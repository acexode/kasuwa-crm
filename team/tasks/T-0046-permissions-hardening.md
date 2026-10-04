# T-0046 — Permissions-engine hardening (the D-L55 gaps)

**status** `not-assigned` · **owner** Agent 1 · **priority** P1 (before any "assign permissions" endpoint) · **decisions** D-L55, D-L53, D-L51

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
