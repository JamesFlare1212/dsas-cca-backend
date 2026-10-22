import { describe, expect, test } from 'bun:test';
import { AppError, UpstreamError } from '../src/core/errors.ts';
import { Metrics } from '../src/core/metrics.ts';
import type { Activity } from '../src/domain/activity.ts';
import { normalizeActivity } from '../src/domain/normalize.ts';
import { type AppDependencies, createApp } from '../src/http/app.ts';
import { activity, MemoryRepository, silentLogger } from './helpers.ts';

const fetchedAt = '2026-10-20T12:34:56.000Z';
type FixtureOptions = Partial<
  Pick<AppDependencies, 'catalog' | 'getClientAddress' | 'isShuttingDown'>
> & {
  config?: Partial<AppDependencies['config']>;
};

function fixture(options: FixtureOptions = {}) {
  const repository = new MemoryRepository();
  const metrics = new Metrics();
  const catalog: AppDependencies['catalog'] = options.catalog ?? {
    queueSize: 0,
    getActivity: async (id) => ({ entry: { value: activity(id), fetchedAt }, cache: 'HIT' }),
    getStaff: async () => ({
      entry: { value: { T1: 'Ada Lovelace', T2: 'Grace Hopper' }, fetchedAt },
      cache: 'HIT',
    }),
  };
  const app = createApp({
    ...options,
    config: {
      allowedOrigins: ['https://clubs.example'],
      HTTP_REQUESTS_PER_MINUTE: 0,
      HTTP_TIMEOUT_MS: 1000,
      ...options.config,
    },
    repository,
    catalog,
    logger: silentLogger,
    metrics,
  });
  return { app, repository, catalog, metrics };
}

function seed(repository: MemoryRepository) {
  const entries: Activity[] = [
    {
      ...activity('30', 'Football'),
      category: 'Sports',
      academicYear: '2025/2026',
      grades: { min: '5', max: '12' },
      photo: 'https://images.example/30.webp',
    },
    { ...activity('10', 'Art Club'), grades: { min: '1', max: '4' } },
    { ...activity('20', 'Chess Club'), isStudentLed: true },
    {
      ...activity('40', 'Open Workshop'),
      category: null,
      academicYear: null,
      grades: { min: null, max: null },
      isStudentLed: null,
    },
  ];
  for (const value of entries) repository.activities.set(value.id, { value, fetchedAt });
  repository.activities.set('50', { value: null, fetchedAt });
}

describe('HTTP API compatibility and validation', () => {
  test('detail exposes bilingual content and all meetings alongside the legacy field', async () => {
    const { app, catalog } = fixture();
    const value = activity('42');
    value.descriptionZh = '中文描述';
    value.meetings = [
      { ...structuredClone(value.meeting), staff: ['T1'] },
      { ...structuredClone(value.meeting), day: 'Friday', staff: ['T2'] },
    ];
    value.meeting.day = 'Friday';
    catalog.getActivity = async () => ({ entry: { value, fetchedAt }, cache: 'HIT' });
    const response = await app.request('/v1/activity/42');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      descriptionZh: '中文描述',
      meetings: value.meetings,
      meeting: value.meeting,
      cache: 'HIT',
    });
  });

  test('list is the legacy ID-to-summary map, including all results without pagination', async () => {
    const { app, repository } = fixture();
    seed(repository);
    const response = await app.request('/v1/activity/list');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      '10': { name: 'Art Club', photo: '' },
      '20': { name: 'Chess Club', photo: '' },
      '30': { name: 'Football', photo: 'https://images.example/30.webp' },
      '40': { name: 'Open Workshop', photo: '' },
    });
    expect(response.headers.get('X-Total-Count')).toBe('4');
  });

  test('filters combine and grade bounds are inclusive from grade 1 through grade 12', async () => {
    const { app, repository } = fixture();
    seed(repository);
    const cases: [string, string[]][] = [
      ['category=Clubs&academicYear=2026%2F2027&grade=3&isStudentLed=true', ['20']],
      ['category=Clubs&isStudentLed=false', ['10']],
      ['grade=1', ['10']],
      ['grade=12', ['20', '30']],
      ['academicYear=2025%2F2026', ['30']],
      ['isStudentLed=true&grade=1', []],
    ];
    for (const [query, ids] of cases) {
      const response = await app.request(`/v1/activity/list?${query}`);
      expect(response.status).toBe(200);
      expect(Object.keys(await response.json())).toEqual(ids);
    }
  });

  test('kindergarten parsing and filtering use -2 through 0 without matching primary grades', async () => {
    const { app, repository } = fixture();
    for (const [id, schedule] of [
      ['60', 'KG1'],
      ['61', 'KG2'],
      ['62', 'KG3'],
      ['63', 'KG1-KG3'],
      ['64', 'G1'],
    ]) {
      if (!id || !schedule) throw new Error('Missing fixture');
      const value = normalizeActivity(
        {
          newRows: [
            {
              rID: `${id}:1`,
              fields: [
                { fID: 'activityname', fData: 'Test Club' },
                { fID: 'schedule', fData: schedule },
              ],
            },
          ],
        },
        id,
      );
      await repository.saveActivity(id, { value, fetchedAt }, 60000);
    }
    for (const [grade, ids] of [
      ['-2', ['60', '63']],
      ['-1', ['61', '63']],
      ['0', ['62', '63']],
      ['1', ['64']],
      ['2', []],
      ['3', []],
    ] as const) {
      const response = await app.request(`/v1/activity/list?grade=${grade}`);
      expect(response.status).toBe(200);
      expect(Object.keys(await response.json())).toEqual([...ids]);
      expect(response.headers.get('X-Total-Count')).toBe(String(ids.length));
    }
  });

  test('pagination follows filtering, accepts limit 500, and keeps the full result count', async () => {
    const { app, repository } = fixture();
    seed(repository);
    for (const [query, ids] of [
      ['limit=1&offset=1', ['20']],
      ['category=Clubs&limit=1&offset=1', ['20']],
      ['limit=500&offset=0', ['10', '20', '30', '40']],
      ['offset=99', []],
    ] as const) {
      const response = await app.request(`/v1/activity/list?${query}`);
      expect(response.status).toBe(200);
      expect(Object.keys(await response.json())).toEqual([...ids]);
      expect(response.headers.get('X-Total-Count')).toBe(query.startsWith('category=') ? '2' : '4');
    }
  });

  test('category and academic year endpoints retain count maps and ignore missing records', async () => {
    const { app, repository } = fixture();
    seed(repository);
    const categories = await app.request('/v1/activity/category');
    const years = await app.request('/v1/activity/academicYear');
    expect(categories.status).toBe(200);
    expect(await categories.json()).toEqual({ Clubs: 2, Sports: 1 });
    expect(years.status).toBe(200);
    expect(await years.json()).toEqual({ '2026/2027': 2, '2025/2026': 1 });
  });

  test('rejects malformed or repeated query parameters before touching storage', async () => {
    const { app, repository } = fixture();
    repository.failure = new AppError('STORAGE_UNAVAILABLE', 'Redis is unavailable.');
    for (const query of [
      'grade=1abc',
      'grade=-3',
      'grade=-0',
      'grade=-01',
      'grade=-1.0',
      'grade=13',
      'grade=01',
      'grade=1.0',
      'grade=',
      'grade=1&grade=12',
      'category=Clubs&category=Sports',
      'limit=1&limit=2',
      'academicYear=2026/2026',
      'academicYear=2026-2027',
      'academicYear=2026/2027junk',
      'isStudentLed=yes',
      'isStudentLed=TRUE',
      'isStudentLed=',
      'limit=0',
      'limit=501',
      'limit=-1',
      'limit=1abc',
      'offset=-1',
      'offset=1.5',
      'category=',
    ]) {
      const response = await app.request(`/v1/activity/list?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  test('unknown categories and years give compatible diagnostics', async () => {
    const { app, repository } = fixture();
    seed(repository);
    const category = await app.request('/v1/activity/list?category=Unknown');
    expect(category.status).toBe(400);
    expect(await category.json()).toMatchObject({ availableCategories: ['Clubs', 'Sports'] });
    const year = await app.request('/v1/activity/list?academicYear=2024/2025');
    expect(year.status).toBe(400);
    expect(await year.json()).toMatchObject({ availableAcademicYears: ['2026/2027', '2025/2026'] });
  });

  test('activity detail preserves the payload and HIT/MISS/STALE metadata', async () => {
    for (const cache of ['HIT', 'MISS', 'STALE'] as const) {
      const value = activity('123');
      const { app, catalog } = fixture();
      const calls: string[] = [];
      catalog.getActivity = async (id, signal) => {
        calls.push(id);
        expect(signal).toBeInstanceOf(AbortSignal);
        return { entry: { value, fetchedAt }, cache };
      };
      const response = await app.request('/v1/activity/00123');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...value, lastCheck: fetchedAt, cache });
      expect(response.headers.get('X-Cache')).toBe(cache);
      expect(response.headers.get('X-Data-Updated-At')).toBe(fetchedAt);
      expect(calls).toEqual(['123']);
    }
  });

  test('true missing details return 404; upstream failure returns 503 without a false absence', async () => {
    const { app, catalog } = fixture();
    catalog.getActivity = async () => ({ entry: { value: null, fetchedAt }, cache: 'HIT' });
    const missing = await app.request('/v1/activity/123');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('X-Cache')).toBe('HIT');
    expect(missing.headers.get('X-Data-Updated-At')).toBe(fetchedAt);
    expect(await missing.json()).toMatchObject({
      lastCheck: fetchedAt,
      cache: 'HIT',
      source: 'api-fetch-empty',
    });
    catalog.getActivity = async () => {
      throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Upstream is unavailable.');
    };
    const unavailable = await app.request('/v1/activity/123');
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBeTruthy();
    expect(unavailable.headers.has('X-Cache')).toBe(false);
    expect(await unavailable.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  test('invalid activity IDs never call the catalog', async () => {
    const { app, catalog } = fixture();
    let calls = 0;
    catalog.getActivity = async () => {
      calls++;
      throw new Error('Must not be called');
    };
    for (const id of ['1abc', '-1', '1e3', '1.0', '1000000000']) {
      expect((await app.request(`/v1/activity/${id}`)).status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test('staff remains a name map with cache and freshness metadata', async () => {
    const { app, catalog } = fixture();
    for (const cache of ['HIT', 'MISS', 'STALE'] as const) {
      catalog.getStaff = async () => ({
        entry: { value: { T1: 'Ada Lovelace', T2: 'Grace Hopper' }, fetchedAt },
        cache,
      });
      const response = await app.request('/v1/staffs');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        T1: 'Ada Lovelace',
        T2: 'Grace Hopper',
        lastCheck: fetchedAt,
        cache,
      });
      expect(response.headers.get('X-Cache')).toBe(cache);
      expect(response.headers.get('X-Data-Updated-At')).toBe(fetchedAt);
    }
  });

  test('readiness fails during Redis outage or shutdown while liveness stays healthy', async () => {
    let stopping = false;
    const { app, repository } = fixture({ isShuttingDown: () => stopping });
    expect((await app.request('/health/ready')).status).toBe(200);
    repository.failure = new AppError('STORAGE_UNAVAILABLE', 'Redis ping failed.');
    expect((await app.request('/health/ready')).status).toBe(503);
    expect((await app.request('/health/live')).status).toBe(200);
    repository.failure = undefined;
    expect((await app.request('/health/ready')).status).toBe(200);
    stopping = true;
    expect((await app.request('/health/ready')).status).toBe(503);
    expect((await app.request('/v1/activity/list')).status).toBe(503);
    expect((await app.request('/health/live')).status).toBe(200);
  });

  test('allowed origins receive CORS metadata and preflight; blocked origins cannot read API data', async () => {
    const { app } = fixture();
    const allowed = await app.request('/v1/activity/list', {
      headers: { Origin: 'https://clubs.example' },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://clubs.example');
    for (const header of ['x-request-id', 'x-cache', 'x-data-updated-at']) {
      expect(allowed.headers.get('Access-Control-Expose-Headers')?.toLowerCase()).toContain(header);
    }
    const preflight = await app.request('/v1/activity/list', {
      method: 'OPTIONS',
      headers: { Origin: 'https://clubs.example', 'Access-Control-Request-Method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://clubs.example');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    for (const method of ['GET', 'OPTIONS']) {
      const denied = await app.request('/v1/activity/list', {
        method,
        headers: { Origin: 'https://attacker.example' },
      });
      expect(denied.status).toBe(403);
      expect(denied.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
    expect((await app.request('/v1/activity/list')).status).toBe(200);
  });

  test('native client addresses isolate rate limits and forged forwarding headers cannot bypass them', async () => {
    let nativeAddress = '192.0.2.1';
    const seen: Request[] = [];
    const { app } = fixture({
      config: { HTTP_REQUESTS_PER_MINUTE: 1 },
      getClientAddress: (request) => {
        seen.push(request);
        return nativeAddress;
      },
    });
    expect(
      (await app.request('/v1/activity/list', { headers: { 'X-Forwarded-For': '198.51.100.1' } }))
        .status,
    ).toBe(200);
    const limited = await app.request('/v1/activity/list', {
      headers: { 'X-Forwarded-For': '198.51.100.2', 'X-Real-IP': '198.51.100.3' },
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    nativeAddress = '192.0.2.2';
    expect(
      (await app.request('/v1/activity/list', { headers: { 'X-Forwarded-For': '198.51.100.1' } }))
        .status,
    ).toBe(200);
    expect(seen).toHaveLength(3);
    expect(seen.every((request) => request instanceof Request)).toBe(true);

    const fallback = fixture({ config: { HTTP_REQUESTS_PER_MINUTE: 1 } }).app;
    expect(
      (await fallback.request('/v1/activity/list', { headers: { 'X-Forwarded-For': '1.1.1.1' } }))
        .status,
    ).toBe(200);
    expect(
      (await fallback.request('/v1/activity/list', { headers: { 'X-Forwarded-For': '2.2.2.2' } }))
        .status,
    ).toBe(429);
  });

  test('error responses omit internal exception messages, stack traces, and credentials', async () => {
    const { app, catalog, repository } = fixture();
    const secret = 'redis://private-user:private-password@internal.example:6379';
    catalog.getActivity = async () => {
      throw new Error(`Connection refused: ${secret}`);
    };
    const unexpected = await app.request('/v1/activity/123');
    expect(unexpected.status).toBe(500);
    const body = await unexpected.json();
    expect(body).toMatchObject({
      error: 'An internal server error occurred.',
      requestId: unexpected.headers.get('X-Request-ID'),
    });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain('stack');
    repository.failure = new AppError('STORAGE_UNAVAILABLE', 'Redis read failed.', 503, {
      cause: new Error(secret),
    });
    const storage = await app.request('/v1/activity/list');
    expect(storage.status).toBe(503);
    const storageBody = await storage.json();
    expect(storageBody).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      requestId: storage.headers.get('X-Request-ID'),
    });
    expect(JSON.stringify(storageBody)).not.toContain(secret);
    expect(JSON.stringify(storageBody)).not.toContain('stack');
  });
});
