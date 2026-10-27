# T-0092 — Object storage adapter and `stored_object` (ADR-0017; migration, new dependencies)

**status** `done` (suite to be written; no task dependency) · **owner** Agent 3 · **priority** P1 · **decisions**
ADR-0017, D-L128 (ADR-0017 Q1–Q3), D-P30 item 1, D-L21, D-L94, D-L65, D-L23 · **migration** 0040 (projected; the lead
assigns the number at merge)

## Goal
Build ADR-0017 Decisions 1 to 6, without the import flow (T-0094). This task needs a CLAUDE.md section 8 decision for a new
adapter package, a new table and two new dependencies. ADR-0017 and D-P30 are that decision.
- **Depends on:** nothing. **Unblocks:** T-0094 and T-0096's real-API run.
- **`packages/storage-adapter`** (`scope:adapter`), with an `ObjectStore` port keyed by an opaque `StorageKey`:
  - `put`, `getStream`, `head` (size, content type and checksum; never content), `delete` and `deletePrefix`;
  - `presignUpload(key, { contentLength, partCount })` returns part URLs, each with its part's `Content-Length` signed,
    plus `completeUpload` and `abortUpload`. URLs expire in 5 minutes;
  - `S3ObjectStore` works over any S3-compatible endpoint, and an in-memory fake serves the unit tests.
  - The boundary lint rule names `@aws-sdk/*` as importable only from this package. `pnpm lint:boundaries:verify` proves
    it fires.
- **Keys:** `tenant/<tenantId>/programme/<programmeId>/<purpose>/<fileId>`.
  - The key is minted only from a `TenantTx`'s resolved session plus a server UUID.
  - The type cannot be built from a string. There is no filename, extension or user text in a key.
  - `purpose` is a closed enum (`import` only for now).
- **Production stores (D-L128 Q1):** one implementation covers AWS S3 `af-south-1` for `za-1` and MinIO for Lagos Silo
  cells.
  - Config: `S3_ENDPOINT` (optional for AWS), `S3_REGION`, `S3_BUCKET` and `S3_FORCE_PATH_STYLE` (MinIO and SeaweedFS
    need it).
  - The two static keys are optional together. When absent, the SDK's default chain is used (workload identity).
  - No region or bucket is ever read from a request.
- **Bridge (D-L128 Q2):** Bridge tenants use the cell's bucket under the same `tenant/<tenantId>/` prefix. There is no
  per-tier branch in code. `deletePrefix('tenant/<id>/')` is the offboarding path for every tier.
- **SSE-S3 (D-L128 Q3):**
  - `S3_SSE_MODE` is `AES256 | off`. `off` makes `@kasuwa/config` refuse to start any process outside development and test,
    the D-L94 rule.
  - `aws:kms` is refused until the per-cell KMS task.
  - Every `put` and every `CreateMultipartUpload` sends `ServerSideEncryption: AES256`. The fake records it so the unit
    tests assert it.
- **Two endpoints:** `S3_PUBLIC_ENDPOINT` is the host signed into browser URLs, and may differ from `S3_ENDPOINT`, the host
  the API and worker call. Without it, dev URLs point at a Docker-internal host.
  - `webEnv` gets only the public origin, for the CSP.
  - The credentials stay forbidden in the web process (T-0014).
- **The web CSP `connect-src`** gains the public storage origin. The bucket CORS rule admits only the web origin, PUT and
  GET, and exposes `ETag`.
- **Dev (ends D-L21's anonymous mode):** the compose SeaweedFS gets a mounted S3 identity config with credentials. A
  one-shot step creates the bucket and CORS rule. `pnpm dev` and `.env.example` are updated.
  - `packages/testing` gets a SeaweedFS Testcontainers helper, used beside Postgres. Application code never imports it.
- **Migration 0040, `stored_object`**, in the 0027 pattern:
  - columns: tenant, programme, key, purpose, declared and verified size, content type, sha256,
    `status pending|uploaded|rejected|deleted`, uploaded_by, created_at, `expires_at`;
  - RLS ENABLED and FORCED, with WITH CHECK identical to USING;
  - composite FKs to tenant and programme, RESTRICT, and the D-L76 key guard;
  - added to `TENANT_SCOPED_TABLES` and the `schema.ts` mirror;
  - `kasuwa_app` gets no DELETE (rows move to `deleted`). `key` is unique and immutable (trigger), so a row can never be
    pointed at another tenant's key.
- **A minimal repository:** create, read by id inside the caller's transaction, and status moves. A URL is issued only
  after the row is read in scope. An out-of-scope id is the one 404 body.
- **Logging:** never a key, filename, URL, endpoint credential or object content. Errors carry codes.
- **Dependencies:** `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, with ADR-0017's one-line justifications in
  the PR. `csv-parse` goes in T-0094, where it is used.
- **Size:** about 550 lines. If it runs over, split it: PR 1 is the config and dev store; PR 2 is the adapter and migration.

## Acceptance tests
- The suite: `tests/acceptance/platform/storage-adapter.acceptance.test.ts` (lead, D-L23). It runs real SeaweedFS and
  Postgres and proves:
  - keys are never built from request input;
  - a second tenant's `fileId` is 404 and gets no URL;
  - URLs expire;
  - the SSE header is sent;
  - `deletePrefix` leaves no object;
  - an oversized part is refused, by the bucket or, where SeaweedFS does not enforce a signed length, by `head` at
    complete. The suite pins which.
- Unmodified: `config-schemas`, `rls-enforcement`, `schema-hygiene`, `migration-runner` and the boundary-verify script.

## Non-goals
- the import endpoints, the job and the sweeper (T-0094);
- `presignDownload`: no consumer exists, because D-L128 Q6 rules out a failed-rows download. Add it with the export centre;
- SSE-KMS and per-tenant keys (later, D-L128 Q3);
- virus or content scanning (ADR-0017 Consequences: attachments must not reuse this flow);
- bucket lifecycle rules in real cells (T-0005; T-0094 states the rule it needs).
