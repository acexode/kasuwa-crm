# T-0096 — Import wizard screen (P28)

**status** `done` (suite to be written; can start on mocks after T-0093; the real-API run waits on T-0094) ·
**owner** Agent 11 · **priority** P1 · **decisions** ADR-0017, D-L128 (ADR-0017 Q4, Q6), D-P28, D-P21, D-L84, D-L87

## Goal
The P28 import wizard (frames A–A6, design in `docs/design/P28/`), behind a new flag `crm_import`, off by default and not
production-ready. It is built against T-0093's contract, on the CRM shell at `/contacts/import`.
- **Depends on:** T-0093 (mocks), T-0094 (live) and T-0092 (the CSP and CORS that make a real upload possible).
- **A, upload:**
  - choose the target programme from the session's programmes;
  - contacts only;
  - a multipart upload straight to the bucket with pause and resume, part retry, and re-requested URLs on expiry;
  - the file is never stored on the device (D-P21).
- **A1:** the 25 MiB limit is stated, with advice. "Split it for me" and "migrate instead" are not built.
- **A2–A3, mapping:**
  - auto-match from the server's suggestion, and "reuse the mapping from a previous import";
  - the required-field checklist, with Continue blocked while incomplete;
  - fields the caller may not edit are not offered (an earlier 403 makes them read-only).
- **A4, phones:** the default country (NG, GH, KE, ZA) and the duplicate rule in words: "exact phone or email in this
  programme is skipped". There is no before-and-after preview of file values and no name-plus-date-of-birth rule (D-P12).
- **A5–A6:**
  - the run polls the job (with backoff), shows live counts, and offers cancel;
  - the result report shows counts and `{ row, column, code }` errors only, plus a link to the Contacts list filtered by
    `importId`;
  - there is no "download bad rows" (D-L128 Q6);
  - D-P28 compliance mapping is shown as restrict-only.
- Import history at `/contacts/import` lists past jobs.
- **Standard requirements:** i18n in every catalogue (under an `import.*` namespace), no colour literals, accessible (a
  labelled step list, live region for progress), mobile-first at 360 px, and a pinned byte budget.
- **Size:** about 550 lines.

## Acceptance tests
`tests/acceptance/records-ui/import-screen.acceptance.test.ts` and `tests/e2e/p28-import.spec.ts` (lead, D-L23), with a
contract-validated mock. One live journey runs on the third web server once T-0094 merges.

## Non-goals
- migration (B–B5), export (D–D1) and DSAR (E–E3): hidden (D-L87);
- a client-side CSV parse or preview, which would add a dependency and hold PII in the page;
- duplicates and merge (T-0097);
- notifications on completion (T-0101 shows `import_finished`).
