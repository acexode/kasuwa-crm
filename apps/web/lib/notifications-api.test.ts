import { afterEach, describe, expect, it, vi } from 'vitest';
import { getUnreadCount, listNotifications, markAllRead, notificationSearch, toItem, updateNotification } from './notifications-api';
import { listContacts, parseRetryAfter } from './records-api';

const ID = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c06';
const OBJECT = '3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01';

const wire = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  kind: 'record_assigned',
  objectType: 'contact',
  objectId: OBJECT,
  actor: { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', displayName: 'Sample Agent' },
  objectDisplayName: 'Sample Customer',
  createdAt: '2026-10-18T09:50:00Z',
  readAt: null,
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('notifications client', () => {
  it('builds only declared parameters, kind once, limit within 1..100', () => {
    expect(notificationSearch({})).toBe('');
    expect(notificationSearch({ filter: 'all' })).toBe('');
    expect(notificationSearch({ filter: 'unread', kind: 'task_assigned', cursor: 'abc', limit: 500 })).toBe('?filter=unread&kind=task_assigned&cursor=abc&limit=100');
  });

  it('reads a page, ignoring a kind it does not know and keeping a malformed object id as text', async () => {
    const fetchMock = stub(200, {
      data: [wire(), wire({ id: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c07', kind: 'deal_won', objectType: 'deal' }), wire({ id: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c08', objectId: '../../admin' })],
      nextCursor: 'next',
    });
    const result = await listNotifications({ filter: 'unread' });
    expect(result.ok && result.value.items.map((row) => row.id)).toEqual([ID, '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c08']);
    expect(result.ok && result.value.nextCursor).toBe('next');
    expect(result.ok && result.value.headId).toBe(ID);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.cache).toBe('no-store');
  });

  it('refuses a kind and object type that do not pair', () => {
    expect(toItem(wire({ kind: 'task_assigned' }))).toBeNull();
    expect(toItem(wire())).not.toBeNull();
    expect(toItem(wire({ createdAt: 'yesterday' }))).toBeNull();
  });

  it('sends the closed bodies: read-all always bounded, mark-one { read }', async () => {
    const all = stub(200, { count: 1, capped: false });
    await markAllRead({ throughId: ID, kind: 'task_assigned' });
    expect(JSON.parse(String((all.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ kind: 'task_assigned', throughId: ID });
    const one = stub(200, { id: ID, readAt: null });
    await updateNotification(ID, false);
    const init = (one.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ read: false });
  });

  it('carries Retry-After on a 429', async () => {
    stub(429, { statusCode: 429, code: 'too_many_requests', message: 'x' }, { 'retry-after': '30' });
    const result = await getUnreadCount();
    expect(!result.ok && result.error).toMatchObject({ code: 'too_many_requests', retryAfterSeconds: 30 });
  });

  it('reads a 429 with no envelope as a wait, for the notifications calls only (N7)', async () => {
    const bare = () => vi.stubGlobal('fetch', vi.fn(async () => new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '20' } })));
    bare();
    const mine = await getUnreadCount();
    expect(!mine.ok && mine.error).toMatchObject({ code: 'too_many_requests', retryAfterSeconds: 20 });
    // Every other records call still reads it as a lost answer, as before.
    bare();
    const other = await listContacts({});
    expect(!other.ok && other.error.code).toBe('network');
  });

  it('refuses a count past the cap (N8)', async () => {
    stub(200, { count: 100, capped: true });
    const result = await getUnreadCount();
    expect(!result.ok && result.error.code).toBe('network');
  });

  it('reads Retry-After as whole seconds only', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('0')).toBeUndefined();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
