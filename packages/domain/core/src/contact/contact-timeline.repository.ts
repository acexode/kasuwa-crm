import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import { InvalidCursorError } from '../cursor';

/**
 * The contact timeline's rows (T-0061; the T-0059 contract, D-L72, D-L73,
 * D-L81): one row per audit CHANGE of the contact and one per ACTIVITY on
 * the contact, newest first, keyset-paged, with field security applied
 * BEFORE the page is cut.
 *
 * WHERE ITEMS COME FROM
 *   - Every `audit_event` with `object_type = 'contact'` and `object_id` the
 *     contact (`created` and `updated`), expanded to one row per entry in its
 *     `changes`. Only entries whose `field` the caller may see are kept: the
 *     caller passes that allow-list (`visibleChangeFields`), so a withheld
 *     field's rows never reach the LIMIT and a page is never short because of
 *     them (a short page with a cursor says "hidden items follow").
 *   - Every `activity` whose `contact_id` is the contact, when the caller may
 *     see activities' contact link at all (`includeActivities`). An
 *     activity's own audit events are never rows here.
 *
 * ITEM IDS are `ti_` + md5 of the event id and the field name (or of the
 * activity id), so an id depends on its own event and field and on nothing
 * else: adding, removing or withholding other changes never moves it, and a
 * positional id ("change #1 of event E") would have told a caller who sees #1
 * that a hidden #0 exists. md5 here is an identifier, not a secret.
 *
 * ORDER is `occurredAt` descending, then the item id descending in code-unit
 * order (`COLLATE "C"`, whatever the database's default collation). The sort
 * key is the timestamp TRUNCATED TO THE MILLISECOND, exactly what the wire
 * shows, so two items the wire shows at the same instant are always ordered by
 * id, and the keyset `(ms, id)` is total: a page edge inside one event, or
 * among events microseconds apart, neither drops nor repeats a row.
 *
 * An activity's time is its `created_at` (D-L77); completing it changes the
 * row, never its place.
 *
 * Actors are read at READ time from "user" (D-L81): a rename shows on every
 * past item, a disabled user is still named, and `null` is the system only.
 *
 * tenancy-reviewed: every table filtered on the session tenant and on the
 * contact's programme, which the caller checked is in the session's scope;
 * RLS on audit_event, activity and "user" besides. The contact id is bound;
 * the field list is bound as an array; no identifier comes from input.
 */

export interface TimelineActorRow {
  id: string;
  displayName: string;
}

interface TimelineBase {
  itemId: string;
  /** ISO 8601, UTC, millisecond precision, with a Z: the wire's `occurredAt`. */
  occurredAt: string;
  actor: TimelineActorRow | null;
}

export interface TimelineChangeRow extends TimelineBase {
  kind: 'change';
  /** The Contact wire name the audit change carries. */
  field: string;
  /** False only when the event recorded values (T-0061 onward). */
  redacted: boolean;
  before: string | null;
  after: string | null;
}

export interface TimelineActivityRow extends TimelineBase {
  kind: 'activity';
  activityId: string;
  activityType: string;
  subject: string | null;
  body: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
}

export type TimelineRow = TimelineChangeRow | TimelineActivityRow;

export interface TimelinePageRows {
  rows: TimelineRow[];
  nextCursor: string | null;
}

export interface ListContactTimelineOptions {
  contactId: string;
  /** The contact's programme; must be in the session's scope. */
  programmeId: string;
  limit: number;
  cursor?: string | undefined;
  /** Audit change `field` values the caller may see. Anything else is omitted. */
  visibleChangeFields: readonly string[];
  /** Whether activity rows are included at all. */
  includeActivities: boolean;
}

// --- cursor ------------------------------------------------------------------

/**
 * A position, never a scope (see cursor.ts): the last item's millisecond and
 * id. It also names the contact it was issued for, so a cursor replayed on
 * another contact is refused (400 invalid_cursor) instead of quietly moving a
 * window over a different list. The contact id is checked against the path,
 * which the caller already resolved within scope; it grants nothing.
 */
const TIMELINE_ITEM_ID = /^ti_[0-9a-f]{32}$/;
const MS_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A cursor timestamp Postgres will accept back as `timestamptz`, exactly as
 * this module rendered it. `Date.parse` alone is not enough: V8 rolls an
 * impossible date forward (`2026-02-30` becomes 2 March) and accepts year
 * 0000, which Postgres refuses with 22008, a 500. So the value must round-trip
 * through `Date` unchanged, and its year must be 1970..9999.
 */
export function isTimelineCursorTimestamp(value: string): boolean {
  if (!MS_TIMESTAMP.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1970 || year > 9999) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const TimelineCursorPayload = z
  .object({
    k: z.string().uuid(),
    t: z.string().refine(isTimelineCursorTimestamp),
    i: z.string().regex(TIMELINE_ITEM_ID),
  })
  .strict();

export interface TimelineCursor {
  contactId: string;
  occurredAt: string;
  itemId: string;
}

export function encodeTimelineCursor(position: TimelineCursor): string {
  const parsed = TimelineCursorPayload.safeParse({
    k: position.contactId,
    t: position.occurredAt,
    i: position.itemId,
  });
  if (!parsed.success) throw new InvalidCursorError();
  return Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
}

/** Throws InvalidCursorError for garbage, or for a cursor issued for another contact. */
export function decodeTimelineCursor(cursor: string, contactId: string): TimelineCursor {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = TimelineCursorPayload.safeParse(parsedJson);
  if (!parsed.success || parsed.data.k.toLowerCase() !== contactId.toLowerCase()) {
    throw new InvalidCursorError();
  }
  return { contactId: parsed.data.k, occurredAt: parsed.data.t, itemId: parsed.data.i };
}

// --- query -------------------------------------------------------------------

const RawRow = z.object({
  item_id: z.string().regex(TIMELINE_ITEM_ID),
  occurred_at: z.string().regex(MS_TIMESTAMP),
  kind: z.enum(['change', 'activity']),
  field: z.string().nullable(),
  redacted: z.boolean().nullable(),
  before_value: z.string().nullable(),
  after_value: z.string().nullable(),
  actor_id: z.string().uuid().nullable(),
  actor_name: z.string().nullable(),
  activity_id: z.string().uuid().nullable(),
  activity_type: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  due_at: z.date().nullable(),
  completed_at: z.date().nullable(),
});
type RawRow = z.infer<typeof RawRow>;

/**
 * An actor names a user whose name could not be read. 0008's actor FK and
 * 0027's creator FK make this impossible ("anonymised, never hard-deleted");
 * failing beats rendering a person's change as the system's (`null`), which
 * would falsify the trail. Carries no identifier.
 */
export class TimelineActorUnresolvedError extends Error {
  constructor() {
    super('A timeline actor could not be resolved to a user');
    this.name = 'TimelineActorUnresolvedError';
  }
}

/** Thrown for a programme outside the session. The API answers 404 before this. */
export class TimelineProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to read a timeline in a programme outside the session scope');
    this.name = 'TimelineProgrammeOutOfScopeError';
  }
}

/** The wire's `occurredAt`: UTC, milliseconds, a Z. Shared by every branch and the cursor. */
const MS_TEXT = (column: string) =>
  `to_char(date_trunc('milliseconds', ${column}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const TIMELINE_SQL = (withCursor: boolean) => `
  WITH items AS (
    SELECT 'ti_' || md5('change:' || e.id::text || ':' || (c.entry ->> 'field')) AS item_id,
           date_trunc('milliseconds', e.occurred_at) AS sort_at,
           ${MS_TEXT('e.occurred_at')} AS occurred_at,
           'change'::text AS kind,
           c.entry ->> 'field' AS field,
           (c.entry -> 'redacted') IS DISTINCT FROM 'false'::jsonb AS redacted,
           CASE WHEN jsonb_typeof(c.entry -> 'before') = 'string'
                THEN c.entry ->> 'before' END AS before_value,
           CASE WHEN jsonb_typeof(c.entry -> 'after') = 'string'
                THEN c.entry ->> 'after' END AS after_value,
           e.actor_user_id AS actor_id,
           NULL::uuid AS activity_id,
           NULL::text AS activity_type,
           NULL::text AS subject,
           NULL::text AS body,
           NULL::timestamptz AS due_at,
           NULL::timestamptz AS completed_at
      FROM audit_event e
     CROSS JOIN LATERAL jsonb_array_elements(e.changes) AS c(entry)
     WHERE e.tenant_id = $1
       AND e.programme_id = $2
       AND e.programme_id = ANY($3::uuid[])
       AND e.object_type = 'contact'
       AND e.object_id = $4
       AND e.action IN ('created', 'updated')
       AND jsonb_typeof(c.entry) = 'object'
       AND c.entry ->> 'field' = ANY($5::text[])
    UNION ALL
    SELECT 'ti_' || md5('activity:' || a.id::text),
           date_trunc('milliseconds', a.created_at),
           ${MS_TEXT('a.created_at')},
           'activity'::text,
           NULL, NULL, NULL, NULL,
           a.created_by_user_id,
           a.id, a.type, a.subject, a.body, a.due_at, a.completed_at
      FROM activity a
     WHERE $6::boolean
       AND a.tenant_id = $1
       AND a.programme_id = $2
       AND a.programme_id = ANY($3::uuid[])
       AND a.contact_id = $4
  )
  SELECT item_id, occurred_at, kind, field, redacted, before_value, after_value,
         actor_id,
         (SELECT u.display_name
            FROM "user" u
           WHERE u.tenant_id = $1
             AND u.id = items.actor_id) AS actor_name,
         activity_id, activity_type, subject, body, due_at, completed_at
    FROM items
   ${
     withCursor
       ? `WHERE sort_at < $8::timestamptz
             OR (sort_at = $8::timestamptz AND item_id COLLATE "C" < $9::text COLLATE "C")`
       : ''
   }
   ORDER BY sort_at DESC, item_id COLLATE "C" DESC
   LIMIT $7`;

function toRow(raw: RawRow): TimelineRow {
  let actor: TimelineActorRow | null = null;
  if (raw.actor_id !== null) {
    if (raw.actor_name === null) throw new TimelineActorUnresolvedError();
    actor = { id: raw.actor_id, displayName: raw.actor_name };
  }
  if (raw.kind === 'activity') {
    if (raw.activity_id === null || raw.activity_type === null) {
      throw new Error('timeline activity row without its activity');
    }
    return {
      kind: 'activity',
      itemId: raw.item_id,
      occurredAt: raw.occurred_at,
      actor,
      activityId: raw.activity_id,
      activityType: raw.activity_type,
      subject: raw.subject,
      body: raw.body,
      dueAt: raw.due_at,
      completedAt: raw.completed_at,
    };
  }
  if (raw.field === null) throw new Error('timeline change row without its field');
  return {
    kind: 'change',
    itemId: raw.item_id,
    occurredAt: raw.occurred_at,
    actor,
    field: raw.field,
    redacted: raw.redacted ?? true,
    before: raw.before_value,
    after: raw.after_value,
  };
}

/**
 * One page of a contact's timeline rows. The caller has already found the
 * contact within the session's scope (404 otherwise) and decided field
 * security; this applies it before the LIMIT. Fetches one extra row to know
 * whether a next page exists, without a count.
 */
export async function listContactTimeline(
  tx: TenantTx,
  options: ListContactTimelineOptions,
): Promise<TimelinePageRows> {
  if (!tx.session.programmeIds.includes(options.programmeId)) {
    throw new TimelineProgrammeOutOfScopeError();
  }
  const position =
    options.cursor === undefined
      ? undefined
      : decodeTimelineCursor(options.cursor, options.contactId);
  const values: unknown[] = [
    tx.session.tenantId,
    options.programmeId,
    [...tx.session.programmeIds],
    options.contactId,
    [...options.visibleChangeFields],
    options.includeActivities,
    options.limit + 1,
  ];
  if (position !== undefined) values.push(position.occurredAt, position.itemId);

  const raws = await tx.query(TIMELINE_SQL(position !== undefined), values);
  const rows = raws.map((raw) => {
    // A row this statement produced that does not fit is the server's bug:
    // a plain Error (a scrubbed 500), never the ZodError the error filter
    // would turn into a 400 naming internal columns.
    const parsed = RawRow.safeParse(raw);
    if (!parsed.success) throw new Error('timeline row does not match the expected shape');
    return toRow(parsed.data);
  });
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor:
      hasMore && last !== undefined
        ? encodeTimelineCursor({
            contactId: options.contactId,
            occurredAt: last.occurredAt,
            itemId: last.itemId,
          })
        : null,
  };
}
