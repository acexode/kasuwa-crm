import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContactMerge, getContactMergePreview, listContactMerges, listDuplicates, undoContactMerge } from './duplicates-api';

const ID = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01';
const OTHER = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e02';
const PROGRAMME = '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01';

const MERGE = {
  id: '9a1b2c3d-4e5f-4a60-8b71-8c9d0e1f2a01',
  programmeId: PROGRAMME,
  survivor: { id: ID, displayName: 'Sample Fixture' },
  merged: { id: OTHER, displayName: null },
  mergedByUserId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01',
  mergedAt: '2026-10-18T09:00:00Z',
  undoUntil: '2026-11-17T09:00:00Z',
  undoneAt: null,
  undoneByUserId: null,
  survivorReverted: null,
};

function answer(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

type Call = [string, RequestInit];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the duplicates client (T-0097)', () => {
  it('asks for a programme’s sets with the programme in the path and the cursor alone, never cached, no scope', async () => {
    const fetchMock = vi.fn(async () => answer({ data: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await listDuplicates(PROGRAMME);
    await listDuplicates(PROGRAMME, 'abc=/+');
    const calls = fetchMock.mock.calls as unknown as Call[];
    expect(calls.map(([url]) => url)).toEqual([`/api/v1/programmes/${PROGRAMME}/duplicates`, `/api/v1/programmes/${PROGRAMME}/duplicates?cursor=abc%3D%2F%2B`]);
    for (const [, init] of calls) {
      expect(init.method).toBe('GET');
      expect(init.cache).toBe('no-store');
      expect(JSON.stringify(init.headers)).not.toMatch(/programme|tenant|scope/i);
    }
  });

  it('reads a set as served and refuses one that carries a score or a matched value’s shape it does not know', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ data: [{ matchOn: 'phone', contacts: [{ id: ID, displayName: null, updatedAt: 'x' }, { id: OTHER, displayName: 'A', updatedAt: 'y' }] }], nextCursor: 'next' })));
    const read = await listDuplicates(PROGRAMME);
    expect(read.ok && read.value.data[0]?.contacts[0]?.displayName).toBeNull();
    expect(read.ok && read.value.nextCursor).toBe('next');
    // A set of one, or a match on something else, is not the contract's: a connection-class failure, never a draw.
    vi.stubGlobal('fetch', vi.fn(async () => answer({ data: [{ matchOn: 'name', contacts: [] }], nextCursor: null })));
    expect(await listDuplicates(PROGRAMME)).toEqual({ ok: false, error: { code: 'network' } });
  });

  it('carries Retry-After from a 429 as whole seconds, and nothing from a header it cannot read', async () => {
    const body = { statusCode: 429, code: 'too_many_requests', message: 'x' };
    vi.stubGlobal('fetch', vi.fn(async () => answer(body, 429, { 'retry-after': '30' })));
    expect(await listDuplicates(PROGRAMME)).toEqual({ ok: false, error: { code: 'too_many_requests', retryAfterSeconds: 30 } });
    for (const value of ['Wed, 21 Oct 2026 07:28:00 GMT', '0', '-4', '1.5']) {
      vi.stubGlobal('fetch', vi.fn(async () => answer(body, 429, { 'retry-after': value })));
      expect(await listDuplicates(PROGRAMME), value).toEqual({ ok: false, error: { code: 'too_many_requests' } });
    }
  });

  it('asks for a preview with the main record in the path and `with` alone', async () => {
    const fetchMock = vi.fn(async () => answer({ statusCode: 404, code: 'not_found', message: 'x' }, 404));
    vi.stubGlobal('fetch', fetchMock);
    const result = await getContactMergePreview(ID, OTHER);
    expect((fetchMock.mock.calls as unknown as Call[])[0]?.[0]).toBe(`/api/v1/contacts/${ID}/merge-preview?with=${OTHER}`);
    expect(result).toEqual({ ok: false, error: { code: 'not_found' } });
  });

  it('posts the merge as a closed JSON body and reads already_merged and undo_expired as codes of their own', async () => {
    const fetchMock = vi.fn(async () => answer({ statusCode: 409, code: 'already_merged', message: 'x' }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const body = { survivorId: ID, mergedId: OTHER, survivorVersion: 3, mergedVersion: 1, choices: { status: 'merged' as const } };
    const refused = await createContactMerge(body);
    const [url, init] = (fetchMock.mock.calls as unknown as Call[])[0] ?? ['', {}];
    expect(url).toBe('/api/v1/contact-merges');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect(refused).toEqual({ ok: false, error: { code: 'already_merged' } });
    vi.stubGlobal('fetch', vi.fn(async () => answer({ statusCode: 410, code: 'undo_expired', message: 'x' }, 410)));
    expect(await undoContactMerge(MERGE.id)).toEqual({ ok: false, error: { code: 'undo_expired' } });
  });

  it('undoes with no body, and lists the history with the cursor alone', async () => {
    const fetchMock = vi.fn(async (url: string) => answer(url.endsWith('/undo') ? MERGE : { data: [MERGE], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await undoContactMerge(MERGE.id);
    await listContactMerges();
    await listContactMerges('c1');
    const calls = fetchMock.mock.calls as unknown as Call[];
    expect(calls.map(([url]) => url)).toEqual([`/api/v1/contact-merges/${MERGE.id}/undo`, '/api/v1/contact-merges', '/api/v1/contact-merges?cursor=c1']);
    expect(calls[0]?.[1].method).toBe('POST');
    expect(calls[0]?.[1].body).toBeUndefined();
    expect(calls[1]?.[1].method).toBe('GET');
  });

  it('draws a merge whose party’s name is withheld as null, not as a missing name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ data: [MERGE], nextCursor: null })));
    const result = await listContactMerges();
    expect(result.ok && result.value.data[0]?.merged.displayName).toBeNull();
  });
});
