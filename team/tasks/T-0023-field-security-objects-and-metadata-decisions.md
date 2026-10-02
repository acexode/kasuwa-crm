# T-0023 — `listFieldSecurityObjects`, `api_name` immutability, no `nin`/`bvn` types

**owner** Agent 2 · **status** `not-assigned` · **priority** P0 · **deps** none · **budget** 2 sessions

## Goal
1. Implement `listFieldSecurityObjects` from `docs/api/admin.openapi.yaml`, backed by `object_def`
   and `field_def`; flip it to `x-kasuwa-implemented: true`.
2. **D-P4:** `field_def.api_name` and `object_def.api_name` are immutable after insert, enforced in
   the database (migration **`0007`**, number reserved). Labels stay editable.
3. **D-P5:** remove `nin` (and `bvn` if present) from the field-type set in
   `packages/metadata-engine/src/types.ts` and the `0002` CHECK, via the same new migration.

## Acceptance test
`tests/acceptance/metadata/field-security-objects.acceptance.test.ts`

## Done when
The suite passes unmodified; all gates green; `migration-reviewer` passes; report at
`team/reports/T-0023.md`.
