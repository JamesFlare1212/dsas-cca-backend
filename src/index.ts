import { join } from 'node:path';
import { type Config, loadConfig } from './config.ts';
import { AppError } from './core/errors.ts';
import { createLogger } from './core/logger.ts';
import { Metrics } from './core/metrics.ts';
import { createApp } from './http/app.ts';
import { CatalogService } from './services/catalog.ts';
import { Scheduler } from './services/scheduler.ts';
import { PassthroughImageStore, S3ImageStore } from './storage/images.ts';
import { RedisRepository } from './storage/redis.ts';
import { CookieAuth } from './upstream/auth.ts';
import { EngageClient } from './upstream/client.ts';

export async function startServer(config: Config = loadConfig()) {
  const logger = createLogger(config.LOG_LEVEL);
  const repository = new RedisRepository(
    { url: config.REDIS_URL, prefix: config.REDIS_KEY_PREFIX },
    logger,
  );
  const auth = new CookieAuth(
    {
      baseUrl: config.API_BASE_URL,
      username: config.API_USERNAME,
      password: config.API_PASSWORD,
      cookiePath: join(config.DATA_DIR, 'cookies.json'),
      loginTimeoutMs: config.AUTH_LOGIN_TIMEOUT_MS,
      authCooldownMs: config.AUTH_FAILURE_COOLDOWN_MS,
      credentialsEncoded: config.API_CREDENTIALS_URL_ENCODED,
    },
    logger,
  );
  const source = new EngageClient(
    {
      baseUrl: config.API_BASE_URL,
      requestTimeoutMs: config.CRAWLER_REQUEST_TIMEOUT_MS,
      maxRetries: config.CRAWLER_MAX_RETRIES,
      retryDelayMs: config.CRAWLER_RETRY_DELAY_MS,
      maxResponseBytes: config.MAX_UPSTREAM_RESPONSE_BYTES,
      requestsPerMinute: config.CRAWLER_REQUESTS_PER_MINUTE,
    },
    auth,
    logger,
  );
  const images =
    config.S3_BUCKET_NAME && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? new S3ImageStore(
          {
            endpoint: config.S3_ENDPOINT ?? '',
            bucket: config.S3_BUCKET_NAME,
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
            region: config.S3_REGION,
            publicUrl: config.S3_PUBLIC_URL ?? '',
            prefix: config.S3_PUBLIC_URL_PREFIX,
            maxInputBytes: config.IMAGE_MAX_INPUT_BYTES,
            maxPixels: config.IMAGE_MAX_PIXELS,
            concurrency: config.IMAGE_CONCURRENCY,
            operationTimeoutMs: config.IMAGE_PROCESS_TIMEOUT_MS,
          },
          logger,
        )
      : new PassthroughImageStore(logger);
  const metrics = new Metrics();
  const catalog = new CatalogService(repository, source, images, config, logger, metrics);
  const scheduler = new Scheduler(repository, catalog, config, logger, metrics);
  let shuttingDown = false;
  let closePromise: Promise<void> | undefined;
  let server: Bun.Server<undefined> | undefined;
  const app = createApp({
    config,
    repository,
    catalog,
    logger,
    metrics,
    isShuttingDown: () => shuttingDown,
    getClientAddress: (request) => server?.requestIP(request)?.address ?? 'unknown',
  });
  try {
    await repository.ping();
    server = Bun.serve({
      hostname: config.HOST,
      port: config.PORT,
      idleTimeout: Math.min(255, Math.ceil(config.HTTP_TIMEOUT_MS / 1000) + 5),
      fetch: app.fetch,
    });
  } catch (err) {
    await Promise.allSettled([repository.close(), auth.close(), catalog.close()]);
    throw err;
  }
  if (config.SCHEDULER_ENABLED) scheduler.start();
  logger.info(
    { host: config.HOST, port: server.port, bun: Bun.version, scheduler: config.SCHEDULER_ENABLED },
    'DSAS CCA API started',
  );

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    shuttingDown = true;
    closePromise = (async () => {
      logger.info('Draining HTTP requests and background work');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          logger.error('Graceful shutdown deadline reached; closing remaining connections');
          void server?.stop(true);
          reject(new AppError('SHUTTING_DOWN', 'Graceful shutdown deadline exceeded.'));
        }, config.SHUTDOWN_TIMEOUT_MS);
        timer.unref();
      });
      try {
        const drain = Promise.allSettled([
          scheduler.close(),
          catalog.close(),
          auth.close(),
          server?.stop(false),
        ]).then(async (results) => {
          await repository.close();
          const failure = results.find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
        });
        await Promise.race([drain, deadline]);
      } finally {
        clearTimeout(timer);
      }
      logger.info('Shutdown complete');
    })();
    return closePromise;
  }
  return { server, app, close };
}

if (import.meta.main) {
  try {
    const runtime = await startServer();
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      runtime.close().then(
        () => {
          process.exit(0);
        },
        () => {
          process.exit(1);
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    // Startup failures may originate in URLs or SDKs that include credentials.
    console.error(
      error instanceof Error && error.message.startsWith('Invalid configuration:')
        ? error.message
        : 'Startup failed. Check configuration and Redis connectivity.',
    );
    process.exitCode = 1;
  }
}
