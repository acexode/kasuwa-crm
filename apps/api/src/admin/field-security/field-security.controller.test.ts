import { describe, expect, it } from 'vitest';
import { toFieldSecurityObjectList } from './field-security.controller';

describe('toFieldSecurityObjectList', () => {
  it('renames to the published field names and keeps a zero count', () => {
    expect(
      toFieldSecurityObjectList([
        { apiName: 'branch_audit', label: 'Branch audit', fieldCount: 0 },
        { apiName: 'site_visit', label: 'Site visit', fieldCount: 3 },
      ]),
    ).toEqual({
      items: [
        { objectApiName: 'branch_audit', label: 'Branch audit', fieldCount: 0 },
        { objectApiName: 'site_visit', label: 'Site visit', fieldCount: 3 },
      ],
    });
  });

  it('publishes nothing but the three fields, even if a summary carries more', () => {
    const leaky = {
      apiName: 'site_visit',
      label: 'Site visit',
      fieldCount: 3,
      id: '11111111-0000-4000-8000-0000002300a1',
      tenantId: '11111111-0000-4000-8000-000000000001',
    };
    const list = toFieldSecurityObjectList([leaky]);
    expect(Object.keys(list.items[0] ?? {}).sort()).toEqual([
      'fieldCount',
      'label',
      'objectApiName',
    ]);
  });

  it('is an empty list, not an error, for a tenant with no objects', () => {
    expect(toFieldSecurityObjectList([])).toEqual({ items: [] });
  });
});
