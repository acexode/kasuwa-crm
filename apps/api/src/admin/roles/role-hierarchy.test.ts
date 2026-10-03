import { describe, expect, it } from 'vitest';
import {
  applyMoves,
  cycleConflicts,
  descendantsOf,
  isValidReassignmentTarget,
  planRoleDeletion,
  rolesOnCycles,
  type ParentMap,
} from './role-hierarchy';

/*
 *   md
 *   ├── ops
 *   │   ├── lead
 *   │   │   └── agent
 *   │   └── qa
 *   └── risk
 *   loose            (a second root)
 */
const tree: ParentMap = new Map<string, string | null>([
  ['md', null],
  ['ops', 'md'],
  ['lead', 'ops'],
  ['agent', 'lead'],
  ['qa', 'ops'],
  ['risk', 'md'],
  ['loose', null],
]);

describe('descendantsOf', () => {
  it('returns every role beneath, not only direct children, and never the role itself', () => {
    expect(descendantsOf(tree, 'ops').sort()).toEqual(['agent', 'lead', 'qa']);
    expect(descendantsOf(tree, 'md').sort()).toEqual(['agent', 'lead', 'ops', 'qa', 'risk']);
    expect(descendantsOf(tree, 'agent')).toEqual([]);
  });

  it('terminates on a map that already contains a cycle', () => {
    const looped = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(descendantsOf(looped, 'a')).toEqual(['b']);
  });
});

describe('rolesOnCycles', () => {
  it('is empty for a forest', () => {
    expect(rolesOnCycles(tree).size).toBe(0);
  });

  it('names exactly the roles on the loop, not the ones hanging off it', () => {
    const looped = applyMoves(tree, [{ roleId: 'ops', parentRoleId: 'agent' }]);
    expect([...rolesOnCycles(looped)].sort()).toEqual(['agent', 'lead', 'ops']);
  });

  it('treats a role that is its own parent as a cycle', () => {
    expect([...rolesOnCycles(applyMoves(tree, [{ roleId: 'qa', parentRoleId: 'qa' }]))]).toEqual([
      'qa',
    ]);
  });
});

describe('cycleConflicts', () => {
  it('accepts moves that leave a forest, including swaps that are only valid together', () => {
    expect(cycleConflicts(tree, [{ roleId: 'loose', parentRoleId: 'lead' }])).toEqual([]);
    // lead under qa, then qa under risk: fine in any order once both apply.
    expect(
      cycleConflicts(tree, [
        { roleId: 'qa', parentRoleId: 'risk' },
        { roleId: 'lead', parentRoleId: 'qa' },
      ]),
    ).toEqual([]);
    // Moving a role to the root is never a cycle.
    expect(cycleConflicts(tree, [{ roleId: 'agent', parentRoleId: null }])).toEqual([]);
  });

  it('rejects a role reporting to its own descendant', () => {
    expect(cycleConflicts(tree, [{ roleId: 'ops', parentRoleId: 'agent' }]).sort()).toEqual([
      'agent',
      'ops',
    ]);
  });

  it('judges the batch as a whole: the cycle is reported, the valid move is not', () => {
    const conflicts = cycleConflicts(tree, [
      { roleId: 'loose', parentRoleId: 'lead' },
      { roleId: 'md', parentRoleId: 'ops' },
    ]);
    expect(conflicts.sort()).toEqual(['md', 'ops']);
    expect(conflicts).not.toContain('loose');
  });

  it('never reports a role the request did not name, even when the loop runs through it', () => {
    // md -> agent closes md > ops > lead > agent > md; ops and lead were not sent.
    const conflicts = cycleConflicts(tree, [{ roleId: 'md', parentRoleId: 'agent' }]);
    expect(conflicts.sort()).toEqual(['agent', 'md']);
  });

  it('does not mutate the map it was given', () => {
    cycleConflicts(tree, [{ roleId: 'md', parentRoleId: 'agent' }]);
    expect(tree.get('md')).toBeNull();
  });
});

describe('reassignment on delete', () => {
  it('refuses the role itself and its subtree, and accepts anything else', () => {
    expect(isValidReassignmentTarget(tree, 'ops', 'ops')).toBe(false);
    expect(isValidReassignmentTarget(tree, 'ops', 'agent')).toBe(false);
    expect(isValidReassignmentTarget(tree, 'ops', 'md')).toBe(true);
    expect(isValidReassignmentTarget(tree, 'ops', 'loose')).toBe(true);
  });

  it('plans to move the direct children up to the deleted role’s parent', () => {
    expect(planRoleDeletion(tree, 'ops', 'risk')).toEqual({
      kind: 'ok',
      children: ['lead', 'qa'],
      newParentForChildren: 'md',
    });
    // Deleting a root makes its children roots.
    expect(planRoleDeletion(tree, 'md', 'loose')).toEqual({
      kind: 'ok',
      children: ['ops', 'risk'],
      newParentForChildren: null,
    });
  });

  it('answers in the contract order: self is a cycle, unknown is not found, subtree is a cycle', () => {
    expect(planRoleDeletion(tree, 'ops', 'ops')).toEqual({
      kind: 'cycle',
      conflictingIds: ['ops'],
    });
    expect(planRoleDeletion(tree, 'ops', 'elsewhere')).toEqual({ kind: 'not_found' });
    expect(planRoleDeletion(tree, 'ops', 'lead')).toEqual({
      kind: 'cycle',
      conflictingIds: ['ops', 'lead'],
    });
    expect(planRoleDeletion(tree, 'nobody', 'md')).toEqual({ kind: 'not_found' });
  });
});
