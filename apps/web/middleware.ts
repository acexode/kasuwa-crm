import { NextResponse, type NextRequest } from 'next/server';

/**
 * Carries a `?locale=` PREVIEW into the request, for that request only.
 *
 * A layout does not receive `searchParams` — only pages do — and `lang`/`dir`
 * belong on `<html>`, which the layout owns. Middleware is the one place that
 * sees both. It sets a request header the layout reads; it sets no cookie, so
 * the choice does not survive the next navigation.
 *
 * WHY A PREVIEW EXISTS AT ALL. Arabic is REGISTERED and not OFFERED: it ships
 * so that RTL can be exercised against real strings rather than against a
 * specimen (see `packages/i18n/CLAUDE.md`). RTL is a layout mode, not a
 * translation, and proving it on one screen now costs an attribute where
 * retrofitting it across thirty screens is a project.
 *
 * It is NOT a way to offer a language. The menu comes from `SUPPORTED_LOCALES`
 * and nothing here touches that; a preview renders once, persists nothing, and
 * appears in no navigation.
 */
export function middleware(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get('locale');
  if (requested === null) {
    return NextResponse.next();
  }

  const headers = new Headers(request.headers);
  headers.set('x-kasuwa-preview-locale', requested);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Static assets and the API proxy never need a locale decision, and running
  // middleware on every font request is latency nobody asked for.
  matcher: ['/((?!_next/static|_next/image|fonts|api/).*)'],
};
