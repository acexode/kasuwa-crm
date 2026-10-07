import { describe, expect, it } from 'vitest';
import {
  classifyAccountWriteError,
  hierarchyVerdict,
  MAX_ACCOUNT_DEPTH,
} from './account-hierarchy';

/** A pg-shaped error: what `DatabaseError` carries, built without a server. */
function pgError(code: string, constraint: string | undefined, message: string): Error {
  return Object.assign(new Error(message), {
    code,
    constraint,
    detail: 'Failing row contains (Probe Name Ltd, +2348030000000)',
  });
}

describe('hierarchyVerdict (D-L74: no cycle, depth at most 5)', () => {
  it('the cap is 5', () => {
    expect(MAX_ACCOUNT_DEPTH).toBe(5);
  });

  it('a cycle is parent_cycle whatever the depth', () => {
    expect(hierarchyVerdict({ cycle: true, parentDepth: 1, height: 1 })).toBe('parent_cycle');
    expect(hierarchyVerdict({ cycle: true, parentDepth: 9, height: 9 })).toBe('parent_cycle');
  });

  it('a new account under depth 4 lands at 5 and is allowed; under depth 5 it is parent_depth', () => {
    expect(hierarchyVerdict({ cycle: false, parentDepth: 4, height: 1 })).toBeNull();
    expect(hierarchyVerdict({ cycle: false, parentDepth: 5, height: 1 })).toBe('parent_depth');
  });

  it('a re-parent counts the subtree that moves with it', () => {
    // An account with one child, moved under depth 4: the child lands at 6.
    expect(hierarchyVerdict({ cycle: false, parentDepth: 4, height: 2 })).toBe('parent_depth');
    // Under depth 3: the child lands at exactly 5.
    expect(hierarchyVerdict({ cycle: false, parentDepth: 3, height: 2 })).toBeNull();
  });
});

describe('classifyAccountWriteError (0026 guard and keys -> a 400 reason, never pg text)', () => {
  it.each([
    [
      'the guard refusing a cycle',
      pgError(
        '23514',
        'account_hierarchy',
        'account hierarchy: an account cannot be its own ancestor',
      ),
      'parent_cycle',
    ],
    [
      'the guard refusing depth',
      pgError('23514', 'account_hierarchy', 'account hierarchy: deeper than 5 levels'),
      'parent_depth',
    ],
    [
      'the guard failing closed',
      pgError(
        '23514',
        'account_hierarchy',
        'account hierarchy: the parent chain could not be verified',
      ),
      'unknown_parent',
    ],
    [
      'the self-parent CHECK',
      pgError('23514', 'account_parent_not_self_check', 'new row violates check constraint'),
      'parent_cycle',
    ],
    [
      'the parent composite key',
      pgError('23503', 'account_parent_same_programme_fk', 'insert or update violates foreign key'),
      'unknown_parent',
    ],
    [
      'the owner composite key',
      pgError('23503', 'account_owner_same_tenant_fk', 'insert or update violates foreign key'),
      'unknown_owner',
    ],
  ])('%s', (_label, error, reason) => {
    expect(classifyAccountWriteError(error)).toBe(reason);
  });

  it.each([
    ['another CHECK', pgError('23514', 'account_tier_check', 'violates check constraint')],
    ['another key', pgError('23503', 'contact_account_same_programme_fk', 'violates fk')],
    ['a NUL in text', pgError('22021', undefined, 'invalid byte sequence')],
    ['a unique violation', pgError('23505', 'account_pkey', 'duplicate key')],
    ['no constraint on a 23514', pgError('23514', undefined, 'account hierarchy: deeper than 5')],
  ])('leaves %s alone (a scrubbed 500, not a guessed 400)', (_label, error) => {
    expect(classifyAccountWriteError(error)).toBeNull();
  });

  it('ignores anything that is not an Error, however it is shaped', () => {
    expect(
      classifyAccountWriteError({ code: '23514', constraint: 'account_hierarchy', message: '' }),
    ).toBeNull();
    expect(classifyAccountWriteError('23514')).toBeNull();
    expect(classifyAccountWriteError(null)).toBeNull();
  });
});
