import type { MessageId } from '@kasuwa/i18n/bundle';
import type { ContactMerge, DuplicateSet } from '../../lib/duplicates-api';
import type { RecordsError } from '../../lib/records-api';

/**
 * The pure half of P28's landing (T-0097): which two contacts a set offers, how
 * long a 429 asks the screen to wait, what state a merge in the history is in
 * and how a refusal of a merge or an undo reads. No React and no `'use client'`,
 * so it is unit-tested directly and a server component may import it. The
 * comparison and the merge view's state are `merge-model.ts`.
 */


// ---------------------------------------------------------------------------
// Sets: the pair a merge is of
// ---------------------------------------------------------------------------

/** A set has no id of its own: its members and what they match on identify it. */
export function setKey(set: DuplicateSet): string {
  return `${set.matchOn}:${set.contacts.map((contact) => contact.id).join(',')}`;
}

/** Picks a contact, or drops it. Picking is free; `pairOf` decides when it is a merge. */
export function togglePick(picks: readonly string[], id: string): readonly string[] {
  return picks.includes(id) ? picks.filter((held) => held !== id) : [...picks, id];
}

/**
 * The two contacts a set offers to merge, in served order, or `null`. A set of
 * two is its own pair; in a larger set exactly two must be picked (pairwise,
 * D-L146). A pick of someone not in the set is ignored.
 */
export function pairOf(set: DuplicateSet, picks: readonly string[]): readonly [string, string] | null {
  const ids = set.contacts.map((contact) => contact.id);
  if (ids.length === 2) return [ids[0] ?? '', ids[1] ?? ''];
  const chosen = ids.filter((id) => picks.includes(id));
  return chosen.length === 2 ? [chosen[0] ?? '', chosen[1] ?? ''] : null;
}

// ---------------------------------------------------------------------------
// The throttle (D-L163, D-L165)
// ---------------------------------------------------------------------------

/** After this many refusals in a row the screen stops asking by itself and offers a button. */
export const MAX_AUTO_RETRIES = 3;
const DEFAULT_WAIT_SECONDS = 30;
const LONGEST_WAIT_SECONDS = 600;

/** How long a 429 asks the screen to wait: `Retry-After`, else `retryAt`, else a modest default; never absurd. */
export function waitSeconds(error: RecordsError, now: number): number {
  let seconds = error.retryAfterSeconds;
  if (seconds === undefined && error.retryAt !== undefined) {
    const at = Date.parse(error.retryAt);
    if (!Number.isNaN(at)) seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(Math.max(seconds ?? DEFAULT_WAIT_SECONDS, 1), LONGEST_WAIT_SECONDS);
}

export interface ThrottleStep {
  /** The wait the API asked for, for the sentence. */
  readonly seconds: number;
  /** The earliest moment the next scan may be sent (epoch milliseconds). */
  readonly until: number;
  /** The screen has stopped asking by itself: the button is the way on. */
  readonly manual: boolean;
}

/** What one more 429 in a row asks of the screen. `streak` counts it: the first refusal is 1. */
export function throttleStep(streak: number, error: RecordsError, now: number): ThrottleStep {
  const seconds = waitSeconds(error, now);
  return { seconds, until: now + seconds * 1000, manual: streak >= MAX_AUTO_RETRIES };
}

// ---------------------------------------------------------------------------
// The history: what state a merge is in
// ---------------------------------------------------------------------------

export type MergeState = 'open' | 'expired' | 'undone';

/** Undone beats expired; expired is the server's word (`expired`) or the clock's, whichever came first. */
export function mergeState(merge: ContactMerge, now: number, expired: ReadonlySet<string> = new Set()): MergeState {
  if (merge.undoneAt !== null) return 'undone';
  if (expired.has(merge.id) || Date.parse(merge.undoUntil) <= now) return 'expired';
  return 'open';
}

// ---------------------------------------------------------------------------
// Words for what the API refuses
// ---------------------------------------------------------------------------

export interface Refusal {
  /** The sentence: always by `code`, never by `message`, and never a raw code. */
  readonly message: MessageId;
  /** What the screen does about it besides saying so. */
  readonly effect: 'none' | 'sets' | 'preview' | 'fields' | 'expired' | 'dead';
  /** For `fields`: the choices the API refused, by field. */
  readonly fields: readonly string[];
}

function refusedFields(error: RecordsError): string[] {
  return (error.details ?? [])
    .filter((detail) => detail.code === 'field_not_editable' && detail.path.startsWith('choices.'))
    .map((detail) => detail.path.slice('choices.'.length));
}

function own(code: RecordsError['code']): MessageId {
  return `records.error.${code}` as MessageId;
}

/** `createContactMerge` refused (I9). */
export function mergeRefusal(error: RecordsError): Refusal {
  switch (error.code) {
    case 'already_merged':
      // The pair is gone: the sets are read again.
      return { message: own(error.code), effect: 'sets', fields: [] };
    case 'stale_write':
      // Someone saved first: the preview is read again, and the next merge carries its versions.
      return { message: 'duplicates.error.staleWrite', effect: 'preview', fields: [] };
    case 'not_found':
      // Rights lost or the contact merged away meanwhile: the one generic not-found (CLAUDE.md 6.4), and the sets move on.
      return { message: own(error.code), effect: 'sets', fields: [] };
    case 'not_permitted': {
      const fields = refusedFields(error);
      return fields.length > 0
        ? { message: 'duplicates.error.fieldNotEditable', effect: 'fields', fields }
        : { message: own(error.code), effect: 'none', fields: [] };
    }
    default:
      return { message: own(error.code), effect: 'none', fields: [] };
  }
}

/** `undoContactMerge` refused (I10): a refused undo is never sent again. */
export function undoRefusal(error: RecordsError): Refusal {
  switch (error.code) {
    case 'undo_expired':
      // The server's clock wins over the browser's.
      return { message: own(error.code), effect: 'expired', fields: [] };
    case 'already_merged':
      return { message: 'duplicates.error.alreadyMerged', effect: 'dead', fields: [] };
    case 'not_found':
      // The merger lost `contact.write` (D-L163): the generic words, nothing about permission.
      return { message: own(error.code), effect: 'dead', fields: [] };
    case 'not_permitted':
      return { message: own(error.code), effect: 'dead', fields: [] };
    default:
      // A dropped connection or a 5xx may be tried again.
      return { message: own(error.code), effect: 'none', fields: [] };
  }
}
