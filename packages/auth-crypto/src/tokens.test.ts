import { describe, expect, it } from 'vitest';
import {
  hashIdentifier,
  hashSessionToken,
  newSessionToken,
  SESSION_TOKEN_PREFIX,
} from './tokens';

describe('session tokens', () => {
  it('is prefixed, opaque and never repeats', () => {
    const first = newSessionToken();
    const second = newSessionToken();
    expect(first.startsWith(SESSION_TOKEN_PREFIX)).toBe(true);
    expect(first).not.toBe(second);
  });

  it('carries 256 bits of randomness', () => {
    const body = newSessionToken().slice(SESSION_TOKEN_PREFIX.length);
    expect(Buffer.from(body, 'base64url').length).toBe(32);
  });

  it('encodes to a URL-safe alphabet, so it never needs escaping', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(newSessionToken()).toMatch(/^ksw_s1_[A-Za-z0-9_-]+$/u);
    }
  });

  it('hashes to 32 bytes, deterministically, and not to the token', () => {
    const token = newSessionToken();
    const hash = hashSessionToken(token);
    expect(hash.length).toBe(32);
    expect(hashSessionToken(token).equals(hash)).toBe(true);
    expect(hash.toString('utf8')).not.toContain(token);
    expect(hashSessionToken(newSessionToken()).equals(hash)).toBe(false);
  });
});

describe('identifier hashing', () => {
  const tenantA = '11111111-0000-4000-8000-000000000001';
  const tenantB = '22222222-0000-4000-8000-000000000002';

  it('is case- and whitespace-insensitive, so typing variants share a counter', () => {
    const plain = hashIdentifier(tenantA, 'tunde.agent@tenant-a.test');
    expect(hashIdentifier(tenantA, 'Tunde.Agent@Tenant-A.test').equals(plain)).toBe(true);
    expect(hashIdentifier(tenantA, '  tunde.agent@tenant-a.test  ').equals(plain)).toBe(true);
  });

  it('separates tenants, so one workspace cannot lock out another', () => {
    expect(
      hashIdentifier(tenantA, 'same@example.test').equals(
        hashIdentifier(tenantB, 'same@example.test'),
      ),
    ).toBe(false);
  });

  it('does not contain the address it counts', () => {
    const hash = hashIdentifier(tenantA, 'tunde.agent@tenant-a.test');
    expect(hash.toString('hex')).not.toContain(
      Buffer.from('tunde.agent@tenant-a.test', 'utf8').toString('hex'),
    );
  });
});
