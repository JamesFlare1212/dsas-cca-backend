import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { z } from 'zod';
import { AppError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import type { Activity, StaffDirectory } from '../domain/activity.ts';
import type { ActivitySummary, CacheEntry, Lease, Repository } from './repository.ts';

const text = z.string().nullable();
const flag = z.boolean().nullable();
const timestamp = z.iso.datetime({ offset: true });
const activitySchema: z.ZodType<Activity> = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  academicYear: text,
  category: text,
  description: text,
  photo: text,
  duration: z.strictObject({ startDate: text, endDate: text, isRecurringWeekly: flag }),
  grades: z.strictObject({ min: text, max: text }),
  isPreSignup: flag,
  isStudentLed: flag,
  materials: z.array(z.string()),
  meeting: z.strictObject({
    day: text,
    startTime: text,
    endTime: text,
    location: z.strictObject({ block: text, room: text, site: text }),
  }),
  poorWeatherPlan: text,
  schedule: text,
  semesterCost: text,
  requirements: z.array(z.string()),
  staff: z.array(z.string()),
  staffForReports: z.array(z.string()),
  studentLeaders: z.array(z.string()),
});
const activityEntrySchema = z.strictObject({
  value: activitySchema.nullable(),
  fetchedAt: timestamp,
});
const transientMissingSchema = z.strictObject({
  value: z.null(),
  fetchedAt: timestamp,
});
const staffEntrySchema = z.strictObject({
  value: z.record(z.string(), z.string()).nullable(),
  fetchedAt: timestamp,
});
const summarySchema: z.ZodType<ActivitySummary> = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  photo: z
    .string()
    .refine((value) => !/^data:/i.test(value.trimStart()))
    .nullable(),
  category: text,
  academicYear: text,
  grades: z.strictObject({ min: text, max: text }),
  isStudentLed: flag,
  lastCheck: timestamp,
});

// Read the durable record first, and inspect a transient record and its TTL in
// the same script so expiry cannot occur between those checks.
const GET_ACTIVITY = `
local activity = redis.call('HGET', KEYS[1], ARGV[1])
if activity then
  return {'durable', activity}
end
local missing = redis.call('GET', KEYS[2])
if not missing then
  return nil
end
if redis.call('PTTL', KEYS[2]) < 0 then
  return redis.error_reply('Invalid transient missing TTL')
end
return {'transient', missing}
`;

// Checking types before the first mutation prevents WRONGTYPE errors from leaving
// a partially updated record. Redis scripts run without interleaving commands.
const SAVE_ACTIVITY = `
local expected = {'hash', 'hash', 'zset'}
for i = 1, 3 do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= expected[i] then
    return redis.error_reply('Invalid activity storage key type')
  end
end
if ARGV[5] == 'NX' and redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
if ARGV[3] == '' then
  redis.call('HDEL', KEYS[2], ARGV[1])
else
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
end
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1])
redis.call('DEL', KEYS[4])
return 1
`;
const SAVE_TRANSIENT_MISSING = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return 0
end
local kind = redis.call('TYPE', KEYS[2]).ok
if kind ~= 'none' and kind ~= 'string' then
  return redis.error_reply('Invalid transient missing key type')
end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
return 1
`;
const RENEW_LEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
const RELEASE_LEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function unavailable(operation: string, cause?: unknown): AppError {
  return new AppError('STORAGE_UNAVAILABLE', `Redis ${operation} failed.`, 503, { cause });
}

function decode<T>(raw: string, schema: z.ZodType<T>): T {
  const value: unknown = JSON.parse(raw);
  return schema.parse(value);
}

function requireId(id: string): void {
  if (!id || id.length > 512) throw unavailable('identifier validation');
}

/**
 * Keys are <prefix>:v2:{activities,summaries,due,staff,missing:<id>,lease:<name>}.
 * A prefix already ending in :v2 is used as-is. No v1 keys are read or mutated.
 * Durable records (including tracked negative entries), summaries, and staff
 * never expire; freshness uses fetchedAt and the due sorted set instead.
 * Ad hoc negative entries use expiring missing keys without due enrollment.
 */
export class RedisRepository implements Repository {
  private readonly client: Redis;
  private readonly keys: { activities: string; summaries: string; due: string; staff: string };
  private readonly namespace: string;
  private connecting: Promise<void> | undefined;
  private initialized = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly leases = new Set<RedisLease>();

  constructor(
    options: { url: string; prefix: string },
    private readonly logger: Logger,
  ) {
    const prefix = options.prefix.replace(/:+$/, '');
    if (!/^[\w:-]+$/.test(prefix)) throw unavailable('prefix validation');
    this.namespace = /(?:^|:)v2$/.test(prefix) ? prefix : `${prefix}:v2`;
    this.keys = {
      activities: `${this.namespace}:activities`,
      summaries: `${this.namespace}:summaries`,
      due: `${this.namespace}:due`,
      staff: `${this.namespace}:staff`,
    };
    try {
      this.client = new Redis(options.url, {
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: 3000,
        commandTimeout: 5000,
        maxRetriesPerRequest: 0,
        retryStrategy: null,
        autoResendUnfulfilledCommands: false,
      });
    } catch (cause) {
      throw unavailable('configuration', cause);
    }
    this.client.on('error', () => {
      // Do not log connection URLs, credentials, or cached payloads.
      this.logger.warn('Redis connection error');
      for (const lease of this.leases) lease.lose(unavailable('lease connection'));
    });
    this.client.on('close', () => {
      this.initialized = false;
      for (const lease of this.leases) lease.lose(unavailable('lease connection closed'));
    });
  }

  private async ready(): Promise<void> {
    if (this.initialized && this.client.status === 'ready') return;
    if (!this.connecting) {
      this.connecting = (async () => {
        if (this.client.status !== 'ready') await this.client.connect();
        if ((await this.client.ping()) !== 'PONG') throw unavailable('initial ping');
        this.initialized = true;
      })().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private async run<T>(operation: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw unavailable('repository closed');
    const task = (async () => {
      try {
        await this.ready();
        if (this.closed) throw unavailable('repository closed');
        return await work();
      } catch (cause) {
        if (cause instanceof AppError && cause.code === 'STORAGE_UNAVAILABLE') throw cause;
        throw unavailable(operation, cause);
      }
    })();
    this.pending.add(task);
    try {
      return await task;
    } finally {
      this.pending.delete(task);
    }
  }

  async ping(): Promise<void> {
    await this.run('ping', async () => {
      if ((await this.client.ping()) !== 'PONG') throw unavailable('ping');
    });
  }

  async getActivity(id: string): Promise<CacheEntry<Activity> | null> {
    requireId(id);
    return this.run('read activity', async () => {
      const result: unknown = await this.client.eval(
        GET_ACTIVITY,
        2,
        this.keys.activities,
        `${this.namespace}:missing:${id}`,
        id,
      );
      if (result === null) return null;
      if (
        !Array.isArray(result) ||
        result.length !== 2 ||
        (result[0] !== 'durable' && result[0] !== 'transient') ||
        typeof result[1] !== 'string'
      ) {
        throw unavailable('activity read acknowledgement');
      }
      if (result[0] === 'transient') return decode(result[1], transientMissingSchema);
      const entry = decode(result[1], activityEntrySchema);
      if (entry.value && entry.value.id !== id) throw unavailable('activity ID integrity');
      return entry;
    });
  }

  async saveTransientMissing(id: string, fetchedAt: string, ttlMs: number): Promise<void> {
    requireId(id);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw unavailable('transient missing TTL validation');
    }
    await this.run('save transient missing', async () => {
      const valid = transientMissingSchema.parse({ value: null, fetchedAt });
      const result: unknown = await this.client.eval(
        SAVE_TRANSIENT_MISSING,
        2,
        this.keys.activities,
        `${this.namespace}:missing:${id}`,
        id,
        JSON.stringify(valid),
        String(ttlMs),
      );
      if (result !== 0 && result !== 1)
        throw unavailable('transient missing write acknowledgement');
    });
  }

  async hasDurableActivity(id: string): Promise<boolean> {
    requireId(id);
    return this.run(
      'read durable activity provenance',
      async () => (await this.client.hexists(this.keys.activities, id)) === 1,
    );
  }

  async saveActivity(
    id: string,
    entry: CacheEntry<Activity>,
    refreshAfterMs: number,
  ): Promise<void> {
    await this.writeActivity(id, entry, refreshAfterMs, false);
  }

  /** Migration must never overwrite a record refreshed by a running instance. */
  saveActivityIfAbsent(
    id: string,
    entry: CacheEntry<Activity>,
    refreshAfterMs: number,
  ): Promise<boolean> {
    return this.writeActivity(id, entry, refreshAfterMs, true);
  }

  private async writeActivity(
    id: string,
    entry: CacheEntry<Activity>,
    refreshAfterMs: number,
    onlyIfAbsent: boolean,
  ): Promise<boolean> {
    requireId(id);
    return this.run('save activity', async () => {
      const valid = activityEntrySchema.parse(entry);
      if (valid.value && valid.value.id !== id) throw unavailable('activity ID integrity');
      const dueAt = Date.parse(valid.fetchedAt) + refreshAfterMs;
      if (
        !Number.isSafeInteger(refreshAfterMs) ||
        refreshAfterMs < 0 ||
        !Number.isSafeInteger(dueAt)
      ) {
        throw unavailable('refresh time validation');
      }
      const activity = valid.value;
      const summary: ActivitySummary | null = activity
        ? {
            id,
            name: activity.name,
            photo:
              activity.photo && !/^data:/i.test(activity.photo.trimStart()) ? activity.photo : null,
            category: activity.category,
            academicYear: activity.academicYear,
            grades: activity.grades,
            isStudentLed: activity.isStudentLed,
            lastCheck: valid.fetchedAt,
          }
        : null;
      const result: unknown = await this.client.eval(
        SAVE_ACTIVITY,
        4,
        this.keys.activities,
        this.keys.summaries,
        this.keys.due,
        `${this.namespace}:missing:${id}`,
        id,
        JSON.stringify(valid),
        summary ? JSON.stringify(summary) : '',
        String(dueAt),
        onlyIfAbsent ? 'NX' : '',
      );
      if (result !== 1 && !(onlyIfAbsent && result === 0))
        throw unavailable('activity write acknowledgement');
      return result === 1;
    });
  }

  async listActivitySummaries(): Promise<ActivitySummary[]> {
    return this.run('list summaries', async () => {
      const rows = await this.client.hgetall(this.keys.summaries);
      return Object.entries(rows).map(([id, raw]) => {
        const summary = decode(raw, summarySchema);
        if (summary.id !== id) throw unavailable('summary ID integrity');
        return summary;
      });
    });
  }

  async getDueActivityIds(before: number, limit: number): Promise<string[]> {
    if (!Number.isFinite(before) || !Number.isSafeInteger(limit) || limit < 1) {
      throw unavailable('due query validation');
    }
    return this.run('read due activities', () =>
      this.client.zrangebyscore(this.keys.due, '-inf', before, 'LIMIT', 0, limit),
    );
  }

  async deferActivity(id: string, retryAt: number): Promise<void> {
    requireId(id);
    if (!Number.isSafeInteger(retryAt)) throw unavailable('retry time validation');
    await this.run('defer activity', async () => {
      await this.client.zadd(this.keys.due, retryAt, id);
    });
  }

  async getStaff(): Promise<CacheEntry<StaffDirectory> | null> {
    return this.run('read staff', async () => {
      const raw = await this.client.hget(this.keys.staff, 'all');
      return raw === null ? null : decode(raw, staffEntrySchema);
    });
  }

  async saveStaff(entry: CacheEntry<StaffDirectory>): Promise<void> {
    await this.run('save staff', async () => {
      await this.client.hset(this.keys.staff, 'all', JSON.stringify(staffEntrySchema.parse(entry)));
    });
  }

  async saveStaffIfAbsent(entry: CacheEntry<StaffDirectory>): Promise<boolean> {
    return this.run(
      'import staff',
      async () =>
        (await this.client.hsetnx(
          this.keys.staff,
          'all',
          JSON.stringify(staffEntrySchema.parse(entry)),
        )) === 1,
    );
  }

  async acquireLease(name: string, ttlMs: number): Promise<Lease | null> {
    requireId(name);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 3 || ttlMs > 2147483647) {
      throw unavailable('lease TTL validation');
    }
    return this.run('acquire lease', async () => {
      const key = `${this.namespace}:lease:${name}`;
      const token = randomUUID();
      const startedAt = performance.now();
      const result = await this.client.set(key, token, 'PX', ttlMs, 'NX');
      if (result === null) return null;
      if (result !== 'OK') throw unavailable('lease acquisition acknowledgement');
      const lease = new RedisLease(
        this.client,
        key,
        token,
        ttlMs,
        startedAt,
        () => {
          this.leases.delete(lease);
        },
        this.logger,
      );
      this.leases.add(lease);
      if (this.closed) {
        await lease.release();
        throw unavailable('repository closed');
      }
      if (lease.signal.aborted) {
        await lease.release();
        throw unavailable('lease acquisition expired');
      }
      return lease;
    });
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      // Abort immediately, even when a command or a lease acquisition is pending.
      for (const lease of this.leases) lease.lose(unavailable('repository closed'));
      this.closing = (async () => {
        try {
          await Promise.allSettled([...this.pending]);
          const results = await Promise.allSettled(
            [...this.leases].map((lease) => lease.release()),
          );
          const failure = results.find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw unavailable('close leases', failure.reason);
        } finally {
          this.client.disconnect();
        }
      })();
    }
    return this.closing;
  }
}

class RedisLease implements Lease {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private interval: ReturnType<typeof setInterval> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private renewing: Promise<void> | undefined;
  private releasing: Promise<void> | undefined;

  constructor(
    private readonly client: Redis,
    private readonly key: string,
    private readonly token: string,
    private readonly ttlMs: number,
    startedAt: number,
    private readonly onRelease: () => void,
    private readonly logger: Logger,
  ) {
    this.armExpiry(startedAt);
    if (!this.signal.aborted) {
      this.interval = setInterval(
        () => {
          if (this.renewing || this.signal.aborted) return;
          this.renewing = this.renew().finally(() => {
            this.renewing = undefined;
          });
        },
        Math.max(1, Math.floor(ttlMs / 3)),
      );
      this.interval.unref();
    }
  }

  private armExpiry(startedAt: number): void {
    if (this.expiry) clearTimeout(this.expiry);
    const remaining = startedAt + this.ttlMs - performance.now();
    if (remaining <= 0) {
      this.lose(unavailable('lease expired'));
      return;
    }
    // A stalled renewal must not leave callers working past the known TTL.
    this.expiry = setTimeout(() => this.lose(unavailable('lease expired')), remaining);
    this.expiry.unref();
  }

  private async renew(): Promise<void> {
    const startedAt = performance.now();
    try {
      const result: unknown = await this.client.eval(
        RENEW_LEASE,
        1,
        this.key,
        this.token,
        this.ttlMs,
      );
      if (result !== 1) this.lose(unavailable('lease ownership lost'));
      else if (!this.signal.aborted) this.armExpiry(startedAt);
    } catch {
      this.logger.warn('Redis lease renewal failed');
      this.lose(unavailable('lease renewal'));
    }
  }

  lose(reason: AppError): void {
    if (this.interval) clearInterval(this.interval);
    if (this.expiry) clearTimeout(this.expiry);
    if (!this.signal.aborted) this.controller.abort(reason);
  }

  release(): Promise<void> {
    if (!this.releasing) {
      this.lose(unavailable('lease released'));
      this.releasing = (async () => {
        try {
          await this.renewing;
          const result: unknown = await this.client.eval(RELEASE_LEASE, 1, this.key, this.token);
          if (result !== 0 && result !== 1) throw unavailable('lease release acknowledgement');
        } catch (cause) {
          throw unavailable('release lease', cause);
        } finally {
          this.onRelease();
        }
      })();
    }
    return this.releasing;
  }
}
