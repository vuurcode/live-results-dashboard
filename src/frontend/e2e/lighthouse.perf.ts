import fs from 'node:fs';
import path from 'node:path';
import { chromium, test } from '@playwright/test';
import { MOCK_URL, WEB_PORT } from './env';

// Load performance with Lighthouse (`npm run lighthouse`), against the production build with the replay mockserver on
// localhost, so the data source adds no delay. Lighthouse itself simulates a slow phone (mobile) or a desktop. It reports and
// saves the full HTML report in test-results/; it asserts nothing, because the scores vary from machine to machine.
const DEBUG_PORT = 9333;
const URL = `http://localhost:${WEB_PORT}/?competitionId=e2e-timed`;

for (const formFactor of ['mobile', 'desktop'] as const) {
  test(`lighthouse ${formFactor}`, async ({ request }) => {
    test.setTimeout(180_000);
    await request.post(`${MOCK_URL}/api/reset`, { params: { competitionId: 'e2e-timed' } });
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${DEBUG_PORT}`] });
    try {
      const { default: lighthouse } = await import('lighthouse');
      const desktop = formFactor === 'desktop' ? (await import('lighthouse/core/config/desktop-config.js')).default : undefined;
      const result = await lighthouse(URL, { port: DEBUG_PORT, output: 'html', logLevel: 'error' }, desktop);
      if (!result) throw new Error('no result');
      const { lhr, report } = result;
      const dir = path.join('test-results', 'lighthouse');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${formFactor}.html`), String(report));

      const audit = (id: string) => lhr.audits[id]?.displayValue ?? '-';
      console.log(`lighthouse ${formFactor}`, {
        performance: Math.round((lhr.categories['performance']?.score ?? 0) * 100),
        accessibility: Math.round((lhr.categories['accessibility']?.score ?? 0) * 100),
        bestPractices: Math.round((lhr.categories['best-practices']?.score ?? 0) * 100),
        FCP: audit('first-contentful-paint'),
        LCP: audit('largest-contentful-paint'),
        TBT: audit('total-blocking-time'),
        CLS: audit('cumulative-layout-shift'),
        speedIndex: audit('speed-index'),
        transferred: audit('total-byte-weight'),
        report: path.join(dir, `${formFactor}.html`),
      });
    } finally {
      await browser.close();
    }
  });
}
