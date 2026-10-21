import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { AppError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';
import type { Metrics } from '../core/metrics.ts';
import type { CatalogService } from '../services/catalog.ts';
import type { Repository } from '../storage/repository.ts';

const filtersSchema = z.object({
  category: z.string().min(1).max(200).optional(),
  academicYear: z
    .string()
    .regex(/^\d{4}\/\d{4}$/)
    .refine((value) => Number(value.slice(5)) === Number(value.slice(0, 4)) + 1)
    .optional(),
  grade: z
    .string()
    .regex(/^(?:[1-9]|1[0-2])$/)
    .transform(Number)
    .optional(),
  isStudentLed: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .transform(Number)
    .refine((value) => value <= 500)
    .optional(),
  offset: z
    .string()
    .regex(/^\d{1,6}$/)
    .transform(Number)
    .optional(),
});

type HttpConfig = Pick<Config, 'allowedOrigins' | 'HTTP_REQUESTS_PER_MINUTE' | 'HTTP_TIMEOUT_MS'>;
export interface AppDependencies {
  config: HttpConfig;
  repository: Repository;
  catalog: Pick<CatalogService, 'getActivity' | 'getStaff' | 'queueSize'>;
  logger: Logger;
  metrics: Metrics;
  isShuttingDown?: () => boolean;
  getClientAddress?: (request: Request) => string;
}

export function createApp(deps: AppDependencies) {
  const app = new Hono<{ Variables: { requestId: string } }>();
  const { config, repository, catalog, logger, metrics } = deps;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  app.use('*', secureHeaders());
  app.use('*', async (context, next) => {
    const requestId = crypto.randomUUID();
    context.set('requestId', requestId);
    context.header('X-Request-ID', requestId);
    metrics.requests++;
    const started = performance.now();
    await next();
    logger.info(
      {
        requestId,
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs: Math.round(performance.now() - started),
      },
      'HTTP request',
    );
  });
  app.use('/v1/*', async (context, next) => {
    if (deps.isShuttingDown?.())
      throw new AppError('SHUTTING_DOWN', 'Service is shutting down.', 503);
    const origin = context.req.header('Origin');
    if (origin && !config.allowedOrigins.includes('*') && !config.allowedOrigins.includes(origin)) {
      return context.json({ error: 'Origin is not allowed.', code: 'VALIDATION_ERROR' }, 403);
    }
    if (config.HTTP_REQUESTS_PER_MINUTE > 0) {
      const now = Date.now();
      const address = deps.getClientAddress?.(context.req.raw) ?? 'unknown';
      let bucket = buckets.get(address);
      if (!bucket || now >= bucket.resetAt) {
        // Cap memory even when clients continually use new source addresses.
        if (buckets.size >= 10000) {
          for (const [key, value] of buckets) if (now >= value.resetAt) buckets.delete(key);
          if (buckets.size >= 10000)
            throw new AppError('RATE_LIMITED', 'Service is busy. Try again later.', 429);
        }
        bucket = { count: 0, resetAt: now + 60000 };
        buckets.set(address, bucket);
      }
      bucket.count++;
      if (bucket.count > config.HTTP_REQUESTS_PER_MINUTE) {
        context.header(
          'Retry-After',
          String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))),
        );
        throw new AppError('RATE_LIMITED', 'Too many requests. Try again later.', 429);
      }
    }
    await next();
  });
  app.use(
    '*',
    cors({
      origin: (origin) =>
        config.allowedOrigins.includes('*')
          ? '*'
          : config.allowedOrigins.includes(origin)
            ? origin
            : undefined,
      allowMethods: ['GET', 'HEAD', 'OPTIONS'],
      exposeHeaders: ['X-Request-ID', 'X-Cache', 'X-Data-Updated-At', 'X-Total-Count'],
      maxAge: 86400,
    }),
  );

  app.get('/', (context) =>
    context.json({
      name: 'DSAS CCA API',
      version: 2,
      endpoints: [
        '/v1/activity/list',
        '/v1/activity/category',
        '/v1/activity/academicYear',
        '/v1/activity/:activityId',
        '/v1/staffs',
        '/health/live',
        '/health/ready',
      ],
    }),
  );
  app.get('/health/live', (context) => context.json({ status: 'ok' }));
  app.get('/health/ready', async (context) => {
    if (deps.isShuttingDown?.()) return context.json({ status: 'shutting_down' }, 503);
    await repository.ping();
    return context.json({ status: 'ready' });
  });
  app.get('/metrics', (context) =>
    context.text(metrics.render(catalog.queueSize), 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    }),
  );

  app.get('/v1/activity/list', async (context) => {
    const params = new URL(context.req.url).searchParams;
    for (const key of params.keys()) {
      if (params.getAll(key).length > 1)
        throw new AppError('VALIDATION_ERROR', `Parameter ${key} must appear once.`, 400);
    }
    const parsed = filtersSchema.safeParse(Object.fromEntries(params));
    if (!parsed.success)
      throw new AppError(
        'VALIDATION_ERROR',
        `Invalid query parameter: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}.`,
        400,
      );
    const filters = parsed.data;
    const summaries = await repository.listActivitySummaries();
    const categories = [
      ...new Set(summaries.flatMap((entry) => (entry.category ? [entry.category] : []))),
    ].sort();
    const years = [
      ...new Set(summaries.flatMap((entry) => (entry.academicYear ? [entry.academicYear] : []))),
    ]
      .sort()
      .reverse();
    if (filters.category && !categories.includes(filters.category))
      return context.json(
        {
          error: 'Invalid category parameter. Category not found.',
          availableCategories: categories,
        },
        400,
      );
    if (filters.academicYear && !years.includes(filters.academicYear))
      return context.json(
        {
          error: 'Invalid academicYear parameter. Academic year not found.',
          availableAcademicYears: years,
        },
        400,
      );
    const filtered = summaries
      .filter((entry) => {
        if (filters.category && entry.category !== filters.category) return false;
        if (filters.academicYear && entry.academicYear !== filters.academicYear) return false;
        if (
          filters.isStudentLed !== undefined &&
          (entry.isStudentLed ?? false) !== filters.isStudentLed
        )
          return false;
        if (filters.grade !== undefined) {
          if (entry.grades.min === null || entry.grades.max === null) return false;
          const min = Number(entry.grades.min),
            max = Number(entry.grades.max);
          if (
            !Number.isFinite(min) ||
            !Number.isFinite(max) ||
            filters.grade < min ||
            filters.grade > max
          )
            return false;
        }
        return true;
      })
      .sort((a, b) => Number(a.id) - Number(b.id));
    const offset = filters.offset ?? 0;
    const page = filtered.slice(offset, filters.limit ? offset + filters.limit : undefined);
    context.header('X-Total-Count', String(filtered.length));
    return context.json(
      Object.fromEntries(
        page.map((entry) => [entry.id, { name: entry.name, photo: entry.photo ?? '' }]),
      ),
    );
  });

  app.get('/v1/activity/category', async (context) => {
    const summaries = await repository.listActivitySummaries();
    const counts = new Map<string, number>();
    for (const entry of summaries)
      if (entry.category) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    return context.json(Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))));
  });
  app.get('/v1/activity/academicYear', async (context) => {
    const summaries = await repository.listActivitySummaries();
    const counts = new Map<string, number>();
    for (const entry of summaries)
      if (entry.academicYear)
        counts.set(entry.academicYear, (counts.get(entry.academicYear) ?? 0) + 1);
    return context.json(Object.fromEntries([...counts].sort(([a], [b]) => b.localeCompare(a))));
  });
  app.get('/v1/activity/:activityId', async (context) => {
    const input = context.req.param('activityId');
    if (!/^\d{1,9}$/.test(input))
      throw new AppError('VALIDATION_ERROR', 'Invalid Activity ID format.', 400);
    const activityId = String(Number(input));
    const signal = AbortSignal.any([
      context.req.raw.signal,
      AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
    ]);
    const result = await catalog.getActivity(activityId, signal);
    context.header('X-Cache', result.cache);
    context.header('X-Data-Updated-At', result.entry.fetchedAt);
    if (!result.entry.value)
      return context.json(
        {
          error: `Activity ${activityId} not found.`,
          lastCheck: result.entry.fetchedAt,
          source: 'api-fetch-empty',
          cache: result.cache,
        },
        404,
      );
    return context.json({
      ...result.entry.value,
      lastCheck: result.entry.fetchedAt,
      cache: result.cache,
    });
  });
  app.get('/v1/staffs', async (context) => {
    const signal = AbortSignal.any([
      context.req.raw.signal,
      AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
    ]);
    const result = await catalog.getStaff(signal);
    context.header('X-Cache', result.cache);
    context.header('X-Data-Updated-At', result.entry.fetchedAt);
    return context.json({
      ...result.entry.value,
      lastCheck: result.entry.fetchedAt,
      cache: result.cache,
    });
  });

  app.notFound((context) => context.json({ error: 'Endpoint not found.', code: 'NOT_FOUND' }, 404));
  app.onError((error, context) => {
    const requestId = context.get('requestId');
    if (error instanceof AppError) {
      if (error.status >= 500) logger.error({ err: error, requestId }, 'Request failed');
      const status =
        error.status === 400
          ? 400
          : error.status === 404
            ? 404
            : error.status === 429
              ? 429
              : error.status === 504
                ? 504
                : 503;
      if (status === 503) context.header('Retry-After', '30');
      return context.json({ error: error.message, code: error.code, requestId }, status);
    }
    if (error.name === 'AbortError' || error.name === 'TimeoutError')
      return context.json(
        { error: 'Request timed out or was cancelled.', code: 'UPSTREAM_UNAVAILABLE', requestId },
        504,
      );
    logger.error({ err: error, requestId }, 'Unexpected request failure');
    return context.json({ error: 'An internal server error occurred.', requestId }, 500);
  });
  return app;
}
