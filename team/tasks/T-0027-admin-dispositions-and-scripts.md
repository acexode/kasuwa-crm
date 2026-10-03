# T-0027 — Admin API: dispositions and programme scripts

**owner** Agent 3 · **status** `not-assigned` · **priority** P0 · **deps** prep PR · **migration** `0010` · **budget** 2 sessions

## Goal
Build `listDispositions`, `createDisposition`, `reorderDispositions`, `updateDisposition`, `deleteDisposition` and `listProgrammeScripts` per spec. Both are programme-scoped: scope comes from the session via `user_programme`, out-of-scope ids return one identical 404, and RLS filters on `tenant_id` and the programme. Delete the hand-built scripts row in the e2e mock once the spec's `200` example exists (HANDOFF item 4).

## Acceptance test
`tests/acceptance/admin/dispositions-scripts.acceptance.test.ts`

## Done when
The suite passes unmodified in CI; all gates are green; migration-reviewer and tenancy-reviewer pass.
