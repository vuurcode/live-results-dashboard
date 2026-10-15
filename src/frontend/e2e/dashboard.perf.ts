import { expect, test } from '@playwright/test';
import { MOCK_URL, WEB_PORT } from './env';

// Runtime cost of a live dashboard while a replay plays (updates every second, snake and count-up animations),
// measured in the browser so the API delay is not part of it. The mockserver replays committed fixtures.
// Desktop with a CPU 4x slower than this machine, and a low-end phone: small touch screen, CPU 6x slower.
const PROFILES = [
  { name: 'desktop', cpuSlowdown: 4, viewport: { width: 1400, height: 1000 }, mobile: false },
  { name: 'phone', cpuSlowdown: 6, viewport: { width: 390, height: 844 }, mobile: true },
] as const;
const MEASURE_MS = 15_000;
const LONG_TASK_MS = 200;
const MIN_FPS = 20;
// Follow opens the live distance and folds the previous one, which moves the sections below by design: the mass start
// replay does that twice (about 0.09 each). The other competitions stay put.
const MAX_SHIFT: Record<string, number> = { 'e2e-mass': 0.25 };
const DEFAULT_MAX_SHIFT = 0.1;

interface Sample { longTasks: number[]; layoutShift: number; frames: number; worstFrameMs: number }

for (const profile of PROFILES) for (const competition of ['e2e-individual', 'e2e-lanes', 'e2e-mass']) {
  test(`${profile.name} ${competition}: stays smooth while the replay plays (${profile.cpuSlowdown}x slower CPU)`, async ({ browser, request }) => {
    const context = await browser.newContext({ baseURL: `http://localhost:${WEB_PORT}`, viewport: profile.viewport, isMobile: profile.mobile, hasTouch: profile.mobile, deviceScaleFactor: profile.mobile ? 3 : 1 });
    const page = await context.newPage();
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: competition } });
    await page.addInitScript(() => {
      const s = { longTasks: [] as number[], layoutShift: 0, frames: 0, worstFrameMs: 0 };
      (window as unknown as { __perf: typeof s }).__perf = s;
      new PerformanceObserver((l) => l.getEntries().forEach((e) => s.longTasks.push(e.duration))).observe({ type: 'longtask', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => {
        const shift = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) s.layoutShift += shift.value;
      })).observe({ type: 'layout-shift', buffered: true });
      let last = 0;
      const tick = (t: number) => {
        if (last) s.worstFrameMs = Math.max(s.worstFrameMs, t - last);
        last = t;
        s.frames++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown });
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

    await page.goto(`/?competitionId=${competition}`);
    await expect(page.locator('.individual-competitor-card, .race-item-laps').first()).toBeVisible();
    const before = await metrics();
    await page.evaluate(() => { const p = (window as unknown as { __perf: Sample }).__perf; p.longTasks.length = 0; p.layoutShift = 0; p.frames = 0; p.worstFrameMs = 0; });
    await page.waitForTimeout(MEASURE_MS);
    const after = await metrics();
    const p = await page.evaluate(() => (window as unknown as { __perf: Sample }).__perf);

    const seconds = MEASURE_MS / 1000;
    const report = {
      fps: +(p.frames / seconds).toFixed(1),
      worstFrameMs: Math.round(p.worstFrameMs),
      longTasks: p.longTasks.length,
      worstTaskMs: Math.round(Math.max(0, ...p.longTasks)),
      layoutShift: +p.layoutShift.toFixed(3),
      scriptMsPerSec: Math.round(((after['ScriptDuration'] - before['ScriptDuration']) * 1000) / seconds),
      layoutsPerSec: +((after['LayoutCount'] - before['LayoutCount']) / seconds).toFixed(1),
      styleRecalcsPerSec: +((after['RecalcStyleCount'] - before['RecalcStyleCount']) / seconds).toFixed(1),
      heapMB: +(after['JSHeapUsedSize'] / 1e6).toFixed(1),
    };
    console.log(`${profile.name} ${competition}`, report);
    await context.close();

    expect(report.worstTaskMs, 'no task blocks the main thread for long').toBeLessThan(LONG_TASK_MS * 2);
    expect(report.fps, 'frame rate while animating').toBeGreaterThan(MIN_FPS);
    expect(report.layoutShift, 'cumulative layout shift').toBeLessThan(MAX_SHIFT[competition] ?? DEFAULT_MAX_SHIFT);
  });
}
