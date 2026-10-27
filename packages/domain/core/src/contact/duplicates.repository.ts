import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import { InvalidCursorError, LIST_CURSOR_VERSION, MAX_CURSOR_LENGTH } from '../cursor';
import { CONTACT_MAX_EMAILS, CONTACT_MAX_PHONES } from './contact-write-schema';

/**
 * Duplicate contact sets (T-0095; D-P12, D-P33, D-L146, D-L151, D-L153).
 *
 * A set is the contacts of ONE programme sharing an exact E.164 phone (any of
 * a contact's numbers) or a lower-cased email, at most the ten most recently
 * updated. Merged-away contacts are never in a set (D-P27). The matched value
 * is used inside the statement to group and never leaves it: the rows that
 * come back are a match kind, contact ids, names and update times.
 *
 * A SCOPED SCAN, NO INDEX (D-P33). Under FORCE RLS neither jsonb unnesting nor
 * `lower()` can be an index condition, so the statement reads the one
 * programme's live rows once, through the programme-led key (so the RLS
 * functions are evaluated once, as an index condition, not per row),
 * unnests each row's numbers and addresses in ONE array (a single pass;
 * a withheld field contributes nothing), and hash-groups them. The kind is
 * read back from the value: an E.164 number never holds an `@`, an address
 * always does (both are validated on every write path). Every page costs one such scan, the first
 * and the deepest alike; the T-0095 suite holds it to 150 ms at 60,000
 * contacts per programme.
 *
 * ORDER AND CURSOR (D-L153's widening of D-L151). Sets are ordered by their
 * lowest contact id, then by match kind, then by an ordinal among the sets
 * sharing both (a pair matching on two numbers is one set; a contact sharing
 * one number with B and another with C is two, with the same lowest id). The
 * cursor carries exactly those three and a format version: an id, the literal
 * `phone` or `email`, and two small integers. Never a matched value.
 */

export type DuplicateMatchOn = 'phone' | 'email';

/** The most contacts a set returns (the contract's maxItems). */
export const DUPLICATE_SET_MAX_CONTACTS = 10;

/** A page position: the last set's lowest id, its match kind and its ordinal. */
export interface DuplicatePosition {
  lowestId: string;
  matchOn: DuplicateMatchOn;
  ordinal: number;
}

/**
 * The largest ordinal a set can have. Every set with lowest id L and kind K is
 * keyed on one of L's own numbers (or addresses), so there are at most as many
 * as L holds: the ordinal (from 0) stays below the cap. A row planted around
 * the write paths with more is not paged past the cap (the statement filters
 * it), rather than minting a cursor this server would refuse.
 */
export const MAX_DUPLICATE_ORDINAL = Math.max(CONTACT_MAX_PHONES, CONTACT_MAX_EMAILS) - 1;
const MAX_ORDINAL = MAX_DUPLICATE_ORDINAL;

const CursorPayload = z.strictObject({
  v: z.literal(LIST_CURSOR_VERSION),
  id: z.uuid(),
  m: z.enum(['phone', 'email']),
  n: z.number().int().min(0).max(MAX_ORDINAL),
});

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function encodeDuplicateCursor(position: DuplicatePosition): string {
  const parsed = CursorPayload.safeParse({
    v: LIST_CURSOR_VERSION,
    id: position.lowestId.toLowerCase(),
    m: position.matchOn,
    n: position.ordinal,
  });
  if (!parsed.success) throw new InvalidCursorError();
  return Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
}

/** Throws InvalidCursorError for anything this server did not issue. */
export function decodeDuplicateCursor(cursor: string): DuplicatePosition {
  if (cursor.length > MAX_CURSOR_LENGTH || !BASE64URL.test(cursor)) throw new InvalidCursorError();
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = CursorPayload.safeParse(json);
  if (!parsed.success) throw new InvalidCursorError();
  return { lowestId: parsed.data.id.toLowerCase(), matchOn: parsed.data.m, ordinal: parsed.data.n };
}

export interface DuplicateContactRow {
  id: string;
  displayName: string;
  updatedAt: Date;
}

export interface DuplicateSetRow extends DuplicatePosition {
  /** Most recently updated first. */
  contacts: DuplicateContactRow[];
}

export interface ListDuplicateSetsOptions {
  /** Match on phones: false when field security withholds `phones` here. */
  phones: boolean;
  /** Match on emails: false when field security withholds `emails` here. */
  emails: boolean;
  after: DuplicatePosition | null;
  /** Rows to return; the caller asks for one more than a page to learn whether another exists. */
  limit: number;
}

/**
 * The duplicate scan's work_mem (D-L162: at most 64 MB, for that one
 * statement). At 60,000 contacts per programme the grouping holds about
 * 120,000 keys, about 18 MB in a hash table; the server default (4 MB)
 * spills it to disk in five batches.
 */
export const DUPLICATE_SCAN_WORK_MEM = '64MB';

/** A programme outside the session's scope: a caller bug, never scanned. */
export class DuplicateScopeError extends Error {
  constructor() {
    super('A duplicate scan named a programme outside the session scope');
    this.name = 'DuplicateScopeError';
  }
}

interface SetDbRow {
  match_on: DuplicateMatchOn;
  low: string;
  ordinal: number;
  ids: string[];
}

/**
 * Up to `limit` sets of `programmeId` after `after`, in the order above.
 *
 * tenancy-reviewed: tenant from the session, the programme both named and
 * required (in JS and in SQL) to be in the session's scope; RLS besides. The
 * second read is keyed on ids the first returned, inside the same scope.
 */
export async function listDuplicateSets(
  tx: TenantTx,
  programmeId: string,
  options: ListDuplicateSetsOptions,
): Promise<DuplicateSetRow[]> {
  if (!tx.session.programmeIds.includes(programmeId)) throw new DuplicateScopeError();
  if (!options.phones && !options.emails) return [];
  // D-L162: work_mem raised for THIS statement only (bounded at 64 MB), so
  // the hash-grouping of every number and address in the programme stays in
  // memory instead of spilling to disk; restored straight after, so the rest
  // of the request transaction runs at the server's setting.
  const [previous] = await tx.query<{ work_mem: string }>(
    `SELECT current_setting('work_mem') AS work_mem, set_config('work_mem', $1, true)`,
    [DUPLICATE_SCAN_WORK_MEM],
  );
  const sets = await tx.query<SetDbRow>(
    `WITH keyed AS MATERIALIZED (
       SELECT lower(v.k) COLLATE "C" AS k, v.id, v.updated_at
         FROM (
           SELECT jsonb_array_elements_text(
                    CASE WHEN $4::boolean AND jsonb_typeof(c.phones) = 'array'
                         THEN jsonb_path_query_array(c.phones, '$[*].e164') ELSE '[]'::jsonb END
                    || CASE WHEN $5::boolean AND jsonb_typeof(c.emails) = 'array'
                            THEN c.emails ELSE '[]'::jsonb END) AS k,
                  c.id, c.updated_at
             FROM contact c
            WHERE c.tenant_id = $1
              AND c.programme_id = $2
              AND c.programme_id = ANY($3::uuid[])
              AND c.deleted_at IS NULL
         ) AS v
     ),
     shared AS (
       SELECT k FROM keyed GROUP BY k HAVING count(*) > 1
     ),
     members AS (
       SELECT d.k, d.id,
              row_number() OVER (PARTITION BY d.k ORDER BY d.updated_at DESC, d.id) AS rn
         FROM (SELECT DISTINCT kd.k, kd.id, kd.updated_at
                 FROM keyed kd JOIN shared USING (k)) AS d
     ),
     sets AS (
       SELECT DISTINCT
              CASE WHEN strpos(k, '@') > 0 THEN 'email' ELSE 'phone' END AS match_on,
              array_agg(id ORDER BY id) AS ids
         FROM members
        WHERE rn <= ${DUPLICATE_SET_MAX_CONTACTS}
        GROUP BY k
       HAVING count(*) > 1
     ),
     ordered AS (
       SELECT match_on, ids, ids[1] AS low,
              (row_number() OVER (PARTITION BY ids[1], match_on ORDER BY ids::text) - 1)::integer
                AS ordinal
         FROM sets
     )
     SELECT match_on, low, ordinal, ids
       FROM ordered
      WHERE ordinal <= ${MAX_ORDINAL}
        AND ($6::uuid IS NULL
             OR (low, match_on COLLATE "C", ordinal) > ($6::uuid, $7::text COLLATE "C", $8::integer))
      ORDER BY low, match_on COLLATE "C", ordinal
      LIMIT $9`,
    [
      tx.session.tenantId,
      programmeId,
      [...tx.session.programmeIds],
      options.phones,
      options.emails,
      options.after?.lowestId ?? null,
      options.after?.matchOn ?? null,
      options.after?.ordinal ?? null,
      options.limit,
    ],
  );
  if (previous !== undefined) {
    await tx.query(`SELECT set_config('work_mem', $1, true)`, [previous.work_mem]);
  }
  if (sets.length === 0) return [];

  const wanted = [...new Set(sets.flatMap((set) => set.ids))];
  const contacts = await tx.query<{ id: string; display_name: string; updated_at: Date }>(
    `SELECT id, display_name, updated_at
       FROM contact
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
        AND deleted_at IS NULL
        AND id = ANY($4::uuid[])`,
    [tx.session.tenantId, programmeId, [...tx.session.programmeIds], wanted],
  );
  const byId = new Map(contacts.map((row) => [row.id, row]));
  return sets.map((set) => ({
    lowestId: set.low,
    matchOn: set.match_on,
    ordinal: set.ordinal,
    contacts: set.ids
      .flatMap((id) => {
        const row = byId.get(id);
        return row === undefined
          ? []
          : [{ id: row.id, displayName: row.display_name, updatedAt: row.updated_at }];
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id)),
  }));
}
