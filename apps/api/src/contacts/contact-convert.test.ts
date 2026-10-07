import { describe, expect, it } from 'vitest';
import { ConvertContactBody } from './contact-convert';
import { CreateContactBody, UpdateContactBody } from './contacts.schemas';

// Invented (CLAUDE.md 6.1).
const ACCOUNT = '11111111-0000-4000-8000-00007600aa01';

describe('ConvertContactBody (T-0076)', () => {
  it('accepts version plus exactly one target', () => {
    expect(ConvertContactBody.safeParse({ version: 1, accountId: ACCOUNT }).success).toBe(true);
    expect(
      ConvertContactBody.safeParse({ version: 4, newAccount: { name: 'Probe Grains Co.' } })
        .success,
    ).toBe(true);
    expect(
      ConvertContactBody.safeParse({ version: 2_147_483_647, newAccount: { name: 'N'.repeat(200) } })
        .success,
    ).toBe(true);
  });

  it.each([
    ['neither target', { version: 1 }],
    ['both targets', { version: 1, accountId: ACCOUNT, newAccount: { name: 'Both' } }],
    ['a null accountId', { version: 1, accountId: null }],
    ['a null newAccount', { version: 1, newAccount: null }],
    ['an empty name', { version: 1, newAccount: { name: '' } }],
    ['a 201-character name', { version: 1, newAccount: { name: 'N'.repeat(201) } }],
    ['a NUL in the name', { version: 1, newAccount: { name: 'Probe\u0000 Co' } }],
    ['an owner on the new account', { version: 1, newAccount: { name: 'O', ownerUserId: ACCOUNT } }],
    ['a status', { version: 1, accountId: ACCOUNT, status: 'qualified' }],
    ['a programmeId', { version: 1, accountId: ACCOUNT, programmeId: ACCOUNT }],
    ['a companyName', { version: 1, accountId: ACCOUNT, companyName: 'Copy Co' }],
    ['version 0', { version: 0, accountId: ACCOUNT }],
    ['a version above 2^31 - 1', { version: 2 ** 31, accountId: ACCOUNT }],
    ['a fractional version', { version: 1.5, accountId: ACCOUNT }],
    ['a string version', { version: '1', accountId: ACCOUNT }],
  ])('refuses %s', (_label, body) => {
    expect(ConvertContactBody.safeParse(body).success).toBe(false);
  });

  it('refuses an own __proto__ key inside newAccount (a raw JSON body can carry one)', () => {
    const body: unknown = JSON.parse(
      `{"version":1,"newAccount":{"name":"Proto Co","__proto__":{"programmeId":"${ACCOUNT}"}}}`,
    );
    expect(ConvertContactBody.safeParse(body).success).toBe(false);
  });
});

describe('companyName on the contact write bodies (T-0076, D-L82)', () => {
  it('accepts 1..200 characters and null', () => {
    for (const companyName of ['C', 'C'.repeat(200), 'Ọjà Foods Ltd', null]) {
      expect(CreateContactBody.safeParse({ displayName: 'Probe', companyName }).success).toBe(true);
      expect(UpdateContactBody.safeParse({ version: 1, companyName }).success).toBe(true);
    }
  });

  it('refuses "", 201 characters, a NUL and a non-string', () => {
    for (const companyName of ['', 'C'.repeat(201), 'Probe\u0000 Co', 42, { name: 'X' }]) {
      expect(CreateContactBody.safeParse({ displayName: 'Probe', companyName }).success).toBe(
        false,
      );
      expect(UpdateContactBody.safeParse({ version: 1, companyName }).success).toBe(false);
    }
  });
});
