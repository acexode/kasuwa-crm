import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed, startRedis, startSeaweedFs, type StartedRedis, type StartedSeaweedFs } from '@kasuwa/testing';
import pg, { type Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0094, the import API and job, run as the initiating user
 * (migration; ADR-0017 flow steps 1-7; D-L128 Q4-Q7, D-L146, D-L148, D-L150,
 * D-L151, D-L155, D-L158; D-P12, D-P14, D-P28, D-P33; CLAUDE.md 2.1-2.3, 6.1,
 * 6.4, 6.7). Agent 3 builds it. Written by QA for the lead before the build
 * (D-L23, D-L25), from the T-0093 contract and the decisions, not from an
 * implementation. Its adversarial twin is
 * tests/acceptance/tenancy/import-isolation.acceptance.test.ts; helpers are
 * restated there, never imported.
 *
 * It runs against REAL Postgres (global setup), REAL SeaweedFS
 * (`startSeaweedFs`) and REAL Redis (`startRedis`, added to @kasuwa/testing
 * with this suite). The API is booted in process; the worker's job PROCESSORS
 * are called directly with the payload the API actually put on the queue, so
 * nothing waits on a timer and nothing polls.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder honours these exactly)
 * ==========================================================================
 *
 * A. BOOT. `AppModule.forRoot` accepts two more options, both optional so
 *    every existing suite still boots without them:
 *      redisUrl: string        where the API enqueues import jobs (BullMQ)
 *      objectStore: ObjectStore the store the API presigns, completes and
 *                               heads through (main.ts passes an
 *                               S3ObjectStore built from storageEnv)
 *
 * B. QUEUES (BullMQ, one Redis). Exactly these names:
 *      kasuwa.import.header     enqueued by completeImportUpload (202)
 *      kasuwa.import.run        enqueued by runImport (202)
 *      kasuwa.import.retention  DELAYED: by createImport (24 hours), and at
 *                               every end of a job that the API or the run
 *                               reaches (finished, rejected at complete,
 *                               cancelled by abort): 7 days
 *    Every payload is exactly `{ tenantId, userId, importId }` (ids only,
 *    Zod-parsed by the processor), where userId is the import's
 *    createdByUserId. No filename, header, mapping, cell, URL or key ever
 *    reaches Redis, in data or in options.
 *
 * C. PROCESSORS. `apps/worker/src/import-jobs.ts` exports
 *      processImportHeader(deps, payload): Promise<unknown>
 *      processImportRun(deps, payload): Promise<unknown>
 *      processImportRetention(deps, payload): Promise<unknown>
 *    with deps `{ pool, store, redisUrl, now? }`: a kasuwa_app pool, the
 *    ObjectStore, Redis for the jobs it enqueues itself, and an optional clock
 *    (`() => Date`, default the real one) that retention uses to decide
 *    whether the job is due. apps/worker/src/main.ts registers one BullMQ
 *    Worker per queue calling these. Importing the module starts nothing.
 *
 * D. TABLE `import_job` (one migration file creates it; the number is
 *    assigned in merge order, D-L146). Columns this suite names:
 *      id, tenant_id, programme_id, stored_object_id, created_by_user_id,
 *      status, upload_id (text), filename, headers, mapping,
 *      raw_file_deleted_at
 *    everything else (counts, errors, timestamps) is the builder's. RLS
 *    ENABLED and FORCED; a permissive policy naming app.current_tenant_id()
 *    and app.current_programme_ids() whose WITH CHECK equals its USING; in
 *    TENANT_SCOPED_TABLES. FKs, each carrying tenant_id:
 *      (tenant_id, programme_id, stored_object_id) -> stored_object
 *      (tenant_id, created_by_user_id)             -> "user"
 *    stored_object_id is UNIQUE. kasuwa_app: SELECT and INSERT, UPDATE on
 *    neither id, tenant_id, programme_id, stored_object_id,
 *    created_by_user_id nor created_at, and no DELETE or TRUNCATE (nor any
 *    role it can enter); kasuwa_auth: nothing.
 *    `contact.import_job_id uuid NULL`, no default, with an FK
 *      (tenant_id, programme_id, import_job_id) -> import_job
 *    Still exactly two SECURITY DEFINER functions (CLAUDE.md 2.7).
 *
 * E. PERMISSIONS. `contact.import` is a PROGRAMME_ACTION; every permission
 *    set granting it also grants `contact.write` (D-L151); `admin` grants it;
 *    `agent`, `team_lead`, `programme_manager` and `qa_analyst` do not.
 *
 * F. THE CONTRACT. The nine import operations and listContacts' `importId`
 *    are `x-kasuwa-implemented: true` once served (a LEAD EDIT to the T-0093
 *    suite's R1, which pins false today). The duplicates and merge
 *    operations stay false (T-0095).
 *
 * ==========================================================================
 * RULINGS where the task, the contract or the decisions are silent
 * (this suite's; the lead may reverse them)
 * ==========================================================================
 *
 * R1  Part plan. createImport takes no part count, so the server plans it:
 *     min(4, ceil(sizeBytes / 5 MiB)) parts, sized as the adapter's
 *     `planParts` sizes them. The contract's own example (12 MiB, parts of
 *     5, 5 and 2 MiB) is exactly this rule. Without a pinned plan a server
 *     could always use one part, and resume (upload-urls) and the
 *     missing-part mismatch would be untestable.
 * R2  Resume. Re-issued URLs belong to the SAME multipart upload: a part sent
 *     on an original URL and parts sent on re-issued ones complete together,
 *     and import_job.upload_id does not change. (StoredObjectRepository.
 *     presignUpload aborts the open upload, D-L158; T-0094 must not use it to
 *     re-issue.)
 * R3  The upload id (D-L155). It is stored on the job at createImport, is the
 *     upload the bucket holds open for the object's key, is never in an
 *     answer, and complete uses the STORED id (a body naming one is 400; a
 *     tampered stored id fails complete: the isolation suite).
 * R4  Reads. getImport and listImports need `contact.import` in the import's
 *     programme and are NOT creator-only: another holder of the right reads
 *     the job. A programme member without the right gets 404 on every
 *     operation with an import id (the ImportId parameter's rule), and 403
 *     only on createImport.
 * R5  Batches run one after another, each holding at most 1,000 rows (the
 *     task's "for example 500"), so scope and the right are re-checked at
 *     least every 1,000 rows and no batch is a long transaction.
 * R6  A creator who loses the programme or `contact.import` while the job is
 *     queued or running ends it `failed`, with counts equal to the contacts
 *     committed so far, and nothing is created afterwards. Losing the
 *     programme leaves the creator unable to see the row, so the move to
 *     `failed` cannot be written by the job as the creator: 0031's pattern (a
 *     trigger on user_programme) is one way that needs no new identity.
 *     Escalated with this suite.
 * R7  too_many_rows. A file may hold 100,000 DATA rows (spreadsheet rows 2
 *     to 100,001), all imported; the first row past them, spreadsheet row
 *     100,002, is the single `too_many_rows` error and is not imported.
 *     CONTRACT DEFECT, reported: ImportRowError.row has `maximum: 100001`,
 *     which cannot hold 100,002 (and counts.created's maximum of 100,000
 *     rules out the reading in which the header counts as a row). The test
 *     that observes it does not validate that one body against the schema.
 *     Its status (finished or failed) is the builder's.
 * R8  Grant spellings (D-P28, D-L148). Whatever spellings of a boolean or a
 *     consent state the parser accepts, no import ever produces a contact
 *     with whatsapp_opt_in true or consent_state opted_in or pending; such a
 *     row is not created, and its error is consent_grant_refused (or
 *     invalid_value for a spelling the parser refuses). `true` and `false`
 *     are the boolean spellings the suite relies on.
 * R9  `importId` on listContacts for an import the caller cannot see (another
 *     tenant, another programme, OR the same programme without
 *     `contact.import`) is an empty page, even when the contacts it created
 *     are visible to the caller in the plain list (the contract: "an import
 *     the caller cannot see ... answers an empty page").
 * R10 Run as the creator, observably: every created contact has exactly one
 *     `created` contact audit event whose actor is the creator (actor_kind
 *     user), never the system, and is owned by the mapping's ownerUserId.
 * R11 A row over 65,536 bytes is a ROW error: later rows are still read and
 *     imported. A row under the limit is not refused for its size.
 * R12 Field security is re-resolved at run time (runImport's description):
 *     a mapped field that became non-editable after the mapping was saved is
 *     the row error `field_not_editable` at its column for every row that
 *     carries a value there, and no contact gets a value for it.
 * R13 Retention is decided from the ROW and the clock, not from the queue's
 *     timing alone: a retention job that runs early (the 24-hour job of an
 *     import that has since finished, a retry) changes nothing. Due, it
 *     deletes the object, moves stored_object to `deleted`, sets
 *     raw_file_deleted_at and clears headers, filename and mapping (D-L148,
 *     D-L150) while counts and errors remain; an abandoned upload is aborted
 *     and the job becomes `expired`. It audits `deleted` on stored_object
 *     with the creator as actor. A second run is a no-op.
 * R14 The lifecycle tag `kasuwa-purpose=import` (D-L146) is on the completed
 *     object, as the bucket reports it.
 * R15 Duplicates: an exact E.164 phone (after normalisation) or a
 *     lower-cased email, within the import's programme only, against the
 *     programme's existing contacts AND the rows the file has already
 *     created. Never across programmes, whoever runs it. A skipped row is
 *     `{ row, column: null, code: possible_duplicate }`; nothing is merged or
 *     changed on the matched contact.
 * R16 Phone normalisation for NG, GH, KE and ZA: the trunk `0` of a national
 *     number is dropped and the default country's code prefixed; a `+`
 *     number keeps its own country whatever the default.
 *
 * ==========================================================================
 * D-L23: on this branch there is no import_job, no route, no queue and no
 * apps/worker/src/import-jobs.ts. Every test except those titled
 * "(self-check)" begins with a request, a table read or a module load that
 * needs the build, and fails there with that reason.
 *
 * Fixtures: packages/db/src/fixtures.ts (never a second set), plus rows the
 * migrator plants with ids in this suite's range
 * (`11111111-0094-4000-8000-...`). Every planted value is synthetic. Writes:
 * reseed after every test. Objects and queues live in containers this file
 * starts and stops.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = resolve(REPO_ROOT, 'docs/api/records.openapi.yaml');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');
const WORKER_JOBS_MODULE = resolve(REPO_ROOT, 'apps/worker/src/import-jobs.ts');
const ADAPTER_MODULE = '@kasuwa/storage-adapter';
const CONFIG_MODULE = '@kasuwa/config';
const PERMISSIONS_MODULE = '@kasuwa/permissions';

const HEADER_QUEUE = 'kasuwa.import.header';
const RUN_QUEUE = 'kasuwa.import.run';
const RETENTION_QUEUE = 'kasuwa.import.retention';
const QUEUES = [HEADER_QUEUE, RUN_QUEUE, RETENTION_QUEUE] as const;

const MiB = 1024 * 1024;
const MAX_FILE = 25 * MiB;
const MIN_PART = 5 * MiB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Tolerance on a retention delay: the builder may compute it from a timestamp it read earlier. */
const DELAY_SLACK = 5 * MINUTE;
/** T-0084's page budget, applied to every statement of the duplicate scan. */
const PAGE_BUDGET_MS = 150;
/** The whole run of a 20-row file against a 120k-contact tenant. Generous: it catches a scan per row. */
const RUN_BUDGET_MS = 60_000;
/** Per test, for the describes whose tests run whole flows (the project default is 30 s). */
const FLOW_TIMEOUT = 120_000;

const RUN = Date.now().toString(36);
const id94 = (tail: string) => `11111111-0094-4000-8000-${tail.padStart(12, '0')}`;
const NOWHERE = id94('dead00000001');

/** File content markers. None may ever appear in a log, audit row, job row, queue or error. */
const CELL = `zqcell${RUN}`;
const HEAD = `ZqHead${RUN}`;
const FILE = `zqfile${RUN}-customers.csv`;

const IMPORTER = asUser(TENANT_A, USER_A_AGENT_1);
const OTHER = asUser(TENANT_A, USER_A_AGENT_2);
const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_SET = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const B_ADMIN = asUser(TENANT_B, USER_B_AGENT_1);

type Json = Record<string, unknown>;
type Headers = Record<string, string>;

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function permissionSet(key: string): string {
  return must(
    SEED_PERMISSION_SETS.find((set) => set.tenantId === TENANT_A && set.key === key),
    `no seeded permission set '${key}'`,
  ).id;
}

const seeded = (programmeId: string) => SEED_CONTACTS.filter((c) => c.programmeId === programmeId);
const A1_FIRST = must(seeded(PROGRAMME_A1)[0], 'an A1 contact');
const A2_FIRST = must(seeded(PROGRAMME_A2)[0], 'an A2 contact');
const A2_SECOND = must(seeded(PROGRAMME_A2)[1], 'a second A2 contact');

// ---------------------------------------------------------------------------
// CSV and bytes.
// ---------------------------------------------------------------------------

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** RFC 4180 text, LF line ends, a trailing newline. */
function csv(rows: readonly (readonly string[])[], options: { bom?: boolean } = {}): Buffer {
  const text = rows.map((row) => row.map(cell).join(',')).join('\n') + '\n';
  return Buffer.from((options.bom === true ? '﻿' : '') + text, 'utf8');
}

/** Filler of an exact size that is not a CSV anyone will parse (the upload tests never run it). */
function filler(size: number): Buffer {
  const out = Buffer.alloc(size, 0x61);
  out.write('Name\n', 0, 'utf8');
  return out;
}

// ---------------------------------------------------------------------------
// The JSON-Schema checker over the records contract (restated).
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS: Record<string, RegExp> = {
  uuid: UUID,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  uri: /^https?:\/\/\S+$/,
};

const docCache = new Map<string, unknown>();
function loadDoc(file: string): unknown {
  let doc = docCache.get(file);
  if (doc === undefined) {
    doc = parse(readFileSync(file, 'utf8')) as unknown;
    docCache.set(file, doc);
  }
  return doc;
}

function atPointer(doc: unknown, fragment: string): unknown {
  let node = doc;
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    if (raw === '') continue;
    node = (node as Json | undefined)?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (node === undefined) throw new Error(`schema pointer #${fragment} resolves to nothing`);
  return node;
}

function deref(schema: Json, file: string): { schema: Json; file: string } {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return { schema, file };
  const [relative, fragment = ''] = ref.split('#');
  const target = relative === undefined || relative === '' ? file : resolve(dirname(file), relative);
  return deref(atPointer(loadDoc(target), fragment) as Json, target);
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function check(input: Json, file: string, value: unknown, path: string, errors: string[]): void {
  const { schema, file: at } = deref(input, file);
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf as Json[]) check(part, at, value, path, errors);
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Json[]).filter((branch) => {
      const e: string[] = [];
      check(branch, at, value, path, e);
      return e.length === 0;
    });
    if (passing.length !== 1) errors.push(`${path}: matches ${passing.length} oneOf branches`);
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = (schema.anyOf as Json[]).some((branch) => {
      const e: string[] = [];
      check(branch, at, value, path, e);
      return e.length === 0;
    });
    if (!ok) errors.push(`${path}: matches no anyOf branch`);
  }
  if ('const' in schema && schema.const !== value) errors.push(`${path}: not the const`);
  const actual = jsonType(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!(allowed.includes(actual) || (actual === 'integer' && allowed.includes('number')))) {
      errors.push(`${path}: type ${actual}, schema allows ${allowed.join('|')}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path}: not in enum`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) errors.push(`${path}: too short`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) errors.push(`${path}: too long`);
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format !== undefined && !format.test(value)) errors.push(`${path}: not a ${String(schema.format)}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.items !== undefined && typeof schema.items === 'object') {
      value.forEach((item, index) => check(schema.items as Json, at, item, `${path}[${index}]`, errors));
    }
  }
  if (actual === 'object') {
    const object = value as Json;
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) errors.push(`${path}: required property "${key}" is missing`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) check(childSchema, at, child, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: property "${key}" is not allowed`);
    }
  }
}

function schemaErrors(ref: string, value: unknown): string[] {
  const errors: string[] = [];
  check({ $ref: `#/components/schemas/${ref}` }, SPEC_PATH, value, ref, errors);
  return errors;
}

function expectSchema(ref: string, value: unknown, where: string): void {
  expect(schemaErrors(ref, value), `${where}: not a valid ${ref}`).toEqual([]);
}

function operations(): Map<string, Json> {
  const out = new Map<string, Json>();
  const paths = ((loadDoc(SPEC_PATH) as Json).paths ?? {}) as Record<string, Json>;
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item)) {
      if (typeof op === 'object' && op !== null && typeof (op as Json).operationId === 'string') {
        out.set((op as Json).operationId as string, op as Json);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statement recording (pg.Client.prototype.query wrapped; `pg` is one install).
// ---------------------------------------------------------------------------

type QueryFn = (this: unknown, ...args: unknown[]) => unknown;
const clientPrototype = pg.Client.prototype as unknown as { query: QueryFn };
const originalQuery = clientPrototype.query;

interface Recorded {
  text: string;
  values: unknown[];
}

function statementText(args: unknown[]): string {
  const [first] = args;
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null) return String((first as { text?: unknown }).text ?? '');
  return '';
}

function statementValues(args: unknown[]): unknown[] {
  const [first, second] = args;
  if (Array.isArray(second)) return second;
  if (typeof first === 'object' && first !== null) {
    const values = (first as { values?: unknown }).values;
    if (Array.isArray(values)) return values;
  }
  return [];
}

async function recordStatements(work: () => Promise<void>): Promise<Recorded[]> {
  const sink: Recorded[] = [];
  clientPrototype.query = function recordingQuery(this: unknown, ...args: unknown[]) {
    sink.push({ text: statementText(args), values: statementValues(args) });
    return originalQuery.apply(this, args);
  };
  try {
    await work();
  } finally {
    clientPrototype.query = originalQuery;
  }
  return sink;
}

// ---------------------------------------------------------------------------
// Log capture: every channel the process can write to (the T-0036 approach).
// ---------------------------------------------------------------------------

let captureLines: string[] | null = null;

function render(value: unknown): string {
  return typeof value === 'string' ? value : inspect(value, { depth: 12, breakLength: Number.POSITIVE_INFINITY });
}

class RecordingLogger extends ConsoleLogger {
  private record(args: unknown[]): void {
    captureLines?.push(args.map(render).join(' '));
  }
  override log(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override error(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override warn(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override debug(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override verbose(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override fatal(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
}

async function captureEverything(work: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  captureLines = lines;
  const toLines = (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
    for (const line of text.split('\n')) if (line !== '') lines.push(line);
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      toLines(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      toLines(chunk);
      return true;
    }),
    ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(render).join(' '));
      }),
    ),
  ];
  let telemetry: { spans: unknown[]; logs: unknown[] };
  try {
    telemetry = await collectTelemetry(work);
  } finally {
    for (const spy of spies) spy.mockRestore();
    captureLines = null;
  }
  return [...lines, ...telemetry.logs.map(render), ...telemetry.spans.map(render)];
}

// ---------------------------------------------------------------------------
// The worker's processors and BullMQ (the worker's own install).
// ---------------------------------------------------------------------------

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
    throw new Error(`apps/worker/src/import-jobs.ts cannot be loaded (pinned C): ${String((error as Error).message).split('\n')[0]}`);
  }
  for (const name of ['processImportHeader', 'processImportRun', 'processImportRetention']) {
    expect(typeof loaded[name], `apps/worker/src/import-jobs.ts does not export ${name} (pinned C)`).toBe('function');
  }
  return loaded as unknown as ImportJobsModule;
}

interface BullJob {
  id?: string | undefined;
  name: string;
  data: unknown;
  opts: { delay?: number | undefined } & Record<string, unknown>;
  timestamp: number;
}
interface BullQueue {
  getJobs(types: string[], start?: number, end?: number): Promise<BullJob[]>;
  obliterate(options: { force: boolean }): Promise<void>;
  close(): Promise<void>;
}
type BullQueueClass = new (name: string, options: { connection: { host: string; port: number } }) => BullQueue;

function bullQueueClass(): BullQueueClass {
  // The worker owns BullMQ; borrowing its install means the suite reads Redis
  // with exactly the client version the worker writes with.
  const workerRequire = createRequire(resolve(REPO_ROOT, 'apps/worker/package.json'));
  return (workerRequire('bullmq') as { Queue: BullQueueClass }).Queue;
}

const JOB_STATES = ['waiting', 'delayed', 'paused', 'prioritized', 'active', 'completed', 'failed'];

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

interface Detail {
  path: string;
  code: string;
}
const detailsOf = (body: unknown): Detail[] => {
  const details = (body as Json | null)?.details;
  return Array.isArray(details) ? (details as Detail[]) : [];
};

const DATABASE_TEXT = ['Failing row contains', 'violates', 'constraint', '23503', '23505', '42501', 'import_job'];

function expectError(response: request.Response, status: number, code: string, where: string): Json {
  expect(response.status, `${where}: expected ${status} ${code}, got ${response.status} ${response.text}`).toBe(status);
  const body = response.body as Json;
  expect(body.code, `${where}: Error.code`).toBe(code);
  for (const text of DATABASE_TEXT) expect(response.text, `${where}: the body carries database text`).not.toContain(text);
  for (const d of detailsOf(body)) {
    expect(Object.keys(d).sort(), `${where}: a detail carries more than path and code`).toEqual(['code', 'path']);
  }
  return body;
}

function expectDetail(response: request.Response, status: number, code: string, detail: string, path: string, where: string): Json {
  const body = expectError(response, status, code, where);
  const found = detailsOf(body).some((d) => d.code === detail && d.path === path);
  expect(found, `${where}: details ${JSON.stringify(body.details)} lack ${detail} at ${path}`).toBe(true);
  return body;
}

function expectNoStore(response: request.Response, where: string): void {
  expect(String(response.headers['cache-control'] ?? ''), `${where}: Cache-Control`).toMatch(/no-store/);
}

interface UploadPart {
  partNumber: number;
  url: string;
  sizeBytes: number;
}
interface ImportUpload {
  importId: string;
  parts: UploadPart[];
  expiresAt: string;
}
interface RowError {
  row: number;
  column: number | null;
  code: string;
}
interface ImportBody {
  id: string;
  programmeId: string;
  status: string;
  filename: string | null;
  headers: string[] | null;
  mapping: Json | null;
  suggestedMapping: Json[] | null;
  counts: { created: number; skipped: number; failed: number };
  errors: RowError[];
  errorsTruncated: boolean;
  rawFileDeletedAt: string | null;
  createdByUserId: string;
  createdAt: string;
  finishedAt: string | null;
}

interface JobRow {
  id: string;
  tenant_id: string;
  programme_id: string;
  stored_object_id: string;
  created_by_user_id: string;
  status: string;
  upload_id: string | null;
  filename: string | null;
  headers: unknown;
  mapping: unknown;
  raw_file_deleted_at: Date | null;
}

// ===========================================================================

describe('acceptance: the import API and job (T-0094)', () => {
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
    const Queue = bullQueueClass();
    for (const name of QUEUES) queues.set(name, new Queue(name, { connection: { host: redis.host, port: redis.port } }));
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(
          withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5, redisUrl: redis.url, objectStore: store }),
        ),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    workerPool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  }, 240_000);

  afterAll(async () => {
    clientPrototype.query = originalQuery;
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
    // IMPORTER: Agent 1 holds `admin` (and so `contact.import`) in A1 only,
    // and is NOT a tenant admin. That is what makes "creator only" and
    // "cancel: creator or tenant admin" observable.
    await assign(USER_A_AGENT_1, PROGRAMME_A1, 'admin');
    // AGENT_SET: a member of A1 holding `agent`, which lacks contact.import.
    await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'agent');
    // Custom fields on contact: tier__c (picklist, no grants: editable),
    // secret__c (text, admin set may only READ), late__c (text, admin set may
    // edit; a test lowers it to read after the mapping is saved).
    const objectRow = await observer.query<{ id: string }>(
      `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact'`,
      [TENANT_A],
    );
    const objectId = must(objectRow.rows[0]?.id, 'no contact object_def');
    const fields: [string, string, string, Json][] = [
      [id94('f00000000001'), 'tier__c', 'picklist', { values: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }] }],
      [id94('f00000000002'), 'secret__c', 'text', {}],
      [id94('f00000000003'), 'late__c', 'text', {}],
    ];
    for (const [id, apiName, type, fieldConfig] of fields) {
      await observer.query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
         VALUES ($1, $2, $3, $4, $5, $6, 'none', true, $7::jsonb)`,
        [id, TENANT_A, objectId, apiName, `T-0094 ${apiName}`, type, JSON.stringify(fieldConfig)],
      );
    }
    await grant(id94('f00000000002'), 'admin', 'read');
    await grant(id94('f00000000003'), 'admin', 'edit');
  }, 60_000);

  afterEach(async () => {
    clientPrototype.query = originalQuery;
    await reseed(inject('migrationUrl'));
  }, 120_000);

  // -------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------

  const server = () => app.getHttpServer();
  const enc = encodeURIComponent;
  const post = (headers: Headers, path: string, body?: unknown) => {
    const call = request(server()).post(path).set(headers);
    return body === undefined ? call : call.set('Content-Type', 'application/json').send(JSON.stringify(body));
  };
  const put = (headers: Headers, path: string, body: unknown) =>
    request(server()).put(path).set(headers).set('Content-Type', 'application/json').send(JSON.stringify(body));
  const get = (headers: Headers, path: string) => request(server()).get(path).set(headers);
  const importPath = (id: string, tail = '') => `/api/v1/imports/${enc(id)}${tail}`;

  async function assign(userId: string, programmeId: string, key: string): Promise<void> {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id) DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSet(key)],
    );
  }

  async function grant(fieldId: string, setKey: string, level: 'none' | 'read' | 'edit'): Promise<void> {
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(setKey), level],
    );
  }

  async function jobRow(importId: string): Promise<JobRow> {
    const rows = await observer.query<JobRow>(
      `SELECT id, tenant_id, programme_id, stored_object_id, created_by_user_id, status, upload_id,
              filename, headers, mapping, raw_file_deleted_at
         FROM import_job WHERE id = $1`,
      [importId],
    );
    return must(rows.rows[0], `import_job ${importId}`);
  }

  async function storedObject(id: string): Promise<{ status: string; programme_id: string; declared_size_bytes: string }> {
    const rows = await observer.query<{ status: string; programme_id: string; declared_size_bytes: string }>(
      'SELECT status, programme_id, declared_size_bytes::text FROM stored_object WHERE id = $1',
      [id],
    );
    return must(rows.rows[0], `stored_object ${id}`);
  }

  const keyOf = (job: JobRow) => `tenant/${job.tenant_id}/programme/${job.programme_id}/import/${job.stored_object_id}`;

  function deps(now?: () => Date): ImportJobDeps {
    return { pool: workerPool, store, redisUrl: redis.url, ...(now === undefined ? {} : { now }) };
  }

  async function jobsFor(queueName: string, importId: string): Promise<BullJob[]> {
    const queue = must(queues.get(queueName), queueName);
    const all = await queue.getJobs(JOB_STATES, 0, -1);
    return all.filter((job) => (job.data as Json | null)?.importId === importId);
  }

  async function onlyJob(queueName: string, importId: string): Promise<BullJob> {
    const found = await jobsFor(queueName, importId);
    expect(found.length, `${queueName}: expected one job for the import, found ${found.length}`).toBe(1);
    return must(found[0], 'job');
  }

  async function retentionJobWithDelay(importId: string, delay: number): Promise<BullJob> {
    const found = await jobsFor(RETENTION_QUEUE, importId);
    const match = found.find((job) => Math.abs((job.opts.delay ?? -1) - delay) <= DELAY_SLACK);
    expect(
      match,
      `${RETENTION_QUEUE}: no job delayed ${delay} ms (± ${DELAY_SLACK}); found delays ${JSON.stringify(found.map((j) => j.opts.delay))}`,
    ).toBeDefined();
    return must(match, 'retention job');
  }

  async function createImport(headers: Headers, programmeId: string, bytes: Buffer, filename = FILE, contentType = 'text/csv') {
    const response = await post(headers, '/api/v1/imports', { programmeId, filename, sizeBytes: bytes.length, contentType });
    expect(response.status, `createImport: ${response.text}`).toBe(201);
    return response.body as ImportUpload;
  }

  /** PUT parts to their presigned URLs, as a browser would. `only` limits which part numbers are sent. */
  async function putParts(parts: readonly UploadPart[], bytes: Buffer, only?: readonly number[]) {
    const offsets = new Map<number, number>();
    let offset = 0;
    for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
      offsets.set(part.partNumber, offset);
      offset += part.sizeBytes;
    }
    const etags: { partNumber: number; etag: string }[] = [];
    for (const part of parts) {
      if (only !== undefined && !only.includes(part.partNumber)) continue;
      const start = must(offsets.get(part.partNumber), 'offset');
      const response = await fetch(part.url, { method: 'PUT', body: bytes.subarray(start, start + part.sizeBytes) });
      await response.arrayBuffer().catch(() => undefined);
      expect(response.status, `PUT part ${part.partNumber}`).toBe(200);
      etags.push({ partNumber: part.partNumber, etag: response.headers.get('etag') ?? '' });
    }
    return etags;
  }

  async function uploadAndComplete(headers: Headers, programmeId: string, bytes: Buffer, filename = FILE) {
    const upload = await createImport(headers, programmeId, bytes, filename);
    const etags = await putParts(upload.parts, bytes);
    const done = await post(headers, importPath(upload.importId, '/complete'), { parts: etags });
    expect(done.status, `completeImportUpload: ${done.text}`).toBe(202);
    return upload.importId;
  }

  async function readHeader(importId: string): Promise<void> {
    const job = await onlyJob(HEADER_QUEUE, importId);
    await (await importJobs()).processImportHeader(deps(), job.data);
  }

  async function getImport(headers: Headers, importId: string): Promise<ImportBody> {
    const response = await get(headers, importPath(importId));
    expect(response.status, `getImport: ${response.text}`).toBe(200);
    return response.body as ImportBody;
  }

  async function saveMapping(headers: Headers, importId: string, body: Json): Promise<void> {
    const response = await put(headers, importPath(importId, '/mapping'), body);
    expect(response.status, `putImportMapping: ${response.text}`).toBe(200);
  }

  async function queueRun(headers: Headers, importId: string): Promise<BullJob> {
    const response = await post(headers, importPath(importId, '/run'));
    expect(response.status, `runImport: ${response.text}`).toBe(202);
    return onlyJob(RUN_QUEUE, importId);
  }

  interface ImportOptions {
    headers?: Headers;
    programmeId?: string;
    defaultCountry?: string;
    ownerUserId?: string | null;
    bom?: boolean;
  }

  /** The whole flow: declare, upload, complete, read the header, map, run. Returns the job as the creator reads it. */
  async function importCsv(rows: readonly (readonly string[])[], columns: Json[], options: ImportOptions = {}) {
    const headers = options.headers ?? IMPORTER;
    const bytes = csv(rows, { bom: options.bom ?? false });
    const importId = await uploadAndComplete(headers, options.programmeId ?? PROGRAMME_A1, bytes);
    await readHeader(importId);
    await saveMapping(headers, importId, {
      columns,
      defaultCountry: options.defaultCountry ?? 'NG',
      ...(options.ownerUserId === undefined ? {} : { ownerUserId: options.ownerUserId }),
    });
    const job = await queueRun(headers, importId);
    await (await importJobs()).processImportRun(deps(), job.data);
    return { importId, body: await getImport(headers, importId) };
  }

  interface ContactRow {
    id: string;
    programme_id: string;
    display_name: string;
    phones: { e164: string }[];
    emails: string[];
    dnd: boolean;
    whatsapp_opt_in: boolean;
    consent_state: string;
    owner_user_id: string | null;
    custom: Json;
    status: string | null;
  }

  async function importedContacts(importId: string): Promise<ContactRow[]> {
    const rows = await observer.query<ContactRow>(
      `SELECT id, programme_id, display_name, phones, emails, dnd, whatsapp_opt_in, consent_state,
              owner_user_id, custom, status
         FROM contact WHERE import_job_id = $1 ORDER BY display_name`,
      [importId],
    );
    return rows.rows;
  }

  async function countImported(importId: string): Promise<number> {
    const rows = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM contact WHERE import_job_id = $1', [importId]);
    return Number(rows.rows[0]?.n ?? '0');
  }

  const byName = (contacts: readonly ContactRow[]) => new Map(contacts.map((c) => [c.display_name, c]));
  const errorKey = (e: RowError) => `${e.row}:${e.column === null ? 'null' : e.column}:${e.code}`;

  /**
   * Runs `work` and, right after the first COMMIT that leaves at least one
   * contact of `importId` committed, runs `between` before the committing
   * call returns. The processor awaits that COMMIT before its next batch, so
   * `between` falls strictly between two batches, with no timer.
   */
  async function betweenBatches(importId: string, between: () => Promise<void>, work: () => Promise<void>): Promise<number> {
    let fired = false;
    let busy = false;
    let committedBefore = -1;
    clientPrototype.query = function hookedQuery(this: unknown, ...args: unknown[]) {
      const out = originalQuery.apply(this, args);
      if (fired || busy || statementText(args).trim().toUpperCase() !== 'COMMIT') return out;
      if (out === null || typeof out !== 'object' || typeof (out as Promise<unknown>).then !== 'function') return out;
      return (out as Promise<unknown>).then(async (result) => {
        if (fired || busy) return result;
        busy = true;
        try {
          const n = await countImported(importId);
          if (n > 0) {
            fired = true;
            committedBefore = n;
            await between();
          }
        } finally {
          busy = false;
        }
        return result;
      });
    };
    try {
      await work();
    } finally {
      clientPrototype.query = originalQuery;
    }
    expect(fired, 'the hook never fired: no batch committed a contact').toBe(true);
    return committedBefore;
  }

  /** `count` data rows `zq<prefix><n>` under a one-column header, for the batch tests. */
  function nameRows(prefix: string, count: number): string[][] {
    return [['Name'], ...Array.from({ length: count }, (_, i) => [`zq${prefix}${RUN}n${i + 1}`])];
  }

  // =========================================================================
  // 1. The migration.
  // =========================================================================

  describe('1. migration: import_job and contact.import_job_id', () => {
    it('exactly one migration file creates import_job, and it has been applied', async () => {
      const creators = readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith('.sql'))
        .filter((file) => /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(public\.)?"?import_job"?\s*\(/i.test(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8')));
      expect(creators, 'migrations creating import_job').toHaveLength(1);
      const table = await observer.query<{ oid: string | null }>(`SELECT to_regclass('public.import_job')::text AS oid`);
      expect(table.rows[0]?.oid, 'import_job does not exist').toBe('import_job');
    });

    it('import_job has the pinned columns, a unique stored_object_id, and is in TENANT_SCOPED_TABLES', async () => {
      const columns = await observer.query<{ name: string; type: string }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
           FROM pg_attribute a WHERE a.attrelid = to_regclass('public.import_job') AND a.attnum > 0 AND NOT a.attisdropped`,
      );
      const types = new Map(columns.rows.map((row) => [row.name, row.type]));
      for (const [name, type] of [
        ['id', 'uuid'],
        ['tenant_id', 'uuid'],
        ['programme_id', 'uuid'],
        ['stored_object_id', 'uuid'],
        ['created_by_user_id', 'uuid'],
        ['status', 'text'],
        ['upload_id', 'text'],
        ['filename', 'text'],
        ['raw_file_deleted_at', 'timestamp with time zone'],
      ] as const) {
        expect(types.get(name), `import_job.${name}`).toBe(type);
      }
      for (const name of ['headers', 'mapping']) expect(types.has(name), `import_job.${name}`).toBe(true);
      const unique = await observer.query<{ def: string }>(
        `SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
          WHERE i.indrelid = to_regclass('public.import_job') AND i.indisunique`,
      );
      expect(
        unique.rows.some((row) => /\(stored_object_id\)/.test(row.def)),
        `no unique index on (stored_object_id) alone: ${JSON.stringify(unique.rows)}`,
      ).toBe(true);
      expect(TENANT_SCOPED_TABLES as readonly string[]).toContain('import_job');
    });

    it('RLS is ENABLED and FORCED, a permissive policy scopes tenant and programme with WITH CHECK equal to USING', async () => {
      const state = await observer.query<{ enabled: boolean; forced: boolean; owner: string }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced, pg_get_userbyid(relowner) AS owner
           FROM pg_class WHERE oid = to_regclass('public.import_job')`,
      );
      expect(state.rows[0]).toEqual({ enabled: true, forced: true, owner: 'kasuwa_migrator' });
      const policies = await observer.query<{ permissive: string; qual: string | null; with_check: string | null }>(
        `SELECT permissive, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'import_job'`,
      );
      const scoping = policies.rows.filter(
        (p) =>
          p.permissive === 'PERMISSIVE' &&
          (p.qual ?? '').includes('current_tenant_id()') &&
          (p.qual ?? '').includes('current_programme_ids()'),
      );
      expect(scoping.length, `no permissive tenant+programme policy: ${JSON.stringify(policies.rows)}`).toBeGreaterThan(0);
      expect(scoping.some((p) => p.with_check === p.qual), 'no scoping policy has WITH CHECK identical to USING').toBe(true);
    });

    it('kasuwa_app reads and inserts, may not move the keys or the creator, and cannot DELETE or TRUNCATE; kasuwa_auth holds nothing', async () => {
      const privilege = async (role: string, what: string) => {
        const rows = await observer.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'public.import_job', $2) AS ok`, [role, what]);
        return rows.rows[0]?.ok;
      };
      expect(await privilege('kasuwa_app', 'SELECT')).toBe(true);
      expect(await privilege('kasuwa_app', 'INSERT')).toBe(true);
      for (const column of ['id', 'tenant_id', 'programme_id', 'stored_object_id', 'created_by_user_id', 'created_at']) {
        const rows = await observer.query<{ ok: boolean }>(
          `SELECT has_column_privilege('kasuwa_app', 'public.import_job', $1, 'UPDATE') AS ok`,
          [column],
        );
        expect(rows.rows[0]?.ok, `kasuwa_app may UPDATE import_job.${column}`).toBe(false);
      }
      const holders = await observer.query<{ role: string; what: string }>(
        `SELECT r.rolname AS role, x.what FROM pg_roles r
          CROSS JOIN LATERAL (
            SELECT 'DELETE' AS what WHERE has_table_privilege(r.oid, 'public.import_job', 'DELETE')
            UNION ALL SELECT 'TRUNCATE' WHERE has_table_privilege(r.oid, 'public.import_job', 'TRUNCATE')
            UNION ALL SELECT 'BYPASSRLS' WHERE r.rolbypassrls
          ) x
         WHERE pg_has_role('kasuwa_app', r.oid, 'MEMBER')`,
      );
      expect(holders.rows, 'kasuwa_app, or a role it can enter, can delete import_job rows or bypass RLS').toEqual([]);
      for (const what of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await privilege('kasuwa_auth', what), `kasuwa_auth holds ${what}`).toBe(false);
      }
    });

    it('every FK on import_job carries tenant_id; the object FK carries the programme; the creator FK points at "user"', async () => {
      const fks = await observer.query<{ cols: string[]; target: string; target_cols: string[] }>(
        `SELECT array_agg(a.attname ORDER BY k.n) AS cols, c.confrelid::regclass::text AS target,
                array_agg(fa.attname ORDER BY k.n) AS target_cols
           FROM pg_constraint c
           CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(col, fcol, n)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.col
           JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fcol
          WHERE c.conrelid = to_regclass('public.import_job') AND c.contype = 'f'
          GROUP BY c.oid, c.confrelid`,
      );
      expect(fks.rows.length, 'import_job has no foreign keys').toBeGreaterThan(0);
      for (const fk of fks.rows) expect(fk.cols, `FK to ${fk.target} lacks tenant_id`).toContain('tenant_id');
      const objectFk = fks.rows.find((fk) => fk.target === 'stored_object');
      expect(objectFk, 'no FK to stored_object').toBeDefined();
      expect([...(objectFk?.cols ?? [])].sort()).toEqual(['programme_id', 'stored_object_id', 'tenant_id']);
      expect([...(objectFk?.target_cols ?? [])].sort()).toEqual(['id', 'programme_id', 'tenant_id']);
      const creatorFk = fks.rows.find((fk) => fk.cols.includes('created_by_user_id'));
      expect(creatorFk?.target, 'created_by_user_id has no FK').toBe('"user"');
    });

    it('contact.import_job_id is a nullable uuid with no default, with an FK (tenant, programme, job) to import_job', async () => {
      const column = await observer.query<{ type: string; notnull: boolean; default: string | null }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = to_regclass('public.contact') AND a.attname = 'import_job_id' AND NOT a.attisdropped`,
      );
      expect(column.rows).toEqual([{ type: 'uuid', notnull: false, default: null }]);
      const fk = await observer.query<{ cols: string[]; target_cols: string[] }>(
        `SELECT array_agg(a.attname ORDER BY k.n) AS cols, array_agg(fa.attname ORDER BY k.n) AS target_cols
           FROM pg_constraint c
           CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(col, fcol, n)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.col
           JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fcol
          WHERE c.conrelid = to_regclass('public.contact') AND c.contype = 'f'
            AND c.confrelid = to_regclass('public.import_job')
          GROUP BY c.oid`,
      );
      expect(fk.rows.length, 'contact has no FK to import_job').toBe(1);
      expect([...(fk.rows[0]?.cols ?? [])].sort()).toEqual(['import_job_id', 'programme_id', 'tenant_id']);
      expect([...(fk.rows[0]?.target_cols ?? [])].sort()).toEqual(['id', 'programme_id', 'tenant_id']);
      const set = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM contact WHERE import_job_id IS NOT NULL');
      expect(set.rows[0]?.n, 'a seeded contact carries an import').toBe('0');
    });

    it('still exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)', async () => {
      // Holds on main too; it is here to catch the build adding a third.
      // The table read first makes the test fail on main for the real reason.
      await observer.query('SELECT 1 FROM import_job LIMIT 1');
      const definers = await observer.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
      );
      expect(definers.rows.map((row) => row.name)).toEqual(['app.resolve_session', 'app.resolve_tenant_by_slug']);
    });
  });

  // =========================================================================
  // 2. The right, and the contract flags.
  // =========================================================================

  describe('2. contact.import and the contract', () => {
    it('contact.import is a programme action held only by sets that also hold contact.write; admin holds it, agent does not', async () => {
      const permissions = (await import(PERMISSIONS_MODULE)) as {
        PROGRAMME_ACTIONS: readonly string[];
        permissionSetKeysGranting: (action: string) => string[];
      };
      expect(permissions.PROGRAMME_ACTIONS).toContain('contact.import');
      const importers = permissions.permissionSetKeysGranting('contact.import');
      const writers = permissions.permissionSetKeysGranting('contact.write');
      expect(importers).toContain('admin');
      for (const key of importers) expect(writers, `${key} holds contact.import without contact.write (D-L151)`).toContain(key);
      for (const key of ['agent', 'team_lead', 'programme_manager', 'qa_analyst']) {
        expect(importers, `${key} holds contact.import (D-P14)`).not.toContain(key);
      }
    });

    it('a member holding only `agent` is 403 on createImport, and 404 on the same programme’s imports (R4)', async () => {
      const refused = await post(AGENT_SET, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename: FILE, sizeBytes: 10, contentType: 'text/csv' });
      expectError(refused, 403, 'not_permitted', 'createImport without contact.import');
      const upload = await createImport(IMPORTER, PROGRAMME_A1, csv([['Name'], ['zqa']]));
      const unknown = await get(AGENT_SET, importPath(NOWHERE));
      const seen = await get(AGENT_SET, importPath(upload.importId));
      expectError(seen, 404, 'not_found', 'getImport without contact.import');
      expect(seen.body).toEqual(unknown.body);
      const list = await get(AGENT_SET, '/api/v1/imports');
      expect(list.status, list.text).toBe(200);
      expect(((list.body as { data: Json[] }).data ?? []).map((row) => row.id)).not.toContain(upload.importId);
    });

    it('the nine import operations and listContacts’ importId are x-kasuwa-implemented: true; duplicates stay false (pinned F)', async () => {
      // Fails until served AND until the lead flips T-0093's R1. The table
      // read keeps this from passing on a contract-only change.
      await observer.query('SELECT 1 FROM import_job LIMIT 1');
      const ops = operations();
      for (const id of [
        'createImport',
        'listImports',
        'getImport',
        'issueImportUploadUrls',
        'completeImportUpload',
        'abortImportUpload',
        'putImportMapping',
        'runImport',
        'cancelImport',
      ]) {
        expect(ops.get(id)?.['x-kasuwa-implemented'], `${id}`).toBe(true);
      }
      const parameters = (ops.get('listContacts')?.parameters ?? []) as Json[];
      const importId = parameters.find((p) => p.name === 'importId');
      expect(importId?.['x-kasuwa-implemented'], 'listContacts importId').toBe(true);
      for (const id of ['listDuplicates', 'createContactMerge']) expect(ops.get(id)?.['x-kasuwa-implemented']).toBe(false);
    });
  });

  // =========================================================================
  // 3. createImport.
  // =========================================================================

  describe('3. createImport: declare the file, get part URLs', { timeout: FLOW_TIMEOUT }, () => {
    it('201 ImportUpload: parts planned (R1), signed on the public endpoint, no filename anywhere in a URL; no-store', async () => {
      const bytes = csv([['Name'], ['zqa']]);
      const response = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename: FILE, sizeBytes: bytes.length, contentType: 'text/csv' });
      expect(response.status, response.text).toBe(201);
      expectNoStore(response, 'createImport');
      expectSchema('ImportUpload', response.body, 'createImport');
      const upload = response.body as ImportUpload;
      expect(upload.parts.map((p) => p.partNumber)).toEqual([1]);
      expect(upload.parts[0]?.sizeBytes).toBe(bytes.length);
      const expires = Date.parse(upload.expiresAt) - Date.now();
      expect(expires, 'expiresAt is not about 5 minutes away').toBeGreaterThan(4 * MINUTE);
      expect(expires).toBeLessThan(6 * MINUTE);
      for (const part of upload.parts) {
        expect(new URL(part.url).origin, 'a part URL is not on the public endpoint').toBe(new URL(seaweed.endpoint).origin);
        expect(part.url).not.toContain(FILE);
        expect(part.url).not.toContain(enc(FILE));
        expect(part.url).not.toContain('zqfile');
      }
      expect(response.text, 'the filename is echoed in the upload answer').not.toContain(FILE);
    });

    it('stores the job awaiting_upload with the creator, a pending stored_object in the programme, and the open upload id (R3)', async () => {
      const bytes = csv([['Name'], ['zqa']]);
      const upload = await createImport(IMPORTER, PROGRAMME_A1, bytes);
      const job = await jobRow(upload.importId);
      expect(job).toMatchObject({
        tenant_id: TENANT_A,
        programme_id: PROGRAMME_A1,
        created_by_user_id: USER_A_AGENT_1,
        status: 'awaiting_upload',
        filename: FILE,
      });
      expect(job.upload_id, 'no upload id stored on the job (D-L155)').toEqual(expect.any(String));
      expect(await seaweed.listUploadDirectories(), 'the stored upload id is not an open upload in the bucket').toContain(job.upload_id);
      const object = await storedObject(job.stored_object_id);
      expect(object).toEqual({ status: 'pending', programme_id: PROGRAMME_A1, declared_size_bytes: String(bytes.length) });
      expect(JSON.stringify(upload), 'the upload id is in an answer').not.toContain(String(job.upload_id));
      const read = await get(IMPORTER, importPath(upload.importId));
      expect(read.text, 'the upload id is in getImport').not.toContain(String(job.upload_id));
    });

    it('audits `created` on import_job by id, actor the creator, naming no filename', async () => {
      const upload = await createImport(IMPORTER, PROGRAMME_A1, csv([['Name'], ['zqa']]));
      const events = await observer.query<{ action: string; actor_user_id: string; object_label: string; changes: unknown; programme_id: string }>(
        `SELECT action, actor_user_id, object_label, changes, programme_id FROM audit_event
          WHERE tenant_id = $1 AND object_type = 'import_job' AND object_id = $2`,
        [TENANT_A, upload.importId],
      );
      expect(events.rows.map((e) => e.action)).toEqual(['created']);
      expect(events.rows[0]).toMatchObject({ actor_user_id: USER_A_AGENT_1, programme_id: PROGRAMME_A1 });
      expect(JSON.stringify(events.rows)).not.toContain('zqfile');
    });

    it('enqueues the 24-hour retention job with an ids-only payload (pinned B)', async () => {
      const upload = await createImport(IMPORTER, PROGRAMME_A1, csv([['Name'], ['zqa']]));
      const job = await retentionJobWithDelay(upload.importId, DAY);
      expect(job.data).toEqual({ tenantId: TENANT_A, userId: USER_A_AGENT_1, importId: upload.importId });
      expect(JSON.stringify({ data: job.data, opts: job.opts, name: job.name })).not.toContain('zqfile');
    });

    it('25 MiB exactly is accepted in at most four parts; one byte more is 400 file_too_large at sizeBytes; 0 is 400', async () => {
      const ok = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename: FILE, sizeBytes: MAX_FILE, contentType: 'text/csv' });
      expect(ok.status, ok.text).toBe(201);
      expect((ok.body as ImportUpload).parts.length).toBeLessThanOrEqual(4);
      const over = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename: FILE, sizeBytes: MAX_FILE + 1, contentType: 'text/csv' });
      expectDetail(over, 400, 'validation_failed', 'file_too_large', 'sizeBytes', 'createImport over 25 MiB');
      const zero = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename: FILE, sizeBytes: 0, contentType: 'text/csv' });
      const body = expectError(zero, 400, 'validation_failed', 'createImport of 0 bytes');
      expect(detailsOf(body).map((d) => d.path)).toContain('sizeBytes');
    });

    it('plans min(4, ceil(size / 5 MiB)) parts, sized as planParts: numbered from 1, summing to the size, all but the last at least 5 MiB (R1)', async () => {
      const { planParts } = (await import(ADAPTER_MODULE)) as { planParts: (length: number, count: number) => number[] };
      for (const size of [1, MIN_PART, MIN_PART + 1, 12 * MiB, 20 * MiB + 3, MAX_FILE]) {
        const response = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename: FILE, sizeBytes: size, contentType: 'text/csv' });
        expect(response.status, `${size}: ${response.text}`).toBe(201);
        const parts = (response.body as ImportUpload).parts;
        const count = Math.min(4, Math.ceil(size / MIN_PART));
        expect(parts.map((p) => p.partNumber), `${size}: part numbers`).toEqual(Array.from({ length: count }, (_, i) => i + 1));
        expect(parts.map((p) => p.sizeBytes), `${size}: part sizes`).toEqual(planParts(size, count));
        expect(parts.reduce((sum, p) => sum + p.sizeBytes, 0)).toBe(size);
        for (const part of parts.slice(0, -1)) expect(part.sizeBytes).toBeGreaterThanOrEqual(MIN_PART);
      }
    }, 60_000);

    it('content types: text/csv, application/csv and vnd.ms-excel with a .csv name in any case; anything else is 400 unsupported_type', async () => {
      for (const [contentType, filename] of [
        ['text/csv', FILE],
        ['application/csv', FILE],
        ['application/vnd.ms-excel', 'zq-report.CSV'],
      ] as const) {
        const response = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename, sizeBytes: 10, contentType });
        expect(response.status, `${contentType} ${filename}: ${response.text}`).toBe(201);
      }
      for (const [contentType, filename] of [
        ['application/vnd.ms-excel', 'zq-report.xls'],
        ['application/vnd.ms-excel', 'zq-report.csv.xls'],
        ['text/plain', FILE],
        ['application/octet-stream', FILE],
        ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'zq.xlsx'],
      ] as const) {
        const response = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename, sizeBytes: 10, contentType });
        expectDetail(response, 400, 'validation_failed', 'unsupported_type', 'contentType', `${contentType} ${filename}`);
      }
    });

    it('a filename with a separator, a control character, NUL or over 255 characters is 400 at filename, and is never echoed', async () => {
      for (const filename of [`zq/${RUN}.csv`, `zq\\${RUN}.csv`, `zq\u0007${RUN}.csv`, `zq\u0000${RUN}.csv`, `zq${'x'.repeat(260)}.csv`, '']) {
        const response = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename, sizeBytes: 10, contentType: 'text/csv' });
        const body = expectError(response, 400, 'validation_failed', `filename ${JSON.stringify(filename.slice(0, 12))}`);
        expect(detailsOf(body).map((d) => d.path)).toContain('filename');
        if (filename !== '') expect(response.text).not.toContain(RUN);
      }
    });

    it('the body is closed: a part count, key, tenant, upload id or file id is 400, and no import is created', async () => {
      const before = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM import_job');
      for (const extra of [{ partCount: 1 }, { key: 'tenant/x' }, { tenantId: TENANT_B }, { uploadId: 'u' }, { fileId: NOWHERE }, { createdByUserId: USER_A_SUPERVISOR }]) {
        const response = await post(IMPORTER, '/api/v1/imports', { programmeId: PROGRAMME_A1, filename: FILE, sizeBytes: 10, contentType: 'text/csv', ...extra });
        expectError(response, 400, 'validation_failed', `extra ${Object.keys(extra).join()}`);
      }
      const after = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM import_job');
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    });

    it('a programme out of scope, another tenant’s, or none is one identical 404 (a target, never 403)', async () => {
      const body = (programmeId: string) => ({ programmeId, filename: FILE, sizeBytes: 10, contentType: 'text/csv' });
      const nowhere = await post(IMPORTER, '/api/v1/imports', body(NOWHERE));
      const sibling = await post(IMPORTER, '/api/v1/imports', body(PROGRAMME_A2));
      const tenantB = await post(B_ADMIN, '/api/v1/imports', body(PROGRAMME_A1));
      for (const [response, where] of [[nowhere, 'nowhere'], [sibling, 'sibling'], [tenantB, 'other tenant']] as const) {
        expectError(response, 404, 'not_found', where);
      }
      expect(sibling.body).toEqual(nowhere.body);
      expect(tenantB.body).toEqual(nowhere.body);
    });
  });

  // =========================================================================
  // 4. Upload: re-issue, complete, mismatch, abort.
  // =========================================================================

  describe('4. upload-urls, complete and abort', { timeout: FLOW_TIMEOUT }, () => {
    it('re-issued URLs resume the SAME upload: part 1 on the first URL, the rest on fresh ones, complete is 202 (R2)', async () => {
      const bytes = filler(2 * MIN_PART + 10);
      const upload = await createImport(IMPORTER, PROGRAMME_A1, bytes);
      expect(upload.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
      const before = await jobRow(upload.importId);
      const first = await putParts(upload.parts, bytes, [1]);
      const reissue = await post(IMPORTER, importPath(upload.importId, '/upload-urls'), { partNumbers: [2, 3] });
      expect(reissue.status, reissue.text).toBe(200);
      expectNoStore(reissue, 'issueImportUploadUrls');
      expectSchema('ImportUpload', reissue.body, 'issueImportUploadUrls');
      const fresh = reissue.body as ImportUpload;
      expect(fresh.importId).toBe(upload.importId);
      expect(fresh.parts.map((p) => [p.partNumber, p.sizeBytes])).toEqual(upload.parts.slice(1).map((p) => [p.partNumber, p.sizeBytes]));
      expect(Date.parse(fresh.expiresAt)).toBeGreaterThan(Date.now() + 4 * MINUTE);
      expect((await jobRow(upload.importId)).upload_id, 're-issue changed the upload id').toBe(before.upload_id);
      // Sizes are the original plan's; offsets come from the original list.
      const offsets = upload.parts;
      const rest: { partNumber: number; etag: string }[] = [];
      for (const part of fresh.parts) {
        const start = offsets.filter((p) => p.partNumber < part.partNumber).reduce((sum, p) => sum + p.sizeBytes, 0);
        const response = await fetch(part.url, { method: 'PUT', body: bytes.subarray(start, start + part.sizeBytes) });
        await response.arrayBuffer().catch(() => undefined);
        expect(response.status, `PUT re-issued part ${part.partNumber}`).toBe(200);
        rest.push({ partNumber: part.partNumber, etag: response.headers.get('etag') ?? '' });
      }
      const done = await post(IMPORTER, importPath(upload.importId, '/complete'), { parts: [...first, ...rest] });
      expect(done.status, done.text).toBe(202);
      expectSchema('Import', done.body, 'completeImportUpload');
      expect((done.body as ImportBody).status).toBe('reading_header');
      const job = await jobRow(upload.importId);
      expect((await seaweed.listEntries(keyOf(job))).map((e) => e.size)).toEqual([bytes.length]);
    }, 120_000);

    it('upload-urls refuses part numbers outside the plan or none (400), and any status but awaiting_upload (409)', async () => {
      const bytes = filler(MIN_PART + 10);
      const upload = await createImport(IMPORTER, PROGRAMME_A1, bytes);
      for (const partNumbers of [[3], [], [0], [5], [1, 1]]) {
        const response = await post(IMPORTER, importPath(upload.importId, '/upload-urls'), { partNumbers });
        expectError(response, 400, 'validation_failed', `partNumbers ${JSON.stringify(partNumbers)}`);
      }
      const etags = await putParts(upload.parts, bytes);
      expect((await post(IMPORTER, importPath(upload.importId, '/complete'), { parts: etags })).status).toBe(202);
      const late = await post(IMPORTER, importPath(upload.importId, '/upload-urls'), { partNumbers: [1] });
      expectError(late, 409, 'import_status_conflict', 'upload-urls after complete');
    }, 60_000);

    it('complete moves to reading_header and enqueues the header job (ids only); the object sits at the minted key with the lifecycle tag (R14)', async () => {
      const bytes = csv([['Name'], ['zqa']]);
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, bytes);
      const job = await jobRow(importId);
      expect(job.status).toBe('reading_header');
      expect((await storedObject(job.stored_object_id)).status).toBe('uploaded');
      const header = await onlyJob(HEADER_QUEUE, importId);
      expect(header.data).toEqual({ tenantId: TENANT_A, userId: USER_A_AGENT_1, importId });
      const entries = await seaweed.listEntries(`tenant/${TENANT_A}/programme/${PROGRAMME_A1}/import/`);
      expect(entries.map((e) => e.key)).toEqual([keyOf(job)]);
      const tags = Object.entries(entries[0]?.extended ?? {}).map(([name, value]) => `${name}=${Buffer.from(value, 'base64').toString('utf8')}`);
      expect(tags.some((tag) => /kasuwa-purpose=import$/i.test(tag) || /kasuwa-purpose.*=import$/i.test(tag)), `no lifecycle tag on the object: ${JSON.stringify(tags)}`).toBe(true);
      const events = await observer.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = $1 AND actor_user_id = $2
            AND object_id IN ($3, $4) AND occurred_at > now() - interval '5 minutes'`,
        [TENANT_A, USER_A_AGENT_1, importId, job.stored_object_id],
      );
      expect(Number(events.rows[0]?.n), 'complete wrote no audit event (import uploaded)').toBeGreaterThanOrEqual(2);
    });

    it('a part never sent is 422 upload_mismatch: the job is rejected, the object deleted, `rejected` audited, retention queued', async () => {
      const bytes = filler(MIN_PART + 1024);
      const upload = await createImport(IMPORTER, PROGRAMME_A1, bytes);
      expect(upload.parts.length).toBe(2);
      const etags = await putParts(upload.parts, bytes, [1]);
      const response = await post(IMPORTER, importPath(upload.importId, '/complete'), { parts: etags });
      expectError(response, 422, 'upload_mismatch', 'complete with a part missing');
      expectNoStore(response, 'upload_mismatch');
      const job = await jobRow(upload.importId);
      expect(job.status).toBe('rejected');
      expect(['rejected', 'deleted']).toContain((await storedObject(job.stored_object_id)).status);
      expect(await seaweed.listEntries(keyOf(job)), 'the mismatched object is still in the bucket').toEqual([]);
      const audit = await observer.query<{ actor_user_id: string }>(
        `SELECT actor_user_id FROM audit_event WHERE tenant_id = $1 AND object_type = 'stored_object'
            AND object_id = $2 AND action = 'rejected'`,
        [TENANT_A, job.stored_object_id],
      );
      expect(audit.rows).toEqual([{ actor_user_id: USER_A_AGENT_1 }]);
      await retentionJobWithDelay(upload.importId, 7 * DAY);
      const again = await post(IMPORTER, importPath(upload.importId, '/complete'), { parts: etags });
      expectError(again, 409, 'import_status_conflict', 'complete after rejection');
      expect(await jobsFor(HEADER_QUEUE, upload.importId), 'a rejected upload queued a header read').toEqual([]);
    }, 60_000);

    it('complete twice is 409; a malformed part list or a body naming an upload id is 400 and changes nothing (R3)', async () => {
      const bytes = csv([['Name'], ['zqa']]);
      const upload = await createImport(IMPORTER, PROGRAMME_A1, bytes);
      const etags = await putParts(upload.parts, bytes);
      for (const body of [{}, { parts: [] }, { parts: [{ partNumber: 9, etag: 'x' }] }, { parts: etags, uploadId: 'forged' }]) {
        const response = await post(IMPORTER, importPath(upload.importId, '/complete'), body);
        expectError(response, 400, 'validation_failed', `complete ${JSON.stringify(Object.keys(body))}`);
      }
      expect((await jobRow(upload.importId)).status).toBe('awaiting_upload');
      expect((await post(IMPORTER, importPath(upload.importId, '/complete'), { parts: etags })).status).toBe(202);
      const twice = await post(IMPORTER, importPath(upload.importId, '/complete'), { parts: etags });
      expectError(twice, 409, 'import_status_conflict', 'complete twice');
    });

    it('abort is 200 `cancelled`: the open upload is gone, nothing is in the bucket, later writes are 409, retention is queued', async () => {
      const bytes = filler(MIN_PART + 1024);
      const upload = await createImport(IMPORTER, PROGRAMME_A1, bytes);
      await putParts(upload.parts, bytes, [1]);
      const before = await jobRow(upload.importId);
      const response = await post(IMPORTER, importPath(upload.importId, '/abort'));
      expect(response.status, response.text).toBe(200);
      expectSchema('Import', response.body, 'abortImportUpload');
      const body = response.body as ImportBody;
      expect(body.status).toBe('cancelled');
      expect(body.finishedAt).toEqual(expect.any(String));
      expect(await seaweed.listUploadDirectories(), 'the multipart upload is still open').not.toContain(before.upload_id);
      expect(await seaweed.listEntries(keyOf(before))).toEqual([]);
      expect((await storedObject(before.stored_object_id)).status).not.toBe('pending');
      for (const [path, payload] of [
        ['/upload-urls', { partNumbers: [1] }],
        ['/complete', { parts: [{ partNumber: 1, etag: '"x"' }] }],
        ['/abort', undefined],
      ] as const) {
        expectError(await post(IMPORTER, importPath(upload.importId, path), payload), 409, 'import_status_conflict', `${path} after abort`);
      }
      await retentionJobWithDelay(upload.importId, 7 * DAY);
    }, 60_000);
  });

  // =========================================================================
  // 5. The header job and the mapping.
  // =========================================================================

  describe('5. reading the header, and the mapping', { timeout: FLOW_TIMEOUT }, () => {
    it('the header job stores the column names (BOM stripped) and a suggested mapping; the job awaits the mapping; nothing is logged', async () => {
      const bytes = csv([['Name', `Mobile ${HEAD}`, 'Email'], [`${CELL}a`, '0803 555 0101', 'a@example.test']], { bom: true });
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, bytes);
      const lines = await captureEverything(() => readHeader(importId));
      const body = await getImport(IMPORTER, importId);
      expectSchema('Import', body, 'getImport after the header');
      expect(body.status).toBe('awaiting_mapping');
      expect(body.headers).toEqual(['Name', `Mobile ${HEAD}`, 'Email']);
      expect(Array.isArray(body.suggestedMapping)).toBe(true);
      expect(body.mapping).toBeNull();
      expect(JSON.stringify(body), 'a cell reached the job').not.toContain(CELL);
      expect(lines.filter((line) => line.includes(HEAD) || line.includes(CELL)), 'the header job logged file content').toEqual([]);
    });

    it('a header of 501 columns, or a name over 255 characters, never yields a job outside the Import schema', async () => {
      for (const header of [Array.from({ length: 501 }, (_, i) => `c${i}`), ['Name', 'x'.repeat(300)]]) {
        const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv([header, header.map(() => 'v')]));
        await (await importJobs()).processImportHeader(deps(), (await onlyJob(HEADER_QUEUE, importId)).data).catch(() => undefined);
        const response = await get(IMPORTER, importPath(importId));
        expect(response.status).toBe(200);
        expectSchema('Import', response.body, `header of ${header.length} columns`);
      }
    });

    it('mapping is 409 before the header is read, 200 after, and is answered with the saved mapping (no-store)', async () => {
      const bytes = csv([['Name', 'Mobile'], ['zqa', '0803 555 0101']]);
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, bytes);
      const mapping = { columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }], defaultCountry: 'NG' };
      expectError(await put(IMPORTER, importPath(importId, '/mapping'), mapping), 409, 'import_status_conflict', 'mapping while reading_header');
      await readHeader(importId);
      const response = await put(IMPORTER, importPath(importId, '/mapping'), { ...mapping, ownerUserId: USER_A_AGENT_1 });
      expect(response.status, response.text).toBe(200);
      expectNoStore(response, 'putImportMapping');
      expectSchema('Import', response.body, 'putImportMapping');
      expect((response.body as ImportBody).mapping).toEqual({ ...mapping, ownerUserId: USER_A_AGENT_1 });
    });

    it('refuses an incomplete, out-of-range, repeated, unknown-owner, unknown-field or ill-formed mapping with the pinned details', async () => {
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv([['Name', 'Mobile', 'Other'], ['zqa', '0803 555 0101', 'x']]));
      await readHeader(importId);
      const send = (body: Json) => put(IMPORTER, importPath(importId, '/mapping'), body);
      expectDetail(await send({ columns: [{ index: 1, field: 'phones' }], defaultCountry: 'NG' }), 400, 'validation_failed', 'mapping_incomplete', 'displayName', 'no name');
      expectDetail(await send({ columns: [{ index: 0, field: 'displayName' }, { index: 3, field: 'phones' }], defaultCountry: 'NG' }), 400, 'validation_failed', 'unknown_column', 'columns.1.index', 'index beyond the headers');
      expectDetail(await send({ columns: [{ index: 0, field: 'displayName' }, { index: 2, field: 'displayName' }], defaultCountry: 'NG' }), 400, 'validation_failed', 'duplicate_mapping', 'columns.1.field', 'displayName twice');
      expect((await send({ columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }, { index: 2, field: 'phones' }], defaultCountry: 'NG' })).status, 'phones twice').toBe(200);
      for (const owner of [USER_B_AGENT_1, USER_A_AGENT_2, NOWHERE]) {
        expectDetail(await send({ columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG', ownerUserId: owner }), 400, 'validation_failed', 'unknown_reference', 'ownerUserId', `owner ${owner}`);
      }
      expectDetail(await send({ columns: [{ index: 0, field: 'displayName' }, { index: 2, field: 'custom.nosuch__c' }], defaultCountry: 'NG' }), 400, 'validation_failed', 'unknown_field', 'columns.1.field', 'unknown custom key');
      for (const body of [
        { columns: [{ index: 0, field: 'displayName' }] },
        { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'US' },
        { columns: [{ index: 0, field: 'displayName' }], fromImportId: importId, defaultCountry: 'NG' },
        { columns: [{ index: 0, field: 'ownerUserId' }], defaultCountry: 'NG' },
        { columns: [{ index: 0, field: 'programmeId' }], defaultCountry: 'NG' },
      ]) {
        expectError(await send(body), 400, 'validation_failed', `ill-formed ${JSON.stringify(body).slice(0, 80)}`);
      }
    });

    it('a mapped field the creator may not edit is 403 field_not_editable at the field, never a column', async () => {
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv([['Name', 'Secret'], ['zqa', 'x']]));
      await readHeader(importId);
      const response = await put(IMPORTER, importPath(importId, '/mapping'), {
        columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'custom.secret__c' }],
        defaultCountry: 'NG',
      });
      expectDetail(response, 403, 'not_permitted', 'field_not_editable', 'custom.secret__c', 'withheld custom field');
    });

    it('fromImportId copies an earlier mapping BY HEADER NAME into a file with another column order; the answer has no fromImportId', async () => {
      const first = await importCsv([['Name', 'Mobile'], ['zqfirst', '0803 555 0101']], [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }]);
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv([['Mobile', 'Name'], ['0803 555 0102', 'zqsecond']]));
      await readHeader(importId);
      const response = await put(IMPORTER, importPath(importId, '/mapping'), { fromImportId: first.importId, defaultCountry: 'NG' });
      expect(response.status, response.text).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain('fromImportId');
      const columns = ((response.body as ImportBody).mapping?.columns ?? []) as Json[];
      const byIndex = new Map(columns.map((c) => [c.index, c.field]));
      expect(byIndex.get(0)).toBe('phones');
      expect(byIndex.get(1)).toBe('displayName');
    });
  });

  // =========================================================================
  // 6. Run, cancel, and creator-only writes.
  // =========================================================================

  describe('6. run, cancel, and who may write', { timeout: FLOW_TIMEOUT }, () => {
    it('run is 409 without a mapping, 202 `queued` with one (ids-only job), and 409 a second time', async () => {
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv([['Name'], ['zqa']]));
      await readHeader(importId);
      expectError(await post(IMPORTER, importPath(importId, '/run')), 409, 'import_status_conflict', 'run without a mapping');
      await saveMapping(IMPORTER, importId, { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG' });
      const response = await post(IMPORTER, importPath(importId, '/run'));
      expect(response.status, response.text).toBe(202);
      expectNoStore(response, 'runImport');
      expectSchema('Import', response.body, 'runImport');
      expect((response.body as ImportBody).status).toBe('queued');
      expect((await onlyJob(RUN_QUEUE, importId)).data).toEqual({ tenantId: TENANT_A, userId: USER_A_AGENT_1, importId });
      expectError(await post(IMPORTER, importPath(importId, '/run')), 409, 'import_status_conflict', 'run twice');
    });

    it('cancel is 409 before the run; cancelled while queued, the run creates nothing and the job ends `cancelled`', async () => {
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv(nameRows('cq', 5)));
      await readHeader(importId);
      expectError(await post(IMPORTER, importPath(importId, '/cancel')), 409, 'import_status_conflict', 'cancel while awaiting_mapping');
      await saveMapping(IMPORTER, importId, { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG' });
      const job = await queueRun(IMPORTER, importId);
      const cancel = await post(IMPORTER, importPath(importId, '/cancel'));
      expect(cancel.status, cancel.text).toBe(202);
      expectSchema('Import', cancel.body, 'cancelImport');
      await (await importJobs()).processImportRun(deps(), job.data);
      const body = await getImport(IMPORTER, importId);
      expect(body.status).toBe('cancelled');
      expect(body.counts.created).toBe(0);
      expect(await countImported(importId)).toBe(0);
    });

    it('a tenant admin cancels a running import between batches: what was created stays, nothing more is created (R5)', async () => {
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv(nameRows('cm', 2500)));
      await readHeader(importId);
      await saveMapping(IMPORTER, importId, { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG' });
      const job = await queueRun(IMPORTER, importId);
      const jobs = await importJobs();
      const committed = await betweenBatches(
        importId,
        async () => {
          const response = await post(SUPERVISOR, importPath(importId, '/cancel'));
          expect(response.status, `tenant admin cancel: ${response.text}`).toBe(202);
        },
        async () => {
          await jobs.processImportRun(deps(), job.data);
        },
      );
      expect(committed, 'a batch held more than 1,000 rows (R5)').toBeLessThanOrEqual(1000);
      const body = await getImport(IMPORTER, importId);
      expect(body.status).toBe('cancelled');
      expect(await countImported(importId)).toBe(committed);
      expect(body.counts.created).toBe(committed);
    }, 180_000);

    it('every write but cancel is the creator’s alone: another importer and a tenant admin get 403 and nothing changes (D-L151)', async () => {
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'admin');
      const bytes = csv([['Name'], ['zqa']]);
      const upload = await createImport(IMPORTER, PROGRAMME_A1, bytes);
      const etags = await putParts(upload.parts, bytes);
      const id = upload.importId;
      for (const who of [OTHER, SUPERVISOR]) {
        expectError(await post(who, importPath(id, '/upload-urls'), { partNumbers: [1] }), 403, 'not_permitted', 'upload-urls by another');
        expectError(await post(who, importPath(id, '/complete'), { parts: etags }), 403, 'not_permitted', 'complete by another');
        expectError(await post(who, importPath(id, '/abort')), 403, 'not_permitted', 'abort by another');
      }
      expect((await jobRow(id)).status).toBe('awaiting_upload');
      expect((await post(IMPORTER, importPath(id, '/complete'), { parts: etags })).status).toBe(202);
      await readHeader(id);
      const mapping = { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG' };
      for (const who of [OTHER, SUPERVISOR]) {
        expectError(await put(who, importPath(id, '/mapping'), mapping), 403, 'not_permitted', 'mapping by another');
      }
      await saveMapping(IMPORTER, id, mapping);
      for (const who of [OTHER, SUPERVISOR]) {
        expectError(await post(who, importPath(id, '/run')), 403, 'not_permitted', 'run by another');
      }
      expect(await jobsFor(RUN_QUEUE, id)).toEqual([]);
      await queueRun(IMPORTER, id);
      expectError(await post(OTHER, importPath(id, '/cancel')), 403, 'not_permitted', 'cancel by a non-admin importer');
      expect((await jobRow(id)).status).toBe('queued');
      // Reads are not creator-only (R4).
      expect((await get(OTHER, importPath(id))).status).toBe(200);
      const list = await get(OTHER, '/api/v1/imports');
      expect(((list.body as { data: Json[] }).data ?? []).map((row) => row.id)).toContain(id);
      expect((await post(SUPERVISOR, importPath(id, '/cancel'))).status, 'a tenant admin may cancel').toBe(202);
    });
  });

  // =========================================================================
  // 7. The run: parsing, phones, compliance, duplicates, limits.
  // =========================================================================

  describe('7. the run job', { timeout: FLOW_TIMEOUT }, () => {
    it('creates the rows as the creator: import_job_id set, owner from the mapping, one `created` audit each by the creator (R10)', async () => {
      const { importId, body } = await importCsv(
        [
          ['Name', 'Mobile', 'Email', 'Status'],
          ['zqrun1', '0803 555 0101', 'run1@example.test', 'new'],
          ['zqrun2', '+234 803 555 0102', '', 'contacted'],
        ],
        [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }, { index: 2, field: 'emails' }, { index: 3, field: 'status' }],
        { ownerUserId: USER_A_AGENT_1 },
      );
      expectSchema('Import', body, 'finished import');
      expect(body.status).toBe('finished');
      expect(body.counts).toEqual({ created: 2, skipped: 0, failed: 0 });
      expect(body.errors).toEqual([]);
      expect(body.finishedAt).toEqual(expect.any(String));
      const contacts = await importedContacts(importId);
      expect(contacts.map((c) => [c.display_name, c.programme_id, c.owner_user_id, c.status])).toEqual([
        ['zqrun1', PROGRAMME_A1, USER_A_AGENT_1, 'new'],
        ['zqrun2', PROGRAMME_A1, USER_A_AGENT_1, 'contacted'],
      ]);
      const audit = await observer.query<{ object_id: string; actor_kind: string; actor_user_id: string | null }>(
        `SELECT object_id, actor_kind, actor_user_id FROM audit_event
          WHERE tenant_id = $1 AND object_type = 'contact' AND action = 'created' AND object_id = ANY ($2::uuid[])`,
        [TENANT_A, contacts.map((c) => c.id)],
      );
      expect(audit.rows.length).toBe(2);
      for (const row of audit.rows) expect(row).toMatchObject({ actor_kind: 'user', actor_user_id: USER_A_AGENT_1 });
      const finished = await observer.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = $1 AND object_type = 'import_job'
            AND object_id = $2 AND action = 'updated'`,
        [TENANT_A, importId],
      );
      expect(Number(finished.rows[0]?.n), 'no `updated` import_job audit at the end').toBeGreaterThanOrEqual(1);
      const retention = await retentionJobWithDelay(importId, 7 * DAY);
      expect(retention.data).toEqual({ tenantId: TENANT_A, userId: USER_A_AGENT_1, importId });
    });

    it('the importId filter lists exactly the created contacts; an unknown id is an empty page; a malformed one is 400', async () => {
      const { importId } = await importCsv(nameRows('flt', 3), [{ index: 0, field: 'displayName' }]);
      const listed = await get(IMPORTER, `/api/v1/contacts?importId=${enc(importId)}&limit=50`);
      expect(listed.status, listed.text).toBe(200);
      const ids = ((listed.body as { data: Json[] }).data ?? []).map((row) => row.id).sort();
      expect(ids).toEqual((await importedContacts(importId)).map((c) => c.id).sort());
      expect(ids.length).toBe(3);
      const unknown = await get(IMPORTER, `/api/v1/contacts?importId=${NOWHERE}`);
      expect(unknown.status).toBe(200);
      expect(unknown.body).toEqual({ data: [], nextCursor: null });
      expectError(await get(IMPORTER, '/api/v1/contacts?importId=not-a-uuid'), 400, 'validation_failed', 'malformed importId');
    });

    it('normalises phones to E.164 for NG, GH, KE and ZA; a + number keeps its own country (R16)', async () => {
      // [country, national as typed, its E.164, a +234 number as typed, its E.164]
      const cases: [string, string, string, string, string][] = [
        ['NG', '0803 555 0101', '+2348035550101', '+234 803 555 0191', '+2348035550191'],
        ['GH', '024 455 0103', '+233244550103', '+234 803 555 0193', '+2348035550193'],
        ['KE', '0712 555 104', '+254712555104', '+234 803 555 0194', '+2348035550194'],
        ['ZA', '082 555 0105', '+27825550105', '+234-803-555-0195', '+2348035550195'],
      ];
      for (const [country, typed, e164, intlTyped, intlE164] of cases) {
        const { importId, body } = await importCsv(
          [['Name', 'Mobile'], [`zq${country}national`, typed], [`zq${country}intl`, intlTyped]],
          [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }],
          { defaultCountry: country },
        );
        expect(body.counts, `${country}: ${JSON.stringify(body.errors)}`).toEqual({ created: 2, skipped: 0, failed: 0 });
        const contacts = byName(await importedContacts(importId));
        expect(contacts.get(`zq${country}national`)?.phones.map((p) => p.e164), country).toEqual([e164]);
        expect(contacts.get(`zq${country}intl`)?.phones.map((p) => p.e164), `${country} international`).toEqual([intlE164]);
      }
    }, 120_000);

    it('rows parse with the contacts schema plus custom fields: {row, column, code} by record (quoted newlines, BOM), no values', async () => {
      const { importId, body } = await importCsv(
        [
          ['Name', 'Mobile', 'Email', 'Status', 'Tier', 'Notes'],
          [`${CELL}ok2`, '', '', 'new', 'gold', `multi\nline ${CELL}`],
          ['x'.repeat(201), '', '', '', '', ''],
          [`${CELL}r4`, '', 'not-an-email', '', '', ''],
          [`${CELL}r5`, 'call me', '', '', '', ''],
          ['', '', '', '', '', ''],
          [`${CELL}r7`, '', '', 'banana', '', ''],
          [`${CELL}r8`, '', '', '', 'platinum', ''],
          [`${CELL}ok9`, '', '', '', 'silver', ''],
        ],
        [
          { index: 0, field: 'displayName' },
          { index: 1, field: 'phones' },
          { index: 2, field: 'emails' },
          { index: 3, field: 'status' },
          { index: 4, field: 'custom.tier__c' },
          { index: 5, field: null },
        ],
        { bom: true },
      );
      expectSchema('Import', body, 'import with row errors');
      expect(body.headers?.[0], 'the BOM reached the header').toBe('Name');
      expect(body.counts).toEqual({ created: 2, skipped: 0, failed: 6 });
      const statusError = body.errors.find((e) => e.row === 7);
      expect(['invalid_value', 'unknown_value']).toContain(statusError?.code);
      expect(body.errors.filter((e) => e.row !== 7).map(errorKey)).toEqual([
        '3:0:too_long',
        '4:2:invalid_email',
        '5:1:invalid_phone',
        '6:0:required',
        '8:4:unknown_value',
      ]);
      expect(statusError?.column).toBe(3);
      for (const e of body.errors) expect(Object.keys(e).sort()).toEqual(['code', 'column', 'row']);
      const contacts = byName(await importedContacts(importId));
      expect(contacts.get(`${CELL}ok2`)?.custom).toEqual({ tier__c: 'gold' });
      expect(contacts.get(`${CELL}ok9`)?.custom).toEqual({ tier__c: 'silver' });
      expect(JSON.stringify(body)).not.toContain(CELL);
      expect(JSON.stringify(body)).not.toContain('not-an-email');
    });

    it('compliance is restrict-or-default only: a granting value is consent_grant_refused and the row is not created (D-L148)', async () => {
      const { importId, body } = await importCsv(
        [
          ['Name', 'DND', 'WhatsApp', 'Consent'],
          ['zqc2', 'true', 'false', 'withdrawn'],
          ['zqc3', 'false', '', 'unknown'],
          ['zqc4', '', '', ''],
          ['zqc5', '', 'true', ''],
          ['zqc6', '', '', 'opted_in'],
          ['zqc7', '', '', 'pending'],
        ],
        [{ index: 0, field: 'displayName' }, { index: 1, field: 'dnd' }, { index: 2, field: 'whatsappOptIn' }, { index: 3, field: 'consentState' }],
      );
      expect(body.counts).toEqual({ created: 3, skipped: 0, failed: 3 });
      expect(body.errors.map(errorKey)).toEqual(['5:2:consent_grant_refused', '6:3:consent_grant_refused', '7:3:consent_grant_refused']);
      const contacts = byName(await importedContacts(importId));
      expect([...contacts.keys()].sort()).toEqual(['zqc2', 'zqc3', 'zqc4']);
      expect(contacts.get('zqc2')).toMatchObject({ dnd: true, whatsapp_opt_in: false, consent_state: 'withdrawn' });
      expect(contacts.get('zqc3')).toMatchObject({ dnd: false, whatsapp_opt_in: false, consent_state: 'unknown' });
      expect(contacts.get('zqc4')).toMatchObject({ dnd: false, whatsapp_opt_in: false, consent_state: 'unknown' });
    });

    it('no spelling of a grant gets through: every variant row is refused, and no contact is granted (R8)', async () => {
      const whatsapp = ['TRUE', 'True', ' true', 'true ', 'yes', 'Y', '1', 'on'];
      const consent = ['OPTED_IN', 'Opted_in', 'opted-in', ' opted_in', 'opted in', 'Pending', 'PENDING ', 'optedin'];
      const rows: string[][] = [['Name', 'WhatsApp', 'Consent']];
      whatsapp.forEach((value, i) => rows.push([`zqw${i}`, value, '']));
      consent.forEach((value, i) => rows.push([`zqk${i}`, '', value]));
      const { importId, body } = await importCsv(rows, [
        { index: 0, field: 'displayName' },
        { index: 1, field: 'whatsappOptIn' },
        { index: 2, field: 'consentState' },
      ]);
      expect(body.counts.created, `a variant row was created: ${JSON.stringify(body.errors)}`).toBe(0);
      const granted = await observer.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM contact WHERE import_job_id = $1
            AND (whatsapp_opt_in OR consent_state IN ('opted_in', 'pending'))`,
        [importId],
      );
      expect(granted.rows[0]?.n).toBe('0');
      for (let row = 2; row < rows.length; row += 1) {
        const errors = body.errors.filter((e) => e.row === row);
        expect(errors.length, `row ${row} has no error`).toBeGreaterThan(0);
        for (const e of errors) expect(['consent_grant_refused', 'invalid_value']).toContain(e.code);
      }
    });

    it('duplicates by normalised phone or lower-cased email within the programme and the file are skipped; another programme’s are created (R15)', async () => {
      await observer.query(`UPDATE contact SET emails = '["dup.seed@example.test"]'::jsonb WHERE id = $1`, [A1_FIRST.id]);
      const before = await observer.query<{ version: number; phones: unknown; emails: unknown }>(
        'SELECT version, phones, emails FROM contact WHERE id = $1',
        [A1_FIRST.id],
      );
      const national = `0${A1_FIRST.phoneE164.slice(4)}`;
      const { importId, body } = await importCsv(
        [
          ['Name', 'Mobile', 'Email'],
          ['zqd2', national, ''],
          ['zqd3', A2_FIRST.phoneE164, ''],
          ['zqd4', '', 'DUP.Seed@Example.TEST'],
          ['zqd5', '0803 555 0199', ''],
          ['zqd6', '08035550199', ''],
          ['zqd7', '', 'fresh@example.test'],
          ['zqd8', '', 'FRESH@example.test'],
        ],
        [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }, { index: 2, field: 'emails' }],
      );
      expect(body.counts).toEqual({ created: 3, skipped: 4, failed: 0 });
      expect(body.errors.map(errorKey)).toEqual([
        '2:null:possible_duplicate',
        '4:null:possible_duplicate',
        '6:null:possible_duplicate',
        '8:null:possible_duplicate',
      ]);
      expect((await importedContacts(importId)).map((c) => c.display_name)).toEqual(['zqd3', 'zqd5', 'zqd7']);
      const after = await observer.query<{ version: number; phones: unknown; emails: unknown }>(
        'SELECT version, phones, emails FROM contact WHERE id = $1',
        [A1_FIRST.id],
      );
      expect(after.rows, 'the matched contact was changed').toEqual(before.rows);
    });

    it('never looks across programmes, even for an importer who reaches both (R15)', async () => {
      const { body } = await importCsv(
        [['Name', 'Mobile'], ['zqx2', A2_SECOND.phoneE164]],
        [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }],
        { headers: SUPERVISOR, programmeId: PROGRAMME_A1 },
      );
      expect(body.counts).toEqual({ created: 1, skipped: 0, failed: 0 });
      const intoA2 = await importCsv(
        [['Name', 'Mobile'], ['zqx3', A1_FIRST.phoneE164]],
        [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }],
        { headers: SUPERVISOR, programmeId: PROGRAMME_A2 },
      );
      expect(intoA2.body.counts).toEqual({ created: 1, skipped: 0, failed: 0 });
    });

    it('a row over 65,536 bytes is row_too_large (column null), one just under is not, and later rows still import (R11)', async () => {
      const { importId, body } = await importCsv(
        [['Name', 'Blob'], ['zqr2', 'a'.repeat(60_000)], ['zqr3', 'b'.repeat(70_000)], ['zqr4', 'c']],
        [{ index: 0, field: 'displayName' }, { index: 1, field: null }],
      );
      expect(body.errors.map(errorKey)).toEqual(['3:null:row_too_large']);
      expect(body.counts).toEqual({ created: 2, skipped: 0, failed: 1 });
      expect((await importedContacts(importId)).map((c) => c.display_name)).toEqual(['zqr2', 'zqr4']);
    });

    it('errors are capped at 1,000, lowest rows first, errorsTruncated set, every failed row counted', async () => {
      const rows: string[][] = [['Name', 'Other'], ...Array.from({ length: 1500 }, () => ['', 'x'])];
      const { body } = await importCsv(rows, [{ index: 0, field: 'displayName' }, { index: 1, field: null }]);
      expectSchema('Import', body, 'capped errors');
      expect(body.errors.length).toBe(1000);
      expect(body.errors[0]).toEqual({ row: 2, column: 0, code: 'required' });
      expect(body.errors.at(-1)).toEqual({ row: 1001, column: 0, code: 'required' });
      expect(body.errors.map((e) => e.row)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 2));
      expect(body.errorsTruncated).toBe(true);
      expect(body.counts).toEqual({ created: 0, skipped: 0, failed: 1500 });
    }, 120_000);

    it('a hard stop past 100,000 rows: a valid row 100,002 is never imported (R7, the cheap half)', async () => {
      const late = `zqlate${RUN}`;
      const rows: string[][] = [['Name', 'Other'], ...Array.from({ length: 100_000 }, () => ['', 'x']), [late, 'x']];
      const { body } = await importCsv(rows, [{ index: 0, field: 'displayName' }, { index: 1, field: null }]);
      expect(['finished', 'failed']).toContain(body.status);
      expect(body.counts.created).toBe(0);
      const found = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM contact WHERE display_name = $1', [late]);
      expect(found.rows[0]?.n, 'the row past 100,000 was imported').toBe('0');
      expect(body.errorsTruncated).toBe(true);
    }, 600_000);

    it('100,000 data rows import and row 100,002 is the one too_many_rows error (R7; schema check skipped for the defect)', async () => {
      const rows: string[][] = [['Name'], ...Array.from({ length: 100_001 }, (_, i) => [`zqm${i + 2}`])];
      const { importId, body } = await importCsv(rows, [{ index: 0, field: 'displayName' }]);
      expect(['finished', 'failed']).toContain(body.status);
      expect(body.counts.created).toBe(100_000);
      expect(body.errors).toEqual([{ row: 100_002, column: null, code: 'too_many_rows' }]);
      expect(await countImported(importId)).toBe(100_000);
      const last = await observer.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM contact WHERE import_job_id = $1 AND display_name = ANY ($2::text[])',
        [importId, ['zqm100001', 'zqm100002']],
      );
      expect(last.rows[0]?.n, 'row 100,001 imported and row 100,002 not').toBe('1');
    }, 1_200_000);

    it('field security is re-resolved at run: a field made read-only after mapping is field_not_editable per row, never written (R12)', async () => {
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv([['Name', 'Late'], ['zqf2', 'v'], ['zqf3', '']]));
      await readHeader(importId);
      await saveMapping(IMPORTER, importId, { columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'custom.late__c' }], defaultCountry: 'NG' });
      const job = await queueRun(IMPORTER, importId);
      await grant(id94('f00000000003'), 'admin', 'read');
      await (await importJobs()).processImportRun(deps(), job.data);
      const body = await getImport(IMPORTER, importId);
      expect(body.errors.map(errorKey)).toEqual(['2:1:field_not_editable']);
      const written = await observer.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM contact WHERE import_job_id = $1 AND custom ? 'late__c'`,
        [importId],
      );
      expect(written.rows[0]?.n).toBe('0');
    });

    it('no cell, header or filename in logs, telemetry, the job row, audit, queues or errors; the API answers only headers', async () => {
      // A number no fixture holds; checked in its national and E.164 digits.
      const phone = '0809 444 7171';
      const rows = [
        ['Name', `Given ${HEAD}`, 'Family', 'Company', 'Mobile', 'Email', 'Secretish'],
        [`${CELL}n1`, `${CELL}g1`, `${CELL}f1`, `${CELL}co1`, phone, `${CELL}m1@example.test`, `${CELL}s1`],
        [`${CELL}n2`, `${CELL}g2`, `${CELL}f2`, `${CELL}co2`, 'not a phone', `bad ${CELL}`, `${CELL}s2`],
        ['', `${CELL}g3`, '', '', '', '', ''],
      ];
      const columns = [
        { index: 0, field: 'displayName' },
        { index: 1, field: 'givenNames' },
        { index: 2, field: 'familyName' },
        { index: 3, field: 'companyName' },
        { index: 4, field: 'phones' },
        { index: 5, field: 'emails' },
        { index: 6, field: 'custom.late__c' },
      ];
      const started = new Date(Date.now() - 1000);
      let importId = '';
      const thrown: string[] = [];
      const lines = await captureEverything(async () => {
        importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv(rows));
        await readHeader(importId);
        await saveMapping(IMPORTER, importId, { columns, defaultCountry: 'NG' });
        const job = await queueRun(IMPORTER, importId);
        await (await importJobs()).processImportRun(deps(), job.data).catch((error: unknown) => {
          thrown.push(render(error));
        });
      });
      const body = await getImport(IMPORTER, importId);
      expect(body.counts.created, JSON.stringify(body.errors)).toBe(1);
      const leaks = (text: string) =>
        [CELL, HEAD, FILE, 'zqfile', '8094447171', '809 444 7171'].filter((marker) => text.includes(marker));
      expect(lines.flatMap((line) => leaks(line).map((m) => `${m} in: ${line.slice(0, 160)}`)), 'file content was logged').toEqual([]);
      // Signed part URLs are bearer credentials (D-L151): never logged.
      expect(lines.filter((line) => /X-Amz-Signature/i.test(line)), 'a signed part URL was logged').toEqual([]);
      expect(thrown.flatMap(leaks), 'a thrown error carries file content').toEqual([]);
      const job = await observer.query<{ row: string }>(
        `SELECT (to_jsonb(j) - 'headers' - 'filename' - 'mapping')::text AS row FROM import_job j WHERE id = $1`,
        [importId],
      );
      expect(leaks(job.rows[0]?.row ?? ''), 'the job row holds a cell').toEqual([]);
      const audit = await observer.query<{ row: string }>(
        `SELECT to_jsonb(a)::text AS row FROM audit_event a WHERE tenant_id = $1 AND occurred_at >= $2`,
        [TENANT_A, started],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
      expect(audit.rows.flatMap((r) => leaks(r.row)), 'the audit holds file content').toEqual([]);
      for (const name of QUEUES) {
        for (const queued of await jobsFor(name, importId)) {
          const text = JSON.stringify({ name: queued.name, data: queued.data, opts: queued.opts });
          expect(leaks(text), `${name} carries file content`).toEqual([]);
          expect(text).not.toMatch(/X-Amz-Signature|https?:\/\//i);
        }
      }
      const withoutHeaders = JSON.stringify({ ...body, headers: null, filename: null, mapping: null, suggestedMapping: null });
      expect(leaks(withoutHeaders), 'getImport carries a cell').toEqual([]);
    });
  });

  // =========================================================================
  // 8. Scope during the job: run as the creator, re-checked every batch.
  // =========================================================================

  describe('8. the creator’s scope and right, re-checked every batch', { timeout: FLOW_TIMEOUT }, () => {
    async function preparedRun(count: number, prefix: string) {
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv(nameRows(prefix, count)));
      await readHeader(importId);
      await saveMapping(IMPORTER, importId, { columns: [{ index: 0, field: 'displayName' }], defaultCountry: 'NG' });
      const job = await queueRun(IMPORTER, importId);
      return { importId, job };
    }

    it('a creator removed from the programme after queueing: the run creates nothing and the job is `failed` (R6)', async () => {
      const { importId, job } = await preparedRun(10, 'rmq');
      await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [USER_A_AGENT_1, PROGRAMME_A1]);
      await (await importJobs()).processImportRun(deps(), job.data).catch(() => undefined);
      expect(await countImported(importId)).toBe(0);
      expect((await jobRow(importId)).status).toBe('failed');
    });

    it('a creator removed from the programme between batches: `failed`, counts so far, nothing created after (R5, R6)', async () => {
      const { importId, job } = await preparedRun(2500, 'rmm');
      const jobs = await importJobs();
      const committed = await betweenBatches(
        importId,
        async () => {
          await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [USER_A_AGENT_1, PROGRAMME_A1]);
        },
        async () => {
          await jobs.processImportRun(deps(), job.data).catch(() => undefined);
        },
      );
      expect(committed).toBeLessThanOrEqual(1000);
      expect(await countImported(importId), 'contacts were created after the creator lost the programme').toBe(committed);
      const body = await getImport(SUPERVISOR, importId);
      expect(body.status).toBe('failed');
      expect(body.counts.created).toBe(committed);
    }, 180_000);

    it('a creator who loses contact.import between batches: `failed`, counts so far, nothing created after (R5, R6)', async () => {
      const { importId, job } = await preparedRun(2500, 'rmr');
      const jobs = await importJobs();
      const committed = await betweenBatches(
        importId,
        async () => {
          await assign(USER_A_AGENT_1, PROGRAMME_A1, 'agent');
        },
        async () => {
          await jobs.processImportRun(deps(), job.data).catch(() => undefined);
        },
      );
      expect(await countImported(importId)).toBe(committed);
      const body = await getImport(SUPERVISOR, importId);
      expect(body.status).toBe('failed');
      expect(body.counts.created).toBe(committed);
    }, 180_000);
  });

  // =========================================================================
  // 9. Retention.
  // =========================================================================

  describe('9. retention: the raw file, then headers, filename and mapping', { timeout: FLOW_TIMEOUT }, () => {
    it('an upload abandoned 24 hours: the job expires, the upload is aborted, the object row deleted, the filename cleared (R13)', async () => {
      const bytes = filler(MIN_PART + 1024);
      const upload = await createImport(IMPORTER, PROGRAMME_A1, bytes);
      await putParts(upload.parts, bytes, [1]);
      const before = await jobRow(upload.importId);
      const created = Date.parse((await getImport(IMPORTER, upload.importId)).createdAt);
      const job = await retentionJobWithDelay(upload.importId, DAY);
      await (await importJobs()).processImportRetention(deps(() => new Date(created + DAY + MINUTE)), job.data);
      const body = await getImport(IMPORTER, upload.importId);
      expectSchema('Import', body, 'expired import');
      expect(body.status).toBe('expired');
      expect(body.finishedAt).toEqual(expect.any(String));
      expect(body.rawFileDeletedAt).toEqual(expect.any(String));
      expect(body.filename).toBeNull();
      expect(await seaweed.listUploadDirectories()).not.toContain(before.upload_id);
      expect(await seaweed.listEntries(keyOf(before))).toEqual([]);
      expect((await storedObject(before.stored_object_id)).status).toBe('deleted');
    }, 60_000);

    it('a retention job that is not yet due changes nothing (the 24-hour job of a finished import; R13)', async () => {
      const { importId } = await importCsv(nameRows('nd', 2), [{ index: 0, field: 'displayName' }]);
      const job = await retentionJobWithDelay(importId, DAY);
      await (await importJobs()).processImportRetention(deps(), job.data);
      const row = await jobRow(importId);
      expect(row.raw_file_deleted_at).toBeNull();
      expect(row.filename).toBe(FILE);
      expect((await seaweed.listEntries(keyOf(row))).length).toBe(1);
    });

    it('7 days after the end: the object is gone, stored_object deleted, headers/filename/mapping cleared, counts and errors kept, `deleted` audited by the creator (R13)', async () => {
      const { importId, body: finished } = await importCsv(
        [['Name', `Mobile ${HEAD}`], ['zqt2', '0803 555 0101'], ['', '0803 555 0102']],
        [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }],
      );
      const before = await jobRow(importId);
      const job = await retentionJobWithDelay(importId, 7 * DAY);
      const due = Date.parse(must(finished.finishedAt, 'finishedAt')) + 7 * DAY + MINUTE;
      await (await importJobs()).processImportRetention(deps(() => new Date(due)), job.data);
      expect(await seaweed.listEntries(keyOf(before)), 'the raw file is still in the bucket').toEqual([]);
      expect((await storedObject(before.stored_object_id)).status).toBe('deleted');
      const after = await jobRow(importId);
      expect(after.raw_file_deleted_at).not.toBeNull();
      expect([after.headers, after.filename, after.mapping]).toEqual([null, null, null]);
      const body = await getImport(IMPORTER, importId);
      expectSchema('Import', body, 'erased import');
      expect(body).toMatchObject({ headers: null, filename: null, mapping: null, counts: finished.counts, errors: finished.errors });
      const listed = await get(IMPORTER, '/api/v1/imports');
      const summary = ((listed.body as { data: Json[] }).data ?? []).find((row) => row.id === importId);
      expect(summary?.filename).toBeNull();
      expect(summary?.rawFileDeletedAt).toEqual(expect.any(String));
      const audit = await observer.query<{ actor_kind: string; actor_user_id: string | null }>(
        `SELECT actor_kind, actor_user_id FROM audit_event WHERE tenant_id = $1 AND object_type = 'stored_object'
            AND object_id = $2 AND action = 'deleted'`,
        [TENANT_A, before.stored_object_id],
      );
      expect(audit.rows).toEqual([{ actor_kind: 'user', actor_user_id: USER_A_AGENT_1 }]);
      // Idempotent.
      await (await importJobs()).processImportRetention(deps(() => new Date(due + HOUR)), job.data);
      expect(await getImport(IMPORTER, importId)).toEqual(body);
    });

    it('after erasure, fromImportId is 400 unknown_reference, the same body as an import that never existed (D-L148)', async () => {
      const { importId, body: finished } = await importCsv([['Name'], ['zqe2']], [{ index: 0, field: 'displayName' }]);
      const job = await retentionJobWithDelay(importId, 7 * DAY);
      const due = Date.parse(must(finished.finishedAt, 'finishedAt')) + 7 * DAY + MINUTE;
      await (await importJobs()).processImportRetention(deps(() => new Date(due)), job.data);
      const next = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv([['Name'], ['zqe3']]));
      await readHeader(next);
      const erased = await put(IMPORTER, importPath(next, '/mapping'), { fromImportId: importId, defaultCountry: 'NG' });
      const never = await put(IMPORTER, importPath(next, '/mapping'), { fromImportId: NOWHERE, defaultCountry: 'NG' });
      expectDetail(erased, 400, 'validation_failed', 'unknown_reference', 'fromImportId', 'erased template');
      expect(erased.body).toEqual(never.body);
    });
  });

  // =========================================================================
  // 10. Reading: getImport and listImports.
  // =========================================================================

  describe('10. getImport and listImports', { timeout: FLOW_TIMEOUT }, () => {
    it('listImports: newest first, keyset by cursor and limit, ImportPage, no-store, only programmes where the caller imports', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) ids.push((await createImport(IMPORTER, PROGRAMME_A1, csv([['Name'], [`zq${i}`]]))).importId);
      const a2 = (await createImport(SUPERVISOR, PROGRAMME_A2, csv([['Name'], ['zqa2']]))).importId;
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const response = await get(IMPORTER, `/api/v1/imports?limit=1${cursor === null ? '' : `&cursor=${enc(cursor)}`}`);
        expect(response.status, response.text).toBe(200);
        expectNoStore(response, 'listImports');
        expectSchema('ImportPage', response.body, 'listImports');
        const body = response.body as { data: Json[]; nextCursor: string | null };
        seen.push(...body.data.map((row) => String(row.id)));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual([...ids].reverse());
      expect(seen).not.toContain(a2);
      const supervisor = await get(SUPERVISOR, '/api/v1/imports?limit=50');
      expect(((supervisor.body as { data: Json[] }).data ?? []).map((row) => row.id)).toEqual(expect.arrayContaining([...ids, a2]));
    });

    it('getImport: an import id the caller cannot reach is the same 404 as one that does not exist; a non-uuid is 400', async () => {
      const upload = await createImport(SUPERVISOR, PROGRAMME_A2, csv([['Name'], ['zqa']]));
      const unknown = await get(IMPORTER, importPath(NOWHERE));
      const sibling = await get(IMPORTER, importPath(upload.importId));
      expectError(unknown, 404, 'not_found', 'unknown import');
      expectError(sibling, 404, 'not_found', 'sibling programme import');
      expect(sibling.body).toEqual(unknown.body);
      expectNoStore(sibling, 'getImport 404');
      expectError(await get(IMPORTER, importPath('not-a-uuid')), 400, 'validation_failed', 'non-uuid import id');
    });
  });

  // =========================================================================
  // 11. The duplicate scan at the T-0084 size.
  // =========================================================================

  describe('11. the duplicate scan at 120,000 contacts (D-P33, D-L146)', () => {
    const SEED_SQL = `
      INSERT INTO contact (id, tenant_id, programme_id, display_name, phones, emails, created_at, updated_at)
      SELECT ('11111111-0094-4000-8001-' || lpad(i::text, 12, '0'))::uuid, $1::uuid,
             CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
             'seed ' || substr(md5('n' || i), 1, 10),
             jsonb_build_array(jsonb_build_object('type', 'mobile', 'e164', '+23490' || lpad(i::text, 8, '0'))),
             jsonb_build_array('p' || i || '@seed.example.test'),
             timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => i),
             timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => i)
        FROM generate_series(1, 120000) AS i`;

    it('finds a match on the first and the last page, ignores the other programme, and every scan statement is within budget', async () => {
      // Parse-time first, so this fails on main for the real reason, not after seeding.
      await importJobs();
      await observer.query(SEED_SQL, [TENANT_A, PROGRAMME_A1, PROGRAMME_A2]);
      await observer.query('ANALYZE contact');
      const rows: string[][] = [
        ['Name', 'Mobile', 'Email'],
        // i = 2 (A1, the first page) and i = 119,998 (A1, the last page), as national numbers.
        ['zqs2', '09000000002', ''],
        ['zqs3', '09000119998', ''],
        ['zqs4', '', 'P60000@SEED.Example.Test'],
        ['zqs5', '09000000003', ''],
        ...Array.from({ length: 16 }, (_, i) => [`zqs${i + 6}`, `0807777${String(i).padStart(4, '0')}`, '']),
      ];
      const importId = await uploadAndComplete(IMPORTER, PROGRAMME_A1, csv(rows));
      await readHeader(importId);
      await saveMapping(IMPORTER, importId, {
        columns: [{ index: 0, field: 'displayName' }, { index: 1, field: 'phones' }, { index: 2, field: 'emails' }],
        defaultCountry: 'NG',
      });
      const job = await queueRun(IMPORTER, importId);
      const jobs = await importJobs();
      let elapsed = 0;
      const recorded = await recordStatements(async () => {
        const t0 = performance.now();
        await jobs.processImportRun(deps(), job.data);
        elapsed = performance.now() - t0;
      });
      const body = await getImport(IMPORTER, importId);
      expect(body.counts).toEqual({ created: 17, skipped: 3, failed: 0 });
      expect(body.errors.map(errorKey)).toEqual(['2:null:possible_duplicate', '3:null:possible_duplicate', '4:null:possible_duplicate']);
      expect(elapsed, 'the whole run').toBeLessThanOrEqual(RUN_BUDGET_MS);
      const scans = recorded.filter(
        (s) => /^\s*(select|with)\b/i.test(s.text) && /\bfrom\s+(public\.)?"?contact"?\b/i.test(s.text) && !/\b(insert|update|delete)\b/i.test(s.text),
      );
      expect(scans.length, 'no SELECT from contact was recorded: the scan is not a keyset SELECT').toBeGreaterThan(0);
      for (const scan of scans) expect(scan.text, 'a scan pages by OFFSET').not.toMatch(/\boffset\b/i);
      for (const scan of scans) {
        let best = Number.POSITIVE_INFINITY;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const plan = await withTenantTransaction(workerPool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) =>
            tx.query<{ 'QUERY PLAN': { 'Execution Time': number }[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${scan.text}`, scan.values),
          );
          best = Math.min(best, Number(plan[0]?.['QUERY PLAN'][0]?.['Execution Time'] ?? Number.POSITIVE_INFINITY));
        }
        expect(best, `scan statement over ${PAGE_BUDGET_MS} ms: ${scan.text.slice(0, 200)}`).toBeLessThanOrEqual(PAGE_BUDGET_MS);
      }
    }, 600_000);
  });

  // =========================================================================
  // Self-checks: the checkers, against planted defects.
  // =========================================================================

  describe('self-checks', () => {
    it('the schema checker refuses a row error with a value, and the too_many_rows row number (self-check)', () => {
      expect(schemaErrors('ImportRowError', { row: 2, column: 0, code: 'required' })).toEqual([]);
      expect(schemaErrors('ImportRowError', { row: 2, column: 0, code: 'required', value: 'x' })).not.toEqual([]);
      expect(schemaErrors('ImportRowError', { row: 2, column: 0, code: 'bad_code' })).not.toEqual([]);
      // R7's defect, recorded: the contract cannot hold row 100,002 today.
      expect(schemaErrors('ImportRowError', { row: 100_002, column: null, code: 'too_many_rows' })).not.toEqual([]);
    });

    it('csv() quotes commas, quotes and newlines, and the BOM option prefixes U+FEFF (self-check)', () => {
      expect(csv([['a,b', 'c"d', 'e\nf']]).toString('utf8')).toBe('"a,b","c""d","e\nf"\n');
      expect(csv([['x']], { bom: true }).toString('utf8').charCodeAt(0)).toBe(0xfeff);
    });
  });
});
