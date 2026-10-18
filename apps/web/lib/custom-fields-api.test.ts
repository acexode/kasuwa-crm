import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCustomField,
  currencyOf,
  listCustomFields,
  picklistValuesOf,
  retireCustomField,
  updateCustomField,
  type CustomFieldDefinition,
} from './custom-fields-api';

const DEFINITION: CustomFieldDefinition = {
  id: '11111111-0000-4000-8000-0000000c0001',
  objectApiName: 'contact',
  apiName: 'tier__c',
  label: 'Customer tier',
  description: null,
  type: 'picklist',
  classification: 'none',
  config: { values: [{ value: 'gold', label: 'Gold' }] },
  retiredAt: null,
  createdAt: '2026-10-14T09:00:00.000Z',
  updatedAt: '2026-10-14T09:00:00.000Z',
};

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the custom-fields client (T-0090)', () => {
  it('reads one object, retired fields included, same-origin, never cached, with no scope', async () => {
    const fetchMock = vi.fn(async () =>
      answer({ objectApiName: 'contact', limits: { fieldsPerObject: 100, definitionsPerObject: 500, picklistValues: 500, apiBytes: 16384 }, items: [DEFINITION] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await listCustomFields('contact');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/custom-fields?object=contact&includeRetired=true');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/programme|tenant|scope/i);
    expect(result.ok && result.value.limits.fieldsPerObject).toBe(100);
    expect(result.ok && result.value.items[0]?.apiName).toBe('tier__c');
  });

  it('refuses a list answer the contract does not describe, as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ objectApiName: 'lead', items: [] })));
    const result = await listCustomFields('contact');
    expect(result.ok).toBe(false);
  });

  it('refuses a non-positive limit, a config with extra keys, and a config that does not fit the type', async () => {
    const list = (items: unknown[], fieldsPerObject = 100) =>
      vi.fn(async () => answer({ objectApiName: 'contact', limits: { fieldsPerObject, definitionsPerObject: 500, picklistValues: 500 }, items }));
    vi.stubGlobal('fetch', list([DEFINITION], 0));
    expect((await listCustomFields('contact')).ok).toBe(false);
    vi.stubGlobal('fetch', list([{ ...DEFINITION, config: { values: [{ value: 'gold', label: 'Gold' }], extra: 1 } }]));
    expect((await listCustomFields('contact')).ok).toBe(false);
    vi.stubGlobal('fetch', list([{ ...DEFINITION, type: 'text' }]));
    expect((await listCustomFields('contact')).ok).toBe(false);
    vi.stubGlobal('fetch', list([{ ...DEFINITION, type: 'currency' }]));
    expect((await listCustomFields('contact')).ok).toBe(false);
    vi.stubGlobal('fetch', list([DEFINITION]));
    expect((await listCustomFields('contact')).ok).toBe(true);
  });

  it('creates with the body as given and parses the definition', async () => {
    const fetchMock = vi.fn(async () => answer(DEFINITION, 201));
    vi.stubGlobal('fetch', fetchMock);
    const body = { objectApiName: 'contact', apiName: 'tier__c', label: 'Customer tier', type: 'text', classification: 'none' } as const;
    const result = await createCustomField(body);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/custom-fields');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
    expect(result.ok).toBe(true);
  });

  it('updates by id, URL-encoded, with only the body given', async () => {
    const fetchMock = vi.fn(async () => answer(DEFINITION));
    vi.stubGlobal('fetch', fetchMock);
    await updateCustomField('a/b', { label: 'Renamed' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/custom-fields/a%2Fb');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ label: 'Renamed' });
  });

  it('retires with a POST and no body', async () => {
    const fetchMock = vi.fn(async () => answer({ ...DEFINITION, retiredAt: '2026-10-18T09:00:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await retireCustomField(DEFINITION.id);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/v1/admin/custom-fields/${DEFINITION.id}/retire`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(result.ok && result.value.retiredAt).not.toBeNull();
  });

  it('keeps the contract’s error code and the detail’s own code, and never reads the English message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        answer(
          {
            statusCode: 409,
            error: 'Conflict',
            code: 'limit_reached',
            message: 'This object already has the most custom fields allowed.',
            details: [{ path: 'objectApiName', code: 'field_limit_reached' }],
          },
          409,
        ),
      ),
    );
    const result = await createCustomField({ objectApiName: 'deal', apiName: 'x__c', label: 'X', type: 'text', classification: 'none' });
    expect(result).toEqual({ ok: false, error: { code: 'limit_reached', details: [{ path: 'objectApiName', code: 'field_limit_reached' }] } });
  });

  it('answers a dropped connection as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('failed'))));
    const result = await retireCustomField(DEFINITION.id);
    expect(result).toEqual({ ok: false, error: { code: 'network' } });
  });

  it('reads picklist values and the currency out of the config', () => {
    expect(picklistValuesOf(DEFINITION)).toEqual([{ value: 'gold', label: 'Gold' }]);
    expect(currencyOf(DEFINITION)).toBeNull();
    const money = { ...DEFINITION, type: 'currency' as const, config: { currencyCode: 'KES' } };
    expect(currencyOf(money)).toBe('KES');
    expect(picklistValuesOf(money)).toEqual([]);
    expect(picklistValuesOf({ ...DEFINITION, type: 'text', config: {} })).toEqual([]);
  });
});
