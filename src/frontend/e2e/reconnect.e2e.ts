import { expect, test } from '@playwright/test';

test.describe('Reconnecting', () => {
  test('a dropped connection resumes from the last message instead of replaying the competition', async ({ page }) => {
    const urls: string[] = [];
    const received: string[][] = [];
    let drop: (() => void) | undefined;
    await page.routeWebSocket(/\/ws/, (ws) => {
      urls.push(ws.url());
      const types: string[] = [];
      received.push(types);
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        types.push((JSON.parse(String(m)) as { type: string }).type);
        ws.send(m);
      });
      drop = () => void ws.close();
    });
    await page.goto('/?competitionId=e2e-individual');
    await expect(page.locator('.individual-competitor-card').first()).toBeVisible();
    expect(received[0]).toContain('distance_meta');

    // another follower keeps the room open, as the room is closed once nobody follows it
    const other = await page.context().newPage();
    await other.goto('/?competitionId=e2e-individual');
    await expect(other.locator('.individual-competitor-card').first()).toBeVisible();

    drop?.();
    await expect.poll(() => urls.length, { timeout: 10_000 }).toBe(2);
    const resumed = new URL(urls[1]);
    expect(resumed.searchParams.get('epoch')).toBeTruthy();
    expect(Number(resumed.searchParams.get('lastSeq'))).toBeGreaterThan(0);
    await expect.poll(() => received[1].length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(received[1]).not.toContain('distance_meta');
    expect(received[1]).not.toContain('event_name');
    expect(received[1].length).toBeLessThan(received[0].length); // only the updates that came meanwhile
    await expect(page.locator('.individual-competitor-card').first()).toBeVisible();
  });
});
