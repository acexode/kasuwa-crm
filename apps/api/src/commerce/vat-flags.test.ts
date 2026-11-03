import { describe, expect, it } from 'vitest';
import { vatMultitaxEnabled } from './vat-flags';

describe('vatMultitaxEnabled', () => {
  it('is off unless explicitly true', () => {
    expect(vatMultitaxEnabled({})).toBe(false);
    expect(vatMultitaxEnabled({ vatMultitaxEnabled: false })).toBe(false);
    expect(vatMultitaxEnabled({ vatMultitaxEnabled: true })).toBe(true);
  });
});
