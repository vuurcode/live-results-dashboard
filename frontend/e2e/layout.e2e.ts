import { expect, test } from '@playwright/test';
import { MOCK_URL } from './env';

test.describe('large screens', () => {
  for (const [width, font] of [
    [1280, 16],
    [1920, 16],
    [2560, 21.33],
    [3840, 32],
  ] as const) {
    test(`${width}px wide: root font size scales to ${font}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1080 });
      await page.goto('/?competitionId=e2e-timed');
      const px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      expect(px).toBeCloseTo(font, 1);
    });
  }

  test('4K: card names and the watermark stay inside their card', async ({ page }) => {
    await page.setViewportSize({ width: 3840, height: 2160 });
    await page.goto('/?competitionId=e2e-pairs');
    await expect(page.locator('.timed-watermark').first()).toBeVisible({ timeout: 15_000 });
    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll('.timed-competitor-card')].filter((card) => {
        const c = card.getBoundingClientRect();
        return [...card.querySelectorAll('.timed-watermark, .timed-card-name, .fw-semibold')].some((el) => {
          const r = el.getBoundingClientRect();
          return r.left < c.left - 1 || r.right > c.right + 1;
        });
      }).length,
    );
    expect(overflowing).toBe(0);
  });
});

test.describe('pinned titles', () => {
  test('the top bar and the open distance title stay visible while the list scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 260 });
    await page.goto('/?competitionId=e2e-timed');
    const header = page.locator('.accordion-header').first();
    await expect(page.locator('.timed-heat-row').first()).toBeAttached();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    const { barBottom, headerTop, headerBottom, scrollY } = await page.evaluate(() => ({
      barBottom: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
      headerTop: document.querySelector('.accordion-header')!.getBoundingClientRect().top,
      headerBottom: document.querySelector('.accordion-header')!.getBoundingClientRect().bottom,
      scrollY: window.scrollY,
    }));
    expect(scrollY).toBeGreaterThan(0);
    expect(barBottom).toBeGreaterThan(0);
    expect(headerTop).toBeGreaterThanOrEqual(barBottom - 1);
    expect(headerBottom).toBeLessThan(260);
    await expect(header).toBeInViewport();
  });

  test('the pinned distance title shrinks while it is stuck', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 260 });
    await page.goto('/?competitionId=e2e-timed');
    const button = page.locator('.accordion-header .accordion-button').first();
    await expect(page.locator('.timed-heat-row').first()).toBeAttached();
    const before = (await button.boundingBox())!.height;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(async () => (await button.boundingBox())!.height).toBeLessThan(before * 0.8);
  });

  test('the groups overview of a mass start stays pinned below the title', async ({ page, request }) => {
    // start the replay over so the groups exist and the page is tall enough to scroll
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-mass' } });
    await page.waitForTimeout(800);
    await page.setViewportSize({ width: 1280, height: 330 });
    await page.goto('/?competitionId=e2e-mass');
    const strip = page.locator('.groups-strip').first();
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    const box = (await strip.boundingBox())!;
    const barBottom = await page.evaluate(() => document.querySelector('.topbar')!.getBoundingClientRect().bottom);
    expect(box.y).toBeGreaterThanOrEqual(barBottom - 1);
    expect(box.y).toBeLessThan(150);
  });
});

test.describe('mass start group cards', () => {
  for (const width of [390, 1280, 3840]) {
    test(`${width}px: cards are readable, equal and never cut off`, async ({ page, request }) => {
      await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-mass' } });
      await page.waitForTimeout(800);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?competitionId=e2e-mass');
      const cards = page.locator('.groups-strip .group-strip-card');
      await expect(cards.first()).toBeVisible({ timeout: 15_000 });
      const { widths, rem, cut } = await page.evaluate(() => {
        const strip = document.querySelector('.groups-strip') as HTMLElement;
        const cs = [...strip.querySelectorAll('.group-strip-card')] as HTMLElement[];
        const stripBox = strip.getBoundingClientRect();
        return {
          widths: cs.map((c) => c.getBoundingClientRect().width),
          rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
          // a card may be scrolled out of view, but must never be clipped without the strip being scrollable
          cut: strip.scrollWidth > strip.clientWidth && getComputedStyle(strip).overflowX === 'hidden' && stripBox.width > 0,
        };
      });
      for (const w of widths) {
        expect(w).toBeGreaterThanOrEqual(11 * rem - 1);
        expect(w).toBeLessThanOrEqual(22 * rem + 1);
      }
      expect(cut).toBe(false);
    });
  }
});

test('competitor card titles have the same height with or without badges', async ({ page, request }) => {
  await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-pairs' } });
  await page.goto('/?competitionId=e2e-pairs');
  await expect(page.locator('.timed-comp-header').first()).toBeVisible();
  await expect(page.locator('.timed-comp-header .timed-split-badge').first()).toBeVisible(); // some titles carry a badge
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('.timed-comp-header')].map((h) => Math.round(h.getBoundingClientRect().height * 10) / 10),
  );
  expect(heights.length).toBeGreaterThan(1);
  expect(new Set(heights).size).toBe(1);
});

test('a competitor title stays pinned while its tall card scrolls,', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto('/?competitionId=e2e-timed');
  const card = page.locator('.timed-competitor-card').first();
  await expect(card.locator('.timed-compact-body')).toBeVisible();
  const { cardTop, cardH } = await card.evaluate((c) => {
    const r = c.getBoundingClientRect();
    return { cardTop: r.top + window.scrollY, cardH: r.height };
  });
  await page.evaluate((y) => window.scrollTo(0, y), cardTop + 10); // card top is now above the pinned bars
  await page.waitForTimeout(300);
  const barBottom = await page.evaluate(() => document.querySelector('.topbar')!.getBoundingClientRect().bottom); // (the disclaimer above it has scrolled away)
  const headerTop = await card.locator('.timed-comp-header').evaluate((h) => h.getBoundingClientRect().top);
  expect(cardH).toBeGreaterThan(0);
  expect(headerTop).toBeGreaterThanOrEqual(barBottom - 1);
  expect(headerTop).toBeLessThan(barBottom + 80);
  await expect(card.locator('.timed-comp-header')).toBeInViewport();

});

test.describe('lane columns on narrow screens', () => {
  for (const [width, perRow] of [[1280, 2], [700, 2], [400, 1]] as const) {
    test(`${width}px: a pair is shown ${perRow === 2 ? 'side by side' : 'one per row'}`, async ({ page, request }) => {
      await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-pairs' } });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?competitionId=e2e-pairs');
      const cards = page.locator('.timed-heat-row').first().locator('.timed-competitor-card');
      await expect(cards).toHaveCount(2);
      const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
      expect(Math.abs(a!.y - b!.y) < 5 ? 2 : 1).toBe(perRow);
    });
  }
});

test.describe('settings panel and tooltips', () => {
  test('the settings button is as tall as the match picker, and the settings are listed below each other', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto('/?competitionId=e2e-timed');
    await page.getByRole('button', { name: /^Display/ }).click(); // the settings start closed
    const h = (loc: ReturnType<typeof page.locator>) => loc.evaluate((e) => Math.round(e.getBoundingClientRect().height));
    expect(await h(page.locator('button.topbar-group-btn').first())).toBe(await h(page.locator('#matchSelect')));
    const tops = await page.locator('.settings-panel .setting-group:visible').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops.length).toBeGreaterThan(2);
    expect(new Set(tops).size).toBe(tops.length); // one per row
  });

  test('the help text is always shown under its setting and fits inside the panel', async ({ page }) => {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/?competitionId=e2e-timed');
      await page.getByRole('button', { name: /^Display/ }).click();
      const bodies = page.locator('.settings-panel .setting-popover-body:visible');
      await expect(bodies.first()).toBeVisible(); // without hovering anything
      const panel = (await page.locator('.settings-panel').boundingBox())!;
      for (const body of await bodies.all()) {
        const box = (await body.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(panel.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      }
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw).toBeLessThanOrEqual(cw);
    }
  });

  test('a lap badge has a tooltip with distance, lap time and total time on three rows', async ({ page, request }) => {
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-timed' } });
    await page.goto('/?competitionId=e2e-timed');
    const badge = page.locator('.timed-compact-badge').first();
    await expect(badge).toBeVisible({ timeout: 30000 });
    const title = await badge.getAttribute('title');
    expect(title!.split('\n')).toHaveLength(3);
    expect(title).toMatch(/^Distance: \d+m\nLap time: [\d:.]+\nTotal time: [\d:.]+$/);
    expect(await badge.evaluate((e) => getComputedStyle(e).cursor)).toBe('help');
  });
});

test.describe('empty lane sets on narrow screens', () => {
  // heat 1 has only white/red, heat 2 has all four lanes
  for (const [width, hidden] of [[1280, false], [700, true], [400, true]] as const) {
    test(`${width}px: the yellow/blue lanes of heat 1 are ${hidden ? 'hidden' : 'kept'}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?competitionId=e2e-lanes');
      const heat1 = page.locator('.timed-heat-row').first();
      await expect(heat1.locator('.timed-lane-col')).toHaveCount(4);
      await expect(heat1.locator('.timed-lane-col.lane-set-empty')).toHaveCount(2);
      const visible = await heat1.locator('.timed-lane-col').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).length);
      expect(visible).toBe(hidden ? 2 : 4);
      const bgs = await heat1.locator('.timed-heat-lane-bg:visible').count(); // the heat label's colour bars follow too
      expect(bgs).toBe(width > 800 ? 4 : 0); // (the label itself is hidden on narrow screens)
      // the full heat keeps all four lanes
      await expect(page.locator('.timed-heat-row').nth(1).locator('.timed-lane-col.lane-set-empty')).toHaveCount(0);
    });
  }
});

test('unfolding a distance does not change the height of its heats halfway', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?competitionId=e2e-timed');
  await expect(page.locator('.timed-compact-badge').nth(5)).toBeVisible({ timeout: 30000 });
  const button = page.locator('.accordion-button').first();
  if ((await button.getAttribute('aria-expanded')) === 'true') await button.click();
  await expect(page.locator('.accordion-collapse.collapse:not(.show)').first()).toBeAttached();
  await page.waitForTimeout(500);
  await button.click();
  const heights = new Set<number>();
  for (let i = 0; i < 14; i++) {
    const h = await page.evaluate(() => Math.round(document.querySelector('.accordion-collapse .timed-heat-row')!.getBoundingClientRect().height));
    if (h > 0) heights.add(h); // (0 = not yet unfolded)
    await page.waitForTimeout(40);
  }
  expect([...heights], 'the pinned-title state must not flip while the accordion animates').toHaveLength(1);
});

test.describe('card side padding', () => {
  for (const width of [1280, 900, 600, 390]) {
    test(`${width}px: title, lap badges and total time share the same side edges`, async ({ page, request }) => {
      await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-pairs' } });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?competitionId=e2e-pairs');
      await expect(page.locator('.timed-compact-final').first()).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.timed-pb-current').first()).toBeVisible({ timeout: 30000 });
      const edges = await page.evaluate(() =>
        [...document.querySelectorAll('.timed-competitor-card:not(.timed-lane-placeholder)')].map((card) => {
          const c = card.getBoundingClientRect();
          const left = (sel: string) => { const e = card.querySelector(sel); return e ? e.getBoundingClientRect().left - c.left : null; };
          const right = (sel: string) => { const e = card.querySelector(sel); return e ? c.right - e.getBoundingClientRect().right : null; };
          return { name: left('.timed-comp-name'), firstBadge: left('.timed-compact-lap'), total: right('.timed-compact-final'), pb: right('.timed-pb-current') };
        }),
      );
      for (const e of edges) {
        if (e.firstBadge !== null) expect(Math.abs(e.firstBadge - e.name!), `badges vs title left: ${JSON.stringify(e)}`).toBeLessThanOrEqual(2);
        if (e.total !== null && e.pb !== null) expect(Math.abs(e.total - e.pb), `total vs PB right: ${JSON.stringify(e)}`).toBeLessThanOrEqual(2);
      }
    });
  }
});
