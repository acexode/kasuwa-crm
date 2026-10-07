import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  FLAGS,
  featureFlagClient,
  initialiseFeatureFlags,
  toEvaluationContext,
} from '@kasuwa/feature-flags';
import { OUTCOMES_FILE, type E2eOutcome } from '../support/e2e-outcomes-reporter';

/**
 * ACCEPTANCE — T-0042, the CRM app shell and the P04 Contacts list
 * (Agent 11, Frontend & Design System). Decisions: D-L60, D-P1, D-P13, D-L61.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `crm_records` — a registered flag, DEFAULT OFF, read on the server.
 *      `/contacts` is a real 404 without it and renders with it.
 *   2. A CRM app shell with its own nav, separate from the admin console.
 *   3. P04 frame 02 against the contract mock: the documented columns, a
 *      "name or number" search that sends `q`, filter chips that send the
 *      contract's filter parameters, a column chooser, locked columns (a lock,
 *      never an empty cell; the chooser says why), the programme chip, and
 *      next-page paging on `nextCursor` with no total and no "Page X of Y".
 *   4. Frames 05 and 06: empty, no results, loading, offline.
 *   5. 360 px: no sideways page scroll, and the filter sheet opens.
 *   6. i18n: the lint rule fires on the route, the en-XA pseudo-locale renders
 *      pseudo text on `/contacts`, and D-P1's Beta badges still appear.
 *   7. `/contacts` inside a byte budget, measured on the production build.
 *   8. No PII in the page URL: the search term stays out of the address bar.
 *
 * THE BROWSER HALF. Everything a browser must prove lives in
 * `tests/e2e/p04-contacts.spec.ts` (journeys) and
 * `tests/e2e/support/records-mock.ts` (the contract mock), both written with
 * this suite and PINNED by hash below: they are part of the acceptance
 * contract even though their directory is not protected. Their header lists
 * the DOM hooks the screen must expose and the one harness change the builder
 * makes — a `webRecordsUrl` web process, same production build, `crm_records`
 * on. The CONTACTS_BUDGET_BYTES literal is the one line the builder may
 * change, and only downwards towards the measurement (section 7).
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @p04 --reporter=list,<ours>
 *
 * spawned with `shell: false` and the arguments as an array. The T-0035 suite
 * spawns `pnpm … --grep "@a|@b"` through a shell and `cmd.exe` splits it on
 * the `|` (D-L62); a single tag with no shell metacharacter avoids that twice
 * over, because run-e2e.mjs itself forwards the arguments to Playwright through
 * a shell on Windows. Every test is read from the outcomes file our reporter
 * writes, so a skipped, `fixme`d or unmatched test never counts as a pass.
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const FLAG = 'crm_records';

const E2E_TAG = '@p04';

/** `next build` (SWC wasm on the dev host, D-L62), a container, three servers and the journeys. */
const E2E_RUN_TIMEOUT_MS = 1_800_000;

const SPEC = 'tests/e2e/p04-contacts.spec.ts';
const MOCK = 'tests/e2e/support/records-mock.ts';
const BUDGET_RECORD = 'tests/e2e/.artifacts/p04-contacts-budget.json';

/**
 * The pinned browser half (CRLF folded to LF; the budget literal normalised).
 * A change to either file is a change to the acceptance contract: the lead
 * re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: 'f15c54f9fd16516bb5bafedf1d8725022d18876f9636c3327cd413e680b2ee46',
  [MOCK]: '66f2e9548a9830e2297bbbec17d89ea672a417d29be661926bf0184a980cfd09',
};

/** See the budget test in the spec for the derivation. Never above this. */
const CONTACTS_BUDGET_CEILING = 240_000;

/** Re-pinned within 5% of what the run measured, like P01/1 (T-0035). */
const BUDGET_HEADROOM = 1.05;

const PRD_CEILING_BYTES = 300 * 1024;

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  ['@p04-flag-off', '/contacts is a 404 with crm_records at its default, and the browser cannot flip it'],
  ['@p04-flag-on', '/contacts renders with crm_records on'],
  ['@p04-shell', 'a CRM shell with its own nav, separate from admin, every link resolving'],
  ['@p04-columns', 'the documented columns, only Contact properties, axe-clean'],
  ['@p04-search', '"name or number" sends q, stays out of the URL, promises no email search'],
  ['@p04-filters', 'chips send the contract filter parameters and nothing else'],
  ['@p04-column-chooser', 'the column chooser hides and restores a column'],
  ['@p04-locked', 'a withheld field is a lock, never empty; a null is never a lock'],
  ['@p04-programme-chip', 'the programme chip, with no id and no scope sent'],
  ['@p04-paging', 'nextCursor paging, echoed exactly, no total, no "Page X of Y"'],
  ['@p04-empty', 'P04/05 empty, offering import and capture'],
  ['@p04-no-results', 'P04/05 no results, naming the search and the filters'],
  ['@p04-loading', 'P04/06 skeleton rows; a failed read is not "no contacts"'],
  ['@p04-offline', 'P04/06 offline: last synced, actions disabled'],
  ['@p04-mobile', '360 px: no sideways scroll, the filter sheet opens and filters'],
  ['@p04-pseudo', 'en-XA renders pseudo text on /contacts'],
  ['@p04-beta', 'the D-P1 Beta badges in the CRM shell language menu'],
  ['@p04-budget', '/contacts inside its byte budget on the production build'],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SourceFile {
  file: string;
  source: string;
}

function trackedFiles(directory: string): string[] {
  return execFileSync('git', ['ls-files', directory], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function webSources(): SourceFile[] {
  return trackedFiles('apps/web')
    .filter((file) => /\.(tsx?|mjs)$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => ({ file, source: readFileSync(fromRoot(file), 'utf8') }));
}

/** The App Router page for `/contacts` (a route group such as `(crm)` allowed). */
function contactsPage(): string | undefined {
  return trackedFiles('apps/web/app').find((file) =>
    /^apps\/web\/app\/(?:\([\w-]+\)\/)*contacts\/page\.tsx$/.test(file),
  );
}

/** apps/web files belonging to this slice: the route, the shell, the records client and screens. */
function sliceSources(): SourceFile[] {
  return webSources().filter(
    ({ file }) =>
      /(^|\/)(contacts|records|crm)(\/|[-.])/i.test(file.replace(/^apps\/web\//, '')) &&
      !file.includes('[id]'),
  );
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8'),
  ) as Record<string, string>;
}

const BUDGET_LITERAL = /const CONTACTS_BUDGET_BYTES = ([\d_]+);/;

function normalisedHash(file: string): string {
  const source = readFileSync(fromRoot(file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(BUDGET_LITERAL, 'const CONTACTS_BUDGET_BYTES = <budget>;');
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** Error `code`s `listContacts` can answer with, from the contract. */
function listErrorCodes(): string[] {
  const contract = parse(readFileSync(fromRoot('docs/api/records.openapi.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, { responses: Record<string, { $ref?: string }> }>>;
    components: { responses: Record<string, unknown> };
  };
  const list = contract.paths['/api/v1/contacts']?.get;
  expect(list, 'listContacts is gone from the records contract').toBeDefined();
  const codes = new Set<string>();
  for (const [status, response] of Object.entries(list?.responses ?? {})) {
    if (status.startsWith('2') || typeof response.$ref !== 'string') {
      continue;
    }
    const name = response.$ref.split('/').at(-1) ?? '';
    const body = (contract.components.responses[name] as { content?: Record<string, unknown> })?.content?.[
      'application/json'
    ] as { example?: { code?: string }; examples?: Record<string, { value?: { code?: string } }> } | undefined;
    for (const example of [body?.example, ...Object.values(body?.examples ?? {}).map((entry) => entry.value)]) {
      if (typeof example?.code === 'string') {
        codes.add(example.code);
      }
    }
  }
  return [...codes].sort();
}

/** ESLint from the workspace root, run as node with no shell. */
function eslint(args: readonly string[], input?: string): { status: number | null; output: string } {
  const require = createRequire(fromRoot('package.json'));
  const bin = resolve(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  const run = spawnSync(process.execPath, [bin, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error?.message ?? ''}` };
}

// ===========================================================================
// 1. The flag and the route
// ===========================================================================

describe('acceptance: T-0042 — crm_records exists, is off, and gates /contacts on the server', () => {
  it('registers crm_records, and it evaluates OFF by default', async () => {
    // `true` as the fallback on purpose: an unregistered flag returns the
    // fallback, so only a flag that is registered AND defaults off answers false.
    expect(Object.keys(FLAGS), `${FLAG} is not declared in FLAGS`).toContain(FLAG);
    await initialiseFeatureFlags();
    const value = await featureFlagClient().getBooleanValue(
      FLAG,
      true,
      toEvaluationContext({ tenantId: 'acceptance-probe' }),
    );
    expect(value, `${FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('is read through lib/feature-flags.ts and never by a client module; /contacts calls notFound()', () => {
    const flagModule = readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8');
    expect(flagModule, 'apps/web/lib/feature-flags.ts does not know crm_records').toContain(FLAG);
    const clientEvaluators = webSources().filter(
      ({ source }) => /^\s*['"]use client['"]/m.test(source) && source.includes(FLAG),
    );
    expect(
      clientEvaluators.map(({ file }) => file),
      'a client module names crm_records — flags are read on the server only',
    ).toEqual([]);

    const page = contactsPage();
    expect(page, 'there is no apps/web/app/**/contacts/page.tsx').toBeDefined();
    const source = withoutComments(readFileSync(fromRoot(page ?? 'missing'), 'utf8'));
    // A gated ROUTE, not a hidden link: the page itself answers 404.
    expect(source, `${page} does not call notFound()`).toMatch(/\bnotFound\s*\(/);
  });

  it('starts a crm_records web process from the production build, and leaves the default server flagless', () => {
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    expect(runner, 'run-e2e.mjs starts no web process with crm_records in KASUWA_FEATURE_FLAGS_ON').toMatch(
      /KASUWA_FEATURE_FLAGS_ON:\s*['"`][^'"`]*\bcrm_records\b/,
    );
    expect(runner, 'run-e2e.mjs does not publish webRecordsUrl in the stack file').toContain('webRecordsUrl');
    expect(runner, 'the default web server no longer forces every flag empty').toMatch(
      /KASUWA_FEATURE_FLAGS_ON:\s*''/,
    );
  });

  it('reads contacts through lib/records-api.ts: same-origin, Zod-parsed, no scope argument', () => {
    const file = fromRoot('apps/web/lib/records-api.ts');
    expect(existsSync(file), 'apps/web/lib/records-api.ts does not exist').toBe(true);
    const source = withoutComments(existsSync(file) ? readFileSync(file, 'utf8') : '');
    expect(source, 'records-api.ts does not use a relative /api/v1 path').toMatch(/['"`]\/api\/v1(\/contacts)?['"`/]/);
    expect(source, 'records-api.ts does not parse with Zod').toMatch(/from ['"]zod['"]/);
    expect(source, 'records-api.ts builds a scope argument').not.toMatch(
      /programmeIds|(set|append)\(\s*['"`]programme/,
    );
    for (const { file: name, source: code } of webSources()) {
      expect(withoutComments(code), `${name} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|records-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
  });
});

// ===========================================================================
// 2. i18n — the lint rule, the error keys, D-P1
// ===========================================================================

describe('acceptance: T-0042 — every string through i18n, and no language dropped', () => {
  it('keeps no-literal-string at error, and it fires on the /contacts route file', () => {
    const config = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(config, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );

    // A rule only ever seen passing proves nothing. Plant a literal at the
    // route's own path and watch it fail.
    const page = contactsPage();
    expect(page, 'there is no apps/web/app/**/contacts/page.tsx').toBeDefined();
    const planted = eslint(
      ['--stdin', '--stdin-filename', page ?? 'apps/web/app/contacts/page.tsx', '--format', 'json'],
      'export default function Planted() {\n  return <p>All contacts</p>;\n}\n',
    );
    expect(planted.output, `a literal JSX string at ${page} is not rejected:\n${planted.output.slice(-2000)}`).toContain(
      'i18next/no-literal-string',
    );
    expect(planted.status, 'eslint accepted a literal JSX string').not.toBe(0);
  });

  it('lints the slice clean, types no user-facing attribute, and localises every listContacts error', () => {
    const slice = sliceSources();
    const files = slice.map(({ file }) => file);
    expect(files, 'no apps/web file for the contacts slice (route, records-api, screen)').toContain(
      contactsPage() ?? 'apps/web/app/contacts/page.tsx',
    );
    expect(files).toContain('apps/web/lib/records-api.ts');

    const run = eslint(['--max-warnings', '0', ...files]);
    expect(run.status, `eslint fails on the contacts slice:\n${run.output.slice(-4000)}`).toBe(0);

    // jsx-text-only cannot see attributes; an English aria-label is still English.
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of slice.filter(({ file: name }) => name.endsWith('.tsx'))) {
      expect(source.match(attribute) ?? [], `${file} types user-facing text into an attribute`).toEqual([]);
    }

    // T-0039: the web app localises records errors as records.error.<code>.
    const en = catalogue('en');
    const codes = listErrorCodes();
    expect(codes.length, 'listContacts declares no error codes').toBeGreaterThan(0);
    const missing = codes.filter((code) => en[`records.error.${code}`] === undefined);
    expect(missing, 'en.json lacks records.error.<code> for these listContacts errors').toEqual([]);
  });

  it('drops no design-menu language from the menu (D-P1)', async () => {
    // New English keys make every draft catalogue incomplete, and an incomplete
    // language silently leaves MENU_LOCALES — taking its Beta badge with it.
    // The browser test counts badges against BETA_LOCALES, which would shrink
    // in step and pass; this is the check that cannot.
    const i18n: { DESIGN_MENU_LOCALES: readonly string[]; MENU_LOCALES: readonly string[] } = await import(
      fromRoot('packages/i18n/src/index.ts')
    );
    expect(i18n.DESIGN_MENU_LOCALES.length).toBeGreaterThan(1);
    const dropped = i18n.DESIGN_MENU_LOCALES.filter((locale) => !i18n.MENU_LOCALES.includes(locale));
    expect(dropped, 'these languages fell off the menu — translate the new keys in every catalogue').toEqual([]);
  });
});

// ===========================================================================
// 3. The browser half is the one written with this suite
// ===========================================================================

describe('acceptance: T-0042 — the journeys and the mock are the ones this suite was written with', () => {
  it('pins p04-contacts.spec.ts and records-mock.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(
        normalisedHash(file),
        `${file} changed. It is part of the T-0042 acceptance contract: ask the lead to re-pin it ` +
          '(only CONTACTS_BUDGET_BYTES may move without that).',
      ).toBe(pinned);
    }
    const mock = readFileSync(fromRoot(MOCK), 'utf8');
    expect(mock, 'the mock no longer reads the records contract').toContain('docs/api/records.openapi.yaml');
  });
});

// ===========================================================================
// 4. The browser — one run of @p04
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
  startedAt: number;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0042 e2e run did not start', outcomes: undefined, startedAt: 0 };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(
    e2eRun.outcomes,
    `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`,
  ).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0042 — the contacts list in a browser', () => {
  beforeAll(() => {
    rmSync(OUTCOMES_FILE, { force: true });
    rmSync(fromRoot(BUDGET_RECORD), { force: true });

    // Relative to tests/e2e, where run-e2e.mjs starts Playwright.
    const reporter = relative(
      fromRoot('tests', 'e2e'),
      fromRoot('tests', 'acceptance', 'support', 'e2e-outcomes-reporter.ts'),
    ).replace(/\\/g, '/');

    const startedAt = Date.now();
    const run = spawnSync(
      process.execPath,
      // `--grep` is a regex, so `@p04` also selects T-0057's `@p04-accounts…`
      // journeys, which the Accounts suite runs and judges itself. Excluding
      // them keeps this run about the Contacts screen. No shell metacharacter
      // in either pattern (D-L62).
      [
        fromRoot('tests', 'e2e', 'scripts', 'run-e2e.mjs'),
        '--grep',
        E2E_TAG,
        '--grep-invert',
        '@p04-accounts',
        `--reporter=list,${reporter}`,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        timeout: E2E_RUN_TIMEOUT_MS,
        // A production build plus a Playwright list reporter overflows the
        // 1 MB default, and an overflow kills the child mid-run.
        maxBuffer: 256 * 1024 * 1024,
      },
    );

    e2eRun = {
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error === undefined ? '' : `\n[spawn] ${run.error.message}`}`,
      outcomes: existsSync(OUTCOMES_FILE)
        ? (JSON.parse(readFileSync(OUTCOMES_FILE, 'utf8')) as E2eOutcome[])
        : undefined,
      startedAt,
    };
  }, E2E_RUN_TIMEOUT_MS);

  it('runs every @p04 journey, and every one passes', () => {
    const p04 = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0.
    expect(p04.length, 'the run reported fewer @p04 tests than there are behaviours').toBeGreaterThanOrEqual(
      REQUIRED.length,
    );
    const failing = p04.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@p04 tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter(
        (outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag),
      );
      expect(proving.length, `no PASSING @p04 test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('pins /contacts at or under 240,000 bytes and within 5% of what this run measured', () => {
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    const literal = BUDGET_LITERAL.exec(spec);
    expect(literal, 'CONTACTS_BUDGET_BYTES is not where it was').not.toBeNull();
    const budget = Number((literal?.[1] ?? '0').replace(/_/g, ''));
    expect(budget, 'the /contacts budget is above its ceiling').toBeLessThanOrEqual(CONTACTS_BUDGET_CEILING);
    expect(budget).toBeLessThan(PRD_CEILING_BYTES);

    const record = fromRoot(BUDGET_RECORD);
    expect(existsSync(record), 'the budget test wrote no measurement').toBe(true);
    expect(statSync(record).mtimeMs, 'the measurement is older than this run').toBeGreaterThanOrEqual(
      e2eRun.startedAt,
    );
    const measured = (JSON.parse(readFileSync(record, 'utf8')) as { transferredBytes: number }).transferredBytes;
    expect(measured, 'the measurement is empty').toBeGreaterThan(0);
    expect(budget, `the budget is under the ${measured} bytes measured`).toBeGreaterThanOrEqual(measured);
    expect(
      budget,
      `the budget is more than 5% over the ${measured} bytes measured — re-pin CONTACTS_BUDGET_BYTES`,
    ).toBeLessThanOrEqual(Math.round(measured * BUDGET_HEADROOM));
  });
});
