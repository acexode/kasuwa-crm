import { describe, expect, it } from 'vitest';
import { isCompleteOrder } from './disposition.repository';

describe('isCompleteOrder (T-0027, D-L47)', () => {
  const live = ['a', 'b', 'c'];

  it('accepts the live ids in any order', () => {
    expect(isCompleteOrder(live, ['c', 'a', 'b'])).toBe(true);
    expect(isCompleteOrder(live, live)).toBe(true);
    expect(isCompleteOrder([], [])).toBe(true);
  });

  it('rejects a subset, an empty list and a superset', () => {
    expect(isCompleteOrder(live, ['a', 'b'])).toBe(false);
    expect(isCompleteOrder(live, [])).toBe(false);
    expect(isCompleteOrder(live, ['a', 'b', 'c', 'd'])).toBe(false);
  });

  it('rejects a duplicate standing in for an omitted id', () => {
    expect(isCompleteOrder(live, ['a', 'a', 'b'])).toBe(false);
  });

  it('rejects a foreign or unknown id in place of a live one', () => {
    expect(isCompleteOrder(live, ['a', 'b', 'x'])).toBe(false);
    expect(isCompleteOrder([], ['x'])).toBe(false);
  });
});
