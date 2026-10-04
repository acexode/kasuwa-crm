import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import { FakeChannelProvider } from '@kasuwa/channel-adapter';
import {
  BU_A,
  BU_B,
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser } from '../support/api';

/**
 * ACCEPTANCE — T-0033, audit the writes that landed after T-0025 (Agent 1, M2).
 *
 * The contract is `docs/api/admin.openapi.yaml`: every operation marked
 * `x-kasuwa-audited: true` "MUST write an audit row when it is implemented"
 * (spec header, point 5), read back through `listAuditEvents`. D-L52: D-L38
 * counts as closed only when every `x-kasuwa-audited` write on main writes an
 * event. If the spec and this file disagree, the spec is right and this file
 * is the defect: say so in the report, do not edit it.
 *
 * WHAT THIS SUITE IS REALLY ABOUT
 *
 *   1. A write can never again ship unaudited. The coverage test parses the
 *      spec and, for EVERY operation that is both live (`x-kasuwa-implemented`
 *      true or partial) and `x-kasuwa-audited: true`, drives one minimal
 *      successful call and one or more refused calls through the real API. A
 *      success adds exactly the events the spec names (one, or one per moved
 *      role / changed cell); a refusal adds none. The operation-to-request
 *      table below is explicit, and a live audited operation with no entry
 *      FAILS the suite: whoever flips a flag must also teach this file to
 *      drive the operation.
 *   2. The writes T-0025 could not reach: updateProgrammeSla and
 *      updateProgrammeRetention (T-0028), invitePortalUser (T-0030) and the
 *      four disposition writes (T-0027), each with specific assertions.
 *   3. A portal invite names an outsider. Its address is recorded only as a
 *      redacted change (D-L52, spec `AuditChange`: "redacted: true with both
 *      values null"); neither the address, its local part nor the invitee's
 *      display name appears anywhere the log returns.
 *   4. Visibility per D-L48: an event with a `programmeId` is visible only to
 *      members of that programme. Every new event here happens inside a
 *      programme, so it must carry that programme — a programme write audited
 *      with `programmeId: null` would be readable tenant-wide.
 *
 * Conventions this suite pins, where the spec names a thing but not its key.
 * They follow D-L48 (API field names in `changes[].field`, values as strings)
 * and are listed so the builder meets them deliberately:
 *
 *   - SLA writes: `objectType: 'sla_policy'`, `action: 'updated'`,
 *     `objectId` = the programme id (the policy has no id of its own);
 *   - retention writes: `objectType: 'retention_policy'`, `action: 'updated'`,
 *     `objectId` = the programme id;
 *   - disposition writes: `objectType: 'disposition'`, `objectId` = the
 *     disposition id, actions `created` / `updated` / `deleted`; a reorder is
 *     ONE `updated` event for the programme (one event per successful write,
 *     T-0033), whatever `objectType` it chooses;
 *   - portal invites: `objectType: 'portal_user'`, `action: 'invited'`,
 *     `objectId` = the portal user id; `access` is a plain change, `email` a
 *     redacted one. A resend (D-L49) is a successful write: one more event.
 *
 * Callers. No permissions engine: tenant A writes as USER_A_SUPERVISOR (A1 and
 * A2), refusals-by-scope as USER_A_AGENT_1 (A1 only), tenant B as
 * USER_B_AGENT_1. Event counts are read as the supervisor, who can read every
 * event this suite provokes in tenant A (D-L48).
 *
 * Writes. Every test that writes reseeds in `finally`, and the suite reseeds
 * before and after. The field-security probe needs an object with fields and
 * the seed has none, so the coverage test inserts one (as the field-security
 * suite does), and the reseed removes it.
 */

const SPEC_PATH = resolve(__dirname, '../../../docs/api/admin.openapi.yaml');

const EVENTS = '/api/v1/admin/audit/events';
const FILTER_OPTIONS = '/api/v1/admin/audit/filter-options';
const EXPORTS = '/api/v1/admin/audit/exports';
const ROLES = '/api/v1/admin/roles';
const HIERARCHY = '/api/v1/admin/roles/hierarchy';
const MATRIX = '/api/v1/admin/field-security/matrix';
const PROGRAMMES = '/api/v1/admin/programmes';
const programmePath = (programmeId: string) => `${PROGRAMMES}/${programmeId}`;
const slaPath = (programmeId: string) => `${programmePath(programmeId)}/sla`;
const retentionPath = (programmeId: string) => `${programmePath(programmeId)}/retention`;
const invitePath = (programmeId: string) =>
  `${programmePath(programmeId)}/portal-users/invitations`;
const archivePath = (programmeId: string) => `${programmePath(programmeId)}/archive`;
const dispositionsPath = (programmeId: string) => `${programmePath(programmeId)}/dispositions`;
const dispositionPath = (programmeId: string, dispositionId: string) =>
  `${dispositionsPath(programmeId)}/${dispositionId}`;
const orderPath = (programmeId: string) => `${dispositionsPath(programmeId)}/order`;

/** Never real rows: same shape as the seed ids, nothing seeds them. */
const NO_SUCH_ROLE = '11111111-0000-4000-8000-0000000f9999';

/** The field-security probe's object, inserted by the coverage test. */
const PROBE_OBJECT_ID = '11111111-0000-4000-8000-0000003300a1';
const PROBE_OBJECT = 'audit_probe';
const PROBE_FIELDS = ['probe_priority', 'probe_notes'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const AUDIT_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'exported',
  'invited',
  'viewed',
  'failed_sign_in',
  'rejected',
  'rotated',
  'played_recording',
];

/** Unique per run so a name never collides with an earlier, unreseeded run. */
const RUN = Date.now().toString(36);
let sequence = 0;
const next = () => (sequence += 1);
const uniqueName = (label: string) => `${label} ${RUN}-${next()}`;
/** `^[A-Z0-9_]+$`, at most 16 characters (DispositionWrite.code). */
const uniqueCode = (prefix: string) =>
  `${prefix}_${RUN.toUpperCase().slice(-6)}${next()}`.slice(0, 16);
const inviteAddress = () => `audit.invitee.${RUN}.${next()}@client.example`;

type Headers = Record<string, string>;
type Json = Record<string, unknown>;

const A = asUser(TENANT_A, USER_A_SUPERVISOR);
const A_AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const A_AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const A_NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const B = asUser(TENANT_B, USER_B_AGENT_1);

const SEEDED_USERS = SEED_TENANTS.flatMap((tenant) => tenant.users);
const userIdOf = (headers: Headers): string => {
  const id = Object.values(headers).find((value) => SEEDED_USERS.some((user) => user.id === value));
  if (id === undefined) throw new Error('Fixture drift: headers name no seeded user');
  return id;
};

/** A valid `SlaPolicyWrite` minus `version` (same body as the T-0028 suite). */
const SLA_BODY = {
  targets: [
    {
      channel: 'whatsapp',
      firstResponseSeconds: 120,
      resolutionSeconds: 86_400,
      clock: 'business_hours',
    },
    { channel: 'voice', firstResponseSeconds: 20, resolutionSeconds: null, clock: 'always' },
  ],
  pauseOutsideOperatingHours: false,
  pauseAwaitingCustomer: true,
  warnAtPercentOfTarget: 75,
  warnNotifyRole: 'team_lead',
  breachNotifyRole: 'programme_manager_and_client',
};

/** A valid `RetentionPolicyWrite` minus `version`. */
const RETENTION_BODY = {
  callRecordingsDays: 2555,
  messageTranscriptsDays: 2555,
  screenRecordingsDays: 90,
  qaEvaluationsDays: 1095,
  onExpiry: 'delete',
  redactSensitiveNumbersInTranscripts: true,
  legalHold: false,
};

/** D-L50: the first retention write for a programme with no policy sends version 0. */
const NO_POLICY_VERSION = 0;

// --- shape checks transcribed from docs/api/admin.openapi.yaml -------------

interface AuditChange {
  field: string;
  before?: string | null;
  after?: string | null;
  redacted: boolean;
}

interface AuditEntry {
  id: string;
  occurredAt: string;
  actor: { kind: string; id?: string | null; displayName: string; roleName?: string | null };
  action: string;
  objectType: string;
  objectLabel: string;
  objectId?: string | null;
  programmeId?: string | null;
  sourceIp?: string | null;
  sourceLocation?: string | null;
  changes?: AuditChange[];
}

interface AuditEventList {
  items: AuditEntry[];
  page: { nextCursor: string | null; hasMore: boolean };
}

const ENTRY_KEYS = [
  'id',
  'occurredAt',
  'actor',
  'action',
  'objectType',
  'objectLabel',
  'objectId',
  'programmeId',
  'sourceIp',
  'sourceLocation',
  'changes',
];
const ACTOR_KEYS = ['kind', 'id', 'displayName', 'roleName'];
const CHANGE_KEYS = ['field', 'before', 'after', 'redacted'];

function expectOnlyKeys(value: Json, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    expect(allowed, `${where} carries "${key}", which the spec does not name`).toContain(key);
  }
}

const nullableString = (value: unknown) => value === null || typeof value === 'string';

/** `#/components/schemas/AuditEntry` — the essentials of the T-0025 suite's check. */
function expectAuditEntry(value: unknown, where = 'AuditEntry'): AuditEntry {
  expect(value, `${where}: not an object`).toEqual(expect.any(Object));
  const entry = value as Json;
  expectOnlyKeys(entry, ENTRY_KEYS, where);
  expect(entry.id, `${where}.id`).toMatch(UUID);
  expect(entry.occurredAt, `${where}.occurredAt`).toMatch(UTC_ISO);
  expect(AUDIT_ACTIONS, `${where}.action`).toContain(entry.action);
  expect(entry.objectType, `${where}.objectType`).toEqual(expect.any(String));
  expect(entry.objectLabel, `${where}.objectLabel`).toEqual(expect.any(String));
  for (const key of ['objectId', 'programmeId'] as const) {
    if (entry[key] !== undefined && entry[key] !== null) {
      expect(entry[key], `${where}.${key} must be a uuid or null`).toMatch(UUID);
    }
  }
  if (entry.sourceIp !== undefined) {
    expect(entry.sourceIp, `${where}.sourceIp: nobody may see it yet`).toBeNull();
  }
  const actor = entry.actor as Json;
  expect(actor, `${where}.actor`).toEqual(expect.any(Object));
  expectOnlyKeys(actor, ACTOR_KEYS, `${where}.actor`);
  if (entry.changes !== undefined) {
    expect(Array.isArray(entry.changes), `${where}.changes must be an array`).toBe(true);
    (entry.changes as Json[]).forEach((change, index) => {
      const at = `${where}.changes[${index}]`;
      expectOnlyKeys(change, CHANGE_KEYS, at);
      expect(change.field, `${at}.field`).toEqual(expect.any(String));
      expect(typeof change.redacted, `${at}.redacted`).toBe('boolean');
      if (change.before !== undefined) expect(nullableString(change.before), at).toBe(true);
      if (change.after !== undefined) expect(nullableString(change.after), at).toBe(true);
      if (change.redacted === true) {
        expect(change.before ?? null, `${at}: redacted, so before is null`).toBeNull();
        expect(change.after ?? null, `${at}: redacted, so after is null`).toBeNull();
      }
    });
  }
  return entry as unknown as AuditEntry;
}

const changeOf = (entry: AuditEntry, field: string) =>
  (entry.changes ?? []).find((change) => change.field === field);

// --- the spec, parsed --------------------------------------------------------

interface SpecOperation {
  operationId: string;
  method: string;
  path: string;
  implemented: unknown;
  audited: unknown;
}

const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete'];

function specOperations(): SpecOperation[] {
  const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
    paths: Record<string, Record<string, Json | null>>;
  };
  const operations: SpecOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(method) || operation === null) continue;
      if (typeof operation.operationId !== 'string') continue;
      operations.push({
        operationId: operation.operationId,
        method,
        path,
        implemented: operation['x-kasuwa-implemented'],
        audited: operation['x-kasuwa-audited'],
      });
    }
  }
  return operations;
}

/** Live means `true` or `partial`: a partially built write is still a write. */
const isLive = (operation: SpecOperation) =>
  operation.implemented === true || operation.implemented === 'partial';
const isAudited = (operation: SpecOperation) => operation.audited === true;

// --- the coverage table --------------------------------------------------------

/** One call and the status it must answer. */
interface Call {
  label: string;
  send: () => Promise<request.Response>;
  status: number;
}

/**
 * How to drive one audited operation. `refusals` run first and must each
 * write nothing; then `success` runs and must write exactly `events` events,
 * every one naming `actor` as the actor.
 */
interface Probe {
  refusals: Call[];
  success: Call;
  events: number;
  actor: Headers;
}

type ProbeBuilder = () => Promise<Probe>;

/**
 * Seam S1 (T-0030): the real API with a channel provider this suite controls,
 * so an invite can be sent, and made to fail. The options object is built
 * first so the suite typechecks against `AppModuleOptions` as it is.
 */
async function createAuditApi(
  databaseUrl: string,
  channelProvider: FakeChannelProvider,
): Promise<INestApplication> {
  const options = { databaseUrl, poolMax: 5, channelProvider };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(options)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

// ---------------------------------------------------------------------------

describe('acceptance: audit coverage of every audited write (T-0033)', () => {
  let app: INestApplication;
  let appPool: Pool;
  let fake: FakeChannelProvider;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    fake = new FakeChannelProvider();
    app = await createAuditApi(inject('databaseUrl'), fake);
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const fresh = () => reseed(inject('migrationUrl'));

  // --- reading the log ------------------------------------------------------

  /** Every event the caller can read, walking the cursor. Bounded so a looping cursor fails. */
  const allEvents = async (headers: Headers, query: Json = {}): Promise<AuditEntry[]> => {
    const items: AuditEntry[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 25; pageNumber += 1) {
      const response = await request(server())
        .get(EVENTS)
        .query({ ...query, pageSize: 200, ...(cursor === null ? {} : { cursor }) })
        .set(headers);
      expect(response.status, `listAuditEvents: ${JSON.stringify(response.body)}`).toBe(200);
      const page = response.body as AuditEventList;
      expect(Array.isArray(page.items), 'AuditEventList.items must be an array').toBe(true);
      page.items.forEach((item, index) => expectAuditEntry(item, `items[${index}]`));
      items.push(...page.items);
      if (!page.page.hasMore) return items;
      cursor = page.page.nextCursor;
    }
    throw new Error('listAuditEvents never reached the last page');
  };

  /** The events `action` added to what `reader` (default: the supervisor) can see. */
  const eventsDuring = async (
    action: () => Promise<unknown>,
    reader: Headers = A,
  ): Promise<AuditEntry[]> => {
    const before = new Set((await allEvents(reader)).map((entry) => entry.id));
    await action();
    return (await allEvents(reader)).filter((entry) => !before.has(entry.id));
  };

  /** Runs one call, asserts its status, and returns the events it added. */
  const callAndCollect = async (call: Call, reader: Headers = A) => {
    let response: request.Response | undefined;
    const added = await eventsDuring(async () => {
      response = await call.send();
    }, reader);
    expect(
      response?.status,
      `${call.label}: expected ${call.status}, body: ${JSON.stringify(response?.body)}`,
    ).toBe(call.status);
    return { added, body: (response?.body ?? {}) as Json };
  };

  const single = (entries: AuditEntry[], what: string): AuditEntry => {
    expect(entries, `expected exactly one audit event for ${what}`).toHaveLength(1);
    const [entry] = entries;
    if (entry === undefined) throw new Error(`no audit event for ${what}`);
    return entry;
  };

  // --- the API, as the probes need it ---------------------------------------

  const send = (method: 'post' | 'put' | 'patch' | 'delete', path: string, headers: Headers) =>
    request(server())[method](path).set(headers);

  const expectStatus = (response: request.Response, status: number, what: string) => {
    expect(response.status, `${what}: ${JSON.stringify(response.body)}`).toBe(status);
    return response.body as Json;
  };

  const createRole = async (name: string) =>
    expectStatus(
      await send('post', ROLES, A).send({ name, parentRoleId: null }),
      201,
      'createRole (setup)',
    ) as { id: string; name: string };

  const roleTreeVersion = async () =>
    (
      expectStatus(await request(server()).get(ROLES).set(A), 200, 'listRoles') as {
        version: number;
      }
    ).version;

  const programmeVersion = async (programmeId: string) =>
    (
      expectStatus(
        await request(server()).get(programmePath(programmeId)).set(A),
        200,
        'getProgramme',
      ) as { version: number }
    ).version;

  const createDisposition = async (programmeId: string, headers: Headers = A) =>
    expectStatus(
      await send('post', dispositionsPath(programmeId), headers).send({
        code: uniqueCode('AUD'),
        label: uniqueName('Audit probe'),
        category: 'callback',
      }),
      201,
      'createDisposition (setup)',
    ) as { id: string; code: string; label: string; active: boolean };

  const dispositionIds = async (programmeId: string) =>
    (
      expectStatus(
        await request(server()).get(dispositionsPath(programmeId)).set(A),
        200,
        'listDispositions',
      ) as { items: { id: string }[] }
    ).items.map((item) => item.id);

  const slaVersion = async (programmeId: string) =>
    (
      expectStatus(
        await request(server()).get(slaPath(programmeId)).set(A),
        200,
        'getProgrammeSla',
      ) as { version: number }
    ).version;

  const matrixVersion = async () =>
    (
      expectStatus(
        await request(server()).get(MATRIX).query({ object: PROBE_OBJECT }).set(A),
        200,
        'getFieldSecurityMatrix',
      ) as { version: number }
    ).version;

  /** The seed has no object with fields; the field-security probe needs one. */
  const insertProbeObject = async () => {
    await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
      async (tx) => {
        await tx.query(
          `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
           VALUES ($1, $2, $3, 'Audit probe', true)`,
          [PROBE_OBJECT_ID, TENANT_A, PROBE_OBJECT],
        );
        for (const field of PROBE_FIELDS) {
          await tx.query(
            `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
             VALUES (gen_random_uuid(), $1, $2, $3, $3, 'text')`,
            [TENANT_A, PROBE_OBJECT_ID, field],
          );
        }
      },
    );
  };

  /**
   * THE TABLE. One entry per audited operation, keyed by operationId. Adding
   * a live audited operation to the spec without an entry here fails
   * 'every live audited operation has a probe'. Entries for operations not
   * yet live (T-0028's, until it merges) are allowed and simply wait.
   */
  const PROBES: Record<string, ProbeBuilder> = {
    // --- programmes ---------------------------------------------------------
    createProgramme: async () => {
      const name = uniqueName('Audit Coverage Programme');
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'createProgramme in another tenant’s business unit',
            send: () => send('post', PROGRAMMES, A).send({ name, businessUnitId: BU_B }),
            status: 404,
          },
          {
            label: 'createProgramme with no name',
            send: () => send('post', PROGRAMMES, A).send({ businessUnitId: BU_A }),
            status: 400,
          },
        ],
        success: {
          label: 'createProgramme',
          send: () => send('post', PROGRAMMES, A).send({ name, businessUnitId: BU_A }),
          status: 201,
        },
      };
    },

    updateProgramme: async () => {
      const version = await programmeVersion(PROGRAMME_A2);
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'updateProgramme from outside the programme',
            send: () =>
              send('patch', programmePath(PROGRAMME_A2), A_AGENT_1).send({
                version,
                name: uniqueName('Telco Y'),
              }),
            status: 404,
          },
          {
            label: 'updateProgramme with a stale version',
            send: () =>
              send('patch', programmePath(PROGRAMME_A2), A).send({
                version: version - 1,
                name: uniqueName('Telco Y'),
              }),
            status: 409,
          },
        ],
        success: {
          label: 'updateProgramme',
          send: () =>
            send('patch', programmePath(PROGRAMME_A2), A).send({
              version,
              name: uniqueName('Telco Y Retention'),
            }),
          status: 200,
        },
      };
    },

    archiveProgramme: async () => {
      // A programme of its own, so archiving it disturbs no other probe. The
      // creator becomes its first member (T-0029), so the event is readable.
      const name = uniqueName('Audit Archive Target');
      const created = expectStatus(
        await send('post', PROGRAMMES, A).send({ name, businessUnitId: BU_A }),
        201,
        'createProgramme (setup)',
      ) as { id: string };
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'archiveProgramme with the wrong confirmation',
            send: () => send('post', archivePath(created.id), A).send({ confirmation: 'archive' }),
            status: 400,
          },
          {
            label: 'archiveProgramme from outside the programme',
            send: () =>
              send('post', archivePath(created.id), A_AGENT_1).send({ confirmation: name }),
            status: 404,
          },
        ],
        success: {
          label: 'archiveProgramme',
          send: () => send('post', archivePath(created.id), A).send({ confirmation: name }),
          status: 200,
        },
      };
    },

    updateProgrammeSla: async () => {
      const version = await slaVersion(PROGRAMME_A2);
      const voice = SLA_BODY.targets[1];
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'updateProgrammeSla from outside the programme',
            send: () =>
              send('put', slaPath(PROGRAMME_A2), A_AGENT_1).send({ version, ...SLA_BODY }),
            status: 404,
          },
          {
            label: 'updateProgrammeSla with two targets for one channel (D-L50)',
            send: () =>
              send('put', slaPath(PROGRAMME_A2), A).send({
                version,
                ...SLA_BODY,
                targets: [...SLA_BODY.targets, voice],
              }),
            status: 400,
          },
        ],
        success: {
          label: 'updateProgrammeSla',
          send: () => send('put', slaPath(PROGRAMME_A2), A).send({ version, ...SLA_BODY }),
          status: 200,
        },
      };
    },

    updateProgrammeRetention: async () => ({
      actor: A,
      events: 1,
      refusals: [
        {
          label: 'updateProgrammeRetention from outside the programme',
          send: () =>
            send('put', retentionPath(PROGRAMME_A2), A_AGENT_1).send({
              version: NO_POLICY_VERSION,
              ...RETENTION_BODY,
            }),
          status: 404,
        },
        {
          label: 'updateProgrammeRetention with a zero-day period',
          send: () =>
            send('put', retentionPath(PROGRAMME_A2), A).send({
              version: NO_POLICY_VERSION,
              ...RETENTION_BODY,
              screenRecordingsDays: 0,
            }),
          status: 400,
        },
      ],
      success: {
        label: 'updateProgrammeRetention (first policy)',
        send: () =>
          send('put', retentionPath(PROGRAMME_A2), A).send({
            version: NO_POLICY_VERSION,
            ...RETENTION_BODY,
          }),
        status: 200,
      },
    }),

    invitePortalUser: async () => {
      const email = inviteAddress();
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'invitePortalUser with a malformed address',
            send: () =>
              send('post', invitePath(PROGRAMME_A2), A).send({
                email: 'not-an-address',
                access: 'viewer',
              }),
            status: 400,
          },
          {
            label: 'invitePortalUser from outside the programme',
            send: () =>
              send('post', invitePath(PROGRAMME_A2), A_AGENT_1).send({ email, access: 'viewer' }),
            status: 404,
          },
          {
            label: 'invitePortalUser when the provider is unavailable (nothing is saved)',
            send: () => {
              fake.failNextSend('unavailable');
              return send('post', invitePath(PROGRAMME_A2), A).send({ email, access: 'viewer' });
            },
            status: 503,
          },
        ],
        success: {
          label: 'invitePortalUser',
          send: () => send('post', invitePath(PROGRAMME_A2), A).send({ email, access: 'viewer' }),
          status: 202,
        },
      };
    },

    // --- dispositions -------------------------------------------------------
    createDisposition: async () => {
      const existing = await createDisposition(PROGRAMME_A2);
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'createDisposition with a code already used in the programme',
            send: () =>
              send('post', dispositionsPath(PROGRAMME_A2), A).send({
                code: existing.code,
                label: 'Duplicate',
                category: 'resolved',
              }),
            status: 409,
          },
          {
            label: 'createDisposition from outside the programme',
            send: () =>
              send('post', dispositionsPath(PROGRAMME_A2), A_AGENT_1).send({
                code: uniqueCode('OUT'),
                label: 'Outsider',
                category: 'resolved',
              }),
            status: 404,
          },
        ],
        success: {
          label: 'createDisposition',
          send: () =>
            send('post', dispositionsPath(PROGRAMME_A2), A).send({
              code: uniqueCode('NEW'),
              label: uniqueName('Callback booked'),
              category: 'callback',
            }),
          status: 201,
        },
      };
    },

    updateDisposition: async () => {
      const target = await createDisposition(PROGRAMME_A2);
      const path = dispositionPath(PROGRAMME_A2, target.id);
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'updateDisposition from outside the programme',
            send: () => send('patch', path, A_AGENT_1).send({ label: 'Outsider' }),
            status: 404,
          },
          {
            label: 'updateDisposition with an unknown category',
            send: () => send('patch', path, A).send({ category: 'vanished' }),
            status: 400,
          },
        ],
        success: {
          label: 'updateDisposition',
          send: () => send('patch', path, A).send({ label: uniqueName('Renamed probe') }),
          status: 200,
        },
      };
    },

    deleteDisposition: async () => {
      const target = await createDisposition(PROGRAMME_A2);
      const path = dispositionPath(PROGRAMME_A2, target.id);
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'deleteDisposition from outside the programme',
            send: () => send('delete', path, A_AGENT_1),
            status: 404,
          },
        ],
        success: { label: 'deleteDisposition', send: () => send('delete', path, A), status: 204 },
      };
    },

    reorderDispositions: async () => {
      await createDisposition(PROGRAMME_A2);
      await createDisposition(PROGRAMME_A2);
      const ids = await dispositionIds(PROGRAMME_A2);
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'reorderDispositions with a subset of the list',
            send: () =>
              send('put', orderPath(PROGRAMME_A2), A).send({ dispositionIds: ids.slice(1) }),
            status: 400,
          },
          {
            label: 'reorderDispositions from outside the programme',
            send: () =>
              send('put', orderPath(PROGRAMME_A2), A_AGENT_1).send({
                dispositionIds: [...ids].reverse(),
              }),
            status: 404,
          },
        ],
        success: {
          label: 'reorderDispositions',
          send: () =>
            send('put', orderPath(PROGRAMME_A2), A).send({ dispositionIds: [...ids].reverse() }),
          status: 200,
        },
      };
    },

    // --- roles --------------------------------------------------------------
    createRole: async () => ({
      actor: A,
      events: 1,
      refusals: [
        {
          label: 'createRole with an empty name',
          send: () => send('post', ROLES, A).send({ name: '', parentRoleId: null }),
          status: 400,
        },
      ],
      success: {
        label: 'createRole',
        send: () =>
          send('post', ROLES, A).send({ name: uniqueName('Audit Planner'), parentRoleId: null }),
        status: 201,
      },
    }),

    updateRole: async () => {
      const role = await createRole(uniqueName('Audit Lead'));
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'updateRole on a role that does not exist',
            send: () => send('patch', `${ROLES}/${NO_SUCH_ROLE}`, A).send({ name: 'Ghost' }),
            status: 404,
          },
        ],
        success: {
          label: 'updateRole',
          send: () =>
            send('patch', `${ROLES}/${role.id}`, A).send({ name: uniqueName('Audit Manager') }),
          status: 200,
        },
      };
    },

    deleteRole: async () => {
      const doomed = await createRole(uniqueName('Audit Doomed'));
      const destination = await createRole(uniqueName('Audit Destination'));
      return {
        actor: A,
        events: 1,
        refusals: [
          {
            label: 'deleteRole on a role that does not exist',
            send: () =>
              send('delete', `${ROLES}/${NO_SUCH_ROLE}`, A).query({
                reassignUsersToRoleId: destination.id,
              }),
            status: 404,
          },
        ],
        success: {
          label: 'deleteRole',
          send: () =>
            send('delete', `${ROLES}/${doomed.id}`, A).query({
              reassignUsersToRoleId: destination.id,
            }),
          status: 204,
        },
      };
    },

    updateRoleHierarchy: async () => {
      const root = await createRole(uniqueName('Audit Director'));
      const first = await createRole(uniqueName('Audit Lead A'));
      const second = await createRole(uniqueName('Audit Lead B'));
      const version = await roleTreeVersion();
      return {
        actor: A,
        // "audited with the full before and after parent for every moved role."
        events: 2,
        refusals: [
          {
            label: 'updateRoleHierarchy with no moves',
            send: () => send('put', HIERARCHY, A).send({ version, moves: [] }),
            status: 400,
          },
        ],
        success: {
          label: 'updateRoleHierarchy (two moves)',
          send: () =>
            send('put', HIERARCHY, A).send({
              version,
              moves: [
                { roleId: first.id, parentRoleId: root.id },
                { roleId: second.id, parentRoleId: root.id },
              ],
            }),
          status: 200,
        },
      };
    },

    // --- field security -----------------------------------------------------
    updateFieldSecurityMatrix: async () => {
      const version = await matrixVersion();
      return {
        actor: A,
        // "every changed cell is a separate audit row". A never-saved cell is `edit`.
        events: 2,
        refusals: [
          {
            label: 'updateFieldSecurityMatrix touching the locked Admin set',
            send: () =>
              send('put', MATRIX, A).send({
                objectApiName: PROBE_OBJECT,
                version,
                changes: [
                  { fieldApiName: 'probe_priority', permissionSetId: 'agent', level: 'read' },
                  { fieldApiName: 'probe_notes', permissionSetId: 'admin', level: 'none' },
                ],
              }),
            status: 403,
          },
        ],
        success: {
          label: 'updateFieldSecurityMatrix (two cells)',
          send: () =>
            send('put', MATRIX, A).send({
              objectApiName: PROBE_OBJECT,
              version,
              changes: [
                { fieldApiName: 'probe_priority', permissionSetId: 'agent', level: 'read' },
                { fieldApiName: 'probe_notes', permissionSetId: 'qa_analyst', level: 'none' },
              ],
            }),
          status: 200,
        },
      };
    },

    // --- audit ---------------------------------------------------------------
    createAuditExport: async () => ({
      actor: A,
      events: 1,
      refusals: [
        {
          label: 'createAuditExport in an unknown format',
          send: () => send('post', EXPORTS, A).send({ format: 'pdf', scope: 'last_90_days' }),
          status: 400,
        },
      ],
      success: {
        label: 'createAuditExport',
        send: () => send('post', EXPORTS, A).send({ format: 'csv', scope: 'last_90_days' }),
        status: 202,
      },
    }),
  };

  // --- 1. the table is complete ----------------------------------------------

  it('every live audited operation in the spec has a probe, and every probe names an audited operation', () => {
    const operations = specOperations();
    const liveAudited = operations.filter((op) => isLive(op) && isAudited(op));
    expect(
      liveAudited.length,
      'the spec has no live audited operation at all — the parse is wrong',
    ).toBeGreaterThanOrEqual(10);

    const missing = liveAudited
      .map((op) => op.operationId)
      .filter((operationId) => !(operationId in PROBES));
    expect(
      missing,
      'live x-kasuwa-audited operations with no entry in PROBES: a write would ship unaudited',
    ).toEqual([]);

    // A stale entry is a sign the spec was renamed under this file.
    const audited = new Set(operations.filter(isAudited).map((op) => op.operationId));
    for (const operationId of Object.keys(PROBES)) {
      expect(audited.has(operationId), `PROBES.${operationId} is not an audited operation`).toBe(
        true,
      );
    }

    // A read is never marked audited by accident.
    for (const op of operations.filter(isAudited)) {
      expect(op.method, `${op.operationId} is audited but is a GET`).not.toBe('get');
    }
  });

  it('the spec marks the T-0028 writes live and audited, so the coverage check reaches them', () => {
    const byId = new Map(specOperations().map((op) => [op.operationId, op]));
    for (const operationId of ['updateProgrammeSla', 'updateProgrammeRetention']) {
      const op = byId.get(operationId);
      expect(op, `${operationId} not found in admin.openapi.yaml`).toBeDefined();
      expect(op?.implemented, `${operationId} is not marked implemented`).toBe(true);
      expect(op?.audited, `${operationId} is not marked audited`).toBe(true);
    }
    for (const operationId of [
      'invitePortalUser',
      'createDisposition',
      'updateDisposition',
      'deleteDisposition',
      'reorderDispositions',
    ]) {
      expect(byId.get(operationId)?.audited, `${operationId} is not marked audited`).toBe(true);
    }
  });

  // --- 2. the coverage check -----------------------------------------------

  it('every live audited operation writes its events on success, by the session user, and none on refusal', async () => {
    const liveAudited = specOperations().filter((op) => isLive(op) && isAudited(op));
    const failures: string[] = [];
    try {
      await insertProbeObject();
      for (const op of liveAudited) {
        const build = PROBES[op.operationId];
        if (build === undefined) {
          failures.push(`${op.operationId}: no probe (see the table test)`);
          continue;
        }
        const probe = await build();

        for (const refusal of probe.refusals) {
          const { added } = await callAndCollect(refusal);
          if (added.length !== 0) {
            failures.push(
              `${op.operationId}: refused call "${refusal.label}" wrote ${added.length} event(s)`,
            );
          }
        }

        const { added } = await callAndCollect(probe.success);
        if (added.length !== probe.events) {
          failures.push(
            `${op.operationId}: success wrote ${added.length} event(s), expected ${probe.events}`,
          );
        }
        const actorId = userIdOf(probe.actor);
        for (const entry of added) {
          if (entry.actor.kind !== 'user' || entry.actor.id !== actorId) {
            failures.push(`${op.operationId}: event ${entry.id} does not name the session user`);
          }
        }
      }
      expect(failures, failures.join('\n')).toEqual([]);
    } finally {
      await fresh();
    }
  });

  // --- 3. the writes T-0025 could not reach ----------------------------------

  it('updateProgrammeSla writes one `updated` sla_policy event per save, naming only what moved; refusals write none', async () => {
    try {
      const firstVersion = await slaVersion(PROGRAMME_A2);
      const first = await callAndCollect({
        label: 'first SLA save',
        send: () =>
          send('put', slaPath(PROGRAMME_A2), A).send({ version: firstVersion, ...SLA_BODY }),
        status: 200,
      });
      const firstEntry = single(first.added, 'the first SLA save');
      expect(firstEntry.action).toBe('updated');
      expect(firstEntry.objectType).toBe('sla_policy');
      expect(firstEntry.objectId, 'the SLA belongs to the programme').toBe(PROGRAMME_A2);
      expect(firstEntry.programmeId, 'the write happened inside A2').toBe(PROGRAMME_A2);
      expect(firstEntry.actor.id).toBe(USER_A_SUPERVISOR);
      const savedVersion = (first.body as { version: number }).version;

      // Change one number: one event, one change, before and after as strings.
      const second = await callAndCollect({
        label: 'second SLA save',
        send: () =>
          send('put', slaPath(PROGRAMME_A2), A).send({
            version: savedVersion,
            ...SLA_BODY,
            warnAtPercentOfTarget: 90,
          }),
        status: 200,
      });
      const secondEntry = single(second.added, 'the second SLA save');
      expect(changeOf(secondEntry, 'warnAtPercentOfTarget')).toEqual(
        expect.objectContaining({ before: '75', after: '90', redacted: false }),
      );
      expect(
        changeOf(secondEntry, 'pauseAwaitingCustomer'),
        'an unchanged field is not a change',
      ).toBeUndefined();

      // A stale version applies nothing, so it audits nothing.
      const stale = await callAndCollect({
        label: 'stale SLA save',
        send: () =>
          send('put', slaPath(PROGRAMME_A2), A).send({
            version: savedVersion,
            ...SLA_BODY,
            warnAtPercentOfTarget: 60,
          }),
        status: 409,
      });
      expect(stale.body.code).toBe('stale_write');
      expect(stale.added, 'a stale SLA write was audited').toEqual([]);
    } finally {
      await fresh();
    }
  });

  it('updateProgrammeRetention audits each deliberate step once, and the refused lift-and-shorten not at all', async () => {
    const put = (version: number, overrides: Partial<typeof RETENTION_BODY>) =>
      send('put', retentionPath(PROGRAMME_A2), A).send({
        ...RETENTION_BODY,
        version,
        ...overrides,
      });
    try {
      const created = await callAndCollect({
        label: 'first retention policy (version 0, D-L50)',
        send: () => put(NO_POLICY_VERSION, {}),
        status: 200,
      });
      const createdEntry = single(created.added, 'the first retention write');
      expect(createdEntry.action).toBe('updated');
      expect(createdEntry.objectType).toBe('retention_policy');
      expect(createdEntry.objectId).toBe(PROGRAMME_A2);
      expect(createdEntry.programmeId).toBe(PROGRAMME_A2);

      const held = await callAndCollect({
        label: 'put the programme on legal hold',
        send: () => put((created.body as { version: number }).version, { legalHold: true }),
        status: 200,
      });
      expect(changeOf(single(held.added, 'legal hold on'), 'legalHold')).toEqual(
        expect.objectContaining({ before: 'false', after: 'true', redacted: false }),
      );
      const heldVersion = (held.body as { version: number }).version;

      // "Turning a hold off and shortening a period in the same request is 409."
      const together = await callAndCollect({
        label: 'lift the hold and shorten together',
        send: () => put(heldVersion, { legalHold: false, screenRecordingsDays: 30 }),
        status: 409,
      });
      expect(together.body.code).toBe('legal_hold_active');
      expect(together.added, 'a refused retention write was audited').toEqual([]);

      // "Two deliberate steps, two audit rows."
      const lifted = await callAndCollect({
        label: 'lift the hold',
        send: () => put(heldVersion, { legalHold: false }),
        status: 200,
      });
      expect(changeOf(single(lifted.added, 'legal hold off'), 'legalHold')).toEqual(
        expect.objectContaining({ before: 'true', after: 'false', redacted: false }),
      );
      const shortened = await callAndCollect({
        label: 'shorten screen recordings',
        send: () => put((lifted.body as { version: number }).version, { screenRecordingsDays: 30 }),
        status: 200,
      });
      const shortenedEntry = single(shortened.added, 'shortening a period');
      expect(changeOf(shortenedEntry, 'screenRecordingsDays')).toEqual(
        expect.objectContaining({ before: '90', after: '30', redacted: false }),
      );
      expect(changeOf(shortenedEntry, 'legalHold'), 'the hold did not move').toBeUndefined();
    } finally {
      await fresh();
    }
  });

  it('invitePortalUser writes one `invited` event whose address is a redacted change, never its value', async () => {
    const email = inviteAddress();
    const localPart = email.split('@')[0] ?? email;
    const displayName = `Invitee ${RUN}`;
    try {
      const invited = await callAndCollect({
        label: 'invitePortalUser',
        send: () =>
          send('post', invitePath(PROGRAMME_A2), A).send({ email, displayName, access: 'viewer' }),
        status: 202,
      });
      const portalUserId = (invited.body as { id: string }).id;
      const entry = single(invited.added, 'invitePortalUser');
      expect(entry.action).toBe('invited');
      expect(entry.objectType).toBe('portal_user');
      expect(entry.objectId, 'the opaque id is the portal user').toBe(portalUserId);
      expect(entry.programmeId, 'granting an outsider sight of A2 happened in A2').toBe(
        PROGRAMME_A2,
      );
      expect(entry.actor.id).toBe(USER_A_SUPERVISOR);
      expect(changeOf(entry, 'access')).toEqual(
        expect.objectContaining({ after: 'viewer', redacted: false }),
      );
      // D-L52: the address is recorded only as a redacted change.
      expect(changeOf(entry, 'email'), 'the invited address is not recorded as redacted').toEqual(
        expect.objectContaining({ redacted: true }),
      );

      // Nowhere the log answers — events as any reader, filter options — carries it.
      const options = await request(server()).get(FILTER_OPTIONS).set(A).expect(200);
      const raw = JSON.stringify({
        supervisor: await allEvents(A),
        agentTwo: await allEvents(A_AGENT_2),
        options: options.body as unknown,
      }).toLowerCase();
      expect(raw, 'the audit log discloses the invited address').not.toContain(email.toLowerCase());
      expect(raw, 'the audit log discloses the address local part').not.toContain(
        localPart.toLowerCase(),
      );
      expect(raw, 'the audit log names the invitee').not.toContain(displayName.toLowerCase());
    } finally {
      await fresh();
    }
  });

  it('a resend is one more `invited` event for the same portal user; a send that fails saves and audits nothing', async () => {
    const email = inviteAddress();
    const invite = () =>
      send('post', invitePath(PROGRAMME_A2), A).send({ email, access: 'reports_only' });
    try {
      // The provider is down: "Nothing was saved", so nothing was done to audit.
      const failed = await callAndCollect({
        label: 'invite while the provider is unavailable',
        send: () => {
          fake.failNextSend('unavailable');
          return invite();
        },
        status: 503,
      });
      expect(failed.added, 'a 503 invite left an audit row behind').toEqual([]);

      const first = await callAndCollect({ label: 'first invite', send: invite, status: 202 });
      const id = (first.body as { id: string }).id;
      single(first.added, 'the first invite');

      // D-L49: a resend rotates the token — a successful, consequential write.
      const resent = await callAndCollect({ label: 'resend', send: invite, status: 202 });
      expect((resent.body as { id: string }).id, 'a resend keeps the id').toBe(id);
      const resendEntry = single(resent.added, 'the resend');
      expect(resendEntry.action).toBe('invited');
      expect(resendEntry.objectId).toBe(id);
      expect(resendEntry.programmeId).toBe(PROGRAMME_A2);

      // A malformed address is refused before anything happens.
      const malformed = await callAndCollect({
        label: 'malformed invite',
        send: () =>
          send('post', invitePath(PROGRAMME_A2), A).send({ email: 'nobody', access: 'viewer' }),
        status: 400,
      });
      expect(malformed.added).toEqual([]);
    } finally {
      await fresh();
    }
  });

  it('disposition writes are audited as `disposition` events inside their programme, with the field that moved', async () => {
    try {
      const code = uniqueCode('PTP');
      const label = uniqueName('Promise to pay');
      const created = await callAndCollect({
        label: 'createDisposition',
        send: () =>
          send('post', dispositionsPath(PROGRAMME_A2), A).send({
            code,
            label,
            category: 'promise_to_pay',
          }),
        status: 201,
      });
      const id = (created.body as { id: string }).id;
      const createdEntry = single(created.added, 'createDisposition');
      expect(createdEntry.action).toBe('created');
      expect(createdEntry.objectType).toBe('disposition');
      expect(createdEntry.objectId).toBe(id);
      expect(createdEntry.programmeId).toBe(PROGRAMME_A2);

      const relabel = uniqueName('Promised payment');
      const updated = await callAndCollect({
        label: 'updateDisposition (label)',
        send: () => send('patch', dispositionPath(PROGRAMME_A2, id), A).send({ label: relabel }),
        status: 200,
      });
      const updatedEntry = single(updated.added, 'updateDisposition');
      expect(updatedEntry.action).toBe('updated');
      expect(updatedEntry.objectId).toBe(id);
      expect(changeOf(updatedEntry, 'label')).toEqual(
        expect.objectContaining({ before: label, after: relabel, redacted: false }),
      );

      // "Deactivate instead" is the recommended path; it is audited as its own value.
      const deactivated = await callAndCollect({
        label: 'updateDisposition (deactivate)',
        send: () => send('patch', dispositionPath(PROGRAMME_A2, id), A).send({ active: false }),
        status: 200,
      });
      expect(changeOf(single(deactivated.added, 'deactivation'), 'active')).toEqual(
        expect.objectContaining({ before: 'true', after: 'false', redacted: false }),
      );

      const deleted = await callAndCollect({
        label: 'deleteDisposition',
        send: () => send('delete', dispositionPath(PROGRAMME_A2, id), A),
        status: 204,
      });
      const deletedEntry = single(deleted.added, 'deleteDisposition');
      expect(deletedEntry.action).toBe('deleted');
      expect(deletedEntry.objectType).toBe('disposition');
      expect(deletedEntry.objectId).toBe(id);
      expect(deletedEntry.programmeId).toBe(PROGRAMME_A2);

      // A duplicate code is refused whole, and a refusal is not an event.
      const other = await createDisposition(PROGRAMME_A2);
      const duplicate = await callAndCollect({
        label: 'createDisposition with a duplicate code',
        send: () =>
          send('post', dispositionsPath(PROGRAMME_A2), A).send({
            code: other.code,
            label: 'Again',
            category: 'resolved',
          }),
        status: 409,
      });
      expect(duplicate.added).toEqual([]);
    } finally {
      await fresh();
    }
  });

  it('reorderDispositions is one `updated` event for the programme, not one per row, and a subset writes none', async () => {
    try {
      await createDisposition(PROGRAMME_A2);
      await createDisposition(PROGRAMME_A2);
      await createDisposition(PROGRAMME_A2);
      const ids = await dispositionIds(PROGRAMME_A2);
      expect(ids.length).toBeGreaterThanOrEqual(3);

      const subset = await callAndCollect({
        label: 'reorder with a subset',
        send: () =>
          send('put', orderPath(PROGRAMME_A2), A).send({ dispositionIds: ids.slice(0, 2) }),
        status: 400,
      });
      expect(subset.added).toEqual([]);

      const reordered = await callAndCollect({
        label: 'reorderDispositions',
        send: () =>
          send('put', orderPath(PROGRAMME_A2), A).send({ dispositionIds: [...ids].reverse() }),
        status: 200,
      });
      const entry = single(reordered.added, 'reorderDispositions');
      expect(entry.action).toBe('updated');
      expect(entry.programmeId).toBe(PROGRAMME_A2);
      expect(entry.actor.id).toBe(USER_A_SUPERVISOR);
    } finally {
      await fresh();
    }
  });

  // --- 4. visibility (D-L48) -------------------------------------------------

  it('the new programme-scoped events are visible to members of that programme only', async () => {
    try {
      const ids: string[] = [];
      const collect = async (call: Call) => {
        const { added } = await callAndCollect(call);
        expect(added.length, `${call.label} wrote no event`).toBeGreaterThan(0);
        for (const entry of added) {
          // A programme write audited with no programme is readable tenant-wide.
          expect(entry.programmeId, `${call.label}: the event must carry A2`).toBe(PROGRAMME_A2);
          ids.push(entry.id);
        }
      };

      const version = await slaVersion(PROGRAMME_A2);
      await collect({
        label: 'updateProgrammeSla',
        send: () => send('put', slaPath(PROGRAMME_A2), A).send({ version, ...SLA_BODY }),
        status: 200,
      });
      await collect({
        label: 'updateProgrammeRetention',
        send: () =>
          send('put', retentionPath(PROGRAMME_A2), A).send({
            version: NO_POLICY_VERSION,
            ...RETENTION_BODY,
          }),
        status: 200,
      });
      await collect({
        label: 'createDisposition',
        send: () =>
          send('post', dispositionsPath(PROGRAMME_A2), A).send({
            code: uniqueCode('VIS'),
            label: uniqueName('Visible'),
            category: 'resolved',
          }),
        status: 201,
      });
      await collect({
        label: 'invitePortalUser',
        send: () =>
          send('post', invitePath(PROGRAMME_A2), A).send({
            email: inviteAddress(),
            access: 'viewer',
          }),
        status: 202,
      });

      // Agent 2 is in A2: every one of them is theirs to read.
      const agentTwo = new Set((await allEvents(A_AGENT_2)).map((entry) => entry.id));
      for (const id of ids) {
        expect(agentTwo.has(id), `USER_A_AGENT_2 (A2) cannot read event ${id}`).toBe(true);
      }

      // Agent 1 (A1 only), the user with no programme, and tenant B: none of them.
      for (const [label, headers] of [
        ['USER_A_AGENT_1 (A1 only)', A_AGENT_1],
        ['USER_A_NO_PROGRAMME', A_NO_PROGRAMME],
        ['tenant B', B],
      ] as const) {
        const seen = await allEvents(headers);
        expect(
          seen.filter((entry) => ids.includes(entry.id) || entry.programmeId === PROGRAMME_A2),
          `${label} can read an event from programme A2`,
        ).toEqual([]);
      }
    } finally {
      await fresh();
    }
  });

  it('an A2 member writing in A2 is the actor, and a non-member is not offered them as an actor', async () => {
    try {
      // Since T-0032 a disposition write needs the `admin` set in the
      // programme; the seed gives agent 2 `agent` in A2. This test is about
      // who the actor is, not about permissions, so grant it first. `fresh()`
      // reseeds afterwards.
      const migrator = createPool({ connectionString: inject('migrationUrl'), max: 1 });
      try {
        await migrator.query(
          `UPDATE user_programme SET permission_set_id =
             (SELECT id FROM permission_set
               WHERE tenant_id = user_programme.tenant_id AND key = 'admin')
           WHERE user_id = $1 AND programme_id = $2`,
          [USER_A_AGENT_2, PROGRAMME_A2],
        );
      } finally {
        await migrator.end();
      }
      const { added } = await callAndCollect({
        label: 'createDisposition by USER_A_AGENT_2',
        send: () =>
          send('post', dispositionsPath(PROGRAMME_A2), A_AGENT_2).send({
            code: uniqueCode('AG2'),
            label: uniqueName('Agent two'),
            category: 'callback',
          }),
        status: 201,
      });
      const entry = single(added, 'createDisposition by agent 2');
      expect(entry.actor.kind).toBe('user');
      expect(entry.actor.id, 'the actor is the session user').toBe(USER_A_AGENT_2);

      // Agent 1 cannot reach A2, so agent 2's only action is invisible to them,
      // and offering agent 2 as a filter would confirm what they did.
      const options = await request(server()).get(FILTER_OPTIONS).set(A_AGENT_1).expect(200);
      const actors = (options.body as { actors: { id?: string | null }[] }).actors;
      expect(actors.map((actor) => actor.id)).not.toContain(USER_A_AGENT_2);
      const filtered = await allEvents(A_AGENT_1, { actorId: USER_A_AGENT_2 });
      expect(filtered).toEqual([]);
    } finally {
      await fresh();
    }
  });

  it('tenant B writing at tenant A programme ids gets 404 and leaves no event in either tenant', async () => {
    try {
      const before = new Set(
        [...(await allEvents(A)), ...(await allEvents(B))].map((entry) => entry.id),
      );
      const attempts: [string, () => request.Test][] = [
        [
          'updateProgrammeSla',
          () => send('put', slaPath(PROGRAMME_A1), B).send({ version: 0, ...SLA_BODY }),
        ],
        [
          'updateProgrammeRetention',
          () =>
            send('put', retentionPath(PROGRAMME_A1), B).send({
              version: NO_POLICY_VERSION,
              ...RETENTION_BODY,
            }),
        ],
        [
          'invitePortalUser',
          () =>
            send('post', invitePath(PROGRAMME_A1), B).send({
              email: inviteAddress(),
              access: 'viewer',
            }),
        ],
        [
          'createDisposition',
          () =>
            send('post', dispositionsPath(PROGRAMME_A1), B).send({
              code: uniqueCode('XTN'),
              label: 'Cross tenant',
              category: 'resolved',
            }),
        ],
      ];
      for (const [operationId, attempt] of attempts) {
        const response = await attempt();
        expect(
          response.status,
          `${operationId} from tenant B: ${JSON.stringify(response.body)}`,
        ).toBe(404);
      }
      const after = [...(await allEvents(A)), ...(await allEvents(B))].filter(
        (entry) => !before.has(entry.id),
      );
      expect(after, 'a cross-tenant write that 404ed was audited').toEqual([]);
    } finally {
      await fresh();
    }
  });
});
