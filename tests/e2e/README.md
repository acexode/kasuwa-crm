# `tests/e2e` — the end-to-end harness

Playwright against the real stack: the API, the web app, and a Postgres
container seeded from `packages/db/src/fixtures.ts` — the same two tenants,
four programmes and twelve contacts the isolation suite asserts against. There
is no mock server. An e2e suite that mocks the API tests the mock.

```bash
pnpm test:e2e                            # the suite
pnpm test:e2e -- --grep @harness         # just the harness self-tests
pnpm test:e2e -- --grep @over-budget     # MUST exit non-zero (see below)
pnpm test:e2e -- --headed                # watch it
```

Docker must be running: `pnpm test:e2e` starts its own Postgres through
Testcontainers. Nothing uses the dev stack's ports, and nothing uses 3000/3001
— every server binds a free port and `scripts/run-e2e.mjs` writes the URLs to
`.artifacts/stack.json` for the specs to read.

## How to add a journey

1. Put it in `tests/e2e/<area>.spec.ts`.
2. Get your URLs from the harness, never from a constant:

   ```ts
   import { stack } from './support/stack';
   const { webUrl, apiUrl } = stack();
   ```

3. Get your data from `@kasuwa/db`, never from a literal you typed:

   ```ts
   import { TENANT_A, USER_A_AGENT_1, SEED_CONTACTS } from '@kasuwa/db';
   ```

   A second fixture set drifts from the first within a month, and then this
   suite is asserting against tenants the isolation suite has never heard of.

4. Authenticate by asserting an identity, not a scope:

   ```ts
   const context = await browser.newContext({
     extraHTTPHeaders: {
       'x-kasuwa-tenant-id': TENANT_A,
       'x-kasuwa-user-id': USER_A_AGENT_1,
     },
   });
   ```

   These are the stub auth headers (ADR-0007). They say *who* the caller is.
   What they may reach comes from `user_programme`, inside the database. If you
   ever find yourself wanting a header that widens scope, that is the security
   bug the tenancy suite exists to catch — see `tenancy.spec.ts`.

5. **Never `waitForTimeout`.** Wait on state: a locator, a response, a load
   state, `expect.poll`. An acceptance test greps this directory for
   `waitForTimeout` and fails the build. A flaky e2e suite is worse than none,
   because it teaches the team to re-run rather than read.

## How to set a budget

PRD 2.13 commits to a workspace that is usable at **256 kbps with 300 ms of
latency**. That commitment survives thirty screens only if each screen fails on
a number.

```ts
import {
  assertWithinByteBudget,
  measurePageLoad,
} from './support/metrics';

test('the contact list stays inside its budget', async ({ page }) => {
  const metrics = await measurePageLoad(page, `${webUrl}/contacts`, 'low-bandwidth');

  assertWithinByteBudget('the contact list', metrics.transferredBytes, 180 * 1024);
  expect(metrics.fcpMs).toBeLessThan(5_000);
});
```

`measurePageLoad` returns `{ fcpMs, transferredBytes }`, both measured through
the Chrome DevTools Protocol. The profiles are in `support/metrics.ts`:

| Profile | Latency | Throughput |
|---|---|---|
| `default` | none | unthrottled |
| `low-bandwidth` | 300 ms | 256 kbps |

Pick the budget from what the screen actually needs, not from what it currently
costs. If a screen cannot meet the profile, that is a finding about the screen
and it belongs in `team/DECISIONS.md` — **not** in a relaxed profile here.

## Why `fixtures/over-budget.spec.ts` is red on purpose

It loads a 400 KiB page against a 64 KiB budget, and it must fail. A budget
check that has only ever been seen passing is indistinguishable from one that
checks nothing, so the acceptance suite runs it and asserts that the run exits
non-zero with "budget" in the output.

It is in its own Playwright project and excluded from the `chromium` project by
`testIgnore`, so the normal suite never runs it. Do not "fix" it, and do not
move it into the main project.

## Artefacts

Everything a failed run produced lands in `.artifacts/` (git-ignored):

| Path | What |
|---|---|
| `harness-metrics.json` | `{ "<profile>": { fcpMs, transferredBytes } }` |
| `stack.json` | the URLs this run's servers bound to |
| `test-results/` | traces and screenshots, retained on failure |
| `report/` | the HTML report |

CI uploads the whole directory when the job fails, and only then.
