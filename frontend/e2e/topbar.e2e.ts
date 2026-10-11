import { expect, test } from '@playwright/test';

test.describe('top bar', () => {
  test('on a single lane view the match picker and the cogwheel share one row', async ({ page }) => {
    for (const width of [320, 390, 767]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?competitionId=e2e-timed');
      const select = page.locator('#matchSelect');
      const settings = page.locator('button.topbar-group-btn').first();
      await expect(select).toBeVisible();
      await expect(settings.locator('.topbar-group-cog')).toBeVisible();
      await expect(settings.locator('.topbar-group-text')).toBeHidden();
      const [s, b] = await Promise.all([select.boundingBox(), settings.boundingBox()]);
      expect(Math.abs(s!.y + s!.height / 2 - (b!.y + b!.height / 2))).toBeLessThan(6);
      expect(b!.x + b!.width).toBeLessThanOrEqual(width);
    }
  });

  test('on a wide screen the match picker is wider and the settings show their label', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto('/?competitionId=e2e-timed');
    const box = await page.locator('#matchSelect').boundingBox();
    expect(box!.width).toBeGreaterThan(700);
    await expect(page.locator('button.topbar-group-btn').first().locator('.topbar-group-text')).toBeVisible();
  });
});
