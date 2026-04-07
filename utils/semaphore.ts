// utils/semaphore.ts
/**
 * Semaphore implementation for controlling concurrent operations
 * Based on patterns from civitai/civitai and p-queue
 */

export class Semaphore {
  private capacity: number;
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error('Semaphore capacity must be at least 1');
    }
    this.capacity = capacity;
    this.permits = capacity;
  }

  /**
   * Acquire a permit. If none available, waits until one is released.
   */
  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.permits > 0) {
        this.permits--;
        resolve();
      } else {
        // Queue the release callback
        this.queue.push(() => {
          resolve();
        });
      }
    });
  }

  /**
   * Release a permit and wake up a waiting task if any.
   */
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    } else {
      this.permits++;
    }
  }

  /**
   * Get current available permits.
   */
  getAvailablePermits(): number {
    return this.permits;
  }

  /**
   * Get total capacity.
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Get number of waiting tasks.
   */
  getWaitingCount(): number {
    return this.queue.length;
  }
}

/**
 * Execute async tasks with concurrency limit
 * @param tasks Array of async task functions
 * @param concurrency Maximum concurrent tasks
 * @returns Promise that resolves with all results when complete
 */
export async function executeWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const semaphore = new Semaphore(concurrency);
  const results: T[] = new Array(tasks.length);

  const promises = tasks.map(async (task, index) => {
    await semaphore.acquire();
    try {
      results[index] = await task();
      return results[index];
    } finally {
      semaphore.release();
    }
  });

  return Promise.all(promises);
}

/**
 * Execute async tasks with concurrency limit and progress callback
 * @param tasks Array of async task functions
 * @param concurrency Maximum concurrent tasks
 * @param onProgress Callback with (completed, total, result) after each task
 * @returns Promise that resolves with all results when complete
 */
export async function executeWithConcurrencyAndProgress<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  onProgress?: (completed: number, total: number, result: T, error?: Error) => void
): Promise<T[]> {
  const semaphore = new Semaphore(concurrency);
  const results: T[] = new Array(tasks.length);
  let completed = 0;
  const total = tasks.length;

  const promises = tasks.map(async (task, index) => {
    await semaphore.acquire();
    try {
      results[index] = await task();
      completed++;
      onProgress?.(completed, total, results[index]!);
      return results[index];
    } catch (error) {
      completed++;
      onProgress?.(completed, total, undefined as T, error as Error);
      throw error;
    } finally {
      semaphore.release();
    }
  });

  return Promise.all(promises);
}

/**
 * Batch processor with concurrency control
 * Useful for processing large arrays in chunks with controlled concurrency
 */
export class BatchProcessor<T, R> {
  private semaphore: Semaphore;
  private processor: (item: T, index: number) => Promise<R>;
  private onError?: (error: Error, item: T, index: number) => void;
  private onProgress?: (completed: number, total: number) => void;

  constructor(
    processor: (item: T, index: number) => Promise<R>,
    concurrency: number,
    options?: {
      onError?: (error: Error, item: T, index: number) => void;
      onProgress?: (completed: number, total: number) => void;
    }
  ) {
    this.processor = processor;
    this.semaphore = new Semaphore(concurrency);
    this.onError = options?.onError;
    this.onProgress = options?.onProgress;
  }

  /**
   * Process an array of items with concurrency control
   * Only returns successful results, errors are handled by onError callback
   */
  async process(items: T[]): Promise<Awaited<R>[]> {
    const results: (Awaited<R> | undefined)[] = new Array(items.length);
    let completed = 0;
    const total = items.length;

    const promises = items.map(async (item, index) => {
      await this.semaphore.acquire();
      try {
        const result = await this.processor(item, index);
        completed++;
        this.onProgress?.(completed, total);
        return result;
      } catch (error) {
        completed++;
        this.onProgress?.(completed, total);
        this.onError?.(error as Error, item, index);
        return undefined;
      } finally {
        this.semaphore.release();
      }
    });

    const allResults = await Promise.all(promises);
    return allResults.filter((r): r is Awaited<R> => r !== undefined);
  }

  /**
   * Process an array and return both results and errors
   */
  async processWithErrors(items: T[]): Promise<{
    results: R[];
    errors: Array<{ error: Error; item: T; index: number }>;
  }> {
    const results: R[] = [];
    const errors: Array<{ error: Error; item: T; index: number }> = [];
    let completed = 0;
    const total = items.length;

    const promises = items.map(async (item, index) => {
      await this.semaphore.acquire();
      try {
        const result = await this.processor(item, index);
        results.push(result);
        completed++;
        this.onProgress?.(completed, total);
      } catch (error) {
        completed++;
        this.onProgress?.(completed, total);
        errors.push({ error: error as Error, item, index });
      } finally {
        this.semaphore.release();
      }
    });

    await Promise.all(promises);
    return { results, errors };
  }
}
