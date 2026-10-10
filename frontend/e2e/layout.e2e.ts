import { expect, test } from '@playwright/test';

test.describe('large screens', () => {
  for (const [width, font] of [
    [1280, 16],
    [1920, 16],
    [2560, 21.33],
    [3840, 32],
  ] as const) {
    test(`${width}px wide: root font size scales to ${font}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1080 });
      await page.goto('/?competitionId=e2e-timed');
      const px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      expect(px).toBeCloseTo(font, 1);
    });
  }

  test('4K: card names and the watermark stay inside their card', async ({ page }) => {
    await page.setViewportSize({ width: 3840, height: 2160 });
    await page.goto('/?competitionId=e2e-pairs');
    await expect(page.locator('.timed-watermark').first()).toBeVisible({ timeout: 15_000 });
    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll('.timed-competitor-card')].filter((card) => {
        const c = card.getBoundingClientRect();
        return [...card.querySelectorAll('.timed-watermark, .timed-card-name, .fw-semibold')].some((el) => {
          const r = el.getBoundingClientRect();
          return r.left < c.left - 1 || r.right > c.right + 1;
        });
      }).length,
    );
    expect(overflowing).toBe(0);
  });
});

test.describe('pinned titles', () => {
  test('the top bar and the open distance title stay visible while the list scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 260 });
    await page.goto('/?competitionId=e2e-timed');
    const header = page.locator('.accordion-header').first();
    await expect(page.locator('.timed-heat-row').first()).toBeAttached();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    const { barBottom, headerTop, headerBottom, scrollY } = await page.evaluate(() => ({
      barBottom: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
      headerTop: document.querySelector('.accordion-header')!.getBoundingClientRect().top,
      headerBottom: document.querySelector('.accordion-header')!.getBoundingClientRect().bottom,
      scrollY: window.scrollY,
    }));
    expect(scrollY).toBeGreaterThan(0);
    expect(barBottom).toBeGreaterThan(0);
    expect(headerTop).toBeGreaterThanOrEqual(barBottom - 1);
    expect(headerBottom).toBeLessThan(260);
    await expect(header).toBeInViewport();
  });
});
