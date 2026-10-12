import type { MessageId } from '@kasuwa/i18n/bundle';
import { withheld, type ActivityBucket, type MyActivity } from '../../lib/activities-api';
import type { RecordsError } from '../../lib/records-api';
import { localToUtc } from '../record/record-core';

/**
 * The pure half of P07 (T-0083): bucket state, the calendar's windows, the
 * snooze presets, the meeting-time rules and the reschedule form's edits. No
 * React and no `'use client'`, so it is unit-tested directly and a server
 * component may import it.
 *
 * EVERY DATE HERE IS THE BROWSER'S. A local midnight is `new Date(y, m, d)`,
 * which the browser resolves in its own zone — the zone the person reads
 * their clock in, and the one `browserTimeZone()` sends. No module names a
 * zone; the server never guesses one.
 */

export const BUCKETS: readonly ActivityBucket[] = ['overdue', 'today', 'upcoming'];

export function bucketLabel(bucket: ActivityBucket): MessageId {
  return `activities.bucket.${bucket}` as MessageId;
}

// ---------------------------------------------------------------------------
// Buckets: three keyset lists, each its own read (D-P13: no count anywhere)
// ---------------------------------------------------------------------------

export interface BucketState {
  readonly phase: 'loading' | 'ready' | 'error';
  readonly rows: readonly MyActivity[];
  readonly cursor: string | null;
  readonly loadingMore: boolean;
  readonly moreError: RecordsError | null;
  readonly error: RecordsError | null;
}

export const LOADING_BUCKET: BucketState = {
  phase: 'loading',
  rows: [],
  cursor: null,
  loadingMore: false,
  moreError: null,
  error: null,
};

/** A first page arrived: it replaces whatever the bucket held (a re-read starts from the top). */
export function bucketLoaded(page: { readonly data: readonly MyActivity[]; readonly nextCursor: string | null }): BucketState {
  return { phase: 'ready', rows: page.data, cursor: page.nextCursor, loadingMore: false, moreError: null, error: null };
}

/** A later page: appended in served order, a row already held never repeated. */
export function bucketAppended(
  state: BucketState,
  page: { readonly data: readonly MyActivity[]; readonly nextCursor: string | null },
): BucketState {
  const held = new Set(state.rows.map((row) => row.id));
  return {
    ...state,
    rows: [...state.rows, ...page.data.filter((row) => !held.has(row.id))],
    cursor: page.nextCursor,
    loadingMore: false,
    moreError: null,
  };
}

/**
 * A failed first read is an error, never "nothing due". A failed RE-read
 * keeps the rows already drawn (they were true a moment ago) only while they
 * are still there to be retried; a bucket that never loaded is an error.
 */
export function bucketFailed(state: BucketState, error: RecordsError): BucketState {
  return state.phase === 'ready' ? state : { ...LOADING_BUCKET, phase: 'error', error };
}

export type TasksView = 'loading' | 'caught-up' | 'buckets';

/** "All caught up" only when every bucket READ and every one is empty: loading or failed is never that. */
export function tasksView(states: Readonly<Record<ActivityBucket, BucketState>>): TasksView {
  const all = BUCKETS.map((bucket) => states[bucket]);
  if (all.every((state) => state.phase === 'loading')) return 'loading';
  if (all.every((state) => state.phase === 'ready' && state.rows.length === 0)) return 'caught-up';
  return 'buckets';
}

// ---------------------------------------------------------------------------
// Local days, in the browser's zone
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** listCalendar's longest window: six weeks, a month grid. */
export const MAX_WINDOW_DAYS = 42;
/** A meeting's longest span. */
export const MAX_MEETING_MS = 24 * HOUR_MS;

/** Local midnight starting the day `at` falls on. */
export function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/** Local midnight `days` calendar days after the day `at` falls on (a day is not always 24 hours). */
export function addDays(at: Date, days: number): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DD` of the local day `at` falls on. */
export function dayKey(at: Date): string {
  return `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The `datetime-local` value of an instant, in the browser's zone. Empty for no time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${dayKey(at)}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export { localToUtc };

// ---------------------------------------------------------------------------
// The calendar's window: local midnights, never more than 42 days
// ---------------------------------------------------------------------------

export type CalendarRange = 'week' | 'month';

export interface CalendarView {
  readonly range: CalendarRange;
  /** Any instant inside the period shown; normalised to a local midnight. */
  readonly anchor: Date;
}

export interface WindowDays {
  readonly from: Date;
  readonly to: Date;
  /** Every local day in [from, to), in order. */
  readonly days: readonly Date[];
}

/** Monday is the first day of the week, as the design draws it. */
export function weekStart(at: Date): Date {
  const day = startOfDay(at);
  return addDays(day, -((day.getDay() + 6) % 7));
}

/**
 * The days a view shows and the window it reads. A week is seven local days
 * from Monday's midnight; a month is its own days, first midnight to the next
 * month's first midnight — at most 31 days, inside the contract's 42.
 */
export function windowOf(view: CalendarView): WindowDays {
  const from = view.range === 'week' ? weekStart(view.anchor) : new Date(view.anchor.getFullYear(), view.anchor.getMonth(), 1);
  const to = view.range === 'week' ? addDays(from, 7) : new Date(from.getFullYear(), from.getMonth() + 1, 1);
  const days: Date[] = [];
  for (let day = from; day < to && days.length < MAX_WINDOW_DAYS; day = addDays(day, 1)) {
    days.push(day);
  }
  return { from, to, days };
}

/** The window on the wire: UTC with a `Z`, refused here rather than sent if it is ever over 42 days. */
export function wireWindow(window: WindowDays): { from: string; to: string } | null {
  const span = window.to.getTime() - window.from.getTime();
  if (span <= 0 || span > MAX_WINDOW_DAYS * DAY_MS) return null;
  return { from: window.from.toISOString(), to: window.to.toISOString() };
}

/** The previous or next period. A month steps to the first of the month, so January 31st never skips February. */
export function shiftView(view: CalendarView, direction: -1 | 1): CalendarView {
  if (view.range === 'week') return { ...view, anchor: addDays(weekStart(view.anchor), 7 * direction) };
  return { ...view, anchor: new Date(view.anchor.getFullYear(), view.anchor.getMonth() + direction, 1) };
}

/** Blank cells before a month's first day, so the grid lines up under Monday..Sunday. */
export function leadingBlanks(window: WindowDays): number {
  const first = window.days[0];
  return first === undefined ? 0 : (first.getDay() + 6) % 7;
}

/** Where an item sits on the calendar: a task's due time, a meeting's start. `null` when it has none or it is withheld. */
export function eventStart(item: MyActivity): string | null {
  const field = item.type === 'meeting' ? 'startsAt' : 'dueAt';
  if (withheld(item, field)) return null;
  const value = item.type === 'meeting' ? item.startsAt : item.dueAt;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** `true` when an item has every time it needs to be placed: a withheld time is never guessed. */
export function placeable(item: MyActivity): boolean {
  if (eventStart(item) === null) return false;
  if (item.type !== 'meeting') return true;
  return !withheld(item, 'endsAt') && typeof item.endsAt === 'string';
}

/**
 * Items by the local day they start on, in served order. One that began
 * before the window (a meeting still running) sits on the first day; one
 * with a withheld or missing time is not placed at all.
 */
export function placeEvents(items: readonly MyActivity[], window: WindowDays): Map<string, MyActivity[]> {
  const byDay = new Map<string, MyActivity[]>(window.days.map((day) => [dayKey(day), []]));
  const first = window.days[0];
  for (const item of items) {
    const start = eventStart(item);
    if (start === null || !placeable(item) || first === undefined) continue;
    const at = new Date(start);
    const key = at < window.from ? dayKey(first) : dayKey(at);
    byDay.get(key)?.push(item);
  }
  return byDay;
}

// ---------------------------------------------------------------------------
// Snooze: presets, each a later time than now and than the task's own
// ---------------------------------------------------------------------------

export type SnoozePreset = 'hour' | 'tomorrow' | 'nextWeek';

export interface SnoozeOption {
  readonly preset: SnoozePreset;
  readonly at: Date;
}

export function snoozeLabel(preset: SnoozePreset): MessageId {
  return `activities.snooze.${preset}` as MessageId;
}

/**
 * An hour from now (to the next minute), tomorrow at 09:00 and next Monday at
 * 09:00, local. A preset that is not after now, or that IS the task's current
 * time, is not offered: sending an unchanged time is not a change (D-L102).
 */
export function snoozeOptions(now: Date, dueAt: string | null): SnoozeOption[] {
  const hour = new Date(Math.ceil((now.getTime() + HOUR_MS) / 60_000) * 60_000);
  const tomorrow = addDays(now, 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = addDays(weekStart(now), 7);
  monday.setHours(9, 0, 0, 0);
  const current = dueAt === null ? Number.NaN : Date.parse(dueAt);
  const options: SnoozeOption[] = [
    { preset: 'hour', at: hour },
    { preset: 'tomorrow', at: tomorrow },
    { preset: 'nextWeek', at: monday },
  ];
  return options.filter((option) => option.at.getTime() > now.getTime() && option.at.getTime() !== current);
}

// ---------------------------------------------------------------------------
// Meeting times: checked before anything is sent
// ---------------------------------------------------------------------------

export type MeetingRule = 'required' | 'invalid_range' | 'too_long';

/** The contract's rules, judged locally: both times, the end after the start (equal is not after), at most 24 h. */
export function meetingRule(startsAt: string | null, endsAt: string | null): MeetingRule | null {
  if (startsAt === null || endsAt === null) return 'required';
  const span = Date.parse(endsAt) - Date.parse(startsAt);
  if (!(span > 0)) return 'invalid_range';
  if (span > MAX_MEETING_MS) return 'too_long';
  return null;
}

export function meetingRuleLabel(rule: MeetingRule): MessageId {
  return `activities.meeting.error.${rule}` as MessageId;
}

// ---------------------------------------------------------------------------
// Reschedule: version plus only what changed, rebased after a 409 (D-L102)
// ---------------------------------------------------------------------------

export type TimeKey = 'dueAt' | 'startsAt' | 'endsAt';

export type TimeForm = Partial<Record<TimeKey, string>>;

export function timeKeys(type: MyActivity['type']): readonly TimeKey[] {
  return type === 'meeting' ? ['startsAt', 'endsAt'] : ['dueAt'];
}

/** The form an item opens with: its served times, as the browser's wall clock. */
export function timeForm(item: MyActivity): TimeForm {
  const form: TimeForm = {};
  for (const key of timeKeys(item.type)) {
    form[key] = withheld(item, key) ? '' : toLocalInput(item[key]);
  }
  return form;
}

/** The keys whose typed value differs from what the form was seeded with. */
export function changedKeys(seed: TimeForm, typed: TimeForm, keys: readonly TimeKey[]): TimeKey[] {
  return keys.filter((key) => (seed[key] ?? '') !== (typed[key] ?? ''));
}

export type RescheduleOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'invalid'; readonly field: TimeKey; readonly message: MessageId }
  | { readonly kind: 'send'; readonly body: Readonly<Record<string, string | number>> };

/**
 * What a save sends: `version` plus each changed time in UTC, nothing else.
 * A meeting's rules are judged on the RESULT (the times on screen), so a bad
 * move is a message here and never a request.
 */
export function rescheduleBody(type: MyActivity['type'], version: number, seed: TimeForm, typed: TimeForm): RescheduleOutcome {
  const keys = timeKeys(type);
  const changed = changedKeys(seed, typed, keys);
  if (changed.length === 0) return { kind: 'unchanged' };
  const utc: Partial<Record<TimeKey, string | null>> = {};
  for (const key of keys) {
    const value = typed[key] ?? '';
    utc[key] = value === '' ? null : localToUtc(value);
    if (value !== '' && utc[key] === null) return { kind: 'invalid', field: key, message: 'record.error.invalid' };
  }
  if (type === 'meeting') {
    const rule = meetingRule(utc.startsAt ?? null, utc.endsAt ?? null);
    if (rule !== null) {
      const field: TimeKey = rule === 'required' && (utc.startsAt ?? null) === null ? 'startsAt' : 'endsAt';
      return { kind: 'invalid', field, message: meetingRuleLabel(rule) };
    }
  } else if ((utc.dueAt ?? null) === null) {
    return { kind: 'invalid', field: 'dueAt', message: 'activities.reschedule.error.dueRequired' };
  }
  const body: Record<string, string | number> = { version };
  for (const key of changed) {
    const value = utc[key];
    if (typeof value === 'string') body[key] = value;
  }
  return { kind: 'send', body };
}

export interface Rebased {
  readonly seed: TimeForm;
  readonly typed: TimeForm;
  readonly conflicts: readonly TimeKey[];
}

/**
 * After a 409 and a re-read: the form becomes the FRESH item with the
 * person's edits laid back on top. A field both people changed keeps what was
 * typed and is flagged; a field the person never touched takes the fresh
 * value and is never sent (D-L102).
 */
export function rebaseTimes(seed: TimeForm, typed: TimeForm, fresh: TimeForm, keys: readonly TimeKey[]): Rebased {
  const edited = changedKeys(seed, typed, keys);
  const next: TimeForm = { ...fresh };
  for (const key of edited) next[key] = typed[key] ?? '';
  return {
    seed: fresh,
    typed: next,
    conflicts: edited.filter((key) => (seed[key] ?? '') !== (fresh[key] ?? '')),
  };
}

/** The highest version seen per activity: an answer that arrives late never winds one back. */
export function withVersion(known: Readonly<Record<string, number>>, id: string, version: number): Record<string, number> {
  const held = known[id];
  return held !== undefined && held >= version ? { ...known } : { ...known, [id]: version };
}

/** The version to write an item with: what the list served, or a later one a write answered. */
export function versionOf(item: MyActivity, known: Readonly<Record<string, number>>): number {
  return Math.max(item.version, known[item.id] ?? 0);
}
