import { expect, test } from '@playwright/test';
import { MOCK_URL } from './env';

test.describe('landing on the live distance after a load or reload', () => {
  for (const [width, height] of [[320, 640], [390, 740], [700, 900], [1024, 768], [1400, 900]] as const) {
    test(`${width}px: the live distance is in view, below the top bar`, async ({ page, request }) => {
      await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-timed' } });
      await page.setViewportSize({ width, height });
      await page.goto('/?competitionId=e2e-timed');
      const liveHeader = page.locator('.accordion-button', { has: page.locator('.glowing-badge') }).first();
      await expect(liveHeader).toBeVisible();

      for (const load of ['first load', 'reload']) {
        if (load === 'reload') await page.reload();
        await expect(liveHeader).toBeVisible();
        await page.waitForTimeout(2500); // the page settles before it scrolls
        const { top, bottom, barBottom, scrollY } = await page.evaluate(() => {
          const r = document.querySelector('.accordion-button:has(.glowing-badge)')!.getBoundingClientRect();
          const bar = document.querySelector('header')?.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, barBottom: bar?.bottom ?? 0, scrollY: window.scrollY };
        });
        expect(top, `${load}: header below the top bar`).toBeGreaterThanOrEqual(barBottom - 1);
        expect(bottom, `${load}: header in view`).toBeLessThanOrEqual(height);
        expect(top, `${load}: not overshot (scrollY ${scrollY})`).toBeLessThan(height * 0.5);
      }
    });
  }
});
