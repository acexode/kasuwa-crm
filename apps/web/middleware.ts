import { NextResponse, type NextRequest } from 'next/server';
import { webEnv } from '@kasuwa/config/web';
import { contentSecurityPolicy, newNonce, type CspMode } from './lib/server/csp';

/**
 * Two jobs, on every page request.
 *
 * 1. THE PAGE CSP (ADR-0019 point 10, T-0125). A fresh nonce per response,
 *    put on the REQUEST's `content-security-policy` header, where Next reads
 *    it and stamps it on every script it renders, and on the RESPONSE, where
 *    the browser enforces it. The policy itself is `lib/server/csp.ts`. The
 *    BFF at `/api/v1/*` sets its own (`default-src 'none'`), so only
 *    `api/v1/` (and `fonts/`) is left out of the matcher.
 *
 * 2. A `?locale=` PREVIEW, carried into the request for that request only.
 *    A layout does not receive `searchParams` — only pages do — and
 *    `lang`/`dir` belong on `<html>`, which the layout owns. Middleware is the
 *    one place that sees both. It sets a request header the layout reads; it
 *    sets no cookie, so the choice does not survive the next navigation.
 *
 *    WHY A PREVIEW EXISTS AT ALL. Arabic is REGISTERED and not OFFERED: it
 *    ships so that RTL can be exercised against real strings rather than
 *    against a specimen (see `packages/i18n/CLAUDE.md`). It is NOT a way to
 *    offer a language: the menu comes from `SUPPORTED_LOCALES`, and a preview
 *    renders once, persists nothing, and appears in no navigation.
 *
 * The Node runtime, so the policy reads this process's own configuration
 * through `webEnv()` (lazily, once), never `process.env`.
 */
let mode: CspMode | undefined;

function cspMode(): CspMode {
  if (mode === undefined) {
    const env = webEnv();
    mode = Object.freeze({ development: env.NODE_ENV === 'development', webOrigin: env.KASUWA_WEB_ORIGIN });
  }
  return mode;
}

export function middleware(request: NextRequest) {
  const policy = contentSecurityPolicy(newNonce(), cspMode());
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);

  const requested = request.nextUrl.searchParams.get('locale');
  if (requested !== null) {
    headers.set('x-kasuwa-preview-locale', requested);
  }

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  runtime: 'nodejs',
  // Everything gets the policy except two prefixes (D-L181 N4): the BFF
  // (`api/v1/`), which sets its own `default-src 'none'`, and the self-hosted
  // fonts (`fonts/`). Trailing slashes, so `/api/other`, `/fonts-x` and Next's
  // own 404s are covered. Static chunks get it too; on a script or stylesheet
  // response the header is inert, and an exclusion list that grows is how a
  // page ends up without one.
  matcher: ['/((?!api/v1/|fonts/).*)'],
};
