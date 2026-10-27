# T-0154 — Refresh the trackers

**id** T-0154 · **status** `done` · **owner** Cursor · **priority** P2 · **module** Repo (docs) ·
**PRD** Phase 3 plan S0 · **deps** none · **tier** Docs · **budget** 1 session

## Goal
The trackers say what is true on `main`: nothing merged is still `not-assigned`, `FEATURES.md` is regenerated, and the
`apps/web/CLAUDE.md` route table lists every built screen.

## Context
- Regenerate `team/FEATURES.md` with `node tools/generate-features.mjs` after fixing whatever stale input makes it differ.
- Update `ROADMAP`, `STATUS`, `DESIGN-QUEUE`, the `apps/web/CLAUDE.md` route table, and task `status:` fields (a merged task
  is `done`; `verify-task-readiness` must not get worse).
- **Proposes, does not apply:** the `CLAUDE.md` section 2.6 edit. Write it as a diff in the report; the lead applies it.

## Acceptance tests
No new suite (docs-only). The existing `tests/acceptance/platform/features-register.acceptance.test.ts` must keep passing.

## Done check
`pnpm features:check` is current; `node tools/verify-task-readiness.mjs` lists no task this PR touched; `team/reports/T-0154.md`.
