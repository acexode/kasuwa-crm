import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newNonce } from './csp';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe('the page CSP (ADR-0019 point 10, I18)', () => {
  it('is exactly the ADR policy for a production loopback process, with no upgrade', () => {
    const policy = contentSecurityPolicy('N0nce', { development: false, webOrigin: 'http://127.0.0.1:3000' });
    expect(policy).toBe(
      "default-src 'self'; script-src 'self' 'nonce-N0nce' 'strict-dynamic'; style-src 'self' 'nonce-N0nce'; " +
        "style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
        "frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
    );
  });

  it('upgrades insecure requests only on an https, non-loopback origin', () => {
    expect(directives(contentSecurityPolicy('n', { development: false, webOrigin: 'https://app.kasuwa.example' })).has('upgrade-insecure-requests')).toBe(true);
    expect(directives(contentSecurityPolicy('n', { development: false, webOrigin: 'https://localhost:3000' })).has('upgrade-insecure-requests')).toBe(false);
    expect(directives(contentSecurityPolicy('n', { development: false, webOrigin: 'http://web.dev.example:3000' })).has('upgrade-insecure-requests')).toBe(false);
  });

  it('relaxes only for development: unsafe-eval, the HMR socket, inline dev styles', () => {
    const dev = directives(contentSecurityPolicy('n', { development: true, webOrigin: 'http://localhost:3000' }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(dev.get('connect-src')).toEqual(["'self'", 'ws://localhost:3000']);
    expect(dev.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    const prod = directives(contentSecurityPolicy('n', { development: false, webOrigin: 'https://app.kasuwa.example' }));
    expect(prod.get('script-src')).not.toContain("'unsafe-eval'");
    expect(prod.get('connect-src')).toEqual(["'self'"]);
    expect(prod.get('style-src')).not.toContain("'unsafe-inline'");
  });

  it('adds only the object store\'s origin to connect-src, and only when it is configured', () => {
    const without = directives(contentSecurityPolicy('n', { development: false, webOrigin: 'https://app.kasuwa.example' }));
    expect(without.get('connect-src')).toEqual(["'self'"]);
    const withStorage = directives(
      contentSecurityPolicy('n', { development: false, webOrigin: 'https://app.kasuwa.example', storageEndpoint: 'https://store.kasuwa.example/kasuwa-za-1?x=1' }),
    );
    expect(withStorage.get('connect-src')).toEqual(["'self'", 'https://store.kasuwa.example']);
    expect(withStorage.get('default-src')).toEqual(["'self'"]);
  });

  it('draws a fresh nonce of at least 128 bits every time', () => {
    const nonces = Array.from({ length: 50 }, () => newNonce());
    expect(new Set(nonces).size).toBe(50);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/=]{22,}$/);
      expect(Buffer.from(nonce, 'base64').byteLength).toBeGreaterThanOrEqual(16);
    }
  });
});
