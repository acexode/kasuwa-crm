import { numberingLocale } from './numbering';
import type { NotificationFilter, NotificationItem, NotificationKind, NotificationObjectType } from './notifications-api';

/**
 * The notification list as pure functions (T-0101): days, sentences, and what a
 * write does to what is drawn. No React, no `fetch`, no clock but the one
 * passed in, so every rule is a unit test.
 */

// ---------------------------------------------------------------------------
// Days: the READER'S local date (I18), never UTC and never the tenant's
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` of `instant` in `timeZone` (the browser's own zone when omitted). */
export function dayKey(instant: string | number | Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** The calendar day before `day` (`YYYY-MM-DD`): date arithmetic on the label, so a daylight-saving change cannot skip a day. */
export function previousDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const before = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) - 1));
  return before.toISOString().slice(0, 10);
}

export type RelativeDay = 'today' | 'yesterday' | 'other';

export function relativeDay(day: string, today: string): RelativeDay {
  if (day === today) return 'today';
  return day === previousDay(today) ? 'yesterday' : 'other';
}

export interface DayGroup {
  readonly day: string;
  readonly items: readonly NotificationItem[];
}

/** Items grouped by local day, in served order: a day is one group however the pages fell. */
export function groupByDay(items: readonly NotificationItem[], timeZone?: string): readonly DayGroup[] {
  const groups = new Map<string, NotificationItem[]>();
  for (const item of items) {
    const key = dayKey(item.createdAt, timeZone);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups.entries()].map(([day, rows]) => ({ day, items: rows }));
}

/** A day label for a day older than yesterday: Intl, in the page's language and the app's digits. Falls back to the raw date, never to "Invalid Date". */
export function formatDay(day: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(numberingLocale(locale), { timeZone: 'UTC', dateStyle: 'full' }).format(new Date(`${day}T12:00:00Z`));
  } catch {
    return day;
  }
}

/** The time of day of an item, in the reader's zone. */
export function formatTime(instant: string, locale: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(numberingLocale(locale), {
      ...(timeZone === undefined ? {} : { timeZone }),
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(instant));
  } catch {
    return instant;
  }
}

// ---------------------------------------------------------------------------
// Sentences: one translated sentence per kind and object type, names as data
// ---------------------------------------------------------------------------

/** The two ends of a sentence's name slots: private-use marks, split back out after the translator has placed them. */
export const ACTOR_MARK = '';
export const OBJECT_MARK = '';

export type SentenceVariant = 'both' | 'actor' | 'object' | 'none';

/** Which sentence to say, from which names were served. A withheld name is a generic sentence, never a stand-in. */
export function sentenceVariant(item: Pick<NotificationItem, 'actorName' | 'objectName'>): SentenceVariant {
  const actor = item.actorName !== null && item.actorName !== '';
  const object = item.objectName !== null && item.objectName !== '';
  if (actor && object) return 'both';
  if (actor) return 'actor';
  return object ? 'object' : 'none';
}

export const SENTENCE_IDS = {
  'record_assigned.contact': 'notifications.sentence.record_assigned.contact',
  'record_assigned.account': 'notifications.sentence.record_assigned.account',
  'record_assigned.deal': 'notifications.sentence.record_assigned.deal',
  'task_assigned.activity': 'notifications.sentence.task_assigned.activity',
  'import_finished.import': 'notifications.sentence.import_finished.import',
} as const;

export type SentenceKey = keyof typeof SENTENCE_IDS;

export function sentenceKey(kind: NotificationKind, objectType: NotificationObjectType): SentenceKey {
  return `${kind}.${objectType}` as SentenceKey;
}

export interface SentencePart {
  readonly kind: 'text' | 'actor' | 'object';
  readonly text: string;
}

/** Splits a formatted sentence at the name marks, so a name is drawn as its own text node and never parsed. */
export function sentenceParts(formatted: string): readonly SentencePart[] {
  const parts: SentencePart[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') parts.push({ kind: 'text', text: buffer });
    buffer = '';
  };
  for (const character of formatted) {
    if (character === ACTOR_MARK || character === OBJECT_MARK) {
      flush();
      parts.push({ kind: character === ACTOR_MARK ? 'actor' : 'object', text: '' });
    } else {
      buffer += character;
    }
  }
  flush();
  return parts;
}

// ---------------------------------------------------------------------------
// The list and what a write does to it
// ---------------------------------------------------------------------------

export interface ListQuery {
  readonly filter: NotificationFilter;
  readonly kind: NotificationKind | null;
}

/** Page size: the dropdown shows the latest few, the centre pages in twenties. */
export const DROPDOWN_LIMIT = 10;
export const CENTRE_LIMIT = 20;

/** Sets one drawn item's state to what the SERVER said (`readAt`), whatever it was before. */
export function setItemState(items: readonly NotificationItem[], id: string, readAt: string | null): readonly NotificationItem[] {
  return items.map((item) => (item.id === id ? { ...item, readAt } : item));
}

export function removeItem(items: readonly NotificationItem[], id: string): readonly NotificationItem[] {
  return items.filter((item) => item.id !== id);
}

/**
 * What a mark-all covers among the DRAWN items: everything at or older than the
 * newest the view drew, of the kind when one is named. The drawn list is the
 * view's own, newest first, so with a bound taken from its head that is every
 * drawn item of the kind.
 */
export function markAllCovered(items: readonly NotificationItem[], kind: NotificationKind | null, readAt: string): readonly NotificationItem[] {
  return items.map((item) => (item.readAt === null && (kind === null || item.kind === kind) ? { ...item, readAt } : item));
}

export function unreadIn(items: readonly NotificationItem[], kind: NotificationKind | null): number {
  return items.filter((item) => item.readAt === null && (kind === null || item.kind === kind)).length;
}

/** Appends a served page, in served order, dropping a repeat of an id already drawn. */
export function appendPage(items: readonly NotificationItem[], page: readonly NotificationItem[]): readonly NotificationItem[] {
  const seen = new Set(items.map((item) => item.id));
  return [...items, ...page.filter((item) => !seen.has(item.id))];
}
