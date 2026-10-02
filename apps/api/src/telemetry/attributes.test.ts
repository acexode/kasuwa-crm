import { describe, expect, it } from 'vitest';
import { allowListed, normaliseMethod, routeVocabulary, templatePath } from './attributes';

describe('telemetry attribute allow-list', () => {
  it('keeps only named attributes, whatever else a caller passes', () => {
    expect(
      allowListed({
        'http.route': '/api/v1/contacts/:id',
        tenant_id: 'tenant',
        programme_id: ['p1', 'p2'],
        'url.full': 'https://x.test/?q=%2B2348030000000',
        'user.email': 'someone@example.test',
        'http.request.header.x-request-id': 'deadbeef',
      }),
    ).toEqual({
      'http.route': '/api/v1/contacts/:id',
      tenant_id: 'tenant',
      programme_id: ['p1', 'p2'],
    });
  });

  it('drops values that are not strings, numbers or string lists', () => {
    expect(allowListed({ tenant_id: { email: 'someone@example.test' }, cell: ['a', 1] })).toEqual(
      {},
    );
  });

  it('never echoes an unknown method', () => {
    expect(normaliseMethod('get')).toBe('GET');
    expect(normaliseMethod('someone@example.test')).toBe('_OTHER');
    expect(normaliseMethod(undefined)).toBe('_OTHER');
  });
});

describe('templatePath', () => {
  const vocabulary = routeVocabulary(['api/v1/contacts', ':id', 'health', '/api/v1/auth/sign-in']);

  it('keeps declared route words and replaces everything else', () => {
    expect(templatePath('/api/v1/contacts/search', vocabulary)).toBe('/api/v1/contacts/:param');
    expect(templatePath('/api/v1/contacts/adaeze.okonkwo@example.test', vocabulary)).toBe(
      '/api/v1/contacts/:param',
    );
  });

  it('never looks at the query string or fragment', () => {
    expect(templatePath('/api/v1/contacts?q=%2B2348030000000#x', vocabulary)).toBe(
      '/api/v1/contacts',
    );
  });

  it('does not learn a word from a parameter placeholder', () => {
    expect(vocabulary.has(':id')).toBe(false);
    expect(vocabulary.has('sign-in')).toBe(true);
  });

  it('bounds the number of segments', () => {
    expect(templatePath(`/${'api/'.repeat(50)}`, vocabulary).split('/').length).toBe(13);
  });
});
