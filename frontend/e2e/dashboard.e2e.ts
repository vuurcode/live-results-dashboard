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

  test('follows no match when the URL names none, and offers the match list', async ({ page }) => {
    let sockets = 0;
    page.on('websocket', (ws) => { if (ws.url().includes('/ws')) sockets++; });
    await page.goto('/');
    await expect(page.getByRole('status').filter({ hasText: 'Choose a match' })).toBeVisible();
    await expect(page.locator('#matchSelect')).toBeVisible();
    await expect(page.locator('#matchSelect option[disabled]')).toHaveText('No match selected');
    await expect(page.locator('.match-hint')).toHaveText('Select a live match to watch it');
    await expect(page.locator('.skeleton-title')).toHaveCount(0);
    expect(sockets).toBe(0);
  });

  test('says so when there are no matches to pick from', async ({ page }) => {
    await page.route('**/api/matches/today', (route) => route.fulfill({ json: [] }));
    await page.goto('/');
    await expect(page.locator('.match-hint')).toHaveText('There are no matches to watch right now');
    await expect(page.locator('#matchSelect')).toHaveCount(0);
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
    // category and club code sit small below the name
    await expect(page.locator('.timed-competitor-card', { hasText: 'Competitor A' }).locator('.timed-comp-meta')).toHaveText(/\S/);
    // 4 competitors x 3 laps (200 / 600 / 1000 m) once the whole replay has played
    await expect(page.locator('.timed-compact-badge')).toHaveCount(12);
    await expect(page.locator('.compact-dist').filter({ hasText: '1000m' })).toHaveCount(4);
  });

  test('cards keep their height while lap times arrive', async ({ page, request }) => {
    await restartReplay(request, 'e2e-timed');
    await page.goto('/?competitionId=e2e-timed');
    await expect(page.locator('.timed-compact-body').first()).toBeVisible();

    const heights = new Map<number, Set<string>>();
    let badges = 0;
    let sawEmpty = false;
    for (let i = 0; i < 200 && badges < 12; i++) {
      const sample = await page.evaluate(() => ({
        badges: document.querySelectorAll('.timed-compact-badge').length,
        heights: [...document.querySelectorAll('.timed-competitor-card')].map((c) => c.getBoundingClientRect().height.toFixed(1)),
      }));
      badges = sample.badges;
      sawEmpty ||= sample.badges < 12;
      sample.heights.forEach((h, c) => heights.set(c, (heights.get(c) ?? new Set<string>()).add(h)));
      await page.waitForTimeout(100);
    }
    expect(badges).toBe(12);
    expect(sawEmpty, 'the test must observe cards before all their times arrive').toBe(true);
    for (const [card, seen] of heights) {
      expect(seen.size, `card ${card} changed height: ${[...seen].join(' -> ')}`).toBe(1);
    }
  });
});

test.describe('mass start', () => {
  const names = (page: Page) => page.locator('.race-item-laps .race-name-fixed');

  test('cards show the lap times as badges with their distance above, and the total time so far', async ({ page, request }) => {
    await restartReplay(request, 'e2e-timed');
    await page.goto('/?competitionId=e2e-timed');
    await expect(page.locator('.timed-compact-body').first()).toBeVisible();
    await expect(page.locator('.timed-compact-body .timed-compact-badge').first()).toBeVisible();
    await expect(page.locator('.timed-compact-body').first()).toContainText(/\d+m/); // each badge has its distance above it

    await expect(page.locator('.timed-compact-latest').first()).toBeVisible();
    // finished cards keep this layout too, and end with the total time so far
    await expect(page.locator('.timed-compact-final').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.timed-compact-lap .compact-dist').first()).toBeVisible();
    // the distance reached so far sits above the total until the final lap is done
    await expect(page.locator('.timed-compact-final .compact-reached').first()).toBeAttached();
  });

  test('lap colours (off by default) colour the compact badges by variance against the previous lap', async ({ page, request }) => {
    await restartReplay(request, 'e2e-timed');
    await page.goto('/?competitionId=e2e-timed');
    await page.getByRole('button', { name: /^Display/ }).click(); // the settings start closed
    const toggle = page.getByRole('switch', { name: 'Lap time diff colours' });
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('.timed-compact-badge').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.timed-compact-badge[class*="lap-badge-"]')).toHaveCount(0);
    await toggle.check();
    await expect(page.locator('.timed-compact-badge.lap-badge-normal').first()).toBeVisible();
    // the Lap delta threshold is configurable here too, and only while the colours are on
    const threshold = page.getByLabel('Lap time diff threshold');
    await expect(threshold).toBeVisible();
    // long track defaults to 0.5%, takes one decimal, and its example follows the setting (also while stepping)
    await expect(threshold).toHaveValue('0.5');
    const example = page.locator('.settings-panel .setting-popover-example');
    await expect(example.locator('.popover-badge-grey')).toHaveText('0.5%');
    await expect(example.locator('.popover-badge-orange')).toHaveText('40.2\u202fs');
    await expect(example.locator('.popover-badge-purple')).toHaveText('39.8\u202fs');
    await threshold.press('ArrowUp'); // a step of 0.1 updates the example at once
    await expect(example.locator('.popover-badge-grey')).toHaveText('0.6%');
    await threshold.fill('1');
    await threshold.blur();
    await expect(example.locator('.popover-badge-grey')).toHaveText('1%');
    await expect(example.locator('.popover-badge-orange')).toHaveText('40.4\u202fs');
    await expect(example.locator('.popover-badge-purple')).toHaveText('39.6\u202fs');
    await toggle.uncheck();
    await expect(page.getByLabel('Lap time diff threshold')).toBeHidden(); // slid shut
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
  await expect(select.locator('option')).toHaveCount(5); // the five fixture matches; the mock's other-day and other-venue entries are filtered out
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
  await expect(display).toHaveAttribute('aria-expanded', 'false'); // closed on load
  await display.click();
  await expect(display).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('switch', { name: 'Auto-follow on updates' })).toBeVisible();

  await massStart.click();
  await expect(massStart).toHaveAttribute('aria-expanded', 'true');
  await expect(display).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('switch', { name: 'Auto-follow on updates' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Lap times' })).toBeVisible();

  await display.click();
  await expect(massStart).toHaveAttribute('aria-expanded', 'false');
});
