import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_CONTACTS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0025, admin API: the audit log and its writer (Agent 1, M2).
 *
 * The contract is `docs/api/admin.openapi.yaml`, operations `listAuditEvents`,
 * `getAuditFilterOptions`, `createAuditExport` and `getAuditExport`, and the
 * `AuditAction`, `AuditActor`, `AuditChange`, `AuditEntry`, `AuditEventList`,
 * `AuditFilterOptions`, `CreateAuditExportRequest`, `AuditExport` and `Error`
 * schemas. The shape checks below are hand-transcribed from them — the
 * acceptance package has no OpenAPI validator. If the spec and this file
 * disagree, the spec is right and this file is the defect: say so in the
 * report, do not edit it.
 *
 * WHAT THIS SUITE IS REALLY ABOUT
 *
 *   1. D-L38's closure. Five admin writes are live and marked
 *      `x-kasuwa-audited` — createRole, updateRole, deleteRole,
 *      updateRoleHierarchy (T-0022) and updateProgramme (T-0024) — and none of
 *      them writes an audit row today. A reader with no writer is a screen that
 *      says "no events match" forever. So most tests here perform a write the
 *      system already supports and then look for its row.
 *   2. The log is the sharp edge for personal data (spec header point 3,
 *      `AuditEntry`). Entries carry only the fields the spec names, an actor
 *      is a name and a role and nothing else, and no seeded email address or
 *      phone number appears anywhere in what the log returns.
 *   3. The log is scoped like everything else: tenant B never sees tenant A's
 *      events, and an event that happened inside a programme is visible only
 *      to callers whose `user_programme` reaches that programme.
 *   4. The log cannot be rewritten by the application: `kasuwa_app` may
 *      insert into `audit_event` and read it, never update or delete it.
 *
 * Conventions this suite pins, where the spec names a thing but not its key.
 * They are the obvious choice in each case and are listed so the builder
 * meets them deliberately rather than by accident:
 *
 *   - role events carry `objectType: 'role'`, programme events
 *     `objectType: 'programme'` (the spec's own filter-options example);
 *   - a rename is a change with `field: 'name'`, a re-parent a change with
 *     `field: 'parentRoleId'` — role names and parent ids are configuration,
 *     so `redacted: false` with both values present;
 *   - an export's audit row has `action: 'exported'` and
 *     `objectId === exportId`, and `includeIpAddresses: true` is recorded as a
 *     change with `field: 'includeIpAddresses'`, `after: 'true'`;
 *   - events are returned newest first (the spec's example is ordered so, and
 *     the "Recent admin changes" card is `pageSize=5` of this endpoint).
 *
 * Callers. There is no permissions engine, so tenant A is driven as
 * USER_A_SUPERVISOR (member of A1 and A2) and tenant B as USER_B_AGENT_1.
 * `403 not_permitted` on createAuditExport is not exercised, and `sourceIp`
 * must be `null` for every caller: no permission exists yet that could allow
 * it. When the engine lands, these callers must still pass; raise it rather
 * than widen anything.
 *
 * Writes. Every test that writes reseeds in `finally`, and the suite reseeds
 * before and after. This relies on the seed clearing `audit_event` along with
 * everything else keyed to a tenant.
 */

const EVENTS = '/api/v1/admin/audit/events';
const FILTER_OPTIONS = '/api/v1/admin/audit/filter-options';
const EXPORTS = '/api/v1/admin/audit/exports';
const ROLES = '/api/v1/admin/roles';
const HIERARCHY = '/api/v1/admin/roles/hierarchy';
const PROGRAMMES = '/api/v1/admin/programmes';

/** Never a real row: same shape as the seed ids, nothing seeds it. */
const NO_SUCH_EXPORT = '11111111-0000-4000-8000-0000000a9999';

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
const uniqueName = (label: string) => `${label} ${RUN}-${(sequence += 1)}`;

const A = asUser(TENANT_A, USER_A_SUPERVISOR);
const B = asUser(TENANT_B, USER_B_AGENT_1);

const SEEDED_USERS = SEED_TENANTS.flatMap((tenant) => tenant.users);
const displayNameOf = (userId: string): string => {
  const user = SEEDED_USERS.find((candidate) => candidate.id === userId);
  if (user === undefined) {
    throw new Error(`Fixture drift: no seeded user ${userId}`);
  }
  return user.displayName;
};
const TENANT_A_USER_IDS = SEEDED_USERS.filter((user) => user.id.startsWith('11111111')).map(
  (user) => user.id,
);

// --- shape checks transcribed from docs/api/admin.openapi.yaml -------------

type Json = Record<string, unknown>;

interface AuditActor {
  kind: 'user' | 'system';
  id?: string | null;
  displayName: string;
  roleName?: string | null;
}

interface AuditChange {
  field: string;
  before?: string | null;
  after?: string | null;
  redacted: boolean;
}

interface AuditEntry {
  id: string;
  occurredAt: string;
  actor: AuditActor;
  action: string;
  objectType: string;
  objectLabel: string;
  objectId?: string | null;
  programmeId?: string | null;
  sourceIp?: string | null;
  sourceLocation?: string | null;
  changes?: AuditChange[];
}

interface Page {
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number | null;
}

interface AuditEventList {
  items: AuditEntry[];
  page: Page;
}

interface AuditExport {
  exportId: string;
  status: string;
  format: string;
  estimatedRowCount?: number | null;
  deliveryEmailHint?: string | null;
  linkExpiresAfterHours?: number | null;
  requestedAt: string;
  completedAt?: string | null;
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
const EXPORT_KEYS = [
  'exportId',
  'status',
  'format',
  'estimatedRowCount',
  'deliveryEmailHint',
  'linkExpiresAfterHours',
  'requestedAt',
  'completedAt',
];

/** Every key present must be one the schema names — personal data arrives as "one more field". */
function expectOnlyKeys(value: Json, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    expect(allowed, `${where} carries "${key}", which the spec does not name`).toContain(key);
  }
}

const nullableString = (value: unknown) => value === null || typeof value === 'string';

/** `#/components/schemas/AuditEntry`, with `AuditActor` and `AuditChange`. */
function expectAuditEntry(value: unknown, where = 'AuditEntry'): AuditEntry {
  expect(value, `${where}: not an object`).toEqual(expect.any(Object));
  const entry = value as Json;
  expectOnlyKeys(entry, ENTRY_KEYS, where);

  expect(entry.id, `${where}.id`).toMatch(UUID);
  expect(entry.occurredAt, `${where}.occurredAt must be UTC ISO 8601 with a Z`).toMatch(UTC_ISO);
  expect(AUDIT_ACTIONS, `${where}.action`).toContain(entry.action);
  expect(entry.objectType, `${where}.objectType`).toEqual(expect.any(String));
  expect((entry.objectType as string).length, `${where}.objectType maxLength`).toBeLessThanOrEqual(
    64,
  );
  expect(entry.objectLabel, `${where}.objectLabel`).toEqual(expect.any(String));
  for (const key of ['objectId', 'programmeId'] as const) {
    if (entry[key] !== undefined && entry[key] !== null) {
      expect(entry[key], `${where}.${key} must be a uuid or null`).toMatch(UUID);
    }
  }
  // No permission exists yet that could allow an IP address to be shown, and
  // "not shown" is null (AuditEntry.sourceIp).
  if (entry.sourceIp !== undefined) {
    expect(entry.sourceIp, `${where}.sourceIp is personal data; nobody may see it yet`).toBeNull();
  }
  if (entry.sourceLocation !== undefined) {
    expect(nullableString(entry.sourceLocation), `${where}.sourceLocation`).toBe(true);
  }

  const actor = entry.actor as Json;
  expect(actor, `${where}.actor`).toEqual(expect.any(Object));
  expectOnlyKeys(actor, ACTOR_KEYS, `${where}.actor`);
  expect(['user', 'system'], `${where}.actor.kind`).toContain(actor.kind);
  expect(actor.displayName, `${where}.actor.displayName`).toEqual(expect.any(String));
  if (actor.kind === 'system') {
    expect(actor.id ?? null, `${where}: a system actor has a null id`).toBeNull();
  } else {
    expect(actor.id, `${where}.actor.id`).toMatch(UUID);
  }
  if (actor.roleName !== undefined) {
    expect(nullableString(actor.roleName), `${where}.actor.roleName`).toBe(true);
  }

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
        // "the server sends redacted: true with both values null".
        expect(change.before ?? null, `${at}: redacted, so before is null`).toBeNull();
        expect(change.after ?? null, `${at}: redacted, so after is null`).toBeNull();
      }
    });
  }
  return entry as unknown as AuditEntry;
}

/** `#/components/schemas/Page`. */
function expectPage(value: unknown): Page {
  const page = value as Json;
  expect(page, 'page').toEqual(expect.any(Object));
  expect(nullableString(page.nextCursor), 'Page.nextCursor is a string or null').toBe(true);
  expect(typeof page.hasMore, 'Page.hasMore is a boolean').toBe('boolean');
  if (page.hasMore === false) {
    expect(page.nextCursor, 'no more pages, so no cursor').toBeNull();
  } else {
    expect(page.nextCursor, 'more pages, so a cursor').toEqual(expect.any(String));
  }
  if (page.totalCount !== undefined && page.totalCount !== null) {
    expect(Number.isInteger(page.totalCount), 'Page.totalCount').toBe(true);
  }
  return page as unknown as Page;
}

/** `#/components/schemas/AuditEventList`. */
function expectEventList(value: unknown): AuditEventList {
  const list = value as Json;
  expect(Array.isArray(list.items), 'AuditEventList.items must be an array').toBe(true);
  (list.items as unknown[]).forEach((item, index) =>
    expectAuditEntry(item, `AuditEventList.items[${index}]`),
  );
  expectPage(list.page);
  return list as unknown as AuditEventList;
}

/** `#/components/schemas/AuditExport`. */
function expectAuditExport(value: unknown, where = 'AuditExport'): AuditExport {
  const body = value as Json;
  expect(body, `${where}: not an object`).toEqual(expect.any(Object));
  expectOnlyKeys(body, EXPORT_KEYS, where);
  expect(body.exportId, `${where}.exportId`).toMatch(UUID);
  expect(['queued', 'running', 'ready', 'failed', 'expired'], `${where}.status`).toContain(
    body.status,
  );
  expect(['csv', 'json'], `${where}.format`).toContain(body.format);
  expect(body.requestedAt, `${where}.requestedAt`).toMatch(UTC_ISO);
  if (body.completedAt !== undefined && body.completedAt !== null) {
    expect(body.completedAt, `${where}.completedAt`).toMatch(UTC_ISO);
  }
  for (const key of ['estimatedRowCount', 'linkExpiresAfterHours'] as const) {
    if (body[key] !== undefined && body[key] !== null) {
      expect(Number.isInteger(body[key]), `${where}.${key}`).toBe(true);
    }
  }
  // "No download URL, ever."
  expect(JSON.stringify(body), `${where} must carry no URL`).not.toMatch(/https?:\/\//iu);
  return body as unknown as AuditExport;
}

/** `#/components/schemas/Error`, with the `code` the operation names. */
function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, body: ${JSON.stringify(response.body)}`,
  ).toBe(status);
  const body = response.body as Json;
  expect(body.statusCode, 'Error.statusCode').toBe(status);
  expect(body.error, 'Error.error (the reason phrase)').toEqual(expect.any(String));
  expect(body.code, 'Error.code — clients switch on this, never on message').toBe(code);
  expect(body.message, 'Error.message').toEqual(expect.any(String));
  if (body.details !== undefined) {
    for (const detail of body.details as Json[]) {
      expect(Object.keys(detail).sort(), 'details carry path and code only').toEqual([
        'code',
        'path',
      ]);
    }
  }
  return body;
}

const changeOf = (entry: AuditEntry, field: string) =>
  (entry.changes ?? []).find((change) => change.field === field);

// ---------------------------------------------------------------------------

describe('acceptance: admin audit log API (T-0025)', () => {
  let app: INestApplication;
  let appPool: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    app = await createApi(inject('databaseUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const fresh = () => reseed(inject('migrationUrl'));

  const listEvents = async (
    headers: Record<string, string>,
    query: Record<string, string | number> = {},
  ): Promise<AuditEventList> => {
    const response = await request(server()).get(EVENTS).query(query).set(headers);
    expect(response.status, `listAuditEvents: ${JSON.stringify(response.body)}`).toBe(200);
    return expectEventList(response.body);
  };

  /** Every event matching `query`, walking the cursor. Bounded so a looping cursor fails, not hangs. */
  const allEvents = async (
    headers: Record<string, string>,
    query: Record<string, string | number> = {},
  ): Promise<AuditEntry[]> => {
    const items: AuditEntry[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 25; pageNumber += 1) {
      const page: AuditEventList = await listEvents(headers, {
        ...query,
        pageSize: 200,
        ...(cursor === null ? {} : { cursor }),
      });
      items.push(...page.items);
      if (!page.page.hasMore) return items;
      cursor = page.page.nextCursor;
    }
    throw new Error('listAuditEvents never reached the last page');
  };

  const eventsAbout = async (
    headers: Record<string, string>,
    objectId: string,
    query: Record<string, string> = {},
  ) => (await allEvents(headers, query)).filter((entry) => entry.objectId === objectId);

  const createRole = async (name: string, parentRoleId: string | null = null) => {
    const response = await request(server()).post(ROLES).set(A).send({ name, parentRoleId });
    expect(response.status, `createRole: ${JSON.stringify(response.body)}`).toBe(201);
    return response.body as { id: string; name: string; parentRoleId: string | null };
  };

  const programmeVersion = async (headers: Record<string, string>, programmeId: string) => {
    const response = await request(server()).get(`${PROGRAMMES}/${programmeId}`).set(headers);
    expect(response.status, `getProgramme: ${JSON.stringify(response.body)}`).toBe(200);
    return (response.body as { version: number }).version;
  };

  const renameProgramme = async (
    headers: Record<string, string>,
    programmeId: string,
    name: string,
  ) => {
    const version = await programmeVersion(headers, programmeId);
    const response = await request(server())
      .patch(`${PROGRAMMES}/${programmeId}`)
      .set(headers)
      .send({ version, name });
    expect(response.status, `updateProgramme: ${JSON.stringify(response.body)}`).toBe(200);
  };

  const createExport = async (headers: Record<string, string>, body: object) => {
    const response = await request(server()).post(EXPORTS).set(headers).send(body);
    expect(response.status, `createAuditExport: ${JSON.stringify(response.body)}`).toBe(202);
    return expectAuditExport(response.body, 'createAuditExport response');
  };

  /** The one event this test is about, asserting there is exactly one. */
  const single = (entries: AuditEntry[], what: string): AuditEntry => {
    expect(entries, `expected exactly one audit event for ${what}`).toHaveLength(1);
    const [entry] = entries;
    if (entry === undefined) throw new Error(`no audit event for ${what}`);
    return entry;
  };

  const expectSupervisorActor = (entry: AuditEntry) => {
    expect(entry.actor.kind).toBe('user');
    expect(entry.actor.id, 'the actor is the session user, not a guess').toBe(USER_A_SUPERVISOR);
    expect(entry.actor.displayName).toBe(displayNameOf(USER_A_SUPERVISOR));
  };

  // --- D-L38: the writes that already exist are audited --------------------

  it('createRole writes one `created` event naming the actor, the role and no programme', async () => {
    try {
      const startedAt = Date.now();
      const role = await createRole(uniqueName('Workforce Planner'));

      const entry = single(
        await eventsAbout(A, role.id, { objectType: 'role', action: 'created' }),
        'createRole',
      );
      expect(entry.action).toBe('created');
      expect(entry.objectType).toBe('role');
      expect(entry.objectId).toBe(role.id);
      expect(entry.objectLabel, 'objectLabel names the role').toBe(role.name);
      // "Roles are tenant-wide and carry no programme."
      expect(entry.programmeId ?? null).toBeNull();
      expectSupervisorActor(entry);

      const at = Date.parse(entry.occurredAt);
      expect(at, 'occurredAt is when the write happened').toBeGreaterThanOrEqual(
        startedAt - 60_000,
      );
      expect(at).toBeLessThanOrEqual(Date.now() + 60_000);
    } finally {
      await fresh();
    }
  });

  it('updateRole writes an `updated` event whose changes carry the name before and after', async () => {
    try {
      const role = await createRole(uniqueName('Head of CX'));
      const renamed = uniqueName('Head of Customer Experience');
      await request(server())
        .patch(`${ROLES}/${role.id}`)
        .set(A)
        .send({ name: renamed })
        .expect(200);

      const entry = single(
        await eventsAbout(A, role.id, { objectType: 'role', action: 'updated' }),
        'updateRole',
      );
      expectSupervisorActor(entry);
      expect(entry.objectLabel, 'objectLabel is the name as it now is').toBe(renamed);
      expect(changeOf(entry, 'name')).toEqual(
        expect.objectContaining({ before: role.name, after: renamed, redacted: false }),
      );
    } finally {
      await fresh();
    }
  });

  it('updateRoleHierarchy records the before and after parent of every moved role, and a refused write records nothing', async () => {
    try {
      const root = await createRole(uniqueName('Operations Director'));
      const first = await createRole(uniqueName('Collections Lead'));
      const second = await createRole(uniqueName('Care Lead'));

      const before = await request(server()).get(ROLES).set(A).expect(200);
      await request(server())
        .put(HIERARCHY)
        .set(A)
        .send({
          version: (before.body as { version: number }).version,
          moves: [
            { roleId: first.id, parentRoleId: root.id },
            { roleId: second.id, parentRoleId: root.id },
          ],
        })
        .expect(200);

      // "audited with the full before and after parent for every moved role."
      for (const moved of [first, second]) {
        const entry = single(
          await eventsAbout(A, moved.id, { objectType: 'role', action: 'updated' }),
          `hierarchy move of ${moved.name}`,
        );
        expectSupervisorActor(entry);
        expect(changeOf(entry, 'parentRoleId')).toEqual(
          expect.objectContaining({ before: null, after: root.id, redacted: false }),
        );
      }
      const rootUpdates = await eventsAbout(A, root.id, { action: 'updated' });
      expect(rootUpdates, 'the parent did not move; it has no update event').toEqual([]);

      // A write refused as a cycle applies nothing — so it audits no change.
      const current = await request(server()).get(ROLES).set(A).expect(200);
      const refused = await request(server())
        .put(HIERARCHY)
        .set(A)
        .send({
          version: (current.body as { version: number }).version,
          moves: [{ roleId: root.id, parentRoleId: first.id }],
        });
      expectError(refused, 409, 'role_hierarchy_cycle');
      expect(
        await eventsAbout(A, root.id, { action: 'updated' }),
        'a refused hierarchy write was audited as if applied',
      ).toEqual([]);
    } finally {
      await fresh();
    }
  });

  it('deleteRole writes a `deleted` event that keeps the role name after the role is gone', async () => {
    try {
      const doomed = await createRole(uniqueName('Area Manager'));
      const destination = await createRole(uniqueName('Back Office'));

      await request(server())
        .delete(`${ROLES}/${doomed.id}`)
        .query({ reassignUsersToRoleId: destination.id })
        .set(A)
        .expect(204);

      const entry = single(
        await eventsAbout(A, doomed.id, { objectType: 'role', action: 'deleted' }),
        'deleteRole',
      );
      expectSupervisorActor(entry);
      // "A role someone still holds cannot vanish from the audit trail."
      expect(entry.objectLabel).toBe(doomed.name);
    } finally {
      await fresh();
    }
  });

  it('updateProgramme writes an `updated` event carrying the programme, visible only inside that programme', async () => {
    try {
      const original = SEED_TENANTS[0]?.programmes.find((p) => p.id === PROGRAMME_A1)?.name;
      const renamed = uniqueName('Bank X Recoveries');
      await renameProgramme(A, PROGRAMME_A1, renamed);

      const entry = single(
        await eventsAbout(A, PROGRAMME_A1, { objectType: 'programme', action: 'updated' }),
        'updateProgramme',
      );
      expectSupervisorActor(entry);
      expect(entry.objectType).toBe('programme');
      expect(entry.programmeId, 'the action happened inside A1').toBe(PROGRAMME_A1);
      expect(changeOf(entry, 'name')).toEqual(
        expect.objectContaining({ before: original, after: renamed, redacted: false }),
      );

      // Agent 1 is in A1: the event is theirs to read.
      const agentOne = await allEvents(asUser(TENANT_A, USER_A_AGENT_1));
      expect(agentOne.map((event) => event.id)).toContain(entry.id);

      // Agent 2 (A2 only), the user with no programme, and tenant B: absent.
      // programmeId is output, not scope — visibility comes from user_programme.
      for (const [label, headers] of [
        ['USER_A_AGENT_2 (A2 only)', asUser(TENANT_A, USER_A_AGENT_2)],
        ['USER_A_NO_PROGRAMME', asUser(TENANT_A, USER_A_NO_PROGRAMME)],
        ['tenant B', B],
      ] as const) {
        const seen = await allEvents(headers);
        expect(
          seen.some((event) => event.id === entry.id || event.programmeId === PROGRAMME_A1),
          `${label} can read an event from programme A1`,
        ).toBe(false);
      }
    } finally {
      await fresh();
    }
  });

  // --- listAuditEvents: pagination, filters, validation ---------------------

  it('paginates with an opaque cursor, newest first, and a cursor carries no scope to tenant B', async () => {
    try {
      const created = [
        await createRole(uniqueName('Trainer')),
        await createRole(uniqueName('QA Analyst')),
        await createRole(uniqueName('Shift Lead')),
      ];
      const query = { objectType: 'role', action: 'created', actorId: USER_A_SUPERVISOR };

      const walked: AuditEntry[] = [];
      let cursor: string | null = null;
      let firstCursor: string | null = null;
      for (let step = 0; step < 10; step += 1) {
        const page: AuditEventList = await listEvents(A, {
          ...query,
          pageSize: 1,
          ...(cursor === null ? {} : { cursor }),
        });
        expect(page.items.length, 'pageSize=1 returns at most one item').toBeLessThanOrEqual(1);
        walked.push(...page.items);
        if (!page.page.hasMore) break;
        cursor = page.page.nextCursor;
        firstCursor ??= cursor;
      }

      const ids = walked.map((entry) => entry.id);
      expect(new Set(ids).size, 'a cursor walk repeated an event').toBe(ids.length);
      const objectIds = walked.map((entry) => entry.objectId);
      for (const role of created) {
        expect(objectIds, `the walk skipped the event for ${role.name}`).toContain(role.id);
      }
      const times = walked.map((entry) => Date.parse(entry.occurredAt));
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index], 'events are returned newest first').toBeLessThanOrEqual(
          times[index - 1] ?? Number.POSITIVE_INFINITY,
        );
      }

      // Tenant A's cursor replayed by tenant B: a 400, or a page of B's own.
      expect(firstCursor, 'three events at pageSize=1 must produce a cursor').toEqual(
        expect.any(String),
      );
      const replay = await request(server())
        .get(EVENTS)
        .query({ objectType: 'role', action: 'created', pageSize: 1, cursor: firstCursor ?? '' })
        .set(B);
      expect([200, 400]).toContain(replay.status);
      if (replay.status === 200) {
        const leaked = expectEventList(replay.body).items.filter((entry) =>
          created.some((role) => role.id === entry.objectId),
        );
        expect(leaked, 'a replayed cursor reached tenant A').toEqual([]);
      } else {
        expectError(replay, 400, 'validation_failed');
      }

      // A cursor the server never issued is refused, not interpreted.
      expectError(
        await request(server()).get(EVENTS).query({ cursor: 'not-a-cursor' }).set(A),
        400,
        'validation_failed',
      );
    } finally {
      await fresh();
    }
  });

  it('rejects malformed query parameters with validation_failed naming the path', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ pageSize: '0' }, 'pageSize'],
      [{ pageSize: '201' }, 'pageSize'],
      [{ pageSize: 'ten' }, 'pageSize'],
      [{ action: 'nuked' }, 'action'],
      [{ actorId: 'not-a-uuid' }, 'actorId'],
      [{ from: 'yesterday' }, 'from'],
      [{ to: '2026-13-45' }, 'to'],
      [{ objectType: 'x'.repeat(65) }, 'objectType'],
      [{ sourceIpPrefix: '1'.repeat(46) }, 'sourceIpPrefix'],
    ];
    for (const [query, path] of cases) {
      const response = await request(server()).get(EVENTS).query(query).set(A);
      const body = expectError(response, 400, 'validation_failed');
      expect(
        (body.details as { path: string }[] | undefined)?.map((detail) => detail.path),
        `details for ${JSON.stringify(query)}`,
      ).toContain(path);
    }

    // A client-supplied scope argument is refused or ignored — never honoured.
    const scoped = await request(server()).get(EVENTS).query({ programmeIds: PROGRAMME_A1 }).set(B);
    expect([200, 400]).toContain(scoped.status);
    if (scoped.status === 200) {
      expect(
        expectEventList(scoped.body).items.some((entry) => entry.programmeId === PROGRAMME_A1),
      ).toBe(false);
    }
  });

  it('filters narrow what the caller sees and never widen it', async () => {
    try {
      const role = await createRole(uniqueName('Back Office Lead'));
      const visible = await eventsAbout(A, role.id);
      expect(visible.length, 'the create must be visible before filtering').toBeGreaterThan(0);

      const narrowed = async (query: Record<string, string>) =>
        (await allEvents(A, query)).filter((entry) => entry.objectId === role.id);

      // Matching filters keep it.
      expect(await narrowed({ actorId: USER_A_SUPERVISOR, action: 'created' })).toHaveLength(1);
      // A different actor, action or object type drops it.
      expect(await narrowed({ actorId: USER_A_AGENT_1 })).toEqual([]);
      expect(await narrowed({ action: 'deleted' })).toEqual([]);
      expect(await narrowed({ objectType: 'programme' })).toEqual([]);
      // `from` is inclusive and `to` exclusive; a window after the write has none of it.
      const later = new Date(Date.now() + 3_600_000).toISOString();
      expect(await narrowed({ from: later })).toEqual([]);
      expect(await narrowed({ to: '2020-01-01T00:00:00.000Z' })).toEqual([]);
      // A literal prefix, not a pattern: '.*' matches no address.
      expect((await listEvents(A, { sourceIpPrefix: '.*' })).items).toEqual([]);

      // An actor in another tenant is the same empty page as an actor who did nothing.
      expect((await listEvents(A, { actorId: USER_B_AGENT_1 })).items).toEqual([]);
      expect((await listEvents(A, { actorId: USER_A_NO_PROGRAMME })).items).toEqual([]);
    } finally {
      await fresh();
    }
  });

  // --- tenant isolation ----------------------------------------------------

  it('tenant B never sees tenant A events or actors, by list, filter or filter options', async () => {
    try {
      const role = await createRole(uniqueName('Quality Lead'));
      await renameProgramme(A, PROGRAMME_A2, uniqueName('Telco Y Retention'));

      const bEvents = await allEvents(B);
      for (const entry of bEvents) {
        expect(entry.objectId, 'tenant B sees a tenant A object').not.toBe(role.id);
        expect([PROGRAMME_A1, PROGRAMME_A2]).not.toContain(entry.programmeId);
        expect(TENANT_A_USER_IDS, 'tenant B sees a tenant A actor').not.toContain(entry.actor.id);
      }
      // Filtering on A's actor from B is an empty page, not a 404 or a 403.
      expect((await listEvents(B, { actorId: USER_A_SUPERVISOR })).items).toEqual([]);

      const options = await request(server()).get(FILTER_OPTIONS).set(B).expect(200);
      const actors = (options.body as { actors: { id?: string | null }[] }).actors;
      for (const actor of actors) {
        expect(TENANT_A_USER_IDS, 'tenant B filter options list a tenant A user').not.toContain(
          actor.id,
        );
      }
    } finally {
      await fresh();
    }
  });

  // --- getAuditFilterOptions -----------------------------------------------

  it('getAuditFilterOptions lists only actors who appear in the log the caller can read', async () => {
    try {
      // Agent 2 acts only inside A2; the supervisor acts tenant-wide.
      // D-L53 (2026-10-03): renaming a programme needs a tenant admin, so agent 2
      // is made one for this test only (reseeded in `finally`). The event still
      // carries programme A2, which is what this test's visibility check is about.
      const migrator = createPool({ connectionString: inject('migrationUrl'), max: 1 });
      try {
        await migrator.query('UPDATE "user" SET is_tenant_admin = true WHERE id = $1', [
          USER_A_AGENT_2,
        ]);
      } finally {
        await migrator.end();
      }
      await renameProgramme(asUser(TENANT_A, USER_A_AGENT_2), PROGRAMME_A2, uniqueName('Telco Y'));
      await createRole(uniqueName('Workforce Analyst'));

      const optionsFor = async (headers: Record<string, string>) => {
        const response = await request(server()).get(FILTER_OPTIONS).set(headers);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const body = response.body as Json;
        expectOnlyKeys(body, ['actors', 'actions', 'objectTypes'], 'AuditFilterOptions');
        expect(Array.isArray(body.actors)).toBe(true);
        expect(Array.isArray(body.actions)).toBe(true);
        expect(Array.isArray(body.objectTypes)).toBe(true);
        for (const actor of body.actors as Json[]) {
          // `id` and `displayName` only; no email, no phone.
          expectOnlyKeys(actor, ['id', 'displayName', 'kind'], 'AuditFilterOptions.actors[]');
          expect(actor.displayName).toEqual(expect.any(String));
          expect(['user', 'system']).toContain(actor.kind);
        }
        for (const action of body.actions as unknown[]) {
          expect(AUDIT_ACTIONS).toContain(action);
        }
        for (const type of body.objectTypes as Json[]) {
          expectOnlyKeys(type, ['objectType', 'label'], 'AuditFilterOptions.objectTypes[]');
          expect(type.objectType).toEqual(expect.any(String));
          expect(type.label).toEqual(expect.any(String));
        }
        return body as {
          actors: { id?: string | null; displayName: string }[];
          objectTypes: { objectType: string }[];
        };
      };

      const supervisor = await optionsFor(A);
      const supervisorActorIds = supervisor.actors.map((actor) => actor.id);
      expect(supervisorActorIds).toContain(USER_A_SUPERVISOR);
      expect(supervisorActorIds, 'the supervisor reaches A2, so sees agent 2').toContain(
        USER_A_AGENT_2,
      );
      expect(supervisor.actors.find((actor) => actor.id === USER_A_AGENT_2)?.displayName).toBe(
        displayNameOf(USER_A_AGENT_2),
      );
      // Not a staff directory: users who did nothing are not offered.
      expect(supervisorActorIds).not.toContain(USER_A_NO_PROGRAMME);
      expect(supervisorActorIds).not.toContain(USER_A_AGENT_1);
      expect(supervisor.objectTypes.map((type) => type.objectType)).toEqual(
        expect.arrayContaining(['role', 'programme']),
      );

      // Agent 1 cannot reach A2: agent 2's only actions are invisible to them,
      // so agent 2 must not be offered — that would confirm what they did.
      const agentOne = await optionsFor(asUser(TENANT_A, USER_A_AGENT_1));
      expect(agentOne.actors.map((actor) => actor.id)).not.toContain(USER_A_AGENT_2);
      expect(
        (await listEvents(asUser(TENANT_A, USER_A_AGENT_1), { actorId: USER_A_AGENT_2 })).items,
      ).toEqual([]);
    } finally {
      await fresh();
    }
  });

  // --- createAuditExport / getAuditExport ----------------------------------

  it('createAuditExport is 202 with an AuditExport: no URL, a masked hint, and bad bodies refused', async () => {
    try {
      const created = await createExport(A, { format: 'csv', scope: 'last_90_days' });
      expect(created.status, 'an export has just been asked for').toBe('queued');
      expect(created.format).toBe('csv');

      const email = SEEDED_USERS.find((user) => user.id === USER_A_SUPERVISOR)?.email ?? '';
      if (created.deliveryEmailHint !== undefined && created.deliveryEmailHint !== null) {
        // "Masked, for the toast. Never the full address."
        expect(created.deliveryEmailHint).not.toBe(email);
        expect(created.deliveryEmailHint).not.toContain(email.split('@')[0] ?? email);
      }
      expect(JSON.stringify(created)).not.toContain(email);

      const send = (body: unknown) =>
        request(server())
          .post(EXPORTS)
          .set(A)
          .send(body as object);
      expectError(await send({ scope: 'filtered' }), 400, 'validation_failed');
      expectError(await send({ format: 'xlsx', scope: 'filtered' }), 400, 'validation_failed');
      expectError(await send({ format: 'csv', scope: 'all' }), 400, 'validation_failed');
      expectError(
        await send({ format: 'csv', scope: 'filtered', includeIpAddresses: 'yes' }),
        400,
        'validation_failed',
      );
      // additionalProperties: false — and these are scope arguments.
      expectError(
        await send({ format: 'csv', scope: 'filtered', programmeIds: [PROGRAMME_A1] }),
        400,
        'validation_failed',
      );
      expectError(
        await send({ format: 'csv', scope: 'filtered', filters: { tenantId: TENANT_B } }),
        400,
        'validation_failed',
      );
    } finally {
      await fresh();
    }
  });

  it('creating an export is itself audited, including the decision to include IP addresses', async () => {
    try {
      const plain = await createExport(A, {
        format: 'json',
        scope: 'filtered',
        filters: { objectType: 'role' },
      });
      const withIps = await createExport(A, {
        format: 'csv',
        scope: 'last_90_days',
        includeIpAddresses: true,
      });

      for (const created of [plain, withIps]) {
        const entry = single(
          await eventsAbout(A, created.exportId, { action: 'exported' }),
          `export ${created.exportId}`,
        );
        expectSupervisorActor(entry);
        expect(entry.action).toBe('exported');
      }

      const recorded = single(
        await eventsAbout(A, withIps.exportId, { action: 'exported' }),
        'the IP-bearing export',
      );
      expect(changeOf(recorded, 'includeIpAddresses')).toEqual(
        expect.objectContaining({ after: 'true', redacted: false }),
      );

      // An export request refused at validation asked for nothing; no row.
      const before = (await allEvents(A, { action: 'exported' })).length;
      await request(server())
        .post(EXPORTS)
        .set(A)
        .send({ format: 'pdf', scope: 'all' })
        .expect(400);
      expect((await allEvents(A, { action: 'exported' })).length).toBe(before);

      // Tenant B does not see tenant A's export row.
      const bExports = await allEvents(B, { action: 'exported' });
      expect(bExports.map((entry) => entry.objectId)).not.toContain(withIps.exportId);
    } finally {
      await fresh();
    }
  });

  it('getAuditExport returns the requester their export; anyone else, in any tenant, gets the no-such-export 404', async () => {
    try {
      const created = await createExport(A, { format: 'csv', scope: 'last_90_days' });

      const own = await request(server()).get(`${EXPORTS}/${created.exportId}`).set(A);
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      const polled = expectAuditExport(own.body, 'getAuditExport response');
      expect(polled.exportId).toBe(created.exportId);
      expect(polled.format).toBe('csv');
      expect(polled.requestedAt).toBe(created.requestedAt);

      // "An exportId belonging to another caller is 404, not 403" — same
      // tenant, other tenant, and nothing at all are one body.
      const missing = await request(server()).get(`${EXPORTS}/${NO_SUCH_EXPORT}`).set(A);
      expectError(missing, 404, 'not_found');
      for (const [label, headers] of [
        ['USER_A_AGENT_1 (same tenant, not the requester)', asUser(TENANT_A, USER_A_AGENT_1)],
        ['tenant B', B],
      ] as const) {
        const response = await request(server()).get(`${EXPORTS}/${created.exportId}`).set(headers);
        expectError(response, 404, 'not_found');
        expect(response.body, `${label} gets a body that differs from no-such-export`).toEqual(
          missing.body,
        );
      }

      // And the other way: tenant B's own export is invisible to tenant A.
      const bExport = await createExport(B, { format: 'json', scope: 'last_90_days' });
      const crossed = await request(server()).get(`${EXPORTS}/${bExport.exportId}`).set(A);
      expectError(crossed, 404, 'not_found');
      expect(crossed.body).toEqual(missing.body);
    } finally {
      await fresh();
    }
  });

  // --- personal data -------------------------------------------------------

  it('no seeded email address or phone number appears anywhere the audit log returns', async () => {
    try {
      const role = await createRole(uniqueName('Collections Supervisor'));
      await request(server())
        .patch(`${ROLES}/${role.id}`)
        .set(A)
        .send({ name: uniqueName('Collections Manager') })
        .expect(200);
      await renameProgramme(A, PROGRAMME_A1, uniqueName('Bank X Collections'));
      await createExport(A, { format: 'csv', scope: 'last_90_days', includeIpAddresses: true });

      const events = await allEvents(A);
      expect(events.length, 'the writes above must have produced events').toBeGreaterThanOrEqual(4);
      const options = await request(server()).get(FILTER_OPTIONS).set(A).expect(200);

      const raw = JSON.stringify({ events, options: options.body as unknown });
      for (const user of SEEDED_USERS) {
        expect(raw, `the audit log discloses ${user.id}'s email`).not.toContain(user.email);
      }
      for (const contact of SEED_CONTACTS) {
        expect(raw, `the audit log discloses contact ${contact.id}'s phone`).not.toContain(
          contact.phoneE164,
        );
        expect(raw, `the audit log names customer ${contact.id}`).not.toContain(
          contact.displayName,
        );
      }
      // No address of any kind, and no international phone number of any kind.
      expect(raw).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/u);
      expect(raw).not.toMatch(/\+\d{9,}/u);
    } finally {
      await fresh();
    }
  });

  // --- authentication and scope headers ------------------------------------

  const EVERY_OPERATION = [
    ['listAuditEvents', () => request(app.getHttpServer()).get(EVENTS)],
    ['getAuditFilterOptions', () => request(app.getHttpServer()).get(FILTER_OPTIONS)],
    [
      'createAuditExport',
      () => request(app.getHttpServer()).post(EXPORTS).send({ format: 'csv', scope: 'filtered' }),
    ],
    ['getAuditExport', () => request(app.getHttpServer()).get(`${EXPORTS}/${NO_SUCH_EXPORT}`)],
  ] as const;

  it('every operation is 401 not_authenticated without a usable session', async () => {
    for (const [operation, build] of EVERY_OPERATION) {
      expectError(await build(), 401, 'not_authenticated');

      const bogus = await build().set('authorization', 'Bearer ksw_s1_not-a-real-session');
      expect(bogus.status, `${operation} with a forged bearer token`).toBe(401);
      expectError(bogus, 401, 'not_authenticated');

      // A real user paired with the wrong tenant is not a user at all.
      const crossed = await build().set(asUser(TENANT_B, USER_A_SUPERVISOR));
      expect(crossed.status, `${operation} as a user under the wrong tenant`).toBe(401);
    }
  });

  it('every operation rejects a request that tries to supply its own scope', async () => {
    const scopeHeaders: [string, string][] = [
      ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
      ['x-kasuwa-programme-id', PROGRAMME_A2],
      ['x-kasuwa-scope', 'all'],
    ];
    try {
      for (const [operation, build] of EVERY_OPERATION) {
        for (const [header, value] of scopeHeaders) {
          const response = await build().set(asUser(TENANT_A, USER_A_AGENT_1)).set(header, value);
          expect(response.status, `${operation} with ${header}`).toBe(400);
        }
      }
    } finally {
      await fresh();
    }
  });

  // --- schema and contract -------------------------------------------------

  it('audit_event is tenant-scoped, RLS enabled and FORCED, WITH CHECK = USING, and append-only for kasuwa_app', async () => {
    const scoped: readonly string[] = TENANT_SCOPED_TABLES;
    expect(scoped, 'audit_event is missing from TENANT_SCOPED_TABLES').toContain('audit_event');

    const state = await readTableSecurity(appPool);
    const row = state.find((entry) => entry.table === 'audit_event');
    expect(row, 'table audit_event does not exist').toBeDefined();
    expect(row?.rlsEnabled, 'audit_event: RLS is not enabled').toBe(true);
    expect(row?.rlsForced, 'audit_event: RLS is not FORCED').toBe(true);
    expect(row?.policyCount, 'audit_event: has no policy').toBeGreaterThan(0);

    const tenantColumn = await appPool.query<{ nullable: string }>(
      `SELECT is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_event' AND column_name = 'tenant_id'`,
    );
    expect(tenantColumn.rows, 'audit_event has no tenant_id').toHaveLength(1);
    expect(tenantColumn.rows[0]?.nullable, 'audit_event.tenant_id must be NOT NULL').toBe('NO');

    const policies = await appPool.query<{ matching: number }>(
      `SELECT count(*) FILTER (
                WHERE p.polwithcheck IS NOT NULL
                  AND pg_get_expr(p.polwithcheck, p.polrelid) = pg_get_expr(p.polqual, p.polrelid)
              )::int AS matching
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'audit_event'`,
    );
    expect(
      policies.rows[0]?.matching ?? 0,
      'audit_event: no policy with WITH CHECK = USING',
    ).toBeGreaterThan(0);

    // Append-only: the writer inserts and the reader selects; nothing in the
    // application can rewrite or erase history. has_table_privilege counts
    // grants through PUBLIC and role membership, so a grant cannot hide.
    const privileges = await appPool.query<{ privilege: string; granted: boolean }>(
      `SELECT privilege, has_table_privilege('kasuwa_app', 'public.audit_event', privilege) AS granted
         FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS privilege`,
    );
    const granted = new Map(privileges.rows.map((entry) => [entry.privilege, entry.granted]));
    expect(granted.get('SELECT'), 'kasuwa_app must be able to read audit_event').toBe(true);
    expect(granted.get('INSERT'), 'kasuwa_app must be able to write audit_event').toBe(true);
    expect(granted.get('UPDATE'), 'kasuwa_app can UPDATE audit_event').toBe(false);
    expect(granted.get('DELETE'), 'kasuwa_app can DELETE audit_event').toBe(false);
    expect(granted.get('TRUNCATE'), 'kasuwa_app can TRUNCATE audit_event').toBe(false);
  });

  it('the spec marks every T-0025 operation x-kasuwa-implemented: true', () => {
    // The audit screens keep their mock until this flips.
    const spec = readFileSync(resolve(__dirname, '../../../docs/api/admin.openapi.yaml'), 'utf8');
    for (const operationId of [
      'listAuditEvents',
      'getAuditFilterOptions',
      'createAuditExport',
      'getAuditExport',
    ]) {
      const match = new RegExp(
        `operationId:\\s*${operationId}\\s*\\n\\s*x-kasuwa-implemented:\\s*(\\S+)`,
      ).exec(spec);
      expect(match, `${operationId} not found in admin.openapi.yaml`).not.toBeNull();
      expect(match?.[1], `${operationId} is not marked implemented`).toBe('true');
    }
  });
});
