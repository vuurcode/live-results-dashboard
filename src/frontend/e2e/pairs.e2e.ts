import { expect, test, type APIRequestContext } from '@playwright/test';
import { MOCK_URL } from './env';

// A two-lane (pairs) competition: a DNF and a personal best in one pair, a skater without an opponent, a normal pair.
const COMPETITION = 'e2e-pairs';

async function restartReplay(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: COMPETITION } });
  expect(res.ok()).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 800));
}

test.describe('two-lane competition', () => {
  test('shows pairs, a lone skater, a DNF and a personal best', async ({ page, request }) => {
    await restartReplay(request);
    await page.goto(`/?competitionId=${COMPETITION}`);

    await expect(page.locator('.individual-heat-row')).toHaveCount(3);
    await expect(page.locator('.individual-competitor-card:not(.individual-lane-placeholder)')).toHaveCount(5);
    // the lone skater's pair keeps an empty slot for the missing lane
    await expect(page.locator('.individual-lane-placeholder')).toHaveCount(1);
    // no heat has more than the two lanes
    for (const row of await page.locator('.individual-heat-row').all()) {
      expect(await row.locator('.individual-competitor-card').count()).toBeLessThanOrEqual(2);
    }
    // the lone skater (heat 2) has a card of their own
    await expect(page.locator('.individual-competitor-card', { hasText: 'Competitor C' })).toBeVisible();

    // once the replay has finished: A set a personal best, B did not finish
    const cardA = page.locator('.individual-competitor-card', { hasText: 'Competitor A' });
    const cardB = page.locator('.individual-competitor-card', { hasText: 'Competitor B' });
    await expect(cardB.getByText('DNF', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(cardA.locator('.individual-compact-badge')).toHaveCount(2);
    await expect(cardA.getByText('PB', { exact: true })).toBeVisible();
    // times are in thousandths by default, hundredths on request
    await expect(cardA.locator('.individual-compact-final .race-time')).toHaveText(/\.\d{3}$/);
    await page.getByRole('button', { name: /^Display/ }).click();
    await page.locator('#thousandthsInput').uncheck();
    await expect(cardA.locator('.individual-compact-final .race-time')).toHaveText(/^\d+:?\d*\.\d{2}$/);
    // the old personal best on the card title is struck through (a line drawn across it) once it has been beaten
    await expect(cardA.locator('.individual-pb-beaten')).toBeVisible();
    await expect
      .poll(() => cardA.locator('.individual-pb-beaten').evaluate((el) => getComputedStyle(el, '::after').height))
      .toBe('1px');
    // ... and stays plain for a skater who did not improve it (Competitor C finished slower than 43.0)
    await expect(page.locator('.individual-competitor-card', { hasText: 'Competitor C' }).locator('.individual-pb-beaten')).toHaveCount(0);
    // a time slower than the personal best shows the difference as an orange watermark, not as a badge
    const slower = page.locator('.individual-competitor-card', { hasText: 'Competitor C' }).locator('.individual-watermark-slower');
    await expect(slower).toHaveText(/^\+ \d/);
    await expect(slower).toHaveCSS('color', /rgba?\(176, 84, 0/);
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
        await page.goto(`/?competitionId=${COMPETITION}`);
        await expect(page.locator('html')).toHaveAttribute('lang', locale.slice(0, 2));
        const cardA = page.locator('.individual-competitor-card', { hasText: 'Competitor A' });
        await expect(cardA.getByText(term, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('.individual-competitor-card').getByText(other, { exact: true })).toHaveCount(0);
        await expect(cardA.getByText(term === 'PB' ? 'Previous PB' : 'Vorig PR')).toBeVisible();
      });
    });
  }
});

test.describe('long names', () => {
  for (const width of [320, 1280]) {
    test(`${width}px: long and unbreakable names stay inside their cards`, async ({ page, request }) => {
      await restartReplay(request);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?competitionId=${COMPETITION}`);
      await expect(page.locator('.individual-competitor-card', { hasText: 'Magnificent Maximiliaan' })).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.individual-competitor-card', { hasText: 'Supercalifragilistic' })).toBeVisible();
      await expect(page.locator('.individual-compact-badge').first()).toBeVisible({ timeout: 15_000 });

      const problems = await page.evaluate(() => {
        const out: string[] = [];
        for (const card of document.querySelectorAll('.individual-competitor-card')) {
          const c = card.getBoundingClientRect();
          for (const el of card.querySelectorAll('.individual-comp-name, .individual-watermark, .individual-badge-orange, .individual-split-badge')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && (r.left < c.left - 1 || r.right > c.right + 1)) {
              out.push(`${el.className} sticks out of "${card.querySelector('.individual-comp-name')?.textContent?.slice(0, 20)}"`);
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
