import { isLoopbackHostname } from '@kasuwa/config/session';

/**
 * THE PAGE CONTENT-SECURITY-POLICY (ADR-0019 point 10, T-0125). SERVER ONLY.
 *
 * Set by `middleware.ts` on every page response, with a fresh nonce each time:
 *
 *   default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic';
 *   style-src 'self' 'nonce-…'; style-src-attr 'unsafe-inline';
 *   img-src 'self' data: blob:; font-src 'self'; connect-src 'self';
 *   frame-ancestors 'none'; form-action 'self'; base-uri 'none';
 *   object-src 'none'; upgrade-insecure-requests
 *
 * - `connect-src 'self'` is the line that matters: the browser talks only to
 *   its own origin, so the API's address appears nowhere in the policy or the
 *   bundles. The one addition is the object store's public ORIGIN, and only in
 *   a process given S3_PUBLIC_ENDPOINT, for the import wizard's direct part
 *   uploads (ADR-0017 point 4, ADR-0019 point 10). The realtime origin joins
 *   when realtime auth is designed, not sooner.
 * - `style-src-attr 'unsafe-inline'` is MEASURED, not guessed (the ADR asks the
 *   build to measure): progress bars, the role tree's indent, the script
 *   canvas and the token gallery set `style={}`, and any of those rendered on
 *   the server arrives as a `style` attribute, which `style-src` alone would
 *   block. It admits attributes only; `<style>` elements still need the nonce,
 *   and `style-src` never carries `'unsafe-inline'`.
 * - Development only (`next dev`): `'unsafe-eval'` for React Refresh, the HMR
 *   websocket in `connect-src`, and `style-src 'unsafe-inline'` without a
 *   nonce, because the dev server injects `<style>` elements at runtime. No
 *   production or test process gets any of the three.
 * - `upgrade-insecure-requests` only on an https, non-loopback origin: on
 *   http://127.0.0.1 it would upgrade the page's own requests to an https
 *   port nothing listens on.
 * - `Strict-Transport-Security` is set at the ingress, not here.
 */

export interface CspMode {
  /** NODE_ENV=development (`next dev`). */
  readonly development: boolean;
  /** KASUWA_WEB_ORIGIN: this process's own origin. */
  readonly webOrigin: string;
  /**
   * S3_PUBLIC_ENDPOINT, when this process has one: the object store the
   * browser PUTs import parts to on presigned URLs (ADR-0017 point 4). Its
   * ORIGIN joins `connect-src`, as ADR-0019 point 10 rules for "when imports
   * ship"; a process without it keeps `connect-src 'self'` alone.
   */
  readonly storageEndpoint?: string | undefined;
}

/**
 * 128 bits from the platform CSPRNG, base64 without its `==` padding: 22
 * characters (I18, amendment 4). The padding carries no entropy and is
 * repeated on every script tag of every page.
 */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
}

export function contentSecurityPolicy(nonce: string, mode: CspMode): string {
  const origin = new URL(mode.webOrigin);
  const upgrade = origin.protocol === 'https:' && !isLoopbackHostname(origin.hostname);
  const websocket = `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`;
  const storage = mode.storageEndpoint === undefined ? undefined : new URL(mode.storageEndpoint).origin;
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    ['script-src', "'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(mode.development ? ["'unsafe-eval'"] : [])],
    mode.development ? ['style-src', "'self'", "'unsafe-inline'"] : ['style-src', "'self'", `'nonce-${nonce}'`],
    ['style-src-attr', "'unsafe-inline'"],
    ['img-src', "'self'", 'data:', 'blob:'],
    ['font-src', "'self'"],
    ['connect-src', "'self'", ...(storage === undefined ? [] : [storage]), ...(mode.development ? [websocket] : [])],
    ['frame-ancestors', "'none'"],
    ['form-action', "'self'"],
    ['base-uri', "'none'"],
    ['object-src', "'none'"],
    ...(upgrade ? [['upgrade-insecure-requests'] as [string]] : []),
  ];
  return directives.map((parts) => parts.join(' ')).join('; ');
}
