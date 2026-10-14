import { defineConfig } from '@playwright/test';
import base from './playwright.config';
import { WEB_PORT } from './e2e/env';

// Runtime performance checks, run on demand (`npm run perf`) and not as part of the e2e suite: timings are noisy on shared runners.
// The Angular server runs the production configuration so the numbers reflect the shipped bundle.
export default defineConfig({
  ...base,
  testMatch: '**/*.perf.ts',
  reporter: 'list',
  retries: 0,
  webServer: (base.webServer as { command: string }[]).map((s) =>
    s.command.startsWith('npx ng serve') ? { ...s, command: `${s.command} --configuration production` } : s,
  ),
  use: { ...base.use, baseURL: `http://localhost:${WEB_PORT}` },
});
