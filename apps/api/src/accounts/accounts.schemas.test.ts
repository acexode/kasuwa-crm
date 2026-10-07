import { describe, expect, it } from 'vitest';
import {
  CreateAccountBody,
  ListAccountContactsQuery,
  ListAccountsQuery,
  UpdateAccountBody,
} from './accounts.schemas';

const PROGRAMME = '11111111-0000-4000-8000-00005500f001';

/** `details[].code` as the admin filter would build it from these issues. */
function codes(result: { success: boolean; error?: { issues: unknown[] } }): unknown[] {
  if (result.success) return [];
  return (result.error?.issues ?? []).map((issue) => {
    const { code, params } = issue as { code: string; params?: { reason?: unknown } };
    return code === 'custom' ? params?.reason : code;
  });
}

describe('ListAccountsQuery', () => {
  it('defaults sort to name and limit to 25, and ignores unknown parameters', () => {
    const parsed = ListAccountsQuery.parse({ programmeId: PROGRAMME, tenantId: 'x', scope: 'all' });
    expect(parsed.sort).toBe('name');
    expect(parsed.limit).toBe(25);
    expect(Object.keys(parsed)).not.toContain('programmeId');
  });

  it('accepts a single filter value and a repeated one', () => {
    expect(ListAccountsQuery.parse({ tier: 'sme' }).tier).toEqual(['sme']);
    expect(ListAccountsQuery.parse({ tag: ['a', 'b'] }).tag).toEqual(['a', 'b']);
    expect(ListAccountsQuery.parse({ owner: ['me', 'unassigned', PROGRAMME] }).owner).toHaveLength(
      3,
    );
  });

  it.each([
    { sort: 'tier' },
    { sort: '-industry' },
    { sort: 'ownerUserId' },
    { sort: 'id' },
    { limit: '0' },
    { limit: '101' },
    { q: '' },
    { q: 'a'.repeat(101) },
    { q: 'Oja\u0000' },
    { tier: 'Enterprise' },
    { tier: 'mid-market' },
    { owner: 'everyone' },
    { industry: '' },
    { industry: 'x'.repeat(65) },
    { tag: '' },
    { tag: 'bad\u0000tag' },
    { state: 'La\u0000gos' },
  ])('refuses %j', (query) => {
    expect(ListAccountsQuery.safeParse(query).success).toBe(false);
  });

  it('accepts q of exactly 100 characters', () => {
    expect(ListAccountsQuery.safeParse({ q: 'a'.repeat(100) }).success).toBe(true);
  });
});

describe('ListAccountContactsQuery', () => {
  it('defaults sort to displayName and accepts only the contacts sort enum', () => {
    expect(ListAccountContactsQuery.parse({}).sort).toBe('displayName');
    for (const sort of ['givenNames', 'emails', 'phones', 'accountId']) {
      expect(ListAccountContactsQuery.safeParse({ sort }).success, sort).toBe(false);
    }
  });
});

describe('CreateAccountBody', () => {
  it('is closed: server-owned and unknown properties are refused', () => {
    for (const extra of [
      { id: PROGRAMME },
      { version: 1 },
      { owner: { id: PROGRAMME, displayName: 'X' } },
      { createdAt: '2026-01-01T00:00:00Z' },
      { withheldFields: [] },
      { tenantId: PROGRAMME },
      { health: 90 },
      { website: 'https://example.test' },
    ]) {
      expect(CreateAccountBody.safeParse({ name: 'Probe', ...extra }).success).toBe(false);
    }
  });

  it('refuses a raw __proto__ key, as JSON.parse produces it', () => {
    const body: unknown = JSON.parse(`{"name":"Probe","__proto__":{"programmeId":"${PROGRAMME}"}}`);
    expect(CreateAccountBody.safeParse(body).success).toBe(false);
  });

  it.each([
    ['a NUL in the name', { name: 'Acme\u0000 Ltd' }, 'invalid_character'],
    ['a NUL in a tag', { name: 'Probe', tags: ['ok', 'bad\u0000tag'] }, 'invalid_character'],
    ['a NUL in the industry', { name: 'Probe', industry: 'F\u0000MCG' }, 'invalid_character'],
    ['a NUL in the state', { name: 'Probe', state: 'La\u0000gos' }, 'invalid_character'],
    ['an empty name', { name: '' }, 'too_small'],
    ['a 201-character name', { name: 'N'.repeat(201) }, 'too_big'],
    ['an empty industry', { name: 'Probe', industry: '' }, 'too_small'],
  ])('%s is refused with its reason', (_label, body, reason) => {
    expect(codes(CreateAccountBody.safeParse(body))).toContain(reason);
  });

  it.each([
    ['a national-format phone', { phones: [{ type: 'work', e164: '08031234567' }] }],
    ['a phone with a space', { phones: [{ type: 'work', e164: '+234 803 123 4567' }] }],
    [
      'a phone with an extra key',
      { phones: [{ type: 'work', e164: '+2348031234567', dnd: true }] },
    ],
    ['a phone type outside the enum', { phones: [{ type: 'fax', e164: '+2348031234567' }] }],
    ['a tier label', { tier: 'Enterprise' }],
    ['51 tags', { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }],
    [
      '11 phones',
      { phones: Array.from({ length: 11 }, () => ({ type: 'work', e164: '+2348031234567' })) },
    ],
    ['a non-uuid owner', { ownerUserId: 'me' }],
    ['a non-uuid parent', { parentAccountId: 'top' }],
  ])('refuses %s', (_label, extra) => {
    expect(CreateAccountBody.safeParse({ name: 'Probe', ...extra }).success).toBe(false);
  });

  it('accepts the boundaries: a 200-character name, 50 tags, 10 phones, empty State', () => {
    const result = CreateAccountBody.safeParse({
      programmeId: PROGRAMME,
      name: 'N'.repeat(200),
      tags: Array.from({ length: 50 }, (_, i) => `tag-${i}`),
      phones: Array.from({ length: 10 }, () => ({ type: 'work', e164: '+2348031234567' })),
      state: '',
      tier: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('UpdateAccountBody', () => {
  it('needs version and at least one field, and never clears the name', () => {
    expect(UpdateAccountBody.safeParse({ tier: 'sme' }).success).toBe(false);
    expect(codes(UpdateAccountBody.safeParse({ version: 2 }))).toEqual(['nothing_to_update']);
    expect(UpdateAccountBody.safeParse({ version: 2, name: null }).success).toBe(false);
    expect(UpdateAccountBody.safeParse({ version: 0, tier: 'sme' }).success).toBe(false);
    expect(UpdateAccountBody.safeParse({ version: 2, tier: null }).success).toBe(true);
  });

  it('never accepts a programme, in any spelling (D-L76)', () => {
    for (const extra of [
      { programmeId: PROGRAMME },
      { programme_id: PROGRAMME },
      { tenantId: PROGRAMME },
      { id: PROGRAMME },
    ]) {
      expect(UpdateAccountBody.safeParse({ version: 1, tier: 'sme', ...extra }).success).toBe(
        false,
      );
    }
  });

  it('bounds version to a Postgres integer, so a huge one is 400 rather than a 500', () => {
    for (const version of [2_147_483_648, 1e10, 1e21]) {
      expect(UpdateAccountBody.safeParse({ version, tier: 'sme' }).success, String(version)).toBe(
        false,
      );
    }
    expect(UpdateAccountBody.safeParse({ version: 2_147_483_647, tier: 'sme' }).success).toBe(true);
  });
});
