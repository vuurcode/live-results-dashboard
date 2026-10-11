import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { MOCK_URL } from './env';

/**
 * Restart a match's replay from its first sample, so every test starts from the same state.
 * The backend polls every 0.5s and clears a competition's state when laps go backwards,
 * so give it a moment to notice before a page connects.
 */
async function restartReplay(request: APIRequestContext, match: string): Promise<void> {
  const res = await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: match } });
  expect(res.ok()).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 800));
}

test.describe('competition selection', () => {
  test('follows the competition named in the page URL', async ({ page, request }) => {
    await restartReplay(request, 'e2e-mass');
    await page.goto('/?competitionId=e2e-mass');
    await expect(page.locator('.topbar-title')).toHaveText('E2E Mass Start Event');
    await expect(page).toHaveTitle('E2E Mass Start Event | Live Results Dashboard');
  });

  test('uses the default competition when the URL names none', async ({ page, request }) => {
    await restartReplay(request, 'e2e-timed');
    await page.goto('/');
    await expect(page.locator('.topbar-title')).toHaveText('E2E Timed Event');
  });

  test('two viewers of one competition both get its data', async ({ browser, request }) => {
    await restartReplay(request, 'e2e-timed');
    const [a, b] = await Promise.all([browser.newPage(), browser.newPage()]);
    await Promise.all([a.goto('/?competitionId=e2e-timed'), b.goto('/?competitionId=e2e-timed')]);
    for (const page of [a, b]) {
      await expect(page.locator('.topbar-title')).toHaveText('E2E Timed Event');
      await expect(page.locator('.timed-competitor-card', { hasText: 'Competitor A' })).toBeVisible();
    }
    await Promise.all([a.close(), b.close()]);
  });
});

test.describe('timed distance', () => {
  test('shows every heat and competitor, and fills in lap times as they arrive', async ({ page, request }) => {
    await restartReplay(request, 'e2e-timed');
    await page.goto('/?competitionId=e2e-timed');

    await expect(page.locator('.timed-heat-row')).toHaveCount(2);
    for (const name of ['Competitor A', 'Competitor B', 'Competitor C', 'Competitor D']) {
      await expect(page.locator('.timed-competitor-card', { hasText: name })).toBeVisible();
    }
    // 4 competitors x 3 laps (200 / 600 / 1000 m) once the whole replay has played
    await expect(page.locator('.timed-lap-row.timed-lap-done')).toHaveCount(12);
    await expect(page.locator('.timed-lap-dist').filter({ hasText: '1000m' })).toHaveCount(4);
  });

  test('lap rows keep their height while times replace the placeholders', async ({ page, request }) => {
    await restartReplay(request, 'e2e-timed');
    await page.addInitScript(() => localStorage.setItem('compactTimed', 'false')); // per-distance rows
    await page.goto('/?competitionId=e2e-timed');
    await expect(page.locator('.timed-lap-row').first()).toBeVisible();

    const heights = new Map<string, Set<string>>();
    let sawPending = false;
    const sample = async (): Promise<number> => {
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('.timed-competitor-card')].flatMap((card, c) =>
          [...card.querySelectorAll('.timed-lap-row')].map((row, r) => ({
            key: `${c}:${r}`,
            height: row.getBoundingClientRect().height,
            done: row.classList.contains('timed-lap-done'),
          })),
        ),
      );
      for (const row of rows) {
        const seen = heights.get(row.key) ?? new Set<string>();
        seen.add(row.height.toFixed(1));
        heights.set(row.key, seen);
      }
      sawPending ||= rows.some((r) => !r.done);
      return rows.filter((r) => r.done).length;
    };

    // Sample throughout the replay: pending rows first, then every row done.
    let done = 0;
    for (let i = 0; i < 200 && done < 12; i++) {
      done = await sample();
      await page.waitForTimeout(100);
    }
    expect(done).toBe(12);
    expect(sawPending, 'the test must observe rows before their times arrive').toBe(true);
    expect(heights.size).toBe(12);
    for (const [key, seen] of heights) {
      expect(seen.size, `row ${key} changed height: ${[...seen].join(' -> ')}`).toBe(1);
    }
  });
});

test.describe('mass start', () => {
  const names = (page: Page) => page.locator('.race-item-laps .race-name-fixed');

  test('compact mode shows only lap time badges until the final time is known, and can be switched off', async ({ page, request }) => {
    await restartReplay(request, 'e2e-timed');
    await page.goto('/?competitionId=e2e-timed');
    const toggle = page.getByRole('switch', { name: 'Compact' });
    await expect(toggle).toBeChecked(); // on by default
    await expect(page.locator('.timed-compact-body').first()).toBeVisible();
    await expect(page.locator('.timed-compact-body .timed-compact-badge').first()).toBeVisible();
    await expect(page.locator('.timed-compact-body').first()).not.toContainText(/\d\s?m\b/); // no distances

    await expect(page.locator('.timed-compact-latest').first()).toBeVisible();

    await toggle.uncheck();
    await expect(page.locator('.timed-compact-body')).toHaveCount(0);
    await expect(page.locator('.timed-lap-row').first()).toBeVisible();
  });

  test('ranks competitors and marks them finished', async ({ page, request }) => {
    await restartReplay(request, 'e2e-mass');
    await page.goto('/?competitionId=e2e-mass');

    await expect(page.locator('.race-item-laps')).toHaveCount(4);
    // 3 racing laps recorded for everyone (the warm-up lap is dropped): all finished, fastest first
    await expect(page.locator('.race-item-laps.race-finished')).toHaveCount(4);
    await expect(names(page)).toHaveText(['Competitor E', 'Competitor F', 'Competitor G', 'Competitor H']);
  });

  test('selecting a competitor highlights their row, selecting again clears it', async ({ page, request }) => {
    await restartReplay(request, 'e2e-mass');
    await page.goto('/?competitionId=e2e-mass');
    await expect(page.locator('.race-item-laps.race-finished')).toHaveCount(4);

    const row = page.locator('.race-item-laps', { hasText: 'Competitor F' });
    await row.click();
    await expect(row).toHaveClass(/race-selected/);
    await row.click();
    await expect(row).not.toHaveClass(/race-selected/);
  });
});

test('lists the matches of today and opens the chosen one', async ({ page }) => {
  await page.goto('/?competitionId=e2e-timed');
  const select = page.getByLabel('Matches today');
  await expect(select.locator('option')).toHaveCount(3); // the three fixture matches; the mock's other-day and other-venue entries are filtered out
  await expect(select).toHaveValue('e2e-timed');
  await select.selectOption('e2e-mass');
  await page.waitForURL(/competitionId=e2e-mass/);
  await expect(page.getByLabel('Matches today')).toHaveValue('e2e-mass');
});

test('the match picker replaces the event name, venue first, start time only before the start', async ({ page }) => {
  await page.goto('/?competitionId=e2e-timed');
  const select = page.getByLabel('Matches today');
  await expect(select).toBeVisible();
  // the event name is still the page heading, but visually hidden because the picker shows it
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('E2E Timed Event');
  await expect(page.getByRole('heading', { level: 1 })).toHaveClass(/visually-hidden/);
  const labels = await select.locator('option').allTextContents();
  const running = labels.find((l) => l.includes('E2E Timed Event'))!;
  expect(running.trim()).toBe('Mock Ice Rink · E2E Timed Event'); // started: no time
});

test('only one settings group is open at a time, and the options are toggles', async ({ page, request }) => {
  await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-mass' } });
  await page.goto('/?competitionId=e2e-mass');
  const display = page.getByRole('button', { name: /^Display/ });
  const massStart = page.getByRole('button', { name: /^Mass Start/ });
  await expect(display).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('switch', { name: 'Auto-follow updates' })).toBeVisible();

  await massStart.click();
  await expect(massStart).toHaveAttribute('aria-expanded', 'true');
  await expect(display).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('switch', { name: 'Auto-follow updates' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Lap times' })).toBeVisible();

  await display.click();
  await expect(massStart).toHaveAttribute('aria-expanded', 'false');
});
