import { expect, test } from '@playwright/test';

test.describe('when there is nothing to show', () => {
  test('a match that is not live says so, with the data source message, instead of loading forever', async ({ page }) => {
    await page.goto('/?competitionId=e2e-notlive');
    const notice = page.getByRole('status').filter({ hasText: 'not live yet' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Deze wedstrijd is op (nog) niet live.');
    await expect(page.locator('.skeleton-accordion')).toHaveCount(0);
  });

  test('the message follows the browser language', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'nl-NL' });
    const page = await context.newPage();
    await page.goto('/?competitionId=e2e-notlive');
    await expect(page.getByRole('status')).toContainText('Deze wedstrijd is nog niet live');
    await context.close();
  });

  test('a lost connection is reported', async ({ page }) => {
    await page.routeWebSocket(/\/ws/, (ws) => void ws.close());
    await page.goto('/?competitionId=e2e-timed');
    await expect(page.getByRole('status').filter({ hasText: 'Connection lost' })).toBeVisible();
  });

  test('a connection that stays silent is reported after a while, not shown as loading forever', async ({ page }) => {
    await page.clock.install();
    await page.routeWebSocket(/\/ws/, () => undefined); // accepts the connection and never answers
    await page.goto('/?competitionId=e2e-timed');
    await expect(page.locator('.skeleton-accordion').first()).toBeVisible();
    await page.clock.fastForward(11_000);
    await expect(page.getByRole('status').filter({ hasText: 'Still waiting for data' })).toBeVisible();
  });
});
