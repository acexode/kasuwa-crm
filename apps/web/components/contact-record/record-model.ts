import type { MessageId } from '@kasuwa/i18n/bundle';
import { ConsentState, ContactSource, ContactStatus, PreferredChannel, type Phone } from '../../lib/records-api';
import type { ChangeValue, ContactRecord } from '../../lib/contact-record-api';
import { editedKeys, onlyEdited, rebaseEdits, type RebasedEdits, type ValueView } from '../record/record-core';

/**
 * The pure half of the P05 contact record (T-0062): which fields are drawn and
 * how, and what an edit sends. Times, timeline paging, refusals and reads are
 * the shared `../record/record-core.ts`. No React and no
 * `'use client'`, so it is unit-tested directly and a server component may
 * import it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DESIGN AND THE CONTRACT DISAGREE, THE CONTRACT WINS (D-L69)
 *
 *   - Details are Contact properties. P05/01's DOB, addresses, NIN and the
 *     "layout builder" sections have no field behind them and are not drawn.
 *   - A withheld field keeps its place with a lock (P05/05); a `null` is "Not
 *     set". They are never the same thing.
 *   - The timeline draws `before` and `after` ONLY when the API sent them
 *     (D-L72). Phones, emails, names, the owner and the account are shown by
 *     field name alone, and nothing here reconstructs a value for them.
 *   - Codes are copy: a status, a source, a channel, a consent state and a
 *     language are drawn by their translated labels, never as the code.
 * ---------------------------------------------------------------------------
 */

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** The details panel's rows, in order. `owner` is drawn by name. */
export type DetailKey =
  | 'givenNames'
  | 'familyName'
  | 'companyName'
  | 'phones'
  | 'emails'
  | 'status'
  | 'owner'
  | 'source'
  | 'tags'
  | 'preferredLanguage'
  | 'preferredChannel'
  | 'state'
  | 'lga'
  | 'whatsappOptIn'
  | 'consentState'
  | 'dnd';

export interface DetailSpec {
  readonly key: DetailKey;
  readonly label: MessageId;
}

export const DETAILS: readonly DetailSpec[] = [
  { key: 'givenNames', label: 'record.field.givenNames' },
  { key: 'familyName', label: 'record.field.familyName' },
  { key: 'companyName', label: 'record.field.companyName' },
  { key: 'phones', label: 'records.col.phones' },
  { key: 'emails', label: 'records.col.emails' },
  { key: 'status', label: 'records.col.status' },
  { key: 'owner', label: 'records.col.ownerUserId' },
  { key: 'source', label: 'records.col.source' },
  { key: 'tags', label: 'records.col.tags' },
  { key: 'preferredLanguage', label: 'record.field.preferredLanguage' },
  { key: 'preferredChannel', label: 'records.col.preferredChannel' },
  { key: 'state', label: 'record.field.state' },
  { key: 'lga', label: 'record.field.lga' },
  { key: 'whatsappOptIn', label: 'records.col.whatsappOptIn' },
  { key: 'consentState', label: 'records.col.consentState' },
  { key: 'dnd', label: 'records.filter.dnd' },
];

/**
 * `true` when field security withheld `field` from this caller. `owner` goes
 * with `ownerUserId` and `account` with `accountId`: the contract withholds
 * each pair together, and either name in `withheldFields` locks both.
 */
export function isLocked(record: ContactRecord, field: string): boolean {
  const pair: Readonly<Record<string, string>> = {
    owner: 'ownerUserId',
    ownerUserId: 'owner',
    account: 'accountId',
    accountId: 'account',
  };
  const partner = pair[field];
  return record.withheldFields.includes(field) || (partner !== undefined && record.withheldFields.includes(partner));
}

/** The label of a Contact field as the timeline names it (`field_changed.field`). */
export function fieldLabel(field: string): MessageId | null {
  const labels: Readonly<Record<string, MessageId>> = {
    displayName: 'records.col.displayName',
    givenNames: 'record.field.givenNames',
    familyName: 'record.field.familyName',
    companyName: 'record.field.companyName',
    phones: 'records.col.phones',
    emails: 'records.col.emails',
    ownerUserId: 'records.col.ownerUserId',
    accountId: 'records.col.accountId',
    status: 'records.col.status',
    source: 'records.col.source',
    preferredChannel: 'records.col.preferredChannel',
    preferredLanguage: 'record.field.preferredLanguage',
    whatsappOptIn: 'records.col.whatsappOptIn',
    state: 'record.field.state',
    lga: 'record.field.lga',
    tags: 'records.col.tags',
    consentState: 'records.col.consentState',
  };
  return labels[field] ?? null;
}

/** Languages the record names by a translated label. Anything else is drawn as the tag it is. */
export const LANGUAGE_CODES = ['en', 'fr', 'ha', 'ig', 'yo', 'pcm', 'sw', 'ar'] as const;

export function languageLabel(tag: string): MessageId | null {
  const lower = tag.toLowerCase();
  const base = lower.split('-')[0] ?? lower;
  const known = (LANGUAGE_CODES as readonly string[]).find((code) => code === lower || code === base);
  return known === undefined ? null : (`record.language.${known}` as MessageId);
}

const EMPTY: ValueView = { kind: 'empty' };

function codeLabel(prefix: string, codes: readonly string[], value: string): ValueView {
  return codes.includes(value) ? { kind: 'label', id: `${prefix}.${value}` as MessageId } : { kind: 'text', text: value };
}

/**
 * How one Contact value is drawn: a translated label for a code, record text
 * for free text, "not set" for nothing. The same rules for the details panel
 * and for a timeline item's `before` and `after`.
 */
export function describeValue(field: string, value: ChangeValue | undefined): ValueView {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'boolean') {
    if (field === 'dnd') return { kind: 'label', id: value ? 'records.filter.dnd.on' : 'records.filter.dnd.off' };
    return { kind: 'label', id: value ? 'records.filter.wa.on' : 'records.filter.wa.off' };
  }
  if (Array.isArray(value)) {
    const items = value.filter((item) => item !== '');
    return items.length === 0 ? EMPTY : { kind: 'text', text: items.join(', ') };
  }
  if (value === '') return EMPTY;
  switch (field) {
    case 'status':
      return codeLabel('records.status', ContactStatus.options, value);
    case 'source':
      return codeLabel('records.source', ContactSource.options, value);
    case 'preferredChannel':
      return codeLabel('records.channel', PreferredChannel.options, value);
    case 'consentState':
      return codeLabel('records.consent', ConsentState.options, value);
    case 'preferredLanguage': {
      const id = languageLabel(value);
      return id === null ? { kind: 'text', text: value } : { kind: 'label', id };
    }
    default:
      return { kind: 'text', text: value };
  }
}

/**
 * E.164 grouped for reading: `+2348030000001` -> `+234 803 000 0001`. Nigerian
 * numbers get the national grouping; anything else is shown as stored.
 */
export function formatPhone(e164: string): string {
  const nigerian = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return nigerian === null ? e164 : `+234 ${nigerian[1]} ${nigerian[2]} ${nigerian[3]}`;
}

/** Up to two initials, for the decorative avatar (always aria-hidden). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => /^\p{L}/u.test(part))
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

// ---------------------------------------------------------------------------
// The full edit: a draft of strings, and a body of only what changed
// ---------------------------------------------------------------------------

export type EditKey =
  | 'displayName'
  | 'givenNames'
  | 'familyName'
  | 'phones'
  | 'emails'
  | 'tags'
  | 'preferredLanguage'
  | 'preferredChannel'
  | 'state'
  | 'lga'
  | 'consentState'
  | 'whatsappOptIn';

/**
 * What the sheet offers, in order. Not here, on purpose: `programmeId` (never
 * a field edit), `source` and `dnd` (how a contact arrived and the NCC
 * register are not hand edits), `phoneNetwork` (server-derived), and
 * `status`, the owner and the account, which have their own controls or none.
 */
export const EDIT_KEYS: readonly EditKey[] = [
  'displayName',
  'givenNames',
  'familyName',
  'phones',
  'emails',
  'tags',
  'preferredLanguage',
  'preferredChannel',
  'state',
  'lga',
  'consentState',
  'whatsappOptIn',
];

export type Draft = Partial<Record<EditKey, string | boolean>>;

/** The keys a caller may be offered on this record: never one it cannot read. */
export function editableKeys(record: ContactRecord): EditKey[] {
  return EDIT_KEYS.filter((key) => !isLocked(record, key) && (key in record || key === 'displayName'));
}

export function draftOf(record: ContactRecord): Draft {
  const draft: Draft = {};
  for (const key of editableKeys(record)) {
    switch (key) {
      case 'phones':
        draft.phones = (record.phones ?? []).map((phone) => phone.e164).join('\n');
        break;
      case 'emails':
        draft.emails = (record.emails ?? []).join('\n');
        break;
      case 'tags':
        draft.tags = (record.tags ?? []).join(', ');
        break;
      case 'whatsappOptIn':
        draft.whatsappOptIn = record.whatsappOptIn === true;
        break;
      default: {
        const value = record[key];
        draft[key] = typeof value === 'string' ? value : '';
      }
    }
  }
  return draft;
}

function lines(text: string, separator: RegExp): string[] {
  return text
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, index) => JSON.stringify(item) === JSON.stringify(b[index]));
}

/**
 * `updateContact`'s body: `version` plus ONLY the fields whose value differs
 * from the record as served. A readable but read-only field sent unchanged is
 * `403 field_not_editable` for the whole edit, so "send the form" is not an
 * option. `null` for nothing set is how a nullable field is cleared; `""`
 * never goes on the wire.
 */
export function changedFields(record: ContactRecord, draft: Draft): { body: Record<string, unknown>; invalid: EditKey[] } {
  const body: Record<string, unknown> = {};
  const invalid: EditKey[] = [];
  for (const key of editableKeys(record)) {
    const value = draft[key];
    if (value === undefined) continue;
    switch (key) {
      case 'displayName': {
        const text = String(value).trim();
        if (text === '') invalid.push(key);
        else if (text !== record.displayName) body.displayName = text;
        break;
      }
      case 'phones': {
        const served = record.phones ?? [];
        const next: Phone[] = lines(String(value), /\n/).map((entry) => {
          const e164 = entry.replace(/[\s-]/g, '');
          return { type: served.find((phone) => phone.e164 === e164)?.type ?? 'mobile', e164 };
        });
        if (!sameList(next, served)) body.phones = next;
        break;
      }
      case 'emails': {
        const next = lines(String(value), /[\n,]/);
        if (!sameList(next, record.emails ?? [])) body.emails = next;
        break;
      }
      case 'tags': {
        const next = lines(String(value), /,/);
        if (!sameList(next, record.tags ?? [])) body.tags = next;
        break;
      }
      case 'whatsappOptIn':
        if (value !== (record.whatsappOptIn === true)) body.whatsappOptIn = value === true;
        break;
      case 'consentState': {
        const next = String(value);
        if (next !== '' && next !== record.consentState) body.consentState = next;
        break;
      }
      default: {
        const text = String(value).trim();
        const next = text === '' ? null : text;
        const served = record[key] ?? null;
        if (next !== served) body[key] = next;
      }
    }
  }
  return { body, invalid };
}

/** What the person changed in a draft seeded from `base`. */
export function editedDraftKeys(base: ContactRecord, draft: Draft): EditKey[] {
  return editedKeys(draftOf(base), draft, editableKeys(base));
}

/**
 * The draft after a 409 re-read: `fresh` as served, with the person's edits
 * (against `opened`, the record the draft was seeded from) laid back on top.
 * See `rebaseEdits`: untouched fields take the fresh value and are not sent.
 */
export function rebaseDraft(opened: ContactRecord, fresh: ContactRecord, draft: Draft): RebasedEdits<EditKey, Draft> {
  return rebaseEdits(draftOf(opened), draftOf(fresh), draft, editableKeys(fresh));
}

/**
 * The full edit's body against `base`, the record the draft is now seeded
 * from: its `version` plus what changed, cut down to the fields the person
 * edited. `body` is `null` when that is nothing.
 */
export function saveBody(base: ContactRecord, draft: Draft): { body: Record<string, unknown> | null; invalid: EditKey[] } {
  const edited = editedDraftKeys(base, draft);
  const { body, invalid } = changedFields(base, draft);
  return {
    body: onlyEdited({ ...body, version: base.version }, edited),
    invalid: invalid.filter((key) => edited.includes(key)),
  };
}

/** The status codes the inline edit offers: exactly the contract's set. */
export const STATUS_CODES: readonly string[] = ContactStatus.options;
