import { describe, expect, it } from 'vitest';
import type { Role } from '../../lib/admin-api';
import { applyMove, canMove, isDescendant, moveTargets, parentMap, treeRows } from './role-tree';

/**
 * `P02/C1`, `C2`. These are the assertions a drag-and-drop end-to-end test
 * would make badly and slowly: whether a move is a cycle is arithmetic, and a
 * browser is the wrong place to find out that it is wrong.
 */

const ROLES: readonly Role[] = [
  { id: 'md', name: 'Managing Director', parentRoleId: null, userCount: 1 },
  { id: 'hops', name: 'Head of Operations', parentRoleId: 'md', userCount: 1 },
  { id: 'pmb', name: 'Programme Manager, Banking', parentRoleId: 'hops', userCount: 3 },
  { id: 'tle', name: 'Team Lead, Eko Collections', parentRoleId: 'pmb', userCount: 6 },
  { id: 'fin', name: 'Finance Manager', parentRoleId: 'md', userCount: 2 },
];

describe('treeRows', () => {
  it('orders parents before children and reports a 1-based level', () => {
    const rows = treeRows(ROLES, [], new Set());
    expect(rows.map((row) => row.role.id)).toEqual(['md', 'hops', 'pmb', 'tle', 'fin']);
    expect(rows.map((row) => row.level)).toEqual([1, 2, 3, 4, 2]);
  });

  it('omits a collapsed role’s descendants rather than hiding them', () => {
    // Hidden rows that are still in the DOM are still in the tab order, which
    // is a tree a keyboard user cannot navigate.
    const rows = treeRows(ROLES, [], new Set(['hops']));
    expect(rows.map((row) => row.role.id)).toEqual(['md', 'hops', 'fin']);
  });

  it('marks a role whose pending parent differs from the loaded one', () => {
    const rows = treeRows(ROLES, [{ roleId: 'pmb', parentRoleId: 'md' }], new Set());
    expect(rows.find((row) => row.role.id === 'pmb')?.moved).toBe(true);
    expect(rows.find((row) => row.role.id === 'fin')?.moved).toBe(false);
  });

  it('treats a role whose parent is not in the list as a root, not as missing', () => {
    const orphan: Role = { id: 'x', name: 'Orphan', parentRoleId: 'gone', userCount: 1 };
    const rows = treeRows([...ROLES, orphan], [], new Set());
    expect(rows.map((row) => row.role.id)).toContain('x');
    expect(rows.find((row) => row.role.id === 'x')?.level).toBe(1);
  });
});

describe('canMove', () => {
  const parents = parentMap(ROLES, []);

  it('refuses a role onto itself', () => {
    expect(canMove(parents, 'hops', 'hops')).toBe(false);
  });

  it('refuses a role onto one of its own descendants', () => {
    // The cycle an admin actually creates by accident while dragging.
    expect(isDescendant(parents, 'hops', 'tle')).toBe(true);
    expect(canMove(parents, 'hops', 'tle')).toBe(false);
  });

  it('refuses a move that changes nothing', () => {
    expect(canMove(parents, 'hops', 'md')).toBe(false);
  });

  it('allows a sideways move and a move to the root', () => {
    expect(canMove(parents, 'pmb', 'fin')).toBe(true);
    expect(canMove(parents, 'pmb', null)).toBe(true);
  });
});

describe('applyMove', () => {
  it('replaces an earlier move of the same role instead of stacking them', () => {
    const once = applyMove(ROLES, [], 'pmb', 'fin');
    const twice = applyMove(ROLES, once, 'pmb', null);
    expect(twice).toEqual([{ roleId: 'pmb', parentRoleId: null }]);
  });

  it('drops the move entirely when the role is back where it started', () => {
    // Otherwise the bar counts a change that is not one, and Save writes an
    // audit row saying a role moved to where it already was.
    const moved = applyMove(ROLES, [], 'pmb', 'fin');
    expect(applyMove(ROLES, moved, 'pmb', 'hops')).toEqual([]);
  });
});

describe('moveTargets', () => {
  it('offers every role that is not the role itself or beneath it', () => {
    const parents = parentMap(ROLES, []);
    expect(moveTargets(ROLES, parents, 'hops').map((role) => role.id)).toEqual(['md', 'fin']);
  });
});
