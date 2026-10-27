# T-0093 — Import, duplicates and merge contract (P28)

**status** `done` (suite to be written; no task dependency) · **owner** Agent 3 · **priority** P1 · **decisions**
ADR-0017, D-L128 (ADR-0017 Q4, Q6, Q7), D-P12, D-P27, D-P28, D-P14, D-P17, D-L84, D-L97, D-L23

## Goal
Contract first (ADR-0004), with `x-kasuwa-implemented: false` until T-0094 and T-0095 land. The design is in
`docs/design/P28/` (frames A–A6 and C–C1). The merge operations are here too, so that T-0097 can start on mocks before
T-0095.
- **Depends on:** nothing. **Unblocks:** T-0094, T-0095, T-0096 and T-0097.
- **Where:** `docs/api/records.openapi.yaml`. T-0099 also edits it, so the two run one after the other.

**Imports (contacts only; leads are contacts with a lead status, D-P17):**
- **`POST /imports`** takes `{ programmeId, filename, sizeBytes, contentType }` and returns
  `201 { importId, parts: [{ partNumber, url, sizeBytes }], expiresAt }`.
  - `programmeId` is a record identifier inside the session's scope; outside it, the response is 404.
  - Limits: `sizeBytes` 1..26,214,400 (25 MiB, D-L128 Q4) and at most 4 parts. A part is at least 5 MiB except the last.
  - Accepted types: `text/csv`, `application/csv`, and `application/vnd.ms-excel` with a `.csv` name. Windows browsers
    send the last for CSV.
  - Errors: `400 file_too_large`, `400 unsupported_type`, `403 not_permitted` (`contact.import`).
- **`POST /imports/{id}/upload-urls`** takes `{ partNumbers }` and re-issues expired part URLs while the job is
  `awaiting_upload`. This is how a slow upload resumes.
- **`POST /imports/{id}/complete`** takes `{ parts: [{ partNumber, etag }] }` and returns 202.
  - `422 upload_mismatch` when the size or type differs from the declaration; the job is then `rejected`.
  - **`POST /imports/{id}/abort`** abandons the upload.
- **Statuses:** `awaiting_upload`, `reading_header`, `awaiting_mapping`, `queued`, `running`, `finished`, `failed`,
  `rejected`, `cancelled`, `expired`.
- **`GET /imports/{id}`** and **`GET /imports`** (keyset, newest first, within the session's scope) return:
  - status, `headers` (the file's column names; never a cell) and a suggested mapping;
  - counts `{ created, skipped, failed }`;
  - `errors: [{ row, column, code }]`, capped (the lead pins the cap), with `errorsTruncated`;
  - `rawFileDeletedAt`.
  - No cell value appears anywhere, including in error `detail`.
- **`PUT /imports/{id}/mapping`** takes `{ columns: [{ index, field }], defaultCountry, ownerUserId?, fromImportId? }`.
  - `field` is a contact api name, `custom.<key>` or `null` (ignore).
  - `defaultCountry` is NG, GH, KE or ZA.
  - `ownerUserId` must be a member of the programme (D-L67).
  - `fromImportId` copies an earlier job's mapping by header name. This is the "mapping template" (M21), with no template
    table.
  - Errors: a field the caller may not edit in the programme is `403 field_not_editable`. A required field left unmapped
    is `400 mapping_incomplete`, with the missing api names.
- **Compliance (D-P28):** `dnd` may only be mapped to set `true`. `whatsappOptIn` may only be set `false`. `consentState`
  admits only its restrictive values. A granting value is a row error, `consent_grant_refused`.
- **`POST /imports/{id}/run`** returns `202`. **`POST /imports/{id}/cancel`** is honoured between batches.
- **Row error codes** form a closed enum, among them `invalid_phone`, `invalid_email`, `required`, `too_long`,
  `possible_duplicate`, `consent_grant_refused`, `row_too_large`, `too_many_rows` (over 100,000, D-L128 Q4) and
  `field_not_editable`.
- **`GET /contacts?importId=`** is a new list filter, scoped as every list is. It is how the result report links the
  created contacts.

**Duplicates and merge (D-P12, D-P27, D-P28):**
- **`GET /duplicates?programmeId=&cursor=`** returns sets of contacts matching on exact E.164 phone or lower-cased email,
  within one programme.
  - Each set has `{ matchOn: phone | email, contacts: [{ id, displayName | null, updatedAt }] }`.
  - The matched value is never returned. No confidence score is given: exact only.
- **`GET /contacts/{id}/merge-preview?with={otherId}`** returns both records under field security, the default choice per
  field (from the record updated more recently, if non-empty), and the compliance outcome.
- **`POST /contact-merges`** takes `{ survivorId, mergedId, survivorVersion, mergedVersion, choices: { <field>:
  survivor | merged } }`.
  - Compliance fields are not choosable: `400 compliance_not_choosable`. A withheld or non-editable field is
    `403 field_not_editable`.
  - A different programme is 404 when the caller cannot see the other record, and `400 cross_programme` when they can.
  - Stale versions are 409. An already-merged record is `409 already_merged`.
- **`POST /contact-merges/{id}/undo`** is allowed for the merging user or a tenant admin, for 30 days.
  - After that it is `410 undo_expired`.
  - The response says whether the survivor's fields were reverted (`survivorReverted`).
- **`GET /contact-merges`** (keyset, within scope) is Phase 2's recycle-bin view, since a merge is the only soft delete.
- A merged-away contact is 404 on every contact operation (D-P27).
- **Error bodies** name the path and a code, never the received value.

## Acceptance tests
`tests/acceptance/platform/records-contract-import.acceptance.test.ts` (lead, D-L23). It is contract only, with no
database. Every existing mock still validates (D-L97).

## Non-goals
- migration from Zoho or Salesforce (P28 B–B5), the export centre (D–D1) and DSAR (E–E3): hidden in Phase 2 (D-L87);
- importing accounts, deals or activities;
- fuzzy or name-plus-date-of-birth matching (D-P12: suggestions later);
- a dry run, a client-side preview of file values, and a download of failed rows (D-L128 Q6);
- merging more than two records in one call (repeat the merge);
- merging accounts.
