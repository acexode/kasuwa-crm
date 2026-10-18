import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * ACCEPTANCE — T-0093, the records API contract for CSV IMPORT, DUPLICATES
 * and MERGE (P28 frames A–A6 and C–C1; ADR-0017, D-L128 Q4/Q6/Q7, D-L146,
 * D-P12, D-P27, D-P28, D-P14, D-P17, D-L84, D-L97). Agent 3 serves it
 * (T-0094 imports, T-0095 duplicates and merge); Agent 11 draws it (T-0096,
 * T-0097) on mocks first. Contract only: no route, no migration, no code, no
 * database. Written by QA for the lead from the invariants (D-L23, D-L25),
 * before the build.
 *
 * The artefacts under test are `docs/api/records.openapi.yaml` and, for the
 * shared Error envelope's `code` enum only, `docs/api/admin.openapi.yaml`.
 * Both are read as data (parsed YAML, never a regex over the raw text, so a
 * keyword in a YAML comment satisfies nothing). The T-0039 suite keeps the
 * whole-file rules (every `$ref` resolves, unique operationIds, one Error
 * schema, every operation documents 401 and carries x-kasuwa-screens); this
 * suite does not repeat them. Schema rules are checked BEHAVIOURALLY where
 * they can be: a small validator runs fixed accept and refuse cases against
 * the published schema, so the builder chooses the JSON-Schema spelling and
 * the suite only cares what the schema admits.
 *
 * ---------------------------------------------------------------------------
 * PINNED INTERFACES (every name the task file leaves open is a ruling below)
 * ---------------------------------------------------------------------------
 *
 * OPERATIONS (all `x-kasuwa-implemented: false`; tag in brackets)
 *   createImport            POST /api/v1/imports                       201 ImportUpload      [imports]
 *   listImports             GET  /api/v1/imports                       200 ImportPage        [imports]
 *   getImport               GET  /api/v1/imports/{importId}            200 Import            [imports]
 *   issueImportUploadUrls   POST /api/v1/imports/{importId}/upload-urls 200 ImportUpload     [imports]
 *   completeImportUpload    POST /api/v1/imports/{importId}/complete   202 Import            [imports]
 *   abortImportUpload       POST /api/v1/imports/{importId}/abort      200 Import            [imports]
 *   putImportMapping        PUT  /api/v1/imports/{importId}/mapping    200 Import            [imports]
 *   runImport               POST /api/v1/imports/{importId}/run        202 Import            [imports]
 *   cancelImport            POST /api/v1/imports/{importId}/cancel     202 Import            [imports]
 *   listDuplicates          GET  /api/v1/programmes/{programmeId}/duplicates 200 DuplicatePage [duplicates]
 *   getContactMergePreview  GET  /api/v1/contacts/{contactId}/merge-preview?with= 200 ContactMergePreview [duplicates]
 *   createContactMerge      POST /api/v1/contact-merges                201 ContactMerge      [duplicates]
 *   undoContactMerge        POST /api/v1/contact-merges/{mergeId}/undo 200 ContactMerge      [duplicates]
 *   listContactMerges       GET  /api/v1/contact-merges                200 ContactMergePage  [duplicates]
 *   and on listContacts the query parameter `importId` (uuid, flagged false).
 *
 * SCHEMAS (records.openapi.yaml, components.schemas)
 *   ImportStatus           awaiting_upload reading_header awaiting_mapping
 *                          queued running finished failed rejected cancelled
 *                          expired
 *   ImportContentType      text/csv application/csv application/vnd.ms-excel
 *   CreateImportRequest    closed { programmeId, filename, sizeBytes,
 *                          contentType }, all required
 *   ImportUpload           closed { importId, parts, expiresAt }
 *   ImportUploadPart       closed { partNumber, url, sizeBytes }
 *   IssueImportUploadUrlsRequest  closed { partNumbers }
 *   CompleteImportUploadRequest   closed { parts: ImportCompletedPart[] }
 *   ImportCompletedPart    closed { partNumber, etag }
 *   ImportDefaultCountry   NG GH KE ZA
 *   ImportField            a contact api name a column may set, or
 *                          `custom.<key>`
 *   ImportColumnMapping    closed { index, field: ImportField | null }
 *   ImportMapping          closed { columns, defaultCountry, ownerUserId }
 *   PutImportMappingRequest closed { columns | fromImportId, defaultCountry,
 *                          ownerUserId? }
 *   ImportCounts           closed { created, skipped, failed }
 *   ImportRowErrorCode     the closed row-error enum (R9)
 *   ImportRowError         closed { row, column, code }
 *   Import, ImportSummary, ImportPage
 *   DuplicateMatchOn       phone email
 *   DuplicateContact       closed { id, displayName | null, updatedAt }
 *   DuplicateSet           closed { matchOn, contacts }
 *   DuplicatePage
 *   MergeSide              survivor merged
 *   MergeField             the standard fields a merge may choose
 *   MergeChoices           { <MergeField | custom.<key>>: MergeSide }
 *   MergeComplianceOutcome closed { dnd?, whatsappOptIn?, consentState?,
 *                          withheldFields }
 *   ContactMergePreview    closed { survivor, merged, defaults, compliance }
 *   CreateContactMergeRequest closed { survivorId, mergedId,
 *                          survivorVersion, mergedVersion, choices? }
 *   ContactMergeParty      closed { id, displayName | null }
 *   ContactMerge, ContactMergePage
 *
 * ERRORS
 *   Error.code (admin.openapi.yaml) GAINS: import_status_conflict (409),
 *   upload_mismatch (422), already_merged (409), undo_expired (410).
 *   400 details (all under `validation_failed`, `{ path, code }` only):
 *     createImport           sizeBytes file_too_large; contentType
 *                            unsupported_type
 *     putImportMapping       <apiName> mapping_incomplete (one detail per
 *                            missing field); columns.<i>.index unknown_column;
 *                            columns.<i>.field duplicate_mapping; ownerUserId
 *                            unknown_reference; fromImportId unknown_reference
 *     getContactMergePreview with cross_programme; with same_contact
 *     createContactMerge     choices.<compliance field> compliance_not_choosable;
 *                            mergedId cross_programme; mergedId same_contact
 *   403 not_permitted: createImport and every import write (`contact.import`);
 *     putImportMapping detail <apiName> field_not_editable; createContactMerge
 *     detail choices.<field> field_not_editable; undoContactMerge (not the
 *     merging user and not a tenant admin).
 *   404 not_found: every operation with an id, and createImport's
 *     unreachable programmeId.
 *   409 import_status_conflict on every import write in the wrong status;
 *     409 stale_write and 409 already_merged on createContactMerge; 409
 *     already_merged on undoContactMerge; 410 undo_expired; 422
 *     upload_mismatch on completeImportUpload.
 *
 * EXTENSIONS (limits and compliance as data, so a screen and the server read
 * one number)
 *   x-kasuwa-import-limits on createImport: exactly
 *     { maxFileBytes: 26214400, maxParts: 4, minPartBytes: 5242880,
 *       maxRows: 100000, maxRowBytes: 65536, maxColumns: 500,
 *       maxErrors: 1000 }
 *   x-kasuwa-import-compliance on putImportMapping: exactly (D-L148)
 *     { dnd: [true, false], whatsappOptIn: [false],
 *       consentState: [withdrawn, unknown] }
 *   x-kasuwa-compliance-order on createContactMerge: exactly, most
 *     restrictive first,
 *     { dnd: [true, false], whatsappOptIn: [false, true],
 *       consentState: [withdrawn, unknown, pending, opted_in] }
 *
 * ---------------------------------------------------------------------------
 * RULINGS (proposed to the lead; R-numbers are this suite's, not decision ids)
 * ---------------------------------------------------------------------------
 *
 *   R1  Operation ids, paths and schema names are as pinned above. Every
 *       new operation and the `importId` parameter are
 *       `x-kasuwa-implemented: false` until T-0094 and T-0095 serve them
 *       (with lead edits flipping the flag tests, as T-0086 and T-0089 did).
 *       Import ops carry tag `imports` and screens from P28/A..A6; the
 *       duplicates and merge ops carry tag `duplicates` and screens from
 *       P28/C and P28/C1. Both tags are declared at the top of the file.
 *   R2  DUPLICATES TAKE THE PROGRAMME IN THE PATH, NOT THE QUERY. The task
 *       file spells it `GET /duplicates?programmeId=`, but the merged T-0039
 *       suite forbids any query, header or cookie parameter named like
 *       `programmeId` on any operation of this file (CLAUDE.md 2.2), and
 *       that is a security rule this suite will not ask to loosen. The path
 *       form is the existing precedent for a scoped target
 *       (`/pipelines/{pipelineId}/deals`): a programme the caller does not
 *       reach is `404 not_found`, the same body as one that does not exist.
 *       Reported to the lead as a contradiction; the alternative is a lead
 *       edit to T-0039's rule.
 *   R3  Upload (ADR-0017, D-L128 Q4, D-L146): `sizeBytes` 1..26,214,400
 *       (25 MiB), at most 4 parts, every part but the last at least 5 MiB
 *       (5,242,880 bytes), each part's size signed into its URL, URLs valid
 *       for 5 minutes. Over the limit is `400 file_too_large` at `sizeBytes`.
 *       The content type is exactly one of `text/csv`, `application/csv` or
 *       `application/vnd.ms-excel`, and the last only with a filename ending
 *       `.csv` (any case): Windows browsers send it for CSV, and an `.xls`
 *       must not slip in under it. Anything else is `400 unsupported_type`
 *       at `contentType`. Whether `text/csv` with a non-`.csv` name is
 *       admitted is NOT pinned (the task does not say). `filename` is 1..255
 *       characters with no `/`, `\`, NUL or other control character; it is
 *       stored, shown back within scope and never logged, and never appears
 *       in a storage key or URL. It is cleared with the raw file (R22).
 *   R4  `programmeId` on createImport is a TARGET, as on createContact: one
 *       the caller does not reach is `404`, never `403`. Permission is
 *       `contact.import` in that programme, else `403 not_permitted`. The
 *       import READS (getImport, listImports) are also gated on
 *       `contact.import` in the import's programme, answered as scope: an
 *       import in a programme where the caller lacks it is `404` and is not
 *       listed (reads never answer 403). `headers` and `filename` are file
 *       content-adjacent; they are not for every reader of contacts.
 *   R5  Status machine, and `409 import_status_conflict` for a write in a
 *       status that does not admit it: upload-urls, complete and abort in
 *       `awaiting_upload` only; mapping in `awaiting_mapping` only; run in
 *       `awaiting_mapping` with a saved mapping; cancel in `queued` or
 *       `running`, honoured between batches (the 202 may still say
 *       `running`). A size or type that differs from the declaration at
 *       complete is `422 upload_mismatch` and the job becomes `rejected`
 *       (its object deleted). Abort moves the job to `cancelled`. An upload
 *       abandoned for 24 hours becomes `expired`. Abort, run, cancel and
 *       undo take no request body.
 *   R6  Mapping body (`PutImportMappingRequest`, a full replace): exactly
 *       one of `columns` (1..500 `ImportColumnMapping`) or `fromImportId`
 *       (copy an earlier job's mapping by header name: the "mapping
 *       template", M21, with no template table); `defaultCountry` always
 *       required (NG, GH, KE, ZA; phones are normalised to E.164 with it);
 *       `ownerUserId` optional, a member of the programme (D-L67), else
 *       `400 unknown_reference` at `ownerUserId`; an earlier import the
 *       caller cannot see is `400 unknown_reference` at `fromImportId`
 *       (the same body as none). `field` is an `ImportField` or `null`
 *       (ignore the column). ImportField's standard names are exactly the
 *       contact fields a CSV cell may set: displayName, givenNames,
 *       familyName, companyName, phones, emails, status, source, tags,
 *       preferredLanguage, preferredChannel, state, lga, dnd, whatsappOptIn,
 *       consentState; never id, programmeId, version, owner, ownerUserId
 *       (the whole job's owner is the mapping's `ownerUserId`), account,
 *       accountId, phoneNetwork, timestamps or `custom` as a whole. Only
 *       `phones`, `emails` and `tags` may be mapped by more than one column;
 *       any other repeat is `400 duplicate_mapping` at
 *       `columns.<i>.field`; an index beyond the file's headers is
 *       `400 unknown_column` at `columns.<i>.index`.
 *   R7  Errors about a FIELD name the field: `mapping_incomplete` (one
 *       detail per missing api name; the required field is `displayName`,
 *       satisfied by mapping `displayName` or at least one of `givenNames`
 *       and `familyName`), `field_not_editable` (403, the field the caller
 *       may not edit in the programme, `custom.<key>` for a custom field)
 *       and `unknown_field` (a custom key unknown or retired, T-0088).
 *       Errors about a COLUMN name `columns.<i>.<property>`.
 *   R8  COMPLIANCE ON IMPORT (D-P28; AMENDED by D-L148), as data:
 *       `x-kasuwa-import-compliance` lists the only values a mapped
 *       compliance column may write. An import only CREATES contacts
 *       (duplicates are skipped), so a cell may hold a restrictive value or
 *       the new-contact default: `dnd` true or false, `whatsappOptIn` false,
 *       `consentState` withdrawn or unknown. An empty cell leaves the
 *       default. A granting value is the row error `consent_grant_refused`:
 *       `whatsappOptIn` true, `consentState` pending or opted_in. As a rule
 *       the suite checks: each field's admitted values are exactly the
 *       prefix of its `x-kasuwa-compliance-order` (most restrictive first)
 *       that ends at the field's `default` on Contact, so nothing looser
 *       than a new contact's own default can arrive by import.
 *   R9  Row errors: `ImportRowErrorCode` is CLOSED and exactly: required,
 *       invalid_value, invalid_phone, invalid_email, too_long,
 *       unknown_value, unknown_field, custom_too_large, possible_duplicate,
 *       consent_grant_refused, field_not_editable, row_too_large,
 *       too_many_rows. `ImportRowError` is exactly `{ row, column, code }`:
 *       `row` is the row as a spreadsheet shows it (the header is row 1, so
 *       the first data row is 2); `column` is the zero-based index into
 *       `headers`, or `null` for a whole-row error (row_too_large,
 *       too_many_rows, possible_duplicate). `too_many_rows` is ONE error, at
 *       the first row past 100,000, which is not imported. A row over
 *       65,536 bytes is `row_too_large`.
 *   R10 NO CELL VALUE ANYWHERE (ADR-0017 item 4, D-L128 Q6): no property of
 *       any import, duplicate or merge-history schema is named for a value,
 *       sample, cell, preview, raw content or detail; every such object is
 *       closed; error bodies carry `path` and `code` only. `headers` holds
 *       the file's column names, at most 500 of 1..255 characters.
 *   R11 THE ERRORS CAP (left to the lead by the task): `errors` holds at most
 *       1,000 row errors, the lowest row numbers first, and
 *       `errorsTruncated` says whether more were dropped. `counts.failed`
 *       counts every failed row, not just the listed ones.
 *       `counts.skipped` counts rows skipped as possible duplicates (each
 *       also listed as `possible_duplicate` while under the cap).
 *   R12 Import is closed and exactly: id, programmeId, status, filename,
 *       sizeBytes, contentType, headers (null until read), suggestedMapping
 *       (null until read), mapping (null until saved), counts, errors,
 *       errorsTruncated, rawFileDeletedAt (null until the sweeper runs,
 *       D-L146; then `headers` and `filename` are null too, R22),
 *       createdByUserId, createdAt, updatedAt, finishedAt (null
 *       until it ends). ImportSummary, the list row, is the same without
 *       contentType, headers, suggestedMapping, mapping, errors and
 *       errorsTruncated. Users are ids only (no name: D-L64 does not make
 *       this a user directory). Lists are keyset, newest first, `cursor`
 *       and `limit` only, no count (D-P13).
 *   R13 `listContacts?importId=` lists the contacts that import created,
 *       scoped as every list is. An import the caller cannot see answers an
 *       empty page, never a 404 or 400 (no oracle). A screen must not send
 *       it while it is flagged false: the live route ignores unknown
 *       parameters, so it would get unfiltered rows that look filtered
 *       (the D-L75 hazard).
 *   R14 DUPLICATES (D-P12, D-L146): sets of contacts matching on exact
 *       E.164 phone or lower-cased email in one programme. A set is
 *       exactly `{ matchOn, contacts }`, 2..10 contacts (the ten most
 *       recently updated; no count and no "more" flag), each exactly
 *       `{ id, displayName, updatedAt }`, `displayName` null when withheld.
 *       The matched value is never returned and no score is given. A match
 *       on a field withheld from the caller in that programme yields no
 *       sets for that `matchOn` (two rows sharing a hidden number is itself
 *       a fact about the number). Merged-away contacts are never in a set.
 *       The same pair may appear in a phone set and an email set.
 *   R15 MERGE PREVIEW: `contactId` is the survivor and `with` the merged
 *       contact (a required uuid query parameter, the only one). Both are
 *       Contact (field security applied). `defaults` picks, per choosable
 *       field the caller may edit, the side updated more recently if its
 *       value is non-empty, else the other side; it never names a
 *       compliance field or a field withheld on either side. `compliance`
 *       is the outcome by `x-kasuwa-compliance-order` (the most restrictive
 *       value wins whatever the survivor or the date, D-P28), with an
 *       outcome field the caller cannot read omitted and listed in its
 *       `withheldFields`. `with` out of scope is 404; in another programme
 *       the caller can see, `400 cross_programme` at `with`; the same id
 *       twice, `400 same_contact` at `with`.
 *   R16 MERGE: `choices` is optional; an absent choosable field takes the
 *       preview's default. A field the caller may not edit, or that is
 *       withheld, keeps the survivor's value and choosing it is
 *       `403 field_not_editable` at `choices.<field>` (a merge is never a
 *       way round field security). A compliance field is
 *       `400 compliance_not_choosable` at `choices.<field>` and always takes
 *       the most restrictive value. `MergeField` is exactly displayName,
 *       givenNames, familyName, companyName, phones, emails, accountId,
 *       ownerUserId, status, source, tags, preferredLanguage,
 *       preferredChannel, state, lga; `custom.<key>` is also choosable.
 *       Permission: `contact.write` in the programme. Stale versions are
 *       `409 stale_write`. One audit event per merge (D-P12).
 *   R17 404 VERSUS already_merged (the task file says both; this is the
 *       reconciliation): a merged-away contact is 404 on every CONTACT
 *       operation, the paths under `/api/v1/contacts` (D-P27), merge-preview
 *       included. On createContactMerge, an id naming a contact the caller
 *       could read before it was merged away is `409 already_merged`
 *       (the merges history already shows it to them); out of scope it is
 *       404. On undoContactMerge, a survivor since merged away into another
 *       contact is `409 already_merged` (undo the later merge first).
 *   R18 UNDO (D-P12, D-P27, D-L146): by the merging user or a tenant admin,
 *       else 403; until `undoUntil`, which is `mergedAt` plus exactly 30
 *       days, then `410 undo_expired`. The merged contact is restored and
 *       its activities move back. `survivorReverted` is true when the
 *       survivor's chosen fields were put back (the survivor was not edited
 *       since the merge) and false when it was edited and keeps its
 *       current values; null until undone. Undo never loosens a compliance
 *       field on the survivor (D-L146). A repeat undo answers 200 with the
 *       merge unchanged.
 *   R19 ContactMerge is closed and exactly: id, programmeId, survivor,
 *       merged (each a ContactMergeParty `{ id, displayName | null }`, null
 *       when withheld; never a UUID printed as a name, D-L64),
 *       mergedByUserId, mergedAt, undoUntil, undoneAt, undoneByUserId,
 *       survivorReverted. listContactMerges is the Phase 2 recycle bin: a
 *       merge is the only soft delete; keyset, newest first, within scope.
 *   R20 Every answer of every new operation is `Cache-Control: no-store`
 *       (headers, names and file names are personal data). createImport,
 *       completeImportUpload, createContactMerge and undoContactMerge are
 *       `x-kasuwa-audited: true` (ADR-0017's audited events; D-P12).
 *   R21 D-L97: every example on the new operations validates and is
 *       internally coherent (part sizes sum to the declared size; defaults
 *       follow the recency rule; the compliance outcome follows the order;
 *       undo is 30 days); no import, duplicate or merge-history example
 *       holds a phone- or email-like string; every OTHER example in the
 *       file still validates; every e2e mock that reads the contract still
 *       loads.
 *   R22 HEADER ERASURE (D-L148). A headerless CSV puts its first data row
 *       into `headers`, and a filename can name a person, so neither may
 *       outlive the raw file that ADR-0017 makes the erasure mechanism. When
 *       the raw file is deleted (7 days after the job ends, 24 hours after
 *       an abandoned upload), `headers` and `filename` become null on the
 *       import record, in the same step that sets `rawFileDeletedAt`, and
 *       the schemas say why. In every example, `rawFileDeletedAt` set means
 *       `headers` and `filename` null, and `filename` is present until then.
 *       `fromImportId` copies by header name only while the source's
 *       headers still exist; afterwards it is `400 unknown_reference` at
 *       `fromImportId`, the same body as an import the caller cannot see.
 *   R23 SECURITY REVIEW (D-L151), pinned as contract text and shape:
 *       a. Import writes are the creator's: upload-urls, complete, abort,
 *          mapping and run only for the import's `createdByUserId`; anyone
 *          else in scope is `403 not_permitted`. Cancel: the creator or a
 *          tenant admin. The job runs as `createdByUserId`, and re-checks
 *          `contact.import` and scope every batch.
 *       b. `contact.import` is held only by permission sets that also hold
 *          `contact.write` (admin in Phase 2). Setting `ownerUserId` to
 *          another member needs the same right as createContact
 *          (`contact.write`).
 *       c. Undo restores each compliance field of the restored contact at
 *          the more restrictive of its snapshot value and the survivor's
 *          current value; the survivor is never loosened either.
 *       d. The duplicates cursor carries only a contact id, the lowest id in
 *          the last set; sets are ordered by their lowest contact id
 *          ascending; the cursor never carries the matched value.
 *       e. Undo: the merging user who holds `contact.write` in the programme
 *          now, or a tenant admin. All-or-nothing under the undoer's current
 *          field security: a field to revert that is not editable is
 *          `403 not_permitted` / `field_not_editable` and nothing changes.
 *       f. `contact.claim_and_set_status` never permits a merge.
 *       g. listContactMerges is gated on `contact.write` or tenant admin;
 *          after the deferred purge an entry shows ids only.
 *       h. listDuplicates is throttled like search: `429
 *          too_many_requests` with a `Retry-After` header.
 *       i. completeImportUpload checks metadata, not content: the bytes are
 *          untrusted until parsed.
 *       j. Signed part URLs are bearer credentials and are never logged.
 *       k. The import result says duplicates were skipped and no restriction
 *          was applied to existing contacts.
 *
 * LEAD EDITS TO MERGED SUITES (same branch), each the minimum that admits
 * this contract with every other assertion kept, each passing before and
 * after the contract lands:
 *   records-contract (T-0039): its "map view is never silently implemented"
 *   guard matched any operationId containing `map` and any path segment
 *   starting `map`, so `putImportMapping` and `/imports/{importId}/mapping`
 *   would have been forced to answer 501 for ever. The guard now skips
 *   `mapping`; getAccountMap and `/accounts/map` are still caught.
 *   records-contract-activities (T-0081): its "nothing reopens a task" guard
 *   refused any operation named or routed like `undo`. It now admits exactly
 *   undoContactMerge at `/api/v1/contact-merges/{mergeId}/undo` (D-P12);
 *   every other undo, reopen or restore is still refused.
 *   records-contract-leads (T-0056): merge was "not built" (D-P12 open), so
 *   any operation named like merge had to be a 501 stub naming a P04 frame.
 *   The four merge operations, at exactly their pinned paths, are now
 *   exempt; any other merge operation is still held to the stub rule.
 *   records-contract-record-view (T-0059): every operation under
 *   `/api/v1/contacts/{id}/` had to name a P05 frame. getContactMergePreview,
 *   at exactly its pinned path, is a P28/C1 read and is exempt.
 * NOT a suite edit, for the builder: `team/FEATURES.md` is generated from the
 * contract (`pnpm features`), so the features-register suite fails until it is
 * regenerated in the same change.
 *
 * ---------------------------------------------------------------------------
 *
 * D-L23: on main the file has none of this. Every test then fails naming the
 * missing operation, schema, parameter or extension rather than crashing at
 * collection: the specs are loaded lazily. Each negative invariant and each
 * self-check of a helper first requires the contract piece it guards
 * (`gate()`), so none passes on a file without it. The two regression guards
 * at the end (every OTHER example still validates; every e2e mock still
 * loads) hold on main by design: they protect what exists, and say so where
 * they are written.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const RECORDS_REL = 'docs/api/records.openapi.yaml';
const RECORDS = resolve(repoRoot, RECORDS_REL);
const E2E_SUPPORT = resolve(repoRoot, 'tests/e2e/support');

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The text with every run of whitespace collapsed, so a phrase may wrap. */
function prose(text: unknown): string {
  return str(text).replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Loading and $ref resolution (the T-0039 suite's loader, unchanged in kind)
// ---------------------------------------------------------------------------

function posix(file: string): string {
  return relative(repoRoot, file).split('\\').join('/');
}

const docCache = new Map<string, { doc: unknown; error: string | null }>();

function loadDoc(file: string): { doc: unknown; error: string | null } {
  const cached = docCache.get(file);
  if (cached) return cached;
  let entry: { doc: unknown; error: string | null };
  if (!existsSync(file)) {
    entry = { doc: undefined, error: `${posix(file)} does not exist` };
  } else {
    try {
      entry = { doc: parse(readFileSync(file, 'utf8')) as unknown, error: null };
    } catch (error) {
      entry = { doc: undefined, error: `${posix(file)} is not valid YAML: ${(error as Error).message}` };
    }
  }
  docCache.set(file, entry);
  return entry;
}

function spec(file: string = RECORDS): Mapping {
  const { doc, error } = loadDoc(file);
  if (error !== null) throw new Error(`${error} — the contract is missing.`);
  if (!isMapping(doc)) throw new Error(`${posix(file)} does not parse to a mapping`);
  return doc;
}

interface Located {
  node: unknown;
  file: string;
}

function resolveRef(ref: string, fromFile: string): Located | undefined {
  const hash = ref.indexOf('#');
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? '' : ref.slice(hash + 1);
  const file = filePart === '' ? fromFile : resolve(dirname(fromFile), filePart);
  const { doc, error } = loadDoc(file);
  if (error !== null) return undefined;
  let node: unknown = doc;
  if (pointer !== '') {
    if (!pointer.startsWith('/')) return undefined;
    for (const raw of pointer.slice(1).split('/')) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(node)) {
        node = node[Number(key)];
      } else if (isMapping(node) && key in node) {
        node = node[key];
      } else {
        return undefined;
      }
    }
  }
  return node === undefined ? undefined : { node, file };
}

function deref(located: Located): Located {
  let current = located;
  for (let hops = 0; hops < 32; hops += 1) {
    if (!isMapping(current.node) || typeof current.node.$ref !== 'string') return current;
    const ref = current.node.$ref;
    const next = resolveRef(ref, current.file);
    if (next === undefined) throw new Error(`unresolved $ref ${ref} (from ${posix(current.file)})`);
    current = next;
  }
  throw new Error('$ref chain longer than 32 hops (a cycle?)');
}

function at(node: unknown, file: string = RECORDS): Located {
  return deref({ node, file });
}

function child(parent: Located, key: string): Located | undefined {
  if (!isMapping(parent.node) || parent.node[key] === undefined) return undefined;
  return at(parent.node[key], parent.file);
}

function rec(name: string): Located {
  const components = isMapping(spec().components) ? (spec().components as Mapping) : {};
  const schemas = isMapping(components.schemas) ? components.schemas : {};
  if (schemas[name] === undefined) throw new Error(`${RECORDS_REL}: components.schemas.${name} not found`);
  return at({ $ref: `#/components/schemas/${name}` });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

interface Operation {
  id: string;
  method: string;
  path: string;
  op: Mapping;
  params: Located[];
}

function operations(): Operation[] {
  const doc = spec();
  const paths = isMapping(doc.paths) ? doc.paths : {};
  const out: Operation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = at(rawItem).node;
    if (!isMapping(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!isMapping(op)) continue;
      const own = Array.isArray(op.parameters) ? op.parameters : [];
      const params = [...shared, ...own].map((parameter) => at(parameter));
      out.push({ id: str(op.operationId), method, path, op, params });
    }
  }
  return out;
}

function operation(id: string): Operation {
  const found = operations().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`operationId ${id} not found in ${RECORDS_REL}`);
  return found;
}

function paramNode(op: Operation, name: string, where?: string): Mapping | undefined {
  for (const located of op.params) {
    const node = located.node;
    if (isMapping(node) && node.name === name && (where === undefined || node.in === where)) return node;
  }
  return undefined;
}

function paramSchema(op: Operation, name: string, where?: string): Located {
  const node = paramNode(op, name, where);
  if (!node) throw new Error(`${op.id} has no parameter ${name}`);
  return at(node.schema ?? {});
}

function paramNames(op: Operation, where: string): string[] {
  return op.params
    .map((located) => located.node)
    .filter(isMapping)
    .filter((node) => node.in === where)
    .map((node) => str(node.name))
    .sort();
}

function responses(op: Operation): Map<string, Located> {
  const raw = isMapping(op.op.responses) ? op.op.responses : {};
  return new Map(Object.entries(raw).map(([code, value]) => [code, at(value)]));
}

function jsonMedia(holder: Located | undefined): Located | undefined {
  if (!holder) return undefined;
  const content = child(holder, 'content');
  return content ? child(content, 'application/json') : undefined;
}

function jsonSchema(holder: Located | undefined): Located | undefined {
  const media = jsonMedia(holder);
  return media ? child(media, 'schema') : undefined;
}

function responseSchema(op: Operation, status: string): Located {
  const schema = jsonSchema(responses(op).get(status));
  if (!schema) throw new Error(`${op.id} has no ${status} application/json schema`);
  return schema;
}

function requestBody(op: Operation): Located | undefined {
  return op.op.requestBody === undefined ? undefined : at(op.op.requestBody);
}

function requestSchema(op: Operation): Located {
  const schema = jsonSchema(requestBody(op));
  if (!schema) throw new Error(`${op.id} has no application/json request schema`);
  return schema;
}

/** Every example value on a media object, `example` and `examples` alike, by label. */
function examplesOf(media: Located | undefined): [string, unknown][] {
  if (!media || !isMapping(media.node)) return [];
  const out: [string, unknown][] = [];
  if (media.node.example !== undefined) out.push(['example', media.node.example]);
  const examples = child(media, 'examples');
  if (examples && isMapping(examples.node)) {
    for (const key of Object.keys(examples.node)) {
      const example = child(examples, key);
      if (example && isMapping(example.node)) out.push([key, example.node.value]);
    }
  }
  return out;
}

function exampleBodies(holder: Located | undefined): Mapping[] {
  return examplesOf(jsonMedia(holder))
    .map(([, value]) => value)
    .filter(isMapping);
}

function successExamples(op: Operation, status: string): Mapping[] {
  return exampleBodies(responses(op).get(status));
}

function requestExamples(op: Operation): Mapping[] {
  return exampleBodies(requestBody(op));
}

function description(op: Operation): string {
  return prose(op.op.description);
}

function nodeDescription(located: Located | undefined): string {
  return located && isMapping(located.node) ? prose(located.node.description) : '';
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Own and allOf-merged properties, each dereferenced. */
function properties(schema: Located): Map<string, Located> {
  const out = new Map<string, Located>();
  const node = schema.node;
  if (!isMapping(node)) return out;
  for (const part of Array.isArray(node.allOf) ? node.allOf : []) {
    for (const [key, value] of properties(at(part, schema.file))) out.set(key, value);
  }
  const props = child(schema, 'properties');
  if (props && isMapping(props.node)) {
    for (const key of Object.keys(props.node)) {
      const value = child(props, key);
      if (value) out.set(key, value);
    }
  }
  return out;
}

function keysOf(schema: Located): string[] {
  return [...properties(schema).keys()].sort();
}

function required(schema: Located): string[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  return (Array.isArray(node.required) ? node.required.map(str) : []).sort();
}

function isClosed(schema: Located): boolean {
  return isMapping(schema.node) && schema.node.additionalProperties === false;
}

function enumOf(schema: Located): unknown[] {
  const node = schema.node;
  if (!isMapping(node)) return [];
  if (node.const !== undefined && node.const !== null) return [node.const];
  if (Array.isArray(node.enum)) return node.enum.filter((value) => value !== null);
  const items = child(schema, 'items');
  if (items) return enumOf(items);
  const found: unknown[] = [];
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const variants = node[key];
    if (Array.isArray(variants)) found.push(...variants.flatMap((variant) => enumOf(at(variant, schema.file))));
  }
  return found;
}

/**
 * True when `schema` is the named component, directly, through `$ref`, or
 * through a single-part `allOf` wrapper (the usual way to put a description
 * or a flag beside a `$ref`).
 */
function isSchema(schema: Located | undefined, target: Located): boolean {
  if (!schema) return false;
  const current = deref(schema);
  if (current.node === target.node) return true;
  const node = current.node;
  if (isMapping(node) && Array.isArray(node.allOf) && node.allOf.length === 1) {
    return isSchema(at(node.allOf[0], current.file), target);
  }
  return false;
}

/** The items schema of an array property. */
function itemsOf(schema: Located, key: string): Located {
  const prop = properties(schema).get(key);
  const items = prop ? child(deref(prop), 'items') : undefined;
  if (!items) throw new Error(`${key} is not an array with items`);
  return items;
}

function numberAt(schema: Located | undefined, key: string): number | undefined {
  if (!schema) return undefined;
  const node = deref(schema).node;
  if (!isMapping(node)) return undefined;
  const value = node[key];
  if (typeof value === 'number') return value;
  for (const combinator of ['allOf', 'oneOf', 'anyOf']) {
    const variants = node[combinator];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const found = numberAt(at(variant, schema.file), key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// A JSON-Schema validator: the subset these contracts use (the T-0088
// suite's). It is proven to reject broken copies before it is trusted.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function validate(raw: Located, value: unknown, path: string): string[] {
  const schema = deref(raw);
  const node = schema.node;
  if (node === true || (isMapping(node) && Object.keys(node).length === 0)) return [];
  if (node === false) return [`${path}: refused by a false schema`];
  if (!isMapping(node)) return [`${path}: schema is not a mapping`];
  const problems: string[] = [];
  if (Array.isArray(node.allOf)) {
    for (const part of node.allOf) problems.push(...validate(at(part, schema.file), value, path));
  }
  for (const combinator of ['oneOf', 'anyOf'] as const) {
    const variants = node[combinator];
    if (!Array.isArray(variants)) continue;
    const passing = variants.filter((variant) => validate(at(variant, schema.file), value, path).length === 0).length;
    if (combinator === 'oneOf' ? passing !== 1 : passing < 1) {
      problems.push(`${path}: matches ${passing} ${combinator} branches`);
    }
  }
  if (node.not !== undefined && validate(at(node.not, schema.file), value, path).length === 0) {
    problems.push(`${path}: matches a not schema`);
  }
  const actual = jsonType(value);
  if (node.type !== undefined) {
    const allowed = (Array.isArray(node.type) ? node.type : [node.type]).map(str);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      return [...problems, `${path}: ${actual}, not ${allowed.join('|')}`];
    }
  }
  if ('const' in node && node.const !== value) problems.push(`${path}: not ${String(node.const)}`);
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(node.enum)}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof node.minLength === 'number' && length < node.minLength) problems.push(`${path}: too short`);
    if (typeof node.maxLength === 'number' && length > node.maxLength) problems.push(`${path}: too long`);
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern, 'u').test(value)) {
      problems.push(`${path}: does not match ${node.pattern}`);
    }
    if (node.format === 'uuid' && !UUID.test(value)) problems.push(`${path}: not a uuid`);
    if (node.format === 'email' && !EMAIL.test(value)) problems.push(`${path}: not an email`);
    if (node.format === 'date-time' && (!UTC_DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) {
      problems.push(`${path}: not a UTC date-time with a Z`);
    }
  }
  if (typeof value === 'number') {
    if (typeof node.minimum === 'number' && value < node.minimum) problems.push(`${path}: < min`);
    if (typeof node.maximum === 'number' && value > node.maximum) problems.push(`${path}: > max`);
  }
  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) problems.push(`${path}: too few items`);
    if (typeof node.maxItems === 'number' && value.length > node.maxItems) problems.push(`${path}: too many items`);
    if (node.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) problems.push(`${path}: items are not unique`);
    }
    const items = child(schema, 'items');
    if (items) value.forEach((item, index) => problems.push(...validate(items, item, `${path}[${index}]`)));
  }
  if (isMapping(value)) {
    const keys = Object.keys(value);
    if (typeof node.minProperties === 'number' && keys.length < node.minProperties) {
      problems.push(`${path}: fewer than ${node.minProperties} properties`);
    }
    if (typeof node.maxProperties === 'number' && keys.length > node.maxProperties) {
      problems.push(`${path}: more than ${node.maxProperties} properties`);
    }
    const props = isMapping(node.properties) ? node.properties : {};
    const patterns = isMapping(node.patternProperties) ? node.patternProperties : {};
    for (const key of Array.isArray(node.required) ? node.required.map(str) : []) {
      if (!(key in value)) problems.push(`${path}: ${key} is required`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (node.propertyNames !== undefined) {
        problems.push(...validate(at(node.propertyNames, schema.file), key, `${path} key ${JSON.stringify(key)}`));
      }
      const matching = Object.keys(patterns).filter((pattern) => new RegExp(pattern, 'u').test(key));
      for (const pattern of matching) {
        problems.push(...validate(at(patterns[pattern], schema.file), item, `${path}.${key}`));
      }
      if (props[key] !== undefined) {
        problems.push(...validate(at(props[key], schema.file), item, `${path}.${key}`));
      } else if (matching.length === 0) {
        if (node.additionalProperties === false) {
          problems.push(`${path}: ${key} is not a property of this closed object`);
        } else if (isMapping(node.additionalProperties)) {
          problems.push(...validate(at(node.additionalProperties, schema.file), item, `${path}.${key}`));
        }
      }
    }
  }
  return problems;
}

const accepts = (schema: Located, value: unknown): boolean => validate(schema, value, 'v').length === 0;

/** Cases a schema got wrong: accepted refusals and refused acceptances, labelled. */
function caseProblems(schema: Located, good: unknown[], bad: unknown[], wrap: (v: unknown) => unknown = (v) => v): string[] {
  const out: string[] = [];
  for (const value of good) {
    const problems = validate(schema, wrap(value), 'v');
    if (problems.length > 0) out.push(`refused ${JSON.stringify(value)}: ${problems.join('; ')}`);
  }
  for (const value of bad) {
    if (accepts(schema, wrap(value))) out.push(`accepted ${JSON.stringify(value)}`);
  }
  return out;
}

/** A free-standing schema (for self-checks), located in the records file. */
function synthetic(node: Mapping): Located {
  return { node, file: RECORDS };
}

// ---------------------------------------------------------------------------
// The pinned operations
// ---------------------------------------------------------------------------

interface OpSpec {
  id: string;
  method: string;
  path: string;
  success: string;
  schema: string;
  body: string | null;
  statuses: string[];
  tag: 'imports' | 'duplicates';
}

const IMPORTS = '/api/v1/imports';
const IMPORT_ITEM = `${IMPORTS}/{importId}`;
const MERGES = '/api/v1/contact-merges';

const OPS: OpSpec[] = [
  { id: 'createImport', method: 'post', path: IMPORTS, success: '201', schema: 'ImportUpload', body: 'CreateImportRequest', statuses: ['400', '401', '403', '404'], tag: 'imports' },
  { id: 'listImports', method: 'get', path: IMPORTS, success: '200', schema: 'ImportPage', body: null, statuses: ['400', '401'], tag: 'imports' },
  { id: 'getImport', method: 'get', path: IMPORT_ITEM, success: '200', schema: 'Import', body: null, statuses: ['400', '401', '404'], tag: 'imports' },
  { id: 'issueImportUploadUrls', method: 'post', path: `${IMPORT_ITEM}/upload-urls`, success: '200', schema: 'ImportUpload', body: 'IssueImportUploadUrlsRequest', statuses: ['400', '401', '403', '404', '409'], tag: 'imports' },
  { id: 'completeImportUpload', method: 'post', path: `${IMPORT_ITEM}/complete`, success: '202', schema: 'Import', body: 'CompleteImportUploadRequest', statuses: ['400', '401', '403', '404', '409', '422'], tag: 'imports' },
  { id: 'abortImportUpload', method: 'post', path: `${IMPORT_ITEM}/abort`, success: '200', schema: 'Import', body: null, statuses: ['400', '401', '403', '404', '409'], tag: 'imports' },
  { id: 'putImportMapping', method: 'put', path: `${IMPORT_ITEM}/mapping`, success: '200', schema: 'Import', body: 'PutImportMappingRequest', statuses: ['400', '401', '403', '404', '409'], tag: 'imports' },
  { id: 'runImport', method: 'post', path: `${IMPORT_ITEM}/run`, success: '202', schema: 'Import', body: null, statuses: ['400', '401', '403', '404', '409'], tag: 'imports' },
  { id: 'cancelImport', method: 'post', path: `${IMPORT_ITEM}/cancel`, success: '202', schema: 'Import', body: null, statuses: ['400', '401', '403', '404', '409'], tag: 'imports' },
  { id: 'listDuplicates', method: 'get', path: '/api/v1/programmes/{programmeId}/duplicates', success: '200', schema: 'DuplicatePage', body: null, statuses: ['400', '401', '404', '429'], tag: 'duplicates' },
  { id: 'getContactMergePreview', method: 'get', path: '/api/v1/contacts/{contactId}/merge-preview', success: '200', schema: 'ContactMergePreview', body: null, statuses: ['400', '401', '404'], tag: 'duplicates' },
  { id: 'createContactMerge', method: 'post', path: MERGES, success: '201', schema: 'ContactMerge', body: 'CreateContactMergeRequest', statuses: ['400', '401', '403', '404', '409'], tag: 'duplicates' },
  { id: 'undoContactMerge', method: 'post', path: `${MERGES}/{mergeId}/undo`, success: '200', schema: 'ContactMerge', body: null, statuses: ['400', '401', '403', '404', '409', '410'], tag: 'duplicates' },
  { id: 'listContactMerges', method: 'get', path: MERGES, success: '200', schema: 'ContactMergePage', body: null, statuses: ['400', '401'], tag: 'duplicates' },
];

const IMPORT_WRITES = ['issueImportUploadUrls', 'completeImportUpload', 'abortImportUpload', 'putImportMapping', 'runImport', 'cancelImport'];
const NO_BODY = ['abortImportUpload', 'runImport', 'cancelImport', 'undoContactMerge'];
const AUDITED = ['createImport', 'completeImportUpload', 'createContactMerge', 'undoContactMerge'];
const IMPORT_FRAMES = /^P28\/A[1-6]?$/;
const MERGE_FRAMES = /^P28\/C1?$/;

/** Every new operation, or a failure naming the first missing: a gate for negative invariants. */
function gate(): Operation[] {
  return OPS.map((spec) => operation(spec.id));
}

const op = (id: string): Operation => operation(id);

// ---------------------------------------------------------------------------
// Fixed values and cases. Every value is invented.
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;
const MAX_FILE = 25 * MIB;
const MIN_PART = 5 * MIB;

const LIMITS = {
  maxFileBytes: 26214400,
  maxParts: 4,
  minPartBytes: 5242880,
  maxRows: 100000,
  maxRowBytes: 65536,
  maxColumns: 500,
  maxErrors: 1000,
};

const STATUSES = ['awaiting_mapping', 'awaiting_upload', 'cancelled', 'expired', 'failed', 'finished', 'queued', 'reading_header', 'rejected', 'running'];
const CONTENT_TYPES = ['application/csv', 'application/vnd.ms-excel', 'text/csv'];
const COUNTRIES = ['GH', 'KE', 'NG', 'ZA'];
const ROW_CODES = [
  'consent_grant_refused',
  'custom_too_large',
  'field_not_editable',
  'invalid_email',
  'invalid_phone',
  'invalid_value',
  'possible_duplicate',
  'required',
  'row_too_large',
  'too_long',
  'too_many_rows',
  'unknown_field',
  'unknown_value',
];
const IMPORT_FIELDS = [
  'companyName',
  'consentState',
  'displayName',
  'dnd',
  'emails',
  'familyName',
  'givenNames',
  'lga',
  'phones',
  'preferredChannel',
  'preferredLanguage',
  'source',
  'state',
  'status',
  'tags',
  'whatsappOptIn',
];
const MERGE_FIELDS = [
  'accountId',
  'companyName',
  'displayName',
  'emails',
  'familyName',
  'givenNames',
  'lga',
  'ownerUserId',
  'phones',
  'preferredChannel',
  'preferredLanguage',
  'source',
  'state',
  'status',
  'tags',
];
const COMPLIANCE_FIELDS = ['consentState', 'dnd', 'whatsappOptIn'];
const COMPLIANCE_ORDER: Record<string, unknown[]> = {
  dnd: [true, false],
  whatsappOptIn: [false, true],
  consentState: ['withdrawn', 'unknown', 'pending', 'opted_in'],
};
const IMPORT_COMPLIANCE: Record<string, unknown[]> = {
  dnd: [true, false],
  whatsappOptIn: [false],
  consentState: ['withdrawn', 'unknown'],
};
/** The new-contact defaults, as Contact declares them (R8 reads them from the schema). */
const NEW_CONTACT_DEFAULTS: Record<string, unknown> = { dnd: false, whatsappOptIn: false, consentState: 'unknown' };

const IMPORT_KEYS = [
  'contentType',
  'counts',
  'createdAt',
  'createdByUserId',
  'errors',
  'errorsTruncated',
  'filename',
  'finishedAt',
  'headers',
  'id',
  'mapping',
  'programmeId',
  'rawFileDeletedAt',
  'sizeBytes',
  'status',
  'suggestedMapping',
  'updatedAt',
];
const SUMMARY_KEYS = ['counts', 'createdAt', 'createdByUserId', 'filename', 'finishedAt', 'id', 'programmeId', 'rawFileDeletedAt', 'sizeBytes', 'status', 'updatedAt'];
const MERGE_KEYS = ['id', 'merged', 'mergedAt', 'mergedByUserId', 'programmeId', 'survivor', 'survivorReverted', 'undoUntil', 'undoneAt', 'undoneByUserId'];

const PID = '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01';
const UID = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01';
const IID = '5e1a2b3c-4d5e-4f60-8a1b-2c3d4e5f6a01';
const NUL = String.fromCharCode(0);

const createBody = (over: Mapping = {}): Mapping => ({
  programmeId: PID,
  filename: 'sample-customers.csv',
  sizeBytes: 1048576,
  contentType: 'text/csv',
  ...over,
});
const omit = (value: Mapping, key: string): Mapping => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const GOOD_CREATE = [
  createBody(),
  createBody({ sizeBytes: 1 }),
  createBody({ sizeBytes: MAX_FILE }),
  createBody({ contentType: 'application/csv' }),
  createBody({ contentType: 'application/vnd.ms-excel', filename: 'Sample Export.CSV' }),
  createBody({ contentType: 'application/vnd.ms-excel', filename: 'sample.csv' }),
  createBody({ filename: 'a.csv' }),
  createBody({ filename: `${'x'.repeat(251)}.csv` }),
];
const BAD_CREATE = [
  createBody({ sizeBytes: 0 }),
  createBody({ sizeBytes: MAX_FILE + 1 }),
  createBody({ sizeBytes: 100 * MIB }),
  createBody({ sizeBytes: 1.5 }),
  createBody({ sizeBytes: '1048576' }),
  createBody({ sizeBytes: -1 }),
  createBody({ contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  createBody({ contentType: 'text/plain' }),
  createBody({ contentType: 'TEXT/CSV' }),
  createBody({ contentType: 'text/csv; charset=utf-8' }),
  createBody({ contentType: 'application/vnd.ms-excel', filename: 'sample.xls' }),
  createBody({ contentType: 'application/vnd.ms-excel', filename: 'sample.csv.xls' }),
  createBody({ contentType: 'application/vnd.ms-excel', filename: 'csv' }),
  createBody({ contentType: 'application/vnd.ms-excel', filename: 'sample.xlsx' }),
  createBody({ filename: '' }),
  createBody({ filename: 'folder/sample.csv' }),
  createBody({ filename: 'folder\\sample.csv' }),
  createBody({ filename: `sample${NUL}.csv` }),
  createBody({ filename: 'sample\n.csv' }),
  createBody({ filename: `${'x'.repeat(252)}.csv` }),
  createBody({ programmeId: 'not-a-uuid' }),
  createBody({ programmeIds: [PID] }),
  createBody({ tenantId: PID }),
  createBody({ key: 'tenant/x/programme/y/import/z' }),
  omit(createBody(), 'programmeId'),
  omit(createBody(), 'filename'),
  omit(createBody(), 'sizeBytes'),
  omit(createBody(), 'contentType'),
];

const mappingBody = (over: Mapping = {}): Mapping => ({
  columns: [
    { index: 0, field: 'givenNames' },
    { index: 1, field: 'familyName' },
    { index: 2, field: 'phones' },
    { index: 3, field: null },
  ],
  defaultCountry: 'NG',
  ...over,
});

const GOOD_MAPPING = [
  mappingBody(),
  mappingBody({ ownerUserId: UID }),
  mappingBody({ ownerUserId: null }),
  mappingBody({ defaultCountry: 'ZA', columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'custom.tier__c' }] }),
  { fromImportId: IID, defaultCountry: 'KE' },
  { fromImportId: IID, defaultCountry: 'GH', ownerUserId: UID },
  mappingBody({ columns: Array.from({ length: 500 }, (_, index) => ({ index, field: null })) }),
];
const BAD_MAPPING = [
  mappingBody({ fromImportId: IID }),
  { defaultCountry: 'NG' },
  omit(mappingBody(), 'defaultCountry'),
  { fromImportId: IID },
  mappingBody({ defaultCountry: 'US' }),
  mappingBody({ defaultCountry: 'ng' }),
  mappingBody({ defaultCountry: 'NGA' }),
  mappingBody({ defaultCountry: null }),
  mappingBody({ columns: [] }),
  mappingBody({ columns: Array.from({ length: 501 }, (_, index) => ({ index, field: null })) }),
  mappingBody({ columns: [{ index: -1, field: 'givenNames' }] }),
  mappingBody({ columns: [{ index: 500, field: 'givenNames' }] }),
  mappingBody({ columns: [{ index: 1.5, field: 'givenNames' }] }),
  mappingBody({ columns: [{ index: 0 }] }),
  mappingBody({ columns: [{ field: 'givenNames' }] }),
  mappingBody({ columns: [{ index: 0, field: 'givenNames', header: 'First name' }] }),
  mappingBody({ columns: [{ index: 0, field: 'givenNames', sample: 'x' }] }),
  mappingBody({ columns: [{ index: 0, field: 'id' }] }),
  mappingBody({ ownerUserId: 'me' }),
  mappingBody({ fromImportId: 'not-a-uuid' }),
  mappingBody({ programmeId: PID }),
  mappingBody({ dryRun: true }),
];

const GOOD_FIELDS = [...IMPORT_FIELDS, 'custom.tier__c', 'custom.loan_product__c'];
const BAD_FIELDS = [
  'id',
  'programmeId',
  'version',
  'owner',
  'ownerUserId',
  'account',
  'accountId',
  'phoneNetwork',
  'createdAt',
  'updatedAt',
  'withheldFields',
  'custom',
  'custom.',
  'custom.tier',
  'custom.Tier__c',
  'Custom.tier__c',
  'custom.tier__c.x',
  'phone',
  'email',
  'displayname',
  'DisplayName',
  '',
  null,
  3,
];

const GOOD_ROW_ERRORS = [
  { row: 2, column: 0, code: 'invalid_phone' },
  { row: 100001, column: null, code: 'too_many_rows' },
  { row: 17, column: 499, code: 'consent_grant_refused' },
  { row: 5, column: null, code: 'possible_duplicate' },
];
const BAD_ROW_ERRORS = [
  { row: 1, column: 0, code: 'required' },
  { row: 0, column: 0, code: 'required' },
  { row: 2.5, column: 0, code: 'required' },
  { row: 2, column: -1, code: 'required' },
  { row: 2, column: 0, code: 'not_a_code' },
  { row: 2, column: 0, code: 'invalid_string' },
  { row: 2, column: 'Phone', code: 'invalid_phone' },
  { row: 2, column: 0 },
  { column: 0, code: 'required' },
  { row: 2, code: 'required' },
  { row: 2, column: 0, code: 'invalid_phone', value: '0803' },
  { row: 2, column: 0, code: 'invalid_phone', detail: 'x' },
  { row: 2, column: 0, code: 'invalid_phone', message: 'x' },
  { row: 2, column: 0, code: 'invalid_phone', header: 'Phone' },
];

const GOOD_CHOICES = [{}, { status: 'merged' }, { givenNames: 'survivor', phones: 'merged', 'custom.tier__c': 'merged' }, Object.fromEntries(MERGE_FIELDS.map((field) => [field, 'survivor']))];
const BAD_CHOICES = [
  { status: 'both' },
  { status: 'newest' },
  { status: true },
  { status: null },
  { id: 'merged' },
  { programmeId: 'merged' },
  { version: 'merged' },
  { createdAt: 'merged' },
  { updatedAt: 'merged' },
  { withheldFields: 'merged' },
  { owner: 'merged' },
  { account: 'merged' },
  { phoneNetwork: 'merged' },
  { custom: 'merged' },
  { 'custom.tier': 'merged' },
  { 'custom.Tier__c': 'merged' },
  [],
  'merged',
];

const mergeBody = (over: Mapping = {}): Mapping => ({
  survivorId: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01',
  mergedId: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e02',
  survivorVersion: 3,
  mergedVersion: 1,
  choices: { status: 'merged' },
  ...over,
});
const GOOD_MERGE = [mergeBody(), omit(mergeBody(), 'choices'), mergeBody({ choices: {} })];
const BAD_MERGE = [
  omit(mergeBody(), 'survivorId'),
  omit(mergeBody(), 'mergedId'),
  omit(mergeBody(), 'survivorVersion'),
  omit(mergeBody(), 'mergedVersion'),
  mergeBody({ survivorVersion: 0 }),
  mergeBody({ mergedVersion: '1' }),
  mergeBody({ survivorId: 'x' }),
  mergeBody({ mergedIds: ['3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e03'] }),
  mergeBody({ programmeId: PID }),
  mergeBody({ choices: { status: 'both' } }),
  mergeBody({ choices: [] }),
];

/** Property names that would carry a cell, a matched value or a score (R10, R14). */
const VALUE_NAME = /value|sample|cell|preview|^raw(?!FileDeletedAt$)|content(?!Type$)|detail|message|line|score|confidence|similarity|matched|^phones?$|^emails?$|e164|^key$/i;

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function detailsOf(body: Mapping): Mapping[] {
  return Array.isArray(body.details) ? body.details.filter(isMapping) : [];
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isMapping(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

/** Error examples of one status on one operation. */
function errorExamples(id: string, status: string): Mapping[] {
  return exampleBodies(responses(op(id)).get(status));
}

/** True when some error example of the status has `code` and (optionally) a detail at a path matching `path` with `detail`. */
function hasError(id: string, status: string, code: string, path?: RegExp, detail?: string): boolean {
  return errorExamples(id, status).some((body) => {
    if (body.code !== code) return false;
    if (path === undefined || detail === undefined) return true;
    return detailsOf(body).some((d) => path.test(str(d.path)) && d.code === detail);
  });
}

/** Every schema reachable from `roots`, by a short label, each visited once. */
function reachable(roots: [string, Located][]): [string, Located][] {
  const out: [string, Located][] = [];
  const seen = new Set<unknown>();
  const visit = (label: string, raw: Located, depth: number): void => {
    if (depth > 40) return;
    const schema = deref(raw);
    if (seen.has(schema.node)) return;
    seen.add(schema.node);
    out.push([label, schema]);
    const node = schema.node;
    if (!isMapping(node)) return;
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
      const variants = node[key];
      if (Array.isArray(variants)) variants.forEach((variant, i) => visit(`${label}/${key}${i}`, at(variant, schema.file), depth + 1));
    }
    const items = child(schema, 'items');
    if (items) visit(`${label}[]`, items, depth + 1);
    const props = child(schema, 'properties');
    if (props && isMapping(props.node)) {
      for (const key of Object.keys(props.node)) {
        const value = child(props, key);
        if (value) visit(`${label}.${key}`, value, depth + 1);
      }
    }
  };
  for (const [label, schema] of roots) visit(label, schema, 0);
  return out;
}

/** R10/R14: the properties in a schema tree that are named for a value; empty when right. */
function valueNamedProperties(roots: [string, Located][]): string[] {
  const out: string[] = [];
  for (const [label, schema] of reachable(roots)) {
    const node = schema.node;
    if (!isMapping(node) || !isMapping(node.properties)) continue;
    for (const key of Object.keys(node.properties)) if (VALUE_NAME.test(key)) out.push(`${label}.${key}`);
  }
  return out;
}

/** R10: the object schemas in a tree that are not closed; empty when right. */
function openObjects(roots: [string, Located][]): string[] {
  const out: string[] = [];
  for (const [label, schema] of reachable(roots)) {
    const node = schema.node;
    if (!isMapping(node) || !isMapping(node.properties)) continue;
    // An untyped combinator branch is a constraint on its parent (the vnd.ms-excel `.csv` rule
    // spelled as anyOf), not an object of its own; the parent's closedness governs.
    if (/\/(anyOf|oneOf|allOf)\d+$/.test(label) && node.type === undefined) continue;
    if (node.additionalProperties !== false) out.push(label);
  }
  return out;
}

/**
 * R8 (D-L148): the compliance rule as data, checked against the order and the
 * new-contact defaults: each field admits exactly the restrictive-first
 * prefix of its order that ends at its default. Empty when right.
 */
function importComplianceProblems(rule: unknown, order: unknown, defaults: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!isMapping(rule)) return ['x-kasuwa-import-compliance is not a mapping'];
  if (!isMapping(order)) return ['x-kasuwa-compliance-order is not a mapping'];
  for (const field of Object.keys(rule)) if (!COMPLIANCE_FIELDS.includes(field)) problems.push(`${field} is not a compliance field`);
  for (const field of COMPLIANCE_FIELDS) {
    const admitted = rule[field];
    const ranked = order[field];
    if (!Array.isArray(admitted) || admitted.length === 0) {
      problems.push(`${field}: no admitted values`);
      continue;
    }
    if (!Array.isArray(ranked) || ranked.length === 0) {
      problems.push(`${field}: no order`);
      continue;
    }
    const end = ranked.indexOf(defaults[field]);
    if (end === -1) {
      problems.push(`${field}: the default ${JSON.stringify(defaults[field])} is not in the order`);
      continue;
    }
    const expected = ranked.slice(0, end + 1);
    if (JSON.stringify(admitted) !== JSON.stringify(expected)) {
      problems.push(`${field}: admits ${JSON.stringify(admitted)}, the restrictive values up to the default are ${JSON.stringify(expected)}`);
    }
  }
  return problems;
}

/** R22: import examples that keep a filename or headers past erasure, or lose the filename before it; empty when right. */
function importErasureProblems(rows: [string, Mapping][]): string[] {
  const problems: string[] = [];
  for (const [label, row] of rows) {
    const erased = row.rawFileDeletedAt !== null && row.rawFileDeletedAt !== undefined;
    if (erased && row.filename !== null) problems.push(`${label}: filename kept after the raw file was deleted`);
    if (erased && 'headers' in row && row.headers !== null) problems.push(`${label}: headers kept after the raw file was deleted`);
    if (!erased && (typeof row.filename !== 'string' || row.filename.length === 0)) problems.push(`${label}: filename missing before the raw file was deleted`);
  }
  return problems;
}

/** R15: the merge outcome of two compliance values under the order. */
function mostRestrictive(field: string, a: unknown, b: unknown): unknown {
  const ranked = COMPLIANCE_ORDER[field] ?? [];
  const ia = ranked.indexOf(a);
  const ib = ranked.indexOf(b);
  if (ia === -1 || ib === -1) return undefined;
  return ia <= ib ? a : b;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function withheldOf(record: Mapping): string[] {
  return Array.isArray(record.withheldFields) ? record.withheldFields.map(str) : [];
}

/** R15 on data: what a preview example gets wrong; empty when right. */
function previewProblems(label: string, preview: Mapping): string[] {
  const problems: string[] = [];
  const survivor = isMapping(preview.survivor) ? preview.survivor : {};
  const merged = isMapping(preview.merged) ? preview.merged : {};
  const defaults = isMapping(preview.defaults) ? preview.defaults : {};
  const compliance = isMapping(preview.compliance) ? preview.compliance : {};
  if (survivor.programmeId !== merged.programmeId) problems.push(`${label}: survivor and merged are in different programmes`);
  if (survivor.id === merged.id) problems.push(`${label}: survivor and merged are the same contact`);
  const survivorNewer = Date.parse(str(survivor.updatedAt)) >= Date.parse(str(merged.updatedAt));
  const withheld = new Set([...withheldOf(survivor), ...withheldOf(merged)]);
  for (const [field, side] of Object.entries(defaults)) {
    if (COMPLIANCE_FIELDS.includes(field)) {
      problems.push(`${label}: defaults names the compliance field ${field}`);
      continue;
    }
    if (withheld.has(field)) {
      problems.push(`${label}: defaults names ${field}, withheld on a side`);
      continue;
    }
    if (field.startsWith('custom.')) continue;
    const newer = survivorNewer ? survivor : merged;
    const newerSide = survivorNewer ? 'survivor' : 'merged';
    const olderSide = survivorNewer ? 'merged' : 'survivor';
    const expected = isEmptyValue(newer[field]) ? olderSide : newerSide;
    if (side !== expected) problems.push(`${label}: defaults.${field} is ${String(side)}, the recency rule says ${expected}`);
  }
  const outcomeWithheld = Array.isArray(compliance.withheldFields) ? compliance.withheldFields.map(str) : [];
  for (const field of COMPLIANCE_FIELDS) {
    if (outcomeWithheld.includes(field)) {
      if (field in compliance) problems.push(`${label}: compliance.${field} is withheld but present`);
      continue;
    }
    if (!(field in compliance)) {
      problems.push(`${label}: compliance.${field} is neither present nor withheld`);
      continue;
    }
    if (field in survivor && field in merged) {
      const expected = mostRestrictive(field, survivor[field], merged[field]);
      if (compliance[field] !== expected) problems.push(`${label}: compliance.${field} is ${JSON.stringify(compliance[field])}, the most restrictive is ${JSON.stringify(expected)}`);
    }
  }
  return problems;
}

/** R21: strings in an example that look like a phone number or an email; empty when right. */
function identifierLikeStrings(value: unknown): string[] {
  return stringsIn(value).filter((text) => {
    if (UUID.test(text) || UTC_DATE_TIME.test(text) || /^https?:\/\//.test(text) || /^"[^"]*"$/.test(text)) return false;
    return text.includes('@') || text.replace(/[^0-9]/g, '').length >= 7;
  });
}

/** Every value used in a request example of the new operations (R10: an error never echoes one). */
function requestValues(): string[] {
  const out = new Set<string>();
  for (const spec of OPS) {
    for (const body of requestExamples(op(spec.id))) for (const text of stringsIn(body)) out.add(text);
  }
  // Field names, codes and country codes are schema, not values: an error may name them.
  return [...out].filter(
    (text) => [...text].length >= 4 && !UUID.test(text) && !/^[a-z][A-Za-z0-9_]*$/.test(text) && !/^custom\./.test(text) && !/^[A-Z]{2}$/.test(text),
  );
}

/** R10: what an error example gets wrong: extra detail keys or an echoed value; empty when right. */
function echoProblems(label: string, body: Mapping, values: string[]): string[] {
  const problems: string[] = [];
  for (const detail of detailsOf(body)) {
    const keys = Object.keys(detail).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['code', 'path'])) problems.push(`${label}: a detail carries ${keys.join(', ')}, not path and code only`);
  }
  for (const text of stringsIn(body)) {
    for (const value of values) if (text.includes(value)) problems.push(`${label}: echoes ${value}`);
  }
  return problems;
}

/** Every example in the file paired with its schema: request bodies and responses. */
function allExamples(): { label: string; schema: Located | undefined; value: unknown; op: Operation; status: string }[] {
  const out: { label: string; schema: Located | undefined; value: unknown; op: Operation; status: string }[] = [];
  for (const operationItem of operations()) {
    const body = requestBody(operationItem);
    for (const [label, value] of examplesOf(jsonMedia(body))) {
      out.push({ label: `${operationItem.id} request ${label}`, schema: jsonSchema(body), value, op: operationItem, status: 'request' });
    }
    for (const [status, response] of responses(operationItem)) {
      for (const [label, value] of examplesOf(jsonMedia(response))) {
        out.push({ label: `${operationItem.id} ${status} ${label}`, schema: jsonSchema(response), value, op: operationItem, status });
      }
    }
  }
  return out;
}

function errorCodeEnum(): string[] {
  const error = responseSchema(op('createImport'), '400');
  const code = properties(error).get('code');
  return code ? enumOf(code).map(str) : [];
}

function noStore(response: Located): boolean {
  const headers = child(response, 'headers');
  const header = headers ? child(headers, 'Cache-Control') : undefined;
  if (!header) return false;
  const schema = child(header, 'schema');
  return schema !== undefined && JSON.stringify(enumOf(schema)) === JSON.stringify(['no-store']);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('acceptance: import, duplicates and merge contract (T-0093)', () => {
  describe('the operations (R1, R2)', () => {
    for (const spec of OPS) {
      it(`${spec.id} is ${spec.method.toUpperCase()} ${spec.path}, tag ${spec.tag}, answering ${spec.success} ${spec.schema}`, () => {
        const found = op(spec.id);
        expect(`${found.method} ${found.path}`).toBe(`${spec.method} ${spec.path}`);
        expect(found.op.tags, `${spec.id} tags`).toEqual([spec.tag]);
        const successes = [...responses(found).keys()].filter((code) => /^2\d\d$/.test(code));
        expect(successes, `${spec.id} success statuses`).toEqual([spec.success]);
        expect(isSchema(responseSchema(found, spec.success), rec(spec.schema)), `${spec.id} ${spec.success} is ${spec.schema}`).toBe(true);
      });
    }

    it('both tags are declared at the top of the file', () => {
      gate();
      const tags = Array.isArray(spec().tags) ? (spec().tags as unknown[]).filter(isMapping).map((tag) => str(tag.name)) : [];
      expect(tags).toEqual(expect.arrayContaining(['imports', 'duplicates']));
    });

    it('screens: import operations draw P28/A..A6, duplicates and merge P28/C and C1; the list and both merge steps name their frame', () => {
      const problems: string[] = [];
      for (const spec of OPS) {
        const screens = op(spec.id).op['x-kasuwa-screens'];
        const list = Array.isArray(screens) ? screens.map(str) : [];
        if (list.length === 0) problems.push(`${spec.id}: no screens`);
        const allowed = spec.tag === 'imports' ? IMPORT_FRAMES : MERGE_FRAMES;
        for (const screen of list) if (!allowed.test(screen)) problems.push(`${spec.id}: ${screen} is not a ${spec.tag} frame`);
      }
      expect(problems).toEqual([]);
      expect(op('listDuplicates').op['x-kasuwa-screens'], 'listDuplicates').toContain('P28/C');
      expect(op('getContactMergePreview').op['x-kasuwa-screens'], 'getContactMergePreview').toContain('P28/C1');
      expect(op('createContactMerge').op['x-kasuwa-screens'], 'createContactMerge').toContain('P28/C1');
    });

    for (const spec of OPS) {
      it(`${spec.id} documents ${spec.statuses.join(', ')}${spec.method === 'get' ? ', and never 403 (a read)' : ''}`, () => {
        const found = [...responses(op(spec.id)).keys()];
        expect(found, spec.id).toEqual(expect.arrayContaining(spec.statuses));
        if (spec.method === 'get') expect(found, `${spec.id}: an out-of-scope read is 404, never 403`).not.toContain('403');
      });
    }

    it('every path id is a uuid: importId, programmeId, contactId, mergeId', () => {
      const problems: string[] = [];
      let checked = 0;
      for (const spec of OPS) {
        const found = op(spec.id);
        for (const name of paramNames(found, 'path')) {
          checked += 1;
          const schema = paramSchema(found, name, 'path');
          const node = schema.node;
          if (!isMapping(node) || node.format !== 'uuid' || node.type !== 'string') problems.push(`${spec.id}: ${name} is not a uuid string`);
        }
      }
      expect(problems).toEqual([]);
      // Not vacuous: seven import item operations, listDuplicates, merge-preview and undo.
      expect(checked).toBe(10);
    });

    it('R2: duplicates take the programme in the PATH; no new operation takes a programme, tenant or scope in a query, header or cookie', () => {
      const offending: string[] = [];
      for (const found of gate()) {
        for (const located of found.params) {
          const node = located.node;
          if (!isMapping(node) || node.in === 'path') continue;
          if (/programme|tenant|scope|owner/i.test(str(node.name)) || (node.in === 'header' && /^x-kasuwa-/i.test(str(node.name)))) {
            offending.push(`${found.id}: ${str(node.in)} ${str(node.name)}`);
          }
        }
      }
      expect(offending).toEqual([]);
      expect(paramNames(op('listDuplicates'), 'path')).toEqual(['programmeId']);
    });

    it('the lists take cursor and limit only; merge-preview takes `with` only, a required uuid', () => {
      for (const id of ['listImports', 'listDuplicates', 'listContactMerges']) {
        expect(paramNames(op(id), 'query'), `${id} query parameters`).toEqual(['cursor', 'limit']);
        expect(paramNames(op(id), 'header'), `${id} header parameters`).toEqual([]);
      }
      const preview = op('getContactMergePreview');
      expect(paramNames(preview, 'query')).toEqual(['with']);
      expect(paramNode(preview, 'with', 'query')?.required, 'with is required').toBe(true);
      expect(isMapping(paramSchema(preview, 'with', 'query').node) ? (paramSchema(preview, 'with', 'query').node as Mapping).format : undefined).toBe('uuid');
      for (const id of ['getImport', 'issueImportUploadUrls', 'completeImportUpload', 'abortImportUpload', 'putImportMapping', 'runImport', 'cancelImport', 'createImport', 'createContactMerge', 'undoContactMerge']) {
        expect(paramNames(op(id), 'query'), `${id} takes a query parameter`).toEqual([]);
      }
    });

    it('the pages are { data, nextCursor } with no total, count or offset anywhere (D-P13)', () => {
      const pages: [string, string][] = [
        ['ImportPage', 'ImportSummary'],
        ['DuplicatePage', 'DuplicateSet'],
        ['ContactMergePage', 'ContactMerge'],
      ];
      for (const [page, row] of pages) {
        const schema = rec(page);
        expect(keysOf(schema), page).toEqual(['data', 'nextCursor']);
        expect(required(schema), page).toEqual(['data', 'nextCursor']);
        expect(isClosed(schema), `${page} closed`).toBe(true);
        expect(isSchema(itemsOf(schema, 'data'), rec(row)), `${page}.data[] is ${row}`).toBe(true);
        expect(accepts(properties(schema).get('nextCursor') ?? synthetic({}), null), `${page}.nextCursor admits null`).toBe(true);
      }
      const counting = reachable(pages.map(([page]) => [page, rec(page)] as [string, Located]))
        .flatMap(([label, schema]) => (isMapping(schema.node) && isMapping(schema.node.properties) ? Object.keys(schema.node.properties).map((key) => `${label}.${key}`) : []))
        .filter((path) => /total|count(?!s$)|offset|\.page$|more$|estimate/i.test(path.split('.').pop() ?? ''));
      expect(counting).toEqual([]);
    });

    it('abort, run, cancel and undo take no request body; the other writes take a required, closed one', () => {
      for (const id of NO_BODY) expect(requestBody(op(id)), `${id} takes a body`).toBeUndefined();
      for (const spec of OPS.filter((candidate) => candidate.body !== null)) {
        const body = requestBody(op(spec.id));
        expect(isMapping(body?.node) ? body.node.required : undefined, `${spec.id} body required`).toBe(true);
        expect(isSchema(requestSchema(op(spec.id)), rec(str(spec.body))), `${spec.id} body is ${String(spec.body)}`).toBe(true);
        expect(isClosed(rec(str(spec.body))), `${String(spec.body)} closed`).toBe(true);
      }
    });
  });

  describe('createImport: the upload (R3, R4)', () => {
    it('CreateImportRequest: exactly programmeId, filename, sizeBytes, contentType, all required', () => {
      const schema = rec('CreateImportRequest');
      expect(keysOf(schema)).toEqual(['contentType', 'filename', 'programmeId', 'sizeBytes']);
      expect(required(schema)).toEqual(['contentType', 'filename', 'programmeId', 'sizeBytes']);
    });

    it('it admits 1..25 MiB, the three content types, vnd.ms-excel only with a .csv name, and a safe filename; it refuses the rest', () => {
      expect(caseProblems(rec('CreateImportRequest'), GOOD_CREATE, BAD_CREATE)).toEqual([]);
    });

    it('(self-check, R3) the cases admit a faithful schema and catch one without the .csv rule or with a 100 MB cap', () => {
      rec('CreateImportRequest');
      const props = {
        programmeId: { type: 'string', format: 'uuid' },
        filename: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\\\u0000-\\u001f\\u007f]+$' },
        sizeBytes: { type: 'integer', minimum: 1, maximum: MAX_FILE },
        contentType: { type: 'string', enum: CONTENT_TYPES },
      };
      const csvRule = [
        { properties: { contentType: { enum: ['text/csv', 'application/csv'] } } },
        { properties: { contentType: { const: 'application/vnd.ms-excel' }, filename: { pattern: '\\.[cC][sS][vV]$' } } },
      ];
      const base = { type: 'object', additionalProperties: false, required: ['programmeId', 'filename', 'sizeBytes', 'contentType'] };
      const faithful = synthetic({ ...base, properties: props, anyOf: csvRule });
      expect(caseProblems(faithful, GOOD_CREATE, BAD_CREATE), 'the cases refuse a faithful schema').toEqual([]);
      const noCsvRule = synthetic({ ...base, properties: props });
      expect(caseProblems(noCsvRule, GOOD_CREATE, BAD_CREATE).length, 'no .csv rule').toBeGreaterThan(0);
      const big = synthetic({ ...base, properties: { ...props, sizeBytes: { type: 'integer', minimum: 1, maximum: 100 * MIB } }, anyOf: csvRule });
      expect(caseProblems(big, GOOD_CREATE, BAD_CREATE).length, '100 MB').toBeGreaterThan(0);
    });

    it('ImportContentType is exactly text/csv, application/csv, application/vnd.ms-excel; CreateImportRequest.contentType uses it', () => {
      expect(enumOf(rec('ImportContentType')).map(str).sort()).toEqual(CONTENT_TYPES);
      const contentType = properties(rec('CreateImportRequest')).get('contentType');
      expect(isSchema(contentType, rec('ImportContentType')), 'contentType is ImportContentType').toBe(true);
    });

    it('ImportUpload: closed { importId, parts 1..4 ImportUploadPart, expiresAt }; a part is closed { partNumber 1..4, url, sizeBytes 1..25 MiB }', () => {
      const upload = rec('ImportUpload');
      expect(isClosed(upload)).toBe(true);
      expect(keysOf(upload)).toEqual(['expiresAt', 'importId', 'parts']);
      expect(required(upload)).toEqual(['expiresAt', 'importId', 'parts']);
      const parts = properties(upload).get('parts');
      expect(numberAt(parts, 'minItems')).toBe(1);
      expect(numberAt(parts, 'maxItems')).toBe(4);
      expect(isSchema(itemsOf(upload, 'parts'), rec('ImportUploadPart'))).toBe(true);
      const part = rec('ImportUploadPart');
      expect(isClosed(part)).toBe(true);
      expect(keysOf(part)).toEqual(['partNumber', 'sizeBytes', 'url']);
      expect(required(part)).toEqual(['partNumber', 'sizeBytes', 'url']);
      const good = { partNumber: 1, url: 'https://storage.example/upload?part=1', sizeBytes: MIN_PART };
      expect(caseProblems(part, [good, { ...good, partNumber: 4, sizeBytes: 1 }, { ...good, sizeBytes: MAX_FILE }], [
        { ...good, partNumber: 0 },
        { ...good, partNumber: 5 },
        { ...good, sizeBytes: 0 },
        { ...good, sizeBytes: MAX_FILE + 1 },
        { ...good, key: 'tenant/x' },
        omit(good, 'url'),
      ])).toEqual([]);
      expect(accepts(properties(upload).get('expiresAt') ?? synthetic({}), '2026-10-18T09:05:00Z')).toBe(true);
      expect(accepts(properties(upload).get('expiresAt') ?? synthetic({}), '2026-10-18 09:05')).toBe(false);
    });

    it('x-kasuwa-import-limits is exactly the seven limits (D-L128 Q4, D-L146; the errors cap is R11)', () => {
      expect(op('createImport').op['x-kasuwa-import-limits']).toEqual(LIMITS);
    });

    it('the limits agree with the schemas: file size, part count, columns, mapping index and the errors cap', () => {
      const limits = op('createImport').op['x-kasuwa-import-limits'];
      if (!isMapping(limits)) throw new Error('createImport has no x-kasuwa-import-limits');
      expect(numberAt(properties(rec('CreateImportRequest')).get('sizeBytes'), 'maximum'), 'sizeBytes maximum').toBe(limits.maxFileBytes);
      expect(numberAt(properties(rec('ImportUpload')).get('parts'), 'maxItems'), 'parts').toBe(limits.maxParts);
      expect(numberAt(properties(rec('Import')).get('errors'), 'maxItems'), 'errors').toBe(limits.maxErrors);
      expect(numberAt(properties(rec('Import')).get('headers'), 'maxItems'), 'headers').toBe(limits.maxColumns);
      expect(numberAt(properties(rec('ImportColumnMapping')).get('index'), 'maximum'), 'index').toBe(Number(limits.maxColumns) - 1);
      expect(numberAt(properties(rec('PutImportMappingRequest')).get('columns'), 'maxItems'), 'columns').toBe(limits.maxColumns);
    });

    it('the description states the rules: contact.import, 404 for an unreachable programme, 25 MiB, 4 parts, 5 MiB, the .csv rule, 5-minute URLs, no filename in a key', () => {
      const text = description(op('createImport'));
      expect(text).toMatch(/`contact\.import`/);
      expect(text).toMatch(/404/);
      expect(text).toMatch(/25 MiB/);
      expect(text).toMatch(/4 parts/);
      expect(text).toMatch(/5 MiB/);
      expect(text).toMatch(/application\/vnd\.ms-excel/);
      expect(text).toMatch(/\.csv/);
      expect(text).toMatch(/5 minutes/);
      expect(text).toMatch(/filename/i);
      expect(text).toMatch(/never (logged|in a (storage )?key)/i);
    });

    it('errors: 400 file_too_large at sizeBytes and unsupported_type at contentType; 403 not_permitted; 404 not_found', () => {
      expect(hasError('createImport', '400', 'validation_failed', /^sizeBytes$/, 'file_too_large'), 'file_too_large').toBe(true);
      expect(hasError('createImport', '400', 'validation_failed', /^contentType$/, 'unsupported_type'), 'unsupported_type').toBe(true);
      expect(hasError('createImport', '403', 'not_permitted'), '403').toBe(true);
      expect(hasError('createImport', '404', 'not_found'), '404').toBe(true);
    });

    it('the examples: parts sum to the declared size, numbered 1..n, n <= 4, every part but the last >= 5 MiB; no URL carries the filename', () => {
      const requests = requestExamples(op('createImport'));
      const answers = successExamples(op('createImport'), '201');
      expect(requests.length, 'a request example').toBeGreaterThan(0);
      expect(answers.length, 'a 201 example').toBeGreaterThan(0);
      const [request] = requests;
      const problems: string[] = [];
      for (const answer of answers) {
        const parts = Array.isArray(answer.parts) ? answer.parts.filter(isMapping) : [];
        const sizes = parts.map((part) => Number(part.sizeBytes));
        if (request && sizes.reduce((a, b) => a + b, 0) !== request.sizeBytes) problems.push(`parts sum to ${sizes.reduce((a, b) => a + b, 0)}, not ${String(request.sizeBytes)}`);
        if (parts.length < 1 || parts.length > 4) problems.push(`${parts.length} parts`);
        parts.forEach((part, index) => {
          if (part.partNumber !== index + 1) problems.push(`part ${index} is numbered ${String(part.partNumber)}`);
          if (index < parts.length - 1 && Number(part.sizeBytes) < MIN_PART) problems.push(`part ${index + 1} is under 5 MiB and not the last`);
          const stem = str(request?.filename).replace(/\.[^.]*$/, '').toLowerCase();
          if (stem.length > 0 && str(part.url).toLowerCase().includes(stem)) problems.push(`part ${index + 1} URL carries the filename`);
        });
      }
      expect(problems).toEqual([]);
      // The example must exercise multipart, or the 5 MiB rule is checked on nothing.
      expect(answers.some((answer) => Array.isArray(answer.parts) && answer.parts.length >= 2), 'a multipart example').toBe(true);
    });
  });

  describe('upload-urls, complete and abort (R5)', () => {
    it('IssueImportUploadUrlsRequest: closed { partNumbers: 1..4 unique integers 1..4 }', () => {
      const schema = rec('IssueImportUploadUrlsRequest');
      expect(keysOf(schema)).toEqual(['partNumbers']);
      expect(required(schema)).toEqual(['partNumbers']);
      const wrap = (partNumbers: unknown): unknown => ({ partNumbers });
      expect(caseProblems(schema, [[1], [4], [1, 2, 3, 4], [3, 1]], [[], [0], [5], [1, 1], [1.5], ['1'], [1, 2, 3, 4, 1], null], wrap)).toEqual([]);
      expect(accepts(schema, { partNumbers: [1], importId: IID })).toBe(false);
    });

    it('CompleteImportUploadRequest: closed { parts: 1..4 ImportCompletedPart }; a part is closed { partNumber 1..4, etag 1..256 }', () => {
      const schema = rec('CompleteImportUploadRequest');
      expect(keysOf(schema)).toEqual(['parts']);
      expect(required(schema)).toEqual(['parts']);
      expect(isSchema(itemsOf(schema, 'parts'), rec('ImportCompletedPart'))).toBe(true);
      const part = (partNumber: unknown, etag: unknown = '"9b2cf535f27731c974343645a3985328"'): Mapping => ({ partNumber, etag });
      const wrap = (parts: unknown): unknown => ({ parts });
      expect(caseProblems(schema, [[part(1)], [part(1), part(2), part(3), part(4)]], [
        [],
        [part(0)],
        [part(5)],
        [part(1), part(2), part(3), part(4), part(1)],
        [part(1, '')],
        [part(1, 'x'.repeat(257))],
        [{ partNumber: 1 }],
        [{ ...part(1), sizeBytes: 10 }],
      ], wrap)).toEqual([]);
    });

    it('upload-urls re-issues expired URLs in awaiting_upload only (how a slow upload resumes); complete and abort likewise', () => {
      const issue = description(op('issueImportUploadUrls'));
      expect(issue).toMatch(/`awaiting_upload`/);
      expect(issue).toMatch(/expire/i);
      expect(issue).toMatch(/resum/i);
      expect(description(op('completeImportUpload'))).toMatch(/`awaiting_upload`/);
      expect(description(op('abortImportUpload'))).toMatch(/`awaiting_upload`/);
      expect(description(op('abortImportUpload'))).toMatch(/`cancelled`/);
    });

    it('complete: a size or type that differs from the declaration is 422 upload_mismatch and the job is rejected', () => {
      const text = description(op('completeImportUpload'));
      expect(text).toMatch(/upload_mismatch/);
      expect(text).toMatch(/`rejected`/);
      expect(hasError('completeImportUpload', '422', 'upload_mismatch'), '422 example').toBe(true);
      for (const body of errorExamples('completeImportUpload', '422')) expect(body.statusCode, 'statusCode').toBe(422);
    });

    it('every import write in the wrong status is 409 import_status_conflict', () => {
      for (const id of IMPORT_WRITES) {
        expect(hasError(id, '409', 'import_status_conflict'), `${id} 409`).toBe(true);
      }
    });

    it('every import write documents 403 not_permitted and 404 not_found', () => {
      for (const id of IMPORT_WRITES) {
        expect(hasError(id, '403', 'not_permitted'), `${id} 403`).toBe(true);
        expect(hasError(id, '404', 'not_found'), `${id} 404`).toBe(true);
      }
    });
  });

  describe('statuses and the job (R5, R9–R12)', () => {
    it('ImportStatus is exactly the ten statuses', () => {
      expect(enumOf(rec('ImportStatus')).map(str).sort()).toEqual(STATUSES);
    });

    it('Import is closed with exactly its keys, all required', () => {
      const schema = rec('Import');
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(IMPORT_KEYS);
      expect(required(schema)).toEqual(IMPORT_KEYS);
    });

    it('ImportSummary (the list row) is closed with exactly its keys, all required: no headers, mapping or errors', () => {
      const schema = rec('ImportSummary');
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(SUMMARY_KEYS);
      expect(required(schema)).toEqual(SUMMARY_KEYS);
    });

    it('the shared keys have one meaning: status is ImportStatus, counts is ImportCounts, ids are uuids, times are UTC, nullable where R12 says', () => {
      const problems: string[] = [];
      for (const name of ['Import', 'ImportSummary']) {
        const props = properties(rec(name));
        const prop = (key: string): Located => props.get(key) ?? synthetic({ not: {} });
        if (!isSchema(props.get('status'), rec('ImportStatus'))) problems.push(`${name}.status`);
        if (!isSchema(props.get('counts'), rec('ImportCounts'))) problems.push(`${name}.counts`);
        for (const key of ['id', 'programmeId', 'createdByUserId']) if (!accepts(prop(key), IID) || accepts(prop(key), 'x')) problems.push(`${name}.${key} is not a uuid`);
        for (const key of ['createdAt', 'updatedAt']) if (!accepts(prop(key), '2026-10-18T09:00:00Z') || accepts(prop(key), null)) problems.push(`${name}.${key}`);
        for (const key of ['finishedAt', 'rawFileDeletedAt']) if (!accepts(prop(key), '2026-10-18T09:00:00Z') || !accepts(prop(key), null) || accepts(prop(key), '2026-10-18')) problems.push(`${name}.${key} is not a nullable UTC time`);
        if (!accepts(prop('sizeBytes'), MAX_FILE) || accepts(prop('sizeBytes'), MAX_FILE + 1) || accepts(prop('sizeBytes'), 0)) problems.push(`${name}.sizeBytes`);
        if (!accepts(prop('filename'), 'sample.csv') || !accepts(prop('filename'), null) || accepts(prop('filename'), '') || accepts(prop('filename'), 'x'.repeat(256))) problems.push(`${name}.filename is not 1..255 or null (R22)`);
      }
      const props = properties(rec('Import'));
      if (!isSchema(props.get('contentType'), rec('ImportContentType'))) problems.push('Import.contentType');
      expect(problems).toEqual([]);
    });

    it('headers: the file’s column names, at most 500 of 1..255 characters, or null until read', () => {
      const headers = properties(rec('Import')).get('headers');
      if (!headers) throw new Error('Import has no headers');
      expect(caseProblems(headers, [null, [], ['First name', 'Phone'], Array.from({ length: 500 }, (_, i) => `Column ${i}`)], [
        [''],
        ['x'.repeat(256)],
        Array.from({ length: 501 }, (_, i) => `Column ${i}`),
        [1],
        'First name,Phone',
        [{ name: 'Phone', sample: 'x' }],
      ])).toEqual([]);
      expect(nodeDescription(headers) + description(op('getImport'))).toMatch(/never a cell|no cell/i);
    });

    it('suggestedMapping is ImportColumnMapping[] or null; mapping is ImportMapping or null', () => {
      const props = properties(rec('Import'));
      const suggested = props.get('suggestedMapping');
      if (!suggested) throw new Error('Import has no suggestedMapping');
      expect(accepts(suggested, null), 'suggestedMapping null').toBe(true);
      expect(accepts(suggested, [{ index: 0, field: 'givenNames' }, { index: 1, field: null }]), 'suggestedMapping list').toBe(true);
      expect(accepts(suggested, [{ index: 0, field: 'id' }]), 'suggestedMapping refuses a non-importable field').toBe(false);
      const mapping = props.get('mapping');
      if (!mapping) throw new Error('Import has no mapping');
      expect(accepts(mapping, null), 'mapping null').toBe(true);
      const saved = rec('ImportMapping');
      expect(isClosed(saved)).toBe(true);
      expect(keysOf(saved)).toEqual(['columns', 'defaultCountry', 'ownerUserId']);
      expect(required(saved)).toEqual(['columns', 'defaultCountry', 'ownerUserId']);
      expect(accepts(mapping, { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG', ownerUserId: null })).toBe(true);
      expect(accepts(mapping, { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG', ownerUserId: null, fromImportId: IID }), 'a saved mapping is the resolved columns, never a fromImportId').toBe(false);
    });

    it('ImportCounts: closed { created, skipped, failed }, integers 0..100,000', () => {
      const counts = rec('ImportCounts');
      expect(isClosed(counts)).toBe(true);
      expect(keysOf(counts)).toEqual(['created', 'failed', 'skipped']);
      expect(required(counts)).toEqual(['created', 'failed', 'skipped']);
      const good = { created: 0, skipped: 0, failed: 0 };
      expect(caseProblems(counts, [good, { created: 100000, skipped: 0, failed: 0 }], [
        { ...good, created: -1 },
        { ...good, failed: 1.5 },
        { ...good, skipped: '3' },
        { ...good, created: 100001 },
        { ...good, total: 0 },
        omit(good, 'failed'),
      ])).toEqual([]);
    });

    it('ImportRowErrorCode is the closed enum of exactly thirteen codes (R9)', () => {
      expect(enumOf(rec('ImportRowErrorCode')).map(str).sort()).toEqual(ROW_CODES);
    });

    it('ImportRowError is closed and exactly { row >= 2, column >= 0 or null, code }: no value, header, message or detail (R9, R10)', () => {
      const schema = rec('ImportRowError');
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(['code', 'column', 'row']);
      expect(required(schema)).toEqual(['code', 'column', 'row']);
      expect(isSchema(properties(schema).get('code'), rec('ImportRowErrorCode'))).toBe(true);
      expect(caseProblems(schema, GOOD_ROW_ERRORS, BAD_ROW_ERRORS)).toEqual([]);
    });

    it('errors: ImportRowError[], at most 1,000, with errorsTruncated a boolean (R11)', () => {
      const props = properties(rec('Import'));
      expect(isSchema(itemsOf(rec('Import'), 'errors'), rec('ImportRowError'))).toBe(true);
      expect(numberAt(props.get('errors'), 'maxItems')).toBe(1000);
      const truncated = props.get('errorsTruncated');
      expect(truncated && accepts(truncated, true) && accepts(truncated, false) && !accepts(truncated, null)).toBe(true);
    });

    it('getImport states the cap, the row numbering, the 7-day raw-file deletion and that no cell value appears, error detail included', () => {
      const text = description(op('getImport'));
      expect(text).toMatch(/1,?000/);
      expect(text).toMatch(/`errorsTruncated`/);
      expect(text).toMatch(/row 1|header row/i);
      expect(text).toMatch(/7 days/);
      expect(text).toMatch(/`rawFileDeletedAt`/);
      expect(text).toMatch(/no cell value|never a cell/i);
      expect(text).toMatch(/`contact\.import`/);
    });

    it('listImports: keyset, newest first, within scope, gated on contact.import as 404-not-403', () => {
      const text = description(op('listImports'));
      expect(text).toMatch(/newest first/i);
      expect(text).toMatch(/`contact\.import`/);
      expect(text).toMatch(/scope/i);
    });

    it('runImport: 202; it runs as the initiating user, re-resolving scope when it runs (ADR-0017 Q7); cancel is honoured between batches', () => {
      expect(description(op('runImport'))).toMatch(/initiating user|as `createdByUserId`/i);
      expect(description(op('runImport'))).toMatch(/saved mapping|mapping (is|has been) saved/i);
      expect(description(op('cancelImport'))).toMatch(/between batches/i);
      expect(description(op('cancelImport'))).toMatch(/`queued`|`running`/);
    });
  });

  describe('the mapping (R6–R8)', () => {
    it('PutImportMappingRequest: closed; columns, defaultCountry, ownerUserId, fromImportId; exactly one of columns and fromImportId; defaultCountry required', () => {
      const schema = rec('PutImportMappingRequest');
      expect(keysOf(schema)).toEqual(['columns', 'defaultCountry', 'fromImportId', 'ownerUserId']);
      expect(required(schema)).toEqual(['defaultCountry']);
      expect(caseProblems(schema, GOOD_MAPPING, BAD_MAPPING)).toEqual([]);
    });

    it('ImportDefaultCountry is exactly NG, GH, KE, ZA, used by both mapping schemas', () => {
      expect(enumOf(rec('ImportDefaultCountry')).map(str).sort()).toEqual(COUNTRIES);
      expect(isSchema(properties(rec('PutImportMappingRequest')).get('defaultCountry'), rec('ImportDefaultCountry'))).toBe(true);
      expect(isSchema(properties(rec('ImportMapping')).get('defaultCountry'), rec('ImportDefaultCountry'))).toBe(true);
    });

    it('ImportColumnMapping: closed { index 0..499, field: ImportField or null }, both required', () => {
      const schema = rec('ImportColumnMapping');
      expect(isClosed(schema)).toBe(true);
      expect(keysOf(schema)).toEqual(['field', 'index']);
      expect(required(schema)).toEqual(['field', 'index']);
      const field = properties(schema).get('field');
      expect(field && accepts(field, null), 'field admits null (ignore the column)').toBe(true);
    });

    it('ImportField admits exactly the sixteen importable contact fields and custom.<key>; it refuses the rest', () => {
      const field = rec('ImportField');
      expect(enumOf(field).map(str).sort(), 'the standard names').toEqual(IMPORT_FIELDS);
      expect(caseProblems(field, GOOD_FIELDS, BAD_FIELDS)).toEqual([]);
    });

    it('every importable field is a property of Contact (no invented name)', () => {
      const contact = keysOf(rec('Contact'));
      expect(enumOf(rec('ImportField')).map(str).filter((name) => !contact.includes(name))).toEqual([]);
    });

    it('(self-check, R6) an ImportField that admits any camelCase name, or any custom.* path, is caught by the cases', () => {
      rec('ImportField');
      for (const weak of [
        synthetic({ type: 'string', pattern: '^[a-z][A-Za-z0-9]*$|^custom\\.[a-z][a-z0-9_]*__c$' }),
        synthetic({ anyOf: [{ type: 'string', enum: IMPORT_FIELDS }, { type: 'string', pattern: '^custom\\.' }] }),
        synthetic({ anyOf: [{ type: 'string', enum: [...IMPORT_FIELDS, 'ownerUserId'] }, { type: 'string', pattern: '^custom\\.[a-z][a-z0-9_]*__c$' }] }),
      ]) {
        expect(caseProblems(weak, GOOD_FIELDS, BAD_FIELDS).length).toBeGreaterThan(0);
      }
    });

    it('the description states fromImportId (by header name, the mapping template with no template table), D-L67, the repeat rule and the displayName rule', () => {
      const text = description(op('putImportMapping'));
      expect(text).toMatch(/`fromImportId`/);
      expect(text).toMatch(/header name/i);
      expect(text).toMatch(/template/i);
      expect(text).toMatch(/D-L67/);
      expect(text).toMatch(/`phones`, `emails` and `tags`/);
      expect(text).toMatch(/duplicate_mapping/);
      expect(text).toMatch(/`displayName`/);
      expect(text).toMatch(/`givenNames`/);
      expect(text).toMatch(/E\.164/);
    });

    it('errors: mapping_incomplete names the missing api name; unknown_column, duplicate_mapping at the column; unknown_reference at ownerUserId and fromImportId', () => {
      expect(hasError('putImportMapping', '400', 'validation_failed', /^displayName$/, 'mapping_incomplete'), 'mapping_incomplete at displayName').toBe(true);
      expect(hasError('putImportMapping', '400', 'validation_failed', /^columns\.\d+\.index$/, 'unknown_column'), 'unknown_column').toBe(true);
      expect(hasError('putImportMapping', '400', 'validation_failed', /^columns\.\d+\.field$/, 'duplicate_mapping'), 'duplicate_mapping').toBe(true);
      expect(hasError('putImportMapping', '400', 'validation_failed', /^ownerUserId$/, 'unknown_reference'), 'ownerUserId').toBe(true);
      expect(hasError('putImportMapping', '400', 'validation_failed', /^fromImportId$/, 'unknown_reference'), 'fromImportId').toBe(true);
      expect(description(op('putImportMapping'))).toMatch(/mapping_incomplete/);
    });

    it('403 field_not_editable names a field (an ImportField), not a column', () => {
      const field = rec('ImportField');
      const paths = errorExamples('putImportMapping', '403').flatMap((body) => detailsOf(body).filter((d) => d.code === 'field_not_editable').map((d) => str(d.path)));
      expect(paths.length, 'a 403 example with field_not_editable').toBeGreaterThan(0);
      expect(paths.filter((path) => !accepts(field, path)), 'a field_not_editable path that is not a field').toEqual([]);
      expect(description(op('putImportMapping'))).toMatch(/field_not_editable/);
    });

    it('x-kasuwa-import-compliance is exactly dnd [true, false], whatsappOptIn [false], consentState [withdrawn, unknown] (D-P28, D-L148)', () => {
      expect(op('putImportMapping').op['x-kasuwa-import-compliance']).toEqual(IMPORT_COMPLIANCE);
    });

    it('the new-contact defaults are Contact’s own: dnd false, whatsappOptIn false, consentState unknown', () => {
      gate();
      const contact = properties(rec('Contact'));
      const declared = Object.fromEntries(
        COMPLIANCE_FIELDS.map((field) => {
          const prop = contact.get(field);
          const node = prop ? deref(prop).node : undefined;
          return [field, isMapping(node) ? node.default : undefined];
        }),
      );
      expect(declared).toEqual(NEW_CONTACT_DEFAULTS);
    });

    it('each field admits exactly the restrictive values up to its new-contact default under x-kasuwa-compliance-order: nothing that grants', () => {
      expect(importComplianceProblems(op('putImportMapping').op['x-kasuwa-import-compliance'], op('createContactMerge').op['x-kasuwa-compliance-order'], NEW_CONTACT_DEFAULTS)).toEqual([]);
    });

    it('(self-check, R8) a planted grant, a dropped default, a missing field or an unordered list is caught by the compliance check', () => {
      gate();
      const check = (rule: unknown): string[] => importComplianceProblems(rule, COMPLIANCE_ORDER, NEW_CONTACT_DEFAULTS);
      expect(check({ ...IMPORT_COMPLIANCE, consentState: ['withdrawn', 'unknown', 'opted_in'] }).length, 'opted_in').toBeGreaterThan(0);
      expect(check({ ...IMPORT_COMPLIANCE, consentState: ['withdrawn', 'unknown', 'pending'] }).length, 'pending').toBeGreaterThan(0);
      expect(check({ ...IMPORT_COMPLIANCE, whatsappOptIn: [false, true] }).length, 'whatsappOptIn true').toBeGreaterThan(0);
      expect(check({ ...IMPORT_COMPLIANCE, consentState: ['withdrawn'] }).length, 'default dropped').toBeGreaterThan(0);
      expect(check({ ...IMPORT_COMPLIANCE, dnd: [false, true] }).length, 'unordered').toBeGreaterThan(0);
      expect(check({ dnd: [true, false], whatsappOptIn: [false] }).length, 'missing field').toBeGreaterThan(0);
      expect(check(IMPORT_COMPLIANCE)).toEqual([]);
    });

    it('the description states the compliance rule: restrict only, consent_grant_refused, an empty cell leaves the default, D-P28', () => {
      const text = description(op('putImportMapping'));
      expect(text).toMatch(/consent_grant_refused/);
      expect(text).toMatch(/D-P28/);
      expect(text).toMatch(/empty cell/i);
      expect(text).toMatch(/never grant/i);
      expect(text).toMatch(/new contacts? only|only creates/i);
      expect(text).toMatch(/default/i);
    });
  });

  describe('header erasure (R22, D-L148)', () => {
    it('Import.headers and filename and ImportSummary.filename are nullable, and each schema says it is cleared with the raw file', () => {
      const problems: string[] = [];
      for (const [name, key] of [['Import', 'headers'], ['Import', 'filename'], ['ImportSummary', 'filename']] as const) {
        const prop = properties(rec(name)).get(key);
        if (!prop) {
          problems.push(`${name} has no ${key}`);
          continue;
        }
        if (!accepts(prop, null)) problems.push(`${name}.${key} refuses null`);
        const raw = isMapping(rec(name).node) && isMapping((rec(name).node as Mapping).properties) ? ((rec(name).node as Mapping).properties as Mapping)[key] : undefined;
        const text = prose(isMapping(raw) ? raw.description : '') + ' ' + nodeDescription(prop);
        if (!/`rawFileDeletedAt`/.test(text) || !/null/.test(text)) problems.push(`${name}.${key} does not say it is null once \`rawFileDeletedAt\` is set`);
      }
      expect(problems).toEqual([]);
      // CreateImportRequest still requires a real filename.
      expect(accepts(properties(rec('CreateImportRequest')).get('filename') ?? synthetic({}), null), 'createImport takes a null filename').toBe(false);
    });

    it('getImport states the erasure: headers and filename cleared with the raw file, 7 days after the end or 24 hours after an abandoned upload, and why', () => {
      const text = description(op('getImport'));
      expect(text).toMatch(/`headers` and `filename`/);
      expect(text).toMatch(/7 days/);
      expect(text).toMatch(/24 hours/);
      expect(text).toMatch(/headerless|first (data )?row/i);
      expect(text).toMatch(/D-L148/);
    });

    it('putImportMapping: fromImportId works only while the source’s headers exist, then 400 unknown_reference at fromImportId', () => {
      const text = description(op('putImportMapping'));
      expect(text).toMatch(/`fromImportId`[^.]*(headers|raw file)[^.]*(deleted|cleared|null)|(deleted|cleared|null)[^.]*`fromImportId`/i);
      expect(text).toMatch(/unknown_reference/);
      expect(hasError('putImportMapping', '400', 'validation_failed', /^fromImportId$/, 'unknown_reference')).toBe(true);
    });

    it('the examples agree: rawFileDeletedAt set means headers and filename null; filename present until then; one example shows an erased import', () => {
      gate();
      const rows: [string, Mapping][] = [];
      for (const id of ['getImport', 'completeImportUpload', 'abortImportUpload', 'putImportMapping', 'runImport', 'cancelImport']) {
        const spec = OPS.find((candidate) => candidate.id === id);
        for (const body of successExamples(op(id), spec ? spec.success : '200')) rows.push([id, body]);
      }
      for (const page of successExamples(op('listImports'), '200')) {
        for (const row of Array.isArray(page.data) ? page.data.filter(isMapping) : []) rows.push(['listImports', row]);
      }
      expect(importErasureProblems(rows)).toEqual([]);
      expect(rows.some(([, row]) => row.rawFileDeletedAt !== null && row.rawFileDeletedAt !== undefined), 'no example shows an erased import').toBe(true);
    });

    it('(self-check, R22) the erasure check catches a kept filename, kept headers and a filename missing before deletion', () => {
      gate();
      const live = { rawFileDeletedAt: null, filename: 'sample.csv', headers: ['Name'] };
      const gone = { rawFileDeletedAt: '2026-10-25T09:00:00Z', filename: null, headers: null };
      expect(importErasureProblems([['a', live], ['b', gone]])).toEqual([]);
      expect(importErasureProblems([['x', { ...gone, filename: 'sample.csv' }]]).length).toBeGreaterThan(0);
      expect(importErasureProblems([['x', { ...gone, headers: ['Name'] }]]).length).toBeGreaterThan(0);
      expect(importErasureProblems([['x', { ...live, filename: null }]]).length).toBeGreaterThan(0);
    });
  });

  describe('the importId contacts filter (R13)', () => {
    it('listContacts takes importId: query, optional, a uuid, x-kasuwa-implemented: false', () => {
      const node = paramNode(op('listContacts'), 'importId', 'query');
      if (!node) throw new Error('listContacts has no importId parameter');
      expect(node.required === undefined || node.required === false, 'optional').toBe(true);
      const schema = at(node.schema ?? {});
      expect(accepts(schema, IID) && !accepts(schema, 'x') && !accepts(schema, [IID]), 'one uuid').toBe(true);
      expect(node['x-kasuwa-implemented'], 'flag').toBe(false);
    });

    it('its description: scoped as every list is; an unseen import answers an empty page, never 404 or 400; not sent until served (D-L75)', () => {
      const node = paramNode(op('listContacts'), 'importId', 'query');
      const text = prose(node?.description);
      expect(text).toMatch(/empty page/i);
      expect(text).toMatch(/never (a )?`?404`?/i);
      expect(text).toMatch(/scope/i);
      expect(text).toMatch(/ignores unknown parameters|until (it is )?served/i);
    });
  });

  describe('duplicates (R14)', () => {
    it('DuplicateMatchOn is exactly phone and email', () => {
      expect(enumOf(rec('DuplicateMatchOn')).map(str).sort()).toEqual(['email', 'phone']);
    });

    it('DuplicateSet: closed, exactly { matchOn, contacts: 2..10 DuplicateContact }', () => {
      const set = rec('DuplicateSet');
      expect(isClosed(set)).toBe(true);
      expect(keysOf(set)).toEqual(['contacts', 'matchOn']);
      expect(required(set)).toEqual(['contacts', 'matchOn']);
      expect(isSchema(properties(set).get('matchOn'), rec('DuplicateMatchOn'))).toBe(true);
      expect(isSchema(itemsOf(set, 'contacts'), rec('DuplicateContact'))).toBe(true);
      const contacts = properties(set).get('contacts');
      expect(numberAt(contacts, 'minItems')).toBe(2);
      expect(numberAt(contacts, 'maxItems')).toBe(10);
    });

    it('DuplicateContact: closed, exactly { id, displayName (string or null), updatedAt }: no phone, email, matched value or score', () => {
      const contact = rec('DuplicateContact');
      expect(isClosed(contact)).toBe(true);
      expect(keysOf(contact)).toEqual(['displayName', 'id', 'updatedAt']);
      expect(required(contact)).toEqual(['displayName', 'id', 'updatedAt']);
      const good = { id: IID, displayName: 'Sample Person', updatedAt: '2026-10-18T09:00:00Z' };
      expect(caseProblems(contact, [good, { ...good, displayName: null }], [
        { ...good, phone: '+2348030000001' },
        { ...good, matchedValue: 'x' },
        { ...good, score: 0.9 },
        { ...good, programmeId: PID },
        omit(good, 'displayName'),
        { ...good, displayName: 'x'.repeat(201) },
      ])).toEqual([]);
    });

    it('(self-check, R10, R14) the value-name sweep catches a planted matchedValue, score, sampleValues or e164', () => {
      gate();
      for (const name of ['matchedValue', 'score', 'confidence', 'sampleValues', 'e164', 'value', 'cellText', 'rawRow', 'detail']) {
        const planted = synthetic({ type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, [name]: { type: 'string' } } });
        expect(valueNamedProperties([['planted', planted]]), name).toEqual([`planted.${name}`]);
      }
      const clean = synthetic({ type: 'object', properties: { rawFileDeletedAt: { type: 'string' }, contentType: { type: 'string' }, counts: { type: 'object' } } });
      expect(valueNamedProperties([['clean', clean]])).toEqual([]);
    });

    it('listDuplicates states the rule: exact E.164 or lower-cased email, one programme, never the matched value, no score, withheld matches yield nothing, 404 for an unreachable programme', () => {
      const text = description(op('listDuplicates'));
      expect(text).toMatch(/E\.164/);
      expect(text).toMatch(/lower-?cased/i);
      expect(text).toMatch(/one programme/i);
      expect(text).toMatch(/matched value is never returned|never returns? the matched value/i);
      expect(text).toMatch(/no (confidence )?score/i);
      expect(text).toMatch(/withheld/i);
      expect(text).toMatch(/404/);
      expect(text).toMatch(/merged away|merged-away/i);
    });
  });

  describe('merge preview (R15)', () => {
    it('ContactMergePreview: closed { survivor: Contact, merged: Contact, defaults: MergeChoices, compliance: MergeComplianceOutcome }', () => {
      const preview = rec('ContactMergePreview');
      expect(isClosed(preview)).toBe(true);
      expect(keysOf(preview)).toEqual(['compliance', 'defaults', 'merged', 'survivor']);
      expect(required(preview)).toEqual(['compliance', 'defaults', 'merged', 'survivor']);
      const props = properties(preview);
      expect(isSchema(props.get('survivor'), rec('Contact')), 'survivor').toBe(true);
      expect(isSchema(props.get('merged'), rec('Contact')), 'merged').toBe(true);
      expect(isSchema(props.get('defaults'), rec('MergeChoices')), 'defaults').toBe(true);
      expect(isSchema(props.get('compliance'), rec('MergeComplianceOutcome')), 'compliance').toBe(true);
    });

    it('MergeComplianceOutcome: closed; dnd, whatsappOptIn, consentState optional (omitted when withheld) and withheldFields required, naming only those three', () => {
      const outcome = rec('MergeComplianceOutcome');
      expect(isClosed(outcome)).toBe(true);
      expect(keysOf(outcome)).toEqual(['consentState', 'dnd', 'whatsappOptIn', 'withheldFields']);
      expect(required(outcome)).toEqual(['withheldFields']);
      expect(caseProblems(outcome, [
        { dnd: true, whatsappOptIn: false, consentState: 'withdrawn', withheldFields: [] },
        { dnd: false, withheldFields: ['whatsappOptIn', 'consentState'] },
      ], [
        { dnd: 'true', withheldFields: [] },
        { consentState: 'maybe', withheldFields: [] },
        { dnd: true },
        { dnd: true, withheldFields: ['phones'] },
        { dnd: null, withheldFields: [] },
        { dnd: true, withheldFields: [], reason: 'x' },
      ])).toEqual([]);
      expect(isSchema(properties(outcome).get('consentState'), rec('ConsentState'))).toBe(true);
    });

    it('x-kasuwa-compliance-order is exactly the restrictive ranking, each a permutation of its field’s values on Contact', () => {
      const order = op('createContactMerge').op['x-kasuwa-compliance-order'];
      expect(order).toEqual(COMPLIANCE_ORDER);
      const consent = enumOf(rec('ConsentState')).map(str).sort();
      expect(isMapping(order) && Array.isArray(order.consentState) ? [...order.consentState].map(str).sort() : [], 'every consent state ranked').toEqual(consent);
    });

    it('the preview description: contactId survives, `with` is merged away, recency default if non-empty, most restrictive compliance, field security, 404 and the 400s', () => {
      const text = description(op('getContactMergePreview'));
      expect(text).toMatch(/survivor/i);
      expect(text).toMatch(/`with`/);
      expect(text).toMatch(/updated more recently|more recently updated/i);
      expect(text).toMatch(/non-empty/i);
      expect(text).toMatch(/most restrictive/i);
      expect(text).toMatch(/field security/i);
      expect(text).toMatch(/cross_programme/);
      expect(text).toMatch(/D-P27/);
    });

    it('errors: 400 cross_programme and same_contact at `with`; 404 not_found', () => {
      expect(hasError('getContactMergePreview', '400', 'validation_failed', /^with$/, 'cross_programme')).toBe(true);
      expect(hasError('getContactMergePreview', '400', 'validation_failed', /^with$/, 'same_contact')).toBe(true);
      expect(hasError('getContactMergePreview', '404', 'not_found')).toBe(true);
    });

    it('the example follows the rules: one programme, recency defaults, no compliance or withheld field in defaults, the most restrictive outcome', () => {
      const examples = successExamples(op('getContactMergePreview'), '200');
      expect(examples.length, 'a 200 example').toBeGreaterThan(0);
      expect(examples.flatMap((example, i) => previewProblems(`example ${i}`, example))).toEqual([]);
      // Not vacuous: the example must have the compliance fields differ, or "most restrictive" is checked on a tie.
      expect(examples.some((example) => isMapping(example.survivor) && isMapping(example.merged) && COMPLIANCE_FIELDS.some((field) => (example.survivor as Mapping)[field] !== (example.merged as Mapping)[field])), 'a compliance difference').toBe(true);
      expect(examples.some((example) => isMapping(example.defaults) && Object.values(example.defaults).includes('merged') && Object.values(example.defaults).includes('survivor')), 'defaults pick both sides').toBe(true);
    });

    it('(self-check, R15) the preview checker catches a compliance default, a recency error, a loosened outcome and a cross-programme pair', () => {
      gate();
      const survivor = { id: 'a', programmeId: PID, updatedAt: '2026-10-10T00:00:00Z', status: 'new', companyName: null, dnd: false, whatsappOptIn: true, consentState: 'opted_in', withheldFields: [] };
      const merged = { id: 'b', programmeId: PID, updatedAt: '2026-10-12T00:00:00Z', status: 'qualified', companyName: 'Sample Ltd', dnd: true, whatsappOptIn: true, consentState: 'withdrawn', withheldFields: ['emails'] };
      const good = { survivor, merged, defaults: { status: 'merged', companyName: 'merged' }, compliance: { dnd: true, whatsappOptIn: true, consentState: 'withdrawn', withheldFields: [] } };
      expect(previewProblems('good', good)).toEqual([]);
      expect(previewProblems('dnd default', { ...good, defaults: { dnd: 'merged' } }).length).toBeGreaterThan(0);
      expect(previewProblems('recency', { ...good, defaults: { status: 'survivor' } }).length).toBeGreaterThan(0);
      expect(previewProblems('withheld default', { ...good, defaults: { emails: 'survivor' } }).length).toBeGreaterThan(0);
      expect(previewProblems('loosened', { ...good, compliance: { ...good.compliance, consentState: 'opted_in' } }).length).toBeGreaterThan(0);
      expect(previewProblems('cross', { ...good, merged: { ...merged, programmeId: IID } }).length).toBeGreaterThan(0);
    });
  });

  describe('merge (R16, R17)', () => {
    it('CreateContactMergeRequest: closed { survivorId, mergedId, survivorVersion, mergedVersion, choices? }', () => {
      const schema = rec('CreateContactMergeRequest');
      expect(keysOf(schema)).toEqual(['choices', 'mergedId', 'mergedVersion', 'survivorId', 'survivorVersion']);
      expect(required(schema)).toEqual(['mergedId', 'mergedVersion', 'survivorId', 'survivorVersion']);
      expect(isSchema(properties(schema).get('choices'), rec('MergeChoices'))).toBe(true);
      expect(caseProblems(schema, GOOD_MERGE, BAD_MERGE)).toEqual([]);
    });

    it('MergeSide is exactly survivor and merged; MergeField is exactly the fifteen choosable standard fields, each a Contact property', () => {
      expect(enumOf(rec('MergeSide')).map(str).sort()).toEqual(['merged', 'survivor']);
      expect(enumOf(rec('MergeField')).map(str).sort()).toEqual(MERGE_FIELDS);
      const contact = keysOf(rec('Contact'));
      expect(MERGE_FIELDS.filter((name) => !contact.includes(name))).toEqual([]);
      expect(enumOf(rec('MergeField')).map(str).filter((name) => COMPLIANCE_FIELDS.includes(name)), 'a compliance field is choosable').toEqual([]);
    });

    it('MergeChoices: keys a MergeField or custom.<key>, values a MergeSide; never an id, version, timestamp or derived field', () => {
      expect(caseProblems(rec('MergeChoices'), GOOD_CHOICES, BAD_CHOICES)).toEqual([]);
    });

    it('the description: compliance_not_choosable, field_not_editable (the survivor keeps it), cross_programme, stale_write, already_merged, contact.write, one audit event', () => {
      const text = description(op('createContactMerge'));
      expect(text).toMatch(/compliance_not_choosable/);
      expect(text).toMatch(/field_not_editable/);
      expect(text).toMatch(/keeps the survivor['’]s value/i);
      expect(text).toMatch(/cross_programme/);
      expect(text).toMatch(/stale_write/);
      expect(text).toMatch(/already_merged/);
      expect(text).toMatch(/`contact\.write`/);
      expect(text).toMatch(/audit/i);
      expect(text).toMatch(/most restrictive/i);
    });

    it('R17: a merged-away contact is 404 on every contact operation (D-P27); already_merged is the merges’ answer, not the contacts’', () => {
      const text = description(op('createContactMerge'));
      expect(text).toMatch(/D-P27/);
      expect(text).toMatch(/404 on every contact operation/i);
      expect(description(op('undoContactMerge'))).toMatch(/already_merged/);
      // No contact operation (a path under /api/v1/contacts) documents a 409 already_merged.
      const leaks: string[] = [];
      for (const found of operations().filter((candidate) => candidate.path.startsWith('/api/v1/contacts'))) {
        for (const [status] of responses(found)) {
          for (const body of errorExamples(found.id, status)) if (body.code === 'already_merged') leaks.push(`${found.id} ${status}`);
        }
      }
      gate();
      expect(leaks).toEqual([]);
    });

    it('errors: 400 compliance_not_choosable at choices.<compliance field>, cross_programme and same_contact at mergedId; 403 field_not_editable at choices.<field>; 409 stale_write and already_merged; 404', () => {
      expect(hasError('createContactMerge', '400', 'validation_failed', /^choices\.(dnd|whatsappOptIn|consentState)$/, 'compliance_not_choosable'), 'compliance_not_choosable').toBe(true);
      expect(hasError('createContactMerge', '400', 'validation_failed', /^mergedId$/, 'cross_programme'), 'cross_programme').toBe(true);
      expect(hasError('createContactMerge', '400', 'validation_failed', /^mergedId$/, 'same_contact'), 'same_contact').toBe(true);
      expect(hasError('createContactMerge', '403', 'not_permitted', /^choices\.([a-zA-Z]+|custom\.[a-z][a-z0-9_]*__c)$/, 'field_not_editable'), 'field_not_editable').toBe(true);
      expect(hasError('createContactMerge', '409', 'stale_write'), 'stale_write').toBe(true);
      expect(hasError('createContactMerge', '409', 'already_merged'), 'already_merged').toBe(true);
      expect(hasError('createContactMerge', '404', 'not_found'), '404').toBe(true);
    });

    it('the example request chooses no compliance field', () => {
      const bodies = requestExamples(op('createContactMerge'));
      expect(bodies.length, 'a request example').toBeGreaterThan(0);
      const chosen = bodies.flatMap((body) => (isMapping(body.choices) ? Object.keys(body.choices) : []));
      expect(chosen.filter((field) => COMPLIANCE_FIELDS.includes(field))).toEqual([]);
      expect(chosen.length, 'the example makes at least one choice').toBeGreaterThan(0);
    });
  });

  describe('undo and the merges history (R18, R19)', () => {
    it('ContactMerge is closed with exactly its keys, all required; survivor and merged are ContactMergeParty', () => {
      const merge = rec('ContactMerge');
      expect(isClosed(merge)).toBe(true);
      expect(keysOf(merge)).toEqual(MERGE_KEYS);
      expect(required(merge)).toEqual(MERGE_KEYS);
      expect(isSchema(properties(merge).get('survivor'), rec('ContactMergeParty'))).toBe(true);
      expect(isSchema(properties(merge).get('merged'), rec('ContactMergeParty'))).toBe(true);
      const party = rec('ContactMergeParty');
      expect(isClosed(party)).toBe(true);
      expect(keysOf(party)).toEqual(['displayName', 'id']);
      expect(required(party)).toEqual(['displayName', 'id']);
      expect(accepts(party, { id: IID, displayName: null })).toBe(true);
    });

    it('ContactMerge types: times UTC, undoneAt and undoneByUserId nullable, survivorReverted true, false or null', () => {
      const props = properties(rec('ContactMerge'));
      const prop = (key: string): Located => props.get(key) ?? synthetic({ not: {} });
      const problems: string[] = [];
      for (const key of ['mergedAt', 'undoUntil']) if (!accepts(prop(key), '2026-10-18T09:00:00Z') || accepts(prop(key), null)) problems.push(key);
      if (!accepts(prop('undoneAt'), null) || !accepts(prop('undoneAt'), '2026-10-18T09:00:00Z')) problems.push('undoneAt');
      for (const key of ['undoneByUserId']) if (!accepts(prop(key), null) || !accepts(prop(key), UID) || accepts(prop(key), 'x')) problems.push(key);
      for (const key of ['id', 'programmeId', 'mergedByUserId']) if (!accepts(prop(key), UID) || accepts(prop(key), null)) problems.push(key);
      for (const value of [true, false, null]) if (!accepts(prop('survivorReverted'), value)) problems.push(`survivorReverted ${String(value)}`);
      if (accepts(prop('survivorReverted'), 'yes')) problems.push('survivorReverted "yes"');
      expect(problems).toEqual([]);
    });

    it('undo: the merging user or a tenant admin; 30 days, then 410 undo_expired; survivorReverted; compliance never loosened; a repeat is 200', () => {
      const text = description(op('undoContactMerge'));
      expect(text).toMatch(/merging user/i);
      expect(text).toMatch(/tenant admin/i);
      expect(text).toMatch(/30 days/);
      expect(text).toMatch(/undo_expired/);
      expect(text).toMatch(/`survivorReverted`/);
      expect(text).toMatch(/never loosens?/i);
      expect(text).toMatch(/repeat/i);
      expect(text).toMatch(/activities/i);
    });

    it('errors: 410 undo_expired (statusCode 410), 409 already_merged, 403 not_permitted, 404 not_found', () => {
      expect(hasError('undoContactMerge', '410', 'undo_expired')).toBe(true);
      for (const body of errorExamples('undoContactMerge', '410')) expect(body.statusCode).toBe(410);
      expect(hasError('undoContactMerge', '409', 'already_merged')).toBe(true);
      expect(hasError('undoContactMerge', '403', 'not_permitted')).toBe(true);
      expect(hasError('undoContactMerge', '404', 'not_found')).toBe(true);
    });

    it('the examples: undoUntil is mergedAt plus exactly 30 days; a fresh merge is not undone; an undo sets undoneAt and survivorReverted', () => {
      const created = successExamples(op('createContactMerge'), '201');
      const undone = successExamples(op('undoContactMerge'), '200');
      expect(created.length, 'a 201 example').toBeGreaterThan(0);
      expect(undone.length, 'an undo example').toBeGreaterThan(0);
      const problems: string[] = [];
      for (const merge of [...created, ...undone]) {
        if (Date.parse(str(merge.undoUntil)) - Date.parse(str(merge.mergedAt)) !== 30 * 24 * 3600 * 1000) problems.push(`undoUntil ${str(merge.undoUntil)} is not mergedAt + 30 days`);
      }
      for (const merge of created) if (merge.undoneAt !== null || merge.survivorReverted !== null || merge.undoneByUserId !== null) problems.push('a fresh merge says it was undone');
      for (const merge of undone) {
        if (typeof merge.survivorReverted !== 'boolean') problems.push('undo answer has no survivorReverted');
        if (merge.undoneAt === null || Date.parse(str(merge.undoneAt)) > Date.parse(str(merge.undoUntil))) problems.push('undoneAt missing or past undoUntil');
      }
      expect(problems).toEqual([]);
    });

    it('listContactMerges: the Phase 2 recycle bin, keyset, newest first, within scope', () => {
      const text = description(op('listContactMerges'));
      expect(text).toMatch(/recycle bin/i);
      expect(text).toMatch(/newest first/i);
      expect(text).toMatch(/scope/i);
    });
  });

  describe('no cell value anywhere (R10, R20)', () => {
    it('no import, duplicate or merge-history schema has a property named for a value, sample, cell, preview, raw content, detail or score', () => {
      gate();
      const roots: [string, Located][] = ['Import', 'ImportPage', 'ImportUpload', 'DuplicatePage', 'ContactMergePage', 'MergeComplianceOutcome'].map((name) => [name, rec(name)]);
      expect(valueNamedProperties(roots)).toEqual([]);
    });

    it('every object in those schemas, and in the four new request bodies, is closed', () => {
      gate();
      const roots: [string, Located][] = [
        'Import',
        'ImportPage',
        'ImportUpload',
        'DuplicatePage',
        'ContactMergePage',
        'CreateImportRequest',
        'IssueImportUploadUrlsRequest',
        'CompleteImportUploadRequest',
        'PutImportMappingRequest',
      ].map((name) => [name, rec(name)]);
      expect(openObjects(roots)).toEqual([]);
    });

    it('(self-check, R10) the closedness sweep catches an open nested object', () => {
      gate();
      const planted = synthetic({
        type: 'object',
        additionalProperties: false,
        properties: {
          errors: { type: 'array', items: { type: 'object', properties: { row: { type: 'integer' } } } },
          mapping: { oneOf: [{ type: 'object', properties: { columns: { type: 'array' } } }, { type: 'null' }] },
        },
      });
      expect(openObjects([['planted', planted]])).toEqual(['planted.errors[]', 'planted.mapping/oneOf0']);
    });

    it('every error example on the new operations carries path and code only and echoes no request value', () => {
      gate();
      const values = requestValues();
      expect(values.length, 'the request examples hold values to look for').toBeGreaterThan(0);
      const problems: string[] = [];
      let checked = 0;
      for (const spec of OPS) {
        for (const [status] of responses(op(spec.id))) {
          if (!/^[45]/.test(status)) continue;
          for (const body of errorExamples(spec.id, status)) {
            checked += 1;
            problems.push(...echoProblems(`${spec.id} ${status}`, body, values));
          }
        }
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(30);
    });

    it('(self-check, R10) the echo check catches an extra detail key and an echoed filename', () => {
      gate();
      const values = ['sample-customers.csv'];
      expect(echoProblems('x', { code: 'validation_failed', details: [{ path: 'sizeBytes', code: 'file_too_large', received: 1 }] }, values).length).toBeGreaterThan(0);
      expect(echoProblems('x', { code: 'validation_failed', message: 'sample-customers.csv is too large' }, values).length).toBeGreaterThan(0);
      expect(echoProblems('x', { code: 'validation_failed', details: [{ path: 'sizeBytes', code: 'file_too_large' }] }, values)).toEqual([]);
    });

    it('no import, duplicate or merge-history example holds a phone- or email-like string (merge-preview’s Contact records excepted)', () => {
      gate();
      const ids = OPS.filter((spec) => spec.id !== 'getContactMergePreview').map((spec) => spec.id);
      const found: string[] = [];
      let checked = 0;
      for (const id of ids) {
        for (const [status] of responses(op(id))) {
          for (const body of exampleBodies(responses(op(id)).get(status))) {
            checked += 1;
            for (const text of identifierLikeStrings(body)) found.push(`${id} ${status}: ${text}`);
          }
        }
        for (const body of requestExamples(op(id))) for (const text of identifierLikeStrings(body)) found.push(`${id} request: ${text}`);
      }
      expect(found).toEqual([]);
      expect(checked).toBeGreaterThan(14);
    });

    it('(self-check, R21) the identifier sweep catches a planted phone and email and spares uuids, times, URLs and etags', () => {
      gate();
      expect(identifierLikeStrings({ a: '+234 803 000 0001' })).toEqual(['+234 803 000 0001']);
      expect(identifierLikeStrings({ a: 'sample@example.com' })).toEqual(['sample@example.com']);
      expect(identifierLikeStrings({ a: IID, b: '2026-10-18T09:00:00Z', c: 'https://storage.example/u?X-Amz-Date=20261018T090000Z', d: '"9b2cf535f27731c974343645a3985328"', e: 'Phone 2' })).toEqual([]);
    });

    it('every answer of every new operation, errors included, is Cache-Control: no-store', () => {
      const missing: string[] = [];
      for (const found of gate()) {
        for (const [status, response] of responses(found)) if (!noStore(response)) missing.push(`${found.id} ${status}`);
      }
      expect(missing).toEqual([]);
    });

    it('createImport, completeImportUpload, createContactMerge and undoContactMerge are x-kasuwa-audited: true', () => {
      for (const id of AUDITED) expect(op(id).op['x-kasuwa-audited'], id).toBe(true);
    });
  });

  describe('errors: the shared envelope (R1)', () => {
    it('Error.code gains import_status_conflict, upload_mismatch, already_merged and undo_expired', () => {
      expect(errorCodeEnum()).toEqual(expect.arrayContaining(['import_status_conflict', 'upload_mismatch', 'already_merged', 'undo_expired']));
    });

    it('every error example on the new operations has its status as statusCode and a code in the enum', () => {
      const codes = errorCodeEnum();
      const problems: string[] = [];
      let checked = 0;
      for (const spec of OPS) {
        for (const [status] of responses(op(spec.id))) {
          if (!/^[45]/.test(status)) continue;
          for (const body of errorExamples(spec.id, status)) {
            checked += 1;
            if (body.statusCode !== Number(status)) problems.push(`${spec.id} ${status}: statusCode ${String(body.statusCode)}`);
            if (!codes.includes(str(body.code))) problems.push(`${spec.id} ${status}: ${str(body.code)} not in the enum`);
          }
        }
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(30);
    });
  });

  describe('security review (R23, D-L151)', () => {
    const CREATOR_ONLY = ['issueImportUploadUrls', 'completeImportUpload', 'abortImportUpload', 'putImportMapping', 'runImport'];

    it('a: upload-urls, complete, abort, mapping and run are the creator’s only; anyone else in scope is 403 not_permitted', () => {
      const problems: string[] = [];
      for (const id of CREATOR_ONLY) {
        const text = description(op(id));
        if (!/`createdByUserId`/.test(text)) problems.push(`${id}: does not name createdByUserId`);
        if (!/403|not_permitted/.test(text)) problems.push(`${id}: does not say anyone else is 403`);
        if (!hasError(id, '403', 'not_permitted')) problems.push(`${id}: no 403 example`);
      }
      expect(problems).toEqual([]);
    });

    it('a: cancel is open to the creator or a tenant admin', () => {
      const text = description(op('cancelImport'));
      expect(text).toMatch(/`createdByUserId`/);
      expect(text).toMatch(/tenant admin/i);
    });

    it('a: the job runs as createdByUserId and re-checks contact.import and scope every batch', () => {
      const text = description(op('runImport'));
      expect(text).toMatch(/runs as `createdByUserId`|as `createdByUserId`/);
      expect(text).toMatch(/every batch/i);
      expect(text).toMatch(/`contact\.import`/);
      expect(text).toMatch(/scope/i);
    });

    it('b: contact.import is held only by sets that also hold contact.write (admin in Phase 2)', () => {
      const text = description(op('createImport'));
      expect(text).toMatch(/`contact\.write`/);
      expect(text).toMatch(/\badmin\b/);
      expect(text).toMatch(/only/i);
    });

    it('b: setting ownerUserId to another member needs contact.write, as on createContact', () => {
      const text = description(op('putImportMapping'));
      expect(text).toMatch(/`ownerUserId`[^.]*`contact\.write`|`contact\.write`[^.]*`ownerUserId`/);
      expect(text).toMatch(/createContact/);
    });

    it('c: undo restores each compliance field at the more restrictive of the snapshot and the survivor’s current value; the survivor is never loosened', () => {
      const text = description(op('undoContactMerge'));
      expect(text).toMatch(/snapshot/i);
      expect(text).toMatch(/more restrictive/i);
      expect(text).toMatch(/restored contact/i);
      expect(text).toMatch(/never loosen/i);
    });

    it('d: the duplicates cursor carries only a contact id, the lowest in the last set; sets ascend by lowest contact id; never the matched value', () => {
      const listDup = op('listDuplicates');
      const cursor = paramNode(listDup, 'cursor', 'query');
      const text = `${description(listDup)} ${prose(cursor?.description)}`;
      expect(text).toMatch(/lowest contact id/i);
      expect(text).toMatch(/ascending/i);
      expect(text).toMatch(/cursor[^.]*only a contact id|only a contact id[^.]*cursor/i);
      expect(text).toMatch(/cursor[^.]*never[^.]*matched value|matched value[^.]*never[^.]*cursor/i);
    });

    it('e: undo is for the merging user holding contact.write now, or a tenant admin; all-or-nothing under current field security', () => {
      const text = description(op('undoContactMerge'));
      expect(text).toMatch(/merging user[^.]*`contact\.write`/i);
      expect(text).toMatch(/tenant admin/i);
      expect(text).toMatch(/all-or-nothing/i);
      expect(text).toMatch(/field_not_editable/);
      expect(text).toMatch(/nothing changes/i);
      expect(hasError('undoContactMerge', '403', 'not_permitted', /^([a-zA-Z]+|custom\.[a-z][a-z0-9_]*__c)$/, 'field_not_editable'), 'a 403 field_not_editable example at a field').toBe(true);
    });

    it('f: contact.claim_and_set_status never permits a merge', () => {
      expect(description(op('createContactMerge'))).toMatch(/`contact\.claim_and_set_status`[^.]*never/);
    });

    it('g: listContactMerges is gated on contact.write or tenant admin; after the deferred purge an entry shows ids only', () => {
      const text = description(op('listContactMerges'));
      expect(text).toMatch(/`contact\.write`/);
      expect(text).toMatch(/tenant admin/i);
      expect(text).toMatch(/purge/i);
      expect(text).toMatch(/ids only/i);
    });

    it('h: listDuplicates is throttled like search: 429 too_many_requests with a Retry-After header', () => {
      const response = responses(op('listDuplicates')).get('429');
      if (!response) throw new Error('listDuplicates documents no 429');
      expect(hasError('listDuplicates', '429', 'too_many_requests')).toBe(true);
      const headers = child(response, 'headers');
      const names = headers && isMapping(headers.node) ? Object.keys(headers.node).map((name) => name.toLowerCase()) : [];
      expect(names).toContain('retry-after');
      expect(description(op('listDuplicates'))).toMatch(/throttl/i);
    });

    it('i: completing an upload checks metadata, not content; the bytes stay untrusted until parsed', () => {
      const text = description(op('completeImportUpload'));
      expect(text).toMatch(/metadata/i);
      expect(text).toMatch(/not (the )?content/i);
      expect(text).toMatch(/untrusted/i);
    });

    it('j: signed part URLs are bearer credentials, never logged', () => {
      for (const id of ['createImport', 'issueImportUploadUrls']) {
        const text = description(op(id));
        expect(text, id).toMatch(/bearer/i);
        expect(text, id).toMatch(/never logged/i);
      }
    });

    it('k: the import result says duplicates were skipped and no restriction was applied to existing contacts', () => {
      const text = description(op('getImport'));
      expect(text).toMatch(/skipped/i);
      expect(text).toMatch(/no restriction[^.]*existing contacts/i);
    });
  });

  describe('flags: contract first (R1)', () => {
    it('every new operation is x-kasuwa-implemented: false', () => {
      const problems: string[] = [];
      for (const spec of OPS) if (op(spec.id).op['x-kasuwa-implemented'] !== false) problems.push(spec.id);
      expect(problems).toEqual([]);
    });
  });

  describe('examples (R21, D-L97)', () => {
    it('(self-check) the validator rejects broken copies of an Import, a DuplicateSet and a ContactMerge', () => {
      const imports = successExamples(op('getImport'), '200');
      const [first] = imports;
      if (!first) throw new Error('getImport 200 has no example');
      expect(validate(rec('Import'), first, 'import')).toEqual([]);
      const errors = Array.isArray(first.errors) ? first.errors.filter(isMapping) : [];
      const [firstError] = errors;
      const mutants: [string, unknown][] = [
        ['a sample', { ...first, sampleValues: ['x'] }],
        ['an unknown status', { ...first, status: 'done' }],
        ['a float count', { ...first, counts: { created: 1.5, skipped: 0, failed: 0 } }],
        ['a value on an error', { ...first, errors: [{ ...(firstError ?? { row: 2, column: 0, code: 'required' }), value: 'x' }] }],
        ['no errorsTruncated', JSON.parse(JSON.stringify({ ...first, errorsTruncated: undefined }))],
        ['1001 errors', { ...first, errors: Array.from({ length: 1001 }, (_, i) => ({ row: i + 2, column: 0, code: 'required' })) }],
      ];
      for (const [label, mutant] of mutants) expect(validate(rec('Import'), mutant, 'import').length, `accepted ${label}`).toBeGreaterThan(0);
      const pages = successExamples(op('listDuplicates'), '200');
      const set = pages.flatMap((page) => (Array.isArray(page.data) ? page.data.filter(isMapping) : []))[0];
      if (!set) throw new Error('listDuplicates 200 has no set');
      expect(validate(rec('DuplicateSet'), set, 'set')).toEqual([]);
      expect(validate(rec('DuplicateSet'), { ...set, score: 1 }, 'set').length).toBeGreaterThan(0);
      expect(validate(rec('DuplicateSet'), { ...set, matchOn: 'name' }, 'set').length).toBeGreaterThan(0);
    });

    it('every new operation has an example on its success answer, and every new body has a request example', () => {
      const missing: string[] = [];
      for (const spec of OPS) {
        if (successExamples(op(spec.id), spec.success).length === 0) missing.push(`${spec.id} ${spec.success}`);
        if (spec.body !== null && requestExamples(op(spec.id)).length === 0) missing.push(`${spec.id} request`);
      }
      expect(missing).toEqual([]);
    });

    it('every example on the new operations validates against its schema', () => {
      const ids = new Set(gate().map((found) => found.id));
      const problems: string[] = [];
      let checked = 0;
      for (const example of allExamples()) {
        if (!ids.has(example.op.id)) continue;
        checked += 1;
        if (example.schema) problems.push(...validate(example.schema, example.value, example.label));
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThanOrEqual(30);
    });

    it('getImport examples show a finished job with row errors (consent_grant_refused and possible_duplicate among them) and an awaiting_mapping job with headers and a suggestion; indices fit the headers', () => {
      const examples = successExamples(op('getImport'), '200');
      const finished = examples.find((example) => example.status === 'finished');
      const mapping = examples.find((example) => example.status === 'awaiting_mapping');
      expect(finished, 'a finished example').toBeDefined();
      expect(mapping, 'an awaiting_mapping example').toBeDefined();
      const codes = new Set((Array.isArray(finished?.errors) ? finished.errors.filter(isMapping) : []).map((error) => str(error.code)));
      expect([...codes]).toEqual(expect.arrayContaining(['consent_grant_refused', 'possible_duplicate']));
      expect(codes.size, 'at least three codes').toBeGreaterThanOrEqual(3);
      const problems: string[] = [];
      for (const example of examples) {
        const headers = Array.isArray(example.headers) ? example.headers : [];
        const indices = [
          ...(Array.isArray(example.suggestedMapping) ? example.suggestedMapping.filter(isMapping).map((column) => Number(column.index)) : []),
          ...(isMapping(example.mapping) && Array.isArray(example.mapping.columns) ? example.mapping.columns.filter(isMapping).map((column) => Number(column.index)) : []),
          ...(Array.isArray(example.errors) ? example.errors.filter(isMapping).filter((error) => error.column !== null).map((error) => Number(error.column)) : []),
        ];
        for (const index of indices) if (index >= headers.length) problems.push(`${str(example.status)}: index ${index} beyond ${headers.length} headers`);
      }
      expect(problems).toEqual([]);
      expect(Array.isArray(mapping?.headers) && mapping.headers.length > 0, 'headers on the awaiting_mapping example').toBe(true);
    });

    it('listDuplicates example shows a phone set and an email set, and a withheld name as null', () => {
      const pages = successExamples(op('listDuplicates'), '200');
      const sets = pages.flatMap((page) => (Array.isArray(page.data) ? page.data.filter(isMapping) : []));
      expect(sets.map((set) => str(set.matchOn)).sort()).toEqual(expect.arrayContaining(['email', 'phone']));
      const names = sets.flatMap((set) => (Array.isArray(set.contacts) ? set.contacts.filter(isMapping) : [])).map((contact) => contact.displayName);
      expect(names).toContain(null);
    });

    it('the list examples are newest first', () => {
      const problems: string[] = [];
      for (const [id, key] of [['listImports', 'createdAt'], ['listContactMerges', 'mergedAt']] as const) {
        for (const page of successExamples(op(id), '200')) {
          const rows = Array.isArray(page.data) ? page.data.filter(isMapping) : [];
          if (rows.length < 2) problems.push(`${id}: the example has fewer than two rows, so the order shows nothing`);
          for (let i = 1; i < rows.length; i += 1) if (Date.parse(str(rows[i]?.[key])) > Date.parse(str(rows[i - 1]?.[key]))) problems.push(`${id}: row ${i} is newer than row ${i - 1}`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('every other example in the file still validates (D-L97: import and merge break no mock)', () => {
      // A regression guard: it holds on main by design and must keep holding.
      // Not vacuous: it counts what it checked.
      const ids = new Set(OPS.map((spec) => spec.id));
      const problems: string[] = [];
      let checked = 0;
      for (const example of allExamples()) {
        if (ids.has(example.op.id)) continue;
        checked += 1;
        if (example.schema) problems.push(...validate(example.schema, example.value, example.label));
      }
      expect(problems).toEqual([]);
      expect(checked).toBeGreaterThan(100);
    });

    it('every e2e mock that reads the records contract still loads: each validates its own rows when imported (D-L97)', async () => {
      // A regression guard like the one above: it holds on main by design. A mock that derives
      // rows from this file throws at import when a schema change makes its rows invalid.
      const mocks = readdirSync(E2E_SUPPORT)
        .filter((name) => /-mock\.ts$/.test(name))
        .filter((name) => /records\.openapi\.yaml/.test(readFileSync(resolve(E2E_SUPPORT, name), 'utf8')));
      expect(mocks.length, 'no contract mock found').toBeGreaterThanOrEqual(8);
      const failures: string[] = [];
      for (const name of mocks) {
        try {
          await import(resolve(E2E_SUPPORT, name));
        } catch (error) {
          failures.push(`${name}: ${(error as Error).message}`);
        }
      }
      expect(failures).toEqual([]);
      // Lead edit (D-L154): each mock parses the 10k-line contract on import, and under a loaded
      // machine this took over vitest's default 5 s on main (2026-10-18). A slow import is not
      // a broken mock, so the guard waits on the imports rather than the clock.
    }, 60_000);
  });
});
