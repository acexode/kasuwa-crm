import type { INestApplication } from '@nestjs/common';
import {
  BU_A,
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
  TENANT_A,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
} from '@kasuwa/db';
import { reseed, withForcedScope } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0032, the permissions engine (Agent 1, M2). Closes D-L51,
 * D-L40 and the `403 not_permitted` every admin write in the spec lists.
 *
 * RLS already decides what a session may SEE. This suite is about what it may
 * DO, and about the one place the database still trusts the application to
 * decide that: who may write a `user_programme` row (D-L51).
 *
 * Sources: docs/api/admin.openapi.yaml (`NotPermitted`, and every operation
 * whose responses list `'403'`), team/DECISIONS.md D-L40 and D-L51,
 * team/DECISION-LOG.md D-L06 (no wildcard scope) and D-P9 (`user_programme`
 * carries the permission set that applies to that person in that programme),
 * CLAUDE.md 2.7 (SECURITY DEFINER). If the spec and this file disagree, the
 * spec is right and this file is the defect: say so in the report, do not
 * edit it.
 *
 * ------------------------------------------------------------------------
 * THE MODEL AND THE SEAMS THE BUILDER MUST PROVIDE. Internals are yours;
 * these are not.
 *
 *   M1. A grant is a PERMISSION SET ASSIGNED PER USER PER PROGRAMME, on the
 *       membership row (D-P9): a column `user_programme.permission_set_id`,
 *       with a composite foreign key `(tenant_id, permission_set_id)` ->
 *       `permission_set (tenant_id, id)` (the target 0006 already built for
 *       it). There is no tenant-wide wildcard grant and no wildcard scope
 *       (D-L06). Nullability is yours; a NULL set means no permission.
 *
 *   M2. What a set allows is yours to model. This suite relies on these
 *       facts about the seeded sets (`SEED_PERMISSION_SETS`), per D-L53:
 *         * the locked `admin` set permits every PROGRAMME-SCOPED write below
 *           (archiveProgramme, create/update/delete/reorderDisposition,
 *           invitePortalUser) in the programme it is held in, and nowhere
 *           else;
 *         * every other set (`agent`, `team_lead`, `qa_analyst`,
 *           `programme_manager`, `client_portal`) permits none of them this
 *           round;
 *         * no set, `admin` included, permits a TENANT-LEVEL write (M4).
 *
 *   M3. The decision is re-resolved from the database on EVERY request,
 *       exactly as scope is. The suite changes a membership row's set, and a
 *       user's tenant-admin flag, between two requests and expects the second
 *       request to see it. A permission cached in the session token, or in
 *       process memory, fails here.
 *
 *   M4. TENANT ADMIN is a tenant-level flag on the user (D-L53): a column
 *       `"user".is_tenant_admin boolean`. It is NOT derived from programme
 *       membership, and holding `admin` in one, some or all programmes does
 *       not make anyone a tenant admin.
 *         * TENANT-LEVEL writes require it: createProgramme, updateProgramme
 *           (D-L40), createRole, updateRole, deleteRole, updateRoleHierarchy,
 *           updateFieldSecurityMatrix, createAuditExport.
 *         * PROGRAMME-SCOPED writes require the `admin` set in that programme
 *           OR tenant admin.
 *         * Tenant admin NEVER widens scope (D-L06): a tenant admin who is
 *           not a member of a programme gets 404 there, exactly like anybody
 *           else. RLS scope is unchanged by this task.
 *
 *   M5. The seed (`packages/db/src/seed.ts`) sets `is_tenant_admin` true for
 *       USER_A_SUPERVISOR and USER_B_AGENT_1 (tenant B's only user) and false
 *       for every other user, and assigns: USER_A_SUPERVISOR `admin` in A1 and
 *       A2; USER_A_AGENT_1 `agent` in A1; USER_A_AGENT_2 `agent` in A2
 *       (USER_B_AGENT_1's set in B1 is yours). This suite also plants tenant
 *       A's values before every test (through `kasuwa_migrator`), so it
 *       states what it relies on rather than trusting the seed silently —
 *       the seed must still match, because every other admin suite drives
 *       USER_A_SUPERVISOR and USER_B_AGENT_1 for writes.
 *
 *   M6. D-L51: `user_programme` INSERT and UPDATE are tightened IN THE
 *       DATABASE so a row can only be written for a programme already in
 *       `app.current_programme_ids()`, or for a programme created in the same
 *       transaction (the createProgramme flow). The tightening must not add a
 *       PERMISSIVE `FOR INSERT` policy — permissive policies are OR-ed, so a
 *       new one can only widen. Use `AS RESTRICTIVE`, which is AND-ed (0008's
 *       `audit_event_actor_is_session` is the precedent). The catalogue test
 *       below fails on any permissive `FOR INSERT` policy not on its
 *       allow-list.
 *
 *   M7. No new SECURITY DEFINER function (CLAUDE.md 2.7). The "created in the
 *       same transaction" marker has to be built without one, or argued for
 *       in an ADR first — in which case this file is wrong and the lead
 *       changes it, not you.
 *
 * ------------------------------------------------------------------------
 * ORDER OF ANSWERS (D-L53), which this suite holds:
 *   400 for a supplied scope header — the guard, before any of this;
 *       unchanged and not re-tested here;
 *   404 for a record the caller cannot reach — ALWAYS first, because a 403
 *       would confirm the record exists (spec `NotPermitted`, CLAUDE.md 6.4).
 *       "The record" is the one the path names: a reachable programme in the
 *       path with an unreachable disposition id is still 404;
 *   403 not_permitted for a record the caller can read but may not act on —
 *       decided BEFORE the body is validated, so an unpermitted caller learns
 *       nothing from validation either;
 *   400 validation_failed only for a permitted caller.
 *
 * A refused write is NOT audited (D-L53): a 403 writes no `audit_event` row.
 *
 * NOT asserted: `updateProgrammeSla` and `updateProgrammeRetention`, which
 * list 403 but are `x-kasuwa-implemented: false`. `reorderDispositions` gains
 * a 403 in the spec as part of this task (D-L53) and is in the table below.
 *
 * Writes. Every test reseeds afterwards, and `afterAll` reseeds again.
 */

const ADMIN = '/api/v1/admin';
const PROGRAMMES = `${ADMIN}/programmes`;
const ROLES = `${ADMIN}/roles`;
const HIERARCHY = `${ADMIN}/roles/hierarchy`;
const MATRIX = `${ADMIN}/field-security/matrix`;
const EXPORTS = `${ADMIN}/audit/exports`;

/** Never a real row: same shape as the seed ids, nothing seeds it. */
const NOWHERE = '11111111-0000-4000-8000-0000000c9999';
/** An object planted for the field-security write; reseed removes it. */
const OBJ_PROBE = '11111111-0000-4000-8000-0000003200a1';
const OBJ_PROBE_API = 'permission_probe';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unique per run so a name never collides with an earlier, unreseeded run. */
const RUN = Date.now().toString(36);
let sequence = 0;
const next = () => (sequence += 1);
const uniqueName = (label: string) => `${label} ${RUN}-${next()}`;
const uniqueCode = () => `P${RUN.toUpperCase()}${next()}`.slice(0, 16);
const uniqueAddress = () => `portal.perm-${RUN}-${next()}@client.example`;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;

function permissionSet(key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === TENANT_A && candidate.key === key,
  );
  if (set === undefined) {
    throw new Error(`Fixture drift: tenant A has no seeded permission set '${key}'`);
  }
  return set.id;
}

const ADMIN_SET = permissionSet('admin');
const AGENT_SET = permissionSet('agent');
/** D-L53 ruling 6: read-only for admin writes this round. */
const READ_ONLY_SETS = ['team_lead', 'qa_analyst', 'programme_manager', 'client_portal'].map(
  permissionSet,
);

function seededName(id: string): string {
  const programme = SEED_TENANTS.flatMap((tenant) => tenant.programmes).find(
    (candidate) => candidate.id === id,
  );
  if (programme === undefined) {
    throw new Error(`Fixture drift: no seeded programme ${id}`);
  }
  return programme.name;
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
  return body;
}

// ---------------------------------------------------------------------------

describe('acceptance: permissions engine (T-0032)', () => {
  let app: INestApplication;
  /** kasuwa_app — the role the API runs as. RLS applies. */
  let appPool: Pool;
  /** kasuwa_migrator — BYPASSRLS. Plants grants and observes rows; never serves. */
  let observer: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  /** M1: write one membership row's permission set, creating the row if needed. */
  async function assign(userId: string, programmeId: string, permissionSetId: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSetId],
    );
  }

  /** M4: set one tenant-A user's tenant-admin flag. */
  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query(
      'UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2 AND tenant_id = $3',
      [value, userId, TENANT_A],
    );
  }

  beforeEach(async () => {
    // M5: exactly what the seed must already say.
    await setTenantAdmin(USER_A_SUPERVISOR, true);
    for (const userId of [USER_A_AGENT_1, USER_A_AGENT_2, USER_A_NO_PROGRAMME]) {
      await setTenantAdmin(userId, false);
    }
    await assign(USER_A_SUPERVISOR, PROGRAMME_A1, ADMIN_SET);
    await assign(USER_A_SUPERVISOR, PROGRAMME_A2, ADMIN_SET);
    await assign(USER_A_AGENT_1, PROGRAMME_A1, AGENT_SET);
    await assign(USER_A_AGENT_2, PROGRAMME_A2, AGENT_SET);
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  async function one(sql: string, values: unknown[]): Promise<unknown> {
    const result = await observer.query<{ v: unknown }>(sql, values);
    return result.rows[0]?.v ?? null;
  }

  /** D-L53: a refused write is not audited. */
  const auditRows = () =>
    one('SELECT count(*)::int AS v FROM audit_event WHERE tenant_id = $1', [TENANT_A]);

  const programmeRow = (id: string) =>
    one('SELECT to_jsonb(p) AS v FROM programme p WHERE id = $1', [id]);

  async function versionOf(headers: Headers, programmeId: string): Promise<number> {
    const response = await request(server()).get(`${PROGRAMMES}/${programmeId}`).set(headers);
    expect(response.status, `getProgramme: ${JSON.stringify(response.body)}`).toBe(200);
    return response.body.version as number;
  }

  async function createDispositionAsSupervisor(programmeId: string): Promise<string> {
    const response = await request(server())
      .post(`${PROGRAMMES}/${programmeId}/dispositions`)
      .set(SUPERVISOR)
      .send({ code: uniqueCode(), label: 'Probe', category: 'resolved' });
    expect(response.status, `createDisposition: ${JSON.stringify(response.body)}`).toBe(201);
    return response.body.id as string;
  }

  async function createRoleAsSupervisor(parentRoleId: string | null = null): Promise<string> {
    const response = await request(server())
      .post(ROLES)
      .set(SUPERVISOR)
      .send({ name: uniqueName('Probe role'), parentRoleId });
    expect(response.status, `createRole: ${JSON.stringify(response.body)}`).toBe(201);
    return response.body.id as string;
  }

  // --- every admin write whose spec lists 403 --------------------------------

  type Context = Record<string, string | number>;

  interface Operation {
    name: string;
    /** True when the path names a programme, so an unreachable one is 404. */
    programmeScoped: boolean;
    /** M4: needs tenant admin. Otherwise `admin` in the programme OR tenant admin. */
    tenantLevel: boolean;
    prepare: (programmeId: string) => Promise<Context>;
    send: (headers: Headers, programmeId: string, context: Context) => request.Test;
    /** What the write would change, read through the observer. */
    snapshot: (programmeId: string, context: Context) => Promise<unknown>;
    success: number;
  }

  const OPERATIONS: Operation[] = [
    {
      name: 'createProgramme',
      programmeScoped: false,
      tenantLevel: true,
      prepare: async () => ({ name: uniqueName('Pesa Merchant Onboarding') }),
      send: (headers, _programmeId, context) =>
        request(server())
          .post(PROGRAMMES)
          .set(headers)
          .send({ name: context.name, businessUnitId: BU_A }),
      snapshot: async () =>
        one(
          `SELECT jsonb_build_array(
                    (SELECT count(*) FROM programme WHERE tenant_id = $1),
                    (SELECT count(*) FROM user_programme WHERE tenant_id = $1)) AS v`,
          [TENANT_A],
        ),
      success: 201,
    },
    {
      name: 'updateProgramme',
      programmeScoped: true,
      tenantLevel: true,
      prepare: async (programmeId) => ({
        version: await versionOf(SUPERVISOR, programmeId),
        name: uniqueName('Renamed'),
      }),
      send: (headers, programmeId, context) =>
        request(server())
          .patch(`${PROGRAMMES}/${programmeId}`)
          .set(headers)
          .send({ version: context.version, name: context.name }),
      snapshot: (programmeId) => programmeRow(programmeId),
      success: 200,
    },
    {
      name: 'archiveProgramme',
      programmeScoped: true,
      tenantLevel: false,
      prepare: async () => ({}),
      send: (headers, programmeId) =>
        request(server())
          .post(`${PROGRAMMES}/${programmeId}/archive`)
          .set(headers)
          .send({ confirmation: seededName(programmeId) }),
      snapshot: (programmeId) => programmeRow(programmeId),
      success: 200,
    },
    {
      name: 'createDisposition',
      programmeScoped: true,
      tenantLevel: false,
      prepare: async () => ({ code: uniqueCode() }),
      send: (headers, programmeId, context) =>
        request(server())
          .post(`${PROGRAMMES}/${programmeId}/dispositions`)
          .set(headers)
          .send({ code: context.code, label: 'Paid in full', category: 'resolved' }),
      snapshot: (programmeId) =>
        one('SELECT count(*)::int AS v FROM disposition WHERE programme_id = $1', [programmeId]),
      success: 201,
    },
    {
      name: 'updateDisposition',
      programmeScoped: true,
      tenantLevel: false,
      prepare: async (programmeId) => ({ id: await createDispositionAsSupervisor(programmeId) }),
      send: (headers, programmeId, context) =>
        request(server())
          .patch(`${PROGRAMMES}/${programmeId}/dispositions/${context.id}`)
          .set(headers)
          .send({ label: 'Relabelled', active: false }),
      snapshot: (_programmeId, context) =>
        one('SELECT to_jsonb(d) AS v FROM disposition d WHERE id = $1', [context.id]),
      success: 200,
    },
    {
      name: 'deleteDisposition',
      programmeScoped: true,
      tenantLevel: false,
      prepare: async (programmeId) => ({ id: await createDispositionAsSupervisor(programmeId) }),
      send: (headers, programmeId, context) =>
        request(server())
          .delete(`${PROGRAMMES}/${programmeId}/dispositions/${context.id}`)
          .set(headers),
      snapshot: (_programmeId, context) =>
        one('SELECT to_jsonb(d) AS v FROM disposition d WHERE id = $1', [context.id]),
      success: 204,
    },
    {
      name: 'reorderDispositions',
      programmeScoped: true,
      tenantLevel: false,
      prepare: async (programmeId) => {
        await createDispositionAsSupervisor(programmeId);
        await createDispositionAsSupervisor(programmeId);
        const list = await request(server())
          .get(`${PROGRAMMES}/${programmeId}/dispositions`)
          .set(SUPERVISOR);
        expect(list.status, `listDispositions: ${JSON.stringify(list.body)}`).toBe(200);
        const ids = (list.body.items as { id: string }[]).map((item) => item.id);
        return { reversed: ids.reverse().join(',') };
      },
      send: (headers, programmeId, context) =>
        request(server())
          .put(`${PROGRAMMES}/${programmeId}/dispositions/order`)
          .set(headers)
          .send({ dispositionIds: String(context.reversed).split(',') }),
      snapshot: (programmeId) =>
        one(
          `SELECT coalesce(jsonb_agg(id ORDER BY position), '[]'::jsonb) AS v
             FROM disposition WHERE programme_id = $1 AND deleted_at IS NULL`,
          [programmeId],
        ),
      success: 200,
    },
    {
      name: 'invitePortalUser',
      programmeScoped: true,
      tenantLevel: false,
      prepare: async () => ({ email: uniqueAddress() }),
      send: (headers, programmeId, context) =>
        request(server())
          .post(`${PROGRAMMES}/${programmeId}/portal-users/invitations`)
          .set(headers)
          .send({ email: context.email, access: 'viewer' }),
      snapshot: (programmeId) =>
        one('SELECT count(*)::int AS v FROM portal_user WHERE programme_id = $1', [programmeId]),
      success: 202,
    },
    {
      name: 'createRole',
      programmeScoped: false,
      tenantLevel: true,
      prepare: async () => ({ name: uniqueName('Collections Lead') }),
      send: (headers, _programmeId, context) =>
        request(server()).post(ROLES).set(headers).send({ name: context.name, parentRoleId: null }),
      snapshot: () => one('SELECT count(*)::int AS v FROM role WHERE tenant_id = $1', [TENANT_A]),
      success: 201,
    },
    {
      name: 'updateRole',
      programmeScoped: false,
      tenantLevel: true,
      prepare: async () => ({ id: await createRoleAsSupervisor(), name: uniqueName('Renamed') }),
      send: (headers, _programmeId, context) =>
        request(server()).patch(`${ROLES}/${context.id}`).set(headers).send({ name: context.name }),
      snapshot: (_programmeId, context) =>
        one('SELECT to_jsonb(r) AS v FROM role r WHERE id = $1', [context.id]),
      success: 200,
    },
    {
      name: 'deleteRole',
      programmeScoped: false,
      tenantLevel: true,
      prepare: async () => ({
        id: await createRoleAsSupervisor(),
        target: await createRoleAsSupervisor(),
      }),
      send: (headers, _programmeId, context) =>
        request(server())
          .delete(`${ROLES}/${context.id}`)
          .query({ reassignUsersToRoleId: context.target })
          .set(headers),
      snapshot: (_programmeId, context) =>
        one('SELECT to_jsonb(r) AS v FROM role r WHERE id = $1', [context.id]),
      success: 204,
    },
    {
      name: 'updateRoleHierarchy',
      programmeScoped: false,
      tenantLevel: true,
      prepare: async () => {
        const parent = await createRoleAsSupervisor();
        const child = await createRoleAsSupervisor();
        const list = await request(server()).get(ROLES).set(SUPERVISOR);
        expect(list.status, `listRoles: ${JSON.stringify(list.body)}`).toBe(200);
        return { parent, child, version: list.body.version as number };
      },
      send: (headers, _programmeId, context) =>
        request(server())
          .put(HIERARCHY)
          .set(headers)
          .send({
            version: context.version,
            moves: [{ roleId: context.child, parentRoleId: context.parent }],
          }),
      snapshot: () =>
        one(
          `SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) AS v
             FROM role r WHERE tenant_id = $1`,
          [TENANT_A],
        ),
      success: 200,
    },
    {
      name: 'updateFieldSecurityMatrix',
      programmeScoped: false,
      tenantLevel: true,
      prepare: async () => {
        await observer.query(
          `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
           VALUES ($1, $2, $3, 'Permission probe', true)`,
          [OBJ_PROBE, TENANT_A, OBJ_PROBE_API],
        );
        await observer.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
           VALUES (gen_random_uuid(), $1, $2, 'priority', 'priority', 'text')`,
          [TENANT_A, OBJ_PROBE],
        );
        const matrix = await request(server())
          .get(MATRIX)
          .query({ object: OBJ_PROBE_API })
          .set(SUPERVISOR);
        expect(matrix.status, `getFieldSecurityMatrix: ${JSON.stringify(matrix.body)}`).toBe(200);
        return { version: matrix.body.version as number };
      },
      send: (headers, _programmeId, context) =>
        request(server())
          .put(MATRIX)
          .set(headers)
          .send({
            objectApiName: OBJ_PROBE_API,
            version: context.version,
            // A non-locked set, so a permitted caller's write is a 200 — a
            // change to the locked set is the spec's OTHER 403.
            changes: [{ fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' }],
          }),
      snapshot: () =>
        one(
          `SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.field_id, g.permission_set_id),
                           '[]'::jsonb) AS v
             FROM field_security_grant g WHERE tenant_id = $1`,
          [TENANT_A],
        ),
      success: 200,
    },
    {
      name: 'createAuditExport',
      programmeScoped: false,
      tenantLevel: true,
      prepare: async () => ({}),
      send: (headers) =>
        request(server()).post(EXPORTS).set(headers).send({ format: 'csv', scope: 'last_90_days' }),
      snapshot: () =>
        one('SELECT count(*)::int AS v FROM audit_export WHERE tenant_id = $1', [TENANT_A]),
      success: 202,
    },
  ];

  const byName = (name: string): Operation => {
    const operation = OPERATIONS.find((candidate) => candidate.name === name);
    if (operation === undefined) {
      throw new Error(`no operation ${name}`);
    }
    return operation;
  };

  /** Every operation, with archiveProgramme last: an archived programme may refuse writes. */
  const archiveLast = (operations: Operation[]) => [
    ...operations.filter((candidate) => candidate.name !== 'archiveProgramme'),
    ...operations.filter((candidate) => candidate.name === 'archiveProgramme'),
  ];
  const PROGRAMME_LEVEL = OPERATIONS.filter((candidate) => !candidate.tenantLevel);
  const TENANT_LEVEL = OPERATIONS.filter((candidate) => candidate.tenantLevel);

  describe('every implemented admin write whose spec lists 403', () => {
    for (const operation of OPERATIONS) {
      it(`${operation.name}: 403 not_permitted, no change and no audit row for an agent-only caller who can read the target; ${operation.success} for a tenant admin`, async () => {
        const context = await operation.prepare(PROGRAMME_A1);
        const before = await operation.snapshot(PROGRAMME_A1, context);
        const auditBefore = await auditRows();

        // USER_A_AGENT_1 is a member of A1 — he can read the record — but
        // holds only the `agent` set there and is not a tenant admin.
        const refused = await operation.send(AGENT_1, PROGRAMME_A1, context);
        const body = expectError(refused, 403, 'not_permitted');
        expect(JSON.stringify(body), '403 never carries an id').not.toMatch(UUID);
        expect(
          await operation.snapshot(PROGRAMME_A1, context),
          `${operation.name}: a refused write changed something`,
        ).toEqual(before);
        expect(await auditRows(), `${operation.name}: a refused write was audited (D-L53)`).toBe(
          auditBefore,
        );

        const allowed = await operation.send(SUPERVISOR, PROGRAMME_A1, context);
        expect(
          allowed.status,
          `${operation.name} as a tenant admin: ${JSON.stringify(allowed.body)}`,
        ).toBe(operation.success);
        expect(
          await operation.snapshot(PROGRAMME_A1, context),
          `${operation.name}: the permitted write changed nothing`,
        ).not.toEqual(before);
      });
    }

    it('a programme the caller cannot reach is still 404 — never 403 — on every write whose path names one, and nothing changes', async () => {
      const nothing = await request(server()).get(`${PROGRAMMES}/${NOWHERE}`).set(AGENT_1);
      expectError(nothing, 404, 'not_found');

      for (const operation of OPERATIONS.filter((candidate) => candidate.programmeScoped)) {
        // Prepared in A2, which USER_A_AGENT_1 is not a member of. A 403 here
        // would tell him A2 (and the disposition in it) exists.
        const context = await operation.prepare(PROGRAMME_A2);
        const before = await operation.snapshot(PROGRAMME_A2, context);

        const response = await operation.send(AGENT_1, PROGRAMME_A2, context);
        expect(response.status, `${operation.name} on an unreachable programme`).toBe(404);
        expect(response.body, `${operation.name}: not the no-such-record body`).toEqual(
          nothing.body,
        );
        expect(await operation.snapshot(PROGRAMME_A2, context)).toEqual(before);
      }
    });

    it('a user with no membership anywhere is refused every tenant-level write with 403, and nothing changes', async () => {
      for (const operation of OPERATIONS.filter((candidate) => !candidate.programmeScoped)) {
        const context = await operation.prepare(PROGRAMME_A1);
        const before = await operation.snapshot(PROGRAMME_A1, context);

        const response = await operation.send(NO_PROGRAMME, PROGRAMME_A1, context);
        expectError(response, 403, 'not_permitted');
        expect(
          await operation.snapshot(PROGRAMME_A1, context),
          `${operation.name}: a refused write changed something`,
        ).toEqual(before);
      }
    });

    it('permission is decided before the body is validated: 404, then 403, then 400', async () => {
      // D-L53. An unpermitted caller learns nothing from validation either.
      // Each request carries an empty body, which every one of these
      // operations rejects as `validation_failed` for a permitted caller.
      const cases: {
        name: string;
        programmeScoped: boolean;
        send: (headers: Headers, programmeId: string) => request.Test;
      }[] = [
        {
          name: 'createProgramme',
          programmeScoped: false,
          send: (h) => request(server()).post(PROGRAMMES).set(h).send({}),
        },
        {
          name: 'updateProgramme',
          programmeScoped: true,
          send: (h, p) => request(server()).patch(`${PROGRAMMES}/${p}`).set(h).send({}),
        },
        {
          name: 'createDisposition',
          programmeScoped: true,
          send: (h, p) => request(server()).post(`${PROGRAMMES}/${p}/dispositions`).set(h).send({}),
        },
        {
          name: 'reorderDispositions',
          programmeScoped: true,
          send: (h, p) =>
            request(server()).put(`${PROGRAMMES}/${p}/dispositions/order`).set(h).send({}),
        },
        {
          name: 'invitePortalUser',
          programmeScoped: true,
          send: (h, p) =>
            request(server()).post(`${PROGRAMMES}/${p}/portal-users/invitations`).set(h).send({}),
        },
        {
          name: 'createRole',
          programmeScoped: false,
          send: (h) => request(server()).post(ROLES).set(h).send({}),
        },
        {
          name: 'updateRoleHierarchy',
          programmeScoped: false,
          send: (h) => request(server()).put(HIERARCHY).set(h).send({}),
        },
        {
          name: 'updateFieldSecurityMatrix',
          programmeScoped: false,
          send: (h) => request(server()).put(MATRIX).set(h).send({}),
        },
        {
          name: 'createAuditExport',
          programmeScoped: false,
          send: (h) => request(server()).post(EXPORTS).set(h).send({}),
        },
      ];

      for (const { name, programmeScoped, send } of cases) {
        const refused = await send(AGENT_1, PROGRAMME_A1);
        expect(refused.status, `${name}: unpermitted + invalid body`).toBe(403);
        expectError(refused, 403, 'not_permitted');

        const invalid = await send(SUPERVISOR, PROGRAMME_A1);
        expect(invalid.status, `${name}: permitted + invalid body`).toBe(400);
        expectError(invalid, 400, 'validation_failed');

        if (programmeScoped) {
          const unreachable = await send(AGENT_1, PROGRAMME_A2);
          expect(unreachable.status, `${name}: unreachable + invalid body`).toBe(404);
        }
      }
    });
  });

  // --- D-L40 / D-L53 ------------------------------------------------------------

  describe('D-L40: the duplicate-name oracle is closed to non-admins', () => {
    it('createProgramme and updateProgramme with a sibling’s exact name are 403 — not 409 — to non-admins, and still 409 to a tenant admin', async () => {
      const takenName = seededName(PROGRAMME_A2);
      const programmesBefore = await one(
        'SELECT count(*)::int AS v FROM programme WHERE tenant_id = $1',
        [TENANT_A],
      );
      const a1Before = await programmeRow(PROGRAMME_A1);

      // USER_A_AGENT_1 cannot read A2. Before T-0032 a 409 told him that a
      // programme called "Telco Y Care" exists in his tenant.
      for (const [label, headers] of [
        ['USER_A_AGENT_1', AGENT_1],
        ['USER_A_NO_PROGRAMME', NO_PROGRAMME],
      ] as const) {
        const created = await request(server())
          .post(PROGRAMMES)
          .set(headers)
          .send({ name: takenName, businessUnitId: BU_A });
        expect(created.status, `${label} createProgramme`).toBe(403);
        const body = expectError(created, 403, 'not_permitted');
        expect(JSON.stringify(body)).not.toContain(takenName);
        expect(JSON.stringify(body)).not.toContain(PROGRAMME_A2);
      }

      const renamed = await request(server())
        .patch(`${PROGRAMMES}/${PROGRAMME_A1}`)
        .set(AGENT_1)
        .send({ version: await versionOf(AGENT_1, PROGRAMME_A1), name: takenName });
      const body = expectError(renamed, 403, 'not_permitted');
      expect(JSON.stringify(body)).not.toContain(takenName);

      expect(
        await one('SELECT count(*)::int AS v FROM programme WHERE tenant_id = $1', [TENANT_A]),
      ).toBe(programmesBefore);
      expect(await programmeRow(PROGRAMME_A1)).toEqual(a1Before);

      // A tenant admin is trusted tenant-wide, so the 409 stays.
      expectError(
        await request(server())
          .post(PROGRAMMES)
          .set(SUPERVISOR)
          .send({ name: takenName, businessUnitId: BU_A }),
        409,
        'duplicate_name',
      );
      expectError(
        await request(server())
          .patch(`${PROGRAMMES}/${PROGRAMME_A1}`)
          .set(SUPERVISOR)
          .send({ version: await versionOf(SUPERVISOR, PROGRAMME_A1), name: takenName }),
        409,
        'duplicate_name',
      );
    });
  });

  // --- per programme, and the tenant-admin flag ---------------------------------

  describe('the decision is per programme, tenant admin is a flag, and both are re-resolved on every request', () => {
    it('admin in A1 permits every programme-scoped write in A1, none in A2, and no tenant-level write', async () => {
      // USER_A_AGENT_1: `admin` in A1, `agent` in A2, not a tenant admin — a
      // member of both, so A2 is readable and the honest answer there is 403.
      await assign(USER_A_AGENT_1, PROGRAMME_A1, ADMIN_SET);
      await assign(USER_A_AGENT_1, PROGRAMME_A2, AGENT_SET);

      // M4: a programme admin — of one programme out of two here — is not a
      // tenant admin. This is D-L40's point: no 409 oracle on A2's name.
      for (const operation of TENANT_LEVEL) {
        const context = await operation.prepare(PROGRAMME_A1);
        const before = await operation.snapshot(PROGRAMME_A1, context);
        expectError(await operation.send(AGENT_1, PROGRAMME_A1, context), 403, 'not_permitted');
        expect(await operation.snapshot(PROGRAMME_A1, context)).toEqual(before);
      }

      for (const operation of archiveLast(PROGRAMME_LEVEL)) {
        const inA2 = await operation.prepare(PROGRAMME_A2);
        const before = await operation.snapshot(PROGRAMME_A2, inA2);
        expectError(await operation.send(AGENT_1, PROGRAMME_A2, inA2), 403, 'not_permitted');
        expect(await operation.snapshot(PROGRAMME_A2, inA2)).toEqual(before);
      }

      for (const operation of archiveLast(PROGRAMME_LEVEL)) {
        const inA1 = await operation.prepare(PROGRAMME_A1);
        const allowed = await operation.send(AGENT_1, PROGRAMME_A1, inA1);
        expect(allowed.status, `${operation.name} in A1: ${JSON.stringify(allowed.body)}`).toBe(
          operation.success,
        );
      }
    });

    it('every set other than admin is read-only for admin writes', async () => {
      // D-L53 ruling 6, for this round.
      for (const setId of READ_ONLY_SETS) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, setId);
        for (const operation of PROGRAMME_LEVEL) {
          const context = await operation.prepare(PROGRAMME_A1);
          const before = await operation.snapshot(PROGRAMME_A1, context);
          const response = await operation.send(AGENT_1, PROGRAMME_A1, context);
          expect(response.status, `${operation.name} with set ${setId}`).toBe(403);
          expect(await operation.snapshot(PROGRAMME_A1, context)).toEqual(before);
        }
      }
    });

    it('the tenant-admin flag permits every write in reachable programmes, never widens scope, and applies on the next request', async () => {
      // USER_A_AGENT_1 keeps only the `agent` set in A1 and is not in A2.
      await setTenantAdmin(USER_A_AGENT_1, true);

      // D-L06: tenant admin is a permission, not a scope. A2 is still 404.
      const nothing = await request(server()).get(`${PROGRAMMES}/${NOWHERE}`).set(AGENT_1);
      for (const operation of OPERATIONS.filter((candidate) => candidate.programmeScoped)) {
        const inA2 = await operation.prepare(PROGRAMME_A2);
        const before = await operation.snapshot(PROGRAMME_A2, inA2);
        const response = await operation.send(AGENT_1, PROGRAMME_A2, inA2);
        expect(response.status, `${operation.name} in unreachable A2 as a tenant admin`).toBe(404);
        expect(response.body).toEqual(nothing.body);
        expect(await operation.snapshot(PROGRAMME_A2, inA2)).toEqual(before);
      }

      for (const operation of archiveLast(OPERATIONS)) {
        const inA1 = await operation.prepare(PROGRAMME_A1);
        const allowed = await operation.send(AGENT_1, PROGRAMME_A1, inA1);
        expect(
          allowed.status,
          `${operation.name} as a tenant admin with the agent set: ${JSON.stringify(allowed.body)}`,
        ).toBe(operation.success);
      }

      // M3: revoked on the very next request.
      await setTenantAdmin(USER_A_AGENT_1, false);
      const createRole = byName('createRole');
      expectError(
        await createRole.send(AGENT_1, PROGRAMME_A1, await createRole.prepare(PROGRAMME_A1)),
        403,
        'not_permitted',
      );
    });

    it('a change to a membership’s permission set applies on the very next request, in both directions', async () => {
      const create = byName('createDisposition');

      expectError(
        await create.send(AGENT_1, PROGRAMME_A1, await create.prepare(PROGRAMME_A1)),
        403,
        'not_permitted',
      );

      await assign(USER_A_AGENT_1, PROGRAMME_A1, ADMIN_SET);
      const granted = await create.send(AGENT_1, PROGRAMME_A1, await create.prepare(PROGRAMME_A1));
      expect(granted.status, `after the grant: ${JSON.stringify(granted.body)}`).toBe(201);

      await assign(USER_A_AGENT_1, PROGRAMME_A1, AGENT_SET);
      expectError(
        await create.send(AGENT_1, PROGRAMME_A1, await create.prepare(PROGRAMME_A1)),
        403,
        'not_permitted',
      );
    });
  });

  // --- D-L51, in the database ------------------------------------------------

  describe('D-L51: the database guards programme membership', () => {
    const RLS_REFUSED = { code: '42501' };

    it('kasuwa_app cannot enrol anyone in, or move a membership into, a programme outside its scope — or escalate a membership it cannot see', async () => {
      // A session scoped to A1 only, as USER_A_SUPERVISOR would be if he were
      // a member of A1 alone. Everything below names A2, an EXISTING
      // programme of the same tenant: the boundary between two BPO clients.
      const scope = { tenantId: TENANT_A, userId: USER_A_SUPERVISOR, programmeIds: [PROGRAMME_A1] };

      // Enrol someone (here: himself, as admin) in a sibling programme.
      await expect(
        withForcedScope(appPool, scope, (query) =>
          query(
            `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
             VALUES ($1, $2, $3, $4)`,
            [USER_A_AGENT_1, PROGRAMME_A2, TENANT_A, ADMIN_SET],
          ),
        ),
      ).rejects.toMatchObject(RLS_REFUSED);

      // Move an in-scope membership across the boundary.
      await expect(
        withForcedScope(appPool, scope, (query) =>
          query(
            `UPDATE user_programme SET programme_id = $1
              WHERE user_id = $2 AND programme_id = $3`,
            [PROGRAMME_A2, USER_A_AGENT_1, PROGRAMME_A1],
          ),
        ),
      ).rejects.toMatchObject(RLS_REFUSED);

      // Escalate a membership in A2 to admin. Either the row is invisible
      // (nothing updated) or the write is refused; it must never land.
      let escalated = 0;
      try {
        escalated = await withForcedScope(appPool, scope, async (query) => {
          const rows = await query<{ n: number }>(
            `WITH changed AS (
               UPDATE user_programme SET permission_set_id = $1
                WHERE user_id = $2 AND programme_id = $3
               RETURNING 1)
             SELECT count(*)::int AS n FROM changed`,
            [ADMIN_SET, USER_A_AGENT_2, PROGRAMME_A2],
          );
          return rows[0]?.n ?? 0;
        });
      } catch (error) {
        expect(error).toMatchObject(RLS_REFUSED);
      }
      expect(escalated, 'a session scoped to A1 rewrote a membership in A2').toBe(0);
    });

    it('an UPDATE of an in-scope programme does not let the same transaction enrol anyone in a sibling (the creation marker cannot be forged)', async () => {
      // D-L55: UPDATE-ing A1 stamps A1's xmin with this transaction's xid. That
      // must not make a membership in A2 look "created in this transaction".
      const scope = { tenantId: TENANT_A, userId: USER_A_SUPERVISOR, programmeIds: [PROGRAMME_A1] };
      await expect(
        withForcedScope(appPool, scope, async (query) => {
          await query(`UPDATE programme SET updated_at = now() WHERE id = $1`, [PROGRAMME_A1]);
          await query(
            `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
             VALUES ($1, $2, $3, $4)`,
            [USER_A_AGENT_1, PROGRAMME_A2, TENANT_A, ADMIN_SET],
          );
        }),
      ).rejects.toMatchObject(RLS_REFUSED);
    });

    it('kasuwa_app cannot make any user a tenant admin (column privilege on "user")', async () => {
      // D-L55: the only proof the REVOKE in 0015 is live. The flag is writable
      // by the migrator (provisioning, seed) and never by the application role.
      const scope = { tenantId: TENANT_A, userId: USER_A_SUPERVISOR, programmeIds: [PROGRAMME_A1] };
      await expect(
        withForcedScope(appPool, scope, (query) =>
          query(`UPDATE "user" SET is_tenant_admin = true WHERE id = $1`, [USER_A_AGENT_1]),
        ),
      ).rejects.toMatchObject(RLS_REFUSED);
    });

    it('membership in a programme already in scope, and the creator’s enrolment through createProgramme, still work', async () => {
      // In scope: RLS admits it. Whether the CALLER may assign people is the
      // engine's decision in the application; the database's job is the
      // boundary.
      const inserted = await withForcedScope(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR, programmeIds: [PROGRAMME_A1] },
        async (query) => {
          await query(
            `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
             VALUES ($1, $2, $3, $4)`,
            [USER_A_AGENT_2, PROGRAMME_A1, TENANT_A, AGENT_SET],
          );
          return true;
        },
      );
      expect(inserted).toBe(true);

      // Created in the same transaction: the one case that is NOT yet in
      // scope. Through the real API, as a tenant admin.
      const created = await request(server())
        .post(PROGRAMMES)
        .set(SUPERVISOR)
        .send({ name: uniqueName('Telco Y Retention'), businessUnitId: BU_A });
      expect(created.status, `createProgramme: ${JSON.stringify(created.body)}`).toBe(201);
      const id = created.body.id as string;

      const members = await observer.query<{ user_id: string }>(
        'SELECT user_id FROM user_programme WHERE programme_id = $1',
        [id],
      );
      expect(members.rows, 'the creator, and only the creator, is enrolled').toEqual([
        { user_id: USER_A_SUPERVISOR },
      ]);

      // ...with a set that lets them administer what they just made.
      const disposition = await request(server())
        .post(`${PROGRAMMES}/${id}/dispositions`)
        .set(SUPERVISOR)
        .send({ code: uniqueCode(), label: 'First code', category: 'resolved' });
      expect(disposition.status, JSON.stringify(disposition.body)).toBe(201);

      // M1: the set is a same-tenant reference, enforced by the schema.
      const fk = await observer.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS definition
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND t.relname = 'user_programme' AND c.contype = 'f'`,
      );
      expect(
        fk.rows.map((row) => row.definition.replace(/\s+/g, ' ')),
        'no (tenant_id, permission_set_id) -> permission_set(tenant_id, id) foreign key',
      ).toContainEqual(
        expect.stringMatching(
          /FOREIGN KEY \(tenant_id, permission_set_id\) REFERENCES permission_set\(tenant_id, id\)/,
        ),
      );
    });
  });

  // --- catalogue invariants -----------------------------------------------------

  describe('catalogue invariants', () => {
    it('lists every PERMISSIVE FOR INSERT policy and allows only the ones that have been argued for', async () => {
      // Permissive policies are OR-ed: each one is a way in that the others
      // cannot close. 0012 introduced the first (D-L46); D-L51 found what a
      // weak one costs. A new entry here is a decision for the lead, made in
      // this file — not something a migration does quietly. Restrictive
      // policies (AND-ed, they can only narrow) are not listed.
      const ALLOWED = ['programme.programme_insert_in_tenant'];

      const policies = await observer.query<{ name: string }>(
        `SELECT c.relname || '.' || p.polname AS name
           FROM pg_policy p
           JOIN pg_class c ON c.oid = p.polrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND p.polcmd = 'a'
            AND p.polpermissive
          ORDER BY 1`,
      );

      expect(
        policies.rows.map((row) => row.name),
        'a permissive FOR INSERT policy is not on the allow-list — use AS RESTRICTIVE, or raise it',
      ).toEqual(ALLOWED);
    });

    it('has exactly the two SECURITY DEFINER functions CLAUDE.md 2.7 documents, and no third', async () => {
      const definers = await observer.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY 1`,
      );

      expect(
        definers.rows.map((row) => row.name),
        'a SECURITY DEFINER function exists that has no ADR (CLAUDE.md 2.7)',
      ).toEqual(['app.resolve_session', 'app.resolve_tenant_by_slug']);
    });
  });
});
