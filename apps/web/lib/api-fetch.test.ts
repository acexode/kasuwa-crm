import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@kasuwa/config/session';
import { apiFetch, sendToSignIn } from './api-fetch';

function stubFetch(status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubWindow(pathname: string): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  vi.stubGlobal('window', { location: { pathname, assign } });
  return assign;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
  return call?.[1] ?? {};
}

describe('apiFetch (ADR-0019 step d)', () => {
  it('sends the CSRF header the BFF requires, named as @kasuwa/config names it', async () => {
    const fetchMock = stubFetch();
    await apiFetch('/api/v1/auth/sign-out', { method: 'POST' });
    const headers = sentInit(fetchMock).headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
  });

  it('sends a JSON body with its type, and a bodyless request with none', async () => {
    const fetchMock = stubFetch();
    await apiFetch('/api/v1/contacts', { method: 'POST', body: { displayName: 'Ada' } });
    await apiFetch('/api/v1/contacts/x/archive', { method: 'POST' });
    const [withBody, bodyless] = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(withBody?.[1].body).toBe('{"displayName":"Ada"}');
    expect((withBody?.[1].headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(bodyless?.[1].body).toBeUndefined();
    expect((bodyless?.[1].headers as Record<string, string>)['content-type']).toBeUndefined();
  });

  it('never caches, sends only same-origin credentials, and names no identity or scope', async () => {
    const fetchMock = stubFetch();
    await apiFetch('/api/v1/contacts');
    const init = sentInit(fetchMock);
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|x-kasuwa|programme|tenant|scope/i);
  });

  it('takes relative /api/ paths only', async () => {
    stubFetch();
    await expect(apiFetch('https://api.example/api/v1/contacts')).rejects.toThrow(/relative/);
    await expect(apiFetch('/contacts')).rejects.toThrow(/relative/);
  });

  it('sends a signed-out browser to sign-in on a 401 (I6)', async () => {
    stubFetch(401);
    const assign = stubWindow('/contacts');
    const response = await apiFetch('/api/v1/contacts');
    expect(response.status).toBe(401);
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('hands the sign-in flow its own 401 back', async () => {
    stubFetch(401);
    const assign = stubWindow('/verify');
    await apiFetch('/api/v1/auth/mfa', { method: 'POST', body: {}, onUnauthenticated: 'return' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('does not reload sign-in from sign-in, and does nothing without a window', () => {
    const assign = stubWindow('/');
    sendToSignIn();
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    expect(() => sendToSignIn()).not.toThrow();
  });
});
