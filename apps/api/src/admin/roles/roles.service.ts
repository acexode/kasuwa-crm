import { newId, type TenantTx } from '@kasuwa/db';
import { change, changedFields, recordAuditEvent } from '../audit/audit-writer';
import { duplicateName, notFound, staleWrite } from '../common/admin-errors';
import { hierarchyCycle } from './roles.errors';
import {
  cycleConflicts,
  descendantIndex,
  planRoleDeletion,
  type ParentMap,
  type RoleMove,
} from './role-hierarchy';
import type { CreateRoleBody, RoleHierarchyBody, UpdateRoleBody } from './roles.schemas';

/**
 * The role and permission-set queries (T-0022).
 *
 * tenancy-reviewed: every statement carries an explicit `tenant_id = $1` bound
 * to `tx.session.tenantId` IN ADDITION to the RLS policy on the table — two
 * independent layers, so a typo in one does not leak (CLAUDE.md 2.3). Nothing
 * here reads a tenant or programme id from the request.
 *
 * Every write takes the tenant's hierarchy lock first (`lockHierarchy`). The
 * cycle check reads the whole tree and then writes; without the lock, two
 * concurrent moves that are each acyclic on their own could both pass and
 * commit a loop together. The 0006 trigger would catch that too — as a 500 —
 * so the lock is what makes it a clean answer rather than a crash.
 *
 * Audit (T-0025): every successful write appends its event through
 * `recordAuditEvent` on the same `tx`, after the write, so the two commit
 * together. A refused write throws before that point and records nothing; a
 * write that changes nothing (a PATCH repeating the current values, a move to
 * the parent a role already has) records nothing either. Role events carry no
 * programme: roles are tenant-wide (D-L48).
 */

export interface RoleView {
  id: string;
  name: string;
  parentRoleId: string | null;
  userCount: number;
  descendantUserCount: number;
}

export interface RoleDetailView extends RoleView {
  seesRecordsOwnedBy: {
    roleCount: number;
    userCount: number;
    sample: { id: string; name: string }[];
  };
}

/** "The first few descendant role names for display." */
const SAMPLE_SIZE = 5;

interface RoleRow {
  id: string;
  name: string;
  parent_role_id: string | null;
  user_count: number;
}

const tenantOf = (tx: TenantTx) => tx.session.tenantId;

async function readVersion(tx: TenantTx, lock: boolean): Promise<number> {
  // FOR NO KEY UPDATE, not FOR UPDATE: it serialises hierarchy writers without
  // blocking the FOR KEY SHARE locks every foreign-key check on tenant takes.
  const rows = await tx.query<{ version: number }>(
    `SELECT role_hierarchy_version AS version FROM tenant WHERE id = $1
     ${lock ? 'FOR NO KEY UPDATE' : ''}`,
    [tenantOf(tx)],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Tenant row not visible inside its own transaction');
  return row.version;
}

const lockHierarchy = (tx: TenantTx) => readVersion(tx, true);

async function bumpVersion(tx: TenantTx): Promise<void> {
  await tx.query(
    `UPDATE tenant SET role_hierarchy_version = role_hierarchy_version + 1 WHERE id = $1`,
    [tenantOf(tx)],
  );
}

async function loadRoles(tx: TenantTx): Promise<RoleRow[]> {
  return tx.query<RoleRow>(
    `SELECT r.id, r.name, r.parent_role_id,
            (SELECT count(*)::int FROM "user" u
              WHERE u.tenant_id = $1 AND u.role_id = r.id) AS user_count
       FROM role r
      WHERE r.tenant_id = $1
      ORDER BY lower(r.name), r.id`,
    [tenantOf(tx)],
  );
}

const parentMap = (rows: readonly RoleRow[]): ParentMap =>
  new Map(rows.map((row) => [row.id, row.parent_role_id]));

function toViews(rows: readonly RoleRow[]): {
  views: RoleView[];
  descendants: Map<string, string[]>;
} {
  const descendants = descendantIndex(parentMap(rows));
  const users = new Map(rows.map((row) => [row.id, row.user_count]));
  const views = rows.map((row) => ({
    id: row.id,
    name: row.name,
    parentRoleId: row.parent_role_id,
    userCount: row.user_count,
    descendantUserCount: (descendants.get(row.id) ?? []).reduce(
      (sum, id) => sum + (users.get(id) ?? 0),
      0,
    ),
  }));
  return { views, descendants };
}

function toDetail(rows: readonly RoleRow[], roleId: string): RoleDetailView {
  const { views, descendants } = toViews(rows);
  const view = views.find((candidate) => candidate.id === roleId);
  if (view === undefined) throw notFound();
  const beneath = new Set(descendants.get(roleId) ?? []);
  // `views` is already in name order, so the sample is "the first few by name".
  const sample = views.filter((candidate) => beneath.has(candidate.id));
  return {
    ...view,
    seesRecordsOwnedBy: {
      roleCount: beneath.size,
      userCount: view.descendantUserCount,
      sample: sample.slice(0, SAMPLE_SIZE).map(({ id, name }) => ({ id, name })),
    },
  };
}

/** A unique violation is the name, whatever the database's message says. */
async function guardUnique<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === '23505') throw duplicateName();
      // A parent that vanished between the read and the write.
      if (error.code === '23503') throw notFound();
    }
    throw error;
  }
}

function nameTaken(rows: readonly RoleRow[], name: string, exceptId: string | null): boolean {
  const wanted = name.toLowerCase();
  return rows.some((row) => row.id !== exceptId && row.name.toLowerCase() === wanted);
}

export async function listRoles(tx: TenantTx): Promise<{ version: number; items: RoleView[] }> {
  const version = await readVersion(tx, false);
  return { version, items: toViews(await loadRoles(tx)).views };
}

export async function getRole(tx: TenantTx, roleId: string): Promise<RoleDetailView> {
  return toDetail(await loadRoles(tx), roleId);
}

export async function createRole(tx: TenantTx, body: CreateRoleBody): Promise<RoleView> {
  await lockHierarchy(tx);
  const rows = await loadRoles(tx);
  const parentRoleId = body.parentRoleId ?? null;
  if (parentRoleId !== null && !rows.some((row) => row.id === parentRoleId)) throw notFound();
  if (nameTaken(rows, body.name, null)) throw duplicateName();

  const id = newId();
  await guardUnique(() =>
    tx.query(`INSERT INTO role (id, tenant_id, name, parent_role_id) VALUES ($1, $2, $3, $4)`, [
      id,
      tenantOf(tx),
      body.name,
      parentRoleId,
    ]),
  );
  await bumpVersion(tx);
  await recordAuditEvent(tx, {
    action: 'created',
    objectType: 'role',
    objectId: id,
    objectLabel: body.name,
    programmeId: null,
    changes: [change('name', null, body.name), change('parentRoleId', null, parentRoleId)],
  });
  return { id, name: body.name, parentRoleId, userCount: 0, descendantUserCount: 0 };
}

export async function updateRole(
  tx: TenantTx,
  roleId: string,
  body: UpdateRoleBody,
): Promise<RoleDetailView> {
  await lockHierarchy(tx);
  const rows = await loadRoles(tx);
  const current = rows.find((row) => row.id === roleId);
  if (current === undefined) throw notFound();

  const { parentRoleId, name } = body;
  const changes = changedFields([
    ['name', current.name, name ?? current.name],
    [
      'parentRoleId',
      current.parent_role_id,
      parentRoleId === undefined ? current.parent_role_id : parentRoleId,
    ],
  ]);
  if (parentRoleId !== undefined && parentRoleId !== current.parent_role_id) {
    if (parentRoleId !== null && !rows.some((row) => row.id === parentRoleId)) throw notFound();
    const conflicts = cycleConflicts(parentMap(rows), [{ roleId, parentRoleId }]);
    if (conflicts.length > 0) throw hierarchyCycle(conflicts);
    await guardUnique(() =>
      tx.query(
        `UPDATE role SET parent_role_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantOf(tx), roleId, parentRoleId],
      ),
    );
    await bumpVersion(tx);
  }
  if (name !== undefined && name !== current.name) {
    if (nameTaken(rows, name, roleId)) throw duplicateName();
    await guardUnique(() =>
      tx.query(`UPDATE role SET name = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [
        tenantOf(tx),
        roleId,
        name,
      ]),
    );
  }
  if (changes.length > 0) {
    await recordAuditEvent(tx, {
      action: 'updated',
      objectType: 'role',
      objectId: roleId,
      objectLabel: name ?? current.name,
      programmeId: null,
      changes,
    });
  }
  return getRole(tx, roleId);
}

export async function updateRoleHierarchy(
  tx: TenantTx,
  body: RoleHierarchyBody,
): Promise<{ version: number; items: RoleView[] }> {
  const version = await lockHierarchy(tx);
  if (body.version !== version) throw staleWrite();

  const rows = await loadRoles(tx);
  const known = new Set(rows.map((row) => row.id));
  const moves: RoleMove[] = body.moves;
  // Any id the tenant cannot see — absent or another tenant's — is one answer.
  for (const move of moves) {
    if (!known.has(move.roleId)) throw notFound();
    if (move.parentRoleId !== null && !known.has(move.parentRoleId)) throw notFound();
  }
  const conflicts = cycleConflicts(parentMap(rows), moves);
  if (conflicts.length > 0) throw hierarchyCycle(conflicts);

  // One statement: the trigger judges the final shape, never a half-applied one.
  await guardUnique(() =>
    tx.query(
      `UPDATE role r
          SET parent_role_id = m.parent_role_id, updated_at = now()
         FROM unnest($2::uuid[], $3::uuid[]) AS m (id, parent_role_id)
        WHERE r.tenant_id = $1 AND r.id = m.id`,
      [tenantOf(tx), moves.map((move) => move.roleId), moves.map((move) => move.parentRoleId)],
    ),
  );
  await bumpVersion(tx);

  // "Audited with the full before and after parent for every moved role":
  // one event per role whose parent actually changed. A move naming the
  // parent a role already has changed nothing and is not recorded.
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const move of moves) {
    const before = byId.get(move.roleId);
    if (before === undefined || before.parent_role_id === move.parentRoleId) continue;
    await recordAuditEvent(tx, {
      action: 'updated',
      objectType: 'role',
      objectId: move.roleId,
      objectLabel: before.name,
      programmeId: null,
      changes: [change('parentRoleId', before.parent_role_id, move.parentRoleId)],
    });
  }
  return listRoles(tx);
}

export async function deleteRole(
  tx: TenantTx,
  roleId: string,
  reassignUsersToRoleId: string,
): Promise<void> {
  await lockHierarchy(tx);
  const rows = await loadRoles(tx);
  const plan = planRoleDeletion(parentMap(rows), roleId, reassignUsersToRoleId);
  if (plan.kind === 'not_found') throw notFound();
  if (plan.kind === 'cycle') throw hierarchyCycle(plan.conflictingIds);
  const doomed = rows.find((row) => row.id === roleId);
  if (doomed === undefined) throw notFound();

  const tenantId = tenantOf(tx);
  const moved = await tx.query<{ count: number }>(
    `WITH moved AS (
       UPDATE "user" SET role_id = $3, updated_at = now()
        WHERE tenant_id = $1 AND role_id = $2
       RETURNING 1
     )
     SELECT count(*)::int AS count FROM moved`,
    [tenantId, roleId, reassignUsersToRoleId],
  );
  await tx.query(
    `UPDATE role SET parent_role_id = $3, updated_at = now()
      WHERE tenant_id = $1 AND parent_role_id = $2`,
    [tenantId, roleId, plan.newParentForChildren],
  );
  await tx.query(`DELETE FROM role WHERE tenant_id = $1 AND id = $2`, [tenantId, roleId]);
  await bumpVersion(tx);
  // "Recorded with the role name, the destination role and the number of
  // people moved" (D-L48). The name lives in objectLabel, so the row still
  // reads correctly after the role is gone.
  await recordAuditEvent(tx, {
    action: 'deleted',
    objectType: 'role',
    objectId: roleId,
    objectLabel: doomed.name,
    programmeId: null,
    changes: [
      change('reassignedToRoleId', null, reassignUsersToRoleId),
      change('movedUserCount', null, String(moved[0]?.count ?? 0)),
    ],
  });
}

export interface PermissionSetView {
  permissionSetId: string;
  label: string;
  userCount: number | null;
  locked: boolean;
}

export async function listPermissionSets(tx: TenantTx): Promise<{ items: PermissionSetView[] }> {
  const rows = await tx.query<{ key: string; label: string; locked: boolean }>(
    `SELECT key, label, locked FROM permission_set
      WHERE tenant_id = $1
      ORDER BY sort_order, key`,
    [tenantOf(tx)],
  );
  // userCount is null, not 0: there is no assignment model yet (D-P9 puts it
  // on user_programme), and 0 would claim that nobody holds the set.
  return {
    items: rows.map((row) => ({
      permissionSetId: row.key,
      label: row.label,
      userCount: null,
      locked: row.locked,
    })),
  };
}
