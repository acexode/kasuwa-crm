import { describe, expect, it } from 'vitest';
import { byCheckedAtThenRequirement } from './deal-board.repository';
import { dealRotting, weightedAmountMinor, weightedAmountSql } from './deal-board';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe('weightedAmountMinor (D-L88: half to even, per deal, in BigInt)', () => {
  it('rounds an exact half to the even neighbour, and anything else to the nearest', () => {
    expect(weightedAmountMinor('25', 1000)).toBe('2'); // 2.5 -> 2
    expect(weightedAmountMinor('35', 1000)).toBe('4'); // 3.5 -> 4
    expect(weightedAmountMinor('15', 1000)).toBe('2'); // 1.5 -> 2
    expect(weightedAmountMinor('2', 2500)).toBe('0'); // 0.5 -> 0
    expect(weightedAmountMinor('6', 2500)).toBe('2'); // 1.5 -> 2
    expect(weightedAmountMinor('10', 2500)).toBe('2'); // 2.5 -> 2
    expect(weightedAmountMinor('7', 3333)).toBe('2'); // 2.3331 -> 2
    expect(weightedAmountMinor('8', 3333)).toBe('3'); // 2.6664 -> 3
  });

  it('is exact beyond 2^53 and keeps won (10000) and lost (0) amounts whole', () => {
    expect(weightedAmountMinor('999999999999999995', 1000)).toBe('100000000000000000');
    expect(weightedAmountMinor('999999999999999985', 1000)).toBe('99999999999999998');
    expect(weightedAmountMinor('900719925474099301', 10000)).toBe('900719925474099301');
    expect(weightedAmountMinor('123', 0)).toBe('0');
    expect(weightedAmountMinor('0', 7000)).toBe('0');
  });

  it('refuses what is not a non-negative integer string or a basis-point value', () => {
    for (const bad of ['-1', '1.5', '01', '', '1e3', ' 1']) {
      expect(() => weightedAmountMinor(bad, 1000), bad).toThrow(RangeError);
    }
    expect(() => weightedAmountMinor('1', 10001)).toThrow(RangeError);
    expect(() => weightedAmountMinor('1', 2.5)).toThrow(RangeError);
  });

  it('its SQL twin rounds in numeric, half to even, and names only the expressions given', () => {
    const sql = weightedAmountSql('d.amount_minor', 's.probability_bp');
    expect(sql).toContain('d.amount_minor::numeric * s.probability_bp');
    expect(sql).toContain('div(');
    expect(sql).toContain('mod(');
    expect(sql).not.toMatch(/round\(|::bigint|float/);
  });
});

describe('dealRotting (whole 24-hour periods since stageEnteredAt)', () => {
  const now = Date.UTC(2031, 0, 31, 12);
  const entered = (ms: number) => new Date(now - ms);

  it('fresh below half, stale from half rounded down, rotting from the stage’s days', () => {
    expect(dealRotting(entered(6 * DAY + 12 * HOUR), 14, now)).toBe('fresh');
    expect(dealRotting(entered(7 * DAY), 14, now)).toBe('stale');
    expect(dealRotting(entered(14 * DAY - 1), 14, now)).toBe('stale');
    expect(dealRotting(entered(14 * DAY), 14, now)).toBe('rotting');
    // 21 days: stale from 10 (21/2 rounded down).
    expect(dealRotting(entered(10 * DAY), 21, now)).toBe('stale');
    expect(dealRotting(entered(9 * DAY + 23 * HOUR), 21, now)).toBe('fresh');
  });

  it('is null for a stage without rotting days (won and lost)', () => {
    expect(dealRotting(entered(400 * DAY), null, now)).toBeNull();
  });
});

describe('a card’s checks', () => {
  it('are ordered by when they were ticked, ties by requirement id', () => {
    const check = (requirementId: string, at: number) => ({
      requirementId,
      checkedAt: new Date(at),
      checkedBy: { id: 'u', displayName: 'T0107 synthetic' },
    });
    const sorted = [check('b', 2), check('c', 1), check('a', 2)].sort(byCheckedAtThenRequirement);
    expect(sorted.map((entry) => entry.requirementId)).toEqual(['c', 'a', 'b']);
  });
});
