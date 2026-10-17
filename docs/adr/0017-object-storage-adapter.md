# ADR-0017 — Object storage behind a storage adapter; the import upload flow

- **Status:** Accepted (D-L128, @acexode, 2026-10-13). Answers to its open questions are in D-L128.
  Approved in principle by D-P30 item 1 (@acexode, 2026-10-07); this ADR came before T-0092 as it asked.
- **Date:** 2026-10-13
- **Deciders:** Lead; @acexode

## Context
CSV import (M21 P0, design P28) is the first feature that stores a customer's file. Nothing in the repo reads or writes object
storage today. `docker-compose.yml` runs SeaweedFS with anonymous S3 access (D-L21: MinIO's images are no longer freely
pullable), and `.env.example` already carries `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` and the two credentials, which
`@kasuwa/config` forbids in the web process.

An import file is a bulk of customer PII: names, phones, emails, sometimes balances. It must be held to the same isolation as a
contact row, yet object storage has no RLS. The forces:
- **Tenancy.** A bucket key is a string. A key the client chooses, or a URL handed out without a scope check, is a cross-tenant
  read. CLAUDE.md 2.2: the session decides scope, never the caller.
- **The API process.** Streaming a 50 MB upload through NestJS ties up memory and an event loop that serves screen-pops.
- **Erasure.** D-P27 and D-L83 require erasure to reach every copy of a person. A row inside a CSV cannot be found by subject.
- **Residency.** ADR-0002's tiers: Pooled tenants share cell `za-1`; Silo tenants (banks, government, large BPOs) get their own
  cell, possibly in Lagos. A file must stay in its tenant's cell.
- **Adapters.** CLAUDE.md 2.8: external systems are named in exactly one package. Object storage is one.

## Decision
1. **A new `packages/storage-adapter` (`scope:adapter`).** It exports a narrow `ObjectStore` port and is the only package that
   names an S3 SDK; the boundary lint rule enforces this. Its interface, keyed by an opaque `StorageKey`:
   - `put(key, stream, { contentType, contentLength })` and `getStream(key)` for server-side use (the worker);
   - `head(key)` returning size, content type and checksum, never content;
   - `delete(key)` and `deletePrefix(prefix)` (tenant offboarding, programme closure);
   - `presignUpload(key, { contentLength, partCount })` returning presigned multipart part URLs plus `completeUpload` and
     `abortUpload`, as D-P30 approved; `presignDownload(key, { filename })`. Both expire in **5 minutes**.
   One implementation, `S3ObjectStore`, over any S3-compatible endpoint, and an in-memory fake for unit tests, as with
   ADR-0003's adapters. Every call sends server-side encryption headers.
2. **Keys are minted by the server from the session.** `StorageKey` can only be built by a function taking the resolved tenant
   and programme from `withTenantTransaction`, never request input:
   `tenant/<tenantId>/programme/<programmeId>/<purpose>/<fileId>`, with `fileId` a server UUID. No filename, extension or
   user text appears in a key (D-P30). The original filename lives in the metadata row and is never logged.
3. **Every object has a metadata row, and access goes through it.** A tenant-scoped `stored_object` table (tenant, programme,
   key, purpose, declared and verified size, content type, sha256, status `pending|uploaded|rejected|deleted`, uploaded by,
   created, `expires_at`), in the 0027 pattern: RLS ENABLED and FORCED, `WITH CHECK` identical to `USING`,
   `TENANT_SCOPED_TABLES`, composite FKs. A presigned URL is issued only after the row is read inside the caller's tenant
   transaction; a row the caller cannot see is `404` (CLAUDE.md 6.4). The key prefix is a second layer, not the guard. The
   import job table (`import_job`) is T-0094's migration and references `stored_object`.
4. **The API never carries file bytes and never logs row contents.** Uploads go browser-to-bucket on presigned URLs; the API
   handles only metadata. Neither API nor worker logs a cell value, a header row, a filename or a parse error's source line;
   errors cite row number, column key and a code. The storage host joins the web CSP `connect-src` and the bucket CORS rule
   admits only the web origin, PUT and GET.
5. **Residency: one bucket per cell.** The bucket, region and endpoint come from the cell's configuration via `@kasuwa/config`,
   so Pooled tenants share `za-1`'s bucket and a Silo cell has its own, in its own region. The adapter takes no region from a
   request. Bridge is an open question below.
6. **Server-side encryption is mandatory in deployed cells** (SSE-S3 at minimum); `@kasuwa/config` refuses to start a deployed
   process with it off. SeaweedFS in development may ignore the header; the adapter's tests assert it is sent.

### The import flow end to end
1. **Initiate.** `POST /imports` with declared filename, size and content type (Zod-validated). The API checks the
   `contact.import` permission, inserts `stored_object` (`pending`) and `import_job` (`awaiting_upload`) in one tenant
   transaction, writes an audit event, and returns part URLs. Limits are checked here: **≤ 25 MB**, `text/csv` or `.csv`
   only, ≤ 4 parts; each part's `Content-Length` is signed, so the bucket rejects a larger body.
2. **Upload.** The browser PUTs parts to the bucket and calls `POST /imports/:id/complete`. The API completes the multipart
   upload, `head`s the object, and rejects (and deletes) one whose size or type differs from the declaration.
3. **Map.** The worker reads the header row only and stores column names for P28's mapping step; the user picks a mapping
   template and confirms. Header names are stored, never logged.
4. **Parse and validate.** A BullMQ job `kasuwa.import.run` (payload Zod-parsed: ids only, no row data) streams the object
   through `csv-parse`, with a cap of **100,000 rows** and 64 KB per row. Each row is parsed with the same Zod schema the
   contacts API uses. D-P28 applies: an import may set `dnd`, opt-out and `whatsapp_opt_in = false`, never grant consent.
   Writes go through the contact repository inside `withTenantTransaction`, in batches, as the initiating user, so scope is
   re-resolved from `user_programme` when the job runs. A user who lost the programme fails the job.
5. **Dedupe hook (T-0095).** Each validated row passes through a `DuplicateCandidatePort` before insert. Until T-0095 lands it
   flags exact phone or email matches within the programme (D-P12, ADR-0014's jsonb indexes) as "skipped, possible duplicate";
   it never merges and never looks across programmes.
6. **Result report.** `import_job` records counts (created, skipped, failed) and a list of `{row, column, code}` errors. No cell
   values. The screen shows it and links each created contact through the normal scoped reads.
7. **Retention.** The raw file is deleted **7 days** after the job ends (or 24 hours after an abandoned `pending` row), by a
   sweeper job, and `stored_object` moves to `deleted`. Imported contacts follow D-P27 like any other contact.

### Erasure and audit
- Because a subject cannot be located inside a CSV, the **short retention window is the erasure mechanism**: no raw import file
  outlives 7 days, so a DSAR erase is complete for stored files within 7 days. Tenant offboarding runs `deletePrefix` on the
  tenant prefix. Legal hold against this window is M21 Q1, for counsel.
- Audited events, by id and never by content: import initiated, upload completed or rejected, job finished (with counts),
  raw file deleted, and every `presignDownload` (CLAUDE.md 6.7 treats exports as sensitive). The outbox is not built, so
  audit is written in the same transaction as the state change, as today.

### Dependencies (all three approved in D-P30; justifications go in T-0092's PR)
- `@aws-sdk/client-s3`: the maintained S3 client; works against SeaweedFS, AWS S3 and a licensed MinIO unchanged.
- `@aws-sdk/s3-request-presigner`: SigV4 presigning for the part and download URLs, so bytes never pass through the API.
- `csv-parse`: streaming, RFC 4180 CSV with quoted newlines and BOM handling; a hand-rolled parser gets these wrong.

Alternatives considered:
- **A lighter client** (`aws4fetch`, or `minio`'s JS client). Smaller, but we would hand-roll multipart and SSE handling or
  tie ourselves to one vendor. The v3 SDK is modular, and only the two packages above are installed.
- **Local filesystem in development.** Rejected: dev would never exercise presigning, CORS or key isolation, which is where the
  bugs live. SeaweedFS is already in the stack.
- **Streaming through the API**: rejected by Decision 4.

### Development and test
- `pnpm dev` uses the compose SeaweedFS on `59000`. T-0092 turns on credentialled access (an S3 identity config mounted into
  the container) and creates the bucket and CORS rule, ending D-L21's anonymous mode, so dev exercises signing.
- Unit tests use the in-memory fake. Integration tests start SeaweedFS with Testcontainers beside Postgres and prove: keys are
  never built from request input, a second tenant's `fileId` is `404` and gets no URL, an oversized part is refused by the
  bucket, URLs expire, the result report holds no cell value, and deleted rows leave no object.
- Endpoint, region, bucket, credentials and SSE mode are read only through `@kasuwa/config`, Zod-parsed, and never logged.
  Deployed cells use workload identity where the provider offers it; static keys only from the environment.

## Consequences
- Import ships without a second isolation model: RLS guards the metadata, and the server-minted prefix guards the bytes.
- The API stays small under load; the worker carries parsing and its memory profile.
- A 7-day window means a failed import cannot be retried from the stored file after a week; the user re-uploads.
- **Gap: no virus or content scanning.** CSV is parsed as text and never executed or served back as-is, which limits the risk,
  but attachments (inbox, KB) must not reuse this flow until scanning is designed. Formula injection (`=`, `+`, `-`, `@`
  leading cells) is neutralised on any future export, not on import.
- **Revisit when** attachments, recordings or the export centre arrive: each needs its own retention and audit, and exports
  need the watermarking and approval thresholds in M21 Q2.

## Open questions for @acexode
1. **Production store.** AWS S3 in `af-south-1` for `za-1`, or a licensed MinIO, especially for Lagos Silo cells (D-L21)?
2. **Bridge tenants.** A dedicated bucket in the shared cell, or the shared bucket with their prefix?
3. **SSE-S3 or SSE-KMS** with a per-cell key (and per-tenant keys for Silo)?
4. **Limits.** Are 25 MB and 100,000 rows right for the first BPO tenants, or is a larger cap needed at launch?
5. **Retention.** Is 7 days for raw files acceptable to counsel, and does legal hold ever extend it (M21 Q1)?
6. **Failed-rows download.** Should users get a CSV of failed rows with their values? That is an export of PII: permission-gated,
   audited and subject to M21 Q2. This ADR leaves it out.
7. **Worker identity.** The import job acts as the initiating user inside `withTenantTransaction`. No worker does this yet;
   confirm before T-0094 builds it, or say if a different pattern is wanted.
