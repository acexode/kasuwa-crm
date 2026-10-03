import { describe, expect, it } from 'vitest';
import { validationFailedFrom } from '../common/admin-errors';
import { CreateAuditExportBody, ListAuditEventsQuery } from './audit.schemas';

function pathsOf(
  schema: typeof ListAuditEventsQuery | typeof CreateAuditExportBody,
  input: unknown,
) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('expected a validation failure');
  const body = validationFailedFrom(result.error).getResponse() as {
    details: { path: string; code: string }[];
  };
  return body.details.map((detail) => detail.path);
}

describe('ListAuditEventsQuery', () => {
  it('defaults pageSize to 50 and accepts an empty query', () => {
    expect(ListAuditEventsQuery.parse({}).pageSize).toBe(50);
  });

  it.each([
    [{ pageSize: '0' }, 'pageSize'],
    [{ pageSize: '201' }, 'pageSize'],
    [{ pageSize: 'ten' }, 'pageSize'],
    [{ action: 'nuked' }, 'action'],
    [{ actorId: 'not-a-uuid' }, 'actorId'],
    [{ from: 'yesterday' }, 'from'],
    [{ to: '2026-13-45' }, 'to'],
    [{ to: '2026-02-30T00:00:00Z' }, 'to'],
    [{ objectType: 'x'.repeat(65) }, 'objectType'],
    [{ sourceIpPrefix: '1'.repeat(46) }, 'sourceIpPrefix'],
    [{ programmeIds: '99999999-0000-4000-8000-000000000003' }, 'programmeIds'],
  ])('refuses %j at %s', (query, path) => {
    expect(pathsOf(ListAuditEventsQuery, query)).toContain(path);
  });

  it('accepts a UTC instant with fractional seconds', () => {
    expect(ListAuditEventsQuery.parse({ from: '2026-09-01T00:00:00.000Z' }).from).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });
});

describe('CreateAuditExportBody', () => {
  it('defaults includeIpAddresses to false', () => {
    expect(
      CreateAuditExportBody.parse({ format: 'csv', scope: 'last_90_days' }).includeIpAddresses,
    ).toBe(false);
  });

  it.each([
    [{ scope: 'filtered' }, 'format'],
    [{ format: 'xlsx', scope: 'filtered' }, 'format'],
    [{ format: 'csv', scope: 'all' }, 'scope'],
    [{ format: 'csv', scope: 'filtered', includeIpAddresses: 'yes' }, 'includeIpAddresses'],
    [{ format: 'csv', scope: 'filtered', programmeIds: [] }, 'programmeIds'],
    [{ format: 'csv', scope: 'filtered', filters: { tenantId: 'x' } }, 'filters.tenantId'],
    // Free text would land in an event every tenant user can read.
    [
      { format: 'csv', scope: 'filtered', filters: { objectType: 'call me' } },
      'filters.objectType',
    ],
    [{ format: 'csv', scope: 'last_90_days', filters: { action: 'created' } }, 'filters'],
  ])('refuses %j at %s', (body, path) => {
    expect(pathsOf(CreateAuditExportBody, body)).toContain(path);
  });
});
