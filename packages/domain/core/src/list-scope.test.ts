import { describe, expect, it } from 'vitest';
import { listScopeSql } from './list-scope';

const TENANT = '11111111-0000-4000-8000-000000000001';
const P1 = '11111111-0000-4000-8000-0000000000a1';
const P2 = '11111111-0000-4000-8000-0000000000a2';

function bind() {
  const values: unknown[] = [];
  return {
    values,
    add: (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

describe('listScopeSql (T-0084, migration review M1)', () => {
  it('a one-programme session gets scalar equality, so a programme-led index can give the order', () => {
    const params = bind();
    const scope = listScopeSql({ tenantId: TENANT, programmeIds: [P1] }, params.add);
    expect(scope.tenantId).toBe('$1');
    expect(scope.programmeIn('programme_id')).toBe('programme_id = $2::uuid');
    expect(scope.programmeIn('cursor_row.programme_id')).toBe('cursor_row.programme_id = $2::uuid');
    expect(params.values).toEqual([TENANT, P1]);
  });

  it('a session reaching several programmes, or none, gets = ANY over exactly its own list', () => {
    for (const programmeIds of [[P1, P2], []]) {
      const params = bind();
      const scope = listScopeSql({ tenantId: TENANT, programmeIds }, params.add);
      expect(scope.programmeIn('programme_id')).toBe('programme_id = ANY($2::uuid[])');
      expect(params.values).toEqual([TENANT, programmeIds]);
    }
  });
});
