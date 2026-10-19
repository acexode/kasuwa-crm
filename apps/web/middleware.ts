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
    mode = Object.freeze({
      development: env.NODE_ENV === 'development',
      webOrigin: env.KASUWA_WEB_ORIGIN,
      storageEndpoint: env.S3_PUBLIC_ENDPOINT,
    });
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
  // Every page gets the policy (D-L181 N4): `/api/other`, Next's own 404s and
  // everything else. Left out, with trailing slashes: the BFF (`api/v1/`),
  // which sets its own `default-src 'none'`; the self-hosted fonts
  // (`fonts/`); and Next's hashed static files (`_next/static/`,
  // `_next/image`). A CSP on a script, stylesheet or image response is inert,
  // and putting it there cost ~340 bytes on every chunk: about 4.4 KB on the
  // /contacts budget, measured (T-0125 gate). Link PREFETCHES are left out
  // too, as Next's own nonce guidance does: a prefetched RSC payload is not a
  // document and renders no script, and each one carried the header for
  // nothing (~365 bytes per prefetch on the admin budgets).
  matcher: [
    {
      source: '/((?!api/v1/|fonts/|_next/static/|_next/image).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
