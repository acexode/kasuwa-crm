# T-0008 — End-to-end test harness

| Field | Value |
|---|---|
| **id** | T-0008 |
| **status** | `not-assigned` |
| **ready to assign** | **Yes** — acceptance tests written and failing |
| **module** | Cross-cutting |
| **owner** | Agent 12 — QA & Adversarial Testing |
| **priority** | **P0 — unblocks every screen task** |
| **PRD refs** | Founding pack 3.15 (E2E: Playwright, top 30 journeys, low-bandwidth throttled runs, offline); PRD 2.13 |
| **dependencies** | none |
| **decisions** | none blocking |
| **budget** | 3 sessions before escalating |

## Why this is first

T-0007 (the P01 authentication screens) cannot be made ready without it. The
designs have arrived and the acceptance tests cannot be written, because there
is nothing to write them in. The same is true of every screen task after it.

This is the cheapest task on the board with the largest unblocking effect.

## Goal

A screen task can express its acceptance criteria as a browser test that runs in
CI, against the real app and the real API, including on a throttled connection.

## Scope

1. **Playwright**, in `tests/e2e/`, as its own vitest-independent runner.
   - Chromium is enough. Firefox and WebKit are not worth the CI minutes until
     something actually differs.
   - Against a **real stack**: the Testcontainers Postgres from
     `@kasuwa/testing`, a running `apps/api`, and `apps/web`. Not a mock server
     — an e2e suite that mocks the API tests the mock.
2. **A network-condition profile.** PRD 2.13 commits to a workspace usable at
   **256 kbps with 300 ms latency**. The harness must express that as a reusable
   fixture, so a screen test can assert its budget instead of asserting that
   someone remembered to check.
   - Expose transferred bytes and first-contentful-paint so a test can fail on a
     number, not an impression.
3. **A CI job**, after `build`. Traces and screenshots uploaded on failure —
   a red e2e job that cannot be diagnosed without re-running it locally will be
   ignored within a fortnight.
4. **One real journey** proving the harness: sign in with the stub auth headers,
   land on a page, assert something true. Replaced by the real auth journey when
   T-0001 lands.
5. **Seeded fixtures.** Reuse `packages/db/src/fixtures.ts` — the same two
   tenants the isolation suite uses. A second set of test data would drift from
   the first.

## Things worth getting right, because everything copies this

- **Determinism over speed.** A flaky e2e suite is worse than none: it trains
  the team to re-run rather than read. No arbitrary `waitForTimeout`; wait on
  state.
- **The low-bandwidth fixture is the point**, not a nice-to-have. It is the one
  mechanism that keeps the 256 kbps commitment honest once there are thirty
  screens, and it is the first thing that will be skipped under pressure.
- **Tenancy in the browser.** At least one test must confirm that a signed-in
  user cannot reach another tenant's record by editing the URL — the same
  property the API suite asserts, now through the layer a user actually touches.
- **Accessibility hooks.** Wire `@axe-core/playwright` now even if only one test
  uses it. Retrofitting accessibility assertions across thirty screens is a
  project; adding them screen by screen is a habit.

## Non-goals

- The thirty journeys from founding pack 3.15 — this is the harness, not the
  suite.
- Offline and PWA scenarios (needs the service worker, M19).
- Load testing (k6) and visual regression.
- Mobile device emulation beyond one viewport.

## Acceptance tests

**Written.** `tests/acceptance/platform/e2e-harness.pending.acceptance.test.ts`
— 15 assertions, 14 failing today. Run them with `pnpm test:pending`.

Read that file before writing any code: the header states the interface
contract other tasks will depend on (the `@harness` tag, the metrics JSON, the
over-budget fixture). Internals are yours; those five points are not.

The suite does not ask whether the harness exists — it **runs** it as a
subprocess and asserts on the numbers it produced. In particular the byte
budget is proven by a fixture that must make the run exit non-zero, because a
check only ever observed passing is indistinguishable from one that checks
nothing.

Behaviours they name:

- `pnpm test:e2e` runs against a real API and a real database and passes
- the low-bandwidth fixture measurably throttles: the same page reports higher
  FCP and the same transferred bytes under it
- a test can assert a transferred-byte budget and **fails** when the budget is
  exceeded — demonstrated with a deliberately over-budget fixture, not asserted
- a signed-in user cannot reach another tenant's record by URL editing
- failures upload a trace and a screenshot

**Ready.** The tests exist and fail (D-L23 satisfied). Assigning this task
means renaming the file to drop `.pending`, in a lead-approved PR — `pnpm
verify:tasks` fails if the status says otherwise.

## Definition of done

Standard (`CLAUDE.md` section 5), plus:

- [ ] `pnpm test:e2e` works from a clean checkout with Docker running
- [ ] The CI job runs it and uploads artefacts on failure
- [ ] The budget assertion is **demonstrated failing** on an over-budget page,
      then passing. A check only ever seen passing is indistinguishable from one
      that checks nothing.
- [ ] `CLAUDE.md` commands section updated
- [ ] A short note in the task for whoever writes the first screen test: how to
      add a journey, and how to set a budget

## Escalate if

- Playwright cannot drive the stack in CI without a mock. Say so — the answer is
  to fix the stack's startup, not to introduce a mock.
- The 256 kbps profile turns out to be unachievable for the app shell as it
  stands. That is a finding about the app, not about the harness, and it belongs
  in `DECISIONS.md` rather than in a relaxed budget.
