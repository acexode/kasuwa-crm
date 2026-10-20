import type { MfaChallengeStarted } from './auth-api';
import type { SmsOptionStore } from './mfa-sms-option';

/**
 * `P01/2` — which of "Use a passkey" and "Use a backup code" the code step
 * offers (T-0131). T-0126's rule for the SMS fallback, applied to the other
 * two: an option is shown only when the challenge lists that method as
 * `available`. An option the server did not offer is a button that fails when
 * pressed.
 *
 * The contract's method enum has no passkey yet, so no challenge can mark one
 * available and the passkey row stays hidden until the API offers it. Nothing
 * here guesses.
 *
 * Kept in `sessionStorage` per challenge, like the SMS hint, so a reload of
 * `/verify` keeps what sign-in learned. Absent or unreadable means "none".
 */

export type MfaFallback = 'passkey' | 'backup_code';

const FALLBACKS: readonly MfaFallback[] = ['passkey', 'backup_code'];

type ChallengeMethod = MfaChallengeStarted['methods'][number];

export function availableFallbacks(methods: readonly ChallengeMethod[]): MfaFallback[] {
  return FALLBACKS.filter((fallback) =>
    methods.some((entry) => (entry.type as string) === fallback && entry.available),
  );
}

const KEY_PREFIX = 'kasuwa.mfa.fallbacks:';

export function rememberFallbacks(
  store: SmsOptionStore | undefined,
  challengeId: string,
  fallbacks: readonly MfaFallback[],
): void {
  if (store === undefined || challengeId === '') return;
  try {
    if (fallbacks.length === 0) store.removeItem(KEY_PREFIX + challengeId);
    else store.setItem(KEY_PREFIX + challengeId, JSON.stringify(fallbacks));
  } catch {
    // Quota or a disabled store: hidden on reload, the safe direction.
  }
}

export function recallFallbacks(store: SmsOptionStore | undefined, challengeId: string): MfaFallback[] {
  if (store === undefined || challengeId === '') return [];
  try {
    const raw = store.getItem(KEY_PREFIX + challengeId);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return FALLBACKS.filter((fallback) => parsed.includes(fallback));
  } catch {
    return [];
  }
}

export function forgetFallbacks(store: SmsOptionStore | undefined, challengeId: string): void {
  rememberFallbacks(store, challengeId, []);
}
