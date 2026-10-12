import { afterEach, describe, expect, it, vi } from 'vitest';
import { listScripts, putScriptTranslation, updateScript } from './scripting-api';
import { completeScriptRun, getScriptRun, listContactScripts, startScriptRun } from './script-runs-api';

/**
 * The scripting clients (T-0115, T-0116): relative paths only, never cached,
 * no scope anywhere, every answer parsed, and a refusal read by `code`.
 */

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

function stub(status: number, body: unknown): Sent[] {
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

const RUN = {
  id: '4a7e2c91-8b3d-4f60-a5e2-7c9d1b0f3e43',
  programmeId: 'p',
  contactId: 'c',
  scriptId: 's',
  versionId: 'v',
  versionNumber: 13,
  latestVersion: { id: 'v', number: 13, publishedAt: '2026-10-07T13:55:00Z', publishedBy: null },
  status: 'in_progress',
  outcome: null,
  unacknowledgedComplianceNodeIds: [],
  endedAtNodeId: null,
  stopReason: null,
  currentNodeId: 'greet',
  path: [{ nodeId: 'greet', enteredAt: '2026-10-12T09:00:00Z' }],
  acknowledgements: [],
  answers: {},
  startedBy: { id: 'a', displayName: 'Kemi Balogun' },
  startedAt: '2026-10-12T09:00:00Z',
  completedAt: null,
  dispositionId: null,
  activityId: null,
  followUpTaskId: null,
  revision: 1,
};

describe('the scripting clients', () => {
  it('ask a relative path, never cached, with no scope in the query or the headers', async () => {
    const sent = stub(200, { data: [], nextCursor: null });
    await listScripts('eyJpZCI6ImEifQ');
    await listContactScripts('3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01', null);
    expect(sent.map((entry) => entry.url)).toEqual(['/api/v1/scripts?cursor=eyJpZCI6ImEifQ', '/api/v1/contacts/3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01/scripts']);
    for (const { init } of sent) {
      expect(init.cache).toBe('no-store');
      expect(Object.keys((init.headers ?? {}) as Record<string, string>).filter((name) => /programme|tenant/i.test(name))).toEqual([]);
    }
  });

  it('send exactly the body they are given, and start a run with the script and the contact only', async () => {
    const sent = stub(201, RUN);
    await startScriptRun('s', 'c');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ scriptId: 's', contactId: 'c' });
    await updateScript('s', { revision: 42, name: 'Renamed' }).catch(() => undefined);
    expect(JSON.parse(String(sent[1]?.init.body))).toEqual({ revision: 42, name: 'Renamed' });
    expect(sent[1]?.init.method).toBe('PATCH');
    await putScriptTranslation('s', 'pcm', { revision: 43, texts: { greet: { text: 'Hello' } } }).catch(() => undefined);
    expect(sent[2]?.url).toBe('/api/v1/scripts/s/translations/pcm');
    expect(sent[2]?.init.method).toBe('PUT');
  });

  it('read an answer the contract does not describe as a network failure, never as data', async () => {
    stub(200, { ...RUN, status: 'expired' });
    const result = await getScriptRun(RUN.id);
    expect(result).toEqual({ ok: false, error: { code: 'network', status: 200, details: [] } });
  });

  it('read an answer whose amount is not integer minor units as a network failure, never as data', async () => {
    for (const amountMinor of ['12.50', '', '1e3']) {
      stub(200, { ...RUN, answers: { ptp: { type: 'form', values: { amount: { amountMinor, currency: 'NGN' } }, updatedAt: '2026-10-12T09:01:00Z' } } });
      expect(await getScriptRun(RUN.id)).toEqual({ ok: false, error: { code: 'network', status: 200, details: [] } });
    }
    stub(200, { ...RUN, answers: { ptp: { type: 'form', values: { amount: { amountMinor: '-2500000', currency: 'NGN' } }, updatedAt: '2026-10-12T09:01:00Z' } } });
    expect((await getScriptRun(RUN.id)).ok).toBe(true);
  });

  it('read a refusal by its code and details, and an unknown code as a network failure', async () => {
    stub(409, { statusCode: 409, error: 'Conflict', code: 'stale_write', message: 'm' });
    expect(await completeScriptRun(RUN.id, { revision: 1, outcome: 'completed', dispositionId: 'd' })).toEqual({
      ok: false,
      error: { code: 'stale_write', status: 409, details: [] },
    });
    stub(400, { statusCode: 400, code: 'validation_failed', message: 'm', details: [{ path: 'values.amount', code: 'too_small' }] });
    expect(await getScriptRun(RUN.id)).toEqual({ ok: false, error: { code: 'validation_failed', status: 400, details: [{ path: 'values.amount', code: 'too_small' }] } });
    stub(418, { code: 'teapot' });
    expect(await getScriptRun(RUN.id)).toEqual({ ok: false, error: { code: 'network', status: 418, details: [] } });
  });

  it('report a request that never arrived with status 0, so a completion can be sent again exactly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('connection reset'))));
    expect(await completeScriptRun(RUN.id, { revision: 1, outcome: 'completed', dispositionId: 'd' })).toEqual({
      ok: false,
      error: { code: 'network', status: 0, details: [] },
    });
  });
});
