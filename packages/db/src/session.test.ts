import { describe, expect, it } from 'vitest';
import { formatProgrammeIds } from './session';

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
