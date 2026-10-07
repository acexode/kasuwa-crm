# T-0062 — Contact record screen, the 360° view (P05)

**status** `assigned` (suite on `lead/T-0062-acceptance`) · **owner** Agent 11 · **priority** P1 · **decisions** D-L69, D-L72, D-L73, D-L81, D-P21, D-P23

## Goal
P05 frames 01, 02, 05 (field security) and 06 (loading) for a contact, on the real API, behind a new `crm_record_view` flag.
- **Details panel:** driven by the field-security matrix. Withheld fields show the locked treatment.
- **Related:** the account summary, linking to the account record.
- **Timeline (T-0061):**
  - items for field changes, consent changes and activities;
  - before and after values only where the API gives them;
  - actors by name; keyset "load older".
- **Activities:** log a note, task or call, and complete a task, through T-0061's activity endpoints. Who may do it follows
  D-P18.
- **Inline edits:** status and owner for the D-P14/D-P18 sets; full edit for writers.
- **Out of scope:** an out-of-scope record shows the generic not-found page, never the P05 "access denied" page (D-L69).
- **Hidden until their modules exist:** the WhatsApp composer, AI summary, recording playback, NIN last-4, addresses and Follow
  (D-L69).
- **Rules:** never print a UUID; i18n everywhere; no device storage of records (D-L64); byte budget pinned.

## Acceptance tests
`tests/acceptance/records-ui/contact-record.acceptance.test.ts` and an e2e spec (`@p05-contact`), written by the lead.