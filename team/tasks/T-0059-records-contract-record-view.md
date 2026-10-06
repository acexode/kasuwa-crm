# T-0059 — Records contract: the 360° record view (contact side)

**status** `done` (#94) · **owner** Agent 3 · **priority** P1 · **decisions** D-L69, D-L63, D-L64, D-P13, P05 design (exported)

## Goal
Extend `docs/api/records.openapi.yaml` (ADR-0004, the contract only) with what P05's contact record screen needs beyond
T-0041 and T-0043.
- **`GET /contacts/{id}/timeline`:**
  - keyset-paged, newest first;
  - a typed union of items: a field change read from audit, a consent change, and later an activity;
  - a field-change item for a field withheld from the caller is **omitted entirely**, value and name.
- **Related records:** the contact's account summary, `{ id, name } | null`. It is withheld when `accountId` is withheld.
- **Everything else on P05 is marked 501 or left out,** with the module it waits for:
  - WhatsApp composer and the 24-hour window (M08);
  - AI summary (M17);
  - recording playback (ADR-0003);
  - NIN last-4 (D-L13);
  - addresses;
  - follow (P26).
- **Not-found page:** the P05 "access denied" page is not drawn. An out-of-scope record is the generic not-found page (D-L69).

## Acceptance tests
`tests/acceptance/platform/records-contract-record-view.acceptance.test.ts`, written by the lead.

## Escalate if
The timeline needs an `activity` table to be useful. That is T-0060; the contract may reserve the item type now.