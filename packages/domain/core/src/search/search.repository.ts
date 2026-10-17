import type { TenantTx } from '@kasuwa/db';
import { LEAD_STATUSES } from '../contact/contact-lead';

/**
 * Global search reads (T-0086; searchRecords and lookupRecords in
 * docs/api/records.openapi.yaml, migration 0038).
 *
 * NOTHING HERE DECIDES WHO READS WHAT. The API decides, per programme, which
 * fields may be compared there (field security, D-L64, the D-L68 displayName
 * rule) and which types the caller reads (D-L115, D-L127), and hands in the
 * result as BRANCHES: one (programme, folded column) pair per field that may
 * be matched in that programme. A field withheld in a programme has no branch
 * there, so it is never compared, and never decides which rows are chosen or
 * their order.
 *
 * Defence in depth (founding pack 3.3): every statement repeats the tenant
 * (from `tx.session`) and the programme predicates that RLS already enforces.
 * Every branch's programme is checked against the session's scope before any
 * SQL is built: a branch naming a programme outside it is refused with an
 * error, never silently searched. No SQL is built from user input: columns
 * come from the fixed lists below, every value is a bound parameter.
 *
 * THE PREFIX PLAN (T-0086 suite R5, R6). One statement per type. Each branch
 * is its own
 *
 *     SELECT id, <col> FROM <table>
 *      WHERE tenant_id = $t AND programme_id = $p AND <col> >= $lo AND <col> < $hi
 *      ORDER BY <col>, id LIMIT 3
 *
 * so the range is the Index Cond of 0038's (tenant_id, programme_id, <col>,
 * id) index (equality on both leading keys, scalar programme), the order
 * comes from the index, and the scan stops after three rows however much of
 * the tenant matches. The branches are unioned, each record keeps its least
 * matched key, and the first three by (key, id) are joined back to the table
 * by primary key. That choice is the global first three by (least readable
 * matched key, id): a record among them is among the first three of the
 * branch that holds its least key, so taking three per branch never drops
 * it. Deterministic, and blind to withheld fields.
 *
 * NOTHING HERE LOGS: the prefix is a name, and every row is personal data.
 */

/** At most this many hits per type (records-contract-search R12). */
export const SEARCH_HITS_PER_TYPE = 3;

export const CONTACT_FOLDED_COLUMNS = [
  'display_name_search',
  'given_names_search',
  'family_name_search',
  'company_name_search',
] as const;
export type ContactFoldedColumn = (typeof CONTACT_FOLDED_COLUMNS)[number];
/** Every folded column of migration 0038: the only column names a branch can carry. */
type FoldedColumn = ContactFoldedColumn | 'name_search';

/** One field that may be matched in one programme. */
export interface SearchBranch<Column extends FoldedColumn> {
  programmeId: string;
  column: Column;
}

/** The folded query and its exclusive upper bound (null: no upper bound exists). */
export interface PrefixRange {
  prefix: string;
  upper: string | null;
}

/** A branch named a programme outside the session's scope: a caller bug, never searched. */
export class SearchScopeError extends Error {
  constructor() {
    super('A search branch named a programme outside the session scope');
    this.name = 'SearchScopeError';
  }
}

class Params {
  readonly values: unknown[] = [];
  private readonly programmes = new Map<string, string>();
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  /** One placeholder per distinct programme id. */
  programme(id: string): string {
    let placeholder = this.programmes.get(id);
    if (placeholder === undefined) {
      placeholder = this.add(id);
      this.programmes.set(id, placeholder);
    }
    return placeholder;
  }
}

function assertInScope(tx: TenantTx, programmeIds: readonly string[]): void {
  const scope = new Set(tx.session.programmeIds);
  if (programmeIds.some((id) => !scope.has(id))) throw new SearchScopeError();
}

/**
 * The union of per-branch range scans, as the ids and least keys of the
 * first three records: `SELECT id, k ... LIMIT 3`. `extra` is one more
 * narrowing predicate on every branch (the leads view's status set).
 */
// tenancy-reviewed: every branch carries `tenant_id = <session tenant>` and a
// scalar `programme_id = <a programme of the session>` (checked by
// assertInScope); the caller ANDs the session scope onto the join as well.
function firstThree<Column extends FoldedColumn>(
  table: 'contact' | 'account' | 'deal',
  tenant: string,
  branches: readonly SearchBranch<Column>[],
  range: PrefixRange,
  params: Params,
  extra = '',
): string {
  const low = params.add(range.prefix);
  const high = range.upper === null ? null : params.add(range.upper);
  const scans = branches.map(({ programmeId, column }) => {
    const upper = high === null ? '' : ` AND ${column} < ${high}`;
    return `(SELECT id, ${column} AS k
               FROM ${table}
              WHERE tenant_id = ${tenant}::uuid
                AND programme_id = ${params.programme(programmeId)}::uuid
                AND ${column} >= ${low}${upper}${extra}
              ORDER BY ${column}, id
              LIMIT ${SEARCH_HITS_PER_TYPE})`;
  });
  return `SELECT branch.id, min(branch.k) AS k
            FROM (${scans.join('\n             UNION ALL\n             ')}) AS branch
           GROUP BY branch.id
           ORDER BY min(branch.k), branch.id
           LIMIT ${SEARCH_HITS_PER_TYPE}`;
}

// --- contacts and leads -------------------------------------------------------

export interface ContactSearchRow {
  id: string;
  programmeId: string;
  displayName: string;
  givenNames: string | null;
  familyName: string | null;
  companyName: string | null;
  status: string | null;
}

interface ContactSearchDbRow {
  id: string;
  programme_id: string;
  display_name: string;
  given_names: string | null;
  family_name: string | null;
  company_name: string | null;
  status: string | null;
}

const CONTACT_HIT_COLUMNS = `c.id, c.programme_id, c.display_name, c.given_names, c.family_name,
       c.company_name, c.status`;

function toContactSearchRow(row: ContactSearchDbRow): ContactSearchRow {
  return {
    id: row.id,
    programmeId: row.programme_id,
    displayName: row.display_name,
    givenNames: row.given_names,
    familyName: row.family_name,
    companyName: row.company_name,
    status: row.status,
  };
}

/**
 * The leads view's status predicate, as SQL literals from LEAD_STATUSES (a
 * constant, never input). Literal rather than a bound array so that it is the
 * exact predicate of 0038's partial lead indexes and the planner can prove it
 * implies them; texteq is leak-proof, so it holds under FORCE RLS.
 */
export const LEAD_STATUS_PREDICATE = `status IN (${LEAD_STATUSES.map((status) => {
  if (!/^[a-z_]+$/.test(status)) throw new Error('A lead status is not a plain word');
  return `'${status}'`;
}).join(', ')})`;

export interface ContactPrefixSearch {
  range: PrefixRange;
  branches: readonly SearchBranch<ContactFoldedColumn>[];
  /** The leads view: only contacts at a lead status (LEAD_STATUS_PREDICATE). */
  leadsOnly?: boolean | undefined;
}

/** A statement and its bound values. */
export interface BuiltStatement {
  text: string;
  values: unknown[];
}

const HIT_COLUMNS: Record<'contact' | 'account' | 'deal', string> = {
  contact: CONTACT_HIT_COLUMNS,
  account: 'c.id, c.programme_id, c.name',
  deal: 'c.id, c.programme_id, c.pipeline_id, c.name',
};

/**
 * One type's prefix statement (pure; exported for its unit test).
 *
 * The join back to the table is scoped to the programmes the branches
 * actually searched, never to the whole session: a deal search runs only in
 * the programmes whose pipelines the caller reads, and the join must not be
 * wider than that, even though the ids it receives could only come from
 * those branches.
 */
// tenancy-reviewed: tenant from the session; every programme is one the
// caller checked against the session scope (assertInScope) before this runs.
export function prefixStatement<Column extends FoldedColumn>(
  table: 'contact' | 'account' | 'deal',
  tenantId: string,
  branches: readonly SearchBranch<Column>[],
  range: PrefixRange,
  leadsOnly = false,
): BuiltStatement {
  const params = new Params();
  const tenant = params.add(tenantId);
  const extra = leadsOnly ? ` AND ${LEAD_STATUS_PREDICATE}` : '';
  const hits = firstThree(table, tenant, branches, range, params, extra);
  const searched = [...new Set(branches.map((branch) => branch.programmeId))];
  const scope = params.add(searched);
  return {
    text: `SELECT ${HIT_COLUMNS[table]}
             FROM (${hits}) AS hit
             JOIN ${table} c
               ON c.id = hit.id
              AND c.tenant_id = ${tenant}::uuid
              AND c.programme_id = ANY(${scope}::uuid[])
            ORDER BY hit.k, c.id`,
    values: params.values,
  };
}

/**
 * The first three contacts (or leads) whose folded field starts with the
 * prefix, over the given branches. No branch, no statement: `[]`.
 */
export async function searchContactsByPrefix(
  tx: TenantTx,
  search: ContactPrefixSearch,
): Promise<ContactSearchRow[]> {
  if (search.branches.length === 0) return [];
  assertInScope(
    tx,
    search.branches.map((branch) => branch.programmeId),
  );
  const { text, values } = prefixStatement(
    'contact',
    tx.session.tenantId,
    search.branches,
    search.range,
    search.leadsOnly === true,
  );
  const rows = await tx.query<ContactSearchDbRow>(text, values);
  return rows.map(toContactSearchRow);
}

/** One exact lookup term, already normalised by the API. */
export type ContactLookupTerm =
  { kind: 'phone'; e164: string } | { kind: 'email'; address: string };

export interface ContactLookup {
  term: ContactLookupTerm;
  /** The programmes in which the term's field (phones or emails) may be compared. */
  programmeIds: readonly string[];
  /** The lead statuses, or null when the lead group is not read (R13). */
  leadStatuses: readonly string[] | null;
}

/** Both groups of one lookup, from one read. */
export interface ContactLookupRows {
  contacts: ContactSearchRow[];
  leads: ContactSearchRow[];
}

/**
 * The first three contacts by id, and the first three leads by id, holding
 * exactly this phone number or this email address (case-insensitive on both
 * sides), in the given programmes. Whole-value equality only: never a prefix
 * or a substring.
 *
 * ONE read for both groups. The match is not an index condition under FORCE
 * RLS (jsonb containment is not leak-proof, ADR-0015, D-L128 Q3), so it reads
 * the given programmes' rows, a cost the T-0086 suite bounds by a latency
 * budget (R8); reading them once rather than once per group halves it.
 * MATERIALIZED keeps the planner from walking the primary key of the whole
 * table to find the first ids in order.
 */
// tenancy-reviewed: tenant from the session, programmes a subset of the
// session's scope (assertInScope); RLS besides.
export async function lookupContacts(
  tx: TenantTx,
  lookup: ContactLookup,
): Promise<ContactLookupRows> {
  if (lookup.programmeIds.length === 0) return { contacts: [], leads: [] };
  assertInScope(tx, lookup.programmeIds);
  const params = new Params();
  const tenant = params.add(tx.session.tenantId);
  const programmes = params.add([...lookup.programmeIds]);
  const match =
    lookup.term.kind === 'phone'
      ? `c.phones @> jsonb_build_array(jsonb_build_object('e164', ${params.add(lookup.term.e164)}::text))`
      : `EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.emails) AS e(address)
                  WHERE lower(e.address) = lower(${params.add(lookup.term.address)}::text))`;
  const isLead =
    lookup.leadStatuses === null
      ? 'false'
      : `coalesce(c.status = ANY(${params.add([...lookup.leadStatuses])}::text[]), false)`;
  const rows = await tx.query<ContactSearchDbRow & { in_contacts: boolean; in_leads: boolean }>(
    `WITH matched AS MATERIALIZED (
       SELECT ${CONTACT_HIT_COLUMNS}, ${isLead} AS is_lead
         FROM contact c
        WHERE c.tenant_id = ${tenant}::uuid
          AND c.programme_id = ANY(${programmes}::uuid[])
          AND ${match}
     ),
     ranked AS (
       SELECT matched.*,
              row_number() OVER (ORDER BY id) AS contact_rank,
              row_number() OVER (PARTITION BY is_lead ORDER BY id) AS group_rank
         FROM matched
     )
     SELECT id, programme_id, display_name, given_names, family_name, company_name, status,
            contact_rank <= ${SEARCH_HITS_PER_TYPE} AS in_contacts,
            (is_lead AND group_rank <= ${SEARCH_HITS_PER_TYPE}) AS in_leads
       FROM ranked
      WHERE contact_rank <= ${SEARCH_HITS_PER_TYPE}
         OR (is_lead AND group_rank <= ${SEARCH_HITS_PER_TYPE})
      ORDER BY id`,
    params.values,
  );
  return {
    contacts: rows.filter((row) => row.in_contacts).map(toContactSearchRow),
    leads: rows.filter((row) => row.in_leads).map(toContactSearchRow),
  };
}

// --- accounts -------------------------------------------------------------------

export interface AccountSearchRow {
  id: string;
  programmeId: string;
  name: string;
}

/** The first three accounts whose folded name starts with the prefix, in these programmes. */
export async function searchAccountsByPrefix(
  tx: TenantTx,
  range: PrefixRange,
  programmeIds: readonly string[],
): Promise<AccountSearchRow[]> {
  if (programmeIds.length === 0) return [];
  assertInScope(tx, programmeIds);
  const branches = programmeIds.map((programmeId) => ({
    programmeId,
    column: 'name_search' as const,
  }));
  const { text, values } = prefixStatement('account', tx.session.tenantId, branches, range);
  const rows = await tx.query<{ id: string; programme_id: string; name: string }>(text, values);
  return rows.map((row) => ({ id: row.id, programmeId: row.programme_id, name: row.name }));
}

// --- deals ----------------------------------------------------------------------

export interface DealSearchRow {
  id: string;
  programmeId: string;
  pipelineId: string;
  name: string;
}

/** The first three deals whose folded name starts with the prefix, in these programmes. */
export async function searchDealsByPrefix(
  tx: TenantTx,
  range: PrefixRange,
  programmeIds: readonly string[],
): Promise<DealSearchRow[]> {
  if (programmeIds.length === 0) return [];
  assertInScope(tx, programmeIds);
  const branches = programmeIds.map((programmeId) => ({
    programmeId,
    column: 'name_search' as const,
  }));
  const { text, values } = prefixStatement('deal', tx.session.tenantId, branches, range);
  const rows = await tx.query<{
    id: string;
    programme_id: string;
    pipeline_id: string;
    name: string;
  }>(text, values);
  return rows.map((row) => ({
    id: row.id,
    programmeId: row.programme_id,
    pipelineId: row.pipeline_id,
    name: row.name,
  }));
}
