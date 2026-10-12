import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import { InvalidCursorError } from '../cursor';

/**
 * The caller's own tasks and calendar (T-0082, P07; records.openapi.yaml
 * listMyActivities and listCalendar; D-L80, D-L105, D-L107).
 *
 * The contact repository's rules, unchanged (packages/domain/core/CLAUDE.md):
 *   - every function takes a TenantTx; the tenant, the session's programmes
 *     and the OWNER come from `tx.session`, never from the caller. There is
 *     no owner, user or programme parameter here, so nothing a request sends
 *     can choose whose activities are read;
 *   - every WHERE repeats `tenant_id` and the session's programmes even though
 *     RLS (activity_isolation) enforces both: two independent layers;
 *   - no SQL is built from input: fragments are constants, values are bound.
 *
 * FIELD SECURITY BEFORE PAGING (L3). The caller passes the programmes in
 * which the row's time field is READABLE (`dueAt` for a task; `startsAt` and
 * `endsAt` for a meeting). Those are a subset of the session's programmes,
 * computed from the field matrix by the API; a row elsewhere is never read,
 * so it can never reach the LIMIT, a body or a cursor. The other withheld
 * fields are the API's to omit.
 *
 * CURSORS (D-L80). A cursor names the LAST row served and nothing else: no
 * time, subject or name, and no scope (src/cursor.ts). The position is
 * re-read from that row's CURRENT sort key, inside the caller's scope, and
 * only when the row is one this list could show the caller: owned by the
 * session user, in a reached programme, of the list's kind, with a readable
 * sort field. Anything else is `InvalidCursorError`, one answer whatever the
 * reason, so a cursor cannot test whether an id exists. A row completed or
 * moved since still resolves, at its current position. The position never
 * passes through a JavaScript `Date` (src/cursor.ts PRECISION NOTE): it is
 * read and compared in one statement.
 *
 * NOTHING HERE LOGS: subjects and names are personal data in practice.
 */

/** One row of either list, before field security. */
export interface MyActivityRow {
  id: string;
  programmeId: string;
  type: 'task' | 'meeting';
  subject: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  startsAt: Date | null;
  endsAt: Date | null;
  /** The activity's contact link, with the contact's display name. */
  contactId: string | null;
  contactDisplayName: string | null;
  /** The activity's account link, with the account's name. */
  accountId: string | null;
  accountName: string | null;
  version: number;
}

export interface MyActivityPageRows {
  rows: MyActivityRow[];
  /** The id the next page starts after; `null` on the last page. */
  nextCursorId: string | null;
}

// --- cursors ------------------------------------------------------------------

/** Which list a cursor belongs to: a cursor from one is refused by the other. */
export type MyActivityCursorKind = 'tasks' | 'calendar';

const KIND_CODE: Record<MyActivityCursorKind, string> = { tasks: 't', calendar: 'c' };

/** The contract's `ActivityCursor` maxLength. */
export const MAX_ACTIVITY_CURSOR_LENGTH = 512;

const ActivityCursorPayload = z
  .object({
    k: z.enum(['t', 'c']),
    i: z.string().uuid(),
  })
  .strict();

/** An opaque cursor holding a list kind and one id: never a time, a name or a scope. */
export function encodeActivityCursor(kind: MyActivityCursorKind, id: string): string {
  const parsed = ActivityCursorPayload.safeParse({ k: KIND_CODE[kind], i: id.toLowerCase() });
  if (!parsed.success) throw new InvalidCursorError();
  return Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
}

/** The id a cursor names, or `InvalidCursorError`, one error for every malformation. */
export function decodeActivityCursor(kind: MyActivityCursorKind, cursor: string): string {
  if (cursor.length === 0 || cursor.length > MAX_ACTIVITY_CURSOR_LENGTH) {
    throw new InvalidCursorError();
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidCursorError();
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = ActivityCursorPayload.safeParse(json);
  if (!parsed.success || parsed.data.k !== KIND_CODE[kind]) throw new InvalidCursorError();
  return parsed.data.i.toLowerCase();
}

// --- rows ---------------------------------------------------------------------

const RawRow = z.object({
  id: z.string().uuid(),
  programme_id: z.string().uuid(),
  type: z.enum(['task', 'meeting']),
  subject: z.string().nullable(),
  due_at: z.date().nullable(),
  completed_at: z.date().nullable(),
  starts_at: z.date().nullable(),
  ends_at: z.date().nullable(),
  contact_id: z.string().uuid().nullable(),
  contact_display_name: z.string().nullable(),
  account_id: z.string().uuid().nullable(),
  account_name: z.string().nullable(),
  version: z.number().int().min(1),
});

function toRow(raw: unknown): MyActivityRow {
  const row = RawRow.parse(raw);
  return {
    id: row.id,
    programmeId: row.programme_id,
    type: row.type,
    subject: row.subject,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    contactId: row.contact_id,
    contactDisplayName: row.contact_display_name,
    accountId: row.account_id,
    accountName: row.account_name,
    version: row.version,
  };
}

/** The activity columns both lists send, from alias `a`. */
const ACTIVITY_COLUMNS = `
  a.id, a.programme_id, a.type, a.subject, a.due_at, a.completed_at, a.starts_at, a.ends_at,
  a.contact_id, a.account_id, a.version`;

/**
 * The summaries, from `e` (the chosen rows). The composite keys of 0027 keep
 * a target in the activity's own programme, so the joins repeat the tenant
 * and the programme; RLS on contact and account besides.
 */
const SUMMARY_JOINS = `
  LEFT JOIN contact c
         ON c.tenant_id = $1 AND c.programme_id = e.programme_id AND c.id = e.contact_id
  LEFT JOIN account ac
         ON ac.tenant_id = $1 AND ac.programme_id = e.programme_id AND ac.id = e.account_id`;

const SUMMARY_COLUMNS = `
  e.id, e.programme_id, e.type, e.subject, e.due_at, e.completed_at, e.starts_at, e.ends_at,
  e.contact_id, c.display_name AS contact_display_name,
  e.account_id, ac.name AS account_name, e.version`;

function pageOf(raws: readonly unknown[], limit: number): MyActivityPageRows {
  const rows = raws.slice(0, limit).map(toRow);
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursorId: raws.length > limit && last !== undefined ? last.id : null,
  };
}

// --- listMyActivities ---------------------------------------------------------

/**
 * A bucket as a due-time range, `from <= due_at < to`, either end open when
 * `null`, plus whether undated tasks follow (upcoming only). Built by the API
 * from the server's instant and the caller's zone.
 */
export interface DueRange {
  from: Date | null;
  to: Date | null;
  undated: boolean;
}

export interface ListMyOpenTasksOptions {
  range: DueRange;
  /** Session programmes in which `dueAt` is readable (L3). */
  dueReadableProgrammeIds: readonly string[];
  /** The id a previous page ended on, decoded; `null` for the first page. */
  cursorId: string | null;
  limit: number;
}

/**
 * The session user's own OPEN tasks in one bucket: `due_at` ascending, ties
 * by id, undated last (btree ASC is NULLS LAST), then by id. Served by
 * 0034's activity_owner_open_task_due_idx.
 *
 * tenancy-reviewed: tenant, owner and programmes from the session (the
 * readable list is intersected with the session's); RLS besides.
 */
export async function listMyOpenTasks(
  tx: TenantTx,
  options: ListMyOpenTasksOptions,
): Promise<MyActivityPageRows> {
  const { tenantId, userId, programmeIds } = tx.session;
  const values: unknown[] = [tenantId, userId, [...programmeIds], [...options.dueReadableProgrammeIds]];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  // Shared by the cursor's row and the listed rows: what this list may show.
  const shown = (alias: string) => `
        ${alias}.tenant_id = $1
    AND ${alias}.owner_user_id = $2
    AND ${alias}.programme_id = ANY($3::uuid[])
    AND ${alias}.programme_id = ANY($4::uuid[])
    AND ${alias}.type = 'task'`;

  if (options.cursorId !== null) {
    const found = await tx.query<{ ok: number }>(
      `SELECT 1 AS ok FROM activity p WHERE p.id = $5::uuid AND ${shown('p')}`,
      [...values, options.cursorId],
    );
    if (found.length === 0) throw new InvalidCursorError();
  }

  const range: string[] = [];
  if (options.range.from !== null) range.push(`a.due_at >= ${bind(options.range.from)}::timestamptz`);
  if (options.range.to !== null) range.push(`a.due_at < ${bind(options.range.to)}::timestamptz`);
  const dated = range.length > 0 ? range.join(' AND ') : 'a.due_at IS NOT NULL';
  const inRange = options.range.undated ? `((${dated}) OR a.due_at IS NULL)` : `(${dated})`;

  let pos = '';
  let after = '';
  if (options.cursorId !== null) {
    const cursor = bind(options.cursorId);
    pos = `pos AS (
      SELECT p.due_at, p.id FROM activity p WHERE p.id = ${cursor}::uuid AND ${shown('p')}
    ),`;
    after = `AND EXISTS (
      SELECT 1 FROM pos
       WHERE (pos.due_at IS NULL AND a.due_at IS NULL AND a.id > pos.id)
          OR (pos.due_at IS NOT NULL
              AND (a.due_at IS NULL
                   OR a.due_at > pos.due_at
                   OR (a.due_at = pos.due_at AND a.id > pos.id))))`;
  }
  const limit = bind(options.limit + 1);

  const raws = await tx.query<Record<string, unknown>>(
    `WITH ${pos} e AS (
       SELECT ${ACTIVITY_COLUMNS}
         FROM activity a
        WHERE ${shown('a')}
          AND a.completed_at IS NULL
          AND ${inRange}
          ${after}
        ORDER BY a.due_at ASC NULLS LAST, a.id ASC
        LIMIT ${limit}::integer
     )
     SELECT ${SUMMARY_COLUMNS}
       FROM e
       ${SUMMARY_JOINS}
      ORDER BY e.due_at ASC NULLS LAST, e.id ASC`,
    values,
  );
  return pageOf(raws, options.limit);
}

// --- listCalendar -------------------------------------------------------------

export interface ListMyCalendarOptions {
  /** Inclusive, UTC. */
  from: Date;
  /** Exclusive, UTC. */
  to: Date;
  /** Session programmes in which a task's `dueAt` is readable (L3). */
  dueReadableProgrammeIds: readonly string[];
  /** Session programmes in which a meeting's `startsAt` AND `endsAt` are readable (L3). */
  meetingReadableProgrammeIds: readonly string[];
  cursorId: string | null;
  limit: number;
}

/**
 * The session user's own events overlapping `[from, to)`: tasks with
 * `from <= due_at < to`, open or completed, and meetings with
 * `starts_at < to AND ends_at > from`. Ordered by start (`due_at` or
 * `starts_at`), ties by id. One branch per kind (UNION ALL), so each uses its
 * own index: 0027's activity_owner_due_idx and 0034's
 * activity_owner_meeting_starts_idx.
 *
 * tenancy-reviewed: tenant, owner and programmes from the session (both
 * readable lists are intersected with the session's); RLS besides.
 */
export async function listMyCalendar(
  tx: TenantTx,
  options: ListMyCalendarOptions,
): Promise<MyActivityPageRows> {
  const { tenantId, userId, programmeIds } = tx.session;
  const values: unknown[] = [
    tenantId,
    userId,
    [...programmeIds],
    [...options.dueReadableProgrammeIds],
    [...options.meetingReadableProgrammeIds],
  ];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };

  const owned = (alias: string) => `
        ${alias}.tenant_id = $1
    AND ${alias}.owner_user_id = $2
    AND ${alias}.programme_id = ANY($3::uuid[])`;
  const task = (alias: string) =>
    `${alias}.type = 'task' AND ${alias}.programme_id = ANY($4::uuid[])`;
  const meeting = (alias: string) =>
    `${alias}.type = 'meeting' AND ${alias}.programme_id = ANY($5::uuid[])`;
  // A cursor names a row this list could show: a dated task or a meeting.
  const resolvable = `${owned('p')}
    AND ((${task('p')} AND p.due_at IS NOT NULL) OR (${meeting('p')}))`;

  if (options.cursorId !== null) {
    const found = await tx.query<{ ok: number }>(
      `SELECT 1 AS ok FROM activity p WHERE p.id = $6::uuid AND ${resolvable}`,
      [...values, options.cursorId],
    );
    if (found.length === 0) throw new InvalidCursorError();
  }

  const from = bind(options.from);
  const to = bind(options.to);
  let pos = '';
  let taskAfter = '';
  let meetingAfter = '';
  let posJoin = '';
  if (options.cursorId !== null) {
    const cursor = bind(options.cursorId);
    pos = `pos AS (
      SELECT CASE WHEN p.type = 'meeting' THEN p.starts_at ELSE p.due_at END AS start_at, p.id
        FROM activity p
       WHERE p.id = ${cursor}::uuid AND ${resolvable}
    ),`;
    posJoin = 'CROSS JOIN pos';
    taskAfter = 'AND (a.due_at, a.id) > (pos.start_at, pos.id)';
    meetingAfter = 'AND (a.starts_at, a.id) > (pos.start_at, pos.id)';
  }
  const limit = bind(options.limit + 1);

  const raws = await tx.query<Record<string, unknown>>(
    `WITH ${pos} e AS (
       (SELECT ${ACTIVITY_COLUMNS}, a.due_at AS start_at
          FROM activity a ${posJoin}
         WHERE ${owned('a')}
           AND ${task('a')}
           AND a.due_at >= ${from}::timestamptz
           AND a.due_at < ${to}::timestamptz
           ${taskAfter}
         ORDER BY a.due_at, a.id
         LIMIT ${limit}::integer)
       UNION ALL
       (SELECT ${ACTIVITY_COLUMNS}, a.starts_at AS start_at
          FROM activity a ${posJoin}
         WHERE ${owned('a')}
           AND ${meeting('a')}
           AND a.starts_at < ${to}::timestamptz
           AND a.ends_at > ${from}::timestamptz
           ${meetingAfter}
         ORDER BY a.starts_at, a.id
         LIMIT ${limit}::integer)
     )
     SELECT ${SUMMARY_COLUMNS}
       FROM e
       ${SUMMARY_JOINS}
      ORDER BY e.start_at ASC, e.id ASC
      LIMIT ${limit}::integer`,
    values,
  );
  return pageOf(raws, options.limit);
}
