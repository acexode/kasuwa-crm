import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed, startRedis, startSeaweedFs, withForcedScope, type StartedRedis, type StartedSeaweedFs } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { asUser, withAuthDatabase } from '../support/api';

/**
 * ACCEPTANCE (ADVERSARIAL) — T-0094 import isolation (ADR-0017 Decisions 2-4,
 * D-L151, D-L155; CLAUDE.md 2.1-2.4, 6.4). Written by QA for the lead before
 * the build (D-L23, D-L25). The behavioural suite is
 * tests/acceptance/records/import-api.acceptance.test.ts; its PINNED
 * INTERFACES (A boot options, B queues and payloads, C the processors in
 * apps/worker/src/import-jobs.ts, D the import_job columns) apply here
 * unchanged and are not repeated. Helpers are restated, never imported.
 *
 * Every test here tries to make the model fail: reach another tenant's or
 * programme's import, get a URL for bytes that are not yours, finish or run
 * an upload that is someone else's, hand the server an upload it did not
 * start, or point a job at bytes in another tenant with raw SQL.
 *
 * RULINGS (this suite's; the lead may reverse them):
 *
 *   I1  ONE 404. Every operation with an import id, by a caller who cannot
 *       see the import (another tenant, another programme, the same programme
 *       without `contact.import`), answers exactly the body an id that never
 *       existed answers, and carries no URL. The 404 is decided before status
 *       (409) and before the creator check (403), so status and existence
 *       are not oracles either.
 *   I2  The importId filter on listContacts is an empty page for any import
 *       the caller cannot see, including one whose contacts the caller CAN
 *       see in the plain list (same programme, no `contact.import`).
 *   I3  A FORGED UPLOAD. The client never names an upload id (a body that
 *       does is 400); complete uses the id stored on the job (D-L155). If
 *       that stored id is not the upload the server opened for the object's
 *       key (tampered to a made-up value, or to ANOTHER import's open
 *       upload), complete fails (status >= 400): no object appears at either
 *       key, the job does not advance, stored_object is not `uploaded`, and
 *       the other import's upload is untouched and still completes.
 *   I4  RAW SQL, as the migrator (BYPASSRLS, so only the schema stops it):
 *       import_job cannot point at a stored_object in another tenant or
 *       another programme; contact.import_job_id cannot point at a job in
 *       another tenant or programme. As kasuwa_app in a real session: a job
 *       cannot be inserted naming another creator (that would make the job
 *       RUN AS someone else) or another tenant, the keys and the creator of a
 *       job cannot be updated, and nothing can be deleted.
 *   I5  FORGED PAYLOADS. A processor given a payload whose userId is not the
 *       import's creator, whose tenantId is not the import's, naming a user
 *       of another tenant, or carrying any extra key, creates nothing,
 *       reads no header, deletes nothing and does not advance the job. The
 *       genuine payload then works (the control).
 *
 * D-L23: on main there is no route, no table and no worker module; every
 * test fails at its first request, plant or load.
 *
 * Fixtures: packages/db/src/fixtures.ts, plus stored_object rows the migrator
 * plants with ids in this suite's range (`11111111-0094-4000-8100-...`).
 * Reseed after every test.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const WORKER_JOBS_MODULE = resolve(REPO_ROOT, 'apps/worker/src/import-jobs.ts');
const ADAPTER_MODULE = '@kasuwa/storage-adapter';
const CONFIG_MODULE = '@kasuwa/config';
const HEADER_QUEUE = 'kasuwa.import.header';
const RUN_QUEUE = 'kasuwa.import.run';
const RETENTION_QUEUE = 'kasuwa.import.retention';
const QUEUES = [HEADER_QUEUE, RUN_QUEUE, RETENTION_QUEUE] as const;
const JOB_STATES = ['waiting', 'delayed', 'paused', 'prioritized', 'active', 'completed', 'failed'];
const DAY = 24 * 60 * 60_000;
/** Per test: most run a whole flow (the project default is 30 s). */
const FLOW_TIMEOUT = 120_000;

const RUN = Date.now().toString(36);
const id94 = (tail: string) => `11111111-0094-4000-8100-${tail.padStart(12, '0')}`;
const NOWHERE = id94('dead00000001');
const FILE = `zqiso${RUN}.csv`;

/** Agent 1 holds `admin` in A1 (beforeEach): the creator. */
const CREATOR = asUser(TENANT_A, USER_A_AGENT_1);
/** Agent 2 holds `admin` in A2 only (beforeEach): contact.import, but not in A1. */
const SIBLING = asUser(TENANT_A, USER_A_AGENT_2);
/** Emeka holds `agent` in A1 (beforeEach): sees A1's contacts, lacks contact.import. */
const NO_RIGHT = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const B_ADMIN = asUser(TENANT_B, USER_B_AGENT_1);

type Json = Record<string, unknown>;
type Headers = Record<string, string>;

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function permissionSet(tenantId: string, key: string): string {
  return must(SEED_PERMISSION_SETS.find((s) => s.tenantId === tenantId && s.key === key), `set ${key}`).id;
}

function csv(rows: readonly (readonly string[])[]): Buffer {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return Buffer.from(rows.map((r) => r.map(cell).join(',')).join('\n') + '\n', 'utf8');
}

interface UploadPart {
  partNumber: number;
  url: string;
  sizeBytes: number;
}
interface ImportUpload {
  importId: string;
  parts: UploadPart[];
}
interface JobRow {
  status: string;
  stored_object_id: string;
  upload_id: string | null;
  filename: string | null;
  headers: unknown;
  tenant_id: string;
  programme_id: string;
}

interface ImportJobDeps {
  pool: Pool;
  store: unknown;
  redisUrl: string;
  now?: () => Date;
}
type Processor = (deps: ImportJobDeps, payload: unknown) => Promise<unknown>;
interface ImportJobsModule {
  processImportHeader: Processor;
  processImportRun: Processor;
  processImportRetention: Processor;
}

async function importJobs(): Promise<ImportJobsModule> {
  let loaded: Record<string, unknown>;
  try {
    loaded = { ...(await import(WORKER_JOBS_MODULE)) };
  } catch (error) {
    throw new Error(`apps/worker/src/import-jobs.ts cannot be loaded: ${String((error as Error).message).split('\n')[0]}`);
  }
  for (const name of ['processImportHeader', 'processImportRun', 'processImportRetention']) {
    expect(typeof loaded[name], `apps/worker/src/import-jobs.ts does not export ${name}`).toBe('function');
  }
  return loaded as unknown as ImportJobsModule;
}

interface BullJob {
  name: string;
  data: unknown;
  opts: { delay?: number | undefined } & Record<string, unknown>;
}
interface BullQueue {
  getJobs(types: string[], start?: number, end?: number): Promise<BullJob[]>;
  obliterate(options: { force: boolean }): Promise<void>;
  close(): Promise<void>;
}
type BullQueueClass = new (name: string, options: { connection: { host: string; port: number } }) => BullQueue;

const DATABASE_TEXT = ['Failing row contains', 'violates', 'constraint', '23503', '42501', 'import_job', 'stored_object'];

function expectError(response: request.Response, status: number, code: string, where: string): Json {
  expect(response.status, `${where}: expected ${status} ${code}, got ${response.status} ${response.text}`).toBe(status);
  expect((response.body as Json).code, `${where}: Error.code`).toBe(code);
  for (const text of DATABASE_TEXT) expect(response.text, `${where}: database text in the body`).not.toContain(text);
  return response.body as Json;
}

/** The SQLSTATE a statement fails with, or 'ok'. */
async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return String((error as { code?: unknown }).code ?? 'no code');
  }
}

class Rollback extends Error {}

describe('acceptance (adversarial): import isolation (T-0094)', () => {
  let app: INestApplication;
  let observer: Pool;
  let appPool: Pool;
  let seaweed: StartedSeaweedFs;
  let redis: StartedRedis;
  let store: unknown;
  const queues = new Map<string, BullQueue>();

  beforeAll(async () => {
    seaweed = await startSeaweedFs();
    redis = await startRedis();
    const adapter = (await import(ADAPTER_MODULE)) as { S3ObjectStore: new (config: unknown) => unknown };
    const config = (await import(CONFIG_MODULE)) as { storageEnv: (env: Record<string, string>) => unknown };
    store = new adapter.S3ObjectStore(
      config.storageEnv({
        NODE_ENV: 'test',
        S3_ENDPOINT: seaweed.endpoint,
        S3_PUBLIC_ENDPOINT: seaweed.endpoint,
        S3_REGION: seaweed.region,
        S3_BUCKET: seaweed.bucket,
        S3_FORCE_PATH_STYLE: 'true',
        S3_ACCESS_KEY_ID: seaweed.accessKeyId,
        S3_SECRET_ACCESS_KEY: seaweed.secretAccessKey,
      }),
    );
    const workerRequire = createRequire(resolve(REPO_ROOT, 'apps/worker/package.json'));
    const Queue = (workerRequire('bullmq') as { Queue: BullQueueClass }).Queue;
    for (const name of QUEUES) queues.set(name, new Queue(name, { connection: { host: redis.host, port: redis.port } }));
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5, redisUrl: redis.url, objectStore: store })),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    for (const queue of queues.values()) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
    await appPool?.end();
    await observer?.end();
    await redis?.stop();
    await seaweed?.stop();
    await reseed(inject('migrationUrl'));
  }, 120_000);

  beforeEach(async () => {
    await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'admin');
    await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A2, 'admin');
    await assign(TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1, 'agent');
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  }, 120_000);

  // -------------------------------------------------------------------------

  const server = () => app.getHttpServer();
  const enc = encodeURIComponent;
  const importPath = (id: string, tail = '') => `/api/v1/imports/${enc(id)}${tail}`;
  const post = (headers: Headers, path: string, body?: unknown) => {
    const call = request(server()).post(path).set(headers);
    return body === undefined ? call : call.set('Content-Type', 'application/json').send(JSON.stringify(body));
  };
  const put = (headers: Headers, path: string, body: unknown) =>
    request(server()).put(path).set(headers).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const get = (headers: Headers, path: string) => request(server()).get(path).set(headers);

  async function assign(tenantId: string, userId: string, programmeId: string, key: string): Promise<void> {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id) DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, tenantId, permissionSet(tenantId, key)],
    );
  }

  async function jobRow(importId: string): Promise<JobRow> {
    const rows = await observer.query<JobRow>(
      `SELECT status, stored_object_id, upload_id, filename, headers, tenant_id, programme_id FROM import_job WHERE id = $1`,
      [importId],
    );
    return must(rows.rows[0], `import_job ${importId}`);
  }

  const keyOf = (job: JobRow) => `tenant/${job.tenant_id}/programme/${job.programme_id}/import/${job.stored_object_id}`;

  function deps(now?: () => Date): ImportJobDeps {
    return { pool: appPool, store, redisUrl: redis.url, ...(now === undefined ? {} : { now }) };
  }

  async function jobsFor(queueName: string, importId: string): Promise<BullJob[]> {
    const all = await must(queues.get(queueName), queueName).getJobs(JOB_STATES, 0, -1);
    return all.filter((job) => (job.data as Json | null)?.importId === importId);
  }

  async function onlyJob(queueName: string, importId: string): Promise<BullJob> {
    const found = await jobsFor(queueName, importId);
    expect(found.length, `${queueName}: one job expected for the import`).toBe(1);
    return must(found[0], 'job');
  }

  async function createImport(headers: Headers, programmeId: string, bytes: Buffer): Promise<ImportUpload> {
    const response = await post(headers, '/api/v1/imports', { programmeId, filename: FILE, sizeBytes: bytes.length, contentType: 'text/csv' });
    expect(response.status, `createImport: ${response.text}`).toBe(201);
    return response.body as ImportUpload;
  }

  async function putParts(parts: readonly UploadPart[], bytes: Buffer) {
    const etags: { partNumber: number; etag: string }[] = [];
    let offset = 0;
    for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
      const response = await fetch(part.url, { method: 'PUT', body: bytes.subarray(offset, offset + part.sizeBytes) });
      await response.arrayBuffer().catch(() => undefined);
      expect(response.status, `PUT part ${part.partNumber}`).toBe(200);
      etags.push({ partNumber: part.partNumber, etag: response.headers.get('etag') ?? '' });
      offset += part.sizeBytes;
    }
    return etags;
  }

  async function completed(headers: Headers, programmeId: string, bytes: Buffer): Promise<string> {
    const upload = await createImport(headers, programmeId, bytes);
    const etags = await putParts(upload.parts, bytes);
    const done = await post(headers, importPath(upload.importId, '/complete'), { parts: etags });
    expect(done.status, `complete: ${done.text}`).toBe(202);
    return upload.importId;
  }

  async function mapped(headers: Headers, programmeId: string, rows: string[][]): Promise<string> {
    const importId = await completed(headers, programmeId, csv(rows));
    await (await importJobs()).processImportHeader(deps(), (await onlyJob(HEADER_QUEUE, importId)).data);
    const saved = await put(headers, importPath(importId, '/mapping'), { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG' });
    expect(saved.status, `mapping: ${saved.text}`).toBe(200);
    return importId;
  }

  async function queued(headers: Headers, programmeId: string, rows: string[][]): Promise<{ importId: string; payload: unknown }> {
    const importId = await mapped(headers, programmeId, rows);
    const response = await post(headers, importPath(importId, '/run'));
    expect(response.status, `run: ${response.text}`).toBe(202);
    return { importId, payload: (await onlyJob(RUN_QUEUE, importId)).data };
  }

  async function countImported(importId: string): Promise<number> {
    const rows = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM contact WHERE import_job_id = $1', [importId]);
    return Number(rows.rows[0]?.n ?? '0');
  }

  /** A stored_object row the migrator plants, referenced by no job. */
  async function plantObject(tail: string, tenantId: string, programmeId: string, userId: string): Promise<string> {
    const id = id94(tail);
    // D-L166 item 1: the key is its own text parameter. Binding one parameter
    // as both a uuid column and a text operand is refused by Postgres
    // ("inconsistent types deduced for parameter") before the statement under
    // test runs.
    await observer.query(
      `INSERT INTO stored_object (id, tenant_id, programme_id, key, purpose, declared_size_bytes, content_type, uploaded_by_user_id)
       VALUES ($1, $2, $3, $5, 'import', 10, 'text/csv', $4)`,
      [id, tenantId, programmeId, userId, `tenant/${tenantId}/programme/${programmeId}/import/${id}`],
    );
    return id;
  }

  /** Every operation with an import id, with a body that would be valid for it. */
  function everyIdOperation(importId: string): [string, (h: Headers) => request.Test][] {
    return [
      ['getImport', (h) => get(h, importPath(importId))],
      ['issueImportUploadUrls', (h) => post(h, importPath(importId, '/upload-urls'), { partNumbers: [1] })],
      ['completeImportUpload', (h) => post(h, importPath(importId, '/complete'), { parts: [{ partNumber: 1, etag: '"0123456789abcdef"' }] })],
      ['abortImportUpload', (h) => post(h, importPath(importId, '/abort'))],
      ['putImportMapping', (h) => put(h, importPath(importId, '/mapping'), { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG' })],
      ['runImport', (h) => post(h, importPath(importId, '/run'))],
      ['cancelImport', (h) => post(h, importPath(importId, '/cancel'))],
    ];
  }

  async function expectOne404(who: Headers, label: string, importId: string): Promise<void> {
    const reference = new Map<string, string>();
    for (const [name, call] of everyIdOperation(NOWHERE)) {
      const response = await call(who);
      expectError(response, 404, 'not_found', `${label} ${name} on an id that never existed`);
      reference.set(name, response.text);
    }
    for (const [name, call] of everyIdOperation(importId)) {
      const response = await call(who);
      expectError(response, 404, 'not_found', `${label} ${name}`);
      expect(response.text, `${label} ${name}: not the body of an import that never existed`).toBe(reference.get(name));
      expect(response.text, `${label} ${name}: a URL in a 404`).not.toMatch(/https?:\/\/|X-Amz-/i);
      expect(String(response.headers['cache-control'] ?? ''), `${label} ${name}: Cache-Control`).toMatch(/no-store/);
    }
  }

  // =========================================================================

  describe('I1. one 404, with no URL, for every import the caller cannot see', { timeout: FLOW_TIMEOUT }, () => {
    it('another tenant’s admin: every operation on an import awaiting upload is the never-existed 404; the import is untouched', async () => {
      const upload = await createImport(CREATOR, PROGRAMME_A1, csv([['Name'], ['zqa']]));
      const before = await jobRow(upload.importId);
      await expectOne404(B_ADMIN, 'tenant B admin', upload.importId);
      expect(await jobRow(upload.importId)).toEqual(before);
      expect(await seaweed.listUploadDirectories(), 'the creator’s open upload was touched').toContain(before.upload_id);
    });

    it('an importer of another programme in the same tenant: the same 404 everywhere (in every status)', async () => {
      const upload = await createImport(CREATOR, PROGRAMME_A1, csv([['Name'], ['zqa']]));
      await expectOne404(SIBLING, 'A2 importer', upload.importId);
      const { importId } = await queued(CREATOR, PROGRAMME_A1, [['Name'], ['zqb']]);
      await expectOne404(SIBLING, 'A2 importer, queued', importId);
      expect((await jobRow(importId)).status).toBe('queued');
    });

    it('a member of the same programme without contact.import: the same 404 everywhere (R4 of the api suite)', async () => {
      const upload = await createImport(CREATOR, PROGRAMME_A1, csv([['Name'], ['zqa']]));
      await expectOne404(NO_RIGHT, 'A1 agent', upload.importId);
      expect((await jobRow(upload.importId)).status).toBe('awaiting_upload');
    });

    it('lists never cross: B sees none of A’s imports, A’s tenant admin none of B’s, the A2 importer none of A1’s', async () => {
      const a1 = (await createImport(CREATOR, PROGRAMME_A1, csv([['Name'], ['zqa']]))).importId;
      const b1 = (await createImport(B_ADMIN, PROGRAMME_B1, csv([['Name'], ['zqb']]))).importId;
      const ids = async (who: Headers) => {
        const response = await get(who, '/api/v1/imports?limit=50');
        expect(response.status, response.text).toBe(200);
        return ((response.body as { data: Json[] }).data ?? []).map((row) => String(row.id));
      };
      expect(await ids(B_ADMIN)).toEqual([b1]);
      expect(await ids(SUPERVISOR)).toEqual([a1]);
      expect(await ids(SIBLING)).toEqual([]);
      expect(await ids(NO_RIGHT)).toEqual([]);
    });
  });

  describe('I2. the importId filter is no oracle', { timeout: FLOW_TIMEOUT }, () => {
    it('an import the caller cannot see is an empty page, even when its contacts are in the caller’s plain list', async () => {
      const { importId, payload } = await queued(CREATOR, PROGRAMME_A1, [['Name'], [`zqv${RUN}a`], [`zqv${RUN}b`]]);
      await (await importJobs()).processImportRun(deps(), payload);
      expect(await countImported(importId)).toBe(2);
      const own = await get(CREATOR, `/api/v1/contacts?importId=${enc(importId)}`);
      expect(((own.body as { data: Json[] }).data ?? []).length, 'the control: the creator sees them').toBe(2);
      const plain = await get(NO_RIGHT, `/api/v1/contacts?q=${enc(`zqv${RUN}`)}&limit=50`);
      expect(plain.status, plain.text).toBe(200);
      expect(((plain.body as { data: Json[] }).data ?? []).length, 'the control: the agent sees the contacts in the plain list').toBe(2);
      for (const [who, label] of [[NO_RIGHT, 'A1 agent'], [SIBLING, 'A2 importer'], [B_ADMIN, 'tenant B']] as const) {
        const response = await get(who, `/api/v1/contacts?importId=${enc(importId)}`);
        expect(response.status, `${label}: ${response.text}`).toBe(200);
        expect(response.body, `${label}: the filter answered rows`).toEqual({ data: [], nextCursor: null });
      }
    });
  });

  describe('I3. a forged upload never completes', { timeout: FLOW_TIMEOUT }, () => {
    it('an upload id the server did not open for the key: complete fails, no object appears, the job does not advance', async () => {
      const bytes = csv([['Name'], ['zqf']]);
      const upload = await createImport(CREATOR, PROGRAMME_A1, bytes);
      const etags = await putParts(upload.parts, bytes);
      const before = await jobRow(upload.importId);
      expectError(await post(CREATOR, importPath(upload.importId, '/complete'), { parts: etags, uploadId: before.upload_id }), 400, 'validation_failed', 'a body naming an upload id');
      await observer.query(`UPDATE import_job SET upload_id = 'forged-upload-id-zq' WHERE id = $1`, [upload.importId]);
      const response = await post(CREATOR, importPath(upload.importId, '/complete'), { parts: etags });
      expect(response.status, `complete with a forged stored upload id: ${response.text}`).toBeGreaterThanOrEqual(400);
      expect(response.text).not.toContain('forged-upload-id-zq');
      const after = await jobRow(upload.importId);
      expect(['reading_header', 'awaiting_mapping']).not.toContain(after.status);
      const object = await observer.query<{ status: string }>('SELECT status FROM stored_object WHERE id = $1', [after.stored_object_id]);
      expect(object.rows[0]?.status).not.toBe('uploaded');
      expect(await seaweed.listEntries(keyOf(after)), 'an object appeared at the key').toEqual([]);
      expect(await jobsFor(HEADER_QUEUE, upload.importId)).toEqual([]);
    });

    it('another import’s open upload (another tenant’s): complete fails, and that upload is untouched and still completes', async () => {
      const bytes = csv([['Name'], ['zqg']]);
      const mine = await createImport(CREATOR, PROGRAMME_A1, bytes);
      const theirs = await createImport(B_ADMIN, PROGRAMME_B1, bytes);
      const theirTags = await putParts(theirs.parts, bytes);
      const theirRow = await jobRow(theirs.importId);
      await observer.query('UPDATE import_job SET upload_id = $2 WHERE id = $1', [mine.importId, theirRow.upload_id]);
      const response = await post(CREATOR, importPath(mine.importId, '/complete'), { parts: theirTags });
      expect(response.status, `complete with B’s upload id: ${response.text}`).toBeGreaterThanOrEqual(400);
      const myRow = await jobRow(mine.importId);
      expect(await seaweed.listEntries(keyOf(myRow))).toEqual([]);
      expect(await seaweed.listEntries(keyOf(theirRow)), 'B’s upload was completed by A').toEqual([]);
      expect(await seaweed.listUploadDirectories()).toContain(theirRow.upload_id);
      const done = await post(B_ADMIN, importPath(theirs.importId, '/complete'), { parts: theirTags });
      expect(done.status, `B’s own complete: ${done.text}`).toBe(202);
      expect((await seaweed.listEntries(keyOf(theirRow))).length).toBe(1);
    });

    it('another importer of the same programme cannot complete, map or run the creator’s import, and does it no damage', async () => {
      await assign(TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1, 'admin');
      const bytes = csv([['Name'], ['zqh']]);
      const upload = await createImport(CREATOR, PROGRAMME_A1, bytes);
      const etags = await putParts(upload.parts, bytes);
      expectError(await post(NO_RIGHT, importPath(upload.importId, '/complete'), { parts: etags }), 403, 'not_permitted', 'complete by another importer');
      expectError(await post(NO_RIGHT, importPath(upload.importId, '/upload-urls'), { partNumbers: [1] }), 403, 'not_permitted', 'urls by another importer');
      const row = await jobRow(upload.importId);
      expect(row.status).toBe('awaiting_upload');
      expect(await seaweed.listUploadDirectories()).toContain(row.upload_id);
      expect((await post(CREATOR, importPath(upload.importId, '/complete'), { parts: etags })).status).toBe(202);
      await (await importJobs()).processImportHeader(deps(), (await onlyJob(HEADER_QUEUE, upload.importId)).data);
      const mapping = { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG' };
      expectError(await put(NO_RIGHT, importPath(upload.importId, '/mapping'), mapping), 403, 'not_permitted', 'mapping by another importer');
      expect((await put(CREATOR, importPath(upload.importId, '/mapping'), mapping)).status).toBe(200);
      expectError(await post(NO_RIGHT, importPath(upload.importId, '/run')), 403, 'not_permitted', 'run by another importer');
      expect(await jobsFor(RUN_QUEUE, upload.importId)).toEqual([]);
    });
  });

  describe('I4. raw SQL cannot re-point a job or its contacts', { timeout: FLOW_TIMEOUT }, () => {
    it('as the migrator: import_job cannot point at another tenant’s or programme’s stored_object (23503)', async () => {
      const job = (await createImport(CREATOR, PROGRAMME_A1, csv([['Name'], ['zqa']]))).importId;
      const own = await plantObject('a10000000001', TENANT_A, PROGRAMME_A1, USER_A_AGENT_1);
      const sibling = await plantObject('a20000000001', TENANT_A, PROGRAMME_A2, USER_A_AGENT_2);
      const foreign = await plantObject('b10000000001', TENANT_B, PROGRAMME_B1, USER_B_AGENT_1);
      const repoint = (objectId: string) => () => observer.query('UPDATE import_job SET stored_object_id = $2 WHERE id = $1', [job, objectId]);
      expect(await sqlState(repoint(foreign)), 'another tenant’s object').toBe('23503');
      expect(await sqlState(repoint(sibling)), 'another programme’s object').toBe('23503');
      expect(await sqlState(repoint(own)), 'the control: an object in the job’s own programme').toBe('ok');
    });

    it('as the migrator: contact.import_job_id cannot point at another tenant’s or programme’s job (23503)', async () => {
      const a1 = (await createImport(CREATOR, PROGRAMME_A1, csv([['Name'], ['zqa']]))).importId;
      const a2 = (await createImport(SUPERVISOR, PROGRAMME_A2, csv([['Name'], ['zqb']]))).importId;
      const b1 = (await createImport(B_ADMIN, PROGRAMME_B1, csv([['Name'], ['zqc']]))).importId;
      const contact = must(SEED_CONTACTS.find((c) => c.programmeId === PROGRAMME_A1), 'A1 contact').id;
      const link = (jobId: string) => () => observer.query('UPDATE contact SET import_job_id = $2 WHERE id = $1', [contact, jobId]);
      expect(await sqlState(link(b1)), 'another tenant’s job').toBe('23503');
      expect(await sqlState(link(a2)), 'another programme’s job').toBe('23503');
      expect(await sqlState(link(a1)), 'the control: a job in the contact’s programme').toBe('ok');
    });

    it('as kasuwa_app in a real session: no job for another creator or tenant, no re-pointing, no delete', async () => {
      const source = (await createImport(CREATOR, PROGRAMME_A1, csv([['Name'], ['zqa']]))).importId;
      const fresh = await plantObject('a10000000002', TENANT_A, PROGRAMME_A1, USER_A_AGENT_1);
      const foreignObject = await plantObject('b10000000002', TENANT_B, PROGRAMME_B1, USER_B_AGENT_1);
      // 'ok' only when the statement ran and the deliberate Rollback undid it.
      const asCreator = async (sql: string, values: unknown[]): Promise<string> => {
        try {
          await withTenantTransaction(appPool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
            await tx.query(sql, values);
            throw new Rollback('rolled back on purpose');
          });
          return 'committed';
        } catch (error) {
          if (error instanceof Rollback) return 'ok';
          return String((error as { code?: unknown }).code ?? `no code: ${(error as Error).name}`);
        }
      };
      const copy = `INSERT INTO import_job
                    SELECT (jsonb_populate_record(NULL::import_job, to_jsonb(j) || $2::jsonb)).*
                      FROM import_job j WHERE j.id = $1`;
      const as = (patch: Json) => [
        source,
        JSON.stringify({ id: id94('c00000000001'), stored_object_id: fresh, upload_id: `copy-upload-${RUN}`, ...patch }),
      ];
      expect(await asCreator(copy, as({})), 'the control: a copy as the creator themself').toBe('ok');
      expect(await asCreator(copy, as({ created_by_user_id: USER_A_SUPERVISOR })), 'a job that would run as the tenant admin').toBe('42501');
      expect(
        await asCreator(copy, as({ tenant_id: TENANT_B, programme_id: PROGRAMME_B1, stored_object_id: foreignObject })),
        'a job in tenant B',
      ).toBe('42501');
      for (const [column, value] of [
        ['created_by_user_id', USER_A_SUPERVISOR],
        ['stored_object_id', fresh],
        ['tenant_id', TENANT_B],
        ['programme_id', PROGRAMME_A2],
      ] as const) {
        expect(await asCreator(`UPDATE import_job SET ${column} = $2 WHERE id = $1`, [source, value]), `UPDATE ${column}`).toBe('42501');
      }
      expect(await asCreator('DELETE FROM import_job WHERE id = $1', [source]), 'DELETE').toBe('42501');
      expect((await jobRow(source)).status).toBe('awaiting_upload');
    });

    it('forced session variables: a tenant sees only its programmes’ jobs; a forged programme id from another tenant sees none', async () => {
      const a1 = (await createImport(CREATOR, PROGRAMME_A1, csv([['Name'], ['zqa']]))).importId;
      const a2 = (await createImport(SUPERVISOR, PROGRAMME_A2, csv([['Name'], ['zqb']]))).importId;
      const b1 = (await createImport(B_ADMIN, PROGRAMME_B1, csv([['Name'], ['zqc']]))).importId;
      const visible = (scope: { tenantId?: string; userId?: string; programmeIds?: string[] }) =>
        withForcedScope(appPool, scope, async (query) => (await query<{ id: string }>('SELECT id FROM import_job ORDER BY id')).map((r) => r.id));
      expect(await visible({ tenantId: TENANT_A, userId: USER_A_AGENT_1, programmeIds: [PROGRAMME_A1] })).toEqual([a1]);
      expect((await visible({ tenantId: TENANT_A, userId: USER_A_SUPERVISOR, programmeIds: [PROGRAMME_A1, PROGRAMME_A2] })).sort()).toEqual([a1, a2].sort());
      expect(await visible({ tenantId: TENANT_A, userId: USER_A_AGENT_1, programmeIds: [PROGRAMME_B1] })).toEqual([]);
      expect(await visible({ tenantId: TENANT_B, userId: USER_B_AGENT_1, programmeIds: [PROGRAMME_A1, PROGRAMME_B1] })).toEqual([b1]);
      expect(await visible({})).toEqual([]);
    });
  });

  describe('I5. forged queue payloads do nothing', { timeout: FLOW_TIMEOUT }, () => {
    it('run: another user, another tenant, a foreign user or an extra key creates nothing; the genuine payload then runs', async () => {
      const { importId, payload } = await queued(CREATOR, PROGRAMME_A1, [['Name'], [`zqp${RUN}a`], [`zqp${RUN}b`]]);
      expect(payload).toEqual({ tenantId: TENANT_A, userId: USER_A_AGENT_1, importId });
      const jobs = await importJobs();
      for (const [label, forged] of [
        ['the tenant admin instead of the creator', { tenantId: TENANT_A, userId: USER_A_SUPERVISOR, importId }],
        ['another tenant', { tenantId: TENANT_B, userId: USER_B_AGENT_1, importId }],
        ['a user of another tenant', { tenantId: TENANT_A, userId: USER_B_AGENT_1, importId }],
        ['an extra key', { tenantId: TENANT_A, userId: USER_A_AGENT_1, importId, programmeIds: [PROGRAMME_A1, PROGRAMME_A2] }],
      ] as const) {
        await jobs.processImportRun(deps(), forged).catch(() => undefined);
        expect(await countImported(importId), `${label}: contacts were created`).toBe(0);
        expect((await jobRow(importId)).status, `${label}: the job advanced`).toBe('queued');
      }
      await jobs.processImportRun(deps(), payload);
      expect(await countImported(importId), 'the control: the genuine payload').toBe(2);
    });

    it('header: a forged user reads no header; the genuine payload does', async () => {
      const importId = await completed(CREATOR, PROGRAMME_A1, csv([['Name', 'Mobile'], ['zqa', '0803 555 0101']]));
      const jobs = await importJobs();
      await jobs.processImportHeader(deps(), { tenantId: TENANT_A, userId: USER_A_SUPERVISOR, importId }).catch(() => undefined);
      expect((await jobRow(importId)).headers, 'a forged header job stored headers').toBeNull();
      await jobs.processImportHeader(deps(), (await onlyJob(HEADER_QUEUE, importId)).data);
      expect((await jobRow(importId)).headers, 'the control').toEqual(['Name', 'Mobile']);
    });

    it('retention: a forged user deletes nothing from a finished import long past due; the genuine payload erases it', async () => {
      const { importId, payload } = await queued(CREATOR, PROGRAMME_A1, [['Name'], ['zqr']]);
      const jobs = await importJobs();
      await jobs.processImportRun(deps(), payload);
      const row = await jobRow(importId);
      expect(row.status).toBe('finished');
      const far = () => new Date(Date.now() + 30 * DAY);
      for (const forged of [
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR, importId },
        { tenantId: TENANT_B, userId: USER_B_AGENT_1, importId },
        { tenantId: TENANT_A, userId: USER_A_AGENT_1, importId, force: true },
      ]) {
        await jobs.processImportRetention(deps(far), forged).catch(() => undefined);
        expect((await jobRow(importId)).filename, `${JSON.stringify(forged)} cleared the filename`).toBe(FILE);
        expect((await seaweed.listEntries(keyOf(row))).length, `${JSON.stringify(forged)} deleted the file`).toBe(1);
      }
      await jobs.processImportRetention(deps(far), payload);
      expect((await jobRow(importId)).filename, 'the control: the genuine payload erases').toBeNull();
      expect(await seaweed.listEntries(keyOf(row))).toEqual([]);
    });
  });

  describe('I6. bytes stay under the tenant’s own prefix', { timeout: FLOW_TIMEOUT }, () => {
    it('part URLs and the object name the import’s own tenant, programme and object id, never the filename or another tenant', async () => {
      const bytes = csv([['Name'], ['zqk']]);
      const upload = await createImport(CREATOR, PROGRAMME_A1, bytes);
      const row = await jobRow(upload.importId);
      for (const part of upload.parts) {
        const url = new URL(part.url);
        expect(url.origin).toBe(new URL(seaweed.endpoint).origin);
        expect(decodeURIComponent(url.pathname)).toContain(keyOf(row));
        expect(part.url).not.toContain(TENANT_B);
        expect(part.url).not.toContain(FILE);
      }
      const etags = await putParts(upload.parts, bytes);
      // D-L166 item 2: earlier tests leave their objects in the bucket (reseed
      // does not touch it), so only THIS import's own key is listed whole;
      // tenant A's prefix is compared before and after, which keeps "complete
      // wrote nowhere else" without depending on test order.
      const keysUnder = async (prefix: string) => (await seaweed.listEntries(prefix)).map((e) => e.key).sort();
      const beforeA = await keysUnder(`tenant/${TENANT_A}/`);
      expect(beforeA, 'an object sits at the key before complete').not.toContain(keyOf(row));
      const before = await seaweed.listEntries(`tenant/${TENANT_B}/`);
      expect((await post(CREATOR, importPath(upload.importId, '/complete'), { parts: etags })).status).toBe(202);
      expect((await seaweed.listEntries(keyOf(row))).map((e) => e.key)).toEqual([keyOf(row)]);
      const afterA = await keysUnder(`tenant/${TENANT_A}/`);
      expect(afterA.filter((key) => !beforeA.includes(key)), 'complete wrote somewhere but the import’s own key').toEqual([keyOf(row)]);
      expect(await seaweed.listEntries(`tenant/${TENANT_B}/`)).toEqual(before);
    });

    it('fromImportId naming another tenant’s or programme’s import is the never-existed 400 unknown_reference', async () => {
      const b1 = await mapped(B_ADMIN, PROGRAMME_B1, [['Name'], ['zqb']]);
      const a2 = await mapped(SUPERVISOR, PROGRAMME_A2, [['Name'], ['zqc']]);
      const mine = await completed(CREATOR, PROGRAMME_A1, csv([['Name'], ['zqd']]));
      await (await importJobs()).processImportHeader(deps(), (await onlyJob(HEADER_QUEUE, mine)).data);
      const attempt = (fromImportId: string) => put(CREATOR, importPath(mine, '/mapping'), { fromImportId, defaultCountry: 'NG' });
      const never = await attempt(NOWHERE);
      expectError(never, 400, 'validation_failed', 'fromImportId nowhere');
      expect((never.body as { details?: Json[] }).details).toEqual([{ path: 'fromImportId', code: 'unknown_reference' }]);
      for (const [id, label] of [[b1, 'tenant B'], [a2, 'programme A2']] as const) {
        const response = await attempt(id);
        expectError(response, 400, 'validation_failed', `fromImportId ${label}`);
        expect(response.body, `fromImportId ${label}`).toEqual(never.body);
      }
    });
  });

  describe('self-checks', () => {
    it('sqlState reports a SQLSTATE and "ok" (self-check)', async () => {
      expect(await sqlState(async () => Promise.reject(Object.assign(new Error('x'), { code: '23503' })))).toBe('23503');
      expect(await sqlState(async () => undefined)).toBe('ok');
    });

    it('csv() quotes what needs quoting (self-check)', () => {
      expect(csv([['a,b', 'c']]).toString('utf8')).toBe('"a,b",c\n');
    });

    it('a deliberate Rollback carries no SQLSTATE, so it cannot be mistaken for a refusal (self-check)', async () => {
      expect(await sqlState(async () => Promise.reject(new Rollback('r')))).toBe('no code');
    });
  });
});
