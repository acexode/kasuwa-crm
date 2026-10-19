import { describe, expect, it } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@kasuwa/config/session';
import { CSRF_REJECTED_BODY, hasRequestBody, isJsonContentType, isNavigation, passesCsrf } from './csrf';

const ORIGIN = 'http://127.0.0.1:3000';

/**
 * Fixture shorthand: in these cases the bytes that arrived match the length
 * the fixture names. (The BFF itself never reads that header; it counts.)
 */
function arrived(headers: Headers): boolean {
  return headers.has('transfer-encoding') || Number(headers.get('content-length') ?? '0') > 0;
}

function verdict(method: string, headers: Headers): boolean {
  return passesCsrf(method, headers, ORIGIN, arrived(headers));
}

function good(extra: Record<string, string> = {}): Headers {
  return new Headers({ origin: ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE, 'sec-fetch-site': 'same-origin', ...extra });
}

function without(name: string, extra: Record<string, string> = {}): Headers {
  const headers = good(extra);
  headers.delete(name);
  return headers;
}

describe('passesCsrf (ADR-0019 point 4)', () => {
  it('lets every safe method through untouched, whatever it carries', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(verdict(method, new Headers({ origin: 'http://evil.example' }))).toBe(true);
    }
  });

  it('passes a well-formed bodyless write and a well-formed JSON write', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(verdict(method, good({ 'content-length': '0' })), method).toBe(true);
      expect(verdict(method, good({ 'content-length': '2', 'content-type': 'application/json' })), method).toBe(true);
      expect(verdict(method, good({ 'content-length': '2', 'content-type': 'Application/JSON; charset=utf-8' })), method).toBe(true);
    }
    expect(verdict('POST', without('sec-fetch-site')), 'Sec-Fetch-Site is optional').toBe(true);
  });

  it.each<[string, Headers]>([
    ['a cross-origin Origin', good({ origin: 'http://evil.example' })],
    ['no Origin', without('origin')],
    ['Origin: null', good({ origin: 'null' })],
    ['a trailing slash', good({ origin: `${ORIGIN}/` })],
    ['another port', good({ origin: 'http://127.0.0.1:3001' })],
    ['another scheme', good({ origin: 'https://127.0.0.1:3000' })],
    ['two Origin values', new Headers([['origin', ORIGIN], ['origin', ORIGIN], [CSRF_HEADER, CSRF_HEADER_VALUE]])],
    ['Sec-Fetch-Site: cross-site', good({ 'sec-fetch-site': 'cross-site' })],
    ['Sec-Fetch-Site: same-site', good({ 'sec-fetch-site': 'same-site' })],
    ['Sec-Fetch-Site: none', good({ 'sec-fetch-site': 'none' })],
    ['no custom header', without(CSRF_HEADER)],
    ['the XHR value', good({ [CSRF_HEADER]: 'XMLHttpRequest' })],
    ['a text/plain body', good({ 'content-length': '2', 'content-type': 'text/plain' })],
    ['a text/plain;charset body', good({ 'content-length': '2', 'content-type': 'text/plain; charset=utf-8' })],
    ['a form body', good({ 'content-length': '3', 'content-type': 'application/x-www-form-urlencoded' })],
    ['a multipart body', good({ 'content-length': '9', 'content-type': 'multipart/form-data; boundary=x' })],
    ['a body with no type', good({ 'content-length': '2' })],
    ['a chunked body with no type', good({ 'transfer-encoding': 'chunked' })],
    ['a json-ish lookalike type', good({ 'content-length': '2', 'content-type': 'application/jsonx' })],
  ])('refuses %s', (_label, headers) => {
    expect(verdict('POST', headers)).toBe(false);
  });

  it('never compares with Host or X-Forwarded-Host', () => {
    const forged = good({ origin: 'http://evil.example', host: 'evil.example', 'x-forwarded-host': 'evil.example' });
    expect(verdict('POST', forged)).toBe(false);
  });

  it('answers every refusal with one body that names no check', () => {
    expect(JSON.stringify(CSRF_REJECTED_BODY)).not.toMatch(/origin|x-requested-with|requested|content-type|sec-fetch|header|referer/i);
    expect(CSRF_REJECTED_BODY.code).toBe('csrf_rejected');
  });
});

describe('the helpers', () => {
  it('decides "may have a body" by the stream, never by the length headers (D-L181 N5)', () => {
    expect(hasRequestBody(new Request('http://x/', { method: 'GET', headers: { 'content-length': '5' } }))).toBe(false);
    expect(hasRequestBody(new Request('http://x/', { method: 'POST', headers: { 'content-length': '0' }, body: 'abc' }))).toBe(true);
    expect(hasRequestBody(new Request('http://x/', { method: 'POST', headers: { 'content-length': '9' } }))).toBe(false);
  });

  it('takes the body verdict it is given: a bodyless write needs no type, a write with bytes needs JSON', () => {
    const bodyless = new Headers({ origin: ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-length': '7' });
    expect(passesCsrf('POST', bodyless, ORIGIN, false)).toBe(true);
    expect(passesCsrf('POST', new Headers({ origin: ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE, 'content-length': '0' }), ORIGIN, true)).toBe(false);
  });

  it('knows JSON only by its media type', () => {
    expect(isJsonContentType(null)).toBe(false);
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('text/json')).toBe(false);
  });

  it('sees a navigation by either Fetch Metadata header', () => {
    expect(isNavigation(new Headers({ 'sec-fetch-dest': 'document' }))).toBe(true);
    expect(isNavigation(new Headers({ 'sec-fetch-mode': 'navigate' }))).toBe(true);
    expect(isNavigation(new Headers({ 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }))).toBe(false);
    expect(isNavigation(new Headers())).toBe(false);
  });
});
