# T-0022 — Admin API: roles and permission sets

**owner** Agent 1 · **status** `not-assigned` · **priority** P0 · **deps** none · **budget** 2 sessions

## Goal
Implement the `roles` operations of `docs/api/admin.openapi.yaml` (`listRoles`, `createRole`,
`getRole`, `updateRole`, `deleteRole`, `updateRoleHierarchy`) plus `listPermissionSets`, honouring
the spec exactly. New tables `role` and `permission_set` in migration **`0006`** (number reserved),
each RLS enabled + forced, `WITH CHECK` = `USING`, added to `TENANT_SCOPED_TABLES`. Flip each built
operation's `x-kasuwa-implemented` to `true`.

## Acceptance test
`tests/acceptance/admin/roles-api.acceptance.test.ts`

## Done when
- The acceptance suite passes unmodified; lint, typecheck, unit, integration, isolation green.
- A role in tenant A is `404` to tenant B. A hierarchy cycle is rejected.
- `migration-reviewer` and `tenancy-reviewer` pass. Report at `team/reports/T-0022.md`.

## Out of scope
Field-security matrix (needs D-P9's permission-set link; next task) · audit endpoints · programme APIs.
