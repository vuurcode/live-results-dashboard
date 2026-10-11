import { expect, test, type APIRequestContext } from '@playwright/test';
import { MOCK_URL } from './env';

// A two-lane (pairs) match: a DNF and a personal best in one pair, a skater without an opponent, a normal pair.
const MATCH = 'e2e-pairs';

async function restartReplay(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: MATCH } });
  expect(res.ok()).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 800));
}

test.describe('two-lane match', () => {
  test('shows pairs, a lone skater, a DNF and a personal best', async ({ page, request }) => {
    await restartReplay(request);
    await page.goto(`/?competitionId=${MATCH}`);

    await expect(page.locator('.timed-heat-row')).toHaveCount(3);
    await expect(page.locator('.timed-competitor-card:not(.timed-lane-placeholder)')).toHaveCount(5);
    // the lone skater's pair keeps an empty slot for the missing lane
    await expect(page.locator('.timed-lane-placeholder')).toHaveCount(1);
    // no heat has more than the two lanes
    for (const row of await page.locator('.timed-heat-row').all()) {
      expect(await row.locator('.timed-competitor-card').count()).toBeLessThanOrEqual(2);
    }
    // the lone skater (heat 2) has a card of their own
    await expect(page.locator('.timed-competitor-card', { hasText: 'Competitor C' })).toBeVisible();

    // once the replay has finished: A set a personal best, B did not finish
    const cardA = page.locator('.timed-competitor-card', { hasText: 'Competitor A' });
    const cardB = page.locator('.timed-competitor-card', { hasText: 'Competitor B' });
    await expect(cardB.getByText('DNF', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(cardA.locator('.timed-lap-row.timed-lap-done')).toHaveCount(2);
    await expect(cardA.getByText('PB', { exact: true })).toBeVisible();
    // the old personal best on the card title is struck through once it has been beaten
    await expect(cardA.locator('.timed-pb-beaten')).toHaveCSS('text-decoration-line', 'line-through');
    // ... and stays plain for a skater who did not improve it (Competitor C finished slower than 43.0)
    await expect(page.locator('.timed-competitor-card', { hasText: 'Competitor C' }).locator('.timed-pb-beaten')).toHaveCount(0);
  });
});

test.describe('personal best wording follows the browser language', () => {
  for (const [locale, term, other] of [
    ['en-US', 'PB', 'PR'],
    ['nl-NL', 'PR', 'PB'],
  ] as const) {
    test.describe(locale, () => {
      test.use({ locale });
      test(`uses ${term}, never ${other}`, async ({ page, request }) => {
        await restartReplay(request);
        await page.goto(`/?competitionId=${MATCH}`);
        await expect(page.locator('html')).toHaveAttribute('lang', locale.slice(0, 2));
        const cardA = page.locator('.timed-competitor-card', { hasText: 'Competitor A' });
        await expect(cardA.getByText(term, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('.timed-competitor-card').getByText(other, { exact: true })).toHaveCount(0);
        await expect(cardA.getByText(`${term}:`)).toBeVisible();
      });
    });
  }
});

test.describe('long names', () => {
  for (const width of [320, 1280]) {
    test(`${width}px: long and unbreakable names stay inside their cards`, async ({ page, request }) => {
      await restartReplay(request);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?competitionId=${MATCH}`);
      await expect(page.locator('.timed-competitor-card', { hasText: 'Magnificent Maximiliaan' })).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.timed-competitor-card', { hasText: 'Supercalifragilistic' })).toBeVisible();
      await expect(page.locator('.timed-lap-row.timed-lap-done').first()).toBeVisible({ timeout: 15_000 });

      const problems = await page.evaluate(() => {
        const out: string[] = [];
        for (const card of document.querySelectorAll('.timed-competitor-card')) {
          const c = card.getBoundingClientRect();
          for (const el of card.querySelectorAll('.timed-comp-name, .timed-watermark, .timed-badge-orange, .timed-split-badge')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && (r.left < c.left - 1 || r.right > c.right + 1)) {
              out.push(`${el.className} sticks out of "${card.querySelector('.timed-comp-name')?.textContent?.slice(0, 20)}"`);
            }
          }
        }
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push('page scrolls horizontally');
        return out;
      });
      expect(problems).toEqual([]);
    });
  }
});
