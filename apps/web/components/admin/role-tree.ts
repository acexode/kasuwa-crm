import type { Role, RoleMove } from '../../lib/admin-api';

/**
 * The tree arithmetic behind `P02/C`, `C1` and `C2`, kept pure so it can be
 * tested without a browser — a drag-and-drop test is the slowest and least
 * reliable way to find out that "is this role a descendant of that one" is
 * wrong.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT COMPUTE
 *
 * It derives the ROWS to draw and whether a proposed move is legal. It does
 * NOT recompute `descendantUserCount`: the contract says that number is
 * server-computed because record visibility follows the same relation, and a
 * second implementation in the browser is exactly how a visibility rule drifts
 * from what the screen promises.
 *
 * `isDescendant` exists so the screen can refuse a cycle before sending it,
 * which is a courtesy and not the control. The server answers
 * `409 role_hierarchy_cycle` and applies NOTHING — not the valid moves either
 * — and `RolesScreen` renders that rather than assuming its own check was
 * enough.
 * ---------------------------------------------------------------------------
 */

export interface RoleRow {
  readonly role: Role;
  /** 1-based, for `aria-level`. */
  readonly level: number;
  readonly hasChildren: boolean;
  readonly parentRoleId: string | null;
  /** The parent differs from the one that was loaded. */
  readonly moved: boolean;
}

/** `roleId -> parentRoleId`, with pending moves applied over the loaded list. */
export function parentMap(
  roles: readonly Role[],
  moves: readonly RoleMove[],
): ReadonlyMap<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const role of roles) parents.set(role.id, role.parentRoleId);
  for (const move of moves) {
    if (parents.has(move.roleId)) parents.set(move.roleId, move.parentRoleId);
  }
  return parents;
}

/** True when `candidateId` sits anywhere beneath `rootId` under `parents`. */
export function isDescendant(
  parents: ReadonlyMap<string, string | null>,
  rootId: string,
  candidateId: string,
): boolean {
  // Bounded by the number of roles, so a parent map that somehow contains a
  // cycle terminates rather than hanging the tab.
  let current: string | null | undefined = candidateId;
  for (let step = 0; step <= parents.size; step += 1) {
    if (current === null || current === undefined) return false;
    if (current === rootId) return candidateId !== rootId;
    current = parents.get(current) ?? null;
  }
  return false;
}

/**
 * A move is legal when it is not onto itself and not onto one of its own
 * descendants. Both would be a cycle, and the second is the one an admin
 * actually does by accident while dragging.
 */
export function canMove(
  parents: ReadonlyMap<string, string | null>,
  roleId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === roleId) return false;
  if (newParentId !== null && !parents.has(newParentId)) return false;
  if ((parents.get(roleId) ?? null) === newParentId) return false;
  return newParentId === null || !isDescendant(parents, roleId, newParentId);
}

/**
 * Depth-first rows, parents before children, siblings in the order the server
 * sent them. A collapsed role's descendants are omitted entirely rather than
 * hidden with CSS: a tree whose hidden rows are still in the tab order is one a
 * keyboard user cannot navigate.
 */
export function treeRows(
  roles: readonly Role[],
  moves: readonly RoleMove[],
  collapsed: ReadonlySet<string>,
): readonly RoleRow[] {
  const parents = parentMap(roles, moves);
  const loaded = new Map(roles.map((role) => [role.id, role.parentRoleId] as const));
  const moved = new Set(moves.map((move) => move.roleId));
  const byId = new Map(roles.map((role) => [role.id, role] as const));

  const childrenOf = new Map<string | null, Role[]>();
  for (const role of roles) {
    const parent = parents.get(role.id) ?? null;
    // A parent that is not in the list (deleted, or outside what the caller can
    // reach) makes the role a root rather than making it disappear.
    const key = parent !== null && byId.has(parent) ? parent : null;
    const bucket = childrenOf.get(key);
    if (bucket === undefined) childrenOf.set(key, [role]);
    else bucket.push(role);
  }

  const rows: RoleRow[] = [];
  const seen = new Set<string>();

  const walk = (parentId: string | null, level: number): void => {
    for (const role of childrenOf.get(parentId) ?? []) {
      if (seen.has(role.id)) continue;
      seen.add(role.id);
      const hasChildren = (childrenOf.get(role.id) ?? []).length > 0;
      rows.push({
        role,
        level,
        hasChildren,
        parentRoleId: parentId,
        moved: moved.has(role.id) && (loaded.get(role.id) ?? null) !== parentId,
      });
      if (!collapsed.has(role.id)) walk(role.id, level + 1);
    }
  };

  walk(null, 1);
  return rows;
}

/**
 * Record a move, replacing any earlier move of the same role and dropping it
 * entirely when the role is back where it started. Without that second rule the
 * unsaved bar counts a change that is not one, and "Save" sends a no-op edge
 * that writes an audit row saying a role moved to where it already was.
 */
export function applyMove(
  roles: readonly Role[],
  moves: readonly RoleMove[],
  roleId: string,
  newParentId: string | null,
): readonly RoleMove[] {
  const original = roles.find((role) => role.id === roleId)?.parentRoleId ?? null;
  const without = moves.filter((move) => move.roleId !== roleId);
  if (original === newParentId) return without;
  return [...without, { roleId, parentRoleId: newParentId }];
}

/** Every role a given role may be moved under, for the "Reports to" picker. */
export function moveTargets(
  roles: readonly Role[],
  parents: ReadonlyMap<string, string | null>,
  roleId: string,
): readonly Role[] {
  return roles.filter((role) => role.id !== roleId && !isDescendant(parents, roleId, role.id));
}
