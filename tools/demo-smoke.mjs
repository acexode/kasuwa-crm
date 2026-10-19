#!/usr/bin/env node
/**
 * DEMO ONLY: a pre-flight walk of every demo screen in a real (headless)
 * browser, signed in for real (password, then a TOTP code) as each demo role.
 *
 * For each screen it records the HTTP status, the heading, any failed
 * `/api/v1` call and any console error, and saves a screenshot to
 * demo/screenshots/ (git-ignored). Run it the morning of a demo, after
 * `pnpm demo`, to know before the audience does if something is off.
 *
 *   node tools/demo-smoke.mjs                 # http://localhost:3000
 *   DEMO_URL=http://localhost:3000 node tools/demo-smoke.mjs
 *
 * It goes through the web app's own BFF exactly as a presenter's browser does
 * (ADR-0019): no identity header, no side door. Each role signs in once, so
 * that person's current TOTP code is then spent: a presenter signing the same
 * person in straight afterwards waits for the next code (30 s).
 *
 * Uses the Playwright already installed for tests/e2e; adds no dependency.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { DEMO_USERS, currentStep, demoPassword, totpFor } from './demo-totp.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'tests', 'e2e', 'package.json'));
const { chromium } = require('@playwright/test');

const base = new URL(process.env.DEMO_URL ?? 'http://localhost:3000');
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) {
  console.error('demo-smoke: local only.');
  process.exit(1);
}
const shots = join(root, 'demo', 'screenshots');
mkdirSync(shots, { recursive: true });

/** Signs `role` in through P01/1 and P01/2. Retries once on the next TOTP step if this one is spent. */
async function signIn(page, role) {
  const user = DEMO_USERS[role];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(base.toString());
    await page.locator('[data-screen="P01/1"]').waitFor({ timeout: 60_000 });
    await page.getByLabel(/workspace/i).fill(user.slug);
    await page.getByLabel(/work email/i).fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(demoPassword());
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.locator('[data-screen="P01/2"]').waitFor({ timeout: 60_000 });
    const step = currentStep() + attempt;
    while (currentStep() < step) await page.waitForTimeout(1_000);
    const boxes = page.getByTestId('otp-input').getByRole('textbox');
    await boxes.first().focus();
    await page.keyboard.type(totpFor(role, step));
    const answer = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/mfa');
    await page.getByTestId('mfa-submit').click();
    if ((await answer).status() === 200) {
      await page.waitForURL((url) => url.pathname !== '/verify', { timeout: 60_000 });
      return;
    }
  }
  throw new Error(`demo-smoke: could not sign in as ${role}`);
}

/** A read through the BFF, from inside the signed-in page, as the app itself makes it. */
async function apiGet(page, path) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { headers: { accept: 'application/json', 'x-requested-with': 'kasuwa-web' } });
    return response.json();
  }, path);
}

const browser = await chromium.launch();

// Ids for the record screens, read as the admin.
const lookup = await browser.newContext();
const lookupPage = await lookup.newPage();
await signIn(lookupPage, 'admin');
const contacts = (await apiGet(lookupPage, '/api/v1/contacts?q=Babatunde')).data;
const contact = contacts.find((row) => row.displayName === 'Babatunde Alabi') ?? contacts[0];
const account = (await apiGet(lookupPage, '/api/v1/accounts?q=Lekki')).data[0];
const pipelines = (await apiGet(lookupPage, '/api/v1/pipelines')).data;
const pipeline = pipelines.find((row) => row.programmeId === '11111111-0000-4000-8000-0000000c0001');
const deals = (await apiGet(lookupPage, `/api/v1/pipelines/${pipeline.id}/deals`)).data;
const deal = deals.find((row) => row.name.startsWith('Kano Groundnut Traders: harvest')) ?? deals[0];
const script = (await apiGet(lookupPage, '/api/v1/scripts')).data.find((row) => row.name.startsWith('Bank X'));
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

const results = [];
try {
  for (const role of ROLES) {
    // The admin is already signed in (the id lookup); each other role signs in
    // once, in its own browser context: one session per profile (ADR-0019).
    const context = role === 'admin' ? lookup : await browser.newContext();
    const page = role === 'admin' ? lookupPage : await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    if (role !== 'admin') {
      try {
        await signIn(page, role);
      } catch (error) {
        results.push({ role, name: '(sign-in)', status: 0, heading: 'sign-in failed', api: '', console: 0 });
        console.error(`demo-smoke: ${role}: ${String(error).split('\n')[0]}`);
        await context.close();
        continue;
      }
    }
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
