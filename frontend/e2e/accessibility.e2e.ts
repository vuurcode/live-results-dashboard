import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { MOCK_URL } from './env';

// Same rule set as .claude/skills/accessibility/scripts/axe-scan.mjs
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function restartReplay(request: import('@playwright/test').APIRequestContext, match: string) {
  const res = await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: match } });
  expect(res.ok()).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 800));
}

test.describe('accessibility', () => {
  for (const [match, ready] of [
    ['e2e-timed', '.timed-lap-row.timed-lap-done'],
    ['e2e-mass', '.race-item-laps.race-finished'],
  ] as const) {
    test(`${match}: no axe violations once the replay has finished`, async ({ page, request }) => {
      await restartReplay(request, match);
      await page.goto(`/?competitionId=${match}`);
      // finished rows are the last state of the replay, with every badge and row on screen
      await expect(page.locator(ready)).toHaveCount(match === 'e2e-timed' ? 12 : 4);

      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(
        violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(' ')}`),
      ).toEqual([]);
    });
  }

  test('the event name is the page heading', async ({ page, request }) => {
    await restartReplay(request, 'e2e-timed');
    await page.goto('/?competitionId=e2e-timed');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('E2E Timed Event');
  });

  test('a competitor row can be selected with the keyboard alone', async ({ page, request }) => {
    await restartReplay(request, 'e2e-mass');
    await page.goto('/?competitionId=e2e-mass');
    await expect(page.locator('.race-item-laps.race-finished')).toHaveCount(4);

    const row = page.getByRole('button', { name: /Competitor G/ });
    await row.focus();
    await expect(row).toBeFocused();
    await expect(row).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Enter');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Space');
    await expect(row).toHaveAttribute('aria-pressed', 'false');
  });
});
