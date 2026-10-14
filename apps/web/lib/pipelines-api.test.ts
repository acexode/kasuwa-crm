import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeal, filterParams, getPipelineBoard, listDeals, moveDeal, searchRecords } from './pipelines-api';

const NO_FILTERS = { q: '', owner: [], currency: [], closeFrom: '', closeTo: '', closedSince: null };

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
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const DEAL = {
  id: 'd1',
  programmeId: 'p1',
  pipelineId: 'pl1',
  stageId: 's1',
  version: 2,
  name: 'Synthetic',
  stageEnteredAt: '2026-10-01T00:00:00.000Z',
  closedAt: null,
  rotting: 'fresh',
  checks: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  withheldFields: ['amount'],
};

describe('the pipelines client', () => {
  it('builds only declared filters, arrays exploded, and no scope', () => {
    const params = filterParams({ q: '  lockers ', owner: ['me', 'unassigned'], currency: ['NGN'], closeFrom: '2026-10-01', closeTo: '', closedSince: null });
    expect(params.toString()).toBe('q=lockers&owner=me&owner=unassigned&closeFrom=2026-10-01&currency=NGN');
    expect(filterParams(NO_FILTERS).toString()).toBe('');
  });

  it('pages a column with its stageId, its cursor and the same filters, same-origin', async () => {
    const sent = stubFetch(200, { pipelineId: 'pl1', closedSince: '2026-07-14T09:00:00.000Z', withheldFields: [], stages: [] });
    const result = await getPipelineBoard('pl1', { ...NO_FILTERS, q: 'x' }, { stageId: 's1', cursor: 'c 1' });
    expect(result.ok).toBe(true);
    expect(sent[0]?.url).toBe('/api/v1/pipelines/pl1/board?q=x&stageId=s1&cursor=c+1');
    expect(sent[0]?.init.cache).toBe('no-store');
    expect(Object.keys(sent[0]?.init.headers ?? {}).filter((name) => /programme|tenant/i.test(name))).toEqual([]);
  });

  it('sends the default sort as nothing, and never a count', async () => {
    const sent = stubFetch(200, { data: [], nextCursor: null });
    await listDeals('pl1', NO_FILTERS, '-updatedAt');
    await listDeals('pl1', NO_FILTERS, 'name', 'cur');
    expect(sent.map((entry) => entry.url)).toEqual(['/api/v1/pipelines/pl1/deals', '/api/v1/pipelines/pl1/deals?sort=name&cursor=cur']);
  });

  it('keeps a withheld amount absent, never null, when it parses a deal', async () => {
    stubFetch(200, DEAL);
    const result = await moveDeal('d1', { version: 2, toStageId: 's2' });
    expect(result.ok && !('amount' in result.value)).toBe(true);
  });

  it('moves with version and toStageId, and fields or checks only when there are any', async () => {
    const sent = stubFetch(200, DEAL);
    await moveDeal('d1', { version: 2, toStageId: 's2', fields: {}, checks: [] });
    await moveDeal('d1', { version: 2, toStageId: 's2', fields: { expectedCloseDate: '2026-11-20' }, checks: ['r1'] });
    expect(sent.map((entry) => JSON.parse(String(entry.init.body)) as unknown)).toEqual([
      { version: 2, toStageId: 's2' },
      { version: 2, toStageId: 's2', fields: { expectedCloseDate: '2026-11-20' }, checks: ['r1'] },
    ]);
  });

  it('creates with the name and only the fields filled', async () => {
    const sent = stubFetch(201, DEAL);
    await createDeal('pl1', { name: 'Synthetic', amount: { amountMinor: '125050', currency: 'GHS' } });
    expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ name: 'Synthetic', amount: { amountMinor: '125050', currency: 'GHS' } });
  });

  it('reads a refusal by code and details, never by message', async () => {
    stubFetch(409, { statusCode: 409, code: 'transition_not_allowed', message: 'whatever' });
    expect(await moveDeal('d1', { version: 2, toStageId: 's2' })).toEqual({ ok: false, error: { status: 409, code: 'transition_not_allowed', details: [] } });
    stubFetch(500, 'not json at all');
    expect(await moveDeal('d1', { version: 2, toStageId: 's2' })).toEqual({ ok: false, error: { status: 0, code: 'network', details: [] } });
  });

  it('offers picker rows of the deal’s programme only', async () => {
    stubFetch(200, {
      data: [
        { id: 'c1', programmeId: 'p1', displayName: 'Synthetic Alpha' },
        { id: 'c2', programmeId: 'p2', displayName: 'Synthetic Alphabet' },
      ],
    });
    const result = await searchRecords('primaryContactId', 'alpha', 'p1');
    expect(result.ok && result.value.map((row) => row.id)).toEqual(['c1']);
  });
});
