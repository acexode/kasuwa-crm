import type { MessageId } from '@kasuwa/i18n/bundle';
import type { CustomFilters } from '../../lib/custom-values-filters';
import {
  AccountSort,
  AccountTier,
  isAccountWithheld,
  type Account,
  type AccountListQuery,
  type CreateAccountBody,
  type MyProgramme,
  type UpdateAccountBody,
} from '../../lib/accounts-api';
import { hasDetail, type Phone, type PhoneType, type RecordsError } from '../../lib/records-api';
import { editedKeys, onlyEdited, rebaseEdits, type RebasedEdits } from '../record/record-core';

/**
 * The pure half of P04/03 (T-0057): columns, filters, sort, the list query and
 * the create/edit form. No React and no `'use client'`, so it is unit-tested
 * directly and a server component may import it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DESIGN AND THE CONTRACT DISAGREE, THE CONTRACT WINS
 *
 *   - Columns are Account properties. P04's Health has no field (D-L69), and
 *     neither do deal rollups or counts (D-P13): not drawn.
 *   - Filters are `listAccounts` parameters: owner, tier, industry, tag, state,
 *     lga. P04's saved views have no operation: not drawn.
 *   - Sort is `sort`'s enum only — name, created, updated — never tier,
 *     industry or owner, which field security can withhold.
 *   - Search is by name; `q` does not search phones on accounts.
 *   - No Map view (501), no bulk selection, no DND marker on an account's
 *     phones (the contract says a screen must not infer one).
 *   - Ids are not names: the owner's name comes embedded on the row, a
 *     programme's from `listMyProgrammes`. No UUID is ever printed.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** A column is an Account property, by type. */
export type AccountColumnKey = 'name' | 'industry' | 'tier' | 'phones' | 'owner' | 'tags' | 'state' | 'programmeId';

export interface AccountColumn {
  readonly key: AccountColumnKey;
  readonly label: MessageId;
  readonly defaultVisible: boolean;
  /** The Account properties whose withholding locks this column. */
  readonly fields: readonly string[];
  readonly fixed?: true;
}

/**
 * P04/03's order (T-0133): Account, Phone, Industry, Owner — Last activity
 * after it where `last_activity` is on — then Tier, Tags, State, and what the
 * chooser can add. The export's WA and Email columns have no Account property.
 */
export const ACCOUNT_COLUMNS: readonly AccountColumn[] = [
  { key: 'name', label: 'accounts.col.name', defaultVisible: true, fields: ['name'], fixed: true },
  { key: 'phones', label: 'records.col.phones', defaultVisible: true, fields: ['phones'] },
  { key: 'industry', label: 'accounts.col.industry', defaultVisible: true, fields: ['industry'] },
  // The contract withholds `owner` and `ownerUserId` together; either locks it.
  { key: 'owner', label: 'records.col.ownerUserId', defaultVisible: true, fields: ['owner', 'ownerUserId'] },
  { key: 'tier', label: 'accounts.col.tier', defaultVisible: true, fields: ['tier'] },
  { key: 'tags', label: 'records.col.tags', defaultVisible: true, fields: ['tags'] },
  { key: 'state', label: 'records.col.state', defaultVisible: true, fields: ['state'] },
  { key: 'programmeId', label: 'accounts.col.programme', defaultVisible: false, fields: ['programmeId'] },
];

export function defaultHiddenAccountColumns(): AccountColumnKey[] {
  return ACCOUNT_COLUMNS.filter((column) => !column.defaultVisible).map((column) => column.key);
}

/** Hides or restores a column. The fixed name column cannot be hidden. */
export function toggleAccountColumn(hidden: readonly AccountColumnKey[], key: AccountColumnKey): AccountColumnKey[] {
  if (ACCOUNT_COLUMNS.find((column) => column.key === key)?.fixed === true) {
    return [...hidden];
  }
  return hidden.includes(key) ? hidden.filter((value) => value !== key) : [...hidden, key];
}

/** `true` when this row withholds the column. Decided PER ROW: two rows on a page can be two programmes. */
export function cellWithheld(row: Account, key: AccountColumnKey): boolean {
  const column = ACCOUNT_COLUMNS.find((spec) => spec.key === key);
  return column?.fields.some((field) => isAccountWithheld(row, field)) ?? false;
}

/**
 * Whether a 360 px card draws this field: always when it is withheld (a lock
 * says the value exists), and otherwise only when there is something to read.
 * "Unassigned" is something to read; an empty list or a `null` is not.
 */
export function cardShows(row: Account, key: Exclude<AccountColumnKey, 'name'>): boolean {
  if (cellWithheld(row, key)) return true;
  switch (key) {
    case 'owner':
      return true;
    case 'phones':
      return (row.phones ?? []).length > 0;
    case 'tags':
      return (row.tags ?? []).length > 0;
    case 'programmeId':
      return true;
    default:
      return row[key] !== null && row[key] !== undefined;
  }
}

/** Columns withheld on at least one row held: the header and the chooser carry a lock; each cell still asks its row. */
export function lockedAccountColumns(rows: readonly Account[]): AccountColumnKey[] {
  return ACCOUNT_COLUMNS.filter((column) => rows.some((row) => cellWithheld(row, column.key))).map(
    (column) => column.key,
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type AccountFilterKey = 'owner' | 'tier' | 'industry' | 'tag' | 'state' | 'lga';

export interface AccountFilter {
  readonly key: AccountFilterKey;
  readonly label: MessageId;
  /** Wire values to pick from; empty for a free-valued filter, which takes typed text. */
  readonly options: readonly string[];
  /** The Account properties it reads. Filtering on a withheld one is `400 field_withheld`. */
  readonly fields: readonly string[];
  /** The parameter's `maxItems`. */
  readonly maxItems: number;
}

export const ACCOUNT_FILTERS: readonly AccountFilter[] = [
  { key: 'owner', label: 'records.filter.owner', options: ['me', 'unassigned'], fields: ['ownerUserId', 'owner'], maxItems: 20 },
  { key: 'tier', label: 'accounts.col.tier', options: AccountTier.options, fields: ['tier'], maxItems: 10 },
  { key: 'industry', label: 'accounts.col.industry', options: [], fields: ['industry'], maxItems: 20 },
  { key: 'tag', label: 'accounts.filter.tag', options: [], fields: ['tags'], maxItems: 20 },
  { key: 'state', label: 'accounts.filter.state', options: [], fields: ['state'], maxItems: 40 },
  { key: 'lga', label: 'accounts.filter.lga', options: [], fields: ['lga'], maxItems: 40 },
];

export type AccountFilterState = Readonly<Record<AccountFilterKey, readonly string[]>>;

export const NO_ACCOUNT_FILTERS: AccountFilterState = { owner: [], tier: [], industry: [], tag: [], state: [], lga: [] };

/** A free value: 1 to 64 characters on the wire. */
export const FREE_VALUE_MAX = 64;

/** Toggles a listed option on or off. */
export function toggleAccountFilter(state: AccountFilterState, key: AccountFilterKey, value: string): AccountFilterState {
  const current = state[key];
  return { ...state, [key]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] };
}

/**
 * Adds a typed value: trimmed, 1–64 characters, not already there (the server
 * matches case-insensitively, so neither do we twice), and not past the
 * parameter's `maxItems`. Anything else leaves the state as it was.
 */
export function addFreeValue(state: AccountFilterState, key: AccountFilterKey, typed: string): AccountFilterState {
  const value = typed.trim();
  const spec = ACCOUNT_FILTERS.find((filter) => filter.key === key);
  const current = state[key];
  if (
    value === '' ||
    value.length > FREE_VALUE_MAX ||
    current.some((item) => item.toLowerCase() === value.toLowerCase()) ||
    current.length >= (spec?.maxItems ?? 0)
  ) {
    return state;
  }
  return { ...state, [key]: [...current, value] };
}

export function activeAccountFilters(state: AccountFilterState): AccountFilterKey[] {
  return ACCOUNT_FILTERS.filter((filter) => state[filter.key].length > 0).map((filter) => filter.key);
}

/**
 * Filters the caller cannot use: their field is withheld on a row they have
 * been served. The server would answer `400 field_withheld`, so the chip says
 * so up front (a lock) instead of offering a filter that fails.
 */
export function lockedAccountFilters(withheld: ReadonlySet<string>): AccountFilterKey[] {
  return ACCOUNT_FILTERS.filter((filter) => filter.fields.some((field) => withheld.has(field))).map(
    (filter) => filter.key,
  );
}

/** Message id for a listed option's label. Free values are record data and are drawn as typed. */
export function accountOptionLabel(key: AccountFilterKey, value: string): MessageId | null {
  if (key === 'owner') return `records.owner.filter.${value}` as MessageId;
  if (key === 'tier') return tierLabel(value);
  return null;
}

/** `accounts.tier.<code>`: a tier is a code on the wire and a label on screen. */
export function tierLabel(tier: string): MessageId {
  return `accounts.tier.${tier}` as MessageId;
}

// ---------------------------------------------------------------------------
// Sort and the query
// ---------------------------------------------------------------------------

export const ACCOUNT_SORTS: readonly AccountSort[] = AccountSort.options;

const SORT_LABELS: Readonly<Record<AccountSort, MessageId>> = {
  name: 'accounts.sort.nameAsc',
  '-name': 'accounts.sort.nameDesc',
  '-createdAt': 'accounts.sort.newest',
  createdAt: 'accounts.sort.oldest',
  '-updatedAt': 'accounts.sort.updatedRecent',
  updatedAt: 'accounts.sort.updatedOldest',
};

export function sortLabel(sort: AccountSort): MessageId {
  return SORT_LABELS[sort];
}

/** `aria-sort` for the name header: only the name column is ever sortable. */
export function nameAriaSort(sort: AccountSort): 'ascending' | 'descending' | 'none' {
  if (sort === 'name') return 'ascending';
  if (sort === '-name') return 'descending';
  return 'none';
}

/** Everything about the list but the search box, replaced as one value (`useKeysetList` compares it by identity). */
export interface AccountView {
  /** Rows per page, 25, 50 or 100 (P04's footer, T-0133): the read's `limit`. */
  readonly pageSize?: number;
  readonly filters: AccountFilterState;
  readonly sort: AccountSort;
  /** Custom-field filters (T-0091); absent while the feature is off. */
  readonly custom?: CustomFilters;
}

export const DEFAULT_ACCOUNT_VIEW: AccountView = { filters: NO_ACCOUNT_FILTERS, sort: 'name' };

/** P04 offers 25, 50 and 100; the list asks for the first. */
export const ACCOUNT_PAGE_SIZE = 25;

/** The `listAccounts` query for a search box and a view. No scope, ever. */
export function toAccountQuery(q: string, view: AccountView, cursor?: string): AccountListQuery {
  const { filters } = view;
  const tier = filters.tier.filter((value): value is AccountTier => (AccountTier.options as readonly string[]).includes(value));
  const trimmed = q.trim();
  return {
    ...(trimmed === '' ? {} : { q: trimmed }),
    ...(filters.owner.length > 0 ? { owner: filters.owner } : {}),
    ...(tier.length > 0 ? { tier } : {}),
    ...(filters.industry.length > 0 ? { industry: filters.industry } : {}),
    ...(filters.tag.length > 0 ? { tag: filters.tag } : {}),
    ...(filters.state.length > 0 ? { state: filters.state } : {}),
    ...(filters.lga.length > 0 ? { lga: filters.lga } : {}),
    ...(view.custom === undefined ? {} : { custom: view.custom }),
    sort: view.sort,
    ...(cursor === undefined ? {} : { cursor }),
    limit: view.pageSize ?? ACCOUNT_PAGE_SIZE,
  };
}

// ---------------------------------------------------------------------------
// The create / edit sheet
// ---------------------------------------------------------------------------

/** The fields the sheet edits. Owner and parent need pickers that need reads the contract has not got. */
export type AccountFormField = 'programmeId' | 'name' | 'industry' | 'tier' | 'tags' | 'phones' | 'state' | 'lga';

/** What is typed, as typed. */
export interface AccountForm {
  readonly programmeId: string;
  readonly name: string;
  readonly industry: string;
  readonly tier: string;
  readonly tags: string;
  readonly phones: string;
  readonly state: string;
  readonly lga: string;
}

/** Fields an edit may change: never `programmeId` (an account does not move between programmes). */
export const EDITABLE_FIELDS = ['name', 'industry', 'tier', 'tags', 'phones', 'state', 'lga'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const NAME_MAX = 200;
export const TEXT_MAX = 64;

const E164 = /^\+[1-9][0-9]{6,14}$/;

/** A blank create form. With exactly one programme there is nothing to choose. */
export function emptyAccountForm(programmes: readonly MyProgramme[] | null): AccountForm {
  return {
    programmeId: programmes?.length === 1 ? (programmes[0]?.id ?? '') : '',
    name: '',
    industry: '',
    tier: '',
    tags: '',
    phones: '',
    state: '',
    lga: '',
  };
}

/** A row as a form. A withheld field is blank AND locked: the sheet shows a lock, never an input. */
export function accountToForm(row: Account): AccountForm {
  return {
    programmeId: row.programmeId,
    name: row.name,
    industry: row.industry ?? '',
    tier: row.tier ?? '',
    tags: (row.tags ?? []).join(', '),
    phones: (row.phones ?? []).map((phone) => phone.e164).join(', '),
    state: row.state ?? '',
    lga: row.lga ?? '',
  };
}

/** Fields of this row the caller cannot read, so cannot write either (the contract: you cannot clear what you cannot see). */
export function lockedFormFields(row: Account | null): EditableField[] {
  if (row === null) return [];
  return EDITABLE_FIELDS.filter((field) => isAccountWithheld(row, field));
}

/** The values a valid form stands for, normalised as the contract stores them. */
export interface AccountValues {
  readonly name: string;
  readonly industry: string | null;
  readonly tier: AccountTier | null;
  readonly tags: readonly string[];
  readonly phones: readonly string[];
  readonly state: string | null;
  readonly lga: string | null;
}

export type FormErrors = Partial<Record<AccountFormField, MessageId>>;

function list(typed: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of typed.split(',')) {
    const value = part.trim();
    if (value !== '' && !seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      out.push(value);
    }
  }
  return out;
}

/** `+234 803-000 0101` -> `+2348030000101`. Spacing and punctuation go; the number is not guessed at. */
export function normalisePhone(typed: string): string {
  return typed.replace(/[\s().-]/g, '');
}

function optional(typed: string): string | null {
  const value = typed.trim();
  return value === '' ? null : value;
}

/**
 * Checks a form against the contract's request schemas before anything is
 * sent, so a person is told which field to fix rather than "not accepted".
 * `locked` fields are not read at all.
 */
export function validateAccountForm(
  form: AccountForm,
  options: { readonly needProgramme: boolean; readonly locked: readonly EditableField[] },
): { ok: true; values: AccountValues } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {};
  const open = (field: EditableField) => !options.locked.includes(field);

  if (options.needProgramme && form.programmeId === '') errors.programmeId = 'accounts.invalid.programme';

  const name = form.name.trim();
  if (name === '' || name.length > NAME_MAX) errors.name = 'accounts.invalid.name';

  const industry = optional(form.industry);
  if (open('industry') && industry !== null && industry.length > TEXT_MAX) errors.industry = 'accounts.invalid.tooLong';

  const tier = form.tier === '' ? null : AccountTier.safeParse(form.tier);
  const tierValue = tier === null ? null : tier.success ? tier.data : null;

  const tags = list(form.tags);
  if (open('tags') && (tags.length > 50 || tags.some((tag) => tag.length > TEXT_MAX))) errors.tags = 'accounts.invalid.tags';

  const phones = list(form.phones).map(normalisePhone);
  if (open('phones') && (phones.length > 10 || phones.some((phone) => !E164.test(phone)))) {
    errors.phones = 'accounts.invalid.phones';
  }

  const state = optional(form.state);
  if (open('state') && state !== null && state.length > TEXT_MAX) errors.state = 'accounts.invalid.tooLong';
  const lga = optional(form.lga);
  if (open('lga') && lga !== null && lga.length > TEXT_MAX) errors.lga = 'accounts.invalid.tooLong';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, values: { name, industry, tier: tierValue, tags, phones, state, lga } };
}

/** Phones as the contract stores them, keeping the type of a number the row already had (new ones are `work`). */
export function toPhones(numbers: readonly string[], existing: readonly Phone[] = []): Phone[] {
  return numbers.map((e164) => ({ type: existing.find((phone) => phone.e164 === e164)?.type ?? ('work' satisfies PhoneType), e164 }));
}

/**
 * createAccount's body: the name, the TARGET programme when one was chosen,
 * and only the fields that were filled in. Never a server-owned property.
 */
export function createBody(values: AccountValues, programmeId: string): CreateAccountBody {
  return {
    ...(programmeId === '' ? {} : { programmeId }),
    name: values.name,
    ...(values.industry === null ? {} : { industry: values.industry }),
    ...(values.tier === null ? {} : { tier: values.tier }),
    ...(values.tags.length === 0 ? {} : { tags: values.tags }),
    ...(values.phones.length === 0 ? {} : { phones: toPhones(values.phones) }),
    ...(values.state === null ? {} : { state: values.state }),
    ...(values.lga === null ? {} : { lga: values.lga }),
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * updateAccount's body: the `version` this screen was served, plus ONLY what
 * changed — and never a withheld field. Round-tripping every field would send
 * `phones: []` for a row whose phones the caller cannot read, which clears
 * them (the contract refuses it). `null` when nothing changed.
 */
export function updateBody(row: Account, values: AccountValues): UpdateAccountBody | null {
  const open = (field: EditableField) => !isAccountWithheld(row, field);
  const changes: Omit<UpdateAccountBody, 'version'> = {
    ...(values.name !== row.name ? { name: values.name } : {}),
    ...(open('industry') && values.industry !== (row.industry ?? null) ? { industry: values.industry } : {}),
    ...(open('tier') && values.tier !== (row.tier ?? null) ? { tier: values.tier } : {}),
    ...(open('tags') && !sameList(values.tags, row.tags ?? []) ? { tags: values.tags } : {}),
    ...(open('phones') && !sameList(values.phones, (row.phones ?? []).map((phone) => phone.e164))
      ? { phones: toPhones(values.phones, row.phones ?? []) }
      : {}),
    ...(open('state') && values.state !== (row.state ?? null) ? { state: values.state } : {}),
    ...(open('lga') && values.lga !== (row.lga ?? null) ? { lga: values.lga } : {}),
  };
  return Object.keys(changes).length === 0 ? null : { version: row.version, ...changes };
}

/** The fields the caller may edit on this row: never one it cannot read. */
function openFields(row: Account): EditableField[] {
  return EDITABLE_FIELDS.filter((field) => !isAccountWithheld(row, field));
}

/** What the person changed in a form seeded from `base`. */
export function editedAccountFields(base: Account, form: AccountForm): EditableField[] {
  return editedKeys(accountToForm(base), form, openFields(base));
}

/**
 * The form after a 409 re-read: `fresh` as served, with the person's edits
 * (against `opened`, the row the form was seeded from) laid back on top. A
 * field somebody else changed that the person did not touch shows the new
 * value and is not sent; one both changed keeps the person's value and is
 * flagged in `conflicts`.
 */
export function rebaseAccountForm(opened: Account, fresh: Account, form: AccountForm): RebasedEdits<EditableField, AccountForm> {
  return rebaseEdits(accountToForm(opened), accountToForm(fresh), form, openFields(fresh));
}

/**
 * An edit's body against `base`, the row the form is now seeded from: the
 * served `version` plus what changed, cut down to the fields the person
 * edited. `null` when that is nothing.
 */
export function editBody(base: Account, form: AccountForm, values: AccountValues): UpdateAccountBody | null {
  const body = updateBody(base, values);
  return body === null ? null : onlyEdited(body, editedAccountFields(base, form));
}

// ---------------------------------------------------------------------------
// Refusals, read by `code` and `details[].code`, never by the server's message
// ---------------------------------------------------------------------------

/** What a failed list read says. A filter on a withheld field is its own sentence. */
export function listErrorMessage(error: RecordsError | null): MessageId {
  if (hasDetail(error, 'field_withheld')) return 'accounts.error.fieldWithheld';
  return `records.error.${error?.code ?? 'network'}` as MessageId;
}

/** The Account properties a `field_withheld` refusal names, through the filter parameter it names. */
export function withheldFromError(error: RecordsError | null): string[] {
  return (error?.details ?? [])
    .filter((detail) => detail.code === 'field_withheld')
    .flatMap((detail) => ACCOUNT_FILTERS.find((filter) => filter.key === detail.path)?.fields ?? []);
}

/**
 * What a refused save says, inside the sheet. The 403 is the gate (D-L84):
 * the screen cannot know beforehand whether the caller holds `account.write`.
 */
export function refusalMessage(error: RecordsError): MessageId {
  if (hasDetail(error, 'field_not_editable')) return 'accounts.error.fieldNotEditable';
  if (error.code === 'validation_failed') return 'accounts.error.notAccepted';
  return `records.error.${error.code}` as MessageId;
}

/** A programme's name for a row, or `null` when the caller's list does not name it. Never the id. */
export function programmeName(programmes: readonly MyProgramme[] | null, id: string): string | null {
  return programmes?.find((programme) => programme.id === id)?.name ?? null;
}
