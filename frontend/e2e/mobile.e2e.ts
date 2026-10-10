import { expect, test } from '@playwright/test';

for (const width of [320, 390]) {
  test.describe(`mobile ${width}px`, () => {
    test.use({ viewport: { width, height: 740 }, hasTouch: true });

    for (const match of ['e2e-timed', 'e2e-mass']) {
      test(`${match}: no horizontal page scroll, settings open`, async ({ page }) => {
        await page.goto(`/?competitionId=${match}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        for (const button of await page.locator('button.topbar-group-btn').all()) {
          await button.click();
        }
        await expect(page.locator('.setting-group').first()).toBeVisible();

        const { scrollWidth, clientWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      });
    }

    test('settings controls are at least 24px (WCAG 2.5.8)', async ({ page }) => {
      await page.goto('/?competitionId=e2e-mass');
      for (const button of await page.locator('button.topbar-group-btn').all()) {
        await button.click();
      }
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('header button, header input')]
          .map((e) => ({ n: e.id || e.className.toString(), r: e.getBoundingClientRect() }))
          .filter((x) => x.r.width > 0 && (x.r.width < 24 || x.r.height < 24))
          .map((x) => `${x.n} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
      );
      expect(small).toEqual([]);
    });
  });
}
