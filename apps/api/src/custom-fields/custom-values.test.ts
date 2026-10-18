import type { TenantTx } from '@kasuwa/db';
import type { CustomFieldAccess, CustomFieldDef, FieldAccessLevel } from '@kasuwa/metadata-engine';
import { STANDARD_OBJECT_CATALOGUE } from '@kasuwa/db';
import {
  WITHHOLDABLE_ACCOUNT_FIELDS,
  WITHHOLDABLE_ACTIVITY_FIELDS,
  WITHHOLDABLE_CONTACT_FIELDS,
  WITHHOLDABLE_DEAL_FIELDS,
} from '@kasuwa/domain-core';
import { isCustomFieldKey } from '@kasuwa/metadata-engine';
import { describe, expect, it } from 'vitest';
import { AdminError } from '../admin/common/admin-errors';
import { change } from '../admin/audit/audit-writer';
import { CONTACT_AUDIT_VALUE_FIELDS } from '../contacts/contact-audit';
import {
  customBackstopAs400,
  customFiltersFrom,
  customNotEditablePaths,
  isCustomBackstopRefusal,
  customPatchKeys,
  customWireOf,
  customWriteTooLarge,
  parseCustomCreate,
  parseCustomPatch,
  recordAuditWithCustom,
} from './custom-values';

// Invented ids, naming nothing real.
const TENANT = '99999999-0000-4000-8000-0000000089c0';
const USER = '99999999-0000-4000-8000-0000000089c1';
const P1 = '99999999-0000-4000-8000-0000000089c2';
const P2 = '99999999-0000-4000-8000-0000000089c3';
const ECHO = 'zqecho-api-0089';

const def = (apiName: string, type: CustomFieldDef['type'], values: string[] = []): CustomFieldDef => ({
  id: '99999999-0000-4000-8000-0000000089cf',
  apiName,
  type,
  classification: 'none',
  values,
  currencyCode: null,
});

const levels = (entries: Record<string, FieldAccessLevel>) => new Map(Object.entries(entries));
const CUSTOM: CustomFieldAccess = {
  object: 'contact',
  retired: ['old__c'],
  defs: new Map(
    [
      def('tier__c', 'picklist', ['gold', 'silver']),
      def('vip__c', 'boolean'),
      def('txt__c', 'text'),
      def('band__c', 'picklist', ['red']),
      def('big__c', 'text'),
    ].map((entry) => [entry.apiName, entry]),
  ),
  access: new Map([
    [P1, levels({ tier__c: 'edit', vip__c: 'edit', txt__c: 'edit', band__c: 'none', big__c: 'edit' })],
    [P2, levels({ tier__c: 'edit', vip__c: 'read', txt__c: 'edit', band__c: 'read', big__c: 'edit' })],
  ]),
};

function refusal(fn: () => unknown): { status: number; body: { details?: { path: string; code: string }[] } } {
  try {
    fn();
  } catch (error) {
    if (error instanceof AdminError) {
      return { status: error.getStatus(), body: error.getResponse() as { details?: { path: string; code: string }[] } };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('customFiltersFrom (records.openapi.yaml CustomFilter, CustomEmptyFilter)', () => {
  it('reads both query parser shapes, AND-ing equality and is-empty', () => {
    // D-L142: the SQL filters on the projected custom, with the read's readable lists.
    const readable = {
      [P1]: ['big__c', 'tier__c', 'txt__c', 'vip__c'],
      [P2]: ['band__c', 'big__c', 'tier__c', 'txt__c', 'vip__c'],
    };
    expect(customFiltersFrom(CUSTOM, { 'custom[tier__c]': 'gold', 'custom[vip__c]': 'false' })).toEqual({
      equals: [
        { key: 'tier__c', value: 'gold' },
        { key: 'vip__c', value: false },
      ],
      empty: [],
      readable,
    });
    expect(customFiltersFrom(CUSTOM, { custom: { tier__c: 'silver' }, customEmpty: ['vip__c', 'vip__c'] })).toEqual({
      equals: [{ key: 'tier__c', value: 'silver' }],
      empty: ['vip__c'],
      readable,
    });
    expect(customFiltersFrom(CUSTOM, { q: 'x' })).toBeUndefined();
  });

  it('refuses with the contract codes, at custom.<key>', () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ 'custom[nope__c]': 'x' }, 'custom.nope__c', 'unknown_field'],
      [{ customEmpty: 'nope__c' }, 'custom.nope__c', 'unknown_field'],
      [{ 'custom[band__c]': 'red' }, 'custom.band__c', 'field_withheld'],
      [{ customEmpty: 'band__c' }, 'custom.band__c', 'field_withheld'],
      [{ 'custom[txt__c]': 'abc' }, 'custom.txt__c', 'filter_not_supported'],
      [{ customEmpty: 'txt__c' }, 'custom.txt__c', 'filter_not_supported'],
      [{ 'custom[tier__c]': 'diamond' }, 'custom.tier__c', 'unknown_value'],
      [{ 'custom[tier__c]': 'Gold' }, 'custom.tier__c', 'invalid_value'],
      [{ 'custom[tier__c]': ['gold', 'silver'] }, 'custom.tier__c', 'invalid_value'],
      [{ 'custom[vip__c]': 'yes' }, 'custom.vip__c', 'invalid_value'],
    ];
    for (const [query, path, code] of cases) {
      const answer = refusal(() => customFiltersFrom(CUSTOM, query));
      expect(answer.status, JSON.stringify(query)).toBe(400);
      expect(answer.body.details, JSON.stringify(query)).toContainEqual({ path, code });
    }
  });

  it('a malformed key is unknown_field at the parameter, never echoed (D-L140)', () => {
    for (const [query, path] of [
      [{ [`custom[Zq${ECHO}__c]`]: 'x' }, 'custom'],
      [{ [`custom[${ECHO}__c\n]`]: 'x' }, 'custom'],
      [{ customEmpty: `${ECHO} x__c` }, 'customEmpty'],
      [{ custom: 'tier__c' }, 'custom'],
    ] as const) {
      const answer = refusal(() => customFiltersFrom(CUSTOM, query));
      expect(answer.body.details).toEqual([{ path, code: 'unknown_field' }]);
      expect(JSON.stringify(answer.body)).not.toContain(ECHO);
    }
  });

  it('withheld anywhere: band__c is readable in P2 and still refused, because it is none in P1', () => {
    const onlyP2: CustomFieldAccess = { ...CUSTOM, access: new Map([[P2, CUSTOM.access.get(P2) ?? new Map()]]) };
    expect(customFiltersFrom(onlyP2, { 'custom[band__c]': 'red' })).toMatchObject({ equals: [{ key: 'band__c', value: 'red' }], empty: [] });
    expect(refusal(() => customFiltersFrom(CUSTOM, { 'custom[band__c]': 'red' })).body.details).toEqual([
      { path: 'custom.band__c', code: 'field_withheld' },
    ]);
  });
});

describe('writes: 403 paths, parsing, size and audit (D-L140, D-L141)', () => {
  it('names custom.<key> for live keys below edit in the row programme, value or null', () => {
    expect(customNotEditablePaths(CUSTOM, P2, { custom: { vip__c: null, band__c: 'red', tier__c: 'gold', nope__c: 1 } })).toEqual([
      'custom.vip__c',
      'custom.band__c',
    ]);
    expect(customNotEditablePaths(CUSTOM, P1, { custom: 'not an object' })).toEqual([]);
  });

  it('a create is refused for size on its own values; a patch splits into set and remove', () => {
    expect(parseCustomCreate(CUSTOM, undefined)).toEqual({});
    expect(parseCustomCreate(CUSTOM, { tier__c: 'gold' })).toEqual({ tier__c: 'gold' });
    const huge = { txt__c: '€'.repeat(1000), big__c: '€'.repeat(1000) };
    expect(parseCustomCreate(CUSTOM, huge)).toEqual(huge); // about 6 KB
    const answer = refusal(() =>
      parseCustomCreate(
        { ...CUSTOM, defs: new Map([...CUSTOM.defs, ...['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [`${k}__c`, def(`${k}__c`, 'text')] as const)]) },
        Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [`${k}__c`, '€'.repeat(1000)])),
      ),
    );
    expect(answer.body.details).toEqual([{ path: 'custom', code: 'custom_too_large' }]);
    expect(parseCustomPatch(CUSTOM, undefined)).toBeUndefined();
    // D-L142: every custom write also drops the object's retired keys.
    expect(parseCustomPatch(CUSTOM, { tier__c: null, vip__c: true })).toEqual({
      set: { vip__c: true },
      remove: ['tier__c'],
      drop: ['old__c'],
    });
    expect(customPatchKeys({ set: { vip__c: true }, remove: ['tier__c'] })).toEqual(['tier__c', 'vip__c']);
  });

  it('maps the size backstop (23514 on <table>_custom_size) to 400 custom_too_large, and nothing else', async () => {
    const backstop = Object.assign(new Error('x'), { code: '23514', constraint: 'deal_custom_size' });
    await expect(
      customBackstopAs400(() => Promise.reject(backstop)),
    ).rejects.toMatchObject({ response: { code: 'validation_failed', details: [{ path: 'custom', code: 'custom_too_large' }] } });
    expect(isCustomBackstopRefusal(backstop)).toBe(true);
    for (const other of [
      { code: '23514', constraint: 'contact_custom_keys' },
      { code: '23514', constraint: 'account_hierarchy' },
      { code: '23505', constraint: 'deal_custom_size' },
      null,
    ]) {
      expect(isCustomBackstopRefusal(other), JSON.stringify(other)).toBe(false);
    }
    const unrelated = Object.assign(new Error('y'), { code: '23514', constraint: 'contact_custom_keys' });
    await expect(customBackstopAs400(() => Promise.reject(unrelated))).rejects.toBe(unrelated);
    expect(await customBackstopAs400(() => Promise.resolve(7))).toBe(7);
  });

  it('refuses for size only when the visible size passes 16 KiB AND the write grows it', () => {
    expect(customWriteTooLarge({ before: 100, after: 16_384 })).toBe(false);
    expect(customWriteTooLarge({ before: 100, after: 16_385 })).toBe(true);
    expect(customWriteTooLarge({ before: 19_000, after: 19_000 })).toBe(false); // same size
    expect(customWriteTooLarge({ before: 19_000, after: 18_000 })).toBe(false); // a shrink
    expect(customWriteTooLarge({ before: 19_000, after: 19_001 })).toBe(true);
  });

  it('audits custom keys by name only, and continues a long event rather than refuse the write', async () => {
    const calls: unknown[][] = [];
    const tx: TenantTx = {
      session: { tenantId: TENANT, userId: USER, programmeIds: [P1] },
      query: <T>(_text: string, values: readonly unknown[] = []) => {
        calls.push([...values]);
        return Promise.resolve([] as T[]);
      },
    };
    const event = {
      action: 'updated' as const,
      objectType: 'contact' as const,
      objectId: P1,
      objectLabel: P1,
      programmeId: P1,
      changes: [change('status', 'new', 'contacted')],
    };
    await recordAuditWithCustom(tx, event, ['tier__c']);
    expect(calls).toHaveLength(1);
    const changes = JSON.parse(String(calls[0]?.[8])) as { field: string; before: unknown; after: unknown; redacted: boolean }[];
    expect(changes).toEqual([
      { field: 'status', before: 'new', after: 'contacted', redacted: false },
      { field: 'tier__c', before: null, after: null, redacted: true },
    ]);
    calls.length = 0;
    await recordAuditWithCustom(tx, event, Array.from({ length: 100 }, (_, i) => `k${i}__c`));
    expect(calls).toHaveLength(2);
  });
});

describe('customWireOf (the second layer, V1, V2)', () => {
  it('serves readable live keys and lists every withheld live key, value or none', () => {
    expect(customWireOf(CUSTOM, P1, { tier__c: 'gold', band__c: 'red', old__c: 'retired' })).toEqual({
      custom: { tier__c: 'gold' },
      withheld: ['custom.band__c'],
    });
    expect(customWireOf(CUSTOM, P1, {})).toEqual({ custom: {}, withheld: ['custom.band__c'] });
  });
});

describe('standard field names are never custom keys (D-L142)', () => {
  it('no standard field of any object, by api name or wire name, passes isCustomFieldKey', () => {
    const names = [
      ...STANDARD_OBJECT_CATALOGUE.flatMap((object) => object.fields.map((field) => field.apiName)),
      ...WITHHOLDABLE_CONTACT_FIELDS,
      ...WITHHOLDABLE_ACCOUNT_FIELDS,
      ...WITHHOLDABLE_ACTIVITY_FIELDS,
      ...WITHHOLDABLE_DEAL_FIELDS,
      ...CONTACT_AUDIT_VALUE_FIELDS,
    ];
    // Not vacuous: every standard object contributes.
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((name) => isCustomFieldKey(name))).toEqual([]);
  });
});
