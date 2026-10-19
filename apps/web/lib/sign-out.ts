import { apiFetch } from './api-fetch';

/**
 * Ends the session (ADR-0019 point 5): the BFF revokes it at the API and
 * clears the cookie whatever the API answered, so the caller goes to sign-in
 * whatever this resolves to. Bodyless, and CSRF-checked like any write.
 *
 * Its own module, not in `auth-api.ts`: the sign-out button sits in every CRM
 * and admin shell, and the sign-in flow's schemas have no business in their
 * first load on a 256 kbps link.
 */
export async function signOut(): Promise<void> {
  try {
    await apiFetch('/api/v1/auth/sign-out', { method: 'POST', onUnauthenticated: 'return' });
  } catch {
    // A dropped connection still ends here: the caller leaves for sign-in,
    // and an unrevoked session expires on the API's clock.
  }
}
