import { afterEach, describe, expect, test } from 'bun:test';
import { type Config, loadConfig } from '../src/config.ts';
import { waitFor } from '../src/core/async.ts';
import { UpstreamError } from '../src/core/errors.ts';
import { Metrics } from '../src/core/metrics.ts';
import { CatalogService } from '../src/services/catalog.ts';
import { Scheduler } from '../src/services/scheduler.ts';
import type { ActivitySource } from '../src/upstream/client.ts';
import { activity, MemoryRepository, rawActivity, silentLogger } from './helpers.ts';

const resources: { scheduler: Scheduler; catalog: CatalogService }[] = [];
afterEach(async () => {
  for (const { scheduler, catalog } of resources.splice(0)) {
    await scheduler.close();
    await catalog.close();
  }
});

function fixture(
  source: ActivitySource,
  overrides: Partial<Config> = {},
  repository = new MemoryRepository(),
) {
  const options = {
    ...loadConfig({
      API_USERNAME: 'synthetic',
      API_PASSWORD: 'synthetic',
      CRAWLER_REQUESTS_PER_MINUTE: '0',
    }),
    MIN_ACTIVITY_ID_SCAN: 1,
    MAX_ACTIVITY_ID_SCAN: 3,
    CONCURRENT_API_CALLS: 2,
    CIRCUIT_FAILURE_THRESHOLD: 100,
    ...overrides,
  };
  // Keep the unrelated staff job local while exercising the real activity ingestion path.
  repository.staff = { value: { T1: 'Test Teacher' }, fetchedAt: new Date().toISOString() };
  const metrics = new Metrics();
  const catalog = new CatalogService(
    repository,
    source,
    { process: async (photo) => photo },
    options,
    silentLogger,
    metrics,
  );
  const scheduler = new Scheduler(repository, catalog, options, silentLogger, metrics);
  resources.push({ scheduler, catalog });
  return { scheduler, catalog, repository, metrics };
}

async function eventually(check: () => boolean, message: string) {
  const deadline = performance.now() + 1000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(message);
    await Bun.sleep(2);
  }
}

describe('scheduler recovery and coordination', () => {
  test('repeated discovery finds newly published activities after an earlier missing result expires', async () => {
    const available = new Set(['2']);
    const calls: string[] = [];
    const { scheduler, repository } = fixture(
      {
        fetchActivity: async (id) => {
          calls.push(id);
          return available.has(id) ? rawActivity(id) : null;
        },
      },
      { negativeFreshMs: 10 },
    );
    await scheduler.discover(new AbortController().signal);
    expect(repository.activities.get('1')?.value).toBeNull();
    expect((await repository.listActivitySummaries()).map((item) => item.id)).toEqual(['2']);
    available.add('1');
    await Bun.sleep(20);
    await scheduler.discover(new AbortController().signal);
    expect(repository.activities.get('1')?.value?.id).toBe('1');
    expect(calls.filter((id) => id === '1')).toHaveLength(2);
    expect(calls.filter((id) => id === '2')).toHaveLength(1);
  });

  test('initial discovery outage retries through the due queue without restart or another discovery', async () => {
    let outage = true;
    let calls = 0;
    const { scheduler, repository } = fixture(
      {
        fetchActivity: async (id) => {
          calls++;
          if (outage) throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Synthetic outage');
          return rawActivity(id, 'Recovered Club');
        },
      },
      {
        MAX_ACTIVITY_ID_SCAN: 1,
        // Short constructor timings exercise real completion-based timers without a long test.
        FAILED_FETCH_RETRY_SECONDS: 0.02,
        CLUB_CHECK_INTERVAL_SECONDS: 0.01,
        DISCOVERY_INTERVAL_MINS: 60,
      },
    );
    scheduler.start();
    await eventually(
      () => repository.due.has('1'),
      'Failed discovery never entered the retry queue',
    );
    expect(repository.activities.has('1')).toBe(false);
    outage = false;
    await eventually(
      () => repository.activities.get('1')?.value?.name === 'Recovered Club',
      'Due refresh did not recover initial discovery',
    );
    expect(calls).toBe(2);
    expect(repository.due.get('1')).toBeGreaterThan(Date.now());
  });

  test('due refresh retains stale data and its timestamp during outage, then replaces it on recovery', async () => {
    let outage = true;
    const { scheduler, repository } = fixture({
      fetchActivity: async (id) => {
        if (outage) throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Synthetic outage');
        return rawActivity(id, 'Recovered Club');
      },
    });
    const stale = { value: activity('1', 'Saved Club'), fetchedAt: '2020-01-01T00:00:00.000Z' };
    repository.activities.set('1', structuredClone(stale));
    repository.due.set('1', 0);
    await scheduler.refreshDue(new AbortController().signal);
    expect(repository.activities.get('1')).toEqual(stale);
    expect(repository.due.get('1')).toBeGreaterThan(Date.now());
    outage = false;
    // Model the persisted retry deadline becoming eligible, without waiting a production minute.
    repository.due.set('1', Date.now() - 1);
    await scheduler.refreshDue(new AbortController().signal);
    expect(repository.activities.get('1')?.value?.name).toBe('Recovered Club');
    expect(repository.activities.get('1')?.fetchedAt).not.toBe(stale.fetchedAt);
  });

  test('discovery bounds concurrency and an individual failure does not abandon the remaining IDs', async () => {
    const release = Promise.withResolvers<void>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const { scheduler, repository } = fixture(
      {
        fetchActivity: async (id, signal) => {
          started.push(id);
          active++;
          peak = Math.max(peak, active);
          try {
            await waitFor(release.promise, signal);
            if (id === '2') throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'One activity failed');
            return rawActivity(id);
          } finally {
            active--;
          }
        },
      },
      { MAX_ACTIVITY_ID_SCAN: 6 },
    );
    const discovery = scheduler.discover(new AbortController().signal);
    try {
      await eventually(() => started.length === 2, 'Discovery did not start the permitted workers');
      expect(started).toEqual(['1', '2']);
      expect(active).toBe(2);
    } finally {
      release.resolve();
    }
    await discovery;
    expect(peak).toBe(2);
    expect(started).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(repository.activities.size).toBe(5);
    expect(repository.activities.has('2')).toBe(false);
    expect(repository.due.has('2')).toBe(true);
  });

  test('replicas sharing a repository cannot run the same discovery lease concurrently', async () => {
    const repository = new MemoryRepository();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const source: ActivitySource = {
      fetchActivity: async (id, signal) => {
        calls++;
        await waitFor(release.promise, signal);
        return rawActivity(id);
      },
    };
    const first = fixture(source, { MAX_ACTIVITY_ID_SCAN: 1 }, repository);
    const second = fixture(source, { MAX_ACTIVITY_ID_SCAN: 1 }, repository);
    first.scheduler.start();
    try {
      await eventually(() => calls === 1, 'First replica did not acquire discovery lease');
      first.scheduler.start();
      second.scheduler.start();
      await eventually(
        () => second.metrics.jobsCompleted >= 2,
        'Second replica did not complete independent jobs',
      );
      expect(calls).toBe(1);
      expect(repository.leases.has('job:discover')).toBe(true);
    } finally {
      release.resolve();
    }
    await eventually(
      () => !repository.leases.has('job:discover'),
      'Discovery lease was not released',
    );
    expect(repository.activities.get('1')?.value?.id).toBe('1');
  });

  test('close aborts running jobs, releases leases, and prevents queued IDs or timers starting work', async () => {
    const blocked = Promise.withResolvers<void>();
    const { scheduler, catalog, repository } = fixture(
      { fetchActivity: async (id) => rawActivity(id) },
      {
        MAX_ACTIVITY_ID_SCAN: 10,
        DISCOVERY_INTERVAL_MINS: 0.0002,
        CLUB_CHECK_INTERVAL_SECONDS: 0.01,
        STAFF_CHECK_INTERVAL_SECONDS: 0.01,
      },
    );
    const started: string[] = [];
    const signals: AbortSignal[] = [];
    catalog.warmActivity = async (id, signal) => {
      if (!signal) throw new Error('Scheduled work requires a cancellation signal');
      started.push(id);
      signals.push(signal);
      await waitFor(blocked.promise, signal);
    };
    scheduler.start();
    await eventually(() => started.length === 2, 'Discovery did not begin');
    await scheduler.close();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(repository.leases.size).toBe(0);
    scheduler.start();
    await Bun.sleep(35);
    expect(started).toEqual(['1', '2']);
  });
});
