#!/usr/bin/env node
/**
 * Design parity screenshots (D-L193, D-L197).
 *
 * The screens drifted from Claude Design because nobody had seen the designs
 * rendered: the old exports could not open in a browser. This tool makes the
 * comparison mechanical, so a builder and a reviewer look at the same pairs.
 *
 *   node tools/design-parity.mjs design P04 P05     # every frame of those exports
 *   node tools/design-parity.mjs app p04 p05        # the running demo's screens (prefix match)
 *   node tools/design-parity.mjs pair <left.png> <right.png> <out.png> [LEFT,RIGHT]   # labels default DESIGN,APP
 *
 * Output goes to `.artifacts/parity/` (git-ignored):
 *   design/<P##>/NN-<section>-<label>.png, plus index.txt (file | size | section | label)
 *   app/<screen>-<width>-<light|dark>.png
 *
 * DESIGN FRAMES. Each export is a canvas of labelled frames ("Contact · 1440 ·
 * Light"). The canvas mounts a frame only while it is near the viewport, so each
 * frame is scrolled into view and awaited before its screenshot. P10 is a single
 * live prototype, captured at 1440/1024/360 in both its views.
 *
 * APP SCREENS. Needs `pnpm demo` running on http://localhost:3000 (use exactly
 * that host: 127.0.0.1 signs in but refuses every save). Signs in as DEMO_ROLE
 * (default `admin`) through P01/1 and P01/2 with the demo TOTP, then shoots each
 * screen at 1440, 1024 and 360, light and dark, full page. Add new screens to
 * SCREENS below in the PR that builds them.
 *
 * PAIRS. `pair` renders the design frame and the app screenshot side by side,
 * at the same scale, into one PNG: the before/after evidence a PR links.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { DEMO_USERS, currentStep, demoPassword, totpFor } from './demo-totp.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'tests', 'e2e', 'package.json'));
const { chromium } = require('@playwright/test');
const out = join(root, '.artifacts', 'parity');
const designRoot = join(root, 'docs', 'design');

const EXPORTS = {
  P01: 'P01/v1.0/Kasuwa Auth and Onboarding.html',
  P02: 'P02/Kasuwa Admin Console.html',
  P03: 'P03/Kasuwa Home Dashboards.html',
  P04: 'P04/Kasuwa List Views.html',
  P05: 'P05/Kasuwa Record Views.html',
  P06: 'P06/Kasuwa Deals Pipeline.html',
  P07: 'P07/Kasuwa Activities.html',
  P08: 'P08/Kasuwa Inbox.html',
  P09: 'P09/Kasuwa Voice.html',
  P10: 'P10/Kasuwa Scripting.html',
  P18: 'P18/Kasuwa Customisation Studio.html',
  P21: 'P21/Kasuwa Design System – Kasuwa Quotes & Invoicing.html',
  P26: 'P26/Kasuwa Notifications.html',
  P27: 'P27/Kasuwa Search - Command.html',
  P28: 'P28/Kasuwa Data Management.html',
};

const WIDTHS = [
  [1440, 900],
  [1024, 768],
  [360, 780],
];
const SCHEMES = ['light', 'dark'];

/** Serves docs/design on a free loopback port. The browser cannot open file:// exports reliably. */
function serveDesign() {
  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
  };
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname));
    const file = join(designRoot, path);
    if (!file.startsWith(designRoot) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () =>
      done({ server, base: `http://127.0.0.1:${server.address().port}` }),
    );
  });
}

async function captureDesign(ids) {
  const { server, base } = await serveDesign();
  const browser = await chromium.launch();
  try {
    for (const id of ids) {
      if (EXPORTS[id] === undefined)
        throw new Error(`unknown export ${id}; known: ${Object.keys(EXPORTS).join(' ')}`);
      if (!existsSync(join(designRoot, EXPORTS[id])))
        throw new Error(`missing export docs/design/${EXPORTS[id]}`);
      const dir = join(out, 'design', id);
      mkdirSync(dir, { recursive: true });
      if (id === 'P10') {
        await captureP10(browser, base, dir);
        continue;
      }
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      await page.goto(`${base}/${encodeURI(EXPORTS[id])}`, { waitUntil: 'load', timeout: 120_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1_500);
      const frames = await page.evaluate(() => {
        const label = /\b(1440|1024|768|390|360)\b[^·]*·\s*(Light|Dark)\b/;
        const labels = [...document.querySelectorAll('body *')].filter(
          (e) =>
            e.children.length === 0 &&
            e.textContent.trim().length < 80 &&
            label.test(e.textContent.trim()) &&
            (e.nextElementSibling || e.parentElement.nextElementSibling),
        );
        const boxOf = (e) => e.nextElementSibling || e.parentElement.nextElementSibling;
        labels.forEach((e, i) => boxOf(e).setAttribute('data-parity', String(i)));
        const headings = [...document.querySelectorAll('h2')].filter(
          (h) => !h.closest('[data-parity]'),
        );
        return labels.map((e, i) => {
          let section = '';
          for (const h of headings) {
            if (h.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) {
              section = h.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
            }
          }
          const box = boxOf(e).getBoundingClientRect();
          return {
            i,
            size: `${Math.round(box.width)}x${Math.round(box.height)}`,
            label: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 60),
            section,
          };
        });
      });
      const index = [];
      for (const frame of frames) {
        const slug = `${String(frame.i + 1).padStart(2, '0')}-${`${frame.section}-${frame.label}`
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 70)}`;
        try {
          const box = page.locator(`[data-parity="${frame.i}"]`);
          await box.scrollIntoViewIfNeeded();
          await page.waitForFunction(
            (i) =>
              (document.querySelector(`[data-parity="${i}"]`)?.querySelectorAll('*').length ?? 0) >
              20,
            frame.i,
            { timeout: 20_000 },
          );
          await page.waitForTimeout(700);
          await box.screenshot({ path: join(dir, `${slug}.png`), timeout: 30_000 });
          index.push(`${slug}.png | ${frame.size} | ${frame.section} | ${frame.label}`);
        } catch (error) {
          index.push(`FAILED ${slug}: ${String(error).split('\n')[0].slice(0, 100)}`);
        }
      }
      writeFileSync(join(dir, 'index.txt'), `${index.join('\n')}\n`);
      console.log(`${id}: ${index.length} frames -> ${dir}`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

async function captureP10(browser, base, dir) {
  for (const [width, height] of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`${base}/${encodeURI(EXPORTS.P10)}`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: join(dir, `agent-${width}.png`), fullPage: true });
    const builder = page.getByText('Script Builder', { exact: true }).first();
    if ((await builder.count()) > 0) {
      await builder.click();
      await page.waitForTimeout(1_000);
      await page.screenshot({ path: join(dir, `builder-${width}.png`), fullPage: true });
    }
    await page.close();
  }
  console.log(`P10: prototype views -> ${dir}`);
}

const appBase = 'http://localhost:3000';

async function signIn(page, role) {
  const user = DEMO_USERS[role];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(appBase);
    await page.locator('[data-screen="P01/1"]').waitFor({ timeout: 60_000 });
    await page.getByLabel(/workspace/i).fill(user.slug);
    await page.getByLabel(/work email/i).fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(demoPassword());
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await page.locator('[data-screen="P01/2"]').waitFor({ timeout: 60_000 });
    // A code is accepted once, so always use a step no earlier run has spent.
    const step = currentStep() + 1 + attempt;
    while (currentStep() < step) await page.waitForTimeout(1_000);
    await page.getByTestId('otp-input').getByRole('textbox').first().focus();
    await page.keyboard.type(totpFor(role, step));
    const answer = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/auth/mfa',
    );
    await page.getByTestId('mfa-submit').click();
    if ((await answer).status() === 200) {
      await page.waitForURL((url) => url.pathname !== '/verify', { timeout: 60_000 });
      return;
    }
  }
  throw new Error(`design-parity: could not sign in as ${role}`);
}

async function shoot(page, dir, name, path) {
  for (const [width, height] of WIDTHS) {
    for (const scheme of SCHEMES) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: scheme });
      try {
        if (path !== null)
          await page.goto(appBase + path, { waitUntil: 'networkidle', timeout: 60_000 });
        await page.waitForTimeout(600);
        await page.screenshot({
          path: join(dir, `${name}-${width}-${scheme}.png`),
          fullPage: true,
        });
      } catch (error) {
        console.error(`${name} ${width} ${scheme}: ${String(error).split('\n')[0]}`);
      }
    }
  }
}

async function captureApp(prefixes) {
  const role = process.env.DEMO_ROLE ?? 'admin';
  const dir = join(out, 'app');
  mkdirSync(dir, { recursive: true });
  const wanted = (name) =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const browser = await chromium.launch();
  try {
    // The designs are drawn on a Lagos desk ("All times WAT"); shoot in that zone, not the host's (T-0134).
    const desk = { timezoneId: 'Africa/Lagos' };
    const signedOut = await browser.newContext(desk);
    const anon = await signedOut.newPage();
    for (const [name, path] of [
      ['p01-signin', '/'],
      ['p01-sso', '/sso'],
      ['p01-signup', '/sign-up'],
      ['p01-signup-region', '/sign-up/region'],
      ['p01-signup-verify', '/sign-up/verify'],
    ]) {
      if (wanted(name)) await shoot(anon, dir, name, path);
    }
    if (wanted('p01-totp')) {
      const user = DEMO_USERS[role];
      await anon.goto(appBase);
      await anon.locator('[data-screen="P01/1"]').waitFor({ timeout: 60_000 });
      await anon.getByLabel(/workspace/i).fill(user.slug);
      await anon.getByLabel(/work email/i).fill(user.email);
      await anon.getByLabel('Password', { exact: true }).fill(demoPassword());
      await anon.getByRole('button', { name: /^sign in$/i }).click();
      await anon.locator('[data-screen="P01/2"]').waitFor({ timeout: 60_000 });
      await shoot(anon, dir, 'p01-totp', null);
    }
    await signedOut.close();

    const context = await browser.newContext(desk);
    const page = await context.newPage();
    await signIn(page, role);
    const get = (path) =>
      page.evaluate(
        async (target) =>
          (
            await fetch(target, {
              headers: { accept: 'application/json', 'x-requested-with': 'kasuwa-web' },
            })
          ).json(),
        path,
      );
    const ids = {};
    const needsIds = (prefix) => prefixes.length === 0 || prefixes.some((p) => p.startsWith(prefix) || prefix.startsWith(p));
    if (needsIds('p05') || needsIds('p06') || needsIds('p10')) {
      const contacts = (await get('/api/v1/contacts?q=Babatunde')).data;
      ids.contact = (
        contacts.find((row) => row.displayName === 'Babatunde Alabi') ?? contacts[0]
      )?.id;
      ids.account = (await get('/api/v1/accounts?q=Lekki')).data[0]?.id;
      const pipelines = (await get('/api/v1/pipelines')).data;
      const pipeline =
        pipelines.find((row) => row.programmeId === '11111111-0000-4000-8000-0000000c0001') ??
        pipelines[0];
      ids.pipeline = pipeline?.id;
      const deals = pipeline ? (await get(`/api/v1/pipelines/${pipeline.id}/deals`)).data : [];
      ids.deal = (
        deals.find((row) => row.name.startsWith('Kano Groundnut Traders: harvest')) ?? deals[0]
      )?.id;
      ids.script = (await get('/api/v1/scripts')).data?.find((row) =>
        row.name.startsWith('Bank X'),
      )?.id;
    }
    const programme = '11111111-0000-4000-8000-0000000c0001';
    const SCREENS = [
      ['p03-home', '/home'],
      ['p04-contacts', '/contacts'],
      ['p04-leads', '/leads'],
      ['p04-accounts', '/accounts'],
      ['p05-contact', `/contacts/${ids.contact}`],
      ['p05-account', `/accounts/${ids.account}`],
      ['p06-pipelines', '/pipelines'],
      ['p06-board', `/pipelines/${ids.pipeline}`],
      ['p06-deal', `/deals/${ids.deal}`],
      ['p07-activities', '/activities'],
      ['p10-scripts', '/scripts'],
      ['p10-builder', `/scripts/${ids.script}`],
      ['p02-admin', '/admin'],
      ['p02-programmes', '/admin/programmes'],
      ['p02-programme', `/admin/programmes/${programme}`],
      ['p02-roles', '/admin/roles'],
      ['p02-field-security', '/admin/field-security'],
      ['p02-audit', '/admin/audit'],
      ['p18-custom-fields', '/admin/custom-fields'],
      ['p18-objects', '/admin/studio'],
      ['p18-relationships', '/admin/studio/relationships'],
      ['p18-layouts', '/admin/studio/layouts'],
      ['p18-layout-builder', '/admin/studio/layouts/builder'],
      ['p18-validation', '/admin/studio/validation-rules'],
      ['p18-record-types', '/admin/studio/record-types'],
      ['p26-notifications', '/notifications'],
      ['p27-search', '/search?q=Kano'],
      ['p28-import', '/contacts/import'],
      ['p28-duplicates', '/contacts/duplicates'],
      ['p28-data-import', '/admin/data/import'],
      ['p28-data-duplicates', '/admin/data/duplicates'],
      ['p28-data-migration', '/admin/data/migration'],
      ['p28-data-exports', '/admin/data/exports'],
      ['p28-data-requests', '/admin/data/requests'],
      ['p01-onboarding', '/onboarding'],
      ['design-components-2', '/design/components-2'],
    ];
    for (const [name, path] of SCREENS) {
      if (!wanted(name) || path.includes('undefined')) continue;
      await shoot(page, dir, name, path);
      console.log(`shot ${name}`);
    }
  } finally {
    await browser.close();
  }
}

async function pair(designPng, appPng, target, labels = 'DESIGN,APP') {
  const [left, right] = labels.split(',');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 3000, height: 1000 } });
    const src = (file) => `data:image/png;base64,${readFileSync(resolve(file)).toString('base64')}`;
    await page.setContent(
      `<html><body style="margin:0;font:600 14px sans-serif;background:gray">
       <div id="w" style="display:inline-flex;gap:24px;padding:16px;align-items:flex-start">
       <figure style="margin:0"><figcaption>${left} ${basename(designPng)}</figcaption><img src="${src(designPng)}"></figure>
       <figure style="margin:0"><figcaption>${right} ${basename(appPng)}</figcaption><img src="${src(appPng)}"></figure>
       </div></body></html>`,
      { waitUntil: 'load' },
    );
    await page.locator('#w').screenshot({ path: target });
    console.log(`pair -> ${target}`);
  } finally {
    await browser.close();
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'design') await captureDesign(args.length > 0 ? args : Object.keys(EXPORTS));
else if (command === 'app') await captureApp(args);
else if (command === 'pair' && args.length >= 3) await pair(args[0], args[1], args[2], args[3]);
else {
  console.error(
    'usage: design-parity.mjs design [P##…] | app [screen-prefix…] | pair <design.png> <app.png> <out.png>',
  );
  process.exit(1);
}
