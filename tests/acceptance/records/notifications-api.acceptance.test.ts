import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import * as db from '@kasuwa/db';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import * as domainCore from '@kasuwa/domain-core';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0100, notifications: the `notification` table, the four
 * producers, the outbox consumer and the read API (Agent 1; ADR-0018, D-P29,
 * D-P23, D-L87, D-L134, D-L146, D-L154, D-L156, D-L157, D-L161).
 *
 * Written by Agent 12 (QA) for the lead before the build (D-L23, D-L25), from
 * the task file, the decisions and the merged contract (records.openapi.yaml,
 * pinned by platform/records-contract-notifications R1–R16), not from an
 * implementation (none exists). Its tenancy half (forged and replayed jobs
 * against the REAL handler, raw SQL against the table) is section 5 of
 * tests/acceptance/tenancy/outbox-forgery.acceptance.test.ts.
 *
 * Driven through real Postgres (RLS, kasuwa_app), the real API (in process),
 * and the real relay and consumer helper exported by @kasuwa/db
 * (relayOutboxBatch with a recording queue port, then consumeOutboxJob bound
 * to `kasuwa.events.notifications`). Section 10 boots the real worker process
 * against the harness's real Redis, end to end.
 *
 * ==========================================================================
 * PINNED INTERFACES (everything else is the builder's)
 * ==========================================================================
 *
 *   I1. `handleNotificationEvent(tx, event)` exported from
 *       @kasuwa/domain-core: the notifications OutboxHandler. It is what
 *       apps/worker registers with
 *       `outboxConsumerProcessor(consumeOutboxJob, appPool,
 *       'kasuwa.events.notifications', handleNotificationEvent, write)`
 *       (D-L161). This suite calls `consumeOutboxJob(appPool, data,
 *       handleNotificationEvent, { queue: 'kasuwa.events.notifications' })`.
 *       Its return value is not pinned. A duplicate delivery must RESOLVE
 *       (handled), never reject: a rejection is retried five times and then
 *       parked in the failed set (see the ON CONFLICT finding under I3).
 *
 *   I2. EVENT TYPES, each registered in @kasuwa/db's OUTBOX_EVENT_SCHEMAS,
 *       routed to `kasuwa.events.notifications`, and re-exported from
 *       @kasuwa/domain-core as the SAME object (ADR-0018 point 9; the T-0098
 *       ContactOwnerChangedPayload precedent):
 *         contact.owner_changed  aggregate contact   ContactOwnerChangedPayload
 *                                { contactId, previousOwnerId, newOwnerId }
 *         account.owner_changed  aggregate account   AccountOwnerChangedPayload
 *                                { accountId, previousOwnerId, newOwnerId }
 *         deal.owner_changed     aggregate deal      DealOwnerChangedPayload
 *                                { dealId, previousOwnerId, newOwnerId }
 *         activity.assigned      aggregate activity  ActivityAssignedPayload
 *                                { activityId, previousOwnerId, newOwnerId }
 *       Strict; every value a lower-case uuid, the two owner ids nullable.
 *       `import.finished` is NOT pinned: T-0094 had not merged when this
 *       suite was written (task file: "left out and becomes a follow-up").
 *
 *   I3. TABLE `notification`, exactly the columns
 *         id, tenant_id, programme_id, recipient_user_id, kind, object_type,
 *         object_id, actor_user_id, source_event_id, created_at, read_at
 *       (uuid ids, timestamptz times), every one NOT NULL except read_at.
 *       `kind` and `object_type` hold the contract's codes
 *       (NotificationKind, NotificationObjectType) and nothing else.
 *       RLS ENABLED and FORCED; in TENANT_SCOPED_TABLES; a permissive policy
 *       TO kasuwa_app whose WITH CHECK is identical to its USING (tenant and
 *       programme); restrictive SELECT and UPDATE policies limiting rows to
 *       `recipient_user_id = app.current_user_id()` (D-L157); INSERT is not
 *       recipient-restricted (the consumer inserts as the actor). kasuwa_app
 *       holds INSERT, SELECT and UPDATE (read_at) only: no DELETE, no
 *       TRUNCATE, no UPDATE of any other column. UNIQUE (source_event_id,
 *       recipient_user_id).
 *       UNWORKABLE AS THE TASK FILE WROTE IT: "inserted with ON CONFLICT DO
 *       NOTHING ... needs no SELECT policy on the conflict path" is false
 *       once the restrictive recipient SELECT policy exists. INSERT ... ON
 *       CONFLICT requires SELECT, so PostgreSQL also checks the NEW row
 *       against the SELECT policies, and the actor (who is not the
 *       recipient) is refused 42501 on the FIRST insert, not only on a
 *       conflict. Proven before commit on a scratch table with exactly I3's
 *       policies; with the restrictive SELECT policy removed, the same
 *       statement commits. The suite therefore pins the invariant (one row
 *       per event and recipient; a duplicate never lands; the actor never
 *       reads the row), not the statement. A workable shape: plain INSERT
 *       inside a SAVEPOINT, treating 23505 on that key as "already
 *       delivered". Widening the SELECT policy to admit the actor would hand
 *       actors read receipts (read_at) and is refused by section 1.
 *       The migration's file name and number are the builder's (the task
 *       projected 0044; numbers are assigned in merge order, D-L146).
 *
 *   I4. ROUTES, as the contract (listNotifications, getNotificationUnreadCount,
 *       updateNotification, markAllNotificationsRead), each flipped to
 *       `x-kasuwa-implemented: true` (the lead edit to the contract suite is
 *       on this branch).
 *
 * ==========================================================================
 * RULINGS (this suite's, for the lead to accept or overrule; N-numbers are
 * not decision ids)
 * ==========================================================================
 *
 *   N-R1  THE GATE. The consumer writes a notification only when, re-read now
 *         under RLS within the event's programme (D-L156), the aggregate
 *         exists there AND its current owner equals the payload's
 *         `newOwnerId`. The recipient always comes from the row (D-L161:
 *         current state, never the payload); the payload only GATES. Without
 *         the gate a stale event misattributes: change 1 (by X, to R1) and
 *         change 2 (by Y, to R2), consumed after both commit, would tell R2
 *         "X assigned you this". With it, R1 gets nothing (no longer the
 *         owner), R2 gets one notification, from Y. The gate also defeats a
 *         raw-SQL event that names a newOwnerId who is not the owner.
 *   N-R2  WHO IS NEVER NOTIFIED. The actor (self-assignment); nobody, when the
 *         owner is cleared (D-P23 unassignment, by PATCH or by a membership
 *         removal); a recipient who is not a member of the object's programme
 *         now; a recipient who cannot read the object now (D-L157, judged on
 *         the recipient's own rights, e.g. a deal owner whose set became
 *         `client_portal`, which does not read deals, D-L115); a re-sent
 *         owner that is already in place (no change).
 *   N-R3  THE OWNER FIELD (beyond the task file). When field security
 *         withholds `owner_user_id` from the recipient in the object's
 *         programme, nothing is written. "You were assigned X" tells the
 *         reader who owns X, which the record itself withholds from them
 *         (D-L115: for a deal "the answer never tells who owns a deal").
 *   N-R4  CREATES ARE ASSIGNMENTS. Creating a contact, account, deal or
 *         activity with an owner other than the caller appends the same
 *         event as a change (previousOwnerId null) and notifies the owner. A
 *         task created for someone else is the main "task_assigned" case in
 *         P26. A create owned by the caller, or by nobody, notifies nobody.
 *   N-R5  RAW SQL CANNOT WRITE A NOTIFICATION AS SOMEONE ELSE. A restrictive
 *         `FOR INSERT TO kasuwa_app` policy binds `actor_user_id` to
 *         app.current_user_id(), as F-R3 did for outbox_event (D-L156): the
 *         consumer inserts as the event's actor, so it is unaffected. A
 *         recipient in another tenant is refused by the database (the
 *         composite-FK convention). Pinned in the tenancy file.
 *   N-R6  THE UNREAD BOUND, FROM BOTH SIDES. The count examines exactly the
 *         500 newest unread (D-L157 and the contract; the task file's "100"
 *         is superseded): with 495 invisible newest and visible ones beneath,
 *         the count is 5. Fewer examined would answer less, more examined
 *         would answer more.
 *   N-R7  PATCH 404 is byte-identical to getContact's 404 for an invented id
 *         (the contract: "Identical to NotFound").
 *   N-R8  THROTTLE (D-L134, D-L157 "allows for several visible windows").
 *         Per user and per operation, measured as requests admitted in a
 *         burst before the first 429: getNotificationUnreadCount and
 *         listNotifications each admit THROTTLE_MIN..THROTTLE_MAX. A
 *         throttled caller gets 429 even for a malformed request (decided
 *         before validation). Another user is unaffected. No test in this
 *         file sends more than 40 requests of one operation as one user, so
 *         the floor never trips another test.
 *   N-R9  THE WORKER. Booted with both roles against real Redis, apps/worker
 *         consumes `kasuwa.events.notifications`: an owner change made through
 *         the API becomes a notification row with no further help, and the
 *         worker's output carries no name, email or object id.
 *
 * ==========================================================================
 * NOT PINNED, AND WHY (honest gaps)
 * ==========================================================================
 *   - "Append after the row lock" (D-L161 contract point 1) has no
 *     behavioural test here: the API offers no way to interleave two owner
 *     changes on one record inside the window between seq assignment and
 *     COMMIT without an injection hook. The order of two successive changes
 *     is pinned (section 2), which a missing lock does not break. The
 *     migration reviewer should read the producer diff for the lock.
 *   - `import.finished` and "an import of N rows yields one notification":
 *     T-0094 had not merged. Follow-up.
 *   - "A contact merged away is dropped" (D-L157): T-0095 had not merged. The
 *     drop rule is pinned through the object's own read path (programme left,
 *     rights lost, object gone), which is the mechanism D-L157 names.
 *   - A raw-SQL outbox event that names the actor itself, about a record
 *     whose owner really is R, still yields "actor assigned you R's record"
 *     although no change happened. The gate (N-R1) cannot tell a forged
 *     event from a real one when every value matches. It needs code execution
 *     as kasuwa_app, where worse is possible; recorded, not pinned.
 *
 * Fixtures: packages/db/src/fixtures.ts (tenants, programmes, permission sets,
 * the supervisor as the usual actor) plus rows planted by kasuwa_migrator
 * with ids in this suite's range 11111111-0000-4000-8000-0100xxxxxxxx. Every
 * planted name is synthetic (Sample, Fixture, or a `Zqn` marker). The suite
 * reseeds after every test.
 *
 * D-L23: on main there is no table, no handler, no event type beyond
 * contact.owner_changed and no route. Every test fails for one of those
 * reasons; the self-check at the top passes on main by design and says so.
 */

const SUITE_APP_NAME = 'acceptance-t0100';
const NOTIFICATIONS_QUEUE = 'kasuwa.events.notifications';
const UNREAD_BOUND = 500;
const THROTTLE_MIN = 60;
const THROTTLE_MAX = 600;

const BASE = '/api/v1/notifications';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NOTIFICATION_KEYS = [
  'actor',
  'createdAt',
  'id',
  'kind',
  'objectDisplayName',
  'objectId',
  'objectType',
  'readAt',
];
const COLUMNS = [
  'actor_user_id',
  'created_at',
  'id',
  'kind',
  'object_id',
  'object_type',
  'programme_id',
  'read_at',
  'recipient_user_id',
  'source_event_id',
  'tenant_id',
];

type Json = Record<string, unknown>;
type Headers = Record<string, string>;

// ---------------------------------------------------------------------------
// Ids: `0100` marks T-0100; a hex kind digit (a account, b activity, c
// contact, d deal, e user, 9 notification; f is the fixed tie-break ids) and
// a counter that never resets.
// ---------------------------------------------------------------------------

let counter = 0;
const nextId = (kind: 'a' | 'b' | 'c' | 'd' | 'e' | '9') =>
  `11111111-0000-4000-8000-0100${kind}${(counter += 1).toString(16).padStart(7, '0')}`;

/**
 * A unique alphabetic word per call. Names never embed an id fragment: a
 * "did the withheld name leak" check would otherwise match the object's id.
 */
let words = 0;
function word(): string {
  let n = (words += 1);
  let out = '';
  while (n > 0) {
    out = String.fromCharCode(97 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  // Fixed length, so no word is a prefix of another.
  return `Zqw${out.padStart(4, 'a')}`;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function permissionSet(tenantId: string, key: string): string {
  return must(
    SEED_PERMISSION_SETS.find((set) => set.tenantId === tenantId && set.key === key),
    `no seeded permission set '${key}' in ${tenantId}`,
  ).id;
}

const SUPERVISOR = must(
  SEED_TENANTS.flatMap((tenant) => tenant.users).find((user) => user.id === USER_A_SUPERVISOR),
  'the seeded supervisor',
);

// ---------------------------------------------------------------------------
// The pinned exports, resolved at call time so the file collects on main.
// ---------------------------------------------------------------------------

interface OutboxJob {
  name: string;
  data: unknown;
  opts?: Record<string, unknown>;
}
type RelayOutboxBatch = (
  pool: Pool,
  options: {
    queues: Readonly<Record<string, { addBulk: (jobs: readonly OutboxJob[]) => Promise<unknown> }>>;
    batchSize: number;
  },
) => Promise<unknown>;
interface ConsumeOutcome {
  outcome: string;
  reason?: string;
  detail?: string;
  value?: unknown;
}
type Handler = (tx: TenantTx, event: Json) => Promise<unknown>;
type ConsumeOutboxJob = (
  pool: Pool,
  data: unknown,
  handler: Handler,
  options?: { queue?: string },
) => Promise<ConsumeOutcome>;

function dbExport<T>(name: string): T {
  const candidate: unknown = (db as Record<string, unknown>)[name];
  if (typeof candidate !== 'function') throw new Error(`T-0098: @kasuwa/db does not export ${name}`);
  return candidate as T;
}

function notificationHandler(): Handler {
  const candidate: unknown = (domainCore as Record<string, unknown>).handleNotificationEvent;
  if (typeof candidate !== 'function') {
    throw new Error('T-0100 I1: @kasuwa/domain-core does not export handleNotificationEvent');
  }
  return candidate as Handler;
}

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean };
}

function registeredSchema(eventType: string): SchemaLike {
  const registry: unknown = (db as Record<string, unknown>).OUTBOX_EVENT_SCHEMAS;
  const schema: unknown =
    typeof registry === 'object' && registry !== null
      ? (registry as Record<string, unknown>)[eventType]
      : undefined;
  if (typeof schema !== 'object' || schema === null || typeof (schema as SchemaLike).safeParse !== 'function') {
    throw new Error(`T-0100 I2: OUTBOX_EVENT_SCHEMAS has no ${eventType}`);
  }
  return schema as SchemaLike;
}

/** Every leaf string of a JSON value, with its path. */
function leafStrings(value: unknown, path = ''): { path: string; value: string }[] {
  if (typeof value === 'string') return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => leafStrings(item, `${path}[${index}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => leafStrings(child, path === '' ? key : `${path}.${key}`));
  }
  return [];
}

/** Leaves that are not a lower-case uuid. Numbers and booleans count too. */
function nonIdLeaves(value: unknown, path = ''): string[] {
  if (value === null) return [];
  if (typeof value === 'string') return UUID.test(value) ? [] : [`${path}=${JSON.stringify(value)}`];
  if (Array.isArray(value)) return value.flatMap((item, index) => nonIdLeaves(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    return Object.entries(value as Json).flatMap(([key, child]) => nonIdLeaves(child, path === '' ? key : `${path}.${key}`));
  }
  return [`${path}=${JSON.stringify(value)}`];
}

// ---------------------------------------------------------------------------
// Log capture: every channel (the former-owner suite's approach).
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

async function captureEverything(work: () => Promise<void>): Promise<string> {
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
  let telemetry: Telemetry;
  try {
    telemetry = await collectTelemetry(work);
  } finally {
    for (const spy of spies) spy.mockRestore();
    captureLines = null;
  }
  return [...lines, ...telemetry.logs.map(render), ...telemetry.spans.map(render)].join('\n');
}

// ===========================================================================

describe('acceptance: notifications — table, producers, consumer and read API (T-0100)', () => {
  let app: INestApplication;
  /** kasuwa_app: the API's and the worker's role. RLS applies. */
  let appPool: Pool;
  /** kasuwa_migrator: BYPASSRLS. Plants and observes; never serves. */
  let observer: Pool;
  /** kasuwa_relay, for relayOutboxBatch. */
  let relay: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 }))],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 4, applicationName: SUITE_APP_NAME });
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3, applicationName: SUITE_APP_NAME });
    relay = createPool({ connectionString: inject('relayDatabaseUrl'), max: 2, applicationName: SUITE_APP_NAME });
  });

  afterAll(async () => {
    await app?.close();
    await relay?.end();
    await appPool?.end();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  beforeEach(async () => {
    await observer.query('DELETE FROM outbox_event');
    // Reseed clears it through the tenant cascade once the table has its FKs;
    // this keeps one test's rows from another's either way. Absent on main.
    await observer.query('DELETE FROM notification').catch(() => undefined);
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  const http = () => request(app.getHttpServer());

  // --- planting (kasuwa_migrator) -------------------------------------------

  interface FreshUser {
    id: string;
    displayName: string;
    email: string;
    headers: Headers;
  }

  async function freshUser(
    memberships: readonly (readonly [string, string])[],
    tenantId = TENANT_A,
  ): Promise<FreshUser> {
    const id = nextId('e');
    const displayName = `Zqn Fixture User ${word()}`;
    const email = `t0100.${id.slice(-8)}@example.test`;
    await observer.query(
      `INSERT INTO "user" (id, tenant_id, email, display_name, is_tenant_admin) VALUES ($1, $2, $3, $4, false)`,
      [id, tenantId, email, displayName],
    );
    for (const [programmeId, set] of memberships) {
      await observer.query(
        `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id) VALUES ($1, $2, $3, $4)`,
        [id, programmeId, tenantId, permissionSet(tenantId, set)],
      );
    }
    return { id, displayName, email, headers: asUser(tenantId, id) };
  }

  const agentIn = (programmeId = PROGRAMME_A1) => freshUser([[programmeId, 'agent']]);
  const supervisorHeaders = asUser(TENANT_A, USER_A_SUPERVISOR);

  async function plantContact(programmeId = PROGRAMME_A1, ownerUserId: string | null = null, tenantId = TENANT_A): Promise<{ id: string; displayName: string }> {
    const id = nextId('c');
    const family = `Sample ${word()}`;
    const displayName = `Zqncontact ${family}`;
    await observer.query(
      `INSERT INTO contact (id, tenant_id, programme_id, display_name, given_names, family_name, owner_user_id)
       VALUES ($1, $2, $3, $4, 'Zqncontact', $5, $6)`,
      [id, tenantId, programmeId, displayName, family, ownerUserId],
    );
    return { id, displayName };
  }

  async function plantAccount(programmeId = PROGRAMME_A1, ownerUserId: string | null = null): Promise<{ id: string; name: string }> {
    const id = nextId('a');
    const name = `Zqnaccount Sample ${word()}`;
    await observer.query(
      'INSERT INTO account (id, tenant_id, programme_id, name, owner_user_id) VALUES ($1, $2, $3, $4, $5)',
      [id, TENANT_A, programmeId, name, ownerUserId],
    );
    return { id, name };
  }

  async function pipelineOf(programmeId: string): Promise<{ pipeline: string; stage: string }> {
    const found = await observer.query<{ pipeline: string; stage: string }>(
      `SELECT p.id AS pipeline, s.id AS stage
         FROM pipeline p
         JOIN pipeline_stage s ON s.tenant_id = p.tenant_id AND s.programme_id = p.programme_id AND s.pipeline_id = p.id
        WHERE p.tenant_id = $1 AND p.programme_id = $2 AND s.kind = 'open'
        ORDER BY p.created_at, p.id, s.position
        LIMIT 1`,
      [TENANT_A, programmeId],
    );
    return must(found.rows[0], `no pipeline with an open stage in ${programmeId}`);
  }

  async function plantDeal(programmeId = PROGRAMME_A1, ownerUserId: string | null = null): Promise<{ id: string; name: string }> {
    const id = nextId('d');
    const name = `Zqndeal Sample ${word()}`;
    const { pipeline, stage } = await pipelineOf(programmeId);
    await observer.query(
      `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, TENANT_A, programmeId, pipeline, stage, name, ownerUserId],
    );
    return { id, name };
  }

  async function plantActivity(programmeId = PROGRAMME_A1, ownerUserId: string | null = null): Promise<{ id: string; subject: string }> {
    const account = await plantAccount(programmeId);
    const id = nextId('b');
    const subject = `Zqntask Sample ${word()}`;
    await observer.query(
      `INSERT INTO activity (id, tenant_id, programme_id, type, subject, account_id, owner_user_id, created_by_user_id)
       VALUES ($1, $2, $3, 'task', $4, $5, $6, $7)`,
      [id, TENANT_A, programmeId, subject, account.id, ownerUserId, USER_A_SUPERVISOR],
    );
    return { id, subject };
  }

  /** One field-security decision in tenant A against the standard field_def. */
  async function withholdField(objectApiName: 'contact' | 'account' | 'deal' | 'activity', field: string, setKey: string): Promise<void> {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3 AND NOT o.is_custom AND NOT f.is_custom`,
      [TENANT_A, objectApiName, field],
    );
    const fieldId = must(found.rows[0]?.id, `no standard field_def ${objectApiName}.${field}`);
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, 'none')
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey)],
    );
  }

  interface NotificationPlant {
    recipient: string;
    objectId: string;
    objectType?: 'contact' | 'account' | 'deal' | 'activity';
    kind?: 'record_assigned' | 'task_assigned';
    programmeId?: string;
    tenantId?: string;
    actor?: string;
    /** Seconds before now. Larger is older. */
    ageSeconds?: number;
    /** An exact time instead of ageSeconds. */
    createdAt?: string;
    read?: boolean;
    id?: string;
  }

  async function plantNotification(row: NotificationPlant): Promise<string> {
    const id = row.id ?? nextId('9');
    const objectType = row.objectType ?? 'contact';
    await observer.query(
      `INSERT INTO notification (id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id,
                                 actor_user_id, source_event_id, created_at, read_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               COALESCE($10::timestamptz, now() - make_interval(secs => $11::int)),
               CASE WHEN $12::boolean THEN now() ELSE NULL END)`,
      [
        id,
        row.tenantId ?? TENANT_A,
        row.programmeId ?? PROGRAMME_A1,
        row.recipient,
        row.kind ?? (objectType === 'activity' ? 'task_assigned' : 'record_assigned'),
        objectType,
        row.objectId,
        row.actor ?? USER_A_SUPERVISOR,
        randomUUID(),
        row.createdAt ?? null,
        row.ageSeconds ?? 0,
        row.read ?? false,
      ],
    );
    return id;
  }

  interface NotificationRow {
    id: string;
    tenant_id: string;
    programme_id: string;
    recipient_user_id: string;
    kind: string;
    object_type: string;
    object_id: string;
    actor_user_id: string;
    source_event_id: string;
    read_at: Date | null;
  }

  async function rowsFor(where: { recipient?: string; objectId?: string }): Promise<NotificationRow[]> {
    const result = await observer.query<NotificationRow>(
      `SELECT id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id, actor_user_id,
              source_event_id, read_at
         FROM notification
        WHERE ($1::uuid IS NULL OR recipient_user_id = $1) AND ($2::uuid IS NULL OR object_id = $2)
        ORDER BY created_at, id`,
      [where.recipient ?? null, where.objectId ?? null],
    );
    return result.rows;
  }

  async function allNotificationRows(): Promise<number> {
    const result = await observer.query<{ n: number }>('SELECT count(*)::int AS n FROM notification');
    return result.rows[0]?.n ?? -1;
  }

  interface OutboxRow {
    id: string;
    seq: string;
    tenant_id: string;
    programme_id: string;
    actor_user_id: string;
    event_type: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: Json;
  }

  async function outboxFor(aggregateId: string): Promise<OutboxRow[]> {
    const result = await observer.query<OutboxRow>(
      `SELECT id, seq::text AS seq, tenant_id, programme_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload
         FROM outbox_event WHERE aggregate_id = $1 ORDER BY seq`,
      [aggregateId],
    );
    return result.rows;
  }

  // --- the relay and the consumer --------------------------------------------

  /** Runs the real relay once into a recording port; returns the envelopes. */
  async function relayOnce(): Promise<Json[]> {
    const jobs: OutboxJob[] = [];
    await dbExport<RelayOutboxBatch>('relayOutboxBatch')(relay, {
      queues: {
        [NOTIFICATIONS_QUEUE]: {
          addBulk: async (batch) => {
            jobs.push(...batch);
            return batch;
          },
        },
      },
      batchSize: 100,
    });
    return jobs.map((job) => JSON.parse(JSON.stringify(job.data)) as Json);
  }

  async function consume(data: unknown): Promise<ConsumeOutcome> {
    return dbExport<ConsumeOutboxJob>('consumeOutboxJob')(appPool, data, notificationHandler(), {
      queue: NOTIFICATIONS_QUEUE,
    });
  }

  /**
   * Relays and consumes until the outbox is drained (a later event of one
   * aggregate is only claimed once the earlier one is published). Every
   * genuine job must be HANDLED: a drop here means the consumer never ran
   * the handler, and every "nothing was written" assertion would be vacuous.
   */
  async function pump(): Promise<Json[]> {
    const delivered: Json[] = [];
    for (let round = 0; round < 6; round += 1) {
      const envelopes = await relayOnce();
      if (envelopes.length === 0) break;
      for (const envelope of envelopes) {
        const outcome = await consume(envelope);
        expect(outcome, `a genuine ${String(envelope.eventType)} job was not handled`).toMatchObject({ outcome: 'handled' });
        delivered.push(envelope);
      }
    }
    return delivered;
  }

  // --- the API ---------------------------------------------------------------

  function expectNoStore(response: request.Response, where: string): void {
    expect(String(response.headers['cache-control']), `${where}: Cache-Control`).toBe('no-store');
  }

  async function listRaw(headers: Headers, query: Record<string, string> = {}): Promise<request.Response> {
    return http().get(BASE).query(query).set(headers);
  }

  async function list(headers: Headers, query: Record<string, string> = {}): Promise<{ data: Json[]; nextCursor: string | null }> {
    const response = await listRaw(headers, query);
    expect(response.status, `listNotifications: ${response.text.slice(0, 300)}`).toBe(200);
    expectNoStore(response, 'listNotifications');
    const body = response.body as Json;
    expect(Object.keys(body).sort()).toEqual(['data', 'nextCursor']);
    const data = body.data as Json[];
    for (const item of data) {
      expect(Object.keys(item).sort(), 'a Notification is closed').toEqual(NOTIFICATION_KEYS);
      expect(Object.keys(item.actor as Json).sort(), 'NotificationActor is closed').toEqual(['displayName', 'id']);
    }
    return { data, nextCursor: body.nextCursor as string | null };
  }

  /** Every visible item, following nextCursor to the end. */
  async function listAll(headers: Headers, query: Record<string, string> = {}): Promise<Json[]> {
    const out: Json[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 30; page += 1) {
      const result = await list(headers, cursor === null ? query : { ...query, cursor });
      out.push(...result.data);
      cursor = result.nextCursor;
      if (cursor === null) return out;
    }
    throw new Error('more than 30 pages');
  }

  async function unread(headers: Headers): Promise<Json> {
    const response = await http().get(`${BASE}/unread-count`).set(headers);
    expect(response.status, `getNotificationUnreadCount: ${response.text.slice(0, 300)}`).toBe(200);
    expectNoStore(response, 'getNotificationUnreadCount');
    return response.body as Json;
  }

  async function patchRaw(headers: Headers, id: string, body: unknown): Promise<request.Response> {
    return http().patch(`${BASE}/${id}`).set(headers).send(body as object);
  }

  async function readAllRaw(headers: Headers, body: unknown): Promise<request.Response> {
    return http().post(`${BASE}/read-all`).set(headers).send(body as object);
  }

  async function versionOf(path: string): Promise<number> {
    const response = await http().get(path).set(supervisorHeaders);
    expect(response.status, `GET ${path}: ${response.text.slice(0, 200)}`).toBe(200);
    return must((response.body as { version?: number }).version, `${path} has no version`);
  }

  const PATHS = {
    contact: (id: string) => `/api/v1/contacts/${id}`,
    account: (id: string) => `/api/v1/accounts/${id}`,
    deal: (id: string) => `/api/v1/deals/${id}`,
    activity: (id: string) => `/api/v1/activities/${id}`,
  } as const;
  type ObjectType = keyof typeof PATHS;

  /** Sets the owner through the real update route; the control asserts 200. */
  async function assign(
    objectType: ObjectType,
    id: string,
    ownerUserId: string | null,
    headers: Headers = supervisorHeaders,
    version?: number,
  ): Promise<request.Response> {
    const current =
      version ??
      (objectType === 'activity'
        ? must(
            (await observer.query<{ version: number }>('SELECT version FROM activity WHERE id = $1', [id])).rows[0]?.version,
            'activity version',
          )
        : await versionOf(PATHS[objectType](id)));
    return http().patch(PATHS[objectType](id)).set(headers).send({ version: current, ownerUserId });
  }

  async function assignOk(objectType: ObjectType, id: string, ownerUserId: string | null, headers: Headers = supervisorHeaders): Promise<void> {
    const response = await assign(objectType, id, ownerUserId, headers);
    expect(response.status, `control: the ${objectType} owner change was refused: ${response.text.slice(0, 300)}`).toBe(200);
  }

  async function plantObject(objectType: ObjectType, ownerUserId: string | null = null, programmeId = PROGRAMME_A1): Promise<{ id: string; name: string }> {
    switch (objectType) {
      case 'contact': {
        const contact = await plantContact(programmeId, ownerUserId);
        return { id: contact.id, name: contact.displayName };
      }
      case 'account':
        return plantAccount(programmeId, ownerUserId);
      case 'deal':
        return plantDeal(programmeId, ownerUserId);
      case 'activity': {
        const activity = await plantActivity(programmeId, ownerUserId);
        return { id: activity.id, name: activity.subject };
      }
    }
  }

  const EVENTS: Record<ObjectType, { eventType: string; key: string; kind: string; schemaExport: string }> = {
    contact: { eventType: 'contact.owner_changed', key: 'contactId', kind: 'record_assigned', schemaExport: 'ContactOwnerChangedPayload' },
    account: { eventType: 'account.owner_changed', key: 'accountId', kind: 'record_assigned', schemaExport: 'AccountOwnerChangedPayload' },
    deal: { eventType: 'deal.owner_changed', key: 'dealId', kind: 'record_assigned', schemaExport: 'DealOwnerChangedPayload' },
    activity: { eventType: 'activity.assigned', key: 'activityId', kind: 'task_assigned', schemaExport: 'ActivityAssignedPayload' },
  };
  const OBJECT_TYPES = Object.keys(EVENTS) as ObjectType[];

  // =========================================================================
  // 0. Self-check: the id-leaf walker this suite judges payloads with.
  //    Passes on main by design: shown refusing planted defects.
  // =========================================================================

  describe('0. (self-check) helpers', () => {
    it('(self-check) every planted id is a valid uuid; nonIdLeaves passes ids and nulls and catches text, numbers and nested text', () => {
      for (const kind of ['a', 'b', 'c', 'd', 'e', '9'] as const) expect(nextId(kind), kind).toMatch(UUID);
      expect(nonIdLeaves({ a: randomUUID(), b: null })).toEqual([]);
      expect(nonIdLeaves({ a: 'Zqn Sample' })).toHaveLength(1);
      expect(nonIdLeaves({ a: { b: ['x'] } })).toEqual(['a.b[0]="x"']);
      expect(nonIdLeaves({ n: 3 })).toHaveLength(1);
      expect(nonIdLeaves({ a: randomUUID().toUpperCase() }), 'an upper-case uuid is not canonical').toHaveLength(1);
    });
  });

  // =========================================================================
  // 1. The migration (I3).
  // =========================================================================

  describe('1. the notification table (I3)', () => {
    it('has exactly the I3 columns, every one NOT NULL except read_at, uuid ids and timestamptz times', async () => {
      const result = await observer.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'notification' ORDER BY column_name`,
      );
      expect(result.rows.map((row) => row.column_name), 'no name, subject or value column (D-P29)').toEqual(COLUMNS);
      for (const row of result.rows) {
        expect(row.is_nullable, row.column_name).toBe(row.column_name === 'read_at' ? 'YES' : 'NO');
        if (row.column_name.endsWith('_id') || row.column_name === 'id') expect(row.data_type, row.column_name).toBe('uuid');
        if (row.column_name.endsWith('_at')) expect(row.data_type, row.column_name).toBe('timestamp with time zone');
      }
    });

    it('kind and object_type admit the contract codes and refuse free text, even from the migrator', async () => {
      const recipient = await agentIn();
      const contact = await plantContact();
      // Control: every contract pairing is storable.
      for (const [kind, objectType] of [['record_assigned', 'contact'], ['record_assigned', 'account'], ['record_assigned', 'deal'], ['task_assigned', 'activity'], ['import_finished', 'import']] as const) {
        await observer.query(
          `INSERT INTO notification (id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id, actor_user_id, source_event_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), TENANT_A, PROGRAMME_A1, recipient.id, kind, objectType, contact.id, USER_A_SUPERVISOR, randomUUID()],
        );
      }
      for (const [kind, objectType] of [['Zqn Sample assigned you Amaka', 'contact'], ['record_assigned', 'Zqn Sample Holdings']]) {
        const outcome = await observer
          .query(
            `INSERT INTO notification (id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id, actor_user_id, source_event_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [randomUUID(), TENANT_A, PROGRAMME_A1, recipient.id, kind, objectType, contact.id, USER_A_SUPERVISOR, randomUUID()],
          )
          .then(() => 'stored', (error: { code?: string }) => error.code ?? 'error');
        expect(['23514', '22P02'], `free text stored in ${kind === 'record_assigned' ? 'object_type' : 'kind'}`).toContain(outcome);
      }
    });

    it('has RLS ENABLED and FORCED, and is in TENANT_SCOPED_TABLES', async () => {
      const result = await observer.query<{ rls: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class
          WHERE oid = 'public.notification'::regclass`,
      );
      expect(result.rows[0]).toEqual({ rls: true, forced: true });
      expect([...TENANT_SCOPED_TABLES] as string[]).toContain('notification');
    });

    it('has a permissive tenant-and-programme policy TO kasuwa_app (WITH CHECK = USING) and restrictive SELECT and UPDATE policies on the recipient', async () => {
      const result = await observer.query<{ permissive: string; roles: string[]; cmd: string; qual: string | null; with_check: string | null }>(
        `SELECT permissive, roles::text[] AS roles, cmd, qual, with_check FROM pg_policies
          WHERE schemaname = 'public' AND tablename = 'notification'`,
      );
      const policies = result.rows;
      const tenant = policies.filter(
        (p) => p.permissive === 'PERMISSIVE' && p.cmd === 'ALL' && p.roles.includes('kasuwa_app'),
      );
      expect(tenant, 'one permissive FOR ALL policy TO kasuwa_app').toHaveLength(1);
      const [only] = tenant;
      expect(only?.with_check, 'WITH CHECK identical to USING (CLAUDE.md 2.4)').toBe(only?.qual);
      expect(only?.qual ?? '').toMatch(/current_tenant_id/);
      expect(only?.qual ?? '').toMatch(/current_programme_ids/);
      for (const cmd of ['SELECT', 'UPDATE']) {
        const restrictive = policies.filter(
          (p) => p.permissive === 'RESTRICTIVE' && (p.cmd === cmd || p.cmd === 'ALL') && /recipient_user_id/.test(`${p.qual ?? ''}`) && /current_user_id/.test(`${p.qual ?? ''}`),
        );
        expect(restrictive.length, `no restrictive ${cmd} policy on recipient_user_id = app.current_user_id() (D-L157)`).toBeGreaterThan(0);
      }
      const insertRestrictedToRecipient = policies.filter(
        (p) => p.permissive === 'RESTRICTIVE' && (p.cmd === 'INSERT' || p.cmd === 'ALL') && /recipient_user_id/.test(`${p.with_check ?? p.qual ?? ''}`),
      );
      expect(insertRestrictedToRecipient, 'INSERT is recipient-restricted: the consumer, inserting as the actor, could never write').toEqual([]);
      const strangers = policies.filter((p) => p.roles.some((role) => ['public', 'kasuwa_relay', 'kasuwa_auth', 'kasuwa_sweeper'].includes(role)));
      expect(strangers).toEqual([]);
    });

    it('kasuwa_app holds INSERT, SELECT and UPDATE (read_at) only; the relay, auth, sweeper and PUBLIC hold nothing', async () => {
      const privilege = async (role: string, priv: string): Promise<boolean> => {
        const result = await observer.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'public.notification', $2) AS ok`, [role, priv]);
        return result.rows[0]?.ok ?? false;
      };
      const column = async (role: string, col: string, priv: string): Promise<boolean> => {
        const result = await observer.query<{ ok: boolean }>(`SELECT has_column_privilege($1, 'public.notification', $2, $3) AS ok`, [role, col, priv]);
        return result.rows[0]?.ok ?? false;
      };
      expect(await privilege('kasuwa_app', 'SELECT')).toBe(true);
      expect(await privilege('kasuwa_app', 'INSERT')).toBe(true);
      for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        expect(await privilege('kasuwa_app', priv), `kasuwa_app holds table-level ${priv}`).toBe(false);
      }
      for (const col of COLUMNS) {
        expect(await column('kasuwa_app', col, 'UPDATE'), `kasuwa_app UPDATE on ${col}`).toBe(col === 'read_at');
      }
      for (const role of ['kasuwa_relay', 'kasuwa_auth', 'kasuwa_sweeper', 'public']) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          expect(await privilege(role, priv), `${role} holds ${priv}`).toBe(false);
        }
      }
    });

    it('UNIQUE (source_event_id, recipient_user_id)', async () => {
      const result = await observer.query<{ cols: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS cols
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = 'public.notification'::regclass AND i.indisunique AND i.indpred IS NULL
          GROUP BY i.indexrelid`,
      );
      expect(result.rows.map((row) => row.cols.join(','))).toContain('recipient_user_id,source_event_id');
    });

    it('as kasuwa_app: the recipient reads and marks only their own rows; a colleague in the same programme sees and changes none', async () => {
      const recipient = await agentIn();
      const colleague = await agentIn();
      const contact = await plantContact();
      const id = await plantNotification({ recipient: recipient.id, objectId: contact.id });
      const asRecipient = await withTenantTransaction(appPool, { tenantId: TENANT_A, userId: recipient.id }, (tx) =>
        tx.query<{ id: string }>('SELECT id FROM notification WHERE tenant_id = $1', [TENANT_A]),
      );
      expect(asRecipient.map((row) => row.id), 'control: the recipient reads it').toEqual([id]);
      const seen = await withTenantTransaction(appPool, { tenantId: TENANT_A, userId: colleague.id }, async (tx) => {
        const rows = await tx.query('SELECT id FROM notification WHERE tenant_id = $1', [TENANT_A]);
        const updated = await tx.query('UPDATE notification SET read_at = now() WHERE id = $1 RETURNING id', [id]);
        return { rows: rows.length, updated: updated.length };
      });
      expect(seen).toEqual({ rows: 0, updated: 0 });
      expect((await rowsFor({ recipient: recipient.id }))[0]?.read_at).toBeNull();
    });

    it('as kasuwa_app: the recipient cannot change any column but read_at, nor DELETE (42501)', async () => {
      const recipient = await agentIn();
      const contact = await plantContact();
      const id = await plantNotification({ recipient: recipient.id, objectId: contact.id });
      const attempt = async (sql: string): Promise<string> =>
        withTenantTransaction(appPool, { tenantId: TENANT_A, userId: recipient.id }, (tx) => tx.query(sql, [id])).then(
          () => 'committed',
          (error: { code?: string }) => error.code ?? 'error',
        );
      expect(await attempt('UPDATE notification SET read_at = now() WHERE id = $1'), 'control').toBe('committed');
      expect(await attempt(`UPDATE notification SET kind = 'task_assigned' WHERE id = $1`)).toBe('42501');
      expect(await attempt(`UPDATE notification SET recipient_user_id = actor_user_id WHERE id = $1`)).toBe('42501');
      expect(await attempt('DELETE FROM notification WHERE id = $1')).toBe('42501');
      expect(await rowsFor({ recipient: recipient.id })).toHaveLength(1);
    });

    it('as the actor: a notification for a colleague can be written once; a second for the same (source_event_id, recipient) is refused by the key (23505), and the actor cannot SELECT the row', async () => {
      // FINDING (see I3): the task file's `INSERT ... ON CONFLICT DO NOTHING`
      // is refused (42501) for the actor under the restrictive SELECT policy,
      // on the FIRST insert: ON CONFLICT needs SELECT, so PostgreSQL checks
      // the new row against the SELECT policies too. Shown on a scratch
      // table before commit. The invariant pinned here is the key itself;
      // the handler's idempotency is pinned behaviourally in section 3.
      const recipient = await agentIn();
      const contact = await plantContact();
      const sourceEventId = randomUUID();
      const insert = async (): Promise<string> =>
        withTenantTransaction(appPool, { tenantId: TENANT_A, userId: USER_A_SUPERVISOR }, (tx) =>
          tx.query(
            `INSERT INTO notification (id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id, actor_user_id, source_event_id)
             VALUES ($1, $2, $3, $4, 'record_assigned', 'contact', $5, $6, $7)`,
            [randomUUID(), TENANT_A, PROGRAMME_A1, recipient.id, contact.id, USER_A_SUPERVISOR, sourceEventId],
          ),
        ).then(() => 'committed', (error: { code?: string }) => error.code ?? 'error');
      expect(await insert()).toBe('committed');
      expect(await insert(), 'the replay').toBe('23505');
      expect(await rowsFor({ recipient: recipient.id })).toHaveLength(1);
      const actorSees = await withTenantTransaction(appPool, { tenantId: TENANT_A, userId: USER_A_SUPERVISOR }, (tx) =>
        tx.query('SELECT id FROM notification WHERE source_event_id = $1', [sourceEventId]),
      );
      expect(actorSees, 'the actor reads the recipient\'s notification').toEqual([]);
    });
  });

  // =========================================================================
  // 2. Producers (I2; N-R4; D-L161).
  // =========================================================================

  describe('2. producers: the event commits with the change', () => {
    it('the four event types are registered, strict, ids only, and published by @kasuwa/domain-core as the same objects', () => {
      for (const objectType of OBJECT_TYPES) {
        const { eventType, key, schemaExport } = EVENTS[objectType];
        const schema = registeredSchema(eventType);
        expect((domainCore as Record<string, unknown>)[schemaExport], `@kasuwa/domain-core does not export ${schemaExport}`).toBe(schema);
        const valid = { [key]: randomUUID(), previousOwnerId: null, newOwnerId: randomUUID() };
        expect(schema.safeParse(valid).success, `${eventType}: control`).toBe(true);
        expect(schema.safeParse({ ...valid, previousOwnerId: randomUUID() }).success, `${eventType}: both owners`).toBe(true);
        expect(schema.safeParse({ ...valid, displayName: 'Zqn Sample' }).success, `${eventType}: not strict`).toBe(false);
        expect(schema.safeParse({ ...valid, [key]: 'Zqn Sample' }).success, `${eventType}: free text as the id`).toBe(false);
        expect(schema.safeParse({ [key]: valid[key], newOwnerId: valid.newOwnerId }).success, `${eventType}: previousOwnerId optional`).toBe(false);
      }
    });

    it.each(OBJECT_TYPES)('changing a %s owner appends exactly one event, in the record\'s programme, as the session user, with a v4 id and an ids-only payload', async (objectType) => {
      const recipient = await agentIn();
      const object = await plantObject(objectType, USER_A_SUPERVISOR);
      await assignOk(objectType, object.id, recipient.id);
      const rows = await outboxFor(object.id);
      expect(rows, `no ${EVENTS[objectType].eventType} event`).toHaveLength(1);
      const [event] = rows;
      expect(event).toMatchObject({
        tenant_id: TENANT_A,
        programme_id: PROGRAMME_A1,
        actor_user_id: USER_A_SUPERVISOR,
        event_type: EVENTS[objectType].eventType,
        aggregate_type: objectType,
        aggregate_id: object.id,
      });
      expect(event?.id ?? '', 'event ids come from randomUUID() (D-L161)').toMatch(UUID_V4);
      expect(event?.payload).toEqual({
        [EVENTS[objectType].key]: object.id,
        previousOwnerId: USER_A_SUPERVISOR,
        newOwnerId: recipient.id,
      });
    });

    it.each(OBJECT_TYPES)('the %s change notifies the new owner once: the right kind, object, actor and display name', async (objectType) => {
      const recipient = await agentIn();
      const object = await plantObject(objectType, null);
      await assignOk(objectType, object.id, recipient.id);
      await pump();
      const { data } = await list(recipient.headers);
      expect(data).toEqual([
        {
          id: expect.stringMatching(UUID) as unknown,
          kind: EVENTS[objectType].kind,
          objectType,
          objectId: object.id,
          actor: { id: USER_A_SUPERVISOR, displayName: SUPERVISOR.displayName },
          objectDisplayName: object.name,
          createdAt: expect.stringMatching(/Z$/) as unknown,
          readAt: null,
        },
      ]);
      const [row] = await rowsFor({ recipient: recipient.id });
      expect(row?.source_event_id, 'source_event_id is the outbox event id').toBe((await outboxFor(object.id))[0]?.id);
    });

    it('two successive changes append two events, in commit order, chained by their owners', async () => {
      const first = await agentIn();
      const second = await agentIn();
      const contact = await plantContact();
      await assignOk('contact', contact.id, first.id);
      await assignOk('contact', contact.id, second.id);
      const rows = await outboxFor(contact.id);
      expect(rows.map((row) => row.payload)).toEqual([
        { contactId: contact.id, previousOwnerId: null, newOwnerId: first.id },
        { contactId: contact.id, previousOwnerId: first.id, newOwnerId: second.id },
      ]);
      expect(new Set(rows.map((row) => row.id)).size, 'a fresh id per event').toBe(2);
    });

    it('a refused change (409 stale version, 403 agent assigning another) appends nothing and notifies nobody', async () => {
      const recipient = await agentIn();
      const agent = await agentIn();
      const contact = await plantContact(PROGRAMME_A1, agent.id);
      const version = await versionOf(PATHS.contact(contact.id));
      const stale = await assign('contact', contact.id, recipient.id, supervisorHeaders, version + 5);
      expect(stale.status, 'control: a stale write').toBe(409);
      const forbidden = await assign('contact', contact.id, recipient.id, agent.headers);
      expect(forbidden.status, 'control: an agent may only take a contact for itself').toBe(403);
      expect(await outboxFor(contact.id)).toEqual([]);
      // Non-vacuity: the same change, allowed, does append.
      await assignOk('contact', contact.id, recipient.id);
      expect(await outboxFor(contact.id)).toHaveLength(1);
    });

    it('N-R4: creating a task for someone else notifies them (task_assigned); a task the caller keeps notifies nobody', async () => {
      const recipient = await agentIn();
      const account = await plantAccount();
      const created = await http()
        .post('/api/v1/activities')
        .set(supervisorHeaders)
        .send({ type: 'task', subject: 'Zqntask Sample created', accountId: account.id, ownerUserId: recipient.id });
      expect([200, 201], `control: createActivity: ${created.text.slice(0, 300)}`).toContain(created.status);
      const own = await http()
        .post('/api/v1/activities')
        .set(recipient.headers)
        .send({ type: 'task', subject: 'Zqntask Sample own', accountId: account.id, ownerUserId: recipient.id });
      expect([200, 201], `control: createActivity (own): ${own.text.slice(0, 300)}`).toContain(own.status);
      await pump();
      const { data } = await list(recipient.headers);
      expect(data.map((item) => [item.kind, item.objectId, (item.actor as Json).id])).toEqual([
        ['task_assigned', (created.body as Json).id, USER_A_SUPERVISOR],
      ]);
    });

    it('N-R4: creating a contact, an account or a deal owned by someone else notifies them (record_assigned)', async () => {
      const recipient = await agentIn();
      const { pipeline } = await pipelineOf(PROGRAMME_A1);
      const creates: [string, string, Json][] = [
        ['contact', '/api/v1/contacts', { programmeId: PROGRAMME_A1, displayName: 'Zqncontact Sample created', ownerUserId: recipient.id }],
        ['account', '/api/v1/accounts', { programmeId: PROGRAMME_A1, name: 'Zqnaccount Sample created', ownerUserId: recipient.id }],
        ['deal', `/api/v1/pipelines/${pipeline}/deals`, { name: 'Zqndeal Sample created', ownerUserId: recipient.id }],
      ];
      const ids: Record<string, unknown> = {};
      for (const [type, path, body] of creates) {
        const response = await http().post(path).set(supervisorHeaders).send(body);
        expect([200, 201], `control: create ${type}: ${response.text.slice(0, 300)}`).toContain(response.status);
        ids[type] = (response.body as Json).id;
      }
      await pump();
      const items = await listAll(recipient.headers);
      expect(items.map((item) => `${String(item.kind)}:${String(item.objectType)}:${String(item.objectId)}`).sort()).toEqual(
        ['contact', 'account', 'deal'].map((type) => `record_assigned:${type}:${String(ids[type])}`).sort(),
      );
    });

    it('self-assignment notifies nobody: an agent taking a contact, creating its own deal, or assigning a task to itself', async () => {
      const agent = await agentIn();
      const contact = await plantContact();
      await assignOk('contact', contact.id, agent.id, agent.headers);
      const { pipeline } = await pipelineOf(PROGRAMME_A1);
      const deal = await http().post(`/api/v1/pipelines/${pipeline}/deals`).set(agent.headers).send({ name: 'Zqndeal Sample own' });
      expect([200, 201], `control: createDeal: ${deal.text.slice(0, 300)}`).toContain(deal.status);
      const activity = await plantActivity(PROGRAMME_A1, null);
      await assignOk('activity', activity.id, agent.id, agent.headers);
      // Whether a self-assignment appends an event is the builder's; any that
      // did was handled (pump asserts it) and must have written nothing.
      await pump();
      expect(await rowsFor({ recipient: agent.id })).toEqual([]);
      expect((await unread(agent.headers)).count).toBe(0);
    });

    it('unassignment (D-P23) notifies nobody: clearing the owner by PATCH, and removing the owner from the programme', async () => {
      const recipient = await agentIn();
      const cleared = await plantContact();
      const removed = await plantContact();
      await assignOk('contact', cleared.id, recipient.id);
      await assignOk('contact', removed.id, recipient.id);
      await pump();
      expect(await allNotificationRows(), 'control: the two assignments notified').toBe(2);
      await assignOk('contact', cleared.id, null);
      const deleted = await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [recipient.id, PROGRAMME_A1]);
      expect(deleted.rowCount, 'control: the membership existed').toBe(1);
      const owner = await observer.query<{ o: string | null }>('SELECT owner_user_id AS o FROM contact WHERE id = $1', [removed.id]);
      expect(owner.rows[0]?.o, 'control: removal unassigned the contact (T-0103)').toBeNull();
      await pump();
      // A regression guard more than a probe: after an unassignment there is
      // no owner left to notify, so a wrong recipient would have to be the
      // previous owner or the actor. Neither may get a row.
      expect(await allNotificationRows()).toBe(2);
    });

    it('re-sending the owner already in place notifies nobody again', async () => {
      const recipient = await agentIn();
      const contact = await plantContact();
      await assignOk('contact', contact.id, recipient.id);
      await pump();
      await assignOk('contact', contact.id, recipient.id);
      await pump();
      expect(await rowsFor({ recipient: recipient.id })).toHaveLength(1);
    });
  });

  // =========================================================================
  // 3. The consumer (D-L156, D-L157, D-L161; N-R1–N-R3).
  // =========================================================================

  describe('3. the consumer acts on current state, as the recipient could see it', () => {
    it('writes a row of ids only: the event\'s tenant, programme, actor and id, the current owner as recipient', async () => {
      const recipient = await agentIn();
      const contact = await plantContact();
      await assignOk('contact', contact.id, recipient.id);
      const [event] = await outboxFor(contact.id);
      await pump();
      const rows = await rowsFor({ objectId: contact.id });
      expect(rows).toEqual([
        {
          id: expect.stringMatching(UUID) as unknown,
          tenant_id: TENANT_A,
          programme_id: PROGRAMME_A1,
          recipient_user_id: recipient.id,
          kind: 'record_assigned',
          object_type: 'contact',
          object_id: contact.id,
          actor_user_id: USER_A_SUPERVISOR,
          source_event_id: must(event, 'the event').id,
          read_at: null,
        },
      ]);
    });

    it('idempotent: the same job delivered twice, and twice at once, leaves one row and never throws', async () => {
      const recipient = await agentIn();
      const contact = await plantContact();
      await assignOk('contact', contact.id, recipient.id);
      const [envelope] = await relayOnce();
      const job = must(envelope, 'the relay enqueued the event');
      expect(await consume(job)).toMatchObject({ outcome: 'handled' });
      expect(await consume(job)).toMatchObject({ outcome: 'handled' });
      const concurrent = await Promise.allSettled([consume(job), consume(job)]);
      expect(concurrent.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await rowsFor({ recipient: recipient.id })).toHaveLength(1);
    });

    it('N-R1: a stale event notifies nobody; the later change notifies its owner, from its own actor', async () => {
      const first = await agentIn();
      const second = await agentIn();
      const otherAdmin = await freshUser([[PROGRAMME_A1, 'admin']]);
      const contact = await plantContact();
      await assignOk('contact', contact.id, first.id);
      await assignOk('contact', contact.id, second.id, otherAdmin.headers);
      await pump();
      expect(await rowsFor({ recipient: first.id }), 'the first owner no longer owns it').toEqual([]);
      const rows = await rowsFor({ recipient: second.id });
      expect(rows.map((row) => row.actor_user_id), 'one notification, from the second change\'s actor').toEqual([otherAdmin.id]);
    });

    it('a recipient who is no longer a member of the programme is not notified (a planted former owner)', async () => {
      const recipient = await agentIn();
      const contact = await plantContact();
      await assignOk('contact', contact.id, recipient.id);
      await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [recipient.id, PROGRAMME_A1]);
      // Owner restored past the removal trigger: data written before T-0103
      // (the former-owner suite's plant). Current owner = payload's new owner.
      await observer.query('UPDATE contact SET owner_user_id = $1 WHERE id = $2', [recipient.id, contact.id]);
      // Non-vacuity: without a producer this test would pass on nothing.
      expect(await pump(), 'control: the assignment was relayed and handled').toHaveLength(1);
      expect(await rowsFor({ recipient: recipient.id })).toEqual([]);
    });

    it('D-L157: a deal owner who can no longer read deals (their set became client_portal) is not notified', async () => {
      const recipient = await agentIn();
      const control = await agentIn();
      const deal = await plantDeal();
      const other = await plantDeal();
      await assignOk('deal', deal.id, recipient.id);
      await assignOk('deal', other.id, control.id);
      await observer.query('UPDATE user_programme SET permission_set_id = $1 WHERE user_id = $2', [
        permissionSet(TENANT_A, 'client_portal'),
        recipient.id,
      ]);
      await pump();
      expect(await rowsFor({ recipient: control.id }), 'control: the agent who still reads deals is notified').toHaveLength(1);
      expect(await rowsFor({ recipient: recipient.id })).toEqual([]);
    });

    it.each(['contact', 'deal'] as const)('N-R3: when owner_user_id is withheld from the recipient, a %s assignment notifies nobody', async (objectType) => {
      await withholdField(objectType, 'owner_user_id', 'agent');
      const recipient = await agentIn();
      const control = await freshUser([[PROGRAMME_A1, 'team_lead']]);
      const object = await plantObject(objectType);
      const other = await plantObject(objectType);
      await assignOk(objectType, object.id, recipient.id);
      await assignOk(objectType, other.id, control.id);
      await pump();
      expect(await rowsFor({ recipient: control.id }), 'control: a team lead, who reads the owner, is notified').toHaveLength(1);
      expect(await rowsFor({ recipient: recipient.id })).toEqual([]);
    });
  });

  // =========================================================================
  // 4. listNotifications (R3–R7 of the contract suite).
  // =========================================================================

  describe('4. listNotifications', () => {
    it('lists only the caller\'s own, newest first by createdAt then id; tenant B and a colleague see none of them', async () => {
      const recipient = await agentIn();
      const colleague = await agentIn();
      const contact = await plantContact();
      const same = new Date(Date.now() - 60_000).toISOString();
      const older = await plantNotification({ recipient: recipient.id, objectId: contact.id, ageSeconds: 600 });
      const tieLow = await plantNotification({ recipient: recipient.id, objectId: contact.id, createdAt: same, id: '11111111-0000-4000-8000-0100f0000001' });
      const tieHigh = await plantNotification({ recipient: recipient.id, objectId: contact.id, createdAt: same, id: '11111111-0000-4000-8000-0100f0000002' });
      const newest = await plantNotification({ recipient: recipient.id, objectId: contact.id, ageSeconds: 1 });
      await plantNotification({ recipient: colleague.id, objectId: contact.id });
      expect((await list(recipient.headers)).data.map((item) => item.id)).toEqual([newest, tieHigh, tieLow, older]);
      expect((await list(colleague.headers)).data).toHaveLength(1);
      expect((await list(asUser(TENANT_B, USER_B_AGENT_1))).data).toEqual([]);
    });

    it('filter=unread keeps unread items; kind narrows to one kind', async () => {
      const recipient = await freshUser([[PROGRAMME_A1, 'agent']]);
      const contact = await plantContact();
      const activity = await plantActivity(PROGRAMME_A1, recipient.id);
      const read = await plantNotification({ recipient: recipient.id, objectId: contact.id, read: true, ageSeconds: 30 });
      const unreadRecord = await plantNotification({ recipient: recipient.id, objectId: contact.id, ageSeconds: 20 });
      const task = await plantNotification({ recipient: recipient.id, objectId: activity.id, objectType: 'activity', ageSeconds: 10 });
      expect((await list(recipient.headers, { filter: 'unread' })).data.map((item) => item.id)).toEqual([task, unreadRecord]);
      expect((await list(recipient.headers, { kind: 'record_assigned' })).data.map((item) => item.id)).toEqual([unreadRecord, read]);
      expect((await list(recipient.headers, { kind: 'task_assigned', filter: 'unread' })).data.map((item) => item.id)).toEqual([task]);
    });

    it('names are read now: a renamed object and a renamed actor show their current names', async () => {
      const recipient = await agentIn();
      const actor = await freshUser([[PROGRAMME_A1, 'admin']]);
      const contact = await plantContact();
      await plantNotification({ recipient: recipient.id, objectId: contact.id, actor: actor.id });
      const [before] = (await list(recipient.headers)).data;
      expect(before).toMatchObject({ objectDisplayName: contact.displayName, actor: { id: actor.id, displayName: actor.displayName } });
      await observer.query(`UPDATE contact SET display_name = 'Zqncontact Renamed', given_names = 'Zqncontact', family_name = 'Renamed' WHERE id = $1`, [contact.id]);
      await observer.query(`UPDATE "user" SET display_name = 'Zqn Fixture Renamed' WHERE id = $1`, [actor.id]);
      const [after] = (await list(recipient.headers)).data;
      expect(after).toMatchObject({ objectDisplayName: 'Zqncontact Renamed', actor: { id: actor.id, displayName: 'Zqn Fixture Renamed' } });
    });

    it('an actor who has left the object\'s programme is named null, though still a member elsewhere (D-P23, R5)', async () => {
      const recipient = await agentIn();
      const actor = await freshUser([[PROGRAMME_A1, 'admin'], [PROGRAMME_A2, 'admin']]);
      const contact = await plantContact();
      await plantNotification({ recipient: recipient.id, objectId: contact.id, actor: actor.id });
      await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [actor.id, PROGRAMME_A1]);
      const { data } = await list(recipient.headers);
      expect(data.map((item) => item.actor)).toEqual([{ id: actor.id, displayName: null }]);
    });

    it.each([
      ['contact', 'given_names'],
      ['contact', 'family_name'],
      ['account', 'name'],
      ['deal', 'name'],
      ['activity', 'subject'],
    ] as const)('a %s whose %s is withheld from the reader is listed with objectDisplayName null, never composed or hinted (R4)', async (objectType, field) => {
      // The reader holds `agent` in A1 (withheld there) and `team_lead` in A2
      // (not withheld): the rule is the reader's set in the OBJECT's programme.
      const reader = await freshUser([[PROGRAMME_A1, 'agent'], [PROGRAMME_A2, 'team_lead']]);
      const hidden = await plantObject(objectType, null, PROGRAMME_A1);
      const shown = await plantObject(objectType, null, PROGRAMME_A2);
      await plantNotification({ recipient: reader.id, objectId: hidden.id, objectType, programmeId: PROGRAMME_A1, ageSeconds: 20 });
      await plantNotification({ recipient: reader.id, objectId: shown.id, objectType, programmeId: PROGRAMME_A2, ageSeconds: 10 });
      const before = (await list(reader.headers)).data.map((item) => item.objectDisplayName);
      expect(before, 'control: both names before withholding').toEqual([shown.name, hidden.name]);
      await withholdField(objectType, field, 'agent');
      const response = await listRaw(reader.headers);
      const after = ((response.body as Json).data as Json[]).map((item) => item.objectDisplayName);
      expect(after).toEqual([shown.name, null]);
      const hiddenParts = hidden.name.split(' ').filter((part) => part.startsWith('Zqw'));
      expect(hiddenParts, 'non-vacuity: the hidden name has its own word').toHaveLength(1);
      expect(hiddenParts.filter((part) => response.text.includes(part)), 'a withheld name leaked in part').toEqual([]);
    });

    it('drops, never redacts, an item whose object the reader can no longer read: object gone, rights lost (D-P29, R6)', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      const deal = await plantDeal();
      const keep = await plantNotification({ recipient: reader.id, objectId: contact.id, ageSeconds: 30 });
      const gone = await plantNotification({ recipient: reader.id, objectId: randomUUID(), ageSeconds: 20 });
      const dealItem = await plantNotification({ recipient: reader.id, objectId: deal.id, objectType: 'deal', ageSeconds: 10 });
      expect((await list(reader.headers)).data.map((item) => item.id), 'control: the deal is visible').toEqual([dealItem, keep]);
      expect(gone).not.toBe(keep);
      await observer.query('UPDATE user_programme SET permission_set_id = $1 WHERE user_id = $2', [permissionSet(TENANT_A, 'client_portal'), reader.id]);
      const after = await listRaw(reader.headers);
      const ids = ((after.body as Json).data as Json[]).map((item) => item.id);
      expect(ids, 'client_portal reads no deals (D-L115)').not.toContain(dealItem);
      expect(ids).not.toContain(gone);
      expect(after.text, 'the dropped deal\'s name').not.toContain(deal.name);
    });

    it('a reader who lost the object\'s programme sees nothing of it, and the unread count drops', async () => {
      const reader = await freshUser([[PROGRAMME_A1, 'agent'], [PROGRAMME_A2, 'agent']]);
      const a1 = await plantContact(PROGRAMME_A1);
      const a2 = await plantContact(PROGRAMME_A2);
      const kept = await plantNotification({ recipient: reader.id, objectId: a1.id, programmeId: PROGRAMME_A1 });
      await plantNotification({ recipient: reader.id, objectId: a2.id, programmeId: PROGRAMME_A2 });
      expect(await unread(reader.headers), 'control').toEqual({ count: 2, capped: false });
      await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [reader.id, PROGRAMME_A2]);
      const response = await listRaw(reader.headers);
      expect(((response.body as Json).data as Json[]).map((item) => item.id)).toEqual([kept]);
      expect(response.text).not.toContain(a2.displayName);
      expect(await unread(reader.headers)).toEqual({ count: 1, capped: false });
    });

    it('keyset paging examines `limit` rows per page: short and empty pages carry a cursor; only null ends (R7)', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      // Newest first: V1 I2 I3 I4 V5 V6 I7 (I = an object that no longer exists).
      const pattern = [true, false, false, false, true, true, false];
      const ids: string[] = [];
      for (const [index, visible] of pattern.entries()) {
        ids.push(await plantNotification({ recipient: reader.id, objectId: visible ? contact.id : randomUUID(), ageSeconds: (index + 1) * 10 }));
      }
      const page1 = await list(reader.headers, { limit: '2' });
      expect(page1.data.map((item) => item.id)).toEqual([ids[0]]);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await list(reader.headers, { limit: '2', cursor: must(page1.nextCursor, 'cursor 1') });
      expect(page2.data, 'I3 and I4 examined: an empty page').toEqual([]);
      expect(page2.nextCursor, 'an empty page is not the end').not.toBeNull();
      const page3 = await list(reader.headers, { limit: '2', cursor: must(page2.nextCursor, 'cursor 2') });
      expect(page3.data.map((item) => item.id)).toEqual([ids[4], ids[5]]);
      let cursor = page3.nextCursor;
      for (let guard = 0; cursor !== null && guard < 3; guard += 1) {
        const page = await list(reader.headers, { limit: '2', cursor });
        expect(page.data, 'only I7 is left').toEqual([]);
        cursor = page.nextCursor;
      }
      expect(cursor, 'the list never ended').toBeNull();
    });

    it('the cursor carries no time, kind, filter or name, in any encoding (R7)', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      await plantNotification({ recipient: reader.id, objectId: contact.id, createdAt: '2026-10-18T09:50:00.000Z' });
      await plantNotification({ recipient: reader.id, objectId: contact.id, createdAt: '2026-10-18T09:40:00.000Z' });
      const page = await list(reader.headers, { limit: '1', filter: 'unread', kind: 'record_assigned' });
      const cursor = must(page.nextCursor, 'a cursor');
      const decoded = [cursor, Buffer.from(cursor, 'base64url').toString('utf8'), Buffer.from(cursor, 'base64').toString('utf8')]
        .join('\n')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
      for (const forbidden of ['2026', String(Date.parse('2026-10-18T09:50:00.000Z')).slice(0, 9), 'record_assigned', 'unread', 'Zqn', contact.displayName]) {
        expect(decoded, `the cursor carries "${forbidden}"`).not.toContain(forbidden);
      }
    });

    it('a cursor naming another user\'s, another tenant\'s, or a deleted notification gives one empty page with nextCursor null (D-L157)', async () => {
      const owner = await agentIn();
      const other = await agentIn();
      const tenantB = await freshUser([[PROGRAMME_B1, 'agent']], TENANT_B);
      const contact = await plantContact();
      const contactB = await plantContact(PROGRAMME_B1, null, TENANT_B);
      for (const age of [10, 20, 30]) await plantNotification({ recipient: owner.id, objectId: contact.id, ageSeconds: age });
      // Older rows of the other callers: a server that resolved the position
      // by the cursor row's time, whoever owns it, would return these.
      for (const age of [100, 200]) {
        await plantNotification({ recipient: other.id, objectId: contact.id, ageSeconds: age });
        await plantNotification({ recipient: tenantB.id, objectId: contactB.id, ageSeconds: age, tenantId: TENANT_B, programmeId: PROGRAMME_B1, actor: USER_B_AGENT_1 });
      }
      const first = await list(owner.headers, { limit: '1' });
      const cursor = must(first.nextCursor, 'a cursor');
      const answers: string[] = [];
      for (const caller of [other, tenantB]) {
        const response = await listRaw(caller.headers, { cursor, limit: '1' });
        expect(response.status).toBe(200);
        expectNoStore(response, 'foreign cursor');
        answers.push(JSON.stringify(response.body));
      }
      await observer.query('DELETE FROM notification WHERE recipient_user_id = $1', [owner.id]);
      await plantNotification({ recipient: owner.id, objectId: contact.id, ageSeconds: 1_000 });
      const deleted = await listRaw(owner.headers, { cursor, limit: '1' });
      expect(deleted.status).toBe(200);
      answers.push(JSON.stringify(deleted.body));
      expect(answers).toEqual([0, 1, 2].map(() => JSON.stringify({ data: [], nextCursor: null })));
    });

    it('a cursor whose own row is no longer visible still pages on (R7)', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      const newer = await plantNotification({ recipient: reader.id, objectId: contact.id, ageSeconds: 10 });
      const older = await plantNotification({ recipient: reader.id, objectId: contact.id, ageSeconds: 20 });
      const page1 = await list(reader.headers, { limit: '1' });
      expect(page1.data.map((item) => item.id)).toEqual([newer]);
      await observer.query('UPDATE notification SET object_id = $1 WHERE id = $2', [randomUUID(), newer]);
      const page2 = await list(reader.headers, { limit: '1', cursor: must(page1.nextCursor, 'cursor') });
      expect(page2.data.map((item) => item.id)).toEqual([older]);
    });

    it.each([
      [{ cursor: '%%%not-a-cursor%%%' }, 'cursor', 'invalid_cursor'],
      [{ kind: 'mention' }, 'kind', 'invalid_value'],
      [{ filter: 'starred' }, 'filter', 'invalid_value'],
    ])('400 validation_failed for %j, naming the path and code and never the value', async (query, path, code) => {
      const reader = await agentIn();
      const response = await listRaw(reader.headers, query);
      expect(response.status).toBe(400);
      expectNoStore(response, 'a 400');
      expect(response.body).toMatchObject({ code: 'validation_failed', details: [{ path, code }] });
      expect(response.text).not.toContain(Object.values(query)[0]);
    });

    it('limit outside 1..100 is 400, never clamped', async () => {
      const reader = await agentIn();
      for (const limit of ['0', '101']) {
        const response = await listRaw(reader.headers, { limit });
        expect(response.status, `limit=${limit}`).toBe(400);
        expect(response.body).toMatchObject({ code: 'validation_failed' });
      }
    });
  });

  // =========================================================================
  // 5. getNotificationUnreadCount (R8; D-L157; N-R6).
  // =========================================================================

  describe('5. the unread count', () => {
    async function plantMany(recipient: string, count: number, objectOf: (index: number) => string, startAgeSeconds = 0): Promise<void> {
      await observer.query(
        `INSERT INTO notification (id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id, actor_user_id, source_event_id, created_at)
         SELECT gen_random_uuid(), $1, $2, $3, 'record_assigned', 'contact', (($4::text[])[g])::uuid, $5, gen_random_uuid(),
                now() - make_interval(secs => $6::int + g)
           FROM generate_series(1, $7::int) AS g`,
        [TENANT_A, PROGRAMME_A1, recipient, Array.from({ length: count }, (_, index) => objectOf(index)), USER_A_SUPERVISOR, startAgeSeconds, count],
      );
    }

    it('counts visible unread only; read items and invisible items do not count', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      await plantNotification({ recipient: reader.id, objectId: contact.id });
      await plantNotification({ recipient: reader.id, objectId: contact.id, read: true });
      await plantNotification({ recipient: reader.id, objectId: randomUUID() });
      expect(await unread(reader.headers)).toEqual({ count: 1, capped: false });
    });

    it('99 visible unread is { 99, capped: false }; 100 is { 99, capped: true }', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      await plantMany(reader.id, 99, () => contact.id);
      expect(await unread(reader.headers)).toEqual({ count: 99, capped: false });
      await plantNotification({ recipient: reader.id, objectId: contact.id });
      expect(await unread(reader.headers)).toEqual({ count: 99, capped: true });
    });

    it(`N-R6: exactly the ${UNREAD_BOUND} newest unread are examined (495 invisible newest, visible beneath: count 5)`, async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      await plantMany(reader.id, 495, () => randomUUID(), 0);
      await plantMany(reader.id, 20, () => contact.id, 10_000);
      expect(await unread(reader.headers)).toEqual({ count: 5, capped: false });
      // Five more invisible on top push every visible one past the bound.
      await plantMany(reader.id, 5, () => randomUUID(), -100);
      expect(await unread(reader.headers), 'more than 500 were examined').toEqual({ count: 0, capped: false });
    }, 60_000);
  });

  // =========================================================================
  // 6. updateNotification (R9, R11; N-R7).
  // =========================================================================

  describe('6. updateNotification', () => {
    it('read: true sets readAt and keeps the first readAt; read: false clears it; the answer is the item with its names', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      const id = await plantNotification({ recipient: reader.id, objectId: contact.id });
      const first = await patchRaw(reader.headers, id, { read: true });
      expect(first.status, first.text.slice(0, 300)).toBe(200);
      expectNoStore(first, 'updateNotification');
      const item = first.body as Json;
      expect(Object.keys(item).sort()).toEqual(NOTIFICATION_KEYS);
      expect(item).toMatchObject({ id, objectDisplayName: contact.displayName, actor: { id: USER_A_SUPERVISOR, displayName: SUPERVISOR.displayName } });
      expect(typeof item.readAt).toBe('string');
      const again = await patchRaw(reader.headers, id, { read: true });
      expect((again.body as Json).readAt, 'idempotent: the first readAt stands').toBe(item.readAt);
      const cleared = await patchRaw(reader.headers, id, { read: false });
      expect((cleared.body as Json).readAt).toBeNull();
      expect((await rowsFor({ recipient: reader.id }))[0]?.read_at).toBeNull();
    });

    it('one 404 body, identical to getContact\'s, for none, a colleague\'s, another tenant\'s and an invisible one, and a 404 changes nothing', async () => {
      const reader = await agentIn();
      const colleague = await agentIn();
      const contact = await plantContact();
      const contactB = await plantContact(PROGRAMME_B1, null, TENANT_B);
      const theirs = await plantNotification({ recipient: colleague.id, objectId: contact.id });
      const foreign = await plantNotification({ recipient: USER_B_AGENT_1, objectId: contactB.id, tenantId: TENANT_B, programmeId: PROGRAMME_B1, actor: USER_B_AGENT_1 });
      const invisible = await plantNotification({ recipient: reader.id, objectId: randomUUID() });
      const reference = await http().get(PATHS.contact(randomUUID())).set(reader.headers);
      expect(reference.status, 'control: getContact 404').toBe(404);
      for (const [name, id] of [['none', randomUUID()], ['a colleague\'s', theirs], ['another tenant\'s', foreign], ['an invisible one', invisible]] as const) {
        for (const body of [{ read: true }, { read: false }]) {
          const response = await patchRaw(reader.headers, id, body);
          expect(response.status, name).toBe(404);
          expectNoStore(response, `404 for ${name}`);
          expect(response.text, `${name}: not the NotFound body`).toBe(reference.text);
        }
      }
      const result = await observer.query<{ n: number }>('SELECT count(*)::int AS n FROM notification WHERE read_at IS NOT NULL');
      expect(result.rows[0]?.n, 'a 404 marked something read').toBe(0);
    });

    it('400 for a body that is not { read: boolean } or a non-uuid id; nothing changes', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      const id = await plantNotification({ recipient: reader.id, objectId: contact.id });
      for (const body of [{ read: 'yes' }, {}, { read: true, recipientUserId: reader.id }, { read: true, readAt: '2026-01-01T00:00:00Z' }]) {
        const response = await patchRaw(reader.headers, id, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(response.body).toMatchObject({ code: 'validation_failed' });
      }
      expect((await patchRaw(reader.headers, 'not-a-uuid', { read: true })).status).toBe(400);
      expect((await rowsFor({ recipient: reader.id }))[0]?.read_at).toBeNull();
    });
  });

  // =========================================================================
  // 7. markAllNotificationsRead (R10; D-L154).
  // =========================================================================

  describe('7. markAllNotificationsRead', () => {
    it('{} marks every unread notification of the caller read, invisible ones too, and answers the new visible count', async () => {
      const reader = await agentIn();
      const colleague = await agentIn();
      const contact = await plantContact();
      await plantNotification({ recipient: reader.id, objectId: contact.id });
      await plantNotification({ recipient: reader.id, objectId: randomUUID() });
      const theirs = await plantNotification({ recipient: colleague.id, objectId: contact.id });
      const response = await readAllRaw(reader.headers, {});
      expect(response.status, response.text.slice(0, 300)).toBe(200);
      expectNoStore(response, 'markAllNotificationsRead');
      expect(response.body).toEqual({ count: 0, capped: false });
      expect((await rowsFor({ recipient: reader.id })).map((row) => row.read_at !== null)).toEqual([true, true]);
      expect((await rowsFor({ recipient: colleague.id })).find((row) => row.id === theirs)?.read_at).toBeNull();
    });

    it('kind narrows to one kind', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      const activity = await plantActivity(PROGRAMME_A1, reader.id);
      await plantNotification({ recipient: reader.id, objectId: contact.id });
      const task = await plantNotification({ recipient: reader.id, objectId: activity.id, objectType: 'activity' });
      const response = await readAllRaw(reader.headers, { kind: 'record_assigned' });
      expect(response.status, response.text.slice(0, 300)).toBe(200);
      expect(response.body).toEqual({ count: 1, capped: false });
      expect((await rowsFor({ recipient: reader.id })).filter((row) => row.read_at === null).map((row) => row.id)).toEqual([task]);
    });

    it('throughId marks only notifications at or older than it, by createdAt then id; a newer one stays unread and is counted', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      const same = new Date(Date.now() - 60_000).toISOString();
      const older = await plantNotification({ recipient: reader.id, objectId: contact.id, ageSeconds: 600 });
      const tieLow = await plantNotification({ recipient: reader.id, objectId: contact.id, createdAt: same, id: '11111111-0000-4000-8000-0100f0000011' });
      const through = await plantNotification({ recipient: reader.id, objectId: contact.id, createdAt: same, id: '11111111-0000-4000-8000-0100f0000012' });
      const tieHigh = await plantNotification({ recipient: reader.id, objectId: contact.id, createdAt: same, id: '11111111-0000-4000-8000-0100f0000013' });
      const newer = await plantNotification({ recipient: reader.id, objectId: contact.id, ageSeconds: 1 });
      const response = await readAllRaw(reader.headers, { throughId: through });
      expect(response.status, response.text.slice(0, 300)).toBe(200);
      expect(response.body).toEqual({ count: 2, capped: false });
      const unreadIds = (await rowsFor({ recipient: reader.id })).filter((row) => row.read_at === null).map((row) => row.id).sort();
      expect(unreadIds).toEqual([newer, tieHigh].sort());
      expect([older, tieLow].every((id) => !unreadIds.includes(id))).toBe(true);
    });

    it('a throughId that is unknown, a colleague\'s, another tenant\'s or not a uuid is one 400 at throughId, and nothing changes', async () => {
      const reader = await agentIn();
      const colleague = await agentIn();
      const contact = await plantContact();
      const contactB = await plantContact(PROGRAMME_B1, null, TENANT_B);
      await plantNotification({ recipient: reader.id, objectId: contact.id });
      const theirs = await plantNotification({ recipient: colleague.id, objectId: contact.id });
      const foreign = await plantNotification({ recipient: USER_B_AGENT_1, objectId: contactB.id, tenantId: TENANT_B, programmeId: PROGRAMME_B1, actor: USER_B_AGENT_1 });
      const bodies: string[] = [];
      for (const throughId of [randomUUID(), theirs, foreign, 'not-a-uuid']) {
        const response = await readAllRaw(reader.headers, { throughId });
        expect(response.status, throughId).toBe(400);
        expectNoStore(response, 'throughId 400');
        expect(response.body).toMatchObject({ code: 'validation_failed', details: [{ path: 'throughId', code: 'invalid_value' }] });
        bodies.push(response.text);
      }
      expect(new Set(bodies).size, 'the 400s differ: an existence oracle').toBe(1);
      const marked = await observer.query<{ n: number }>('SELECT count(*)::int AS n FROM notification WHERE read_at IS NOT NULL');
      expect(marked.rows[0]?.n).toBe(0);
    });

    it('the caller\'s own notification whose object is no longer visible is a valid throughId', async () => {
      const reader = await agentIn();
      const contact = await plantContact();
      const older = await plantNotification({ recipient: reader.id, objectId: contact.id, ageSeconds: 60 });
      const invisible = await plantNotification({ recipient: reader.id, objectId: randomUUID(), ageSeconds: 30 });
      const response = await readAllRaw(reader.headers, { throughId: invisible });
      expect(response.status, response.text.slice(0, 300)).toBe(200);
      expect((await rowsFor({ recipient: reader.id })).find((row) => row.id === older)?.read_at).not.toBeNull();
    });
  });

  // =========================================================================
  // 8. Every answer is no-store; 401 before anything.
  // =========================================================================

  describe('8. no-store and 401', () => {
    it('an unauthenticated call to each route is 401 with no-store', async () => {
      const id = randomUUID();
      for (const call of [
        () => http().get(BASE),
        () => http().get(`${BASE}/unread-count`),
        () => http().patch(`${BASE}/${id}`).send({ read: true }),
        () => http().post(`${BASE}/read-all`).send({}),
      ]) {
        const response = await call();
        expect(response.status).toBe(401);
        expectNoStore(response, '401');
      }
    });

    it('scope headers are refused, never honoured (CLAUDE.md 2.2)', async () => {
      const reader = await agentIn();
      const response = await http().get(BASE).set({ ...reader.headers, 'x-kasuwa-programme-ids': `{${PROGRAMME_A2}}` });
      expect(response.status).toBe(400);
      expectNoStore(response, 'scope header');
    });
  });

  // =========================================================================
  // 9. No PII in rows, payloads or logs (D-P29; CLAUDE.md 6.1).
  // =========================================================================

  describe('9. no PII in notification rows, event payloads or logs', () => {
    it('an assignment of each kind, consumed and read: rows and payloads hold ids and codes only; no log line or span names anyone', async () => {
      const recipient = await agentIn();
      const objects = await Promise.all(OBJECT_TYPES.map(async (type) => ({ type, ...(await plantObject(type)) })));
      const haystack = await captureEverything(async () => {
        for (const object of objects) await assignOk(object.type, object.id, recipient.id);
        await pump();
        const { data } = await list(recipient.headers);
        expect(data.map((item) => item.objectDisplayName).sort(), 'control: the names were resolved').toEqual(objects.map((object) => object.name).sort());
        await unread(recipient.headers);
        await patchRaw(recipient.headers, String(data[0]?.id), { read: true });
        await readAllRaw(recipient.headers, {});
      });
      const events = await observer.query<{ payload: Json }>('SELECT payload FROM outbox_event WHERE aggregate_id = ANY($1::uuid[])', [objects.map((object) => object.id)]);
      expect(events.rows.length, 'control: four events').toBe(4);
      expect(events.rows.flatMap((row) => nonIdLeaves(row.payload))).toEqual([]);
      const rows = await rowsFor({ recipient: recipient.id });
      expect(rows.length).toBe(4);
      const texts = rows.flatMap((row) => leafStrings({ ...row, read_at: null }).map((leaf) => leaf.value));
      expect(texts.filter((value) => !UUID.test(value) && !['record_assigned', 'task_assigned', 'contact', 'account', 'deal', 'activity'].includes(value))).toEqual([]);
      const forbidden = [
        ...objects.map((object) => object.name),
        ...objects.flatMap((object) => object.name.split(' ').filter((part) => part.startsWith('Zqw'))),
        recipient.displayName,
        recipient.email,
        SUPERVISOR.displayName,
        SUPERVISOR.email,
      ];
      expect(forbidden.filter((value) => haystack.includes(value))).toEqual([]);
    });
  });

  // =========================================================================
  // 10. The worker process consumes the queue end to end (N-R9).
  // =========================================================================

  describe('10. the worker consumes kasuwa.events.notifications', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..');
    const children: ChildProcess[] = [];

    afterAll(() => {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    });

    function url(role: string, password: string): string {
      const base = new URL(inject('databaseUrl'));
      base.username = role;
      base.password = password;
      return base.toString();
    }

    it('an owner change made through the API becomes a notification with no further help, and the worker prints no name, email or object id', async () => {
      const recipient = await agentIn();
      const contact = await plantContact();
      const redisUrl = inject('redisUrl');
      const workerDir = join(repoRoot, 'apps', 'worker');
      const tsx = createRequire(join(workerDir, 'package.json')).resolve('tsx/cli');
      const child = spawn(process.execPath, [tsx, 'src/main.ts'], {
        cwd: workerDir,
        env: {
          NODE_ENV: 'test',
          REDIS_URL: redisUrl,
          DATABASE_URL: url('kasuwa_app', 'kasuwa_app_dev'),
          DATABASE_RELAY_URL: url('kasuwa_relay', 'kasuwa_relay_dev'),
          HOME: tmpdir(),
          TMPDIR: tmpdir(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      children.push(child);
      let output = '';
      let exited: number | null | undefined;
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.on('exit', (code) => {
        exited = code ?? -1;
      });
      try {
        await assignOk('contact', contact.id, recipient.id);
        await vi.waitFor(
          async () => {
            if (exited !== undefined) return;
            if ((await rowsFor({ recipient: recipient.id })).length === 0) throw new Error('no notification yet');
          },
          { timeout: 60_000, interval: 250 },
        );
        expect(exited, `the worker exited. Output:\n${output}`).toBeUndefined();
        expect(await rowsFor({ recipient: recipient.id })).toHaveLength(1);
        const forbidden = [contact.displayName, contact.id, recipient.displayName, recipient.email, SUPERVISOR.displayName];
        expect(forbidden.filter((value) => output.includes(value))).toEqual([]);
      } finally {
        if (exited === undefined) {
          child.kill('SIGTERM');
          await vi
            .waitFor(() => {
              if (exited === undefined) throw new Error('still running');
            }, { timeout: 15_000, interval: 100 })
            .catch(() => child.kill('SIGKILL'));
        }
        // The platform outbox suite's refusal tests assume no `bull:kasuwa.*`
        // key exists in the harness's Redis when they run. Files run one at
        // a time but in no fixed order, so this test leaves none behind.
        const keys = await redisCommand(redisUrl, ['KEYS', 'bull:kasuwa.*']);
        if (Array.isArray(keys) && keys.length > 0) await redisCommand(redisUrl, ['DEL', ...keys.map(String)]);
      }
    }, 120_000);
  });

  // =========================================================================
  // 11. The throttle (R12; D-L134, D-L157; N-R8). Last, on fresh users.
  // =========================================================================

  describe('11. a per-user throttle with Retry-After', () => {
    async function burst(send: () => Promise<request.Response>): Promise<{ admitted: number; refusal: request.Response | null }> {
      for (let n = 0; n < THROTTLE_MAX + 50; n += 1) {
        const response = await send();
        if (response.status === 429) return { admitted: n, refusal: response };
        expect(response.status, `request ${n + 1}: ${response.text.slice(0, 200)}`).toBe(200);
      }
      return { admitted: THROTTLE_MAX + 50, refusal: null };
    }

    function expectThrottle(response: request.Response | null, where: string): void {
      expect(response, `${where}: never throttled`).not.toBeNull();
      if (response === null) return;
      expect(response.status).toBe(429);
      expectNoStore(response, where);
      expect(response.body).toMatchObject({ statusCode: 429, error: 'Too Many Requests', code: 'too_many_requests' });
      const retryAfter = String(response.headers['retry-after'] ?? '');
      expect(retryAfter, `${where}: Retry-After`).toMatch(/^[1-9][0-9]*$/);
    }

    it(`getNotificationUnreadCount admits ${THROTTLE_MIN}..${THROTTLE_MAX} per user in a burst, then 429 with Retry-After; another user is unaffected`, async () => {
      const first = await agentIn();
      const { admitted, refusal } = await burst(() => http().get(`${BASE}/unread-count`).set(first.headers));
      process.stdout.write(`notifications throttle: unread-count admitted ${admitted}\n`);
      expectThrottle(refusal, 'unread-count');
      expect(admitted).toBeGreaterThanOrEqual(THROTTLE_MIN);
      expect(admitted).toBeLessThanOrEqual(THROTTLE_MAX);
      const second = await agentIn();
      expect(await unread(second.headers)).toEqual({ count: 0, capped: false });
    }, 120_000);

    it(`listNotifications admits ${THROTTLE_MIN}..${THROTTLE_MAX}; once throttled, even a malformed request is 429 (before validation)`, async () => {
      const caller = await agentIn();
      const { admitted, refusal } = await burst(() => listRaw(caller.headers));
      process.stdout.write(`notifications throttle: list admitted ${admitted}\n`);
      expectThrottle(refusal, 'list');
      expect(admitted).toBeGreaterThanOrEqual(THROTTLE_MIN);
      expect(admitted).toBeLessThanOrEqual(THROTTLE_MAX);
      expectThrottle(await listRaw(caller.headers, { limit: '0', kind: 'mention' }), 'malformed while throttled');
    }, 120_000);
  });
});

// ---------------------------------------------------------------------------
// A minimal RESP client (the platform outbox suite's, copied: importing a test
// file registers its tests).
// ---------------------------------------------------------------------------

type Resp = string | number | null | Resp[];

function encodeResp(args: readonly string[]): Buffer {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) parts.push(`$${Buffer.byteLength(arg, 'utf8')}\r\n${arg}\r\n`);
  return Buffer.from(parts.join(''), 'utf8');
}

function parseResp(buffer: Buffer, offset: number): { value: Resp; next: number } | undefined {
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return undefined;
  const kind = String.fromCharCode(buffer[offset] ?? 0);
  const line = buffer.toString('utf8', offset + 1, lineEnd);
  const after = lineEnd + 2;
  switch (kind) {
    case '+':
      return { value: line, next: after };
    case '-':
      throw new Error(`redis: ${line}`);
    case ':':
      return { value: Number(line), next: after };
    case '$': {
      const length = Number(line);
      if (length === -1) return { value: null, next: after };
      if (buffer.length < after + length + 2) return undefined;
      return { value: buffer.toString('utf8', after, after + length), next: after + length + 2 };
    }
    case '*': {
      const count = Number(line);
      if (count === -1) return { value: null, next: after };
      const items: Resp[] = [];
      let cursor = after;
      for (let index = 0; index < count; index += 1) {
        const item = parseResp(buffer, cursor);
        if (item === undefined) return undefined;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`redis: unexpected reply type ${kind}`);
  }
}

function redisCommand(url: string, args: readonly string[]): Promise<Resp> {
  const { hostname, port } = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: hostname, port: Number(port === '' ? '6379' : port) });
    let buffer = Buffer.alloc(0);
    socket.on('connect', () => socket.write(encodeResp(args)));
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const parsed = parseResp(buffer, 0);
        if (parsed !== undefined) {
          socket.end();
          resolvePromise(parsed.value);
        }
      } catch (error) {
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('error', reject);
  });
}
