import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FLAGS,
  featureFlagClient,
  initialiseFeatureFlags,
  toEvaluationContext,
} from '@kasuwa/feature-flags';
import { OUTCOMES_FILE, type E2eOutcome } from '../support/e2e-outcomes-reporter';

/**
 * ACCEPTANCE — T-0007, the P01 authentication and onboarding screens
 * (Agent 11, Frontend & Design System).
 *
 * ACTIVE since 2026-10-02 (groups 3–4 assigned under D-P2). This file runs in
 * the blocking `isolation` project. Groups 1–2 (`P01/1`–`2b`) shipped in #22
 * and their assertions are unchanged; groups 3–4 (`P01/3`, `P01/4`,
 * `P01/5.1`–`5.5`, `P01/6`) are asserted in the blocks at the end of the file,
 * whose header states the e2e contract they hold the builder to.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE IS AND IS NOT
 *
 * It is NOT a visual check. Nothing here can tell you whether a screen looks
 * like its design; a human comparing the export to the browser does that, and
 * no assertion replaces it.
 *
 * What it does assert are the properties that are invisible in review and
 * expensive to discover later:
 *
 *   - every screen id in the manifest is actually reachable and tested,
 *     including the failure states, which are most of this task
 *   - the sign-in failure does not leak which field was wrong
 *   - no string bypasses i18n and no offered language falls back to English
 *   - the page stays inside its transferred-byte budget (D-L28)
 *   - no colour is invented outside the design system
 *
 * Every one of those is a thing a reviewer looking at a screenshot cannot see.
 * ------------------------------------------------------------------------
 *
 * BUILT AGAINST A CONTRACT, NOT AGAINST ENDPOINTS. @acexode put this task in
 * flight alongside T-0001 rather than after it. Agent 1 publishes the auth API
 * contract first; you build against it with a mock server, and wire to the real
 * endpoints as the final step when T-0001 merges.
 *
 * So this suite deliberately does NOT require a live auth API for most of its
 * assertions — but it does require that the mock is generated FROM the
 * committed contract rather than hand-written, because a hand-written mock
 * drifts from the contract silently and then the wiring step discovers that
 * sixteen screens were built against a fiction.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

/**
 * Source with block and line comments removed. Approximate — it does not parse
 * strings — but `(^|[^:])` keeps `https://…` inside a string intact, and a
 * comment that names a thing is not the thing.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The sixteen screens on the P01 index board. Cited, not invented. */
const SCREENS = [
  'P01/1',
  'P01/1a',
  'P01/1b',
  'P01/1c',
  'P01/1d',
  'P01/2',
  'P01/2a',
  'P01/2b',
  'P01/3',
  'P01/4',
  'P01/5.1',
  'P01/5.2',
  'P01/5.3',
  'P01/5.4',
  'P01/5.5',
  'P01/6',
] as const;

const E2E_RUN_TIMEOUT_MS = 900_000;

function e2eSources(): string {
  const files = execFileSync('git', ['ls-files', 'tests/e2e'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.endsWith('.ts'));

  return files.map((file) => readFileSync(fromRoot(file), 'utf8')).join('\n');
}

describe('acceptance: every screen in the manifest exists and is tested', () => {
  it('covers all sixteen screen ids in the e2e suite', () => {
    // Citing the id in the test is how a screen stays traceable to its design
    // a year from now, when the export has been re-versioned twice and nobody
    // remembers which state `1c` was.
    const sources = e2eSources();

    const missing = SCREENS.filter((screen) => !sources.includes(screen));
    expect(missing, `no e2e test cites these screen ids: ${missing.join(', ')}`).toEqual([]);
  });

  it('tests the failure states, which are most of this task', () => {
    // `1a` wrong credentials, `1b` locked out, `1c` needs SSO, `1d` slow
    // connection, `2a` wrong code, `2b` expired code. A suite that covers only
    // the happy path has tested the least interesting sixth of the work, and
    // these are the screens a real user meets on their worst day.
    const sources = e2eSources();

    for (const screen of ['P01/1a', 'P01/1b', 'P01/1c', 'P01/1d', 'P01/2a', 'P01/2b']) {
      expect(sources, `${screen} — failure state is not exercised`).toContain(screen);
    }
  });

  it('generates its mock from the committed auth contract', () => {
    // T-0001 publishes the contract first precisely so this task can start.
    // A HAND-WRITTEN mock defeats that: it drifts silently, and the wiring
    // step then discovers sixteen screens built against a fiction.
    const contract = ['docs/api/auth.openapi.yaml', 'docs/api/auth.openapi.json'].find((file) =>
      existsSync(fromRoot(file)),
    );

    expect(contract, 'no committed auth contract to build the mock from').toBeDefined();

    const sources = e2eSources();
    expect(
      sources,
      'the mock does not reference the contract — is it hand-written?',
    ).toMatch(/openapi|auth\.openapi/i);
  });
});

describe('acceptance: the sign-in failure leaks nothing', () => {
  it('answers an unknown email and a wrong password identically', () => {
    // `P01/1a` deliberately does not say which field was wrong. That is the
    // same rule as the API's "not authenticated" (CLAUDE.md section 6): an
    // error distinguishing the two is a user-enumeration oracle, and an
    // attacker with a list of emails uses it to find out who banks where.
    //
    // It is also the single most likely thing to be "fixed" as a usability
    // improvement by someone who has not read that section, which is why it is
    // asserted at the UI layer and not only at the API.
    //
    // Asserted through the e2e suite, which can compare what the two attempts
    // actually render — including the lockout counter, which must advance the
    // same way for both, or the counter becomes the oracle instead.
    const run = spawnSync('pnpm', ['test:e2e', '--', '--grep', '@enumeration'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: E2E_RUN_TIMEOUT_MS,
    });

    expect(
      run.status,
      `the enumeration test did not pass:\n${run.stdout ?? ''}${run.stderr ?? ''}`,
    ).toBe(0);

    expect(e2eSources(), 'no test tagged @enumeration').toContain('@enumeration');
  }, E2E_RUN_TIMEOUT_MS);

  it('names a timezone when it tells someone to come back later', () => {
    // `P01/1b`. "Try again in 15 minutes" is useless to someone whose phone
    // clock is in a different zone from the tenant — and BPO rosters routinely
    // span WAT, EAT and SAST, so this is the normal case, not the edge.
    const sources = e2eSources();
    expect(sources, 'the lockout test does not assert a timezone is shown').toMatch(
      /timeZone|timezone|IANA/,
    );
  });
});

describe('acceptance: nothing is hard-coded that should not be', () => {
  it('invents no colour outside the design system', () => {
    // Lint enforces this, so the assertion is really about the lint rule still
    // being switched on for the files that now exist.
    const files = execFileSync('git', ['ls-files', 'apps/web'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => /\.(tsx?|css)$/.test(file));

    expect(files.length, 'apps/web has no source files').toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(fromRoot(file), 'utf8');
      const hex = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hex, `${file} contains colour literals: ${hex.join(', ')}`).toEqual([]);
    }
  });

  it('offers no language that falls back to English', () => {
    // The gate from T-0009 already guarantees this for the catalogue. What it
    // cannot guarantee is that the SCREEN offers exactly the gate's list —
    // a hard-coded menu in a component would happily list seven while the
    // catalogue supports two.
    const sources = execFileSync('git', ['ls-files', 'apps/web'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => readFileSync(fromRoot(file), 'utf8'))
      .join('\n');

    expect(
      sources,
      'the language menu does not come from SUPPORTED_LOCALES — it can offer a language that is not ready',
    ).toMatch(/SUPPORTED_LOCALES/);

    // And no endonym typed directly into a component, which is the way a menu
    // ends up listing a language the gate has held back.
    //
    // Comments are stripped (amended 2026-10-02). P02 landed two doc comments
    // that NAME Yorùbá while explaining why the code does not hard-code it
    // (`components/admin/nav-model.ts`, `scripts-tab.tsx`), and this assertion
    // — pending at the time, so nobody saw it — went red on main for a reason
    // that is not the defect it guards against. A comment offers no language.
    const code = withoutComments(sources);
    for (const endonym of ['Yorùbá', 'Kiswahili', 'Français']) {
      expect(code, `"${endonym}" is hard-coded in a component`).not.toContain(endonym);
    }
  });
});

describe('acceptance: the 256 kbps commitment is kept', () => {
  it('asserts a transferred-byte budget against a production build', () => {
    // D-L28, as answered by @acexode: CI builds apps/web in production mode and
    // the budget is set against THAT, starting from the PRD 2.13 ceiling of
    // 300 KB gzipped on the critical path.
    //
    // The harness (T-0008) measured a `next dev` bundle, and a budget set
    // against a development build is meaningless in both directions. T-0010
    // makes the CI job build properly; this asserts the screens then use it.
    const sources = e2eSources();

    expect(sources, 'no screen test asserts a byte budget').toMatch(/assertWithinByteBudget/);

    // The ceiling is a ceiling, not a target. A budget pinned at 300 KB permits
    // every page between today's weight and the NFR limit, which is most of the
    // room a regression needs.
    const budgets = [...sources.matchAll(/assertWithinByteBudget\([^)]*?(\d{5,})/g)].map((match) =>
      Number(match[1]),
    );

    expect(budgets.length, 'no numeric budget found').toBeGreaterThan(0);
    for (const budget of budgets) {
      expect(
        budget,
        `a budget of ${budget} bytes is at or above the 300 KB NFR ceiling — ` +
          'pin it near the measured weight, not at the limit',
      ).toBeLessThanOrEqual(300 * 1024);
    }
  });

  it('keeps the slow-connection screen, which is the first thing cut for time', () => {
    // `P01/1d` is not a spinner: skeleton, then "Still connecting…" at 4s, then
    // an offer of low-bandwidth mode. It is the 256 kbps NFR made visible, it
    // is the screen most likely to be dropped under schedule pressure, and the
    // task file says in as many words not to cut it.
    // Tied to the screen id on purpose. Grepping the whole e2e tree for
    // "lowBandwidth" passes on the harness's own profile definition, which
    // says nothing about whether P01/1d was ever tested — the first draft of
    // this assertion did exactly that and went green against zero screens.
    const files = execFileSync('git', ['ls-files', 'tests/e2e'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => file.endsWith('.spec.ts'));

    const covering = files
      .map((file) => readFileSync(fromRoot(file), 'utf8'))
      .filter((source) => source.includes('P01/1d'));

    expect(covering.length, 'no spec cites P01/1d at all').toBeGreaterThan(0);
    expect(
      covering.some((source) => /lowBandwidth|low-bandwidth/.test(source)),
      'P01/1d is cited but never exercised under the low-bandwidth profile',
    ).toBe(true);
  });
});

describe('acceptance: the debts T-0008 left are paid', () => {
  it('tampers with a WEB url, not only an API one', () => {
    // T-0008 could only tamper with the API origin, because apps/web had one
    // page and no record route. It said so, and logged it here. The browser is
    // the layer a user actually touches, and a client router that fetches by id
    // before the server checks scope is a real and common leak.
    const tenancy = fromRoot('tests/e2e/tenancy.spec.ts');
    expect(existsSync(tenancy)).toBe(true);

    const source = readFileSync(tenancy, 'utf8');
    expect(
      source,
      'the tenancy e2e test still only drives the API origin — add the web-route case',
    ).toMatch(/webUrl|webOrigin|page\.goto\(`?\$\{web/);
  });

  it('has deleted the axe color-contrast exclusion', () => {
    // T-0008 excluded it on the design-tokens gallery, which is a demo page
    // rendering 3:1 large-text pairs at caption size. A real screen exists now,
    // so the exemption goes and axe blocks on contrast like every other rule.
    //
    // An accessibility exemption inherited by thirty screens is exactly what
    // nobody remembers to remove, because by then it has always been there.
    const spec = readFileSync(fromRoot('tests/e2e/harness.spec.ts'), 'utf8');
    expect(spec, 'the color-contrast exclusion is still in harness.spec.ts').not.toMatch(
      /color-contrast/,
    );
  });
});

/* ==========================================================================
 * GROUPS 3–4 — SIGN-UP (`P01/3`, `P01/4`, `P01/5.1`) AND FIRST-ADMIN
 * ONBOARDING (`P01/5.2`–`5.5`, `P01/6`). Added 2026-10-02 under D-P2.
 *
 * D-P2 split what the design draws as one flow:
 *
 *   - `P01/3`, `P01/4`, `P01/5.1` are SELF-SERVE. They are built against the
 *     mock generated from `docs/api/auth.openapi.yaml` (signUp, verifyOtp and
 *     resendOtp are `x-kasuwa-implemented: false`) and sit behind the feature
 *     flag `self_serve_signup`, DEFAULT OFF. The flag gates the ROUTE: a screen
 *     reachable by typing its path while the flag is off is hidden, not gated.
 *   - `P01/5.2`–`5.5` and `P01/6` are the FIRST-ADMIN-LOGIN flow. Every tenant
 *     needs them, including the ones provisioned by hand (T-0015), so they are
 *     NOT behind the flag. Gating them would strand every launch tenant halfway
 *     through setup — the regression this block exists to catch.
 *
 * D-P3: sign-up never says "that email is already registered". The contract
 * answers 202 with one body either way; `P01/3` shows one neutral "check your
 * inbox" state for both.
 *
 * THE E2E CONTRACT these assertions read. Everything below is checked against
 * ONE run of `pnpm test:e2e -- --grep @p01`, through a reporter this suite
 * owns (`tests/acceptance/support/e2e-outcomes-reporter.ts`), so a test that
 * was skipped, `fixme`d or never matched does not count as a pass.
 *
 *   1. Every test below is tagged `@p01` and cites the screen ids it covers in
 *      its title or its describe, as groups 1–2 already do.
 *   2. Each of the eight screens is asserted by `[data-screen="<id>"]`.
 *   3. `@self-serve-off` — the stack as `pnpm test:e2e` starts it, flag at its
 *      default. Typing the path of `P01/3`, `P01/4` and `P01/5.1` answers HTTP
 *      404 (CLAUDE.md 6.4: hidden is "not found", never "forbidden"), and
 *      `P01/5.2`–`5.5` and `P01/6` render.
 *   4. `@self-serve-on` — the flag turned on SERVER-SIDE. `P01/3`, `P01/4` and
 *      `P01/5.1` render. How the harness gets a flag-on web process is the
 *      builder's choice; it must not be something a browser can send.
 *   5. `@enumeration` — a `P01/3` case submits an address that has an account
 *      and one that does not, and asserts the two render identically.
 * ========================================================================== */

const GROUP_3_4 = [
  'P01/3',
  'P01/4',
  'P01/5.1',
  'P01/5.2',
  'P01/5.3',
  'P01/5.4',
  'P01/5.5',
  'P01/6',
] as const;

/** Behind `self_serve_signup` (D-P2 point 3). */
const SELF_SERVE = ['P01/3', 'P01/4', 'P01/5.1'] as const;

/** First-admin login — NOT behind the flag (D-P2 point 4, T-0018). */
const FIRST_ADMIN = ['P01/5.2', 'P01/5.3', 'P01/5.4', 'P01/5.5', 'P01/6'] as const;

const SELF_SERVE_FLAG = 'self_serve_signup';

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
  return trackedSources('apps/web', /\.tsx?$/).filter(({ file }) => !/\.test\.tsx?$/.test(file));
}

function specSources(): SourceFile[] {
  return trackedSources('tests/e2e', /\.spec\.ts$/);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `P01/5.1` must not match `P01/5.10`, and `P01/3` must not match `P01/3a`. */
function cites(text: string, screen: string): boolean {
  return new RegExp(`${escapeRegExp(screen)}(?!\\w|\\.\\d)`).test(text);
}

function catalogues(): { file: string; messages: Record<string, string> }[] {
  return trackedSources('packages/i18n/src/locales', /\/[\w-]+\.json$/)
    .filter(({ file }) => !/\.(review|passthrough)\.json$/.test(file))
    .map(({ file, source }) => ({ file, messages: JSON.parse(source) as Record<string, string> }));
}

interface P01Run {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
}

let p01Run: P01Run = {
  status: null,
  output: 'the @p01 e2e run did not start',
  outcomes: undefined,
};

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

/** The passing tests (optionally carrying `tag`) that cite `screen`. */
function passingFor(screen: string, tag?: string): E2eOutcome[] {
  expect(
    p01Run.outcomes,
    `the @p01 e2e run wrote no outcomes — it did not get as far as Playwright:\n${p01Run.output.slice(-4000)}`,
  ).toBeDefined();
  return (p01Run.outcomes ?? []).filter(
    (outcome) =>
      passed(outcome) &&
      cites(outcome.title, screen) &&
      (tag === undefined || outcome.tags.includes(tag)),
  );
}

function missingFrom(screens: readonly string[], tag?: string): string[] {
  return screens.filter((screen) => passingFor(screen, tag).length === 0);
}

describe('acceptance: P01 groups 3–4 — the flag exists and is off', () => {
  it('registers self_serve_signup, and it evaluates OFF by default', async () => {
    // D-P2: built in MVP, shipped OFF until v1. The probe asks for `true` as
    // the fallback on purpose: an unregistered flag returns the fallback, so
    // only a flag that is registered AND defaults off can answer `false`.
    expect(Object.keys(FLAGS), `${SELF_SERVE_FLAG} is not declared in FLAGS`).toContain(
      SELF_SERVE_FLAG,
    );

    await initialiseFeatureFlags();
    const value = await featureFlagClient().getBooleanValue(
      SELF_SERVE_FLAG,
      true,
      toEvaluationContext({ tenantId: 'acceptance-probe' }),
    );
    expect(value, `${SELF_SERVE_FLAG} does not evaluate OFF by default`).toBe(false);
  });

  it('gates the web routes with the shared flag, not a hand-rolled switch', () => {
    // CLAUDE.md section 4: feature flags go through @kasuwa/feature-flags. A
    // second, local switch is two sources of truth for "is sign-up public",
    // and the day they disagree is the day sign-up is public by accident.
    const sources = webSources();

    expect(
      sources.some(({ source }) => source.includes(SELF_SERVE_FLAG)),
      `no apps/web source evaluates ${SELF_SERVE_FLAG}`,
    ).toBe(true);
    expect(
      sources.some(({ source }) => /from ['"]@kasuwa\/feature-flags['"]/.test(source)),
      'apps/web does not import @kasuwa/feature-flags',
    ).toBe(true);
  });
});

describe('acceptance: P01 groups 3–4 — every screen is built and reached in a browser', () => {
  beforeAll(() => {
    // Stale outcomes from an earlier run would be indistinguishable from this
    // run's, so the file goes first.
    rmSync(OUTCOMES_FILE, { force: true });

    // Relative to tests/e2e, which is where run-e2e.mjs starts Playwright and
    // therefore what Playwright resolves a CLI reporter path against.
    const reporter = relative(
      fromRoot('tests', 'e2e'),
      fromRoot('tests', 'acceptance', 'support', 'e2e-outcomes-reporter.ts'),
    ).replace(/\\/g, '/');

    const run = spawnSync(
      'pnpm',
      ['test:e2e', '--', '--grep', '@p01', `--reporter=list,${reporter}`],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: E2E_RUN_TIMEOUT_MS,
      },
    );

    p01Run = {
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}`,
      outcomes: existsSync(OUTCOMES_FILE)
        ? (JSON.parse(readFileSync(OUTCOMES_FILE, 'utf8')) as E2eOutcome[])
        : undefined,
    };
  }, E2E_RUN_TIMEOUT_MS);

  it('keeps the whole @p01 run green, groups 1–2 included', () => {
    // Groups 1–2 shipped in #22. Landing 3–4 must not cost them anything —
    // including the manifest test in p01-auth.spec.ts, which has to change
    // honestly rather than be deleted.
    expect(
      p01Run.status,
      `pnpm test:e2e --grep @p01 did not exit 0:\n${p01Run.output.slice(-6000)}`,
    ).toBe(0);
  });

  it('names each of the eight screens in apps/web', () => {
    // The screen id is how a rendered state stays traceable to its design.
    // Groups 1–2 set the convention: `data-screen="<id>"` on the section.
    const sources = webSources()
      .map(({ source }) => source)
      .join('\n');

    const missing = GROUP_3_4.filter(
      (screen) => !sources.includes(`'${screen}'`) && !sources.includes(`"${screen}"`),
    );
    expect(missing, `apps/web renders no screen marked: ${missing.join(', ')}`).toEqual([]);
  });

  it('asserts each screen by its data-screen marker, and declares none unbuilt', () => {
    // Citing an id in a comment or a manifest constant is not covering it —
    // the sixteen-id assertion above cannot tell the difference, which is why
    // it passed while half the board was unbuilt. This one can.
    const specs = specSources();
    const all = specs.map(({ source }) => source).join('\n');

    const unasserted = GROUP_3_4.filter((screen) => !all.includes(`data-screen="${screen}"`));
    expect(
      unasserted,
      `no spec locates these screens by [data-screen]: ${unasserted.join(', ')}`,
    ).toEqual([]);

    for (const { file, source } of specs) {
      for (const match of source.matchAll(/notBuilt\s*:\s*\[([^\]]*)\]/g)) {
        const stillUnbuilt = GROUP_3_4.filter((screen) => cites(match[1] ?? '', screen));
        expect(stillUnbuilt, `${file} still declares these screens unbuilt`).toEqual([]);
      }
    }
  });

  it('reaches every one of the eight screens in a passing browser test', () => {
    const missing = missingFrom(GROUP_3_4);
    expect(
      missing,
      `no PASSING @p01 test cites these screens (skipped and fixme do not count): ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('with self_serve_signup OFF, P01/3, P01/4 and P01/5.1 are 404 when their path is typed', () => {
    // The flag gates the route, not the button (T-0007 amendment). Asserted on
    // the HTTP status of a direct navigation, because a client-side redirect
    // after a 200 has already shipped the screen to the browser.
    const offSpecs = specSources().filter(({ source }) => source.includes('@self-serve-off'));
    expect(offSpecs.length, 'no spec carries a @self-serve-off test').toBeGreaterThan(0);
    expect(
      offSpecs.some(({ source }) => /\.status\(\)/.test(source) && /\b404\b/.test(source)),
      'the @self-serve-off tests never assert an HTTP 404 status',
    ).toBe(true);

    const missing = missingFrom(SELF_SERVE, '@self-serve-off');
    expect(
      missing,
      `no passing @self-serve-off test proves these are unreachable with the flag off: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('with self_serve_signup OFF, the first-admin steps P01/5.2–5.5 and P01/6 still render', () => {
    // D-P2 point 4, and the regression T-0018 names as most likely: someone
    // tidies the flag handling and the whole wizard goes behind it.
    const missing = missingFrom(FIRST_ADMIN, '@self-serve-off');
    expect(
      missing,
      `no passing @self-serve-off test reaches these first-admin steps: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('with self_serve_signup ON, P01/3, P01/4 and P01/5.1 render', () => {
    const missing = missingFrom(SELF_SERVE, '@self-serve-on');
    expect(
      missing,
      `no passing @self-serve-on test reaches these with the flag on: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('answers a new and an already-registered email on P01/3 with one neutral state (D-P3)', () => {
    const missing = missingFrom(['P01/3'], '@enumeration');
    expect(
      missing,
      'no passing @enumeration test compares a new and an existing address on P01/3',
    ).toEqual([]);
  });
});

describe('acceptance: P01 groups 3–4 — nothing says what it must not', () => {
  it('has no "already registered" message anywhere sign-up could show it (D-P3)', () => {
    // The oracle is a string before it is a state. If no catalogue holds it and
    // no component types it, no screen can show it.
    const oracle =
      /already (been )?(registered|signed up|in use|taken)|(account|email|address) already exists|already ha(s|ve) an account/i;

    for (const { file, messages } of catalogues()) {
      const offenders = Object.entries(messages)
        // Admin's "a programme with that name already exists" is a duplicate
        // name inside a tenant the caller already belongs to, not an oracle.
        .filter(([key]) => !key.startsWith('admin.'))
        .filter(([, value]) => oracle.test(value))
        .map(([key]) => key);
      expect(offenders, `${file} carries an "already registered" message`).toEqual([]);
    }

    // Comments are stripped: a comment explaining why the oracle is absent is
    // not the oracle, and `sign-in-screen.tsx` has exactly such a comment.
    for (const { file, source } of webSources()) {
      expect(withoutComments(source), `${file} hard-codes an "already registered" message`).not.toMatch(
        oracle,
      );
    }

    // And the contract still refuses to have one: sign-up answers 202 for both
    // cases and declares no 409 at all.
    const contract = readFileSync(fromRoot('docs/api/auth.openapi.yaml'), 'utf8');
    const signUp = contract.slice(
      contract.indexOf('/api/v1/auth/sign-up:'),
      contract.indexOf('/api/v1/auth/verify-otp:'),
    );
    expect(signUp, 'the sign-up operation is missing from the contract').toContain(
      'operationId: signUp',
    );
    expect(signUp, 'sign-up declares a 409 — that is the oracle').not.toMatch(/['"]?409['"]?\s*:/);
  });

  it('takes every new string from @kasuwa/i18n', () => {
    // The lint rule is what fails a literal JSX text node; assert it is still
    // switched on for every web component, at error.
    const eslintConfig = readFileSync(fromRoot('eslint.config.mjs'), 'utf8');
    expect(eslintConfig, 'the no-literal-string rule is off for apps/web').toMatch(
      /files:\s*\[\s*'apps\/web\/\*\*\/\*\.tsx'\s*\][\s\S]{0,800}'i18next\/no-literal-string':\s*\[\s*'error'/,
    );

    // The rule runs in jsx-text-only mode, so it does not see attributes —
    // and a label, placeholder or alt typed in English is still English. No
    // literal user-facing attribute anywhere in the web app.
    const attribute = /\b(aria-label|aria-description|placeholder|title|alt)="[^"]*[A-Za-z][^"]*"/g;
    for (const { file, source } of webSources().filter(({ file: name }) => name.endsWith('.tsx'))) {
      const literals = source.match(attribute) ?? [];
      expect(literals, `${file} types user-facing text into an attribute`).toEqual([]);
    }

    // CLAUDE.md section 4: no hard-coded currency symbols. `P01/5.2` previews
    // money formats; the symbol comes from Intl and the tenant's currency.
    for (const { file, source } of webSources()) {
      expect(source, `${file} hard-codes a currency symbol`).not.toMatch(/[₦₵]|KSh/);
    }
  });

  it('prints no WhatsApp price in any language (P01/5.3)', () => {
    // Meta changes the prices. The design explains cost TYPES and the 24-hour
    // window instead, which is the part that is still true next quarter.
    const price = /(\$|US\$|USD|₦|NGN|ZAR|KES|KSh|GHS|GH₵)\s?\d/;
    for (const { file, messages } of catalogues()) {
      const offenders = Object.entries(messages)
        .filter(([key, value]) => /whatsapp/i.test(key) && price.test(value))
        .map(([key]) => key);
      expect(offenders, `${file} prints a WhatsApp price`).toEqual([]);
    }
  });
});
