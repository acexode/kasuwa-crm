import { describe, expect, it } from 'vitest';
import { CreateContactBody, ListContactsQuery, UpdateContactBody } from './contacts.schemas';

describe('ListContactsQuery', () => {
  it('accepts a single filter value and a repeated one', () => {
    const one = ListContactsQuery.parse({ status: 'new' });
    expect(one.status).toEqual(['new']);
    const several = ListContactsQuery.parse({ status: ['new', 'qualified'], dnd: 'false' });
    expect(several.status).toEqual(['new', 'qualified']);
    expect(several.dnd).toBe(false);
  });

  it('defaults sort and limit, and ignores unknown parameters', () => {
    const parsed = ListContactsQuery.parse({ programmeId: 'x', tenantId: 'y' });
    expect(parsed.sort).toBe('-createdAt');
    expect(parsed.limit).toBe(25);
    expect('programmeId' in parsed).toBe(false);
  });

  it.each([
    { sort: 'emails' },
    { sort: 'id' },
    { limit: '0' },
    { limit: '101' },
    { q: '' },
    { q: 'a'.repeat(101) },
    { owner: 'not-a-uuid' },
    { status: 'Qualified' },
    { dnd: 'maybe' },
  ])('refuses %j', (query) => {
    expect(ListContactsQuery.safeParse(query).success).toBe(false);
  });

  it('accepts owner me, unassigned and a user id', () => {
    const parsed = ListContactsQuery.parse({
      owner: ['me', 'unassigned', '11111111-0000-4000-8000-0000000d0003'],
    });
    expect(parsed.owner).toHaveLength(3);
  });
});

describe('CreateContactBody', () => {
  it('is closed: server-owned and unknown properties are refused', () => {
    for (const extra of [
      { dnd: false },
      { phoneNetwork: 'MTN' },
      { version: 1 },
      { tenantId: 'x' },
      { nickname: 'Ada' },
    ]) {
      expect(CreateContactBody.safeParse({ displayName: 'A', ...extra }).success).toBe(false);
    }
  });

  it('takes E.164 only, and a well-formed BCP 47 tag', () => {
    expect(
      CreateContactBody.safeParse({
        displayName: 'A',
        phones: [{ type: 'mobile', e164: '08031234567' }],
      }).success,
    ).toBe(false);
    expect(
      CreateContactBody.safeParse({ displayName: 'A', preferredLanguage: 'not a tag!' }).success,
    ).toBe(false);
    expect(
      CreateContactBody.safeParse({
        displayName: 'A',
        phones: [{ type: 'mobile', e164: '+2348031234567' }],
        preferredLanguage: 'pcm',
      }).success,
    ).toBe(true);
  });
});

describe('UpdateContactBody', () => {
  it('requires version and at least one field, and refuses programmeId and source', () => {
    expect(UpdateContactBody.safeParse({ status: 'new' }).success).toBe(false);
    expect(UpdateContactBody.safeParse({ version: 1 }).success).toBe(false);
    expect(UpdateContactBody.safeParse({ version: 1, programmeId: 'x' }).success).toBe(false);
    expect(UpdateContactBody.safeParse({ version: 1, source: 'manual' }).success).toBe(false);
    expect(UpdateContactBody.safeParse({ version: 1, status: 'new' }).success).toBe(true);
  });

  it('bounds version to a Postgres integer, so a huge one is 400 rather than a 500', () => {
    for (const version of [2_147_483_648, 1e10, 1e21]) {
      expect(UpdateContactBody.safeParse({ version, status: 'new' }).success, String(version)).toBe(
        false,
      );
    }
    expect(UpdateContactBody.safeParse({ version: 2_147_483_647, status: 'new' }).success).toBe(
      true,
    );
  });
});

describe('free text refuses a NUL (D-L78): 400, never a Postgres 22021 and a 500', () => {
  const NUL = 'Probe\u0000 Person';

  it('displayName, givenNames and familyName on create and update', () => {
    for (const field of ['displayName', 'givenNames', 'familyName'] as const) {
      const create = CreateContactBody.safeParse({ displayName: 'Probe', [field]: NUL });
      expect(create.success, `create ${field}`).toBe(false);
      const issue = create.error?.issues[0];
      expect(issue?.path).toEqual([field]);
      expect(issue?.code === 'custom' ? issue.params?.['reason'] : undefined).toBe(
        'invalid_character',
      );
      expect(
        UpdateContactBody.safeParse({ version: 1, [field]: NUL }).success,
        `update ${field}`,
      ).toBe(false);
    }
  });

  it('keeps the length limits: displayName 1..200, the name parts 0..200 or null', () => {
    expect(CreateContactBody.safeParse({ displayName: '' }).success).toBe(false);
    expect(CreateContactBody.safeParse({ displayName: 'D'.repeat(200) }).success).toBe(true);
    expect(CreateContactBody.safeParse({ displayName: 'D'.repeat(201) }).success).toBe(false);
    for (const field of ['givenNames', 'familyName'] as const) {
      for (const value of ['', 'G'.repeat(200), null]) {
        expect(
          CreateContactBody.safeParse({ displayName: 'Probe', [field]: value }).success,
          `${field} ${JSON.stringify(value)}`,
        ).toBe(true);
      }
      expect(
        CreateContactBody.safeParse({ displayName: 'Probe', [field]: 'G'.repeat(201) }).success,
      ).toBe(false);
    }
    // Code points, as the contract and Postgres count: 200 emoji are 200 characters.
    expect(CreateContactBody.safeParse({ displayName: '\u{1F600}'.repeat(200) }).success).toBe(
      true,
    );
  });

  it('listContacts q: a NUL is 400; 1..100 characters as before', () => {
    expect(ListContactsQuery.safeParse({ q: 'Ama\u0000ka' }).success).toBe(false);
    expect(ListContactsQuery.safeParse({ q: '' }).success).toBe(false);
    expect(ListContactsQuery.safeParse({ q: 'a'.repeat(100) }).success).toBe(true);
    expect(ListContactsQuery.safeParse({ q: 'a'.repeat(101) }).success).toBe(false);
  });
});
