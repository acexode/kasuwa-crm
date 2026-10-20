import { describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/api-fetch';
import { readShellUserName } from './use-shell-user';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));

describe('readShellUserName: the avatar’s one read of /api/v1/auth/me', () => {
  it('cancels the body of a refusal, so the request does not stay open, and draws no name', async () => {
    const response = new Response(JSON.stringify({ code: 'not_authenticated' }), { status: 401 });
    const cancel = vi.spyOn(response.body as ReadableStream<Uint8Array>, 'cancel');
    vi.mocked(apiFetch).mockResolvedValueOnce(response);
    await expect(readShellUserName()).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reads the display name from a 200', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'x', tenantId: 'y', email: 'a@example.test', displayName: 'Sample Reader', locale: 'en-NG' }), { status: 200 }),
    );
    await expect(readShellUserName()).resolves.toBe('Sample Reader');
  });
});
