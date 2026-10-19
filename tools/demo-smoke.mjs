#!/usr/bin/env node
/**
 * DEMO ONLY: a pre-flight walk of every demo screen in a real (headless)
 * browser, through the demo proxy, as each demo role.
 *
 * For each screen it records the HTTP status, the heading, any failed
 * `/api/v1` call and any console error, and saves a screenshot to
 * demo/screenshots/ (git-ignored). Run it the morning of a demo, after
 * `pnpm demo`, to know before the audience does if something is off.
 *
 *   node tools/demo-smoke.mjs                 # http://localhost:3100
 *   DEMO_URL=http://localhost:3100 node tools/demo-smoke.mjs
 *
 * Uses the Playwright already installed for tests/e2e; adds no dependency.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'tests', 'e2e', 'package.json'));
const { chromium } = require('@playwright/test');

const base = new URL(process.env.DEMO_URL ?? 'http://localhost:3100');
const apiBase = new URL(process.env.DEMO_API_URL ?? 'http://127.0.0.1:3001');
if (
  !['127.0.0.1', 'localhost'].includes(base.hostname) ||
  !['127.0.0.1', 'localhost'].includes(apiBase.hostname)
) {
  console.error('demo-smoke: local only.');
  process.exit(1);
}
const shots = join(root, 'demo', 'screenshots');
mkdirSync(shots, { recursive: true });

const ADMIN = {
  tenantId: '11111111-0000-4000-8000-000000000001',
  userId: '11111111-0000-4000-8000-0000000d0003',
};
async function apiGet(path) {
  const response = await fetch(new URL(path, apiBase), {
    headers: { 'x-kasuwa-tenant-id': ADMIN.tenantId, 'x-kasuwa-user-id': ADMIN.userId },
  });
  return response.json();
}

// Ids for the record screens, read as the admin.
const contacts = (await apiGet('/api/v1/contacts?q=Babatunde')).data;
const contact = contacts.find((row) => row.displayName === 'Babatunde Alabi') ?? contacts[0];
const account = (await apiGet('/api/v1/accounts?q=Lekki')).data[0];
const pipelines = (await apiGet('/api/v1/pipelines')).data;
const pipeline = pipelines.find(
  (row) => row.programmeId === '11111111-0000-4000-8000-0000000c0001',
);
const deals = (await apiGet(`/api/v1/pipelines/${pipeline.id}/deals`)).data;
const deal =
  deals.find((row) => row.name.startsWith('Kano Groundnut Traders: harvest')) ?? deals[0];
const script = (await apiGet('/api/v1/scripts')).data.find((row) => row.name.startsWith('Bank X'));
const programmeId = '11111111-0000-4000-8000-0000000c0001';

const SCREENS = [
  ['contacts', '/contacts'],
  ['contact-360', `/contacts/${contact.id}`],
  ['leads', '/leads'],
  ['accounts', '/accounts'],
  ['account-record', `/accounts/${account.id}`],
  ['activities', '/activities'],
  ['pipelines', '/pipelines'],
  ['pipeline-board', `/pipelines/${pipeline.id}`],
  ['deal', `/deals/${deal.id}`],
  ['search', '/search?q=Kano'],
  ['scripts', '/scripts'],
  ['script-builder', `/scripts/${script.id}`],
  ['admin-home', '/admin'],
  ['admin-programmes', '/admin/programmes'],
  ['admin-programme', `/admin/programmes/${programmeId}`],
  ['admin-roles', '/admin/roles'],
  ['admin-field-security', '/admin/field-security'],
  ['admin-custom-fields', '/admin/custom-fields'],
  ['admin-audit', '/admin/audit'],
];

const ROLES = (process.env.DEMO_ROLES ?? 'admin,agent,unassigned').split(',');

const browser = await chromium.launch();
const results = [];
try {
  for (const role of ROLES) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(new URL(`/__demo/as/${role}`, base).toString());
    for (const [name, path] of SCREENS) {
      const failures = [];
      const errors = [];
      const onResponse = (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/api/v1/') && response.status() >= 400) {
          failures.push(`${response.status()} ${url.pathname.replace(/[0-9a-f-]{36}/g, ':id')}`);
        }
      };
      const onConsole = (message) => {
        if (message.type() === 'error') errors.push(message.text().slice(0, 120));
      };
      page.on('response', onResponse);
      page.on('console', onConsole);
      let status = 0;
      try {
        const response = await page.goto(new URL(path, base).toString(), {
          waitUntil: 'networkidle',
          timeout: 60_000,
        });
        status = response?.status() ?? 0;
      } catch (error) {
        errors.push(String(error).slice(0, 120));
      }
      await page.waitForTimeout(500);
      const heading =
        (
          await page
            .locator('h1')
            .first()
            .textContent({ timeout: 2_000 })
            .catch(() => null)
        )?.trim() ?? '';
      await page.screenshot({ path: join(shots, `${role}-${name}.png`), fullPage: false });
      page.off('response', onResponse);
      page.off('console', onConsole);
      results.push({
        role,
        name,
        status,
        heading: heading.slice(0, 40),
        api: [...new Set(failures)].join(' '),
        console: errors.length,
      });
    }
    await context.close();
  }
} finally {
  await browser.close();
}

const pad = (text, width) => String(text).padEnd(width).slice(0, width);
console.log(
  `${pad('role', 11)}${pad('screen', 22)}${pad('http', 6)}${pad('heading', 42)}${pad('console', 9)}failed api calls`,
);
for (const row of results) {
  console.log(
    `${pad(row.role, 11)}${pad(row.name, 22)}${pad(row.status, 6)}${pad(row.heading, 42)}${pad(row.console, 9)}${row.api}`,
  );
}
console.log(`\nscreenshots: ${shots}`);
