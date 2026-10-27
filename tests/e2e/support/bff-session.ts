import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { dirname, resolve } from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { expect, type Page, type Response } from '@playwright/test';
import { seedSignIn } from '@kasuwa/db';

/**
 * Helpers for the T-0125 browser-session journeys (`bff-session.spec.ts`),
 * written from ADR-0019 and the T-0125 acceptance suite's I-rulings, never
 * from the BFF's source. PINNED BY HASH in
 * `tests/acceptance/session/browser-session.acceptance.test.ts`: a change here
 * is a change to the acceptance contract, and the lead re-pins it.
 *
 * Three things here are deliberately independent of the code under test:
 *
 *   - the HTTP probes use `node:http` directly, so a probe sends exactly the
 *     headers it names and no others (no `Origin`, no `Sec-Fetch-*`, no
 *     cookie jar) — the only way to ask "what if the browser did not send
 *     this?";
 *   - TOTP is computed here (RFC 6238 over node:crypto), not with the API's
 *     own helper, so a shared bug cannot agree with itself;
 *   - the cookie is parsed from the raw `Set-Cookie` line, not from a jar that
 *     would silently normalise or drop attributes.
 *
 * NOTHING HERE PRINTS A TOKEN. Before T-0125 the MFA body carries the token,
 * so no error message in this file quotes a response body from an auth route.
 */

export const SESSION_COOKIE = '__Host-kasuwa_session';
/** The development-only relaxed name (ADR-0019 point 8). Never valid here. */
export const INSECURE_COOKIE = 'kasuwa_session';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'kasuwa-web';
/** Every API session token starts with this (ADR-0008). It stands for any token. */
export const TOKEN_PREFIX = 'ksw_s1_';

/** The API's 400 for a scope header (D-L63), verbatim: the BFF answers with it (ADR-0019 point 1). */
export const SCOPE_HEADER_REJECTED_BODY = {
  statusCode: 400,
  error: 'Bad Request',
  code: 'validation_failed',
  message: 'Validation failed',
  details: [{ path: 'headers', code: 'scope_header_not_accepted' }],
};

export const SCOPE_HEADERS = ['x-kasuwa-programme-ids', 'x-kasuwa-programme-id', 'x-kasuwa-scope'] as const;

export const STUB_TENANT_HEADER = 'x-kasuwa-tenant-id';
export const STUB_USER_HEADER = 'x-kasuwa-user-id';

// ---------------------------------------------------------------------------
// Raw HTTP
// ---------------------------------------------------------------------------

export interface RawRequest {
  method?: string | undefined;
  /** Sent as the request target verbatim, so it may be un-normalised or absolute-form. */
  path: string;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  setCookies: string[];
  /** Decoded (gzip, br, deflate) text. */
  body: string;
  /** `Content-Encoding` as sent, before decoding. */
  encoding: string | undefined;
  /** Bytes on the wire, before decoding. */
  wireBytes: number;
}

function decode(buffer: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
      return gunzipSync(buffer);
    case 'br':
      return brotliDecompressSync(buffer);
    case 'deflate':
      return inflateSync(buffer);
    default:
      return buffer;
  }
}

/**
 * One HTTP/1.1 request carrying exactly `headers` (plus the `Host` and
 * `Content-Length` node adds when they are not given). A bodyless unsafe
 * request is sent with `Content-Length: 0`, as a browser sends it.
 */
export function raw(base: string, init: RawRequest): Promise<RawResponse> {
  const url = new URL(base);
  const method = init.method ?? 'GET';
  const body = init.body === undefined ? undefined : Buffer.from(init.body, 'utf8');
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  if (body !== undefined) {
    headers['content-length'] = String(body.byteLength);
  } else if (!['GET', 'HEAD'].includes(method) && !names.has('content-length')) {
    headers['content-length'] = '0';
  }
  return new Promise((done, fail) => {
    const request = httpRequest(
      { host: url.hostname, port: url.port, method, path: init.path, headers, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', fail);
        response.on('end', () => {
          const wire = Buffer.concat(chunks);
          const encodingHeader = response.headers['content-encoding'];
          const encoding = Array.isArray(encodingHeader) ? encodingHeader.join(',') : encodingHeader;
          let text: string;
          try {
            text = decode(wire, encoding).toString('utf8');
          } catch {
            text = wire.toString('utf8');
          }
          const setCookie = response.headers['set-cookie'];
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            setCookies: Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie],
            body: text,
            encoding,
            wireBytes: wire.byteLength,
          });
        });
      },
    );
    request.on('error', fail);
    request.setTimeout(45_000, () => request.destroy(new Error(`timed out: ${method} ${init.path}`)));
    request.end(body);
  });
}

export function header(response: RawResponse, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

export function json(response: RawResponse): unknown {
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    return undefined;
  }
}

/** The `code` of an error envelope, or undefined. */
export function errorCode(response: RawResponse): string | undefined {
  const parsed = json(response);
  if (typeof parsed === 'object' && parsed !== null && 'code' in parsed) {
    const code = (parsed as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The headers a same-origin write from the web app carries (ADR-0019 point 4). */
export function sameOriginWrite(base: string): Record<string, string> {
  return {
    origin: new URL(base).origin,
    [CSRF_HEADER]: CSRF_VALUE,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
}

export function sameOriginJson(base: string): Record<string, string> {
  return { ...sameOriginWrite(base), 'content-type': 'application/json' };
}

/** The headers a same-origin `fetch` read from the web app carries. */
export function sameOriginRead(): Record<string, string> {
  return { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'application/json' };
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

// ---------------------------------------------------------------------------
// Set-Cookie
// ---------------------------------------------------------------------------

export interface ParsedSetCookie {
  name: string;
  value: string;
  /** Lower-cased attribute name to value ('' for a flag). Repeated attributes keep the last. */
  attributes: Map<string, string>;
}

export function parseSetCookie(line: string): ParsedSetCookie {
  const [pair = '', ...rest] = line.split(';');
  const equals = pair.indexOf('=');
  const name = (equals === -1 ? pair : pair.slice(0, equals)).trim();
  const value = equals === -1 ? '' : pair.slice(equals + 1).trim();
  const attributes = new Map<string, string>();
  for (const part of rest) {
    const index = part.indexOf('=');
    const key = (index === -1 ? part : part.slice(0, index)).trim().toLowerCase();
    if (key !== '') {
      attributes.set(key, index === -1 ? '' : part.slice(index + 1).trim());
    }
  }
  return { name, value, attributes };
}

/** Every Set-Cookie for `name` in a response. */
export function cookiesNamed(lines: readonly string[], name: string): ParsedSetCookie[] {
  return lines.map(parseSetCookie).filter((cookie) => cookie.name === name);
}

/** Whether a Set-Cookie deletes its cookie: Max-Age <= 0, or an Expires in the past. */
export function clears(cookie: ParsedSetCookie): boolean {
  const maxAge = cookie.attributes.get('max-age');
  if (maxAge !== undefined && /^-?\d+$/.test(maxAge) && Number(maxAge) <= 0) {
    return true;
  }
  const expires = cookie.attributes.get('expires');
  return expires !== undefined && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= Date.now();
}

/** A session-cookie deletion the browser will honour: `__Host-` needs Secure and Path=/, no Domain. */
export function clearsSession(lines: readonly string[]): boolean {
  return cookiesNamed(lines, SESSION_COOKIE).some(
    (cookie) =>
      clears(cookie) &&
      cookie.attributes.has('secure') &&
      cookie.attributes.get('path') === '/' &&
      !cookie.attributes.has('domain'),
  );
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, six digits, 30-second steps)
// ---------------------------------------------------------------------------

function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of text.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index === -1) {
      throw new Error('not base32');
    }
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

function currentStep(): number {
  return Math.floor(Date.now() / 30_000);
}

/**
 * The last TOTP step used per user, on disk rather than in memory: the API
 * refuses a step at or below the last one it accepted (replay protection),
 * and Playwright replaces its worker after a failure, which would forget an
 * in-memory record and turn one failure into a cascade of "replayed" ones.
 * Steps are absolute time, so an entry left by an earlier run is in the past
 * and harmless.
 */
const TOTP_STATE = resolve(__dirname, '..', '.artifacts', 'bff-session-totp.json');

function readSteps(): Record<string, number> {
  if (!existsSync(TOTP_STATE)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(TOTP_STATE, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

/**
 * The step file is shared by every Playwright process that signs in (the
 * `@p02-live` and `@bff-session` runs among them), and "read the last step,
 * pick the next, write it back" is a read-modify-write: two processes that
 * interleave it pick the same step, and the second code is a replay (T-0162).
 * A lock directory (`mkdir` is atomic) makes the claim one step at a time; a
 * lock older than LOCK_STALE_MS belongs to a process that died holding it and
 * is taken over. The file itself is replaced by rename, so a reader never sees
 * half of it.
 */
const TOTP_LOCK = `${TOTP_STATE}.lock`;
const LOCK_STALE_MS = 10_000;

function tryLock(): boolean {
  mkdirSync(dirname(TOTP_LOCK), { recursive: true });
  try {
    mkdirSync(TOTP_LOCK);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(TOTP_LOCK).mtimeMs > LOCK_STALE_MS) {
        rmSync(TOTP_LOCK, { recursive: true, force: true });
      }
    } catch {
      // The holder released it between the two calls: the next poll takes it.
    }
    return false;
  }
}

/** One claim attempt: the step for `userId`, or undefined if none is free or the lock is held. */
function tryClaimStep(userId: string): number | undefined {
  if (!tryLock()) {
    return undefined;
  }
  try {
    const last = readSteps()[userId] ?? Number.NEGATIVE_INFINITY;
    const step = Math.max(currentStep(), last + 1);
    if (step > currentStep() + 1) {
      return undefined;
    }
    const steps = readSteps();
    steps[userId] = step;
    const scratch = `${TOTP_STATE}.${process.pid}.tmp`;
    writeFileSync(scratch, `${JSON.stringify(steps)}
`, 'utf8');
    renameSync(scratch, TOTP_STATE);
    return step;
  } finally {
    rmSync(TOTP_LOCK, { recursive: true, force: true });
  }
}

/**
 * A fresh, never-used code for `userId`: the current step, or the next one
 * (the API accepts one step either side). When both are used, it waits on the
 * clock's STATE (the step number), by polling, until one is free. The claim is
 * atomic across processes (see TOTP_LOCK).
 */
export async function nextTotp(userId: string): Promise<string> {
  const secret = seedSignIn(userId)?.totpSecret;
  if (secret === undefined) {
    throw new Error(`${userId} is not a seeded user with a TOTP secret`);
  }
  let claimed: number | undefined;
  await expect
    .poll(
      () => {
        claimed = tryClaimStep(userId);
        return claimed !== undefined;
      },
      {
        message: 'no unused TOTP step became available',
        timeout: 65_000,
        intervals: [25, 50, 100, 250, 500],
      },
    )
    .toBe(true);
  if (claimed === undefined) {
    throw new Error('no unused TOTP step became available');
  }
  return totpAt(secret, claimed);
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

export interface Session {
  userId: string;
  tenantId: string;
  /** The cookie's value, which ADR-0019 rules is the API token verbatim. */
  token: string;
  cookie: ParsedSetCookie;
  mfa: RawResponse;
  /** The MFA body as the browser receives it. */
  mfaBody: Record<string, unknown>;
  /** When the MFA response arrived, for Max-Age comparisons. */
  receivedAt: number;
}

export interface Challenge {
  challengeId: string;
}

/** The first factor through the BFF, as the web app sends it. */
export async function startSignIn(base: string, userId: string, extraHeaders: Record<string, string> = {}): Promise<Challenge> {
  const credentials = seedSignIn(userId);
  if (credentials === undefined) {
    throw new Error(`${userId} is not a seeded user`);
  }
  const response = await raw(base, {
    method: 'POST',
    path: '/api/v1/auth/sign-in',
    headers: { ...sameOriginJson(base), ...extraHeaders },
    body: JSON.stringify({ tenantSlug: credentials.tenantSlug, email: credentials.email, password: credentials.password }),
  });
  if (response.status !== 200) {
    throw new Error(`sign-in through the BFF answered ${response.status} (${errorCode(response) ?? 'no code'})`);
  }
  const body = json(response) as { challengeId?: unknown } | undefined;
  if (typeof body?.challengeId !== 'string') {
    throw new Error('sign-in through the BFF answered 200 without a challengeId');
  }
  return { challengeId: body.challengeId };
}

/** The second factor through the BFF. Returns the raw response; asserts nothing. */
export async function submitMfa(
  base: string,
  challengeId: string,
  code: string,
  headers: Record<string, string> = sameOriginJson(base),
): Promise<RawResponse> {
  return raw(base, { method: 'POST', path: '/api/v1/auth/mfa', headers, body: JSON.stringify({ challengeId, code }) });
}

/**
 * A full sign-in through the BFF: password, then a fresh TOTP code. Fails
 * unless the BFF answers the MFA with a `__Host-kasuwa_session` cookie
 * (ADR-0019 point 3). `cookieHeader`, when given, is sent with both steps, as
 * a browser holding an earlier session would send it.
 */
export async function signIn(base: string, userId: string, cookieHeader?: string): Promise<Session> {
  const credentials = seedSignIn(userId);
  if (credentials === undefined) {
    throw new Error(`${userId} is not a seeded user`);
  }
  const extra: Record<string, string> = cookieHeader === undefined ? {} : { cookie: cookieHeader };
  const { challengeId } = await startSignIn(base, userId, extra);
  const code = await nextTotp(userId);
  const mfa = await submitMfa(base, challengeId, code, { ...sameOriginJson(base), ...extra });
  const receivedAt = Date.now();
  if (mfa.status !== 200) {
    throw new Error(`the MFA step through the BFF answered ${mfa.status} (${errorCode(mfa) ?? 'no code'})`);
  }
  const [cookie] = cookiesNamed(mfa.setCookies, SESSION_COOKIE).filter((candidate) => candidate.value !== '');
  if (cookie === undefined) {
    // Deliberately says nothing about the body: before T-0125 it carries the token.
    throw new Error(`a successful MFA through the BFF set no ${SESSION_COOKIE} cookie (ADR-0019 point 3)`);
  }
  const parsed = json(mfa);
  return {
    userId,
    tenantId: credentials.tenantId,
    token: cookie.value,
    cookie,
    mfa,
    mfaBody: typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {},
    receivedAt,
  };
}

/** GET /api/v1/auth/me straight at the API with a Bearer token: is the session live server-side? */
export async function apiMe(apiUrl: string, token: string): Promise<RawResponse> {
  return raw(apiUrl, { path: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
}

/** GET /api/v1/auth/me through the BFF with a cookie header (or none). */
export async function bffMe(base: string, cookie?: string, extra: Record<string, string> = {}): Promise<RawResponse> {
  return raw(base, {
    path: '/api/v1/auth/me',
    headers: { ...sameOriginRead(), ...(cookie === undefined ? {} : { cookie }), ...extra },
  });
}

/** The user id a `/auth/me` answer names, or undefined. */
export function meId(response: RawResponse): string | undefined {
  const parsed = json(response) as { id?: unknown } | undefined;
  return response.status === 200 && typeof parsed?.id === 'string' ? parsed.id : undefined;
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

/**
 * Signs in through the real screens (P01/1 then P01/2), typing a fresh TOTP
 * code, and returns the browser's MFA response. Injects nothing.
 */
export async function signInThroughUi(page: Page, base: string, userId: string): Promise<Response> {
  const credentials = seedSignIn(userId);
  if (credentials === undefined) {
    throw new Error(`${userId} is not a seeded user`);
  }
  await page.goto(base);
  await expect(page.locator('[data-screen="P01/1"]')).toBeVisible();
  await page.getByLabel(/workspace/i).fill(credentials.tenantSlug);
  await page.getByLabel(/work email/i).fill(credentials.email);
  await page.getByLabel('Password', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page.locator('[data-screen="P01/2"]')).toBeVisible();

  const code = await nextTotp(userId);
  const boxes = page.getByTestId('otp-input').getByRole('textbox');
  await boxes.first().focus();
  await page.keyboard.type(code);
  const mfaResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/v1/auth/mfa' && response.request().method() === 'POST',
  );
  await page.getByTestId('mfa-submit').click();
  return mfaResponse;
}

/** The sign-out control (I20): `[data-testid="sign-out"]`, possibly behind `[data-testid="user-menu"]`. */
export async function clickSignOut(page: Page): Promise<void> {
  const control = page.getByTestId('sign-out');
  if (!(await control.isVisible())) {
    await page.getByTestId('user-menu').click();
  }
  await control.click();
}
