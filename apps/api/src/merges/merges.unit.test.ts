import type { MergeContact } from '@kasuwa/domain-core';
import type { CustomFieldAccess, CustomFieldDef } from '@kasuwa/metadata-engine';
import type { Grants } from '@kasuwa/permissions';
import { describe, expect, it } from 'vitest';
import {
  DUPLICATES_LIMIT,
  DUPLICATES_TENANT_CONCURRENCY,
  DUPLICATES_WINDOW_MS,
  DuplicatesThrottleGuard,
  retryAfterSeconds,
} from './duplicates-throttle.guard';
import {
  chosenOwnerIsNotMember,
  complianceChoicePaths,
  lockedChoicePaths,
  mergeDefaults,
  mergeRefusal,
  nameOnlyChanges,
  planMerge,
  planUndo,
  undoRefusal,
  type MergeAccess,
} from './merge-decisions';
import {
  CreateContactMergeBody,
  customChoiceKey,
  isComplianceKey,
  isMergeFieldKey,
} from './merges.schemas';

// Synthetic ids only.
const P1 = '11111111-0000-4000-8000-0000000000a1';
const P2 = '11111111-0000-4000-8000-0000000000a2';
const ME = '11111111-0000-4000-8000-0000000000e1';
const OTHER = '11111111-0000-4000-8000-0000000000e2';
const OWNER = '11111111-0000-4000-8000-0000000000e3';
const LEFT = '11111111-0000-4000-8000-0000000000e4';
const S_ID = '11111111-0000-4000-8000-0000000000c1';
const M_ID = '11111111-0000-4000-8000-0000000000c2';
const LATER = new Date('2026-02-01T00:00:00Z');

function grants(sets: Record<string, string | null>, isTenantAdmin = false): Grants {
  return {
    isTenantAdmin,
    reachableProgrammeIds: Object.keys(sets),
    programmeSets: new Map(Object.entries(sets)),
  };
}

function contact(
  id: string,
  values: Record<string, unknown>,
  extra: Partial<MergeContact> = {},
): MergeContact {
  const base = {
    displayName: 'Synthetic Person',
    givenNames: null,
    familyName: null,
    companyName: null,
    phones: [],
    emails: [],
    accountId: null,
    ownerUserId: null,
    status: null,
    source: null,
    tags: [],
    preferredLanguage: null,
    preferredChannel: null,
    state: null,
    lga: null,
    dnd: false,
    whatsappOptIn: false,
    consentState: 'unknown',
  };
  return {
    id,
    programmeId: P1,
    version: 1,
    deletedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    values: { ...base, ...values } as MergeContact['values'],
    custom: {},
    ...extra,
  };
}

const def = (apiName: string): CustomFieldDef => ({
  id: S_ID,
  apiName,
  type: 'text',
  classification: 'none',
  values: [],
  currencyCode: null,
});

type Level = 'none' | 'read' | 'edit';

const CONTACT_FIELDS = [
  'givenNames',
  'familyName',
  'companyName',
  'phones',
  'emails',
  'accountId',
  'ownerUserId',
  'status',
  'source',
  'tags',
  'preferredLanguage',
  'preferredChannel',
  'state',
  'lga',
  'dnd',
  'whatsappOptIn',
  'consentState',
  'phoneNetwork',
] as const;

function access(
  contactLevels: Record<string, Level> = {},
  customLevels: Record<string, Level> = {},
): MergeAccess {
  const contactMap = new Map(
    CONTACT_FIELDS.map((field) => [field, contactLevels[field] ?? 'edit'] as const),
  );
  const custom: CustomFieldAccess = {
    object: 'contact',
    defs: new Map(Object.keys(customLevels).map((key) => [key, def(key)])),
    access: new Map([[P1, new Map(Object.entries(customLevels))]]),
    retired: [],
  };
  return { contact: new Map([[P1, contactMap]]), custom, programmeId: P1 };
}

describe('the merge right (D-P14, D-L151, D-L163)', () => {
  const live = { programmeId: P1, deletedAt: null };
  const away = { programmeId: P1, deletedAt: new Date() };

  it('needs contact.write on both sides; claim rights never merge', () => {
    expect(mergeRefusal(grants({ [P1]: 'admin' }), live, live)).toBeNull();
    for (const set of [
      'agent',
      'team_lead',
      'programme_manager',
      'qa_analyst',
      'client_portal',
      null,
    ]) {
      expect(mergeRefusal(grants({ [P1]: set }), live, live), String(set)).toBe('not_permitted');
    }
    expect(mergeRefusal(grants({ [P1]: 'agent' }, true), live, live), 'tenant admin').toBeNull();
    const elsewhere = { programmeId: P2, deletedAt: null };
    expect(mergeRefusal(grants({ [P1]: 'admin', [P2]: 'agent' }), live, elsewhere)).toBe(
      'not_permitted',
    );
  });

  it('is 404 for an unreadable side, and for a merged-away side without contact.write', () => {
    expect(mergeRefusal(grants({ [P1]: 'admin' }), undefined, live)).toBe('not_found');
    expect(mergeRefusal(grants({ [P1]: 'agent' }), live, away)).toBe('not_found');
    expect(mergeRefusal(grants({ [P1]: 'agent' }), away, live)).toBe('not_found');
    expect(
      mergeRefusal(grants({ [P1]: 'admin' }), live, away),
      'a writer goes on to 409',
    ).toBeNull();
  });
});

describe('the undo right (D-L151, D-L163)', () => {
  const merge = { programmeId: P1, mergedByUserId: ME };
  it('is the merging user holding contact.write now, or a tenant admin', () => {
    expect(undoRefusal(grants({ [P1]: 'admin' }), merge, ME)).toBeNull();
    expect(undoRefusal(grants({ [P1]: 'admin' }), merge, OTHER)).toBe('not_permitted');
    expect(undoRefusal(grants({ [P1]: 'team_lead' }, true), merge, OTHER)).toBeNull();
  });
  it('is 404 without contact.write in the programme, the merger included', () => {
    expect(undoRefusal(grants({ [P1]: 'agent' }), merge, ME)).toBe('not_found');
    expect(undoRefusal(grants({ [P2]: 'admin' }), merge, ME)).toBe('not_found');
  });
});

describe('displayName on a merge follows its name parts (D-L68, T-0124 I11)', () => {
  it('is never a default, choosing it is 403, and the plan keeps the survivor’s, when a part is withheld', () => {
    for (const part of ['givenNames', 'familyName']) {
      const a = access({ [part]: 'none' });
      expect(lockedChoicePaths({ displayName: 'merged' }, a), part).toEqual([
        'choices.displayName',
      ]);
      const survivor = contact(S_ID, { displayName: 'Older Name' });
      const merged = contact(M_ID, { displayName: 'Newer Name' }, { updatedAt: LATER });
      expect(Object.keys(mergeDefaults(survivor, merged, a, new Map()))).not.toContain(
        'displayName',
      );
      expect(planMerge(survivor, merged, a, new Map(), {}).values).not.toHaveProperty(
        'displayName',
      );
    }
  });

  it('is choosable for a reader of both parts, a read-only part included', () => {
    for (const a of [access(), access({ familyName: 'read' })]) {
      expect(lockedChoicePaths({ displayName: 'merged' }, a)).toEqual([]);
    }
  });
});

describe('field security on a merge', () => {
  it('refuses choosing a withheld or read-only field, standard or custom; names compliance keys', () => {
    const a = access({ emails: 'none', lga: 'read' }, { secret__c: 'none', tier__c: 'edit' });
    const choices = {
      emails: 'merged',
      lga: 'survivor',
      status: 'merged',
      'custom.secret__c': 'merged',
      'custom.tier__c': 'merged',
    };
    expect(lockedChoicePaths(choices, a)).toEqual([
      'choices.emails',
      'choices.lga',
      'choices.custom.secret__c',
    ]);
    expect(complianceChoicePaths({ dnd: 'merged', status: 'merged', consentState: 'x' })).toEqual([
      'choices.dnd',
      'choices.consentState',
    ]);
  });

  it('keeps the survivor value for a field it may not edit, and takes the strictest compliance', () => {
    const survivor = contact(S_ID, {
      emails: ['s@example.test'],
      status: 'new',
      dnd: false,
      consentState: 'opted_in',
      whatsappOptIn: true,
    });
    const merged = contact(
      M_ID,
      {
        emails: ['m@example.test'],
        status: 'qualified',
        dnd: true,
        consentState: 'pending',
        whatsappOptIn: false,
      },
      { updatedAt: LATER },
    );
    const plan = planMerge(survivor, merged, access({ emails: 'none' }), new Map(), {});
    expect(plan.values).not.toHaveProperty('emails');
    expect(plan.values.status).toBe('qualified');
    expect([plan.values.dnd, plan.values.whatsappOptIn, plan.values.consentState]).toEqual([
      true,
      false,
      'pending',
    ]);
    expect(plan.auditFields).toEqual(
      expect.arrayContaining(['status', 'dnd', 'whatsappOptIn', 'consentState']),
    );
  });

  it('never defaults to an owner who left the programme, and flags choosing one', () => {
    const survivor = contact(S_ID, { ownerUserId: OWNER });
    const merged = contact(M_ID, { ownerUserId: LEFT }, { updatedAt: LATER });
    const members = new Map([
      [OWNER, true],
      [LEFT, false],
    ]);
    expect(planMerge(survivor, merged, access(), members, {}).values.ownerUserId).toBe(OWNER);
    expect(
      chosenOwnerIsNotMember({ ownerUserId: 'merged' }, survivor, merged, access(), members),
    ).toBe(true);
    expect(
      chosenOwnerIsNotMember({ ownerUserId: 'survivor' }, survivor, merged, access(), members),
    ).toBe(false);
  });
});

describe('audit field names (M3, D-L163)', () => {
  it('records a custom field by its bare key, so a 63-character key fits the 64-character limit', () => {
    const key = `${'k'.repeat(60)}__c`;
    expect(key).toHaveLength(63);
    const survivor = contact(S_ID, {});
    const merged = contact(M_ID, {}, { custom: { [key]: 'x' }, updatedAt: LATER });
    const plan = planMerge(survivor, merged, access({}, { [key]: 'edit' }), new Map(), {});
    expect(plan.custom[key]).toBe('x');
    expect(plan.auditFields).toContain(key);
    expect(plan.auditFields).not.toContain(`custom.${key}`);
    for (const change of nameOnlyChanges(plan.auditFields)) {
      expect(change.field.length).toBeLessThanOrEqual(64);
      expect([change.before, change.after, change.redacted]).toEqual([null, null, true]);
    }
  });

  it('caps one event at 64 names', () => {
    expect(nameOnlyChanges(Array.from({ length: 80 }, (_, i) => `f${i}`))).toHaveLength(64);
  });
});

describe('undo (M12, D-P28, D-L151)', () => {
  const snapshot = {
    merged: {
      values: { displayName: 'Merged', dnd: false, whatsappOptIn: true, consentState: 'opted_in' },
      custom: {},
    },
    survivor: {
      values: {
        displayName: 'Before',
        emails: ['before@example.test'],
        dnd: false,
        whatsappOptIn: true,
        consentState: 'opted_in',
      },
      custom: {},
      versionAfter: 2,
    },
  };

  it('reverts an unedited survivor except compliance; the restored contact takes the stricter', () => {
    const now = contact(
      S_ID,
      {
        displayName: 'After',
        emails: ['after@example.test'],
        dnd: true,
        whatsappOptIn: false,
        consentState: 'withdrawn',
      },
      { version: 2 },
    );
    const plan = planUndo(snapshot, now, access());
    expect(plan.reverted).toBe(true);
    expect(plan.revert).toMatchObject({ displayName: 'Before', emails: ['before@example.test'] });
    expect(plan.revert).not.toHaveProperty('dnd');
    expect([plan.restore.dnd, plan.restore.whatsappOptIn, plan.restore.consentState]).toEqual([
      true,
      false,
      'withdrawn',
    ]);
    expect(plan.lockedFields).toEqual([]);
  });

  it('is all or nothing: a field the revert would change and the undoer may not edit is named', () => {
    const now = contact(
      S_ID,
      { displayName: 'After', emails: ['after@example.test'] },
      { version: 2, custom: { tier__c: 'gold' } },
    );
    const plan = planUndo(snapshot, now, access({ emails: 'read' }, { tier__c: 'read' }));
    expect(plan.lockedFields).toEqual(['emails', 'custom.tier__c']);
  });

  it('leaves an edited survivor alone, so nothing it would restore is judged', () => {
    const edited = contact(S_ID, { displayName: 'Edited' }, { version: 3 });
    const plan = planUndo(snapshot, edited, access({ emails: 'none' }));
    expect([plan.reverted, plan.revert, plan.lockedFields]).toEqual([false, {}, []]);
  });
});

describe('DuplicatesThrottleGuard (M7, D-L163)', () => {
  it('admits the limit per user per window, then refuses until the window ends', () => {
    const guard = new DuplicatesThrottleGuard();
    const now = 1_000_000;
    for (let n = 0; n < DUPLICATES_LIMIT; n += 1) expect(guard.admit('t:u1', now)).toBeNull();
    expect(guard.admit('t:u1', now)).toBe(now + DUPLICATES_WINDOW_MS);
    expect(guard.admit('t:u2', now)).toBeNull();
    expect(guard.admit('t:u1', now + DUPLICATES_WINDOW_MS)).toBeNull();
  });

  it('holds D-L163: 20 per minute per user, at most two concurrent scans per tenant', () => {
    expect(DUPLICATES_LIMIT).toBe(20);
    expect(DUPLICATES_TENANT_CONCURRENCY).toBe(2);
    const guard = new DuplicatesThrottleGuard();
    const first = guard.enter('tenant-a');
    expect(first).not.toBeNull();
    expect(guard.enter('tenant-a')).not.toBeNull();
    expect(guard.enter('tenant-a'), 'a third scan in the tenant').toBeNull();
    expect(guard.enter('tenant-b'), 'another tenant is unaffected').not.toBeNull();
    first?.();
    first?.(); // idempotent
    expect(guard.enter('tenant-a'), 'a released slot is free again').not.toBeNull();
    expect(guard.enter('tenant-a')).toBeNull();
  });

  it('answers Retry-After in whole seconds, never below 1', () => {
    expect(retryAfterSeconds(10_500, 10_000)).toBe(1);
    expect(retryAfterSeconds(10_000, 10_000)).toBe(1);
    expect(retryAfterSeconds(70_000, 10_001)).toBe(60);
  });
});

describe('merge body', () => {
  it('knows the choosable fields, the compliance fields and the custom pattern', () => {
    expect(isMergeFieldKey('ownerUserId')).toBe(true);
    expect(isMergeFieldKey('dnd')).toBe(false);
    expect(isComplianceKey('consentState')).toBe(true);
    expect(customChoiceKey('custom.tier__c')).toBe('tier__c');
    expect(customChoiceKey('custom.Tier__c')).toBeNull();
    expect(customChoiceKey('tier__c')).toBeNull();
  });

  it('accepts a well-formed body and refuses unknown keys, sides and extra properties', () => {
    const body = { survivorId: P1, mergedId: P2, survivorVersion: 1, mergedVersion: 2 };
    const ok = { ...body, choices: { status: 'merged', 'custom.tier__c': 'survivor' } };
    expect(CreateContactMergeBody.safeParse(ok).success).toBe(true);
    expect(CreateContactMergeBody.safeParse({ ...body, choices: { nope: 'merged' } }).success).toBe(
      false,
    );
    expect(CreateContactMergeBody.safeParse({ ...body, choices: { status: 'both' } }).success).toBe(
      false,
    );
    expect(CreateContactMergeBody.safeParse({ ...body, extra: 1 }).success).toBe(false);
    expect(CreateContactMergeBody.safeParse({ ...body, survivorVersion: 0 }).success).toBe(false);
  });
});
