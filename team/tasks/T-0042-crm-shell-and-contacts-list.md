# T-0042 — CRM app shell and the P04 Contacts list

**status** `not-assigned` · **owner** Agent 11 · **deps** T-0039 (mock), T-0041 (live) · **decisions** D-L60, D-P1

## Goal
Behind a new `crm_records` flag (default off):
- **Shell:** the CRM app shell and nav.
- **`/contacts`:** P04 frame 02 (table, search, filter chips, column chooser, locked columns, programme
  chip) plus frames 05 and 06 (empty, no-results, loading and offline). Desktop and mobile.
- **Data:** a `lib/records-api.ts` following `lib/admin-api.ts`. Mock first, from the contract.
- **Copy:** all strings through i18n. Byte budget pinned.

## Acceptance tests
`tests/acceptance/records-ui/contacts-list.acceptance.test.ts`, written by the lead.
