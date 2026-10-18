import type { CustomFieldDefinition } from '@kasuwa/metadata-engine';
import { describe, expect, it } from 'vitest';
import {
  createConfig,
  CreateCustomFieldBody,
  ListCustomFieldsQuery,
  planValues,
  toCustomFieldDefinitionWire,
  UpdateCustomFieldBody,
} from './custom-fields.schemas';

const values = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ value: `v${String(i + from).padStart(4, '0')}`, label: `Value ${i + from}` }));

const tier: CustomFieldDefinition = {
  id: '99999999-0000-4000-8000-0000000089d0',
  objectApiName: 'contact',
  apiName: 'tier__c',
  label: 'Tier',
  description: null,
  type: 'picklist',
  classification: 'none',
  config: { values: [{ value: 'gold', label: 'Gold' }] },
  retiredAt: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-02T00:00:00.000Z'),
};

describe('CreateCustomFieldBody and createConfig (admin.openapi.yaml, A2, D-L141)', () => {
  it('is closed, names refusals by reason and defaults the classification to none', () => {
    const parsed = CreateCustomFieldBody.parse({ objectApiName: 'deal', apiName: 'a__c', label: 'A', type: 'text' });
    expect(parsed.classification).toBe('none');
    for (const extra of [{ isRequired: false }, { programmeId: tier.id }, { retiredAt: null }]) {
      expect(CreateCustomFieldBody.safeParse({ objectApiName: 'deal', apiName: 'a__c', label: 'A', type: 'text', ...extra }).success).toBe(false);
    }
    const bad = CreateCustomFieldBody.safeParse({ objectApiName: 'deal', apiName: 'NoSuffix', label: 'A', type: 'textarea' });
    expect(bad.success).toBe(false);
    const reasons = bad.success ? [] : bad.error.issues.map((issue) => (issue.code === 'custom' ? issue.params?.['reason'] : issue.code));
    expect(reasons.sort()).toEqual(['invalid_api_name', 'unsupported_type']);
  });

  it('judges config against the type', () => {
    expect(createConfig('picklist', { values: values(2) })).toEqual({ ok: true, config: { values: values(2) } });
    expect(createConfig('currency', { currencyCode: 'GHS' })).toEqual({ ok: true, config: { currencyCode: 'GHS' } });
    expect(createConfig('text', undefined)).toEqual({ ok: true, config: {} });
    expect(createConfig('boolean', {})).toEqual({ ok: true, config: {} });
    const refusals: [Parameters<typeof createConfig>, string, string][] = [
      [['picklist', undefined], 'config', 'invalid_config'],
      [['picklist', { values: [] }], 'config.values', 'invalid_config'],
      [['picklist', { values: values(501) }], 'config.values', 'invalid_config'],
      [['picklist', { values: [{ value: 'a1', label: 'A' }, { value: 'a1', label: 'B' }] }], 'config.values', 'duplicate_value'],
      [['currency', undefined], 'config', 'invalid_config'],
      [['currency', { currencyCode: 'USD' }], 'config.currencyCode', 'unknown_currency'],
      [['currency', { currencyCode: 'ngn' }], 'config.currencyCode', 'invalid_config'],
      [['currency', { values: values(1) }], 'config', 'invalid_config'],
      [['text', { values: values(1) }], 'config', 'invalid_config'],
      [['boolean', { currencyCode: 'NGN' }], 'config', 'invalid_config'],
    ];
    for (const [args, path, code] of refusals) {
      expect(createConfig(...args), JSON.stringify(args).slice(0, 80)).toEqual({ ok: false, details: [{ path, code }] });
    }
  });
});

describe('UpdateCustomFieldBody and planValues (D-L139, D-L141)', () => {
  it('is closed and non-empty', () => {
    for (const body of [{}, { type: 'number' }, { config: {} }, { removeValues: ['gold'] }, { apiName: 'x__c' }]) {
      expect(UpdateCustomFieldBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(UpdateCustomFieldBody.parse({ classification: 'pii' })).toEqual({ classification: 'pii' });
  });

  it('appends values in order and relabels by value', () => {
    const plan = planValues(tier, {
      addValues: [{ value: 'silver', label: 'Silver' }],
      relabelValues: [{ value: 'gold', label: 'Gold plus' }],
    });
    expect(plan).toEqual({
      kind: 'changed',
      config: { values: [{ value: 'gold', label: 'Gold plus' }, { value: 'silver', label: 'Silver' }] },
      added: ['silver'],
      relabelled: ['gold'],
    });
    expect(planValues(tier, { label: 'x' })).toEqual({ kind: 'unchanged' });
  });

  it('refuses at the contract paths, and reports the 500-value limit separately (409)', () => {
    expect(planValues({ ...tier, type: 'text', config: {} }, { relabelValues: [{ value: 'a1', label: 'A' }] })).toEqual({
      kind: 'invalid',
      details: [{ path: 'addValues', code: 'not_a_picklist' }],
    });
    expect(planValues(tier, { relabelValues: [{ value: 'nope', label: 'N' }] })).toEqual({
      kind: 'invalid',
      details: [{ path: 'relabelValues', code: 'unknown_value' }],
    });
    expect(planValues(tier, { addValues: [{ value: 'gold', label: 'G' }] })).toEqual({
      kind: 'invalid',
      details: [{ path: 'addValues', code: 'duplicate_value' }],
    });
    expect(planValues(tier, { addValues: [{ value: 'iron', label: 'I' }, { value: 'iron', label: 'I2' }] })).toEqual({
      kind: 'invalid',
      details: [{ path: 'addValues', code: 'duplicate_value' }],
    });
    const full = { ...tier, config: { values: values(499) } };
    expect(planValues(full, { addValues: values(2, 600) })).toEqual({ kind: 'limit_reached' });
    expect(planValues(full, { addValues: values(1, 600) }).kind).toBe('changed');
  });
});

describe('the wire and the list query', () => {
  it('serves the contract definition: no value, no count, config by type, UTC times', () => {
    expect(toCustomFieldDefinitionWire({ ...tier, retiredAt: new Date('2026-10-03T00:00:00.000Z') })).toEqual({
      id: tier.id,
      objectApiName: 'contact',
      apiName: 'tier__c',
      label: 'Tier',
      description: null,
      type: 'picklist',
      classification: 'none',
      config: { values: [{ value: 'gold', label: 'Gold' }] },
      retiredAt: '2026-10-03T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(toCustomFieldDefinitionWire({ ...tier, type: 'date', config: { stray: true } }).config).toEqual({});
  });

  it('takes one of the four objects and an optional includeRetired; lead is not an alias', () => {
    expect(ListCustomFieldsQuery.parse({ object: 'deal', includeRetired: 'true' })).toEqual({ object: 'deal', includeRetired: true });
    for (const query of [{ object: 'lead' }, { object: '' }, {}, { object: 'contact', programmeId: tier.id }]) {
      expect(ListCustomFieldsQuery.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });
});
