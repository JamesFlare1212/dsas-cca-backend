import { resolve } from 'node:path';
import { z } from 'zod';

const integer = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? fallback : v),
    z.coerce.number().int().min(min).max(max),
  );
const boolean = (fallback: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? String(fallback) : v),
    z.enum(['true', 'false']).transform((v) => v === 'true'),
  );
const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, 'Expected an HTTP(S) URL without embedded credentials, query or fragment');

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: integer(3000, 1, 65535),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_BASE_URL: httpUrl.default('https://engage.nkcswx.cn'),
    API_USERNAME: z.string().min(1),
    API_PASSWORD: z.string().min(1),
    API_CREDENTIALS_URL_ENCODED: boolean(true),
    DATA_DIR: z.string().default('./data'),
    REDIS_URL: z
      .url()
      .refine((value) => /^rediss?:/.test(value), 'Expected a Redis URL')
      .default('redis://127.0.0.1:6379'),
    REDIS_KEY_PREFIX: z
      .string()
      .regex(/^[a-zA-Z0-9:_-]+$/)
      .default('dsas:v2'),
    ALLOWED_ORIGINS: z.string().default('*'),
    FIXED_STAFF_ACTIVITY_ID: z
      .string()
      .regex(/^\d{1,9}$/)
      .default('7095'),
    MIN_ACTIVITY_ID_SCAN: integer(3000, 0, 999999999),
    MAX_ACTIVITY_ID_SCAN: integer(8000, 0, 999999999),
    CONCURRENT_API_CALLS: integer(4, 1, 32),
    MAX_PENDING_FETCHES: integer(256, 1, 10000),
    CRAWLER_REQUEST_TIMEOUT_MS: integer(15000, 100, 120000),
    CRAWLER_MAX_RETRIES: integer(2, 0, 5),
    CRAWLER_RETRY_DELAY_MS: integer(1000, 0, 30000),
    CRAWLER_REQUESTS_PER_MINUTE: integer(120, 0, 60000),
    MAX_UPSTREAM_RESPONSE_BYTES: integer(20000000, 1024, 100000000),
    AUTH_LOGIN_TIMEOUT_MS: integer(60000, 1000, 180000),
    AUTH_FAILURE_COOLDOWN_MS: integer(30000, 1000, 300000),
    CIRCUIT_FAILURE_THRESHOLD: integer(5, 1, 100),
    CIRCUIT_COOLDOWN_MS: integer(30000, 1000, 300000),
    CLUB_UPDATE_INTERVAL_MINS: integer(360, 1, 10080),
    STAFF_UPDATE_INTERVAL_MINS: integer(360, 1, 10080),
    CLUB_CHECK_INTERVAL_SECONDS: integer(60, 1, 3600),
    STAFF_CHECK_INTERVAL_SECONDS: integer(60, 1, 3600),
    DISCOVERY_INTERVAL_MINS: integer(360, 1, 10080),
    ERROR_CACHE_TTL: integer(3600, 1, 86400),
    FAILED_FETCH_RETRY_SECONDS: integer(60, 1, 3600),
    SCHEDULER_ENABLED: boolean(true),
    HTTP_REQUESTS_PER_MINUTE: integer(600, 0, 600000),
    HTTP_TIMEOUT_MS: integer(120000, 1000, 180000),
    SHUTDOWN_TIMEOUT_MS: integer(15000, 1000, 120000),
    S3_ENDPOINT: optionalString,
    S3_PUBLIC_URL: optionalString,
    S3_BUCKET_NAME: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_REGION: z.string().default('us-east-1'),
    S3_PUBLIC_URL_PREFIX: z.string().default('files'),
    IMAGE_MAX_INPUT_BYTES: integer(10000000, 1024, 50000000),
    IMAGE_MAX_PIXELS: integer(24000000, 1, 100000000),
    IMAGE_CONCURRENCY: integer(2, 1, 8),
    IMAGE_PROCESS_TIMEOUT_MS: integer(10000, 100, 60000),
  })
  .superRefine((env, context) => {
    if (
      env.MAX_ACTIVITY_ID_SCAN < env.MIN_ACTIVITY_ID_SCAN ||
      env.MAX_ACTIVITY_ID_SCAN - env.MIN_ACTIVITY_ID_SCAN > 100000
    ) {
      context.addIssue({
        code: 'custom',
        path: ['MAX_ACTIVITY_ID_SCAN'],
        message: 'Scan range must be ordered and contain at most 100001 IDs',
      });
    }
    const s3 = [env.S3_BUCKET_NAME, env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY];
    if (s3.some(Boolean) && !s3.every(Boolean)) {
      context.addIssue({
        code: 'custom',
        path: ['S3_BUCKET_NAME'],
        message: 'S3 bucket and both credentials must be configured together',
      });
    }
    for (const key of ['S3_ENDPOINT', 'S3_PUBLIC_URL'] as const) {
      const value = env[key];
      if (value && !httpUrl.safeParse(value).success)
        context.addIssue({ code: 'custom', path: [key], message: 'Expected an absolute URL' });
    }
    const originList = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    if (
      originList.some(
        (origin) => origin !== '*' && (!URL.canParse(origin) || new URL(origin).origin !== origin),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ALLOWED_ORIGINS'],
        message: 'Expected comma separated origins or *',
      });
    }
  });

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    // Report field names, never supplied values or credentials.
    throw new Error(
      `Invalid configuration: ${[...new Set(result.error.issues.map((issue) => issue.path.join('.')))].join(', ')}`,
    );
  }
  const value = result.data;
  return {
    ...value,
    DATA_DIR: resolve(value.DATA_DIR),
    allowedOrigins: value.ALLOWED_ORIGINS.split(',').map((s) => s.trim()),
    activityFreshMs: value.CLUB_UPDATE_INTERVAL_MINS * 60000,
    staffFreshMs: value.STAFF_UPDATE_INTERVAL_MINS * 60000,
    negativeFreshMs: value.ERROR_CACHE_TTL * 1000,
  };
}
export type Config = ReturnType<typeof loadConfig>;
