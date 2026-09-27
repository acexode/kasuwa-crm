import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the Kasuwa end-to-end harness (T-0008).
 *
 * Read `tests/e2e/README.md` before adding a journey. Three things about this
 * file are load-bearing and should not be changed casually:
 *
 * 1. **One browser.** Chromium only. Another engine costs CI minutes on every
 *    pull request and buys nothing until something actually differs between
 *    them — and the network-throttling profile is a Chrome DevTools Protocol
 *    feature, so the low-bandwidth fixture would not work anywhere else.
 *
 * 2. **Evidence on failure.** A trace and a screenshot are retained whenever a
 *    test fails, and CI uploads `.artifacts/` on a red job. A red e2e job that
 *    cannot be diagnosed without re-running it locally is ignored within a
 *    fortnight, and then it is noise rather than a gate.
 *
 * 3. **Two projects, deliberately.** `chromium` is the suite. `over-budget` is
 *    a single fixture that exists to FAIL — it proves the byte budget bites,
 *    because a budget check only ever observed passing is indistinguishable
 *    from one that checks nothing. It is excluded from the normal run by
 *    `testIgnore` below, and `scripts/run-e2e.mjs` only selects it when the
 *    caller greps for `@over-budget`.
 *
 * The stack (Postgres via Testcontainers, the API, the web app and the static
 * fixture server) is started by `scripts/run-e2e.mjs`, not by `webServer` here:
 * the API's DATABASE_URL is only known once the container has a mapped port, so
 * the servers cannot be described statically.
 */

const here = __dirname;

/** Everything a failed run needs, in one directory CI can upload wholesale. */
export const ARTIFACTS_DIR = resolve(here, '.artifacts');

export default defineConfig({
  testDir: here,
  outputDir: resolve(ARTIFACTS_DIR, 'test-results'),

  // Determinism over speed. Retries hide flakiness, and parallel workers make
  // a throughput measurement meaningless — the low-bandwidth profile would be
  // competing with whatever another worker is downloading.
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,

  timeout: 120_000,
  expect: { timeout: 30_000 },

  reporter: [['list'], ['html', { outputFolder: resolve(ARTIFACTS_DIR, 'report'), open: 'never' }]],

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Every navigation in this suite is to a server the harness started, so a
    // hang is a bug rather than a slow network. Bounded, and never a sleep.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The over-budget fixture is expected to fail. If it ran by default the
      // suite would be permanently red, and a permanently red suite is one
      // nobody reads.
      testIgnore: '**/fixtures/over-budget.spec.ts',
    },
    {
      name: 'over-budget',
      use: { ...devices['Desktop Chrome'] },
      testMatch: '**/fixtures/over-budget.spec.ts',
    },
  ],
});
