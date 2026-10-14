import { describe, expect, it } from 'vitest';
import type { Deal, Pipeline, PipelineStage } from '../../lib/pipelines-api';
import {
  DRAG_CLICK_WINDOW_MS,
  EMPTY_INPUT,
  NO_FILTERS,
  allowedTargets,
  closedSinceFor,
  errorMessage,
  filtersActive,
  formatCalendarDate,
  isAllowed,
  isUuid,
  notEditableFields,
  pipelineHref,
  promptBody,
  promptReady,
  rebaseViews,
  requirementViews,
  swallowsClick,
  toDealFilters,
  unmetRequirementIds,
  type PromptInput,
} from './pipeline-model';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const QUALIFIED: PipelineStage = { id: id(1), name: 'Qualified', kind: 'open', position: 0, probabilityBp: 1000, rottingAfterDays: 14, requirements: [] };
const NEGOTIATION: PipelineStage = {
  id: id(2),
  name: 'Negotiation',
  kind: 'open',
  position: 1,
  probabilityBp: 7000,
  rottingAfterDays: 14,
  requirements: [
    { id: id(21), kind: 'field', field: 'amount' },
    { id: id(22), kind: 'field', field: 'expectedCloseDate' },
    { id: id(23), kind: 'check', label: 'Quote sent' },
  ],
};
const WON: PipelineStage = { id: id(3), name: 'Won', kind: 'won', position: 2, probabilityBp: 10000, rottingAfterDays: null, requirements: [] };
const LOST: PipelineStage = { id: id(4), name: 'Lost', kind: 'lost', position: 3, probabilityBp: 0, rottingAfterDays: null, requirements: [] };

const PIPELINE: Pipeline = {
  id: id(9),
  programmeId: id(8),
  name: 'Sales',
  version: 1,
  stages: [LOST, WON, NEGOTIATION, QUALIFIED],
  transitions: [
    { fromStageId: QUALIFIED.id, toStageId: NEGOTIATION.id },
    { fromStageId: QUALIFIED.id, toStageId: LOST.id },
    { fromStageId: NEGOTIATION.id, toStageId: WON.id },
  ],
};

function deal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: id(100),
    programmeId: PIPELINE.programmeId,
    pipelineId: PIPELINE.id,
    stageId: QUALIFIED.id,
    version: 3,
    name: 'Synthetic deal',
    amount: { amountMinor: '100', currency: 'NGN' },
    expectedCloseDate: null,
    ownerUserId: null,
    owner: null,
    nextStep: null,
    stageEnteredAt: '2026-10-01T00:00:00.000Z',
    closedAt: null,
    rotting: 'fresh',
    checks: [],
    withheldFields: [],
    ...overrides,
  };
}

describe('the allow-list', () => {
  it('offers exactly the targets the pipeline allows from the stage, in position order, never the stage itself', () => {
    expect(allowedTargets(PIPELINE, QUALIFIED.id).map((stage) => stage.name)).toEqual(['Negotiation', 'Lost']);
    expect(allowedTargets(PIPELINE, WON.id)).toEqual([]);
    expect(isAllowed(PIPELINE, QUALIFIED.id, WON.id)).toBe(false);
    expect(isAllowed(PIPELINE, NEGOTIATION.id, WON.id)).toBe(true);
  });
});

describe('the requirement prompt', () => {
  it('shows a held field and a recorded check as met, and a withheld field as a lock', () => {
    const views = requirementViews(NEGOTIATION, deal({ checks: [{ requirementId: id(23) }] }), []);
    expect(views.map((view) => [view.met, view.locked])).toEqual([
      [true, false],
      [false, false],
      [true, false],
    ]);
    const locked = requirementViews(NEGOTIATION, deal({ amount: undefined, withheldFields: ['amount'] }), ['amount']);
    expect(locked[0]).toMatchObject({ met: false, locked: true });
  });

  it('sends only what the person filled: never a met requirement, a lock or an untouched field', () => {
    const views = requirementViews(NEGOTIATION, deal(), []);
    const input: PromptInput = { ...EMPTY_INPUT, text: { [id(22)]: '2026-11-20', [id(21)]: '99' }, checks: { [id(23)]: true } };
    expect(promptReady(views, EMPTY_INPUT)).toBe(false);
    expect(promptReady(views, input)).toBe(true);
    expect(promptBody(3, NEGOTIATION.id, views, input)).toEqual({
      version: 3,
      toStageId: NEGOTIATION.id,
      fields: { expectedCloseDate: '2026-11-20' },
      checks: [id(23)],
    });
  });

  it('turns a typed amount into minor units with its currency, and refuses an unusable one', () => {
    const views = requirementViews(NEGOTIATION, deal({ amount: null }), []);
    const typed: PromptInput = { ...EMPTY_INPUT, text: { [id(21)]: '1250.5', [id(22)]: '2026-11-20' }, currency: { [id(21)]: 'GHS' }, checks: { [id(23)]: true } };
    expect(promptBody(3, NEGOTIATION.id, views, typed).fields).toEqual({ amount: { amountMinor: '125050', currency: 'GHS' }, expectedCloseDate: '2026-11-20' });
    expect(promptReady(views, { ...typed, text: { ...typed.text, [id(21)]: '12.345' } })).toBe(false);
    expect(promptReady(views, { ...typed, currency: {} })).toBe(false);
  });

  it('leaves a lock to the server: a prompt whose only gaps are locks can be confirmed', () => {
    const views = requirementViews(NEGOTIATION, deal({ amount: undefined, expectedCloseDate: undefined, withheldFields: ['amount', 'expectedCloseDate'] }), [
      'amount',
      'expectedCloseDate',
    ]);
    const input: PromptInput = { ...EMPTY_INPUT, checks: { [id(23)]: true } };
    expect(promptReady(views, input)).toBe(true);
    expect(promptBody(3, NEGOTIATION.id, views, input)).toEqual({ version: 3, toStageId: NEGOTIATION.id, checks: [id(23)] });
  });

  it('rebases on the fresh deal after a stale write, keeping what was typed and noting what somebody else changed (D-L102)', () => {
    const served = deal();
    const views = requirementViews(NEGOTIATION, served, []);
    const input: PromptInput = { ...EMPTY_INPUT, text: { [id(22)]: '2026-11-20' }, checks: { [id(23)]: true } };
    const changed = rebaseViews(views, served, deal({ version: 4, expectedCloseDate: '2026-11-30' }), NEGOTIATION, [], input);
    expect(changed.conflicts).toEqual([id(22)]);
    expect(promptBody(4, NEGOTIATION.id, changed.views, input)).toEqual({
      version: 4,
      toStageId: NEGOTIATION.id,
      fields: { expectedCloseDate: '2026-11-20' },
      checks: [id(23)],
    });
    const untouched = rebaseViews(views, served, deal({ version: 4, nextStep: 'Changed elsewhere' }), NEGOTIATION, [], input);
    expect(untouched.conflicts).toEqual([]);
    // A requirement nobody typed that somebody else met is met now, and never sent.
    const met = rebaseViews(views, served, deal({ version: 4, expectedCloseDate: '2026-11-30' }), NEGOTIATION, [], { ...EMPTY_INPUT, checks: { [id(23)]: true } });
    expect(met.views[1]?.met).toBe(true);
  });
});

describe('filters', () => {
  it('builds no filter on a withheld field, and drops a close window that ends before it starts', () => {
    const state = { ...NO_FILTERS, q: 'lockers', owner: 'me' as const, currency: 'NGN', closeFrom: '2026-11-01', closeTo: '2026-10-01' };
    expect(toDealFilters(state, [])).toEqual({ q: 'lockers', owner: ['me'], currency: ['NGN'], closeFrom: '2026-11-01', closeTo: '', closedSince: null });
    expect(toDealFilters(state, ['amount', 'ownerUserId', 'expectedCloseDate'])).toEqual({
      q: 'lockers',
      owner: [],
      currency: [],
      closeFrom: '',
      closeTo: '',
      closedSince: null,
    });
    expect(toDealFilters({ ...NO_FILTERS, currency: 'USD' }, []).currency).toEqual([]);
  });

  it('starts on the server’s 90-day won window and sends a whole-day window as a UTC instant', () => {
    const now = Date.parse('2026-10-12T09:00:00.000Z');
    expect(closedSinceFor(90, now)).toBeNull();
    expect(closedSinceFor(365, now)).toBe('2025-10-12T09:00:00.000Z');
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, wonDays: 365 })).toBe(true);
  });
});

describe('refusals', () => {
  it('localises by code and never by message', () => {
    expect(errorMessage({ status: 409, code: 'transition_not_allowed', details: [] })).toBe('records.error.transition_not_allowed');
    expect(errorMessage({ status: 403, code: 'not_permitted', details: [] })).toBe('records.error.not_permitted');
    expect(errorMessage({ status: 0, code: 'network', details: [] })).toBe('records.error.network');
  });

  it('keeps server-fault wording for 5xx alone, and says "could not be saved" for every other refusal', () => {
    expect(errorMessage({ status: 503, code: 'service_unavailable', details: [] })).toBe('records.error.service_unavailable');
    expect(errorMessage({ status: 500, code: 'something_new', details: [] })).toBe('records.error.internal_error');
    for (const detail of ['unknown_reference', 'field_withheld', 'field_not_editable']) {
      expect(errorMessage({ status: 400, code: 'validation_failed', details: [{ path: 'fields.x', code: detail }] }), detail).toBe('pipeline.error.unsaved');
    }
    expect(errorMessage({ status: 403, code: 'not_permitted', details: [{ path: 'ownerUserId', code: 'field_not_editable' }] })).toBe('pipeline.error.unsaved');
    expect(errorMessage({ status: 400, code: 'validation_failed', details: [] })).toBe('pipeline.error.unsaved');
    expect(errorMessage({ status: 418, code: 'something_new', details: [] })).toBe('pipeline.error.unsaved');
    // A read keeps validation_failed's own advice (clear the search and filters).
    expect(errorMessage({ status: 400, code: 'validation_failed', details: [] }, 'read')).toBe('records.error.validation_failed');
  });

  it('reads the fields a field_not_editable names and the requirements a 422 names', () => {
    expect(
      notEditableFields({ status: 403, code: 'not_permitted', details: [{ path: 'amount', code: 'field_not_editable' }, { path: 'ownerUserId', code: 'owner_not_self' }] }),
    ).toEqual(['amount']);
    expect(unmetRequirementIds({ status: 422, code: 'requirements_unmet', details: [{ path: `requirements.${id(23)}`, code: 'requirement_unmet' }] })).toEqual([id(23)]);
  });
});

describe('links and dates', () => {
  it('links an index row only from a well-formed uuid (R15)', () => {
    expect(pipelineHref(id(9))).toBe(`/pipelines/${id(9)}`);
    expect(pipelineHref('../../admin')).toBeNull();
    expect(pipelineHref('not-a-uuid')).toBeNull();
  });

  it('links only from a well-formed uuid', () => {
    expect(isUuid(id(1))).toBe(true);
    expect(isUuid('javascript:alert(1)//')).toBe(false);
    expect(isUuid('../../admin/audit?export=1#x')).toBe(false);
    expect(isUuid(null)).toBe(false);
  });

  it('draws a calendar date without shifting it through a zone', () => {
    expect(formatCalendarDate('en', '2026-12-01')).toContain('2026');
    expect(formatCalendarDate('en', '2026-12-01')).toMatch(/\b1\b/);
  });
});

describe('the click that ends a drag (R15)', () => {
  it('is swallowed on the dragged card within the window, and no other click is', () => {
    expect(swallowsClick(1_000, 1_000, true)).toBe(true);
    expect(swallowsClick(1_000, 1_000 + DRAG_CLICK_WINDOW_MS, true)).toBe(true);
    expect(swallowsClick(1_000, 1_001 + DRAG_CLICK_WINDOW_MS, true)).toBe(false);
    expect(swallowsClick(1_000, 1_010, false)).toBe(false);
    expect(swallowsClick(1_000, 999, true)).toBe(false);
  });
});
