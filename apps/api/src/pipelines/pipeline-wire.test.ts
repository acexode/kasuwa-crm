import type { DealCard, PipelineDetail } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import {
  RequirementShapeError,
  requirementFieldWire,
  toDealWire,
  toPipelineWire,
} from './pipeline-wire';
import { EMPTY_CUSTOM_WIRE } from '../custom-fields/custom-values';

// Invented ids and synthetic names; nothing seeds them.
const id = (tail: string) => `11111111-0000-4000-8000-0107${tail.padStart(8, '0')}`;
const NOW = Date.UTC(2031, 0, 31, 12);
const DAY = 24 * 60 * 60 * 1000;

function card(overrides: Partial<DealCard> = {}): DealCard {
  return {
    id: id('e1'),
    programmeId: id('e2'),
    pipelineId: id('e3'),
    stageId: id('e4'),
    version: 3,
    name: 'T0107 synthetic deal',
    amountMinor: '999999999999999995',
    currency: 'NGN',
    weightedAmountMinor: '100000000000000000',
    expectedCloseDate: '2031-03-01',
    ownerUserId: id('e5'),
    owner: { id: id('e5'), displayName: null },
    primaryContactId: id('e6'),
    contact: { id: id('e6'), displayName: 'T0107 synthetic contact' },
    accountId: id('e7'),
    account: { id: id('e7'), name: 'T0107 synthetic account' },
    nextStep: 'T0107 synthetic step',
    stageEnteredAt: new Date(NOW - 8 * DAY),
    closedAt: null,
    checks: [],
    createdAt: new Date(NOW - 9 * DAY),
    updatedAt: new Date(NOW - 8 * DAY),
    ...overrides,
  };
}

describe('toDealWire (Deal: withheld fields are omitted, never nulled)', () => {
  it('carries money as strings, exactly, and the weighted amount in the same currency', () => {
    const wire = toDealWire(card(), [], true, 14, NOW, EMPTY_CUSTOM_WIRE);
    expect(wire.amount).toEqual({ amountMinor: '999999999999999995', currency: 'NGN' });
    expect(wire.weightedAmount).toEqual({ amountMinor: '100000000000000000', currency: 'NGN' });
    expect(JSON.stringify(wire)).toContain('"amountMinor":"999999999999999995"');
    expect(wire.rotting).toBe('stale');
    expect(wire.withheldFields).toEqual([]);
  });

  it('a deal with no amount has amount and weightedAmount null (present)', () => {
    const wire = toDealWire(
      card({ amountMinor: null, currency: null, weightedAmountMinor: null }),
      [],
      true,
      14,
      NOW, EMPTY_CUSTOM_WIRE,
    );
    expect(wire).toHaveProperty('amount', null);
    expect(wire).toHaveProperty('weightedAmount', null);
  });

  it('omits each withheld field with its companion and lists it', () => {
    const withheld = [
      'amount',
      'ownerUserId',
      'primaryContactId',
      'accountId',
      'expectedCloseDate',
      'nextStep',
    ] as const;
    const wire = toDealWire(card(), withheld, true, 14, NOW, EMPTY_CUSTOM_WIRE);
    for (const key of [
      'amount',
      'weightedAmount',
      'ownerUserId',
      'owner',
      'primaryContactId',
      'contact',
      'accountId',
      'account',
      'expectedCloseDate',
      'nextStep',
    ]) {
      expect(key in wire, key).toBe(false);
    }
    expect(wire.withheldFields).toEqual([...withheld]);
    expect(wire.name).toBe('T0107 synthetic deal');
  });

  it('the contact summary carries null for displayName when a contact name part is withheld (T-0124 I3)', () => {
    const shown = toDealWire(card(), [], true, 14, NOW, EMPTY_CUSTOM_WIRE);
    const hidden = toDealWire(card(), [], false, 14, NOW, EMPTY_CUSTOM_WIRE);
    expect(shown.contact?.displayName).toEqual(expect.any(String));
    expect(hidden.contact).toEqual({ id: shown.contact?.id, displayName: null });
    expect(hidden.withheldFields).toEqual([]);
  });

  it('a closed deal does not rot', () => {
    const closed = new Date(NOW - 400 * DAY);
    expect(
      toDealWire(card({ closedAt: closed, stageEnteredAt: closed }), [], true, null, NOW, EMPTY_CUSTOM_WIRE).rotting,
    ).toBeNull();
  });
});

describe('toPipelineWire', () => {
  const detail: PipelineDetail = {
    id: id('f1'),
    programmeId: id('f2'),
    name: 'T0107 pipeline',
    version: 1,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    stages: [
      {
        id: id('f3'),
        name: 'T0107 open',
        kind: 'open',
        position: 0,
        probabilityBp: 1000,
        rottingAfterDays: 14,
      },
      {
        id: id('f4'),
        name: 'T0107 won',
        kind: 'won',
        position: 1,
        probabilityBp: 10000,
        rottingAfterDays: null,
      },
    ],
    requirements: [
      { id: id('f5'), stageId: id('f4'), kind: 'field', field: 'expected_close_date', label: null },
      { id: id('f6'), stageId: id('f4'), kind: 'check', field: null, label: 'T0107 check' },
    ],
    transitions: [{ fromStageId: id('f3'), toStageId: id('f4') }],
  };

  it('nests requirements under their stage, field names in camelCase (R12)', () => {
    const wire = toPipelineWire(detail);
    expect(wire.stages[0]?.requirements).toEqual([]);
    expect(wire.stages[1]?.requirements).toEqual([
      { id: id('f5'), kind: 'field', field: 'expectedCloseDate' },
      { id: id('f6'), kind: 'check', label: 'T0107 check' },
    ]);
    expect(wire.createdAt).toBe(new Date(NOW).toISOString());
    expect(requirementFieldWire('primary_contact_id')).toBe('primaryContactId');
    expect(requirementFieldWire('amount')).toBe('amount');
  });

  it('refuses a requirement without its field or label rather than inventing one', () => {
    const broken: PipelineDetail = {
      ...detail,
      requirements: [{ id: id('f7'), stageId: id('f3'), kind: 'check', field: null, label: null }],
    };
    expect(() => toPipelineWire(broken)).toThrow(RequirementShapeError);
  });
});
