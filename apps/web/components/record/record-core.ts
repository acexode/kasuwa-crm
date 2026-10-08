import type { MessageId } from '@kasuwa/i18n/bundle';
import type { RecordsError, RecordsResult, RecordsScreenErrorCode } from '../../lib/records-api';

/**
 * The pure half every P05 record shares — the contact (T-0062) and the
 * account (T-0063): how a time is shown, how timeline pages join, which
 * activity versions the screen may write with, and what a refused write or a
 * failed read means. No React and no `'use client'`, so it is unit-tested
 * directly and a server component may import it.
 *
 * Fix a record behaviour here, once, rather than in each screen.
 */

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * How one value is drawn: a translated label, record text (shown verbatim,
 * never parsed), or nothing set.
 */
export type ValueView =
  | { readonly kind: 'label'; readonly id: MessageId }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'empty' };

// ---------------------------------------------------------------------------
// Times. Stored in UTC; shown in the browser's zone, which is the one the
// person reads their clock in. BPO rosters span WAT, EAT and SAST.
// ---------------------------------------------------------------------------

function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

export function formatDateTime(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return formatter(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}

export function formatClock(locale: string, at: Date): string {
  return formatter(locale, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(at);
}

/** The browser's zone as the locale abbreviates it ("GMT+1", "WAT"), for the timeline's header. */
export function zoneName(locale: string, at: Date = new Date()): string {
  return formatter(locale, { timeZoneName: 'short' }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? '';
}

/**
 * A `datetime-local` value ("2026-10-09T15:00") is wall-clock time in the
 * browser's zone; the contract wants UTC with a `Z`. `null` for anything that
 * does not name a real minute.
 */
export function localToUtc(local: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (match === null) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const at = new Date(year, month - 1, day, hour, minute);
  if (Number.isNaN(at.getTime()) || at.getMonth() !== month - 1 || at.getDate() !== day) return null;
  return at.toISOString();
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

/** What a record's timeline column holds, in memory only (D-L64). */
export interface TimelineState<Item> {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly items: readonly Item[];
  readonly cursor: string | null;
  readonly loadingOlder: boolean;
  readonly olderError: RecordsError | null;
}

export function noTimeline<Item>(): TimelineState<Item> {
  return { phase: 'loading', items: [], cursor: null, loadingOlder: false, olderError: null };
}

interface Identified {
  readonly id: string;
}

/** "Load older": the page appended, any item already on screen not repeated. */
export function appendPage<Item extends Identified>(items: readonly Item[], page: { readonly data: readonly Item[] }): Item[] {
  const seen = new Set(items.map((item) => item.id));
  return [...items, ...page.data.filter((item) => !seen.has(item.id))];
}

/**
 * After a write, the newest page is read again and laid over the top: what
 * the write added appears first, items it changed take their new state, and
 * older pages already loaded stay where they are. The cursor is NOT taken
 * from the fresh page — the one already held still points past the oldest
 * item on screen.
 */
export function mergeHead<Item extends Identified>(items: readonly Item[], fresh: { readonly data: readonly Item[] }): Item[] {
  const head = new Set(fresh.data.map((item) => item.id));
  return [...fresh.data, ...items.filter((item) => !head.has(item.id))];
}

interface ActivityLike {
  readonly type: string;
  readonly activityId?: string;
}

/** Changes one activity item in place, as completing a task does (it never adds one). */
export function withCompleted<Item extends ActivityLike>(items: readonly Item[], activityId: string, completedAt: string | null): Item[] {
  return items.map((item) => (item.type === 'activity' && item.activityId === activityId ? { ...item, completedAt } : item));
}

/** Activity versions, by activity id: the only ones a screen may send back on updateActivity. */
export type ActivityVersions = Readonly<Record<string, number>>;

/**
 * Records versions the server served — on a timeline item (T-0080) or in a
 * 201/200 — and keeps the highest seen for each activity. A version only ever
 * goes up, so an answer that arrives late can never wind one back and turn a
 * fresh write into a stale one.
 */
export function withServedVersions(
  known: ActivityVersions,
  served: readonly { readonly activityId: string; readonly version: number }[],
): ActivityVersions {
  if (served.length === 0) return known;
  const next: Record<string, number> = { ...known };
  for (const { activityId, version } of served) {
    const held = next[activityId];
    if (held === undefined || version > held) next[activityId] = version;
  }
  return next;
}

/** The versions a timeline page carries on its activity items. Items without one carry nothing. */
export function itemVersions(items: readonly unknown[]): { activityId: string; version: number }[] {
  const out: { activityId: string; version: number }[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { type, activityId, version } = item as { type?: unknown; activityId?: unknown; version?: unknown };
    if (type === 'activity' && typeof activityId === 'string' && typeof version === 'number') {
      out.push({ activityId, version });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The copy for a refused write. `records.error.<code>` is the list's; two
 * codes read differently on a record: a 400 is about what was typed, not a
 * search, and a 409 has already been answered by re-reading.
 */
export function writeErrorId(code: RecordsScreenErrorCode): MessageId {
  if (code === 'validation_failed') return 'record.error.invalid';
  if (code === 'stale_write') return 'record.error.stale';
  return `records.error.${code}` as MessageId;
}

/**
 * What a record read means for the screen, on first load and on the re-read
 * after a 409. A 400 for an id from the address bar is "not found". A re-read
 * that fails NEVER leaves the stale record standing as if it were current:
 * gone is the generic not-found, anything else is "did not load".
 */
export type ReadOutcome<T> =
  | { readonly phase: 'ready'; readonly record: T }
  | { readonly phase: 'not-found' }
  | { readonly phase: 'unavailable'; readonly error: RecordsError };

export function readOutcome<T>(result: RecordsResult<T>): ReadOutcome<T> {
  if (result.ok) return { phase: 'ready', record: result.value };
  if (result.error.code === 'not_found' || result.error.code === 'validation_failed') return { phase: 'not-found' };
  return { phase: 'unavailable', error: result.error };
}

/** The screen-level phases of a record. */
export type RecordPhase = 'loading' | 'ready' | 'not-found' | 'unavailable';
