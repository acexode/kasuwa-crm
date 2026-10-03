import { describe, expect, it } from 'vitest';
import { generateInviteToken, hashInviteToken, maskEmail } from './portal-user-invite';

// Invented addresses only (CLAUDE.md section 6).
describe('maskEmail', () => {
  it('keeps the first and last character of the local part and the domain', () => {
    expect(maskEmail('portal.invitee@client.example')).toBe('p•••e@client.example');
  });

  it('never contains the whole local part when it has two or more characters', () => {
    for (const address of [
      'ab@client.example',
      'abc@client.example',
      'portal.x-1@client.example',
    ]) {
      const local = address.slice(0, address.indexOf('@'));
      expect(maskEmail(address), address).not.toContain(local);
      expect(maskEmail(address), address).not.toBe(address);
    }
    expect(maskEmail('ab@client.example')).toBe('a•••@client.example');
  });

  it('counts code points, so a non-ASCII local part is not split', () => {
    expect(maskEmail('\u{1D49C}daé@client.example')).toBe('\u{1D49C}•••é@client.example');
  });

  it('masks on the last @ and copes with no @ at all', () => {
    expect(maskEmail('"a@b"cd@client.example')).toBe('"•••d@client.example');
    expect(maskEmail('nodomain')).toBe('n•••n');
  });
});

describe('generateInviteToken', () => {
  it('is URL-safe, at least 32 characters, and different every time', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const { token } = generateInviteToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(50);
  });

  it('pairs the token with its SHA-256, and the digest does not contain the token', () => {
    const { token, hash } = generateInviteToken();
    expect(hash).toHaveLength(32);
    expect(hash.equals(hashInviteToken(token))).toBe(true);
    expect(hash.toString('hex')).not.toContain(token);
    expect(hash.toString('base64url')).not.toBe(token);
  });
});
