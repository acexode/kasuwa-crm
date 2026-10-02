# T-0024 — Admin API: programmes read and update

**owner** Agent 3 · **status** `not-assigned` · **priority** P0 · **deps** none · **budget** 2 sessions

## Goal
Implement `listProgrammes` and `getProgramme` in full (both `partial` today), `updateProgramme` and
`listProgrammeAgents` (from `user_programme`), exactly as `docs/api/admin.openapi.yaml` specifies.
**No migration** — existing tables only; if a field the spec needs has no column, return what the
spec allows and raise it in the report. Flip each built operation to `x-kasuwa-implemented: true`.

## Acceptance test
`tests/acceptance/admin/programmes-api.acceptance.test.ts`

## Done when
- The suite passes unmodified; all gates green.
- A user sees only programmes in their own `user_programme`; others are `404`.
- `tenancy-reviewer` passes. Report at `team/reports/T-0024.md`.

## Out of scope
create, archive, SLA, dispositions, scripts, retention, portal users (later tasks).
