import type { TenantTx } from '@kasuwa/db';
import { decodeKeysetCursor, encodeKeysetCursor } from '../cursor';
import {
  NEXT_UPDATED_AT_SQL,
  UPDATED_AT_TEXT_SQL,
  versionFromUpdatedAt,
} from './programme-version';

/**
 * Programme reads and the one programme write T-0024 builds.
 *
 * Same discipline as the contact repository: every WHERE repeats the tenant
 * predicate AND `id = ANY(session.programmeIds)`, though the `programme`
 * policy enforces both. The programme ids come from `tx.session`, which came
 * from `user_programme` — never from an argument. No function here accepts a
 * scope, only an identifier, and an identifier outside the session is `null`.
 */

/** The published `ProgrammeStatus` values; `programme_status_check` admits exactly these (0012). */
export const PROGRAMME_STATUSES = ['active', 'paused', 'draft', 'archived'] as const;
export type ProgrammeStatus = (typeof PROGRAMME_STATUSES)[number];

/** The column held a value outside the CHECK — impossible unless the schema drifted. */
export class UnknownProgrammeStatusError extends Error {
  constructor() {
    super('programme.status holds a value outside ProgrammeStatus');
    this.name = 'UnknownProgrammeStatusError';
  }
}

export function toProgrammeStatus(value: string): ProgrammeStatus {
  const status = PROGRAMME_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new UnknownProgrammeStatusError();
  }
  return status;
}

export interface Programme {
  id: string;
  businessUnitId: string;
  name: string;
  clientName: string | null;
  isDefault: boolean;
  /** The lifecycle column (0012). A new programme starts `active` (D-L46). */
  status: ProgrammeStatus;
  /** Derived from `updated_at` — see programme-version.ts. */
  version: number;
}

export interface ProgrammeMember {
  userId: string;
  displayName: string;
  skills: string[];
}

export interface KeysetPage<T> {
  data: T[];
  nextCursor: string | null;
}

export interface ListProgrammesOptions {
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface ProgrammeFilter {
  q?: string | undefined;
  /** Narrows to one status. Absent means every status, archived included (D-L46). */
  status?: ProgrammeStatus | undefined;
}

/** Somebody saved since the caller's read. */
export class StaleProgrammeVersionError extends Error {
  constructor() {
    super('Programme version is not current');
    this.name = 'StaleProgrammeVersionError';
  }
}

/**
 * Tenant-scoped uniqueness of `programme.name`. Carries no identifier and no
 * database text on purpose: the conflicting row may be one the caller cannot
 * read.
 */
export class DuplicateProgrammeNameError extends Error {
  constructor() {
    super('Programme name already in use in this tenant');
    this.name = 'DuplicateProgrammeNameError';
  }
}

interface ProgrammeRow {
  id: string;
  business_unit_id: string;
  name: string;
  client_name: string | null;
  is_default: boolean;
  status: string;
  updated_at_text: string;
  created_at_cursor: string;
}

const SELECT_PROGRAMME = `
  id, business_unit_id, name, client_name, is_default, status,
  ${UPDATED_AT_TEXT_SQL} AS updated_at_text,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
`;

/** Case-insensitive substring; `strpos` rather than LIKE so `%` and `_` are literal. */
const MATCHES_Q = `($3::text IS NULL
   OR strpos(lower(name), lower($3::text)) > 0
   OR strpos(lower(coalesce(client_name, '')), lower($3::text)) > 0)`;

function toProgramme(row: ProgrammeRow): Programme {
  return {
    id: row.id,
    businessUnitId: row.business_unit_id,
    name: row.name,
    clientName: row.client_name,
    isDefault: row.is_default,
    status: toProgrammeStatus(row.status),
    version: versionFromUpdatedAt(row.updated_at_text),
  };
}

function pageOf<R extends { created_at_cursor: string }, T>(
  rows: R[],
  limit: number,
  idOf: (row: R) => string,
  map: (row: R) => T,
): KeysetPage<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    data: page.map(map),
    nextCursor:
      hasMore && last !== undefined
        ? encodeKeysetCursor({ createdAt: last.created_at_cursor, id: idOf(last) })
        : null,
  };
}

/** The caller's reachable programmes, oldest first. Throws InvalidCursorError. */
export async function listProgrammes(
  tx: TenantTx,
  options: ListProgrammesOptions & Pick<ProgrammeFilter, 'status'>,
): Promise<KeysetPage<Programme>> {
  const position = options.cursor === undefined ? null : decodeKeysetCursor(options.cursor);
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<ProgrammeRow>(
    `SELECT ${SELECT_PROGRAMME}
       FROM programme
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND ${MATCHES_Q}
        AND ($4::timestamptz IS NULL OR (created_at, id) > ($4::timestamptz, $5::uuid))
        AND ($7::text IS NULL OR status = $7::text)
      ORDER BY created_at ASC, id ASC
      LIMIT $6`,
    [
      tx.session.tenantId,
      tx.session.programmeIds,
      options.q ?? null,
      position?.createdAt ?? null,
      position?.id ?? null,
      options.limit + 1,
      options.status ?? null,
    ],
  );
  return pageOf(rows, options.limit, (row) => row.id, toProgramme);
}

/** How many reachable programmes match `q` (and `status`, if given), ignoring the cursor. */
export async function countProgrammes(
  tx: TenantTx,
  q: string | undefined,
  status?: ProgrammeStatus,
): Promise<number> {
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM programme
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND ${MATCHES_Q}
        AND ($4::text IS NULL OR status = $4::text)`,
    [tx.session.tenantId, tx.session.programmeIds, q ?? null, status ?? null],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Reachable programmes matching `q`, counted per status — the list's filter
 * chips. Every status is present, zero when nothing matches it.
 */
export async function countProgrammesByStatus(
  tx: TenantTx,
  q: string | undefined,
): Promise<Record<ProgrammeStatus, number>> {
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n
       FROM programme
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND ${MATCHES_Q}
      GROUP BY status`,
    [tx.session.tenantId, tx.session.programmeIds, q ?? null],
  );
  const counts: Record<ProgrammeStatus, number> = { active: 0, paused: 0, draft: 0, archived: 0 };
  for (const row of rows) {
    counts[toProgrammeStatus(row.status)] = row.n;
  }
  return counts;
}

export async function findProgrammeById(tx: TenantTx, id: string): Promise<Programme | null> {
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<ProgrammeRow>(
    `SELECT ${SELECT_PROGRAMME}
       FROM programme
      WHERE id = $1
        AND tenant_id = $2
        AND id = ANY($3::uuid[])`,
    [id, tx.session.tenantId, tx.session.programmeIds],
  );
  const row = rows[0];
  return row === undefined ? null : toProgramme(row);
}

export interface ProgrammeChanges {
  name?: string | undefined;
  /** `null` clears it; absent leaves it alone. */
  clientName?: string | null | undefined;
}

/**
 * Applies `changes` if `expectedVersion` is current.
 *
 * `null` when the programme is not reachable — checked BEFORE the version, so
 * an unreachable id never reaches the 409 path and a correct guess of a
 * foreign version tells the caller nothing. The row is locked by the read, so
 * the check and the write are one decision inside the request transaction: a
 * concurrent writer waits, then sees the version this write produced.
 */
export async function updateProgramme(
  tx: TenantTx,
  id: string,
  expectedVersion: number,
  changes: ProgrammeChanges,
): Promise<Programme | null> {
  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const current = await tx.query<ProgrammeRow>(
    `SELECT ${SELECT_PROGRAMME}
       FROM programme
      WHERE id = $1
        AND tenant_id = $2
        AND id = ANY($3::uuid[])
        FOR UPDATE`,
    [id, tx.session.tenantId, tx.session.programmeIds],
  );
  const row = current[0];
  if (row === undefined) {
    return null;
  }
  if (versionFromUpdatedAt(row.updated_at_text) !== expectedVersion) {
    throw new StaleProgrammeVersionError();
  }

  const setName = changes.name !== undefined;
  const setClientName = changes.clientName !== undefined;
  try {
    // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
    const updated = await tx.query<ProgrammeRow>(
      `UPDATE programme
          SET name        = CASE WHEN $4::boolean THEN $5::text ELSE name END,
              client_name = CASE WHEN $6::boolean THEN $7::text ELSE client_name END,
              updated_at  = ${NEXT_UPDATED_AT_SQL}
        WHERE id = $1
          AND tenant_id = $2
          AND id = ANY($3::uuid[])
        RETURNING ${SELECT_PROGRAMME}`,
      [
        id,
        tx.session.tenantId,
        tx.session.programmeIds,
        setName,
        changes.name ?? null,
        setClientName,
        changes.clientName ?? null,
      ],
    );
    const written = updated[0];
    return written === undefined ? null : toProgramme(written);
  } catch (error) {
    if (isUniqueViolation(error, 'programme_tenant_id_name_key')) {
      throw new DuplicateProgrammeNameError();
    }
    throw error;
  }
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

interface MemberRow {
  user_id: string;
  display_name: string;
  skills: string[];
  created_at_cursor: string;
}

/**
 * The `user_programme` rows of one reachable programme, joined to the user's
 * display name and nothing else — no email, no phone.
 *
 * `null` when the programme is not reachable. Checked against the session
 * first: `user_programme` and `user` are tenant-scoped only, so RLS alone
 * would happily list the members of a sibling programme in the same tenant.
 */
export async function listProgrammeMembers(
  tx: TenantTx,
  programmeId: string,
  options: ListProgrammesOptions,
): Promise<KeysetPage<ProgrammeMember> | null> {
  if (
    !tx.session.programmeIds.includes(programmeId) ||
    (await findProgrammeById(tx, programmeId)) === null
  ) {
    return null;
  }
  // Decoded only once the programme is known to be reachable, so a bad cursor
  // on an unreachable id is still the one 404, never a 400 that answers first.
  const position = options.cursor === undefined ? null : decodeKeysetCursor(options.cursor);

  // tenancy-reviewed: tenant_id + session programme ids, as well as RLS.
  const rows = await tx.query<MemberRow>(
    `SELECT up.user_id, u.display_name, up.skills,
            to_char(up.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              AS created_at_cursor
       FROM user_programme up
       JOIN "user" u ON u.id = up.user_id AND u.tenant_id = up.tenant_id
      WHERE up.tenant_id = $1
        AND u.tenant_id = $1
        AND up.programme_id = $2
        AND up.programme_id = ANY($3::uuid[])
        AND ($4::text IS NULL
             OR strpos(lower(u.display_name), lower($4::text)) > 0
             OR EXISTS (SELECT 1 FROM unnest(up.skills) AS skill
                         WHERE strpos(lower(skill), lower($4::text)) > 0))
        AND ($5::timestamptz IS NULL OR (up.created_at, up.user_id) > ($5::timestamptz, $6::uuid))
      ORDER BY up.created_at ASC, up.user_id ASC
      LIMIT $7`,
    [
      tx.session.tenantId,
      programmeId,
      tx.session.programmeIds,
      options.q ?? null,
      position?.createdAt ?? null,
      position?.id ?? null,
      options.limit + 1,
    ],
  );
  return pageOf(
    rows,
    options.limit,
    (row) => row.user_id,
    (row) => ({ userId: row.user_id, displayName: row.display_name, skills: row.skills }),
  );
}
