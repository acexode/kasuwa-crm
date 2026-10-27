import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { webEnv } from '@kasuwa/config/web';
import { SEED_CONTACTS, SEED_PASSWORD, SEED_TENANTS } from '@kasuwa/db';
import { OUTCOMES_FILE, type E2eOutcome } from '../support/e2e-outcomes-reporter';

/**
 * ACCEPTANCE — T-0125, THE WEB APP KEEPS A SESSION AFTER SIGN-IN (Agent 1,
 * Platform & Security; Agent 11 for the web transports). Decisions: ADR-0019
 * (Proposed; written against it as it stands on 2026-10-19), D-L147, D-L149,
 * ADR-0007, ADR-0008, ADR-0010, D-L05, D-L64, D-L94, CLAUDE.md sections 2 and
 * 6. Written by the lead's QA agent before the BFF exists (D-L23).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS THE BUILDER TO
 *
 *   1. A real browser signs in (password, then a TOTP code) and reads its own
 *      programme on /contacts with NO injected identity header; a signed-out
 *      browser is sent to sign-in and sees no data.
 *   2. The `__Host-kasuwa_session` cookie: HttpOnly, Secure, SameSite=Lax,
 *      Path=/, no Domain, Max-Age following the session. The token never
 *      reaches page JavaScript, storage, a URL, a body, the console or a log.
 *   3. The BFF at apps/web/app/api/v1/[...path]: scope only from the session;
 *      scope headers refused with the API's 400; stub identity forwarded only
 *      by a stub-mode web process, never by a jwt or production one; the
 *      browser's Authorization header dropped.
 *   4. CSRF on every unsafe method, bodyless POSTs and the sign-in routes
 *      included.
 *   5. Sign-out revokes server-side and clears the cookie; replay fails.
 *   6. Lifetime is the API's: twelve hours, no refresh, no sliding, no
 *      rotation; one session per browser profile.
 *   7. Errors leak nothing; nothing logs the token or PII.
 *   8. The page CSP, and what the 2G budget needs from the BFF.
 *   9. Tenancy: a tenant-A session cannot reach tenant B through the BFF.
 *  10. webEnv() refuses the unsafe configurations of ADR-0019 point 8.
 *
 * RULINGS (I1–I24). Where ADR-0019 or D-L149 leave a choice open, the suite is
 * written to these; each conservative choice is flagged in the lead's report.
 *
 *   I1. HARNESS. The real-browser journeys run on a FOURTH web process,
 *       `webSessionUrl`: the same production build under `next start`,
 *       NODE_ENV=test (crm_records is not production-ready, D-L64),
 *       KASUWA_AUTH_MODE=jwt, `crm_records` on, no KASUWA_SESSION_COOKIE_
 *       INSECURE, and no spec context there carries `extraHTTPHeaders`.
 *       ADR-0019 point 7 puts the journey on the default NODE_ENV=production
 *       process, which cannot serve /contacts (no production-ready CRM flag);
 *       the production half (stub headers ignored, the CSP, the BFF probes)
 *       runs on `webUrl`. The session process starts only when the run's grep
 *       can select @bff-session (or there is no grep). The records and
 *       self-serve processes run KASUWA_AUTH_MODE=stub (point 7). Every web
 *       process gets KASUWA_WEB_ORIGIN = its own origin and
 *       KASUWA_API_INTERNAL_URL = the API. This lead edit to run-e2e.mjs ships
 *       with the suite (ADR-0019 step f).
 *   I2. LOOPBACK. `Secure` and the `__Host-` prefix apply on
 *       http://127.0.0.1: Chromium stores and sends such a cookie there
 *       (verified on the harness's Chromium). No e2e process relaxes them.
 *   I3. KASUWA_API_INTERNAL_URL under NODE_ENV=production must be https,
 *       EXCEPT a loopback host (127.0.0.0/8, localhost, [::1]), mirroring
 *       point 8's origin rule. D-L149 #4 says plain http is refused at boot
 *       outside dev and test and names no loopback exception; without one
 *       the e2e production process cannot boot. A hostname that merely
 *       begins with 127. (127.0.0.1.evil.example) is not loopback. FLAGGED.
 *   I4. CSRF, for every method but GET, HEAD and OPTIONS, cookie or not:
 *       `Origin` string-equal to KASUWA_WEB_ORIGIN (missing, `null`, a
 *       trailing slash, another scheme or port: refused; compared with
 *       configuration, never Host or X-Forwarded-Host); `Sec-Fetch-Site`,
 *       when present, exactly `same-origin` (`same-site`, `cross-site` and
 *       `none` refused); `x-requested-with` exactly `kasuwa-web`; a request
 *       with a body must be application/json (text/plain with or without a
 *       charset, form, multipart, and NO content type are refused); a bodyless
 *       request needs Origin and the header, never a type. A refusal is 403
 *       `csrf_rejected` with ONE body for every reason, naming no check, and
 *       never touches the session cookie. A navigation-shaped cross-site form
 *       POST may be refused by either the CSRF check or the navigation
 *       refusal. Nothing answers a CORS preflight.
 *   I5. SIGN-OUT. Any 2xx; a Set-Cookie that deletes `__Host-kasuwa_session`
 *       (Max-Age<=0 or a past Expires) WITH Secure, Path=/ and no Domain, or
 *       the browser ignores the deletion; `Clear-Site-Data` containing
 *       "cache". The old value then fails at the BFF and, as Bearer, at the
 *       API. With no cookie or a garbage cookie it still answers 2xx and
 *       clears.
 *   I6. A 401. The body is the API's `not_authenticated` body verbatim; the
 *       response deletes the cookie (as I5); the web app sends the user to
 *       `/` showing `[data-screen="P01/1"]`. A return-path parameter is not
 *       required (not tested).
 *   I7. LIFETIME. expiresAt within two minutes of now + 12 h (D-L149 #1, the
 *       harness's default KASUWA_AUTH_SESSION_HOURS); Max-Age within five
 *       seconds of expiresAt − now and never above 12 h; an Expires, if sent,
 *       not after expiresAt. No sliding window and no rotation: an
 *       authenticated request answers with no session Set-Cookie. Expiry by
 *       the clock is not driven (no clock control); a revoked session takes
 *       the same API path and is driven.
 *   I8. TOKEN CAPTURE. The MFA 200 has no `accessToken` and no `tokenType`
 *       key and no `ksw_s1_` string; it keeps `expiresAt` and `user`; it is
 *       no-store. The cookie value is the API token verbatim: it
 *       authenticates at the API as Bearer. `name=value` is at most 96 bytes.
 *   I9. VISIBILITY. The token, or any `ksw_s1_` string, is never in
 *       document.cookie, localStorage, sessionStorage, window.name, a request
 *       or navigation URL, a document or API response body the page
 *       receives, the rendered HTML, a console message, a page error, or this
 *       run's server output.
 *   I10. ONE SESSION PER PROFILE (point 3). A sign-in that carries a session
 *       cookie revokes that session, for the same user and across tenants.
 *   I11. IDENTITY. jwt-mode web processes (production, and the session
 *       process) drop `x-kasuwa-tenant-id` and `x-kasuwa-user-id`: with no
 *       cookie the answer is 401; with a cookie it is the cookie's identity;
 *       other `x-kasuwa-*` headers are dropped silently. A stub-mode web
 *       process still forwards them. A browser-supplied `Authorization` is
 *       dropped (cookie-only). The development name `kasuwa_session` never
 *       authenticates where KASUWA_SESSION_COOKIE_INSECURE is absent, and
 *       never outranks the `__Host-` cookie.
 *   I12. SCOPE HEADERS. `x-kasuwa-programme-ids`, `-programme-id` and
 *       `x-kasuwa-scope`: 400 with exactly SCOPE_HEADER_REJECTED_BODY, cookie
 *       or not, jwt or stub, the value never echoed.
 *   I13. NAVIGATION. A request with `Sec-Fetch-Dest: document` or
 *       `Sec-Fetch-Mode: navigate` to /api/* answers 404 with the SAME body as
 *       an unknown /api/v1 path through the BFF, cookie or not, carrying no
 *       user data; a browser navigation to /api/v1/auth/me is a 404.
 *   I14. EVERY BFF ANSWER (200, 204, 400, 401, 403, 404, the MFA 200):
 *       Cache-Control with no-store and neither public nor a positive
 *       max-age; X-Content-Type-Options: nosniff; a CSP of exactly
 *       `default-src 'none'; frame-ancestors 'none'`.
 *   I15. COMPRESSION. A contacts list over 1,100 bytes, asked for with
 *       `accept-encoding: gzip, deflate, br`, arrives with Content-Encoding
 *       gzip, br, deflate or zstd, smaller on the wire.
 *   I16. ERRORS. No BFF answer names the API's host and port (body,
 *       headers, a redirect) or carries a stack trace; another tenant's,
 *       another programme's and a nonexistent record answer one 404 body; a
 *       garbage, revoked or unknown cookie answer one 401 body, and no
 *       cookie, an empty one or a development-named one answer one 401 body.
 *       (Two groups only because the harness API runs stub mode, where a
 *       request with no credential meets the stub guard's differently shaped
 *       401; in a jwt deployment they are one.) The 502 for an unreachable
 *       API is not driven (the harness cannot stop the API mid-run). FLAGGED.
 *   I17. TENANCY. No path (dot segments, encoded slashes, `;` parameters,
 *       NUL, case), query (tenant or programme ids), header (stub identity,
 *       Host, X-Forwarded-Host, Forwarded, tenant slugs) or cookie trick
 *       (a planted `kasuwa_session`, two session cookies) puts tenant-B data
 *       in an answer to a tenant-A session; two session cookies never mix two
 *       tenants in one answer and never crash the BFF. The BFF sends no
 *       request, and so no token, to any host but the configured API
 *       (encoded-slash, backslash, userinfo, absolute-form, Host and
 *       forwarding-header probes against an in-test listener), and never
 *       reaches an API route outside /api/v1 (/health).
 *   I18. THE PAGE CSP, on every page response including the 404 page:
 *       exactly the ADR's directives — default-src 'self'; script-src 'self'
 *       'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…' (plus
 *       style-src-attr 'unsafe-inline' if the build needs it, never
 *       'unsafe-inline' on style-src); img-src 'self' data: blob:; font-src
 *       'self'; connect-src 'self' alone; frame-ancestors 'none';
 *       form-action 'self'; base-uri 'none'; object-src 'none' — with no
 *       'unsafe-eval' outside development, and no upgrade-insecure-requests
 *       on loopback (both e2e processes are loopback). The nonce is at least
 *       128 bits (22+ base64 characters, a ruling: the ADR names no length),
 *       new on every response, and on every <script> in the served HTML. No
 *       policy names the API. The sign-in screens and /contacts raise no
 *       securitypolicyviolation. `x-middleware-subrequest` does not strip it.
 *   I19. LOW BANDWIDTH. ADR-0019 sets no new byte budget and D-L149 #7 keeps
 *       the existing budgets on the processes they measure, so none is added
 *       here; their own suites re-measure. Held instead: I15; I8's cookie
 *       size; no CORS preflight and no request to a second origin during the
 *       journey; no loaded script names the API.
 *   I20. SIGN-OUT CONTROL. `[data-testid="sign-out"]` in the CRM shell
 *       (/contacts) and the admin shell (/admin), optionally behind
 *       `[data-testid="user-menu"]`. It lands on sign-in with the cookie gone
 *       and the session revoked.
 *   I21. STATIC. The route file `apps/web/app/api/v1/[...path]/route.ts`
 *       exports GET, HEAD, POST, PUT, PATCH and DELETE, is force-dynamic and
 *       not edge; next.config.mjs has no /api/v1 rewrite; neither apps/web
 *       nor the web schema names NEXT_PUBLIC_API_URL; `accessToken` is named
 *       in apps/web only under app/api/ and lib/server/; no 'use client'
 *       module imports lib/server; the scope and stub header names and the
 *       400 body live in @kasuwa/config (D-L149 #8), not as literals in
 *       apps/api's auth-context.ts or in apps/web; apps/web/lib/api-fetch.ts
 *       sends the CSRF header, and ESLint refuses a raw fetch of an /api/
 *       path anywhere else in apps/web.
 *   I22. CONFIG (point 8, D-L94). webEnv() refuses: a missing
 *       KASUWA_WEB_ORIGIN or KASUWA_API_INTERNAL_URL; an origin with a path,
 *       userinfo or that is not a URL; under production an http origin that
 *       is not loopback (127.0.0.1.evil.example included); under production
 *       an http API URL that is not loopback (I3); an API URL with
 *       credentials, without echoing them; KASUWA_SESSION_COOKIE_INSECURE
 *       under production with ANY value, empty and "0" included. It accepts
 *       the insecure flag under development and test, a loopback http origin
 *       and API URL under production, and https everywhere.
 *   I23. THE DEMO PROXY GOES (point 11): tools/demo-proxy.mjs is deleted and
 *       neither tools/demo*.mjs nor docs/demo/DEMO.md names it, `/__demo` or
 *       port 3100. A stub-identity switcher has no place in the artefact.
 *   I24. LOGS. This run's output (the API, every web process, Playwright)
 *       contains no `ksw_s1_`, no seed password, no seeded TOTP secret, no
 *       seeded email or phone number, and none of the markers the journeys
 *       put into refused requests' headers, bodies and cookies.
 *
 * NOT HELD HERE, AND WHY (each in the lead's report)
 *   - "Two client addresses reach two throttle keys through the BFF"
 *     (point 9): the harness API trusts no proxy hop, so every request keys
 *     on one socket peer; driving it needs KASUWA_TRUST_PROXY_HOPS in the
 *     harness and sixty-odd sign-ins. The build's unit tests hold it.
 *   - Disabling a user or removing a programme taking effect on the next
 *     request: no API operation does either, and the e2e specs have no
 *     database handle. The BFF caches nothing; I6 and I10 show it defers to
 *     the API on every request, and ADR-0008's suites hold the API side.
 *   - The enrol/confirm token capture: every seeded user is enrolled.
 *   - Expiry by the clock, the 502 path, Opera Mini and old WebViews.
 *   - The build's unit tests (config.test.ts, header-policy, csrf,
 *     session-cookie) are the builder's.
 *
 * THE BROWSER HALF. `tests/e2e/bff-session.spec.ts` and
 * `tests/e2e/support/bff-session.ts` were written with this suite and are
 * PINNED by hash below, because `tests/e2e` is not path-protected (D-L64).
 *
 * ONE RUN, NO SHELL. The journeys run once, as
 *
 *     node tests/e2e/scripts/run-e2e.mjs --grep @bff-session --reporter=list,<ours>
 *
 * spawned with `shell: false` (D-L62), read from the outcomes file our
 * reporter writes, so a skipped, `fixme`d or unmatched test never counts.
 *
 * ON MAIN. Every journey that needs a session fails at its first sign-in with
 * "a successful MFA through the BFF set no __Host-kasuwa_session cookie", the
 * production-process stub probes fail because the rewrite forwards stub
 * identity (200, not 401), CSRF refusals are absent, there is no CSP, and the
 * static and config sections fail naming the missing route, rewrite, schema
 * or wrapper. Two browser tags pass on main BY DESIGN, as regression guards
 * (@bff-session-stub-forwarded, @bff-session-no-cors), and so does the log
 * scan (I24); each is marked where it is. On main 40 of 48 fail, and the
 * eight that pass are the config control, the two harness facts, the pin,
 * tag ownership, those two journeys and the log scan.
 * ------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

const E2E_TAG = '@bff-session';
const SPEC = 'tests/e2e/bff-session.spec.ts';
const SUPPORT = 'tests/e2e/support/bff-session.ts';
const RUNNER = 'tests/e2e/scripts/run-e2e.mjs';
const ROUTE = 'apps/web/app/api/v1/[...path]/route.ts';
const API_FETCH = 'apps/web/lib/api-fetch.ts';
const LOG_MARKER = 'T0125-LOG-MARKER';
const TOKEN_PREFIX = 'ksw_s1_';

/** A production build, a container, five servers and some thirty sign-ins. */
const E2E_RUN_TIMEOUT_MS = 2_400_000;

/**
 * The pinned browser half (CRLF folded to LF). A change to either file is a
 * change to the acceptance contract: the lead re-pins it, the builder does not.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  [SPEC]: '2acee0f2cbc9035084d1643f895012054e7dd806c368cb48df44914a755d3871',
  [SUPPORT]: 'a88b58f1a73a42dba2a741788381352da357e6702485eddba324034cd6e2228a',
};

/** Every behaviour, by the tag a passing test must carry. */
const REQUIRED: readonly (readonly [tag: string, what: string])[] = [
  ['@bff-session-journey', 'a real browser signs in (password + TOTP) and reads its own programme on /contacts with no injected identity header, no preflight and no second origin'],
  ['@bff-session-csp-clean', 'the sign-in screens and /contacts raise no CSP violation, and no loaded script names the API'],
  ['@bff-session-cookie', 'the cookie is __Host-kasuwa_session, HttpOnly, Secure, SameSite=Lax, Path=/, host-only, Max-Age following expiresAt'],
  ['@bff-session-token-hidden', 'the token is in no storage, URL, body, HTML or console message the page can reach'],
  ['@bff-session-signed-out', 'a signed-out browser is sent to sign-in and shown no contact'],
  ['@bff-session-stub-ignored-browser', 'injected stub headers are inert on the production web process'],
  ['@bff-session-sign-out-control', 'the CRM and admin shells sign out: sign-in screen, cookie gone, session revoked'],
  ['@bff-session-revoked-redirect', 'a session revoked elsewhere sends the browser to sign-in and clears the cookie'],
  ['@bff-session-token-capture', 'the MFA answer sets the cookie and carries no token; the cookie is the API token verbatim'],
  ['@bff-session-lifetime', 'twelve hours, Max-Age follows expiresAt, no sliding window, no rotation'],
  ['@bff-session-one-session', 'signing in again ends the previous session, across tenants too'],
  ['@bff-session-stub-ignored', 'stub identity headers are dropped by every jwt web process, and the cookie identity wins'],
  // Passes on main by design: the other side of ADR-0019 point 7.
  ['@bff-session-stub-forwarded', 'a stub-mode web process still forwards stub identity'],
  ['@bff-session-scope-refused', 'every scope header gets the API 400, cookie or not, either mode, unechoed'],
  ['@bff-session-authorization-dropped', 'a browser-supplied Authorization header is dropped'],
  ['@bff-session-insecure-name-ignored', 'the development cookie name never authenticates'],
  ['@bff-session-csrf', 'every CSRF shape is refused with one body and no side effect; well-formed writes pass'],
  ['@bff-session-login-csrf', 'cross-origin sign-in and MFA never reach the API'],
  // Passes on main by design: the API has no CORS configuration.
  ['@bff-session-no-cors', 'no CORS preflight is answered and no cross-origin read granted'],
  ['@bff-session-sign-out', 'sign-out revokes server-side, clears the cookie whatever happened, and sends Clear-Site-Data'],
  ['@bff-session-401-clears', 'a dead session gets the API 401 verbatim and loses its cookie'],
  ['@bff-session-headers', 'every BFF answer is no-store, nosniff and default-src none'],
  ['@bff-session-navigation', 'a top-level navigation to the API is the generic 404'],
  ['@bff-session-compressed', 'a list response arrives compressed'],
  ['@bff-session-methods', 'GET, HEAD, POST, PUT, PATCH and DELETE are exported'],
  ['@bff-session-no-leak', 'one 404 for elsewhere and nowhere, one 401 for every dead cookie, no upstream address, no stack'],
  ['@bff-session-log-markers', 'refusals echo nothing they were sent'],
  ['@bff-session-tenancy', 'no path, query, header or cookie trick reaches tenant B'],
  // Its probes pass on main (the rewrite has a fixed destination); on main it
  // fails only at its sign-in. A regression guard for a hand-built upstream.
  ['@bff-session-ssrf', 'no request, and no token, goes anywhere but the configured API, or outside /api/v1'],
  ['@bff-session-csp', 'the page CSP, its fresh nonce on every script, on every page response'],
];

/** Every other screen's parent tag. None may contain ours, and ours may contain none (D-L84). */
const OTHER_PARENT_TAGS = [
  '@p01',
  '@p02',
  '@p02-live',
  '@p04',
  '@p04-accounts',
  '@p05-contact',
  '@p05-account',
  '@leads-p04',
  '@p06-pipeline',
  '@p06-deal',
  '@p07',
  '@p10-builder',
  '@p10-agent',
  '@p18-studio',
  '@p18-custom-values',
  '@p27-search',
  '@harness',
  '@byte-budget',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SourceFile {
  file: string;
  source: string;
}

function trackedFiles(directory: string): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', directory], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && existsSync(fromRoot(line)));
}

function webSources(): SourceFile[] {
  return trackedFiles('apps/web')
    .filter((file) => /\.(tsx?|mjs)$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => ({ file, source: readFileSync(fromRoot(file), 'utf8') }));
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function normalisedHash(file: string): string {
  return createHash('sha256').update(readFileSync(fromRoot(file), 'utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** The test tags in a spec's code, comments excluded. */
function tagsIn(file: string): string[] {
  return [...withoutComments(readFileSync(fromRoot(file), 'utf8')).matchAll(/@[a-z0-9][\w-]*/gi)]
    .map((match) => match[0])
    .filter((tag) => /^@(p\d|leads|harness|byte|bff)/i.test(tag));
}

/** ESLint from the workspace root, as node with no shell; the JSON report only. */
function eslintStdin(filename: string, input: string): { messages: { ruleId: string | null; severity: number; message: string }[]; output: string } {
  const require = createRequire(fromRoot('package.json'));
  const bin = resolve(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js');
  const run = spawnSync(process.execPath, [bin, '--stdin', '--stdin-filename', filename, '-f', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const start = (run.stdout ?? '').indexOf('[{');
  if (start === -1) {
    return { messages: [], output };
  }
  const report = JSON.parse((run.stdout ?? '').slice(start)) as { messages: { ruleId: string | null; severity: number; message: string }[] }[];
  return { messages: report[0]?.messages ?? [], output };
}

type Env = Readonly<Record<string, string | undefined>>;

const AMBIENT: Env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/kasuwa', LANG: 'C.UTF-8' };
const LEAK = 'x-t0125-not-a-real-pw';

/** A web environment ADR-0019 accepts, per NODE_ENV. Everything below varies one variable. */
function webBase(nodeEnv: 'development' | 'test' | 'production'): Record<string, string | undefined> {
  return {
    ...AMBIENT,
    NODE_ENV: nodeEnv,
    KASUWA_AUTH_MODE: 'jwt',
    KASUWA_CELL: 'za-1',
    KASUWA_WEB_ORIGIN: 'https://app.kasuwa.example',
    KASUWA_API_INTERNAL_URL: 'https://api.internal.kasuwa.example',
  };
}

function refusal(env: Env): string | undefined {
  try {
    webEnv(env);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ===========================================================================
// 1. The route, the rewrite, the transports (static)
// ===========================================================================

describe('acceptance: T-0125 — one BFF route replaces the rewrite (I21)', () => {
  it('has the catch-all route handler, exporting every method, force-dynamic, on the Node runtime', () => {
    expect(existsSync(fromRoot(ROUTE)), `${ROUTE} does not exist`).toBe(true);
    const code = withoutComments(existsSync(fromRoot(ROUTE)) ? readFileSync(fromRoot(ROUTE), 'utf8') : '');
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b|export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`).test(code),
        `the route handler does not export ${method}`,
      ).toBe(true);
    }
    expect(code, 'the route is not force-dynamic').toMatch(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/);
    expect(code, 'the route runs on the edge runtime').not.toMatch(/export\s+const\s+runtime\s*=\s*['"]edge['"]/);
    expect(trackedFiles('apps/web/app/api').filter((file) => /route\.tsx?$/.test(file) && file !== ROUTE), 'a second API route handler').toEqual([]);
  });

  it('deletes the /api/v1 rewrite and NEXT_PUBLIC_API_URL, and reads the upstream through webEnv only', () => {
    const config = withoutComments(readFileSync(fromRoot('apps/web/next.config.mjs'), 'utf8'));
    expect(config, 'next.config.mjs still rewrites /api/v1').not.toMatch(/\/api\/v1\/:path/);
    expect(config, 'next.config.mjs still declares rewrites()').not.toMatch(/\brewrites\s*\(/);
    const named = webSources().filter(({ source }) => withoutComments(source).includes('NEXT_PUBLIC_API_URL')).map(({ file }) => file);
    expect(named, 'apps/web still names NEXT_PUBLIC_API_URL').toEqual([]);
    const schema = withoutComments(readFileSync(fromRoot('packages/config/src/schemas.mjs'), 'utf8'));
    expect(schema, 'the web schema still declares NEXT_PUBLIC_API_URL').not.toMatch(/NEXT_PUBLIC_API_URL\s*:/);
    expect(schema, 'the web schema does not declare KASUWA_API_INTERNAL_URL').toMatch(/KASUWA_API_INTERNAL_URL\s*:/);
    expect(schema, 'the web schema does not declare KASUWA_WEB_ORIGIN').toMatch(/KASUWA_WEB_ORIGIN\s*:/);
  });

  it('names accessToken only on the server side of apps/web, and no client module imports lib/server', () => {
    const offenders = webSources()
      .filter(({ file }) => !file.startsWith('apps/web/app/api/') && !file.startsWith('apps/web/lib/server/'))
      .filter(({ source }) => /\baccessToken\b/.test(withoutComments(source)))
      .map(({ file }) => file);
    expect(offenders, 'a browser-side module still names accessToken (SessionEstablished becomes { expiresAt, user })').toEqual([]);

    const clientImports = webSources()
      .filter(({ source }) => /^\s*['"]use client['"]/m.test(source))
      .filter(({ source }) => /from\s+['"](?:@\/|(?:\.\.?\/)+)(?:[\w-]+\/)*lib\/server\b|from\s+['"]\.\.?\/server\//.test(withoutComments(source)))
      .map(({ file }) => file);
    expect(clientImports, 'a client module imports lib/server').toEqual([]);
  });

  it('keeps the scope and stub header names and the 400 body in @kasuwa/config, not as literals in the API or the web app (D-L149 #8)', () => {
    const config = trackedFiles('packages/config/src')
      .filter((file) => /\.(m?js|ts)$/.test(file) && !/\.test\.ts$/.test(file))
      .map((file) => withoutComments(readFileSync(fromRoot(file), 'utf8')))
      .join('\n');
    for (const literal of ['x-kasuwa-programme-ids', 'x-kasuwa-programme-id', 'x-kasuwa-scope', 'x-kasuwa-tenant-id', 'x-kasuwa-user-id', 'scope_header_not_accepted']) {
      expect(config.includes(`'${literal}'`) || config.includes(`"${literal}"`), `@kasuwa/config does not define ${literal}`).toBe(true);
    }
    const apiContext = withoutComments(readFileSync(fromRoot('apps/api/src/tenancy/auth-context.ts'), 'utf8'));
    expect(apiContext, 'auth-context.ts still defines the scope header names itself').not.toMatch(/['"]x-kasuwa-programme-ids['"]/);
    expect(apiContext, 'auth-context.ts still defines the 400 body itself').not.toMatch(/['"]scope_header_not_accepted['"]/);
    const webLiterals = webSources()
      .filter(({ source }) => /['"]x-kasuwa-programme-ids['"]|['"]scope_header_not_accepted['"]/.test(withoutComments(source)))
      .map(({ file }) => file);
    expect(webLiterals, 'apps/web hard-codes the scope header policy').toEqual([]);
  });

  it('sends every browser call through apps/web/lib/api-fetch.ts, and ESLint refuses a raw fetch of /api/ anywhere else', () => {
    expect(existsSync(fromRoot(API_FETCH)), `${API_FETCH} does not exist`).toBe(true);
    const wrapper = withoutComments(existsSync(fromRoot(API_FETCH)) ? readFileSync(fromRoot(API_FETCH), 'utf8') : '');
    expect(wrapper, 'the wrapper does not send x-requested-with').toMatch(/x-requested-with/i);
    expect(wrapper, 'the wrapper does not send kasuwa-web').toContain('kasuwa-web');

    // Planted violations. On main this exact content lints clean, so an error
    // here can only come from the rule ADR-0019 step d adds.
    const planted = [
      "export async function probe(): Promise<Response> {\n  return fetch('/api/v1/contacts');\n}\n",
      'export async function probe(id: string): Promise<Response> {\n  return fetch(`/api/v1/contacts/${id}`);\n}\n',
    ];
    for (const input of planted) {
      const { messages, output } = eslintStdin('apps/web/lib/t0125-planted-fetch.ts', input);
      expect(messages.filter((message) => message.severity === 2).length, `ESLint accepts a raw fetch of /api/ outside the wrapper:\n${input}\n${output.slice(-2000)}`).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// 2. Configuration (ADR-0019 point 8, D-L94)
// ===========================================================================

describe('acceptance: T-0125 — webEnv() refuses an unsafe session layer (I3, I22)', () => {
  it('accepts the configurations the ADR allows (the control: a refusal below is about its one variable)', () => {
    expect(refusal(webBase('production')), 'a production https configuration is refused').toBeUndefined();
    expect(refusal({ ...webBase('production'), KASUWA_WEB_ORIGIN: 'http://127.0.0.1:3000', KASUWA_API_INTERNAL_URL: 'http://127.0.0.1:3001' }), 'the e2e production process (loopback http) is refused').toBeUndefined();
    expect(refusal({ ...webBase('production'), KASUWA_WEB_ORIGIN: 'http://localhost:3000', KASUWA_API_INTERNAL_URL: 'http://localhost:3001' }), 'localhost is refused under production').toBeUndefined();
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(refusal({ ...webBase(nodeEnv), KASUWA_SESSION_COOKIE_INSECURE: '1' }), `the insecure flag is refused under ${nodeEnv}`).toBeUndefined();
      expect(refusal({ ...webBase(nodeEnv), KASUWA_WEB_ORIGIN: 'http://web.dev.example:3000', KASUWA_API_INTERNAL_URL: 'http://api.dev.example:3001' }), `plain http is refused under ${nodeEnv}`).toBeUndefined();
    }
  });

  it('requires KASUWA_WEB_ORIGIN and KASUWA_API_INTERNAL_URL in every mode', () => {
    for (const nodeEnv of ['development', 'test', 'production'] as const) {
      expect(refusal({ ...webBase(nodeEnv), KASUWA_WEB_ORIGIN: undefined }), `KASUWA_WEB_ORIGIN missing under ${nodeEnv}`).toBeDefined();
      expect(refusal({ ...webBase(nodeEnv), KASUWA_API_INTERNAL_URL: undefined }), `KASUWA_API_INTERNAL_URL missing under ${nodeEnv}`).toBeDefined();
    }
  });

  it('accepts only a bare origin as KASUWA_WEB_ORIGIN', () => {
    for (const origin of ['https://app.kasuwa.example/login', `https://user:${LEAK}@app.kasuwa.example`, 'app.kasuwa.example', 'not a url', 'https://app.kasuwa.example/?x=1']) {
      const message = refusal({ ...webBase('test'), KASUWA_WEB_ORIGIN: origin });
      expect(message, `KASUWA_WEB_ORIGIN=${origin} was accepted`).toBeDefined();
      expect(message ?? '', 'the refusal echoes the value').not.toContain(LEAK);
    }
  });

  it('refuses a non-loopback http origin, and a non-loopback http API URL, under production', () => {
    for (const origin of ['http://app.kasuwa.example', 'http://127.0.0.1.evil.example:3000', 'http://10.0.0.5:3000']) {
      expect(refusal({ ...webBase('production'), KASUWA_WEB_ORIGIN: origin }), `production accepted KASUWA_WEB_ORIGIN=${origin}`).toBeDefined();
    }
    for (const url of ['http://api.internal.kasuwa.example:3001', 'http://127.0.0.1.evil.example:3001', 'http://10.0.0.6:3001']) {
      expect(refusal({ ...webBase('production'), KASUWA_API_INTERNAL_URL: url }), `production accepted KASUWA_API_INTERNAL_URL=${url} (D-L149 #4)`).toBeDefined();
    }
  });

  it('refuses an API URL carrying credentials, without echoing them', () => {
    const message = refusal({ ...webBase('test'), KASUWA_API_INTERNAL_URL: `https://svc:${LEAK}@api.internal.kasuwa.example` });
    expect(message, 'an API URL with credentials was accepted').toBeDefined();
    expect(message ?? '', 'the refusal echoes the credential').not.toContain(LEAK);
  });

  it('refuses KASUWA_SESSION_COOKIE_INSECURE under production by presence, whatever its value', () => {
    for (const value of ['1', 'true', '0', 'false', '']) {
      expect(refusal({ ...webBase('production'), KASUWA_SESSION_COOKIE_INSECURE: value }), `production booted with KASUWA_SESSION_COOKIE_INSECURE=${JSON.stringify(value)}`).toBeDefined();
    }
  });
});

// ===========================================================================
// 3. The demo proxy goes (point 11)
// ===========================================================================

describe('acceptance: T-0125 — the loopback demo proxy and its stub switcher are gone (I23)', () => {
  it('deletes tools/demo-proxy.mjs and every reference to it, /__demo and port 3100', () => {
    expect(existsSync(fromRoot('tools/demo-proxy.mjs')), 'tools/demo-proxy.mjs still exists').toBe(false);
    const files = [...trackedFiles('tools').filter((file) => /^tools\/demo[\w-]*\.mjs$/.test(file)), 'docs/demo/DEMO.md'].filter((file) => existsSync(fromRoot(file)));
    expect(files.length, 'no demo files to check — the check would be vacuous').toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(fromRoot(file), 'utf8');
      expect(text, `${file} names the demo proxy`).not.toMatch(/demo-proxy/);
      expect(text, `${file} names the /__demo switcher`).not.toMatch(/\/__demo\b/);
      expect(text, `${file} names port 3100`).not.toMatch(/\b3100\b/);
    }
  });
});

// ===========================================================================
// 4. The harness (I1) and the pinned browser half
// ===========================================================================

describe('acceptance: T-0125 — the harness runs a jwt session process and stub-mode header processes (I1)', () => {
  const runner = (): string => readFileSync(fromRoot(RUNNER), 'utf8');

  function startFunction(name: string): string {
    const source = runner();
    const start = source.indexOf(`function ${name}(`);
    expect(start, `run-e2e.mjs has no ${name}()`).toBeGreaterThan(-1);
    const next = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  it('starts the session process from the production build: NODE_ENV=test, jwt, crm_records, published as webSessionUrl', () => {
    const session = startFunction('startSessionWeb');
    expect(session).toMatch(/'next',\s*'start'/);
    expect(session).toMatch(/NODE_ENV:\s*'test'/);
    expect(session).toMatch(/KASUWA_AUTH_MODE:\s*'jwt'/);
    expect(session).toMatch(/KASUWA_FEATURE_FLAGS_ON:\s*'[^']*\bcrm_records\b/);
    expect(session).toMatch(/sessionLayerEnv\(/);
    expect(runner()).toContain('webSessionUrl');
  });

  it('runs the header-injecting processes in stub mode and gives every web process its own origin and the API URL', () => {
    for (const name of ['startRecordsWeb', 'startSelfServeWeb']) {
      expect(startFunction(name), `${name} is not KASUWA_AUTH_MODE=stub (ADR-0019 point 7)`).toMatch(/KASUWA_AUTH_MODE:\s*'stub'/);
    }
    expect(startFunction('startWeb'), 'the default process is not production jwt').toMatch(/NODE_ENV:\s*'production'[\s\S]*KASUWA_AUTH_MODE:\s*'jwt'/);
    for (const name of ['startWeb', 'startRecordsWeb', 'startSelfServeWeb', 'startSessionWeb']) {
      expect(startFunction(name), `${name} is not given its session-layer environment`).toMatch(/\.\.\.sessionLayerEnv\(apiUrl, port\)/);
    }
    const layer = startFunction('sessionLayerEnv');
    expect(layer).toMatch(/KASUWA_WEB_ORIGIN:\s*`http:\/\/127\.0\.0\.1:\$\{port\}`/);
    expect(layer).toMatch(/KASUWA_API_INTERNAL_URL:\s*apiUrl/);
    expect(layer, 'a web process may inherit the insecure cookie flag').toMatch(/KASUWA_SESSION_COOKIE_INSECURE:\s*undefined/);
    expect(runner(), 'some web process sets the insecure cookie flag').not.toMatch(/KASUWA_SESSION_COOKIE_INSECURE:\s*['"`]/);
  });
});

describe('acceptance: T-0125 — the journeys and their helpers are the ones this suite was written with', () => {
  it('pins bff-session.spec.ts and support/bff-session.ts', () => {
    for (const [file, pinned] of Object.entries(PINNED_SHA256)) {
      expect(existsSync(fromRoot(file)), `${file} is missing`).toBe(true);
      expect(normalisedHash(file), `${file} changed. It is part of the T-0125 acceptance contract: ask the lead to re-pin it.`).toBe(pinned);
    }
    const spec = readFileSync(fromRoot(SPEC), 'utf8');
    // The session contexts inject nothing; the one deliberate exception is the
    // negative test on the production process.
    expect(withoutComments(spec).match(/extraHTTPHeaders/g)?.length, 'a session journey injects headers').toBe(1);
    expect(spec).toContain(LOG_MARKER);
  });

  it('owns its tag: @bff-session selects these journeys and nothing else', () => {
    const specs = trackedFiles('tests/e2e').filter((file) => file.endsWith('.spec.ts'));
    expect(specs).toContain(SPEC);
    const ours = tagsIn(SPEC);
    expect(ours.filter((tag) => tag !== E2E_TAG && !tag.startsWith(`${E2E_TAG}-`)), 'the spec carries another tag family').toEqual([]);
    for (const [tag] of REQUIRED) {
      expect(ours, `no journey carries ${tag}`).toContain(tag);
    }
    const clashes = specs
      .filter((file) => file !== SPEC)
      .flatMap((file) => tagsIn(file).filter((tag) => new RegExp(E2E_TAG).test(tag)).map((tag) => `${file}: ${tag}`));
    expect(clashes, `--grep ${E2E_TAG} would also run these`).toEqual([]);
    for (const other of OTHER_PARENT_TAGS) {
      expect(new RegExp(other).test(E2E_TAG), `--grep ${other} runs these journeys`).toBe(false);
      expect(ours.filter((tag) => new RegExp(other).test(tag))).toEqual([]);
    }
  });
});

// ===========================================================================
// 5. The browser — one run of @bff-session
// ===========================================================================

interface E2eRun {
  status: number | null;
  output: string;
  outcomes: E2eOutcome[] | undefined;
}

let e2eRun: E2eRun = { status: null, output: 'the T-0125 e2e run did not start', outcomes: undefined };

function passed(outcome: E2eOutcome): boolean {
  return outcome.status === 'passed' && outcome.expectedStatus === 'passed';
}

function outcomes(): E2eOutcome[] {
  expect(e2eRun.outcomes, `the e2e run wrote no outcomes — it did not get as far as Playwright:\n${e2eRun.output.slice(-6000)}`).toBeDefined();
  return e2eRun.outcomes ?? [];
}

describe('acceptance: T-0125 — the session in a real browser and at the BFF', () => {
  beforeAll(() => {
    rmSync(OUTCOMES_FILE, { force: true });
    const reporter = relative(fromRoot('tests', 'e2e'), fromRoot('tests', 'acceptance', 'support', 'e2e-outcomes-reporter.ts')).replace(/\\/g, '/');
    const run = spawnSync(process.execPath, [fromRoot(RUNNER), '--grep', E2E_TAG, `--reporter=list,${reporter}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
      timeout: E2E_RUN_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
    e2eRun = {
      status: run.status,
      output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error === undefined ? '' : `\n[spawn] ${run.error.message}`}`,
      outcomes: existsSync(OUTCOMES_FILE) ? (JSON.parse(readFileSync(OUTCOMES_FILE, 'utf8')) as E2eOutcome[]) : undefined,
    };
  }, E2E_RUN_TIMEOUT_MS);

  it('runs every @bff-session journey, and every one passes', () => {
    const journeys = outcomes().filter((outcome) => outcome.tags.includes(E2E_TAG));
    // Vacuity guard: a grep that matched nothing also exits 0. One test
    // carries two required tags (@bff-session-journey, @bff-session-csp-clean).
    expect(journeys.length, 'the run reported fewer @bff-session tests than there are behaviours').toBeGreaterThanOrEqual(REQUIRED.length - 1);
    const failing = journeys.filter((outcome) => !passed(outcome)).map((outcome) => `${outcome.status}: ${outcome.title}`);
    expect(failing, `@bff-session tests that did not pass:\n${e2eRun.output.slice(-6000)}`).toEqual([]);
    expect(e2eRun.status, `run-e2e.mjs --grep ${E2E_TAG} did not exit 0`).toBe(0);
  });

  for (const [tag, what] of REQUIRED) {
    it(`proves ${what} (${tag})`, () => {
      const proving = outcomes().filter((outcome) => passed(outcome) && outcome.tags.includes(E2E_TAG) && outcome.tags.includes(tag));
      expect(proving.length, `no PASSING @bff-session test carries ${tag} (skipped and fixme do not count)`).toBeGreaterThan(0);
    });
  }

  it('logs no token, no credential, no PII and nothing a refused request carried (I24)', () => {
    // A negative invariant: it passes on main (nothing there logs these), and
    // it bites once the BFF exists and could. Read only once the run reached
    // Playwright, and only if every server's output is in it, so an empty or
    // partial output cannot pass.
    expect(outcomes().length).toBeGreaterThan(0);
    const output = e2eRun.output;
    for (const label of ['[api]', '[web]', '[web:session]']) {
      expect(output.includes(label), `the run output holds nothing from ${label} — the scan below would be vacuous`).toBe(true);
    }
    const users = SEED_TENANTS.flatMap((tenant) => tenant.users);
    const forbidden: [string, string][] = [
      ['a session token', TOKEN_PREFIX],
      ['the seed password', SEED_PASSWORD],
      ['a refused request marker', LOG_MARKER],
      ['a seeded TOTP secret', 'KASUWATESTSECRET'],
      ...users.map((user): [string, string] => ['a seeded email', user.email]),
      ...SEED_CONTACTS.map((contact): [string, string] => ['a seeded phone number', contact.phoneE164]),
    ];
    const found = forbidden.filter(([, value]) => output.includes(value)).map(([what]) => what);
    expect([...new Set(found)], 'the run output (API, web processes, Playwright) carries these').toEqual([]);
  });
});
