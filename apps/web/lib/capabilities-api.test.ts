import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestRecords = vi.hoisted(() => vi.fn());
vi.mock('./records-request', () => ({ requestRecords }));

import {
  Capabilities,
  loadMyCapabilities,
  mayInAnyProgramme,
  mayInProgramme,
  resetCapabilitiesCache,
} from './capabilities-api';

const P1 = '11111111-0000-4000-8000-00000158c001';
const P2 = '11111111-0000-4000-8000-00000158c002';

const caps: Capabilities = {
  tenant: { admin: false, can: [] },
  programmes: [
    { id: P1, can: ['activity.write'] },
    { id: P2, can: ['account.write'] },
  ],
};

describe('capabilities (T-0158)', () => {
  it('holds an action if any reachable programme grants it', () => {
    expect(mayInAnyProgramme(caps, 'account.write')).toBe(true);
    expect(mayInAnyProgramme(caps, 'script.write')).toBe(false);
  });

  it('answers per programme, and never for one it was not told about', () => {
    expect(mayInProgramme(caps, 'account.write', P1)).toBe(false);
    expect(mayInProgramme(caps, 'account.write', P2)).toBe(true);
    expect(mayInProgramme(caps, 'account.write', 'unknown')).toBe(false);
  });

  it('reads nothing for a caller with no programme', () => {
    expect(
      mayInAnyProgramme({ tenant: { admin: false, can: [] }, programmes: [] }, 'account.write'),
    ).toBe(false);
  });

  it('rejects a body that is not the closed shape', () => {
    expect(Capabilities.safeParse({ tenant: { admin: false } }).success).toBe(false);
    expect(Capabilities.safeParse(caps).success).toBe(true);
  });
});

describe('the one-read-per-page cache (T-0158)', () => {
  beforeEach(() => {
    resetCapabilitiesCache();
    requestRecords.mockReset();
  });

  it('reads once for every screen that asks', async () => {
    requestRecords.mockResolvedValue({ ok: true, value: caps });
    const [first, second] = await Promise.all([loadMyCapabilities(), loadMyCapabilities()]);
    expect(first).toEqual(caps);
    expect(second).toBe(first);
    await loadMyCapabilities();
    expect(requestRecords).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed read: the next screen asks again, and the failure draws controls (null)', async () => {
    requestRecords.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable' } });
    expect(await loadMyCapabilities()).toBeNull();
    requestRecords.mockResolvedValueOnce({ ok: true, value: caps });
    expect(await loadMyCapabilities()).toEqual(caps);
    expect(requestRecords).toHaveBeenCalledTimes(2);
  });

  it('asks again after a reset, so a new session never sees the last one', async () => {
    requestRecords.mockResolvedValueOnce({ ok: true, value: caps });
    await loadMyCapabilities();
    const other: Capabilities = { tenant: { admin: false, can: [] }, programmes: [] };
    resetCapabilitiesCache();
    requestRecords.mockResolvedValueOnce({ ok: true, value: other });
    expect(await loadMyCapabilities()).toEqual(other);
    expect(requestRecords).toHaveBeenCalledTimes(2);
  });
});
