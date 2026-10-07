# T-0078 — The admin audit API applies field security to change values

**status** `done` (#105) · **owner** Agent 1 · **priority** P1 (before any deployed cell) · **decisions** D-L63, D-L72, D-L81

## Goal
From T-0061, a contact update's `audit_event.changes` carry `before` and `after` for D-L72's value fields. `/admin/audit`
(T-0033) returns them as they are stored.
- **Field security.** An admin whose field-security matrix withholds a field in the event's programme must see that change
  as `{ field, redacted: true }`, with no values. The tenant-admin flag does not lift field security (D-L63).
- **The rule applies to every audited object whose fields are field-secured** (contact, account, activity), in list, detail
  and export.

## Acceptance tests
`tests/acceptance/admin/audit-field-security.acceptance.test.ts`, written by the lead.
## Suite rulings (lead, 2026-10-07)
- **No programme:** a value-carrying event with no `programmeId` is redacted for every reader (F4, fail closed).
- **Objects:** account and activity events follow the same rule (F7).
- **Shape:** a withheld change is kept, as `{ field, redacted: true }` with null or absent values. The timeline omits it instead; that difference is by design.
- **Not built yet:** there is no detail route and no export file. A tripwire guards each, and the export worker needs its own test, which re-resolves scope and the matrix at build time.
- **Also in this task:** `/admin/audit/events` sends `Cache-Control: no-store`.
