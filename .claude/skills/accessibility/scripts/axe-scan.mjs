#!/usr/bin/env node
// Scans pages of the dashboard with axe-core (WCAG 2.0/2.1/2.2 A and AA rules) in headless Chromium.
//
//   cd frontend && node ../.claude/skills/accessibility/scripts/axe-scan.mjs [--wait 8000] [--all] [url ...]
//
//   --all       list every affected element with axe's message (default: first three per rule)
//   --summary   group colour-contrast failures by element class and colour pair (best for large pages)
//
// Needs a running stack. The e2e stack serves the committed fixture matches on port 14200:
//   cd frontend && npm run e2e        (starts it, runs the tests, stops it)
// or keep it up for scanning by starting the three servers from playwright.config.ts yourself.
// With no urls it scans the timed and mass-start fixture matches on the e2e stack.
//
// Exit code 1 when any serious or critical violation is found, so it can gate CI.
import { createRequire } from 'node:module';
import path from 'node:path';

// Resolve packages from the frontend project (the current directory), not from this script's folder.
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { chromium } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');

const args = process.argv.slice(2);
let waitMs = 8000;
let showAll = false;
let summary = false;
const offenders = new Map(); // `${class} ${fg} on ${bg}` -> { count, ratio, size, weight }
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wait') waitMs = Number(args[++i]);
  else if (args[i] === '--all') showAll = true;
  else if (args[i] === '--summary') summary = true;
  else urls.push(args[i]);
}
if (urls.length === 0) {
  urls.push(
    'http://localhost:14200/?competitionId=e2e-timed',
    'http://localhost:14200/?competitionId=e2e-mass',
  );
}

const browser = await chromium.launch();
let blocking = 0;

for (const url of urls) {
  // AxeBuilder needs a page that belongs to an explicit context (browser.newPage() is not enough).
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(url);
  // Let the replay run so pending, in-progress and finished states are all on screen.
  await page.waitForTimeout(waitMs);
  // Open every collapsed accordion: axe only checks what is rendered.
  for (const button of await page.$$('button.accordion-button.collapsed')) {
    await button.click().catch(() => {});
  }
  await page.waitForTimeout(500);

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();

  console.log(`\n${url}\n${'-'.repeat(url.length)}`);
  if (violations.length === 0) console.log('no violations');
  for (const v of violations) {
    if (summary && v.id === 'color-contrast') {
      for (const node of v.nodes) {
        const d = node.any[0]?.data ?? {};
        const last = node.target.at(-1).split('>').at(-1).trim();
        const key = `${last}  ${d.fgColor} on ${d.bgColor}`;
        const entry = offenders.get(key) ?? { count: 0, ratio: d.contrastRatio, size: d.fontSize, weight: d.fontWeight };
        entry.count++;
        offenders.set(key, entry);
      }
      if (v.impact === 'serious' || v.impact === 'critical') blocking += v.nodes.length;
      continue;
    }
    if (v.impact === 'serious' || v.impact === 'critical') blocking += v.nodes.length;
    console.log(`[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'})`);
    for (const node of showAll ? v.nodes : v.nodes.slice(0, 3)) {
      console.log(`    ${node.target.join(' ')}`);
      if (node.any[0]?.message) console.log(`      ${node.any[0].message}`);
    }
    if (!showAll && v.nodes.length > 3) console.log(`    ... and ${v.nodes.length - 3} more (use --all)`);
    console.log(`    ${v.helpUrl}`);
  }
  await context.close();
}

if (summary && offenders.size > 0) {
  console.log('\ncolor-contrast offenders (class, colours, ratio, count) - worst first');
  [...offenders].sort((a, b) => a[1].ratio - b[1].ratio).forEach(([key, e]) =>
    console.log(`  ${String(e.ratio).padStart(5)}:1  x${String(e.count).padEnd(3)} ${key}  (${e.size}, ${e.weight})`));
}

await browser.close();
process.exit(blocking > 0 ? 1 : 0);
