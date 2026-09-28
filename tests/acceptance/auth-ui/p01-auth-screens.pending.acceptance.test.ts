import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0007, the P01 authentication and onboarding screens
 * (Agent 11, Frontend & Design System).
 *
 * PENDING. `pnpm test:pending` runs them. Renaming this file to drop
 * `.pending` is what assigns the task.
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

describe('acceptance (pending): every screen in the manifest exists and is tested', () => {
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

describe('acceptance (pending): the sign-in failure leaks nothing', () => {
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

describe('acceptance (pending): nothing is hard-coded that should not be', () => {
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
    for (const endonym of ['Yorùbá', 'Kiswahili', 'Français']) {
      expect(sources, `"${endonym}" is hard-coded in a component`).not.toContain(endonym);
    }
  });
});

describe('acceptance (pending): the 256 kbps commitment is kept', () => {
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

describe('acceptance (pending): the debts T-0008 left are paid', () => {
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
