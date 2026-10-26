# T-0152 — Recreate the e2e lock, and fix the e2e README

**id** T-0152 · **status** `assigned` · **owner** Cursor · **priority** P0 (first of Phase 3 S0) · **module** Repo (tests) ·
**PRD** Phase 3 plan S0 (`docs/phase3/PLAN.md`); brief section 7.2; D-L205 #5 · **deps** none · **budget** 2 sessions

## Goal
Two e2e runs can never overlap on one machine, from any checkout or worktree, and the e2e README tells the truth about
how a journey authenticates. Docker Desktop crashed about eight times when runs overlapped.

## Context
- New `tools/e2e-locked.sh`, bash, committed executable. It runs `pnpm test:e2e -- "$@"` from the repo root.
- The lock is a directory taken with `mkdir`, holding `owner.pid` (as `tools/lead-verify.sh` does). Default
  `${KASUWA_E2E_LOCK_DIR:-${TMPDIR:-/tmp}/kasuwa-e2e.lock}`, outside the checkout so every worktree shares it.
  `KASUWA_E2E_LOCK_TIMEOUT` seconds to wait (default 3600). A stale lock (owner pid dead) is taken over; a live one never.
- Exit 3 when `docker info` fails, exit 4 on a wait timeout, otherwise the e2e command's own status. The lock is
  released on every exit.
- README: replace the stub-auth step (ADR-0019 and the BFF replaced it) and the "no mock server" claim; say every mock
  must answer `GET /api/v1/auth/me`; name the suites that start the harness themselves (`records-ui`, `admin-ui`,
  `scripting-ui`, `session`, `auth-ui/p01-auth-screens`) and `-t "<name>"` to run only their static checks.

## Acceptance tests
Committed and failing. Do not edit them.
- `tests/acceptance/platform/e2e-lock.acceptance.test.ts`

## Non-goals
`pnpm test:e2e` and `scripts/run-e2e.mjs` are unchanged. No e2e spec or mock is touched (pinned by hash).

## Definition of done
The named suite passes unmodified; lint, typecheck, unit and isolation (static parts) pass; `team/reports/T-0152.md`.
