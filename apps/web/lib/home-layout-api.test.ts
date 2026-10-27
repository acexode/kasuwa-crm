import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverLayoutStore } from '../components/home/server-layout-store';
import { deleteHomeLayout, getHomeLayout, HOME_LAYOUT_PATH, putHomeLayout } from './home-layout-api';

const LAYOUT = {
  role: 'rep',
  items: [
    { type: 'nba', span: 12 },
    { type: 'agenda', span: 6 },
  ],
} as const;

afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const call = (fetchMock: ReturnType<typeof stub>) =>
  fetchMock.mock.calls[0] as unknown as [string, RequestInit];

describe('the Home layout client (T-0159)', () => {
  it('reads the saved layout from the one same-origin path, no-store', async () => {
    const fetchMock = stub(200, LAYOUT);
    const result = await getHomeLayout();
    expect(result.ok && result.value).toEqual(LAYOUT);
    const [path, init] = call(fetchMock);
    expect(path).toBe(HOME_LAYOUT_PATH);
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
  });

  it('puts exactly { role, items }: no user, tenant or programme', async () => {
    const fetchMock = stub(200, LAYOUT);
    await putHomeLayout({ ...LAYOUT, items: [...LAYOUT.items], extra: 'x' } as never);
    const [, init] = call(fetchMock);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual(LAYOUT);
  });

  it('deletes, and a 204 is success', async () => {
    const fetchMock = stub(204, null);
    const result = await deleteHomeLayout();
    expect(result.ok).toBe(true);
    expect(call(fetchMock)[1].method).toBe('DELETE');
  });

  it('does not accept an answer outside the contract', async () => {
    stub(200, { role: 'rep', items: [{ type: 'no-such-widget', span: 4 }] });
    expect((await getHomeLayout()).ok).toBe(false);
  });
});

describe('serverLayoutStore (T-0159)', () => {
  it('loads the saved layout for the same role', async () => {
    stub(200, LAYOUT);
    expect(await serverLayoutStore.load('user-id', 'rep')).toEqual(LAYOUT.items);
  });

  it('is not another role’s layout, and nothing saved is null', async () => {
    stub(200, LAYOUT);
    expect(await serverLayoutStore.load('user-id', 'manager')).toBeNull();
    stub(404, { statusCode: 404, code: 'not_found', message: 'Not found' });
    expect(await serverLayoutStore.load('user-id', 'rep')).toBeNull();
  });

  it('never throws: a dropped connection loads nothing and saves nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    expect(await serverLayoutStore.load('user-id', 'rep')).toBeNull();
    await expect(serverLayoutStore.save('user-id', 'rep', LAYOUT.items)).resolves.toBeUndefined();
    await expect(serverLayoutStore.clear('user-id', 'rep')).resolves.toBeUndefined();
  });

  it('does not send the user id: the session decides whose layout it is', async () => {
    const fetchMock = stub(200, LAYOUT);
    await serverLayoutStore.save('a-user-id', 'rep', LAYOUT.items);
    const [path, init] = call(fetchMock);
    expect(path).toBe(HOME_LAYOUT_PATH);
    expect(String(init.body)).not.toContain('a-user-id');
  });
});
