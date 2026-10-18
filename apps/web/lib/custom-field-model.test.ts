import { describe, expect, it } from 'vitest';
import {
  VALUE_PATTERN,
  createDirty,
  fullState,
  deriveValues,
  isClassificationRaised,
  isValidApiName,
  suggestApiName,
  updateBody,
  type EditDraft,
} from './custom-field-model';
import type { CustomFieldDefinition } from './custom-fields-api';

const TIER: CustomFieldDefinition = {
  id: '11111111-0000-4000-8000-0000000c0001',
  objectApiName: 'contact',
  apiName: 'tier__c',
  label: 'Customer tier',
  description: null,
  type: 'picklist',
  classification: 'none',
  config: {
    values: [
      { value: 'gold', label: 'Gold' },
      { value: 'silver', label: 'Silver' },
    ],
  },
  retiredAt: null,
  createdAt: '2026-10-14T09:00:00.000Z',
  updatedAt: '2026-10-14T09:00:00.000Z',
};

const UNCHANGED: EditDraft = {
  label: 'Customer tier',
  description: '',
  classification: 'none',
  valueLabels: { gold: 'Gold', silver: 'Silver' },
  newLabels: ['', ''],
};

describe('isValidApiName (D-P24)', () => {
  it('accepts lower snake case ending in __c, 4 to 63 characters', () => {
    expect(isValidApiName('tier__c')).toBe(true);
    expect(isValidApiName('a__c')).toBe(true);
    expect(isValidApiName('_a__c')).toBe(false);
    expect(isValidApiName(`${'a'.repeat(60)}__c`)).toBe(true);
    expect(isValidApiName(`${'a'.repeat(61)}__c`)).toBe(false);
  });

  it.each(['Tier__c', 'tier', 'tier_c', '9tier__c', 'tier__C', 'ti er__c', '__c', 'tier__c ', ''])(
    'refuses %j',
    (bad) => {
      expect(isValidApiName(bad)).toBe(false);
    },
  );
});

describe('suggestApiName', () => {
  it('writes a name that obeys the rule, accents folded', () => {
    expect(suggestApiName('Sample renewal owner')).toBe('sample_renewal_owner__c');
    expect(suggestApiName('  Ọjọ́ ìbí / Date  ')).toBe('ojo_ibi_date__c');
    expect(isValidApiName(suggestApiName('Ọjọ́ ìbí / Date'))).toBe(true);
  });

  it('suggests nothing where the label gives nothing usable', () => {
    expect(suggestApiName('')).toBe('');
    expect(suggestApiName('ذهبي')).toBe('');
    expect(suggestApiName('9 lives')).toBe('');
    expect(suggestApiName('___')).toBe('');
  });

  it('keeps a long label inside the bound', () => {
    const long = suggestApiName('word '.repeat(40));
    expect(long.endsWith('__c')).toBe(true);
    expect([...long].length).toBeLessThanOrEqual(63);
    expect(isValidApiName(long)).toBe(true);
  });
});

describe('deriveValues', () => {
  it('derives a well-formed value from each label', () => {
    expect(deriveValues(['Gold plus', 'Silver', '2 weeks', 'A', 'ذهبي'])).toEqual([
      'gold_plus',
      'silver',
      'v_2_weeks',
      'v_a',
      'value_5',
    ]);
    for (const value of deriveValues(['Gold plus', 'Silver', '2 weeks', 'A', 'ذهبي'])) {
      expect(VALUE_PATTERN.test(value), value).toBe(true);
    }
  });

  it('keeps values unique, among themselves and against existing ones', () => {
    expect(deriveValues(['Gold', 'Gold', 'gold!'], ['gold'])).toEqual(['gold_2', 'gold_3', 'gold_4']);
  });

  it('never exceeds the pattern when a suffix is added to a long value', () => {
    const long = 'x'.repeat(70);
    const values = deriveValues([long, long]);
    expect(new Set(values).size).toBe(2);
    for (const value of values) expect(VALUE_PATTERN.test(value), value).toBe(true);
  });
});

describe('isClassificationRaised (D-L140)', () => {
  it('is true only when the level goes up', () => {
    expect(isClassificationRaised('none', 'pii')).toBe(true);
    expect(isClassificationRaised('none', 'sensitive')).toBe(true);
    expect(isClassificationRaised('pii', 'sensitive')).toBe(true);
    expect(isClassificationRaised('pii', 'none')).toBe(false);
    expect(isClassificationRaised('sensitive', 'pii')).toBe(false);
    expect(isClassificationRaised('pii', 'pii')).toBe(false);
  });
});

describe('updateBody sends only what changed', () => {
  it('is empty when nothing changed, blank new rows included', () => {
    expect(updateBody(TIER, UNCHANGED)).toEqual({});
  });

  it('sends a relabel alone', () => {
    expect(updateBody(TIER, { ...UNCHANGED, label: ' Service tier ' })).toEqual({ label: 'Service tier' });
  });

  it('sends a description, and null when it is cleared', () => {
    expect(updateBody(TIER, { ...UNCHANGED, description: 'A synthetic description.' })).toEqual({
      description: 'A synthetic description.',
    });
    const described = { ...TIER, description: 'Old' };
    expect(updateBody(described, { ...UNCHANGED, description: '  ' })).toEqual({ description: null });
  });

  it('sends a classification alone, up or down', () => {
    expect(updateBody(TIER, { ...UNCHANGED, classification: 'sensitive' })).toEqual({ classification: 'sensitive' });
    const pii = { ...TIER, classification: 'pii' as const };
    expect(updateBody(pii, { ...UNCHANGED, classification: 'none' })).toEqual({ classification: 'none' });
  });

  it('relabels only the values whose label changed, by value', () => {
    expect(updateBody(TIER, { ...UNCHANGED, valueLabels: { gold: 'Gold plus', silver: 'Silver' } })).toEqual({
      relabelValues: [{ value: 'gold', label: 'Gold plus' }],
    });
  });

  it('adds values with derived, unique, well-formed values and never removes one', () => {
    const body = updateBody(TIER, { ...UNCHANGED, newLabels: ['Bronze', '', 'Gold'] });
    expect(body).toEqual({
      addValues: [
        { value: 'bronze', label: 'Bronze' },
        { value: 'gold_2', label: 'Gold' },
      ],
    });
    expect(Object.keys(body)).not.toContain('removeValues');
  });

  it('ignores picklist drafts for a field that is not a picklist', () => {
    const text = { ...TIER, type: 'text' as const, config: {} };
    expect(updateBody(text, { ...UNCHANGED, newLabels: ['Bronze'], valueLabels: { gold: 'x' } })).toEqual({});
  });
});

describe('updateBody trims both sides', () => {
  it('sends nothing for a stored value that carries spaces the draft lost', () => {
    const padded = { ...TIER, label: ' Customer tier ', description: ' note ', config: { values: [{ value: 'gold', label: ' Gold ' }] } };
    expect(updateBody(padded, { label: 'Customer tier', description: 'note', classification: 'none', valueLabels: { gold: 'Gold' }, newLabels: [] })).toEqual({});
  });
});

describe('fullState', () => {
  const limits = { fieldsPerObject: 3, definitionsPerObject: 5 };
  const row = (n: number, retired: boolean) => ({ ...TIER, id: String(n), apiName: `f${n}__c`, retiredAt: retired ? '2026-10-18T09:00:00.000Z' : null });
  it('is open below both limits', () => {
    expect(fullState([row(1, false), row(2, true)], limits)).toBe('open');
  });
  it('is full by fields when the active limit is reached, and retiring makes room', () => {
    expect(fullState([row(1, false), row(2, false), row(3, false)], limits)).toBe('fields');
  });
  it('is full by definitions when retired fields fill them, whatever the active count', () => {
    expect(fullState([row(1, false), row(2, true), row(3, true), row(4, true), row(5, true)], limits)).toBe('definitions');
  });
});

describe('createDirty', () => {
  const clean = { label: '', apiName: '', type: 'text', classification: 'none' as const, description: '', currency: '', newLabels: [''] };
  it('is clean for an untouched form', () => {
    expect(createDirty(clean)).toBe(false);
  });
  it.each([
    { label: 'x' },
    { apiName: 'a__c' },
    { type: 'picklist' },
    { classification: 'pii' as const },
    { description: 'd' },
    { currency: 'NGN' },
    { newLabels: ['', 'Gold'] },
  ])('is dirty once %j changes', (change) => {
    expect(createDirty({ ...clean, ...change })).toBe(true);
  });
});
