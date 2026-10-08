import type { MessageId } from '@kasuwa/i18n/bundle';
import { isAccountWithheld, type Account } from '../../lib/accounts-api';
import { hasDetail, type Contact, type RecordsError, type RecordsResult } from '../../lib/records-api';
import { tierLabel } from '../accounts/accounts-model';
import type { ValueView } from '../record/record-core';

/**
 * The pure half of the P05 account record, frame 04 (T-0063): which fields
 * are drawn and how, the hierarchy walk, and what a contacts read means. No
 * React and no `'use client'`, so it is unit-tested directly and a server
 * component may import it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DESIGN AND THE CONTRACT DISAGREE, THE CONTRACT WINS (D-L69, D-L98)
 *
 *   - Details are Account properties. Frame 04's Health, pipeline rollups and
 *     money, RC number, TIN, billing and buying roles have no field: not drawn.
 *   - A withheld field keeps its place with a lock; a `null` is "Not set".
 *   - The hierarchy is the one `parentAccountId` link, walked UP. Nothing
 *     serves an account's children (T-0118), so the tree's lower half is not
 *     drawn.
 *   - The contacts grid shows no count (D-P13), and a role that cannot see a
 *     contact's account link is told so, never shown "no contacts".
 *   - The timeline's field changes are by name only (D-L78).
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export type AccountDetailKey = 'industry' | 'tier' | 'phones' | 'owner' | 'tags' | 'state' | 'lga';

export interface AccountDetailSpec {
  readonly key: AccountDetailKey;
  readonly label: MessageId;
}

/** The details panel's rows, in frame 04's order. The name is the heading; the parent is the breadcrumb. */
export const ACCOUNT_DETAILS: readonly AccountDetailSpec[] = [
  { key: 'industry', label: 'accounts.col.industry' },
  { key: 'tier', label: 'accounts.col.tier' },
  { key: 'phones', label: 'records.col.phones' },
  { key: 'owner', label: 'records.col.ownerUserId' },
  { key: 'tags', label: 'records.col.tags' },
  { key: 'state', label: 'record.field.state' },
  { key: 'lga', label: 'record.field.lga' },
];

/** `true` when field security withheld `field`. The contract withholds `owner` and `ownerUserId` together. */
export function isLocked(row: Account, field: string): boolean {
  const partner: Readonly<Record<string, string>> = { owner: 'ownerUserId', ownerUserId: 'owner' };
  const other = partner[field];
  return isAccountWithheld(row, field) || (other !== undefined && isAccountWithheld(row, other));
}

/** A free-text or coded Account value as the details panel draws it. Lists and the owner are drawn by the screen. */
export function describeAccountValue(field: 'industry' | 'tier' | 'state' | 'lga', row: Account): ValueView {
  const value = row[field];
  if (value === null || value === undefined || value === '') return { kind: 'empty' };
  return field === 'tier' ? { kind: 'label', id: tierLabel(value) } : { kind: 'text', text: value };
}

/** The label of an Account field as the timeline names it (`AccountFieldChangedItem.field`). */
export function accountFieldLabel(field: string): MessageId | null {
  const labels: Readonly<Record<string, MessageId>> = {
    name: 'accounts.field.name',
    ownerUserId: 'records.col.ownerUserId',
    industry: 'accounts.col.industry',
    tier: 'accounts.col.tier',
    tags: 'records.col.tags',
    phones: 'records.col.phones',
    state: 'record.field.state',
    lga: 'record.field.lga',
    parentAccountId: 'account.field.parentAccountId',
  };
  return labels[field] ?? null;
}

// ---------------------------------------------------------------------------
// The hierarchy (D-L74, D-L98)
// ---------------------------------------------------------------------------

/** A hierarchy is at most five levels (D-L74): the record and four above it. */
export const MAX_ANCESTORS = 4;

/**
 * Why the walk stopped. `root`: an account with no parent. `locked`: a
 * `parentAccountId` withheld from the caller, so nothing above it is read.
 * `limit`: four ancestors read, whatever the data claims. `cycle`: the data
 * named an account already in the chain (the database forbids it; the walk
 * must not loop on the day it is wrong). `failed`: a read did not answer.
 */
export type WalkEnd = 'root' | 'locked' | 'limit' | 'cycle' | 'failed';

export interface Hierarchy {
  /** The ancestors read, ROOT FIRST; the record itself is not here. */
  readonly ancestors: readonly Account[];
  readonly end: WalkEnd;
}

function parentOf(row: Account): { readonly locked: true } | { readonly locked: false; readonly id: string | null } {
  if (isAccountWithheld(row, 'parentAccountId')) return { locked: true };
  return { locked: false, id: typeof row.parentAccountId === 'string' ? row.parentAccountId : null };
}

/**
 * Walks `parentAccountId` up from `record` with `read` (getAccount): each
 * ancestor read once, four at most, stopping at a lock, a cycle or a failure.
 * Sequential by necessity — each answer names the next id.
 */
export async function walkAncestors(
  record: Account,
  read: (id: string) => Promise<RecordsResult<Account>>,
): Promise<Hierarchy> {
  const seen = new Set<string>([record.id]);
  const upward: Account[] = [];
  let current = record;
  for (;;) {
    const parent = parentOf(current);
    if (parent.locked) return { ancestors: [...upward].reverse(), end: 'locked' };
    if (parent.id === null) return { ancestors: [...upward].reverse(), end: 'root' };
    if (seen.has(parent.id)) return { ancestors: [...upward].reverse(), end: 'cycle' };
    if (upward.length >= MAX_ANCESTORS) return { ancestors: [...upward].reverse(), end: 'limit' };
    const result = await read(parent.id);
    if (!result.ok) return { ancestors: [...upward].reverse(), end: 'failed' };
    seen.add(result.value.id);
    upward.push(result.value);
    current = result.value;
  }
}

// ---------------------------------------------------------------------------
// The contacts grid (listAccountContacts)
// ---------------------------------------------------------------------------

/**
 * Three answers that must never look alike: the caller may not see which
 * contacts are linked (`withheld`, a 400 `field_withheld`), there are none
 * (`ready` with no rows), or the read failed (`error`).
 */
export type ContactsPhase = 'loading' | 'ready' | 'withheld' | 'error';

export interface ContactsState {
  readonly phase: ContactsPhase;
  readonly rows: readonly Contact[];
  readonly cursor: string | null;
  readonly loadingMore: boolean;
  readonly moreError: RecordsError | null;
}

export const NO_CONTACTS: ContactsState = { phase: 'loading', rows: [], cursor: null, loadingMore: false, moreError: null };

/** What the first contacts page means. A `field_withheld` refusal is an answer, not a blip: it is never retried. */
export function contactsOutcome(result: RecordsResult<{ data: readonly Contact[]; nextCursor: string | null }>): ContactsState {
  if (result.ok) return { ...NO_CONTACTS, phase: 'ready', rows: result.value.data, cursor: result.value.nextCursor };
  if (result.error.code === 'validation_failed' && hasDetail(result.error, 'field_withheld')) {
    return { ...NO_CONTACTS, phase: 'withheld' };
  }
  return { ...NO_CONTACTS, phase: 'error' };
}
