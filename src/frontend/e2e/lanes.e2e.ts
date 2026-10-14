import { expect, test } from '@playwright/test';
import { MOCK_URL } from './env';

// Four lanes in a row from 1280px; from 768px two per row; below that one, so a card stays wide enough to read.
const FOUR_LANES_MIN = 1280;
const READABLE_CARD_WIDTH = 300;

test.describe('four lanes in a row', () => {
  for (const [width, perRow] of [[767, 1], [768, 2], [FOUR_LANES_MIN - 1, 2], [FOUR_LANES_MIN, 4], [2560, 4]] as const) {
    test(`${width}px: a full heat shows ${perRow} cards per row, each readable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/?competitionId=e2e-lanes');
      const cards = page.locator('.timed-heat-row').nth(1).locator('.timed-competitor-card:not(.timed-lane-placeholder)');
      await expect(cards).toHaveCount(4);
      const boxes = await cards.evaluateAll((els) => els.map((e) => {
        const r = e.getBoundingClientRect();
        return { top: Math.round(r.top), width: r.width };
      }));
      expect(new Set(boxes.map((b) => b.top)).size).toBe(4 / perRow);
      for (const b of boxes) expect(b.width).toBeGreaterThanOrEqual(READABLE_CARD_WIDTH);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
});

test.describe('card watermark placement', () => {
  // Below four lanes the watermark sits in the top right of the title. With four lanes in a row it is dead centre:
  // in the title for a card with a result time (here a new personal best), in the whole card for one without (here a DNF).
  interface Placement { dx: number; dy: number; rightGap: number; topGap: number }

  async function pbPlacement(page: import('@playwright/test').Page, width: number): Promise<Placement> {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/?competitionId=e2e-pairs');
    const card = page.locator('.timed-competitor-card', { hasText: 'Competitor A' });
    await expect(card.locator('.timed-watermark')).toBeVisible({ timeout: 15_000 });
    return card.evaluate((c) => {
      const t = c.querySelector('.timed-comp-title')!.getBoundingClientRect();
      const w = c.querySelector('.timed-watermark')!.getBoundingClientRect();
      return { dx: (w.left + w.width / 2 - (t.left + t.width / 2)) / t.width, dy: w.top + w.height / 2 - (t.top + t.height / 2), rightGap: (t.right - w.right) / t.width, topGap: w.top - t.top };
    });
  }

  // the label of a card without a time is a pseudo-element: its computed position is relative to what it is placed against
  async function noTimePlacement(page: import('@playwright/test').Page, width: number) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/?competitionId=e2e-pairs');
    const card = page.locator('.timed-competitor-card.timed-card-no-time', { hasText: 'Competitor B' });
    await expect(card).toBeVisible({ timeout: 15_000 });
    return card.evaluate((c) => {
      const cs = getComputedStyle(c.querySelector('.timed-comp-title')!, '::before');
      const r = c.getBoundingClientRect();
      return { left: cs.left, right: cs.right, top: cs.top, cardWidth: r.width, cardHeight: r.height };
    });
  }

  for (const width of [320, 700, FOUR_LANES_MIN - 1, FOUR_LANES_MIN, 2560]) {
    test(`${width}px: a PB watermark is dead centre in the title`, async ({ page, request }) => {
      await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-pairs' } });
      const o = await pbPlacement(page, width);
      expect(Math.abs(o.dx)).toBeLessThan(0.02);
      expect(Math.abs(o.dy)).toBeLessThan(4);
    });
  }

  test(`${FOUR_LANES_MIN - 1}px: the watermark of a card without a time sits in the top right of the title`, async ({ page, request }) => {
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-pairs' } });
    const o = await noTimePlacement(page, FOUR_LANES_MIN - 1);
    expect(parseFloat(o.left)).toBeGreaterThan(o.cardWidth * 0.5); // right of the middle, next to the right edge
    expect(parseFloat(o.right)).toBeLessThan(40);
  });

  for (const width of [FOUR_LANES_MIN, 2560]) {
    test(`${width}px: the watermark of a card without a time is dead centre in the whole card`, async ({ page, request }) => {
      await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-pairs' } });
      const o = await noTimePlacement(page, width);
      expect(Math.abs(parseFloat(o.left) - o.cardWidth / 2)).toBeLessThan(o.cardWidth * 0.02);
      expect(Math.abs(parseFloat(o.top) - o.cardHeight / 2)).toBeLessThan(o.cardHeight * 0.02);
    });
  }
});

test.describe('top bar icon', () => {
  for (const [width, shown] of [[FOUR_LANES_MIN - 1, false], [FOUR_LANES_MIN, true]] as const) {
    test(`${width}px: the app icon is ${shown ? 'shown' : 'hidden'}, named after the application on hover`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?competitionId=e2e-pairs');
      const icon = page.locator('.topbar-logo');
      await expect(icon).toHaveAttribute('title', 'Live Results Experiment - Proof of Concept');
      await (shown ? expect(icon).toBeVisible() : expect(icon).toBeHidden());
    });
  }
});

test.describe('card content', () => {
  test('the category is named in full, with the club code in brackets behind it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/?competitionId=e2e-pairs');
    await expect(page.locator('.timed-competitor-card', { hasText: 'Competitor A' }).locator('.timed-comp-meta')).toHaveText('Women Juniors A1 (IFX)');
  });

  test('a total time that does not fit on the row of the lap badges is centred on the next row', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto('/?competitionId=e2e-timed');
    const final = page.locator('.timed-compact-final.timed-compact-own-line').first();
    await expect(final).toBeVisible();
    const { offset, bodyWidth, rowGap } = await final.evaluate((f) => {
      const body = f.closest('.timed-compact-body')!.getBoundingClientRect();
      const r = f.getBoundingClientRect();
      const lastLap = [...f.closest('.timed-compact-body')!.querySelectorAll('.timed-compact-lap')].pop()!.getBoundingClientRect();
      return { offset: r.left + r.width / 2 - (body.left + body.width / 2), bodyWidth: body.width, rowGap: r.top - lastLap.bottom };
    });
    expect(Math.abs(offset)).toBeLessThan(bodyWidth * 0.03);
    expect(rowGap).toBeGreaterThanOrEqual(0); // below the badges, not beside them
  });
});

test.describe('record cards', () => {
  test('WR, NR, TR and TRC show their own watermark and a purple total time badge', async ({ page, request }) => {
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-lanes' } });
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/?competitionId=e2e-lanes');
    const expected: [string, string][] = [
      ['Competitor C', 'World Record'],
      ['Competitor D', 'National Record'],
      ['Competitor E', 'Track Record'],
      ['Competitor F', 'Track Record\n(Women Juniors A1)'],
    ];
    for (const [name, watermark] of expected) {
      const card = page.locator('.timed-competitor-card', { hasText: name });
      await expect(card.locator('.timed-comp-title')).toHaveAttribute('data-watermark', watermark, { timeout: 15_000 });
      await expect(card.locator('.timed-compact-final .timed-lap-time').first()).toHaveCSS('background-color', 'rgb(111, 66, 193)');
    }
  });
});

test.describe('cards on one row', () => {
  for (const width of [800, 1280]) {
    test(`${width}px: the cards of a row, and their titles, are as tall as the tallest`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/?competitionId=e2e-lanes');
      const cards = page.locator('.timed-heat-row').nth(1).locator('.timed-competitor-card:not(.timed-lane-placeholder)');
      await expect(cards).toHaveCount(4);
      const boxes = await cards.evaluateAll((els) => els.map((e) => ({
        top: Math.round(e.getBoundingClientRect().top),
        card: Math.round(e.getBoundingClientRect().height),
        title: Math.round(e.querySelector('.timed-comp-title')!.getBoundingClientRect().height),
        header: Math.round(e.querySelector('.timed-comp-header')!.getBoundingClientRect().height),
      })));
      for (const top of new Set(boxes.map((b) => b.top))) {
        const row = boxes.filter((b) => b.top === top);
        expect(new Set(row.map((b) => b.card)).size, `card heights ${JSON.stringify(row)}`).toBe(1);
        expect(new Set(row.map((b) => b.title)).size, `title heights ${JSON.stringify(row)}`).toBe(1);
        expect(new Set(row.map((b) => b.header)).size, `header heights ${JSON.stringify(row)}`).toBe(1);
      }
    });
  }
});

test.describe('card content is never clipped', () => {
  for (const width of [320, 800, 1400]) {
    test(`${width}px: a card is tall enough for its title and its body, also while the total wraps to its own line`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/?competitionId=e2e-timed');
      const cards = page.locator('.timed-competitor-card:not(.timed-lane-placeholder)');
      await expect(cards).toHaveCount(4);
      const clipped = await cards.evaluateAll((els) => els.filter((c) => {
        const content = [...c.children].reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
        return content > c.getBoundingClientRect().height + 1 || [...c.children].some((child) => child.scrollHeight > child.clientHeight + 1);
      }).length);
      expect(clipped).toBe(0);
    });
  }
});
