/**
 * Injection token for the envelope-encryption key provider (D-L13).
 *
 * Injected rather than constructed in the service, for the same reason as
 * `AUTH_POLICY`: `main.ts` stays the one place that reads configuration, and a
 * test can stand an app up on a provider with a different key id without
 * mutating process.env.
 */
export const KEY_PROVIDER = Symbol('KEY_PROVIDER');
