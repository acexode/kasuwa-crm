# T-0029 — Admin API: programme create, archive preview, archive

**owner** Agent 6 · **status** `not-assigned` · **priority** P0 · **deps** prep PR · **migration** `0012` · **budget** 2 sessions

## Goal
Build `createProgramme`, `getProgrammeArchivePreview` and `archiveProgramme` per spec. Add a real `programme.status` column (expand only); `listProgrammes` and `getProgramme` read it instead of T-0024's constant `active`. The creator gets a `user_programme` row so the new programme is reachable. Archive is reversible-safe: no data is deleted. Programme creation is written as a function T-0015 provisioning can reuse.

## Acceptance test
`tests/acceptance/admin/programme-lifecycle.acceptance.test.ts`

## Done when
The suite passes unmodified in CI; all gates are green; migration-reviewer and tenancy-reviewer pass.
