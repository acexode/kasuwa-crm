# Runbook: the `Tenant isolation suite` check is red

**Never merge past it.** Not with an admin override, not "because it is flaky",
not because the change "obviously cannot affect tenancy", not to unblock a demo.
A red isolation check is a stop-the-line condition (Addendum A1 section 3.5).

## What it means

The `isolation` job in `.github/workflows/ci.yml` runs `pnpm test:isolation`:
every file under `tests/acceptance/` that is not `.pending.`, against a real
Postgres with the real RLS policies, the real guard and the real interceptor.
It is the only thing in the pipeline that checks, end to end, that one tenant
or programme cannot read another's data, and that telemetry carries no personal
data.

Red therefore means one of:

1. **A tenancy or PII control is broken.** Assume this first. A change to a
   migration, a policy, a guard, the session code or the telemetry path can
   break isolation in files the diff never touched — which is why this job
   always runs the whole suite and is never narrowed by `nx affected`.
2. **An acceptance test was changed.** The `Guard protected paths` check should
   also be red, or the PR should carry the `lead-approved` label. If neither,
   stop and tell the lead.
3. **The environment failed** (Docker, Testcontainers, Playwright install).
   Recognisable by failing in setup with **zero tests executed**. Re-run once.
   A second identical failure is not "infrastructure" until someone has read it.

## What to do

1. Open the failed run and download the `isolation-test-report` artefact
   (JUnit XML, plus e2e traces and screenshots when the harness tests failed).
   It is uploaded on failure so the build can be read rather than re-run.
2. Find the failing assertion. Its message says which boundary was crossed.
3. Reproduce locally: `pnpm test:isolation` (Docker must be running).
4. Fix the code. If you believe the **test** is wrong, say so in the PR and to
   the lead — that is the only sanctioned way to push back on one.

## What must NOT be done about it

- **Never merge past it**, by any route: admin merge, removing the required
  check, pushing to `main`, or merging a different PR that contains the change.
- Never edit, skip (`it.skip`, `.only` elsewhere), or rename an acceptance test
  to `.pending.` to turn the check green. A hook and the guard both block it.
- Never widen a scope, an RLS policy or a grant to make an assertion pass. If a
  test fails because a caller cannot see something, the caller is probably not
  supposed to see it (`CLAUDE.md` section 6.5).
- Never make the job conditional, `continue-on-error`, or incremental. A
  skipped required check counts as passing on GitHub.
- Never "fix" a PII failure by adding the leaked field to a redaction list.
  Telemetry is allow-listed (`apps/api/src/telemetry/attributes.ts`); remove
  whatever started recording it.

If `main` itself is red on this check, nothing else merges until it is green
again, and the lead is told immediately.

## Required status checks (for @acexode, once GitHub Pro exists — D-L34)

Branch protection is not available on this private repository on the free plan
(D-L34), so today none of these checks can actually block a merge. Once the
account is on Pro: **Settings -> Branches -> Add branch protection rule** (or
**Rules -> Rulesets -> New branch ruleset**) for `main`, then:

- Require a pull request before merging; require review from Code Owners.
- Require status checks to pass before merging; require branches to be up to
  date. Add these checks, by the job names GitHub shows:
  - `Tenant isolation suite` — the blocking tenancy gate. Its own job, never
    conditional, so it can be required on its own.
  - `Guard protected paths` (guard.yml)
  - `Lint`, `Typecheck`, `Unit tests`, `Integration tests`, `Build`,
    `End-to-end`
  - `Secret scan`, `Dependency scan`
- Do not allow bypassing the above settings (untick admin bypass).
- `Direct pushes to main touch bookkeeping only` (bookkeeping-guard.yml) runs on
  push, after the fact; it cannot be a required check. D-L34's carve-out for
  bookkeeping paths needs a ruleset with a path-scoped bypass, or the guard
  stays an alarm.

A check only appears in the picker after it has run once on the repository, so
open one PR with this workflow before configuring the rule.
