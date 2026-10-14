import { describe, expect, it } from 'vitest';
import type { DealDetail } from '../../lib/deal-detail-api';
import type { Pipeline } from '../../lib/pipelines-api';
import {
  activityTargets,
  asRecordsError,
  checkRows,
  composerRefusal,
  editOutcome,
  editedKeys,
  formOf,
  offeredKeys,
  offersAssignToMe,
  pathStages,
  rebaseForm,
  refusedFields,
  uuidHref,
} from './deal-model';

const ME = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01';
const OTHER = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02';
const CONTACT = '6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d01';
const CONTACT_TWO = '6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d02';
const ACCOUNT = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01';

function deal(extra: Partial<DealDetail> = {}): DealDetail {
  return {
    id: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4c01',
    programmeId: 'p1',
    pipelineId: 'pl1',
    stageId: 's-neg',
    version: 5,
    name: 'Synthetic Foods Q4 supply',
    amount: { amountMinor: '1500000015', currency: 'NGN' },
    weightedAmount: { amountMinor: '1050000010', currency: 'NGN' },
    expectedCloseDate: '2026-10-31',
    ownerUserId: OTHER,
    owner: { id: OTHER, displayName: 'Synthetic Agent Two' },
    primaryContactId: CONTACT,
    contact: { id: CONTACT, displayName: 'Synthetic Alpha Buyer' },
    accountId: ACCOUNT,
    account: { id: ACCOUNT, name: 'Synthetic Pharmacy Group' },
    nextStep: 'Send the revised quote',
    stageEnteredAt: '2026-10-03T09:00:00.000Z',
    closedAt: null,
    rotting: 'fresh',
    checks: [],
    withheldFields: [],
    ...extra,
  };
}

const PIPELINE: Pipeline = {
  id: 'pl1',
  programmeId: 'p1',
  name: 'B2B sales',
  version: 1,
  transitions: [],
  stages: [
    {
      id: 's-lost',
      name: 'Lost',
      kind: 'lost',
      position: 6,
      probabilityBp: 0,
      rottingAfterDays: null,
      requirements: [],
    },
    {
      id: 's-won',
      name: 'Won',
      kind: 'won',
      position: 5,
      probabilityBp: 10000,
      rottingAfterDays: null,
      requirements: [],
    },
    {
      id: 's-neg',
      name: 'Negotiation',
      kind: 'open',
      position: 3,
      probabilityBp: 7000,
      rottingAfterDays: 14,
      requirements: [{ id: 'r-quote', kind: 'check', label: 'Quote sent to the customer' }],
    },
    {
      id: 's-q',
      name: 'Qualified',
      kind: 'open',
      position: 0,
      probabilityBp: 1000,
      rottingAfterDays: 14,
      requirements: [],
    },
  ],
};

describe('the stage path and the checks', () => {
  it('is every open stage then won, in position order, never lost', () => {
    expect(pathStages(PIPELINE).map((stage) => stage.id)).toEqual(['s-q', 's-neg', 's-won']);
  });

  it('labels each check from the pipeline, keeps served order, and leaves a former checker and an unconfigured requirement unnamed', () => {
    const rows = checkRows(
      deal({
        checks: [
          {
            requirementId: 'r-gone',
            checkedAt: '2026-09-12T09:00:00.000Z',
            checkedBy: { id: ME, displayName: 'Synthetic Agent One' },
          },
          {
            requirementId: 'r-quote',
            checkedAt: '2026-10-03T09:00:00.000Z',
            checkedBy: { id: OTHER, displayName: null },
          },
        ],
      }),
      PIPELINE,
    );
    expect(rows).toEqual([
      {
        requirementId: 'r-gone',
        label: null,
        checkedBy: 'Synthetic Agent One',
        checkedAt: '2026-09-12T09:00:00.000Z',
      },
      {
        requirementId: 'r-quote',
        label: 'Quote sent to the customer',
        checkedBy: null,
        checkedAt: '2026-10-03T09:00:00.000Z',
      },
    ]);
  });
});

describe('links', () => {
  it('links only a well-formed uuid', () => {
    expect(uuidHref('/contacts', CONTACT)).toBe(`/contacts/${CONTACT}`);
    expect(uuidHref('/accounts', '../admin')).toBeNull();
    expect(uuidHref('/accounts', 'javascript:alert(1)')).toBeNull();
    expect(uuidHref('/pipelines', null)).toBeNull();
  });
});

describe('assign to me (R11)', () => {
  it('is offered on a colleague’s deal, an unassigned one and a former owner’s, never on the caller’s own or with the owner withheld', () => {
    expect(offersAssignToMe(deal(), ME)).toBe(true);
    expect(offersAssignToMe(deal({ ownerUserId: null, owner: null }), ME)).toBe(true);
    expect(
      offersAssignToMe(deal({ owner: { id: 'gone', displayName: null }, ownerUserId: 'gone' }), ME),
    ).toBe(true);
    expect(
      offersAssignToMe(
        deal({ ownerUserId: ME, owner: { id: ME, displayName: 'Synthetic Agent One' } }),
        ME,
      ),
    ).toBe(false);
    const { ownerUserId: _id, owner: _owner, ...rest } = deal();
    expect(offersAssignToMe({ ...rest, withheldFields: ['ownerUserId'] }, ME)).toBe(false);
    expect(offersAssignToMe(deal(), null)).toBe(false);
  });
});

describe('activity targets (R17)', () => {
  it('targets exactly the served contact and account, one when there is one, none when neither is readable', () => {
    expect(activityTargets(deal())).toEqual({ contactId: CONTACT, accountId: ACCOUNT });
    expect(activityTargets(deal({ accountId: null, account: null }))).toEqual({
      contactId: CONTACT,
      accountId: null,
    });
    expect(activityTargets(deal({ primaryContactId: null, contact: null }))).toEqual({
      contactId: null,
      accountId: ACCOUNT,
    });
    expect(
      activityTargets(
        deal({ primaryContactId: null, contact: null, accountId: null, account: null }),
      ),
    ).toBeNull();
    expect(activityTargets(deal({ withheldFields: ['primaryContactId', 'accountId'] }))).toBeNull();
  });

  it('hands the activity form a code it translates, never a code it does not know', () => {
    expect(
      asRecordsError({
        status: 403,
        code: 'not_permitted',
        details: [{ path: 'dealId', code: 'field_not_editable' }],
      }),
    ).toEqual({
      code: 'not_permitted',
      details: [{ path: 'dealId', code: 'field_not_editable' }],
    });
    expect(asRecordsError({ status: 0, code: 'network', details: [] })).toEqual({
      code: 'network',
    });
    expect(asRecordsError({ status: 400, code: 'task_only', details: [] })).toEqual({
      code: 'validation_failed',
    });
    expect(asRecordsError({ status: 502, code: 'bad_gateway', details: [] })).toEqual({
      code: 'internal_error',
    });
  });
});

describe('the composer’s refusals (R17)', () => {
  it('says a refused deal link is a link it cannot make, and leaves every other refusal to the form', () => {
    expect(
      composerRefusal({
        code: 'not_permitted',
        details: [{ path: 'dealId', code: 'field_not_editable' }],
      }),
    ).toBe('deal.activity.linkRefused');
    expect(composerRefusal({ code: 'not_permitted' })).toBeNull();
    expect(
      composerRefusal({
        code: 'not_permitted',
        details: [{ path: 'contactId', code: 'field_not_editable' }],
      }),
    ).toBeNull();
    expect(
      composerRefusal({
        code: 'validation_failed',
        details: [{ path: 'dealId', code: 'invalid_string' }],
      }),
    ).toBeNull();
  });
});

describe('the edit sheet (R10)', () => {
  it('offers no withheld field, and always the name', () => {
    expect(
      offeredKeys(deal({ withheldFields: ['amount', 'expectedCloseDate', 'ownerUserId'] })),
    ).toEqual(['name', 'nextStep', 'primaryContactId', 'accountId']);
    expect(
      offeredKeys(
        deal({
          withheldFields: [
            'amount',
            'expectedCloseDate',
            'ownerUserId',
            'primaryContactId',
            'accountId',
            'nextStep',
          ],
        }),
      ),
    ).toEqual(['name']);
  });

  it('sends version plus only what changed', () => {
    const seed = formOf(deal());
    const form = {
      ...seed,
      name: 'Synthetic Foods Q4 supply renewed',
      nextStep: 'Call the buyer on Friday',
      expectedCloseDate: '2026-11-14',
    };
    expect(editOutcome(deal(), form, editedKeys(seed, form))).toEqual({
      kind: 'send',
      body: {
        version: 5,
        name: 'Synthetic Foods Q4 supply renewed',
        nextStep: 'Call the buyer on Friday',
        expectedCloseDate: '2026-11-14',
      },
    });
  });

  it('turns typed major units into minor units by string, and clears with null', () => {
    const seed = formOf(deal());
    expect(seed.amount).toBe('15000000.15');
    const form = { ...seed, amount: '16500000', accountId: '' };
    expect(editOutcome(deal(), form, editedKeys(seed, form))).toEqual({
      kind: 'send',
      body: { version: 5, amount: { amountMinor: '1650000000', currency: 'NGN' }, accountId: null },
    });
    const emptied = {
      ...seed,
      amount: '',
      expectedCloseDate: '',
      nextStep: '  ',
      primaryContactId: '',
    };
    expect(editOutcome(deal(), emptied, editedKeys(seed, emptied))).toEqual({
      kind: 'send',
      body: {
        version: 5,
        amount: null,
        expectedCloseDate: null,
        nextStep: null,
        primaryContactId: null,
      },
    });
  });

  it('treats retyping the held value as no change', () => {
    const seed = formOf(deal());
    const form = {
      ...seed,
      name: ' Synthetic Foods Q4 supply ',
      amount: '15000000.15',
      nextStep: 'Send the revised quote',
    };
    expect(editOutcome(deal(), form, ['name', 'amount', 'nextStep'])).toEqual({
      kind: 'unchanged',
    });
    const picked = { ...seed, name: 'Synthetic Foods Q4 supply', primaryContactId: CONTACT_TWO };
    expect(editOutcome(deal(), picked, editedKeys(seed, picked))).toEqual({
      kind: 'send',
      body: { version: 5, primaryContactId: CONTACT_TWO },
    });
  });

  it('refuses a blank name, an unreadable amount and a missing currency locally', () => {
    const seed = formOf(deal({ amount: null, weightedAmount: null }));
    expect(editOutcome(deal(), { ...seed, name: '   ' }, ['name'])).toEqual({
      kind: 'invalid',
      errors: ['name'],
    });
    expect(editOutcome(deal({ amount: null }), { ...seed, amount: '1,250.5' }, ['amount'])).toEqual(
      { kind: 'invalid', errors: ['amount', 'currency'] },
    );
    expect(
      editOutcome(deal({ amount: null }), { ...seed, amount: '1250.505', currency: 'NGN' }, [
        'amount',
      ]),
    ).toEqual({ kind: 'invalid', errors: ['amount'] });
    expect(
      editOutcome(deal({ amount: null }), { ...seed, amount: '100', currency: 'USD' }, [
        'amount',
        'currency',
      ]),
    ).toEqual({ kind: 'invalid', errors: ['currency'] });
  });

  it('never sends a withheld field, even if an edit is somehow held for one', () => {
    const withheldDeal = deal({ withheldFields: ['amount'] });
    const seed = formOf(withheldDeal);
    expect(editOutcome(withheldDeal, { ...seed, amount: '1' }, ['amount'])).toEqual({
      kind: 'unchanged',
    });
  });
});

describe('the 409 rebase (R12, D-L102)', () => {
  it('keeps the typed values, takes the fresh value where the person changed nothing, and flags a field both changed', () => {
    const served = deal();
    const fresh = deal({
      version: 6,
      nextStep: 'Changed at another desk',
      name: 'Renamed at another desk',
    });
    const typed = {
      ...formOf(served),
      expectedCloseDate: '2026-11-14',
      nextStep: 'Typed at this desk',
    };
    const rebased = rebaseForm(served, fresh, typed);
    expect(rebased.form).toEqual({
      ...formOf(fresh),
      expectedCloseDate: '2026-11-14',
      nextStep: 'Typed at this desk',
    });
    expect(rebased.conflicts).toEqual(['nextStep']);
    // The resend: the fresh version, the person's edits, the untouched name never sent.
    expect(editOutcome(fresh, rebased.form, editedKeys(formOf(fresh), rebased.form))).toEqual({
      kind: 'send',
      body: { version: 6, expectedCloseDate: '2026-11-14', nextStep: 'Typed at this desk' },
    });
  });

  it('names a conflict on the amount once, whether the amount or its currency was typed', () => {
    const served = deal();
    const fresh = deal({ version: 6, amount: { amountMinor: '100', currency: 'NGN' } });
    const typed = { ...formOf(served), amount: '20', currency: 'GHS' };
    expect(rebaseForm(served, fresh, typed).conflicts).toEqual(['amount']);
  });

  it('drops an edit to a field withheld since', () => {
    const served = deal();
    const fresh = deal({ version: 6, withheldFields: ['nextStep'] });
    const typed = { ...formOf(served), nextStep: 'Typed at this desk' };
    expect(rebaseForm(served, fresh, typed).form.nextStep).toBe(formOf(fresh).nextStep);
  });
});

describe('refusals', () => {
  it('labels only the deal fields a field_not_editable names', () => {
    expect(
      refusedFields({
        status: 403,
        code: 'not_permitted',
        details: [
          { path: 'amount', code: 'field_not_editable' },
          { path: 'dealId', code: 'field_not_editable' },
          { path: 'nextStep', code: 'invalid_string' },
        ],
      }),
    ).toEqual(['amount']);
    // Assign to me (R11, R13): a refused owner is named by the owner field's label.
    expect(
      refusedFields({
        status: 403,
        code: 'not_permitted',
        details: [{ path: 'ownerUserId', code: 'field_not_editable' }],
      }),
    ).toEqual(['ownerUserId']);
  });
});
