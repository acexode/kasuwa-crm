import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDealActivity,
  getDealDetail,
  listDealTimeline,
  moveDealDetail,
  updateDeal,
} from './deal-detail-api';

interface Sent {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, body: unknown): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEAL = {
  id: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4c01',
  programmeId: 'p1',
  pipelineId: 'pl1',
  stageId: 's1',
  version: 2,
  name: 'Synthetic',
  stageEnteredAt: '2026-10-01T00:00:00.000Z',
  closedAt: null,
  rotting: 'fresh',
  checks: [
    {
      requirementId: 'r1',
      checkedAt: '2026-10-02T00:00:00.000Z',
      checkedBy: { id: 'u1', displayName: null },
    },
  ],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  withheldFields: ['amount'],
};

describe('the deal detail client', () => {
  it('reads the deal with who ticked each check, a former checker unnamed', async () => {
    const sent = stubFetch(200, DEAL);
    const result = await getDealDetail(DEAL.id);
    expect(sent[0]?.url).toBe(`/api/v1/deals/${DEAL.id}`);
    expect(sent[0]?.init.method).toBe('GET');
    expect(result.ok && result.value.checks[0]?.checkedBy.displayName).toBeNull();
  });

  it('refuses a check without its checker: the detail draws who and when', async () => {
    stubFetch(200, { ...DEAL, checks: [{ requirementId: 'r1' }] });
    expect((await getDealDetail(DEAL.id)).ok).toBe(false);
  });

  it('updates with PATCH, same-origin, the body exactly as given, with no scope header', async () => {
    const sent = stubFetch(200, DEAL);
    await updateDeal(DEAL.id, { version: 2, nextStep: null, accountId: null });
    expect(sent[0]?.url).toBe(`/api/v1/deals/${DEAL.id}`);
    expect(sent[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      version: 2,
      nextStep: null,
      accountId: null,
    });
    expect(
      Object.keys((sent[0]?.init.headers ?? {}) as Record<string, string>).filter((name) =>
        /programme|tenant/i.test(name),
      ),
    ).toEqual([]);
  });

  it('moves with only the fields and checks there are', async () => {
    const sent = stubFetch(200, DEAL);
    await moveDealDetail(DEAL.id, { version: 2, toStageId: 's2', fields: {}, checks: [] });
    expect(sent[0]?.url).toBe(`/api/v1/deals/${DEAL.id}/move`);
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ version: 2, toStageId: 's2' });
  });

  it('reads the timeline with no limit, echoing a cursor exactly', async () => {
    const sent = stubFetch(200, { data: [], nextCursor: null });
    await listDealTimeline(DEAL.id, null);
    await listDealTimeline(DEAL.id, 'dGltZWxpbmU0001x+/=');
    expect(sent[0]?.url).toBe(`/api/v1/deals/${DEAL.id}/timeline`);
    expect(new URL(String(sent[1]?.url), 'https://kasuwa.test').searchParams.get('cursor')).toBe(
      'dGltZWxpbmU0001x+/=',
    );
  });

  it('logs an activity linked with dealId, at the deal’s own targets, leaving empty text out', async () => {
    const sent = stubFetch(201, { id: 'a1', type: 'note', version: 1, withheldFields: ['dealId'] });
    await createDealActivity(
      DEAL.id,
      { contactId: 'c1', accountId: null },
      {
        type: 'note',
        subject: '  ',
        body: 'Agreed to hold prices.',
        dueAt: '2026-10-16T14:00:00.000Z',
      },
    );
    expect(sent[0]?.url).toBe('/api/v1/activities');
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({
      type: 'note',
      dealId: DEAL.id,
      contactId: 'c1',
      body: 'Agreed to hold prices.',
    });
    await createDealActivity(
      DEAL.id,
      { contactId: 'c1', accountId: 'a1' },
      { type: 'task', subject: 'Send it', dueAt: '2026-10-16T14:00:00.000Z' },
    );
    expect(JSON.parse(String(sent[1]?.init.body))).toEqual({
      type: 'task',
      dealId: DEAL.id,
      contactId: 'c1',
      accountId: 'a1',
      subject: 'Send it',
      dueAt: '2026-10-16T14:00:00.000Z',
    });
  });
});
