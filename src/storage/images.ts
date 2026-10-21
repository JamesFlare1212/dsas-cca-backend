import { createHash } from 'node:crypto';
import { S3Client } from 'bun';
import sharp from 'sharp';
import { AppError } from '../core/errors.ts';
import type { Logger } from '../core/logger.ts';

export interface ImageStore {
  process(photo: string | null, activityId: string, signal?: AbortSignal): Promise<string | null>;
}

/** Keeps ordinary URLs; omits embedded data when object storage is unconfigured. */
export class PassthroughImageStore implements ImageStore {
  private warned = false;

  constructor(private readonly logger: Logger) {}

  async process(
    photo: string | null,
    _activityId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    if (photo !== null && /^data:/i.test(photo.trimStart())) {
      if (!this.warned) {
        this.logger.warn('Embedded activity images omitted because object storage is unconfigured');
        this.warned = true;
      }
      return null;
    }
    return photo;
  }
}

export interface S3ImageStoreOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  publicUrl: string;
  prefix: string;
  maxInputBytes: number;
  maxPixels: number;
  concurrency: number;
  /** Includes queue time; defaults to 10 seconds. Native S3 work can outlive it. */
  operationTimeoutMs?: number;
}

/** Optional adapter for deterministic tests and other S3-compatible transports. */
export interface ImageObjectStore {
  exists(key: string): Promise<boolean>;
  write(key: string, data: Uint8Array): Promise<void>;
}

const MAX_DIMENSION = 16384;
// Change this version when conversion settings change, so old objects remain valid.
const CONVERTER_VERSION = 'avif-v1';

function imageError(message: string, cause?: unknown): AppError {
  return new AppError('STORAGE_UNAVAILABLE', message, 503, { cause });
}

function checkPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw imageError('Invalid image storage limits.');
}

function baseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('Invalid public URL');
    }
    return url;
  } catch {
    throw imageError('Invalid image storage URL.');
  }
}

function normalizePrefix(prefix: string): string {
  const parts = prefix.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\\'))) {
    throw imageError('Invalid image object prefix.');
  }
  return parts.join('/');
}

function readPayload(photo: string, maxInputBytes: number): string {
  const comma = photo.indexOf(',');
  if (
    comma < 0 ||
    comma > 128 ||
    !/^data:image\/(?:png|jpe?g|webp|gif|avif|tiff?);base64$/i.test(photo.slice(0, comma))
  ) {
    throw imageError('Unsupported embedded image encoding.');
  }
  const length = photo.length - comma - 1;
  if (!length || length > Math.ceil(maxInputBytes / 3) * 4) {
    throw imageError('Embedded image exceeds the input byte limit or is empty.');
  }
  const payload = photo.slice(comma + 1);
  if (length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw imageError('Invalid embedded image base64.');
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  if ((length / 4) * 3 - padding > maxInputBytes) {
    throw imageError('Embedded image exceeds the input byte limit.');
  }
  return payload;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<{
    signal: AbortSignal;
    abort: () => void;
    resolve: (release: () => void) => void;
  }> = [];

  constructor(private readonly concurrency: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.concurrency) {
      this.active++;
      return this.releaser();
    }
    if (this.queue.length >= 128) throw imageError('Image processing queue is full.');
    return new Promise<() => void>((resolve, reject) => {
      const item = {
        signal,
        resolve,
        abort: () => {
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
        },
      };
      this.queue.push(item);
      signal.addEventListener('abort', item.abort, { once: true });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.abort);
        next.resolve(this.releaser());
      } else this.active--;
    };
  }
}

interface ImageJob {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
}

/**
 * publicUrl is a service root, preserving the legacy URL convention:
 *   <publicUrl>/<bucket>/<prefix>/avif-v1/<sha256-of-original-bytes>.avif
 * An empty publicUrl uses a custom endpoint with the same path-style convention;
 * with neither set, URLs use https://<bucket>.s3.<region>.amazonaws.com/<key>
 * (path-style for dotted bucket names, to support standard S3 TLS certificates).
 * Supply the service root, not a bucket URL, for publicUrl/custom endpoint.
 * The bucket's policy controls read access; uploads do not set an ACL.
 *
 * Bun 1.4.3 S3Options has neither AbortSignal nor a transport timeout. A job's
 * deadline or cancellation rejects its callers and prevents subsequent work,
 * but an existing native lookup/upload retains its semaphore slot until it
 * settles. Logical jobs expire independently, including while queued; retries
 * cannot start unbounded native work behind a stalled transport. Content
 * addressing makes a late upload harmless and reusable by a later request.
 */
export class S3ImageStore implements ImageStore {
  private readonly objects: ImageObjectStore;
  private readonly semaphore: Semaphore;
  private readonly prefix: string;
  private readonly publicBase: string;
  private readonly operationTimeoutMs: number;
  private readonly jobs = new Map<string, ImageJob>();

  constructor(
    private readonly options: S3ImageStoreOptions,
    private readonly logger: Logger,
    objects?: ImageObjectStore,
  ) {
    checkPositiveInteger(options.maxInputBytes);
    checkPositiveInteger(options.maxPixels);
    checkPositiveInteger(options.concurrency);
    this.operationTimeoutMs = options.operationTimeoutMs ?? 10000;
    checkPositiveInteger(this.operationTimeoutMs);
    if (this.operationTimeoutMs > 2_147_483_647) throw imageError('Invalid image storage timeout.');
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(options.bucket) ||
      !/^[a-z0-9-]+$/.test(options.region)
    ) {
      throw imageError('Invalid image storage bucket or region.');
    }
    this.prefix = normalizePrefix(options.prefix);
    this.semaphore = new Semaphore(options.concurrency);
    const endpoint = options.endpoint
      ? baseUrl(options.endpoint).toString().replace(/\/+$/, '')
      : '';
    const root = options.publicUrl || endpoint;
    this.publicBase = root
      ? `${baseUrl(root).toString().replace(/\/+$/, '')}/${encodeURIComponent(options.bucket)}`
      : options.bucket.includes('.')
        ? `https://s3.${options.region}.amazonaws.com/${options.bucket}`
        : `https://${options.bucket}.s3.${options.region}.amazonaws.com`;
    if (objects) this.objects = objects;
    else {
      try {
        const client = new S3Client({
          // Explicit AWS fallback prevents ambient S3_ENDPOINT from silently
          // overriding the constructor's options.
          endpoint: endpoint || `https://s3.${options.region}.amazonaws.com`,
          bucket: options.bucket,
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
          region: options.region,
          retry: 1,
        });
        this.objects = {
          exists: (key) => client.exists(key),
          write: async (key, data) => {
            await client.write(key, data, { type: 'image/avif' });
          },
        };
      } catch {
        throw imageError('Image storage initialization failed.');
      }
    }
  }

  async process(
    photo: string | null,
    _activityId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    if (photo === null || !/^data:/i.test(photo.trimStart())) return photo;
    const payload = readPayload(photo.trim(), this.options.maxInputBytes);
    // Canonical base64 gives identical in-flight keys without decoding buffers
    // for queued requests. The persistent object key hashes the decoded bytes.
    const jobKey = createHash('sha256').update(payload).digest('hex');
    let job = this.jobs.get(jobKey);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(imageError('Activity image processing timed out.')),
        this.operationTimeoutMs,
      );
      const created: ImageJob = {
        controller,
        waiters: 0,
        // Only the logical job races cancellation. convert keeps ownership of
        // its semaphore slot until any native S3 promise actually settles.
        promise: abortable(this.convert(payload, controller.signal), controller.signal).finally(
          () => {
            clearTimeout(timer);
            if (this.jobs.get(jobKey) === created) this.jobs.delete(jobKey);
          },
        ),
      };
      job = created;
      this.jobs.set(jobKey, job);
    }
    job.waiters++;
    try {
      return await abortable(job.promise, signal);
    } finally {
      job.waiters--;
      if (job.waiters === 0)
        job.controller.abort(new DOMException('Image processing cancelled', 'AbortError'));
    }
  }

  private async convert(payload: string, signal: AbortSignal): Promise<string> {
    const release = await this.semaphore.acquire(signal);
    let pipeline: ReturnType<typeof sharp> | undefined;
    const abort = () => pipeline?.destroy();
    try {
      signal.throwIfAborted();
      const input = Buffer.from(payload, 'base64');
      if (input.toString('base64') !== payload || input.length > this.options.maxInputBytes) {
        throw imageError('Invalid embedded image base64.');
      }
      pipeline = sharp(input, {
        limitInputPixels: this.options.maxPixels,
        failOn: 'warning',
        sequentialRead: true,
      }).timeout({ seconds: 30 });
      signal.addEventListener('abort', abort, { once: true });
      const metadata = await pipeline.metadata();
      signal.throwIfAborted();
      const { width, height } = metadata;
      if (
        !width ||
        !height ||
        width > MAX_DIMENSION ||
        height > MAX_DIMENSION ||
        width * height > this.options.maxPixels ||
        (metadata.pages ?? 1) > 1 ||
        !['png', 'jpeg', 'webp', 'gif', 'heif', 'avif', 'tiff'].includes(metadata.format ?? '')
      ) {
        throw imageError('Image dimensions, format, or frame count exceed supported limits.');
      }
      const hash = createHash('sha256').update(input).digest('hex');
      const key = [this.prefix, CONVERTER_VERSION, `${hash}.avif`].filter(Boolean).join('/');
      const url = `${this.publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
      if (await this.objects.exists(key)) {
        signal.throwIfAborted();
        return url;
      }
      signal.throwIfAborted();
      const output = await pipeline.rotate().avif({ quality: 55, effort: 4 }).toBuffer();
      signal.throwIfAborted();
      await this.objects.write(key, output);
      signal.throwIfAborted();
      return url;
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      this.logger.warn('Activity image processing failed');
      if (cause instanceof AppError) throw cause;
      throw imageError('Activity image conversion or storage failed.', cause);
    } finally {
      signal.removeEventListener('abort', abort);
      pipeline?.destroy();
      release();
    }
  }
}
