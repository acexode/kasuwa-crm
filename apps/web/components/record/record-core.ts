import type { MessageId } from '@kasuwa/i18n/bundle';
import type { RecordsError, RecordsResult, RecordsScreenErrorCode } from '../../lib/records-api';
import { dateFormatter, tidyMonth } from '../../lib/date-locale';

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

/** Day first on a 24-hour clock in every English (`lib/date-locale.ts`, T-0143). */
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return dateFormatter(locale, options);
}

/**
 * A moment with its zone named, as the designs write it: "20 Oct 15:00 WAT",
 * with the year only when it is not this year ("3 Sep 2025 09:30 WAT"). A
 * bare time is one somebody acts on in the wrong hour; rosters span WAT, EAT
 * and SAST.
 */
export function formatDateTime(locale: string, iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const year = at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const };
  const day = tidyMonth(locale, formatter(locale, { day: 'numeric', month: 'short', ...year }).format(at));
  const zone = zoneName(locale, at);
  return [day, formatTime(locale, iso), zone].filter((part) => part !== '').join(' ');
}

/** The time of day with the zone it is in ("09:12 WAT"), for "last synced". */
export function formatClock(locale: string, at: Date): string {
  const zone = zoneName(locale, at);
  const clock = formatTime(locale, at.toISOString());
  return zone === '' ? clock : `${clock} ${zone}`;
}

/**
 * The time of day on a 24-hour clock ("14:02"), as the P05 timeline draws it:
 * the day is the group heading above it. In the browser's zone.
 */
export function formatTime(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return formatter(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

/**
 * The zones Kasuwa's desks sit in, by their English long name, as the people
 * there write them. `Intl` abbreviates Africa/Lagos as "GMT+1" in English;
 * every Lagos desk, and the P05 design, says "WAT" (T-0134). Matched on the
 * long name so every IANA zone in a region maps, not one city.
 */
const AFRICAN_ZONES: Readonly<Record<string, string>> = {
  // Engines differ: Node's ICU says "West Africa Standard Time", Chromium's "West Africa Time".
  'West Africa Standard Time': 'WAT',
  'West Africa Time': 'WAT',
  'West Africa Summer Time': 'WAST',
  'Central Africa Time': 'CAT',
  'East Africa Time': 'EAT',
  'South Africa Standard Time': 'SAST',
  'South Africa Time': 'SAST',
  'Greenwich Mean Time': 'GMT',
};

/** The browser's zone as people there name it ("WAT", "EAT", "SAST"), for the timeline's header. */
export function zoneName(locale: string, at: Date = new Date()): string {
  const long = new Intl.DateTimeFormat('en', { timeZoneName: 'long' })
    .formatToParts(at)
    .find((part) => part.type === 'timeZoneName')?.value;
  const known = long === undefined ? undefined : AFRICAN_ZONES[long];
  if (known !== undefined) return known;
  return formatter(locale, { timeZoneName: 'short' }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? '';
}

/** A local calendar day ("2026-10-20"), to group a timeline by day in the browser's zone. */
export function dayKey(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** How a day group is headed: today, yesterday, or the date ("Mon 28 Sep"). */
export type DayHeading = { readonly kind: 'today' } | { readonly kind: 'yesterday' } | { readonly kind: 'date'; readonly text: string };

export function dayHeading(locale: string, key: string, now: Date = new Date()): DayHeading {
  if (key === dayKey(now.toISOString())) return { kind: 'today' };
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKey(yesterday.toISOString())) return { kind: 'yesterday' };
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const at = new Date(year, month - 1, day);
  const sameYear = year === now.getFullYear();
  const text = formatter(locale, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(at);
  // English joins the weekday with a comma ("Tue, 20 Oct"); P05 writes "Tue 20 Oct".
  return { kind: 'date', text: tidyMonth(locale, /^en(-|$)/i.test(locale) ? text.replace(',', '') : text) };
}

/** A date alone ("12 Aug 2019"), for Created. */
export function formatDate(locale: string, iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return tidyMonth(locale, formatter(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(at));
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
// Ids from the server, before they become a link or a read
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `true` for a well-formed uuid. A served id is checked before it is put in
 * an `href` or sent back to the API: a malformed one is never turned into a
 * path (`map` is a real API path, and `../` is a different one).
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** `/<base>/<id>` for a well-formed id, encoded; `null` for anything else, which is then drawn unlinked. */
export function recordHref(base: '/accounts' | '/contacts', id: unknown): string | null {
  return isUuid(id) ? `${base}/${encodeURIComponent(id)}` : null;
}

// ---------------------------------------------------------------------------
// Edits after a 409: rebase what the person typed, never resend the rest
// ---------------------------------------------------------------------------

/** The keys whose typed value differs from what the form was seeded with: the person's edits. */
export function editedKeys<K extends string>(
  seed: Partial<Record<K, unknown>>,
  typed: Partial<Record<K, unknown>>,
  keys: readonly K[],
): K[] {
  return keys.filter((key) => seed[key] !== typed[key]);
}

export interface RebasedEdits<K extends string, F> {
  /** The fresh record's form with the person's edits laid back on top. */
  readonly form: F;
  /** What the person edited, among the keys still editable on the fresh record. */
  readonly edited: readonly K[];
  /** Edited keys that somebody else ALSO changed meanwhile: the person's value is kept, and flagged. */
  readonly conflicts: readonly K[];
}

/**
 * After a 409 the record is read again. The form must become the FRESH record
 * with only the person's edits re-applied — never the old form against the
 * new version, which would send every untouched field's old value and undo
 * somebody else's save (a deleted phone number coming back). `keys` are the
 * fields still editable on the fresh record; an edit to one that has since
 * been withheld is dropped, because nothing may be sent for a withheld field.
 */
export function rebaseEdits<K extends string, F extends Partial<Record<K, unknown>>>(
  seed: F,
  fresh: F,
  typed: F,
  keys: readonly K[],
): RebasedEdits<K, F> {
  const edited = editedKeys(seed, typed, keys);
  const form: F = { ...fresh };
  for (const key of edited) {
    form[key] = typed[key] as F[K];
  }
  return { form, edited, conflicts: edited.filter((key) => seed[key] !== fresh[key]) };
}

/** A write body cut down to `version` and the keys the person edited. Nothing they did not touch goes. */
export function onlyEdited<B extends { readonly version: number }>(body: B, edited: readonly string[]): B | null {
  const kept = Object.fromEntries(Object.entries(body).filter(([key]) => key === 'version' || edited.includes(key)));
  return Object.keys(kept).length > 1 ? (kept as B) : null;
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
