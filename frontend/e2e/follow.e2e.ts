import { expect, test } from '@playwright/test';
import { MOCK_URL } from './env';

// The replay moves the live race on through several distances; the page has to end up on the last live heat,
// not above or below it, after all the folding and opening of distances on the way.
for (const [width, height] of [[390, 740], [1024, 768]] as const) {
  test(`${width}px: the page follows the live heat through several distances`, async ({ page, request }) => {
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-multi' } });
    await page.setViewportSize({ width, height });
    await page.goto('/?competitionId=e2e-multi');
    await page.waitForTimeout(17_000); // the replay of ten steps ends on the second heat of the last distance, and the page settles
    const box = await page.evaluate(() => {
      const r = document.querySelector('[data-distance-id="dist-3000"][data-heat-label="Heat 2"]')!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, bar: document.querySelector('header')!.getBoundingClientRect().bottom };
    });
    const live = await page.evaluate(() => {
      const r = document.querySelector('.timed-heat-row-active')!.getBoundingClientRect();
      return { distance: document.querySelector('.timed-heat-row-active')!.getAttribute('data-distance-id'), label: document.querySelector('.timed-heat-row-active')!.getAttribute('data-heat-label'), top: r.top };
    });
    expect(live, 'the heat marked live is the one the page followed').toMatchObject({ distance: 'dist-3000', label: 'Heat 2' });
    expect(live.top, 'the heat marked live is in the upper part of the screen').toBeGreaterThan(0);
    expect(box.top, 'heat starts below the top bar').toBeGreaterThanOrEqual(box.bar - 1);
    expect(box.top, 'heat starts in the upper part of the screen').toBeLessThan(height * 0.45);
    expect(box.bottom, 'heat is in view').toBeLessThanOrEqual(height + 1);
  });
}
