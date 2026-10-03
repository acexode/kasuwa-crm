import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  buildFieldSecurityMatrix,
  DEFAULT_FIELD_ACCESS_LEVEL,
  planFieldSecurityChanges,
  readFieldSecurityMatrix,
  writeFieldSecurityMatrix,
  type MatrixField,
  type MatrixGrant,
  type MatrixPermissionSet,
} from './field-security';

type QueryResultRow = Record<string, unknown>;

const TENANT = '11111111-0000-4000-8000-000000000001';
const USER = '11111111-0000-4000-8000-0000000d0001';
const OBJECT = '11111111-0000-4000-8000-0000000f0001';

const F_PRIORITY = '11111111-0000-4000-8000-0000000f0101';
const F_NOTES = '11111111-0000-4000-8000-0000000f0102';
const F_BVN = '11111111-0000-4000-8000-0000000f0103';
const S_AGENT = '11111111-0000-4000-8000-0000000e0001';
const S_QA = '11111111-0000-4000-8000-0000000e0002';
const S_ADMIN = '11111111-0000-4000-8000-0000000e0003';

const FIELDS: MatrixField[] = [
  { id: F_BVN, apiName: 'bank_verification', label: 'BVN', classification: 'sensitive' },
  { id: F_PRIORITY, apiName: 'priority', label: 'Priority', classification: 'none' },
  { id: F_NOTES, apiName: 'visit_notes', label: 'Visit notes', classification: 'pii' },
];
const SETS: MatrixPermissionSet[] = [
  { id: S_AGENT, key: 'agent', locked: false },
  { id: S_QA, key: 'qa_analyst', locked: false },
  { id: S_ADMIN, key: 'admin', locked: true },
];

const matrix = (grants: MatrixGrant[] = [], filter = {}) =>
  buildFieldSecurityMatrix({
    objectApiName: 'site_visit',
    version: 3,
    fields: FIELDS,
    sets: SETS,
    grants,
    filter,
  });

const levelOf = (m: ReturnType<typeof matrix>, field: string, set: string) =>
  m.rows.find((row) => row.fieldApiName === field)?.cells.find((c) => c.permissionSetId === set)
    ?.level;

describe('buildFieldSecurityMatrix', () => {
  it('is field x permission set: one row per field, one cell per set, keyed by set key', () => {
    const m = matrix();
    expect(m.rows.map((row) => row.fieldApiName)).toEqual([
      'bank_verification',
      'priority',
      'visit_notes',
    ]);
    for (const row of m.rows) {
      expect(row.cells.map((cell) => cell.permissionSetId)).toEqual([
        'agent',
        'qa_analyst',
        'admin',
      ]);
    }
  });

  it('defaults a never-saved cell to edit (D-L45)', () => {
    expect(DEFAULT_FIELD_ACCESS_LEVEL).toBe('edit');
    expect(levelOf(matrix(), 'priority', 'agent')).toBe('edit');
  });

  it('shows a stored decision, and only on its own cell', () => {
    const m = matrix([{ fieldId: F_PRIORITY, permissionSetId: S_AGENT, level: 'none' }]);
    expect(levelOf(m, 'priority', 'agent')).toBe('none');
    expect(levelOf(m, 'priority', 'qa_analyst')).toBe('edit');
    expect(levelOf(m, 'visit_notes', 'agent')).toBe('edit');
  });

  it('pads a locked set at edit, whatever is stored, and marks only it locked', () => {
    const m = matrix([{ fieldId: F_BVN, permissionSetId: S_ADMIN, level: 'none' }]);
    for (const row of m.rows) {
      for (const cell of row.cells) {
        expect(cell.locked).toBe(cell.permissionSetId === 'admin');
        if (cell.locked) expect(cell.level).toBe('edit');
      }
    }
  });

  it('filters by q on api name or label, case-insensitively, without changing totalFieldCount', () => {
    const byName = matrix([], { q: 'VISIT' });
    expect(byName.rows.map((row) => row.fieldApiName)).toEqual(['visit_notes']);
    expect(byName.totalFieldCount).toBe(3);
    const byLabel = matrix([], { q: 'bvn' });
    expect(byLabel.rows.map((row) => row.fieldApiName)).toEqual(['bank_verification']);
    expect(matrix([], { q: '   ' }).rows).toHaveLength(3);
  });

  it('sensitiveOnly keeps pii and sensitive fields only', () => {
    const m = matrix([], { sensitiveOnly: true });
    expect(m.rows.map((row) => row.fieldApiName)).toEqual(['bank_verification', 'visit_notes']);
    expect(m.totalFieldCount).toBe(3);
  });

  it('publishes no id, tenant id or programme: only the spec keys', () => {
    const m = matrix();
    expect(Object.keys(m).sort()).toEqual(['objectApiName', 'rows', 'totalFieldCount', 'version']);
    expect(JSON.stringify(m)).not.toContain(F_PRIORITY);
    expect(JSON.stringify(m)).not.toContain(S_AGENT);
    expect(JSON.stringify(m)).not.toMatch(/programme/i);
  });
});

describe('planFieldSecurityChanges', () => {
  const plan = (
    changes: Parameters<typeof planFieldSecurityChanges>[0]['changes'],
    grants: MatrixGrant[] = [],
  ) => planFieldSecurityChanges({ fields: FIELDS, sets: SETS, grants, changes });

  it('resolves names to ids and records before and after', () => {
    const result = plan(
      [{ fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' }],
      [{ fieldId: F_PRIORITY, permissionSetId: S_AGENT, level: 'none' }],
    );
    expect(result).toEqual({
      kind: 'apply',
      writes: [
        {
          fieldId: F_PRIORITY,
          permissionSetId: S_AGENT,
          fieldApiName: 'priority',
          permissionSetKey: 'agent',
          before: 'none',
          after: 'read',
        },
      ],
    });
  });

  it('refuses the whole request when one cell is locked', () => {
    expect(
      plan([
        { fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' },
        { fieldApiName: 'priority', permissionSetId: 'admin', level: 'none' },
      ]),
    ).toEqual({ kind: 'locked' });
  });

  it('refuses the whole request when one field or set is unknown', () => {
    const valid = { fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' } as const;
    expect(plan([valid, { ...valid, fieldApiName: 'rival_name' }])).toEqual({ kind: 'not_found' });
    expect(plan([valid, { ...valid, permissionSetId: 'external_auditor' }])).toEqual({
      kind: 'not_found',
    });
  });

  it('answers unknown before locked, so a 403 never confirms a hidden name', () => {
    expect(
      plan([
        { fieldApiName: 'priority', permissionSetId: 'admin', level: 'none' },
        { fieldApiName: 'no_such_field', permissionSetId: 'agent', level: 'none' },
      ]),
    ).toEqual({ kind: 'not_found' });
  });

  it('collapses the same cell named twice to one write, last value wins', () => {
    const result = plan([
      { fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' },
      { fieldApiName: 'priority', permissionSetId: 'agent', level: 'none' },
    ]);
    expect(result.kind).toBe('apply');
    if (result.kind === 'apply') {
      expect(result.writes).toHaveLength(1);
      expect(result.writes[0]?.after).toBe('none');
    }
  });
});

// --- repository: a recording fake, asserting SQL hygiene only --------------

interface Recorded {
  text: string;
  values: readonly unknown[];
}

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

const fieldRows = FIELDS.map((f) => ({
  id: f.id,
  api_name: f.apiName,
  label: f.label,
  classification: f.classification,
}));
const setRows = SETS.map((s) => ({ id: s.id, key: s.key, locked: s.locked }));

describe('field-security repository', () => {
  it('returns null for an object the session cannot see, and reads nothing else', async () => {
    const { tx, queries } = fakeTx([[]]);
    await expect(readFieldSecurityMatrix(tx, 'site_visit')).resolves.toBeNull();
    expect(queries).toHaveLength(1);
  });

  it('binds the api_name and filters every statement on the session tenant', async () => {
    const hostile = "x'; DROP TABLE field_def;--";
    const { tx, queries } = fakeTx([[{ id: OBJECT, version: 1 }], fieldRows, setRows, []]);
    await readFieldSecurityMatrix(tx, hostile);
    for (const recorded of queries) {
      expect(recorded.text).not.toContain('DROP TABLE');
      expect(recorded.text).toMatch(/tenant_id = \$1/);
      expect(recorded.values[0]).toBe(TENANT);
    }
    expect(queries[0]?.values).toContain(hostile);
  });

  it('a stale version writes nothing', async () => {
    const { tx, queries } = fakeTx([[{ id: OBJECT, version: 5 }], fieldRows, setRows, []]);
    const result = await writeFieldSecurityMatrix(tx, {
      objectApiName: 'site_visit',
      version: 4,
      changes: [{ fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' }],
    });
    expect(result).toEqual({ kind: 'stale' });
    expect(queries.some((q) => /INSERT|UPDATE object_def/.test(q.text))).toBe(false);
    expect(queries[0]?.text).toContain('FOR NO KEY UPDATE');
  });

  it('a locked change writes nothing, even with a current version', async () => {
    const { tx, queries } = fakeTx([[{ id: OBJECT, version: 5 }], fieldRows, setRows, []]);
    const result = await writeFieldSecurityMatrix(tx, {
      objectApiName: 'site_visit',
      version: 5,
      changes: [{ fieldApiName: 'priority', permissionSetId: 'admin', level: 'none' }],
    });
    expect(result).toEqual({ kind: 'locked' });
    expect(queries.some((q) => /INSERT|UPDATE object_def/.test(q.text))).toBe(false);
  });

  it('a valid write upserts, bumps the version, and returns the re-read matrix', async () => {
    const { tx, queries } = fakeTx([
      [{ id: OBJECT, version: 5 }],
      fieldRows,
      setRows,
      [],
      [], // upsert
      [], // version bump
      [{ id: OBJECT, version: 6 }],
      fieldRows,
      setRows,
      [{ field_id: F_PRIORITY, permission_set_id: S_AGENT, level: 'read' }],
    ]);
    const result = await writeFieldSecurityMatrix(tx, {
      objectApiName: 'site_visit',
      version: 5,
      changes: [{ fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' }],
    });
    expect(result.kind).toBe('saved');
    if (result.kind === 'saved') {
      expect(result.matrix.version).toBe(6);
      expect(levelOf(result.matrix, 'priority', 'agent')).toBe('read');
    }
    const upsert = queries[4];
    expect(upsert?.text).toContain('INSERT INTO field_security_grant');
    expect(upsert?.values).toEqual([TENANT, [F_PRIORITY], [S_AGENT], ['read']]);
    expect(queries[5]?.text).toContain('field_security_version + 1');
    expect(queries[5]?.values).toEqual([TENANT, OBJECT]);
  });
});
