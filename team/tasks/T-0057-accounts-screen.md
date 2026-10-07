# T-0057 — Accounts screen (P04)

**status** `not-assigned` (suite to be written; Accounts API is on main, #100) · **owner** Agent 11 · **priority** P1 · **decisions** D-L64, D-L69, D-L78, D-L80, D-P13, D-P21

## Goal
P04's Accounts frames (03, 05 and 06) on the real API (T-0055), in the CRM shell (T-0042), behind a new `crm_accounts` flag.
- **List:**
  - search by name;
  - filter chips for owner, tier, industry, tag and State/LGA;
  - a column chooser;
  - sorting on the never-withheld keys;
  - "Load more" or next/previous paging. There is no "Page X of Y" and there are no live chip counts (D-P13).
- **Field security:** withheld fields show the locked-column treatment, never an empty value.
- **Create and edit:** an account create/edit sheet for writers (admin, or the tenant-admin flag). Non-writers see no write
  controls. A refused write shows a clear message.
- **States:** empty, no results, loading and offline. Offline keeps the list in memory only, never on the device (D-L64); offline
  edits are disabled (D-P21).
- **Hidden:** the Map view (501), Health, bulk actions and deal rollups (D-L69).
- **Rules:**
  - never print a UUID; owner and programme names come from T-0043;
  - all strings through i18n, in every catalogue;
  - no colour literals;
  - byte budget pinned.

## Acceptance tests
`tests/acceptance/records-ui/accounts-screen.acceptance.test.ts` and an e2e spec (`@p04-accounts`), written by the lead.