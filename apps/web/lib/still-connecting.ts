/**
 * How long a read may take before a screen shows its "still connecting" state
 * (P01/1d's rule, the same NFR everywhere). Its own module (T-0145): list,
 * board and deal hooks need this number and nothing else from the admin
 * console's resource hook.
 */
export const STILL_CONNECTING_MS = 4_000;
