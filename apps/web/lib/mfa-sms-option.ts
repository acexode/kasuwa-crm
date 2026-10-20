import type { MfaChallengeStarted } from './auth-api';

/**
 * `P01/2` — whether the code step offers "Text a code to …", and to where.
 *
 * Found in the hands-on test of Phase 2 (D-L193, T-0126): sign-in went to
 * `/verify` with the challenge id alone, so the TOTP screen rendered the SMS
 * fallback without knowing whether SMS was offered or where the code would go,
 * and every demo user read "Text a code to" followed by nothing.
 *
 * THE RULE: offered only when the challenge's `sms` method is `available` AND
 * carries a masked `deliveryHint`. Either half alone is not enough — an
 * available method with no number on file sends a code nowhere, and a number on
 * file with the method switched off is a button that fails when pressed.
 *
 * WHERE IT LIVES ACROSS A RELOAD: `sessionStorage`, keyed by the challenge id.
 * Never the URL. The hint is masked, but it is still a fragment of a personal
 * phone number, and a URL lands in browser history, in referrers and in every
 * access log between here and the API. `sessionStorage` dies with the tab and
 * is never sent anywhere. Absent or unreadable, the option is hidden — the
 * same answer as "the server did not offer it".
 */

type ChallengeMethod = MfaChallengeStarted['methods'][number];

/** The masked number to offer an SMS code to, or `null` when SMS is not on offer. */
export function smsOptionHint(methods: readonly ChallengeMethod[]): string | null {
  const sms = methods.find((entry) => entry.type === 'sms');
  if (sms === undefined || !sms.available) return null;
  const hint = sms.deliveryHint?.trim() ?? '';
  return hint === '' ? null : hint;
}

/** The slice of `Storage` this module uses, so tests can hand it a plain object. */
export interface SmsOptionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = 'kasuwa.mfa.sms:';

function storageKey(challengeId: string): string {
  return `${KEY_PREFIX}${challengeId}`;
}

/**
 * The tab's `sessionStorage`, or `undefined` where there is none: on the
 * server, and in browsers that throw on access (storage disabled, some private
 * modes). Callers treat `undefined` as "nothing remembered".
 */
export function browserSessionStore(): SmsOptionStore | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Records the decision for `challengeId`. A `null` hint REMOVES any earlier
 * entry rather than storing "no", so a reissue that withdraws SMS cannot leave
 * a stale number behind. Storage failures are swallowed: the cost is that a
 * reload hides the option, which is the safe direction.
 */
export function rememberSmsOption(
  store: SmsOptionStore | undefined,
  challengeId: string,
  hint: string | null,
): void {
  if (store === undefined || challengeId === '') return;
  try {
    if (hint === null) {
      store.removeItem(storageKey(challengeId));
    } else {
      store.setItem(storageKey(challengeId), JSON.stringify({ hint }));
    }
  } catch {
    // Quota or a disabled store. Hidden on reload; nothing else to do.
  }
}

/** The remembered hint for `challengeId`, or `null` — hide the option. */
export function recallSmsOption(store: SmsOptionStore | undefined, challengeId: string): string | null {
  if (store === undefined || challengeId === '') return null;
  try {
    const raw = store.getItem(storageKey(challengeId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('hint' in parsed)) return null;
    const { hint } = parsed;
    return typeof hint === 'string' && hint.trim() !== '' ? hint.trim() : null;
  } catch {
    return null;
  }
}

/** Forgets `challengeId` — once it is spent, the number has no reason to stay. */
export function forgetSmsOption(store: SmsOptionStore | undefined, challengeId: string): void {
  rememberSmsOption(store, challengeId, null);
}

/**
 * Where a successful first factor goes. The challenge id and nothing else: the
 * masked number is carried by `rememberSmsOption`, never in the address bar.
 */
export function verifyPath(challengeId: string): string {
  return `/verify?challenge=${encodeURIComponent(challengeId)}`;
}
