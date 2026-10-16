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
      await page.goto('/?competitionId=e2e-individual');
      const px = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      expect(px).toBeCloseTo(font, 1);
    });
  }

  test('4K: card names and the watermark stay inside their card', async ({ page }) => {
    await page.setViewportSize({ width: 3840, height: 2160 });
    await page.goto('/?competitionId=e2e-pairs');
    await expect(page.locator('.individual-watermark').first()).toBeVisible({ timeout: 15_000 });
    const overflowing = await page.evaluate(() =>
      [...document.querySelectorAll('.individual-competitor-card')].filter((card) => {
        const c = card.getBoundingClientRect();
        return [...card.querySelectorAll('.individual-watermark, .individual-card-name, .fw-semibold')].some((el) => {
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
    await page.goto('/?competitionId=e2e-individual');
    const header = page.locator('.accordion-header').first();
    await expect(page.locator('.individual-heat-row').first()).toBeAttached();
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

  test('the pinned distance title shrinks while it is stuck', async ({ page, request }) => {
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-individual' } }); // a replay that has run on would leave no live distance to unfold
    await page.setViewportSize({ width: 1280, height: 260 });
    await page.goto('/?competitionId=e2e-individual');
    const button = page.locator('.accordion-header .accordion-button').first();
    await expect(page.locator('.individual-heat-row').first()).toBeAttached();
    // The one-off scroll to the live race may still be under way, and the height of the title depends on where the page is:
    // compare the title at the top of the page with the title at the bottom, both reached at once, until the page has settled.
    await expect.poll(async () => {
      const at = async (top: number) => {
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), top);
        return (await button.boundingBox())!.height;
      };
      const unstuck = await at(0);
      const stuck = await at(await page.evaluate(() => document.documentElement.scrollHeight));
      return stuck / unstuck;
    }).toBeLessThan(0.8);
  });

  test('the groups overview of a mass start stays pinned below the title', async ({ page, request }) => {
    // start the replay over so the groups exist and the page is tall enough to scroll
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-mass' } });
    await page.waitForTimeout(800);
    await page.setViewportSize({ width: 1280, height: 330 });
    await page.goto('/?competitionId=e2e-mass');
    const strip = page.locator('.groups-strip').first();
    await expect(strip).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500); // the badges settle on their lines
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    const box = (await strip.boundingBox())!;
    const barBottom = await page.evaluate(() => document.querySelector('.topbar')!.getBoundingClientRect().bottom);
    expect(box.y).toBeGreaterThanOrEqual(barBottom - 1);
    expect(box.y).toBeLessThan(150);
  });
});

test.describe('mass start timeline', () => {
  for (const width of [390, 1280, 3840]) {
    test(`${width}px: the racers sit on one axis, leader at the right, never overlapping or cut off`, async ({ page, request }) => {
      await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-mass' } });
      await page.waitForTimeout(800);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?competitionId=e2e-mass');
      await expect(page.locator('.mass-timeline .timeline-leader')).toBeVisible({ timeout: 15_000 }); // the racers are placed from the first update on
      await page.waitForTimeout(600); // the badges slide into place
      const { boxes, lane } = await page.evaluate(() => {
        const l = document.querySelector('.mass-timeline .timeline-lane')!.getBoundingClientRect();
        const bs = [...document.querySelectorAll('.mass-timeline .timeline-racer')].map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        return { boxes: bs, lane: { x: l.x, right: l.right, bottom: l.bottom } };
      });
      expect(boxes.length).toBeGreaterThan(1);
      expect(Math.abs(boxes[0].x + boxes[0].w - lane.right)).toBeLessThanOrEqual(1); // the leader is at the right edge
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(lane.x - 1);
        expect(b.y + b.h).toBeLessThanOrEqual(lane.bottom + 1);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], c = boxes[j];
          const overlap = a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
          expect(overlap, `racers ${i} and ${j} overlap: ${JSON.stringify(boxes)}`).toBe(false);
        }
      }
    });
  }
});

test('racing competitor card titles have the same height with or without badges', async ({ page, request }) => {
  await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-pairs' } });
  await page.goto('/?competitionId=e2e-pairs');
  await expect(page.locator('.individual-comp-header').first()).toBeVisible();
  await expect(page.locator('.individual-comp-header .individual-split-badge').first()).toBeVisible(); // some titles carry a badge
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('.individual-comp-header-merged')].map((h) => Math.round(h.getBoundingClientRect().height * 10) / 10),
  );
  expect(heights.length).toBeGreaterThan(1);
  expect([...new Set(heights)], String(heights)).toHaveLength(1);
});

test.describe('lane columns on narrow screens', () => {
  for (const [width, perRow] of [[1280, 2], [768, 2], [767, 1], [400, 1]] as const) {
    test(`${width}px: a pair is shown ${perRow === 2 ? 'side by side' : 'one per row'}`, async ({ page, request }) => {
      await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-pairs' } });
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/?competitionId=e2e-pairs');
      const cards = page.locator('.individual-heat-row').first().locator('.individual-competitor-card');
      await expect(cards).toHaveCount(2);
      // measured in one go: the page may be scrolling to the live race
      const [ay, by] = await cards.evaluateAll(els => els.map(e => e.getBoundingClientRect().top));
      expect(Math.abs(ay - by) < 5 ? 2 : 1).toBe(perRow);
    });
  }
});

test.describe('settings panel and tooltips', () => {
  test('the settings button is as tall as the competition picker, and the settings are in two columns', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto('/?competitionId=e2e-individual');
    await page.getByRole('button', { name: /^Display/ }).click(); // the settings start closed
    const h = (loc: ReturnType<typeof page.locator>) => loc.evaluate((e) => Math.round(e.getBoundingClientRect().height));
    expect(await h(page.locator('button.topbar-group-btn').first())).toBe(await h(page.locator('#competitionSelect')));
    const tops = await page.locator('.settings-panel .setting-group:visible').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops.length).toBeGreaterThan(2);
    expect(new Set(tops).size).toBeLessThan(tops.length); // wide screens: settings share rows
    expect(tops.filter((t) => t === tops[0]).length).toBe(2); // two per row
  });

  test('on a narrow screen the settings are listed below each other', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 700 });
    await page.goto('/?competitionId=e2e-individual');
    await page.getByRole('button', { name: /Display/ }).click();
    const tops = await page.locator('.settings-panel .setting-group:visible').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(tops.length);
  });

  test('the help text is always shown under its setting and fits inside the panel', async ({ page }) => {
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/?competitionId=e2e-individual');
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
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-individual' } });
    await page.goto('/?competitionId=e2e-individual');
    const badge = page.locator('.individual-compact-badge').first();
    await expect(badge).toBeVisible({ timeout: 30000 });
    const title = await badge.getAttribute('title');
    expect(title!.split('\n')).toHaveLength(3);
    expect(title).toMatch(/^Distance: \d+m\nLap time: [\d:.]+\nTotal time: [\d:.]+$/);
    expect(await badge.evaluate((e) => getComputedStyle(e).cursor)).toBe('help');
  });
});

test.describe('a heat of two skaters', () => {
  // heat 1 has only white/red, heat 2 has all four lanes
  for (const width of [1280, 700]) {
    test(`${width}px: is a row of its own with two cards, while the full heat keeps its four lanes`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?competitionId=e2e-lanes');
      await expect(page.locator('.individual-heat-row').first().locator('.individual-lane-col')).toHaveCount(2);
      await expect(page.locator('.individual-heat-row').nth(1).locator('.individual-lane-col')).toHaveCount(4);
    });
  }
});

test('the lane colours of a heat of two skaters sit behind the columns of its cards', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto('/?competitionId=e2e-lanes');
  const row = page.locator('.individual-heat-row').first();
  const bg = await row.locator('.individual-heat-lane-bg').nth(1).boundingBox();
  const col = await row.locator('.individual-lane-col').nth(1).boundingBox();
  expect(Math.abs(bg!.x - col!.x)).toBeLessThan(2);
  expect(Math.abs(bg!.width - col!.width)).toBeLessThan(2);
});

test('the heats of a distance with white and red pairs only stay one below the other on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 900 });
  await page.goto('/?competitionId=e2e-pairs');
  const rows = page.locator('.individual-heat-row');
  await expect(rows).toHaveCount(3);
  const first = await rows.nth(0).boundingBox();
  const second = await rows.nth(1).boundingBox();
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 2);
});

test('unfolding a distance does not change the height of its heats halfway', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/?competitionId=e2e-individual');
  await expect(page.locator('.individual-compact-badge').nth(5)).toBeVisible({ timeout: 30000 });
  const button = page.locator('.accordion-button').first();
  if ((await button.getAttribute('aria-expanded')) === 'true') await button.click();
  await expect(page.locator('.accordion-collapse.collapse:not(.show)').first()).toBeAttached();
  await page.waitForTimeout(500);
  await button.click();
  const heights = new Set<number>();
  for (let i = 0; i < 14; i++) {
    const h = await page.evaluate(() => Math.round(document.querySelector('.accordion-collapse .individual-heat-row')!.getBoundingClientRect().height));
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
      await expect(page.locator('.individual-compact-final').first()).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.individual-pb-current').first()).toBeVisible({ timeout: 30000 });
      const edges = await page.evaluate(() =>
        [...document.querySelectorAll('.individual-competitor-card:not(.individual-lane-placeholder)')].map((card) => {
          const c = card.getBoundingClientRect();
          const left = (sel: string) => { const e = card.querySelector(sel); return e ? e.getBoundingClientRect().left - c.left : null; };
          const right = (sel: string) => { const e = card.querySelector(sel); return e ? c.right - e.getBoundingClientRect().right : null; };
          const ownLine = !!card.querySelector('.individual-compact-final.individual-compact-own-line'); // a total on a row of its own is centred
          return { name: left('.individual-comp-name'), firstBadge: left('.individual-compact-lap'), total: ownLine ? null : right('.individual-compact-final'), pb: right('.individual-pb-current') };
        }),
      );
      for (const e of edges) {
        if (e.firstBadge !== null) expect(Math.abs(e.firstBadge - e.name!), `badges vs title left: ${JSON.stringify(e)}`).toBeLessThanOrEqual(2);
        if (e.total !== null && e.pb !== null) expect(Math.abs(e.total - e.pb), `total vs PB right: ${JSON.stringify(e)}`).toBeLessThanOrEqual(2);
      }
    });
  }
});

test('a click outside the settings folds them away, a click inside does not', async ({ page }) => {
  await page.goto('/?competitionId=e2e-individual');
  const display = page.getByRole('button', { name: /^Display/ });
  await display.click();
  await expect(display).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.settings-panel').click({ position: { x: 5, y: 5 } });
  await expect(display).toHaveAttribute('aria-expanded', 'true');
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await expect(display).toHaveAttribute('aria-expanded', 'false');
});

test('on a short screen the open settings stay inside the viewport and scroll to their last card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  await page.goto('/?competitionId=e2e-mass');
  await page.getByRole('button', { name: /^Display/ }).click();
  const panel = page.locator('.settings-panel');
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(600 + 1);
  await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const lastCard = (await panel.locator('.setting-popover').last().boundingBox())!;
  expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(600 + 1);
});

test('the settings sections are columns on wide screens and below each other on narrow ones', async ({ page }) => {
  for (const [width, wide] of [[1440, true], [400, false]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?competitionId=e2e-mass');
    await page.getByRole('button', { name: /^Display/ }).click();
    await expect(page.locator('.settings-section')).toHaveCount(3);
    const boxes = await page.locator('.settings-section').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
    expect(boxes).toHaveLength(3);
    for (let i = 1; i < boxes.length; i++) {
      if (wide) {
        expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].w - 1);
        expect(Math.abs(boxes[i].y - boxes[0].y)).toBeLessThanOrEqual(1);
      } else {
        expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].h - 1);
        expect(Math.abs(boxes[i].x - boxes[0].x)).toBeLessThanOrEqual(1);
      }
    }
  }
});
