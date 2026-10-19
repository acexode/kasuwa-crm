import { describe, expect, it } from 'vitest';
import { assertSessionCookieIsSafe, isLoopbackHostname, type EnvSource } from './index';
import * as session from './session.mjs';
import { webBuildEnv, webEnv } from './web.mjs';

/**
 * ADR-0019 point 8 and amendments 2 and 3 (T-0125): what `webEnv()` refuses
 * about the browser session layer. Invented hosts only; the marker proves a
 * refusal never echoes a credential.
 */
const MARKER = 'x-unit-not-a-real-pw-77';

function base(nodeEnv: 'development' | 'test' | 'production'): Record<string, string | undefined> {
  return {
    NODE_ENV: nodeEnv,
    KASUWA_AUTH_MODE: 'jwt',
    KASUWA_WEB_ORIGIN: 'https://app.kasuwa.example',
    KASUWA_API_INTERNAL_URL: 'https://api.internal.kasuwa.example',
  };
}

function refusal(env: EnvSource): string | undefined {
  try {
    webEnv(env);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('isLoopbackHostname', () => {
  it.each(['localhost', '127.0.0.1', '127.1.2.3', '127.255.255.255', '[::1]'])('treats %s as loopback', (host) => {
    expect(isLoopbackHostname(host)).toBe(true);
  });

  it.each(['127.0.0.1.evil.example', 'localhost.evil.example', '10.0.0.5', '128.0.0.1', '127.256.0.1', 'evil-127.0.0.1', '::1'])(
    'does not treat %s as loopback',
    (host) => {
      expect(isLoopbackHostname(host)).toBe(false);
    },
  );

  it('agrees with the URL parser, which canonicalises numeric hosts', () => {
    expect(isLoopbackHostname(new URL('http://127.0.0.1.evil.example:3000').hostname)).toBe(false);
    expect(isLoopbackHostname(new URL('http://[::1]:3000').hostname)).toBe(true);
    expect(isLoopbackHostname(new URL('http://2130706433/').hostname)).toBe(true);
  });
});

describe('webEnv: the session layer is required and shaped', () => {
  it('accepts https everywhere and returns both URLs', () => {
    for (const nodeEnv of ['development', 'test', 'production'] as const) {
      const env = webEnv(base(nodeEnv));
      expect(env.KASUWA_WEB_ORIGIN).toBe('https://app.kasuwa.example');
      expect(env.KASUWA_API_INTERNAL_URL).toBe('https://api.internal.kasuwa.example');
    }
  });

  it.each(['development', 'test', 'production'] as const)('requires both URLs under %s', (nodeEnv) => {
    expect(refusal({ ...base(nodeEnv), KASUWA_WEB_ORIGIN: undefined })).toMatch(/KASUWA_WEB_ORIGIN/);
    expect(refusal({ ...base(nodeEnv), KASUWA_API_INTERNAL_URL: undefined })).toMatch(/KASUWA_API_INTERNAL_URL/);
  });

  it.each([
    'https://app.kasuwa.example/',
    'https://app.kasuwa.example/login',
    'https://app.kasuwa.example?x=1',
    'https://app.kasuwa.example#top',
    'https://APP.kasuwa.example',
    'ftp://app.kasuwa.example',
    'app.kasuwa.example',
    'not a url',
    '',
  ])('refuses %j as an origin', (origin) => {
    expect(refusal({ ...base('test'), KASUWA_WEB_ORIGIN: origin })).toMatch(/KASUWA_WEB_ORIGIN/);
  });

  it('refuses credentials in either URL without echoing them', () => {
    for (const name of ['KASUWA_WEB_ORIGIN', 'KASUWA_API_INTERNAL_URL']) {
      const message = refusal({ ...base('test'), [name]: `https://svc:${MARKER}@host.kasuwa.example` });
      expect(message, name).toMatch(new RegExp(`${name}: must not carry credentials`));
      expect(message).not.toContain(MARKER);
    }
  });

  it('refuses a non-loopback http origin or API URL under production, naming the variable', () => {
    for (const name of ['KASUWA_WEB_ORIGIN', 'KASUWA_API_INTERNAL_URL']) {
      for (const url of ['http://app.kasuwa.example', 'http://127.0.0.1.evil.example:3000', 'http://10.0.0.5:3000']) {
        expect(refusal({ ...base('production'), [name]: url }), `${name}=${url}`).toMatch(new RegExp(`Refusing to start: ${name}`));
      }
    }
  });

  it('accepts loopback http under production (the e2e production process) and any http under development and test', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(refusal({ ...base('production'), KASUWA_WEB_ORIGIN: `http://${host}:3000`, KASUWA_API_INTERNAL_URL: `http://${host}:3001` })).toBeUndefined();
    }
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(refusal({ ...base(nodeEnv), KASUWA_WEB_ORIGIN: 'http://web.dev.example:3000', KASUWA_API_INTERNAL_URL: 'http://api.dev.example:3001' })).toBeUndefined();
    }
  });
});

describe('webEnv: KASUWA_SESSION_COOKIE_INSECURE', () => {
  it.each(['1', 'true', '0', 'false', ''])('refuses %j under production, by presence', (value) => {
    expect(refusal({ ...base('production'), KASUWA_SESSION_COOKIE_INSECURE: value })).toMatch(
      /Refusing to start: KASUWA_SESSION_COOKIE_INSECURE is set/,
    );
  });

  it.each(['development', 'test'] as const)('accepts exactly "1" under %s and nothing else', (nodeEnv) => {
    expect(refusal({ ...base(nodeEnv), KASUWA_SESSION_COOKIE_INSECURE: '1' })).toBeUndefined();
    for (const value of ['0', 'true', '']) {
      expect(refusal({ ...base(nodeEnv), KASUWA_SESSION_COOKIE_INSECURE: value }), value).toMatch(/must be exactly "1"/);
    }
  });

  it('is checked by the guard on its own, as the ADR names it', () => {
    expect(() => assertSessionCookieIsSafe({ NODE_ENV: 'production', KASUWA_SESSION_COOKIE_INSECURE: '0' })).toThrow(/Refusing to start/);
    expect(() => assertSessionCookieIsSafe({ NODE_ENV: 'test', KASUWA_SESSION_COOKIE_INSECURE: '1' })).not.toThrow();
    expect(() => assertSessionCookieIsSafe({ NODE_ENV: 'production' })).not.toThrow();
  });
});

describe('webBuildEnv: a build is not a boot', () => {
  it('does not require the session layer, and checks its shape when given', () => {
    expect(() => webBuildEnv({ NODE_ENV: 'production' })).not.toThrow();
    expect(() => webBuildEnv({ NODE_ENV: 'production', KASUWA_API_INTERNAL_URL: 'http://127.0.0.1:3001' })).not.toThrow();
    expect(() => webBuildEnv({ NODE_ENV: 'production', KASUWA_API_INTERNAL_URL: `https://svc:${MARKER}@api.example` })).toThrow(
      /KASUWA_API_INTERNAL_URL/,
    );
  });
});

describe('@kasuwa/config/session: the shared header policy', () => {
  it('holds the names and the fixed bodies, frozen', () => {
    expect(session.FORBIDDEN_SCOPE_HEADERS).toEqual(['x-kasuwa-programme-ids', 'x-kasuwa-programme-id', 'x-kasuwa-scope']);
    expect([session.STUB_TENANT_HEADER, session.STUB_USER_HEADER]).toEqual(['x-kasuwa-tenant-id', 'x-kasuwa-user-id']);
    expect(JSON.stringify(session.SCOPE_HEADER_REJECTED_BODY)).toBe(
      '{"statusCode":400,"error":"Bad Request","code":"validation_failed","message":"Validation failed","details":[{"path":"headers","code":"scope_header_not_accepted"}]}',
    );
    expect(JSON.stringify(session.NOT_FOUND_BODY)).toBe('{"statusCode":404,"error":"Not Found","code":"not_found","message":"Not found"}');
    for (const value of [session.FORBIDDEN_SCOPE_HEADERS, session.SCOPE_HEADER_REJECTED_BODY, session.SCOPE_HEADER_REJECTED_BODY.details, session.NOT_FOUND_BODY, session.INTERNAL_ERROR_BODY]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('names a __Host- cookie and a CSRF header outside the x-kasuwa- family the BFF strips', () => {
    expect(session.SESSION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    expect(session.CSRF_HEADER.startsWith('x-kasuwa-')).toBe(false);
  });
});
