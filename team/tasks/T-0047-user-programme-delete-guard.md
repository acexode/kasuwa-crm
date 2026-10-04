# T-0047 — Guard DELETE on `"user"` and `programme` (the second lockout path)

**status** `not-assigned` (builder running: Agent 1, `agent1/T-0047-delete-guard`; suite on `lead/T-0047-acceptance` e88bc75) · **owner** Agent 1 · **priority** P1 (raised: tenant and business_unit too) · **decisions** D-L55

## Goal
`kasuwa_app` holds DELETE on `"user"` and `programme`, and `user_isolation` is tenant-only. A non-admin can therefore
delete the tenant admin's `"user"` row, or a programme in scope, and the cascade removes memberships. This is the
lockout T-0046 closed for direct deletes. Restrict DELETE on both tables to a tenant admin, using restrictive policies
like 0021, or revoke DELETE if no app path needs it. Users should probably be deactivated (`status`), never deleted.

## Acceptance tests
`tests/acceptance/platform/delete-guard.acceptance.test.ts`, written by the lead.

**Widened by the suite (2026-10-04).** `business_unit` and `tenant` are also ON DELETE CASCADE and app-deletable.
On main, an A1-only agent deleted `BU_A`, which took A2 with it, and a session with no programme deleted its whole
tenant. **Ruling (lead):** `REVOKE DELETE ON "user", programme, business_unit, tenant FROM kasuwa_app`. No app code
deletes any of them: users are deactivated and programmes archived. A revoke reveals nothing about which rows exist.
