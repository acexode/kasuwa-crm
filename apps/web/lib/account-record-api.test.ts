import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAccount, listAccountContacts, listAccountTimeline } from './account-record-api';

const ACCOUNT_ID = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';

const ACCOUNT = {
  id: ACCOUNT_ID,
  programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a01',
  name: 'Example Foods Ltd',
  version: 2,
  industry: 'Retail',
  createdAt: '2026-09-01T07:00:00.000Z',
  updatedAt: '2026-09-02T07:00:00.000Z',
  withheldFields: ['phones', 'parentAccountId'],
};

const TASK = {
  id: 'ti_0a9b',
  type: 'activity',
  occurredAt: '2026-09-30T16:05:00.000Z',
  actor: null,
  activityId: '5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4c02',
  activityType: 'task',
  subject: 'Confirm the schedule',
  dueAt: '2026-10-02T15:00:00.000Z',
  completedAt: null,
  version: 3,
};

interface Sent {
  url: string;
  init: RequestInit;
}

function serve(status: number, body: unknown): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the account record client', () => {
  it('reads the account, its contacts and its timeline same-origin, out of the cache, with no scope', async () => {
    const sent = serve(200, { data: [], nextCursor: null });
    await listAccountContacts(ACCOUNT_ID, null);
    await listAccountTimeline(ACCOUNT_ID, null);
    serve(200, ACCOUNT);
    await getAccount(ACCOUNT_ID);
    expect(sent.map((entry) => entry.url)).toEqual([`/api/v1/accounts/${ACCOUNT_ID}/contacts`, `/api/v1/accounts/${ACCOUNT_ID}/timeline`]);
    for (const entry of sent) {
      expect(entry.init.cache).toBe('no-store');
      expect(JSON.stringify(entry.init.headers ?? {})).not.toMatch(/programme|tenant/i);
    }
  });

  it('keeps a withheld field absent, never null', async () => {
    serve(200, ACCOUNT);
    const result = await getAccount(ACCOUNT_ID);
    expect(result.ok).toBe(true);
    expect(result.ok && 'phones' in result.value).toBe(false);
    expect(result.ok && 'parentAccountId' in result.value).toBe(false);
  });

  it('echoes a cursor exactly, and asks for no limit', async () => {
    const sent = serve(200, { data: [], nextCursor: null });
    await listAccountTimeline(ACCOUNT_ID, 'atc_0001+/=');
    await listAccountContacts(ACCOUNT_ID, 'acc_0002');
    const timeline = new URL(sent[0]?.url ?? '', 'http://x');
    const contacts = new URL(sent[1]?.url ?? '', 'http://x');
    expect(timeline.searchParams.get('cursor')).toBe('atc_0001+/=');
    expect(contacts.searchParams.get('cursor')).toBe('acc_0002');
    expect([...timeline.searchParams.keys(), ...contacts.searchParams.keys()]).toEqual(['cursor', 'cursor']);
  });

  it('parses a task with its version, and refuses an activity item without one (T-0080)', async () => {
    serve(200, { data: [TASK], nextCursor: null });
    const served = await listAccountTimeline(ACCOUNT_ID, null);
    expect(served.ok && served.value.data[0]).toMatchObject({ activityId: TASK.activityId, version: 3 });
    const versionless = Object.fromEntries(Object.entries(TASK).filter(([key]) => key !== 'version'));
    serve(200, { data: [versionless], nextCursor: null });
    expect((await listAccountTimeline(ACCOUNT_ID, null)).ok).toBe(false);
  });

  it('refuses a field change that carries values or names no Account field: account changes are by name only', async () => {
    const change = { id: 'ti_1', type: 'field_changed', occurredAt: '2026-10-03T14:40:00.000Z', actor: null, field: 'tier', redacted: true };
    serve(200, { data: [change], nextCursor: null });
    const ok = await listAccountTimeline(ACCOUNT_ID, null);
    expect(ok.ok && 'before' in (ok.value.data[0] ?? {})).toBe(false);
    serve(200, { data: [{ ...change, field: 'displayName' }], nextCursor: null });
    expect((await listAccountTimeline(ACCOUNT_ID, null)).ok).toBe(false);
    serve(200, { data: [{ ...change, type: 'consent_changed' }], nextCursor: null });
    expect((await listAccountTimeline(ACCOUNT_ID, null)).ok).toBe(false);
  });

  it('keeps the field_withheld reason on a refused contacts read', async () => {
    serve(400, {
      statusCode: 400,
      code: 'validation_failed',
      message: 'Validation failed',
      details: [{ path: 'accountId', code: 'field_withheld' }],
    });
    const result = await listAccountContacts(ACCOUNT_ID, null);
    expect(result).toEqual({ ok: false, error: { code: 'validation_failed', details: [{ path: 'accountId', code: 'field_withheld' }] } });
  });
});
