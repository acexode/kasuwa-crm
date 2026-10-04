# T-0046 — Permissions-engine hardening (the D-L55 gaps)

**status** `done` (#85) · **owner** Agent 1 · **priority** P1 (before any "assign permissions" endpoint) · **decisions** D-L55, D-L53, D-L51

## Goal
Close the gaps the T-0032 security review left open (D-L55):
1. `user_programme.permission_set_id` is app-writable for any membership in a reachable programme. Restrict it so
   only the tenant-admin path may change a membership's set: a column privilege plus a policy, or a guarded function.
   Pick the design that does not need a third SECURITY DEFINER function. If none exists, escalate.
2. `user_programme` DELETE is tenant-only. Make it programme-scoped like INSERT (D-L51), with the same
   creation-marker discipline if needed.
3. Assert that no `ON UPDATE CASCADE` into `programme` exists, and that no owner or definer trigger writes
   `programme`. Both would be forge paths for the creation marker.

## Acceptance tests
`tests/acceptance/platform/permissions-hardening.acceptance.test.ts`, written by the lead.

**Suite design (H1–H5):**
- A RESTRICTIVE `FOR UPDATE` policy requires the session user to be a tenant admin. A non-admin UPDATE then
  affects 0 rows, and a non-admin INSERT carrying a set fails with 42501.
- Side doors are closed: delete-and-reinsert, rewriting `user_id`, and upsert.
- There are still exactly two SECURITY DEFINER functions.
- **Residual (ADR-0010 class), recorded but not asserted:** a callback can forge `app.user_id` to a tenant admin's id
  and restore it before commit.
