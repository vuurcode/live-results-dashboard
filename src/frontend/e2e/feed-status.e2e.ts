import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('when there is nothing to show', () => {
  test('a competition that is not live says so, with the data source message, instead of loading forever', async ({ page }) => {
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

  test('a competition that stops being live is flagged above the results it already has', async ({ page }) => {
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        const notLive = JSON.stringify({ type: 'feed_status', data: { state: 'not_live', message: 'Pauze' } });
        ws.send(String(m).includes('"feed_status"') ? notLive : m);
      });
    });
    await page.goto('/?competitionId=e2e-individual');
    await expect(page.locator('.individual-competitor-card').first()).toBeVisible();
    const notice = page.getByRole('status').filter({ hasText: 'not live yet' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Pauze');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`the not-live notice has no axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.routeWebSocket(/\/ws/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((m) => server.send(m));
        server.onMessage((m) => {
          const notLive = JSON.stringify({ type: 'feed_status', data: { state: 'not_live', message: 'Pauze' } });
          ws.send(String(m).includes('"feed_status"') ? notLive : m);
        });
      });
      await page.goto('/?competitionId=e2e-individual');
      const notice = page.getByRole('status').filter({ hasText: 'not live yet' });
      await expect(notice).toBeVisible();
      const results = await new AxeBuilder({ page }).include('.empty-notice').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(results.violations).toEqual([]);
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`the notice shown without results has no axe violations (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/?competitionId=e2e-notlive');
      await expect(page.getByRole('status').filter({ hasText: 'not live yet' })).toBeVisible();
      const results = await new AxeBuilder({ page }).include('.empty-notice').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('a lost connection is reported', async ({ page }) => {
    await page.routeWebSocket(/\/ws/, (ws) => void ws.close());
    await page.goto('/?competitionId=e2e-individual');
    await expect(page.getByRole('status').filter({ hasText: 'Connection lost' })).toBeVisible();
  });

  test('a refused connection asks for a competition instead of reconnecting forever', async ({ page }) => {
    let attempts = 0;
    await page.routeWebSocket(/\/ws/, (ws) => { attempts++; void ws.close({ code: 1008, reason: 'invalid or missing competitionId' }); });
    await page.goto('/?competitionId=e2e-individual');
    await expect(page.getByRole('status').filter({ hasText: 'Choose a competition' })).toBeVisible();
    await page.waitForTimeout(6_000);
    expect(attempts).toBe(1);
  });

  test('a connection that stays silent is reported after a while, not shown as loading forever', async ({ page }) => {
    await page.clock.install();
    await page.routeWebSocket(/\/ws/, () => undefined); // accepts the connection and never answers
    await page.goto('/?competitionId=e2e-individual');
    await expect(page.locator('.skeleton-accordion').first()).toBeVisible();
    await page.clock.fastForward(11_000);
    await expect(page.getByRole('status').filter({ hasText: 'Still waiting for data' })).toBeVisible();
  });
});
