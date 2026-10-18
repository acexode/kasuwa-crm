import { newId, type TenantTx } from '@kasuwa/db';
import type { CustomPatch } from '@kasuwa/metadata-engine';
import { decodeListCursor, encodeListCursor } from '../cursor';
import { customFilterClauses, customMergeSet, type CustomFilters } from '../custom/custom-values.repository';
import { listScopeSql, type ListScopeSql } from '../list-scope';
import type { ContactPhone } from '../contact/contact.repository';
import { foldForSearch } from '../contact/phone';
import {
  AccountWriteRefusedError,
  classifyAccountWriteError,
  MAX_ACCOUNT_DEPTH,
  type HierarchyWalk,
} from './account-hierarchy';

/**
 * Account reads and writes (T-0055), the twin of the contact repository.
 *
 * Defence in depth (CLAUDE.md 2.3): every WHERE repeats the tenant and
 * programme predicates RLS already enforces. Nothing here takes a tenant id or
 * a programme list from its caller: both come from `tx.session`. The one
 * programme id a caller passes (a create's target, an update's record
 * programme) is checked against the session's scope before it is used.
 *
 * No SQL here is built from user input. Column names come from the fixed maps
 * below; every value is a bound parameter.
 *
 * Nothing here decides permission or field security; the API does. Nothing
 * here logs, and no Postgres error text leaves it: a refusal the database
 * makes is rethrown as `AccountWriteRefusedError`, which carries a reason code
 * and nothing else.
 */

/** An account's owner, with the name a screen prints. Closed, as the contact's. */
export interface AccountOwner {
  id: string;
  displayName: string;
}

export interface Account {
  id: string;
  programmeId: string;
  version: number;
  name: string;
  ownerUserId: string | null;
  /** `null` exactly when `ownerUserId` is null; otherwise `owner.id === ownerUserId`. */
  owner: AccountOwner | null;
  industry: string | null;
  tier: string | null;
  tags: string[];
  phones: ContactPhone[];
  state: string | null;
  lga: string | null;
  parentAccountId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccountPage {
  data: Account[];
  nextCursor: string | null;
}

/** The contract's `sort` enum. Every key is a field field security never withholds. */
export const ACCOUNT_SORTS = [
  'name',
  '-name',
  '-createdAt',
  'createdAt',
  '-updatedAt',
  'updatedAt',
] as const;
export type AccountSort = (typeof ACCOUNT_SORTS)[number];
export const DEFAULT_ACCOUNT_SORT: AccountSort = 'name';

interface SortSpec {
  /**
   * A plain column, never an expression and never user input. Each order,
   * `(tenant_id, column, id)`, is a B-tree index of 0035 that kasuwa_app can
   * use under FORCE RLS (D-P33): tenant-led, so that it also gives the order
   * for a session reaching several programmes.
   */
  column: 'name' | 'created_at' | 'updated_at';
  direction: 'ASC' | 'DESC';
}

const SORT_SPECS: Record<AccountSort, SortSpec> = {
  name: { column: 'name', direction: 'ASC' },
  '-name': { column: 'name', direction: 'DESC' },
  '-createdAt': { column: 'created_at', direction: 'DESC' },
  createdAt: { column: 'created_at', direction: 'ASC' },
  '-updatedAt': { column: 'updated_at', direction: 'DESC' },
  updatedAt: { column: 'updated_at', direction: 'ASC' },
};

/** Filters, already parsed. Each one is "any of"; different filters AND. */
export interface AccountFilters {
  /** User ids; `me` already resolved to the session user by the caller. */
  ownerUserIds?: readonly string[] | undefined;
  /** Include accounts with no owner. */
  ownerUnassigned?: boolean | undefined;
  tiers?: readonly string[] | undefined;
  /** Exact, case-insensitive. */
  industries?: readonly string[] | undefined;
  /** Exact, case-insensitive. */
  tags?: readonly string[] | undefined;
  /** Exact, case-insensitive. */
  states?: readonly string[] | undefined;
  /** Exact, case-insensitive. */
  lgas?: readonly string[] | undefined;
  /** Custom-field equality and is-empty (T-0089), already judged by the API. */
  custom?: CustomFilters | undefined;
}

export interface ListAccountsOptions {
  limit: number;
  cursor?: string | undefined;
  sort?: AccountSort | undefined;
  /** `q`: a case- and diacritic-insensitive substring of `name`, and nothing else. */
  search?: string | undefined;
  filters?: AccountFilters | undefined;
}

interface AccountRow {
  id: string;
  programme_id: string;
  version: number;
  name: string;
  owner_user_id: string | null;
  owner_display_name: string | null;
  industry: string | null;
  tier: string | null;
  tags: string[] | null;
  phones: ContactPhone[] | null;
  state: string | null;
  lga: string | null;
  parent_account_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The owner's display name, in the same statement as the account row, as
 * contacts do (T-0043). A correlated subquery on THIS row: a name is only ever
 * read for the owner of an account the statement already returns, under the
 * account's own tenant and programme predicates and RLS, so this is not a
 * user directory.
 *
 * tenancy-reviewed: the user is matched on (tenant_id, id) to the account's
 * own tenant and owner, the pair 0026's composite FK holds; RLS on "user"
 * besides.
 */
const OWNER_DISPLAY_NAME = `(
  SELECT owner_user.display_name
    FROM "user" owner_user
   WHERE owner_user.tenant_id = account.tenant_id
     AND owner_user.id = account.owner_user_id
) AS owner_display_name`;

const SELECT_COLUMNS = `
  id, programme_id, version, name, owner_user_id, industry, tier, tags, phones,
  state, lga, parent_account_id, created_at, updated_at,
  ${OWNER_DISPLAY_NAME}
`;

/** Carries no identifier: the 0026 composite FK makes this impossible. */
export class AccountOwnerUnresolvedError extends Error {
  constructor() {
    super('An account owner could not be resolved to a user');
    this.name = 'AccountOwnerUnresolvedError';
  }
}

function ownerOf(ownerUserId: string | null, displayName: string | null): AccountOwner | null {
  if (ownerUserId === null) return null;
  if (displayName === null) throw new AccountOwnerUnresolvedError();
  return { id: ownerUserId, displayName };
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    programmeId: row.programme_id,
    version: row.version,
    name: row.name,
    ownerUserId: row.owner_user_id,
    owner: ownerOf(row.owner_user_id, row.owner_display_name),
    industry: row.industry,
    tier: row.tier,
    tags: row.tags ?? [],
    phones: row.phones ?? [],
    state: row.state,
    lga: row.lga,
    parentAccountId: row.parent_account_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Bound parameters, numbered as they are added. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** The SQL twin of `foldForSearch`: NFD, drop U+0300-U+036F, lower. */
const FOLDED_NAME = `lower(regexp_replace(normalize(name, NFD), '[\\u0300-\\u036f]', '', 'g'))`;

// tenancy-reviewed: filterClauses and keysetClause only ever NARROW
// listAccounts, whose WHERE always starts with `tenant_id = session tenant AND
// programme_id = ANY(session programmes)`. Every value is a bound parameter;
// column names come from constants.
function filterClauses(filters: AccountFilters, params: Params): string[] {
  const clauses: string[] = [];
  const ownerIds = filters.ownerUserIds ?? [];
  if (ownerIds.length > 0 || filters.ownerUnassigned === true) {
    const parts: string[] = [];
    if (ownerIds.length > 0) {
      parts.push(`owner_user_id = ANY(${params.add([...ownerIds])}::uuid[])`);
    }
    if (filters.ownerUnassigned === true) parts.push('owner_user_id IS NULL');
    clauses.push(`(${parts.join(' OR ')})`);
  }
  if (filters.tiers !== undefined && filters.tiers.length > 0) {
    clauses.push(`tier = ANY(${params.add([...filters.tiers])}::text[])`);
  }
  const lowered = (values: readonly string[]) => values.map((value) => value.toLowerCase());
  if (filters.industries !== undefined && filters.industries.length > 0) {
    clauses.push(`lower(industry) = ANY(${params.add(lowered(filters.industries))}::text[])`);
  }
  if (filters.tags !== undefined && filters.tags.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM unnest(tags) AS t(tag)
                WHERE lower(t.tag) = ANY(${params.add(lowered(filters.tags))}::text[]))`,
    );
  }
  if (filters.states !== undefined && filters.states.length > 0) {
    clauses.push(`lower(state) = ANY(${params.add(lowered(filters.states))}::text[])`);
  }
  if (filters.lgas !== undefined && filters.lgas.length > 0) {
    clauses.push(`lower(lga) = ANY(${params.add(lowered(filters.lgas))}::text[])`);
  }
  clauses.push(...customFilterClauses(filters.custom, (value) => params.add(value)));
  return clauses;
}

/**
 * The keyset seek for an id-only cursor (T-0084, D-L80), the twin of the
 * contact repository's. Throws InvalidCursorError for a cursor this server
 * did not issue for this sort.
 *
 * The position is the cursor row's own `(key, id)`, read once by an
 * uncorrelated row subquery (an InitPlan), so the comparison is an index
 * condition and the page seeks.
 *
 * tenancy-reviewed: the cursor row is resolved INSIDE the session's scope
 * (RLS besides). Another programme's or tenant's row resolves to nothing and
 * the page is empty, exactly as for an invented id. Not narrowed by `q` or the
 * filters: a cursor is a position, valid under any filter of its sort.
 */
function keysetClause(
  sort: AccountSort,
  cursor: string,
  params: Params,
  scope: ListScopeSql,
): string {
  const spec = SORT_SPECS[sort];
  const id = decodeListCursor(cursor, sort);
  const operator = spec.direction === 'DESC' ? '<' : '>';
  return `(${spec.column}, id) ${operator} (
          SELECT cursor_row.${spec.column}, cursor_row.id
            FROM account cursor_row
           WHERE cursor_row.id = ${params.add(id)}::uuid
             AND cursor_row.tenant_id = ${scope.tenantId}
             AND ${scope.programmeIn('cursor_row.programme_id')})`;
}

export async function listAccounts(
  tx: TenantTx,
  options: ListAccountsOptions,
): Promise<AccountPage> {
  const sort = options.sort ?? DEFAULT_ACCOUNT_SORT;
  const spec = SORT_SPECS[sort];
  const params = new Params();

  // tenancy-reviewed: tenant AND session programmes first, always; every other
  // clause is ANDed on and can only narrow. One programme is scalar equality,
  // so a programme-led index gives the order (M1).
  const scope = listScopeSql(tx.session, (value) => params.add(value));
  const where = [`tenant_id = ${scope.tenantId}`, scope.programmeIn('programme_id')];
  if (options.cursor !== undefined) where.push(keysetClause(sort, options.cursor, params, scope));
  if (options.search !== undefined) {
    // strpos, not LIKE or a regex: `%`, `_` and `.*` are literal characters.
    where.push(`strpos(${FOLDED_NAME}, ${params.add(foldForSearch(options.search))}) > 0`);
  }
  if (options.filters !== undefined) where.push(...filterClauses(options.filters, params));

  // One extra row decides whether a next page exists, without a count (D-P13).
  const limit = params.add(options.limit + 1);
  const rows = await tx.query<AccountRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM account
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${spec.column} ${spec.direction}, id ${spec.direction}
      LIMIT ${limit}`,
    params.values,
  );

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page.at(-1);
  return {
    data: page.map(toAccount),
    nextCursor: hasMore && last !== undefined ? encodeListCursor({ sort, id: last.id }) : null,
  };
}

/** One account the session reaches, or null: absent, another tenant's and a sibling's alike. */
export async function findAccountById(tx: TenantTx, id: string): Promise<Account | null> {
  const rows = await tx.query<AccountRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM account
      WHERE id = $1
        AND tenant_id = $2
        AND programme_id = ANY($3::uuid[])`,
    [id, tx.session.tenantId, tx.session.programmeIds],
  );
  const row = rows[0];
  return row === undefined ? null : toAccount(row);
}

// --- the hierarchy -----------------------------------------------------------

/**
 * Walks the committed hierarchy for a proposed parent: up from `parentId`
 * (did it meet `accountId`? how deep is the parent?) and down from
 * `accountId` (how tall is the subtree that would move?). The API answers the
 * verdict (`hierarchyVerdict`) before writing; 0026's guard re-checks under
 * its lock at write time, which is what catches a concurrent half-cycle.
 *
 * Both walks are bounded at MAX_ACCOUNT_DEPTH + 1 levels, so even a corrupt
 * chain cannot loop. `accountId` is null on create (nothing hangs below a new
 * account). The parent must already be known to be an account in
 * `programmeId` (`programmeAccountExists`).
 *
 * tenancy-reviewed: tenant from the session, the programme both named and
 * required to be in the session's scope, on every row of both walks; RLS
 * besides. Reads ids only.
 */
export async function checkAccountHierarchy(
  tx: TenantTx,
  programmeId: string,
  accountId: string | null,
  parentId: string,
): Promise<HierarchyWalk> {
  const rows = await tx.query<{ cycle: boolean; parent_depth: number; height: number }>(
    `WITH RECURSIVE up (id, parent_id, level) AS (
       SELECT a.id, a.parent_account_id, 1
         FROM account a
        WHERE a.tenant_id = $1 AND a.programme_id = $2
          AND a.programme_id = ANY($3::uuid[])
          AND a.id = $4
       UNION ALL
       SELECT a.id, a.parent_account_id, up.level + 1
         FROM up
         JOIN account a
           ON a.tenant_id = $1 AND a.programme_id = $2
          AND a.id = up.parent_id
        WHERE up.level <= $6
          AND up.id IS DISTINCT FROM $5::uuid
     ),
     below (id, level) AS (
       SELECT a.id, 1
         FROM account a
        WHERE a.tenant_id = $1 AND a.programme_id = $2
          AND a.programme_id = ANY($3::uuid[])
          AND a.id = $5::uuid
       UNION ALL
       SELECT c.id, below.level + 1
         FROM below
         JOIN account c
           ON c.tenant_id = $1 AND c.programme_id = $2
          AND c.parent_account_id = below.id
        WHERE below.level <= $6
     )
     SELECT coalesce(bool_or(up.id = $5::uuid), false) AS cycle,
            coalesce(max(up.level), 0)::int AS parent_depth,
            coalesce((SELECT max(level) FROM below), 1)::int AS height
       FROM up`,
    [
      tx.session.tenantId,
      programmeId,
      tx.session.programmeIds,
      parentId,
      accountId,
      MAX_ACCOUNT_DEPTH,
    ],
  );
  const row = rows[0];
  return {
    cycle: row?.cycle ?? false,
    parentDepth: row?.parent_depth ?? 0,
    height: row?.height ?? 1,
  };
}

// --- writes ------------------------------------------------------------------

/** The properties a write may set, as the wire names them. */
export interface AccountValues {
  name?: string | undefined;
  ownerUserId?: string | null | undefined;
  industry?: string | null | undefined;
  tier?: string | null | undefined;
  tags?: string[] | undefined;
  phones?: ContactPhone[] | undefined;
  state?: string | null | undefined;
  lga?: string | null | undefined;
  parentAccountId?: string | null | undefined;
}

type ColumnCast = 'text' | 'uuid' | 'jsonb' | 'text[]';

/**
 * Wire name -> column. `id`, `tenant_id`, `programme_id` and `version` are
 * absent: no write sets them from values, so an update can never move an
 * account between programmes (D-L76) or rewrite its id (0026).
 */
const WRITABLE_COLUMNS: Record<keyof AccountValues, { column: string; cast: ColumnCast }> = {
  name: { column: 'name', cast: 'text' },
  ownerUserId: { column: 'owner_user_id', cast: 'uuid' },
  industry: { column: 'industry', cast: 'text' },
  tier: { column: 'tier', cast: 'text' },
  tags: { column: 'tags', cast: 'text[]' },
  phones: { column: 'phones', cast: 'jsonb' },
  state: { column: 'state', cast: 'text' },
  lga: { column: 'lga', cast: 'text' },
  parentAccountId: { column: 'parent_account_id', cast: 'uuid' },
};

function isWritable(key: string): key is keyof AccountValues {
  return Object.prototype.hasOwnProperty.call(WRITABLE_COLUMNS, key);
}

function assignments(
  values: AccountValues,
  params: Params,
): { column: string; placeholder: string }[] {
  const result: { column: string; placeholder: string }[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || !isWritable(key)) continue;
    const { column, cast } = WRITABLE_COLUMNS[key];
    const bound = cast === 'jsonb' && value !== null ? JSON.stringify(value) : value;
    result.push({ column, placeholder: `${params.add(bound)}::${cast}` });
  }
  return result;
}

/** Thrown for a programme outside the session. The API answers 404 before this. */
export class AccountProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to write an account in a programme outside the session scope');
    this.name = 'AccountProgrammeOutOfScopeError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new AccountProgrammeOutOfScopeError();
  }
}

/** Runs a write, turning a refusal the database makes into a reason code only. */
async function refusalsMapped<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const reason = classifyAccountWriteError(error);
    if (reason !== null) throw new AccountWriteRefusedError(reason);
    throw error;
  }
}

/**
 * Inserts an account in `programmeId`, which must be in the session's scope.
 * tenancy-reviewed: tenant from the session, programme checked against the
 * session, and RLS WITH CHECK refuses either independently.
 */
export async function insertAccount(
  tx: TenantTx,
  programmeId: string,
  values: AccountValues & { name: string },
  custom: Readonly<Record<string, unknown>> = {},
): Promise<Account> {
  assertInScope(tx, programmeId);
  const params = new Params();
  const fixed = [
    { column: 'id', placeholder: `${params.add(newId())}::uuid` },
    { column: 'tenant_id', placeholder: `${params.add(tx.session.tenantId)}::uuid` },
    { column: 'programme_id', placeholder: `${params.add(programmeId)}::uuid` },
    // Validated by the API against the live definitions (T-0089). Never read back here.
    { column: 'custom', placeholder: `${params.add(JSON.stringify(custom))}::jsonb` },
  ];
  const columns = [...fixed, ...assignments(values, params)];
  const rows = await refusalsMapped(() =>
    tx.query<AccountRow>(
      `INSERT INTO account (${columns.map((entry) => entry.column).join(', ')})
       VALUES (${columns.map((entry) => entry.placeholder).join(', ')})
       RETURNING ${SELECT_COLUMNS}`,
      params.values,
    ),
  );
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
  return toAccount(row);
}

/**
 * Applies `values` to one account iff its version is still `version`; null
 * when no row matched (the API's `409 stale_write`). `version = version + 1`
 * is set here, so 0019's trigger leaves it alone and it moves exactly once.
 * Under READ COMMITTED a concurrent writer with the same version blocks on the
 * row lock, re-evaluates the WHERE against the committed row and matches
 * nothing: exactly one wins.
 */
export async function updateAccountIfVersion(
  tx: TenantTx,
  target: { id: string; programmeId: string; version: number },
  values: AccountValues,
  custom?: CustomPatch,
): Promise<Account | null> {
  assertInScope(tx, target.programmeId);
  // tenancy-reviewed: id AND tenant (from the session) AND programme (checked
  // against the session above) AND version; RLS USING and WITH CHECK besides.
  // SET never names id, tenant_id or programme_id: WRITABLE_COLUMNS has none.
  // `custom` is merged per key (T-0089) and never returned.
  const params = new Params();
  const sets = assignments(values, params).map((entry) => `${entry.column} = ${entry.placeholder}`);
  if (custom !== undefined) sets.push(customMergeSet(custom, (value) => params.add(value)));
  sets.push('version = version + 1');
  const rows = await refusalsMapped(() =>
    tx.query<AccountRow>(
      `UPDATE account
          SET ${sets.join(', ')}
        WHERE id = ${params.add(target.id)}::uuid
          AND tenant_id = ${params.add(tx.session.tenantId)}::uuid
          AND programme_id = ${params.add(target.programmeId)}::uuid
          AND version = ${params.add(target.version)}::integer
        RETURNING ${SELECT_COLUMNS}`,
      params.values,
    ),
  );
  const row = rows[0];
  return row === undefined ? null : toAccount(row);
}
