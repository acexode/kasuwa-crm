import type { Programme } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { confirmationMismatch, validationFailed } from './programmes.errors';
import { toCreatedProgrammeResponse, toProgrammeResponse } from './programmes.presenter';
import { ArchiveProgrammeBody, CreateProgrammeBody } from './programmes.schemas';

const BU = '11111111-0000-4000-8000-0000000b0001';

function detailsOf(
  schema: typeof CreateProgrammeBody | typeof ArchiveProgrammeBody,
  input: unknown,
): { path: string; code: string }[] {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error('expected a validation failure');
  }
  const body = validationFailed(result.error).getResponse() as {
    details: { path: string; code: string }[];
  };
  return body.details;
}

const programme: Programme = {
  id: '11111111-0000-4000-8000-0000000c0001',
  businessUnitId: BU,
  name: 'Bank X Collections',
  clientName: null,
  isDefault: false,
  status: 'paused',
  version: 1,
};

describe('createProgramme boundary (T-0029)', () => {
  it('accepts the spec example and normalises an empty client name to null', () => {
    const parsed = CreateProgrammeBody.parse({
      name: '  Pesa Merchant Onboarding ',
      clientName: '',
      countryCode: 'KE',
      businessUnitId: BU,
    });
    expect(parsed).toMatchObject({ name: 'Pesa Merchant Onboarding', clientName: null });
  });

  it('refuses templates, a born status and every scope argument at their own paths', () => {
    expect(
      detailsOf(CreateProgrammeBody, { name: 'x', businessUnitId: BU, templateId: 'c' }),
    ).toEqual([{ path: 'templateId', code: 'not_supported' }]);
    for (const key of ['status', 'tenantId', 'programmeIds']) {
      expect(detailsOf(CreateProgrammeBody, { name: 'x', businessUnitId: BU, [key]: 'v' })).toEqual(
        [{ path: key, code: 'unrecognized_keys' }],
      );
    }
  });

  it('names the field for a bad country, unit or name, and never echoes the value', () => {
    expect(
      detailsOf(CreateProgrammeBody, { name: 'x', businessUnitId: BU, countryCode: 'ng' }),
    ).toEqual([{ path: 'countryCode', code: 'invalid_string' }]);
    expect(detailsOf(CreateProgrammeBody, { name: 'x', businessUnitId: 'nope' })[0]?.path).toBe(
      'businessUnitId',
    );
    const marker = 'ZZ-MARKER-'.padEnd(201, 'x');
    const details = detailsOf(CreateProgrammeBody, { name: marker, businessUnitId: BU });
    expect(details).toEqual([{ path: 'name', code: 'too_big' }]);
    expect(JSON.stringify(details)).not.toContain('ZZ-MARKER');
  });
});

describe('archiveProgramme boundary (T-0029)', () => {
  it('requires a confirmation, keeps it verbatim, and refuses extra keys', () => {
    expect(detailsOf(ArchiveProgrammeBody, {})[0]?.path).toBe('confirmation');
    expect(ArchiveProgrammeBody.parse({ confirmation: ' Name ' }).confirmation).toBe(' Name ');
    expect(detailsOf(ArchiveProgrammeBody, { confirmation: 'x', programmeIds: [] })).toEqual([
      { path: 'programmeIds', code: 'unrecognized_keys' },
    ]);
  });

  it('reports a mismatch at confirmation without either value', () => {
    expect(confirmationMismatch().getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'validation_failed',
      message: 'Validation failed',
      details: [{ path: 'confirmation', code: 'mismatch' }],
    });
  });
});

describe('programme presenter (T-0029)', () => {
  it('reports the status column, not a constant', () => {
    expect(toProgrammeResponse(programme).status).toBe('paused');
  });

  it('leaves the unstored countryCode out of the create response', () => {
    const created = toCreatedProgrammeResponse(programme);
    expect(created).not.toHaveProperty('countryCode');
    expect(created).toMatchObject({ id: programme.id, name: programme.name, status: 'paused' });
  });
});
