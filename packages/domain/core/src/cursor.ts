import { z } from 'zod';

/**
 * Opaque keyset cursors.
 *
 * SECURITY NOTE — read before extending this.
 *
 * A cursor encodes a *position*, never a *scope*. It carries `createdAt` and
 * `id` and nothing else: no tenant id, no programme id, no user id. That is
 * deliberate. The moment a cursor carries scope, a cursor becomes a thing a
 * caller can edit to ask for someone else's rows, and the only defence left is
 * a signature nobody remembers to verify.
 *
 * Scope comes from the session, which comes from the database, which comes from
 * the authenticated user. The worst a tampered cursor can do is move the window
 * within data the caller may already read — which is exactly what
 * `tests/acceptance/tenancy/cursor-tampering.acceptance.test.ts` asserts.
 *
 * Do not add tenantId/programmeId here. If you need signed cursors later, sign
 * the position; do not embed authority.
 *
 * PRECISION NOTE — T-0019, found as FINDING-2 in team/reports/T-0004.md.
 *
 * `created_at` is `timestamptz`, which Postgres stores to the microsecond. A
 * JavaScript `Date` only holds milliseconds, so a position that passes through
 * a `Date` names an instant EARLIER than the row it came from, and under
 * `ORDER BY created_at DESC` every row in between is skipped silently and for
 * ever. Six rows paged one at a time returned four.
 *
 * The fix is to keep the timestamp as a *string* end to end: Postgres renders
 * it with `to_char(... 'US')`, it travels in the cursor verbatim, and it goes
 * back into the query as a bound `timestamptz` parameter. No JS type in that
 * path can truncate it. That is what `encodeKeysetCursor` / `decodeKeysetCursor`
 * are for, and repositories must use those.
 *
 * There is no `Date`-valued pair, deliberately — see the note further down.
 */

export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidCursorError';
  }
}

/**
 * ISO-8601 with an explicit offset and 0–6 fractional digits.
 *
 * Written out rather than taken from `z.string().datetime()` because that
 * helper's `precision` option pins the fractional part to an exact length: we
 * need "up to microseconds", so that cursors issued before T-0019 (three
 * digits) still decode. The `refine` rejects the strings the shape allows but
 * the calendar does not, such as month 13.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

const CursorPayload = z.object({
  /**
   * Timestamp of the last row on the previous page, to microsecond precision.
   * A string, not a number: it is what Postgres rendered and what Postgres will
   * parse back, and nothing in between is allowed to reinterpret it.
   */
  c: z
    .string()
    .regex(ISO_TIMESTAMP)
    .refine((value) => !Number.isNaN(Date.parse(value))),
  /** Row id of the last row on the previous page; breaks ties on `c`. */
  i: z.string().uuid(),
});

/** A position whose timestamp has not been through a `Date`. */
export interface KeysetCursor {
  /** ISO-8601, offset-bearing, up to microsecond precision. Verbatim. */
  createdAt: string;
  id: string;
}

function encode(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), 'utf8').toString('base64url');
}

function decode(cursor: string): { c: string; i: string } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = CursorPayload.safeParse(parsedJson);
  if (!parsed.success) {
    throw new InvalidCursorError();
  }
  return { c: parsed.data.c, i: parsed.data.i };
}

/** Precision-preserving encode. Repositories use this one. */
export function encodeKeysetCursor(position: KeysetCursor): string {
  const parsed = CursorPayload.safeParse({ c: position.createdAt, i: position.id });
  if (!parsed.success) {
    // The timestamp came out of the database a moment ago; a failure here means
    // the query stopped rendering it the way this module expects, and emitting
    // a cursor that silently loses precision is the defect this exists to stop.
    throw new InvalidCursorError();
  }
  return encode(parsed.data.c, parsed.data.i);
}

/** Precision-preserving decode. Repositories use this one. */
export function decodeKeysetCursor(cursor: string): KeysetCursor {
  const { c, i } = decode(cursor);
  return { createdAt: c, id: i };
}

/*
 * THERE IS NO Date-VALUED CURSOR API, AND THAT IS DELIBERATE.
 *
 * A lossy `encodeCursor` / `decodeCursor` pair lived here until T-0019. It
 * truncated microseconds, which is what made keyset pagination silently drop
 * rows — four of six, in production, on any two rows written in the same
 * millisecond.
 *
 * It was kept at first, documented as lossy. The lead deleted it on review:
 * nothing but its own tests used it, and **an exported function documented as
 * lossy is how a fixed bug comes back**, because the next person reads the
 * name and not the comment. A `Date` cannot represent what this column stores,
 * so there is no correct way to offer one.
 *
 * If you need a Date, convert at the edge where you display it, never where
 * you encode a position.
 */

/*
 * SORTED CURSORS (T-0041).
 *
 * A list that can be ordered by something other than `-createdAt` needs a
 * position in THAT order: the sort key's value for the last row, plus its id
 * to break ties. The same rules hold as above - a position, never a scope, and
 * a timestamp that never passes through a `Date`.
 *
 * The sort the cursor was issued for travels in it (`s`), and decoding refuses
 * a cursor issued for a different sort: a `displayName` position replayed
 * under `-updatedAt` would otherwise compare a name against a timestamp. The
 * default `-createdAt` order keeps the original `{ c, i }` shape above, so
 * every cursor issued before T-0041 still decodes.
 */

export type SortedCursorKind = 'timestamp' | 'text';

/**
 * The longest text sort position, in code points. A repository that sorts by
 * text must sort by a key no longer than this (the contacts list sorts by
 * `left(display_name, 200)`), so the cursor never outgrows MAX_CURSOR_LENGTH.
 */
export const MAX_TEXT_SORT_POSITION = 200;

/**
 * The longest cursor this module can issue, for the HTTP boundary's limit.
 * Worst case: a text position of 200 control characters, each JSON-escaped
 * to six bytes (`\u001f`), plus the envelope (`{"s":…,"v":"","i":uuid}`,
 * under 100 bytes), base64url at 4/3. That is 1,734 characters; 2,048 leaves
 * headroom. `sorted-cursor.test.ts` builds the worst case and checks it.
 */
export const MAX_CURSOR_LENGTH = 2048;

const SortedCursorPayload = z
  .object({
    s: z.string().min(1).max(32),
    v: z
      .string()
      .max(MAX_TEXT_SORT_POSITION * 2)
      .refine((value) => [...value].length <= MAX_TEXT_SORT_POSITION),
    i: z.string().uuid(),
  })
  .strict();

export interface SortedCursor {
  /** The sort key the position belongs to, e.g. `displayName`. */
  sort: string;
  /** The last row's sort value: an ISO timestamp verbatim, or text. */
  value: string;
  id: string;
}

function validValue(kind: SortedCursorKind, value: string): boolean {
  if (kind === 'text') return true;
  return ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

export function encodeSortedCursor(position: SortedCursor, kind: SortedCursorKind): string {
  const parsed = SortedCursorPayload.safeParse({
    s: position.sort,
    v: position.value,
    i: position.id,
  });
  if (!parsed.success || !validValue(kind, parsed.data.v)) {
    throw new InvalidCursorError();
  }
  return Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
}

/** Throws InvalidCursorError for garbage, a bad value, or a cursor issued for another sort. */
export function decodeSortedCursor(
  cursor: string,
  sort: string,
  kind: SortedCursorKind,
): SortedCursor {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = SortedCursorPayload.safeParse(parsedJson);
  if (!parsed.success || parsed.data.s !== sort || !validValue(kind, parsed.data.v)) {
    throw new InvalidCursorError();
  }
  return { sort: parsed.data.s, value: parsed.data.v, id: parsed.data.i };
}
