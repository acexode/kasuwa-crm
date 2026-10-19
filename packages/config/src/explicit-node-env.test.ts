import { describe, expect, it } from 'vitest';
import { assertExplicitNodeEnv } from './index';

describe('assertExplicitNodeEnv (T-0122)', () => {
  it('refuses an unset NODE_ENV, naming NODE_ENV and the tool only', () => {
    expect(() => assertExplicitNodeEnv('db:reset', {})).toThrow(/db:reset.*NODE_ENV/u);
  });

  it('accepts any set value; the target checks judge the value', () => {
    for (const value of ['development', 'test', 'production', '']) {
      expect(() => assertExplicitNodeEnv('db:reset', { NODE_ENV: value })).not.toThrow();
    }
  });
});
