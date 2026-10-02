import { describe, expect, it } from 'vitest';
import { validationFailed } from './programmes.errors';
import { initialsOf } from './programmes.presenter';
import { ListProgrammesQuery, UpdateProgrammeBody } from './programmes.schemas';

function detailsOf(
  schema: typeof UpdateProgrammeBody | typeof ListProgrammesQuery,
  input: unknown,
) {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error('expected a validation failure');
  }
  return (validationFailed(result.error).getResponse() as { details: unknown[] }).details;
}

describe('programmes boundary (T-0024)', () => {
  it('names an unexpected scope key at its own path, not the root', () => {
    expect(detailsOf(UpdateProgrammeBody, { version: 1, programmeIds: ['x'] })).toEqual([
      { path: 'programmeIds', code: 'unrecognized_keys' },
    ]);
    expect(detailsOf(ListProgrammesQuery, { programmeIds: 'x' })).toEqual([
      { path: 'programmeIds', code: 'unrecognized_keys' },
    ]);
  });

  it('refuses any status change while no lifecycle column exists', () => {
    for (const status of ['active', 'paused', 'archived', null]) {
      expect(detailsOf(UpdateProgrammeBody, { version: 1, status })).toEqual([
        { path: 'status', code: 'not_supported' },
      ]);
    }
  });

  it('never echoes the submitted value', () => {
    const marker = 'ZZ-MARKER-'.padEnd(201, 'x');
    const details = detailsOf(UpdateProgrammeBody, { version: 1, name: marker });
    expect(details).toEqual([{ path: 'name', code: 'too_big' }]);
    expect(JSON.stringify(details)).not.toContain('ZZ-MARKER');
  });

  it('requires an integer version and bounds pageSize to 1..200', () => {
    expect(detailsOf(UpdateProgrammeBody, { name: 'x' })).toEqual([
      { path: 'version', code: 'invalid_type' },
    ]);
    expect(UpdateProgrammeBody.safeParse({ version: 1.5 }).success).toBe(false);
    expect(ListProgrammesQuery.parse({}).pageSize).toBe(50);
    expect(ListProgrammesQuery.safeParse({ pageSize: '200' }).success).toBe(true);
    for (const pageSize of ['0', '201', 'ten']) {
      expect(ListProgrammesQuery.safeParse({ pageSize }).success, pageSize).toBe(false);
    }
  });

  it('derives initials from the first and last words, by code point', () => {
    expect(initialsOf('Ngozi Okeke')).toBe('NO');
    expect(initialsOf('  musa  ibrahim bello ')).toBe('MB');
    expect(initialsOf('Tunde')).toBe('T');
    expect(initialsOf('')).toBe('');
    expect(initialsOf('\u{1D49C}da Obi')).toBe('\u{1D49C}O');
  });
});
