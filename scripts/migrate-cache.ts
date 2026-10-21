import Redis from 'ioredis';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/core/logger.ts';
import { decodeLegacyActivity, decodeLegacyStaff } from '../src/storage/migrate.ts';
import { RedisRepository } from '../src/storage/redis.ts';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const source = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 3000,
  commandTimeout: 5000,
  maxRetriesPerRequest: 0,
  retryStrategy: null,
});
source.on('error', () => logger.error('Legacy Redis connection failed.'));
const target = new RedisRepository(
  { url: config.REDIS_URL, prefix: config.REDIS_KEY_PREFIX },
  logger,
);
let imported = 0,
  skipped = 0;
try {
  await source.connect();
  await target.ping();
  const lease = await target.acquireLease('migration', 30000);
  if (!lease) throw new Error('Another migration is already running.');
  try {
    let cursor = '0';
    do {
      lease.signal.throwIfAborted();
      const [next, keys] = await source.scan(cursor, 'MATCH', 'activity:*', 'COUNT', 100);
      cursor = next;
      if (keys.length === 0) continue;
      const values = await source.mget(...keys);
      for (let index = 0; index < keys.length; index++) {
        lease.signal.throwIfAborted();
        const key = keys[index],
          serialized = values[index];
        if (!key || !serialized) {
          skipped++;
          continue;
        }
        const id = key.slice('activity:'.length);
        if (await target.getActivity(id)) {
          skipped++;
          continue;
        }
        try {
          const entry = decodeLegacyActivity(JSON.parse(serialized), id);
          if (!entry) {
            skipped++;
            continue;
          }
          if (await target.saveActivityIfAbsent(id, entry, config.activityFreshMs)) imported++;
          else skipped++;
        } catch (err) {
          // A malformed legacy record is skipped; storage failures terminate migration.
          if (err instanceof SyntaxError) {
            skipped++;
            continue;
          }
          throw err;
        }
      }
    } while (cursor !== '0');
    if (!(await target.getStaff())) {
      const serialized = await source.get('staffs:all');
      if (serialized) {
        try {
          const entry = decodeLegacyStaff(JSON.parse(serialized));
          if (entry) await target.saveStaffIfAbsent(entry);
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    }
  } finally {
    await lease.release();
  }
  logger.info({ imported, skipped }, 'Legacy cache copied. Original keys were not modified.');
} finally {
  source.disconnect();
  await target.close();
}
