import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_CODE_ALPHABET,
  BACKUP_CODE_COUNT,
  generateBackupCode,
  generateBackupCodes,
  hashBackupCode,
  normaliseBackupCode,
} from './backup-codes';

const TENANT = '00000000-0000-4000-8000-00000000a001';
const USER = '00000000-0000-4000-8000-00000000b001';
const OTHER_USER = '00000000-0000-4000-8000-00000000b002';

describe('backup codes', () => {
  it('generates ten distinct codes in the xxxxx-xxxxx shape, never six digits', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/u);
      expect(code).not.toMatch(/^[0-9]{6}$/u);
      for (const character of code.replace('-', '')) {
        expect(BACKUP_CODE_ALPHABET).toContain(character);
      }
    }
  });

  it('never uses the confusable characters', () => {
    const many = Array.from({ length: 200 }, () => generateBackupCode()).join('');
    expect(many).not.toMatch(/[01ilo]/u);
  });

  it('normalises case, hyphens and spaces, and rejects anything else', () => {
    expect(normaliseBackupCode('K7M2Q-X9TFA')).toBe('k7m2qx9tfa');
    expect(normaliseBackupCode(' k7m2q x9tfa ')).toBe('k7m2qx9tfa');
    expect(normaliseBackupCode('123456')).toBeNull();
    expect(normaliseBackupCode('k7m2q-x9tf0')).toBeNull();
    expect(normaliseBackupCode('k7m2q-x9tfaa')).toBeNull();
  });

  it('hashes under a key, bound to the tenant and user, and equal across input forms', () => {
    const key = randomBytes(32);
    const code = generateBackupCode();
    const stored = hashBackupCode(key, TENANT, USER, code);

    expect(stored).toHaveLength(32);
    expect(hashBackupCode(key, TENANT, USER, code.toUpperCase()).equals(stored)).toBe(true);
    expect(hashBackupCode(key, TENANT, USER, code.replace('-', '')).equals(stored)).toBe(true);
    // Another user, or another key, gives a different hash.
    expect(hashBackupCode(key, TENANT, OTHER_USER, code).equals(stored)).toBe(false);
    expect(hashBackupCode(randomBytes(32), TENANT, USER, code).equals(stored)).toBe(false);
    // And it is not the unsalted digest anyone could compute from the code.
    const bare = code.replace('-', '');
    expect(stored.toString('hex')).not.toBe(createHash('sha256').update(bare).digest('hex'));
    expect(stored.includes(Buffer.from(bare))).toBe(false);
  });

  it('refuses to hash something that is not a code', () => {
    expect(() => hashBackupCode(randomBytes(32), TENANT, USER, '123456')).toThrow();
  });
});
