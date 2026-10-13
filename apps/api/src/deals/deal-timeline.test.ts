import {
  activityFieldAccessFromObjectAccess,
  activityFieldApiName,
  SECURED_ACTIVITY_FIELDS,
  type ActivityFieldLevel,
  type TimelineActivityRow,
  type TimelineChangeRow,
} from '@kasuwa/domain-core';
import type { FieldAccess, FieldAccessLevel } from '@kasuwa/metadata-engine';
import { describe, expect, it } from 'vitest';
import {
  DEAL_TIMELINE,
  DEAL_TIMELINE_FIELDS,
  dealChangeItem,
  toDealTimelineItems,
  visibleDealChangeFields,
} from './deal-timeline';
import { dealFieldApiName, SECURED_DEAL_FIELDS } from './deal-fields';

// Invented values only (CLAUDE.md 6.1).
const A1 = '11111111-0000-4000-8000-0000011100c1';
const A2 = '11111111-0000-4000-8000-0000011100c2';
const ACTOR = { id: '11111111-0000-4000-8000-0000011100d1', displayName: 'Probe Actor' };
const AT = '2026-04-01T09:00:00.000Z';

const dealAccess = (overrides: Record<string, FieldAccessLevel> = {}): FieldAccess =>
  new Map([
    [
      A1,
      new Map(
        SECURED_DEAL_FIELDS.map(
          (field) => [dealFieldApiName(field), overrides[field] ?? 'edit'] as const,
        ),
      ),
    ],
  ]);

const activityAccess = (overrides: Record<string, ActivityFieldLevel> = {}) =>
  activityFieldAccessFromObjectAccess(
    new Map([
      [
        A1,
        new Map(
          SECURED_ACTIVITY_FIELDS.map(
            (field) => [activityFieldApiName(field), overrides[field] ?? 'edit'] as const,
          ),
        ),
      ],
    ]),
    [A1],
  );

const change = (field: string, extra: Partial<TimelineChangeRow> = {}): TimelineChangeRow => ({
  kind: 'change',
  itemId: `ti_${'a'.repeat(32)}`,
  occurredAt: AT,
  actor: ACTOR,
  field,
  redacted: false,
  before: 'old value',
  after: 'new value',
  ...extra,
});

const activityRow: TimelineActivityRow = {
  kind: 'activity',
  itemId: `ti_${'b'.repeat(32)}`,
  occurredAt: AT,
  actor: ACTOR,
  activityId: '11111111-0000-4000-8000-0000011100e1',
  activityType: 'note',
  subject: 'Probe subject',
  body: 'Probe body',
  dueAt: null,
  completedAt: null,
  startsAt: null,
  endsAt: null,
  version: 2,
};

describe('the deal timeline (T-0111)', () => {
  it('is the record timeline with the deal subject and the dealId link', () => {
    expect(DEAL_TIMELINE.subject).toBe('deal');
    expect(DEAL_TIMELINE.activityLink).toBe('dealId');
  });

  it('R8: shows every field of the closed list by name only, never a value', () => {
    for (const field of DEAL_TIMELINE_FIELDS) {
      expect(dealChangeItem(change(field))).toEqual({
        id: `ti_${'a'.repeat(32)}`,
        occurredAt: AT,
        actor: ACTOR,
        type: 'field_changed',
        field,
        redacted: true,
      });
    }
  });

  it('R8: any other name, stageEnteredAt and closedAt included, gives no item', () => {
    for (const field of ['stageEnteredAt', 'closedAt', 'programmeId', 'consentState', 'tier', '']) {
      expect(dealChangeItem(change(field))).toBeNull();
    }
  });

  it('R9: visible fields are exactly those getDeal does not withhold; name, stageId and checks always', () => {
    expect(visibleDealChangeFields(dealAccess(), A1)).toEqual([...DEAL_TIMELINE_FIELDS]);
    const locked = dealAccess({
      name: 'none',
      amount: 'none',
      ownerUserId: 'none',
      nextStep: 'none',
      expectedCloseDate: 'read',
    });
    expect(visibleDealChangeFields(locked, A1)).toEqual([
      'name',
      'expectedCloseDate',
      'primaryContactId',
      'accountId',
      'stageId',
      'checks',
    ]);
  });

  it('R9: fails closed in a programme the matrix does not carry', () => {
    expect(visibleDealChangeFields(dealAccess(), A2)).toEqual(['name', 'stageId', 'checks']);
  });

  it('R11: the activity item is the shared one, the activity matrix applied', () => {
    const [item] = toDealTimelineItems([activityRow], activityAccess({ subject: 'none' }), A1);
    expect(item).toMatchObject({ type: 'activity', activityId: activityRow.activityId, version: 2 });
    expect(item !== undefined && 'subject' in item).toBe(false);
    expect(item !== undefined && 'dealId' in item).toBe(false);
  });
});
