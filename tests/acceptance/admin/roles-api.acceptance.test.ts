import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0022, admin API: roles and permission sets (Agent 1, M2).
 *
 * PENDING. Real tests, failing today because there is no admin controller and
 * no `role` or `permission_set` table. `pnpm test:pending` runs them.
 * Renaming this file to drop `.pending` is what assigns the task —
 * `pnpm verify:tasks` enforces it (D-L23, and the "Pending acceptance tests"
 * entry in team/DECISION-LOG.md).
 *
 * The contract is `docs/api/admin.openapi.yaml`, operations `listRoles`,
 * `createRole`, `getRole`, `updateRole`, `deleteRole`, `updateRoleHierarchy`
 * and `listPermissionSets`. The shape checks below are hand-transcribed from
 * the spec's `Role`, `RoleList`, `RoleDetail`, `PermissionSetList` and `Error`
 * schemas — the acceptance package has no OpenAPI validator, and adding one is
 * a dependency decision, not a test detail. If the spec and these checks ever
 * disagree, the spec is right and this file is the defect: say so in the
 * report, do not edit it.
 *
 * WHAT THIS SUITE IS REALLY ABOUT
 *
 * Roles are tenant-wide (the spec deliberately gives them no `programmeId`),
 * and the role hierarchy is what record visibility will follow. So the two
 * properties that matter most are:
 *
 *   1. a role id from another tenant is indistinguishable from no role at all —
 *      `404 not_found`, the same body, never `403`; and
 *   2. a hierarchy write that would make a role its own ancestor is refused
 *      whole — `409 role_hierarchy_cycle`, and NOTHING is applied, including
 *      the valid moves in the same request.
 *
 * Callers. There is no permissions engine yet and the seed has no "tenant
 * admin", so tenant A is driven as USER_A_SUPERVISOR and tenant B as
 * USER_B_AGENT_1 — the only user tenant B has. The spec's `403 not_permitted`
 * is deliberately not exercised: who may administer roles is the permissions
 * engine's question, not this task's. If T-0022 introduces an admin check,
 * these callers must pass it; raise it rather than widening anything.
 *
 * Writes. This suite creates roles through the API and reseeds afterwards
 * (`TRUNCATE tenant CASCADE` in the seed clears anything keyed to a tenant).
 */

const ROLES = '/api/v1/admin/roles';
const HIERARCHY = '/api/v1/admin/roles/hierarchy';
const PERMISSION_SETS = '/api/v1/admin/field-security/permission-sets';

/** Never a real row: same shape as the seed ids, nothing seeds it. */
const NO_SUCH_ROLE = '99999999-0000-4000-8000-0000000f9999';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unique per run so a name never collides with an earlier, unreseeded run. */
const RUN = Date.now().toString(36);
let sequence = 0;
const uniqueName = (label: string) => `${label} ${RUN}-${(sequence += 1)}`;

const A = asUser(TENANT_A, USER_A_SUPERVISOR);
const B = asUser(TENANT_B, USER_B_AGENT_1);

// --- shape checks transcribed from docs/api/admin.openapi.yaml -------------

type Json = Record<string, unknown>;

interface Role {
  id: string;
  name: string;
  parentRoleId: string | null;
  userCount: number;
  descendantUserCount?: number;
}

interface RoleList {
  version: number;
  items: Role[];
}

/** `#/components/schemas/Role`. */
function expectRole(value: unknown, where = 'Role'): Role {
  expect(value, `${where}: not an object`).toEqual(expect.any(Object));
  const role = value as Json;

  expect(role.id, `${where}.id`).toMatch(UUID);
  expect(role.name, `${where}.name`).toEqual(expect.any(String));
  expect((role.name as string).length, `${where}.name maxLength`).toBeLessThanOrEqual(120);
  if (role.parentRoleId !== null) {
    expect(role.parentRoleId, `${where}.parentRoleId must be a uuid or null`).toMatch(UUID);
  }
  expect(Number.isInteger(role.userCount), `${where}.userCount must be an integer`).toBe(true);
  if (role.descendantUserCount !== undefined) {
    expect(
      Number.isInteger(role.descendantUserCount),
      `${where}.descendantUserCount must be an integer`,
    ).toBe(true);
  }

  // "Roles are tenant-wide and carry no programme." — listRoles description.
  // A scope field on a role is the spec being quietly widened.
  expect(role, `${where} must not carry programmeId`).not.toHaveProperty('programmeId');
  expect(role, `${where} must not carry tenantId`).not.toHaveProperty('tenantId');
  // Flat, not nested — RoleList description.
  expect(role, `${where} must not nest children`).not.toHaveProperty('children');

  return role as unknown as Role;
}

/** `#/components/schemas/RoleList`. */
function expectRoleList(value: unknown): RoleList {
  const list = value as Json;
  expect(Number.isInteger(list.version), 'RoleList.version must be an integer').toBe(true);
  expect(Array.isArray(list.items), 'RoleList.items must be an array').toBe(true);
  (list.items as unknown[]).forEach((item, index) => expectRole(item, `RoleList.items[${index}]`));
  return list as unknown as RoleList;
}

interface RoleDetail extends Role {
  seesRecordsOwnedBy: {
    roleCount: number;
    userCount: number;
    sample: { id: string; name: string }[];
  };
}

/** `#/components/schemas/RoleDetail` — Role plus `seesRecordsOwnedBy`. */
function expectRoleDetail(value: unknown): RoleDetail {
  expectRole(value, 'RoleDetail');
  const sees = (value as Json).seesRecordsOwnedBy as Json | undefined;
  expect(sees, 'RoleDetail.seesRecordsOwnedBy is what the side panel draws').toBeDefined();
  expect(Number.isInteger(sees?.roleCount), 'seesRecordsOwnedBy.roleCount').toBe(true);
  expect(Number.isInteger(sees?.userCount), 'seesRecordsOwnedBy.userCount').toBe(true);
  expect(Array.isArray(sees?.sample), 'seesRecordsOwnedBy.sample').toBe(true);
  for (const entry of (sees?.sample ?? []) as Json[]) {
    expect(entry.id, 'sample[].id').toMatch(UUID);
    expect(entry.name, 'sample[].name').toEqual(expect.any(String));
  }
  return value as RoleDetail;
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

describe('acceptance (pending): admin roles API', () => {
  let app: INestApplication;
  let appPool: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  const createRole = async (
    headers: Record<string, string>,
    name: string,
    parentRoleId: string | null = null,
  ): Promise<Role> => {
    const response = await request(server()).post(ROLES).set(headers).send({ name, parentRoleId });
    expect(response.status, `createRole: ${JSON.stringify(response.body)}`).toBe(201);
    return expectRole(response.body, 'createRole response');
  };

  const listRoles = async (headers: Record<string, string>): Promise<RoleList> => {
    const response = await request(server()).get(ROLES).set(headers);
    expect(response.status, `listRoles: ${JSON.stringify(response.body)}`).toBe(200);
    return expectRoleList(response.body);
  };

  const parentOf = (list: RoleList, roleId: string) =>
    list.items.find((role) => role.id === roleId)?.parentRoleId;

  // --- create and list -----------------------------------------------------

  it('createRole returns 201 with a Role, and listRoles returns it flat with parentRoleId', async () => {
    const root = await createRole(A, uniqueName('Managing Director'));
    expect(root.parentRoleId, 'a role created without a parent is a root').toBeNull();
    expect(root.userCount, 'nobody holds a role that was just created').toBe(0);

    const child = await createRole(A, uniqueName('Head of Operations'), root.id);
    expect(child.parentRoleId).toBe(root.id);

    const list = await listRoles(A);
    expect(parentOf(list, root.id)).toBeNull();
    expect(parentOf(list, child.id)).toBe(root.id);
  });

  it('createRole rejects a body that does not parse, including one that supplies scope', async () => {
    // CreateRoleRequest: name required, minLength 1, additionalProperties false.
    // A `programmeId` in the body is both a schema violation and an attempt
    // to supply scope (CLAUDE.md 2.2): it must be refused, not ignored.
    const send = (body: unknown) =>
      request(server())
        .post(ROLES)
        .set(A)
        .send(body as object);

    expectError(await send({}), 400, 'validation_failed');
    expectError(await send({ name: '' }), 400, 'validation_failed');
    expectError(await send({ name: 'x'.repeat(121) }), 400, 'validation_failed');
    expectError(
      await send({ name: uniqueName('Scoped'), programmeId: TENANT_A }),
      400,
      'validation_failed',
    );
  });

  it('role names are unique per tenant, and only per tenant', async () => {
    const name = uniqueName('Workforce Planner');
    await createRole(A, name);

    const duplicate = await request(server()).post(ROLES).set(A).send({ name });
    const body = expectError(duplicate, 409, 'duplicate_name');
    // Conflict description: "deliberately does not name the conflicting row".
    expect(JSON.stringify(body)).not.toMatch(UUID);

    // The same name in another tenant is not a conflict. A uniqueness index on
    // `name` alone would make this 409 — and that 409 would tell tenant B that
    // tenant A has a role called this.
    await createRole(B, name);
  });

  // --- tenant isolation ----------------------------------------------------

  it('a role in tenant A is 404 to tenant B on every operation, with the no-such-role body', async () => {
    const role = await createRole(A, uniqueName('Quality Lead'));
    const sibling = await createRole(A, uniqueName('Quality Analyst'), role.id);

    // Absent from B's list.
    const bList = await listRoles(B);
    const bIds = new Set(bList.items.map((item) => item.id));
    expect(bIds.has(role.id)).toBe(false);
    expect(bIds.has(sibling.id)).toBe(false);

    // getRole: 404, identical to a role that does not exist at all. A 403, or
    // any difference between the two bodies, is an enumeration oracle.
    const crossTenant = await request(server()).get(`${ROLES}/${role.id}`).set(B);
    const missing = await request(server()).get(`${ROLES}/${NO_SUCH_ROLE}`).set(B);
    expectError(crossTenant, 404, 'not_found');
    expectError(missing, 404, 'not_found');
    expect(crossTenant.body).toEqual(missing.body);

    // updateRole, deleteRole: 404 too — and nothing changes in tenant A.
    expectError(
      await request(server()).patch(`${ROLES}/${role.id}`).set(B).send({ name: 'Hijacked' }),
      404,
      'not_found',
    );
    const bRoot = await createRole(B, uniqueName('Tenant B root'));
    expectError(
      await request(server())
        .delete(`${ROLES}/${role.id}`)
        .query({ reassignUsersToRoleId: bRoot.id })
        .set(B),
      404,
      'not_found',
    );

    const stillThere = await request(server()).get(`${ROLES}/${role.id}`).set(A).expect(200);
    expect(expectRoleDetail(stillThere.body).name).toBe(role.name);
  });

  it('refuses to attach a role to a parent in another tenant, by create, update or hierarchy write', async () => {
    const foreignParent = await createRole(A, uniqueName('Tenant A parent'));
    const own = await createRole(B, uniqueName('Tenant B role'));

    expectError(
      await request(server())
        .post(ROLES)
        .set(B)
        .send({ name: uniqueName('Grafted'), parentRoleId: foreignParent.id }),
      404,
      'not_found',
    );
    expectError(
      await request(server())
        .patch(`${ROLES}/${own.id}`)
        .set(B)
        .send({ parentRoleId: foreignParent.id }),
      404,
      'not_found',
    );

    const { version } = await listRoles(B);
    expectError(
      await request(server())
        .put(HIERARCHY)
        .set(B)
        .send({ version, moves: [{ roleId: own.id, parentRoleId: foreignParent.id }] }),
      404,
      'not_found',
    );

    const after = await listRoles(B);
    expect(parentOf(after, own.id)).toBeNull();
  });

  // --- getRole / updateRole ------------------------------------------------

  it('getRole returns a RoleDetail whose seesRecordsOwnedBy lists the roles beneath it', async () => {
    const top = await createRole(A, uniqueName('Programme Manager'));
    const middle = await createRole(A, uniqueName('Team Lead'), top.id);
    const leaf = await createRole(A, uniqueName('Agent'), middle.id);

    const topDetail = expectRoleDetail(
      (await request(server()).get(`${ROLES}/${top.id}`).set(A).expect(200)).body,
    );
    expect(topDetail.id).toBe(top.id);
    // Every descendant, not only direct children.
    expect(topDetail.seesRecordsOwnedBy.roleCount).toBe(2);
    expect(topDetail.seesRecordsOwnedBy.sample.map((entry) => entry.id).sort()).toEqual(
      [middle.id, leaf.id].sort(),
    );

    // "A role with no descendants returns an empty list."
    const leafDetail = expectRoleDetail(
      (await request(server()).get(`${ROLES}/${leaf.id}`).set(A).expect(200)).body,
    );
    expect(leafDetail.seesRecordsOwnedBy.roleCount).toBe(0);
    expect(leafDetail.seesRecordsOwnedBy.sample).toEqual([]);
  });

  it('updateRole renames and re-parents, and refuses to make a role report to its own descendant', async () => {
    const top = await createRole(A, uniqueName('Head of CX'));
    const child = await createRole(A, uniqueName('CX Manager'), top.id);
    const other = await createRole(A, uniqueName('Head of Risk'));

    const newName = uniqueName('Head of Customer Experience');
    const renamed = await request(server())
      .patch(`${ROLES}/${top.id}`)
      .set(A)
      .send({ name: newName })
      .expect(200);
    expect(expectRoleDetail(renamed.body).name).toBe(newName);

    const moved = await request(server())
      .patch(`${ROLES}/${child.id}`)
      .set(A)
      .send({ parentRoleId: other.id })
      .expect(200);
    expect(expectRoleDetail(moved.body).parentRoleId).toBe(other.id);

    // other -> child is a cycle now that child reports to other.
    expectError(
      await request(server()).patch(`${ROLES}/${other.id}`).set(A).send({ parentRoleId: child.id }),
      409,
      'role_hierarchy_cycle',
    );
    // A role cannot be its own parent either.
    expectError(
      await request(server()).patch(`${ROLES}/${other.id}`).set(A).send({ parentRoleId: other.id }),
      409,
      'role_hierarchy_cycle',
    );

    const after = await listRoles(A);
    expect(parentOf(after, other.id)).toBeNull();
  });

  // --- updateRoleHierarchy -------------------------------------------------

  it('updateRoleHierarchy applies every move in one write and returns the new RoleList', async () => {
    const root = await createRole(A, uniqueName('Operations Director'));
    const first = await createRole(A, uniqueName('Collections Lead'));
    const second = await createRole(A, uniqueName('Care Lead'));

    const before = await listRoles(A);
    const response = await request(server())
      .put(HIERARCHY)
      .set(A)
      .send({
        version: before.version,
        moves: [
          { roleId: first.id, parentRoleId: root.id },
          { roleId: second.id, parentRoleId: root.id },
        ],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const after = expectRoleList(response.body);
    expect(parentOf(after, first.id)).toBe(root.id);
    expect(parentOf(after, second.id)).toBe(root.id);
    expect(after.version, 'the hierarchy version must move on a write').not.toBe(before.version);

    // Sending the old version again is a stale write, not a silent overwrite.
    expectError(
      await request(server())
        .put(HIERARCHY)
        .set(A)
        .send({ version: before.version, moves: [{ roleId: first.id, parentRoleId: null }] }),
      409,
      'stale_write',
    );
  });

  it('a hierarchy write containing a cycle is 409 role_hierarchy_cycle and applies nothing', async () => {
    const top = await createRole(A, uniqueName('Country Manager'));
    const middle = await createRole(A, uniqueName('Site Manager'), top.id);
    const loose = await createRole(A, uniqueName('Trainer'));

    const before = await listRoles(A);
    const response = await request(server())
      .put(HIERARCHY)
      .set(A)
      .send({
        version: before.version,
        moves: [
          // Valid on its own.
          { roleId: loose.id, parentRoleId: middle.id },
          // top -> middle while middle -> top: a cycle.
          { roleId: top.id, parentRoleId: middle.id },
        ],
      });

    const body = expectError(response, 409, 'role_hierarchy_cycle');

    // conflictingIds names the roles involved, and only ids the caller sent.
    const submitted = new Set([loose.id, middle.id, top.id]);
    expect(Array.isArray(body.conflictingIds), 'conflictingIds is required on a cycle').toBe(true);
    const conflicting = body.conflictingIds as string[];
    expect(conflicting.length).toBeGreaterThan(0);
    for (const id of conflicting) {
      expect(id).toMatch(UUID);
      expect(submitted.has(id), `conflictingIds discloses ${id}, which was not submitted`).toBe(
        true,
      );
    }
    expect(conflicting).toContain(top.id);

    // Nothing applied — not even the valid move — and the version did not move.
    const after = await listRoles(A);
    expect(parentOf(after, loose.id), 'the valid move in a failed write was applied').toBeNull();
    expect(parentOf(after, top.id)).toBeNull();
    expect(parentOf(after, middle.id)).toBe(top.id);
    expect(after.version).toBe(before.version);
  });

  it('updateRoleHierarchy rejects an empty or malformed move list', async () => {
    const { version } = await listRoles(A);
    const put = (body: unknown) =>
      request(server())
        .put(HIERARCHY)
        .set(A)
        .send(body as object);

    expectError(await put({ version, moves: [] }), 400, 'validation_failed');
    expectError(
      await put({ moves: [{ roleId: NO_SUCH_ROLE, parentRoleId: null }] }),
      400,
      'validation_failed',
    );
    expectError(
      await put({ version, moves: [{ roleId: 'not-a-uuid', parentRoleId: null }] }),
      400,
      'validation_failed',
    );
  });

  // --- deleteRole ----------------------------------------------------------

  it('deleteRole requires a reassignment target outside its own subtree, re-parents children, and is 204', async () => {
    const grand = await createRole(A, uniqueName('Regional Head'));
    const doomed = await createRole(A, uniqueName('Area Manager'), grand.id);
    const child = await createRole(A, uniqueName('Shift Supervisor'), doomed.id);
    const elsewhere = await createRole(A, uniqueName('Back Office'));

    const del = (query: Record<string, string>) =>
      request(server()).delete(`${ROLES}/${doomed.id}`).query(query).set(A);

    // Required even when nobody holds the role.
    expectError(await del({}), 400, 'validation_failed');
    // Into its own subtree, or into itself: a cycle.
    expectError(await del({ reassignUsersToRoleId: child.id }), 409, 'role_hierarchy_cycle');
    expectError(await del({ reassignUsersToRoleId: doomed.id }), 409, 'role_hierarchy_cycle');
    // Into a role that does not exist.
    expectError(await del({ reassignUsersToRoleId: NO_SUCH_ROLE }), 404, 'not_found');

    const deleted = await del({ reassignUsersToRoleId: elsewhere.id });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);

    // "Child roles are re-parented to the deleted role's parent."
    const after = await listRoles(A);
    expect(after.items.some((role) => role.id === doomed.id)).toBe(false);
    expect(parentOf(after, child.id)).toBe(grand.id);

    expectError(await request(server()).get(`${ROLES}/${doomed.id}`).set(A), 404, 'not_found');
  });

  // --- permission sets -----------------------------------------------------

  it('listPermissionSets returns a PermissionSetList with the locked Admin column', async () => {
    for (const headers of [A, B]) {
      const response = await request(server()).get(PERMISSION_SETS).set(headers);
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const items = (response.body as Json).items as Json[];
      expect(Array.isArray(items), 'PermissionSetList.items').toBe(true);
      expect(items.length, 'the matrix needs at least one column').toBeGreaterThan(0);

      for (const item of items) {
        expect(item.permissionSetId).toEqual(expect.any(String));
        expect((item.permissionSetId as string).length).toBeLessThanOrEqual(64);
        expect(item.label).toEqual(expect.any(String));
        expect(typeof item.locked, 'locked is a boolean').toBe('boolean');
        if (item.userCount !== undefined && item.userCount !== null) {
          expect(Number.isInteger(item.userCount)).toBe(true);
        }
        expect(item, 'permission sets are tenant-level (D-P9)').not.toHaveProperty('programmeId');
      }

      const ids = items.map((item) => item.permissionSetId);
      expect(new Set(ids).size, 'permissionSetId must be unique within a tenant').toBe(ids.length);
      // "Admins always have full access" — the padlocked column.
      expect(
        items.some((item) => item.locked === true),
        'no locked (Admin) set',
      ).toBe(true);
    }
  });

  // --- authentication and scope headers ------------------------------------

  const EVERY_OPERATION = [
    ['listRoles', () => request(app.getHttpServer()).get(ROLES)],
    ['createRole', () => request(app.getHttpServer()).post(ROLES).send({ name: 'Anonymous' })],
    ['getRole', () => request(app.getHttpServer()).get(`${ROLES}/${NO_SUCH_ROLE}`)],
    [
      'updateRole',
      () =>
        request(app.getHttpServer()).patch(`${ROLES}/${NO_SUCH_ROLE}`).send({ name: 'Anonymous' }),
    ],
    [
      'deleteRole',
      () =>
        request(app.getHttpServer())
          .delete(`${ROLES}/${NO_SUCH_ROLE}`)
          .query({ reassignUsersToRoleId: NO_SUCH_ROLE }),
    ],
    [
      'updateRoleHierarchy',
      () =>
        request(app.getHttpServer())
          .put(HIERARCHY)
          .send({ version: 1, moves: [{ roleId: NO_SUCH_ROLE, parentRoleId: null }] }),
    ],
    ['listPermissionSets', () => request(app.getHttpServer()).get(PERMISSION_SETS)],
  ] as const;

  it('every operation is 401 not_authenticated without a session', async () => {
    for (const [operation, build] of EVERY_OPERATION) {
      const response = await build();
      expect(response.status, `${operation} without a session`).toBe(401);
      expectError(response, 401, 'not_authenticated');
    }
  });

  it('every operation rejects a request that tries to supply its own scope', async () => {
    // Scope is resolved, never supplied (spec header, point 1). The guard
    // rejects these outright on the contacts routes; the admin routes are no
    // exception.
    const scopeHeaders: [string, string][] = [
      ['x-kasuwa-programme-ids', `{${TENANT_B}}`],
      ['x-kasuwa-programme-id', TENANT_B],
      ['x-kasuwa-scope', 'all'],
    ];
    for (const [operation, build] of EVERY_OPERATION) {
      for (const [header, value] of scopeHeaders) {
        const response = await build().set(A).set(header, value);
        expect(response.status, `${operation} with ${header}`).toBe(400);
      }
    }
  });

  // --- schema and contract -------------------------------------------------

  it('role and permission_set are tenant-scoped, RLS enabled and FORCED, with WITH CHECK = USING', async () => {
    const scoped: readonly string[] = TENANT_SCOPED_TABLES;
    expect(scoped, 'role is missing from TENANT_SCOPED_TABLES').toContain('role');
    expect(scoped, 'permission_set is missing from TENANT_SCOPED_TABLES').toContain(
      'permission_set',
    );

    const state = await readTableSecurity(appPool);
    for (const table of ['role', 'permission_set']) {
      const row = state.find((entry) => entry.table === table);
      expect(row, `table ${table} does not exist`).toBeDefined();
      expect(row?.rlsEnabled, `${table}: RLS is not enabled`).toBe(true);
      expect(row?.rlsForced, `${table}: RLS is not FORCED`).toBe(true);
      expect(row?.policyCount, `${table}: has no policy`).toBeGreaterThan(0);
    }

    const columns = await appPool.query<{ table: string; nullable: string }>(
      `SELECT table_name AS table, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('role', 'permission_set')
          AND column_name = 'tenant_id'`,
    );
    expect(columns.rows.map((row) => row.table).sort()).toEqual(['permission_set', 'role']);
    for (const row of columns.rows) {
      expect(row.nullable, `${row.table}.tenant_id must be NOT NULL`).toBe('NO');
    }

    // CLAUDE.md 2.4: at least one policy whose WITH CHECK is identical to its
    // USING, so a row cannot be written that the writer could not then read.
    const policies = await appPool.query<{ table: string; matching: number }>(
      `SELECT c.relname AS table,
              count(*) FILTER (
                WHERE p.polwithcheck IS NOT NULL
                  AND pg_get_expr(p.polwithcheck, p.polrelid) = pg_get_expr(p.polqual, p.polrelid)
              )::int AS matching
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname IN ('role', 'permission_set')
        GROUP BY c.relname`,
    );
    const matching = new Map(policies.rows.map((row) => [row.table, row.matching]));
    expect(matching.get('role') ?? 0, 'role: no policy with WITH CHECK = USING').toBeGreaterThan(0);
    expect(
      matching.get('permission_set') ?? 0,
      'permission_set: no policy with WITH CHECK = USING',
    ).toBeGreaterThan(0);
  });

  it('the spec marks every T-0022 operation x-kasuwa-implemented: true', () => {
    // The screens keep their mock until this flips; a built operation still
    // marked `false` leaves Agent 11 building against a mock for nothing.
    const spec = readFileSync(resolve(__dirname, '../../../docs/api/admin.openapi.yaml'), 'utf8');
    for (const operationId of [
      'listRoles',
      'createRole',
      'getRole',
      'updateRole',
      'deleteRole',
      'updateRoleHierarchy',
      'listPermissionSets',
    ]) {
      const match = new RegExp(
        `operationId:\\s*${operationId}\\s*\\n\\s*x-kasuwa-implemented:\\s*(\\S+)`,
      ).exec(spec);
      expect(match, `${operationId} not found in admin.openapi.yaml`).not.toBeNull();
      expect(match?.[1], `${operationId} is not marked implemented`).toBe('true');
    }
  });
});
