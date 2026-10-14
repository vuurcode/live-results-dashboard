import { expect, test } from '@playwright/test';

test.describe('top bar', () => {
  test('on a single lane view the competition picker and the cogwheel share one row', async ({ page }) => {
    for (const width of [320, 390, 767]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?competitionId=e2e-timed');
      const select = page.locator('#competitionSelect');
      const settings = page.locator('button.topbar-group-btn').first();
      await expect(select).toBeVisible();
      await expect(settings.locator('.topbar-group-cog')).toBeVisible();
      await expect(settings.locator('.topbar-group-text')).toBeHidden();
      const [s, b] = await Promise.all([select.boundingBox(), settings.boundingBox()]);
      expect(Math.abs(s!.y + s!.height / 2 - (b!.y + b!.height / 2))).toBeLessThan(6);
      expect(b!.x + b!.width).toBeLessThanOrEqual(width);
    }
  });

  test('on a wide screen the competition picker is wider and the settings show their label', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto('/?competitionId=e2e-timed');
    const box = await page.locator('#competitionSelect').boundingBox();
    expect(box!.width).toBeGreaterThan(700);
    const button = page.locator('button.topbar-group-btn').first();
    await expect(button.locator('.topbar-group-text')).toBeVisible();
    const gap = await button.evaluate((b) => b.querySelector('.topbar-group-cog')!.getBoundingClientRect().left - b.querySelector('.topbar-group-text')!.getBoundingClientRect().right);
    expect(gap).toBeGreaterThanOrEqual(4); // a space between the label and the cogwheel
  });
});
