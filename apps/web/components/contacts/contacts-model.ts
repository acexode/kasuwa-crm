import type { MessageId } from '@kasuwa/i18n/bundle';
import type { CustomFilters } from '../../lib/custom-values-filters';
import {
  ContactSource,
  ContactStatus,
  type Contact,
  type ContactListQuery,
} from '../../lib/records-api';

/**
 * The pure half of P04/02 (T-0042): columns, filters, the list state and the
 * phone format. No React and no `'use client'`, so it is unit-tested directly
 * and a server component may import it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DESIGN AND THE CONTRACT DISAGREE, THE CONTRACT WINS
 *
 *   - Columns are Contact properties. P04's "Last activity" and "Engagement"
 *     have no field behind them and are not drawn.
 *   - Filters are `listContacts` parameters. P04's "Preferred language" and
 *     "Consent status" chips have no parameter and are not drawn.
 *   - No totals and no "Page X of Y" (D-P13): "Load more" on `nextCursor`.
 *   - Ids are not names (D-L64). Owner and account are drawn as neutral
 *     "assigned" / "linked" labels until T-0043 adds a scoped name lookup.
 * ---------------------------------------------------------------------------
 */

/** A column is a Contact property, by type. */
export type ColumnKey =
  | 'displayName'
  | 'phones'
  | 'whatsappOptIn'
  | 'emails'
  | 'accountId'
  | 'ownerUserId'
  | 'tags'
  | 'status'
  | 'source'
  | 'state'
  | 'consentState'
  | 'preferredChannel';

export interface ColumnSpec {
  readonly key: ColumnKey;
  readonly label: MessageId;
  /** Shown before anyone touches the chooser. */
  readonly defaultVisible: boolean;
  /** The name column: always shown, never offered for hiding. */
  readonly fixed?: true;
}

/** P04/02's order, then the optional columns the chooser can add. */
export const COLUMNS: readonly ColumnSpec[] = [
  { key: 'displayName', label: 'records.col.displayName', defaultVisible: true, fixed: true },
  { key: 'phones', label: 'records.col.phones', defaultVisible: true },
  { key: 'whatsappOptIn', label: 'records.col.whatsappOptIn', defaultVisible: true },
  { key: 'emails', label: 'records.col.emails', defaultVisible: true },
  { key: 'accountId', label: 'records.col.accountId', defaultVisible: true },
  { key: 'ownerUserId', label: 'records.col.ownerUserId', defaultVisible: true },
  { key: 'tags', label: 'records.col.tags', defaultVisible: true },
  { key: 'status', label: 'records.col.status', defaultVisible: true },
  { key: 'source', label: 'records.col.source', defaultVisible: false },
  { key: 'state', label: 'records.col.state', defaultVisible: false },
  { key: 'consentState', label: 'records.col.consentState', defaultVisible: false },
  { key: 'preferredChannel', label: 'records.col.preferredChannel', defaultVisible: false },
];

export function defaultHiddenColumns(): ColumnKey[] {
  return COLUMNS.filter((column) => !column.defaultVisible).map((column) => column.key);
}

/** Hides or restores a column. The fixed name column cannot be hidden. */
export function toggleColumn(hidden: readonly ColumnKey[], key: ColumnKey): ColumnKey[] {
  if (COLUMNS.find((column) => column.key === key)?.fixed === true) {
    return [...hidden];
  }
  return hidden.includes(key) ? hidden.filter((value) => value !== key) : [...hidden, key];
}

/**
 * Columns withheld on at least one row of what is loaded. Locks are PER ROW —
 * field security is per programme, and two rows on one page can come from two
 * programmes — so this only decides whether the header and the chooser carry a
 * lock; every cell still asks its own row.
 */
export function lockedColumns(rows: readonly Contact[]): ColumnKey[] {
  return COLUMNS.filter((column) => rows.some((row) => row.withheldFields.includes(column.key))).map(
    (column) => column.key,
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type FilterKey = 'status' | 'source' | 'owner' | 'dnd' | 'whatsappOptIn';

export interface FilterSpec {
  readonly key: FilterKey;
  readonly label: MessageId;
  /** Wire values, exactly as `listContacts` declares them. */
  readonly options: readonly string[];
  /** A boolean parameter takes one value; an array parameter takes several. */
  readonly single: boolean;
}

export const FILTERS: readonly FilterSpec[] = [
  { key: 'status', label: 'records.filter.status', options: ContactStatus.options, single: false },
  { key: 'source', label: 'records.filter.source', options: ContactSource.options, single: false },
  { key: 'owner', label: 'records.filter.owner', options: ['me', 'unassigned'], single: false },
  { key: 'dnd', label: 'records.filter.dnd', options: ['true', 'false'], single: true },
  { key: 'whatsappOptIn', label: 'records.filter.whatsappOptIn', options: ['true', 'false'], single: true },
];

export type FilterState = Readonly<Record<FilterKey, readonly string[]>>;

/** Everything about the list but the search box, replaced as one value (`useKeysetList` compares it by identity). */
export interface ContactView {
  readonly filters: FilterState;
  /** Custom-field filters (T-0091); empty while the feature is off. */
  readonly custom: CustomFilters;
  /** The one CSV import whose contacts are listed (T-0096, I9); absent for the whole list. */
  readonly importId?: string;
}

export const NO_FILTERS: FilterState = { status: [], source: [], owner: [], dnd: [], whatsappOptIn: [] };

/** Toggles one option. A single-valued filter replaces its value, or clears it. */
export function toggleFilter(state: FilterState, key: FilterKey, value: string): FilterState {
  const spec = FILTERS.find((filter) => filter.key === key);
  const current = state[key];
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : spec?.single === true
      ? [value]
      : [...current, value];
  return { ...state, [key]: next };
}

export function activeFilterKeys(state: FilterState): FilterKey[] {
  return FILTERS.filter((filter) => state[filter.key].length > 0).map((filter) => filter.key);
}

/** Message id for one option's label. */
export function optionLabel(key: FilterKey, value: string): MessageId {
  switch (key) {
    case 'status':
      return `records.status.${value}` as MessageId;
    case 'source':
      return `records.source.${value}` as MessageId;
    case 'owner':
      return `records.owner.filter.${value}` as MessageId;
    case 'dnd':
      return value === 'true' ? 'records.filter.dnd.on' : 'records.filter.dnd.off';
    case 'whatsappOptIn':
      return value === 'true' ? 'records.filter.wa.on' : 'records.filter.wa.off';
  }
}

/** The `listContacts` query for a search box and a filter state. No scope, ever. */
export function toListQuery(q: string, filters: FilterState, cursor?: string, custom?: CustomFilters, importId?: string): ContactListQuery {
  const status = filters.status.filter((value): value is ContactStatus =>
    (ContactStatus.options as readonly string[]).includes(value),
  );
  const source = filters.source.filter((value): value is ContactSource =>
    (ContactSource.options as readonly string[]).includes(value),
  );
  const flag = (values: readonly string[]): boolean | undefined =>
    values[0] === undefined ? undefined : values[0] === 'true';
  const dnd = flag(filters.dnd);
  const whatsappOptIn = flag(filters.whatsappOptIn);
  const trimmed = q.trim();
  return {
    ...(trimmed === '' ? {} : { q: trimmed }),
    ...(filters.owner.length > 0 ? { owner: filters.owner } : {}),
    ...(status.length > 0 ? { status } : {}),
    ...(source.length > 0 ? { source } : {}),
    ...(dnd === undefined ? {} : { dnd }),
    ...(whatsappOptIn === undefined ? {} : { whatsappOptIn }),
    ...(custom === undefined ? {} : { custom }),
    ...(importId === undefined ? {} : { importId }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: PAGE_SIZE,
  };
}

/** P04 offers 25, 50 and 100; the list asks for the first. */
export const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// The list state and the display formats, shared with every P04 list
// ---------------------------------------------------------------------------

export { formatPhone, formatSyncedAt, initials, listState, type ListState } from '../records/list-model';
