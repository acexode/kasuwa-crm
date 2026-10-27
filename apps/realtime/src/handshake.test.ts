import { INSECURE_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from '@kasuwa/config';
import { describe, expect, it } from 'vitest';
import { decideHandshake, NOT_AUTHENTICATED_BODY, type HandshakeConfig } from './handshake';

const ORIGIN = 'https://app.kasuwa.test';
const TOKEN = 'ksw_s1_abc-DEF_123';
const config: HandshakeConfig = { allowedOrigin: ORIGIN, insecureCookie: false };

const refusal = (status: 400 | 401) => expect.objectContaining({ kind: 'refuse', status });

describe('decideHandshake (T-0160)', () => {
  it('accepts a Bearer token', () => {
    expect(decideHandshake({ authorization: `Bearer ${TOKEN}` }, config)).toEqual({
      kind: 'accept',
      token: TOKEN,
    });
  });

  it('accepts the session cookie only from the allowed Origin', () => {
    const cookie = `${SESSION_COOKIE_NAME}=${TOKEN}`;
    expect(decideHandshake({ cookie, origin: ORIGIN }, config)).toEqual({
      kind: 'accept',
      token: TOKEN,
    });
    expect(decideHandshake({ cookie }, config)).toEqual(refusal(401));
    expect(decideHandshake({ cookie, origin: 'https://evil.example' }, config)).toEqual(
      refusal(401),
    );
    expect(
      decideHandshake({ cookie, origin: ORIGIN }, { ...config, allowedOrigin: undefined }),
    ).toEqual(refusal(401));
  });

  it('never accepts both a Bearer and a cookie, or the relaxed cookie name by default', () => {
    const cookie = `${SESSION_COOKIE_NAME}=${TOKEN}`;
    expect(
      decideHandshake({ authorization: `Bearer ${TOKEN}`, cookie, origin: ORIGIN }, config),
    ).toEqual(refusal(401));
    expect(
      decideHandshake(
        { cookie: `${INSECURE_SESSION_COOKIE_NAME}=${TOKEN}`, origin: ORIGIN },
        config,
      ),
    ).toEqual(refusal(401));
    expect(
      decideHandshake(
        { cookie: `${INSECURE_SESSION_COOKIE_NAME}=${TOKEN}`, origin: ORIGIN },
        { ...config, insecureCookie: true },
      ),
    ).toEqual({ kind: 'accept', token: TOKEN });
  });

  it('sees a duplicated cookie and believes neither', () => {
    const cookie = `${SESSION_COOKIE_NAME}=${TOKEN}; ${SESSION_COOKIE_NAME}=${TOKEN}x`;
    expect(decideHandshake({ cookie, origin: ORIGIN }, config)).toEqual(refusal(401));
  });

  it('refuses the stub identity, and anything that is not a Bearer', () => {
    expect(
      decideHandshake(
        { 'x-kasuwa-tenant-id': 'a', 'x-kasuwa-user-id': 'b', authorization: `Bearer ${TOKEN}` },
        config,
      ),
    ).toEqual(refusal(401));
    expect(decideHandshake({ authorization: TOKEN }, config)).toEqual(refusal(401));
    expect(decideHandshake({ authorization: `Basic ${TOKEN}` }, config)).toEqual(refusal(401));
    expect(decideHandshake({}, config)).toEqual(refusal(401));
  });

  it('answers a scope header with a 400, before any credential is read', () => {
    expect(
      decideHandshake({ authorization: `Bearer ${TOKEN}`, 'x-kasuwa-programme-ids': 'p' }, config),
    ).toEqual(refusal(400));
    expect(decideHandshake({ 'x-kasuwa-scope': 'all' }, config)).toEqual(refusal(400));
  });

  it('gives every 401 one body that carries no token', () => {
    const bodies = new Set(
      [{}, { authorization: 'Bearer' }, { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` }].map((h) => {
        const decision = decideHandshake(h, config);
        return decision.kind === 'refuse' ? decision.body : 'accepted';
      }),
    );
    expect([...bodies]).toEqual([NOT_AUTHENTICATED_BODY]);
    expect(NOT_AUTHENTICATED_BODY).not.toContain(TOKEN);
  });

  it('refuses any query string, even beside a live Bearer, with the one 401 body', () => {
    const headers = { authorization: `Bearer ${TOKEN}` };
    for (const url of [`/?token=${TOKEN}`, '/?', '/?x=1', `/?access_token=${TOKEN}`]) {
      expect(decideHandshake(headers, config, url)).toEqual({
        kind: 'refuse',
        status: 401,
        body: NOT_AUTHENTICATED_BODY,
      });
    }
    expect(decideHandshake(headers, config, '/')).toEqual({ kind: 'accept', token: TOKEN });
  });

  it('refuses any path but /, the same way', () => {
    const headers = { authorization: `Bearer ${TOKEN}` };
    for (const url of ['/ws', '//', '/socket', '', '*', '/%2f', 'http://x/']) {
      expect(decideHandshake(headers, config, url)).toEqual({
        kind: 'refuse',
        status: 401,
        body: NOT_AUTHENTICATED_BODY,
      });
    }
  });
});
