import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from './errors.ts';

/** Spaces individual HTTP attempts, including retries and post-login retries. */
export class RequestPacer {
  private nextStartAt = 0;

  constructor(private readonly requestsPerMinute: number) {
    if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 0)
      throw new RangeError('Invalid request rate');
  }

  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.requestsPerMinute === 0) return;
    const startAt = Math.max(Date.now(), this.nextStartAt);
    this.nextStartAt = startAt + 60000 / this.requestsPerMinute;
    const remaining = startAt - Date.now();
    if (remaining > 0) await delay(remaining, undefined, { signal });
    signal?.throwIfAborted();
  }
}

export function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** A bounded FIFO shared by HTTP misses and background work. */
export class FetchQueue {
  private active = 0;
  private readonly queue: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];
  private nextStartAt = 0;

  constructor(
    private readonly concurrency: number,
    private readonly maxPending: number,
    private readonly requestsPerMinute: number,
  ) {}

  get size() {
    return this.active + this.queue.length;
  }

  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.active < this.concurrency) this.active++;
    else {
      if (this.queue.length >= this.maxPending)
        throw new AppError('RATE_LIMITED', 'Fetch queue is full. Try again later.', 503);
      await new Promise<void>((resolve, reject) => {
        const item = {
          resolve,
          reject,
          signal,
          abort: () => {
            const index = this.queue.indexOf(item);
            if (index !== -1) this.queue.splice(index, 1);
            reject(signal.reason);
          },
        };
        this.queue.push(item);
        signal.addEventListener('abort', item.abort, { once: true });
      });
    }
    try {
      signal.throwIfAborted();
      if (this.requestsPerMinute > 0) {
        const startAt = Math.max(Date.now(), this.nextStartAt);
        this.nextStartAt = startAt + 60000 / this.requestsPerMinute;
        const remaining = startAt - Date.now();
        if (remaining > 0) await delay(remaining, undefined, { signal });
      }
      signal.throwIfAborted();
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) {
        next.signal.removeEventListener('abort', next.abort);
        next.resolve();
      } else this.active--;
    }
  }
}

export async function forEachConcurrent<T>(
  items: Iterable<T>,
  concurrency: number,
  work: (item: T) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const iterator = items[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!signal.aborted) {
        const next = iterator.next();
        if (next.done) return;
        await work(next.value);
      }
      signal.throwIfAborted();
    }),
  );
}

/** A scheduler owns its work; HTTP callers may detach without cancelling shared work. */
export class SharedJob<T> {
  private readonly controller = new AbortController();
  private readonly pending = Promise.withResolvers<T>();
  private readonly owners = new Map<AbortSignal, () => void>();
  private detachedSubscriber = false;
  readonly signal: AbortSignal;
  readonly promise = this.pending.promise;

  constructor(shutdown: AbortSignal) {
    this.signal = AbortSignal.any([shutdown, this.controller.signal]);
    const cleanup = () => {
      for (const [signal, listener] of this.owners) signal.removeEventListener('abort', listener);
      this.owners.clear();
    };
    this.promise.then(cleanup, cleanup);
  }

  subscribe(signal?: AbortSignal, ownsWork = false): Promise<T> {
    signal?.throwIfAborted();
    if (ownsWork && signal) {
      if (!this.owners.has(signal)) {
        const listener = () => {
          this.owners.delete(signal);
          if (!this.detachedSubscriber && this.owners.size === 0)
            this.controller.abort(signal.reason);
        };
        this.owners.set(signal, listener);
        signal.addEventListener('abort', listener, { once: true });
      }
    } else this.detachedSubscriber = true;
    return waitFor(this.promise, signal);
  }

  start(work: (signal: AbortSignal) => Promise<T>): void {
    Promise.resolve()
      .then(() => {
        this.signal.throwIfAborted();
        return waitFor(work(this.signal), this.signal);
      })
      .then(this.pending.resolve, this.pending.reject);
  }
}
