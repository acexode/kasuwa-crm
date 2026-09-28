import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  createFieldDef,
  createObjectDef,
  DuplicateApiNameError,
  listObjectDefs,
  UnknownObjectDefError,
} from './repository';
import { parseFieldConfig } from './types';

/** A row as pg hands it back. Typed locally so this package needs no pg dependency. */
type QueryResultRow = Record<string, unknown>;

const TENANT = '11111111-0000-4000-8000-000000000001';
const OTHER_TENANT = '22222222-0000-4000-8000-000000000002';
const USER = '11111111-0000-4000-8000-0000000d0001';
const OBJECT = '11111111-0000-4000-8000-0000000f0001';

interface Recorded {
  text: string;
  values: readonly unknown[];
}

/**
 * A recording stand-in for a tenant transaction.
 *
 * Postgres is never mocked for anything that asserts isolation — that is what
 * the acceptance suite and Testcontainers are for. This fake asserts something
 * different and purely local: that the repository parameterises its SQL and
 * takes tenant_id from the session rather than the caller.
 */
function fakeTx(responses: QueryResultRow[][]): { tx: TenantTx; queries: Recorded[] } {
  const queries: Recorded[] = [];
  const queue = [...responses];
  const tx: TenantTx = {
    session: { tenantId: TENANT, userId: USER, programmeIds: [] },
    query: async <T extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      return (queue.shift() ?? []) as T[];
    },
  };
  return { tx, queries };
}

function objectRow(overrides: Record<string, unknown> = {}): QueryResultRow {
  return {
    id: OBJECT,
    tenant_id: TENANT,
    api_name: 'site_visit',
    label: 'Site visit',
    plural_label: null,
    description: null,
    is_custom: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('metadata repository', () => {
  it('takes tenant_id from the session, never from the caller', async () => {
    const { tx, queries } = fakeTx([[objectRow()]]);

    // The input type has no tenantId; an extra property must not reach SQL.
    await createObjectDef(tx, {
      apiName: 'site_visit',
      label: 'Site visit',
      ...({ tenantId: OTHER_TENANT } as Record<string, unknown>),
    });

    expect(queries[0]?.values).toContain(TENANT);
    expect(queries[0]?.values).not.toContain(OTHER_TENANT);
  });

  it('never concatenates a user-supplied value into SQL', async () => {
    const hostile = 'a_name';
    const { tx, queries } = fakeTx([[objectRow({ api_name: hostile })]]);

    await createObjectDef(tx, { apiName: hostile, label: "'); DROP TABLE object_def;--" });

    for (const recorded of queries) {
      expect(recorded.text).not.toContain(hostile);
      expect(recorded.text).not.toContain('DROP TABLE');
    }
    expect(queries[0]?.values).toContain(hostile);
  });

  it('filters on tenant_id explicitly as well as relying on RLS', async () => {
    // Two independent layers; a typo in one does not leak.
    const { tx, queries } = fakeTx([[objectRow()]]);
    await listObjectDefs(tx);
    expect(queries[0]?.text).toMatch(/WHERE tenant_id = \$1/);
    expect(queries[0]?.values[0]).toBe(TENANT);
  });

  it('maps a unique violation to DuplicateApiNameError', async () => {
    const tx: TenantTx = {
      session: { tenantId: TENANT, userId: USER, programmeIds: [] },
      query: async () => {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      },
    };
    await expect(createObjectDef(tx, { apiName: 'priority', label: 'Priority' })).rejects.toThrow(
      DuplicateApiNameError,
    );
  });

  it('reports an unreachable parent object as unknown, not as forbidden', async () => {
    // A definition in another tenant must look like one that does not exist:
    // 404, never 403. The lookup returns no row because RLS filtered it.
    const { tx } = fakeTx([[]]);
    await expect(
      createFieldDef(tx, { objectId: OBJECT, apiName: 'leak', label: 'Leak', type: 'text' }),
    ).rejects.toThrow(UnknownObjectDefError);
  });

  it('resolves the parent object before inserting a field', async () => {
    const { tx, queries } = fakeTx([
      [objectRow()],
      [
        {
          id: '11111111-0000-4000-8000-0000000f0009',
          tenant_id: TENANT,
          object_id: OBJECT,
          api_name: 'priority',
          label: 'Priority',
          type: 'text',
          description: null,
          is_required: false,
          is_custom: true,
          config: {},
          created_at: new Date('2026-01-01T00:00:00Z'),
          updated_at: new Date('2026-01-01T00:00:00Z'),
        },
      ],
    ]);

    const field = await createFieldDef(tx, {
      objectId: OBJECT,
      apiName: 'priority',
      label: 'Priority',
      type: 'text',
    });

    expect(field.apiName).toBe('priority');
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain('FROM object_def');
    expect(queries[1]?.text).toContain('INSERT INTO field_def');
  });

  it('rejects an invalid api_name before it reaches the database', async () => {
    const { tx, queries } = fakeTx([]);
    await expect(createObjectDef(tx, { apiName: 'Not Valid', label: 'x' })).rejects.toThrow();
    expect(queries).toHaveLength(0);
  });
});

describe('field configuration', () => {
  it('bounds picklist size rather than trusting the author', async () => {
    const values = Array.from({ length: 501 }, (_unused, index) => ({
      value: `option_${index}`,
      label: `Option ${index}`,
    }));
    expect(() => parseFieldConfig('picklist', { values })).toThrow();
    expect(() => parseFieldConfig('picklist', { values: values.slice(0, 2) })).not.toThrow();
  });

  it('rejects unknown config keys instead of silently dropping them', () => {
    expect(() => parseFieldConfig('text', { maxLenght: 10 })).toThrow();
    expect(parseFieldConfig('text', {})).toEqual({});
  });

  it('requires a currency code on a currency field', () => {
    expect(() => parseFieldConfig('currency', {})).toThrow();
    expect(parseFieldConfig('currency', { currencyCode: 'ngn' })).toEqual({ currencyCode: 'NGN' });
  });
});
