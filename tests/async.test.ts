import { describe, expect, test } from 'bun:test';
import { FetchQueue, forEachConcurrent, waitFor } from '../src/core/async.ts';

describe('bounded async work', () => {
  test('queue enforces concurrency, starts pending work in FIFO order, and recovers a failed slot', async () => {
    const queue = new FetchQueue(2, 3, 0);
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const signal = new AbortController().signal;
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    async function task(id: number, gate?: Promise<void>) {
      started.push(id);
      active++;
      peak = Math.max(peak, active);
      try {
        await gate;
        if (id === 3) throw new Error('One fetch failed');
        return id;
      } finally {
        active--;
      }
    }
    const one = queue.run(() => task(1, first.promise), signal);
    const two = queue.run(() => task(2, second.promise), signal);
    const three = queue
      .run(() => task(3), signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    const four = queue.run(() => task(4), signal);
    const five = queue.run(() => task(5), signal);
    try {
      expect(started).toEqual([1, 2]);
      expect(queue.size).toBe(5);
      first.resolve();
      expect(await three).toEqual(new Error('One fetch failed'));
      expect(await Promise.all([one, four, five])).toEqual([1, 4, 5]);
      expect(started).toEqual([1, 2, 3, 4, 5]);
      expect(peak).toBe(2);
      expect(queue.size).toBe(1);
    } finally {
      first.resolve();
      second.resolve();
    }
    expect(await two).toBe(2);
    expect(queue.size).toBe(0);
  });

  test('backpressure rejects overflow and cancelling a pending caller immediately frees its place', async () => {
    const queue = new FetchQueue(1, 1, 0);
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const started: string[] = [];
    const active = queue.run(async () => {
      started.push('active');
      await release.promise;
      return 'active';
    }, new AbortController().signal);
    const cancelled = queue.run(async () => {
      started.push('cancelled');
    }, controller.signal);
    const cancellation = cancelled.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      const overflow = queue.run(async () => {
        started.push('overflow');
      }, new AbortController().signal);
      await expect(overflow).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 503 });
      expect(queue.size).toBe(2);
      const reason = new DOMException('Caller left', 'AbortError');
      controller.abort(reason);
      expect(await cancellation).toBe(reason);
      expect(queue.size).toBe(1);
      const replacement = queue.run(async () => {
        started.push('replacement');
        return 42;
      }, new AbortController().signal);
      expect(queue.size).toBe(2);
      release.resolve();
      expect(await replacement).toBe(42);
      expect(await active).toBe('active');
      expect(started).toEqual(['active', 'replacement']);
      expect(queue.size).toBe(0);
    } finally {
      controller.abort();
      release.resolve();
      await active;
    }
  }, 1000);

  test('already cancelled work never enters the queue or invokes its task', async () => {
    const queue = new FetchQueue(1, 1, 0);
    let calls = 0;
    await expect(
      queue.run(async () => {
        calls++;
      }, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
    expect(queue.size).toBe(0);
    expect(await queue.run(async () => 42, new AbortController().signal)).toBe(42);
    expect(queue.size).toBe(0);
  });

  test('cancellation interrupts a minute-long pacing wait and releases its active slot', async () => {
    const queue = new FetchQueue(1, 1, 1);
    await queue.run(async () => 'first', new AbortController().signal);
    const controller = new AbortController();
    let started = false;
    const paced = queue.run(async () => {
      started = true;
    }, controller.signal);
    const rejected = paced.then(
      () => null,
      (error: unknown) => error,
    );
    controller.abort();
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    expect(started).toBe(false);
    expect(queue.size).toBe(0);
  }, 1000);

  test('one cancelled waiter rejects promptly while another still receives the shared result', async () => {
    const shared = Promise.withResolvers<number>();
    const controller = new AbortController();
    const cancelled = waitFor(shared.promise, controller.signal);
    const rejected = cancelled.then(
      () => null,
      (error: unknown) => error,
    );
    const surviving = waitFor(shared.promise, new AbortController().signal);
    const reason = new DOMException('Caller left', 'AbortError');
    controller.abort(reason);
    expect(await rejected).toBe(reason);
    shared.resolve(42);
    expect(await surviving).toBe(42);
    expect(await shared.promise).toBe(42);
  }, 1000);

  test('shared rejection propagates and an already aborted waiter rejects without waiting', async () => {
    const shared = Promise.withResolvers<number>();
    const error = new Error('Fetch failed');
    const waiting = waitFor(shared.promise, new AbortController().signal);
    shared.reject(error);
    await expect(waiting).rejects.toBe(error);
    const reason = new DOMException('Already cancelled', 'AbortError');
    expect(() => waitFor(Promise.resolve(42), AbortSignal.abort(reason))).toThrow(reason);
  });

  test('concurrent iteration stops taking new items after cancellation and settles active workers', async () => {
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const started: number[] = [];
    let finished = 0;
    const work = forEachConcurrent(
      [1, 2, 3, 4, 5],
      2,
      async (id) => {
        started.push(id);
        await release.promise;
        finished++;
      },
      controller.signal,
    );
    expect(started).toEqual([1, 2]);
    controller.abort();
    release.resolve();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toEqual([1, 2]);
    expect(finished).toBe(2);
    const skipped: number[] = [];
    await expect(
      forEachConcurrent(
        [6],
        2,
        async (id) => {
          skipped.push(id);
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(skipped).toEqual([]);
  }, 1000);
});
