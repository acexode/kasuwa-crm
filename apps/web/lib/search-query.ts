/**
 * What a search box's text IS, decided before anything is sent (T-0087, P27).
 * Pure functions, no `'use client'` and no I/O, so the server pages, the
 * P04 lists and the search panel all decide the same way.
 *
 * ---------------------------------------------------------------------------
 * AN IDENTIFIER NEVER ENTERS A URL (the contract's R21, as D-L135 states it).
 *
 * After NFKC, text is identifier-shaped when it holds an `@`, or when — with
 * every character that is neither a letter (`\p{L}`) nor a decimal digit
 * (`\p{Nd}`) removed — it holds a run of six or more digits of ANY script. So
 * `0803/123/4567`, `0803_123_4567`, an en dash and Arabic-Indic digits all
 * count, and `Unit 12 Block 3456` does not: letters break the run. Such text
 * goes ONLY to lookupRecords, in a POST body.
 *
 * NOTHING PHONE-LIKE REACHES searchRecords, NOT EVEN PART OF IT (R27). Text
 * holding a digit and no letter is a number being typed: `0803` is sent
 * nowhere, and the screen says "keep typing" until the number is
 * lookup-eligible. Typing a number key by key used to put up to five of its
 * digits into the API URL.
 *
 * A NAME is anything else at least two characters long once folded the
 * contract's way (NFD, marks removed, lower-cased, trimmed, inner whitespace
 * collapsed), with control characters removed and at most 100 characters.
 * ---------------------------------------------------------------------------
 */

/** searchRecords' `q`: `minLength` and `maxLength` in the contract. */
export const SEARCH_Q_MIN = 2;
export const SEARCH_Q_MAX = 100;

/** D-L135's identifier rule (see the header). */
export function identifierShaped(text: string): boolean {
  const normal = text.normalize('NFKC');
  if (normal.includes('@')) return true;
  return /\p{Nd}{6,}/u.test(normal.replace(/[^\p{L}\p{Nd}]/gu, ''));
}

/** R27: after NFKC, at least one decimal digit of any script and no letter. */
export function phoneLike(text: string): boolean {
  const normal = text.normalize('NFKC');
  return /\p{Nd}/u.test(normal) && !/\p{L}/u.test(normal);
}

/** The contract's folding, for the minimum length (searchRecords' description). */
export function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim().replace(/\s+/gu, ' ');
}

/** C0, DEL and C1 control characters: the contract refuses them as `invalid_string`. */
function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Text as a name query: NFKC, control characters turned into spaces, trimmed,
 * inner whitespace collapsed, and cut to 100 characters (by code point, never
 * through the middle of one).
 */
export function cleanName(text: string): string {
  const cleaned = [...text.normalize('NFKC')]
    .map((character) => (isControl(character) ? ' ' : character))
    .join('')
    .trim()
    .replace(/\s+/gu, ' ');
  return [...cleaned].slice(0, SEARCH_Q_MAX).join('').trim();
}

export type SearchPlan =
  /** Nothing typed, or only spaces. */
  | { readonly kind: 'idle' }
  /** Under two characters once folded: none of loading, empty, failed or refused (R16). */
  | { readonly kind: 'short' }
  /** A number being typed (R27): the neutral hint, and no request. */
  | { readonly kind: 'keepTyping' }
  /** Digits and letters together with a six-digit run: no phone and no name, refused here. */
  | { readonly kind: 'refused'; readonly field: 'phone' }
  | { readonly kind: 'search'; readonly key: string; readonly q: string }
  | { readonly kind: 'lookup'; readonly key: string; readonly field: 'phone' | 'email'; readonly value: string };

/**
 * Decides what the text in a search box is, and therefore what (if anything)
 * is sent and where. A lookup carries the WHOLE input, NFKC-normalised and
 * trimmed (R28): full-width digits and `＠` arrive as ASCII, and separators
 * NFKC leaves alone are passed as typed for the API to accept or refuse.
 */
export function planSearch(text: string): SearchPlan {
  const name = cleanName(text);
  if (name === '') return { kind: 'idle' };
  const normal = text.normalize('NFKC');
  if (identifierShaped(normal)) {
    const value = normal.trim();
    if (value.includes('@')) return { kind: 'lookup', key: `email:${value}`, field: 'email', value };
    // A six-digit run inside a name ("Sample 0803/000/0001") is neither a
    // name searchRecords may see nor a phone the lookup can read.
    if (/\p{L}/u.test(value)) return { kind: 'refused', field: 'phone' };
    return { kind: 'lookup', key: `phone:${value}`, field: 'phone', value };
  }
  if (phoneLike(normal)) return { kind: 'keepTyping' };
  // Code points, as the server counts them: one astral letter is one character, not two.
  if ([...folded(name)].length < SEARCH_Q_MIN) return { kind: 'short' };
  return { kind: 'search', key: `q:${name}`, q: name };
}

/**
 * A list's own search box (listContacts, listLeads, the pickers over them): text
 * that is, or is becoming, a phone number or an email address is never sent as
 * `q`. The API refuses an identifier-shaped `q` as `400 identifier_in_url`
 * (T-0124 I9, R21), and a number typed key by key would otherwise put up to five
 * of its digits in the URL (R27). The screen says so and points at Search, which
 * looks a whole number up in a POST body.
 */
export function numberTyped(text: string): boolean {
  const kind = planSearch(text).kind;
  return kind === 'lookup' || kind === 'refused' || kind === 'keepTyping';
}

/** The `q` a list may send for what is in its box: the name, or nothing while a number is typed. */
export function listQ(text: string): string {
  return numberTyped(text) ? '' : text;
}

/**
 * A `q` read from a page's own URL ("see all", or a link someone was sent),
 * as a list's first search: only a name ever, so a crafted
 * `?q=<phone number>` is dropped, never searched (R12).
 */
export function nameFromUrl(value: string | string[] | null | undefined): string {
  if (typeof value !== 'string') return '';
  const plan = planSearch(value);
  return plan.kind === 'search' ? plan.q : '';
}

/**
 * Removes `q` from the address bar without a navigation or a new history
 * entry, keeping every other parameter (a `?locale=` preview included). A
 * search term never stays in the URL: in the address bar it lands in history,
 * bookmarks, screenshots and the Referer of every link followed.
 */
export function dropQueryFromAddressBar(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('q')) return;
  url.searchParams.delete('q');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
