/**
 * The board's pure rules (T-0107; D-L88, D-P19), kept apart from SQL so that
 * each is unit-tested without a database.
 */

const BASIS_POINTS = 10_000n;

/**
 * A deal's weighted amount: `amountMinor * probabilityBp / 10000`, rounded
 * half to even (D-L88), in BigInt from the decimal string the database
 * rendered. A JS number never touches an amount: past 2^53 it is not exact.
 * Returns the decimal string. `amountMinor` is non-negative (0036's CHECK).
 */
export function weightedAmountMinor(amountMinor: string, probabilityBp: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amountMinor)) {
    throw new RangeError('amountMinor is not a non-negative integer string');
  }
  if (!Number.isInteger(probabilityBp) || probabilityBp < 0 || probabilityBp > 10_000) {
    throw new RangeError('probabilityBp is not 0..10000');
  }
  const product = BigInt(amountMinor) * BigInt(probabilityBp);
  const quotient = product / BASIS_POINTS;
  const twiceRemainder = (product % BASIS_POINTS) * 2n;
  if (twiceRemainder > BASIS_POINTS) return (quotient + 1n).toString();
  if (twiceRemainder === BASIS_POINTS && quotient % 2n === 1n) return (quotient + 1n).toString();
  return quotient.toString();
}

/**
 * The SQL twin of `weightedAmountMinor`, for the per-currency totals, which
 * are summed in Postgres `numeric` (the contract: never `bigint`, never a JS
 * number). `amount` and `bp` are fixed SQL expressions, never input. Half to
 * even: `div` and `mod` on non-negative numerics, plus one when the remainder
 * is over half, or exactly half and the quotient is odd.
 */
export function weightedAmountSql(amount: string, bp: string): string {
  const product = `(${amount}::numeric * ${bp})`;
  const quotient = `div(${product}, 10000)`;
  const remainder = `mod(${product}, 10000)`;
  return `(${quotient} + CASE
      WHEN ${remainder} * 2 > 10000 THEN 1
      WHEN ${remainder} * 2 = 10000 THEN mod(${quotient}, 2)
      ELSE 0 END)`;
}

export type DealRotting = 'fresh' | 'stale' | 'rotting';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rotting (the contract's DealRotting): whole 24-hour periods since
 * `stageEnteredAt`, no zone; `stale` from half the stage's `rottingAfterDays`
 * rounded down, `rotting` from `rottingAfterDays`. `null` on a stage with no
 * rotting days (won and lost).
 */
export function dealRotting(
  stageEnteredAt: Date,
  rottingAfterDays: number | null,
  nowMs: number,
): DealRotting | null {
  if (rottingAfterDays === null) return null;
  const days = Math.floor((nowMs - stageEnteredAt.getTime()) / DAY_MS);
  if (days >= rottingAfterDays) return 'rotting';
  if (days >= Math.floor(rottingAfterDays / 2)) return 'stale';
  return 'fresh';
}
