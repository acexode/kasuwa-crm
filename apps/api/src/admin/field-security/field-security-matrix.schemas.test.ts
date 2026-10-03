import { describe, expect, it } from 'vitest';
import {
  FieldSecurityMatrixQuery,
  FieldSecurityWriteBody,
  toFieldSecurityMatrixResponse,
} from './field-security-matrix.schemas';

const change = { fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' };

describe('FieldSecurityMatrixQuery', () => {
  it('parses object, q and sensitiveOnly', () => {
    expect(
      FieldSecurityMatrixQuery.parse({ object: 'site_visit', q: 'visit', sensitiveOnly: 'true' }),
    ).toEqual({ object: 'site_visit', q: 'visit', sensitiveOnly: true });
    expect(FieldSecurityMatrixQuery.parse({ object: 'site_visit' }).sensitiveOnly).toBe(false);
  });

  it('refuses a missing or over-long object, and any programmeId (D-P9)', () => {
    expect(FieldSecurityMatrixQuery.safeParse({}).success).toBe(false);
    expect(FieldSecurityMatrixQuery.safeParse({ object: 'x'.repeat(65) }).success).toBe(false);
    expect(
      FieldSecurityMatrixQuery.safeParse({ object: 'site_visit', programmeId: 'p' }).success,
    ).toBe(false);
    expect(
      FieldSecurityMatrixQuery.safeParse({ object: 'site_visit', sensitiveOnly: 'yes' }).success,
    ).toBe(false);
  });
});

describe('FieldSecurityWriteBody', () => {
  const ok = { objectApiName: 'site_visit', version: 1, changes: [change] };

  it('accepts the spec shape', () => {
    expect(FieldSecurityWriteBody.parse(ok)).toEqual(ok);
  });

  it('refuses programmeId at the top and on a change', () => {
    expect(FieldSecurityWriteBody.safeParse({ ...ok, programmeId: 'p' }).success).toBe(false);
    expect(
      FieldSecurityWriteBody.safeParse({ ...ok, changes: [{ ...change, programmeId: 'p' }] })
        .success,
    ).toBe(false);
  });

  it('requires version, at least one change, at most 2000, and a known level', () => {
    expect(FieldSecurityWriteBody.safeParse({ ...ok, version: undefined }).success).toBe(false);
    expect(FieldSecurityWriteBody.safeParse({ ...ok, version: 1.5 }).success).toBe(false);
    expect(FieldSecurityWriteBody.safeParse({ ...ok, changes: [] }).success).toBe(false);
    expect(
      FieldSecurityWriteBody.safeParse({ ...ok, changes: [{ ...change, level: 'write' }] }).success,
    ).toBe(false);
    const many = Array.from({ length: 2001 }, (_unused, i) => ({
      ...change,
      fieldApiName: `f_${i}`,
    }));
    expect(FieldSecurityWriteBody.safeParse({ ...ok, changes: many }).success).toBe(false);
  });

  it('refuses the same cell twice in one save', () => {
    expect(
      FieldSecurityWriteBody.safeParse({ ...ok, changes: [change, { ...change, level: 'none' }] })
        .success,
    ).toBe(false);
  });
});

describe('toFieldSecurityMatrixResponse', () => {
  const matrix = {
    objectApiName: 'site_visit',
    version: 2,
    totalFieldCount: 1,
    rows: [
      {
        fieldApiName: 'priority',
        label: 'Priority',
        classification: 'none' as const,
        cells: [{ permissionSetId: 'agent', level: 'edit' as const, locked: false }],
      },
    ],
  };

  it('passes the spec shape through', () => {
    expect(toFieldSecurityMatrixResponse(matrix)).toEqual(matrix);
  });

  it('refuses to publish anything the spec does not name', () => {
    const leaky = { ...matrix, programmeId: 'p' };
    expect(() => toFieldSecurityMatrixResponse(leaky)).toThrow();
  });
});
