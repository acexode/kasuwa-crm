/**
 * `Retry-After`, read and capped (D-L134, D-L179 N6). A module of its own, so a
 * screen that needs only this (the import job, the notifications client) takes
 * nothing else with it.
 */

/** A `Retry-After` is honoured whole, but a nonsense header is not an hour-long silence: every wait taken from one is capped here. */
export const RETRY_AFTER_CAP_MS = 900_000;

/** A server's `Retry-After` (seconds) as a wait in ms, capped; `fallbackMs` when it sent none. */
export function retryAfterMs(seconds: number | undefined, fallbackMs: number): number {
  return seconds === undefined ? fallbackMs : Math.min(RETRY_AFTER_CAP_MS, Math.max(0, seconds * 1000));
}

/**
 * `Retry-After` as whole seconds, or `undefined`. Only the delta-seconds form
 * the contract declares (`integer, minimum 1`) is read: an HTTP date is not
 * guessed at, because a wrong wait is worse than none.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || !/^\d{1,6}$/.test(header.trim())) return undefined;
  const seconds = Number(header.trim());
  return seconds >= 1 ? seconds : undefined;
}
