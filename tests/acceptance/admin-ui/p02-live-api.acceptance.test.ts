import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SEED_TENANTS } from '@kasuwa/db';
import {
  FLAGS,
  assertFlagsAreProductionSafe,
  featureFlagClient,
  initialiseFeatureFlags,
  toEvaluationContext,
} from '@kasuwa/feature-flags';
import { OUTCOMES_FILE, type E2eOutcome } from '../support/e2e-outcomes-reporter';

/**
 * ACCEPTANCE — T-0035, the P02 admin console on the real API, plus the copy
 * and font decisions that were waiting on it (Agent 11, Frontend & Design
 * System).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. `admin_live_api` — a registered flag, DEFAULT OFF, and NOT
 *      production-ready. With it on, the twenty-two P02 screens answer from
 *      the real admin API against the seeded database. KPIs and skill cover
 *      stay on sample data, and say so on the screen.
 *   2. D-P11 — the sign-up region screen no longer tells anyone to "choose
 *      Nigeria"; it says Nigerian residency is set up with sales.
 *   3. D-P1  — every language on the menu ships; the ones no named reviewer
 *      has signed off carry a Beta badge.
 *   4. D-L43 — self-hosted fonts only. No `fonts.gstatic.com` fallback.
 *   5. D-L44 — the naira and cedi signs come from a small subset, not from
 *      the 168 KB Noto Sans Latin-Extended file.
 *   6. Every route inside its byte budget, and the P01 budget re-pinned.
 *
 * THE E2E CONTRACT. Everything below that needs a browser is read from one run
 * per tag (see E2E_TAGS for why it is not one run of a `|` pattern) of
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep <tag>
 *
 * for each of @p02, @locale-beta, @fonts, @budget and @byte-budget, with no
 * shell, through the reporter this suite owns (`support/e2e-outcomes-reporter.ts`),
 * so a test that was skipped, `fixme`d or never matched the grep does not
 * count as a pass. Note that the `@p02` pattern also matches `@p02-live`.
 *
 *   a. `@p02-live` — the P02 screens against a web process started with
 *      `admin_live_api` ON in its ENVIRONMENT (named in
 *      `KASUWA_FEATURE_FLAGS_ON` by `tests/e2e/scripts/run-e2e.mjs`; nothing a
 *      browser sends may turn it on). Each of the twenty-two screen ids is
 *      cited in the title (or describe) of a passing `@p02-live` test, exactly
 *      as `p02-admin.spec.ts` cites them today.
 *   b. A spec file that holds `@p02-live` tests installs NO interception of
 *      the admin API: no `installAdminMock`, no import of `admin-mock`, no
 *      `.route(` and no `routeFromHAR`. It imports from `@kasuwa/db` and
 *      asserts seeded data — a programme, a user, a role — which the
 *      contract's examples do not contain, so a passing test is evidence the
 *      request reached the API and the database.
 *   c. KPIs (`P02/B2`) and skill cover (`P02/B3`) come from sample data inside
 *      apps/web, never from a test mock, and render inside an element marked
 *      `data-source="mock"` carrying a visible, translated label. A passing
 *      `@p02-live` test tagged `@mock-labelled` cites each of the two screens.
 *   d. `@locale-beta` — the language menu, one passing test per locale on the
 *      design's menu, whose title cites `locale=<tag>`. Unreviewed locales
 *      render the Beta badge; reviewed and source locales do not. The spec
 *      reads review status from `packages/i18n` rather than a list of its own.
 *   e. `@fonts` — passing tests citing `/onboarding` and `/admin` that
 *      capture the critical path and assert no font request leaves the page's
 *      origin and `noto-sans-latin-ext` is not requested before first paint.
 *   f. Budgets — a passing byte-budget test for each route in `BUDGETED`
 *      below, the path cited in its title. `/onboarding` is new; tag it
 *      `@budget` (or `@fonts`) so the grep above reaches it.
 *   g. The whole run exits 0, so the existing mocked `@p02` suite, which runs
 *      with the flag at its default, stays green.
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const LIVE_FLAG = 'admin_live_api';

/**
 * One run per tag, spawned with no shell (D-L62, HANDOFF 2026-10-06 item 6).
 * This suite once ran `pnpm test:e2e --grep "@p02|@locale-beta|…"` through a
 * shell, and `cmd.exe` split the pattern on `|`, so on Windows it never reached
 * Playwright. run-e2e.mjs forwards its arguments through a shell on Windows as
 * well, so a single tag with no shell metacharacter is the portable form, as
 * the T-0042 wrapper does it. `@p02` also selects `@p02-live`.
 */
const E2E_TAGS = ['@p02', '@locale-beta', '@fonts', '@budget', '@byte-budget'] as const;
const E2E_GREP = E2E_TAGS.join(', ');

/** Per run: each one builds the web app afresh. */
const E2E_RUN_TIMEOUT_MS = 1_200_000;

/** The twenty-two screens on the P02 index board, as `p02-admin.spec.ts` lists them. */
const P02_SCREENS = [
  'P02/A',
  'P02/A1',
  'P02/B',
  'P02/B1',
  'P02/B2',
  'P02/B3',
  'P02/B4',
  'P02/B5',
  'P02/B6',
  'P02/B7',
  'P02/B8',
  'P02/B9',
  'P02/C',
  'P02/C1',
  'P02/C2',
  'P02/C3',
  'P02/D',
  'P02/D1',
  'P02/D2',
  'P02/E',
  'P02/E1',
  'P02/E2',
] as const;

/** The two operations the task keeps on the mock (T-0035 goal). */
const STILL_MOCKED = ['getProgrammeKpis', 'getProgrammeSkillCover'] as const;

/**
 * Every route whose weight is held to a budget by this task. The admin routes
 * are the six `p02-admin.spec.ts` already measures; `/onboarding` is the route
 * D-L44 put over the ceiling with one currency sign.
 */
const BUDGETED = [
  '/onboarding',
  '/admin',
  '/admin/programmes',
  '/admin/roles',
  '/admin/field-security',
  '/admin/audit',
  '?tab=scripts',
] as const;

/** The two routes D-L44 names: neither may pay for Latin-Extended to show a ₦. */
const FONT_ROUTES = ['/onboarding', '/admin'] as const;

/** ₦ (naira) and ₵ (cedi). */
const CURRENCY_CODE_POINTS = [0x20a6, 0x20b5] as const;

/** A currency subset is a handful of glyphs; the file it replaces is 167,960 bytes. */
const CURRENCY_SUBSET_MAX_BYTES = 20_480;

/** P01/1 last measured 240,015 bytes (DECISIONS.md D-L43 note). Re-pinned within 5%. */
const P01_SIGN_IN_MEASURED = 240_015;
const P01_SIGN_IN_OLD_BUDGET = 270_336;

const PRD_CEILING_BYTES = 300 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SourceFile {
  file: string;
  source: string;
}

function trackedSources(directory: string, pattern: RegExp): SourceFile[] {
  return execFileSync('git', ['ls-files', directory], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((file) => pattern.test(file))
    .map((file) => ({ file, source: readFileSync(fromRoot(file), 'utf8') }));
}

/** apps/web application code — tests excluded, they may quote anything. */
function webSources(): SourceFile[] {
  return trackedSources('apps/web', /\.(tsx?|mjs)$/).filter(
    ({ file }) => !/\.test\.tsx?$/.test(file),
  );
}

function specSources(): SourceFile[] {
  return trackedSources('tests/e2e', /\.spec\.ts$/);
}

/** Source with comments removed; a comment that names a thing is not the thing. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `P02/B` must not match `P02/B1`. */
function citesScreen(text: string, screen: string): boolean {
  return new RegExp(`${escapeRegExp(screen)}(?!\\w|\\.\\d)`).test(text);
}

/** `/admin` must not match `/admin/roles`. */
function citesPath(text: string, path: string): boolean {
  return new RegExp(`${escapeRegExp(path)}(?![\\w/-])`).test(text);
}

function catalogue(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.json`), 'utf8'),
  ) as Record<string, string>;
}

function catalogues(): { file: string; messages: Record<string, string> }[] {
  return trackedSources('packages/i18n/src/locales', /\/[\w-]+\.json$/)
    .filter(({ file }) => !/\.(review|passthrough)\.json$/.test(file))
    .map(({ file, source }) => ({ file, messages: JSON.parse(source) as Record<string, string> }));
}

function reviewStatus(locale: string): string {
  const review = JSON.parse(
    readFileSync(fromRoot('packages/i18n/src/locales', `${locale}.review.json`), 'utf8'),
  ) as { status?: unknown };
  return typeof review.status === 'string' ? review.status : 'missing';
}

/** Signed off by a named reviewer, or the source language itself. */
function isAttested(locale: string): boolean {
  return ['reviewed', 'source'].includes(reviewStatus(locale));
}

interface ContractOperation {
  operationId?: string;
  tags?: unknown;
  'x-kasuwa-implemented'?: unknown;
}

// T-0088 (D-L139): the custom-field definitions belong to the P18 studio
// (T-0090), not to the P02 console, and stay unbuilt until T-0089. The check
// below is about the console, so it leaves exactly this tag out.
const NOT_THE_CONSOLE_TAGS = ['custom-fields'] as const;

function isConsoleOperation(operation: ContractOperation): boolean {
  const tags = Array.isArray(operation.tags) ? operation.tags : [];
  return !tags.some((tag) => (NOT_THE_CONSOLE_TAGS as readonly unknown[]).includes(tag));
}

function contractOperations(): ContractOperation[] {
  const document = parse(readFileSync(fromRoot('docs/api/admin.openapi.yaml'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const operations: ContractOperation[] = [];
  for (const item of Object.values(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
        operations.push(operation as ContractOperation);
      }
    }
  }
  return operations;
}

/** Parse a CSS `unicode-range` into inclusive [start, end] pairs. */
function parseUnicodeRange(value: string): [number, number][] {
  return value
    .split(',')
    .map((part) => part.trim().replace(/^U\+/i, ''))
    .filter((part) => part.length > 0)
    .map((part): [number, number] => {
      if (part.includes('?')) {
        return [parseInt(part.replace(/\?/g, '0'), 16), parseInt(part.replace(/\?/g, 'F'), 16)];
      }
      const [start, end] = part.split('-');
      const low = parseInt(start ?? '', 16);
      return [low, end === undefined ? low : parseInt(end, 16)];
    });
}

interface FontFace {
  family: string;
  urls: string[];
  /** Absent means the face covers every code point. */
  ranges: [number, number][] | undefined;
}

function fontFaces(css: string): FontFace[] {
  return [...css.matchAll(/@font-face\s*\{([\s\S]*?)\}/g)].map((match) => {
    const body = match[1] ?? '';
    const family = /font-family:\s*['"]?([^;'"]+)['"]?\s*;/.exec(body)?.[1]?.trim() ?? '';
    const urls = [...body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((url) => url[1] ?? '');
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
    return { family, urls, ranges: range === undefined ? undefined : parseUnicodeRange(range) };
  });
}

function covers(face: FontFace, codePoint: number): boolean {
  return (
    face.ranges === undefined ||
    face.ranges.some(([start, end]) => codePoint >= start && codePoint <= end)
  );
}

/** A self-hosted `/fonts/x.woff2` url, as a file in the repository. */
function fontFile(url: string): string {
  return fromRoot('apps/web/public', url.replace(/^\/+/, ''));
}

// ---------------------------------------------------------------------------
// The single e2e run
// ---------------------------------------------------------------------------

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0035 e2e run did not start', outcomes: undefined };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

/** Passing tests carrying every tag in `tags` and matching `predicate` on the title. */
function passing(tags: readonly string[], predicate: (title: string) => boolean): E2eOutcome[] {
  expect(
    e2eRun.outcomes,
    `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-4000)}`,
  ).toBeDefined();
  return (e2eRun.outcomes ?? []).filter(
    (outcome) =>
      passed(outcome) &&
      tags.every((tag) => outcome.tags.includes(tag)) &&
      predicate(outcome.title),
  );
}

// ===========================================================================
// 1. The flag
// ===========================================================================

describe('acceptance: T-0035 — admin_live_api exists, is off, and cannot reach production early', () => {
  it('registers admin_live_api, and it evaluates OFF by default', async () => {
    // The probe asks for `true` as the fallback on purpose: an unregistered
    // flag returns the fallback, so only a flag that is registered AND
    // defaults off can answer `false`.
    expect(Object.keys(FLAGS), `${LIVE_FLAG} is not declared in FLAGS`).toContain(LIVE_FLAG);

    await initialiseFeatureFlags();
    const value = await featureFlagClient().getBooleanValue(
      LIVE_FLAG,
      true,
      toEvaluationContext({ tenantId: 'acceptance-probe' }),
    );
    expect(value, `${LIVE_FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('is not production-ready, the boot guard refuses it, and apps/web reads it server-side', () => {
    // NOT production-ready, for a reason that is not about the screens: D-L51
    // makes the permissions engine (T-0032) the thing that adds the missing
    // 403 on admin endpoints. Until it lands, any authenticated user in a
    // tenant can call them. Pointing a production console at those endpoints
    // is T-0032's flip to make, in one line, when it ships.
    const definition = (FLAGS as Record<string, { productionReady?: unknown }>)[LIVE_FLAG];
    expect(definition, `${LIVE_FLAG} is not declared in FLAGS`).toBeDefined();
    expect(
      definition?.productionReady,
      `${LIVE_FLAG} must declare productionReady: false until T-0032 authorises admin endpoints`,
    ).toBe(false);

    expect(
      () => assertFlagsAreProductionSafe({ nodeEnv: 'production', enabled: [LIVE_FLAG] }),
      'a production process naming admin_live_api must refuse to boot',
    ).toThrow(new RegExp(LIVE_FLAG));
    expect(() =>
      assertFlagsAreProductionSafe({ nodeEnv: 'test', enabled: [LIVE_FLAG] }),
    ).not.toThrow();

    // Read through the server-side flag module, like self_serve_signup — a
    // `'use client'` module cannot evaluate a flag, and a hand-rolled switch is
    // a second source of truth for "is the console live".
    const flagModule = readFileSync(fromRoot('apps/web/lib/feature-flags.ts'), 'utf8');
    expect(flagModule, 'apps/web/lib/feature-flags.ts does not know admin_live_api').toContain(
      LIVE_FLAG,
    );
    const clientEvaluators = webSources().filter(
      ({ source }) => /^\s*['"]use client['"]/m.test(source) && source.includes(LIVE_FLAG),
    );
    expect(
      clientEvaluators.map(({ file }) => file),
      'a client module names admin_live_api — flags are read on the server only',
    ).toEqual([]);
  });
});

// ===========================================================================
// 2. The console on the real API — read from one e2e run
// ===========================================================================

describe('acceptance: T-0035 — the console answers from the real API, in a browser', () => {
  beforeAll(() => {
    // Relative to tests/e2e, which is where run-e2e.mjs starts Playwright.
    const reporter = relative(
      fromRoot('tests', 'e2e'),
      fromRoot('tests', 'acceptance', 'support', 'e2e-outcomes-reporter.ts'),
    ).replace(/\\/g, '/');

    let status: number | null = 0;
    let output = '';
    // Keyed by title: a test carrying two of the tags runs twice, and a failure
    // in either run must survive the merge.
    let outcomes: Map<string, E2eOutcome> | undefined;
    for (const tag of E2E_TAGS) {
      // Stale outcomes from an earlier run would be indistinguishable from this
      // run's, so the file goes first.
      rmSync(OUTCOMES_FILE, { force: true });
      const run = spawnSync(
        process.execPath,
        [fromRoot('tests/e2e/scripts/run-e2e.mjs'), '--grep', tag, `--reporter=list,${reporter}`],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          shell: false,
          timeout: E2E_RUN_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (status === 0 && run.status !== 0) status = run.status;
      output += `\n--- ${tag} (exit ${String(run.status)}) ---\n${run.stdout ?? ''}${run.stderr ?? ''}`;
      if (existsSync(OUTCOMES_FILE)) {
        outcomes ??= new Map();
        for (const outcome of JSON.parse(readFileSync(OUTCOMES_FILE, 'utf8')) as E2eOutcome[]) {
          const earlier = outcomes.get(outcome.title);
          const earlierFailed = earlier !== undefined && earlier.status !== earlier.expectedStatus;
          if (!earlierFailed) outcomes.set(outcome.title, outcome);
        }
      }
    }

    e2eRun = { status, output, outcomes: outcomes ? [...outcomes.values()] : undefined };
  }, E2E_RUN_TIMEOUT_MS * E2E_TAGS.length);

  it('keeps the whole run green, the mocked @p02 suite with the flag at its default included', () => {
    expect(
      e2eRun.status,
      `run-e2e.mjs --grep, once for each of ${E2E_GREP}, did not exit 0:\n${e2eRun.output.slice(-6000)}`,
    ).toBe(0);
  });

  it('runs @p02-live on a flag-ON process, with no interception, against seeded data the contract cannot supply', () => {
    // The flag is per PROCESS. The harness names it in the environment of a
    // web server it starts; the default server keeps every flag empty.
    const runner = readFileSync(fromRoot('tests/e2e/scripts/run-e2e.mjs'), 'utf8');
    expect(
      runner,
      'run-e2e.mjs starts no web process with admin_live_api in KASUWA_FEATURE_FLAGS_ON',
    ).toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*['"`][^'"`]*\badmin_live_api\b/);
    expect(
      runner,
      'the default web server no longer forces every flag empty',
    ).toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*''/);

    const live = specSources().filter(({ source }) => source.includes('@p02-live'));
    expect(live.length, 'no spec carries a @p02-live test').toBeGreaterThan(0);

    for (const { file, source } of live) {
      const code = withoutComments(source);
      expect(code, `${file} installs the admin mock`).not.toMatch(/installAdminMock|admin-mock/);
      expect(code, `${file} intercepts requests — a live test must reach the API`).not.toMatch(
        /\.route\s*\(|routeFromHAR/,
      );
      expect(code, `${file} does not use the seeded fixtures from @kasuwa/db`).toMatch(
        /from ['"]@kasuwa\/db['"]/,
      );
    }

    // The proof only works if the mock could not have produced the data: no
    // seeded programme or user name appears in the contract's examples.
    const contract = readFileSync(fromRoot('docs/api/admin.openapi.yaml'), 'utf8');
    for (const tenant of SEED_TENANTS) {
      for (const name of [
        ...tenant.programmes.map((programme) => programme.name),
        ...tenant.users.map((user) => user.displayName),
      ]) {
        expect(contract, `the contract's examples contain the seeded "${name}"`).not.toContain(name);
      }
    }
  });

  it('reaches every one of the twenty-two P02 screens in a passing @p02-live test', () => {
    const missing = P02_SCREENS.filter(
      (screen) => passing(['@p02-live'], (title) => citesScreen(title, screen)).length === 0,
    );
    expect(
      missing,
      `no PASSING @p02-live test cites these screens (skipped and fixme do not count): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps KPIs and skill cover on sample data inside apps/web, and labels them on the screen', () => {
    // The contract still has nothing behind exactly these two. Everything
    // else the console reads is built, so nothing else may stay on a mock.
    const unimplemented = contractOperations()
      .filter(isConsoleOperation)
      .filter((operation) => operation['x-kasuwa-implemented'] !== true)
      .map((operation) => operation.operationId ?? '(unnamed)')
      .sort();
    expect(
      unimplemented,
      'the admin contract should leave exactly the KPIs and skill cover unbuilt (T-0028 merged first)',
    ).toEqual([...STILL_MOCKED].sort());

    // The sample data lives in the app — a browser in production has no
    // Playwright to fulfil a route — and never comes from the test mock.
    for (const { file, source } of webSources()) {
      expect(withoutComments(source), `${file} imports test support`).not.toMatch(
        /from ['"][^'"]*(tests\/e2e|support\/admin-mock|@kasuwa\/testing)[^'"]*['"]/,
      );
    }
    expect(
      webSources().some(({ source }) => /data-source=["{]?['"]?mock/.test(source)),
      'apps/web marks no element data-source="mock"',
    ).toBe(true);

    // The label is translated like every other string.
    const sampleKeys = Object.keys(catalogue('en')).filter((key) =>
      /^admin\..*(sample|mock)/i.test(key),
    );
    expect(sampleKeys, 'en.json has no admin.* key labelling sample data').not.toEqual([]);

    const liveSpecs = specSources().filter(({ source }) => source.includes('@p02-live'));
    expect(
      liveSpecs.some(({ source }) => source.includes('data-source="mock"')),
      'no @p02-live spec asserts the data-source="mock" marker',
    ).toBe(true);

    const unlabelled = ['P02/B2', 'P02/B3'].filter(
      (screen) =>
        passing(['@p02-live', '@mock-labelled'], (title) => citesScreen(title, screen)).length === 0,
    );
    expect(
      unlabelled,
      `no passing @p02-live @mock-labelled test shows the sample-data label on: ${unlabelled.join(', ')}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 3. D-P11 — the region screen copy
// ===========================================================================

describe('acceptance: T-0035 — D-P11, the sign-up region screen', () => {
  it('drops "choose Nigeria" everywhere and says residency is set up with sales', () => {
    // D-P2 makes Nigeria unselectable during self-serve sign-up; a sentence
    // telling the user to choose it is an instruction the screen refuses.
    for (const { file, messages } of catalogues()) {
      const offenders = Object.entries(messages)
        .filter(([, value]) => /choose Nigeria/i.test(value))
        .map(([key]) => key);
      expect(offenders, `${file} still says "choose Nigeria"`).toEqual([]);
    }

    // The key that carried it is RETIRED, not edited in place. Changing the
    // English under an old id leaves six unreviewed drafts that still tell a
    // Hausa or Yorùbá reader to choose Nigeria, and the completeness gate
    // cannot see it — the id is present, the text is "translated". A new id
    // forces every catalogue to say the new thing.
    for (const { file, messages } of catalogues()) {
      expect(
        Object.keys(messages),
        `${file} still carries region.law.body — retire the id rather than edit its English`,
      ).not.toContain('region.law.body');
    }

    // The adopted sentence, verbatim (DECISIONS.md D-P11). Counsel signs off
    // the final wording before self_serve_signup is lifted; until then this
    // is the text.
    const en = catalogue('en');
    const salesKey = Object.keys(en).find(
      (key) => en[key] === 'Nigerian data residency is set up with our sales team.',
    );
    expect(salesKey, 'en.json has no key carrying the D-P11 sales-residency sentence').toBeDefined();

    // And P01/5.1 actually renders it: the key is in the region screen's
    // declared message ids, which is what ships to its client island.
    const ids = readFileSync(fromRoot('apps/web/components/onboarding/message-ids.ts'), 'utf8');
    const region = /REGION_MESSAGE_IDS[^=]*=\s*\[([\s\S]*?)\];/.exec(ids)?.[1] ?? '';
    expect(region, 'REGION_MESSAGE_IDS is not where it was').not.toBe('');
    expect(region, `P01/5.1 does not declare ${salesKey ?? 'the sales sentence'}`).toContain(
      `'${salesKey ?? '(missing)'}'`,
    );
    expect(region, 'P01/5.1 still declares region.law.body').not.toContain("'region.law.body'");
  });
});

// ===========================================================================
// 4. D-P1 — Beta on unreviewed languages
// ===========================================================================

describe('acceptance: T-0035 — D-P1, unreviewed languages ship with a Beta badge', () => {
  it('marks every unreviewed menu language Beta, and no reviewed one, in a passing browser test', async () => {
    // D-P1 as answered 2026-10-03: every language ships; one without a named
    // reviewer's sign-off shows Beta with a "help improve this translation"
    // link; a reviewer's sign-off removes it. Review status is read from the
    // `<locale>.review.json` files, so signing a language off in the repo is
    // what moves it between the two lists — not an edit to this test.
    const i18n: { DESIGN_MENU_LOCALES: readonly string[] } = await import(
      fromRoot('packages/i18n/src/index.ts')
    );
    const menu = [...i18n.DESIGN_MENU_LOCALES];
    expect(menu.length, 'the design menu lists no languages').toBeGreaterThan(1);

    const beta = menu.filter((locale) => !isAttested(locale));
    const signedOff = menu.filter((locale) => isAttested(locale));
    // Today: six unreviewed drafts and English. If every language is signed
    // off one day, the Beta half of this test has nothing left to check, and
    // that is the right outcome.
    expect(signedOff, 'the source language is not on the menu').toContain('en');

    // The copy, translated like every other string.
    const en = Object.values(catalogue('en'));
    expect(en, 'en.json has no "Beta" label').toContain('Beta');
    expect(
      en.some((value) => /help improve this translation/i.test(value)),
      'en.json has no "help improve this translation" link text',
    ).toBe(true);

    // The spec derives its expectations from the review files too, rather
    // than a list of its own that drifts the day a reviewer signs.
    const specs = specSources().filter(({ source }) => source.includes('@locale-beta'));
    expect(specs.length, 'no spec carries a @locale-beta test').toBeGreaterThan(0);
    expect(
      specs.some(({ source }) => /review/.test(withoutComments(source))),
      'the @locale-beta spec does not read review status from packages/i18n',
    ).toBe(true);

    const uncovered = menu.filter(
      (locale) =>
        passing(['@locale-beta'], (title) =>
          new RegExp(`locale=${escapeRegExp(locale)}(?![\\w-])`).test(title),
        ).length === 0,
    );
    expect(
      uncovered,
      `no passing @locale-beta test cites locale=<tag> for: ${uncovered.join(', ')} ` +
        `(expected Beta: ${beta.join(', ') || 'none'}; expected no Beta: ${signedOff.join(', ')})`,
    ).toEqual([]);
  });
});

// ===========================================================================
// 5. D-L43 and D-L44 — fonts
// ===========================================================================

describe('acceptance: T-0035 — D-L43 and D-L44, the fonts', () => {
  it('references no external origin in any font CSS (D-L43)', () => {
    // A fallback to fonts.gstatic.com is a third origin on a 256 kbps link and
    // a user's IP sent to a third party on every page load — an NDPA
    // processing question nobody decided to take on.
    const css = [
      ...trackedSources('packages/ui', /\.css$/),
      ...trackedSources('apps/web', /\.css$/),
    ];
    expect(
      css.some(({ file }) => file.endsWith('fonts.generated.css')),
      'packages/ui/src/fonts.generated.css is gone',
    ).toBe(true);

    for (const { file, source } of css) {
      const external = [
        ...source.matchAll(/url\(\s*['"]?((?:[a-z][\w+.-]*:)?\/\/[^'")]+)/gi),
        ...source.matchAll(/@import\s+(?:url\()?\s*['"]?((?:https?:)?\/\/[^'")\s]+)/gi),
      ].map((match) => match[1]);
      expect(external, `${file} references an external origin`).toEqual([]);
    }

    for (const face of fontFaces(readFileSync(fromRoot('packages/ui/src/fonts.generated.css'), 'utf8'))) {
      for (const url of face.urls) {
        expect(url, `${face.family} has a source that is not under /fonts/`).toMatch(/^\/fonts\//);
        expect(existsSync(fontFile(url)), `${face.family}: ${url} is not in apps/web/public`).toBe(
          true,
        );
      }
    }

    // And no way round it from the app: no Google font loader, no font host.
    for (const { file, source } of webSources()) {
      expect(withoutComments(source), `${file} loads fonts from Google`).not.toMatch(
        /next\/font\/google|fonts\.googleapis\.com|fonts\.gstatic\.com/,
      );
    }
  });

  it('draws ₦ and ₵ from a small subset, never from the 168 KB Latin-Extended file (D-L44)', () => {
    // A face is downloaded when the page uses a code point in its
    // unicode-range. So the rule is about ranges: no face whose file is large
    // may claim the currency signs, and Noto Sans must have a small one that
    // does — otherwise the next screen with a naira amount is back over 300 KB.
    const faces = fontFaces(readFileSync(fromRoot('packages/ui/src/fonts.generated.css'), 'utf8'));
    expect(faces.length, 'no @font-face rules found').toBeGreaterThan(0);

    for (const codePoint of CURRENCY_CODE_POINTS) {
      const sign = String.fromCodePoint(codePoint);
      for (const face of faces.filter((candidate) => covers(candidate, codePoint))) {
        for (const url of face.urls) {
          const file = fontFile(url);
          expect(existsSync(file), `${face.family}: ${url} is not in apps/web/public`).toBe(true);
          const bytes = existsSync(file) ? statSync(file).size : Number.POSITIVE_INFINITY;
          expect(
            bytes,
            `${face.family} claims ${sign} with ${url} (${bytes} bytes) — a ${sign} would download it`,
          ).toBeLessThanOrEqual(CURRENCY_SUBSET_MAX_BYTES);
        }
      }

      const subset = faces.filter(
        (face) => face.family === 'Noto Sans' && face.ranges !== undefined && covers(face, codePoint),
      );
      expect(subset.length, `no Noto Sans subset face covers ${sign}`).toBeGreaterThan(0);
    }

    // The Latin-Extended file itself is still shipped — Yorùbá, Igbo and Hausa
    // diacritics need it — it just stops being the price of a currency sign.
    expect(
      faces.some((face) => face.urls.some((url) => url.includes('noto-sans-latin-ext'))),
      'Noto Sans Latin-Extended was removed — the Nigerian-language diacritics need it',
    ).toBe(true);
  });

  it('keeps Latin-Extended off the critical path of /onboarding and /admin, in a passing browser test', () => {
    const specs = specSources().filter(({ source }) => source.includes('@fonts'));
    expect(specs.length, 'no spec carries a @fonts test').toBeGreaterThan(0);
    const code = specs.map(({ source }) => withoutComments(source)).join('\n');
    expect(code, 'the @fonts tests do not measure the critical path').toMatch(
      /captureCriticalPath|measureCriticalPath/,
    );
    expect(code, 'the @fonts tests never name the Latin-Extended file').toContain(
      'noto-sans-latin-ext',
    );
    expect(code, 'the @fonts tests never compare a request origin').toMatch(/origin/);

    const missing = FONT_ROUTES.filter(
      (path) => passing(['@fonts'], (title) => citesPath(title, path)).length === 0,
    );
    expect(missing, `no passing @fonts test covers: ${missing.join(', ')}`).toEqual([]);
  });
});

// ===========================================================================
// 6. Byte budgets
// ===========================================================================

describe('acceptance: T-0035 — every route inside its byte budget', () => {
  it('measures every budgeted route in a passing test, pins each under the ceiling, and re-pins P01/1', () => {
    const missing = BUDGETED.filter(
      (path) =>
        passing([], (title) => /byte[- ]budget/i.test(title) && citesPath(title, path)).length === 0,
    );
    expect(
      missing,
      `no PASSING byte-budget test cites these routes: ${missing.join(', ')}`,
    ).toEqual([]);

    // Every budget literal in the e2e suite is a number near a measurement,
    // never the NFR ceiling itself.
    const sources = specSources()
      .map(({ source }) => source)
      .join('\n');
    const literals = [
      ...sources.matchAll(/assertWithinByteBudget\([^)]*?(\d[\d_]{4,})/g),
      ...sources.matchAll(/\bbudget:\s*(\d[\d_]{4,})/g),
    ].map((match) => Number((match[1] ?? '').replace(/_/g, '')));
    expect(literals.length, 'no numeric budget found in the e2e suite').toBeGreaterThan(0);
    for (const budget of literals) {
      expect(budget, `a budget of ${budget} bytes is at or above the 300 KB ceiling`).toBeLessThan(
        PRD_CEILING_BYTES,
      );
    }

    // `/onboarding` has a budget of its own now (D-L44 is the reason it went
    // over in the first place).
    expect(
      specSources().some(
        ({ source }) => /\/onboarding/.test(source) && /assertWithinByteBudget/.test(source),
      ),
      'no spec holds /onboarding to a byte budget',
    ).toBe(true);

    // P01/1: 270,336 left 12.6% headroom over the 240,015 measured (D-L43
    // note). A budget that loose permits a regression of a full font file.
    const p01 = readFileSync(fromRoot('tests/e2e/p01-auth.spec.ts'), 'utf8');
    const signIn = /assertWithinByteBudget\(\s*['"]the P01\/1 sign-in page['"]\s*,[^,]+,\s*([\d_]+)/.exec(
      p01,
    );
    expect(signIn, 'the P01/1 sign-in budget assertion is not where it was').not.toBeNull();
    const pinned = Number((signIn?.[1] ?? '0').replace(/_/g, ''));
    expect(pinned, 'the P01/1 budget was not re-pinned').toBeLessThan(P01_SIGN_IN_OLD_BUDGET);
    expect(
      pinned,
      `the P01/1 budget is more than 5% over the ${P01_SIGN_IN_MEASURED} measured`,
    ).toBeLessThanOrEqual(Math.round(P01_SIGN_IN_MEASURED * 1.05));
  });
});
