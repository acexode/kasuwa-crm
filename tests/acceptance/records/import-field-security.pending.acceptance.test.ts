import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import { createPool, PROGRAMME_A1, SEED_CONTACTS, TENANT_A, USER_A_AGENT_1 } from '@kasuwa/db';
import { reseed, startRedis, startSeaweedFs, type StartedRedis, type StartedSeaweedFs } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { asUser, withAuthDatabase } from '../support/api';

/**
 * ACCEPTANCE — T-0094 field security on the import path, through the API
 * (runImport's description; import-api's R12 and R17; D-L160 ruling 5;
 * D-L151, D-L167).
 *
 * PENDING (D-L169). `pnpm test:pending` runs it; the blocking gate does not.
 * These three tests moved here, unchanged in intent, from
 * tests/acceptance/records/import-api.acceptance.test.ts:
 *   - the mapping-time 403 `field_not_editable` for a field the importer may
 *     not edit;
 *   - R12, field security re-resolved at run time;
 *   - R17, a withheld field is never mapped and never matched on.
 * Each needs an importer whose field levels are HONOURED. The locked `admin`
 * set always has edit (P02/D, `LOCKED_FIELD_ACCESS_LEVEL`), and it is the only
 * set holding `contact.import`. So the importer here holds a CUSTOM, UNLOCKED
 * permission set granting `contact.import` and `contact.write` (D-L151;
 * runImport and every batch need both, D-L167), plus the field level under
 * test.
 *
 * WHY PENDING: custom permission sets cannot hold actions. Set grants are a
 * static allow-list keyed by set key (`SET_PERMITS`,
 * packages/permissions/src/policy.ts), and `permission_set` defines no grant
 * (0006). D-L169 makes custom-set grants their own permissions task: a grant
 * table, the actions a tenant may grant, and whether `contact.import` implies
 * `contact.write`.
 *
 * PROMOTION: when custom-set grants exist, implement `grantActions` below
 * against that mechanism (today it fails on purpose, naming this reason) and
 * rename the file to drop `.pending`. Nothing else should need to change.
 * The tests' first request (createImport, 201) proves that the set really
 * holds `contact.import`, so a 403 later cannot come from a missing right.
 *
 * Helpers are restated from import-api, never imported (the suites' house
 * rule). Fixtures: packages/db/src/fixtures.ts, plus a permission set and
 * custom fields the migrator plants with ids in this file's range
 * (`11111111-0094-4000-8200-...`). Reseed after every test.
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
/** Per test: each runs a whole flow (the project default is 30 s). */
const FLOW_TIMEOUT = 120_000;

const RUN = Date.now().toString(36);
const id94 = (tail: string) => `11111111-0094-4000-8200-${tail.padStart(12, '0')}`;
const FILE = `zqfls${RUN}.csv`;

/** The custom, unlocked permission set the importer holds in A1. */
const IMPORT_SET_ID = id94('5e7000000001');
const IMPORT_SET_KEY = 't0094_field_importer';
const SECRET_FIELD = id94('f00000000002');
const LATE_FIELD = id94('f00000000003');

/** Agent 1 holds the custom set in A1 (beforeEach) and nothing else: the importer. */
const IMPORTER = asUser(TENANT_A, USER_A_AGENT_1);

type Json = Record<string, unknown>;
type Headers = Record<string, string>;

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

const A1_FIRST = must(
  SEED_CONTACTS.find((c) => c.programmeId === PROGRAMME_A1),
  'an A1 contact',
);

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
interface RowError {
  row: number;
  column: number | null;
  code: string;
}
interface ImportBody {
  id: string;
  status: string;
  counts: { created: number; skipped: number; failed: number };
  errors: RowError[];
}

interface ImportJobDeps {
  pool: Pool;
  store: unknown;
  redisUrl: string;
}
type Processor = (deps: ImportJobDeps, payload: unknown) => Promise<unknown>;
interface ImportJobsModule {
  processImportHeader: Processor;
  processImportRun: Processor;
}

async function importJobs(): Promise<ImportJobsModule> {
  let loaded: Record<string, unknown>;
  try {
    loaded = { ...(await import(WORKER_JOBS_MODULE)) };
  } catch (error) {
    throw new Error(`apps/worker/src/import-jobs.ts cannot be loaded: ${String((error as Error).message).split('\n')[0]}`);
  }
  for (const name of ['processImportHeader', 'processImportRun']) {
    expect(typeof loaded[name], `apps/worker/src/import-jobs.ts does not export ${name}`).toBe('function');
  }
  return loaded as unknown as ImportJobsModule;
}

interface BullJob {
  name: string;
  data: unknown;
}
interface BullQueue {
  getJobs(types: string[], start?: number, end?: number): Promise<BullJob[]>;
  obliterate(options: { force: boolean }): Promise<void>;
  close(): Promise<void>;
}
type BullQueueClass = new (name: string, options: { connection: { host: string; port: number } }) => BullQueue;

const DATABASE_TEXT = ['Failing row contains', 'violates', 'constraint', '23503', '23505', '42501', 'import_job'];

interface Detail {
  path: string;
  code: string;
}
const detailsOf = (body: unknown): Detail[] => {
  const details = (body as Json | null)?.details;
  return Array.isArray(details) ? (details as Detail[]) : [];
};

function expectDetail(response: request.Response, status: number, code: string, detail: string, path: string, where: string): void {
  expect(response.status, `${where}: expected ${status} ${code}, got ${response.status} ${response.text}`).toBe(status);
  expect((response.body as Json).code, `${where}: Error.code`).toBe(code);
  for (const text of DATABASE_TEXT) expect(response.text, `${where}: the body carries database text`).not.toContain(text);
  const found = detailsOf(response.body).some((d) => d.code === detail && d.path === path);
  expect(found, `${where}: details ${JSON.stringify((response.body as Json).details)} lack ${detail} at ${path}`).toBe(true);
}

const errorKey = (e: RowError) => `${e.row}:${e.column === null ? 'null' : e.column}:${e.code}`;

describe('acceptance (pending, D-L169): field security on the import path, for an importer whose levels are honoured (T-0094)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants and observes; never serves. */
  let observer: Pool;
  /** kasuwa_app, for the processors: the role apps/worker runs as. */
  let workerPool: Pool;
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
    workerPool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    for (const queue of queues.values()) {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
    await workerPool?.end();
    await observer?.end();
    await redis?.stop();
    await seaweed?.stop();
    await reseed(inject('migrationUrl'));
  }, 120_000);

  beforeEach(async () => {
    // The importer's set: custom and UNLOCKED, so its field levels are honoured.
    await observer.query(
      `INSERT INTO permission_set (id, tenant_id, key, label, locked, sort_order)
       VALUES ($1, $2, $3, 'T-0094 field-security importer', false, 91)`,
      [IMPORT_SET_ID, TENANT_A, IMPORT_SET_KEY],
    );
    await grantActions(IMPORT_SET_ID, ['contact.import', 'contact.write']);
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id) DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [USER_A_AGENT_1, PROGRAMME_A1, TENANT_A, IMPORT_SET_ID],
    );
    // Custom fields on contact: secret__c (the set may only READ it), late__c
    // (the set may edit it; R12 lowers it to read after the mapping is saved).
    const objectRow = await observer.query<{ id: string }>(
      `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact'`,
      [TENANT_A],
    );
    const objectId = must(objectRow.rows[0]?.id, 'no contact object_def');
    for (const [id, apiName] of [[SECRET_FIELD, 'secret__c'], [LATE_FIELD, 'late__c']] as const) {
      await observer.query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
         VALUES ($1, $2, $3, $4, $5, 'text', 'none', true, '{}'::jsonb)`,
        [id, TENANT_A, objectId, apiName, `T-0094 ${apiName}`],
      );
    }
    await grant(SECRET_FIELD, 'read');
    await grant(LATE_FIELD, 'edit');
  }, 60_000);

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

  /**
   * Grants programme actions to a CUSTOM permission set. PENDING (D-L169):
   * there is no mechanism for it yet. Promotion implements this against the
   * grant mechanism the permissions task introduces; until then it fails
   * here, by name, rather than letting a test fail later for a reason that
   * looks like a build defect.
   */
  async function grantActions(setId: string, actions: readonly string[]): Promise<void> {
    throw new Error(
      `PENDING (D-L169): custom permission sets cannot hold actions, so ${actions.join(' and ')} cannot be granted ` +
        `to set ${setId}. Implement grantActions when custom-set grants exist, then drop ".pending".`,
    );
  }

  async function grant(fieldId: string, level: 'none' | 'read' | 'edit'): Promise<void> {
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, IMPORT_SET_ID, level],
    );
  }

  function deps(): ImportJobDeps {
    return { pool: workerPool, store, redisUrl: redis.url };
  }

  async function onlyJob(queueName: string, importId: string): Promise<BullJob> {
    const queue = must(queues.get(queueName), queueName);
    const found = (await queue.getJobs(JOB_STATES, 0, -1)).filter((job) => (job.data as Json | null)?.importId === importId);
    expect(found.length, `${queueName}: expected one job for the import, found ${found.length}`).toBe(1);
    return must(found[0], 'job');
  }

  /** Declare, PUT the parts, complete. createImport's 201 proves the set holds contact.import. */
  async function uploadAndComplete(bytes: Buffer): Promise<string> {
    const created = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename: FILE, sizeBytes: bytes.length, contentType: 'text/csv' });
    expect(created.status, `createImport by the custom-set importer: ${created.text}`).toBe(201);
    const upload = created.body as ImportUpload;
    const etags: { partNumber: number; etag: string }[] = [];
    let offset = 0;
    for (const part of [...upload.parts].sort((a, b) => a.partNumber - b.partNumber)) {
      const response = await fetch(part.url, { method: 'PUT', body: bytes.subarray(offset, offset + part.sizeBytes) });
      await response.arrayBuffer().catch(() => undefined);
      expect(response.status, `PUT part ${part.partNumber}`).toBe(200);
      etags.push({ partNumber: part.partNumber, etag: response.headers.get('etag') ?? '' });
      offset += part.sizeBytes;
    }
    const done = await post(IMPORTER, importPath(upload.importId, '/complete'), { parts: etags });
    expect(done.status, `completeImportUpload: ${done.text}`).toBe(202);
    return upload.importId;
  }

  async function readHeader(importId: string): Promise<void> {
    await (await importJobs()).processImportHeader(deps(), (await onlyJob(HEADER_QUEUE, importId)).data);
  }

  async function saveMapping(importId: string, body: Json): Promise<void> {
    const response = await put(IMPORTER, importPath(importId, '/mapping'), body);
    expect(response.status, `putImportMapping: ${response.text}`).toBe(200);
  }

  async function queueRun(importId: string): Promise<BullJob> {
    const response = await post(IMPORTER, importPath(importId, '/run'));
    expect(response.status, `runImport: ${response.text}`).toBe(202);
    return onlyJob(RUN_QUEUE, importId);
  }

  async function getImport(importId: string): Promise<ImportBody> {
    const response = await get(IMPORTER, importPath(importId));
    expect(response.status, `getImport: ${response.text}`).toBe(200);
    return response.body as ImportBody;
  }

  // =========================================================================

  it('the importer’s set is custom and unlocked, so its field levels are honoured (the premise of every test here)', async () => {
    const set = await observer.query<{ key: string; locked: boolean }>('SELECT key, locked FROM permission_set WHERE id = $1', [IMPORT_SET_ID]);
    expect(set.rows).toEqual([{ key: IMPORT_SET_KEY, locked: false }]);
  });

  it('a mapped field the creator may not edit is 403 field_not_editable at the field, never a column', { timeout: FLOW_TIMEOUT }, async () => {
    const importId = await uploadAndComplete(csv([['Name', 'Secret'], ['zqa', 'x']]));
    await readHeader(importId);
    const response = await put(IMPORTER, importPath(importId, '/mapping'), {
      columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'custom.secret__c' }],
      defaultCountry: 'NG',
    });
    expectDetail(response, 403, 'not_permitted', 'field_not_editable', 'custom.secret__c', 'withheld custom field');
  });

  it('a field withheld from the importer is never matched on: it cannot be mapped, and the readable field still dedupes (R17, D-L160 ruling 5)', { timeout: FLOW_TIMEOUT }, async () => {
    await observer.query(`UPDATE contact SET emails = '["withheld.seed@example.test"]'::jsonb WHERE id = $1`, [A1_FIRST.id]);
    const field = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f JOIN object_def o ON o.id = f.object_id
        WHERE f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = 'emails'`,
      [TENANT_A],
    );
    await grant(must(field.rows[0]?.id, 'contact.emails field_def'), 'none');
    const rows = [
      ['Name', 'Mobile', 'Email'],
      ['zqw2', `0${A1_FIRST.phoneE164.slice(4)}`, ''],
      ['zqw3', '0803 555 0177', 'withheld.seed@example.test'],
    ];
    const importId = await uploadAndComplete(csv(rows));
    await readHeader(importId);
    const withEmails = await put(IMPORTER, importPath(importId, '/mapping'), {
      columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }, { index: 2, field: 'emails' }],
      defaultCountry: 'NG',
    });
    expectDetail(withEmails, 403, 'not_permitted', 'field_not_editable', 'emails', 'mapping a withheld field');
    await saveMapping(importId, {
      columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }, { index: 2, field: null }],
      defaultCountry: 'NG',
    });
    const job = await queueRun(importId);
    await (await importJobs()).processImportRun(deps(), job.data);
    const body = await getImport(importId);
    // Row 2 matches on the readable phone; row 3's email sits in an
    // unmapped column and matches a withheld field, so it is created.
    expect(body.errors.map(errorKey)).toEqual(['2:null:possible_duplicate']);
    expect(body.counts).toEqual({ created: 1, skipped: 1, failed: 0 });
  });

  it('field security is re-resolved at run: a field made read-only after mapping is field_not_editable per row, never written (R12)', { timeout: FLOW_TIMEOUT }, async () => {
    const importId = await uploadAndComplete(csv([['Name', 'Late'], ['zqf2', 'v'], ['zqf3', '']]));
    await readHeader(importId);
    await saveMapping(importId, { columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'custom.late__c' }], defaultCountry: 'NG' });
    const job = await queueRun(importId);
    await grant(LATE_FIELD, 'read');
    await (await importJobs()).processImportRun(deps(), job.data);
    const body = await getImport(importId);
    expect(body.errors.map(errorKey)).toEqual(['2:1:field_not_editable']);
    const written = await observer.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM contact WHERE import_job_id = $1 AND custom ? 'late__c'`,
      [importId],
    );
    expect(written.rows[0]?.n).toBe('0');
  });
});
