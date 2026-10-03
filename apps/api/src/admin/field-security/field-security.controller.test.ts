import type { ArgumentsHost } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AdminNotAuthenticatedFilter } from './admin-not-authenticated.filter';
import { toFieldSecurityObjectList } from './field-security.controller';

function recordingHost(): { host: ArgumentsHost; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const response = {
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

describe('AdminNotAuthenticatedFilter', () => {
  it('turns a bare 401 into the contract’s Error envelope', () => {
    const { host, sent } = recordingHost();
    new AdminNotAuthenticatedFilter().catch(new UnauthorizedException('Not authenticated'), host);

    expect(sent.status).toBe(401);
    expect(sent.body).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      code: 'not_authenticated',
      message: 'Not authenticated',
    });
  });

  it('gives one body whatever the original message said', () => {
    // The 401 is deliberately uninformative; a detail in the thrown message
    // (which token check failed, which tenant) must not reach the client.
    const a = recordingHost();
    const b = recordingHost();
    new AdminNotAuthenticatedFilter().catch(new UnauthorizedException('session revoked'), a.host);
    new AdminNotAuthenticatedFilter().catch(new UnauthorizedException(), b.host);
    expect(a.sent.body).toEqual(b.sent.body);
  });
});

describe('toFieldSecurityObjectList', () => {
  it('renames to the published field names and keeps a zero count', () => {
    expect(
      toFieldSecurityObjectList([
        { apiName: 'branch_audit', label: 'Branch audit', fieldCount: 0 },
        { apiName: 'site_visit', label: 'Site visit', fieldCount: 3 },
      ]),
    ).toEqual({
      items: [
        { objectApiName: 'branch_audit', label: 'Branch audit', fieldCount: 0 },
        { objectApiName: 'site_visit', label: 'Site visit', fieldCount: 3 },
      ],
    });
  });

  it('publishes nothing but the three fields, even if a summary carries more', () => {
    const leaky = {
      apiName: 'site_visit',
      label: 'Site visit',
      fieldCount: 3,
      id: '11111111-0000-4000-8000-0000002300a1',
      tenantId: '11111111-0000-4000-8000-000000000001',
    };
    const list = toFieldSecurityObjectList([leaky]);
    expect(Object.keys(list.items[0] ?? {}).sort()).toEqual([
      'fieldCount',
      'label',
      'objectApiName',
    ]);
  });

  it('is an empty list, not an error, for a tenant with no objects', () => {
    expect(toFieldSecurityObjectList([])).toEqual({ items: [] });
  });
});
