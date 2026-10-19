/**
 * THE WEB APP'S ONE WAY TO CALL ITS API (ADR-0019 step d, T-0125).
 *
 * Every browser request to `/api/*` goes through `apiFetch`; ESLint refuses a
 * raw `fetch` anywhere else in apps/web, so no screen can forget what this
 * adds:
 *
 *   - `x-requested-with: kasuwa-web`, the custom header the BFF requires on
 *     every write (point 4). A cross-origin page cannot add it without a CORS
 *     preflight, and nothing at this origin answers one, so it is what closes
 *     bodyless POSTs. It rides on reads too: they need it not, and one rule
 *     is easier to keep than two.
 *   - `cache: 'no-store'`: every answer is one session's data at a URL that is
 *     the same for every user. The BFF also sends `no-store`; this is the
 *     second layer.
 *   - the default `credentials: 'same-origin'`: the session is an HttpOnly
 *     cookie the browser attaches and this code never sees. There is no token
 *     here, no Authorization header and no identity of any kind. (Not stated
 *     in the call: it is the default, and every byte here ships on every
 *     screen.)
 *   - a 401 sends the user to sign-in (I6), except where the caller IS the
 *     sign-in flow and a 401 means a wrong password or code.
 *
 * Never a scope header: nothing a screen sends names a programme
 * (CLAUDE.md 2.2), so this takes no header argument at all.
 */

const CSRF_HEADER = 'x-requested-with';
const CSRF_HEADER_VALUE = 'kasuwa-web';

/** Where a signed-out browser lands: P01/1. */
export const SIGN_IN_PATH = '/';

export interface ApiFetchInit {
  readonly method?: string;
  /** Serialised as JSON; absent means a bodyless request. */
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /**
   * Always `no-store`, whatever is passed: accepted so a transport can state
   * its own rule where a reader (or a suite) looks for it.
   */
  readonly cache?: 'no-store';
  /**
   * What a 401 means. `sign-in` (the default): the session is gone, so go to
   * P01/1. `return`: the caller is the sign-in flow, and a 401 is its answer
   * (a wrong password, a wrong code), so just hand it back.
   */
  readonly onUnauthenticated?: 'sign-in' | 'return';
}

/** Sends the browser to sign-in, once, and never from sign-in itself. */
export function sendToSignIn(): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === SIGN_IN_PATH) return;
  window.location.assign(SIGN_IN_PATH);
}

export async function apiFetch(path: string, init: ApiFetchInit = {}): Promise<Response> {
  if (!path.startsWith('/api/')) {
    // A same-origin relative path, always. An absolute URL would carry the
    // session's cookie nowhere useful and is not what this is for.
    throw new Error('apiFetch: /api/ only');
  }
  const hasBody = init.body !== undefined;
  const headers: Record<string, string> = hasBody
    ? { accept: 'application/json', 'content-type': 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE }
    : { accept: 'application/json', [CSRF_HEADER]: CSRF_HEADER_VALUE };
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    cache: 'no-store',
    headers,
    ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });
  if (response.status === 401 && (init.onUnauthenticated ?? 'sign-in') === 'sign-in') {
    sendToSignIn();
  }
  return response;
}
