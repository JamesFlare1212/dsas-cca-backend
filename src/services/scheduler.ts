import type { Config } from '../config.ts';
import { forEachConcurrent } from '../core/async.ts';
import type { Logger } from '../core/logger.ts';
import type { Metrics } from '../core/metrics.ts';
import type { Repository } from '../storage/repository.ts';
import type { CatalogService } from './catalog.ts';

type SchedulerOptions = Pick<
  Config,
  | 'MIN_ACTIVITY_ID_SCAN'
  | 'MAX_ACTIVITY_ID_SCAN'
  | 'CONCURRENT_API_CALLS'
  | 'DISCOVERY_INTERVAL_MINS'
  | 'CLUB_CHECK_INTERVAL_SECONDS'
  | 'STAFF_CHECK_INTERVAL_SECONDS'
>;

/** Completion based timers avoid overlapping jobs; Redis leases coordinate replicas. */
export class Scheduler {
  private readonly stopController = new AbortController();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly running = new Set<Promise<void>>();
  private started = false;

  constructor(
    private readonly repository: Repository,
    private readonly catalog: CatalogService,
    private readonly options: SchedulerOptions,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  start() {
    if (this.started) return;
    this.started = true;
    this.schedule('discover', this.options.DISCOVERY_INTERVAL_MINS * 60000, (signal) =>
      this.discover(signal),
    );
    this.schedule('activities', this.options.CLUB_CHECK_INTERVAL_SECONDS * 1000, (signal) =>
      this.refreshDue(signal),
    );
    this.schedule('staff', this.options.STAFF_CHECK_INTERVAL_SECONDS * 1000, (signal) =>
      this.catalog.warmStaff(signal),
    );
  }

  private schedule(name: string, intervalMs: number, work: (signal: AbortSignal) => Promise<void>) {
    if (this.stopController.signal.aborted) return;
    const run = this.runJob(name, work);
    this.running.add(run);
    run
      .finally(() => {
        this.running.delete(run);
        if (this.stopController.signal.aborted) return;
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.schedule(name, intervalMs, work);
        }, intervalMs);
        timer.unref();
        this.timers.add(timer);
      })
      .catch((err: unknown) => this.logger.error({ err, job: name }, 'Scheduler lifecycle error'));
  }

  private async runJob(name: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    try {
      const lease = await this.repository.acquireLease(`job:${name}`, 30000);
      if (!lease) return;
      const signal = AbortSignal.any([lease.signal, this.stopController.signal]);
      try {
        signal.throwIfAborted();
        await work(signal);
        this.metrics.jobsCompleted++;
      } finally {
        await lease.release();
      }
    } catch (err) {
      if (this.stopController.signal.aborted) return;
      this.metrics.jobFailures++;
      this.logger.error({ err, job: name }, 'Background job failed; next run will retry');
    }
  }

  async discover(signal: AbortSignal): Promise<void> {
    const { MIN_ACTIVITY_ID_SCAN: min, MAX_ACTIVITY_ID_SCAN: max } = this.options;
    function* ids() {
      for (let id = min; id <= max; id++) yield String(id);
    }
    let completed = 0;
    let failed = 0;
    await forEachConcurrent(
      ids(),
      this.options.CONCURRENT_API_CALLS,
      async (id) => {
        signal.throwIfAborted();
        try {
          await this.catalog.warmActivity(id, signal);
        } catch (err) {
          signal.throwIfAborted();
          failed++;
          this.logger.debug({ err, activityId: id }, 'Discovery will retry failed activity');
        }
        completed++;
        if (completed % 100 === 0)
          this.logger.info({ completed, total: max - min + 1, failed }, 'Discovery progress');
      },
      signal,
    );
    this.logger.info({ completed, failed }, 'Discovery finished');
  }

  async refreshDue(signal: AbortSignal): Promise<void> {
    const ids = await this.repository.getDueActivityIds(Date.now(), 500);
    await forEachConcurrent(
      ids,
      this.options.CONCURRENT_API_CALLS,
      async (id) => {
        signal.throwIfAborted();
        try {
          await this.catalog.refreshActivity(id, signal, true);
        } catch (err) {
          signal.throwIfAborted();
          this.logger.debug({ err, activityId: id }, 'Refresh deferred after failure');
        }
      },
      signal,
    );
  }

  async close(): Promise<void> {
    this.stopController.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.running);
  }
}
