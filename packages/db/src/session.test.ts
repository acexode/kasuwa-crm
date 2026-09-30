import { describe, expect, it } from 'vitest';
import { formatProgrammeIds, scopeDiverged, SessionScopeViolationError } from './session';

describe('programme scope formatting', () => {
  it('formats an empty scope as an empty array literal', () => {
    expect(formatProgrammeIds([])).toBe('{}');
  });

  it('formats a list as a Postgres array literal', () => {
    const a = '11111111-0000-4000-8000-0000000c0001';
    const b = '11111111-0000-4000-8000-0000000c0002';
    expect(formatProgrammeIds([a, b])).toBe('{' + a + ',' + b + '}');
  });

  /**
   * The value is interpolated into a GUC rather than bound as a parameter, so
   * this validation is the only thing between a corrupted read and a crafted
   * session variable. Keep it.
   */
  it('refuses anything that is not a uuid', () => {
    expect(() => formatProgrammeIds(['not-a-uuid'])).toThrow();
    expect(() => formatProgrammeIds(["11111111-0000-4000-8000-0000000c0001','x"])).toThrow();
    expect(() => formatProgrammeIds([''])).toThrow();
  });
});

/**
 * The comparison behind the re-scope detection (T-0020, T-0004 FINDING-1). The
 * round trip that produces `actual` is exercised in
 * `session-scope.integration.test.ts` against a real database; this covers the
 * decision itself, which is the part that can be wrong quietly.
 */
describe('session scope divergence', () => {
  const TENANT_A = '11111111-0000-4000-8000-00000000000a';
  const TENANT_B = '11111111-0000-4000-8000-00000000000b';
  const USER = '11111111-0000-4000-8000-0000000a0001';
  const PROGRAMMES = '{11111111-0000-4000-8000-0000000c0001}';

  const resolved = { tenantId: TENANT_A, userId: USER, programmeIds: PROGRAMMES };

  it('accepts the context it set', () => {
    expect(scopeDiverged(resolved, { ...resolved })).toBe(false);
  });

  it('detects a re-pointed tenant', () => {
    expect(scopeDiverged(resolved, { ...resolved, tenantId: TENANT_B })).toBe(true);
  });

  it('detects a widened programme list', () => {
    expect(
      scopeDiverged(resolved, {
        ...resolved,
        programmeIds: '{11111111-0000-4000-8000-0000000c0001,11111111-0000-4000-8000-0000000c0002}',
      }),
    ).toBe(true);
  });

  it('detects a NARROWED scope too', () => {
    // Narrowing is harmless in itself, but it still means the object a reviewer
    // reads and the scope the database enforces have diverged — which is the
    // property being defended, not "did anything leak this time".
    expect(scopeDiverged(resolved, { ...resolved, programmeIds: '{}' })).toBe(true);
  });

  it('detects a cleared context, which is a deny rather than a leak but is still a change', () => {
    expect(scopeDiverged(resolved, { tenantId: '', userId: '', programmeIds: '' })).toBe(true);
    expect(scopeDiverged(resolved, { tenantId: null, userId: null, programmeIds: null })).toBe(
      true,
    );
  });

  it('compares text, so an equivalent spelling of the same scope is still a change', () => {
    // The GUC is text and the policies read text. Accepting "the same set,
    // written differently" would mean reasoning about array parsing inside a
    // security check, which is where the next bug would live.
    expect(
      scopeDiverged(resolved, { ...resolved, programmeIds: PROGRAMMES.toUpperCase() }),
    ).toBe(true);
  });

  it('names no identifier in the error it leads to', () => {
    // The error is thrown on a path where the values in play may belong to
    // another tenant. An error message is a leak channel like any other
    // (root CLAUDE.md section 6 rule 4).
    const message = new SessionScopeViolationError().message;
    expect(message).not.toContain(TENANT_A);
    expect(message).not.toContain(TENANT_B);
    expect(message).not.toContain(USER);
    // NOT VACUOUS: the message does exist and does say what happened.
    expect(message).toContain('rolled back');
  });
});
