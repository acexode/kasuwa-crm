# T-0097 — Duplicates and side-by-side merge screen (P28)

**status** `not-assigned` (suite to be written; can start on mocks after T-0093; the real-API run waits on T-0095) ·
**owner** Agent 11 · **priority** P1 · **decisions** D-P12, D-P27, D-P28, D-P14, D-L84, D-L87

## Goal
P28 frames C and C1, behind a new flag `crm_duplicates`, off by default and not production-ready, at
`/contacts/duplicates`.
- **Depends on:** T-0093 (mocks) and T-0095 (live). Build it after T-0096 merges: they share the CRM nav, the catalogues
  and the e2e runner.
- **C:** duplicate sets in the selected programme, with "matches on phone" or "matches on email" and no value shown or
  confidence score. Review opens the merge.
- **C1:**
  - pick the main record, then pick per field;
  - a withheld field shows as withheld and is not choosable;
  - **compliance fields are shown locked, with "the most restrictive choice is kept".** The design's "SMS consent keeps the
    most recent choice" is overruled by D-P28;
  - a confirm dialog;
  - on success, an Undo control (30 days) and a link to the survivor.
- **Merges history** (the Phase 2 recycle bin, D-P27): recent merges with undo where allowed, and "undo expired" after 30
  days.
- **Rights:** controls are shown, and the API's 403 is the gate (D-L84). The `agent` set gets 403 (D-P14).
- **Standard requirements:** i18n (a `duplicates.*` namespace), no colour literals, accessible (a comparison table with
  row headers, radio groups per field), mobile-first (a stacked comparison at 360 px), and a pinned byte budget.
- **Size:** about 500 lines.

## Acceptance tests
`tests/acceptance/records-ui/duplicates-screen.acceptance.test.ts` and `tests/e2e/p28-duplicates.spec.ts` (lead, D-L23),
with a contract-validated mock.

## Non-goals
- a "find duplicates" entry on the contact record;
- merging more than two records at once;
- account merge;
- a general recycle bin for deleted records (no other delete path exists in Phase 2).
