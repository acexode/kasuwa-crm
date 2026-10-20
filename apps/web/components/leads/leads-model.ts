import type { MessageId } from '@kasuwa/i18n/bundle';
import { listRefusalId, type CustomFilters } from '../../lib/custom-values-filters';
import type { Account } from '../../lib/accounts-api';
import {
  LeadSort,
  LeadStatus,
  type ConvertLeadBody,
  type Lead,
  type LeadListQuery,
  type MoveLeadBody,
} from '../../lib/leads-api';
import { ContactSource, hasDetail, isWithheld, type RecordsError } from '../../lib/records-api';

/**
 * The pure half of P04/01 and P04/04 (T-0058): columns, filters, sort, the
 * list and column queries, the Kanban move and the convert body. No React and
 * no `'use client'`, so it is unit-tested directly and a server component may
 * import it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DESIGN AND THE CONTRACT DISAGREE, THE CONTRACT WINS (D-L86)
 *
 *   - Rows are Contacts (D-P17). Columns are Contact properties; Company is
 *     `companyName`. P04/01's Lead score and Last activity have no field.
 *   - Filters are `listLeads` parameters: owner, status, source. Status
 *     offers the four lead stages only; `customer` is never a chip, a column
 *     or a move target. Leaving the lead stages is convert's job.
 *   - Sort is `sort`'s enum only: created and updated, either way. Never
 *     company, status, owner or source, and never the name: `displayName`
 *     follows its name parts and can be withheld (T-0124, D-L68), so
 *     `sort=displayName` is a 400.
 *   - No totals, no live chip counts, no Kanban column counts (D-P13).
 *   - The one contact write is a Kanban move, `{ version, status }`.
 *   - Convert is one `convertContact`: an account in the lead's own
 *     programme, or a new one by name. Not offered where the row withholds
 *     `status` or `accountId`, the two fields it writes.
 *   - No Merge, Lead score, Map, bulk selection or bulk WhatsApp (D-L69).
 * ---------------------------------------------------------------------------
 */

export const LEAD_STATUSES: readonly LeadStatus[] = LeadStatus.options;

/** `true` for a lead stage — the only values a Kanban column, a move or the status filter may name. */
export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

/** `records.status.<code>`: a status is a code on the wire and a label on screen. */
export function statusLabel(status: string): MessageId {
  return `records.status.${status}` as MessageId;
}

export function sourceLabel(source: string): MessageId {
  return `records.source.${source}` as MessageId;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** A column is a Contact property, by name (`data-column`). */
export type LeadColumnKey =
  | 'displayName'
  | 'phones'
  | 'whatsappOptIn'
  | 'emails'
  | 'companyName'
  | 'owner'
  | 'tags'
  | 'status'
  | 'source';

export interface LeadColumn {
  readonly key: LeadColumnKey;
  readonly label: MessageId;
  /** The Contact properties whose withholding locks this cell. */
  readonly fields: readonly string[];
  /** Shown before anyone touches the chooser. */
  readonly defaultVisible: boolean;
  /** The name column: always shown, never offered for hiding. */
  readonly fixed?: true;
}

/**
 * P04/01's order (T-0133): Lead, Phone, WA, Email, Company, Owner, Tags,
 * Status — Last activity sits between Owner and Tags where `last_activity` is
 * on, and Lead score is not drawn (D-L69). Source is in the name's second line
 * ("via Missed call · Lagos · Ikeja") and in the chooser.
 */
export const LEAD_COLUMNS: readonly LeadColumn[] = [
  { key: 'displayName', label: 'records.col.lead', fields: ['displayName'], defaultVisible: true, fixed: true },
  { key: 'phones', label: 'records.col.phones', fields: ['phones'], defaultVisible: true },
  { key: 'whatsappOptIn', label: 'records.col.whatsappOptIn', fields: ['whatsappOptIn'], defaultVisible: true },
  { key: 'emails', label: 'records.col.emails', fields: ['emails'], defaultVisible: true },
  { key: 'companyName', label: 'leads.col.companyName', fields: ['companyName'], defaultVisible: true },
  // The contract withholds `owner` and `ownerUserId` together; either locks it.
  { key: 'owner', label: 'records.col.ownerUserId', fields: ['owner', 'ownerUserId'], defaultVisible: true },
  { key: 'tags', label: 'records.col.tags', fields: ['tags'], defaultVisible: true },
  { key: 'status', label: 'records.col.status', fields: ['status'], defaultVisible: true },
  { key: 'source', label: 'records.col.source', fields: ['source'], defaultVisible: false },
];

export function defaultHiddenLeadColumns(): LeadColumnKey[] {
  return LEAD_COLUMNS.filter((column) => !column.defaultVisible).map((column) => column.key);
}

/** Hides or restores a column. The fixed name column cannot be hidden. */
export function toggleLeadColumn(hidden: readonly LeadColumnKey[], key: LeadColumnKey): LeadColumnKey[] {
  if (LEAD_COLUMNS.find((column) => column.key === key)?.fixed === true) return [...hidden];
  return hidden.includes(key) ? hidden.filter((value) => value !== key) : [...hidden, key];
}

export function leadColumnLabel(key: LeadColumnKey): MessageId {
  return LEAD_COLUMNS.find((column) => column.key === key)?.label ?? 'records.col.displayName';
}

/** `true` when this row withholds the column. Decided PER ROW: two rows on a page can be two programmes. */
export function leadCellWithheld(row: Lead, key: LeadColumnKey): boolean {
  const column = LEAD_COLUMNS.find((spec) => spec.key === key);
  return column?.fields.some((field) => isWithheld(row, field)) ?? false;
}

/** Columns withheld on at least one row held: the header carries a lock; each cell still asks its row. */
export function lockedLeadColumns(rows: readonly Lead[]): LeadColumnKey[] {
  return LEAD_COLUMNS.filter((column) => rows.some((row) => leadCellWithheld(row, column.key))).map(
    (column) => column.key,
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type LeadFilterKey = 'status' | 'owner' | 'source';

export interface LeadFilter {
  readonly key: LeadFilterKey;
  readonly label: MessageId;
  /** Wire values, exactly as `listLeads` declares them. */
  readonly options: readonly string[];
  /** The Contact properties it reads. A filter on a withheld one is `400 field_withheld`. */
  readonly fields: readonly string[];
}

export const LEAD_FILTERS: readonly LeadFilter[] = [
  { key: 'status', label: 'records.filter.status', options: LEAD_STATUSES, fields: ['status'] },
  { key: 'owner', label: 'records.filter.owner', options: ['me', 'unassigned'], fields: ['ownerUserId', 'owner'] },
  { key: 'source', label: 'records.filter.source', options: ContactSource.options, fields: ['source'] },
];

export type LeadFilterState = Readonly<Record<LeadFilterKey, readonly string[]>>;

export const NO_LEAD_FILTERS: LeadFilterState = { status: [], owner: [], source: [] };

export function toggleLeadFilter(state: LeadFilterState, key: LeadFilterKey, value: string): LeadFilterState {
  const current = state[key];
  return { ...state, [key]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] };
}

export function activeLeadFilters(state: LeadFilterState): LeadFilterKey[] {
  return LEAD_FILTERS.filter((filter) => state[filter.key].length > 0).map((filter) => filter.key);
}

/** Filters the caller cannot use: their field is withheld on a row they were served, or named by a refusal. */
export function lockedLeadFilters(withheld: ReadonlySet<string>): LeadFilterKey[] {
  return LEAD_FILTERS.filter((filter) => filter.fields.some((field) => withheld.has(field))).map(
    (filter) => filter.key,
  );
}

/** The Contact properties a `field_withheld` refusal names, through the parameter it names. */
export function withheldFromLeadError(error: RecordsError | null): string[] {
  return (error?.details ?? [])
    .filter((detail) => detail.code === 'field_withheld')
    .flatMap((detail) => LEAD_FILTERS.find((filter) => filter.key === detail.path)?.fields ?? [detail.path]);
}

export function leadOptionLabel(key: LeadFilterKey, value: string): MessageId {
  switch (key) {
    case 'status':
      return statusLabel(value);
    case 'source':
      return sourceLabel(value);
    case 'owner':
      return `records.owner.filter.${value}` as MessageId;
  }
}

// ---------------------------------------------------------------------------
// Sort, the views and the queries
// ---------------------------------------------------------------------------

export const LEAD_SORTS: readonly LeadSort[] = LeadSort.options;

const SORT_LABELS: Readonly<Record<LeadSort, MessageId>> = {
  '-createdAt': 'accounts.sort.newest',
  createdAt: 'accounts.sort.oldest',
  '-updatedAt': 'accounts.sort.updatedRecent',
  updatedAt: 'accounts.sort.updatedOldest',
};

export function leadSortLabel(sort: LeadSort): MessageId {
  return SORT_LABELS[sort];
}

/** Everything about the list but the search box, replaced as one value (`useKeysetList` compares it by identity). */
export interface LeadView {
  readonly filters: LeadFilterState;
  readonly sort: LeadSort;
  /** Rows per page, 25, 50 or 100 (P04's footer, T-0133): the read's `limit`. */
  readonly pageSize?: number;
  /** Custom-field filters (T-0091); absent while the feature is off. */
  readonly custom?: CustomFilters;
}

export const DEFAULT_LEAD_VIEW: LeadView = { filters: NO_LEAD_FILTERS, sort: '-createdAt' };

/** One Kanban column: the board's view, read for one lead stage alone. */
export interface LeadColumnView extends LeadView {
  readonly column: LeadStatus;
}

/** P04 offers 25, 50 and 100; the list asks for the first. */
export const LEAD_PAGE_SIZE = 25;

function base(q: string, view: LeadView): LeadListQuery {
  const { filters } = view;
  const source = filters.source.filter((value): value is ContactSource =>
    (ContactSource.options as readonly string[]).includes(value),
  );
  const trimmed = q.trim();
  return {
    ...(trimmed === '' ? {} : { q: trimmed }),
    ...(filters.owner.length > 0 ? { owner: filters.owner } : {}),
    ...(source.length > 0 ? { source } : {}),
    ...(view.custom === undefined ? {} : { custom: view.custom }),
    sort: view.sort,
  };
}

/** The table's `listLeads` query. No scope, ever; a status filter names lead stages only. */
export function toLeadQuery(q: string, view: LeadView, cursor?: string): LeadListQuery {
  const status = view.filters.status.filter(isLeadStatus);
  return {
    ...base(q, view),
    ...(status.length > 0 ? { status } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    limit: view.pageSize ?? LEAD_PAGE_SIZE,
  };
}

/**
 * A Kanban column's query: the board's search, owner and source, and its OWN
 * stage as the only status ("one Kanban column is one value", listLeads). The
 * status filter is the board's columns, so it is not applied twice.
 */
export function toColumnQuery(q: string, view: LeadColumnView, cursor?: string): LeadListQuery {
  return {
    ...base(q, view),
    status: [view.column],
    ...(cursor === undefined ? {} : { cursor }),
    limit: LEAD_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------
// The Kanban move
// ---------------------------------------------------------------------------

/**
 * The move a drop or a "Move to" choice asks for, or `null` when there is
 * nothing to write: the card's own column, a target that is not a lead stage,
 * or a row whose `status` the caller cannot see. EXACTLY `{ version, status }`,
 * with the version this screen was last served for the row.
 */
export function moveBody(row: Lead, target: string): MoveLeadBody | null {
  if (!isLeadStatus(target) || isWithheld(row, 'status') || row.status === target) return null;
  return { version: row.version, status: target };
}

/** Where a move could take this card: every lead stage but its own. */
export function moveTargets(row: Lead): LeadStatus[] {
  return LEAD_STATUSES.filter((status) => status !== row.status);
}

/** Takes a row out of a column's rows. */
export function withoutRow(rows: readonly Lead[], id: string): Lead[] {
  return rows.filter((row) => row.id !== id);
}

/** Puts a row at the top of a column (where a moved card lands), never twice. */
export function withRowFirst(rows: readonly Lead[], row: Lead): Lead[] {
  return [row, ...withoutRow(rows, row.id)];
}

/** What a refused move says, as an alert beside the board. Read by `code` and `details[].code`, never `message`. */
export function moveRefusal(error: RecordsError): MessageId {
  if (error.code === 'not_permitted') return 'leads.move.error.notPermitted';
  if (error.code === 'stale_write') return 'leads.move.error.stale';
  return `records.error.${error.code}` as MessageId;
}

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------

/**
 * Whether the row offers convert. Convert writes `status` and `accountId`, so
 * a row that withholds either says up front the caller cannot (D-L86). A lead
 * already `qualified` and linked is converted: the action would be a repeat.
 * Every other row offers it, and the API's 403 is the gate (D-L84).
 */
export function convertOffer(row: Lead): 'offer' | 'locked' | 'converted' {
  if (isWithheld(row, 'status') || isWithheld(row, 'accountId')) return 'locked';
  if (row.status === 'qualified' && row.accountId !== null && row.accountId !== undefined) return 'converted';
  return 'offer';
}

/** The accounts a picker may offer this lead: its own programme's only (an account elsewhere is 404). */
export function pickableAccounts(accounts: readonly Account[], programmeId: string): Account[] {
  return accounts.filter((account) => account.programmeId === programmeId);
}

export const NEW_ACCOUNT_NAME_MAX = 200;

/**
 * The new account's name, prefilled from a READABLE `companyName` (the
 * contract allows it). A withheld one is never read, whatever the row holds.
 */
export function suggestedAccountName(lead: Lead): string {
  if (isWithheld(lead, 'companyName')) return '';
  return typeof lead.companyName === 'string' ? lead.companyName.slice(0, NEW_ACCOUNT_NAME_MAX) : '';
}

export type ConvertMode = 'existing' | 'new';

export type ConvertInvalid = 'leads.convert.invalid.account' | 'accounts.invalid.name';

/**
 * convertContact's body: the version this screen was served, plus EXACTLY one
 * of `accountId` or `newAccount`. Never a status, a programme or a contact id.
 */
export function convertBody(
  lead: Lead,
  choice: { readonly mode: ConvertMode; readonly accountId: string | null; readonly name: string },
): { ok: true; body: ConvertLeadBody } | { ok: false; invalid: ConvertInvalid } {
  if (choice.mode === 'existing') {
    if (choice.accountId === null || choice.accountId === '') return { ok: false, invalid: 'leads.convert.invalid.account' };
    return { ok: true, body: { version: lead.version, accountId: choice.accountId } };
  }
  const name = choice.name.trim();
  if (name === '' || name.length > NEW_ACCOUNT_NAME_MAX) return { ok: false, invalid: 'accounts.invalid.name' };
  return { ok: true, body: { version: lead.version, newAccount: { name } } };
}

/**
 * The body the next press sends. After a LOST answer it is exactly the body
 * that was lost — the server may have applied it, and only the identical
 * request is answered as the exact repeat (200, nothing written, D-L86). Any
 * other press builds a fresh body from what is chosen.
 */
export function convertAttempt(
  lost: ConvertLeadBody | null,
  lead: Lead,
  choice: { readonly mode: ConvertMode; readonly accountId: string | null; readonly name: string },
): { ok: true; body: ConvertLeadBody } | { ok: false; invalid: ConvertInvalid } {
  if (lost !== null) return { ok: true, body: lost };
  return convertBody(lead, choice);
}

/**
 * Whether an answer leaves the convert in doubt. Only a lost answer does: the
 * choices are then held as sent until a definitive answer or the sheet closes.
 */
export function convertInDoubt(error: RecordsError): boolean {
  return error.code === 'network';
}

/**
 * What a refused convert says, inside the sheet. `already_linked` is a reason
 * a person can act on, so it has its own sentence, never the generic one.
 * A `network` failure is not a refusal: the answer may have been lost after
 * the server committed, so it says that a retry is safe (the exact repeat).
 */
export function convertRefusal(error: RecordsError, mode: ConvertMode): MessageId {
  if (hasDetail(error, 'already_linked')) return 'leads.convert.error.already_linked';
  if (hasDetail(error, 'field_not_editable')) return 'accounts.error.fieldNotEditable';
  switch (error.code) {
    case 'network':
      return 'leads.convert.lost';
    case 'not_permitted':
      return 'leads.convert.error.notPermitted';
    case 'stale_write':
      return 'leads.convert.error.stale';
    case 'not_found':
      return mode === 'existing' ? 'leads.convert.error.accountNotFound' : 'records.error.not_found';
    case 'validation_failed':
      return 'accounts.error.notAccepted';
    default:
      return `records.error.${error.code}` as MessageId;
  }
}

// ---------------------------------------------------------------------------
// Refusals of the list read
// ---------------------------------------------------------------------------

/**
 * What a failed list read says. `status` withheld anywhere refuses every read
 * of this view (listLeads IS a filter on status), and that is not the
 * caller's filter to remove, so it has its own sentence.
 */
export function leadListError(error: RecordsError | null): MessageId {
  const refusedCustom = listRefusalId(error);
  if (refusedCustom !== null) return refusedCustom;
  if (error?.details?.some((detail) => detail.code === 'field_withheld' && detail.path === 'status') === true) {
    return 'leads.error.statusWithheld';
  }
  if (hasDetail(error, 'field_withheld')) return 'accounts.error.fieldWithheld';
  return `records.error.${error?.code ?? 'network'}` as MessageId;
}
