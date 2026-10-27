# T-0107 — Pipelines and the board API (P06)

**status** `done` (suite to be written) · **owner** Agent 3 · **priority** P1 · **decisions** D-L88, D-L113,
D-L115, D-L120, D-P19, D-P33, D-L97

## Goal
Serve `listPipelines`, `getPipeline` and `getPipelineBoard` from T-0105's contract over T-0106's tables, and flip their
`x-kasuwa-implemented` to `true`. No new table, migration or dependency.
- **Scope:** pipelines are programme-scoped; everything runs in `withTenantTransaction`, with explicit `tenant_id` and
  `programme_id` filters as well as RLS. One 404 body for anything out of scope (404 before 403 before 400).
- **Board:** per stage an exact `count` and per-currency totals over the scoped, filtered set (D-P19). Totals are left out
  when `amount` is withheld; a filter on a withheld field is `400 field_withheld`. Cards page per stage on id-only cursors
  (the T-0084 pattern); won and lost cover `closedSince`, default 90 days, at most 366; `no-store`.
- **Money:** `amountMinor` leaves as a string; a JS `bigint` never reaches `JSON.stringify` (D-L120). Weighted amounts
  are rounded half-even per deal, then summed; never summed across currencies.
- **A programme without a pipeline** (the deploy-window gap, D-L120) is an empty list, never a 500.
- **Plans:** the board's per-stage queries use the 0036 board indexes with no Sort as kasuwa_app (D-P33).

## Acceptance tests
`tests/acceptance/records/pipeline-board-api.acceptance.test.ts`, written by the lead (D-L23). The contract suite,
pipeline-tables and the tenancy folder must still pass unmodified.

## Non-goals
Deal writes and moves (T-0108); pipeline configuration writes (`pipeline.write`, API-only, later); the Kanban (T-0109).
