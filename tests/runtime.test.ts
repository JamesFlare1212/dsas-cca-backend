import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { loadConfig } from '../src/config.ts';
import { startServer } from '../src/index.ts';
import { RedisRepository } from '../src/storage/redis.ts';
import { activity, silentLogger } from './helpers.ts';

const integration = process.env.RUN_REDIS_TESTS === '1' ? test : test.skip;
integration(
  'real server provides cached API data and health checks without logging in, then drains on close',
  async () => {
    const prefix = `test-runtime-${randomUUID()}:v2`;
    const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
    const repository = new RedisRepository({ url: redisUrl, prefix }, silentLogger);
    const raw = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 0,
      retryStrategy: null,
    });
    raw.on('error', () => {});
    const portProbe = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('probe'),
    });
    const port = portProbe.port;
    await portProbe.stop(true);
    const config = loadConfig({
      API_USERNAME: 'fake',
      API_PASSWORD: 'fake',
      API_BASE_URL: 'http://127.0.0.1:1',
      HOST: '127.0.0.1',
      PORT: String(port),
      REDIS_URL: redisUrl,
      REDIS_KEY_PREFIX: prefix,
      SCHEDULER_ENABLED: 'false',
      LOG_LEVEL: 'silent',
    });
    let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      await repository.saveActivity(
        '3350',
        { value: activity(), fetchedAt: new Date().toISOString() },
        config.activityFreshMs,
      );
      runtime = await startServer(config);
      const root = `http://127.0.0.1:${runtime.server.port}`;
      expect((await fetch(`${root}/health/live`)).status).toBe(200);
      expect((await fetch(`${root}/health/ready`)).status).toBe(200);
      const detail = await fetch(`${root}/v1/activity/3350`);
      expect(detail.status).toBe(200);
      expect(detail.headers.get('X-Cache')).toBe('HIT');
      expect(await detail.json()).toMatchObject({ id: '3350', name: 'Chess Club', cache: 'HIT' });
      const list = await fetch(`${root}/v1/activity/list`);
      expect(await list.json()).toEqual({ '3350': { name: 'Chess Club', photo: '' } });
      await Promise.all([runtime.close(), runtime.close()]);
      expect(runtime.server.pendingRequests).toBe(0);
      await expect(fetch(`${root}/health/ready`)).rejects.toBeDefined();
    } finally {
      await runtime?.close();
      await repository.close();
      try {
        await raw.connect();
        const keys = await raw.keys(`${prefix}:*`);
        if (keys.length) await raw.del(...keys);
      } finally {
        raw.disconnect();
      }
    }
  },
  10000,
);
