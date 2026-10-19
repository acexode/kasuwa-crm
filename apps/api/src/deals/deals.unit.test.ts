import { describe, expect, it } from 'vitest';
import { dealCreateChanges, dealMoveChanges, dealUpdateChanges } from './deal-audit';
import {
  dealFieldApiName,
  dealWireField,
  notEditableDealFields,
  withheldDealFields,
} from './deal-fields';
import type { Deal } from './deal.repository';
import { rottingOf, toDealWire, weightedAmountMinor } from './deal-wire';
import {
  CreateDealBody,
  ListDealsQuery,
  MoveDealBody,
  UpdateDealBody,
  isUuid,
} from './deals.schemas';
import { EMPTY_CUSTOM_WIRE } from '../custom-fields/custom-values';
import type { ContactFieldAccess } from '@kasuwa/domain-core';

// Invented ids; nothing seeds them.
const P1 = '11111111-0000-4000-8000-00000108f001';
/** Contact field security in P1: both name parts readable (T-0124 I3). */
const NAMES_READABLE: ContactFieldAccess = new Map([
  [
    P1,
    new Map([
      ['givenNames', 'edit'],
      ['familyName', 'read'],
    ]),
  ],
]);
const OWNER = '11111111-0000-4000-8000-00000108f002';
const OTHER = '11111111-0000-4000-8000-00000108f003';
const STAGE_A = '11111111-0000-4000-8000-00000108f004';
const STAGE_B = '11111111-0000-4000-8000-00000108f005';
const DAY = 24 * 60 * 60 * 1000;

function deal(overrides: Partial<Deal> = {}): Deal {
  const at = new Date(Date.UTC(2031, 0, 1));
  return {
    id: '11111111-0000-4000-8000-00000108f0aa',
    programmeId: P1,
    pipelineId: '11111111-0000-4000-8000-00000108f0bb',
    stageId: STAGE_A,
    stageKind: 'open',
    probabilityBp: 2500,
    rottingAfterDays: 14,
    version: 3,
    name: 'synthetic',
    amountMinor: '999999999999999999',
    currency: 'NGN',
    expectedCloseDate: '2031-02-01',
    ownerUserId: OWNER,
    ownerDisplayName: 'Synthetic Owner',
    primaryContactId: null,
    contactDisplayName: null,
    accountId: null,
    accountName: null,
    nextStep: 'synthetic step',
    stageEnteredAt: at,
    closedAt: null,
    createdAt: at,
    updatedAt: at,
    checks: [],
    ...overrides,
  };
}

const access = (levels: Record<string, 'none' | 'read' | 'edit'>) =>
  new Map([[P1, new Map(Object.entries(levels))]]);

const EDIT_ALL = access({
  name: 'edit',
  amount: 'edit',
  expected_close_date: 'edit',
  owner_user_id: 'edit',
  primary_contact_id: 'edit',
  account_id: 'edit',
  next_step: 'edit',
});

describe('money (D-L121)', () => {
  it('amountMinor is digits only, at most 18, no leading zero; a JSON number, fraction, sign or exponent is a 400 at amount.amountMinor', () => {
    for (const amountMinor of ['0', '5', '999999999999999999']) {
      expect(
        CreateDealBody.safeParse({ name: 'x', amount: { amountMinor, currency: 'NGN' } }).success,
      ).toBe(true);
    }
    for (const amountMinor of [
      '1.5',
      '-1',
      '1e3',
      ' 5',
      '',
      '05',
      '+5',
      '1999999999999999999',
      '٥',
      5,
      null,
    ]) {
      const parsed = CreateDealBody.safeParse({
        name: 'x',
        amount: { amountMinor, currency: 'NGN' },
      });
      expect(parsed.success, String(amountMinor)).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain(
          'amount.amountMinor',
        );
      }
    }
  });

  it('a well-formed unknown code is unknown_currency; anything else is not a code', () => {
    const reason = (currency: unknown) => {
      const parsed = CreateDealBody.safeParse({
        name: 'x',
        amount: { amountMinor: '1', currency },
      });
      if (parsed.success) return 'ok';
      const issue = parsed.error.issues[0];
      return issue?.code === 'custom' ? String(issue.params?.['reason']) : issue?.code;
    };
    expect(reason('KES')).toBe('ok');
    expect(reason('USD')).toBe('unknown_currency');
    expect(reason('ngn')).toBe('invalid_string');
    expect(reason(566)).toBe('invalid_type');
  });

  it('weighted amounts are half-even in BigInt, exact at 18 digits, and strings', () => {
    expect(weightedAmountMinor('5', 2500)).toBe('1');
    expect(weightedAmountMinor('6', 2500)).toBe('2');
    expect(weightedAmountMinor('10', 2500)).toBe('2');
    expect(weightedAmountMinor('14', 2500)).toBe('4');
    expect(weightedAmountMinor('999999999999999999', 7000)).toBe('699999999999999999');
    expect(weightedAmountMinor('999999999999999999', 10000)).toBe('999999999999999999');
  });
});

describe('bodies are closed (D-L120, R15)', () => {
  it('create refuses server-owned keys; update needs version plus a field; move refuses null fields and repeated checks', () => {
    for (const key of [
      'stageId',
      'version',
      'pipelineId',
      'closedAt',
      'checks',
      '__proto__',
      'constructor',
    ]) {
      const body = JSON.parse(`{"name":"x","${key}":1}`) as unknown;
      expect(CreateDealBody.safeParse(body).success, key).toBe(false);
    }
    expect(UpdateDealBody.safeParse({ version: 1 }).success).toBe(false);
    expect(UpdateDealBody.safeParse({ version: 1, nextStep: null }).success).toBe(true);
    expect(UpdateDealBody.safeParse({ version: 2 ** 31, nextStep: 'x' }).success).toBe(false);
    expect(UpdateDealBody.safeParse({ version: 1, stageId: STAGE_B }).success).toBe(false);
    expect(MoveDealBody.safeParse({ version: 1, toStageId: 'not-a-uuid' }).success).toBe(true);
    expect(MoveDealBody.safeParse({ version: 1, toStageId: STAGE_B, fields: {} }).success).toBe(
      false,
    );
    expect(
      MoveDealBody.safeParse({ version: 1, toStageId: STAGE_B, fields: { amount: null } }).success,
    ).toBe(false);
    expect(
      MoveDealBody.safeParse({
        version: 1,
        toStageId: STAGE_B,
        checks: [OWNER, OWNER.toUpperCase()],
      }).success,
    ).toBe(false);
    expect(
      MoveDealBody.safeParse({ version: 1, toStageId: STAGE_B, checkedBy: OWNER }).success,
    ).toBe(false);
  });

  it('a calendar date must exist and has no time; the list query ignores unknown parameters', () => {
    expect(CreateDealBody.safeParse({ name: 'x', expectedCloseDate: '2031-02-28' }).success).toBe(
      true,
    );
    expect(CreateDealBody.safeParse({ name: 'x', expectedCloseDate: '2031-02-30' }).success).toBe(
      false,
    );
    expect(
      CreateDealBody.safeParse({ name: 'x', expectedCloseDate: '2031-03-01T00:00:00Z' }).success,
    ).toBe(false);
    const query = ListDealsQuery.parse({ programmeId: P1, owner: 'me' });
    expect(query).not.toHaveProperty('programmeId');
    expect(query.owner).toEqual(['me']);
    expect(ListDealsQuery.safeParse({ owner: 'everyone' }).success).toBe(false);
    expect(ListDealsQuery.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('isUuid decides the one 404 for path ids', () => {
    expect(isUuid(OWNER)).toBe(true);
    expect(isUuid(OWNER.toUpperCase())).toBe(true);
    for (const value of ['not-a-uuid', `${OWNER}0`, ' ', '\u0000', 5])
      expect(isUuid(value)).toBe(false);
  });
});

describe('field security on the wire (R13)', () => {
  it('maps wire names and requirement api names both ways', () => {
    expect(dealFieldApiName('expectedCloseDate')).toBe('expected_close_date');
    expect(dealWireField('primary_contact_id')).toBe('primaryContactId');
    expect(dealWireField('stage_id')).toBeNull();
  });

  it('omits withheld fields and their summaries, names them in contract order, and never withholds name', () => {
    const levels = access({
      name: 'none',
      amount: 'none',
      expected_close_date: 'read',
      owner_user_id: 'none',
      primary_contact_id: 'edit',
      account_id: 'edit',
      next_step: 'none',
    });
    const wire = toDealWire(deal(), levels, NAMES_READABLE, EMPTY_CUSTOM_WIRE, Date.UTC(2031, 0, 2));
    expect(wire.withheldFields).toEqual(['amount', 'ownerUserId', 'nextStep']);
    for (const key of ['amount', 'weightedAmount', 'ownerUserId', 'owner', 'nextStep']) {
      expect(key in wire, key).toBe(false);
    }
    expect(wire.name).toBe('synthetic');
    expect(withheldDealFields(levels, P1)).toEqual(['amount', 'ownerUserId', 'nextStep']);
    expect(
      notEditableDealFields(levels, P1, ['name', 'expectedCloseDate', 'accountId', 'version']),
    ).toEqual(['name', 'expectedCloseDate']);
  });

  it('serialises money as strings and never a bigint (JSON.stringify would throw)', () => {
    const wire = toDealWire(deal(), EDIT_ALL, NAMES_READABLE, EMPTY_CUSTOM_WIRE, Date.UTC(2031, 0, 2));
    const text = JSON.stringify(wire);
    expect(text).toContain('"amountMinor":"999999999999999999"');
    expect(text).toContain('"amountMinor":"250000000000000000"');
    expect(toDealWire(deal({ amountMinor: null, currency: null }), EDIT_ALL, NAMES_READABLE, EMPTY_CUSTOM_WIRE)).toMatchObject({
      amount: null,
      weightedAmount: null,
    });
  });
});

describe('toDealWire contact summary (T-0124 I3)', () => {
  const CONTACT = '11111111-0000-4000-8000-00000124c001';
  const named = deal({ primaryContactId: CONTACT, contactDisplayName: 'Zq Synthetic Person' });

  it('names the contact for a reader of both parts', () => {
    expect(toDealWire(named, EDIT_ALL, NAMES_READABLE, EMPTY_CUSTOM_WIRE).contact).toEqual({
      id: CONTACT,
      displayName: 'Zq Synthetic Person',
    });
  });

  it('is null, the id still served, when either part is withheld in the deal’s programme, and nothing is listed', () => {
    for (const part of ['givenNames', 'familyName']) {
      const access: ContactFieldAccess = new Map([
        [
          P1,
          new Map([
            ['givenNames', part === 'givenNames' ? 'none' : 'edit'],
            ['familyName', part === 'familyName' ? 'none' : 'edit'],
          ]),
        ],
      ]);
      const wire = toDealWire(named, EDIT_ALL, access, EMPTY_CUSTOM_WIRE);
      expect(wire.contact, part).toEqual({ id: CONTACT, displayName: null });
      expect(wire.withheldFields).toEqual([]);
      expect(JSON.stringify(wire)).not.toContain('Zq Synthetic');
    }
  });

  it('fails closed for a programme the contact access does not know', () => {
    expect(toDealWire(named, EDIT_ALL, new Map(), EMPTY_CUSTOM_WIRE).contact).toEqual({
      id: CONTACT,
      displayName: null,
    });
  });
});

describe('rotting (DealRotting)', () => {
  const entered = new Date(Date.UTC(2031, 0, 1));
  const at = (ms: number) => rottingOf(entered, null, 21, entered.getTime() + ms);
  it('stale from half rottingAfterDays rounded down, rotting from rottingAfterDays, null when closed', () => {
    expect(at(10 * DAY - 1)).toBe('fresh');
    expect(at(10 * DAY)).toBe('stale');
    expect(at(21 * DAY - 1)).toBe('stale');
    expect(at(21 * DAY)).toBe('rotting');
    expect(rottingOf(entered, entered, null, entered.getTime() + 100 * DAY)).toBeNull();
  });
});

describe('audit (R8-R11)', () => {
  it('a create names the keys sent with a value and records the owner id, sent or defaulted; an update names exactly what changed, owner ids excepted', () => {
    expect(
      dealCreateChanges(
        {
          name: 'x',
          nextStep: null,
          amount: { amountMinor: '1', currency: 'NGN' },
        },
        OWNER.toUpperCase(),
      ),
    ).toEqual([
      { field: 'name', before: null, after: null, redacted: true },
      { field: 'amount', before: null, after: null, redacted: true },
      { field: 'ownerUserId', before: null, after: OWNER, redacted: false },
    ]);
    // Sent as null (an unowned deal): no owner change, never a redacted name for it.
    expect(dealCreateChanges({ name: 'x', ownerUserId: null }, null)).toEqual([
      { field: 'name', before: null, after: null, redacted: true },
    ]);
    const before = deal();
    const after = deal({
      nextStep: 'synthetic step',
      ownerUserId: OTHER,
      name: 'renamed',
      version: 4,
    });
    expect(dealUpdateChanges(before, after)).toEqual([
      { field: 'name', before: null, after: null, redacted: true },
      { field: 'ownerUserId', before: OWNER, after: OTHER, redacted: false },
    ]);
    expect(dealUpdateChanges(before, deal({ ownerUserId: null }))).toEqual([
      { field: 'ownerUserId', before: OWNER, after: null, redacted: false },
    ]);
  });

  it('a move records the stage ids, the fields filled and checks by name, never a value', () => {
    const changes = dealMoveChanges(
      deal(),
      deal({ stageId: STAGE_B, closedAt: new Date() }),
      ['amount'],
      true,
    );
    expect(changes).toEqual([
      { field: 'stageId', before: STAGE_A, after: STAGE_B, redacted: false },
      { field: 'amount', before: null, after: null, redacted: true },
      { field: 'checks', before: null, after: null, redacted: true },
      { field: 'stageEnteredAt', before: null, after: null, redacted: true },
      { field: 'closedAt', before: null, after: null, redacted: true },
    ]);
    expect(JSON.stringify(changes)).not.toContain('synthetic');
  });
});
