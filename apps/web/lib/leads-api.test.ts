import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactOwner, Lead, LeadPage, convertLead, getLead, leadListSearch, listLeads, moveLead } from './leads-api';
import { hasDetail, isWithheld } from './records-api';

const ROW = {
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e11',
  programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
  version: 2,
  displayName: 'Tunde Bakare',
  givenNames: 'Tunde',
  familyName: 'Bakare',
  companyName: 'Bakare Logistics',
  phones: [{ type: 'mobile', e164: '+2348060000002' }],
  emails: [],
  accountId: null,
  account: null,
  ownerUserId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02',
  owner: { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02', displayName: 'Kemi Balogun' },
  status: 'new',
  source: 'manual',
  tags: [],
  createdAt: '2026-10-06T08:00:00.000Z',
  updatedAt: '2026-10-06T08:00:00.000Z',
  withheldFields: [],
};

const ACCOUNT = {
  id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c11',
  programmeId: ROW.programmeId,
  name: 'Bakare Logistics Ltd',
  version: 1,
  ownerUserId: null,
  owner: null,
  createdAt: '2026-09-15T10:00:00.000Z',
  updatedAt: '2026-09-15T10:00:00.000Z',
  withheldFields: [],
};

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof stubFetch>): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
  expect(call).toBeDefined();
  return { url: call?.[0] ?? '', init: call?.[1] ?? {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('leadListSearch', () => {
  it('sends only declared parameters, arrays exploded, and no scope', () => {
    const params = new URLSearchParams(
      leadListSearch({
        q: '  Fabrics  ',
        owner: ['me', 'unassigned'],
        status: ['new', 'contacted'],
        source: ['whatsapp'],
        sort: '-updatedAt',
        cursor: 'abc',
        limit: 25,
      }).slice(1),
    );
    expect(params.get('q')).toBe('Fabrics');
    expect(params.getAll('owner')).toEqual(['me', 'unassigned']);
    expect(params.getAll('status')).toEqual(['new', 'contacted']);
    expect(params.getAll('source')).toEqual(['whatsapp']);
    expect(params.get('sort')).toBe('-updatedAt');
    expect(params.get('cursor')).toBe('abc');
    expect(params.get('limit')).toBe('25');
    expect([...params.keys()].some((key) => /programme|tenant|account/i.test(key))).toBe(false);
  });

  it('caps q at 100 characters, drops an empty one, and leaves the default sort to the server', () => {
    expect(new URLSearchParams(leadListSearch({ q: 'x'.repeat(150) }).slice(1)).get('q')).toHaveLength(100);
    // A cut that lands on a space is not sent with a trailing space.
    expect(new URLSearchParams(leadListSearch({ q: `${'a'.repeat(99)} b` }).slice(1)).get('q')).toBe('a'.repeat(99));
    expect(leadListSearch({ q: '   ' })).toBe('');
    expect(leadListSearch({ sort: '-createdAt' })).toBe('');
  });

  it('never puts a phone number or an email address in q (the API refuses it: identifier_in_url)', () => {
    expect(leadListSearch({ q: '0803 000 0001' })).toBe('');
    expect(leadListSearch({ q: 'sample@example.test' })).toBe('');
    expect(new URLSearchParams(leadListSearch({ q: 'Unit 12 Block 3456' }).slice(1)).get('q')).toBe('Unit 12 Block 3456');
  });

  it('a name the caller may not read is omitted, and the row still parses', () => {
    const { displayName: _name, ...rest } = ROW;
    const row = Lead.parse({ ...rest, withheldFields: ['displayName', 'familyName'] });
    expect(row.displayName).toBeUndefined();
    expect(isWithheld(row, 'displayName')).toBe(true);
  });
});

describe('the lead schema', () => {
  it('tells a withheld company from a null one, and keeps the owner and account names', () => {
    const { companyName: _companyName, ...rest } = ROW;
    const withheld = Lead.parse({ ...rest, withheldFields: ['companyName'] });
    expect(isWithheld(withheld, 'companyName')).toBe(true);
    expect(withheld.companyName).toBeUndefined();
    const empty = Lead.parse({ ...ROW, companyName: null });
    expect(empty.companyName).toBeNull();
    expect(Lead.parse(ROW).owner?.displayName).toBe('Kemi Balogun');
    expect(Lead.parse({ ...ROW, accountId: ACCOUNT.id, account: { id: ACCOUNT.id, name: ACCOUNT.name } }).account?.name).toBe(
      ACCOUNT.name,
    );
  });
});

describe('a former owner on a lead row (T-0103, D-P23)', () => {
  it('parses { id, displayName: null } and keeps the row', () => {
    const former = { id: ROW.ownerUserId, displayName: null };
    const parsed = Lead.parse({ ...ROW, owner: former });
    expect(parsed.owner).toEqual(former);
    expect(LeadPage.parse({ data: [{ ...ROW, owner: former }, ROW], nextCursor: null }).data).toHaveLength(2);
  });

  it('still refuses an owner with no name key, or a name that is not a string or null', () => {
    expect(ContactOwner.safeParse({ id: ROW.ownerUserId }).success).toBe(false);
    expect(ContactOwner.safeParse({ id: ROW.ownerUserId, displayName: 42 }).success).toBe(false);
    expect(Lead.safeParse({ ...ROW, owner: 'former' }).success).toBe(false);
  });
});

describe('the leads client', () => {
  it('reads /api/v1/leads same-origin, never /api/v1/contacts, and parses the page', async () => {
    const fetchMock = stubFetch(answer(200, { data: [ROW], nextCursor: 'c1' }));
    const result = await listLeads({ status: ['new'] });
    expect(result.ok && result.value.data[0]?.displayName).toBe('Tunde Bakare');
    expect(result.ok && result.value.nextCursor).toBe('c1');
    const { url, init } = sent(fetchMock);
    expect(url).toBe('/api/v1/leads?status=new');
    expect(JSON.stringify(init.headers)).not.toMatch(/programme|tenant/i);
  });

  it('a move is EXACTLY { version, status }, whatever the caller passes', async () => {
    const fetchMock = stubFetch(answer(200, { ...ROW, status: 'contacted', version: 3 }));
    const widened = { version: 2, status: 'contacted' as const, companyName: 'X', ownerUserId: null };
    const result = await moveLead(ROW.id, widened);
    expect(result.ok && result.value.version).toBe(3);
    const { url, init } = sent(fetchMock);
    expect(url).toBe(`/api/v1/contacts/${ROW.id}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ version: 2, status: 'contacted' });
  });

  it('converts through convertContact alone, with the body it was given', async () => {
    const fetchMock = stubFetch(
      answer(200, { contact: { ...ROW, status: 'qualified', version: 3, accountId: ACCOUNT.id, account: { id: ACCOUNT.id, name: ACCOUNT.name } }, account: ACCOUNT }),
    );
    const result = await convertLead(ROW.id, { version: 2, newAccount: { name: 'Bakare Logistics Ltd' } });
    expect(result.ok && result.value.contact.status).toBe('qualified');
    expect(result.ok && result.value.account.name).toBe('Bakare Logistics Ltd');
    const { url, init } = sent(fetchMock);
    expect(url).toBe(`/api/v1/contacts/${ROW.id}/convert`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ version: 2, newAccount: { name: 'Bakare Logistics Ltd' } });
  });

  it('reads already_linked from details, never from the message', async () => {
    stubFetch(
      answer(400, {
        statusCode: 400,
        code: 'validation_failed',
        message: 'anything at all',
        details: [{ path: 'newAccount', code: 'already_linked' }],
      }),
    );
    const result = await convertLead(ROW.id, { version: 2, newAccount: { name: 'X' } });
    expect(result.ok).toBe(false);
    expect(!result.ok && hasDetail(result.error, 'already_linked')).toBe(true);
  });

  it('a lost answer is a network failure, not a refusal', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    const result = await convertLead(ROW.id, { version: 2, accountId: ACCOUNT.id });
    expect(!result.ok && result.error.code).toBe('network');
  });

  it('re-reads one lead with getContact', async () => {
    const fetchMock = stubFetch(answer(200, ROW));
    const result = await getLead(ROW.id);
    expect(result.ok && result.value.id).toBe(ROW.id);
    expect(sent(fetchMock).url).toBe(`/api/v1/contacts/${ROW.id}`);
  });
});
