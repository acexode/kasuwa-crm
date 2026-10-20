'use client';

import { useSyncExternalStore } from 'react';

/**
 * What the top-bar search field holds (T-0138, P27/A and C): one value for
 * the shell's field, the `/search` results page and the page's own phone
 * field, so the three can never disagree.
 *
 * IN MEMORY ONLY (R19). A module variable: never written to the device, never
 * sent anywhere but the search reads themselves, and gone with the tab. It is
 * how a whole phone number or email address reaches the results page without
 * ever being put in a URL (R12, D-L135): "See all results" navigates to
 * `/search` with no query string, and the page reads the text from here.
 *
 * `origin` is the CRM screen the results page was opened from, for its
 * "Back to …" link (P27/C). Unset, the page draws no back link.
 */

interface SearchFieldState {
  readonly text: string;
  readonly origin: string | null;
}

let state: SearchFieldState = { text: '', origin: null };
const listeners = new Set<() => void>();

function emit(next: SearchFieldState): void {
  if (next.text === state.text && next.origin === state.origin) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SERVER: SearchFieldState = { text: '', origin: null };

export function setSearchText(text: string): void {
  emit({ ...state, text });
}

export function setSearchOrigin(origin: string | null): void {
  emit({ ...state, origin });
}

/** Forget what was typed: after a hit is opened, and when a screen other than `/search` mounts. */
export function clearSearchText(): void {
  emit({ text: '', origin: state.origin });
}

export function useSearchField(): SearchFieldState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER,
  );
}
