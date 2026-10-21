import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import pino from 'pino';
import sharp from 'sharp';
import {
  type ImageObjectStore,
  PassthroughImageStore,
  S3ImageStore,
  type S3ImageStoreOptions,
} from '../src/storage/images.ts';

const logger = pino({ level: 'silent' });
const options: S3ImageStoreOptions = {
  endpoint: 'https://objects.example.test',
  bucket: 'activities',
  accessKeyId: 'test-access',
  secretAccessKey: 'test-secret',
  region: 'us-east-1',
  publicUrl: 'https://cdn.example.test/root/',
  prefix: '/files/',
  maxInputBytes: 100000,
  maxPixels: 100000,
  concurrency: 2,
};

class MemoryObjects implements ImageObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  writes = 0;
  checks = 0;

  async exists(key: string): Promise<boolean> {
    this.checks++;
    return this.objects.has(key);
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    this.writes++;
    this.objects.set(key, data);
  }
}

async function png(width = 4, height = 4, background = '#cc5500'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
}

function dataUrl(input: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(input).toString('base64')}`;
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error('Not initialized');
  };
  let reject: (error: unknown) => void = () => {
    throw new Error('Not initialized');
  };
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Test operation did not settle')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('activity image storage', () => {
  test('unconfigured storage keeps URLs and omits embedded images without logging their contents', async () => {
    const logs: string[] = [];
    const logging = pino(
      { level: 'warn' },
      {
        write: (line: string) => {
          logs.push(line);
        },
      },
    );
    const store = new PassthroughImageStore(logging);
    const photo = dataUrl(await png());
    expect(await store.process(null, '1')).toBeNull();
    expect(await store.process('https://example.test/photo.jpg', '1')).toBe(
      'https://example.test/photo.jpg',
    );
    expect(await store.process(photo, '1')).toBeNull();
    expect(await store.process(`  ${photo}`, '2')).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs.join('')).not.toContain(photo.slice(photo.indexOf(',') + 1));
  });

  test('writes decodable AVIF using original-content SHA256 keys and encoded public paths', async () => {
    const objects = new MemoryObjects();
    const input = await png();
    const store = new S3ImageStore({ ...options, prefix: '/club photos/' }, logger, objects);
    const hash = createHash('sha256').update(input).digest('hex');
    const url = await store.process(dataUrl(input), '123');
    const key = `club photos/avif-v1/${hash}.avif`;
    expect(url).toBe(`https://cdn.example.test/root/activities/club%20photos/avif-v1/${hash}.avif`);
    expect(objects.writes).toBe(1);
    const bytes = objects.objects.get(key);
    expect(bytes).toBeDefined();
    if (!bytes) throw new Error('Missing uploaded image');
    const metadata = await sharp(bytes).metadata();
    expect(metadata.format).toBe('heif');
    expect(metadata.width).toBe(4);
    expect(metadata.height).toBe(4);
    expect(metadata.compression).toBe('av1');
  });

  test('duplicate images across concurrent callers and fresh stores reuse one stored object', async () => {
    const objects = new MemoryObjects();
    const store = new S3ImageStore(options, logger, objects);
    const photo = dataUrl(await png());
    const urls = await Promise.all([
      store.process(photo, '1'),
      store.process(photo, '2'),
      store.process(photo, '3'),
    ]);
    expect(new Set(urls).size).toBe(1);
    expect(objects.writes).toBe(1);
    expect(objects.checks).toBe(1);
    const freshStore = new S3ImageStore(options, logger, objects);
    expect(await freshStore.process(photo, '4')).toBe(urls[0] ?? null);
    expect(objects.writes).toBe(1);
    expect(objects.checks).toBe(2);
  });

  test('normal URLs and null never contact S3', async () => {
    const objects = new MemoryObjects();
    const store = new S3ImageStore(options, logger, objects);
    expect(await store.process(null, '1')).toBeNull();
    expect(await store.process('https://example.test/photo.jpg', '1')).toBe(
      'https://example.test/photo.jpg',
    );
    expect(objects.checks).toBe(0);
    expect(objects.writes).toBe(0);
  });

  test('custom endpoints, public service roots, AWS defaults, and dotted buckets generate correct URLs', async () => {
    const photo = dataUrl(await png());
    for (const [config, base] of [
      [
        { ...options, publicUrl: '', endpoint: 'http://localhost:9000/' },
        'http://localhost:9000/activities/files/',
      ],
      [
        { ...options, publicUrl: 'https://cdn.example.test/root///' },
        'https://cdn.example.test/root/activities/files/',
      ],
      [
        { ...options, publicUrl: '', endpoint: '' },
        'https://activities.s3.us-east-1.amazonaws.com/files/',
      ],
      [
        { ...options, publicUrl: '', endpoint: '', bucket: 'club.photos' },
        'https://s3.us-east-1.amazonaws.com/club.photos/files/',
      ],
    ] as const) {
      const store = new S3ImageStore(config, logger, new MemoryObjects());
      expect((await store.process(photo, '1'))?.startsWith(base)).toBe(true);
    }
  });

  test('byte, dimension, and pixel limits reject before any S3 operation', async () => {
    const objects = new MemoryObjects();
    const cases: Array<[S3ImageStoreOptions, string]> = [
      [{ ...options, maxInputBytes: 10 }, dataUrl(await png())],
      [{ ...options, maxPixels: 10 }, dataUrl(await png(8, 8))],
      [options, dataUrl(await png(16385, 1))],
    ];
    for (const [config, photo] of cases) {
      await expect(
        new S3ImageStore(config, logger, objects).process(photo, '1'),
      ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    }
    expect(objects.checks).toBe(0);
    expect(objects.writes).toBe(0);
  });

  test('invalid base64, unsupported data encodings, and corrupt images fail explicitly', async () => {
    const objects = new MemoryObjects();
    const store = new S3ImageStore(options, logger, objects);
    for (const photo of [
      'data:image/png;base64,',
      'data:image/png;base64,!invalid!',
      'data:image/png;base64,YR==',
      'data:image/png;base64,YQ=',
      'data:image/png;base64,YQ===',
      'data:image/png;utf8,hello',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:text/html;base64,PHNjcmlwdD4=',
      dataUrl(Buffer.from('not an image')),
    ]) {
      await expect(store.process(photo, '1')).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
      });
    }
    expect(objects.checks).toBe(0);
    expect(objects.writes).toBe(0);
  });

  test('object lookup and upload failures are explicit and retryable', async () => {
    const photo = dataUrl(await png());
    const objects = new MemoryObjects();
    let failLookup = true;
    let failUpload = true;
    const adapter: ImageObjectStore = {
      exists: async (key) => {
        if (failLookup) throw new Error('lookup failed');
        return objects.exists(key);
      },
      write: async (key, data) => {
        if (failUpload) throw new Error('upload failed');
        return objects.write(key, data);
      },
    };
    const store = new S3ImageStore(options, logger, adapter);
    await expect(store.process(photo, '1')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    failLookup = false;
    await expect(store.process(photo, '1')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    failUpload = false;
    expect(await store.process(photo, '1')).toBeString();
    expect(objects.writes).toBe(1);
  });

  test('pre-aborted work has no image or S3 side effects', async () => {
    const objects = new MemoryObjects();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const store = new S3ImageStore(options, logger, objects);
    await expect(store.process(dataUrl(await png()), '1', controller.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(objects.checks).toBe(0);
  });

  test('one cancelled subscriber does not cancel shared image processing', async () => {
    const objects = new MemoryObjects();
    const uploading = deferred<void>();
    const resume = deferred<void>();
    const store = new S3ImageStore(options, logger, {
      exists: (key) => objects.exists(key),
      write: async (key, data) => {
        uploading.resolve();
        await resume.promise;
        await objects.write(key, data);
      },
    });
    const controller = new AbortController();
    const photo = dataUrl(await png());
    const cancelled = store.process(photo, '1', controller.signal);
    const completed = store.process(photo, '2');
    await uploading.promise;
    controller.abort(new Error('subscriber cancelled'));
    await expect(cancelled).rejects.toThrow('subscriber cancelled');
    resume.resolve();
    expect(await completed).toBeString();
    expect(objects.writes).toBe(1);
  });

  test('queued cancellation skips work and native uploads retain their concurrency slot until settled', async () => {
    const objects = new MemoryObjects();
    const uploading = deferred<void>();
    const resume = deferred<void>();
    let activeUploads = 0;
    let maximumUploads = 0;
    const store = new S3ImageStore({ ...options, concurrency: 1 }, logger, {
      exists: (key) => objects.exists(key),
      write: async (key, data) => {
        activeUploads++;
        maximumUploads = Math.max(maximumUploads, activeUploads);
        uploading.resolve();
        await resume.promise;
        await objects.write(key, data);
        activeUploads--;
      },
    });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const photos = await Promise.all([
      png(4, 4, '#ff0000'),
      png(4, 4, '#00ff00'),
      png(4, 4, '#0000ff'),
    ]);
    const first = store.process(
      dataUrl(photos[0] ?? new Uint8Array()),
      '1',
      activeController.signal,
    );
    await uploading.promise;
    const queued = store.process(
      dataUrl(photos[1] ?? new Uint8Array()),
      '2',
      queuedController.signal,
    );
    const last = store.process(dataUrl(photos[2] ?? new Uint8Array()), '3');
    queuedController.abort(new Error('queued cancelled'));
    await expect(queued).rejects.toThrow('queued cancelled');
    activeController.abort(new Error('active cancelled'));
    await expect(first).rejects.toThrow('active cancelled');
    expect(objects.checks).toBe(1);
    expect(activeUploads).toBe(1);
    resume.resolve();
    expect(await last).toBeString();
    expect(maximumUploads).toBe(1);
    expect(objects.writes).toBe(2);
    expect(objects.checks).toBe(2);
  });

  test('cancelling a stalled lookup rejects promptly and skips its upload and cancelled queue entries', async () => {
    const objects = new MemoryObjects();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const photos = await Promise.all([png(), png(4, 4, '#001122'), png(4, 4, '#334455')]);
    const store = new S3ImageStore({ ...options, concurrency: 1 }, logger, {
      exists: async (key) => {
        const result = await objects.exists(key);
        if (objects.checks === 1) {
          entered.resolve();
          await resume.promise;
        }
        return result;
      },
      write: (key, bytes) => objects.write(key, bytes),
    });
    const active = new AbortController();
    const queued = new AbortController();
    const first = store.process(dataUrl(photos[0] ?? new Uint8Array()), '1', active.signal);
    try {
      await within(entered.promise);
      const cancelled = store.process(dataUrl(photos[1] ?? new Uint8Array()), '2', queued.signal);
      queued.abort(new Error('queued lookup cancelled'));
      active.abort(new Error('active lookup cancelled'));
      const cancelledResults = await Promise.allSettled([within(first), within(cancelled)]);
      expect(cancelledResults).toEqual([
        {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'active lookup cancelled' }),
        },
        {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'queued lookup cancelled' }),
        },
      ]);
      const last = store.process(dataUrl(photos[2] ?? new Uint8Array()), '3');
      expect(objects.checks).toBe(1);
      expect(objects.writes).toBe(0);
      resume.resolve();
      expect(await within(last)).toBeString();
      expect(objects.checks).toBe(2);
      expect(objects.writes).toBe(1);
    } finally {
      resume.resolve();
    }
  });

  test('stalled lookup deadlines expire replacement and queued jobs without starting more native work', async () => {
    const objects = new MemoryObjects();
    const entered = deferred<void>();
    const resume = deferred<void>();
    const photo = dataUrl(await png());
    const queuedPhoto = dataUrl(await png(4, 4, '#001122'));
    const store = new S3ImageStore({ ...options, concurrency: 1, operationTimeoutMs: 80 }, logger, {
      exists: async (key) => {
        const result = await objects.exists(key);
        if (objects.checks === 1) {
          entered.resolve();
          await resume.promise;
        }
        return result;
      },
      write: (key, bytes) => objects.write(key, bytes),
    });
    const first = store.process(photo, '1');
    try {
      await within(entered.promise);
      await expect(within(first)).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
        message: 'Activity image processing timed out.',
      });
      const replacement = store.process(photo, '2');
      const queued = store.process(queuedPhoto, '3');
      const timedOut = await Promise.allSettled([within(replacement), within(queued)]);
      expect(timedOut).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }) },
        { status: 'rejected', reason: expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }) },
      ]);
      expect(objects.checks).toBe(1);
      expect(objects.writes).toBe(0);
      expect(await within(store.process(null, '4'))).toBeNull();
      expect(await within(store.process('https://example.test/photo.jpg', '5'))).toBe(
        'https://example.test/photo.jpg',
      );
      resume.resolve();
      expect(await within(store.process(photo, '6'))).toBeString();
      expect(objects.checks).toBe(2);
      expect(objects.writes).toBe(1);
    } finally {
      resume.resolve();
    }
  });

  test('upload deadlines detach jobs but retain native concurrency until a late upload settles', async () => {
    const objects = new MemoryObjects();
    const entered = deferred<void>();
    const resume = deferred<void>();
    let activeUploads = 0;
    let maximumUploads = 0;
    const photo = dataUrl(await png());
    const queuedPhoto = dataUrl(await png(4, 4, '#001122'));
    const store = new S3ImageStore({ ...options, concurrency: 1, operationTimeoutMs: 80 }, logger, {
      exists: (key) => objects.exists(key),
      write: async (key, bytes) => {
        activeUploads++;
        maximumUploads = Math.max(maximumUploads, activeUploads);
        entered.resolve();
        await resume.promise;
        await objects.write(key, bytes);
        activeUploads--;
      },
    });
    const first = store.process(photo, '1');
    try {
      await within(entered.promise);
      await expect(within(first)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      await expect(within(store.process(queuedPhoto, '2'))).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
      });
      expect(activeUploads).toBe(1);
      expect(objects.checks).toBe(1);
      const replacement = store.process(photo, '3');
      resume.resolve();
      expect(await within(replacement)).toBeString();
      expect(activeUploads).toBe(0);
      expect(maximumUploads).toBe(1);
      expect(objects.writes).toBe(1);
      expect(objects.checks).toBe(2);
    } finally {
      resume.resolve();
    }
  });
});
