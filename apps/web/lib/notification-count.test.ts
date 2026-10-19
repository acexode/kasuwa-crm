import { describe, expect, it } from 'vitest';
import { INITIAL_COUNT, applyLocalCount, applyLocalStep, applyServerCount, badgeLabel, isRise, needsReread } from './notification-count';

const known = (count: number, capped = false) => applyServerCount(INITIAL_COUNT, { count, capped }, 0);

describe('the badge', () => {
  it('says nothing before an answer and at zero, the number to 99, and 99+ when capped', () => {
    expect(badgeLabel(INITIAL_COUNT)).toBe('');
    expect(badgeLabel(known(0))).toBe('');
    expect(badgeLabel(known(7))).toBe('7');
    expect(badgeLabel(known(99))).toBe('99');
    expect(badgeLabel(known(99, true))).toBe('99+');
  });
});

describe('latest answer wins', () => {
  it('drops a read that began before a local change', () => {
    const before = known(7);
    const stepped = applyLocalStep(before, -1);
    expect(stepped.count).toBe(6);
    expect(applyServerCount(stepped, { count: 7, capped: false }, before.epoch)).toBe(stepped);
    expect(applyServerCount(stepped, { count: 5, capped: false }, stepped.epoch).count).toBe(5);
  });

  it('takes a mark-all answer as the truth and outdates reads in flight', () => {
    const before = known(7);
    const after = applyLocalCount(before, { count: 1, capped: false });
    expect(after.count).toBe(1);
    expect(applyServerCount(after, { count: 7, capped: false }, before.epoch).count).toBe(1);
  });

  it('steps exactly only when not capped, never below zero, and asks a capped count to be read again', () => {
    expect(applyLocalStep(known(0), -1).count).toBe(0);
    expect(applyLocalStep(known(3), 1).count).toBe(4);
    const capped = applyLocalStep(known(99, true), -1);
    expect(capped).toMatchObject({ count: 99, capped: true });
    expect(needsReread(capped)).toBe(true);
    expect(needsReread(known(5))).toBe(false);
  });
});

describe('announcements', () => {
  it('announces a rise only: not the first count, not unchanged, not a fall', () => {
    expect(isRise(INITIAL_COUNT, known(7))).toBe(false);
    expect(isRise(known(7), known(9))).toBe(true);
    expect(isRise(known(9), known(9))).toBe(false);
    expect(isRise(known(9), known(8))).toBe(false);
    expect(isRise(known(99), known(99, true))).toBe(true);
    expect(isRise(known(99, true), known(99))).toBe(false);
  });
});
