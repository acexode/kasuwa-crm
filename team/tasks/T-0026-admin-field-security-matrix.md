# T-0026 — Admin API: field-security matrix

**owner** Agent 2 · **status** `done` · **priority** P0 · **deps** prep PR · **migration** `0009` · **budget** 2 sessions

## Goal
Build `getFieldSecurityMatrix` and `updateFieldSecurityMatrix` per spec and D-P9: two axes (field × permission set), tenant-level, with no `programmeId`. Store each decision once. Locked permission sets cannot be edited. The write is audited through the T-0025 writer if merged first; otherwise leave an explicit TODO tied to D-L38.

## Acceptance test
`tests/acceptance/admin/field-security-matrix.acceptance.test.ts`

## Done when
The suite passes unmodified in CI; all gates are green; migration-reviewer and tenancy-reviewer pass.
