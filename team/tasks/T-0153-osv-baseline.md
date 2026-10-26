# T-0153 — The osv-scanner baseline must not simply expire

**id** T-0153 · **status** `assigned` · **owner** Cursor · **priority** P0 (expires **2026-10-31**) · **module** Repo (CI) ·
**PRD** Phase 3 plan S0 (`docs/phase3/PLAN.md`); D-L41, D-L205 #5 · **deps** none ·
**decisions** the 2027-01-31 horizon is proposed here, the lead may move it · **budget** 2 sessions

## Goal
On 2026-11-01 the `Dependency scan` job is still green because each of the 33 baselined findings was read, not
because a date moved. Each is either fixed by an upgrade (its entry deleted) or re-accepted with its own reason:
scope (`dev-only`/`test-only`/`build-only`), a `not reachable:` argument, and `fix:` or `no fixed version`.

## Context
- `osv-scanner.toml` (its header states the policy), `pnpm-lock.yaml`, the scan job in `.github/workflows/ci.yml`.
- Most findings are dev and test tooling (vitest, vite, nx, esbuild, testcontainers' undici and uuid); fixing those
  needs major upgrades, which is not this task. Take cheap **same-major** fixes (minimatch, picomatch, postcss, uuid)
  where the lockfile or an override allows it without breaking a build.
- Run the scanner version pinned in `ci.yml` if you can; if not, say so in the report.

## Acceptance tests
Committed and failing. Do not edit them. `dependency-advisories.acceptance.test.ts` (T-0037) must keep passing.
- `tests/acceptance/platform/osv-baseline.acceptance.test.ts`

## Non-goals
Major upgrades of vitest, vite, nx or testcontainers; any scanner or CI change.

## Definition of done
The named suite passes unmodified; lint, typecheck, unit, integration and isolation pass; any dependency change has a
one-line justification in the PR; `team/reports/T-0153.md` says what was upgraded and what was re-accepted, and why.
