import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { MOCK_URL } from './env';

/**
 * Restart a competition's replay from its first sample, so every test starts from the same state.
 * The backend polls every 0.5s and clears a competition's state when laps go backwards,
 * so give it a moment to notice before a page connects.
 */
async function restartReplay(request: APIRequestContext, competition: string): Promise<void> {
  const res = await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: competition } });
  expect(res.ok()).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 800));
}

test.describe('competition selection', () => {
  test('follows the competition named in the page URL', async ({ page, request }) => {
    await restartReplay(request, 'e2e-mass');
    await page.goto('/?competitionId=e2e-mass');
    await expect(page.locator('.topbar-title')).toHaveText('E2E Mass Start Event');
    await expect(page).toHaveTitle('E2E Mass Start Event | Live Results Experiment - Proof of Concept');
  });

  test('follows no competition when the URL names none, and offers the competition list', async ({ page }) => {
    let sockets = 0;
    page.on('websocket', (ws) => { if (ws.url().includes('/ws')) sockets++; });
    await page.goto('/');
    await expect(page.getByRole('status').filter({ hasText: 'Choose a competition' })).toBeVisible();
    await expect(page.locator('#competitionSelect')).toBeVisible();
    await expect(page.locator('#competitionSelect option[disabled]')).toHaveText('No competition selected');
    await expect(page.locator('.competition-hint')).toHaveText('Select a live competition to watch it');
    await expect(page.locator('.skeleton-title')).toHaveCount(0);
    expect(sockets).toBe(0);
  });

  test('on a small screen the hint sits below the picker', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.goto('/');
    const select = (await page.locator('#competitionSelect').boundingBox())!;
    const hint = (await page.locator('.competition-hint').boundingBox())!;
    expect(hint.y).toBeGreaterThanOrEqual(select.y + select.height);
    expect(hint.x + hint.width).toBeLessThanOrEqual(400);
    const cog = (await page.getByRole('button', { name: /^Display/ }).boundingBox())!;
    expect(Math.abs(cog.y + cog.height / 2 - (select.y + select.height / 2))).toBeLessThanOrEqual(3);
    expect(Math.abs(cog.height - select.height)).toBeLessThanOrEqual(1);
  });

  test('the unofficial results notice shows only while a match with results is shown', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.disclaimer-bar')).toHaveCount(0);
    await page.goto('/?competitionId=e2e-notlive');
    await expect(page.getByRole('status').filter({ hasText: 'not live yet' })).toBeVisible();
    await expect(page.locator('.disclaimer-bar')).toHaveCount(0);
    await page.goto('/?competitionId=e2e-individual');
    await expect(page.locator('.disclaimer-bar')).toBeVisible();
  });

  test('says so when there are no competitions to pick from', async ({ page }) => {
    await page.route('**/api/competitions/today', (route) => route.fulfill({ json: [] }));
    await page.goto('/');
    await expect(page.locator('.competition-hint')).toHaveText('There are no competitions to watch right now');
    await expect(page.locator('#competitionSelect')).toHaveCount(0);
  });

  test.describe('the remembered venue', () => {
    const entry = (id: string, venue: string, live: boolean) => ({
      id, code: id, name: `Match ${id}`, start: '2026-10-24T10:00:00Z', allowToSendLive: true, live, venue: { code: venue, name: venue, city: 'City' },
    });
    const list = [entry('e2e-individual', 'V1', false), entry('e2e-pairs', 'V1', true), entry('e2e-lanes', 'V2', true)];

    test('opens the live competition of the venue viewed last, when the page has no competition or an invalid one', async ({ page }) => {
      await page.route('**/api/competitions/today', (route) => route.fulfill({ json: list }));
      await page.addInitScript(() => { if (!localStorage.getItem('lastVenueCode')) localStorage.setItem('lastVenueCode', 'V1'); });
      await page.goto('/');
      await expect(page).toHaveURL(/competitionId=e2e-pairs$/);
      await page.goto('/?competitionId=not%20valid');
      await expect(page).toHaveURL(/competitionId=e2e-pairs$/);
    });

    test('opens the first competition of the venue when none is live', async ({ page }) => {
      await page.route('**/api/competitions/today', (route) => route.fulfill({ json: [entry('e2e-individual', 'V1', false), entry('e2e-pairs', 'V1', false)] }));
      await page.addInitScript(() => localStorage.setItem('lastVenueCode', 'V1'));
      await page.goto('/');
      await expect(page).toHaveURL(/competitionId=e2e-individual$/);
    });

    test('remembers the venue of the competition being viewed, and stays on the page without one remembered', async ({ page }) => {
      await page.route('**/api/competitions/today', (route) => route.fulfill({ json: list }));
      await page.goto('/');
      await expect(page.locator('#competitionSelect')).toBeVisible();
      expect(page.url()).not.toContain('competitionId');
      await page.goto('/?competitionId=e2e-lanes');
      await expect.poll(() => page.evaluate(() => localStorage.getItem('lastVenueCode'))).toBe('V2');
    });
  });

  test('marks the live competitions in the list with a red circle and the others with a grey one', async ({ page }) => {
    const entry = (id: string, live: boolean) => ({
      id, code: id, name: `Match ${id}`, start: '2026-10-24T10:00:00Z', allowToSendLive: true, live, venue: { code: 'V', name: 'Venue', city: 'City' },
    });
    await page.route('**/api/competitions/today', (route) => route.fulfill({ json: [entry('a', true), entry('b', false)] }));
    await page.goto('/');
    const options = page.locator('#competitionSelect option:not([disabled])');
    await expect(options.nth(0)).toContainText('🔴');
    await expect(options.nth(0)).toContainText('Match a');
    await expect(options.nth(1)).toContainText('⚪');
    await expect(options.nth(1)).toContainText('Match b');
  });

  test('asks for the competition list again when the backend hints that it changed', async ({ page, request }) => {
    await restartReplay(request, 'e2e-individual');
    const entry = (live: boolean) => ({
      id: 'e2e-individual', code: 'c', name: 'Match', start: '2026-10-24T10:00:00Z', allowToSendLive: true, live, venue: { code: 'V', name: 'Venue', city: 'City' },
    });
    let live = false;
    let requests = 0;
    await page.route('**/api/competitions/today', (route) => { requests++; return route.fulfill({ json: [entry(live)] }); });
    let toPage: { send: (message: string) => void } | undefined;
    await page.routeWebSocket(/\/ws/, (ws) => { ws.connectToServer(); toPage = ws; });
    await page.goto('/?competitionId=e2e-individual');
    const option = page.locator('#competitionSelect option:not([disabled])');
    await expect(option).toContainText('⚪');
    expect(requests).toBe(1);

    live = true;
    await expect.poll(() => toPage).toBeTruthy();
    toPage!.send(JSON.stringify({ type: 'competitions_changed' }));
    await expect(option).toContainText('🔴');
    expect(requests).toBe(2);
  });

  test('two viewers of one competition both get its data', async ({ browser, request }) => {
    await restartReplay(request, 'e2e-individual');
    const [a, b] = await Promise.all([browser.newPage(), browser.newPage()]);
    await Promise.all([a.goto('/?competitionId=e2e-individual'), b.goto('/?competitionId=e2e-individual')]);
    for (const page of [a, b]) {
      await expect(page.locator('.topbar-title')).toHaveText('E2E Individual Event');
      await expect(page.locator('.individual-competitor-card', { hasText: 'Competitor A' })).toBeVisible();
    }
    await Promise.all([a.close(), b.close()]);
  });
});

test.describe('individual race distance', () => {
  test('shows every heat and competitor, and fills in lap times as they arrive', async ({ page, request }) => {
    await restartReplay(request, 'e2e-individual');
    await page.goto('/?competitionId=e2e-individual');

    await expect(page.locator('.individual-heat-row')).toHaveCount(2);
    for (const name of ['Competitor A', 'Competitor B', 'Competitor C', 'Competitor D']) {
      await expect(page.locator('.individual-competitor-card', { hasText: name })).toBeVisible();
    }
    // category and club code sit small below the name
    await expect(page.locator('.individual-competitor-card', { hasText: 'Competitor A' }).locator('.individual-comp-meta')).toHaveText(/\S/);
    // 4 competitors x 3 laps (200 / 600 / 1000 m) once the whole replay has played
    await expect(page.locator('.individual-compact-badge')).toHaveCount(12);
    await expect(page.locator('.compact-dist').filter({ hasText: '1000m' })).toHaveCount(4);
  });

  test('cards keep their height while lap times arrive, apart from the title growing at the finish', async ({ page, request }) => {
    await restartReplay(request, 'e2e-individual');
    await page.goto('/?competitionId=e2e-individual');
    await expect(page.locator('.individual-compact-body').first()).toBeVisible();

    const heights = new Map<number, Set<string>>();
    let badges = 0;
    let sawEmpty = false;
    for (let i = 0; i < 200 && badges < 12; i++) {
      const sample = await page.evaluate(() => ({
        badges: document.querySelectorAll('.individual-compact-badge').length,
        heights: [...document.querySelectorAll('.individual-competitor-card')].map((c) => c.getBoundingClientRect().height.toFixed(1)),
      }));
      badges = sample.badges;
      sawEmpty ||= sample.badges < 12;
      sample.heights.forEach((h, c) => heights.set(c, (heights.get(c) ?? new Set<string>()).add(h)));
      await page.waitForTimeout(100);
    }
    expect(badges).toBe(12);
    expect(sawEmpty, 'the test must observe cards before all their times arrive').toBe(true);
    for (const [card, seen] of heights) {
      // arriving times never move a card; only finishing may, when the title gets its second line
      expect(seen.size, `card ${card} changed height: ${[...seen].join(' -> ')}`).toBeLessThanOrEqual(2);
    }
  });
});

test.describe('live heat', () => {
  test('each competitor still racing in the live heat has a red border; a card with a result, or a border of its own, does not', async ({ page, request }) => {
    await restartReplay(request, 'e2e-multi');
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/?competitionId=e2e-multi');
    const live = page.locator('[data-live]');
    await expect(live).toHaveCount(1);
    const cards = live.locator('.individual-competitor-card:not(.individual-lane-placeholder)');
    await expect(page.locator('.individual-card-live').first()).toBeVisible({ timeout: 20_000 });
    await expect(live).toHaveCSS('border-top-width', '0px'); // the row itself carries no border
    for (const card of await page.locator('.individual-card-live').all()) {
      await expect(card).toHaveCSS('border-top-color', 'rgb(220, 53, 69)'); // the colour fades in
    }
    const states = await cards.evaluateAll((els) => els.map((c) => ({
      live: c.classList.contains('individual-card-live'),
      border: getComputedStyle(c).borderTopColor,
      other: ['race-finished', 'individual-card-pr', 'individual-card-record', 'individual-card-red', 'individual-card-orange'].some((k) => c.classList.contains(k)),
      badge: !!c.querySelector('.individual-comp-live'),
    })));
    expect(states.some((s) => s.live)).toBe(true);
    for (const s of states) {
      expect(s.live, JSON.stringify(s)).toBe(!s.other && s.badge);
      if (s.live) expect(s.border).toBe('rgb(220, 53, 69)');
    }
    expect(await page.locator('.individual-card-live').evaluateAll((els) => els.every((c) => c.closest('[data-live]')))).toBe(true);
  });

  test('the total counts up to the new time when a lap arrives, not before', async ({ page, request }) => {
    await restartReplay(request, 'e2e-multi');
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/?competitionId=e2e-multi');
    const card = page.locator('[data-live] .individual-card-live:has(.individual-compact-badge)').first();
    const total = card.locator('.individual-compact-final .race-time');
    await expect(total).toBeVisible({ timeout: 20_000 });
    const laps = () => card.locator('.individual-compact-badge').count();
    const lapCount = await laps();
    // record every text the total takes from here on, so the count-up is seen whatever the polling moment
    await card.evaluate((c) => {
      const seen: string[] = [];
      (window as unknown as { __totals: string[] }).__totals = seen;
      const el = c.querySelector('.individual-compact-final .race-time')!;
      new MutationObserver(() => seen.push(el.textContent ?? '')).observe(el, { subtree: true, characterData: true, childList: true });
    });
    await expect.poll(laps, { timeout: 20_000 }).toBeGreaterThan(lapCount);
    await page.waitForTimeout(2000); // the snake takes 1.4s
    const seen = await page.evaluate(() => (window as unknown as { __totals: string[] }).__totals);
    // the total passes through times between the old and the new one, then settles
    expect(new Set(seen).size, seen.join(' ')).toBeGreaterThan(3);
  });
});

test.describe('snake around the newest lap', () => {
  // one fixed card: which card comes first changes as the others get their first lap
  let racer = '';
  const live = (page: Page) => page.locator('.individual-competitor-card', { hasText: racer }).first();
  const snake = (page: Page) => live(page).locator('.individual-compact-latest').evaluate((b) => getComputedStyle(b, '::after').animationName);

  test('is drawn when the lap arrives, and not again when the distance is unfolded', async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem('compactColors', 'true')); // the ring belongs to the coloured badges
    await restartReplay(request, 'e2e-multi');
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/?competitionId=e2e-multi');
    const first = page.locator('[data-live] .individual-card-live:has(.individual-compact-badge) .individual-comp-name').first();
    await expect(first).toBeVisible({ timeout: 20_000 });
    racer = ((await first.textContent()) ?? '').replace(/live/i, '').trim();
    const laps = () => live(page).locator('.individual-compact-badge').count();
    const lapCount = await laps();
    await expect.poll(laps, { timeout: 20_000 }).toBeGreaterThan(lapCount);
    await expect.poll(() => snake(page), { timeout: 2_000 }).toMatch(/snakeAround$/); // Angular scopes the keyframes name

    const header = page.locator('[data-live]').locator('xpath=ancestor::c-accordion-item').locator('.accordion-button').first();
    // fold and unfold in a quiet moment: no lap arrives meanwhile, so any snake would be one replayed by the unfolding
    for (let attempt = 0; ; attempt++) {
      const before = await laps();
      await page.waitForTimeout(1600); // the snake takes 1.4s
      await header.click();
      await header.click();
      await expect(live(page).locator('.individual-compact-latest')).toBeVisible();
      if ((await laps()) === before) break;
      expect(attempt, 'a quiet moment to unfold in').toBeLessThan(5);
    }
    expect(await snake(page)).toBe('none');
    // the ring itself is still there, in its finished state
    expect(await live(page).locator('.individual-compact-latest').evaluate((b) => getComputedStyle(b, '::after').content)).toBe('""');
  });
});

test.describe('dark mode setting', () => {
  test('follows the browser by default; On and Off override it and persist', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/?competitionId=e2e-individual');
    const theme = () => page.locator('html').getAttribute('data-coreui-theme');
    await expect.poll(theme).toBe('dark');

    await page.getByRole('button', { name: /Display\/visualization settings/ }).click();
    const select = page.getByLabel('Dark mode');
    await expect(select).toHaveValue('auto');
    await select.selectOption({ label: 'Off' });
    await expect.poll(theme).toBe('light');
    expect(await page.evaluate(() => localStorage.getItem('colorScheme'))).toBe('light');

    await page.emulateMedia({ colorScheme: 'light' });
    await select.selectOption({ label: 'On' });
    await expect.poll(theme).toBe('dark');
    await page.reload();
    await expect.poll(theme).toBe('dark');

    await page.getByRole('button', { name: /Display\/visualization settings/ }).click();
    await page.getByLabel('Dark mode').selectOption({ label: 'Browser default' });
    await expect.poll(theme).toBe('light');
  });
});

test.describe('animations setting', () => {
  test('is on by default; switched off, it persists and no snake is drawn when a lap arrives', async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem('compactColors', 'true'));
    await restartReplay(request, 'e2e-multi');
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/?competitionId=e2e-multi');
    await expect(page.locator('html')).toHaveAttribute('data-animations', 'on');

    await page.getByRole('button', { name: /Display\/visualization settings/ }).click();
    const toggle = page.getByRole('switch', { name: 'Animations' });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect(page.locator('html')).toHaveAttribute('data-animations', 'off');
    expect(await page.evaluate(() => localStorage.getItem('animations'))).toBe('false');

    const badges = () => page.locator('[data-live] .individual-card-live .individual-compact-badge').count();
    await expect.poll(badges, { timeout: 20_000 }).toBeGreaterThan(0);
    const before = await badges();
    await expect.poll(badges, { timeout: 20_000 }).toBeGreaterThan(before);
    await expect(page.locator('.individual-snake-fresh')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-animations', 'off');
  });
});

test.describe('mass start', () => {
  const names = (page: Page) => page.locator('.race-item-laps .race-name-fixed');

  test('cards show the lap times as badges with their distance above, and the total time so far', async ({ page, request }) => {
    await restartReplay(request, 'e2e-individual');
    await page.goto('/?competitionId=e2e-individual');
    await expect(page.locator('.individual-compact-body').first()).toBeVisible();
    await expect(page.locator('.individual-compact-body .individual-compact-badge').first()).toBeVisible();
    await expect(page.locator('.individual-compact-body').first()).toContainText(/\d+m/); // each badge has its distance above it

    await expect(page.locator('.individual-compact-latest').first()).toBeVisible();
    // finished cards keep this layout too, and end with the total time so far
    await expect(page.locator('.individual-compact-final').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.individual-compact-lap .compact-dist').first()).toBeVisible();
    // the distance reached so far sits above the total until the final lap is done
    await expect(page.locator('.individual-compact-final .compact-reached').first()).toBeAttached();
  });

  test('lap colours (on by default) colour the compact badges by variance against the previous lap', async ({ page, request }) => {
    await restartReplay(request, 'e2e-individual');
    await page.goto('/?competitionId=e2e-individual');
    await page.getByRole('button', { name: /^Display/ }).click(); // the settings start closed
    const toggle = page.getByRole('switch', { name: 'Lap time diff colours' });
    await expect(toggle).toBeChecked();
    await expect(page.locator('.individual-compact-badge').first()).toBeVisible({ timeout: 30000 });
    await toggle.uncheck();
    await expect(page.locator('.individual-compact-badge[class*="lap-badge-"]')).toHaveCount(0);
    await toggle.check();
    await expect(page.locator('.individual-compact-badge.lap-badge-normal').first()).toBeVisible();
    // 1000 m opens with a 200 m lap: that lap and the next have nothing fair to differ from (light grey), the third is coloured
    const lapBadge = (n: number) => page.locator(`.individual-compact-lap:nth-child(${n}) .individual-compact-badge`).first();
    await expect(lapBadge(2)).toHaveClass(/individual-compact-partial/);
    await expect(lapBadge(3)).toBeVisible({ timeout: 30000 });
    await expect(lapBadge(3)).not.toHaveClass(/individual-compact-partial/);
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

  test('several competitors can be selected at once', async ({ page, request }) => {
    await restartReplay(request, 'e2e-mass');
    await page.goto('/?competitionId=e2e-mass');
    await expect(page.locator('.race-item-laps.race-finished')).toHaveCount(4);

    const f = page.locator('.race-item-laps', { hasText: 'Competitor F' });
    const other = page.locator('.race-item-laps').filter({ hasNotText: 'Competitor F' }).first();
    await f.click();
    await other.click();
    await expect(f).toHaveClass(/race-selected/);
    await expect(other).toHaveClass(/race-selected/);
    await f.click();
    await expect(f).not.toHaveClass(/race-selected/);
    await expect(other).toHaveClass(/race-selected/);
  });
});

test('lists the competitions of today and opens the chosen one', async ({ page }) => {
  await page.goto('/?competitionId=e2e-individual');
  const select = page.getByLabel('Competitions today');
  await expect(select.locator('option')).toHaveCount(6); // the six fixture competitions; the mock's other-day and other-venue entries are filtered out
  await expect(select).toHaveValue('e2e-individual');
  await select.selectOption('e2e-mass');
  await page.waitForURL(/competitionId=e2e-mass/);
  await expect(page.getByLabel('Competitions today')).toHaveValue('e2e-mass');
});

test('the competition picker replaces the event name, venue first, start time only before the start', async ({ page }) => {
  await page.goto('/?competitionId=e2e-individual');
  const select = page.getByLabel('Competitions today');
  await expect(select).toBeVisible();
  // the event name is still the page heading, but visually hidden because the picker shows it
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('E2E Individual Event');
  await expect(page.getByRole('heading', { level: 1 })).toHaveClass(/visually-hidden/);
  const labels = await select.locator('option').allTextContents();
  const running = labels.find((l) => l.includes('E2E Individual Event'))!;
  expect(running.trim()).toMatch(/^(🔴 |⚪ )?\d{2}:\d{2}( - \d{2}:\d{2})? · E2E Individual Event \(Mock Ice Rink\)$/);
});

test('one settings panel holds the general and individual race settings and, in a mass start match, the mass start ones under their own headings', async ({ page, request }) => {
  await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-mass' } });
  await page.goto('/?competitionId=e2e-mass');
  const display = page.getByRole('button', { name: /^Display/ });
  await expect(display).toHaveAttribute('aria-expanded', 'false'); // closed on load
  await expect(page.getByRole('button', { name: /^Mass Start/ })).toHaveCount(0);
  await display.click();
  await expect(display).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('switch', { name: 'Auto-follow on updates' })).toBeVisible();
  await expect(page.locator('.settings-heading')).toHaveText(['General', 'Individual race', 'Mass start']);
});

test('without a mass start the settings panel has no mass start section', async ({ page }) => {
  await page.goto('/?competitionId=e2e-individual');
  await page.getByRole('button', { name: /^Display/ }).click();
  await expect(page.getByRole('switch', { name: 'Auto-follow on updates' })).toBeVisible();
  await expect(page.locator('.settings-heading')).toHaveText(['General', 'Individual race']);
});
