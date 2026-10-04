import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { isPoolConnectionTimeout } from './pool';

describe('isPoolConnectionTimeout', () => {
  it('recognises both pg-pool connection timeouts', () => {
    expect(isPoolConnectionTimeout(new Error('timeout exceeded when trying to connect'))).toBe(true);
    expect(
      isPoolConnectionTimeout(
        new Error('Connection terminated due to connection timeout', { cause: new Error('x') }),
      ),
    ).toBe(true);
  });

  it('does not match a statement timeout, a dropped connection or anything else', () => {
    const statementTimeout = Object.assign(
      new DatabaseError('canceling statement due to statement timeout', 0, 'error'),
      { code: '57014' },
    );
    expect(isPoolConnectionTimeout(statementTimeout)).toBe(false);
    expect(isPoolConnectionTimeout(new Error('Connection terminated unexpectedly'))).toBe(false);
    expect(isPoolConnectionTimeout(new Error('timeout exceeded when trying to connect!'))).toBe(
      false,
    );
    expect(isPoolConnectionTimeout('timeout exceeded when trying to connect')).toBe(false);
    expect(isPoolConnectionTimeout(undefined)).toBe(false);
  });
});
