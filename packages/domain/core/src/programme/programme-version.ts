/**
 * The optimistic-concurrency token for a programme (T-0024).
 *
 * `programme` has no `version` column and T-0024 forbids a migration, so the
 * lead's ruling is to derive one: the integer number of milliseconds since the
 * epoch of `updated_at`. It is exactly as good as `updated_at` is at changing
 * on every write, which is why the update statement sets it to something
 * strictly later than its previous value, truncated to the millisecond (see
 * `NEXT_UPDATED_AT_SQL`).
 *
 * The timestamp arrives as the string Postgres rendered — never through a JS
 * `Date` parse of an arbitrary format — and is parsed here by an explicit
 * pattern. One implementation, used on read and on the comparison inside the
 * update, so the version a client was given and the version it is checked
 * against cannot disagree.
 *
 * When a real `version` column arrives (a successor task), this file goes and
 * the wire contract does not change: it is an opaque integer either way.
 */

const RENDERED_UTC =
  /^(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})T(?<h>\d{2}):(?<mi>\d{2}):(?<s>\d{2})(?:\.(?<f>\d{1,6}))?Z$/u;

export class UnparseableVersionTimestampError extends Error {
  constructor() {
    super('updated_at was not rendered in the expected UTC format');
    this.name = 'UnparseableVersionTimestampError';
  }
}

/**
 * `2026-10-02T10:00:00.123456Z` -> 1790935200123. Sub-millisecond digits are
 * truncated, never rounded: rounding could move a version forward past a
 * value the database has not reached yet.
 */
export function versionFromUpdatedAt(rendered: string): number {
  const match = RENDERED_UTC.exec(rendered);
  const g = match?.groups;
  if (g === undefined) {
    throw new UnparseableVersionTimestampError();
  }
  const millis = Number((g.f ?? '').padEnd(3, '0').slice(0, 3));
  const value = Date.UTC(
    Number(g.y),
    Number(g.mo) - 1,
    Number(g.d),
    Number(g.h),
    Number(g.mi),
    Number(g.s),
    millis,
  );
  if (!Number.isSafeInteger(value)) {
    throw new UnparseableVersionTimestampError();
  }
  return value;
}

/**
 * What `updated_at` becomes on a write: now, to the millisecond, but never
 * earlier than one millisecond after its current value. Two writes inside the
 * same millisecond — or a clock that steps backwards — still produce two
 * different versions, so a stale token can never match again by accident.
 *
 * EVERY `UPDATE programme` must set `updated_at` to this. Migration 0018's
 * trigger sets `now()` on any UPDATE that leaves `updated_at` alone, and
 * `now()` is the transaction start: after an earlier statement in the same
 * transaction wrote this value, an UPDATE that forgot it would move the
 * version backwards, and a stale token could match again.
 */
export const NEXT_UPDATED_AT_SQL = `GREATEST(
  date_trunc('milliseconds', clock_timestamp()),
  date_trunc('milliseconds', updated_at) + interval '1 millisecond'
)`;

/** Renders `updated_at` for `versionFromUpdatedAt`, independent of DateStyle. */
export const UPDATED_AT_TEXT_SQL = `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
