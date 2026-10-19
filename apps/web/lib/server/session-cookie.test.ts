import { describe, expect, it } from 'vitest';
import {
  clearSessionSetCookie,
  maxAgeUntil,
  readSessionCookie,
  sessionCookieName,
  sessionSetCookie,
} from './session-cookie';

const SECURE = { insecure: false } as const;
const RELAXED = { insecure: true } as const;
/** Invented, shaped like an API token, valid nowhere. */
const TOKEN = 'ksw_s1_unit-not-a-real-token-AAAAAAAAAAAAAAAAAAAA';
const OTHER = 'ksw_s1_unit-not-a-real-token-BBBBBBBBBBBBBBBBBBBB';

describe('the session cookie (ADR-0019 point 2)', () => {
  it('is __Host-kasuwa_session, and kasuwa_session only under the development flag', () => {
    expect(sessionCookieName(SECURE)).toBe('__Host-kasuwa_session');
    expect(sessionCookieName(RELAXED)).toBe('kasuwa_session');
  });

  it('is set HttpOnly, Secure, SameSite=Lax, Path=/, with no Domain and a Max-Age', () => {
    const line = sessionSetCookie(TOKEN, 43_200, SECURE);
    expect(line).toBe(`__Host-kasuwa_session=${TOKEN}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Lax`);
    expect(line).not.toMatch(/domain/i);
  });

  it('drops only Secure and the prefix under the development flag', () => {
    expect(sessionSetCookie(TOKEN, 60, RELAXED)).toBe(`kasuwa_session=${TOKEN}; Max-Age=60; Path=/; HttpOnly; SameSite=Lax`);
  });

  it('refuses to write a value that could forge an attribute', () => {
    expect(() => sessionSetCookie('ksw_s1_x; Domain=evil.example', 60, SECURE)).toThrow();
    expect(() => sessionSetCookie('', 60, SECURE)).toThrow();
  });

  it('is deleted with the attributes a __Host- deletion needs', () => {
    const line = clearSessionSetCookie(SECURE);
    expect(line).toMatch(/^__Host-kasuwa_session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  });

  it('dies with the session: Max-Age rounds down and is never negative', () => {
    const now = new Date('2026-10-19T08:00:00.000Z');
    expect(maxAgeUntil(new Date('2026-10-19T20:00:00.000Z'), now)).toBe(43_200);
    expect(maxAgeUntil(new Date('2026-10-19T08:00:01.999Z'), now)).toBe(1);
    expect(maxAgeUntil(new Date('2026-10-19T07:00:00.000Z'), now)).toBe(0);
  });
});

describe('readSessionCookie', () => {
  it('finds the one session cookie among others', () => {
    expect(readSessionCookie(`kasuwa_lite=1; __Host-kasuwa_session=${TOKEN}; theme=dark`, SECURE)).toEqual({ kind: 'token', token: TOKEN });
  });

  it('is no session with no header, an empty value or a malformed one', () => {
    expect(readSessionCookie(null, SECURE)).toEqual({ kind: 'none' });
    expect(readSessionCookie('__Host-kasuwa_session=', SECURE)).toEqual({ kind: 'none' });
    expect(readSessionCookie('__Host-kasuwa_session=a b', SECURE)).toEqual({ kind: 'none' });
    expect(readSessionCookie('__Host-kasuwa_session=a"b', SECURE)).toEqual({ kind: 'none' });
    expect(readSessionCookie(`__Host-kasuwa_session=${'a'.repeat(513)}`, SECURE)).toEqual({ kind: 'none' });
  });

  it('never reads the development name in a secure process, so it can never outrank the __Host- cookie', () => {
    expect(readSessionCookie(`kasuwa_session=${TOKEN}`, SECURE)).toEqual({ kind: 'none' });
    expect(readSessionCookie(`kasuwa_session=${OTHER}; __Host-kasuwa_session=${TOKEN}`, SECURE)).toEqual({ kind: 'token', token: TOKEN });
    expect(readSessionCookie(`__Host-kasuwa_session=${TOKEN}`, RELAXED)).toEqual({ kind: 'none' });
  });

  it('answers two session cookies with neither (amendment 5), in either order and even when equal', () => {
    for (const header of [
      `__Host-kasuwa_session=${TOKEN}; __Host-kasuwa_session=${OTHER}`,
      `__Host-kasuwa_session=${OTHER}; __Host-kasuwa_session=${TOKEN}`,
      `__Host-kasuwa_session=${TOKEN}; __Host-kasuwa_session=${TOKEN}`,
    ]) {
      expect(readSessionCookie(header, SECURE)).toEqual({ kind: 'none' });
    }
  });
});
