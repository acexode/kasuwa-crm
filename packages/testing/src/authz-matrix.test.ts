import { describe, expect, it } from 'vitest';
import {
  authzCellKey,
  buildAuthzMatrix,
  buildPlaceholderAuthzMatrix,
  IncompleteAuthzMatrixError,
  PLACEHOLDER_ACTIONS,
  PLACEHOLDER_EXPECTATIONS,
  PLACEHOLDER_OBJECTS,
  PLACEHOLDER_ROLES,
  runAuthzMatrix,
  type AuthzDecision,
} from './authz-matrix';

/**
 * Every test here is written to be capable of failing.
 *
 * The harness's whole value is that it refuses an incomplete matrix, so most of
 * these feed it a broken input and assert that it objects — a completeness check
 * that has only ever been observed passing is indistinguishable from no check.
 */

const roles = ['agent', 'supervisor'] as const;
const objects = ['contact'] as const;
const actions = ['read', 'delete'] as const;

const complete: Record<string, AuthzDecision> = {
  'agent:contact:read': 'allow',
  'agent:contact:delete': 'deny',
  'supervisor:contact:read': 'allow',
  'supervisor:contact:delete': 'allow',
};

describe('buildAuthzMatrix', () => {
  it('enumerates every role × object × action', () => {
    const matrix = buildAuthzMatrix({ roles, objects, actions, expectations: complete });
    expect(matrix.cells).toHaveLength(roles.length * objects.length * actions.length);
    expect(matrix.cells.map((cell) => cell.key).sort()).toEqual(Object.keys(complete).sort());
  });

  it('carries the role, object and action apart from the key', () => {
    // So a failure report can group by role without re-parsing a string.
    const matrix = buildAuthzMatrix({ roles, objects, actions, expectations: complete });
    const cell = matrix.cells.find((candidate) => candidate.key === 'agent:contact:delete');
    expect(cell).toMatchObject({
      role: 'agent',
      object: 'contact',
      action: 'delete',
      expected: 'deny',
    });
  });

  it('refuses a matrix with a missing cell, and names it', () => {
    const { 'supervisor:contact:delete': _omitted, ...incomplete } = complete;
    expect(() => buildAuthzMatrix({ roles, objects, actions, expectations: incomplete })).toThrow(
      /supervisor:contact:delete/,
    );
  });

  it('does not treat a missing cell as a deny', () => {
    // The failure mode the harness exists to prevent, asserted directly: an
    // absent expectation must not quietly become "deny", because then a newly
    // added object arrives with no coverage and the matrix stays green.
    const { 'agent:contact:read': _omitted, ...incomplete } = complete;
    let built: unknown = null;
    try {
      built = buildAuthzMatrix({ roles, objects, actions, expectations: incomplete });
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteAuthzMatrixError);
    }
    expect(built, 'an incomplete matrix was built').toBeNull();
  });

  it('names every missing cell, not just the first', () => {
    try {
      buildAuthzMatrix({ roles, objects, actions, expectations: {} });
      expect.unreachable('an empty expectation set was accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteAuthzMatrixError);
      expect((error as IncompleteAuthzMatrixError).missing).toHaveLength(4);
    }
  });

  it('refuses an expectation for a cell that does not exist', () => {
    // Almost always a half-landed rename. Ignoring it leaves a role or object
    // uncovered while the count still looks right.
    expect(() =>
      buildAuthzMatrix({
        roles,
        objects,
        actions,
        expectations: { ...complete, 'auditor:contact:read': 'deny' },
      }),
    ).toThrow(/auditor:contact:read/);
  });

  it('builds an empty matrix when there is nothing to enumerate', () => {
    // Legitimately vacuous, and called out so the zero is not mistaken for
    // coverage: no roles means no cells, which is correct and proves nothing.
    expect(buildAuthzMatrix({ roles: [], objects, actions, expectations: {} }).cells).toEqual([]);
  });
});

describe('authzCellKey', () => {
  it('matches the key format the expectation table is written in', () => {
    expect(authzCellKey('agent', 'contact', 'read')).toBe('agent:contact:read');
  });
});

describe('runAuthzMatrix', () => {
  it('reports no failures when the evaluator agrees', async () => {
    const matrix = buildAuthzMatrix({ roles, objects, actions, expectations: complete });
    const result = await runAuthzMatrix(matrix, (cell) => cell.expected);
    expect(result.checked).toBe(4);
    expect(result.failures).toEqual([]);
  });

  it('reports EVERY disagreement, not only the first', async () => {
    const matrix = buildAuthzMatrix({ roles, objects, actions, expectations: complete });
    const result = await runAuthzMatrix(matrix, () => 'deny');
    // Three of the four expectations are 'allow'.
    expect(result.failures).toHaveLength(3);
    expect(result.failures.every((failure) => failure.actual === 'deny')).toBe(true);
  });

  it('awaits an asynchronous evaluator', async () => {
    const matrix = buildAuthzMatrix({ roles, objects, actions, expectations: complete });
    const result = await runAuthzMatrix(matrix, async (cell) =>
      Promise.resolve(cell.expected === 'allow' ? 'deny' : 'allow'),
    );
    expect(result.failures).toHaveLength(4);
  });
});

describe('the placeholder matrix', () => {
  it('runs against a placeholder role set while the engine is unbuilt', async () => {
    const matrix = buildPlaceholderAuthzMatrix();
    expect(matrix.cells).toHaveLength(
      PLACEHOLDER_ROLES.length * PLACEHOLDER_OBJECTS.length * PLACEHOLDER_ACTIONS.length,
    );
    const result = await runAuthzMatrix(matrix, (cell) => PLACEHOLDER_EXPECTATIONS[cell.key] ?? 'deny');
    expect(result.failures).toEqual([]);
    expect(result.checked).toBeGreaterThan(0);
  });

  it('is itself complete, so the placeholder cannot rot into a partial table', () => {
    expect(Object.keys(PLACEHOLDER_EXPECTATIONS)).toHaveLength(
      PLACEHOLDER_ROLES.length * PLACEHOLDER_OBJECTS.length * PLACEHOLDER_ACTIONS.length,
    );
  });
});
