import { describe, expect, it } from 'vitest';
import type { CustomField } from './custom-values-api';
import {
  IS_EMPTY,
  appendCustomFilters,
  canonicalNumber,
  customErrorId,
  customPatch,
  customValues,
  describeCustom,
  draftOfCustom,
  majorToMinor,
  minorToMajor,
  notEditableKeys,
  rebaseCustomDraft,
  resetKeys,
  minorDigits,
  setCustomFilter,
} from './custom-values-model';

const field = (over: Partial<CustomField> & Pick<CustomField, 'apiName' | 'type'>): CustomField => ({
  label: over.apiName,
  values: [],
  currency: null,
  ...over,
});

const TIER = field({
  apiName: 'tier__c',
  type: 'picklist',
  values: [
    { value: 'gold', label: 'Gold' },
    { value: 'silver', label: 'Silver' },
  ],
});
const VIP = field({ apiName: 'vip__c', type: 'boolean' });
const LIMIT = field({ apiName: 'credit_limit__c', type: 'currency', currency: 'NGN' });
const SCORE = field({ apiName: 'score__c', type: 'number' });
const DUE = field({ apiName: 'due__c', type: 'date' });
const NOTE = field({ apiName: 'note__c', type: 'text' });
const ALL = [TIER, VIP, LIMIT, SCORE, DUE, NOTE];

describe('amounts and decimals stay text', () => {
  it('moves the point in the string, never through a float', () => {
    expect(minorToMajor('125000050')).toBe('1250000.50');
    expect(minorToMajor('5')).toBe('0.05');
    expect(minorToMajor('-123456789012345678')).toBe('-1234567890123456.78');
    expect(minorToMajor('1.5')).toBeNull();
    expect(majorToMinor('2500000.75')).toBe('250000075');
    expect(majorToMinor('1000')).toBe('100000');
    expect(majorToMinor('-12.5')).toBe('-1250');
    expect(majorToMinor('0.00')).toBe('0');
    expect(majorToMinor('-0')).toBe('0');
    expect(majorToMinor('1.234')).toBeNull();
    expect(majorToMinor('9007199254740993.99')).toBe('900719925474099399');
    expect(majorToMinor('10000000000000000.00')).toBeNull();
  });

  it('writes the number in the contract canonical form', () => {
    expect(canonicalNumber('12.50')).toBe('12.5');
    expect(canonicalNumber('007')).toBe('7');
    expect(canonicalNumber('.5')).toBe('0.5');
    expect(canonicalNumber('-0.0')).toBe('0');
    expect(canonicalNumber('123456789012345.678')).toBe('123456789012345.678');
    expect(canonicalNumber('1234567890123456789')).toBeNull();
    expect(canonicalNumber('abc')).toBeNull();
    expect(canonicalNumber('-')).toBeNull();
  });
});

describe('describeCustom', () => {
  it('shows labels, never stored values, and formats by the field and the locale', () => {
    expect(describeCustom(TIER, 'gold', 'en')).toEqual({ kind: 'text', text: 'Gold' });
    expect(describeCustom(VIP, true, 'en')).toEqual({ kind: 'boolean', value: true });
    expect(describeCustom(LIMIT, { amountMinor: '125000050', currency: 'NGN' }, 'en')).toEqual({
      kind: 'text',
      text: new Intl.NumberFormat('en', { style: 'currency', currency: 'NGN' }).format(1250000.5),
    });
    expect(describeCustom(DUE, '2027-03-01', 'en')).toEqual({
      kind: 'date',
      iso: '2027-03-01',
      text: new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(Date.UTC(2027, 2, 1)),
    });
  });

  it('keeps every digit of an 18-digit amount', () => {
    const view = describeCustom(LIMIT, { amountMinor: '900719925474099312', currency: 'NGN' }, 'en');
    expect(view.kind === 'text' ? view.text.replace(/\D/g, '') : '').toBe('900719925474099312');
  });

  it('draws nothing for a value its definition does not describe', () => {
    expect(describeCustom(TIER, 'platinum', 'en')).toEqual({ kind: 'empty' });
    expect(describeCustom(VIP, 'true', 'en')).toEqual({ kind: 'empty' });
    expect(describeCustom(DUE, '2027-3-1', 'en')).toEqual({ kind: 'empty' });
    expect(describeCustom(LIMIT, { amountMinor: 1, currency: 'NGN' }, 'en')).toEqual({ kind: 'empty' });
    expect(describeCustom(NOTE, undefined, 'en')).toEqual({ kind: 'empty' });
  });
});

describe('customPatch: a per-key merge of only what changed', () => {
  const served = { tier__c: 'gold', vip__c: true, credit_limit__c: { amountMinor: '125000050', currency: 'NGN' } };
  const none = new Set<string>();

  it('sends nothing for an untouched form', () => {
    expect(customPatch(ALL, served, draftOfCustom(ALL, served), none)).toEqual({ patch: null, invalid: [] });
  });

  it('sets, clears and encodes by type', () => {
    const draft = {
      ...draftOfCustom(ALL, served),
      tier__c: 'silver',
      vip__c: '',
      credit_limit__c: '2500000.75',
      score__c: '12.50',
      due__c: '2027-04-15',
      note__c: ' Calls after 4pm ',
    };
    expect(customPatch(ALL, served, draft, none).patch).toEqual({
      tier__c: 'silver',
      vip__c: null,
      credit_limit__c: { amountMinor: '250000075', currency: 'NGN' },
      score__c: '12.5',
      due__c: '2027-04-15',
      note__c: 'Calls after 4pm',
    });
  });

  it('never clears a key that has no value, and never sends a skipped key', () => {
    const draft = { ...draftOfCustom(ALL, served), score__c: '', vip__c: 'false' };
    expect(customPatch(ALL, served, draft, new Set(['vip__c'])).patch).toBeNull();
  });

  it('reports a typed value that is not a value of its type', () => {
    const draft = { ...draftOfCustom(ALL, served), score__c: 'abc', credit_limit__c: '1.234' };
    expect(customPatch(ALL, served, draft, none)).toEqual({ patch: null, invalid: ['credit_limit__c', 'score__c'] });
  });
});

describe('customValues: a create carries filled values only', () => {
  it('leaves out empty keys and never sends null', () => {
    const draft = { tier__c: 'gold', vip__c: '', note__c: '  ' };
    expect(customValues(ALL, draft, new Set()).patch).toEqual({ tier__c: 'gold' });
    expect(customValues(ALL, {}, new Set()).patch).toBeNull();
  });
});

describe('rebaseCustomDraft', () => {
  it('takes the fresh value for an untouched key and keeps what was typed', () => {
    const typed = { tier__c: 'silver', vip__c: 'true', credit_limit__c: '', score__c: '', due__c: '', note__c: '' };
    const rebased = rebaseCustomDraft(ALL, { tier__c: 'gold', vip__c: true }, { tier__c: 'gold', vip__c: false, note__c: 'x' }, typed);
    expect(rebased.tier__c).toBe('silver');
    expect(rebased.vip__c).toBe('false');
    expect(rebased.note__c).toBe('x');
  });
});

describe('refusals', () => {
  it('names the translated message for a custom refusal and never a standard field', () => {
    expect(customErrorId({ details: [{ path: 'custom.tier__c', code: 'unknown_value' }] })).toBe('custom.error.invalid_value');
    expect(customErrorId({ details: [{ path: 'custom', code: 'custom_too_large' }] })).toBe('custom.error.custom_too_large');
    expect(customErrorId({ details: [{ path: 'custom', code: 'unknown_field' }] })).toBe('custom.error.unknown_field');
    expect(customErrorId({ details: [{ path: 'custom.vip__c', code: 'field_not_editable' }] })).toBe('custom.error.field_not_editable');
    expect(customErrorId({ details: [{ path: 'custom.vip__c', code: 'field_withheld' }] })).toBe('custom.error.withheld_write');
    expect(customErrorId({ details: [{ path: 'name', code: 'invalid_value' }] })).toBeNull();
    expect(customErrorId(null)).toBeNull();
  });

  it('learns which keys are read-only from field_not_editable alone', () => {
    expect(
      notEditableKeys({
        details: [
          { path: 'custom.vip__c', code: 'field_not_editable' },
          { path: 'custom.tier__c', code: 'invalid_value' },
          { path: 'name', code: 'field_not_editable' },
        ],
      }),
    ).toEqual(['vip__c']);
  });
});

describe('list filters', () => {
  it('builds custom[key] and customEmpty, one value per key', () => {
    let filters = setCustomFilter({}, 'tier__c', 'gold');
    filters = setCustomFilter(filters, 'vip__c', IS_EMPTY);
    const params = new URLSearchParams();
    appendCustomFilters(params, filters);
    expect(params.get('custom[tier__c]')).toBe('gold');
    expect(params.getAll('customEmpty')).toEqual(['vip__c']);
    expect(params.has('custom[vip__c]')).toBe(false);
    expect(setCustomFilter(filters, 'tier__c', IS_EMPTY).tier__c).toBe(IS_EMPTY);
    expect(setCustomFilter(filters, 'tier__c', '')).not.toHaveProperty('tier__c');
  });
});

describe('separators follow the page locale (M1)', () => {
  it('refuses grouping and a stray comma under en', () => {
    for (const typed of ['1,000', '12,345', '1,5', '1,000.50']) {
      expect(canonicalNumber(typed, 'en'), typed).toBeNull();
      expect(majorToMinor(typed, 2, 'en'), typed).toBeNull();
    }
    expect(canonicalNumber('1.000', 'en')).toBe('1');
  });

  it('takes a comma as the decimal only where the locale has one', () => {
    expect(canonicalNumber('12,50', 'fr')).toBe('12.5');
    expect(majorToMinor('12,5', 2, 'fr')).toBe('1250');
    expect(canonicalNumber('1,2,3', 'fr')).toBeNull();
    expect(canonicalNumber('1,000.5', 'fr')).toBeNull();
    expect(canonicalNumber('12.5', 'fr')).toBe('12.5');
  });
});

describe('a missing key is untouched, only an explicit empty clears (D1)', () => {
  const served = { tier__c: 'gold', note__c: 'hello' };
  it('sends nothing for a key the draft does not hold', () => {
    expect(customPatch(ALL, served, {}, new Set()).patch).toBeNull();
    expect(customPatch(ALL, served, { tier__c: '' }, new Set()).patch).toEqual({ tier__c: null });
  });
  it('a create ignores a missing key as it does an empty one', () => {
    expect(customValues(ALL, { note__c: 'x' }, new Set()).patch).toEqual({ note__c: 'x' });
  });
});

describe('only what changed is validated, and sizes count what they should (D3)', () => {
  it('an unparseable saved value never blocks a save of another key', () => {
    const served = { score__c: 'not a number', tier__c: 'gold' };
    const draft = { ...draftOfCustom(ALL, served), tier__c: 'silver' };
    expect(customPatch(ALL, served, draft, new Set())).toEqual({ patch: { tier__c: 'silver' }, invalid: [] });
  });
  it('counts a text in code points, not UTF-16 units', () => {
    const thousand = '😀'.repeat(1000);
    expect(customValues([NOTE], { note__c: thousand }, new Set()).invalid).toEqual([]);
    expect(customValues([NOTE], { note__c: `${thousand}x` }, new Set()).invalid).toEqual(['note__c']);
  });
  it('counts significant digits only: leading fractional zeros are free', () => {
    expect(canonicalNumber('0.0000000000000000000012')).toBe('0.0000000000000000000012');
    expect(canonicalNumber('0.1234567890123456789')).toBeNull();
    expect(canonicalNumber('0.123456789012345678')).toBe('0.123456789012345678');
  });
});

describe('currency digits come from Intl, dates must round-trip, a read-only key resets', () => {
  it('knows the minor digits of a currency', () => {
    expect(minorDigits('NGN')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(minorToMajor('1250', 0)).toBe('1250');
    expect(majorToMinor('1250', 0)).toBe('1250');
    expect(majorToMinor('12.5', 0)).toBeNull();
  });
  it('shows an impossible date as empty', () => {
    expect(describeCustom(DUE, '2027-02-30', 'en')).toEqual({ kind: 'empty' });
    expect(describeCustom(DUE, '2027-13-01', 'en')).toEqual({ kind: 'empty' });
  });
  it('puts a key told read-only back to the saved value', () => {
    const served = { tier__c: 'gold' };
    const typed = { ...draftOfCustom(ALL, served), tier__c: 'silver', note__c: 'x' };
    const reset = resetKeys(ALL, served, typed, ['tier__c']);
    expect(reset.tier__c).toBe('gold');
    expect(reset.note__c).toBe('x');
  });
});
