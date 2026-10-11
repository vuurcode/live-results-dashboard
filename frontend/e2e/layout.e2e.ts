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

  test('lap rows span the whole card, so a highlighted row is highlighted edge to edge', async ({ page }) => {
    await page.goto('/?competitionId=e2e-timed');
    const card = page.locator('.timed-competitor-card').first();
    await expect(card.locator('.timed-lap-row').first()).toBeVisible();
    const [cardBox, rowBox] = [await card.boundingBox(), await card.locator('.timed-lap-row').first().boundingBox()];
    expect(rowBox!.width).toBeGreaterThanOrEqual(cardBox!.width - 2.5); // minus the card border
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
