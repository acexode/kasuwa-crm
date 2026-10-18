import { newId, type TenantTx } from '@kasuwa/db';
import type { CustomPatch } from '@kasuwa/metadata-engine';
import { decodeListCursor, encodeListCursor } from '../cursor';
import { customFilterClauses, customMergeSet, type CustomFilters } from '../custom/custom-values.repository';
import { listScopeSql, type ListScopeSql } from '../list-scope';
import { foldForSearch, tenantDefaultCountry, type DefaultCountry } from './phone';

/**
 * Contact reads and writes (T-0003 slice, extended by T-0041).
 *
 * Defence in depth (founding pack 3.3): the WHERE clauses below repeat the
 * tenant and programme predicates that RLS already enforces. That redundancy is
 * the point — one layer is a typo away from a leak, two layers are not, and
 * `repository-isolation.acceptance.test.ts` exercises this layer directly
 * rather than through HTTP so a bug in the API cannot mask a bug here.
 *
 * There is no way to call these functions without a TenantTx, and no way to get
 * a TenantTx without a resolved session. Nothing here takes a tenant id or a
 * programme list from its caller: both come from `tx.session`. The one
 * programme id a caller passes (a create's target, an update's record
 * programme) is checked against the session's scope before it is used.
 *
 * No SQL here is built from user input. Column names come from the fixed maps
 * below; every value is a bound parameter.
 *
 * Nothing here decides permission or field security. The API does that, and
 * hands in which programmes may be searched by which field (`ContactSearch`).
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export interface ContactPhone {
  type: string;
  e164: string;
}

/**
 * A contact's owner, with the name a screen prints (T-0043, D-L64). Closed:
 * an id and a display name, never an email, phone or status.
 *
 * `displayName` is `null` for a FORMER owner (T-0103, D-P23): a user who is
 * not a member of the contact's programme (removed from it, or never in it).
 * The screens print a translated neutral label, never the id.
 */
export interface ContactOwner {
  id: string;
  displayName: string | null;
}

/**
 * A contact's account, with the name a screen prints (T-0059 contract,
 * served by T-0061, D-L72). Closed: an id and a name, never the account's
 * owner, tier, industry or phones (getAccount has those, under its own field
 * security).
 */
export interface ContactAccountSummary {
  id: string;
  name: string;
}

export interface Contact {
  id: string;
  programmeId: string;
  version: number;
  displayName: string;
  givenNames: string | null;
  familyName: string | null;
  /** Free text (T-0076, D-P17); `null` when none was recorded. Not a link: `accountId` is. */
  companyName: string | null;
  phones: ContactPhone[];
  emails: string[];
  accountId: string | null;
  /** `null` exactly when `accountId` is null; otherwise `account.id === accountId`. */
  account: ContactAccountSummary | null;
  ownerUserId: string | null;
  /** `null` exactly when `ownerUserId` is null; otherwise `owner.id === ownerUserId`. */
  owner: ContactOwner | null;
  status: string | null;
  source: string | null;
  tags: string[];
  preferredLanguage: string | null;
  preferredChannel: string | null;
  state: string | null;
  lga: string | null;
  dnd: boolean;
  whatsappOptIn: boolean;
  consentState: string;
  phoneNetwork: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactPage {
  data: Contact[];
  nextCursor: string | null;
}

/** The contract's `sort` enum. A key outside it never reaches SQL. */
export const CONTACT_SORTS = [
  '-createdAt',
  'createdAt',
  '-updatedAt',
  'updatedAt',
  'displayName',
  '-displayName',
] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];
export const DEFAULT_CONTACT_SORT: ContactSort = '-createdAt';

interface SortSpec {
  /**
   * A plain column, never an expression and never user input. Each order,
   * `(tenant_id, column, id)`, is a B-tree index of 0035, which kasuwa_app can
   * use under FORCE RLS because every operator it serves is LEAKPROOF (D-P33).
   * An expression key such as `left(display_name, 200)` (T-0041) cannot be: a
   * keyset predicate on a non-LEAKPROOF function is never an index condition
   * under RLS, so a deep page filtered its way to the cursor (D-L112 ruling 8).
   * The cut only bounded a cursor that carried the name; cursors are id-only.
   */
  column: 'created_at' | 'updated_at' | 'display_name';
  direction: 'ASC' | 'DESC';
}

const SORT_SPECS: Record<ContactSort, SortSpec> = {
  '-createdAt': { column: 'created_at', direction: 'DESC' },
  createdAt: { column: 'created_at', direction: 'ASC' },
  '-updatedAt': { column: 'updated_at', direction: 'DESC' },
  updatedAt: { column: 'updated_at', direction: 'ASC' },
  displayName: { column: 'display_name', direction: 'ASC' },
  '-displayName': { column: 'display_name', direction: 'DESC' },
};

/** Filters, already parsed. Each one is "any of"; different filters AND. */
export interface ContactFilters {
  /** User ids; `me` already resolved to the session user by the caller. */
  ownerUserIds?: readonly string[] | undefined;
  /** Include contacts with no owner. */
  ownerUnassigned?: boolean | undefined;
  status?: readonly string[] | undefined;
  source?: readonly string[] | undefined;
  /** Exact, case-insensitive. */
  tags?: readonly string[] | undefined;
  /** Exact, case-insensitive. */
  states?: readonly string[] | undefined;
  /** Exact, case-insensitive. */
  lgas?: readonly string[] | undefined;
  dnd?: boolean | undefined;
  whatsappOptIn?: boolean | undefined;
  /**
   * Contacts linked to this account (listAccountContacts, T-0055). The API
   * judges field security on `accountId` before it sets this: the filter IS
   * a read of that link.
   */
  accountId?: string | undefined;
  /**
   * Narrows to these programmes, within the session's scope (never beyond it:
   * the scope predicate still applies). listAccountContacts passes the
   * account's own programme, which the composite key already implies.
   */
  withinProgrammeIds?: readonly string[] | undefined;
  /**
   * The contacts one import created (T-0094). The API sets it only for an
   * import the caller can see, together with `withinProgrammeIds` naming that
   * import's programme; any other import is an empty page before this runs.
   */
  importJobId?: string | undefined;
  /**
   * Custom-field equality and is-empty (T-0089, ADR-0016 item 8), already
   * judged by the API against the live definitions and field security.
   */
  custom?: CustomFilters | undefined;
}

/**
 * `q`, with what field security allows. Each `...ProgrammeIds` list names
 * the programmes in which that field may be matched: a field the caller may
 * not read in a programme is never matched there, or `q` would be an oracle
 * for its value. `displayName` is never withheld and is always matched.
 */
export interface ContactSearch {
  text: string;
  /** `q` normalised to E.164, or null when it does not read as a number. */
  phoneE164: string | null;
  phoneProgrammeIds: readonly string[];
  givenNamesProgrammeIds: readonly string[];
  familyNameProgrammeIds: readonly string[];
  /**
   * Programmes in which `companyName` may be matched (listLeads, T-0076).
   * Absent: the company is not searched at all (listContacts' `q` is names
   * and numbers, as its contract says).
   */
  companyNameProgrammeIds?: readonly string[] | undefined;
}

export interface ListContactsOptions {
  limit: number;
  cursor?: string | undefined;
  sort?: ContactSort | undefined;
  search?: ContactSearch | undefined;
  filters?: ContactFilters | undefined;
}

interface ContactRow {
  id: string;
  programme_id: string;
  version: number;
  display_name: string;
  given_names: string | null;
  family_name: string | null;
  company_name: string | null;
  phones: ContactPhone[];
  emails: string[];
  account_id: string | null;
  /** The account's `name`, read in the same statement (ACCOUNT_NAME). */
  account_name: string | null;
  owner_user_id: string | null;
  /**
   * The owner's `"user".display_name`, read in the same statement
   * (OWNER_DISPLAY_NAME), and only for a member of the contact's programme.
   */
  owner_display_name: string | null;
  /** Is the owner a member of the contact's programme (OWNER_IS_MEMBER)? `null` with no owner. */
  owner_is_member: boolean | null;
  status: string | null;
  source: string | null;
  tags: string[] | null;
  preferred_language: string | null;
  preferred_channel: string | null;
  state: string | null;
  lga: string | null;
  dnd: boolean;
  whatsapp_opt_in: boolean;
  consent_state: string;
  phone_network: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The owner's membership of THE CONTACT'S programme (T-0103, D-P23): a
 * `user_programme` row in the contact's own tenant and programme. Membership
 * of any other programme, the reader's included, does not count. A disabled
 * user is still a member (D-L81). Read live, so a former owner who rejoins is
 * named again.
 *
 * tenancy-reviewed: keyed on the contact's own tenant, programme and owner,
 * never on an id the caller supplied; RLS on user_programme (tenant-scoped
 * for SELECT, 0001) besides. Reads no name.
 */
const OWNER_MEMBERSHIP = `EXISTS (
    SELECT 1
      FROM user_programme owner_membership
     WHERE owner_membership.tenant_id = contact.tenant_id
       AND owner_membership.programme_id = contact.programme_id
       AND owner_membership.user_id = contact.owner_user_id
  )`;

/**
 * The owner's display name, embedded in the same statement as the contact row
 * (T-0043). It is a correlated subquery on THIS row, so a name is only ever
 * read for the owner of a contact the statement already returns: the
 * contact's own tenant and programme predicates (and RLS) decide which rows
 * those are, and nothing here is keyed on an id the caller supplied. That is
 * what keeps it from being a user directory, which matters because RLS on
 * "user" is tenant-only.
 *
 * D-P23 (T-0103): the name is read only for an owner who is a member of the
 * contact's programme (OWNER_MEMBERSHIP), so a former owner's name never
 * leaves the database, not even into this process.
 *
 * tenancy-reviewed: the user is matched on (tenant_id, id) to the contact's
 * own tenant and owner, the same pair as the composite FK (0019); RLS on
 * "user" besides. A subquery rather than a join so that every unqualified
 * column elsewhere in these statements still means the contact's, and so it
 * also works in INSERT/UPDATE ... RETURNING.
 */
const OWNER_DISPLAY_NAME = `(
  SELECT owner_user.display_name
    FROM "user" owner_user
   WHERE owner_user.tenant_id = contact.tenant_id
     AND owner_user.id = contact.owner_user_id
     AND ${OWNER_MEMBERSHIP}
) AS owner_display_name`;

/** Whether the owner is a member (OWNER_MEMBERSHIP); `null` for an unassigned contact. */
const OWNER_IS_MEMBER = `CASE WHEN contact.owner_user_id IS NULL THEN NULL
  ELSE ${OWNER_MEMBERSHIP} END AS owner_is_member`;

/**
 * The account's name, embedded in the same statement as the contact row
 * (T-0061, D-L72), exactly as the owner's name is. A correlated subquery on
 * THIS row: a name is only ever read for the account a contact the statement
 * already returns is linked to, never for an id the caller supplied.
 *
 * tenancy-reviewed: the account is matched on (tenant_id, programme_id, id)
 * to the contact's own tenant, programme and account, the triple of the
 * composite FK (0019), so it is always an account in the contact's own
 * programme; RLS on account besides.
 */
const ACCOUNT_NAME = `(
  SELECT contact_account.name
    FROM account contact_account
   WHERE contact_account.tenant_id = contact.tenant_id
     AND contact_account.programme_id = contact.programme_id
     AND contact_account.id = contact.account_id
) AS account_name`;

const SELECT_COLUMNS = `
  id, programme_id, version, display_name, given_names, family_name, company_name,
  phones, emails, account_id, owner_user_id, status, source, tags,
  preferred_language, preferred_channel, state, lga, dnd, whatsapp_opt_in,
  consent_state, phone_network, created_at, updated_at,
  ${OWNER_DISPLAY_NAME},
  ${OWNER_IS_MEMBER},
  ${ACCOUNT_NAME}
`;

/**
 * Case- and diacritic-folding in SQL, the twin of `foldForSearch`: NFD, drop
 * U+0300-U+036F, lower. The regex escapes are Postgres's (`\\u` reaches the
 * server as `\u`), not JavaScript's.
 */
const fold = (expression: string) =>
  `lower(regexp_replace(normalize(coalesce(${expression}, ''), NFD), '[\\u0300-\\u036f]', '', 'g'))`;

/**
 * A contact names an owner who is a member of its programme but whose name
 * could not be read. user_programme's composite FK to "user" (0001) makes
 * this impossible; if the schema ever drifts, failing is better than sending
 * a member as a former owner, or `owner: null` beside a set `ownerUserId`,
 * which the contract says means "unassigned". Carries no identifier.
 *
 * Since T-0103 (D-P23) a NON-member owner is not this error: it is a former
 * owner, `{ id, displayName: null }`.
 */
export class ContactOwnerUnresolvedError extends Error {
  constructor() {
    super('A contact owner could not be resolved to a user');
    this.name = 'ContactOwnerUnresolvedError';
  }
}

/**
 * The embedded owner, from a row's owner id, whether that owner is a member
 * of the contact's programme, and the name read beside it (read only for a
 * member). A non-member is a former owner (D-P23): the id, and no name.
 */
export function contactOwnerOf(
  ownerUserId: string | null,
  ownerIsMember: boolean | null,
  ownerDisplayName: string | null,
): ContactOwner | null {
  if (ownerUserId === null) return null;
  if (ownerIsMember !== true) return { id: ownerUserId, displayName: null };
  if (ownerDisplayName === null) throw new ContactOwnerUnresolvedError();
  return { id: ownerUserId, displayName: ownerDisplayName };
}

/**
 * A contact names an account whose name could not be read. The composite FK
 * (0019) makes this impossible; failing is better than sending
 * `account: null` beside a set `accountId`, which the contract says means "no
 * account". Carries no identifier.
 */
export class ContactAccountUnresolvedError extends Error {
  constructor() {
    super('A contact account could not be resolved');
    this.name = 'ContactAccountUnresolvedError';
  }
}

/** The embedded account summary, from a row's account id and the name read beside it. */
export function contactAccountOf(
  accountId: string | null,
  accountName: string | null,
): ContactAccountSummary | null {
  if (accountId === null) return null;
  if (accountName === null) throw new ContactAccountUnresolvedError();
  return { id: accountId, name: accountName };
}

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    programmeId: row.programme_id,
    version: row.version,
    displayName: row.display_name,
    givenNames: row.given_names,
    familyName: row.family_name,
    companyName: row.company_name,
    phones: row.phones,
    emails: row.emails,
    accountId: row.account_id,
    account: contactAccountOf(row.account_id, row.account_name),
    ownerUserId: row.owner_user_id,
    owner: contactOwnerOf(row.owner_user_id, row.owner_is_member, row.owner_display_name),
    status: row.status,
    source: row.source,
    tags: row.tags ?? [],
    preferredLanguage: row.preferred_language,
    preferredChannel: row.preferred_channel,
    state: row.state,
    lga: row.lga,
    dnd: row.dnd,
    whatsappOptIn: row.whatsapp_opt_in,
    consentState: row.consent_state,
    phoneNetwork: row.phone_network,
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

// tenancy-reviewed: searchClause, filterClauses and keysetClause only ever
// NARROW listContacts, whose WHERE always starts with `tenant_id = session
// tenant AND programme_id = ANY(session programmes)`; each clause is ANDed
// onto that. The per-field programme lists in `ContactSearch` are subsets the
// caller computed from the session's own scope, and a list naming a programme
// outside it cannot widen anything (the scope predicate still applies). Every
// value is a bound parameter; column names come from constants.
function searchClause(search: ContactSearch, params: Params): string {
  const folded = params.add(foldForSearch(search.text));
  const alternatives = [`strpos(${fold('display_name')}, ${folded}) > 0`];
  alternatives.push(
    `(programme_id = ANY(${params.add([...search.givenNamesProgrammeIds])}::uuid[])
      AND strpos(${fold('given_names')}, ${folded}) > 0)`,
  );
  alternatives.push(
    `(programme_id = ANY(${params.add([...search.familyNameProgrammeIds])}::uuid[])
      AND strpos(${fold('family_name')}, ${folded}) > 0)`,
  );
  if (search.companyNameProgrammeIds !== undefined) {
    alternatives.push(
      `(programme_id = ANY(${params.add([...search.companyNameProgrammeIds])}::uuid[])
        AND strpos(${fold('company_name')}, ${folded}) > 0)`,
    );
  }
  if (search.phoneE164 !== null) {
    alternatives.push(
      `(programme_id = ANY(${params.add([...search.phoneProgrammeIds])}::uuid[])
        AND phones @> jsonb_build_array(jsonb_build_object('e164', ${params.add(search.phoneE164)}::text)))`,
    );
  }
  return `(${alternatives.join(' OR ')})`;
}

function filterClauses(filters: ContactFilters, params: Params): string[] {
  const clauses: string[] = [];
  const ownerIds = filters.ownerUserIds ?? [];
  if (ownerIds.length > 0 || filters.ownerUnassigned === true) {
    const parts: string[] = [];
    if (ownerIds.length > 0)
      parts.push(`owner_user_id = ANY(${params.add([...ownerIds])}::uuid[])`);
    if (filters.ownerUnassigned === true) parts.push('owner_user_id IS NULL');
    clauses.push(`(${parts.join(' OR ')})`);
  }
  if (filters.status !== undefined && filters.status.length > 0) {
    clauses.push(`status = ANY(${params.add([...filters.status])}::text[])`);
  }
  if (filters.source !== undefined && filters.source.length > 0) {
    clauses.push(`source = ANY(${params.add([...filters.source])}::text[])`);
  }
  if (filters.tags !== undefined && filters.tags.length > 0) {
    const lowered = filters.tags.map((tag) => tag.toLowerCase());
    clauses.push(
      `EXISTS (SELECT 1 FROM unnest(tags) AS t(tag)
                WHERE lower(t.tag) = ANY(${params.add(lowered)}::text[]))`,
    );
  }
  if (filters.states !== undefined && filters.states.length > 0) {
    const lowered = filters.states.map((value) => value.toLowerCase());
    clauses.push(`lower(state) = ANY(${params.add(lowered)}::text[])`);
  }
  if (filters.lgas !== undefined && filters.lgas.length > 0) {
    const lowered = filters.lgas.map((value) => value.toLowerCase());
    clauses.push(`lower(lga) = ANY(${params.add(lowered)}::text[])`);
  }
  if (filters.dnd !== undefined) clauses.push(`dnd = ${params.add(filters.dnd)}::boolean`);
  if (filters.whatsappOptIn !== undefined) {
    clauses.push(`whatsapp_opt_in = ${params.add(filters.whatsappOptIn)}::boolean`);
  }
  if (filters.accountId !== undefined) {
    clauses.push(`account_id = ${params.add(filters.accountId)}::uuid`);
  }
  if (filters.withinProgrammeIds !== undefined) {
    clauses.push(`programme_id = ANY(${params.add([...filters.withinProgrammeIds])}::uuid[])`);
  }
  if (filters.importJobId !== undefined) {
    clauses.push(`import_job_id = ${params.add(filters.importJobId)}::uuid`);
  }
  clauses.push(...customFilterClauses(filters.custom, (value) => params.add(value), 'contact'));
  return clauses;
}

/**
 * The keyset seek for an id-only cursor (T-0084, D-L80). Throws
 * InvalidCursorError for a cursor this server did not issue for this sort.
 *
 * The position is the cursor row's own `(key, id)`, read by an uncorrelated
 * row subquery that Postgres runs once (an InitPlan), so the outer comparison
 * is an index condition on 0035's `(tenant_id, key, id)` and the page SEEKS
 * to the position: no OFFSET, no rescan from the start.
 *
 * tenancy-reviewed: the cursor row is resolved INSIDE the session's scope,
 * the same tenant and programme predicates as the page (RLS besides). A
 * cursor naming another programme's or another tenant's row resolves to no
 * row, the comparison is NULL, and the page is empty: exactly the answer to
 * an invented id, so the cursor is no existence oracle. The resolution is
 * deliberately NOT narrowed by the page's filters or `q`: a cursor is a
 * position, valid under any filter of the same sort (D-L112).
 */
function keysetClause(
  sort: ContactSort,
  cursor: string,
  params: Params,
  scope: ListScopeSql,
): string {
  const spec = SORT_SPECS[sort];
  const id = decodeListCursor(cursor, sort, { legacyKeysetSort: DEFAULT_CONTACT_SORT });
  const operator = spec.direction === 'DESC' ? '<' : '>';
  return `(${spec.column}, id) ${operator} (
          SELECT cursor_row.${spec.column}, cursor_row.id
            FROM contact cursor_row
           WHERE cursor_row.id = ${params.add(id)}::uuid
             AND cursor_row.tenant_id = ${scope.tenantId}
             AND ${scope.programmeIn('cursor_row.programme_id')})`;
}

export async function listContacts(
  tx: TenantTx,
  options: ListContactsOptions,
): Promise<ContactPage> {
  const sort = options.sort ?? DEFAULT_CONTACT_SORT;
  const spec = SORT_SPECS[sort];
  const params = new Params();

  // tenancy-reviewed: tenant AND session programmes first, always; every other
  // clause is ANDed on and can only narrow (see searchClause). One programme
  // is scalar equality, so a programme-led index gives the order (M1).
  const scope = listScopeSql(tx.session, (value) => params.add(value));
  const where = [`tenant_id = ${scope.tenantId}`, scope.programmeIn('programme_id')];
  if (options.cursor !== undefined) where.push(keysetClause(sort, options.cursor, params, scope));
  if (options.search !== undefined) where.push(searchClause(options.search, params));
  if (options.filters !== undefined) where.push(...filterClauses(options.filters, params));

  // Fetch one extra row to decide whether a next page exists, without a count.
  const limit = params.add(options.limit + 1);
  const rows = await tx.query<ContactRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM contact
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${spec.column} ${spec.direction}, id ${spec.direction}
      LIMIT ${limit}`,
    params.values,
  );

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page.at(-1);

  return {
    data: page.map(toContact),
    nextCursor: hasMore && last !== undefined ? encodeListCursor({ sort, id: last.id }) : null,
  };
}

export async function findContactById(tx: TenantTx, id: string): Promise<Contact | null> {
  const rows = await tx.query<ContactRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM contact
      WHERE id = $1
        AND tenant_id = $2
        AND programme_id = ANY($3::uuid[])`,
    [id, tx.session.tenantId, tx.session.programmeIds],
  );
  const row = rows[0];
  return row === undefined ? null : toContact(row);
}

// --- writes ------------------------------------------------------------------

/** The properties a write may set, as the wire names them. */
export interface ContactValues {
  displayName?: string | undefined;
  givenNames?: string | null | undefined;
  familyName?: string | null | undefined;
  companyName?: string | null | undefined;
  phones?: ContactPhone[] | undefined;
  emails?: string[] | undefined;
  accountId?: string | null | undefined;
  ownerUserId?: string | null | undefined;
  status?: string | undefined;
  source?: string | undefined;
  tags?: string[] | undefined;
  preferredLanguage?: string | null | undefined;
  preferredChannel?: string | null | undefined;
  state?: string | null | undefined;
  lga?: string | null | undefined;
  whatsappOptIn?: boolean | undefined;
  consentState?: string | undefined;
}

type ColumnCast = 'text' | 'uuid' | 'jsonb' | 'text[]' | 'boolean';

/** Wire name -> column. Server-owned columns (dnd, phone_network, version) are absent. */
const WRITABLE_COLUMNS: Record<keyof ContactValues, { column: string; cast: ColumnCast }> = {
  displayName: { column: 'display_name', cast: 'text' },
  givenNames: { column: 'given_names', cast: 'text' },
  familyName: { column: 'family_name', cast: 'text' },
  companyName: { column: 'company_name', cast: 'text' },
  phones: { column: 'phones', cast: 'jsonb' },
  emails: { column: 'emails', cast: 'jsonb' },
  accountId: { column: 'account_id', cast: 'uuid' },
  ownerUserId: { column: 'owner_user_id', cast: 'uuid' },
  status: { column: 'status', cast: 'text' },
  source: { column: 'source', cast: 'text' },
  tags: { column: 'tags', cast: 'text[]' },
  preferredLanguage: { column: 'preferred_language', cast: 'text' },
  preferredChannel: { column: 'preferred_channel', cast: 'text' },
  state: { column: 'state', cast: 'text' },
  lga: { column: 'lga', cast: 'text' },
  whatsappOptIn: { column: 'whatsapp_opt_in', cast: 'boolean' },
  consentState: { column: 'consent_state', cast: 'text' },
};

function isWritable(key: string): key is keyof ContactValues {
  return Object.prototype.hasOwnProperty.call(WRITABLE_COLUMNS, key);
}

function assignments(
  values: ContactValues,
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
export class ContactProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to write a contact in a programme outside the session scope');
    this.name = 'ContactProgrammeOutOfScopeError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) {
    throw new ContactProgrammeOutOfScopeError();
  }
}

/**
 * The two server-owned columns an import sets on a contact it creates
 * (T-0094): never reachable from createContact, whose body has neither.
 */
export interface ImportedContactColumns {
  readonly importJobId: string;
  /** D-P28: an import may set DND either way on a NEW contact, never grant consent. */
  readonly dnd: boolean;
}

/**
 * Inserts a contact in `programmeId`, which must be in the session's scope.
 * tenancy-reviewed: tenant from the session, programme checked against the
 * session, and RLS WITH CHECK refuses either independently.
 */
export async function insertContact(
  tx: TenantTx,
  programmeId: string,
  values: ContactValues & { displayName: string },
  custom: Readonly<Record<string, unknown>> = {},
  imported?: ImportedContactColumns,
): Promise<Contact> {
  assertInScope(tx, programmeId);
  const params = new Params();
  const fixed = [
    { column: 'id', placeholder: `${params.add(newId())}::uuid` },
    { column: 'tenant_id', placeholder: `${params.add(tx.session.tenantId)}::uuid` },
    { column: 'programme_id', placeholder: `${params.add(programmeId)}::uuid` },
    // Validated by the API against the live definitions (T-0089). Never read back here.
    { column: 'custom', placeholder: `${params.add(JSON.stringify(custom))}::jsonb` },
  ];
  if (imported !== undefined) {
    // T-0094: the job in the SAME programme (the composite FK refuses any
    // other), and the D-P28 restrict-or-default `dnd` the import worker judged.
    fixed.push(
      { column: 'import_job_id', placeholder: `${params.add(imported.importJobId)}::uuid` },
      { column: 'dnd', placeholder: `${params.add(imported.dnd)}::boolean` },
    );
  }
  const columns = [...fixed, ...assignments(values, params)];
  const rows = await tx.query<ContactRow>(
    `INSERT INTO contact (${columns.map((entry) => entry.column).join(', ')})
     VALUES (${columns.map((entry) => entry.placeholder).join(', ')})
     RETURNING ${SELECT_COLUMNS}`,
    params.values,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('INSERT ... RETURNING returned no row');
  return toContact(row);
}

/**
 * Applies `values` to one contact iff its version is still `version`.
 *
 * Returns null when no row matched: the version moved (or the row went), which
 * the API answers `409 stale_write`. The statement sets `version = version + 1`
 * itself; the 0019 trigger fires only when a statement leaves version alone,
 * so the value moves exactly once. Under READ COMMITTED a concurrent writer
 * with the same version blocks on the row lock, re-evaluates the WHERE against
 * the committed row, matches nothing, and gets null: exactly one wins.
 */
export async function updateContactIfVersion(
  tx: TenantTx,
  target: { id: string; programmeId: string; version: number },
  values: ContactValues,
  custom?: CustomPatch,
): Promise<Contact | null> {
  assertInScope(tx, target.programmeId);
  // tenancy-reviewed: id AND tenant (from the session) AND programme (checked
  // against the session above) AND version; RLS USING and WITH CHECK besides.
  // SET never names tenant_id or programme_id: WRITABLE_COLUMNS has neither.
  // `custom` is merged per key (T-0089) and never returned: RETURNING does
  // not name it.
  const params = new Params();
  const sets = assignments(values, params).map((entry) => `${entry.column} = ${entry.placeholder}`);
  if (custom !== undefined) sets.push(customMergeSet(custom, (value) => params.add(value)));
  sets.push('version = version + 1');
  const rows = await tx.query<ContactRow>(
    `UPDATE contact
        SET ${sets.join(', ')}
      WHERE id = ${params.add(target.id)}::uuid
        AND tenant_id = ${params.add(tx.session.tenantId)}::uuid
        AND programme_id = ${params.add(target.programmeId)}::uuid
        AND version = ${params.add(target.version)}::integer
      RETURNING ${SELECT_COLUMNS}`,
    params.values,
  );
  const row = rows[0];
  return row === undefined ? null : toContact(row);
}

/**
 * The advisory-lock namespace of a programme membership: ASCII 'KMEM'. The
 * second key is `hashtext(programme_id::text || '/' || user_id::text)`.
 * MUST equal `lock_namespace` in migration 0031's
 * `app.unassign_removed_member_contacts()`; the T-0103 races go red if the
 * two drift apart.
 *
 * EVERY WRITER OF `contact.owner_user_id` MUST CALL `programmeMemberExists`
 * for the new owner, in the same transaction, before it writes. That call is
 * what takes this lock; a write that skips it can race a removal and leave a
 * contact owned by a non-member (D-P23, D-L99). Today the writers are
 * createContact and updateContact (`checkReferences` in the API).
 */
export const MEMBERSHIP_LOCK_NAMESPACE = 0x4b4d454d;

/**
 * The owner check ran outside READ COMMITTED. Under REPEATABLE READ or
 * SERIALIZABLE its membership read uses the transaction's first snapshot, so
 * after waiting for a removal it would still see the removed membership: the
 * lock would protect nothing. Refused rather than trusted (T-0103 security
 * review). Carries no identifier.
 */
export class MembershipCheckIsolationError extends Error {
  constructor() {
    super('A programme membership check must run in READ COMMITTED');
    this.name = 'MembershipCheckIsolationError';
  }
}

/**
 * May `userId` own a contact in `programmeId`? D-L67: only a member of that
 * programme (a `user_programme` row there). Another tenant's user, a user who
 * belongs only to a sibling programme, and no user at all are the same
 * `false`, so the API answers all three with one body and an owner field is
 * never an existence oracle across the BPO isolation boundary.
 *
 * tenancy-reviewed: tenant from the session, the programme required in SQL to
 * be in the session's scope, the user joined on (tenant_id, id); RLS on both
 * tables besides. Reads ids only, never a user's name or address.
 *
 * RACES (T-0103, D-L99). A "yes" holds until this transaction commits: the
 * check first takes the membership's advisory lock SHARED (see
 * MEMBERSHIP_LOCK_NAMESPACE), and a removal takes it EXCLUSIVE in migration
 * 0031's trigger before it unassigns. So a removal either waits for this
 * transaction and then unassigns whatever it wrote, or this check waits for
 * the removal and then answers "no" (the same `false` as an invented id).
 * The lock is advisory, not `FOR KEY SHARE` on user_programme: 0021's
 * restrictive UPDATE policy filters row locks for every non-admin session,
 * so an agent's D-P14 self-claim would find no row.
 *
 * The lock and the read are TWO statements on purpose. Under READ COMMITTED
 * each statement takes its snapshot when it starts; a read in the same
 * statement as the lock wait would use a snapshot from before the removal
 * committed and still see the membership.
 */
export async function programmeMemberExists(
  tx: TenantTx,
  programmeId: string,
  userId: string,
): Promise<boolean> {
  // The key text is built from uuid::text, canonical lower case, exactly as
  // 0031 builds it from the row: a client's upper-case id must not miss the lock.
  // The same statement reports the isolation level, checked before the read.
  const [held] = await tx.query<{ isolation: string }>(
    `SELECT current_setting('transaction_isolation') AS isolation
       FROM (SELECT pg_advisory_xact_lock_shared(
                      $1::integer,
                      hashtext($2::uuid::text || '/' || $3::uuid::text)
                    )) AS membership_lock`,
    [MEMBERSHIP_LOCK_NAMESPACE, programmeId, userId],
  );
  if (held?.isolation !== 'read committed') throw new MembershipCheckIsolationError();
  const rows = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM user_programme up
       JOIN "user" u
         ON u.tenant_id = up.tenant_id
        AND u.id = up.user_id
      WHERE up.tenant_id = $1
        AND up.programme_id = $2
        AND up.programme_id = ANY($3::uuid[])
        AND up.user_id = $4`,
    [tx.session.tenantId, programmeId, tx.session.programmeIds, userId],
  );
  return rows.length > 0;
}

/**
 * Is `accountId` an account in `programmeId`? The contact FK only accepts an
 * account in the contact's own programme; answering that here turns what
 * would be a 23503 (a 500) into the same refusal as an id that names nothing.
 *
 * tenancy-reviewed: tenant from the session, the programme both named and
 * required to be in the session's scope, RLS on account besides.
 */
export async function programmeAccountExists(
  tx: TenantTx,
  programmeId: string,
  accountId: string,
): Promise<boolean> {
  const rows = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM account
      WHERE tenant_id = $1
        AND programme_id = $2
        AND programme_id = ANY($3::uuid[])
        AND id = $4`,
    [tx.session.tenantId, programmeId, tx.session.programmeIds, accountId],
  );
  return rows.length > 0;
}

/**
 * The session tenant's default country for phone search (S4).
 *
 * tenancy-reviewed: the session's own tenant row only (`id = session
 * tenant`), under tenant_isolation RLS; two settings columns, nothing else.
 */
export async function loadTenantDefaultCountry(tx: TenantTx): Promise<DefaultCountry | null> {
  const rows = await tx.query<{ locale_default: string | null; currency_default: string | null }>(
    `SELECT locale_default, currency_default FROM tenant WHERE id = $1`,
    [tx.session.tenantId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : tenantDefaultCountry({
        localeDefault: row.locale_default,
        currencyDefault: row.currency_default,
      });
}
