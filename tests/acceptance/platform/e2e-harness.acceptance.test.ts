import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0008, the end-to-end test harness (Agent 12, QA).
 *
 * PENDING. Real tests, failing today because `tests/e2e/` does not exist.
 * `pnpm test:pending` runs them. Renaming this file to drop `.pending` is what
 * assigns the task — `pnpm verify:tasks` enforces it.
 *
 * ------------------------------------------------------------------------
 * WHY THIS SUITE LOOKS LIKE A TEST OF A TEST
 *
 * It is, and deliberately. Every screen task from T-0007 onward will express
 * its acceptance criteria as a Playwright test, which means the harness is
 * about to become load-bearing for the whole front end. A harness that quietly
 * stops throttling, or whose byte budget silently passes everything, does not
 * announce itself — it just makes thirty screens look compliant.
 *
 * So this suite does not ask whether the harness EXISTS. It runs it, as a
 * subprocess, and asserts on numbers it produced:
 *
 *   - the low-bandwidth profile must measurably slow the SAME page down
 *   - the budget assertion must FAIL on an over-budget page, proven by a run
 *     that exits non-zero, not by a passing test that claims it would have
 *
 * The second is the one that matters. A check only ever observed passing is
 * indistinguishable from a check that does nothing, and this is the check
 * standing between us and quietly abandoning the 256 kbps commitment in PRD
 * 2.13 somewhere around the twelfth screen.
 * ------------------------------------------------------------------------
 *
 * THE CONTRACT, in the order it is asserted below. Agent 12 may change any
 * internal detail; these are the interfaces other tasks will depend on.
 *
 *   1. `pnpm test:e2e` runs Playwright against a real API and a real database.
 *   2. `tests/e2e/harness.spec.ts` carries self-tests tagged `@harness`.
 *   3. A run writes `tests/e2e/.artifacts/harness-metrics.json`:
 *        { "<profile>": { "fcpMs": number, "transferredBytes": number } }
 *      for at least the profiles `default` and `low-bandwidth`.
 *   4. `tests/e2e/fixtures/over-budget.spec.ts` is a deliberately over-budget
 *      page. Running it exits non-zero. It is excluded from the normal run.
 *   5. Traces and screenshots are retained on failure and uploaded by CI.
 *
 * No arbitrary timeouts anywhere in the harness (see the last test). A flaky
 * e2e suite is worse than none: it teaches the team to re-run rather than read.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

/** Playwright brings its own browser and stack; it needs far longer than vitest's default. */
const HARNESS_RUN_TIMEOUT_MS = 600_000;

interface ProfileMetrics {
  fcpMs: number;
  transferredBytes: number;
}

type HarnessMetrics = Record<string, ProfileMetrics>;

describe('acceptance (pending): the e2e harness is wired', () => {
  it('exposes pnpm test:e2e', () => {
    const scripts = JSON.parse(readFileSync(fromRoot('package.json'), 'utf8')).scripts ?? {};

    expect(scripts['test:e2e'], 'package.json has no test:e2e script').toBeDefined();

    // It must not be folded into `pnpm test`. The unit/integration/isolation
    // chain is the pre-PR gate and has to stay fast enough that people run it;
    // an e2e run that starts a browser does not belong in it.
    expect(scripts.test).not.toContain('test:e2e');
  });

  // The only assertion here that passes today, because it is a NEGATIVE
  // invariant: it must hold before the harness exists and after. Left in
  // knowingly — it is the regression guard, not a readiness check.
  it('keeps the e2e suite out of the vitest projects', () => {
    // Playwright and vitest both collect `*.spec.ts`. If `tests/e2e/` ever
    // matches a vitest include, the specs get run by the wrong runner and fail
    // in a way that reads as a broken app rather than a misconfigured glob.
    const workspace = readFileSync(fromRoot('vitest.workspace.ts'), 'utf8');
    expect(workspace).not.toMatch(/tests\/e2e/);
  });

  it('configures Chromium only, with traces and screenshots retained on failure', () => {
    const configPath = fromRoot('tests/e2e/playwright.config.ts');
    expect(existsSync(configPath), 'tests/e2e/playwright.config.ts is missing').toBe(true);

    const config = readFileSync(configPath, 'utf8');

    // Firefox and WebKit are not worth the CI minutes until something differs.
    expect(config).toMatch(/chromium/i);
    expect(config).not.toMatch(/webkit|firefox/i);

    // A red e2e job that cannot be diagnosed without re-running it locally is
    // ignored within a fortnight.
    expect(config).toMatch(/trace:\s*['"]retain-on-failure['"]|trace:\s*['"]on-first-retry['"]/);
    expect(config).toMatch(/screenshot:\s*['"]only-on-failure['"]/);
  });

  it('runs against the seeded fixtures rather than a second set of test data', () => {
    // A parallel fixture set drifts from `packages/db/src/fixtures.ts` within a
    // month, and then the e2e suite is asserting against tenants the isolation
    // suite has never heard of.
    const files = execFileSync('git', ['ls-files', 'tests/e2e'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.endsWith('.ts'));

    expect(files.length, 'tests/e2e contains no TypeScript').toBeGreaterThan(0);

    const sources = files.map((file) => readFileSync(fromRoot(file), 'utf8')).join('\n');
    expect(sources, 'the harness does not import @kasuwa/db fixtures').toMatch(/@kasuwa\/db/);
  });

  it('never waits on a clock', () => {
    // Determinism over speed. `waitForTimeout` is how a suite becomes flaky,
    // and it is always added to fix a race rather than to express one.
    const files = execFileSync('git', ['ls-files', 'tests/e2e'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.endsWith('.ts'));

    // Without this the loop below passes on an empty directory, which is
    // exactly the state this suite is written in. A vacuous green is the one
    // failure mode a test-of-a-test cannot afford.
    expect(files.length, 'tests/e2e contains no TypeScript').toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(fromRoot(file), 'utf8');
      // Deliberately a raw source grep, comments included. It has no notion
      // of context, so even a comment explaining why the harness does NOT call
      // waitForTimeout trips it — which happened once during T-0008, and the
      // builder reworded the comment rather than touch this test. That is the
      // right trade: the alternative is a matcher that understands comments,
      // and the first person to add `// eslint-disable`-style reasoning around
      // a real call would slip through it.
      expect(source, `${file} uses waitForTimeout — wait on state instead`).not.toMatch(
        /waitForTimeout/,
      );
    }
  });
});

describe('acceptance (pending): the harness measures what it claims to', () => {
  let metrics: HarnessMetrics;
  let runStatus: number | null;

  beforeAll(() => {
    // The whole point of this suite: do not read the harness, run it.
    const run = spawnSync('pnpm', ['test:e2e', '--', '--grep', '@harness'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: HARNESS_RUN_TIMEOUT_MS,
    });

    runStatus = run.status;

    const metricsPath = fromRoot('tests/e2e/.artifacts/harness-metrics.json');
    metrics = existsSync(metricsPath)
      ? (JSON.parse(readFileSync(metricsPath, 'utf8')) as HarnessMetrics)
      : {};
  }, HARNESS_RUN_TIMEOUT_MS);

  it('passes its own self-tests against a real stack', () => {
    expect(runStatus, 'pnpm test:e2e --grep @harness did not exit 0').toBe(0);
  });

  it('reports first-contentful-paint and transferred bytes per profile', () => {
    // Exposed as numbers so a screen test can fail on a budget rather than on
    // an impression.
    for (const profile of ['default', 'low-bandwidth']) {
      const entry = metrics[profile];
      expect(entry, `no metrics recorded for the ${profile} profile`).toBeDefined();
      expect(typeof entry?.fcpMs, `${profile}.fcpMs is not a number`).toBe('number');
      expect(
        typeof entry?.transferredBytes,
        `${profile}.transferredBytes is not a number`,
      ).toBe('number');
      expect(entry?.fcpMs).toBeGreaterThan(0);
      expect(entry?.transferredBytes).toBeGreaterThan(0);
    }
  });

  it('measurably throttles: the same page is slower but no larger', () => {
    const fast = metrics.default;
    const slow = metrics['low-bandwidth'];

    // Same page, same bytes. If the byte counts differ the two runs did not
    // load the same thing, and the comparison says nothing about throttling.
    expect(
      slow?.transferredBytes,
      'the two profiles transferred different bytes — not the same page',
    ).toBe(fast?.transferredBytes);

    // 256 kbps with 300 ms latency against an unthrottled local server is not
    // a subtle difference. A margin this wide will not flake, and a harness
    // that only just clears it has probably stopped throttling.
    expect(
      slow?.fcpMs,
      'low-bandwidth FCP is not meaningfully slower — is the profile applied?',
    ).toBeGreaterThan((fast?.fcpMs ?? 0) * 2);
  });

  it('fails a run when a page exceeds its byte budget', () => {
    // THE IMPORTANT ONE. Demonstrated by a deliberately over-budget fixture,
    // because a budget check observed only passing is indistinguishable from
    // no budget check at all.
    const overBudget = fromRoot('tests/e2e/fixtures/over-budget.spec.ts');
    expect(existsSync(overBudget), 'no over-budget fixture to prove the budget bites').toBe(
      true,
    );

    const run = spawnSync('pnpm', ['test:e2e', '--', '--grep', '@over-budget'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: HARNESS_RUN_TIMEOUT_MS,
    });

    expect(run.status, 'the over-budget fixture passed — the budget asserts nothing').not.toBe(
      0,
    );

    // And it must fail for the stated reason, not because the page 404s.
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    expect(output, 'the failure does not mention the budget').toMatch(/budget/i);
  });

  it('excludes the over-budget fixture from the normal run', () => {
    // It exists to fail. If it runs by default the suite is permanently red,
    // and a permanently red suite is a suite nobody reads.
    const config = readFileSync(fromRoot('tests/e2e/playwright.config.ts'), 'utf8');
    expect(config).toMatch(/over-budget/);
  });
});

describe('acceptance (pending): the harness accumulates no silent exemptions', () => {
  it('drops the axe color-contrast exclusion as soon as a real screen exists', () => {
    // T-0008 excluded axe's `color-contrast` rule on the one page apps/web
    // serves today — the design-tokens gallery, which renders contrast pairs as
    // caption-sized chips, several of them specified against the 3:1 large-text
    // threshold. axe is right about that page, and the page is a demo.
    //
    // The builder documented the exclusion and said it must be deleted when a
    // real screen replaces the gallery. That was a comment, and a comment does
    // not enforce anything — an accessibility exemption inherited by thirty
    // screens is exactly the kind of thing nobody remembers to remove, because
    // by then it has always been there.
    //
    // So this makes it mechanical: the moment `apps/web` grows a second route,
    // the exemption has to go or this fails. Whoever lands T-0007 will meet it.
    const spec = fromRoot('tests/e2e/harness.spec.ts');
    if (!existsSync(spec)) return;

    const excludesContrast = /color-contrast/.test(readFileSync(spec, 'utf8'));
    if (!excludesContrast) return;

    const routes = execFileSync('git', ['ls-files', 'apps/web/app'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((file) => /(^|\/)page\.tsx?$/.test(file));

    expect(
      routes,
      'apps/web has a real screen now — delete the color-contrast exclusion in ' +
        'tests/e2e/harness.spec.ts and let axe block on it',
    ).toHaveLength(1);
  });
});

describe('acceptance (pending): tenancy holds through the browser', () => {
  it('has a test that edits the URL to another tenant record', () => {
    // The API suite already asserts this property. It is asserted again here
    // because the browser is the layer a user actually touches, and a client
    // router that fetches by id before the server checks scope is a real and
    // common way to leak a record the API would have refused.
    const files = execFileSync('git', ['ls-files', 'tests/e2e'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.endsWith('.spec.ts'));

    const sources = files.map((file) => readFileSync(fromRoot(file), 'utf8')).join('\n');

    expect(sources, 'no e2e test references TENANT_B — URL tampering is untested').toMatch(
      /TENANT_B/,
    );
  });

  it('wires @axe-core/playwright', () => {
    // Now, while it costs one line. Retrofitting accessibility assertions
    // across thirty screens is a project; adding them screen by screen is a
    // habit, and the habit only forms if the import already works.
    const manifest = JSON.parse(readFileSync(fromRoot('tests/e2e/package.json'), 'utf8'));
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(deps['@axe-core/playwright'], '@axe-core/playwright is not a dependency').toBeDefined();

    const files = execFileSync('git', ['ls-files', 'tests/e2e'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.endsWith('.ts'));
    const sources = files.map((file) => readFileSync(fromRoot(file), 'utf8')).join('\n');

    expect(sources, 'nothing actually calls axe').toMatch(/AxeBuilder|axe/i);
  });
});

describe('acceptance (pending): CI runs it and keeps the evidence', () => {
  it('adds an e2e job that runs after build', () => {
    const ci = readFileSync(fromRoot('.github/workflows/ci.yml'), 'utf8');

    expect(ci, 'ci.yml has no e2e job').toMatch(/^ {2}e2e:/m);
    expect(ci, 'the e2e job does not depend on build').toMatch(/needs:.*build/);
  });

  it('uploads traces and screenshots when it fails', () => {
    const ci = readFileSync(fromRoot('.github/workflows/ci.yml'), 'utf8');

    expect(ci).toMatch(/upload-artifact/);
    // `if: failure()` — artefacts on a green run are noise, and the upload
    // step being unconditional is the usual reason a failed job has none.
    expect(ci, 'artefacts are not uploaded on failure').toMatch(/if:\s*failure\(\)/);
  });

  it('documents the command', () => {
    // A harness nobody can find is a harness nobody uses. CLAUDE.md section 3
    // is where every agent looks first.
    const claudeMd = readFileSync(fromRoot('CLAUDE.md'), 'utf8');
    expect(claudeMd, 'CLAUDE.md does not mention pnpm test:e2e').toMatch(/pnpm test:e2e/);
  });
});
