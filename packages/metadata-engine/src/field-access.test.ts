import { STANDARD_OBJECT_CATALOGUE, type TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import { isValidApiName } from './api-name';
import {
  fieldLevel,
  loadFieldAccess,
  resolveFieldAccess,
  type FieldAccessGrant,
} from './field-access';
import { FIELD_CLASSIFICATIONS } from './field-security';
import { UnknownObjectDefError } from './repository';
import { FIELD_TYPES, parseFieldConfig } from './types';

const A1 = '11111111-0000-4000-8000-0000000c0001';
const A2 = '11111111-0000-4000-8000-0000000c0002';
const AGENT = '11111111-0000-4000-8000-0000000e0001';
const QA = '11111111-0000-4000-8000-0000000e0002';
const ADMIN = '11111111-0000-4000-8000-0000000e0003';

const grant = (
  fieldApiName: string,
  permissionSetId: string,
  level: 'none' | 'read' | 'edit',
  locked = false,
): FieldAccessGrant => ({ fieldApiName, permissionSetId, level, locked });

const GRANTS = [
  grant('emails', AGENT, 'none'),
  grant('phones', AGENT, 'read'),
  grant('emails', QA, 'read'),
  grant('phones', QA, 'edit'),
  // Stored on a locked set: never counts.
  grant('emails', ADMIN, 'none', true),
  grant('given_names', ADMIN, 'none', true),
];
const FIELDS = ['emails', 'given_names', 'phones'];

const resolve = (
  memberships: { programmeId: string; permissionSetId: string | null; locked: boolean }[],
  reachable = [A1],
) =>
  resolveFieldAccess({
    fieldApiNames: FIELDS,
    grants: GRANTS,
    memberships,
    reachableProgrammeIds: reachable,
  });

describe('resolveFieldAccess', () => {
  it('applies the set held in the programme, and an unsaved cell is edit (D-L45)', () => {
    const access = resolve([{ programmeId: A1, permissionSetId: AGENT, locked: false }]);
    expect(Object.fromEntries(access.get(A1) ?? [])).toEqual({
      emails: 'none',
      given_names: 'edit',
      phones: 'read',
    });
  });

  it('a locked set is edit, whatever is stored for it', () => {
    const access = resolve([{ programmeId: A1, permissionSetId: ADMIN, locked: true }]);
    expect(Object.fromEntries(access.get(A1) ?? [])).toEqual({
      emails: 'edit',
      given_names: 'edit',
      phones: 'edit',
    });
  });

  it('a membership with no set gets the weakest unlocked level, ignoring locked sets', () => {
    const access = resolve([{ programmeId: A1, permissionSetId: null, locked: false }]);
    expect(Object.fromEntries(access.get(A1) ?? [])).toEqual({
      emails: 'none', // agent none, qa read
      given_names: 'edit', // only the locked admin stored anything
      phones: 'read', // agent read, qa edit
    });
  });

  it('is per programme: one person, two sets, two answers', () => {
    const access = resolve(
      [
        { programmeId: A1, permissionSetId: AGENT, locked: false },
        { programmeId: A2, permissionSetId: QA, locked: false },
      ],
      [A1, A2],
    );
    expect([...access.keys()]).toEqual([A1, A2]);
    expect(access.get(A1)?.get('emails')).toBe('none');
    expect(access.get(A2)?.get('emails')).toBe('read');
  });

  it('fails closed: a reachable programme with no membership row is none for every field', () => {
    const access = resolve([{ programmeId: A1, permissionSetId: AGENT, locked: false }], [A1, A2]);
    expect(Object.fromEntries(access.get(A2) ?? [])).toEqual({
      emails: 'none',
      given_names: 'none',
      phones: 'none',
    });
  });

  it('ignores a membership outside the reachable programmes', () => {
    const access = resolve([{ programmeId: A2, permissionSetId: AGENT, locked: false }], []);
    expect(access.size).toBe(0);
  });

  it('never invents a field: grants for a field the object lacks are not in the answer', () => {
    const access = resolveFieldAccess({
      fieldApiNames: ['name'],
      grants: [grant('emails', AGENT, 'none')],
      memberships: [{ programmeId: A1, permissionSetId: AGENT, locked: false }],
      reachableProgrammeIds: [A1],
    });
    expect([...(access.get(A1)?.keys() ?? [])]).toEqual(['name']);
  });
});

describe('fieldLevel', () => {
  const access = resolve([{ programmeId: A1, permissionSetId: AGENT, locked: false }]);

  it('reads the resolved level', () => {
    expect(fieldLevel(access, A1, 'emails')).toBe('none');
    expect(fieldLevel(access, A1, 'phones')).toBe('read');
    expect(fieldLevel(access, A1, 'given_names')).toBe('edit');
  });

  it('fails closed on a programme or a field the map does not carry, never the default', () => {
    expect(fieldLevel(access, A2, 'given_names')).toBe('none');
    expect(fieldLevel(access, A1, 'no_such_field')).toBe('none');
    expect(fieldLevel(new Map(), A1, 'emails')).toBe('none');
  });
});

function fakeTx(rows: Record<string, unknown>[]): TenantTx & { sent: unknown[][] } {
  const tx = {
    sent: [] as unknown[][],
    session: { tenantId: 'tenant', userId: 'user', programmeIds: [A1] },
    query: (_text: string, values: unknown[]) => {
      tx.sent.push(values);
      return Promise.resolve(rows as never[]);
    },
  };
  return tx as unknown as TenantTx & { sent: unknown[][] };
}

describe('loadFieldAccess', () => {
  it('rejects an object the session cannot see with UnknownObjectDefError, naming nothing', async () => {
    const tx = fakeTx([]);
    const error = await loadFieldAccess(tx, 'competitor_intel').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnknownObjectDefError);
    expect((error as Error).message).toBe('No object definition');
  });

  it.each(['', 'CONTACT', "contact' OR '1'='1", 'contact;--', 'contact '.repeat(20), 'user'])(
    'rejects a malformed name (%j) the same way, without a round trip',
    async (name) => {
      const tx = fakeTx([{ fields: [], grants: [], memberships: [] }]);
      const error = await loadFieldAccess(tx, name).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnknownObjectDefError);
      expect((error as Error).message).toBe('No object definition');
      expect(tx.sent).toEqual([]);
    },
  );

  it('binds the name and the session scope as parameters', async () => {
    const tx = fakeTx([
      {
        fields: ['emails'],
        grants: [{ field: 'emails', set: AGENT, locked: false, level: 'read' }],
        memberships: [{ programme: A1, set: AGENT, locked: false }],
      },
    ]);
    const access = await loadFieldAccess(tx, 'contact');
    expect(tx.sent).toEqual([['tenant', 'contact', 'user', [A1]]]);
    expect(access.get(A1)?.get('emails')).toBe('read');
  });

  it('parses the row: a level outside none/read/edit is an error, not a default', async () => {
    const tx = fakeTx([
      {
        fields: ['emails'],
        grants: [{ field: 'emails', set: AGENT, locked: false, level: 'write' }],
        memberships: [{ programme: A1, set: AGENT, locked: false }],
      },
    ]);
    await expect(loadFieldAccess(tx, 'contact')).rejects.toThrow();
  });
});

describe('the standard object catalogue (T-0053) is valid metadata', () => {
  const fields = STANDARD_OBJECT_CATALOGUE.flatMap((object) =>
    object.fields.map((field) => ({ object: object.apiName, ...field })),
  );

  it('names contact and account, with valid, unique api_names', () => {
    expect(STANDARD_OBJECT_CATALOGUE.map((object) => object.apiName)).toEqual([
      'contact',
      'account',
    ]);
    for (const object of STANDARD_OBJECT_CATALOGUE) {
      expect(isValidApiName(object.apiName), object.apiName).toBe(true);
      const names = object.fields.map((field) => field.apiName);
      expect(new Set(names).size, `${object.apiName}: duplicate field`).toBe(names.length);
      for (const name of names) expect(isValidApiName(name), name).toBe(true);
    }
  });

  it.each(fields.map((field) => [`${field.object}.${field.apiName}`, field] as const))(
    '%s has a P0 type, a known classification and a config its type accepts',
    (_name, field) => {
      expect(FIELD_TYPES).toContain(field.type);
      expect(FIELD_CLASSIFICATIONS).toContain(field.classification);
      expect(() => parseFieldConfig(field.type, field.config)).not.toThrow();
    },
  );
});
