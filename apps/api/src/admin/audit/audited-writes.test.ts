import 'reflect-metadata';
import type { TenantTx } from '@kasuwa/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldSecurityMatrixController } from '../field-security/field-security-matrix.controller';
import { AdminProgrammesController } from '../programmes/programmes.controller';

/**
 * D-L52: the three audited writes that arrived after the writer was built.
 * The domain functions are stubbed; what is under test is what reaches
 * `audit_event` — and, for createProgramme, what must never reach it.
 */

const TENANT = '99999999-0000-4000-8000-000000000001';
const USER = '99999999-0000-4000-8000-000000000002';
const PROGRAMME = '99999999-0000-4000-8000-000000000003';
const NEW_PROGRAMME = '99999999-0000-4000-8000-000000000004';
const FIELD = '99999999-0000-4000-8000-000000000005';
const BUSINESS_UNIT = '99999999-0000-4000-8000-000000000006';

const inserts: unknown[][] = [];
const tx: TenantTx = {
  session: { tenantId: TENANT, userId: USER, programmeIds: [PROGRAMME] },
  query: <T>(text: string, values: readonly unknown[] = []) => {
    if (text.includes('INSERT INTO audit_event')) inserts.push([...values]);
    return Promise.resolve([] as T[]);
  },
};

vi.mock('../../tenancy/tenant-context', () => ({ currentTx: () => tx }));

const domain = vi.hoisted(() => ({
  createProgramme: vi.fn(),
  findProgrammeById: vi.fn(),
  archiveProgramme: vi.fn(),
}));
vi.mock('@kasuwa/domain-core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...domain,
}));

const metadata = vi.hoisted(() => ({ writeFieldSecurityMatrix: vi.fn() }));
vi.mock('@kasuwa/metadata-engine', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...metadata,
}));

// vi.mock is hoisted above these imports, so the controllers see the stubs.
/** Columns of the writer's INSERT, by position. */
const event = (values: unknown[]) => ({
  action: values[3],
  objectType: values[4],
  objectId: values[5],
  objectLabel: values[6],
  programmeId: values[7],
  changes: JSON.parse(String(values[8])) as unknown[],
});

const programme = (status: 'active' | 'archived') => ({
  id: PROGRAMME,
  businessUnitId: BUSINESS_UNIT,
  name: 'Invented Programme',
  clientName: 'Invented Client Ltd',
  isDefault: false,
  status,
  version: 1,
});

beforeEach(() => {
  inserts.length = 0;
  vi.clearAllMocks();
});

describe('createProgramme audit (D-L52)', () => {
  it('records the new id only: no programme, no name, no client name', async () => {
    domain.createProgramme.mockResolvedValue({
      ...programme('active'),
      id: NEW_PROGRAMME,
      name: 'Secret Bank Collections',
      clientName: 'Secret Bank Plc',
    });
    await new AdminProgrammesController().create({
      name: 'Secret Bank Collections',
      clientName: 'Secret Bank Plc',
      businessUnitId: BUSINESS_UNIT,
    });

    expect(inserts).toHaveLength(1);
    const written = event(inserts[0] ?? []);
    expect(written).toEqual({
      action: 'created',
      objectType: 'programme',
      objectId: NEW_PROGRAMME,
      objectLabel: NEW_PROGRAMME,
      programmeId: null,
      changes: [{ field: 'id', before: null, after: NEW_PROGRAMME, redacted: false }],
    });
    expect(JSON.stringify(inserts)).not.toMatch(/Secret Bank/u);
  });
});

describe('archiveProgramme audit (D-L52)', () => {
  it('records the status change inside the programme', async () => {
    domain.findProgrammeById.mockResolvedValue(programme('active'));
    domain.archiveProgramme.mockResolvedValue(programme('archived'));
    await new AdminProgrammesController().archive(
      { programmeId: PROGRAMME },
      { confirmation: 'Invented Programme' },
    );
    expect(inserts.map(event)).toEqual([
      {
        action: 'updated',
        objectType: 'programme',
        objectId: PROGRAMME,
        objectLabel: 'Invented Programme',
        programmeId: PROGRAMME,
        changes: [{ field: 'status', before: 'active', after: 'archived', redacted: false }],
      },
    ]);
  });

  it('records nothing for an idempotent re-archive', async () => {
    domain.findProgrammeById.mockResolvedValue(programme('archived'));
    domain.archiveProgramme.mockResolvedValue(programme('archived'));
    await new AdminProgrammesController().archive(
      { programmeId: PROGRAMME },
      { confirmation: 'Invented Programme' },
    );
    expect(inserts).toEqual([]);
  });
});

describe('updateFieldSecurityMatrix audit (D-L52)', () => {
  it('writes one tenant-level event per changed cell and none for an unchanged one', async () => {
    const cell = {
      fieldId: FIELD,
      permissionSetId: '99999999-0000-4000-8000-000000000007',
      fieldApiName: 'invented_field',
      permissionSetKey: 'agent',
    };
    metadata.writeFieldSecurityMatrix.mockResolvedValue({
      kind: 'saved',
      matrix: { object: 'contact', version: 2, permissionSets: [], rows: [] },
      writes: [
        { ...cell, before: 'edit', after: 'none' },
        { ...cell, permissionSetKey: 'supervisor', before: 'read', after: 'read' },
      ],
    });
    // The stub matrix is not a valid response; only the events matter here.
    await new FieldSecurityMatrixController()
      .update({
        objectApiName: 'contact',
        version: 1,
        changes: [{ fieldApiName: 'invented_field', permissionSetId: 'agent', level: 'none' }],
      })
      .catch(() => undefined);
    expect(metadata.writeFieldSecurityMatrix).toHaveBeenCalledTimes(1);

    expect(inserts.map(event)).toEqual([
      {
        action: 'updated',
        objectType: 'field_security',
        objectId: FIELD,
        objectLabel: 'invented_field',
        programmeId: null,
        changes: [
          { field: 'fieldApiName', before: null, after: 'invented_field', redacted: false },
          { field: 'permissionSetId', before: null, after: 'agent', redacted: false },
          { field: 'level', before: 'edit', after: 'none', redacted: false },
        ],
      },
    ]);
  });
});
