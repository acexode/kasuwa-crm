# T-0078 — The admin audit API applies field security to change values

**status** `not-assigned` (suite to be written; after T-0061) · **owner** Agent 1 · **priority** P1 (before any deployed cell) · **decisions** D-L63, D-L72, D-L81

## Goal
From T-0061, a contact update's `audit_event.changes` carry `before` and `after` for D-L72's value fields. `/admin/audit`
(T-0033) returns them as they are stored.
- **Field security.** An admin whose field-security matrix withholds a field in the event's programme must see that change
  as `{ field, redacted: true }`, with no values. The tenant-admin flag does not lift field security (D-L63).
- **The rule applies to every audited object whose fields are field-secured** (contact, account, activity), in list, detail
  and export.

## Acceptance tests
`tests/acceptance/admin/audit-field-security.acceptance.test.ts`, written by the lead.