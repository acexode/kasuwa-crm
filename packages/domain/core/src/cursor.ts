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
 * Written out rather than taken from `z.iso.datetime()` because that
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
  i: z.uuid(),
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
 * LIST CURSORS (T-0084; D-L80, D-P33, D-L112). Read before extending this.
 *
 * The contacts, leads and accounts lists can be ordered by a name or a
 * timestamp. Until T-0084 their cursors carried the last row's sort VALUE (a
 * name, or a microsecond timestamp) beside its id. A name in a query string
 * is a person's name in every ingress, CDN and browser-history log (D-L80),
 * and a timestamp dates the row; neither belongs in a URL.
 *
 * A list cursor now carries exactly three things:
 *   - `i`, the last row's id;
 *   - `s`, the sort it was issued for (a member of the list's sort enum), so a
 *     cursor replayed under another sort is still refused (400
 *     `invalid_cursor`), as the accounts and leads contracts require;
 *   - `v`, the format version, a small integer.
 * Never a value. The repository resolves the position from the id, INSIDE the
 * caller's scope, in the same statement as the page:
 *   `(key, id) > (SELECT key, id FROM t WHERE id = $cursor AND <scope>)`.
 * A cursor naming a row the caller cannot reach (another programme, another
 * tenant) therefore resolves to nothing, exactly as an invented id does: the
 * page is empty. A different answer for "exists, but not yours" would be a
 * programme-level existence oracle (list-indexes.acceptance.test.ts, I5).
 *
 * The rules above still hold: a position, never a scope. Do not add a tenant,
 * a programme or a sort value here.
 *
 * LEGACY. The pre-T-0041 `{ c, i }` shape (the contacts list's default
 * `-createdAt` order) still decodes under that sort, BY ITS ID ALONE: `c` is
 * validated as a timestamp, as before, so garbage is still 400, and is then
 * dropped. Its value is never trusted. The T-0041 `{ s, v: <text>, i }` shape
 * is not accepted: no deployed cell ever issued one.
 */

/** The list cursor's format version. A small integer, never a value. */
export const LIST_CURSOR_VERSION = 1;

/**
 * The longest cursor the HTTP boundary accepts. An id-only cursor is under 100
 * characters; the limit keeps its T-0041 value so that the boundary schemas,
 * and the record timelines that share it, do not change.
 */
export const MAX_CURSOR_LENGTH = 2048;

const ListCursorPayload = z.strictObject({
  v: z.literal(LIST_CURSOR_VERSION),
  s: z.string().min(1).max(32),
  i: z.uuid(),
});

export interface ListCursor {
  /** The sort the position belongs to, e.g. `displayName`. */
  sort: string;
  /** The last row's id. The position is resolved from it, in scope. */
  id: string;
}

export function encodeListCursor(position: ListCursor): string {
  const parsed = ListCursorPayload.safeParse({
    v: LIST_CURSOR_VERSION,
    s: position.sort,
    i: position.id,
  });
  if (!parsed.success) throw new InvalidCursorError();
  return Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
}

/** The alphabet an issued cursor uses: base64url, unpadded. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface DecodeListCursorOptions {
  /**
   * The sort under which a legacy `{ c, i }` cursor is accepted (the contacts
   * list's default, `-createdAt`). Absent: no legacy shape is accepted.
   */
  legacyKeysetSort?: string | undefined;
}

/**
 * The row id a cursor names, for this sort. Throws InvalidCursorError for
 * garbage, an unknown version, or a cursor issued for another sort. The id
 * is not checked for existence or scope here: the repository resolves it
 * inside the caller's scope.
 */
export function decodeListCursor(
  cursor: string,
  sort: string,
  options: DecodeListCursorOptions = {},
): string {
  // base64url only, as issued. Node's decoder would otherwise accept `+`, `/`,
  // `=` padding and whitespace, so many spellings would name one cursor.
  if (!BASE64URL.test(cursor)) throw new InvalidCursorError();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = ListCursorPayload.safeParse(parsedJson);
  if (parsed.success) {
    if (parsed.data.s !== sort) throw new InvalidCursorError();
    return parsed.data.i;
  }
  if (
    options.legacyKeysetSort !== undefined &&
    options.legacyKeysetSort === sort &&
    !namesListCursorKey(parsedJson)
  ) {
    // By its id alone: `c` is validated (garbage stays 400), then dropped.
    // A payload carrying `v` or `s` is a list cursor (of another sort, or an
    // unknown version) and never falls through to the legacy shape, which
    // would otherwise strip those keys and accept it.
    const legacy = CursorPayload.safeParse(parsedJson);
    if (legacy.success) return legacy.data.i;
  }
  throw new InvalidCursorError();
}

function namesListCursorKey(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (Object.hasOwn(payload, 'v') || Object.hasOwn(payload, 's'))
  );
}

/*
 * ID CURSORS (T-0107; D-L80, the board's and the pipeline list's R7).
 *
 * The pipeline list and each board column have ONE order, so there is no sort
 * to carry: an id cursor is `{ v, i }`, the format version and the last row's
 * id, base64url. Nothing else, never a name, a time, an amount or a stage id.
 * The repository resolves the position from the id inside the caller's scope;
 * unlike the record lists (D-L116), these contracts refuse a cursor that
 * names no reachable row with `400 invalid_cursor`, and that decision belongs
 * to the caller, not to this decoder.
 */

/** The longest pipeline or board cursor the boundary accepts (the contract's maxLength). */
export const MAX_ID_CURSOR_LENGTH = 512;

const IdCursorPayload = z.strictObject({
  v: z.literal(LIST_CURSOR_VERSION),
  i: z.uuid(),
});

export function encodeIdCursor(id: string): string {
  const parsed = IdCursorPayload.safeParse({ v: LIST_CURSOR_VERSION, i: id });
  if (!parsed.success) throw new InvalidCursorError();
  return Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
}

/** The id an id cursor names, lower-cased. Throws InvalidCursorError for anything else. */
export function decodeIdCursor(cursor: string): string {
  if (cursor.length > MAX_ID_CURSOR_LENGTH || !BASE64URL.test(cursor)) {
    throw new InvalidCursorError();
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = IdCursorPayload.safeParse(parsedJson);
  if (!parsed.success) throw new InvalidCursorError();
  return parsed.data.i.toLowerCase();
}
