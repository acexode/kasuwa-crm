import { newId, type TenantTx } from '@kasuwa/db';
import { decodeKeysetCursor, encodeKeysetCursor, type KeysetCursor } from '@kasuwa/domain-core';
import { z } from 'zod';
import { notFound } from '../common/admin-errors';
import {
  AUDIT_OBJECT_TYPE_LABELS,
  change,
  recordAuditEvent,
  redactedChange,
  type AuditAction,
  type AuditChange,
} from './audit-writer';
import type { AuditFilters, CreateAuditExportBody, ListAuditEventsQuery } from './audit.schemas';

/**
 * The audit log's read side and its export requests (T-0025).
 *
 * tenancy-reviewed: every statement repeats what the RLS policies on
 * `audit_event` and `audit_export` already enforce — `tenant_id` bound from
 * `tx.session`, `programme_id IS NULL OR programme_id = ANY(session
 * programmes)`, and for exports `requested_by_user_id = session user`. Two
 * independent layers (CLAUDE.md 2.3). Filters only ever add predicates; none
 * of them can reach a row the session cannot.
 *
 * Personal data: an entry is built from the columns `AuditEntry` names and no
 * others. The actor is a display name and a role name, joined at read time;
 * their email is never selected. `sourceIp` and `sourceLocation` are always
 * null — nobody holds a permission to see an address yet (D-L48), and none is
 * stored.
 */

export interface AuditActorView {
  kind: 'user' | 'system';
  id: string | null;
  displayName: string;
  roleName: string | null;
}

export interface AuditEntryView {
  id: string;
  occurredAt: string;
  actor: AuditActorView;
  action: string;
  objectType: string;
  objectLabel: string;
  objectId: string | null;
  programmeId: string | null;
  sourceIp: null;
  sourceLocation: null;
  changes: AuditChange[];
}

export interface AuditEventListView {
  items: AuditEntryView[];
  page: { nextCursor: string | null; hasMore: boolean; totalCount: null };
}

export interface AuditExportView {
  exportId: string;
  status: string;
  format: string;
  estimatedRowCount: null;
  deliveryEmailHint: null;
  linkExpiresAfterHours: null;
  requestedAt: string;
  completedAt: string | null;
}

/** What a system actor is called. A scheduled job is not a person. */
const SYSTEM_ACTOR_NAME = 'System';

/** The visibility rule of D-L48, as the explicit second layer beside RLS. `$1` tenant, `$2` programmes. */
const VISIBLE = `e.tenant_id = $1
   AND (e.programme_id IS NULL OR e.programme_id = ANY($2::uuid[]))`;

const MS_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const US_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

interface EventRow {
  id: string;
  occurred_at: string;
  occurred_at_cursor: string;
  actor_kind: 'user' | 'system';
  actor_user_id: string | null;
  actor_display_name: string | null;
  actor_role_name: string | null;
  action: string;
  object_type: string;
  object_label: string;
  object_id: string | null;
  programme_id: string | null;
  changes: unknown;
}

/** Re-shapes stored changes to exactly the four spec keys; anything else in the column is dropped. */
const StoredChanges = z.array(
  z.object({
    field: z.string(),
    before: z.string().nullable(),
    after: z.string().nullable(),
    redacted: z.boolean(),
  }),
);

function toChanges(stored: unknown): AuditChange[] {
  const parsed = StoredChanges.safeParse(stored);
  if (!parsed.success) return [];
  return parsed.data.map(({ field, before, after, redacted }) =>
    redacted ? redactedChange(field) : change(field, before, after),
  );
}

export function toEntry(row: EventRow): AuditEntryView {
  const system = row.actor_kind === 'system';
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actor: {
      kind: system ? 'system' : 'user',
      id: system ? null : row.actor_user_id,
      displayName: system ? SYSTEM_ACTOR_NAME : (row.actor_display_name ?? ''),
      roleName: row.actor_role_name,
    },
    action: row.action,
    objectType: row.object_type,
    objectLabel: row.object_label,
    objectId: row.object_id,
    programmeId: row.programme_id,
    sourceIp: null,
    sourceLocation: null,
    changes: toChanges(row.changes),
  };
}

const EMPTY_PAGE: AuditEventListView = {
  items: [],
  page: { nextCursor: null, hasMore: false, totalCount: null },
};

/**
 * Newest first, keyset-paginated on (occurred_at, id). The cursor is a
 * position only (see @kasuwa/domain-core cursor.ts): replayed by another
 * tenant it moves a window over that tenant's own rows and nothing else.
 * Throws InvalidCursorError for a cursor the server did not issue.
 */
export async function listAuditEvents(
  tx: TenantTx,
  query: ListAuditEventsQuery,
): Promise<AuditEventListView> {
  const position: KeysetCursor | null =
    query.cursor === undefined ? null : decodeKeysetCursor(query.cursor);

  // No caller may see a source address, so none may filter on one either: a
  // filter that matched on a hidden value would reveal it a prefix at a time.
  // Every prefix is the same empty page until a permission allows addresses.
  if (query.sourceIpPrefix !== undefined) return EMPTY_PAGE;

  const rows = await tx.query<EventRow>(
    `SELECT e.id,
            to_char(e.occurred_at AT TIME ZONE 'UTC', ${MS_UTC}) AS occurred_at,
            to_char(e.occurred_at AT TIME ZONE 'UTC', ${US_UTC}) AS occurred_at_cursor,
            e.actor_kind, e.actor_user_id, u.display_name AS actor_display_name,
            e.actor_role_name, e.action, e.object_type, e.object_label,
            e.object_id, e.programme_id, e.changes
       FROM audit_event e
       LEFT JOIN "user" u ON u.tenant_id = e.tenant_id AND u.id = e.actor_user_id
      WHERE ${VISIBLE}
        AND ($3::uuid IS NULL OR e.actor_user_id = $3::uuid)
        AND ($4::text IS NULL OR e.action = $4::text)
        AND ($5::text IS NULL OR e.object_type = $5::text)
        AND ($6::timestamptz IS NULL OR e.occurred_at >= $6::timestamptz)
        AND ($7::timestamptz IS NULL OR e.occurred_at < $7::timestamptz)
        AND ($8::timestamptz IS NULL OR (e.occurred_at, e.id) < ($8::timestamptz, $9::uuid))
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT $10`,
    [
      tx.session.tenantId,
      tx.session.programmeIds,
      query.actorId ?? null,
      query.action ?? null,
      query.objectType ?? null,
      query.from ?? null,
      query.to ?? null,
      position?.createdAt ?? null,
      position?.id ?? null,
      query.pageSize + 1,
    ],
  );

  const hasMore = rows.length > query.pageSize;
  const page = hasMore ? rows.slice(0, query.pageSize) : rows;
  const last = page.at(-1);
  return {
    items: page.map(toEntry),
    page: {
      nextCursor:
        hasMore && last !== undefined
          ? encodeKeysetCursor({ createdAt: last.occurred_at_cursor, id: last.id })
          : null,
      hasMore,
      // "the audit log does not compute it past the first page" — nor on it.
      totalCount: null,
    },
  };
}

export interface AuditFilterOptionsView {
  actors: { id: string | null; displayName: string; kind: 'user' | 'system' }[];
  actions: AuditAction[];
  objectTypes: { objectType: string; label: string }[];
}

/**
 * Only what appears in the log the caller can read: never a staff directory,
 * and never an actor whose every action is outside the caller's programmes.
 */
export async function getAuditFilterOptions(tx: TenantTx): Promise<AuditFilterOptionsView> {
  const scope = [tx.session.tenantId, tx.session.programmeIds];
  const actors = await tx.query<{
    actor_kind: 'user' | 'system';
    actor_user_id: string | null;
    display_name: string | null;
  }>(
    `SELECT DISTINCT e.actor_kind, e.actor_user_id, u.display_name
       FROM audit_event e
       LEFT JOIN "user" u ON u.tenant_id = e.tenant_id AND u.id = e.actor_user_id
      WHERE ${VISIBLE}
      ORDER BY u.display_name NULLS FIRST, e.actor_user_id`,
    scope,
  );
  const actions = await tx.query<{ action: AuditAction }>(
    `SELECT DISTINCT e.action FROM audit_event e WHERE ${VISIBLE} ORDER BY e.action`,
    scope,
  );
  const types = await tx.query<{ object_type: string }>(
    `SELECT DISTINCT e.object_type FROM audit_event e WHERE ${VISIBLE} ORDER BY e.object_type`,
    scope,
  );

  return {
    actors: actors.map((row) =>
      row.actor_kind === 'system'
        ? { id: null, displayName: SYSTEM_ACTOR_NAME, kind: 'system' as const }
        : { id: row.actor_user_id, displayName: row.display_name ?? '', kind: 'user' as const },
    ),
    actions: actions.map((row) => row.action),
    objectTypes: types.map((row) => ({
      objectType: row.object_type,
      label: labelOf(row.object_type),
    })),
  };
}

function labelOf(objectType: string): string {
  return Object.prototype.hasOwnProperty.call(AUDIT_OBJECT_TYPE_LABELS, objectType)
    ? AUDIT_OBJECT_TYPE_LABELS[objectType as keyof typeof AUDIT_OBJECT_TYPE_LABELS]
    : objectType;
}

interface ExportRow {
  id: string;
  status: string;
  format: string;
  requested_at: string;
  completed_at: string | null;
}

const EXPORT_COLUMNS = `id, status, format,
  to_char(requested_at AT TIME ZONE 'UTC', ${MS_UTC}) AS requested_at,
  to_char(completed_at AT TIME ZONE 'UTC', ${MS_UTC}) AS completed_at`;

function toExport(row: ExportRow): AuditExportView {
  return {
    exportId: row.id,
    status: row.status,
    format: row.format,
    // No worker builds the file yet, so there is no estimate, no delivery and
    // no link lifetime to promise. Null is the honest answer for all three.
    estimatedRowCount: null,
    deliveryEmailHint: null,
    linkExpiresAfterHours: null,
    requestedAt: row.requested_at,
    completedAt: row.completed_at,
  };
}

/**
 * The export's own audit lines. `sourceIpPrefix` is a partial address — it is
 * recorded as having been set, never with its value.
 */
export function exportChanges(body: CreateAuditExportBody): AuditChange[] {
  const changes = [
    change('format', null, body.format),
    change('scope', null, body.scope),
    change('includeIpAddresses', null, String(body.includeIpAddresses)),
  ];
  const filters: AuditFilters = body.filters ?? {};
  for (const key of ['actorId', 'action', 'objectType', 'from', 'to'] as const) {
    const value = filters[key];
    if (value !== undefined) changes.push(change(`filters.${key}`, null, value));
  }
  if (filters.sourceIpPrefix !== undefined) changes.push(redactedChange('filters.sourceIpPrefix'));
  return changes;
}

/**
 * Queues an export and audits the request in the same transaction — "written
 * before the job starts, not after it succeeds". The requester is the session
 * user; the worker that builds the file must re-resolve their scope then.
 */
export async function createAuditExport(
  tx: TenantTx,
  body: CreateAuditExportBody,
): Promise<AuditExportView> {
  const id = newId();
  const rows = await tx.query<ExportRow>(
    `INSERT INTO audit_export
       (id, tenant_id, requested_by_user_id, format, scope, filters, include_ip_addresses)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING ${EXPORT_COLUMNS}`,
    [
      id,
      tx.session.tenantId,
      tx.session.userId,
      body.format,
      body.scope,
      JSON.stringify(body.filters ?? {}),
      body.includeIpAddresses,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('audit_export insert returned no row');

  await recordAuditEvent(tx, {
    action: 'exported',
    objectType: 'audit_export',
    objectId: id,
    objectLabel: AUDIT_OBJECT_TYPE_LABELS.audit_export,
    programmeId: null,
    changes: exportChanges(body),
  });
  return toExport(row);
}

/** The requester's own export. Anyone else's, in any tenant, is the one `404`. */
export async function getAuditExport(tx: TenantTx, exportId: string): Promise<AuditExportView> {
  const rows = await tx.query<ExportRow>(
    `SELECT ${EXPORT_COLUMNS}
       FROM audit_export
      WHERE tenant_id = $1 AND requested_by_user_id = $2 AND id = $3`,
    [tx.session.tenantId, tx.session.userId, exportId],
  );
  const row = rows[0];
  if (row === undefined) throw notFound();
  return toExport(row);
}
