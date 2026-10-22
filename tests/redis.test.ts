import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import pino from 'pino';
import { AppError } from '../src/core/errors.ts';
import type { Activity } from '../src/domain/activity.ts';
import { activityEntrySchema, RedisRepository } from '../src/storage/redis.ts';
import type { CacheEntry } from '../src/storage/repository.ts';

const logger = pino({ level: 'silent' });
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

function activity(id = '123'): Activity {
  return {
    id,
    name: 'Chess',
    academicYear: '2026',
    category: 'Club',
    description: null,
    descriptionZh: null,
    photo: 'https://images.example.test/chess.avif',
    duration: { startDate: null, endDate: null, isRecurringWeekly: true },
    grades: { min: '3', max: '8' },
    isPreSignup: false,
    isStudentLed: true,
    materials: [],
    meetings: [],
    meeting: {
      day: 'Monday',
      startTime: null,
      endTime: null,
      location: { block: null, room: null, site: null },
    },
    poorWeatherPlan: null,
    schedule: null,
    semesterCost: null,
    requirements: [],
    staff: ['1'],
    staffForReports: [],
    studentLeaders: [],
  };
}

function entry(
  value: Activity | null,
  fetchedAt = '2026-01-01T00:00:00.000Z',
): CacheEntry<Activity> {
  return { value, fetchedAt };
}

test('activity records preserve new detail fields and accept existing v2 cache entries', () => {
  const current = activity();
  current.descriptionZh = '中文描述';
  current.meetings = [
    { ...structuredClone(current.meeting), staff: ['1', '2'] },
    { ...structuredClone(current.meeting), day: 'Friday', staff: ['3'] },
  ];
  expect(activityEntrySchema.parse(JSON.parse(JSON.stringify(entry(current))))).toEqual(
    entry(current),
  );
  const { descriptionZh: _zh, meetings: _meetings, ...old } = current;
  const restored = activityEntrySchema.parse(entry(old as Activity));
  expect(restored.value?.descriptionZh).toBeNull();
  expect(restored.value?.meetings).toEqual([]);
  expect(restored.value?.meeting).toEqual(current.meeting);
  expect(() =>
    activityEntrySchema.parse(entry({ ...current, meetings: 'invalid' } as unknown as Activity)),
  ).toThrow();
});

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const timeout = setTimeout(() => controller.abort(new Error('Lease did not abort')), 2000);
  const controller = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => resolve(), { once: true, signal: controller.signal });
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

describe('RedisRepository failure boundaries', () => {
  test('construction and idempotent close do not connect; operations after close fail explicitly', async () => {
    const repository = new RedisRepository({ url: 'redis://127.0.0.1:1', prefix: 'test' }, logger);
    await Promise.all([repository.close(), repository.close()]);
    await expect(repository.getActivity('1')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  test('an unreachable server is a typed storage failure rather than an empty cache', async () => {
    const repository = new RedisRepository({ url: 'redis://127.0.0.1:0', prefix: 'test' }, logger);
    try {
      const error = await repository.getActivity('1').catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    } finally {
      await repository.close();
    }
  });
});

// These tests use real Redis and exclusively own their random key namespace.
// RUN_REDIS_TESTS=1 TEST_REDIS_URL=redis://127.0.0.1:6379 bun test tests/redis.test.ts
describe.skipIf(process.env.RUN_REDIS_TESTS !== '1')('RedisRepository integration', () => {
  let prefix: string;
  let namespace: string;
  let raw: Redis;
  let repository: RedisRepository;
  let contender: RedisRepository;

  beforeEach(async () => {
    prefix = `test-storage-${randomUUID()}`;
    namespace = `${prefix}:v2`;
    raw = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 2000,
      commandTimeout: 3000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: null,
    });
    raw.on('error', () => {});
    repository = new RedisRepository({ url: redisUrl, prefix }, logger);
    contender = new RedisRepository({ url: redisUrl, prefix }, logger);
    await raw.connect();
    await repository.ping();
  });

  afterEach(async () => {
    const results = await Promise.allSettled([repository.close(), contender.close()]);
    try {
      if (raw.status === 'ready') {
        const keys = await raw.keys(`${prefix}:*`);
        if (keys.length) await raw.del(...keys);
      }
    } finally {
      raw.disconnect();
    }
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });

  test('migration inserts atomically and never overwrites concurrent current data', async () => {
    const current = entry(activity(), '2026-10-01T00:00:00.000Z');
    const legacy = entry({ ...activity(), name: 'Legacy name' });
    await repository.saveActivity('123', current, 1000);
    expect(await contender.saveActivityIfAbsent('123', legacy, 2000)).toBe(false);
    expect(await repository.getActivity('123')).toEqual(current);
    expect(Number(await raw.zscore(`${namespace}:due`, '123'))).toBe(
      Date.parse(current.fetchedAt) + 1000,
    );
    await repository.saveTransientMissing('124', legacy.fetchedAt, 60_000);
    const results = await Promise.all([
      repository.saveActivityIfAbsent('124', entry(activity('124')), 1000),
      contender.saveActivityIfAbsent('124', entry(activity('124')), 1000),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await raw.exists(`${namespace}:missing:124`)).toBe(0);
    await repository.saveStaff({ value: { T1: 'Current' }, fetchedAt: current.fetchedAt });
    expect(
      await contender.saveStaffIfAbsent({ value: { T1: 'Legacy' }, fetchedAt: legacy.fetchedAt }),
    ).toBe(false);
    expect((await repository.getStaff())?.value).toEqual({ T1: 'Current' });
  });

  test('ad hoc missing records expire without durable records, summaries, or due enrollment', async () => {
    const id = '999999999';
    const missing = entry(null);
    const key = `${namespace}:missing:${id}`;
    await repository.saveTransientMissing(id, missing.fetchedAt, 250);
    expect(await contender.getActivity(id)).toEqual(missing);
    expect(await raw.get(key)).toBe(JSON.stringify(missing));
    const ttl = await raw.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(250);
    expect(await raw.hget(`${namespace}:activities`, id)).toBeNull();
    expect(await repository.listActivitySummaries()).toEqual([]);
    expect(await repository.getDueActivityIds(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
    expect(await raw.keys(`${prefix}:*`)).toEqual([key]);
    await Bun.sleep(300);
    expect(await contender.getActivity(id)).toBeNull();
    expect(await raw.exists(key)).toBe(0);
  });

  test.each(['positive', 'negative'] as const)(
    'a durable %s write clears a transient miss and stays persistent',
    async (kind) => {
      const key = `${namespace}:missing:123`;
      const durable = entry(kind === 'positive' ? activity() : null, '2026-10-01T00:00:00.000Z');
      await repository.saveTransientMissing('123', entry(null).fetchedAt, 60_000);
      await contender.saveActivity('123', durable, 1000);
      expect(await repository.getActivity('123')).toEqual(durable);
      expect(await raw.exists(key)).toBe(0);
      expect(await raw.pttl(`${namespace}:activities`)).toBe(-1);
      expect(await repository.getDueActivityIds(Number.MAX_SAFE_INTEGER, 10)).toEqual(['123']);
      expect((await repository.listActivitySummaries()).map((summary) => summary.id)).toEqual(
        kind === 'positive' ? ['123'] : [],
      );
      // A delayed response from another replica must not replace any durable record.
      await repository.saveTransientMissing('123', '2026-10-02T00:00:00.000Z', 60_000);
      expect(await contender.getActivity('123')).toEqual(durable);
      expect(await raw.exists(key)).toBe(0);
    },
  );

  test('racing transient writers cannot shadow or leave misses alongside successful records', async () => {
    await contender.ping();
    for (let index = 0; index < 16; index++) {
      const id = String(999999900 + index);
      const durable = entry(activity(id));
      await Promise.all([
        repository.saveActivity(id, durable, 1000),
        contender.saveTransientMissing(id, durable.fetchedAt, 60_000),
      ]);
      expect(await contender.getActivity(id)).toEqual(durable);
      expect(await raw.exists(`${namespace}:missing:${id}`)).toBe(0);
    }
  });

  test('invalid transient TTLs and timestamps fail explicitly without changing a cached miss', async () => {
    const key = `${namespace}:missing:123`;
    const missing = entry(null);
    await repository.saveTransientMissing('123', missing.fetchedAt, 60_000);
    for (const ttl of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(
        repository.saveTransientMissing('123', '2026-10-01T00:00:00.000Z', ttl),
      ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    }
    await expect(repository.saveTransientMissing('123', 'invalid', 60_000)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(await raw.get(key)).toBe(JSON.stringify(missing));
    expect(await raw.pttl(key)).toBeGreaterThan(0);
    expect(await raw.keys(`${prefix}:*`)).toEqual([key]);
  });

  test.each([
    ['malformed JSON', '{'],
    ['a positive payload', JSON.stringify(entry(activity()))],
    ['a missing timestamp', JSON.stringify({ value: null })],
    ['an invalid timestamp', JSON.stringify({ value: null, fetchedAt: 'invalid' })],
    ['unexpected fields', JSON.stringify({ ...entry(null), extra: true })],
  ])('a transient miss with %s is a typed storage failure', async (_name, payload) => {
    if (payload === undefined) throw new Error('Expected corrupt payload');
    await raw.set(`${namespace}:missing:123`, payload, 'PX', 60_000);
    await expect(repository.getActivity('123')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  test('a transient record without expiry is a storage failure instead of a permanent 404', async () => {
    await raw.set(`${namespace}:missing:123`, JSON.stringify(entry(null)));
    await expect(repository.getActivity('123')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  test('corrupt transient key types fail explicitly and can be cleared by a durable update', async () => {
    const key = `${namespace}:missing:123`;
    await raw.hset(key, 'corrupt', 'data');
    await expect(repository.getActivity('123')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await expect(
      repository.saveTransientMissing('123', entry(null).fetchedAt, 60_000),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await raw.hget(key, 'corrupt')).toBe('data');
    expect(await raw.keys(`${prefix}:*`)).toEqual([key]);
    await repository.saveActivity('123', entry(activity()), 1000);
    expect(await repository.getActivity('123')).toEqual(entry(activity()));
    expect(await raw.exists(key)).toBe(0);
  });

  test('corrupt durable key types cannot be hidden by a transient miss', async () => {
    await raw.set(`${namespace}:activities`, 'wrong type');
    await raw.set(`${namespace}:missing:123`, JSON.stringify(entry(null)), 'PX', 60_000);
    await expect(repository.getActivity('123')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await expect(
      repository.saveTransientMissing('123', entry(null).fetchedAt, 60_000),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await raw.get(`${namespace}:activities`)).toBe('wrong type');
  });

  test('a failed durable write preserves a transient miss without partial durable enrollment', async () => {
    const missing = entry(null);
    await repository.saveTransientMissing('123', missing.fetchedAt, 60_000);
    await raw.set(`${namespace}:due`, 'wrong type');
    await expect(repository.saveActivity('123', entry(activity()), 1000)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(await contender.getActivity('123')).toEqual(missing);
    expect(await raw.get(`${namespace}:missing:123`)).toBe(JSON.stringify(missing));
    expect(await raw.pttl(`${namespace}:missing:123`)).toBeGreaterThan(0);
    expect(await raw.hget(`${namespace}:activities`, '123')).toBeNull();
    expect(await repository.listActivitySummaries()).toEqual([]);
  });

  test('durable provenance survives positive-to-negative transitions and excludes transient misses', async () => {
    expect(await repository.hasDurableActivity('123')).toBe(false);
    await repository.saveTransientMissing('123', new Date().toISOString(), 1000);
    expect(await repository.hasDurableActivity('123')).toBe(false);
    await repository.saveActivity('123', entry(activity()), 1000);
    expect(await repository.hasDurableActivity('123')).toBe(true);
    await repository.saveActivity('123', entry(null), 1000);
    expect(await repository.hasDurableActivity('123')).toBe(true);
  });

  test('positive/negative transitions keep persistent data and summaries consistent', async () => {
    const positive = entry(activity());
    const negative = entry(null, '2026-01-02T00:00:00.000Z');
    await raw.mset(
      `${prefix}:activity:123`,
      'legacy activity',
      `${prefix}:staffs:all`,
      'legacy staff',
    );
    expect(await repository.getActivity('123')).toBeNull();
    await repository.saveActivity('123', positive, 1000);
    expect(await contender.getActivity('123')).toEqual(positive);
    expect(await repository.listActivitySummaries()).toEqual([
      {
        id: '123',
        name: 'Chess',
        photo: activity().photo,
        category: 'Club',
        academicYear: '2026',
        grades: { min: '3', max: '8' },
        isStudentLed: true,
        lastCheck: positive.fetchedAt,
      },
    ]);
    await repository.saveActivity('123', negative, 9000);
    expect(await repository.getActivity('123')).toEqual(negative);
    expect(await repository.listActivitySummaries()).toEqual([]);
    expect(Number(await raw.zscore(`${namespace}:due`, '123'))).toBe(
      Date.parse(negative.fetchedAt) + 9000,
    );
    await repository.saveActivity('123', positive, 1000);
    expect((await repository.listActivitySummaries()).map((row) => row.id)).toEqual(['123']);
    for (const key of ['activities', 'summaries', 'due'])
      expect(await raw.pttl(`${namespace}:${key}`)).toBe(-1);
    expect(await raw.mget(`${prefix}:activity:123`, `${prefix}:staffs:all`)).toEqual([
      'legacy activity',
      'legacy staff',
    ]);
  });

  test('concurrent readers never observe a partial positive/negative transition', async () => {
    await repository.saveActivity('123', entry(activity()), 1000);
    const writer = (async () => {
      for (let index = 0; index < 30; index++) {
        await repository.saveActivity('123', entry(index % 2 ? activity() : null), 1000);
      }
    })();
    const reader = (async () => {
      for (let index = 0; index < 30; index++) {
        const snapshot = await raw
          .multi()
          .hget(`${namespace}:activities`, '123')
          .hget(`${namespace}:summaries`, '123')
          .zscore(`${namespace}:due`, '123')
          .exec();
        expect(snapshot).not.toBeNull();
        if (!snapshot) throw new Error('Missing transaction');
        for (const [error] of snapshot) expect(error).toBeNull();
        const record = snapshot[0]?.[1];
        const summary = snapshot[1]?.[1];
        expect(typeof record).toBe('string');
        if (typeof record !== 'string') throw new Error('Missing record');
        const decoded: unknown = JSON.parse(record);
        expect(decoded).toBeObject();
        const positive =
          Object.hasOwn(decoded as object, 'value') &&
          (decoded as { value: unknown }).value !== null;
        expect(summary !== null).toBe(positive);
        expect(Number(snapshot[2]?.[1])).toBe(Date.parse('2026-01-01T00:00:00.000Z') + 1000);
      }
    })();
    await Promise.all([writer, reader]);
  });

  test('due ordering, limits, and deferral preserve cached records', async () => {
    for (const [id, delay] of [
      ['1', 100],
      ['2', 200],
      ['3', 300],
    ] as const) {
      await repository.saveActivity(id, entry(activity(id)), delay);
    }
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    expect(await repository.getDueActivityIds(start + 200, 10)).toEqual(['1', '2']);
    expect(await repository.getDueActivityIds(start + 300, 1)).toEqual(['1']);
    await repository.deferActivity('1', start + 500);
    expect(await repository.getDueActivityIds(start + 300, 10)).toEqual(['2', '3']);
    expect(await repository.getActivity('1')).toEqual(entry(activity('1')));
    await repository.deferActivity('unknown-discovery', start);
    expect(await repository.getDueActivityIds(start, 10)).toEqual(['unknown-discovery']);
  });

  test('staff positive and negative records persist across repository instances', async () => {
    const staff = { value: { '1': 'Teacher' }, fetchedAt: new Date().toISOString() };
    expect(await repository.getStaff()).toBeNull();
    await repository.saveStaff(staff);
    expect(await contender.getStaff()).toEqual(staff);
    const negative = { ...staff, value: null };
    await contender.saveStaff(negative);
    expect(await repository.getStaff()).toEqual(negative);
    expect(await raw.pttl(`${namespace}:staff`)).toBe(-1);
  });

  test('an already versioned prefix uses the same namespace without adding another version', async () => {
    const versioned = new RedisRepository({ url: redisUrl, prefix: namespace }, logger);
    try {
      await versioned.saveActivity('123', entry(activity()), 1000);
      expect(await repository.getActivity('123')).toEqual(entry(activity()));
    } finally {
      await versioned.close();
    }
  });

  test('embedded images are excluded from summaries', async () => {
    await repository.saveActivity(
      '123',
      entry({ ...activity(), photo: 'data:image/png;base64,c2VjcmV0' }),
      1000,
    );
    expect((await repository.listActivitySummaries())[0]?.photo).toBeNull();
  });

  test('malformed JSON and structurally corrupt activity, summary, and staff records fail explicitly', async () => {
    await repository.saveTransientMissing('123', entry(null).fetchedAt, 60_000);
    await raw.hset(`${namespace}:activities`, '123', '{');
    await expect(repository.getActivity('123')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await raw.hset(
      `${namespace}:activities`,
      '123',
      JSON.stringify({ value: { id: '123' }, fetchedAt: new Date().toISOString() }),
    );
    await expect(repository.getActivity('123')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await raw.hset(`${namespace}:summaries`, '123', JSON.stringify({ id: '123', name: 42 }));
    await expect(repository.listActivitySummaries()).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await raw.hset(
      `${namespace}:staff`,
      'all',
      JSON.stringify({ value: { '1': [] }, fetchedAt: new Date().toISOString() }),
    );
    await expect(repository.getStaff()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  test('a corrupt storage key cannot partially overwrite the last good record', async () => {
    const good = entry(activity());
    await repository.saveActivity('123', good, 1000);
    await raw.del(`${namespace}:due`);
    await raw.set(`${namespace}:due`, 'wrong type');
    await expect(repository.saveActivity('123', entry(null), 1000)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(await repository.getActivity('123')).toEqual(good);
    expect((await repository.listActivitySummaries()).map((row) => row.id)).toEqual(['123']);
  });

  test('serialization failures and invalid refresh times are typed without changing saved data', async () => {
    const good = entry(activity());
    await repository.saveActivity('123', good, 1000);
    const broken = activity();
    Object.defineProperty(broken, 'name', {
      get() {
        throw new Error('Cannot serialize');
      },
    });
    await expect(repository.saveActivity('123', entry(broken), 1000)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await expect(repository.saveActivity('123', entry(null), Number.NaN)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(await repository.getActivity('123')).toEqual(good);
  });

  test('distributed leases exclude peers, renew beyond their TTL, and release idempotently', async () => {
    const lease = await repository.acquireLease('scan', 300);
    expect(lease).not.toBeNull();
    if (!lease) throw new Error('Expected a lease');
    expect(await contender.acquireLease('scan', 300)).toBeNull();
    await Bun.sleep(950);
    expect(lease.signal.aborted).toBe(false);
    expect(await raw.pttl(`${namespace}:lease:scan`)).toBeGreaterThan(0);
    expect(await contender.acquireLease('scan', 300)).toBeNull();
    await Promise.all([lease.release(), lease.release()]);
    expect(lease.signal.aborted).toBe(true);
    const next = await contender.acquireLease('scan', 300);
    expect(next).not.toBeNull();
    await next?.release();
  });

  test('lost ownership aborts work and release never deletes the replacement token', async () => {
    const lease = await repository.acquireLease('scan', 300);
    if (!lease) throw new Error('Expected a lease');
    const token = randomUUID();
    await raw.set(`${namespace}:lease:scan`, token, 'PX', 2000);
    await waitForAbort(lease.signal);
    await lease.release();
    expect(await raw.get(`${namespace}:lease:scan`)).toBe(token);
  });

  test('renewal errors abort a lease; close aborts and releases every live lease', async () => {
    const failed = await repository.acquireLease('broken', 300);
    if (!failed) throw new Error('Expected a lease');
    await raw.del(`${namespace}:lease:broken`);
    await raw.hset(`${namespace}:lease:broken`, 'wrong', 'type');
    await waitForAbort(failed.signal);
    expect(failed.signal.reason).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await raw.del(`${namespace}:lease:broken`);
    await failed.release();
    const first = await repository.acquireLease('first', 300);
    const second = await repository.acquireLease('second', 300);
    await Promise.all([repository.close(), repository.close()]);
    expect(first?.signal.aborted).toBe(true);
    expect(second?.signal.aborted).toBe(true);
    expect(await raw.mget(`${namespace}:lease:first`, `${namespace}:lease:second`)).toEqual([
      null,
      null,
    ]);
  });
});
