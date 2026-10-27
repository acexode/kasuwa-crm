# T-0032 — Permissions engine (closes D-L51, D-L40, and the missing admin 403s)

**owner** Agent 1 · **status** `done` · **priority** P0 · **deps** none · **budget** 3 sessions

## Goal
Decide, in one place, what a session may do, on top of what it may see (RLS already does that).
Permission sets (T-0022) granted per user per programme via `user_programme`; a `can(session, action, programmeId?)` check used by every admin write and sensitive read; `403 not_permitted` where the spec lists it. **D-L51:** tighten `user_programme` INSERT/UPDATE WITH CHECK so membership can only be written for a programme already in scope or created in the same transaction. **D-L40:** create/update programme restricted to tenant admins. An isolation test lists every permissive `FOR INSERT` policy. No new SECURITY DEFINER function without an ADR.

## Acceptance test
`tests/acceptance/platform/permissions.acceptance.test.ts`

## Done when
Suite passes unmodified in CI; every admin write refuses a caller without the permission; migration, tenancy and security reviewers pass.
