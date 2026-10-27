import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { notFound } from '../common/admin-errors';
import { parseOr400 as parseBody } from '../common/admin-input';
import { duplicateCode, incompleteOrder } from './dispositions.errors';
import { toDispositionListResponse } from './dispositions.presenter';
import {
  DispositionOrderBody,
  DispositionParams,
  DispositionPatchBody,
  DispositionWriteBody,
  ListProgrammeScriptsQuery,
} from './dispositions.schemas';

function detailsOf(schema: z.ZodType, input: unknown): unknown {
  try {
    parseBody(schema, input);
  } catch (error) {
    return (error as { getResponse(): { details: unknown } }).getResponse().details;
  }
  throw new Error('expected a validation failure');
}

const valid = { code: 'PTP_1', label: 'Promise to pay', category: 'promise_to_pay' };

describe('dispositions boundary (T-0027)', () => {
  it('applies the DispositionWrite defaults', () => {
    expect(DispositionWriteBody.parse(valid)).toEqual({
      ...valid,
      noteRequired: false,
      followUpRequired: false,
    });
  });

  it('enforces the code pattern and length, naming `code`', () => {
    for (const code of ['', 'lower', 'HAS SPACE', 'A'.repeat(17), 'DASH-ED']) {
      const paths = (detailsOf(DispositionWriteBody, { ...valid, code }) as { path: string }[]).map(
        (detail) => detail.path,
      );
      expect(paths.length, code).toBeGreaterThan(0);
      expect(new Set(paths), code).toEqual(new Set(['code']));
    }
    expect(DispositionWriteBody.safeParse({ ...valid, code: 'A'.repeat(16) }).success).toBe(true);
  });

  it('names a scope or server-owned key at its own path, in every body', () => {
    expect(detailsOf(DispositionWriteBody, { ...valid, programmeId: 'x' })).toEqual([
      { path: 'programmeId', code: 'unrecognized_keys' },
    ]);
    expect(detailsOf(DispositionWriteBody, { ...valid, position: 1 })).toEqual([
      { path: 'position', code: 'unrecognized_keys' },
    ]);
    for (const key of ['code', 'position', 'programmeId']) {
      expect(detailsOf(DispositionPatchBody, { [key]: 'x' }), key).toEqual([
        { path: key, code: 'unrecognized_keys' },
      ]);
    }
    expect(detailsOf(DispositionOrderBody, { dispositionIds: [], programmeId: 'x' })).toEqual([
      { path: 'programmeId', code: 'unrecognized_keys' },
    ]);
  });

  it('never echoes the submitted value', () => {
    const marker = 'ZZ-MARKER-'.padEnd(121, 'x');
    const details = detailsOf(DispositionWriteBody, { ...valid, label: marker });
    expect(JSON.stringify(details)).not.toContain('ZZ-MARKER');
  });

  it('accepts UUIDv7 ids, as newId() issues them', () => {
    const v7 = '01923f4e-5b6c-7d8e-9f01-23456789abcd';
    expect(DispositionParams.safeParse({ programmeId: v7, dispositionId: v7 }).success).toBe(true);
    expect(DispositionOrderBody.safeParse({ dispositionIds: [v7] }).success).toBe(true);
    expect(DispositionOrderBody.safeParse({ dispositionIds: ['one'] }).success).toBe(false);
  });

  it('bounds the scripts pageSize to 1..200', () => {
    expect(ListProgrammeScriptsQuery.parse({}).pageSize).toBe(50);
    for (const pageSize of ['0', '201', 'ten']) {
      expect(detailsOf(ListProgrammeScriptsQuery, { pageSize }), pageSize).toEqual([
        expect.objectContaining({ path: 'pageSize' }),
      ]);
    }
  });

  it('keeps conflict and order errors free of identifiers', () => {
    expect(duplicateCode().getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'duplicate_code',
      message: expect.any(String),
      details: [{ path: 'code', code: 'duplicate' }],
    });
    expect(incompleteOrder().getResponse()).toMatchObject({
      statusCode: 400,
      code: 'validation_failed',
      details: [{ path: 'dispositionIds', code: 'not_complete_list' }],
    });
    expect(notFound().getResponse()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      code: 'not_found',
      message: 'Not found',
    });
  });

  it('reports usage as unknown (null), never zero', () => {
    const list = toDispositionListResponse([
      {
        id: '01923f4e-5b6c-7d8e-9f01-23456789abcd',
        code: 'PTP',
        label: 'Promise to pay',
        category: 'promise_to_pay',
        noteRequired: false,
        followUpRequired: false,
        active: true,
        position: 1,
      },
    ]);
    expect(list.usageWindowDays).toBe(90);
    expect(list.items[0]?.usageCount90d).toBeNull();
    expect(list.items[0]).not.toHaveProperty('tenantId');
  });
});
