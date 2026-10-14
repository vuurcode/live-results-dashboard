import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { MOCK_URL } from './env';

// Same rule set as .claude/skills/accessibility/scripts/axe-scan.mjs
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function restartReplay(request: import('@playwright/test').APIRequestContext, competition: string) {
  const res = await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: competition } });
  expect(res.ok()).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 800));
}

test.describe('accessibility', () => {
  for (const [competition, ready] of [
    ['e2e-timed', '.timed-compact-done'], // finished cards show the total time badge
    ['e2e-mass', '.race-item-laps.race-finished'],
  ] as const) {
    test(`${competition}: no axe violations once the replay has finished`, async ({ page, request }) => {
      await page.addInitScript(() => localStorage.setItem('compactColors', 'true')); // colours on: their contrast is checked too
      await restartReplay(request, competition);
      await page.goto(`/?competitionId=${competition}`);
      // finished rows are the last state of the replay, with every badge and row on screen
      await expect(page.locator(ready)).toHaveCount(4);

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

test('compact lap badge colours (green, orange, purple, and the latest one) have enough contrast', async ({ page, request }) => {
  await restartReplay(request, 'e2e-timed');
  await page.addInitScript(() => localStorage.setItem('compactColors', 'true'));
  await page.goto('/?competitionId=e2e-timed');
  await expect(page.locator('.timed-compact-badge').nth(3)).toBeVisible({ timeout: 30_000 });
  // force every colour onto real badges, whatever the fixture's lap times happen to be
  await page.evaluate(() => {
    const classes = ['lap-badge-normal', 'lap-badge-slow', 'lap-badge-fast'];
    document.querySelectorAll('.timed-compact-badge').forEach((b, i) => {
      b.classList.remove(...classes, 'timed-flash-update');
      b.classList.add(classes[i % 3]);
    });
  });
  const { violations } = await new AxeBuilder({ page }).include('.timed-compact-badge').withTags(TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)} ${v.nodes[0]?.any[0]?.message}`)).toEqual([]);
});
