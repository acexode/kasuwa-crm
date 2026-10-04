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
});
