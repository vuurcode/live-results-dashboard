import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { BACKEND_PORT, MOCK_PORT, MOCK_URL, WEB_PORT } from './e2e/env';

const ci = !!process.env['CI'];
const repoRoot = path.resolve(__dirname, '..');

// Runs the whole stack: Go mockserver (replaying the committed fixtures), Go backend,
// and the Angular dev server proxying /ws to that backend.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: ci ? 1 : 0,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'go run .',
      cwd: path.join(repoRoot, 'mockserver'),
      url: `${MOCK_URL}/api/matches`,
      reuseExistingServer: !ci,
      env: {
        LISTEN_ADDR: `:${MOCK_PORT}`,
        DATA_SAMPLE_DIRECTORY: path.join(__dirname, 'e2e/fixtures/matches'),
        DATA_SAMPLE_INTERVAL: '1.5',
      },
    },
    {
      command: 'go run .',
      cwd: path.join(repoRoot, 'backend/src'),
      port: BACKEND_PORT,
      reuseExistingServer: !ci,
      env: {
        LISTEN_ADDR: `:${BACKEND_PORT}`,
        LIVE_RESULTS_BASE_URL: MOCK_URL,
        LIVE_RESULTS_INTERVAL: '0.5',
        DEFAULT_COMPETITION_ID: 'e2e-timed',
        IDLE_GRACE_SECONDS: '0.5',
      },
    },
    {
      command: `npx ng serve --port ${WEB_PORT} --proxy-config e2e/proxy.conf.json`,
      cwd: __dirname,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !ci,
      timeout: 180_000,
    },
  ],
});
