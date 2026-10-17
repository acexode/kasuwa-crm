import { describe, expect, it } from 'vitest';
import {
  isCalendarDate,
  isUtcDateTime,
  ListPipelinesQuery,
  PipelineBoardQuery,
  PipelineIdParam,
} from './pipelines.schemas';
import { boardStageNamed, resolveClosedSince } from './pipelines.service';

const DAY = 24 * 60 * 60 * 1000;

describe('the board’s query (T-0107)', () => {
  it('dates are real calendar dates; closedSince is a UTC date-time with Z', () => {
    expect(isCalendarDate('2031-03-04')).toBe(true);
    expect(isCalendarDate('2031-02-30')).toBe(false);
    expect(isCalendarDate('2031-3-4')).toBe(false);
    expect(isUtcDateTime('2026-07-14T09:00:00.000Z')).toBe(true);
    expect(isUtcDateTime('2026-07-14T09:00:00.123456Z')).toBe(true);
    for (const bad of [
      '2026-07-14T09:00:00+01:00',
      '2026-07-14',
      'yesterday',
      '2026-02-30T00:00:00Z',
    ]) {
      expect(isUtcDateTime(bad), bad).toBe(false);
    }
  });

  it('defaults the limits, refuses out-of-range ones, and ignores unknown parameters', () => {
    expect(PipelineBoardQuery.parse({ programmeId: 'x' })).toEqual({ limit: 20 });
    expect(ListPipelinesQuery.parse({ tenantId: 'x' })).toEqual({ limit: 25 });
    for (const limit of ['0', '51', 'x', '1.5']) {
      expect(PipelineBoardQuery.safeParse({ limit }).success, limit).toBe(false);
    }
    expect(ListPipelinesQuery.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('repeated parameters arrive as arrays; owner takes me, unassigned or a uuid', () => {
    const parsed = PipelineBoardQuery.parse({ owner: 'me', currency: ['GHS', 'KES'] });
    expect(parsed.owner).toEqual(['me']);
    expect(parsed.currency).toEqual(['GHS', 'KES']);
    expect(PipelineBoardQuery.safeParse({ owner: 'bogus' }).success).toBe(false);
    expect(PipelineBoardQuery.safeParse({ q: 'card\u0000' }).success).toBe(false);
    expect(PipelineBoardQuery.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    // stageId and currency values are judged later, with their own codes.
    expect(PipelineBoardQuery.safeParse({ stageId: 'not-a-uuid', currency: 'ngn' }).success).toBe(
      true,
    );
  });

  it('closedSince: 90 days by default, refused beyond 366 days back or in the future, never clamped', () => {
    const now = Date.UTC(2031, 5, 1);
    expect(resolveClosedSince(undefined, now)).toEqual({
      closedSince: new Date(now - 90 * DAY).toISOString(),
    });
    const sent = new Date(now - 365 * DAY).toISOString();
    expect(resolveClosedSince(sent, now)).toEqual({ closedSince: sent });
    expect(resolveClosedSince(new Date(now - 367 * DAY).toISOString(), now)).toEqual({
      refusal: { path: 'closedSince', code: 'window_too_long' },
    });
    expect(resolveClosedSince(new Date(now + DAY).toISOString(), now)).toEqual({
      refusal: { path: 'closedSince', code: 'invalid_window' },
    });
  });

  it('stageId names a column (open or won) of this pipeline, or nothing', () => {
    const open = {
      id: '11111111-0000-4000-8000-0107000000a1',
      name: 'T0107 open',
      kind: 'open' as const,
      position: 0,
      probabilityBp: 1000,
      rottingAfterDays: 14,
    };
    expect(boardStageNamed([open], open.id.toUpperCase())).toBe(open);
    expect(boardStageNamed([open], '11111111-0000-4000-8000-0107000000a2')).toBeNull();
    expect(boardStageNamed([open], 'not-a-uuid')).toBeNull();
    expect(boardStageNamed([open], [open.id])).toBeNull();
  });
});

describe('the pipeline path (parsed, never cast; a failure is the one 404 in the service)', () => {
  it('accepts a uuid in either case and nothing else', () => {
    const id = '11111111-0000-4000-8000-0107000000b1';
    expect(PipelineIdParam.parse({ pipelineId: id })).toEqual({ pipelineId: id });
    expect(PipelineIdParam.safeParse({ pipelineId: id.toUpperCase() }).success).toBe(true);
    for (const bad of [
      { pipelineId: 'not-a-uuid' },
      { pipelineId: "1' OR '1'='1" },
      { pipelineId: 'x'.repeat(300) },
      { pipelineId: [id] },
      {},
      null,
      id,
    ]) {
      expect(PipelineIdParam.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
