import type { Config } from '../config.ts';
import { FetchQueue, SharedJob, waitFor } from '../core/async.ts';
import { AppError, UpstreamError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import type { Metrics } from '../core/metrics.ts';
import type { Activity, StaffDirectory } from '../domain/activity.ts';
import { normalizeActivity, normalizeStaff, type RawActivity } from '../domain/normalize.ts';
import type { ImageStore } from '../storage/images.ts';
import type { CacheEntry, Repository } from '../storage/repository.ts';
import type { ActivitySource } from '../upstream/client.ts';

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';
export interface CacheResult<T> {
  entry: CacheEntry<T>;
  cache: CacheStatus;
}

type CatalogOptions = Pick<
  Config,
  | 'activityFreshMs'
  | 'staffFreshMs'
  | 'negativeFreshMs'
  | 'CONCURRENT_API_CALLS'
  | 'MAX_PENDING_FETCHES'
  | 'FIXED_STAFF_ACTIVITY_ID'
  | 'FAILED_FETCH_RETRY_SECONDS'
  | 'CIRCUIT_FAILURE_THRESHOLD'
  | 'CIRCUIT_COOLDOWN_MS'
  | 'MIN_ACTIVITY_ID_SCAN'
  | 'MAX_ACTIVITY_ID_SCAN'
  | 'IMAGE_PROCESS_TIMEOUT_MS'
>;

/** One ingestion path for scheduled work and API requests. */
export class CatalogService {
  private readonly activities = new Map<string, SharedJob<CacheEntry<Activity>>>();
  private staffFlight: SharedJob<CacheEntry<StaffDirectory>> | undefined;
  private readonly shutdown = new AbortController();
  private readonly queue: FetchQueue;
  private failures = 0;
  private openUntil = 0;
  private probing = false;

  constructor(
    private readonly repository: Repository,
    private readonly source: ActivitySource,
    private readonly images: ImageStore,
    private readonly options: CatalogOptions,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {
    this.queue = new FetchQueue(options.CONCURRENT_API_CALLS, options.MAX_PENDING_FETCHES, 0);
  }

  get queueSize() {
    return this.queue.size;
  }

  private fresh<T>(entry: CacheEntry<T>, ttl: number) {
    const age = Date.now() - Date.parse(entry.fetchedAt);
    return Number.isFinite(age) && age >= 0 && age < ttl;
  }

  private inDiscoveryRange(id: string): boolean {
    const number = Number(id);
    return (
      number >= this.options.MIN_ACTIVITY_ID_SCAN && number <= this.options.MAX_ACTIVITY_ID_SCAN
    );
  }

  async getActivity(id: string, signal?: AbortSignal): Promise<CacheResult<Activity>> {
    signal?.throwIfAborted();
    const cached = await this.repository.getActivity(id);
    if (
      cached &&
      this.fresh(cached, cached.value ? this.options.activityFreshMs : this.options.negativeFreshMs)
    ) {
      this.metrics.cacheHits++;
      return { entry: cached, cache: 'HIT' };
    }
    if (cached?.value) {
      this.metrics.staleResponses++;
      this.refreshActivity(id).catch((err: unknown) =>
        this.logger.warn(
          { err, activityId: id },
          'Background refresh failed; retaining cached activity',
        ),
      );
      return { entry: cached, cache: 'STALE' };
    }
    this.metrics.cacheMisses++;
    return { entry: await this.refreshActivity(id, signal), cache: 'MISS' };
  }

  async warmActivity(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const cached = await this.repository.getActivity(id);
    if (
      cached &&
      this.fresh(cached, cached.value ? this.options.activityFreshMs : this.options.negativeFreshMs)
    )
      return;
    await this.refreshActivity(id, signal, true);
  }

  refreshActivity(
    id: string,
    signal?: AbortSignal,
    ownsWork = false,
  ): Promise<CacheEntry<Activity>> {
    signal?.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    let job = this.activities.get(id);
    if (job && !job.signal.aborted) return job.subscribe(signal, ownsWork);
    job = new SharedJob<CacheEntry<Activity>>(this.shutdown.signal);
    const current = job;
    this.activities.set(id, current);
    const cleanup = () => {
      if (this.activities.get(id) === current) this.activities.delete(id);
    };
    current.promise.then(cleanup, cleanup);
    const result = current.subscribe(signal, ownsWork);
    current.start((workSignal) =>
      this.queue.run(async () => {
        const previous = await this.repository.getActivity(id);
        const tracked = this.inDiscoveryRange(id) || (await this.repository.hasDurableActivity(id));
        try {
          const value = await this.fetchSource(id, workSignal, (raw) =>
            raw ? normalizeActivity(raw, id) : null,
          );
          if (value) {
            const originalPhoto = value.photo;
            const imageSignal = AbortSignal.any([
              workSignal,
              AbortSignal.timeout(this.options.IMAGE_PROCESS_TIMEOUT_MS),
            ]);
            try {
              value.photo = await waitFor(
                this.images.process(value.photo, id, imageSignal),
                imageSignal,
              );
              if (
                value.photo === null &&
                originalPhoto?.startsWith('data:') &&
                previous?.value?.photo
              )
                value.photo = previous.value.photo;
            } catch (err) {
              workSignal.throwIfAborted();
              this.logger.warn(
                { err, activityId: id },
                'Image processing failed or timed out; retaining previous photo',
              );
              value.photo = previous?.value?.photo ?? null;
            }
          }
          workSignal.throwIfAborted();
          const entry: CacheEntry<Activity> = { value, fetchedAt: new Date().toISOString() };
          if (value || tracked)
            await this.repository.saveActivity(
              id,
              entry,
              value ? this.options.activityFreshMs : this.options.negativeFreshMs,
            );
          else
            await this.repository.saveTransientMissing(
              id,
              entry.fetchedAt,
              this.options.negativeFreshMs,
            );
          return entry;
        } catch (err) {
          if (!workSignal.aborted && tracked)
            await this.repository.deferActivity(
              id,
              Date.now() + this.options.FAILED_FETCH_RETRY_SECONDS * 1000,
            );
          throw err;
        }
      }, workSignal),
    );
    return result;
  }

  private async fetchSource<T>(
    id: string,
    signal: AbortSignal,
    normalize: (raw: RawActivity | null) => T,
  ): Promise<T> {
    const now = Date.now();
    if (this.failures >= this.options.CIRCUIT_FAILURE_THRESHOLD) {
      if (now < this.openUntil || this.probing)
        throw new UpstreamError('UPSTREAM_UNAVAILABLE', 'Upstream is recovering. Try again later.');
      this.probing = true;
    }
    this.metrics.upstreamFetches++;
    try {
      const raw = await this.source.fetchActivity(id, signal);
      signal.throwIfAborted();
      let result: T;
      try {
        result = normalize(raw);
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        throw new UpstreamError(
          'UPSTREAM_PROTOCOL_ERROR',
          'Engage returned semantically invalid activity data.',
        );
      }
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (err) {
      if (!signal.aborted) {
        this.metrics.upstreamFailures++;
        this.failures++;
        if (this.failures >= this.options.CIRCUIT_FAILURE_THRESHOLD)
          this.openUntil = Date.now() + this.options.CIRCUIT_COOLDOWN_MS;
      }
      throw err;
    } finally {
      this.probing = false;
    }
  }

  async getStaff(signal?: AbortSignal): Promise<CacheResult<StaffDirectory>> {
    signal?.throwIfAborted();
    const cached = await this.repository.getStaff();
    if (cached?.value) {
      if (this.fresh(cached, this.options.staffFreshMs)) {
        this.metrics.cacheHits++;
        return { entry: cached, cache: 'HIT' };
      }
      this.metrics.staleResponses++;
      this.refreshStaff().catch((err: unknown) =>
        this.logger.warn({ err }, 'Background staff refresh failed; retaining cached directory'),
      );
      return { entry: cached, cache: 'STALE' };
    }
    this.metrics.cacheMisses++;
    return { entry: await this.refreshStaff(signal), cache: 'MISS' };
  }

  async warmStaff(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const cached = await this.repository.getStaff();
    if (cached?.value && this.fresh(cached, this.options.staffFreshMs)) return;
    await this.refreshStaff(signal, true);
  }

  refreshStaff(signal?: AbortSignal, ownsWork = false): Promise<CacheEntry<StaffDirectory>> {
    signal?.throwIfAborted();
    this.shutdown.signal.throwIfAborted();
    if (this.staffFlight && !this.staffFlight.signal.aborted)
      return this.staffFlight.subscribe(signal, ownsWork);
    const current = new SharedJob<CacheEntry<StaffDirectory>>(this.shutdown.signal);
    this.staffFlight = current;
    const cleanup = () => {
      if (this.staffFlight === current) this.staffFlight = undefined;
    };
    current.promise.then(cleanup, cleanup);
    const result = current.subscribe(signal, ownsWork);
    current.start((workSignal) =>
      this.queue.run(async () => {
        const value = await this.fetchSource(
          this.options.FIXED_STAFF_ACTIVITY_ID,
          workSignal,
          (raw) => {
            if (!raw)
              throw new UpstreamError(
                'UPSTREAM_PROTOCOL_ERROR',
                'Staff source activity is unavailable.',
              );
            const directory = normalizeStaff(raw);
            if (Object.keys(directory).length === 0)
              throw new UpstreamError(
                'UPSTREAM_PROTOCOL_ERROR',
                'Staff source did not contain a directory.',
              );
            return directory;
          },
        );
        const entry = { value, fetchedAt: new Date().toISOString() };
        workSignal.throwIfAborted();
        await this.repository.saveStaff(entry);
        return entry;
      }, workSignal),
    );
    return result;
  }

  async close(): Promise<void> {
    this.shutdown.abort(new AppError('SHUTTING_DOWN', 'Service is shutting down.'));
    await Promise.allSettled([
      ...[...this.activities.values()].map((job) => job.promise),
      ...(this.staffFlight ? [this.staffFlight.promise] : []),
    ]);
  }
}
