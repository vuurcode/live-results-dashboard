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

// Badges ease between colours for over a second; axe must not measure a colour half way between two.
async function settleTransitions(page: import('@playwright/test').Page) {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined))),
  );
}

test.describe('accessibility', () => {
  for (const [competition, ready, scheme] of [
    ['e2e-individual', '.individual-compact-done', 'light'], // finished cards show the total time badge
    ['e2e-mass', '.race-item-laps.race-finished', 'light'],
    ['e2e-individual', '.individual-compact-done', 'dark'],
    ['e2e-mass', '.race-item-laps.race-finished', 'dark'],
  ] as const) {
    test(`${competition} (${scheme}): no axe violations once the replay has finished`, async ({ page, request }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript(() => localStorage.setItem('compactColors', 'true')); // colours on: their contrast is checked too
      await restartReplay(request, competition);
      await page.goto(`/?competitionId=${competition}`);
      // finished rows are the last state of the replay, with every badge and row on screen
      await expect(page.locator(ready)).toHaveCount(4);
      await expect(page.locator('html')).toHaveAttribute('data-coreui-theme', scheme);
      await settleTransitions(page);

      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(
        violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(' ')}`),
      ).toEqual([]);
    });
  }

  test('the event name is the page heading', async ({ page, request }) => {
    await restartReplay(request, 'e2e-individual');
    await page.goto('/?competitionId=e2e-individual');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('E2E Individual Event');
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

for (const scheme of ['light', 'dark'] as const) {
test(`compact lap badge colours (green, orange, purple, and the latest one) have enough contrast (${scheme})`, async ({ page, request }) => {
  await page.emulateMedia({ colorScheme: scheme });
  await restartReplay(request, 'e2e-individual');
  await page.addInitScript(() => localStorage.setItem('compactColors', 'true'));
  await page.goto('/?competitionId=e2e-individual');
  await expect(page.locator('.individual-compact-badge').nth(3)).toBeVisible({ timeout: 30_000 });
  // force every colour onto real badges, whatever the fixture's lap times happen to be
  await page.evaluate(() => {
    const classes = ['lap-badge-normal', 'lap-badge-slow', 'lap-badge-fast'];
    document.querySelectorAll('.individual-compact-badge').forEach((b, i) => {
      b.classList.remove(...classes, 'individual-flash-update');
      b.classList.add(classes[i % 3]);
    });
  });
  const { violations } = await new AxeBuilder({ page }).include('.individual-compact-badge').withTags(TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)} ${v.nodes[0]?.any[0]?.message}`)).toEqual([]);
});
}

test('a collapsed distance stands out from the page and keeps its contrast', async ({ page, request }) => {
  await restartReplay(request, 'e2e-individual');
  await page.goto('/?competitionId=e2e-individual');
  const header = page.locator('.accordion-button').first();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await page.mouse.move(0, 0); // off the header, so the hover colour is not measured

  const style = await header.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, color: s.color };
  });
  expect(style).toEqual({ bg: 'rgb(44, 62, 80)', color: 'rgb(255, 255, 255)' }); // the dark slate of an open distance, not the page white

  const { violations } = await new AxeBuilder({ page }).include('.accordion-button').withTags(TAGS).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes[0]?.any[0]?.message}`)).toEqual([]);
});
