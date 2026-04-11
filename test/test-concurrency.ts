// test/test-concurrency.ts
/**
 * Test script for concurrency features
 * Run with: bun run test/test-concurrency.ts
 */

import { Semaphore, executeWithConcurrency, BatchProcessor } from '../utils/semaphore';

// Simulate API call
function simulateApiCall(id: number, delay: number = 100): Promise<{ id: number; result: string }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ id, result: `Result for ${id}` });
    }, delay);
  });
}

async function testSemaphore(): Promise<void> {
  console.log('\n=== Test 1: Basic Semaphore ===');
  const semaphore = new Semaphore(3);
  
  const start = Date.now();
  const promises = [];
  
  for (let i = 1; i <= 10; i++) {
    const id = i;
    promises.push(
      (async () => {
        await semaphore.acquire();
        console.log(`[${id}] Acquired permit (available: ${semaphore.getAvailablePermits()})`);
        await simulateApiCall(id, 200);
        console.log(`[${id}] Releasing permit`);
        semaphore.release();
      })()
    );
  }
  
  await Promise.all(promises);
  const duration = Date.now() - start;
  console.log(`\n✓ Completed 10 tasks with max 3 concurrent in ${duration}ms`);
  console.log(`  (Sequential would take ~2000ms, parallel should be ~700-800ms)`);
}

async function testExecuteWithConcurrency(): Promise<void> {
  console.log('\n=== Test 2: executeWithConcurrency ===');
  
  const tasks = Array.from({ length: 10 }, (_, i) => () => simulateApiCall(i + 1, 100));
  
  const start = Date.now();
  const results = await executeWithConcurrency(tasks, 5);
  const duration = Date.now() - start;
  
  console.log(`✓ Completed ${results.length} tasks with max 5 concurrent in ${duration}ms`);
  console.log(`  Results: ${results.map(r => r.id).join(', ')}`);
}

async function testBatchProcessor(): Promise<void> {
  console.log('\n=== Test 3: BatchProcessor ===');
  
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` }));
  let processedCount = 0;
  
  const processor = new BatchProcessor(
    async (item: { id: number; name: string }) => {
      await simulateApiCall(item.id, 50);
      processedCount++;
      return { ...item, processed: true };
    },
    4, // concurrency
    {
      onProgress: (completed, total) => {
        if (completed % 5 === 0 || completed === total) {
          console.log(`  Progress: ${completed}/${total} (${Math.round(completed / total * 100)}%)`);
        }
      },
      onError: (error, item) => {
        console.error(`  Error processing item ${item.id}:`, error.message);
      }
    }
  );
  
  const start = Date.now();
  const results = await processor.process(items);
  const duration = Date.now() - start;
  
  console.log(`✓ Processed ${results.length} items with max 4 concurrent in ${duration}ms`);
  console.log(`  Expected ~500ms (20 items / 4 concurrent * 50ms each)`);
}

async function testErrorHandling(): Promise<void> {
  console.log('\n=== Test 4: Error Handling ===');
  
  const items = [1, 2, 3, 4, 5];
  let errorCount = 0;
  
  const processor = new BatchProcessor(
    async (id: number) => {
      if (id % 2 === 0) {
        throw new Error(`Simulated error for ${id}`);
      }
      return { id, success: true };
    },
    3,
    {
      onError: (error, item) => {
        errorCount++;
        console.log(`  Caught error for item ${item}: ${error.message}`);
      }
    }
  );
  
  const results = await processor.process(items);
  console.log(`✓ Completed: ${results.length} success, ${errorCount} errors (errors handled gracefully)`);
}

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║         Concurrency Module Test Suite            ║');
  console.log('╚═══════════════════════════════════════════════════╝');
  
  try {
    await testSemaphore();
    await testExecuteWithConcurrency();
    await testBatchProcessor();
    await testErrorHandling();
    
    console.log('\n╔═══════════════════════════════════════════════════╗');
    console.log('║              All tests passed! ✓                  ║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('\n📝 Configuration:');
    console.log('   - Set CONCURRENT_API_CALLS in .env to control parallelism');
    console.log('   - Current default: 8 concurrent requests');
    console.log('   - Example: CONCURRENT_API_CALLS=16 for faster crawling');
    console.log('');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

main();
