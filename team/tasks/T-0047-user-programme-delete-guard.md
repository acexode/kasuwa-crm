# T-0047 — Guard DELETE on `"user"` and `programme` (the second lockout path)

**status** `not-assigned` · **owner** Agent 1 · **priority** P2 (no endpoint deletes either today) · **decisions** D-L55

## Goal
`kasuwa_app` holds DELETE on `"user"` and `programme`, and `user_isolation` is tenant-only. A non-admin can therefore
delete the tenant admin's `"user"` row, or a programme in scope, and the cascade removes memberships. This is the
lockout T-0046 closed for direct deletes. Restrict DELETE on both tables to a tenant admin, using restrictive policies
like 0021, or revoke DELETE if no app path needs it. Users should probably be deactivated (`status`), never deleted.

## Acceptance tests
`tests/acceptance/platform/delete-guard.acceptance.test.ts`, written by the lead.
