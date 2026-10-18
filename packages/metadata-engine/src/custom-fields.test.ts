import { describe, expect, it } from 'vitest';
import {
  customFieldsSchema,
  customIssueDetails,
  customValueProblem,
  customWithheldAnywhere,
  isCustomFieldKey,
  jsonbTextOctets,
  notEditableCustomKeys,
  readableCustomKeys,
  readableCustomKeysByProgramme,
  splitCustomPatch,
  visibleCustomValues,
  withheldCustomKeys,
  type CustomFieldAccess,
  type CustomFieldDef,
} from './custom-fields';
import type { FieldAccessLevel } from './field-security';

// Invented ids, naming nothing real.
const P1 = '99999999-0000-4000-8000-0000000089a1';
const P2 = '99999999-0000-4000-8000-0000000089a2';
const ECHO = 'zqecho-unit-0089';

const def = (apiName: string, type: CustomFieldDef['type'], extra: Partial<CustomFieldDef> = {}): CustomFieldDef => ({
  id: `99999999-0000-4000-8000-${apiName.length.toString().padStart(12, '0')}`,
  apiName,
  type,
  classification: 'none',
  values: [],
  currencyCode: null,
  ...extra,
});

const DEFS: CustomFieldDef[] = [
  def('txt__c', 'text'),
  def('num__c', 'number'),
  def('amt__c', 'currency', { currencyCode: 'NGN' }),
  def('day__c', 'date'),
  def('tier__c', 'picklist', { values: ['gold', 'silver'] }),
  def('vip__c', 'boolean'),
];
const byName = (name: string) => {
  const found = DEFS.find((candidate) => candidate.apiName === name);
  if (found === undefined) throw new Error(name);
  return found;
};

describe('isCustomFieldKey (D-P24, D-L140)', () => {
  it('admits lower snake case ending in __c, within 63 characters', () => {
    for (const key of ['tier__c', 'a__c', 'b_2__c', `${'a'.repeat(60)}__c`]) expect(isCustomFieldKey(key), key).toBe(true);
  });

  it('refuses standard names, case, leading digits or underscores, spaces, newlines, non-ASCII and length', () => {
    for (const key of [
      'status',
      'Tier__c',
      'tier__C',
      '1tier__c',
      '_tier__c',
      'ti er__c',
      'tier__c\n',
      'ti\ner__c',
      'tír__c',
      '__c',
      'tier_c',
      '__proto__',
      'constructor',
      `${'a'.repeat(61)}__c`,
      '',
    ]) {
      expect(isCustomFieldKey(key), JSON.stringify(key)).toBe(false);
    }
    expect(isCustomFieldKey(42)).toBe(false);
  });
});

describe('customValueProblem: the six Phase 2 encodings (ADR-0016 item 4)', () => {
  const accepted: [string, unknown][] = [
    ['txt__c', 'x'.repeat(1000)],
    ['txt__c', 'Ẹ̀kọ́ àti ìlú 😀'],
    ['num__c', '0'],
    ['num__c', '-0.25'],
    ['num__c', '123456789012345678'],
    ['num__c', `0.${'0'.repeat(37)}1`],
    ['amt__c', { amountMinor: '-999999999999999999', currency: 'NGN' }],
    ['day__c', '2024-02-29'],
    ['tier__c', 'gold'],
    ['vip__c', false],
  ];
  it.each(accepted)('%s accepts %j', (key, value) => {
    expect(customValueProblem(byName(key), value)).toBeNull();
  });

  const refused: [string, unknown, string][] = [
    ['txt__c', '', 'invalid_value'],
    ['txt__c', 'x'.repeat(1001), 'invalid_value'],
    ['txt__c', 'line\nbreak', 'invalid_value'],
    ['txt__c', 'sep\u2028arator', 'invalid_value'],
    ['txt__c', 'nul\u0000', 'invalid_value'],
    ['num__c', 1.5, 'invalid_value'],
    ['num__c', '1.50', 'invalid_value'],
    ['num__c', '-0', 'invalid_value'],
    ['num__c', '1234567890123456789', 'invalid_value'],
    ['num__c', `0.${'0'.repeat(38)}1`, 'invalid_value'],
    ['amt__c', { amountMinor: 1500, currency: 'NGN' }, 'invalid_value'],
    ['amt__c', { amountMinor: '01', currency: 'NGN' }, 'invalid_value'],
    ['amt__c', { amountMinor: '1', currency: 'NGN', note: 'x' }, 'invalid_value'],
    ['amt__c', { amountMinor: '1', currency: 'GHS' }, 'currency_mismatch'],
    ['day__c', '2025-02-29', 'invalid_value'],
    ['day__c', '2026-01-01T00:00:00Z', 'invalid_value'],
    ['tier__c', 'diamond', 'unknown_value'],
    ['tier__c', 'Gold', 'invalid_value'],
    ['vip__c', 'true', 'invalid_value'],
  ];
  it.each(refused)('%s refuses %j as %s', (key, value, code) => {
    expect(customValueProblem(byName(key), value)?.code).toBe(code);
  });

  it('a currency mismatch is reported under the key, at .currency', () => {
    expect(customValueProblem(byName('amt__c'), { amountMinor: '1', currency: 'KES' })?.path).toEqual(['currency']);
  });
});

describe('customFieldsSchema: the per-(tenant, object) Zod builder (ADR-0016 item 3)', () => {
  const create = customFieldsSchema(DEFS, 'create');
  const patch = customFieldsSchema(DEFS, 'patch');
  const detailsOf = (schema: typeof create, input: unknown) => {
    const result = schema.safeParse(input);
    if (result.success) throw new Error('expected a refusal');
    return customIssueDetails(result.error);
  };

  it('accepts the six types and returns exactly what it was given', () => {
    const values = { txt__c: 'a', num__c: '1', amt__c: { amountMinor: '1', currency: 'NGN' }, day__c: '2026-02-28', tier__c: 'gold', vip__c: true };
    expect(create.parse(values)).toEqual(values);
  });

  it('is strict: an unknown or retired well-formed key is unknown_field at custom.<key>', () => {
    expect(detailsOf(create, { nope__c: 'x' })).toEqual([{ path: 'custom.nope__c', code: 'unknown_field' }]);
  });

  it('a malformed key is unknown_field at custom, and is never named (D-L140)', () => {
    for (const key of ['status', `Zq${ECHO}__c`, '__proto__', 'constructor', `${ECHO}__c\n`]) {
      const details = detailsOf(create, JSON.parse(`{${JSON.stringify(key)}: "x"}`) as unknown);
      expect(details, key).toEqual([{ path: 'custom', code: 'unknown_field' }]);
      expect(JSON.stringify(details)).not.toContain(ECHO);
    }
  });

  it('never echoes a received value, on any code', () => {
    const probes = [
      { txt__c: `${ECHO}\nx` },
      { num__c: ECHO },
      { amt__c: { amountMinor: ECHO, currency: 'NGN' } },
      { amt__c: { amountMinor: '1', currency: 'GHS', note: ECHO } },
      { tier__c: ECHO },
      { vip__c: ECHO },
    ];
    for (const probe of probes) {
      const details = detailsOf(create, probe);
      expect(details.length, JSON.stringify(probe)).toBeGreaterThan(0);
      expect(JSON.stringify(details)).not.toContain(ECHO);
      for (const detail of details) expect(Object.keys(detail).sort()).toEqual(['code', 'path']);
    }
  });

  it('create refuses null; patch reads null as "remove" and refuses an empty object', () => {
    expect(detailsOf(create, { txt__c: null })).toEqual([{ path: 'custom.txt__c', code: 'invalid_value' }]);
    expect(patch.parse({ txt__c: null, vip__c: true })).toEqual({ txt__c: null, vip__c: true });
    expect(detailsOf(patch, {})).toEqual([{ path: 'custom', code: 'nothing_to_update' }]);
    expect(create.parse({})).toEqual({});
  });

  it('refuses anything that is not a plain object', () => {
    for (const input of [null, [], 'x', 1]) {
      expect(detailsOf(patch, input), JSON.stringify(input)).toEqual([{ path: 'custom', code: 'invalid_type' }]);
    }
  });

  it('a currency mismatch is reported at custom.<key>.currency', () => {
    expect(detailsOf(create, { amt__c: { amountMinor: '1', currency: 'ZAR' } })).toEqual([
      { path: 'custom.amt__c.currency', code: 'currency_mismatch' },
    ]);
  });

  it('a schema built without a definition refuses its key: definitions are what the caller passes, never cached', () => {
    const without = customFieldsSchema(DEFS.filter((candidate) => candidate.apiName !== 'tier__c'), 'patch');
    expect(without.safeParse({ tier__c: 'gold' }).success).toBe(false);
    expect(patch.safeParse({ tier__c: 'gold' }).success).toBe(true);
  });
});

describe('splitCustomPatch and jsonbTextOctets', () => {
  it('splits a parsed patch into the merge halves: values set, nulls removed', () => {
    expect(splitCustomPatch({ a__c: 'x', b__c: null, c__c: undefined, d__c: false })).toEqual({
      set: { a__c: 'x', d__c: false },
      remove: ['b__c'],
    });
  });

  it('counts octets of the jsonb text form (a space after every colon and comma)', () => {
    expect(jsonbTextOctets({ a__c: 'x' })).toBe('{"a__c": "x"}'.length);
    expect(jsonbTextOctets({ a__c: '€', b__c: true })).toBe(Buffer.byteLength('{"a__c": "€", "b__c": true}'));
    expect(jsonbTextOctets({ p__c: { amountMinor: '1', currency: 'NGN' } })).toBe(
      '{"p__c": {"amountMinor": "1", "currency": "NGN"}}'.length,
    );
  });
});

describe('access questions and the second layer (ADR-0016 item 6)', () => {
  const levels = (entries: Record<string, FieldAccessLevel>) => new Map(Object.entries(entries));
  const access: CustomFieldAccess = {
    object: 'contact',
    defs: new Map(DEFS.map((candidate) => [candidate.apiName, candidate])),
    access: new Map([
      [P1, levels({ txt__c: 'none', num__c: 'read', amt__c: 'edit', day__c: 'edit', tier__c: 'edit', vip__c: 'edit' })],
      [P2, levels({ txt__c: 'edit', num__c: 'edit', amt__c: 'edit', day__c: 'edit', tier__c: 'edit', vip__c: 'edit' })],
    ]),
  };

  it('readable and withheld keys are per programme; an unknown programme reads nothing (fail closed)', () => {
    expect(withheldCustomKeys(access, P1)).toEqual(['txt__c']);
    expect(readableCustomKeys(access, P1)).not.toContain('txt__c');
    expect(readableCustomKeys(access, P2)).toContain('txt__c');
    expect(readableCustomKeys(access, 'not-a-programme')).toEqual([]);
    expect(withheldCustomKeys(access, 'not-a-programme')).toEqual([...DEFS.map((d) => d.apiName)].sort());
    expect(readableCustomKeysByProgramme(access, [P1])).toEqual({ [P1]: readableCustomKeys(access, P1) });
  });

  it('withheld anywhere: a key at none in any reachable programme', () => {
    expect(customWithheldAnywhere(access, 'txt__c')).toBe(true);
    expect(customWithheldAnywhere(access, 'tier__c')).toBe(false);
  });

  it('not editable: live keys below edit in the programme; unknown and malformed keys are left to the 400', () => {
    expect(notEditableCustomKeys(access, P1, ['txt__c', 'num__c', 'tier__c', 'nope__c', 'BAD'])).toEqual(['txt__c', 'num__c']);
    expect(notEditableCustomKeys(access, P2, ['txt__c', 'num__c'])).toEqual([]);
  });

  it('visibleCustomValues keeps only live readable keys, drops nulls, and survives a non-object', () => {
    const projected = { txt__c: 'withheld', num__c: '1', tier__c: null, old__c: 'retired', vip__c: true };
    expect(visibleCustomValues(access, P1, projected)).toEqual({ num__c: '1', vip__c: true });
    expect(visibleCustomValues(access, P1, null)).toEqual({});
    expect(visibleCustomValues(access, P1, ['txt__c'])).toEqual({});
  });
});
