/**
 * The role hierarchy as pure data: one map from role id to parent id.
 *
 * Everything that asks "what is beneath this role" or "would this write make a
 * loop" goes through here, and nothing else implements either question. Record
 * visibility will follow this relation; two implementations of "beneath" is how
 * a visibility rule drifts from what the screen promises (listRoles, spec).
 *
 * No I/O. The caller loads the tenant's edges inside its tenant transaction,
 * under the hierarchy lock, and hands them in.
 */

/** role id -> parent role id, or null for a root. One tenant's roles only. */
export type ParentMap = ReadonlyMap<string, string | null>;

export interface RoleMove {
  roleId: string;
  parentRoleId: string | null;
}

function childrenIndex(parents: ParentMap): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const [id, parent] of parents) {
    if (parent === null) continue;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [id]);
    else list.push(id);
  }
  return children;
}

/**
 * Every role beneath `roleId` — children, grandchildren and so on — excluding
 * `roleId` itself. Terminates even on a cyclic map, so it is safe to call
 * before the map has been validated.
 */
export function descendantsOf(parents: ParentMap, roleId: string): string[] {
  const children = childrenIndex(parents);
  const seen = new Set<string>([roleId]);
  const result: string[] = [];
  const queue = [...(children.get(roleId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    result.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return result;
}

/** Every role with its full descendant set, in one pass per root. */
export function descendantIndex(parents: ParentMap): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const id of parents.keys()) index.set(id, descendantsOf(parents, id));
  return index;
}

/** The map after `moves`, applied all at once. Does not mutate `parents`. */
export function applyMoves(
  parents: ParentMap,
  moves: readonly RoleMove[],
): Map<string, string | null> {
  const next = new Map(parents);
  for (const move of moves) next.set(move.roleId, move.parentRoleId);
  return next;
}

/** Every role that lies on a cycle. Empty for a forest. */
export function rolesOnCycles(parents: ParentMap): Set<string> {
  const onCycle = new Set<string>();
  const done = new Set<string>();
  for (const start of parents.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const inPath = new Map<string, number>();
    let current: string | null | undefined = start;
    while (current !== null && current !== undefined && !done.has(current)) {
      const seenAt = inPath.get(current);
      if (seenAt !== undefined) {
        for (const id of path.slice(seenAt)) onCycle.add(id);
        break;
      }
      inPath.set(current, path.length);
      path.push(current);
      current = parents.get(current);
    }
    for (const id of path) done.add(id);
  }
  return onCycle;
}

/**
 * The ids to report in `409 role_hierarchy_cycle`, or an empty list if `moves`
 * leave a forest.
 *
 * Only ids the caller submitted are ever returned — the moved role and the
 * parent it asked for, for each move whose role ends up on a cycle. A cycle can
 * run through roles the request never named; naming those would make the error
 * body disclose structure the caller did not send (spec, `conflictingIds`).
 */
export function cycleConflicts(parents: ParentMap, moves: readonly RoleMove[]): string[] {
  const onCycle = rolesOnCycles(applyMoves(parents, moves));
  const ids = new Set<string>();
  for (const move of moves) {
    if (!onCycle.has(move.roleId)) continue;
    ids.add(move.roleId);
    if (move.parentRoleId !== null) ids.add(move.parentRoleId);
  }
  return [...ids];
}

/**
 * Whether people in `deletedId` may be moved to `targetId`.
 *
 * Not into the role being deleted, and not into its subtree: that subtree is
 * about to be re-parented, and "reassign into what you are deleting" is the
 * delete-shaped version of a cycle (spec, deleteRole).
 */
export function isValidReassignmentTarget(
  parents: ParentMap,
  deletedId: string,
  targetId: string,
): boolean {
  return targetId !== deletedId && !descendantsOf(parents, deletedId).includes(targetId);
}

export type DeletionPlan =
  | { kind: 'not_found' }
  | { kind: 'cycle'; conflictingIds: string[] }
  | {
      kind: 'ok';
      /** Direct children of the deleted role, which move up one level. */
      children: string[];
      /** Their new parent: the deleted role's own parent ("re-parented to the deleted role's parent"). */
      newParentForChildren: string | null;
    };

/**
 * What deleting `deletedId` and moving its people to `targetId` would do, or
 * why it cannot. The order of the checks is the contract: reassigning into the
 * role itself is a cycle before it is anything else; an unknown target — absent
 * or another tenant's, the map cannot tell and neither can the caller — is
 * `not_found`; a target inside the subtree is a cycle.
 */
export function planRoleDeletion(
  parents: ParentMap,
  deletedId: string,
  targetId: string,
): DeletionPlan {
  if (!parents.has(deletedId)) return { kind: 'not_found' };
  if (targetId === deletedId) return { kind: 'cycle', conflictingIds: [deletedId] };
  if (!parents.has(targetId)) return { kind: 'not_found' };
  if (!isValidReassignmentTarget(parents, deletedId, targetId)) {
    return { kind: 'cycle', conflictingIds: [deletedId, targetId] };
  }
  const children = [...parents].filter(([, parent]) => parent === deletedId).map(([id]) => id);
  return { kind: 'ok', children, newParentForChildren: parents.get(deletedId) ?? null };
}
