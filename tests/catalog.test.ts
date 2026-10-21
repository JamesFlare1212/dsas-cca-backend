import { afterEach, describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config.ts';
import { AppError, UpstreamError } from '../src/core/errors.ts';
import { Metrics } from '../src/core/metrics.ts';
import { CatalogService } from '../src/services/catalog.ts';
import type { ImageStore } from '../src/storage/images.ts';
import type { ActivitySource } from '../src/upstream/client.ts';
import { activity, MemoryRepository, rawActivity, silentLogger } from './helpers.ts';

const services: CatalogService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function setup(
  source: ActivitySource,
  overrides: Record<string, string> = {},
  images: ImageStore = { process: async (photo) => photo },
) {
  const repository = new MemoryRepository();
  const config = loadConfig({
    API_USERNAME: 'fake',
    API_PASSWORD: 'fake',
    CRAWLER_REQUESTS_PER_MINUTE: '0',
    MIN_ACTIVITY_ID_SCAN: '1',
    MAX_ACTIVITY_ID_SCAN: '100',
    ...overrides,
  });
  const metrics = new Metrics();
  const service = new CatalogService(repository, source, images, config, silentLogger, metrics);
  services.push(service);
  return { repository, service, metrics };
}

describe('catalog cache and upstream recovery', () => {
  test('merges simultaneous cache misses into one upstream request', async () => {
    let calls = 0;
    const { service, repository } = setup({
      fetchActivity: async (id) => {
        calls++;
        await Bun.sleep(10);
        return rawActivity(id);
      },
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.getActivity('3350')),
    );
    expect(calls).toBe(1);
    expect(results.every((result) => result.entry.value?.id === '3350')).toBe(true);
    expect(repository.activities.has('3350')).toBe(true);
  });
  test('uses negative cache without re-fetching missing activity', async () => {
    let calls = 0;
    const { service } = setup({
      fetchActivity: async () => {
        calls++;
        return null;
      },
    });
    expect((await service.getActivity('1')).cache).toBe('MISS');
    expect((await service.getActivity('1')).cache).toBe('HIT');
    expect(calls).toBe(1);
  });
  test('an upstream outage does not become negative cached data', async () => {
    const { service, repository } = setup({
      fetchActivity: async () => {
        throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Outage');
      },
    });
    await expect(service.getActivity('1')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(repository.activities.has('1')).toBe(false);
    expect(repository.due.has('1')).toBe(true);
  });
  test('returns stale data promptly and preserves its freshness during outage', async () => {
    const { service, repository } = setup({
      fetchActivity: async () => {
        throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Outage');
      },
    });
    const fetchedAt = new Date(Date.now() - 86400000).toISOString();
    repository.activities.set('1', { value: activity('1'), fetchedAt });
    const result = await service.getActivity('1');
    expect(result.cache).toBe('STALE');
    expect(result.entry.fetchedAt).toBe(fetchedAt);
    await Bun.sleep(10);
    expect(repository.activities.get('1')?.fetchedAt).toBe(fetchedAt);
  });
  test('refreshes stale data and keeps the persistent discovery record', async () => {
    const { service, repository } = setup({
      fetchActivity: async (id) => rawActivity(id, 'Updated Club'),
    });
    repository.activities.set('1', { value: activity('1'), fetchedAt: new Date(0).toISOString() });
    await service.warmActivity('1');
    expect(repository.activities.get('1')?.value?.name).toBe('Updated Club');
    expect(repository.due.get('1')).toBeGreaterThan(Date.now());
  });
  test('storage failures do not fan out to the upstream', async () => {
    let calls = 0;
    const { service, repository } = setup({
      fetchActivity: async () => {
        calls++;
        return null;
      },
    });
    repository.failure = new AppError('STORAGE_UNAVAILABLE', 'Redis unavailable');
    await expect(service.getActivity('1')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(calls).toBe(0);
    repository.failure = undefined;
  });
  test('one cancelled HTTP waiter does not cancel another waiter or shared fetch', async () => {
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = setup({
      fetchActivity: async (id) => {
        await started;
        return rawActivity(id);
      },
    });
    const controller = new AbortController();
    const cancelled = service.getActivity('1', controller.signal);
    const surviving = service.getActivity('1');
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect((await surviving).entry.value?.id).toBe('1');
  });
  test('shared global concurrency limit covers distinct activity requests', async () => {
    let active = 0,
      peak = 0;
    const { service } = setup(
      {
        fetchActivity: async (id) => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(5);
          active--;
          return rawActivity(id);
        },
      },
      { CONCURRENT_API_CALLS: '2' },
    );
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => service.getActivity(String(index + 1))),
    );
    expect(peak).toBe(2);
  });
  test('opens circuit after repeated failures instead of hammering source', async () => {
    let calls = 0;
    const { service } = setup(
      {
        fetchActivity: async () => {
          calls++;
          throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'outage');
        },
      },
      { CIRCUIT_FAILURE_THRESHOLD: '2' },
    );
    for (const id of ['1', '2', '3', '4'])
      await expect(service.refreshActivity(id)).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
    expect(calls).toBe(2);
  });
  test('real not-found result removes old activity from summaries', async () => {
    const { service, repository } = setup({ fetchActivity: async () => null });
    repository.activities.set('1', { value: activity('1'), fetchedAt: new Date(0).toISOString() });
    await service.refreshActivity('1');
    expect(await repository.listActivitySummaries()).toEqual([]);
    expect(repository.activities.get('1')?.value).toBeNull();
  });
  test('an upstream photo removal is reflected instead of retaining the old image', async () => {
    const { service, repository } = setup({ fetchActivity: async (id) => rawActivity(id) });
    repository.activities.set('1', {
      value: { ...activity('1'), photo: 'https://example.test/old.avif' },
      fetchedAt: new Date(0).toISOString(),
    });
    await service.refreshActivity('1');
    expect(repository.activities.get('1')?.value?.photo).toBeNull();
  });
  test('ad hoc missing and failed IDs do not permanently enroll into background polling', async () => {
    let calls = 0;
    const { service, repository } = setup({
      fetchActivity: async () => {
        calls++;
        return null;
      },
    });
    expect((await service.getActivity('999999999')).entry.value).toBeNull();
    expect((await service.getActivity('999999999')).cache).toBe('HIT');
    expect(calls).toBe(1);
    expect(repository.activities.has('999999999')).toBe(false);
    expect(repository.due.has('999999999')).toBe(false);
    const outage = setup({
      fetchActivity: async () => {
        throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Outage');
      },
    });
    await expect(outage.service.getActivity('999999999')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(outage.repository.due.has('999999999')).toBe(false);
    expect(outage.repository.activities.size).toBe(0);
  });

  test('semantic failures are typed protocol errors and count toward circuit breaking', async () => {
    let calls = 0;
    const { service, metrics } = setup(
      {
        fetchActivity: async () => {
          calls++;
          return { newRows: [] };
        },
      },
      { CIRCUIT_FAILURE_THRESHOLD: '1' },
    );
    await expect(service.getActivity('1')).rejects.toMatchObject({
      code: 'UPSTREAM_PROTOCOL_ERROR',
      status: 503,
    });
    await expect(service.getActivity('2')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(calls).toBe(1);
    expect(metrics.upstreamFailures).toBe(1);
  });

  test('staff semantic failures also trip the upstream circuit', async () => {
    let calls = 0;
    const { service, metrics } = setup(
      {
        fetchActivity: async (id) => {
          calls++;
          return rawActivity(id);
        },
      },
      { CIRCUIT_FAILURE_THRESHOLD: '1' },
    );
    await expect(service.refreshStaff()).rejects.toMatchObject({ code: 'UPSTREAM_PROTOCOL_ERROR' });
    await expect(service.refreshStaff()).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(calls).toBe(1);
    expect(metrics.upstreamFailures).toBe(1);
  });

  test('a stalled image store falls back by deadline and releases the catalog slot', async () => {
    const blocked = Promise.withResolvers<string | null>();
    let calls = 0;
    const { service, repository } = setup(
      {
        fetchActivity: async (id) => {
          calls++;
          const raw = rawActivity(id);
          if (id === '1')
            raw.newRows[0]?.fields.push({ fID: 'photo', fData: 'data:image/png;base64,AA==' });
          return raw;
        },
      },
      { CONCURRENT_API_CALLS: '1', IMAGE_PROCESS_TIMEOUT_MS: '100' },
      { process: async (photo) => (photo ? blocked.promise : null) },
    );
    repository.activities.set('1', {
      value: { ...activity('1'), photo: 'https://example.test/old.avif' },
      fetchedAt: new Date(0).toISOString(),
    });
    try {
      const first = service.refreshActivity('1');
      const next = service.getActivity('2');
      expect((await first).value?.photo).toBe('https://example.test/old.avif');
      expect((await next).entry.value?.id).toBe('2');
      expect(calls).toBe(2);
      expect(service.queueSize).toBe(0);
    } finally {
      blocked.resolve(null);
    }
  });

  test('lease loss aborts the source and prevents an older ingestion overwriting a replacement', async () => {
    const released = Promise.withResolvers<void>();
    let sourceSignal: AbortSignal | undefined;
    const { service, repository } = setup({
      fetchActivity: async (id, signal) => {
        sourceSignal = signal;
        await released.promise;
        return rawActivity(id, 'Old snapshot');
      },
    });
    const controller = new AbortController();
    const old = service.warmActivity('1', controller.signal);
    const rejected = old.catch((error: unknown) => error);
    await Bun.sleep(1);
    controller.abort();
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    expect(sourceSignal?.aborted).toBe(true);
    const config = loadConfig({
      API_USERNAME: 'fake',
      API_PASSWORD: 'fake',
      CRAWLER_REQUESTS_PER_MINUTE: '0',
    });
    const replacement = new CatalogService(
      repository,
      { fetchActivity: async (id) => rawActivity(id, 'New snapshot') },
      { process: async (photo) => photo },
      config,
      silentLogger,
      new Metrics(),
    );
    services.push(replacement);
    await replacement.refreshActivity('1');
    released.resolve();
    await Bun.sleep(5);
    expect(repository.activities.get('1')?.value?.name).toBe('New snapshot');
  });

  test('an HTTP subscriber can keep shared work alive after its scheduler owner detaches', async () => {
    const released = Promise.withResolvers<void>();
    let sourceSignal: AbortSignal | undefined;
    const { service } = setup({
      fetchActivity: async (id, signal) => {
        sourceSignal = signal;
        await released.promise;
        return rawActivity(id);
      },
    });
    const owner = new AbortController();
    const owned = service.warmActivity('1', owner.signal).catch((error: unknown) => error);
    await Bun.sleep(1);
    const http = service.getActivity('1');
    await Bun.sleep(1);
    owner.abort();
    expect(await owned).toMatchObject({ name: 'AbortError' });
    expect(sourceSignal?.aborted).toBe(false);
    released.resolve();
    expect((await http).entry.value?.id).toBe('1');
  });
  test('durable out-of-range activities retain their tracked status across repeated missing results and outages', async () => {
    let calls = 0,
      outage = false;
    const { service, repository } = setup(
      {
        fetchActivity: async () => {
          calls++;
          if (outage) throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Outage');
          return null;
        },
      },
      { ERROR_CACHE_TTL: '1' },
    );
    repository.activities.set('9999', {
      value: activity('9999'),
      fetchedAt: new Date(0).toISOString(),
    });
    await service.refreshActivity('9999');
    const first = repository.activities.get('9999');
    const firstDue = repository.due.get('9999');
    await Bun.sleep(2);
    await service.refreshActivity('9999');
    expect(repository.activities.get('9999')?.fetchedAt).not.toBe(first?.fetchedAt);
    expect(repository.due.get('9999')).toBeGreaterThan(firstDue ?? 0);
    expect((await service.getActivity('9999')).cache).toBe('HIT');
    expect(calls).toBe(2);
    outage = true;
    await expect(service.refreshActivity('9999')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(repository.due.get('9999')).toBeGreaterThan(Date.now() + 50000);
    // A scan-range change must not strand an already durable negative either.
    repository.activities.set('9998', { value: null, fetchedAt: new Date(0).toISOString() });
    outage = false;
    await service.refreshActivity('9998');
    expect((await service.getActivity('9998')).cache).toBe('HIT');
  });
});
