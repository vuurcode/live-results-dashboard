import { expect, test } from '@playwright/test';
import { MOCK_URL } from './env';

// Long-session check (`npm run perf:soak`): one page stays open while the replay is restarted over and over, so laps,
// resets, snake animations and count-ups keep coming. After a warm-up the memory, DOM nodes and event listeners must
// stay flat; growth means something is kept alive (a timer, a listener, an animation frame, a stale subscription).
const MINUTES = Number(process.env['SOAK_MINUTES'] ?? 0);
const WARMUP_MS = 60_000;
const SAMPLE_MS = 20_000;
const RESTART_MS = 8_000;
const MAX_HEAP_GROWTH_MB = 10;
const MAX_GROWTH_FACTOR = 1.2; // DOM nodes and listeners

test.skip(!MINUTES, 'set SOAK_MINUTES to run');

test(`${MINUTES} minutes of updates leave memory, DOM nodes and listeners flat`, async ({ page, request }) => {
  test.setTimeout((MINUTES + 2) * 60_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const snapshot = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    return { heapMB: +(m['JSHeapUsedSize'] / 1e6).toFixed(1), nodes: m['Nodes'], listeners: m['JSEventListeners'] };
  };

  await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-individual' } });
  await page.goto('/?competitionId=e2e-individual');
  await expect(page.locator('.individual-competitor-card').first()).toBeVisible();

  const samples: { minute: number; heapMB: number; nodes: number; listeners: number }[] = [];
  const start = Date.now();
  let lastSample = 0;
  let lastRestart = start;
  while (Date.now() - start < MINUTES * 60_000) {
    await page.waitForTimeout(1000);
    if (Date.now() - lastRestart >= RESTART_MS) {
      await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-individual' } });
      lastRestart = Date.now();
    }
    if (Date.now() - lastSample >= SAMPLE_MS) {
      lastSample = Date.now();
      const s = { minute: +((lastSample - start) / 60_000).toFixed(1), ...(await snapshot()) };
      samples.push(s);
      console.log(JSON.stringify(s));
    }
  }

  // The DOM size swings with the replay (sections open and fold, heats fill in), so compare the lowest value of each half
  // of the steady state: a leak raises the floor, a phase of the replay does not.
  const steady = samples.filter((s) => s.minute * 60_000 >= WARMUP_MS);
  expect(steady.length, 'samples after the warm-up').toBeGreaterThan(3);
  const half = Math.floor(steady.length / 2);
  const floor = (rows: typeof steady, key: 'heapMB' | 'nodes' | 'listeners') => Math.min(...rows.map((r) => r[key]));
  const [early, late] = [steady.slice(0, half), steady.slice(half)];
  expect(floor(late, 'heapMB') - floor(early, 'heapMB'), 'heap growth in MB').toBeLessThan(MAX_HEAP_GROWTH_MB);
  expect(floor(late, 'nodes'), 'DOM nodes').toBeLessThan(floor(early, 'nodes') * MAX_GROWTH_FACTOR);
  expect(floor(late, 'listeners'), 'event listeners').toBeLessThan(floor(early, 'listeners') * MAX_GROWTH_FACTOR);
});
