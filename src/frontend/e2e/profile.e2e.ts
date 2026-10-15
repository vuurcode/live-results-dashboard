import { test } from '@playwright/test';

// Profiling run, only with PROFILE=1 (PROFILE=1 npx playwright test e2e/profile.e2e.ts): prints DOM size, heap, script / layout time and long tasks for each fixture while it replays.
test.skip(!process.env['PROFILE'], 'set PROFILE=1 to profile');

for (const id of ['e2e-individual', 'e2e-pairs', 'e2e-mass', 'e2e-lanes', 'e2e-multi']) {
  test(`profile ${id}`, async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.addInitScript(() => {
      (window as unknown as { __long: number[] }).__long = [];
      new PerformanceObserver((l) => (window as unknown as { __long: number[] }).__long.push(...l.getEntries().map((e) => Math.round(e.duration)))).observe({ entryTypes: ['longtask'] });
    });
    await page.goto(`/?competitionId=${id}`);
    await page.waitForTimeout(12_000);
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long as number[]);
    console.log(JSON.stringify({
      id, nodes: m['Nodes'], listeners: m['JSEventListeners'], heapMB: +(m['JSHeapUsedSize'] / 1e6).toFixed(1),
      scriptMs: Math.round(m['ScriptDuration'] * 1000), layoutMs: Math.round(m['LayoutDuration'] * 1000), styleMs: Math.round(m['RecalcStyleDuration'] * 1000),
      layouts: m['LayoutCount'], recalcs: m['RecalcStyleCount'], longTasks: long.length, longMax: Math.max(0, ...long),
    }));
  });
}
