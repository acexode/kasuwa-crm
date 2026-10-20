/**
 * The pure half every P04 record list shares (T-0042 Contacts, T-0057
 * Accounts): the list state, the phone and sync-time formats and the avatar
 * initials. No React and no `'use client'`, so it is unit-tested directly and
 * a server component may import it.
 */

import { formatClock } from '../record/record-core';

export type ListState = 'loading' | 'ready' | 'empty' | 'no-results' | 'error';

/**
 * "Nothing here yet" and "nothing matches" are different screens (P04/05), and
 * neither may be shown while a request is in flight or after one failed — a
 * failed read is not an empty workspace.
 */
export function listState(input: {
  readonly phase: 'loading' | 'loaded' | 'error';
  readonly rowCount: number;
  readonly searching: boolean;
}): ListState {
  if (input.phase === 'loading') return 'loading';
  if (input.phase === 'error') return 'error';
  if (input.rowCount > 0) return 'ready';
  return input.searching ? 'no-results' : 'empty';
}

/** Appends a page, dropping any row already held: a row created here can come round again on a later page. */
export function appendPage<Row extends { readonly id: string }>(
  current: readonly Row[],
  page: readonly Row[],
): Row[] {
  const held = new Set(current.map((row) => row.id));
  return [...current, ...page.filter((row) => !held.has(row.id))];
}

/**
 * E.164 grouped for reading: `+2348030000001` -> `+234 803 000 0001`. Nigerian
 * numbers get the national grouping; anything else is shown as stored, because
 * a wrong grouping is worse than none.
 */
export function formatPhone(e164: string): string {
  const nigerian = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (nigerian !== null) {
    return `+234 ${nigerian[1]} ${nigerian[2]} ${nigerian[3]}`;
  }
  return e164;
}

/** Up to two initials, for the decorative avatar (always aria-hidden). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * "Last synced" with the zone named. A bare `10:42` is useless to somebody
 * whose phone clock is in another zone, and BPO rosters span WAT, EAT and
 * SAST. The browser's zone is the one the person reads their clock in.
 */
export function formatSyncedAt(locale: string, at: Date): string {
  // "15:00 WAT": 24-hour, and the zone a desk names, not ICU English's "GMT+1" (T-0143).
  return formatClock(locale, at);
}
