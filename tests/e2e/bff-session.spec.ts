import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import {
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  seedSignIn,
} from '@kasuwa/db';
import {
  CSRF_HEADER,
  INSECURE_COOKIE,
  SCOPE_HEADERS,
  SCOPE_HEADER_REJECTED_BODY,
  SESSION_COOKIE,
  STUB_TENANT_HEADER,
  STUB_USER_HEADER,
  TOKEN_PREFIX,
  apiMe,
  bffMe,
  clearsSession,
  clickSignOut,
  cookiesNamed,
  errorCode,
  header,
  json,
  meId,
  nextTotp,
  raw,
  sameOriginJson,
  sameOriginRead,
  sameOriginWrite,
  sessionCookie,
  signIn,
  signInThroughUi,
  startSignIn,
  submitMfa,
  type RawResponse,
} from './support/bff-session';
import { stack } from './support/stack';

/**
 * T-0125 — THE WEB APP KEEPS A SESSION AFTER SIGN-IN (ADR-0019, D-L147,
 * D-L149). Written by the lead's QA agent before the BFF exists (D-L23), from
 * the ADR and the I-rulings in the header of
 * `tests/acceptance/session/browser-session.acceptance.test.ts`, which runs
 * these journeys once and PINS this file and `support/bff-session.ts` by hash.
 *
 * WHERE EACH HALF RUNS
 *
 *   - `webSessionUrl`: the production build under `next start`,
 *     NODE_ENV=test, `KASUWA_AUTH_MODE=jwt`, `crm_records` on (I1). The
 *     real-browser journeys. NO context here is given `extraHTTPHeaders`: the
 *     only identity any request carries is the session cookie.
 *   - `webUrl`: the default NODE_ENV=production, `jwt` process. The BFF
 *     probes, the CSP and "no production path accepts stub headers".
 *   - `webRecordsUrl`: NODE_ENV=test, `KASUWA_AUTH_MODE=stub` (ADR-0019
 *     point 7), only to show stub identity still crosses a stub-mode web tier.
 *
 * Every API token is valid behind every web process (one API, one cell), so a
 * session made on one process may be presented on another.
 *
 * The HTTP probes use `node:http` (see the support file): a probe sends only
 * the headers it names. A browser cannot omit `Origin` on a POST, or forge
 * `Host`; an attacker's own client can, and the BFF faces both.
 *
 * NO ASSERTION MESSAGE IN THIS FILE QUOTES A TOKEN OR AN AUTH RESPONSE BODY.
 * The acceptance suite scans this run's output for `ksw_s1_`.
 *
 * Tags: every test carries `@bff-session` and one or more `@bff-session-*`.
 * The acceptance suite lists which tags must pass, and which pass on main by
 * design (negative invariants, said so next to each).
 */

// A fresh TOTP step can take up to thirty seconds per sign-in (the API refuses
// a replayed step), and several journeys sign in more than once.
test.describe.configure({ timeout: 240_000 });

const TUNDE = USER_A_AGENT_1; // tenant A, programme A1 only
const NGOZI = USER_A_AGENT_2; // tenant A, programme A2 only
const MUSA = USER_A_SUPERVISOR; // tenant A, A1 and A2, tenant admin
const EMEKA = USER_A_NO_PROGRAMME; // tenant A, no programme
const WANJIRU = USER_B_AGENT_1; // tenant B, programme B1, tenant admin

const NO_SUCH_CONTACT = '00000000-0000-4000-8000-00000000dead';
const EVIL_ORIGIN = 'http://evil.example';
/** Markers the acceptance suite greps the run's server output for (I24). */
const LOG_MARKER = 'T0125-LOG-MARKER';

function contactsIn(programmeId: string): typeof SEED_CONTACTS {
  return SEED_CONTACTS.filter((contact) => contact.programmeId === programmeId);
}

function contactIn(programmeId: string): string {
  const contact = contactsIn(programmeId)[0];
  if (contact === undefined) {
    throw new Error(`no seeded contact in ${programmeId}`);
  }
  return contact.id;
}

function namesIn(programmeId: string): string[] {
  return contactsIn(programmeId).map((contact) => contact.displayName);
}

const TENANT_B_CONTACTS = SEED_CONTACTS.filter((contact) => contact.tenantId === TENANT_B);
const TENANT_A_CONTACTS = SEED_CONTACTS.filter((contact) => contact.tenantId === TENANT_A);

/** Anything of tenant B's that may not appear in an answer to a tenant-A session. */
const TENANT_B_MARKERS = [TENANT_B, ...TENANT_B_CONTACTS.flatMap((contact) => [contact.id, contact.displayName, contact.phoneE164])];

/**
 * Tenant-B markers in an answer, minus any the request itself carried: a
 * redirect that echoes the path the caller typed (`//contacts/<id>` is a 308
 * to `/contacts/<id>`) has confirmed nothing the caller did not already say.
 */
function tenantBIn(text: string, supplied = ''): string[] {
  return TENANT_B_MARKERS.filter((marker) => text.includes(marker) && !supplied.includes(marker));
}

function hasAny(text: string, values: readonly string[]): boolean {
  return values.some((value) => text.includes(value));
}

function stubHeaders(userId: string): Record<string, string> {
  const credentials = seedSignIn(userId);
  if (credentials === undefined) {
    throw new Error(`${userId} is not seeded`);
  }
  return { [STUB_TENANT_HEADER]: credentials.tenantId, [STUB_USER_HEADER]: userId };
}

function requireSessionWeb(): string {
  const { webSessionUrl } = stack();
  expect(webSessionUrl, 'run-e2e.mjs started no session web process (webSessionUrl is empty) — I1').not.toBe('');
  return webSessionUrl;
}

/** Host and port of the API, which no browser-facing answer may name (I16, I18). */
function apiHost(): string {
  return new URL(stack().apiUrl).host;
}

const CSRF_WORDS = /origin|x-requested-with|requested|content-type|sec-fetch|header|referer/i;

function directives(policy: string | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of (policy ?? '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') {
      map.set(name.toLowerCase(), values);
    }
  }
  return map;
}

function noStore(response: RawResponse): boolean {
  const value = (header(response, 'cache-control') ?? '').toLowerCase();
  return /\bno-store\b/.test(value) && !/\bpublic\b/.test(value) && !/max-age=[1-9]/.test(value) && !/s-maxage=[1-9]/.test(value);
}

/** The BFF's own CSP (I14): exactly `default-src 'none'; frame-ancestors 'none'`. */
function bffPolicyOk(response: RawResponse): boolean {
  const policy = directives(header(response, 'content-security-policy'));
  return (
    policy.size === 2 &&
    (policy.get('default-src') ?? []).join(' ') === "'none'" &&
    (policy.get('frame-ancestors') ?? []).join(' ') === "'none'"
  );
}

function bffHeadersProblems(label: string, response: RawResponse): string[] {
  const problems: string[] = [];
  if (!noStore(response)) problems.push(`${label}: Cache-Control is not no-store (${header(response, 'cache-control') ?? 'absent'})`);
  if ((header(response, 'x-content-type-options') ?? '').toLowerCase() !== 'nosniff') problems.push(`${label}: no X-Content-Type-Options: nosniff`);
  if (!bffPolicyOk(response)) problems.push(`${label}: CSP is not exactly default-src 'none'; frame-ancestors 'none' (${header(response, 'content-security-policy') ?? 'absent'})`);
  return problems;
}

/** A response that says nothing about the upstream (I16): no API address, no stack trace. */
function leaksUpstream(response: RawResponse): boolean {
  const host = apiHost();
  const headers = JSON.stringify(response.headers);
  return (
    response.body.includes(host) ||
    headers.includes(host) ||
    /\n\s+at\s+[\w.<>]+\s+\(/.test(response.body) ||
    /ECONNREFUSED|ENOTFOUND|fetch failed/i.test(response.body)
  );
}

async function newSessionContext(browser: Browser): Promise<BrowserContext> {
  // No extraHTTPHeaders, ever, in this file's session contexts.
  return browser.newContext();
}

// ===========================================================================
// 1. The real browser
// ===========================================================================

test.describe('T-0125 — a real browser signs in and keeps its session', () => {
  test('signs in with a password and a TOTP code, then reads its own programme on /contacts with no injected identity @bff-session @bff-session-journey @bff-session-csp-clean', async ({ browser }) => {
    const base = requireSessionWeb();
    const origin = new URL(base).origin;
    const context = await newSessionContext(browser);
    await context.addInitScript(() => {
      const store: string[] = [];
      Object.defineProperty(window, '__t0125Csp', { value: store, configurable: false });
      document.addEventListener('securitypolicyviolation', (event) => {
        store.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    const page = await context.newPage();

    const sent: Promise<{ url: string; method: string; headers: Record<string, string> }>[] = [];
    // request.allHeaders() never settles for a request the page aborts after its response
    // (Playwright 1.63: Chromium sends no request extra-info), e.g. a Link prefetch cut short
    // by navigation. Such a request emits `requestfailed`; fall back to the headers Playwright
    // already holds, which still carry any injected x-kasuwa-* or authorization header (D-L186).
    const failed = new Map<Request, () => void>();
    context.on('requestfailed', (request) => failed.get(request)?.());
    context.on('request', (request) => {
      const onFailed = new Promise<void>((resolve) => failed.set(request, resolve));
      sent.push(
        Promise.race([request.allHeaders(), onFailed.then(() => request.headers())]).then((headers) => ({
          url: request.url(),
          method: request.method(),
          headers,
        })),
      );
    });
    const scripts: Promise<string>[] = [];
    context.on('response', (response) => {
      if (response.request().resourceType() === 'script') {
        scripts.push(response.text().catch(() => ''));
      }
    });
    const cspViolations = async (): Promise<string[]> =>
      page.evaluate(() => (window as unknown as { __t0125Csp?: string[] }).__t0125Csp ?? ['the violation probe was not installed']);

    const mfa = await signInThroughUi(page, base, TUNDE);
    expect(mfa.status(), 'the MFA step did not succeed in the browser').toBe(200);
    const mfaBody = (await mfa.json()) as Record<string, unknown>;
    expect(Object.keys(mfaBody), 'the browser received the token in the MFA body (ADR-0019 point 3)').not.toContain('accessToken');
    expect(Object.keys(mfaBody)).not.toContain('tokenType');
    await expect(page.locator('[data-screen="P01/2"]'), 'the MFA screen never moved on').toHaveCount(0);
    expect(await cspViolations(), 'the sign-in screens broke the CSP (I18)').toEqual([]);

    const contacts = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/contacts' && response.request().method() === 'GET',
    );
    await page.goto(`${base}/contacts`);
    expect((await contacts).status(), 'the contacts read was not authenticated by the cookie').toBe(200);

    for (const name of namesIn(PROGRAMME_A1)) {
      await expect(page.getByText(name, { exact: true }).first(), `${name} (programme A1) is not on /contacts`).toBeVisible();
    }
    for (const contact of SEED_CONTACTS.filter((candidate) => candidate.programmeId !== PROGRAMME_A1)) {
      await expect(page.getByText(contact.displayName, { exact: true }), `${contact.displayName} is outside Tunde's scope`).toHaveCount(0);
    }
    expect(await cspViolations(), '/contacts broke the CSP (I18)').toEqual([]);

    const requests = await Promise.all(sent);
    expect(requests.length).toBeGreaterThan(0);
    const injected = requests
      .filter((request) => Object.keys(request.headers).some((name) => name.toLowerCase().startsWith('x-kasuwa-') || name.toLowerCase() === 'authorization'))
      .map((request) => `${request.method} ${new URL(request.url).pathname}`);
    expect(injected, 'the browser sent an identity or scope header — the journey must rest on the cookie alone').toEqual([]);

    // I19: no CORS preflight (the custom header is same-origin) and no third origin.
    expect(requests.filter((request) => request.method === 'OPTIONS').map((request) => request.url), 'the browser made a preflight').toEqual([]);
    const elsewhere = requests
      .map((request) => request.url)
      .filter((url) => !url.startsWith('data:') && !url.startsWith('blob:') && new URL(url).origin !== origin);
    expect(elsewhere, 'the browser talked to an origin other than the web app').toEqual([]);

    // I18/I19: the API's address is in no script the browser loaded.
    const host = apiHost();
    const bodies = await Promise.all(scripts);
    expect(bodies.length, 'no script was loaded — the check below would be vacuous').toBeGreaterThan(0);
    expect(bodies.filter((source) => source.includes(host)).length, 'a client bundle names the API address').toBe(0);

    await context.close();
  });

  test('stores the session in a host-only __Host- cookie: HttpOnly, Secure, SameSite=Lax, Path=/, dying with the session @bff-session @bff-session-cookie', async ({ browser }) => {
    const base = requireSessionWeb();
    const context = await newSessionContext(browser);
    const page = await context.newPage();

    const mfa = await signInThroughUi(page, base, NGOZI);
    expect(mfa.status()).toBe(200);
    const arrivedAt = Date.now();
    const lines = (await mfa.headersArray()).filter((entry) => entry.name.toLowerCase() === 'set-cookie').map((entry) => entry.value);
    const sessions = cookiesNamed(lines, SESSION_COOKIE).filter((cookie) => cookie.value !== '');
    expect(sessions.length, `the MFA response set no ${SESSION_COOKIE} cookie`).toBe(1);
    const [cookie] = sessions;
    if (cookie === undefined) return;

    expect(cookie.attributes.has('httponly'), 'not HttpOnly').toBe(true);
    expect(cookie.attributes.has('secure'), 'not Secure (loopback keeps Secure, I2)').toBe(true);
    expect((cookie.attributes.get('samesite') ?? '').toLowerCase(), 'SameSite is not Lax (D-L149 #2)').toBe('lax');
    expect(cookie.attributes.get('path'), 'Path is not /').toBe('/');
    expect(cookie.attributes.has('domain'), 'a Domain attribute makes it a cross-subdomain cookie').toBe(false);
    const maxAge = Number(cookie.attributes.get('max-age'));
    expect(Number.isInteger(maxAge) && maxAge > 0, 'no positive integer Max-Age').toBe(true);
    const expiresAt = Date.parse(String((await mfa.json() as { expiresAt?: unknown }).expiresAt));
    expect(Number.isFinite(expiresAt), 'the MFA body lost expiresAt').toBe(true);
    expect(Math.abs(maxAge - (expiresAt - arrivedAt) / 1000), 'Max-Age does not follow the session expiresAt (I7)').toBeLessThanOrEqual(5);
    expect(maxAge, 'the cookie outlives the 12-hour session').toBeLessThanOrEqual(12 * 3600);

    const stored = (await context.cookies()).filter((candidate) => candidate.name === SESSION_COOKIE);
    expect(stored.length, 'the browser did not store the cookie').toBe(1);
    const [jar] = stored;
    expect(jar?.httpOnly).toBe(true);
    expect(jar?.secure).toBe(true);
    expect(jar?.sameSite).toBe('Lax');
    expect(jar?.path).toBe('/');
    expect(jar?.domain, 'the stored cookie is not host-only').toBe(new URL(base).hostname);
    expect(jar?.value === cookie.value, 'the stored value differs from the one set').toBe(true);

    const visible = await page.evaluate(() => document.cookie);
    expect(visible.includes(SESSION_COOKIE), 'page JavaScript can see the session cookie').toBe(false);
    await context.close();
  });

  test('never lets the token reach page JavaScript, storage, a URL, a response body or the console @bff-session @bff-session-token-hidden', async ({ browser }) => {
    const base = requireSessionWeb();
    const context = await newSessionContext(browser);
    const page = await context.newPage();
    const origin = new URL(base).origin;

    const consoleText: string[] = [];
    page.on('console', (message) => consoleText.push(message.text()));
    page.on('pageerror', (error) => consoleText.push(`${error.name}: ${error.message}\n${error.stack ?? ''}`));
    const urls: string[] = [];
    const bodies: Promise<string>[] = [];
    context.on('request', (request) => urls.push(request.url()));
    context.on('response', (response) => {
      // API answers only: they are finite JSON. A streamed RSC or document
      // body can stay open for as long as the page does, and awaiting one
      // hangs the test (found against a reference build). The rendered HTML
      // is read from the DOM below instead.
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith('/api/')) {
        bodies.push(response.text().catch(() => ''));
      }
    });
    page.on('framenavigated', (frame) => urls.push(frame.url()));

    expect((await signInThroughUi(page, base, MUSA)).status()).toBe(200);
    await page.goto(`${base}/contacts`);
    await expect(page.getByText(namesIn(PROGRAMME_A2)[0] ?? '', { exact: true }).first()).toBeVisible();
    await page.goto(`${base}/admin`);
    await expect(page.locator('[data-screen="P02/A"]')).toBeVisible();

    const token = (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '';
    expect(token.length, 'no session cookie to look for').toBeGreaterThan(0);
    const holds = (text: string): boolean => text.includes(token) || text.includes(TOKEN_PREFIX);

    const reachable = await page.evaluate(() => {
      const dump = (storage: Storage): string =>
        JSON.stringify(Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index) ?? '';
          return [key, storage.getItem(key)];
        }));
      return {
        cookie: document.cookie,
        local: dump(localStorage),
        session: dump(sessionStorage),
        name: window.name,
        href: location.href,
        html: document.documentElement.outerHTML,
      };
    });
    expect(holds(reachable.cookie), 'document.cookie holds the token').toBe(false);
    expect(holds(reachable.local), 'localStorage holds the token').toBe(false);
    expect(holds(reachable.session), 'sessionStorage holds the token').toBe(false);
    expect(holds(reachable.name) || holds(reachable.href), 'window.name or the URL holds the token').toBe(false);
    expect(urls.filter(holds).length, 'a request or navigation URL holds the token').toBe(0);
    const texts = await Promise.all(bodies);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter(holds).length, 'an API response body the page received holds the token').toBe(0);
    expect(holds(reachable.html), 'the rendered HTML holds the token').toBe(false);
    expect(consoleText.filter(holds).length, 'a console message or page error holds the token').toBe(0);
    await context.close();
  });

  test('sends a signed-out browser to sign-in and shows it no contact @bff-session @bff-session-signed-out', async ({ browser }) => {
    const base = requireSessionWeb();
    const context = await newSessionContext(browser);
    const page = await context.newPage();
    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/contacts' && response.request().method() === 'GET',
    );
    await page.goto(`${base}/contacts`);
    // Status only: the page navigates to sign-in on this 401, and the browser
    // drops the body with the document. The same read, made directly:
    expect((await read).status(), 'a signed-out contacts read was not refused').toBe(401);
    const direct = await raw(base, { path: '/api/v1/contacts', headers: sameOriginRead() });
    expect(direct.status).toBe(401);
    expect(hasAny(direct.body, SEED_CONTACTS.map((contact) => contact.displayName)), 'a signed-out read carried contacts').toBe(false);

    await expect(page.locator('[data-screen="P01/1"]'), 'the signed-out browser was not sent to sign-in (I6)').toBeVisible();
    expect(new URL(page.url()).pathname, 'sign-in is at /').toBe('/');
    expect(hasAny(await page.content(), SEED_CONTACTS.map((contact) => contact.displayName)), 'contact data was rendered to a signed-out browser').toBe(false);
    await context.close();
  });

  test('ignores injected stub identity headers on the production web process @bff-session @bff-session-stub-ignored-browser', async ({ browser }) => {
    const { webUrl } = stack();
    // The ONE context in this file that injects headers: the negative test
    // ADR-0019 point 7 asks for. On the production process they must be inert.
    const context = await browser.newContext({ extraHTTPHeaders: stubHeaders(TUNDE) });
    const page = await context.newPage();
    await page.goto(webUrl);
    const answers = await page.evaluate(async () => {
      const read = async (path: string) => {
        const response = await fetch(path);
        return { path, status: response.status, text: await response.text() };
      };
      return [await read('/api/v1/auth/me'), await read('/api/v1/contacts')];
    });
    for (const answer of answers) {
      expect(answer.status, `${answer.path} accepted stub identity on the production web process`).toBe(401);
      expect(hasAny(answer.text, TENANT_A_CONTACTS.map((contact) => contact.displayName))).toBe(false);
    }
    await context.close();
  });

  test('signs out from the CRM shell and from the admin shell, and the old cookie is dead server-side @bff-session @bff-session-sign-out-control', async ({ browser }) => {
    const base = requireSessionWeb();
    const { apiUrl } = stack();
    const shells: [user: string, path: string, ready: (page: Page) => Promise<void>][] = [
      [TUNDE, '/contacts', async (page) => { await expect(page.getByText(namesIn(PROGRAMME_A1)[0] ?? '', { exact: true }).first()).toBeVisible(); }],
      [MUSA, '/admin', async (page) => { await expect(page.locator('[data-screen="P02/A"]')).toBeVisible(); }],
    ];
    for (const [user, path, ready] of shells) {
      const context = await newSessionContext(browser);
      const page = await context.newPage();
      expect((await signInThroughUi(page, base, user)).status()).toBe(200);
      await page.goto(`${base}${path}`);
      await ready(page);
      const token = (await context.cookies()).find((cookie) => cookie.name === SESSION_COOKIE)?.value ?? '';
      expect(token.length).toBeGreaterThan(0);

      const signOut = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/v1/auth/sign-out' && response.request().method() === 'POST',
      );
      await clickSignOut(page);
      const answer = await signOut;
      expect(answer.status(), `sign-out from ${path} failed`).toBeLessThan(300);
      await expect(page.locator('[data-screen="P01/1"]'), `signing out of ${path} did not land on sign-in`).toBeVisible();
      expect((await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE), 'the cookie survived sign-out').toBe(false);

      expect((await bffMe(base, sessionCookie(token))).status, 'the old cookie value still works through the BFF').toBe(401);
      expect((await apiMe(apiUrl, token)).status, 'sign-out did not revoke the session at the API').toBe(401);
      await context.close();
    }
  });

  test('a session revoked elsewhere sends the browser to sign-in on its next read and clears the cookie @bff-session @bff-session-revoked-redirect', async ({ browser }) => {
    const base = requireSessionWeb();
    const session = await signIn(base, WANJIRU);
    const context = await newSessionContext(browser);
    // The cookie set by hand, exactly as the BFF set it: proves the browser
    // needs nothing but this cookie (the value is the API token verbatim).
    await context.addCookies([{ name: SESSION_COOKIE, value: session.token, domain: new URL(base).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    await page.goto(`${base}/contacts`);
    await expect(page.getByText(namesIn(PROGRAMME_B1)[0] ?? '', { exact: true }).first(), 'a hand-set session cookie did not authenticate').toBeVisible();

    const revoked = await raw(base, { method: 'POST', path: '/api/v1/auth/sign-out', headers: { ...sameOriginWrite(base), cookie: sessionCookie(session.token) } });
    expect(revoked.status).toBeLessThan(300);

    const read = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/contacts' && response.request().method() === 'GET',
    );
    await page.reload();
    expect((await read).status()).toBe(401);
    await expect(page.locator('[data-screen="P01/1"]'), 'a 401 did not send the browser to sign-in (I6)').toBeVisible();
    expect((await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE), 'the 401 did not clear the dead cookie').toBe(false);
    await context.close();
  });
});

// ===========================================================================
// 2. Capturing the token, the cookie's lifetime, one session per profile
// ===========================================================================

test.describe('T-0125 — the BFF captures the token and the browser never holds it', () => {
  test('answers the MFA with the cookie and a body that has no token @bff-session @bff-session-token-capture', async () => {
    const { webUrl, apiUrl } = stack();
    const session = await signIn(webUrl, EMEKA);
    const keys = Object.keys(session.mfaBody);
    expect(keys, 'the MFA body still carries accessToken').not.toContain('accessToken');
    expect(keys, 'the MFA body still carries tokenType').not.toContain('tokenType');
    expect(typeof session.mfaBody.expiresAt, 'the MFA body lost expiresAt').toBe('string');
    const user = session.mfaBody.user as { id?: unknown; tenantId?: unknown } | undefined;
    expect(user?.id).toBe(EMEKA);
    expect(user?.tenantId).toBe(TENANT_A);
    expect(session.mfa.body.includes(session.token) || session.mfa.body.includes(TOKEN_PREFIX), 'the MFA body holds a token').toBe(false);
    expect(noStore(session.mfa), 'the MFA answer is cacheable').toBe(true);

    // The value is the API's opaque token, verbatim (ADR-0019 point 2).
    expect(session.token.startsWith(TOKEN_PREFIX), 'the cookie value is not the API token').toBe(true);
    expect(meId(await apiMe(apiUrl, session.token)), 'the cookie value does not authenticate at the API as Bearer').toBe(EMEKA);
    expect(`${SESSION_COOKIE}=${session.token}`.length, 'the cookie costs more than 96 bytes per request (I8)').toBeLessThanOrEqual(96);
  });

  test('keeps the API lifetime: Max-Age follows expiresAt, twelve hours, no refresh, no sliding, no rotation @bff-session @bff-session-lifetime', async () => {
    const { webUrl } = stack();
    const session = await signIn(webUrl, NGOZI);
    const expiresAt = Date.parse(String(session.mfaBody.expiresAt));
    expect(Math.abs(expiresAt - (session.receivedAt + 12 * 3600 * 1000)), 'the session is not twelve hours (D-L149 #1)').toBeLessThanOrEqual(120_000);
    const maxAge = Number(session.cookie.attributes.get('max-age'));
    expect(Math.abs(maxAge - (expiresAt - session.receivedAt) / 1000)).toBeLessThanOrEqual(5);
    const expires = session.cookie.attributes.get('expires');
    if (expires !== undefined) {
      expect(Date.parse(expires), 'Expires is later than the session').toBeLessThanOrEqual(expiresAt + 5_000);
    }

    for (const path of ['/api/v1/auth/me', '/api/v1/contacts']) {
      const answer = await raw(webUrl, { path, headers: { ...sameOriginRead(), cookie: sessionCookie(session.token) } });
      expect(answer.status, `${path} with a live cookie`).toBe(200);
      expect(cookiesNamed(answer.setCookies, SESSION_COOKIE).length, `${path} re-issued the session cookie (no sliding window, no rotation)`).toBe(0);
    }
  });

  test('ends the previous session when the same profile signs in again, as the same user or into another tenant @bff-session @bff-session-one-session', async () => {
    const { webUrl, apiUrl } = stack();
    const first = await signIn(webUrl, MUSA);
    const second = await signIn(webUrl, MUSA, sessionCookie(first.token));
    expect(second.token === first.token, 'the second sign-in reused the first token').toBe(false);
    expect((await apiMe(apiUrl, first.token)).status, 'signing in again left the previous session live').toBe(401);
    expect(meId(await apiMe(apiUrl, second.token))).toBe(MUSA);

    const other = await signIn(webUrl, WANJIRU, sessionCookie(second.token));
    expect((await apiMe(apiUrl, second.token)).status, 'signing into tenant B left the tenant-A session live').toBe(401);
    const me = json(await bffMe(webUrl, sessionCookie(other.token))) as { id?: unknown; tenantId?: unknown } | undefined;
    expect(me?.id).toBe(WANJIRU);
    expect(me?.tenantId).toBe(TENANT_B);
  });
});

// ===========================================================================
// 3. Identity and scope headers
// ===========================================================================

test.describe('T-0125 — identity comes from the cookie alone; scope from the session alone', () => {
  test('drops stub identity headers on every jwt web process, and a cookie identity wins @bff-session @bff-session-stub-ignored', async () => {
    const { webUrl } = stack();
    const base = requireSessionWeb();
    for (const target of [webUrl, base]) {
      for (const path of ['/api/v1/auth/me', '/api/v1/contacts', '/api/v1/admin/programmes']) {
        const answer = await raw(target, { path, headers: { ...sameOriginRead(), ...stubHeaders(MUSA) } });
        // Status only: behind the harness's stub-mode API a request with no
        // identity at all meets the stub guard's 401, whose body differs from
        // the session guard's. Either way, it is not Musa's answer.
        expect(answer.status, `${target}${path} accepted stub identity`).toBe(401);
      }
      const write = await raw(target, {
        method: 'POST',
        path: '/api/v1/contacts',
        headers: { ...sameOriginJson(target), ...stubHeaders(MUSA) },
        body: JSON.stringify({ displayName: `${LOG_MARKER}-stub-write`, programmeId: PROGRAMME_A1 }),
      });
      expect(write.status, `${target} accepted a stub-identity write`).toBe(401);
    }

    const session = await signIn(webUrl, EMEKA);
    const answer = await bffMe(webUrl, sessionCookie(session.token), {
      ...stubHeaders(WANJIRU),
      'x-kasuwa-feature-flags': 'admin_live_api',
      'x-kasuwa-anything': '1',
    });
    expect(meId(answer), 'stub headers beside a cookie were not dropped silently').toBe(EMEKA);
  });

  test('still forwards stub identity on a stub-mode web process (records, NODE_ENV=test) @bff-session @bff-session-stub-forwarded', async () => {
    // Passes on main by design (the rewrite forwards everything): it pins the
    // other side of ADR-0019 point 7, so the header-injecting specs that run
    // on this process keep working once the BFF lands.
    const { webRecordsUrl } = stack();
    expect(meId(await bffMe(webRecordsUrl, undefined, stubHeaders(TUNDE))), 'a stub-mode web process did not forward stub identity').toBe(TUNDE);
  });

  test('refuses every scope header with the API 400, with a cookie or without, in either mode @bff-session @bff-session-scope-refused', async () => {
    const { webUrl, webRecordsUrl } = stack();
    const session = await signIn(webUrl, WANJIRU);
    const cases: [string, string, Record<string, string>][] = [];
    for (const name of SCOPE_HEADERS) {
      cases.push([webUrl, `${name} without a cookie`, { [name]: `${PROGRAMME_B1},${LOG_MARKER}-scope` }]);
      cases.push([webUrl, `${name} with a cookie`, { [name]: PROGRAMME_A2, cookie: sessionCookie(session.token) }]);
      cases.push([webRecordsUrl, `${name} in stub mode`, { [name]: PROGRAMME_A2, ...stubHeaders(TUNDE) }]);
    }
    for (const [target, label, headers] of cases) {
      const answer = await raw(target, { path: '/api/v1/contacts', headers: { ...sameOriginRead(), ...headers } });
      expect(answer.status, `${label}: not refused`).toBe(400);
      expect(json(answer), `${label}: not the API's scope-header body`).toEqual(SCOPE_HEADER_REJECTED_BODY);
      expect(answer.body.includes(LOG_MARKER) || answer.body.includes(PROGRAMME_B1), `${label}: the refusal echoes the header`).toBe(false);
    }
  });

  test('drops a browser-supplied Authorization header: the browser path is cookie-only @bff-session @bff-session-authorization-dropped', async () => {
    const { webUrl } = stack();
    const a = await signIn(webUrl, TUNDE);
    const b = await signIn(webUrl, WANJIRU);
    expect((await bffMe(webUrl, undefined, { authorization: `Bearer ${b.token}` })).status, 'a Bearer header through the BFF authenticated').toBe(401);
    expect(meId(await bffMe(webUrl, sessionCookie(a.token), { authorization: `Bearer ${b.token}` })), 'a Bearer header beside a cookie changed the identity').toBe(TUNDE);
  });

  test('never accepts the development cookie name where the insecure flag is absent @bff-session @bff-session-insecure-name-ignored', async () => {
    const { webUrl } = stack();
    const base = requireSessionWeb();
    const session = await signIn(webUrl, EMEKA);
    for (const target of [webUrl, base]) {
      const answer = await bffMe(target, `${INSECURE_COOKIE}=${session.token}`);
      expect(answer.status, `${target} accepted ${INSECURE_COOKIE}`).toBe(401);
    }
  });
});

// ===========================================================================
// 4. CSRF
// ===========================================================================

test.describe('T-0125 — CSRF on every unsafe method', () => {
  test('refuses every cookie-borne write that lacks an exact Origin, the custom header or a JSON body, bodyless POSTs included, with no side effect @bff-session @bff-session-csrf', async () => {
    const { webUrl } = stack();
    const session = await signIn(webUrl, NGOZI);
    const cookie = sessionCookie(session.token);
    const good = sameOriginWrite(webUrl);
    const port = Number(new URL(webUrl).port);
    const without = (name: string): Record<string, string> => Object.fromEntries(Object.entries(good).filter(([key]) => key !== name));

    // Sign-out is the side-effect detector: if a refused request ever reached
    // the API, the session is revoked and the next /auth/me is 401.
    const cases: [label: string, headers: Record<string, string>, body?: string][] = [
      ['a cross-origin Origin', { ...good, origin: EVIL_ORIGIN }],
      ['no Origin', without('origin')],
      ['Origin: null', { ...good, origin: 'null' }],
      ['an Origin with a trailing slash', { ...good, origin: `${new URL(webUrl).origin}/` }],
      ['the right host on another port', { ...good, origin: `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}` }],
      ['the right host on https', { ...good, origin: `https://127.0.0.1:${port}` }],
      ['Origin matching a forged Host', { ...good, origin: EVIL_ORIGIN, host: 'evil.example' }],
      ['Origin matching a forged X-Forwarded-Host', { ...good, origin: EVIL_ORIGIN, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' }],
      ['Sec-Fetch-Site: cross-site', { ...good, 'sec-fetch-site': 'cross-site' }],
      ['Sec-Fetch-Site: same-site', { ...good, 'sec-fetch-site': 'same-site' }],
      ['Sec-Fetch-Site: none', { ...good, 'sec-fetch-site': 'none' }],
      ['no x-requested-with', without(CSRF_HEADER)],
      ['x-requested-with: XMLHttpRequest', { ...good, [CSRF_HEADER]: 'XMLHttpRequest' }],
      ['a text/plain body', { ...good, 'content-type': 'text/plain' }, '{}'],
      ['a text/plain;charset body', { ...good, 'content-type': 'text/plain; charset=utf-8' }, '{}'],
      ['a form body', { ...good, 'content-type': 'application/x-www-form-urlencoded' }, 'a=1'],
      ['a multipart body', { ...good, 'content-type': 'multipart/form-data; boundary=t0125' }, '--t0125\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--t0125--\r\n'],
      ['a body with no Content-Type', good, '{}'],
      ['a bodyless no-cors POST (no header, no type)', without(CSRF_HEADER)],
      ['a bodyless cross-site form POST (no Fetch Metadata)', { origin: EVIL_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }],
      ['a bodyless same-origin form POST', { ...without(CSRF_HEADER), 'content-type': 'application/x-www-form-urlencoded' }],
    ];

    const bodies = new Set<string>();
    for (const [label, headers, body] of cases) {
      const answer = await raw(webUrl, { method: 'POST', path: '/api/v1/auth/sign-out', headers: { ...headers, cookie }, body });
      expect(answer.status, `${label}: not refused`).toBe(403);
      expect(errorCode(answer), `${label}: not csrf_rejected`).toBe('csrf_rejected');
      expect(CSRF_WORDS.test(answer.body), `${label}: the refusal names the check`).toBe(false);
      expect(cookiesNamed(answer.setCookies, SESSION_COOKIE).length, `${label}: a refusal touched the session cookie`).toBe(0);
      bodies.add(answer.body);
      expect(meId(await bffMe(webUrl, cookie)), `${label}: the refused request reached the API (the session was revoked)`).toBe(NGOZI);
    }
    expect(bodies.size, 'the refusal body differs by reason').toBe(1);

    // A cross-site form POST from a current browser is also a navigation, so
    // the navigation refusal (404) may answer it first. Either refusal will
    // do; reaching the API will not.
    const formNavigation = await raw(webUrl, {
      method: 'POST',
      path: '/api/v1/auth/sign-out',
      headers: { origin: EVIL_ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', cookie },
    });
    expect([403, 404], 'a cross-site form navigation was not refused').toContain(formNavigation.status);
    expect(meId(await bffMe(webUrl, cookie)), 'the cross-site form navigation reached the API').toBe(NGOZI);

    for (const [method, body] of [['PUT', '{}'], ['PATCH', '{}'], ['DELETE', undefined]] as const) {
      const answer = await raw(webUrl, {
        method,
        path: `/api/v1/contacts/${NO_SUCH_CONTACT}`,
        headers: { ...without(CSRF_HEADER), ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie },
        body,
      });
      expect(answer.status, `${method} without the header: not refused before the API`).toBe(403);
      expect(errorCode(answer)).toBe('csrf_rejected');
    }

    // Controls: what passes, passes. A JSON write with all three reaches the
    // API; a bodyless POST with Origin and the header needs no type.
    const lookup = await raw(webUrl, {
      method: 'POST',
      path: '/api/v1/auth/sso/lookup',
      headers: sameOriginJson(webUrl),
      body: JSON.stringify({ email: `nobody@${LOG_MARKER.toLowerCase()}.example` }),
    });
    expect(errorCode(lookup), 'a well-formed JSON write was refused as CSRF').not.toBe('csrf_rejected');
    const signOut = await raw(webUrl, { method: 'POST', path: '/api/v1/auth/sign-out', headers: { ...good, cookie } });
    expect(signOut.status, 'a well-formed bodyless POST was refused').toBeLessThan(300);
    expect((await bffMe(webUrl, cookie)).status, 'the control sign-out did not take effect').toBe(401);
  });

  test('refuses login CSRF: sign-in and MFA from another origin never reach the API @bff-session @bff-session-login-csrf', async () => {
    const { webUrl } = stack();
    const credentials = seedSignIn(TUNDE);
    if (credentials === undefined) throw new Error('unseeded');
    const body = JSON.stringify({ tenantSlug: credentials.tenantSlug, email: credentials.email, password: credentials.password });
    const refusals: [string, Record<string, string>][] = [
      ['a cross-origin sign-in', { ...sameOriginJson(webUrl), origin: EVIL_ORIGIN, 'sec-fetch-site': 'cross-site' }],
      ['a sign-in without the header', Object.fromEntries(Object.entries(sameOriginJson(webUrl)).filter(([key]) => key !== CSRF_HEADER))],
      ['a text/plain sign-in', { ...sameOriginWrite(webUrl), 'content-type': 'text/plain' }],
    ];
    for (const [label, headers] of refusals) {
      const answer = await raw(webUrl, { method: 'POST', path: '/api/v1/auth/sign-in', headers, body });
      expect(answer.status, `${label}: not refused`).toBe(403);
      expect(errorCode(answer)).toBe('csrf_rejected');
      expect(answer.body.includes('challengeId'), `${label}: a challenge was issued`).toBe(false);
    }

    const { challengeId } = await startSignIn(webUrl, TUNDE);
    const code = await nextTotp(TUNDE);
    const forged = await submitMfa(webUrl, challengeId, code, { ...sameOriginJson(webUrl), origin: EVIL_ORIGIN, 'sec-fetch-site': 'cross-site' });
    expect(forged.status, 'a cross-origin MFA was not refused').toBe(403);
    expect(cookiesNamed(forged.setCookies, SESSION_COOKIE).filter((cookie) => cookie.value !== '').length).toBe(0);
    // The SAME code now succeeds. Had the forged request reached the API, the
    // step would be spent and this would be refused as a replay.
    const real = await submitMfa(webUrl, challengeId, code);
    expect(real.status, 'the refused MFA reached the API and spent the code').toBe(200);
    expect(cookiesNamed(real.setCookies, SESSION_COOKIE).filter((cookie) => cookie.value !== '').length).toBe(1);
  });

  test('answers no CORS preflight and grants no cross-origin read @bff-session @bff-session-no-cors', async () => {
    // Passes on main by design (the API has no CORS configuration): a
    // regression guard, because the custom header is only a CSRF control
    // while nothing at this origin answers a preflight.
    const { webUrl } = stack();
    const preflight = await raw(webUrl, {
      method: 'OPTIONS',
      path: '/api/v1/auth/sign-out',
      headers: { origin: EVIL_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': `${CSRF_HEADER},content-type` },
    });
    const read = await raw(webUrl, { path: '/api/v1/auth/me', headers: { origin: EVIL_ORIGIN } });
    for (const answer of [preflight, read]) {
      for (const name of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-credentials', 'access-control-allow-methods']) {
        expect(header(answer, name), `${name} was granted to another origin`).toBeUndefined();
      }
    }
  });
});

// ===========================================================================
// 5. Sign-out, 401, response headers, navigation, compression, methods
// ===========================================================================

test.describe('T-0125 — sign-out, revocation and what every BFF answer carries', () => {
  test('signs out: revokes server-side, clears the cookie whatever the API said, and clears the cache @bff-session @bff-session-sign-out', async () => {
    const { webUrl, apiUrl } = stack();
    const session = await signIn(webUrl, EMEKA);
    const answer = await raw(webUrl, { method: 'POST', path: '/api/v1/auth/sign-out', headers: { ...sameOriginWrite(webUrl), cookie: sessionCookie(session.token) } });
    expect(answer.status).toBeLessThan(300);
    expect(clearsSession(answer.setCookies), 'sign-out did not clear the __Host- cookie (Max-Age=0, Secure, Path=/, no Domain)').toBe(true);
    expect((header(answer, 'clear-site-data') ?? '').includes('"cache"'), 'no Clear-Site-Data: "cache"').toBe(true);

    expect((await bffMe(webUrl, sessionCookie(session.token))).status, 'replaying the old cookie value still works').toBe(401);
    expect((await apiMe(apiUrl, session.token)).status, 'the API still honours the signed-out token').toBe(401);

    for (const [label, cookie] of [['no cookie', undefined], ['a garbage cookie', sessionCookie(`${TOKEN_PREFIX}t0125-garbage`)]] as const) {
      const again = await raw(webUrl, { method: 'POST', path: '/api/v1/auth/sign-out', headers: { ...sameOriginWrite(webUrl), ...(cookie === undefined ? {} : { cookie }) } });
      expect(again.status, `sign-out with ${label}`).toBeLessThan(300);
      expect(clearsSession(again.setCookies), `sign-out with ${label} did not clear the cookie`).toBe(true);
    }
  });

  test('answers a dead session with the API 401 and clears the cookie @bff-session @bff-session-401-clears', async () => {
    const { webUrl, apiUrl } = stack();
    const apiBody = json(await raw(apiUrl, { path: '/api/v1/auth/me', headers: { authorization: `Bearer ${TOKEN_PREFIX}t0125-unknown` } }));
    expect(apiBody, 'the API itself did not answer 401 not_authenticated — the comparison is meaningless').toMatchObject({ code: 'not_authenticated' });
    const answer = await bffMe(webUrl, sessionCookie(`${TOKEN_PREFIX}t0125-unknown`));
    expect(answer.status).toBe(401);
    expect(json(answer), 'the BFF 401 is not the API body verbatim').toEqual(apiBody);
    expect(clearsSession(answer.setCookies), 'a 401 left the dead cookie in place').toBe(true);
  });

  test('marks every BFF answer no-store, nosniff and default-src none @bff-session @bff-session-headers', async () => {
    const { webUrl } = stack();
    const session = await signIn(webUrl, EMEKA);
    const cookie = sessionCookie(session.token);
    const answers: [string, RawResponse][] = [
      ['the MFA 200', session.mfa],
      ['a 200 read', await bffMe(webUrl, cookie)],
      ['a 401', await bffMe(webUrl)],
      ['a 400 scope refusal', await bffMe(webUrl, cookie, { 'x-kasuwa-scope': 'all' })],
      ['a 403 CSRF refusal', await raw(webUrl, { method: 'POST', path: '/api/v1/auth/sign-out', headers: { cookie } })],
      ['a 404', await raw(webUrl, { path: '/api/v1/no-such-route-t0125', headers: { ...sameOriginRead(), cookie } })],
      ['a sign-out', await raw(webUrl, { method: 'POST', path: '/api/v1/auth/sign-out', headers: { ...sameOriginWrite(webUrl), cookie } })],
    ];
    const problems = answers.flatMap(([label, answer]) => bffHeadersProblems(label, answer));
    expect(problems).toEqual([]);
  });

  test('refuses a top-level navigation to the API as the generic 404 @bff-session @bff-session-navigation', async ({ browser }) => {
    const { webUrl } = stack();
    const session = await signIn(webUrl, NGOZI);
    const cookie = sessionCookie(session.token);
    const credentials = seedSignIn(NGOZI);
    const secrets = [credentials?.email ?? 'unseeded', 'Ngozi Okeke', NGOZI];

    const generic = await raw(webUrl, { path: '/api/v1/no-such-route-t0125', headers: { ...sameOriginRead(), cookie } });
    expect(generic.status).toBe(404);
    const control = await bffMe(webUrl, cookie);
    expect(meId(control), 'the control read failed — the refusals below would prove nothing').toBe(NGOZI);

    const navigations: Record<string, string>[] = [
      { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' },
      { 'sec-fetch-dest': 'document' },
      { 'sec-fetch-mode': 'navigate' },
      { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of navigations) {
      for (const withCookie of [true, false]) {
        const answer = await raw(webUrl, { path: '/api/v1/auth/me', headers: { ...headers, ...(withCookie ? { cookie } : {}) } });
        const label = `${JSON.stringify(headers)}${withCookie ? ' with the cookie' : ''}`;
        expect(answer.status, `${label}: a navigation was answered`).toBe(404);
        expect(answer.body, `${label}: not the generic 404`).toBe(generic.body);
        expect(hasAny(answer.body, secrets), `${label}: the refusal carries user data`).toBe(false);
      }
    }

    const context = await newSessionContext(browser);
    await context.addCookies([{ name: SESSION_COOKIE, value: session.token, domain: new URL(webUrl).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const landed = await page.goto(`${webUrl}/api/v1/auth/me`);
    expect(landed?.status(), 'a browser navigation to the API was answered').toBe(404);
    expect(hasAny(await page.content(), secrets), 'a navigation rendered user data').toBe(false);
    await context.close();
  });

  test('delivers a list response compressed @bff-session @bff-session-compressed', async () => {
    const { webUrl } = stack();
    const session = await signIn(webUrl, MUSA);
    const answer = await raw(webUrl, {
      path: '/api/v1/contacts',
      headers: { ...sameOriginRead(), cookie: sessionCookie(session.token), 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(answer.status).toBe(200);
    expect(answer.body.length, 'the list is too small for compression to be expected — the probe needs a larger list').toBeGreaterThan(1100);
    expect(answer.encoding ?? '', 'the list arrived uncompressed (ADR-0019 point 6)').toMatch(/^(gzip|br|deflate|zstd)$/);
    expect(answer.wireBytes).toBeLessThan(Buffer.byteLength(answer.body, 'utf8'));
  });

  test('exports every method: GET, HEAD, POST, PUT, PATCH and DELETE reach the API @bff-session @bff-session-methods', async () => {
    const { webUrl } = stack();
    const session = await signIn(webUrl, EMEKA);
    const cookie = sessionCookie(session.token);
    const head = await raw(webUrl, { method: 'HEAD', path: '/api/v1/auth/me', headers: { ...sameOriginRead(), cookie } });
    expect(head.status, 'HEAD').toBe(200);
    expect(head.body).toBe('');
    for (const [method, path, body] of [
      ['POST', '/api/v1/no-such-route-t0125', '{}'],
      ['PUT', `/api/v1/contacts/${NO_SUCH_CONTACT}`, '{}'],
      ['PATCH', `/api/v1/contacts/${NO_SUCH_CONTACT}`, '{}'],
      ['DELETE', `/api/v1/contacts/${NO_SUCH_CONTACT}`, undefined],
    ] as const) {
      const answer = await raw(webUrl, {
        method,
        path,
        headers: { ...(body === undefined ? sameOriginWrite(webUrl) : sameOriginJson(webUrl)), cookie },
        body,
      });
      expect(answer.status, `${method} is not exported by the route handler`).not.toBe(405);
      expect(errorCode(answer), `${method} was refused as CSRF with every control satisfied`).not.toBe('csrf_rejected');
    }
  });
});

// ===========================================================================
// 6. Errors, logs and tenancy
// ===========================================================================

test.describe('T-0125 — errors leak nothing; tenant A never reaches tenant B', () => {
  test('answers another tenant, another programme and nothing at all with one 404, and every 401 alike @bff-session @bff-session-no-leak', async () => {
    const { webUrl } = stack();
    const session = await signIn(webUrl, TUNDE);
    const revoked = await signIn(webUrl, NGOZI);
    await raw(webUrl, { method: 'POST', path: '/api/v1/auth/sign-out', headers: { ...sameOriginWrite(webUrl), cookie: sessionCookie(revoked.token) } });
    const cookie = sessionCookie(session.token);
    const seen: [string, RawResponse][] = [];
    const get = async (label: string, path: string, cookieHeader?: string): Promise<RawResponse> => {
      const answer = await raw(webUrl, { path, headers: { ...sameOriginRead(), ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }) } });
      seen.push([label, answer]);
      return answer;
    };

    expect((await get('own record', `/api/v1/contacts/${contactIn(PROGRAMME_A1)}`, cookie)).status, 'the caller cannot read their own record — the 404s prove nothing').toBe(200);
    const notFound = [
      await get('another tenant', `/api/v1/contacts/${contactIn(PROGRAMME_B1)}`, cookie),
      await get('another programme', `/api/v1/contacts/${contactIn(PROGRAMME_A2)}`, cookie),
      await get('nothing', `/api/v1/contacts/${NO_SUCH_CONTACT}`, cookie),
    ];
    for (const answer of notFound) expect(answer.status).toBe(404);
    expect(new Set(notFound.map((answer) => answer.body)).size, 'the 404 says whether the record exists elsewhere').toBe(1);

    // Two groups, because the harness's API runs stub mode: a request that
    // reaches it with NO credential meets the stub guard, whose 401 body
    // differs from the session guard's (an API artefact of stub mode, which
    // never runs in production). Within each group the BFF must add nothing.
    const presented = [
      await get('a garbage cookie', '/api/v1/contacts', sessionCookie(`${TOKEN_PREFIX}t0125-garbage`)),
      await get('a revoked cookie', '/api/v1/contacts', sessionCookie(revoked.token)),
      await get('an unknown well-formed cookie', '/api/v1/contacts', sessionCookie(`${TOKEN_PREFIX}${'A'.repeat(43)}`)),
    ];
    const absent = [
      await get('no cookie', '/api/v1/contacts'),
      await get('the development cookie name', '/api/v1/contacts', `${INSECURE_COOKIE}=${session.token}`),
      await get('an empty cookie', '/api/v1/contacts', `${SESSION_COOKIE}=`),
    ];
    for (const answer of [...presented, ...absent]) expect(answer.status).toBe(401);
    expect(new Set(presented.map((answer) => answer.body)).size, 'the 401 says why a presented session failed').toBe(1);
    expect(new Set(absent.map((answer) => answer.body)).size, 'the 401 differs between kinds of missing session').toBe(1);

    const slash = await get('a trailing slash', '/api/v1/contacts/', cookie);
    expect((header(slash, 'location') ?? '').includes(apiHost()), 'a redirect names the API').toBe(false);
    const leaking = seen.filter(([, answer]) => leaksUpstream(answer)).map(([label]) => label);
    expect(leaking, 'an answer names the upstream API or carries a stack trace').toEqual([]);
  });

  test('sends refused requests to no log: markers in headers, body and cookie are not echoed @bff-session @bff-session-log-markers', async () => {
    // The acceptance suite greps this run's server output for LOG_MARKER and
    // for `ksw_s1_`. Here, only the refusals and their silence are asserted.
    const { webUrl } = stack();
    const csrf = await raw(webUrl, {
      method: 'POST',
      path: '/api/v1/auth/sign-out',
      headers: { origin: EVIL_ORIGIN, [CSRF_HEADER]: `${LOG_MARKER}-header`, 'content-type': 'text/plain', cookie: sessionCookie(`${TOKEN_PREFIX}${LOG_MARKER}-cookie`) },
      body: `${LOG_MARKER}-body`,
    });
    expect(csrf.status).toBe(403);
    const scope = await bffMe(webUrl, undefined, { 'x-kasuwa-programme-ids': `${LOG_MARKER}-scope` });
    expect(scope.status).toBe(400);
    const dead = await bffMe(webUrl, sessionCookie(`${TOKEN_PREFIX}${LOG_MARKER}-dead`));
    expect(dead.status).toBe(401);
    for (const answer of [csrf, scope, dead]) {
      expect(answer.body.includes(LOG_MARKER), 'a refusal echoes what was sent').toBe(false);
    }
  });

  test('lets no path, query, header or cookie trick carry a tenant-A session into tenant B @bff-session @bff-session-tenancy', async () => {
    const { webUrl } = stack();
    const a = await signIn(webUrl, TUNDE);
    const b = await signIn(webUrl, WANJIRU);
    const cookieA = sessionCookie(a.token);
    const bContact = contactIn(PROGRAMME_B1);

    const listA = await raw(webUrl, { path: '/api/v1/contacts', headers: { ...sameOriginRead(), cookie: cookieA } });
    expect(listA.status).toBe(200);
    expect(hasAny(listA.body, namesIn(PROGRAMME_A1)), 'the control list does not show programme A1 — nothing below means anything').toBe(true);

    const paths = [
      `/api/v1/contacts/${bContact}`,
      `/api/v1/./contacts/${bContact}`,
      `/api/v1/contacts/../contacts/${bContact}`,
      `/api/v1/contacts/%2e%2e/contacts/${bContact}`,
      `/api/v1/contacts/%2E%2E%2Fcontacts%2F${bContact}`,
      `/api/v1//contacts/${bContact}`,
      `/api/v1/contacts/${bContact};tenant=${TENANT_B}`,
      `/api/v1/contacts/${bContact}%00`,
      `/api/v1/CONTACTS/${bContact}`,
      `/api/v1/contacts?tenantId=${TENANT_B}`,
      `/api/v1/contacts?tenant_id=${TENANT_B}&programmeId=${PROGRAMME_B1}`,
      `/api/v1/contacts?programme_ids=${PROGRAMME_B1}&${STUB_TENANT_HEADER}=${TENANT_B}`,
      `/api/v1/contacts/${bContact}?tenantId=${TENANT_B}`,
      `/api/v1/programmes/${PROGRAMME_B1}/duplicates`,
      `/api/v1/admin/programmes/${PROGRAMME_B1}`,
    ];
    const headerTricks: Record<string, string>[] = [
      stubHeaders(WANJIRU),
      { host: 'rift-valley-contact.kasuwa.example' },
      { 'x-forwarded-host': 'rift-valley-contact.kasuwa.example' },
      { forwarded: 'host=rift-valley-contact.kasuwa.example;proto=https' },
      { 'x-kasuwa-tenant-slug': 'rift-valley-contact', 'x-tenant-id': TENANT_B },
    ];
    const leaks: string[] = [];
    for (const path of paths) {
      const answer = await raw(webUrl, { path, headers: { ...sameOriginRead(), cookie: cookieA } });
      if (tenantBIn(`${answer.body} ${header(answer, 'location') ?? ''}`, path).length > 0) leaks.push(`${path} → ${answer.status}`);
    }
    for (const trick of headerTricks) {
      for (const path of ['/api/v1/contacts', `/api/v1/contacts/${bContact}`]) {
        const answer = await raw(webUrl, { path, headers: { ...sameOriginRead(), cookie: cookieA, ...trick } });
        if (tenantBIn(answer.body, `${path} ${JSON.stringify(trick)}`).length > 0) leaks.push(`${JSON.stringify(trick)} ${path} → ${answer.status}`);
      }
    }
    expect(leaks, 'a tenant-A session read tenant-B data').toEqual([]);

    // A planted development-name cookie never outranks the session (cookie tossing).
    const tossed = await raw(webUrl, { path: '/api/v1/contacts', headers: { ...sameOriginRead(), cookie: `${INSECURE_COOKIE}=${b.token}; ${cookieA}` } });
    expect(tenantBIn(tossed.body), 'a kasuwa_session cookie overrode the __Host- session').toEqual([]);

    // Two session cookies in one header: whichever is used, never both tenants at once.
    for (const order of [`${cookieA}; ${sessionCookie(b.token)}`, `${sessionCookie(b.token)}; ${cookieA}`]) {
      const answer = await raw(webUrl, { path: '/api/v1/contacts', headers: { ...sameOriginRead(), cookie: order } });
      expect(answer.status, 'two session cookies crashed the BFF').toBeLessThan(500);
      const both = hasAny(answer.body, namesIn(PROGRAMME_A1)) && hasAny(answer.body, namesIn(PROGRAMME_B1));
      expect(both, 'two session cookies mixed two tenants in one answer').toBe(false);
    }
  });

  test('never sends a request, or the token, anywhere but the configured API, and never outside /api/v1 @bff-session @bff-session-ssrf', async () => {
    // Passes on main by design (the rewrite has a fixed destination): a
    // regression guard for a hand-built upstream URL. A BFF that builds its
    // upstream from the path, Host or a forwarding header hands the Bearer
    // token to whoever the request names.
    const { webUrl, apiUrl } = stack();
    const received: { url: string; headers: IncomingHttpHeaders }[] = [];
    const attacker = createServer((request, response) => {
      received.push({ url: request.url ?? '', headers: request.headers });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"stolen":true}');
    });
    await new Promise<void>((done) => attacker.listen(0, '127.0.0.1', done));
    const target = `127.0.0.1:${(attacker.address() as AddressInfo).port}`;
    try {
      const session = await signIn(webUrl, MUSA);
      const cookie = sessionCookie(session.token);
      const read = { ...sameOriginRead(), cookie };
      const webHost = new URL(webUrl).host;
      const probes: { path: string; headers: Record<string, string>; method?: string; body?: string }[] = [
        ...[
          `/api/v1/%2F%2F${target}/steal`,
          `/api/v1/%2f%2f${target}/steal`,
          `/api/v1/..%2F..%2F..%2F%2F${target}/steal`,
          `/api/v1/http:%2F%2F${target}/steal`,
          `/api/v1/%5C%5C${target}/steal`,
          `/api/v1/@${target}/steal`,
          `/api/v1/%40${target}/steal`,
          `/api/v1/..%2F..%2F..%2F..%2F@${target}`,
          `/api/v1/contacts?url=http://${target}/steal&redirect=http://${target}/steal`,
        ].map((path) => ({ path, headers: read })),
        { path: `http://${target}/api/v1/auth/me`, headers: { ...read, host: webHost } },
        { path: '/api/v1/auth/me', headers: { ...read, host: target } },
        { path: '/api/v1/auth/me', headers: { ...read, 'x-forwarded-host': target, 'x-forwarded-proto': 'http', 'x-forwarded-port': target.split(':')[1] ?? '' } },
        { path: '/api/v1/auth/me', headers: { ...read, forwarded: `host=${target};proto=http` } },
        { path: '/api/v1/auth/me', headers: { ...read, 'x-original-url': `http://${target}/steal`, 'x-rewrite-url': `http://${target}/steal` } },
        { path: `/api/v1/%2F%2F${target}/steal`, headers: { ...sameOriginJson(webUrl), cookie }, method: 'POST', body: '{}' },
      ];
      for (const probe of probes) {
        await raw(webUrl, { method: probe.method, path: probe.path, headers: probe.headers, body: probe.body });
      }
      expect(received.map((entry) => entry.url), 'the BFF sent a request to a host the client named').toEqual([]);

      const health = await raw(apiUrl, { path: '/health' });
      expect(health.status, 'the API health route moved — the escape check below needs it').toBe(200);
      for (const path of ['/api/v1/..%2F..%2Fhealth', '/api/v1/%2e%2e/%2e%2e/health', '/api/v1/../../health', '/api/v1/%2E%2E%2F%2E%2E%2Fhealth', '/api/v1/..;/..;/health']) {
        const answer = await raw(webUrl, { path, headers: read });
        expect(answer.status === 200 && answer.body === health.body, `${path} reached the API outside /api/v1`).toBe(false);
      }
    } finally {
      await new Promise<void>((done) => attacker.close(() => done()));
    }
  });
});

// ===========================================================================
// 7. The page CSP
// ===========================================================================

test.describe('T-0125 — the page CSP', () => {
  test('sets the ADR-0019 policy with a fresh nonce on every page response, and every script carries it @bff-session @bff-session-csp', async () => {
    const { webUrl } = stack();
    const base = requireSessionWeb();
    const host = apiHost();
    // The signed-in screens are fetched WITH a session, as a browser would
    // navigate to them, so a signed-out redirect cannot stand in for the page.
    // The sign-in screens are fetched without one.
    let cookie: string | undefined;
    const pages: [target: string, path: string, status: number, signedIn: boolean][] = [
      [webUrl, '/', 200, false],
      [webUrl, '/verify', 200, false],
      [webUrl, '/no-such-page-t0125', 404, false],
      [webUrl, '/admin', 200, true],
      [base, '/contacts', 200, true],
    ];
    const nonces: string[] = [];
    for (const [target, path, status, signedIn] of pages) {
      if (signedIn && cookie === undefined) {
        cookie = sessionCookie((await signIn(webUrl, WANJIRU)).token);
      }
      const answer = await raw(target, {
        path,
        headers: { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', ...(signedIn && cookie !== undefined ? { cookie } : {}) },
      });
      const label = `${path} on ${target === webUrl ? 'the production process' : 'the session process'}`;
      expect(answer.status, `${label}: not the page`).toBe(status);
      const policyText = header(answer, 'content-security-policy');
      expect(policyText, `${label}: no Content-Security-Policy`).toBeDefined();
      const policy = directives(policyText);
      const nonceToken = (policy.get('script-src') ?? []).find((value) => /^'nonce-.+'$/.test(value)) ?? '';
      const nonce = nonceToken.slice("'nonce-".length, -1);
      expect(nonce, `${label}: script-src has no nonce`).toMatch(/^[A-Za-z0-9+/_=-]{22,}$/);
      nonces.push(nonce);

      expect(policy.get('default-src'), label).toEqual(["'self'"]);
      expect([...(policy.get('script-src') ?? [])].sort(), `${label}: script-src`).toEqual(["'self'", "'strict-dynamic'", nonceToken].sort());
      expect([...(policy.get('style-src') ?? [])].sort(), `${label}: style-src`).toEqual(["'self'", nonceToken].sort());
      const styleAttr = policy.get('style-src-attr');
      if (styleAttr !== undefined) expect(styleAttr, `${label}: style-src-attr`).toEqual(["'unsafe-inline'"]);
      expect([...(policy.get('img-src') ?? [])].sort(), `${label}: img-src`).toEqual(["'self'", 'blob:', 'data:']);
      expect(policy.get('font-src'), label).toEqual(["'self'"]);
      expect(policy.get('connect-src'), `${label}: connect-src must be 'self' alone`).toEqual(["'self'"]);
      expect(policy.get('frame-ancestors'), label).toEqual(["'none'"]);
      expect(policy.get('form-action'), label).toEqual(["'self'"]);
      expect(policy.get('base-uri'), label).toEqual(["'none'"]);
      expect(policy.get('object-src'), label).toEqual(["'none'"]);
      expect(policy.has('upgrade-insecure-requests'), `${label}: upgrade-insecure-requests on loopback`).toBe(false);
      const known = new Set(['default-src', 'script-src', 'style-src', 'style-src-attr', 'img-src', 'font-src', 'connect-src', 'frame-ancestors', 'form-action', 'base-uri', 'object-src']);
      expect([...policy.keys()].filter((name) => !known.has(name)), `${label}: directives the ADR does not name`).toEqual([]);
      expect((policyText ?? '').includes(host), `${label}: the policy names the API`).toBe(false);
      expect(/'unsafe-eval'|'unsafe-inline'/.test([...(policy.get('script-src') ?? []), ...(policy.get('style-src') ?? [])].join(' ')), `${label}: unsafe-* in script-src or style-src`).toBe(false);

      const tags = answer.body.match(/<script\b[^>]*>/gi) ?? [];
      expect(tags.length, `${label}: no script tag — the nonce check would be vacuous`).toBeGreaterThan(0);
      expect(tags.filter((tag) => !tag.includes(`nonce="${nonce}"`)), `${label}: scripts without the nonce`).toEqual([]);
    }
    expect(new Set(nonces).size, 'a nonce was reused across responses').toBe(nonces.length);

    // Next's middleware-bypass header must not strip the policy.
    const bypass = await raw(webUrl, { path: '/', headers: { accept: 'text/html', 'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware' } });
    expect(header(bypass, 'content-security-policy'), 'x-middleware-subrequest removed the CSP').toBeDefined();
  });
});
