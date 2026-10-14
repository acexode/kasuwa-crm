import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchAnswer, hitHref, lookupRecords, personName, searchRecords, seeAllHref } from './search-api';

const CONTACT = {
  type: 'contact',
  id: '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e11',
  programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
  displayName: 'Sample Fixture',
  givenNames: 'Sample',
  familyName: 'Fixture',
  companyName: null,
  withheldFields: [],
};

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the search client (T-0087)', () => {
  it('asks searchRecords same-origin with q alone, never cached, with no scope', async () => {
    const fetchMock = vi.fn(async () => answer({ groups: [{ type: 'contact', hits: [CONTACT] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchRecords('Sámple fix');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/search?q=S%C3%A1mple+fix');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(JSON.stringify(init.headers)).not.toMatch(/programme|tenant|scope/i);
    expect(result.ok && result.value[0]?.hits[0]?.id).toBe(CONTACT.id);
  });

  it('sends a lookup as a POST with the closed body and no query string', async () => {
    const fetchMock = vi.fn(async () => answer({ groups: [] , }));
    vi.stubGlobal('fetch', fetchMock);
    await lookupRecords('phone', '0803 000 0001');
    await lookupRecords('email', 'sample@example.test');
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual(['/api/v1/search/lookup', '/api/v1/search/lookup']);
    expect(calls.map(([, init]) => init.method)).toEqual(['POST', 'POST']);
    expect(calls.map(([, init]) => JSON.parse(String(init.body)) as unknown)).toEqual([{ phone: '0803 000 0001' }, { email: 'sample@example.test' }]);
  });

  it('reads a lookup refusal by its detail code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      answer({ statusCode: 400, code: 'validation_failed', message: 'x', details: [{ path: 'phone', code: 'invalid_phone' }] }, 400),
    ));
    const result = await lookupRecords('phone', '0803 000');
    expect(result.ok ? null : result.error.details?.[0]?.code).toBe('invalid_phone');
  });
});

describe('a throttled search (D-L137 M5)', () => {
  it('carries retryAt from a 429, and never the query', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      answer({ statusCode: 429, code: 'too_many_requests', message: 'x', retryAt: '2026-10-14T10:01:00.000Z' }, 429),
    ));
    const result = await searchRecords('sam');
    expect(result).toEqual({ ok: false, error: { code: 'too_many_requests', retryAt: '2026-10-14T10:01:00.000Z' } });
  });
});

describe('SearchAnswer: only what is served, in the order served', () => {
  it('ignores a group of a type it does not know, keeps the rest, and draws at most three hits', () => {
    const parsed = SearchAnswer.parse({
      groups: [
        { type: 'contact', hits: [CONTACT, CONTACT, CONTACT, CONTACT] },
        { type: 'ticket', hits: [{ type: 'ticket', id: 'x', subject: 'Sample' }] },
        { type: 'deal', hits: [{ type: 'deal', id: 'd', programmeId: 'p', pipelineId: 'q', name: 'Sample renewal' }] },
      ],
    });
    expect(parsed.map((group) => group.type)).toEqual(['contact', 'deal']);
    expect(parsed[0]?.hits).toHaveLength(3);
  });

  it('drops a hit that does not parse rather than failing the answer', () => {
    const parsed = SearchAnswer.parse({ groups: [{ type: 'account', hits: [{ id: 'a' }, { id: 'b', name: 'Sample Ltd' }] }] });
    expect(parsed[0]?.hits.map((hit) => hit.id)).toEqual(['b']);
  });
});

describe('links and names', () => {
  it('links only from a well-formed uuid, URL-encoded, and a deal only while its screen is live', () => {
    expect(hitHref('deal', CONTACT.id, true)).toBe(`/deals/${CONTACT.id}`);
    expect(hitHref('deal', 'javascript:alert(1)//', true)).toBeNull();
    expect(hitHref('contact', CONTACT.id)).toBe(`/contacts/${CONTACT.id}`);
    expect(hitHref('lead', CONTACT.id)).toBe(`/contacts/${CONTACT.id}`);
    expect(hitHref('account', CONTACT.id)).toBe(`/accounts/${CONTACT.id}`);
    expect(hitHref('deal', CONTACT.id)).toBeNull();
    expect(hitHref('contact', '../../admin/audit?export=1#x')).toBeNull();
    expect(hitHref('account', 'javascript:alert(1)//')).toBeNull();
  });

  it('"see all" is the type list with q and nothing else, never for deals', () => {
    expect(seeAllHref('contact', 'sam')).toBe('/contacts?q=sam');
    expect(seeAllHref('lead', 'Sample 12')).toBe('/leads?q=Sample+12');
    expect(seeAllHref('account', 'sam')).toBe('/accounts?q=sam');
    expect(seeAllHref('deal', 'sam')).toBeNull();
  });

  it('draws displayName as served, never composed; one readable part when it is withheld; null when none is', () => {
    const base = { kind: 'person' as const, id: CONTACT.id, withheldFields: [] };
    expect(personName({ ...base, displayName: 'Fixture-Example, Samwell', givenNames: 'Samwell', familyName: 'Fixture-Example' })).toBe('Fixture-Example, Samwell');
    expect(personName({ ...base, givenNames: 'Sampleton', withheldFields: ['displayName', 'familyName'] })).toBe('Sampleton');
    expect(personName({ ...base, withheldFields: ['displayName', 'givenNames', 'familyName', 'companyName'] })).toBeNull();
  });
});
