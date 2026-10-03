# T-0028 — Admin API: programme SLA and retention

**owner** Agent 4 · **status** `not-assigned` · **priority** P0 · **deps** prep PR · **migration** `0011` · **budget** 2 sessions

## Goal
Build `getProgrammeSla`, `updateProgrammeSla`, `getProgrammeRetention` and `updateProgrammeRetention` per spec. Both are programme-scoped. Retention covers record retention only; recording retention belongs to the deferred telephony work (D-T4) and must say so in the response where the spec allows. Durations are explicit units, never bare numbers.

## Acceptance test
`tests/acceptance/admin/sla-retention.acceptance.test.ts`

## Done when
The suite passes unmodified in CI; all gates are green; migration-reviewer and tenancy-reviewer pass.
