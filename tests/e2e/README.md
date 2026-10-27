# `tests/e2e` — the end-to-end harness

Playwright against a real web app, a real API and a Postgres container seeded
from `packages/db/src/fixtures.ts` — the same two tenants, four programmes and
twelve contacts the isolation suite asserts against. Two kinds of spec run on
that stack:

- **Real-stack journeys** (`tenancy.spec.ts`, `bff-session.spec.ts`) talk to the
  API through the web app and assert what the database decides.
- **Screen specs** (most of `p01-…` to `p28-…`; `p02-live.spec.ts` is the live-API exception) serve the API from a **contract mock**:
  `support/*-mock.ts` answers the screen's calls in the browser through
  `page.route`, built from `docs/api/*.openapi.yaml`. A mock tests the screen
  against the contract, never the API, so a screen spec proves nothing about the
  server. The real-stack journeys do.

## Running it: always through the lock

```bash
tools/e2e-locked.sh                          # the whole suite (nightly and slice closes only)
tools/e2e-locked.sh --grep @harness          # just the harness self-tests
tools/e2e-locked.sh --grep @byte-budget      # the sign-in byte budget
tools/e2e-locked.sh --grep @over-budget      # MUST exit non-zero (see below)
tools/e2e-locked.sh --headed                 # watch it
```

`tools/e2e-locked.sh` runs `pnpm test:e2e -- <your arguments>` from the repo root,
and only when it holds the machine-wide lock. Two e2e runs at once crashed Docker
Desktop about eight times, so a second run waits for the first instead of
starting. Do not call `pnpm test:e2e` directly.

- The lock is a directory (`mkdir` is atomic) holding `owner.pid`, at
  `${KASUWA_E2E_LOCK_DIR:-${TMPDIR:-/tmp}/kasuwa-e2e.lock}`. It is outside the
  checkout, so every worktree meets the same lock.
- `KASUWA_E2E_LOCK_DIR` moves it; `KASUWA_E2E_LOCK_TIMEOUT` is how many seconds to
  wait for it (default 3600).
- A lock is stale only when its owner pid is dead, never because it is old. The
  script takes a stale lock over. It never removes a live one, and you should not
  remove one by hand.
- Exit codes: **3** Docker is not running (the script does not start it), **4** the
  wait timed out and the owner pid is in the message. Any other status is the e2e
  command's own.

Docker must be running: the run starts its own Postgres through Testcontainers.
Nothing uses the dev stack's ports, and nothing uses 3000/3001 — every server
binds a free port and `scripts/run-e2e.mjs` writes the URLs to
`.artifacts/stack.json` for the specs to read.

### Suites that start the harness themselves

Some acceptance suites run Playwright through `scripts/run-e2e.mjs` from inside
vitest: `records-ui`, `admin-ui`, `scripting-ui`, `session/` and
`auth-ui/p01-auth-screens`. They start Docker, a build and the servers. To run
only their static checks and skip the harness, filter by name:

```bash
pnpm exec vitest run tests/acceptance/records-ui/accounts-screen.acceptance.test.ts -t "<test name>"
```

Per task, run only the file and the tags your task names. Those suites are not
part of the per-PR gate; they run nightly, on demand and before a slice closes.

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

4. Authenticate the way a browser does. The web app runs in production mode
   with real sign-in, and ADR-0019 put a same-origin BFF in front of the API: the
   browser holds only an HttpOnly `__Host-kasuwa_session` cookie, and the BFF
   forwards it to the API as a bearer token. Stub identity headers
   (`x-kasuwa-tenant-id`, `x-kasuwa-user-id`, ADR-0007) are not how a journey
   signs in any more, and the API refuses them outside stub mode. For a real
   session use `support/bff-session.ts` (it signs in, with MFA, through the BFF).
   What a caller may reach comes from `user_programme`, inside the database. A
   request that names its own scope is the security bug the tenancy suite exists
   to catch — see `tenancy.spec.ts`.

   **Every contract mock must answer `GET /api/v1/auth/me`.** The screens learn who
   the caller is from it (the activities mock, for one, takes the owner of every
   activity from it), so a mock that does not answer it leaves the screen without
   an identity. Copy the answer from `support/auth-mock.generated.ts` rather than
   writing a second one.

5. **Never `waitForTimeout`.** Wait on state: a locator, a response, a load
   state, `expect.poll`. An acceptance test greps this directory for
   `waitForTimeout` and fails the build. A flaky e2e suite is worse than none,
   because it teaches the team to re-run rather than read.

## How to set a budget

PRD 2.13 commits to a workspace that is usable at **256 kbps with 300 ms of
latency**. That commitment survives thirty screens only if each screen fails on
a number.

```ts
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';

test('the contact list stays inside its budget', async ({ page }) => {
  const metrics = await measurePageLoad(page, `${webUrl}/contacts`, 'low-bandwidth');

  assertWithinByteBudget('the contact list', metrics.transferredBytes, 180 * 1024);
  expect(metrics.fcpMs).toBeLessThan(5_000);
});
```

`measurePageLoad` returns `{ fcpMs, transferredBytes }`, both measured through
the Chrome DevTools Protocol. The profiles are in `support/metrics.ts`:

| Profile         | Latency | Throughput  |
| --------------- | ------- | ----------- |
| `default`       | none    | unthrottled |
| `low-bandwidth` | 300 ms  | 256 kbps    |

Pick the budget from what the screen actually needs, not from what it currently
costs. If a screen cannot meet the profile, that is a finding about the screen
and it belongs in `team/DECISIONS.md` — **not** in a relaxed profile here.

### Every number here is a production number (T-0010)

`pnpm test:e2e` runs `next build` for `apps/web` on every run and serves the
result with `next start` — locally and in CI alike, so the two agree. There is
no `next dev` in this harness any more; a budget set against a development
bundle is meaningless in both directions (D-L28). A fresh build per run is
deliberate: a `.next` left over from another checkout would be measured as if
it were the code under review.

### The sign-in critical path (`@byte-budget`)

```bash
pnpm test:e2e -- --grep @byte-budget
```

`support/critical-path.ts` is the only definition of "critical path": on `/`,
the Document, Script, Stylesheet and Font requests sent at or before first
contentful paint, summed as **gzipped transfer** (CDP `encodedDataLength`),
never decoded bytes. `SIGN_IN_CRITICAL_PATH_BUDGET_BYTES` is pinned near the
measured weight, not at the 300,000-byte PRD 2.13 ceiling; the run writes the
full breakdown to `.artifacts/critical-path.json`. If it fails, that file says
which request grew.

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

| Path                   | What                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `harness-metrics.json` | `{ "<profile>": { fcpMs, transferredBytes } }`                |
| `critical-path.json`   | the `@byte-budget` measurement: every request, counted or not |
| `stack.json`           | the URLs this run's servers bound to                          |
| `test-results/`        | traces and screenshots, retained on failure                   |
| `report/`              | the HTML report                                               |

CI uploads the whole directory when the job fails, and only then.
