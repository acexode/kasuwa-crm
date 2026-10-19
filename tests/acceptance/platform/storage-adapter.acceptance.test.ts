import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { collectTelemetry, reseed, startSeaweedFs, type StartedSeaweedFs } from '@kasuwa/testing';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import * as ts from 'typescript';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

/**
 * ACCEPTANCE — T-0092, the object storage adapter and `stored_object`
 * (ADR-0017 Decisions 1 to 6; Agent 3; migration, new dependencies).
 *
 * Sources: team/tasks/T-0092-storage-adapter.md; docs/adr/0017-object-storage-
 * adapter.md; D-P30 item 1 (the package and its two SDK dependencies); D-L128
 * Q1-Q3 (one implementation for AWS S3 and MinIO, Bridge shares the cell
 * bucket under its prefix, SSE-S3 now); D-L146 (lifecycle backstop, `head` 404
 * reconciles to `deleted`); D-L94 (refuse unsafe config outside development
 * and test); D-L76 (the allow-list key guard); CLAUDE.md 2.1-2.4, 2.7, 2.8,
 * 6.1, 6.3, 6.4.
 *
 * Written from the invariants before any implementation (D-L23, D-L25). It
 * runs against REAL SeaweedFS and REAL Postgres through Testcontainers.
 * SeaweedFS comes from `startSeaweedFs` in `@kasuwa/testing`
 * (packages/testing/src/seaweedfs.ts), added by the lead with this suite:
 * credentialled, and with an unauthenticated filer view so that what the
 * bucket holds is read WITHOUT going through the adapter under test.
 *
 * Every export of the new package (and `storageEnv`) is reached through a
 * dynamic import, so this file collects on main and each test fails on its own
 * line with the real reason: no package, no export, no table.
 *
 * ---------------------------------------------------------------------------
 * PINNED (the builder must honour these exactly)
 * ---------------------------------------------------------------------------
 *
 * B. BOUNDARY. `packages/storage-adapter`, package name
 *    `@kasuwa/storage-adapter`, nx tag `scope:adapter`, mapped in
 *    tsconfig.base.json and vitest.workspace.ts. It is the ONLY package.json
 *    in apps/** and packages/** that lists an `@aws-sdk/*` dependency, and it
 *    lists `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`. No source
 *    file outside it names an `@aws-sdk/` module, in any import form. ESLint
 *    reports a planted `@aws-sdk/client-s3` import in a domain package, the
 *    api, the worker, the web app, a shared package and ANOTHER adapter, and
 *    does not report it inside packages/storage-adapter.
 *
 * P. THE PORT. `@kasuwa/storage-adapter` exports:
 *      S3ObjectStore            class; `new S3ObjectStore(storageEnv(env))`
 *      ObjectStore, StorageKey  types
 *      mintStorageKey(tx, { programmeId, purpose }): StorageKey
 *      tenantStoragePrefix(tenantId): StoragePrefix
 *      STORAGE_PURPOSES         exactly ['import']
 *      StoredObjectRepository   class; `new StoredObjectRepository(store)`
 *      StoredObjectNotFoundError
 *    An ObjectStore has exactly the eight methods of the task:
 *      put(key, body: Readable, { contentType, contentLength })
 *      getStream(key): AsyncIterable<Uint8Array> (or a promise of one)
 *      head(key): { size, contentType, ... } | null   (null: no such object)
 *      delete(key)                                    (idempotent)
 *      deletePrefix(prefix)
 *      presignUpload(key, { contentLength, partCount }):
 *        { uploadId, parts: { partNumber, url, contentLength }[] }
 *      completeUpload(key, uploadId, parts: { partNumber, etag }[])
 *      abortUpload(key, uploadId)
 *
 * K. KEYS. `String(key)` is exactly
 *    `tenant/<tenantId>/programme/<programmeId>/<purpose>/<fileId>`, all
 *    lower-case, fileId a fresh v4 UUID. The tenant comes from
 *    `tx.session.tenantId` and nowhere else; the programme must be one of
 *    `tx.session.programmeIds`; the purpose one of STORAGE_PURPOSES. Extra
 *    input (a tenantId, a fileId, a filename) is ignored. At the TYPE level a
 *    string is not a StorageKey and no store method takes one; at RUN TIME
 *    every store method refuses a key it did not mint (a string, a look-alike
 *    object, a clone) before any request reaches the bucket (R2).
 *
 * U. SIGNED URLS. Every part URL is on the PUBLIC endpoint's origin
 *    (S3_PUBLIC_ENDPOINT), carries `X-Amz-Expires=300` and signs
 *    `content-length` and `host`. The part lengths sum to the declared length
 *    and every part but the last is at least 5 MiB (S3's minimum; a partCount
 *    that cannot satisfy it is refused, as is a length <= 0). The bucket
 *    refuses: a body one byte longer or shorter than the signed length; a URL
 *    signed more than 5 minutes ago; a URL whose partNumber, key or expiry was
 *    edited. After abortUpload, parts already sent cannot be completed (R12).
 *    ON SEAWEEDFS 3.80 THE BUCKET ITSELF ENFORCES THE SIGNED LENGTH (R5,
 *    observed by the lead before the build).
 *    `head` at complete is the second layer and is pinned too: completing
 *    with a part missing yields `rejected`, and the object is deleted.
 *
 * E. ENCRYPTION. Every PutObject and every CreateMultipartUpload the adapter
 *    sends carries `x-amz-server-side-encryption: AES256`, with S3_SSE_MODE
 *    unset (the default). Observed on the wire by a recording proxy between
 *    the adapter and the bucket, not by asking the adapter.
 *
 * O. OFFBOARDING. `deletePrefix(tenantStoragePrefix(A))` leaves no object
 *    under `tenant/<A>/` (10,050 of them: more than one SeaweedFS listing
 *    page, and more than ten DeleteObjects calls' worth), aborts
 *    A's in-flight multipart uploads so none can be completed afterwards, and
 *    leaves tenant B's objects alone. tenantStoragePrefix refuses a non-UUID;
 *    deletePrefix refuses a prefix it did not mint ('', 'tenant/', a string)
 *    and deletes nothing.
 *
 * C. CONFIG. `@kasuwa/config` exports `storageEnv(env)`, judged on the
 *    environment it is GIVEN: S3_REGION and S3_BUCKET required; S3_ENDPOINT
 *    and S3_PUBLIC_ENDPOINT optional URLs; S3_FORCE_PATH_STYLE 'true' |
 *    'false'; the two static keys optional TOGETHER; S3_SSE_MODE 'AES256'
 *    (default) | 'off'; 'off' is refused under NODE_ENV=production, and so is
 *    'aws:kms' everywhere. apiEnv and workerEnv refuse S3_SSE_MODE=off under
 *    production too. webEnv accepts and returns S3_PUBLIC_ENDPOINT and refuses
 *    S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_ENDPOINT (R9). No refusal
 *    echoes a secret.
 *
 * D. DEV STORE (ends D-L21's anonymous mode). docker-compose's seaweedfs runs
 *    with `-s3.config=<path>` and mounts a repository file there; that file
 *    is an identity config whose every identity has credentials and none is
 *    `anonymous`; `.env.example`'s two keys are one of its credentials; the
 *    command passes `-s3.allowedOrigins=<origin,...>` with no wildcard (R11);
 *    `.env.example` names S3_ENDPOINT, S3_PUBLIC_ENDPOINT, S3_REGION,
 *    S3_BUCKET, S3_FORCE_PATH_STYLE=true and S3_SSE_MODE. LIVE: SeaweedFS
 *    started with that very file and origin list refuses an unsigned read and
 *    list, accepts the `.env.example` keys through S3ObjectStore, admits a
 *    preflight from the first listed origin and not from another.
 *
 * T. THE TABLE `stored_object` (exact columns, R3):
 *      id uuid PK, tenant_id uuid NOT NULL, programme_id uuid NOT NULL,
 *      key text NOT NULL, purpose text NOT NULL,
 *      declared_size_bytes bigint NOT NULL, verified_size_bytes bigint NULL,
 *      content_type text NOT NULL, sha256 bytea NULL,
 *      status text NOT NULL DEFAULT 'pending',
 *      uploaded_by_user_id uuid NOT NULL,
 *      created_at timestamptz NOT NULL DEFAULT now(),
 *      expires_at timestamptz (nullability the builder's)
 *    One migration file creates it. RLS ENABLED and FORCED; every permissive
 *    policy names app.current_tenant_id() and app.current_programme_ids();
 *    one has WITH CHECK identical to USING; in TENANT_SCOPED_TABLES and the
 *    schema.ts mirror; owned by kasuwa_migrator. FKs: (tenant_id,
 *    programme_id) -> programme and (tenant_id, uploaded_by_user_id) ->
 *    "user"; every FK carries tenant_id and is ON UPDATE RESTRICT. kasuwa_app
 *    holds SELECT, INSERT and some UPDATE, and NO DELETE (a DELETE is 42501);
 *    nothing it can enter holds DELETE, TRUNCATE or BYPASSRLS; kasuwa_auth
 *    holds nothing. `key` has a unique index on (key) alone and equals
 *    `tenant/<tenant_id>/programme/<programme_id>/<purpose>/<id>` (R1);
 *    purpose is 'import'; status is pending | uploaded | rejected | deleted;
 *    declared_size_bytes > 0; sha256, when set, is 32 bytes. As kasuwa_app,
 *    key, id, tenant_id, programme_id, purpose, uploaded_by_user_id,
 *    created_at and declared_size_bytes never change; as kasuwa_test_admin
 *    (BYPASSRLS) key, id, tenant_id, programme_id and purpose never change
 *    (D-L76). The migrator can still delete a tenant or programme holding
 *    rows. No SECURITY DEFINER function is added (CLAUDE.md 2.7).
 *
 * S. SCOPE. `StoredObjectRepository.get`, `.presignUpload`,
 *    `.completeUpload` and `.markDeleted` on an id the caller cannot see
 *    (another programme, another tenant, invented, malformed, or a caller
 *    with no programme) all reject with ONE error: a
 *    StoredObjectNotFoundError with the same message and code every time,
 *    naming no id; and the store is never asked for a URL or anything else.
 *    The repository reads scope from `tx.session` and ALSO filters
 *    explicitly (CLAUDE.md 2.3): a tx whose session is narrower than the
 *    database's GUCs still cannot read the wider rows (R7).
 *
 * L. LOGGING. Nothing the adapter or repository writes to the console,
 *    stdout, stderr, OpenTelemetry logs or spans contains a key (its full
 *    text), a URL or its signature, or a credential (secret or access key
 *    id); and no error they throw carries one in its message, stack, own
 *    properties or cause chain. Errors carry a string `code`. Bare ids (a row
 *    id, an upload id) are NOT held to this: ADR-0017 audits by id.
 *
 * ---------------------------------------------------------------------------
 * RULINGS BEYOND THE TASK FILE (R-numbers are this suite's; the lead accepts
 * or reverses each)
 * ---------------------------------------------------------------------------
 *  R1  fileId IS the stored_object id, and the key column is derived from the
 *      row. The key is then never a separate input that could point a row at
 *      another tenant's bytes, and the repository can rebuild a StorageKey
 *      from a row it read in scope without parsing a string. The database
 *      enforces the equality (CHECK, generated column or trigger: the
 *      builder's; the end state is pinned).
 *  R2  Run-time refusal of unminted keys, not only a type. A branded string
 *      is erased at run time, and T-0094's handlers will be JavaScript by
 *      then. A class with a private brand (`#brand in key`) satisfies it.
 *  R3  No `filename` column, despite ADR-0017 Decision 2 ("the original
 *      filename lives in the metadata row"): the task's column list is
 *      exhaustive and omits it, and a filename is user text that is PII-
 *      adjacent. If T-0094 needs it, it lives on import_job. Column names:
 *      `declared_size_bytes`, `verified_size_bytes`, `uploaded_by_user_id`
 *      (the house `_user_id` suffix); sha256 is bytea (as the auth hashes).
 *  R4  The repository record never carries the key text (its JSON contains
 *      no `tenant/` path), so no API that serialises it can leak one.
 *  R5  OVERSIZED PART, SEAWEEDFS 3.80, observed by the lead before the build
 *      with hand-signed SigV4 part URLs (2026-10-18):
 *        - SignedHeaders content-length;host, body N+1, N-1 or 1 MB on an
 *          N-byte URL: 403 SignatureDoesNotMatch. The exact N: 200.
 *        - The SAME URL without content-length signed: a 50-byte body on a
 *          10-byte part is ACCEPTED. The guard is entirely the signed header.
 *        - Signed 6 minutes ago, X-Amz-Expires=300: 403 "Request has
 *          expired". Signed 4 minutes ago: 200.
 *      So on SeaweedFS the BUCKET refuses the oversized part, and that is
 *      what U pins. The complete-time `head` is pinned too, as the layer that
 *      catches a short upload (a part never sent).
 *  R6  Expiry is driven by the system clock: the suite fakes `Date` (only
 *      `Date`) while it asks for the URLs. An implementation that signs with
 *      the current time needs nothing extra. SeaweedFS 3.80 does not check
 *      clock skew on header-signed requests at all (a HEAD signed 20 minutes
 *      ago: 200), so the CreateMultipartUpload made under the faked clock
 *      still succeeds there. AWS allows 15 minutes, so it would too.
 *  R7  "Repositories also filter explicitly" is observable: a TenantTx whose
 *      `session` names agent 1 (A1) on a connection whose GUCs are the
 *      supervisor's (A1 and A2) must not read an A2 row. RLS alone would let
 *      it through.
 *  R8  presignUpload is only for a `pending` row; completeUpload for a
 *      `pending` row; markDeleted from any status. A refused move issues no
 *      URL. `deleted` is terminal.
 *  R9  webEnv refuses S3_ENDPOINT, the internal host, as WEB_FORBIDDEN
 *      already refuses REDIS_URL and OPENSEARCH_URL. (tests/e2e/scripts/
 *      run-e2e.mjs then has to blank it for the web process too.)
 *  R10 deletePrefix also aborts the prefix's in-flight multipart uploads.
 *      A tenant offboarded while an upload is open would otherwise get the
 *      file back when the browser completes it inside the 5 minutes.
 *      (SeaweedFS 3.80 answers ListMultipartUploads with a prefix.)
 *  R12 SEAWEEDFS 3.80 REVIVES AN ABORTED UPLOAD (observed): a part PUT on a
 *      live URL after AbortMultipartUpload is accepted, the upload directory
 *      is recreated (and NOT listed by ListMultipartUploads), and
 *      CompleteMultipartUpload then succeeds. AWS refuses that part (404
 *      NoSuchUpload). No adapter can fix the bucket, so the suite pins only
 *      what an adapter controls: parts sent BEFORE the abort cannot be
 *      completed. Consequence for dev: after deletePrefix, a browser holding a
 *      live part URL can still leave orphan bytes for up to 5 minutes, which
 *      only the API's complete step (T-0094, row read in scope) keeps from
 *      becoming an object.
 *  R11 DEV CORS. SeaweedFS 3.80 has NO per-bucket CORS: PutBucketCors is 501
 *      NotImplemented, and by default every preflight from every origin is
 *      answered `Access-Control-Allow-Origin: *`. Its one control is the
 *      gateway flag `-s3.allowedOrigins`: an origin not on the list gets its
 *      connection dropped, a listed one is still answered with `*` for
 *      origin, methods and exposed headers. So in dev the suite pins the
 *      origin restriction through that flag, and "PUT and GET only, expose
 *      ETag" is not expressible on SeaweedFS (real cells: T-0005).
 *
 * ---------------------------------------------------------------------------
 * NOT PINNED HERE, said rather than faked
 * ---------------------------------------------------------------------------
 *  - The web CSP `connect-src` (task: "gains the public storage origin").
 *    apps/web sets NO Content-Security-Policy today (no header, no meta, no
 *    middleware), so there is nothing to gain an origin. Adding a CSP is its
 *    own security task; escalated in the report, not invented here.
 *  - The bucket CORS rule's methods and exposed headers (R11), and the
 *    one-shot step that creates the dev bucket: what it runs is the
 *    builder's. (SeaweedFS also creates a bucket on the first PUT to it, so
 *    a missing step would not show in dev; it would in a MinIO cell.)
 *  - "No region or bucket is read from a request": T-0092 has no endpoint.
 *    storageEnv is the only source the store accepts (P), which is the part
 *    that can be pinned.
 *  - SSE at rest on SeaweedFS: SeaweedFS 3.80 accepts the header; whether it
 *    encrypts is not observable and not ours (ADR-0017 Decision 6).
 *  - `pnpm lint:boundaries:verify` is listed "unmodified" by the task, yet the
 *    task also says it proves the @aws-sdk rule fires. Both cannot hold; this
 *    suite plants the probes itself (B), and the verify script stays as is.
 *  - The in-memory fake and its SSE recording are the unit tests' (task).
 *
 * VACUOUS-PASS GUARDS. Before the build there is no package, no `storageEnv`
 * and no table: the module loaders fail with the reason, plantRows() fails
 * with 42P01, and the catalogue reads check the table exists before counting
 * what it lacks. Every "refused" probe stands beside an accepted control in
 * the same session; every negative scan has a self-check that plants the
 * defect and watches it caught. Self-checks that pass on main say so.
 *
 * PII. Nothing here is a person. Object bodies are generated bytes; the one
 * CSV-like body names no one.
 *
 * WRITES. Rows planted by the migrator use this suite's id range
 * (`0092....-0000-4000-8000-...`); probes roll back; the repository's own
 * writes commit and are removed by the reseed after the file (TRUNCATE tenant
 * CASCADE). Objects live in a container that is thrown away.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const fromRoot = (...parts: string[]): string => resolve(REPO_ROOT, ...parts);
const MIGRATIONS_DIR = fromRoot('packages/db/migrations');

const ADAPTER_MODULE = '@kasuwa/storage-adapter';
const CONFIG_MODULE = '@kasuwa/config';

const MiB = 1024 * 1024;
const MIN_PART = 5 * MiB;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ===========================================================================
// The contract, as types. Everything below is checked at run time first.
// ===========================================================================

type Env = Readonly<Record<string, string | undefined>>;
type EnvFn = (source: Env) => unknown;

/** Opaque: the suite only ever stringifies it or hands it back. */
type Key = { toString(): string };
type Prefix = { toString(): string };

interface PresignedPart {
  partNumber: number;
  url: string;
  contentLength: number;
}
interface PresignedUpload {
  uploadId: string;
  parts: PresignedPart[];
}
interface HeadResult {
  size: number;
  contentType?: string | undefined;
  [extra: string]: unknown;
}
interface CompletedPart {
  partNumber: number;
  etag: string;
}

interface ObjectStore {
  put(key: Key, body: Readable, options: { contentType: string; contentLength: number }): Promise<unknown>;
  getStream(key: Key): AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;
  head(key: Key): Promise<HeadResult | null>;
  delete(key: Key): Promise<unknown>;
  deletePrefix(prefix: Prefix): Promise<unknown>;
  presignUpload(key: Key, options: { contentLength: number; partCount: number }): Promise<PresignedUpload>;
  completeUpload(key: Key, uploadId: string, parts: CompletedPart[]): Promise<unknown>;
  abortUpload(key: Key, uploadId: string): Promise<unknown>;
}

const STORE_METHODS = [
  'put',
  'getStream',
  'head',
  'delete',
  'deletePrefix',
  'presignUpload',
  'completeUpload',
  'abortUpload',
] as const;

interface StoredObjectRecord {
  id: string;
  tenantId: string;
  programmeId: string;
  purpose: string;
  status: string;
  declaredSizeBytes: number;
  verifiedSizeBytes: number | null;
  contentType: string;
  [extra: string]: unknown;
}

interface StoredObjectRepository {
  create(
    tx: TenantTx,
    input: { programmeId: string; purpose: string; declaredSizeBytes: number; contentType: string },
  ): Promise<StoredObjectRecord>;
  get(tx: TenantTx, id: string): Promise<StoredObjectRecord>;
  presignUpload(tx: TenantTx, id: string, options: { partCount: number }): Promise<PresignedUpload>;
  completeUpload(
    tx: TenantTx,
    id: string,
    input: { uploadId: string; parts: CompletedPart[] },
  ): Promise<StoredObjectRecord>;
  markDeleted(tx: TenantTx, id: string): Promise<StoredObjectRecord>;
}

interface AdapterModule {
  S3ObjectStore: new (config: unknown) => ObjectStore;
  StoredObjectRepository: new (store: ObjectStore) => StoredObjectRepository;
  StoredObjectNotFoundError: new (...args: never[]) => Error;
  mintStorageKey: (tx: TenantTx, input: Record<string, unknown>) => Key;
  tenantStoragePrefix: (tenantId: string) => Prefix;
  STORAGE_PURPOSES: readonly string[];
}

async function adapter(): Promise<AdapterModule> {
  const loaded: Record<string, unknown> = { ...(await import(ADAPTER_MODULE)) };
  for (const name of [
    'S3ObjectStore',
    'StoredObjectRepository',
    'StoredObjectNotFoundError',
    'mintStorageKey',
    'tenantStoragePrefix',
  ]) {
    expect(typeof loaded[name], `${ADAPTER_MODULE} does not export ${name} (P)`).toBe('function');
  }
  expect(Array.isArray(loaded.STORAGE_PURPOSES), `${ADAPTER_MODULE} does not export STORAGE_PURPOSES`).toBe(true);
  return loaded as unknown as AdapterModule;
}

/** T-0125 (ADR-0019, D-L178): webEnv requires both session URLs in every mode. */
const WEB_SESSION_URLS = {
  KASUWA_WEB_ORIGIN: 'http://localhost:3000',
  KASUWA_API_INTERNAL_URL: 'http://127.0.0.1:3001',
};

async function configFn(name: 'storageEnv' | 'apiEnv' | 'workerEnv' | 'webEnv'): Promise<EnvFn> {
  const loaded: Record<string, unknown> = { ...(await import(CONFIG_MODULE)) };
  const candidate = loaded[name];
  expect(typeof candidate, `${CONFIG_MODULE} does not export ${name}(env) (C)`).toBe('function');
  return candidate as EnvFn;
}

/** The error a call throws (sync or async). Fails, with a reason, if it does not throw. */
async function rejectionOf(call: () => unknown, because: string): Promise<Error> {
  try {
    await call();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`${because}: threw a non-Error value (${String(error)})`);
  }
  throw new Error(`${because}: it did not throw`);
}

// ===========================================================================
// Fixtures and helpers
// ===========================================================================

const id92 = (tail: string): string => `00920000-0000-4000-8000-${tail.padStart(12, '0')}`;

/** Planted by the migrator: one row per scope the attacks need. */
const ROW_A1 = id92('a1');
const ROW_A2 = id92('a2');
const ROW_B1 = id92('b1');
const ROW_A1_SPARE = id92('a1f');
const INVENTED = id92('dead');

const keyText = (tenantId: string, programmeId: string, id: string): string =>
  `tenant/${tenantId}/programme/${programmeId}/import/${id}`;

const PLANTED: readonly { id: string; tenantId: string; programmeId: string; userId: string }[] = [
  { id: ROW_A1, tenantId: TENANT_A, programmeId: PROGRAMME_A1, userId: USER_A_AGENT_1 },
  { id: ROW_A1_SPARE, tenantId: TENANT_A, programmeId: PROGRAMME_A1, userId: USER_A_AGENT_1 },
  { id: ROW_A2, tenantId: TENANT_A, programmeId: PROGRAMME_A2, userId: USER_A_AGENT_2 },
  { id: ROW_B1, tenantId: TENANT_B, programmeId: PROGRAMME_B1, userId: USER_B_AGENT_1 },
];

const INSERT_ROW = `
  INSERT INTO stored_object (id, tenant_id, programme_id, key, purpose, declared_size_bytes,
                             content_type, status, uploaded_by_user_id, expires_at)
  VALUES ($1, $2, $3, $4, 'import', $5, 'text/csv', 'pending', $6, now() + interval '1 day')`;

type Query = <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<R[]>;

type Outcome =
  | { accepted: true; rows: number }
  | { accepted: false; code: string; message: string };

function outcomeOf(error: unknown): Outcome {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    accepted: false,
    code: typeof code === 'string' ? code : '?',
    message: typeof message === 'string' ? message : String(error),
  };
}

/** One statement under a savepoint, always rolled back to it. */
async function probe(query: Query, sql: string, values: unknown[] = []): Promise<Outcome> {
  await query('SAVEPOINT t0092_probe');
  let outcome: Outcome;
  try {
    const rows = await query(sql, values);
    await query('SET CONSTRAINTS ALL IMMEDIATE');
    outcome = { accepted: true, rows: rows.length };
  } catch (error) {
    outcome = outcomeOf(error);
  }
  await query('ROLLBACK TO SAVEPOINT t0092_probe');
  return outcome;
}

/** 42P01 and 42703 are NEVER a refusal: they say what is missing. */
function verdict(outcome: Outcome): string {
  if (outcome.accepted) return 'accepted';
  const { code, message } = outcome;
  if (code === '23503') return 'foreign_key_violation';
  if (code === '23505') return 'unique_violation';
  if (code === '42501') return 'insufficient_privilege';
  if (code === '428C9') return 'refused'; // a generated column cannot be written
  if (code === 'P0001' || code.startsWith('23') || code.startsWith('22')) return 'refused';
  return `error ${code}: ${message}`;
}
const REFUSED = ['refused', 'foreign_key_violation', 'insufficient_privilege', 'unique_violation'];

class Rollback<T> {
  constructor(readonly value: T) {}
}

/** withTenantTransaction, but nothing commits. */
async function rolledBackTenantTx<T>(
  pool: Pool,
  tenantId: string,
  userId: string,
  fn: (query: Query, tx: TenantTx) => Promise<T>,
): Promise<T> {
  try {
    await withTenantTransaction(pool, { tenantId, userId }, async (tx) => {
      const query: Query = (text, params) => tx.query(text, params);
      throw new Rollback(await fn(query, tx));
    });
  } catch (signal) {
    if (signal instanceof Rollback) return signal.value as T;
    throw signal;
  }
  throw new Error('unreachable: the callback always throws');
}

async function rolledBackTx<T>(pool: Pool, fn: (query: Query) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const query: Query = async (text, params) => (await client.query(text, params)).rows;
    return await fn(query);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Deterministic bytes of a given length (no randomness, no person). */
function bytes(length: number, seed: number): Buffer {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) buffer[i] = (i * 31 + seed) & 0xff;
  return buffer;
}

async function drain(stream: AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** PUT one part to a presigned URL, as a browser would. Returns status and ETag. */
async function putPart(url: string, body: Buffer): Promise<{ status: number; etag: string }> {
  const response = await fetch(url, { method: 'PUT', body });
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status, etag: response.headers.get('etag') ?? '' };
}

// --- the recording proxy -------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: IncomingHttpHeaders;
}

interface RecordingProxy {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

/**
 * A pass-through HTTP proxy in front of SeaweedFS that records every request
 * the adapter makes (method, path, query, headers). The Host header is
 * forwarded unchanged, so SigV4 signatures still verify. It is how E is
 * observed on the wire rather than by asking the adapter what it sent.
 */
async function startRecordingProxy(target: string): Promise<RecordingProxy> {
  const upstream = new URL(target);
  const requests: RecordedRequest[] = [];
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://proxy.invalid');
    requests.push({
      method: incoming.method ?? '',
      path: url.pathname,
      search: url.searchParams,
      headers: { ...incoming.headers },
    });
    const headers = { ...incoming.headers };
    delete headers.expect; // Node answered 100-continue already; never signed (SigV4 skips it)
    const forward = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: incoming.url,
        headers,
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      },
    );
    forward.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(forward);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

// --- output capture (L) ----------------------------------------------------------

interface Captured {
  lines: string[];
  telemetry: string[];
}

/** Console, stdout, stderr and OpenTelemetry, for the duration of `fn`. */
async function captureEverything(fn: () => Promise<void>): Promise<Captured> {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : safeJson(arg))).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'info').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'debug').mockImplementation(record),
    vi.spyOn(console, 'trace').mockImplementation(record),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      record(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      record(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return true;
    }),
  ];
  try {
    const telemetry = await collectTelemetry(fn);
    return {
      lines,
      telemetry: [
        ...telemetry.logs.map((log) => safeJson(log)),
        ...telemetry.spans.map((span) => safeJson(span)),
      ],
    };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner)) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Every string reachable from an error: message, stack, String(), every own
 * property (enumerable or not), to depth 4, across `cause`. A wrapped SDK
 * error keeps the request path in `$response` or a `Key`/`Resource` field;
 * that is exactly what this walks into.
 */
function stringsIn(root: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      found.push(value);
      return;
    }
    if (value === null || typeof value !== 'object' || depth > 4 || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) found.push(String(value));
    for (const name of Object.getOwnPropertyNames(value)) {
      let inner: unknown;
      try {
        inner = (value as Record<string, unknown>)[name];
      } catch {
        continue;
      }
      walk(inner, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

function leaks(haystack: readonly string[], needles: readonly string[]): string[] {
  const problems: string[] = [];
  for (const needle of needles.filter((n) => n.length >= 8)) {
    if (haystack.some((text) => text.includes(needle))) problems.push(needle.slice(0, 24));
  }
  return problems;
}

// --- source scans (B) --------------------------------------------------------------

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage', '.nx', '.turbo']);
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const toPosix = (path: string): string => path.split(sep).join('/');

function walkFiles(directory: string, accept: (name: string) => boolean, found: string[] = []): string[] {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walkFiles(full, accept, found);
    } else if (accept(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Every module specifier in a file that names `@aws-sdk/`, in any import form. From the AST. */
function awsSdkSpecifiers(fileName: string, text: string): string[] {
  const kind = /\.[cm]?jsx?$/u.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const consider = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node) && node.text.startsWith('@aws-sdk/')) {
      found.push(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) consider(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      consider(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) consider(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      consider(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** ESLint from the workspace root, run as node with no shell, linting stdin as `filename`. */
function eslintStdin(
  filename: string,
  input: string,
): { status: number | null; stdout: string; output: string } {
  const require = createRequire(fromRoot('package.json'));
  const bin = resolve(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  const run = spawnSync(process.execPath, [bin, '--stdin', '--stdin-filename', filename, '--format', 'json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: run.status,
    stdout: run.stdout ?? '',
    output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error?.message ?? ''}`,
  };
}

interface EslintMessage {
  ruleId: string | null;
  message: string;
}
/**
 * The JSON formatter's messages. Nx prints "No cached ProjectGraph is
 * available" to STDOUT ahead of the JSON in a checkout with no graph cache,
 * so the report is found by its opening. Unparseable output is a failure.
 */
function eslintMessages(stdout: string): EslintMessage[] {
  try {
    const reports = JSON.parse(stdout.slice(stdout.indexOf('[{"filePath"'))) as { messages?: EslintMessage[] }[];
    return reports.flatMap((report) => report.messages ?? []);
  } catch {
    return [{ ruleId: 'unparsed', message: stdout.slice(0, 2000) }];
  }
}

const AWS_PROBE = `import { S3Client } from '@aws-sdk/client-s3';\nexport const probe = S3Client;\n`;
const sdkComplaints = (messages: readonly EslintMessage[]): EslintMessage[] =>
  messages.filter((m) => m.ruleId !== null && m.message.includes('@aws-sdk'));

// --- the type probe (K) ------------------------------------------------------------

const PROBE_PATH = fromRoot('tests/acceptance/platform/__t0092_storage_key_probe__.ts');

/** Type-checks `source` as if it were a file of this project; returns ITS diagnostics only. */
function typeDiagnostics(source: string): string[] {
  const configPath = fromRoot('tests/acceptance/tsconfig.json');
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    resolve(fileName) === PROBE_PATH
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => resolve(fileName) === PROBE_PATH || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => (resolve(fileName) === PROBE_PATH ? source : readFile(fileName));
  const program = ts.createProgram([PROBE_PATH], options, host);
  const probeFile = program.getSourceFile(PROBE_PATH);
  return [...program.getSyntacticDiagnostics(probeFile), ...program.getSemanticDiagnostics(probeFile)].map(
    (d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`,
  );
}

const KEY_TYPE_PROBE = `
import type { ObjectStore, StorageKey } from '${ADAPTER_MODULE}';
declare const store: ObjectStore;
declare const minted: StorageKey;
export async function probe(): Promise<void> {
  await store.head(minted); // the control: a minted key is accepted
  // @ts-expect-error a string literal is not a StorageKey
  const fromLiteral: StorageKey = 'tenant/x/programme/y/import/z';
  // @ts-expect-error nor is any string
  const fromString: StorageKey = String(Date.now());
  // @ts-expect-error head takes no string
  await store.head('tenant/x/programme/y/import/z');
  // @ts-expect-error nor does delete
  await store.delete(\`tenant/\${String(1)}/programme/p/import/f\`);
  void fromLiteral;
  void fromString;
}
`;

// ===========================================================================
// 1. Boundary (B). No container needed.
// ===========================================================================

describe('acceptance: T-0092 the adapter package and its boundary (B)', () => {
  const pkgPath = fromRoot('packages/storage-adapter/package.json');

  it('packages/storage-adapter is @kasuwa/storage-adapter, tagged scope:adapter, and depends on the two SDK packages', () => {
    expect(existsSync(pkgPath), 'there is no packages/storage-adapter/package.json').toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name?: string;
      dependencies?: Record<string, string>;
      nx?: { tags?: string[] };
    };
    expect(pkg.name).toBe(ADAPTER_MODULE);
    expect(pkg.nx?.tags ?? [], 'the package is not tagged scope:adapter').toContain('scope:adapter');
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(
      expect.arrayContaining(['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']),
    );
  });

  it('is mapped in tsconfig.base.json and vitest.workspace.ts', () => {
    const base = JSON.parse(
      readFileSync(fromRoot('tsconfig.base.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };
    expect(base.compilerOptions?.paths?.[ADAPTER_MODULE], 'no tsconfig path for the package').toEqual([
      'packages/storage-adapter/src/index.ts',
    ]);
    expect(readFileSync(fromRoot('vitest.workspace.ts'), 'utf8')).toMatch(
      /'@kasuwa\/storage-adapter':\s*resolve\(root,\s*'packages\/storage-adapter\/src\/index\.ts'\)/,
    );
  });

  it('is the ONLY package.json in the workspace that lists an @aws-sdk/* dependency', () => {
    const manifests = [
      fromRoot('package.json'),
      ...walkFiles(fromRoot('apps'), (name) => name === 'package.json'),
      ...walkFiles(fromRoot('packages'), (name) => name === 'package.json'),
      ...walkFiles(fromRoot('tests'), (name) => name === 'package.json'),
    ];
    // Not vacuous: the walk reached the manifests that matter.
    const reached = manifests.map((file) => toPosix(relative(REPO_ROOT, file)));
    for (const must of ['package.json', 'apps/api/package.json', 'apps/worker/package.json', 'packages/db/package.json']) {
      expect(reached, `the manifest walk never reached ${must}`).toContain(must);
    }
    const listing = manifests
      .filter((file) => {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string> | undefined>;
        return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some((field) =>
          Object.keys(pkg[field] ?? {}).some((name) => name.startsWith('@aws-sdk/')),
        );
      })
      .map((file) => toPosix(relative(REPO_ROOT, file)));
    expect(listing).toEqual(['packages/storage-adapter/package.json']);
  });

  it('(self-check, passes on main) the @aws-sdk specifier scan catches every import form and ignores comments', () => {
    const caught = [
      "import { S3Client } from '@aws-sdk/client-s3';",
      "import type { S3Client } from '@aws-sdk/client-s3';",
      "export { S3Client } from '@aws-sdk/client-s3';",
      "export * from '@aws-sdk/s3-request-presigner';",
      "const s3 = require('@aws-sdk/client-s3');",
      "const s3 = await import('@aws-sdk/client-s3');",
      "import s3 = require('@aws-sdk/client-s3');",
      "type C = import('@aws-sdk/client-s3').S3Client;",
    ];
    for (const snippet of caught) {
      expect(awsSdkSpecifiers('probe.ts', snippet), snippet).toHaveLength(1);
    }
    expect(
      awsSdkSpecifiers('probe.ts', "// import '@aws-sdk/client-s3'\nconst s = 'see @aws-sdk/client-s3';"),
    ).toEqual([]);
  });

  it('no source file outside packages/storage-adapter names an @aws-sdk/ module', () => {
    const files = [
      ...walkFiles(fromRoot('apps'), (name) => SOURCE.test(name)),
      ...walkFiles(fromRoot('packages'), (name) => SOURCE.test(name)),
    ];
    const scanned = files.map((file) => toPosix(relative(REPO_ROOT, file)));
    expect(scanned, 'the scan never reached apps/api/src/main.ts').toContain('apps/api/src/main.ts');
    expect(
      scanned.some((file) => file.startsWith('packages/storage-adapter/src/')),
      'the scan never reached packages/storage-adapter/src (so its exemption below is untested)',
    ).toBe(true);
    const outside = files
      .filter((file) => !toPosix(relative(REPO_ROOT, file)).startsWith('packages/storage-adapter/'))
      .flatMap((file) =>
        awsSdkSpecifiers(file, readFileSync(file, 'utf8')).map(
          (specifier) => `${toPosix(relative(REPO_ROOT, file))}: ${specifier}`,
        ),
      );
    expect(outside, 'an @aws-sdk module is named outside the storage adapter (CLAUDE.md 2.8)').toEqual([]);
  });

  it.each([
    'packages/domain/core/src/__t0092_probe__.ts',
    'apps/api/src/__t0092_probe__.ts',
    'apps/worker/src/__t0092_probe__.ts',
    'apps/web/lib/__t0092_probe__.ts',
    'packages/db/src/__t0092_probe__.ts',
    'packages/telephony-adapter/src/__t0092_probe__.ts',
  ])('ESLint reports an @aws-sdk/client-s3 import planted at %s', (filename) => {
    const run = eslintStdin(filename, AWS_PROBE);
    const complaints = sdkComplaints(eslintMessages(run.stdout));
    expect(complaints.length, `nothing reported the import at ${filename}:\n${run.output.slice(0, 1500)}`).toBeGreaterThan(0);
    expect(run.status, 'eslint exited 0 on a planted @aws-sdk import').not.toBe(0);
  }, 60_000);

  it('ESLint does NOT report the same import inside packages/storage-adapter, while still reporting a banned one there (the control)', () => {
    // The second import is banned everywhere outside tests (@kasuwa/testing),
    // so a run that reports NOTHING cannot pass this as a clean control.
    // PASSES ON MAIN, legitimately: no rule names @aws-sdk yet. Its job is to
    // fail a rule written so wide that it bans the adapter from its own SDK.
    const run = eslintStdin(
      'packages/storage-adapter/src/__t0092_probe__.ts',
      `${AWS_PROBE}import { withForcedScope } from '@kasuwa/testing';\nexport const forged = withForcedScope;\n`,
    );
    const messages = eslintMessages(run.stdout);
    expect(messages.filter((m) => m.ruleId === 'unparsed')).toEqual([]);
    expect(
      messages.some((m) => m.ruleId !== null && m.message.includes('@kasuwa/testing') || m.ruleId === '@nx/enforce-module-boundaries'),
      `the harness reported nothing at all, so this control proves nothing:\n${run.output.slice(0, 1500)}`,
    ).toBe(true);
    expect(sdkComplaints(messages)).toEqual([]);
  }, 60_000);
});

// ===========================================================================
// 2. Config (C). No container needed.
// ===========================================================================

const AMBIENT: Env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/kasuwa', LANG: 'C.UTF-8' };
const LEAK = 'n0t-a-real-s3-secret-92q';
const LEAK_ID = 'AKIANOTREAL0092ID';

const STORAGE_DEV: Env = {
  ...AMBIENT,
  NODE_ENV: 'development',
  S3_ENDPOINT: 'http://seaweedfs.internal.example:8333',
  S3_PUBLIC_ENDPOINT: 'http://localhost:59000',
  S3_REGION: 'af-south-1',
  S3_BUCKET: 'kasuwa-local',
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: LEAK_ID,
  S3_SECRET_ACCESS_KEY: LEAK,
};

/** AWS S3 in af-south-1 with workload identity: no endpoint, no static keys (D-L128 Q1). */
const STORAGE_PROD_AWS: Env = {
  ...AMBIENT,
  NODE_ENV: 'production',
  KASUWA_AUTH_MODE: 'jwt',
  S3_REGION: 'af-south-1',
  S3_BUCKET: 'kasuwa-za-1',
};

/** As config-schemas' SERVER_PROD_SAFE: every other production guard satisfied. */
const SERVER_PROD_SAFE: Env = {
  ...AMBIENT,
  NODE_ENV: 'production',
  KASUWA_AUTH_MODE: 'jwt',
  KASUWA_CELL: 'za-1',
  DATABASE_URL: 'postgres://kasuwa_app:x-prod-pw-0092@db.internal.example:5432/kasuwa',
  DATABASE_AUTH_URL: 'postgres://kasuwa_auth:x-prod-pw-0092@db.internal.example:5432/kasuwa',
  REDIS_URL: 'redis://redis.internal.example:6379',
  KASUWA_TRUST_PROXY_HOPS: '1',
  KASUWA_KMS_PROVIDER: 'aws-kms',
  KASUWA_KMS_KEY_ID: 'alias/kasuwa-acceptance',
};

/**
 * D-L166 (lead edit), as config-schemas' productionSafeFor: workerEnv requires
 * the relay's own connection since T-0098 (ADR-0018, D-L156), and every other
 * process refuses it by presence, so it is added for the worker alone.
 * Without it workerEnv refuses SERVER_PROD_SAFE on DATABASE_RELAY_URL, never
 * reaching S3_SSE_MODE.
 */
const DATABASE_RELAY_URL = 'postgres://kasuwa_relay:x-prod-pw-0092@db.internal.example:5432/kasuwa';
const serverProdSafeFor = (name: 'apiEnv' | 'workerEnv'): Env =>
  name === 'workerEnv' ? { ...SERVER_PROD_SAFE, DATABASE_RELAY_URL } : SERVER_PROD_SAFE;

const without = (env: Env, ...keys: string[]): Env =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !keys.includes(name)));

describe('acceptance: T-0092 storage configuration (C)', () => {
  it('storageEnv parses a development store and an AWS store with no endpoint and no static keys', async () => {
    const storageEnv = await configFn('storageEnv');
    expect(() => storageEnv(STORAGE_DEV)).not.toThrow();
    expect(() => storageEnv(STORAGE_PROD_AWS)).not.toThrow();
  });

  it.each(['S3_BUCKET', 'S3_REGION'])('storageEnv refuses an environment without %s, naming it', async (name) => {
    const storageEnv = await configFn('storageEnv');
    const error = await rejectionOf(() => storageEnv(without(STORAGE_DEV, name)), `storageEnv accepted no ${name}`);
    expect(error.message).toContain(name);
    expect(error.message).not.toContain(LEAK);
  });

  it.each([
    ['only the access key id', 'S3_SECRET_ACCESS_KEY'],
    ['only the secret', 'S3_ACCESS_KEY_ID'],
  ])('storageEnv refuses %s (the keys are optional TOGETHER), echoing neither', async (_label, dropped) => {
    const storageEnv = await configFn('storageEnv');
    const error = await rejectionOf(
      () => storageEnv(without(STORAGE_DEV, dropped)),
      `storageEnv accepted half a credential pair (without ${dropped})`,
    );
    expect(error.message).toMatch(/S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY/);
    expect(error.message).not.toContain(LEAK);
    expect(error.message).not.toContain(LEAK_ID);
  });

  it.each([
    ['S3_FORCE_PATH_STYLE', 'yes'],
    ['S3_ENDPOINT', 'not a url'],
    ['S3_PUBLIC_ENDPOINT', 'not a url'],
    ['S3_SSE_MODE', 'aws:kms'],
    ['S3_SSE_MODE', 'none'],
  ])('storageEnv refuses %s=%s in development', async (name, value) => {
    const storageEnv = await configFn('storageEnv');
    const error = await rejectionOf(
      () => storageEnv({ ...STORAGE_DEV, [name]: value }),
      `storageEnv accepted ${name}=${value}`,
    );
    expect(error.message).toContain(name);
    expect(error.message).not.toContain(LEAK);
  });

  it('storageEnv accepts S3_SSE_MODE=off in development and test, and AES256 in production', async () => {
    const storageEnv = await configFn('storageEnv');
    expect(() => storageEnv({ ...STORAGE_DEV, S3_SSE_MODE: 'off' })).not.toThrow();
    expect(() => storageEnv({ ...STORAGE_DEV, NODE_ENV: 'test', S3_SSE_MODE: 'off' })).not.toThrow();
    expect(() => storageEnv({ ...STORAGE_PROD_AWS, S3_SSE_MODE: 'AES256' })).not.toThrow();
  });

  it('storageEnv refuses S3_SSE_MODE=off under NODE_ENV=production (D-L94, D-L128 Q3)', async () => {
    const storageEnv = await configFn('storageEnv');
    const error = await rejectionOf(
      () => storageEnv({ ...STORAGE_PROD_AWS, S3_SSE_MODE: 'off' }),
      'storageEnv accepted SSE off in production',
    );
    expect(error.message).toContain('S3_SSE_MODE');
  });

  it('storageEnv refuses aws:kms in production too, until the per-cell KMS task', async () => {
    const storageEnv = await configFn('storageEnv');
    await rejectionOf(
      () => storageEnv({ ...STORAGE_PROD_AWS, S3_SSE_MODE: 'aws:kms' }),
      'storageEnv accepted aws:kms in production',
    );
  });

  it('storageEnv judges the environment it is GIVEN, not process.env', async () => {
    vi.stubEnv('S3_BUCKET', 'from-process-env');
    try {
      const storageEnv = await configFn('storageEnv');
      expect(() => storageEnv(without(STORAGE_DEV, 'S3_BUCKET'))).toThrow(/S3_BUCKET/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['apiEnv', 'workerEnv'] as const)(
    '%s refuses S3_SSE_MODE=off under production, and boots without it (the control)',
    async (name) => {
      const parse = await configFn(name);
      const safe = serverProdSafeFor(name);
      expect(() => parse(safe), `${name} no longer boots the production-safe environment`).not.toThrow();
      expect(() => parse({ ...safe, NODE_ENV: 'development', S3_SSE_MODE: 'off' })).not.toThrow();
      const error = await rejectionOf(
        () => parse({ ...safe, S3_SSE_MODE: 'off' }),
        `${name} booted in production with S3_SSE_MODE=off`,
      );
      expect(error.message).toContain('S3_SSE_MODE');
    },
  );

  it('webEnv accepts S3_PUBLIC_ENDPOINT and returns it (the CSP origin)', async () => {
    const webEnv = await configFn('webEnv');
    const parsed = webEnv({ ...AMBIENT, ...WEB_SESSION_URLS, NODE_ENV: 'development', S3_PUBLIC_ENDPOINT: 'http://localhost:59000' }) as Record<
      string,
      unknown
    >;
    expect(parsed.S3_PUBLIC_ENDPOINT).toBe('http://localhost:59000');
  });

  // The two key cases PASS ON MAIN by design: T-0014 already refuses them, and
  // the task says "the credentials stay forbidden". They are regression guards
  // for the build, not evidence of it. S3_ENDPOINT (R9) is the new one.
  it.each([
    ['S3_ACCESS_KEY_ID', LEAK_ID],
    ['S3_SECRET_ACCESS_KEY', LEAK],
    ['S3_ENDPOINT', `http://internal-${LEAK}.example:8333`],
  ])('webEnv refuses %s, naming it and echoing nothing (T-0014, R9)', async (name, value) => {
    const webEnv = await configFn('webEnv');
    expect(() => webEnv({ ...AMBIENT, ...WEB_SESSION_URLS, NODE_ENV: 'development' })).not.toThrow();
    const error = await rejectionOf(
      () => webEnv({ ...AMBIENT, ...WEB_SESSION_URLS, NODE_ENV: 'development', [name]: value }),
      `webEnv accepted ${name}`,
    );
    expect(error.message).toContain(name);
    expect(error.message).not.toContain(value);
  });
});

// ===========================================================================
// 3. The dev store (D). Static, then live against the repository's own file.
// ===========================================================================

interface S3Identity {
  name?: string;
  credentials?: { accessKey?: string; secretKey?: string }[];
}

function dotenv(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

interface ComposeService {
  command?: string | string[];
  volumes?: string[];
}

function composeSeaweedfs(): { service: ComposeService | undefined; command: string } {
  const compose = parseYaml(readFileSync(fromRoot('docker-compose.yml'), 'utf8')) as {
    services?: Record<string, ComposeService>;
  };
  const service = compose.services?.seaweedfs;
  expect(service, 'docker-compose.yml has no seaweedfs service').toBeDefined();
  const command = Array.isArray(service?.command) ? service.command.join(' ') : (service?.command ?? '');
  return { service, command };
}

/** The `-s3.allowedOrigins` list of the compose seaweedfs command (R11). */
function composeAllowedOrigins(): string[] {
  const flag = /-s3\.allowedOrigins=(\S+)/.exec(composeSeaweedfs().command);
  expect(flag?.[1], 'the seaweedfs command has no -s3.allowedOrigins (SeaweedFS answers every origin by default)').toBeDefined();
  return (flag?.[1] ?? '').split(',').filter((origin) => origin !== '');
}

/** The compose seaweedfs service's identity file: [repo path, container path]. */
function composeIdentityFile(): { repoPath: string; containerPath: string } {
  const { service, command } = composeSeaweedfs();
  const flag = /-s3\.config=(\S+)/.exec(command);
  expect(flag?.[1], 'the seaweedfs command has no -s3.config=<path> (anonymous S3 access, D-L21)').toBeDefined();
  const containerPath = flag?.[1] ?? '';
  const mount = (service?.volumes ?? [])
    .map((volume) => volume.split(':'))
    .find((parts) => parts[1] === containerPath);
  expect(mount, `no volume mounts a repository file at ${containerPath}`).toBeDefined();
  return { repoPath: fromRoot(mount?.[0] ?? ''), containerPath };
}

describe('acceptance: T-0092 the development store ends anonymous access (D)', () => {
  it('compose mounts an identity config in which every identity has credentials and none is anonymous', () => {
    const { repoPath } = composeIdentityFile();
    expect(existsSync(repoPath), `${repoPath} does not exist`).toBe(true);
    const config = JSON.parse(readFileSync(repoPath, 'utf8')) as { identities?: S3Identity[] };
    const identities = config.identities ?? [];
    expect(identities.length, 'the identity config holds no identity').toBeGreaterThan(0);
    for (const identity of identities) {
      expect(identity.name, 'SeaweedFS treats an identity named "anonymous" as unauthenticated access').not.toBe('anonymous');
      expect((identity.credentials ?? []).length, `identity ${identity.name ?? '?'} has no credentials`).toBeGreaterThan(0);
    }
  });

  it('.env.example names every storage variable, path style on, and its keys are a credential of that config', () => {
    const env = dotenv(fromRoot('.env.example'));
    for (const name of ['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_FORCE_PATH_STYLE', 'S3_SSE_MODE']) {
      expect(env[name], `.env.example does not set ${name}`).toBeDefined();
    }
    expect(env.S3_FORCE_PATH_STYLE).toBe('true');
    const { repoPath } = composeIdentityFile();
    const config = JSON.parse(readFileSync(repoPath, 'utf8')) as { identities?: S3Identity[] };
    const pairs = (config.identities ?? []).flatMap((identity) => identity.credentials ?? []);
    expect(
      pairs.some((pair) => pair.accessKey === env.S3_ACCESS_KEY_ID && pair.secretKey === env.S3_SECRET_ACCESS_KEY),
      '.env.example’s keys are not a credential in the mounted identity config, so `pnpm dev` cannot sign',
    ).toBe(true);
  });

  it('compose restricts the gateway to named web origins, not * (R11)', () => {
    const origins = composeAllowedOrigins();
    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins) {
      expect(origin, 'a wildcard origin').not.toContain('*');
      expect(new URL(origin).origin, `${origin} is not a bare origin`).toBe(origin);
    }
  });

  describe('live, with the repository’s identity file', () => {
    let seaweed: StartedSeaweedFs | undefined;
    let startError: unknown;
    const env = existsSync(fromRoot('.env.example')) ? dotenv(fromRoot('.env.example')) : {};

    beforeAll(async () => {
      try {
        const { repoPath } = composeIdentityFile();
        seaweed = await startSeaweedFs({
          bucket: env.S3_BUCKET ?? 'kasuwa-local',
          allowedOrigins: composeAllowedOrigins().join(','),
          identityConfig: readFileSync(repoPath, 'utf8'),
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
            secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
          },
        });
      } catch (error) {
        startError = error;
      }
    }, 180_000);

    afterAll(async () => {
      await seaweed?.stop();
    });

    const started = (): StartedSeaweedFs => {
      expect(startError === undefined ? null : String(startError), 'SeaweedFS could not start with the repository identity file').toBe(null);
      if (seaweed === undefined) throw new Error('unreachable: no container');
      return seaweed;
    };

    it('signs with the .env.example keys through S3ObjectStore (the control), and refuses an unsigned read', async () => {
      const s3 = started();
      const { S3ObjectStore, mintStorageKey } = await adapter();
      const storageEnv = await configFn('storageEnv');
      const store = new S3ObjectStore(
        storageEnv({
          ...AMBIENT,
          NODE_ENV: 'test',
          S3_ENDPOINT: s3.endpoint,
          S3_PUBLIC_ENDPOINT: s3.endpoint,
          S3_REGION: env.S3_REGION ?? 'af-south-1',
          S3_BUCKET: s3.bucket,
          S3_FORCE_PATH_STYLE: 'true',
          S3_ACCESS_KEY_ID: s3.accessKeyId,
          S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
          ...(env.S3_SSE_MODE === undefined ? {} : { S3_SSE_MODE: env.S3_SSE_MODE }),
        }),
      );
      const appPool = createPool({ connectionString: inject('databaseUrl'), max: 1 });
      try {
        const key = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, async (_q, tx) =>
          mintStorageKey(tx, { programmeId: PROGRAMME_A1, purpose: 'import' }),
        );
        const body = bytes(64, 1);
        await store.put(key, Readable.from([body]), { contentType: 'text/csv', contentLength: body.length });
        expect((await s3.listEntries(String(key))).map((entry) => entry.key)).toEqual([String(key)]);
        const anonymous = await fetch(`${s3.endpoint}/${s3.bucket}/${String(key)}`);
        expect(anonymous.status, 'an unsigned GET read an object: anonymous access is still on').toBe(403);
        const anonymousList = await fetch(`${s3.endpoint}/${s3.bucket}/?list-type=2`);
        expect(anonymousList.status, 'an unsigned list was answered').toBe(403);
      } finally {
        await appPool.end();
      }
    }, 120_000);

    it('a browser preflight from another origin is not admitted; one from the web origin is (R11)', async () => {
      const s3 = started();
      const [webOrigin] = composeAllowedOrigins();
      const allowOriginFor = async (origin: string): Promise<string | null> => {
        try {
          const response = await fetch(`${s3.endpoint}/${s3.bucket}/tenant/x`, {
            method: 'OPTIONS',
            headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' },
          });
          return response.headers.get('access-control-allow-origin');
        } catch {
          return null; // SeaweedFS 3.80 drops the connection for an origin not on the list
        }
      };
      expect(await allowOriginFor(webOrigin ?? ''), 'the web origin is not admitted (the control)').not.toBeNull();
      expect(await allowOriginFor('https://attacker.example'), 'another origin was admitted').toBeNull();
    }, 60_000);
  });
});

// ===========================================================================
// 4. Keys, store, URLs, encryption, offboarding, the table, scope, logging.
//    One SeaweedFS and one recording proxy for all of them.
// ===========================================================================

describe('acceptance: T-0092 storage adapter against real SeaweedFS and Postgres', () => {
  let seaweed: StartedSeaweedFs;
  let proxy: RecordingProxy;
  let appPool: Pool;
  let migrator: Pool;
  let testAdmin: Pool;
  let plantError: unknown;

  /** The environment the adapter is built from: internal = the proxy, public = SeaweedFS direct. */
  let storeEnv: Env;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    seaweed = await startSeaweedFs();
    proxy = await startRecordingProxy(seaweed.endpoint);
    storeEnv = {
      ...AMBIENT,
      NODE_ENV: 'test',
      S3_ENDPOINT: proxy.url,
      S3_PUBLIC_ENDPOINT: seaweed.endpoint,
      S3_REGION: seaweed.region,
      S3_BUCKET: seaweed.bucket,
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: seaweed.accessKeyId,
      S3_SECRET_ACCESS_KEY: seaweed.secretAccessKey,
      // S3_SSE_MODE deliberately unset: AES256 is the default (E).
    };
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 4 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    testAdmin = createPool({ connectionString: inject('testAdminUrl'), max: 2 });
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      for (const row of PLANTED) {
        await client.query(INSERT_ROW, [
          row.id,
          row.tenantId,
          row.programmeId,
          keyText(row.tenantId, row.programmeId, row.id),
          12 * MiB,
          row.userId,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      plantError = error;
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
  }, 240_000);

  afterAll(async () => {
    await proxy?.close();
    await seaweed?.stop();
    await appPool?.end();
    await migrator?.end();
    await testAdmin?.end();
    await reseed(inject('migrationUrl'));
  });

  const requirePlanted = (): void => {
    expect(
      plantError === undefined ? null : verdict(outcomeOf(plantError)),
      'the stored_object fixtures could not be planted',
    ).toBe(null);
  };

  const store = async (env: Env = storeEnv): Promise<ObjectStore> => {
    const { S3ObjectStore } = await adapter();
    const storageEnv = await configFn('storageEnv');
    return new S3ObjectStore(storageEnv(env));
  };

  /** Mint a key as `userId` (committed nowhere: minting writes nothing). */
  const mintAs = async (
    tenantId: string,
    userId: string,
    input: Record<string, unknown>,
  ): Promise<Key> => {
    const { mintStorageKey } = await adapter();
    return rolledBackTenantTx(appPool, tenantId, userId, async (_query, tx) => mintStorageKey(tx, input));
  };
  const mintA1 = (): Promise<Key> =>
    mintAs(TENANT_A, USER_A_AGENT_1, { programmeId: PROGRAMME_A1, purpose: 'import' });

  /**
   * 'refused' when mintStorageKey itself throws; the minted text otherwise.
   * The module is loaded FIRST, outside the try: a missing package must fail
   * the test, not count as a refusal (that was a vacuous pass on main).
   */
  const mintRefused = async (tenantId: string, userId: string, input: Record<string, unknown>): Promise<string> => {
    const { mintStorageKey } = await adapter();
    return rolledBackTenantTx(appPool, tenantId, userId, async (_query, tx) => {
      try {
        return `minted ${String(await mintStorageKey(tx, input))}`;
      } catch {
        return 'refused';
      }
    });
  };

  /** Run `fn` in a committed tenant transaction (the repository's writes must persist). */
  const asUser = <T>(tenantId: string, userId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
    withTenantTransaction(appPool, { tenantId, userId }, fn);

  const putSmall = async (target: ObjectStore, key: Key, seed = 7): Promise<Buffer> => {
    const body = bytes(32, seed);
    await target.put(key, Readable.from([body]), { contentType: 'text/csv', contentLength: body.length });
    return body;
  };

  // -------------------------------------------------------------------------
  // K. Keys
  // -------------------------------------------------------------------------
  describe('keys are minted from the session, never from input (K)', () => {
    it('STORAGE_PURPOSES is exactly [import]', async () => {
      const { STORAGE_PURPOSES } = await adapter();
      expect([...STORAGE_PURPOSES]).toEqual(['import']);
    });

    it('a minted key is tenant/<session tenant>/programme/<programme>/import/<fresh v4 uuid>, and two mints differ', async () => {
      const first = String(await mintA1());
      const second = String(await mintA1());
      const pattern = new RegExp(`^tenant/${TENANT_A}/programme/${PROGRAMME_A1}/import/([0-9a-f-]{36})$`);
      expect(first).toMatch(pattern);
      expect(second).toMatch(pattern);
      expect(pattern.exec(first)?.[1]).toMatch(UUID_V4);
      expect(first).not.toBe(second);
    });

    it('ignores a supplied tenantId, fileId, filename and extension', async () => {
      const key = String(
        await mintAs(TENANT_A, USER_A_AGENT_1, {
          programmeId: PROGRAMME_A1,
          purpose: 'import',
          tenantId: TENANT_B,
          fileId: INVENTED,
          filename: 'Customer List EVILNAME.csv',
          extension: '.csv',
        }),
      );
      expect(key.startsWith(`tenant/${TENANT_A}/programme/${PROGRAMME_A1}/import/`)).toBe(true);
      expect(key).not.toContain(TENANT_B);
      expect(key).not.toContain(INVENTED);
      expect(key).not.toMatch(/EVILNAME|\.csv/i);
    });

    it.each([
      ['another programme of the tenant', TENANT_A, USER_A_AGENT_1, PROGRAMME_A2],
      ['another tenant’s programme', TENANT_A, USER_A_AGENT_1, PROGRAMME_B1],
      ['a user with no programme', TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1],
      ['a path traversal', TENANT_A, USER_A_AGENT_1, `${PROGRAMME_A1}/../${PROGRAMME_A2}`],
      ['a traversal to another tenant', TENANT_A, USER_A_AGENT_1, `../../tenant/${TENANT_B}/programme/${PROGRAMME_B1}`],
      ['an empty programme', TENANT_A, USER_A_AGENT_1, ''],
    ])('refuses to mint for %s', async (_label, tenantId, userId, programmeId) => {
      expect(await mintRefused(tenantId, userId, { programmeId, purpose: 'import' })).toBe('refused');
    });

    it.each(['export', 'IMPORT', 'import/../export', '', 'attachment'])(
      'refuses the purpose %j (a closed enum)',
      async (purpose) => {
        expect(await mintRefused(TENANT_A, USER_A_AGENT_1, { programmeId: PROGRAMME_A1, purpose })).toBe('refused');
      },
    );

    it('the supervisor mints in either of their programmes (the control for the refusals)', async () => {
      for (const programmeId of [PROGRAMME_A1, PROGRAMME_A2]) {
        const key = String(await mintAs(TENANT_A, USER_A_SUPERVISOR, { programmeId, purpose: 'import' }));
        expect(key.startsWith(`tenant/${TENANT_A}/programme/${programmeId}/import/`)).toBe(true);
      }
    });

    it('(self-check, passes on main) the type probe can fail', () => {
      expect(typeDiagnostics("export const n: number = 'not a number';\n").join('\n')).toMatch(/TS2322/);
    }, 120_000);

    it('a string is not a StorageKey and no store method takes one, at the type level', () => {
      expect(typeDiagnostics(KEY_TYPE_PROBE), 'the StorageKey type probe').toEqual([]);
    }, 120_000);

    it('at run time every store method refuses a key it did not mint, before any request reaches the bucket (R2)', async () => {
      const target = await store();
      const real = await mintA1();
      const text = String(real);
      const forgeries: [string, unknown][] = [
        ['the key text as a string', text],
        ['a look-alike object', { toString: () => text, valueOf: () => text }],
        ['a spread clone', { ...(real as object) }],
        ['a prototype clone', Object.create(Object.getPrototypeOf(real) as object | null) as unknown],
        ['another tenant’s key text', keyText(TENANT_B, PROGRAMME_B1, randomUUID())],
      ];
      const before = proxy.requests.length;
      const accepted: string[] = [];
      for (const [label, forged] of forgeries) {
        const calls: [string, () => unknown][] = [
          ['put', () => target.put(forged as Key, Readable.from([Buffer.from('x')]), { contentType: 'text/csv', contentLength: 1 })],
          ['head', () => target.head(forged as Key)],
          ['getStream', async () => drain(target.getStream(forged as Key))],
          ['delete', () => target.delete(forged as Key)],
          ['presignUpload', () => target.presignUpload(forged as Key, { contentLength: 10, partCount: 1 })],
          ['completeUpload', () => target.completeUpload(forged as Key, 'x', [{ partNumber: 1, etag: '"x"' }])],
          ['abortUpload', () => target.abortUpload(forged as Key, 'x')],
        ];
        for (const [method, call] of calls) {
          try {
            await call();
            accepted.push(`${method}(${label})`);
          } catch {
            // refused: what we want
          }
        }
      }
      expect(accepted, 'a store method accepted a key it did not mint').toEqual([]);
      expect(
        proxy.requests.slice(before).map((r) => `${r.method} ${r.path}`),
        'a forged key reached the bucket before it was refused',
      ).toEqual([]);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // P, E. The store over SeaweedFS, and encryption on the wire
  // -------------------------------------------------------------------------
  describe('the store over SeaweedFS (P, E)', () => {
    it('exposes exactly the eight methods of the port', async () => {
      const target = await store();
      for (const method of STORE_METHODS) {
        expect(typeof (target as unknown as Record<string, unknown>)[method], `ObjectStore.${method}`).toBe('function');
      }
    });

    it('put stores the bytes at exactly String(key); head reports size and type and no content; getStream returns them', async () => {
      const target = await store();
      const key = await mintA1();
      const body = bytes(4096, 3);
      await target.put(key, Readable.from([body]), { contentType: 'text/csv', contentLength: body.length });

      // Read from the filer, not through the adapter.
      expect((await seaweed.listEntries(String(key))).map((e) => [e.key, e.size])).toEqual([[String(key), 4096]]);

      const head = await target.head(key);
      expect(head).not.toBeNull();
      expect(head?.size).toBe(4096);
      expect(head?.contentType).toBe('text/csv');
      for (const [field, value] of Object.entries(head ?? {})) {
        const isContent =
          value instanceof Uint8Array ||
          value instanceof Readable ||
          (typeof value === 'object' && value !== null && Symbol.asyncIterator in value);
        expect(isContent, `head returned content in ${field}`).toBe(false);
      }
      expect((await drain(target.getStream(key))).equals(body)).toBe(true);
    });

    it('head of a key with no object is null (D-L146 reconciles a 404 to deleted)', async () => {
      const target = await store();
      expect(await target.head(await mintA1())).toBeNull();
    });

    it('delete removes the object and is idempotent', async () => {
      const target = await store();
      const key = await mintA1();
      await putSmall(target, key);
      await target.delete(key);
      expect(await seaweed.listEntries(String(key))).toEqual([]);
      await target.delete(key);
    });

    it('every PutObject carries x-amz-server-side-encryption: AES256 with S3_SSE_MODE unset (E)', async () => {
      const target = await store();
      const key = await mintA1();
      const before = proxy.requests.length;
      await putSmall(target, key);
      const puts = proxy.requests
        .slice(before)
        .filter((r) => r.method === 'PUT' && r.path.endsWith(String(key)) && !r.search.has('uploadId'));
      expect(puts.length, 'the put never reached the bucket through S3_ENDPOINT').toBeGreaterThan(0);
      for (const put of puts) {
        expect(put.headers['x-amz-server-side-encryption'], 'a PutObject without SSE').toBe('AES256');
      }
    });

    it('every CreateMultipartUpload carries x-amz-server-side-encryption: AES256 (E)', async () => {
      const target = await store();
      const key = await mintA1();
      const before = proxy.requests.length;
      const upload = await target.presignUpload(key, { contentLength: 1024, partCount: 1 });
      const creates = proxy.requests
        .slice(before)
        .filter((r) => r.method === 'POST' && r.path.endsWith(String(key)) && r.search.has('uploads'));
      expect(creates.length, 'no CreateMultipartUpload reached the bucket through S3_ENDPOINT').toBe(1);
      expect(creates[0]?.headers['x-amz-server-side-encryption'], 'a CreateMultipartUpload without SSE').toBe('AES256');
      await target.abortUpload(key, upload.uploadId);
    });
  });

  // -------------------------------------------------------------------------
  // U. Signed URLs
  // -------------------------------------------------------------------------
  describe('signed part URLs (U)', () => {
    it('part URLs are on the PUBLIC origin, expire in 300 s and sign content-length and host; lengths sum to the total and only the last part is under 5 MiB', async () => {
      const target = await store();
      const key = await mintA1();
      const total = 12 * MiB + 123;
      const upload = await target.presignUpload(key, { contentLength: total, partCount: 2 });
      expect(typeof upload.uploadId).toBe('string');
      expect(upload.parts.map((p) => p.partNumber)).toEqual([1, 2]);
      expect(upload.parts.reduce((sum, p) => sum + p.contentLength, 0)).toBe(total);
      for (const part of upload.parts.slice(0, -1)) expect(part.contentLength).toBeGreaterThanOrEqual(MIN_PART);
      for (const part of upload.parts) {
        const url = new URL(part.url);
        expect(url.origin, 'a part URL is not on S3_PUBLIC_ENDPOINT').toBe(new URL(seaweed.endpoint).origin);
        expect(url.origin, 'a part URL names the internal endpoint').not.toBe(new URL(proxy.url).origin);
        expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
        const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
        expect(signed).toEqual(expect.arrayContaining(['content-length', 'host']));
        expect(part.url, 'a URL carries the secret key').not.toContain(seaweed.secretAccessKey);
      }
      await target.abortUpload(key, upload.uploadId);
    });

    it.each([
      ['a zero length', 0, 1],
      ['a negative length', -1, 1],
      ['a fractional length', 10.5, 1],
      ['zero parts', 1024, 0],
      // 3 parts of 6 MiB: two non-last parts of 5 MiB need 10 MiB. (6 MiB in
      // 2 parts is satisfiable, 5 MiB + 1 MiB, so it is not a refusal case.)
      ['a part count that forces a non-last part under 5 MiB', 6 * MiB, 3],
    ])('refuses %s', async (_label, contentLength, partCount) => {
      const target = await store();
      const key = await mintA1();
      await rejectionOf(
        () => target.presignUpload(key, { contentLength, partCount }),
        `presignUpload accepted contentLength=${contentLength} partCount=${partCount}`,
      );
    });

    it('exact-length parts upload and complete into one object of the total size', async () => {
      const target = await store();
      const key = await mintA1();
      const total = 10 * MiB + 17;
      const upload = await target.presignUpload(key, { contentLength: total, partCount: 2 });
      const body = bytes(total, 5);
      const parts: CompletedPart[] = [];
      let offset = 0;
      for (const part of upload.parts) {
        const result = await putPart(part.url, body.subarray(offset, offset + part.contentLength));
        offset += part.contentLength;
        expect(result.status, `part ${part.partNumber} was refused`).toBe(200);
        parts.push({ partNumber: part.partNumber, etag: result.etag });
      }
      await target.completeUpload(key, upload.uploadId, parts);
      expect((await seaweed.listEntries(String(key))).map((e) => e.size)).toEqual([total]);
      expect((await drain(target.getStream(key))).equals(body)).toBe(true);
    }, 60_000);

    it('THE BUCKET refuses a part one byte longer, or shorter, than its signed length (R5: SeaweedFS enforces it)', async () => {
      const target = await store();
      const key = await mintA1();
      const upload = await target.presignUpload(key, { contentLength: 4096, partCount: 1 });
      const [part] = upload.parts;
      expect(part?.contentLength).toBe(4096);
      const url = part?.url ?? '';
      expect((await putPart(url, bytes(4097, 1))).status, 'an oversized part was accepted').toBe(403);
      expect((await putPart(url, bytes(4095, 1))).status, 'an undersized part was accepted').toBe(403);
      expect((await putPart(url, bytes(4 * MiB, 1))).status, 'a 4 MiB body on a 4 KiB URL was accepted').toBe(403);
      // The control, on the same URL: the exact length is accepted.
      expect((await putPart(url, bytes(4096, 1))).status).toBe(200);
      await target.abortUpload(key, upload.uploadId);
    });

    it('the bucket refuses a URL whose partNumber, key or expiry was edited', async () => {
      const target = await store();
      const key = await mintA1();
      const other = await mintA1();
      const upload = await target.presignUpload(key, { contentLength: 2048, partCount: 1 });
      const original = new URL(upload.parts[0]?.url ?? '');
      const edited = (change: (url: URL) => void): string => {
        const url = new URL(original.toString());
        change(url);
        return url.toString();
      };
      const body = bytes(2048, 9);
      expect((await putPart(edited((u) => u.searchParams.set('partNumber', '2')), body)).status).toBe(403);
      expect((await putPart(edited((u) => u.searchParams.set('X-Amz-Expires', '604800')), body)).status).toBe(403);
      expect(
        (await putPart(edited((u) => (u.pathname = u.pathname.replace(String(key), String(other)))), body)).status,
      ).toBe(403);
      expect((await putPart(original.toString(), body)).status, 'the unedited URL (the control)').toBe(200);
      await target.abortUpload(key, upload.uploadId);
    });

    it('a URL signed more than 5 minutes ago is refused; one signed 4 minutes ago is accepted (R6)', async () => {
      const target = await store();
      const presignAt = async (minutesAgo: number): Promise<{ key: Key; upload: PresignedUpload }> => {
        const key = await mintA1();
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - minutesAgo * 60_000 });
        try {
          return { key, upload: await target.presignUpload(key, { contentLength: 1024, partCount: 1 }) };
        } finally {
          vi.useRealTimers();
        }
      };
      const stale = await presignAt(6);
      const fresh = await presignAt(4);
      expect((await putPart(stale.upload.parts[0]?.url ?? '', bytes(1024, 2))).status, 'an expired URL was accepted').toBe(403);
      expect((await putPart(fresh.upload.parts[0]?.url ?? '', bytes(1024, 2))).status, 'a live URL was refused').toBe(200);
      await target.abortUpload(stale.key, stale.upload.uploadId);
      await target.abortUpload(fresh.key, fresh.upload.uploadId);
    });

    /**
     * NOT PINNED, A SEAWEEDFS 3.80 DEFECT (observed 2026-10-18): after
     * AbortMultipartUpload, a part PUT on a still-live URL is ACCEPTED (200),
     * the upload directory is recreated, and CompleteMultipartUpload then
     * SUCCEEDS. AWS answers that part with 404 NoSuchUpload. No adapter can
     * fix the bucket, so what is pinned is the part an adapter controls: the
     * abort itself, observed with a part sent BEFORE it.
     */
    it('after abortUpload, the parts already sent cannot be completed and no object exists', async () => {
      const target = await store();
      const key = await mintA1();
      const upload = await target.presignUpload(key, { contentLength: 1024, partCount: 1 });
      const sent = await putPart(upload.parts[0]?.url ?? '', bytes(1024, 4));
      expect(sent.status, 'the part was refused before the abort (the control)').toBe(200);
      await target.abortUpload(key, upload.uploadId);
      await rejectionOf(
        () => target.completeUpload(key, upload.uploadId, [{ partNumber: 1, etag: sent.etag }]),
        'completed an aborted upload',
      );
      expect(await seaweed.listEntries(String(key))).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // O. Offboarding
  // -------------------------------------------------------------------------
  describe('offboarding: deletePrefix (O)', () => {
    it('tenantStoragePrefix is tenant/<id>/ and refuses anything that is not a UUID', async () => {
      const { tenantStoragePrefix } = await adapter();
      expect(String(tenantStoragePrefix(TENANT_A))).toBe(`tenant/${TENANT_A}/`);
      for (const bad of ['', 'not-a-uuid', `${TENANT_A}/../${TENANT_B}`, `${TENANT_A}/`, '*', '../']) {
        await rejectionOf(() => tenantStoragePrefix(bad), `tenantStoragePrefix accepted ${JSON.stringify(bad)}`);
      }
    });

    it('refuses a prefix it did not mint, deleting nothing', async () => {
      const target = await store();
      const key = await mintA1();
      await putSmall(target, key);
      for (const forged of ['', 'tenant/', `tenant/${TENANT_A}/`, `tenant/${TENANT_A}`, { toString: () => '' }]) {
        await rejectionOf(() => target.deletePrefix(forged as Prefix), `deletePrefix accepted ${JSON.stringify(String(forged))}`);
      }
      expect((await seaweed.listEntries(String(key))).length, 'a refused deletePrefix deleted something').toBe(1);
    });

    it('leaves no object under tenant/<A>/ across more than one listing page, aborts A’s open uploads, and keeps tenant B’s objects', async () => {
      const { tenantStoragePrefix, mintStorageKey } = await adapter();
      const target = await store();

      // Tenant A, both programmes: A_OBJECTS objects. Observed on SeaweedFS
      // 3.80: ListObjectsV2 answers at most 10,000 keys a page (AWS: 1,000),
      // and DeleteObjects refuses more than 1,000 keys a call. So 10,050 is
      // what it takes for a first-page-only listing to leave 50 behind, and
      // for an unchunked bulk delete to fail outright.
      const A_OBJECTS = 10_050;
      // Earlier tests in this file left tenant-A objects behind; they go too.
      const earlier = (await seaweed.listEntries(`tenant/${TENANT_A}/`)).length;
      const aKeys = await rolledBackTenantTx(appPool, TENANT_A, USER_A_SUPERVISOR, async (_query, tx) =>
        Array.from({ length: A_OBJECTS }, (_unused, i) =>
          mintStorageKey(tx, { programmeId: i % 2 === 0 ? PROGRAMME_A1 : PROGRAMME_A2, purpose: 'import' }),
        ),
      );
      for (let i = 0; i < aKeys.length; i += 64) {
        await Promise.all(aKeys.slice(i, i + 64).map((key, j) => putSmall(target, key, i + j)));
      }
      // Tenant B: the control.
      const bKeys = [
        await mintAs(TENANT_B, USER_B_AGENT_1, { programmeId: PROGRAMME_B1, purpose: 'import' }),
        await mintAs(TENANT_B, USER_B_AGENT_1, { programmeId: PROGRAMME_B1, purpose: 'import' }),
      ];
      for (const key of bKeys) await putSmall(target, key);

      // An upload in flight for A, its one part already sent.
      const openKey = await mintA1();
      const open = await target.presignUpload(openKey, { contentLength: 512, partCount: 1 });
      const sent = await putPart(open.parts[0]?.url ?? '', bytes(512, 8));
      expect(sent.status).toBe(200);

      // Not vacuous: every object really is there before the delete.
      expect((await seaweed.listEntries(`tenant/${TENANT_A}/`)).length).toBe(earlier + A_OBJECTS);

      await target.deletePrefix(tenantStoragePrefix(TENANT_A));

      expect(
        (await seaweed.listEntries(`tenant/${TENANT_A}/`)).length,
        'objects survived the tenant’s deletePrefix',
      ).toBe(0);
      expect((await seaweed.listEntries(`tenant/${TENANT_B}/`)).map((e) => e.key).sort()).toEqual(
        bKeys.map((key) => String(key)).sort(),
      );
      // R10: the open upload cannot bring the file back.
      let completed = true;
      try {
        await target.completeUpload(openKey, open.uploadId, [{ partNumber: 1, etag: sent.etag }]);
      } catch {
        completed = false;
      }
      expect(completed, 'an upload open at offboarding was completed afterwards').toBe(false);
      expect((await seaweed.listEntries(`tenant/${TENANT_A}/`)).length).toBe(0);
    }, 240_000);
  });

  // -------------------------------------------------------------------------
  // T. The table
  // -------------------------------------------------------------------------
  describe('the stored_object table (T)', () => {
    const tableExists = async (): Promise<void> => {
      const found = await migrator.query<{ oid: string | null }>(`SELECT to_regclass('public.stored_object')::text AS oid`);
      expect(found.rows[0]?.oid, 'there is no table stored_object').toBe('stored_object');
    };

    it('one migration file creates it', () => {
      const creates = readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .filter((name) =>
          /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?stored_object"?\s*\(/i.test(
            readFileSync(join(MIGRATIONS_DIR, name), 'utf8').replace(/--[^\n]*/g, ''),
          ),
        );
      expect(creates.length, `migrations creating stored_object: ${creates.join(', ') || 'none'}`).toBe(1);
    });

    it('has exactly the pinned columns (R3)', async () => {
      await tableExists();
      const columns = await migrator.query<{ column: string; type: string; notnull: boolean; default: string | null }>(
        `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default
           FROM pg_attribute a
           LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = to_regclass('public.stored_object') AND a.attnum > 0 AND NOT a.attisdropped`,
      );
      const got = Object.fromEntries(columns.rows.map((row) => [row.column, row]));
      const TS = 'timestamp with time zone';
      const spec: Record<string, { type: string; notNull: boolean | null; default?: RegExp }> = {
        id: { type: 'uuid', notNull: true },
        tenant_id: { type: 'uuid', notNull: true },
        programme_id: { type: 'uuid', notNull: true },
        key: { type: 'text', notNull: true },
        purpose: { type: 'text', notNull: true },
        declared_size_bytes: { type: 'bigint', notNull: true },
        verified_size_bytes: { type: 'bigint', notNull: false },
        content_type: { type: 'text', notNull: true },
        sha256: { type: 'bytea', notNull: false },
        status: { type: 'text', notNull: true, default: /^'pending'(::text)?$/ },
        uploaded_by_user_id: { type: 'uuid', notNull: true },
        created_at: { type: TS, notNull: true, default: /^now\(\)$/ },
        expires_at: { type: TS, notNull: null },
      };
      expect(Object.keys(got).sort()).toEqual(Object.keys(spec).sort());
      for (const [name, want] of Object.entries(spec)) {
        expect(got[name]?.type, `${name} type`).toBe(want.type);
        if (want.notNull !== null) expect(got[name]?.notnull, `${name} NOT NULL`).toBe(want.notNull);
        if (want.default !== undefined) expect(got[name]?.default ?? '', `${name} default`).toMatch(want.default);
      }
      const pk = await migrator.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS columns
           FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
          WHERE i.indrelid = to_regclass('public.stored_object') AND i.indisprimary`,
      );
      expect(pk.rows[0]?.columns).toEqual(['id']);
    });

    it('RLS is ENABLED and FORCED; every permissive policy names tenant and programme; one has WITH CHECK identical to USING', async () => {
      await tableExists();
      const state = await migrator.query<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class
          WHERE oid = to_regclass('public.stored_object')`,
      );
      expect(state.rows[0]).toEqual({ enabled: true, forced: true });
      const policies = await migrator.query<{ name: string; permissive: boolean; using: string | null; check: string | null }>(
        `SELECT polname AS name, polpermissive AS permissive,
                pg_get_expr(polqual, polrelid) AS using, pg_get_expr(polwithcheck, polrelid) AS check
           FROM pg_policy WHERE polrelid = to_regclass('public.stored_object')`,
      );
      expect(policies.rows.length).toBeGreaterThan(0);
      for (const policy of policies.rows.filter((row) => row.permissive)) {
        for (const expression of [policy.using, policy.check]) {
          if (expression === null) continue;
          expect(expression, policy.name).toContain('current_tenant_id()');
          expect(expression, policy.name).toContain('current_programme_ids()');
        }
      }
      expect(policies.rows.some((row) => row.check !== null && row.check === row.using)).toBe(true);
    });

    it('is in TENANT_SCOPED_TABLES and mirrored in schema.ts', () => {
      expect([...TENANT_SCOPED_TABLES]).toContain('stored_object');
      expect(readFileSync(fromRoot('packages/db/src/schema.ts'), 'utf8')).toMatch(/pgTable\(\s*'stored_object'/);
    });

    it('FKs: (tenant_id, programme_id) -> programme and (tenant_id, uploaded_by_user_id) -> "user"; every FK carries tenant_id and is ON UPDATE RESTRICT', async () => {
      await tableExists();
      const fks = await migrator.query<{ ref: string; on_update: string; pairs: string[] }>(
        `SELECT ref.relname AS ref, con.confupdtype::text AS on_update,
                array_agg(la.attname || '->' || fa.attname ORDER BY la.attname) AS pairs
           FROM pg_constraint con
           JOIN pg_class ref ON ref.oid = con.confrelid
          CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(l, f)
           JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.l
           JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.f
          WHERE con.contype = 'f' AND con.conrelid = to_regclass('public.stored_object')
          GROUP BY con.oid, ref.relname, con.confupdtype`,
      );
      const rows = fks.rows;
      expect(
        rows.some((fk) => fk.ref === 'programme' && fk.pairs.includes('tenant_id->tenant_id') && fk.pairs.includes('programme_id->id')),
        'no composite FK (tenant_id, programme_id) -> programme',
      ).toBe(true);
      expect(
        rows.some((fk) => fk.ref === 'user' && fk.pairs.includes('tenant_id->tenant_id') && fk.pairs.includes('uploaded_by_user_id->id')),
        'no composite FK (tenant_id, uploaded_by_user_id) -> "user"',
      ).toBe(true);
      for (const fk of rows) {
        if (fk.ref !== 'tenant') expect(fk.pairs, `FK to ${fk.ref} without tenant_id`).toContain('tenant_id->tenant_id');
        expect(fk.on_update, `FK to ${fk.ref} is not ON UPDATE RESTRICT (D-L76)`).toBe('r');
      }
    });

    it('kasuwa_migrator owns it; kasuwa_app may SELECT, INSERT and UPDATE but not DELETE; nothing it can enter may DELETE, TRUNCATE or bypass RLS; kasuwa_auth holds nothing', async () => {
      await tableExists();
      const owner = await migrator.query<{ owner: string }>(
        `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = to_regclass('public.stored_object')`,
      );
      expect(owner.rows[0]?.owner).toBe('kasuwa_migrator');
      const app = await migrator.query<Record<string, boolean>>(
        `SELECT has_table_privilege('kasuwa_app', 'public.stored_object', 'SELECT') AS select,
                has_table_privilege('kasuwa_app', 'public.stored_object', 'INSERT') AS insert,
                has_any_column_privilege('kasuwa_app', 'public.stored_object', 'UPDATE') AS update,
                has_table_privilege('kasuwa_app', 'public.stored_object', 'DELETE') AS delete,
                has_table_privilege('kasuwa_auth', 'public.stored_object', 'SELECT')
                  OR has_table_privilege('kasuwa_auth', 'public.stored_object', 'INSERT')
                  OR has_any_column_privilege('kasuwa_auth', 'public.stored_object', 'UPDATE')
                  OR has_table_privilege('kasuwa_auth', 'public.stored_object', 'DELETE') AS auth_any`,
      );
      expect(app.rows[0]).toEqual({ select: true, insert: true, update: true, delete: false, auth_any: false });
      const held = await migrator.query<{ held: string }>(
        `SELECT r.rolname || ':' || x.what AS held
           FROM pg_roles r
          CROSS JOIN LATERAL (
            SELECT 'DELETE' AS what WHERE has_table_privilege(r.oid, 'public.stored_object', 'DELETE')
            UNION ALL SELECT 'TRUNCATE' WHERE has_table_privilege(r.oid, 'public.stored_object', 'TRUNCATE')
            UNION ALL SELECT 'BYPASSRLS' WHERE r.rolbypassrls) AS x
          WHERE pg_has_role('kasuwa_app', r.oid, 'MEMBER')`,
      );
      expect(held.rows.map((row) => row.held)).toEqual([]);
    });

    it('`key` has a unique index on (key) alone', async () => {
      await tableExists();
      const unique = await migrator.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text) AS columns
           FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
          WHERE i.indrelid = to_regclass('public.stored_object') AND i.indisunique AND i.indpred IS NULL
          GROUP BY i.indexrelid`,
      );
      expect(unique.rows.map((row) => row.columns.join(','))).toContain('key');
    });

    it('as kasuwa_app (A1 agent): the valid insert is accepted, and every rule-breaking one is refused (R1)', async () => {
      await tableExists();
      const results = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, async (query) => {
        const id = randomUUID();
        const insert = (overrides: Record<string, unknown>): Promise<Outcome> => {
          const row: Record<string, unknown> = {
            id,
            tenant_id: TENANT_A,
            programme_id: PROGRAMME_A1,
            key: keyText(TENANT_A, PROGRAMME_A1, id),
            purpose: 'import',
            declared_size_bytes: 1024,
            content_type: 'text/csv',
            uploaded_by_user_id: USER_A_AGENT_1,
            ...overrides,
          };
          const names = Object.keys(row);
          return probe(
            query,
            `INSERT INTO stored_object (${names.join(', ')}) VALUES (${names.map((_n, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
            Object.values(row),
          );
        };
        return {
          control: verdict(await insert({})),
          otherTenantKey: verdict(await insert({ key: keyText(TENANT_B, PROGRAMME_B1, id) })),
          otherProgrammeKey: verdict(await insert({ key: keyText(TENANT_A, PROGRAMME_A2, id) })),
          otherIdKey: verdict(await insert({ key: keyText(TENANT_A, PROGRAMME_A1, randomUUID()) })),
          filenameKey: verdict(await insert({ key: `${keyText(TENANT_A, PROGRAMME_A1, id)}/list.csv` })),
          purpose: verdict(await insert({ purpose: 'export', key: `tenant/${TENANT_A}/programme/${PROGRAMME_A1}/export/${id}` })),
          status: verdict(await insert({ status: 'archived' })),
          zeroSize: verdict(await insert({ declared_size_bytes: 0 })),
          negativeSize: verdict(await insert({ declared_size_bytes: -1 })),
          shortHash: verdict(await insert({ sha256: Buffer.alloc(31) })),
          otherProgramme: verdict(await insert({ programme_id: PROGRAMME_A2, key: keyText(TENANT_A, PROGRAMME_A2, id) })),
          otherTenantUploader: verdict(await insert({ uploaded_by_user_id: USER_B_AGENT_1 })),
        };
      });
      expect(results.control, 'the valid row (the control)').toBe('accepted');
      for (const [name, outcome] of Object.entries(results).filter(([name]) => name !== 'control')) {
        expect(REFUSED, `${name}: ${outcome}`).toContain(outcome);
      }
    });

    it('as kasuwa_migrator (BYPASSRLS), the keys still bind: another tenant’s programme or uploader is refused, and so is a key that does not match the row', async () => {
      await tableExists();
      const results = await rolledBackTx(migrator, async (query) => {
        const id = randomUUID();
        const insert = (tenant: string, programme: string, key: string, uploader: string): Promise<Outcome> =>
          probe(query, INSERT_ROW, [id, tenant, programme, key, 1024, uploader]);
        return {
          control: verdict(await insert(TENANT_A, PROGRAMME_A1, keyText(TENANT_A, PROGRAMME_A1, id), USER_A_AGENT_1)),
          crossProgramme: verdict(await insert(TENANT_A, PROGRAMME_B1, keyText(TENANT_A, PROGRAMME_B1, id), USER_A_AGENT_1)),
          crossUploader: verdict(await insert(TENANT_A, PROGRAMME_A1, keyText(TENANT_A, PROGRAMME_A1, id), USER_B_AGENT_1)),
          foreignKey: verdict(await insert(TENANT_A, PROGRAMME_A1, keyText(TENANT_B, PROGRAMME_B1, id), USER_A_AGENT_1)),
        };
      });
      expect(results.control).toBe('accepted');
      expect(REFUSED).toContain(results.crossProgramme);
      expect(REFUSED).toContain(results.crossUploader);
      expect(REFUSED).toContain(results.foreignKey);
    });

    it('each session sees exactly its own programmes’ rows', async () => {
      requirePlanted();
      const seen = async (tenantId: string, userId: string): Promise<string[]> =>
        rolledBackTenantTx(appPool, tenantId, userId, async (query) =>
          (
            await query<{ id: string }>(`SELECT id FROM stored_object WHERE id = ANY ($1::uuid[]) ORDER BY id`, [
              PLANTED.map((row) => row.id),
            ])
          ).map((row) => row.id),
        );
      expect(await seen(TENANT_A, USER_A_AGENT_1)).toEqual([ROW_A1, ROW_A1_SPARE].sort());
      expect(await seen(TENANT_A, USER_A_AGENT_2)).toEqual([ROW_A2]);
      expect(await seen(TENANT_A, USER_A_SUPERVISOR)).toEqual([ROW_A1, ROW_A2, ROW_A1_SPARE].sort());
      expect(await seen(TENANT_B, USER_B_AGENT_1)).toEqual([ROW_B1]);
      expect(await seen(TENANT_A, USER_A_NO_PROGRAMME)).toEqual([]);
    });

    it('an A1 session cannot update an A2 or tenant-B row, and a DELETE even of its own row is 42501', async () => {
      requirePlanted();
      const results = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, async (query) => ({
        own: verdict(await probe(query, `UPDATE stored_object SET status = 'uploaded' WHERE id = $1 RETURNING id`, [ROW_A1])),
        ownRows: (await query(`SELECT 1 FROM stored_object WHERE id = $1`, [ROW_A1])).length,
        a2: await probe(query, `UPDATE stored_object SET status = 'uploaded' WHERE id = ANY ($1::uuid[]) RETURNING id`, [[ROW_A2, ROW_B1]]),
        delete: verdict(await probe(query, `DELETE FROM stored_object WHERE id = $1 RETURNING id`, [ROW_A1])),
      }));
      expect(results.own, 'the control: an A1 agent can move its own row').toBe('accepted');
      expect(results.ownRows).toBe(1);
      expect(results.a2).toEqual({ accepted: true, rows: 0 });
      expect(results.delete).toBe('insufficient_privilege');
    });

    const FIXED_FOR_APP: [string, unknown][] = [
      ['key', keyText(TENANT_A, PROGRAMME_A1, INVENTED)],
      ['id', INVENTED],
      ['tenant_id', TENANT_B],
      ['programme_id', PROGRAMME_A2],
      ['purpose', 'export'],
      ['uploaded_by_user_id', USER_A_AGENT_2],
      ['created_at', '2001-01-01T00:00:00Z'],
      ['declared_size_bytes', 1],
    ];

    it.each(FIXED_FOR_APP)('as kasuwa_app, %s never changes (refused or kept)', async (column, value) => {
      requirePlanted();
      const result = await rolledBackTenantTx(appPool, TENANT_A, USER_A_SUPERVISOR, async (query) => {
        const before = await query<Record<string, unknown>>(`SELECT to_jsonb(s) AS row FROM stored_object s WHERE id = $1`, [ROW_A1]);
        await query('SAVEPOINT t0092_fixed');
        let outcome: string;
        try {
          await query(`UPDATE stored_object SET ${column} = $2 WHERE id = $1`, [ROW_A1, value]);
          outcome = 'ran';
        } catch (error) {
          outcome = verdict(outcomeOf(error));
          await query('ROLLBACK TO SAVEPOINT t0092_fixed');
        }
        const after = await query<Record<string, unknown>>(`SELECT to_jsonb(s) AS row FROM stored_object s WHERE id = $1`, [ROW_A1]);
        const visibleById = await query(`SELECT 1 FROM stored_object WHERE id = $1`, [INVENTED]);
        return { outcome, same: JSON.stringify(before) === JSON.stringify(after) && visibleById.length === 0 };
      });
      expect(result.outcome === 'ran' || REFUSED.includes(result.outcome), result.outcome).toBe(true);
      expect(result.same, `${column} changed as kasuwa_app`).toBe(true);
    });

    it.each(FIXED_FOR_APP.slice(0, 5))('as kasuwa_test_admin (BYPASSRLS), %s never changes (D-L76)', async (column, value) => {
      requirePlanted();
      const result = await rolledBackTx(testAdmin, async (query) => {
        // The control: this role CAN change the row (status), so a kept key is the guard.
        const control = verdict(await probe(query, `UPDATE stored_object SET status = 'rejected' WHERE id = $1 RETURNING id`, [ROW_A1]));
        const before = await query(`SELECT to_jsonb(s) AS row FROM stored_object s WHERE id = $1`, [ROW_A1]);
        await query('SAVEPOINT t0092_fixed');
        let outcome: string;
        try {
          await query(`UPDATE stored_object SET ${column} = $2 WHERE id = $1`, [ROW_A1, value]);
          outcome = 'ran';
        } catch (error) {
          outcome = verdict(outcomeOf(error));
          await query('ROLLBACK TO SAVEPOINT t0092_fixed');
        }
        const after = await query(`SELECT to_jsonb(s) AS row FROM stored_object s WHERE id = $1`, [ROW_A1]);
        return { control, outcome, same: JSON.stringify(before) === JSON.stringify(after) && after.length === 1 };
      });
      expect(result.control).toBe('accepted');
      expect(result.outcome === 'ran' || REFUSED.includes(result.outcome), result.outcome).toBe(true);
      expect(result.same, `${column} changed as kasuwa_test_admin`).toBe(true);
    });

    it('offboarding still works: the migrator deletes a programme, then a tenant, holding rows (rolled back)', async () => {
      requirePlanted();
      const results = await rolledBackTx(migrator, async (query) => ({
        programme: verdict(await probe(query, `DELETE FROM programme WHERE id = $1 RETURNING id`, [PROGRAMME_A2])),
        tenant: verdict(await probe(query, `DELETE FROM tenant WHERE id = $1 RETURNING id`, [TENANT_B])),
      }));
      expect(results).toEqual({ programme: 'accepted', tenant: 'accepted' });
    });

    it('adds no SECURITY DEFINER function (CLAUDE.md 2.7)', async () => {
      await tableExists();
      const definers = await migrator.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
      );
      expect(definers.rows.map((row) => row.name)).toEqual(['app.resolve_session', 'app.resolve_tenant_by_slug']);
    });
  });

  // -------------------------------------------------------------------------
  // S. The repository and scope
  // -------------------------------------------------------------------------
  describe('the repository: a URL only after the row is read in scope (S)', () => {
    /** A store that records every call, so "the store was never asked" is observable. */
    const recording = (inner: ObjectStore): { wrapped: ObjectStore; calls: string[] } => {
      const calls: string[] = [];
      const wrapped = Object.fromEntries(
        STORE_METHODS.map((method) => [
          method,
          (...args: unknown[]) => {
            calls.push(method);
            return (inner[method] as (...a: unknown[]) => unknown).apply(inner, args);
          },
        ]),
      ) as unknown as ObjectStore;
      return { wrapped, calls };
    };

    const repository = async (): Promise<{ repo: StoredObjectRepository; calls: string[]; NotFound: new (...args: never[]) => Error }> => {
      const { StoredObjectRepository: Repo, StoredObjectNotFoundError } = await adapter();
      const { wrapped, calls } = recording(await store());
      return { repo: new Repo(wrapped), calls, NotFound: StoredObjectNotFoundError };
    };

    it('create writes a pending row whose key is derived from it, as the caller; get reads it back; the record carries no key text (R1, R4)', async () => {
      requirePlanted();
      const { repo } = await repository();
      const created = await asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
        repo.create(tx, { programmeId: PROGRAMME_A1, purpose: 'import', declaredSizeBytes: 2048, contentType: 'text/csv' }),
      );
      expect(created).toMatchObject({
        tenantId: TENANT_A,
        programmeId: PROGRAMME_A1,
        purpose: 'import',
        status: 'pending',
        declaredSizeBytes: 2048,
        verifiedSizeBytes: null,
        contentType: 'text/csv',
      });
      expect(created.id).toMatch(UUID_V4);
      expect(safeJson(created), 'the record carries a storage key').not.toContain('tenant/');
      const row = await migrator.query<{ key: string; uploaded_by_user_id: string }>(
        `SELECT key, uploaded_by_user_id FROM stored_object WHERE id = $1`,
        [created.id],
      );
      expect(row.rows[0]).toEqual({ key: keyText(TENANT_A, PROGRAMME_A1, created.id), uploaded_by_user_id: USER_A_AGENT_1 });
      const read = await asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.get(tx, created.id));
      expect(read.id).toBe(created.id);
    });

    it('create in a programme the caller cannot reach writes nothing', async () => {
      requirePlanted();
      const { repo } = await repository();
      const count = async (): Promise<number> =>
        Number((await migrator.query<{ n: string }>(`SELECT count(*)::text AS n FROM stored_object`)).rows[0]?.n ?? '-1');
      const before = await count();
      for (const programmeId of [PROGRAMME_A2, PROGRAMME_B1, INVENTED]) {
        await rejectionOf(
          () =>
            asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
              repo.create(tx, { programmeId, purpose: 'import', declaredSizeBytes: 10, contentType: 'text/csv' }),
            ),
          `created a row in ${programmeId}`,
        );
      }
      expect(await count()).toBe(before);
    });

    /** Every way to name a row the caller must not see, as [label, tenant, user, id]. */
    const OUT_OF_SCOPE: [string, string, string, string][] = [
      ['another programme’s row', TENANT_A, USER_A_AGENT_1, ROW_A2],
      ['another tenant’s row', TENANT_A, USER_A_AGENT_1, ROW_B1],
      ['an invented id', TENANT_A, USER_A_AGENT_1, INVENTED],
      ['a malformed id', TENANT_A, USER_A_AGENT_1, 'not-a-uuid'],
      ['a tenant-B caller on an A1 row', TENANT_B, USER_B_AGENT_1, ROW_A1],
      ['a caller with no programme', TENANT_A, USER_A_NO_PROGRAMME, ROW_A1],
    ];

    it('get, presignUpload, completeUpload and markDeleted all answer every out-of-scope id with ONE error, and the store is never asked', async () => {
      requirePlanted();
      const { repo, calls, NotFound } = await repository();
      const proxyBefore = proxy.requests.length;
      const operations: [string, (tx: TenantTx, id: string) => Promise<unknown>][] = [
        ['get', (tx, id) => repo.get(tx, id)],
        ['presignUpload', (tx, id) => repo.presignUpload(tx, id, { partCount: 1 })],
        ['completeUpload', (tx, id) => repo.completeUpload(tx, id, { uploadId: 'x', parts: [{ partNumber: 1, etag: '"x"' }] })],
        ['markDeleted', (tx, id) => repo.markDeleted(tx, id)],
      ];
      const bodies = new Set<string>();
      for (const [operation, call] of operations) {
        for (const [label, tenantId, userId, id] of OUT_OF_SCOPE) {
          const error = await rejectionOf(() => asUser(tenantId, userId, (tx) => call(tx, id)), `${operation}: ${label} answered`);
          expect(error, `${operation}: ${label} is not a StoredObjectNotFoundError`).toBeInstanceOf(NotFound);
          bodies.add(JSON.stringify({ message: error.message, code: (error as { code?: unknown }).code ?? null }));
          for (const named of [ROW_A1, ROW_A2, ROW_B1, INVENTED, 'not-a-uuid']) {
            expect(error.message, `${operation}: ${label} names an id`).not.toContain(named);
          }
        }
      }
      expect([...bodies], 'out-of-scope ids are told apart (an existence oracle, CLAUDE.md 6.4)').toHaveLength(1);
      expect(calls, 'the store was called for a row the caller cannot see').toEqual([]);
      expect(proxy.requests.slice(proxyBefore), 'a request reached the bucket').toEqual([]);
      // Nothing moved: the planted rows are still pending.
      const statuses = await migrator.query<{ status: string }>(
        `SELECT DISTINCT status FROM stored_object WHERE id = ANY ($1::uuid[])`,
        [[ROW_A1, ROW_A2, ROW_B1]],
      );
      expect(statuses.rows.map((row) => row.status)).toEqual(['pending']);
    });

    it('the supervisor reaches both programmes’ rows (the control for the refusals)', async () => {
      requirePlanted();
      const { repo } = await repository();
      for (const id of [ROW_A1, ROW_A2]) {
        expect((await asUser(TENANT_A, USER_A_SUPERVISOR, (tx) => repo.get(tx, id))).id).toBe(id);
      }
    });

    it('filters explicitly too: a session narrower than the connection’s GUCs cannot read the wider row (R7)', async () => {
      requirePlanted();
      const { repo, NotFound } = await repository();
      const outcome = await rolledBackTenantTx(appPool, TENANT_A, USER_A_SUPERVISOR, async (query, tx) => {
        // RLS on this connection admits A1 and A2 (the supervisor's GUCs) ...
        const rlsSees = (await query(`SELECT 1 FROM stored_object WHERE id = $1`, [ROW_A2])).length;
        // ... but the session the repository is handed is agent 1's: A1 only.
        const narrowed: TenantTx = {
          session: { tenantId: TENANT_A, userId: USER_A_AGENT_1, programmeIds: [PROGRAMME_A1] },
          query: (text, values) => tx.query(text, values),
        };
        let result = 'read';
        try {
          await repo.get(narrowed, ROW_A2);
        } catch (error) {
          result = error instanceof NotFound ? 'not_found' : `other: ${String(error)}`;
        }
        const control = (await repo.get(narrowed, ROW_A1)).id;
        return { rlsSees, result, control };
      });
      expect(outcome).toEqual({ rlsSees: 1, result: 'not_found', control: ROW_A1 });
    });

    it('presignUpload on an in-scope pending row signs its declared size; completing it moves it to uploaded with the verified size', async () => {
      requirePlanted();
      const { repo } = await repository();
      const total = 6 * MiB + 1;
      const created = await asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
        repo.create(tx, { programmeId: PROGRAMME_A1, purpose: 'import', declaredSizeBytes: total, contentType: 'text/csv' }),
      );
      const upload = await asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.presignUpload(tx, created.id, { partCount: 1 }));
      expect(upload.parts.map((p) => p.contentLength)).toEqual([total]);
      const sent = await putPart(upload.parts[0]?.url ?? '', bytes(total, 6));
      expect(sent.status).toBe(200);
      const done = await asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
        repo.completeUpload(tx, created.id, { uploadId: upload.uploadId, parts: [{ partNumber: 1, etag: sent.etag }] }),
      );
      expect(done).toMatchObject({ status: 'uploaded', verifiedSizeBytes: total });
      expect((await seaweed.listEntries(keyText(TENANT_A, PROGRAMME_A1, created.id))).map((e) => e.size)).toEqual([total]);
    }, 60_000);

    it('completing with a part missing: head disagrees with the declaration, the row is rejected and the object deleted', async () => {
      requirePlanted();
      const { repo } = await repository();
      const total = 12 * MiB;
      const created = await asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
        repo.create(tx, { programmeId: PROGRAMME_A1, purpose: 'import', declaredSizeBytes: total, contentType: 'text/csv' }),
      );
      const upload = await asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.presignUpload(tx, created.id, { partCount: 2 }));
      const first = upload.parts[0];
      const sent = await putPart(first?.url ?? '', bytes(first?.contentLength ?? 0, 3));
      expect(sent.status).toBe(200);
      let outcome: StoredObjectRecord | undefined;
      try {
        outcome = await asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
          repo.completeUpload(tx, created.id, { uploadId: upload.uploadId, parts: [{ partNumber: 1, etag: sent.etag }] }),
        );
      } catch {
        // A thrown refusal is acceptable; the row's state below is what counts.
      }
      if (outcome !== undefined) expect(outcome.status).toBe('rejected');
      const row = await migrator.query<{ status: string }>(`SELECT status FROM stored_object WHERE id = $1`, [created.id]);
      expect(row.rows[0]?.status, 'a short upload was accepted').toBe('rejected');
      expect(await seaweed.listEntries(keyText(TENANT_A, PROGRAMME_A1, created.id)), 'the rejected object is still stored').toEqual([]);
    }, 60_000);

    it('markDeleted deletes the object and is terminal: no URL is issued afterwards (R8)', async () => {
      requirePlanted();
      const { repo, calls } = await repository();
      const created = await asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
        repo.create(tx, { programmeId: PROGRAMME_A1, purpose: 'import', declaredSizeBytes: 1024, contentType: 'text/csv' }),
      );
      const upload = await asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.presignUpload(tx, created.id, { partCount: 1 }));
      const sent = await putPart(upload.parts[0]?.url ?? '', bytes(1024, 1));
      await asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
        repo.completeUpload(tx, created.id, { uploadId: upload.uploadId, parts: [{ partNumber: 1, etag: sent.etag }] }),
      );
      const deleted = await asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.markDeleted(tx, created.id));
      expect(deleted.status).toBe('deleted');
      expect(await seaweed.listEntries(keyText(TENANT_A, PROGRAMME_A1, created.id))).toEqual([]);
      const presignsBefore = calls.filter((c) => c === 'presignUpload').length;
      await rejectionOf(
        () => asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.presignUpload(tx, created.id, { partCount: 1 })),
        'issued a URL for a deleted row',
      );
      expect(calls.filter((c) => c === 'presignUpload').length, 'the store was asked for a URL for a deleted row').toBe(presignsBefore);
    }, 60_000);

    it('presignUpload is refused for a row that is already uploaded (R8)', async () => {
      requirePlanted();
      const { repo, calls } = await repository();
      await migrator.query(`UPDATE stored_object SET status = 'uploaded', verified_size_bytes = declared_size_bytes WHERE id = $1`, [ROW_A1_SPARE]);
      await rejectionOf(
        () => asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.presignUpload(tx, ROW_A1_SPARE, { partCount: 1 })),
        'issued a URL for an uploaded row',
      );
      expect(calls).not.toContain('presignUpload');
    });
  });

  // -------------------------------------------------------------------------
  // L. Logging and errors
  // -------------------------------------------------------------------------
  describe('nothing sensitive is logged or carried by an error (L)', () => {
    it('a full cycle, and its failures, write no key, URL, signature or credential anywhere', async () => {
      requirePlanted();
      const { StoredObjectRepository: Repo } = await adapter();
      const secrets: string[] = [seaweed.secretAccessKey, seaweed.accessKeyId];
      const errors: unknown[] = [];
      const captured = await captureEverything(async () => {
        const target = await store();
        const repo = new Repo(target);
        const key = await mintA1();
        secrets.push(String(key));
        await putSmall(target, key);
        await target.head(key);
        await drain(target.getStream(key));
        const created = await asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
          repo.create(tx, { programmeId: PROGRAMME_A1, purpose: 'import', declaredSizeBytes: 1024, contentType: 'text/csv' }),
        );
        secrets.push(keyText(TENANT_A, PROGRAMME_A1, created.id));
        const upload = await asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.presignUpload(tx, created.id, { partCount: 1 }));
        for (const part of upload.parts) {
          secrets.push(part.url, new URL(part.url).searchParams.get('X-Amz-Signature') ?? '');
        }
        const sent = await putPart(upload.parts[0]?.url ?? '', bytes(1024, 2));
        await asUser(TENANT_A, USER_A_AGENT_1, (tx) =>
          repo.completeUpload(tx, created.id, { uploadId: upload.uploadId, parts: [{ partNumber: 1, etag: sent.etag }] }),
        );
        await asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.markDeleted(tx, created.id));
        await target.delete(key);

        // Failures: a missing object, a bogus upload, wrong credentials, an
        // out-of-scope row. SeaweedFS's error XML for each S3 failure carries
        // <Key> and <Resource> with the full key path (observed), which is
        // exactly what a wrapped SDK error would keep. (No "missing bucket"
        // case: SeaweedFS 3.80 creates a bucket on the first PUT to it.)
        const failures: (() => Promise<unknown>)[] = [
          async () => drain(target.getStream(key)),
          () => target.completeUpload(key, 'no-such-upload-0092', [{ partNumber: 1, etag: '"0"' }]),
          async () => putSmall(await store({ ...storeEnv, S3_SECRET_ACCESS_KEY: `${seaweed.secretAccessKey}-wrong` }), key),
          () => asUser(TENANT_A, USER_A_AGENT_1, (tx) => repo.get(tx, ROW_B1)),
        ];
        for (const failure of failures) {
          try {
            await failure();
            errors.push(new Error('did not fail'));
          } catch (error) {
            errors.push(error);
          }
        }
        secrets.push(`${seaweed.secretAccessKey}-wrong`);
      });

      const logged = leaks([...captured.lines, ...captured.telemetry], secrets);
      expect(logged, 'something sensitive was logged').toEqual([]);
      expect(errors.filter((e) => e instanceof Error && e.message === 'did not fail'), 'a failure path succeeded').toEqual([]);
      for (const [index, error] of errors.entries()) {
        expect(leaks(stringsIn(error), secrets), `error ${index} carries something sensitive`).toEqual([]);
        expect(typeof (error as { code?: unknown }).code, `error ${index} has no string code`).toBe('string');
      }
    }, 120_000);

    it('(self-check, passes on main) the leak scan finds a planted secret in a nested cause', () => {
      const planted = new Error('outer', { cause: Object.assign(new Error('inner'), { $response: { path: '/b/tenant/x/secret-key-path' } }) });
      expect(leaks(stringsIn(planted), ['secret-key-path'])).toEqual(['secret-key-path']);
      expect(leaks(stringsIn(new Error('clean')), ['secret-key-path'])).toEqual([]);
    });
  });
});
