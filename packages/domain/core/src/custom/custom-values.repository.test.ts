import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  CustomProgrammeOutOfScopeError,
  customFilterClauses,
  customMergeSet,
  CustomValuesSqlError,
  measureCustomVisibleSize,
  programmesReadingKey,
  projectedCustomSql,
  readProjectedCustom,
} from './custom-values.repository';

// Invented ids, naming nothing real.
const TENANT = '99999999-0000-4000-8000-0000000089b0';
const USER = '99999999-0000-4000-8000-0000000089b1';
const P1 = '99999999-0000-4000-8000-0000000089b2';
const P2 = '99999999-0000-4000-8000-0000000089b3';
const OUTSIDE = '99999999-0000-4000-8000-0000000089b4';
const ROW = '99999999-0000-4000-8000-0000000089b5';
const HOSTILE = "x'); DROP TABLE contact; --";

function fakeTx(rows: unknown[] = []): { tx: TenantTx; calls: { text: string; values: readonly unknown[] }[] } {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const tx: TenantTx = {
    session: { tenantId: TENANT, userId: USER, programmeIds: [P1, P2] },
    query: <T>(text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return Promise.resolve(rows as T[]);
    },
  };
  return { tx, calls };
}

function binder(): { add: (value: unknown) => string; values: unknown[] } {
  const values: unknown[] = [];
  return {
    values,
    add: (value) => {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

describe('projectedCustomSql (ADR-0016 item 6: custom minus every key not readable in the row programme)', () => {
  it('keys the readable list by the row programme and removes everything else from the row custom', () => {
    const sql = projectedCustomSql('t', '$4');
    expect(sql).toContain('t.custom - ARRAY(');
    expect(sql).toContain('jsonb_object_keys(t.custom)');
    expect(sql).toContain('$4::jsonb -> t.programme_id::text');
    expect(sql).toMatch(/WHERE NOT \(custom_key = ANY/);
  });

  it('interpolates only a plain alias and a placeholder: anything else is refused', () => {
    for (const [alias, placeholder] of [
      ['t.x', '$1'],
      ['T', '$1'],
      [HOSTILE, '$1'],
      ['t', '1'],
      ['t', '$0'],
      ['t', `$1; ${HOSTILE}`],
    ] as const) {
      expect(() => projectedCustomSql(alias, placeholder), `${alias} ${placeholder}`).toThrow(CustomValuesSqlError);
    }
  });
});

describe('customMergeSet (ADR-0016 item 5, D-L142: (custom || set) - remove - retired)', () => {
  it('binds the set as JSON, the removals and the retired keys as text arrays; no key reaches the SQL text', () => {
    const { add, values } = binder();
    const sql = customMergeSet(
      { set: { [HOSTILE]: 'v', tier__c: 'gold' }, remove: ['vip__c'], drop: ['old__c'] },
      add,
    );
    expect(sql).toBe('custom = ((custom || $1::jsonb) - $2::text[]) - $3::text[]');
    expect(values).toEqual([JSON.stringify({ [HOSTILE]: 'v', tier__c: 'gold' }), ['vip__c'], ['old__c']]);
    expect(sql).not.toContain('tier__c');
  });

  it('a patch with no retired keys drops an empty list', () => {
    const { add, values } = binder();
    customMergeSet({ set: {}, remove: ['a__c'] }, add);
    expect(values[2]).toEqual([]);
  });
});

describe('customFilterClauses (ADR-0016 item 8; D-L142: on the projected custom)', () => {
  const readable = { [P1]: ['tier__c', 'vip__c', 'band__c'], [P2]: ['tier__c'] };

  it('picklist and boolean equality, and is-empty, each true only where the key is readable in the row programme', () => {
    const { add, values } = binder();
    const clauses = customFilterClauses(
      { equals: [{ key: 'tier__c', value: 'gold' }, { key: 'vip__c', value: true }], empty: ['band__c'], readable },
      add,
      'contact',
    );
    expect(clauses).toEqual([
      '(CASE WHEN contact.programme_id = ANY ($1::uuid[]) THEN contact.custom ->> $2::text END) = $3::text',
      '(CASE WHEN contact.programme_id = ANY ($4::uuid[]) THEN contact.custom -> $5::text END) = $6::jsonb',
      'NOT (CASE WHEN contact.programme_id = ANY ($7::uuid[]) THEN contact.custom ? $8::text ELSE false END)',
    ]);
    expect(values).toEqual([[P1, P2], 'tier__c', 'gold', [P1], 'vip__c', 'true', [P1], 'band__c']);
  });

  it('programmesReadingKey reads the projection for one key: unreadable everywhere is no programme', () => {
    expect(programmesReadingKey(readable, 'tier__c')).toEqual([P1, P2]);
    expect(programmesReadingKey(readable, 'vip__c')).toEqual([P1]);
    expect(programmesReadingKey(readable, 'secret__c')).toEqual([]);
  });

  it('a hostile key or value is a bound parameter, never SQL; a bad alias is refused', () => {
    const { add, values } = binder();
    const clauses = customFilterClauses(
      { equals: [{ key: HOSTILE, value: HOSTILE }], empty: [HOSTILE], readable },
      add,
      'd',
    );
    expect(clauses.join(' ')).not.toContain('DROP');
    expect(values).toEqual([[], HOSTILE, HOSTILE, [], HOSTILE]);
    for (const alias of [HOSTILE, 'd.custom', 'D']) {
      expect(() => customFilterClauses({ equals: [], empty: [], readable }, add, alias), alias).toThrow(
        CustomValuesSqlError,
      );
    }
    expect(customFilterClauses(undefined, add, 'd')).toEqual([]);
  });
});

describe('readProjectedCustom and measureCustomVisibleSize (tenancy: the session decides scope)', () => {
  it('reads only rows of the session tenant and programmes, binding the readable lists as JSON', async () => {
    const { tx, calls } = fakeTx([{ id: ROW, custom: { tier__c: 'gold' } }]);
    const result = await readProjectedCustom(tx, 'contact', [ROW], { [P1]: ['tier__c'] });
    expect(result.get(ROW)).toEqual({ tier__c: 'gold' });
    const [call] = calls;
    expect(call?.text).toMatch(/FROM contact t/);
    expect(call?.text).toMatch(/t\.tenant_id = \$1/);
    expect(call?.text).toMatch(/t\.programme_id = ANY \(\$2::uuid\[\]\)/);
    expect(call?.values).toEqual([TENANT, [P1, P2], [ROW], JSON.stringify({ [P1]: ['tier__c'] })]);
    // The record statement never selects `custom` whole: only the projection names it.
    expect(call?.text).not.toMatch(/SELECT\s+t\.custom\b/);
  });

  it('asks nothing for no rows, and refuses a table outside the four', async () => {
    const { tx, calls } = fakeTx();
    expect((await readProjectedCustom(tx, 'deal', [], {})).size).toBe(0);
    expect(calls).toHaveLength(0);
    await expect(readProjectedCustom(tx, 'pipeline' as 'deal', [ROW], {})).rejects.toThrow(CustomValuesSqlError);
  });

  it('measures two integers on the row in scope, and refuses a programme outside the session', async () => {
    const { tx, calls } = fakeTx([{ before: 10, after: 20 }]);
    const patch = { set: { tier__c: 'gold' }, remove: ['vip__c'], drop: ['old__c'] };
    expect(await measureCustomVisibleSize(tx, 'account', { id: ROW, programmeId: P1 }, ['tier__c'], patch)).toEqual({
      before: 10,
      after: 20,
    });
    const [call] = calls;
    expect(call?.text).toMatch(/FROM account t/);
    expect(call?.text).toMatch(/octet_length/);
    // D-L142: the row is locked from the measure to the write.
    expect(call?.text).toMatch(/FOR UPDATE OF t\s*$/);
    expect(call?.values).toEqual([
      ROW,
      TENANT,
      P1,
      [P1, P2],
      ['tier__c'],
      JSON.stringify(patch.set),
      ['vip__c'],
      ['old__c'],
    ]);
    await expect(
      measureCustomVisibleSize(tx, 'account', { id: ROW, programmeId: OUTSIDE }, [], patch),
    ).rejects.toThrow(CustomProgrammeOutOfScopeError);
  });
});
