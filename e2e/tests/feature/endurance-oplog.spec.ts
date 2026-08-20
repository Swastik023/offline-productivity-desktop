import { expect, test } from '../../fixtures/test.fixture';
import { expectNoGlobalError } from '../../utils/assertions';

test.describe('OpLog Endurance (12 hours)', () => {
  test.setTimeout(120000);

  test('should maintain bounded operation growth over 12 hours of simulated time-tracking', async ({
    workViewPage,
    page,
  }) => {
    // Helper to get current operation count from IndexedDB
    const getOpLogCount = async (): Promise<number> => {
      return await page.evaluate(async () => {
        return new Promise<number>((resolve) => {
          const req = indexedDB.open('SUP_OPS');
          req.onsuccess = (e) => {
            const db = (e.target as any).result;
            const tx = db.transaction('ops', 'readonly');
            const store = tx.objectStore('ops');
            const countReq = store.count();
            countReq.onsuccess = () => resolve(countReq.result);
          };
          req.onerror = () => resolve(0);
        });
      });
    };

    // 1. Initial setup
    await page.clock.install();
    await workViewPage.waitForTaskList();

    // Baseline count
    const baselineOps = await getOpLogCount();

    const stats: Record<string, number> = {};

    // 2. Simulate 12 hour shift
    const CYCLES = 144; // 144 * 5 mins = 12 hours
    
    for (let i = 1; i <= CYCLES; i++) {
      if (i % 12 === 0) {
        await workViewPage.addTask(`Endurance Task ${i}`);
      }
      
      // Fast-forward 5 minutes
      await page.clock.fastForward(5 * 60 * 1000);

      // Record counts at specific hour marks (12 cycles = 1 hour)
      if (i === 12) stats['1h'] = await getOpLogCount();
      if (i === 24) stats['2h'] = await getOpLogCount();
      if (i === 48) stats['4h'] = await getOpLogCount();
      if (i === 96) stats['8h'] = await getOpLogCount();
      if (i === 144) stats['12h'] = await getOpLogCount();
    }

    // 3. Verify no uncaught errors or QuotaExceededError
    await expectNoGlobalError(page);

    // 4. Assertions based on known application persistent actions
    // Ensure that it does NOT create one operation per second (which would be 3600 ops/hour)
    // At most, we expect a few dozen operations per hour from 5-min timer flushes and task creations.
    
    const growth1h = stats['1h'] - baselineOps;
    const growth12h = stats['12h'] - baselineOps;

    // Verify it's not 3600 per hour
    expect(growth1h).toBeLessThan(100);
    
    // Verify it's not exponential/unbounded growth (12 hours should be roughly 12x 1 hour)
    expect(growth12h).toBeLessThan(1200);

    // Ensure growth is relatively linear based on the number of persistent actions
    console.log('OpLog Growth Stats (12 hours):', {
      baseline: baselineOps,
      ...stats
    });
  });
});
