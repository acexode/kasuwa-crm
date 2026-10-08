import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InvalidCursorError } from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { notAuthenticated as authNotAuthenticated } from '../../auth/auth.errors';
import { hierarchyCycle } from '../roles/roles.errors';
import {
  AdminErrorFilter,
  duplicateName,
  MAX_ERROR_DETAILS,
  notFound,
  toAdminError,
  validationFailed,
  validationFailedFrom,
} from './admin-errors';
import { foundOr404, parseIdOr404, parseOr400 } from './admin-input';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

describe('admin error envelope', () => {
  it('gives the guard’s bare 401 and the scope-header 400 a stable code', () => {
    expect(toAdminError(new UnauthorizedException('Not authenticated')).getResponse()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      code: 'not_authenticated',
      message: 'Not authenticated',
    });
    const scope = toAdminError(new BadRequestException('Request carried x-kasuwa-scope'));
    expect(scope.getStatus()).toBe(400);
    expect(scope.getResponse()).toMatchObject({ code: 'validation_failed' });
    // The guard's message is not echoed: it is not part of the contract.
    expect(JSON.stringify(scope.getResponse())).not.toContain('x-kasuwa-scope');
  });

  it('answers the session guard’s AuthError with the same 401 body as the stub guard’s', () => {
    expect(toAdminError(authNotAuthenticated()).getResponse()).toEqual(
      toAdminError(new UnauthorizedException()).getResponse(),
    );
  });

  it('reports Zod failures by path and reason only, never by value', () => {
    const parsed = z.object({ name: z.string().max(3) }).safeParse({ name: 'secret-value' });
    if (parsed.success) throw new Error('expected a parse failure');
    const body = toAdminError(parsed.error).getResponse();
    expect(body).toMatchObject({ statusCode: 400, code: 'validation_failed' });
    expect(JSON.stringify(body)).not.toContain('secret-value');
  });

  it('names an unexpected scope key at its own path, not the root', () => {
    const parsed = z
      .object({ name: z.string() })
      .strict()
      .safeParse({ name: 'x', programmeId: 'p' });
    if (parsed.success) throw new Error('expected a parse failure');
    expect(validationFailedFrom(parsed.error).getResponse()).toMatchObject({
      details: [{ path: 'programmeId', code: 'unrecognized_keys' }],
    });
  });

  it('turns a bad cursor into validation_failed at `cursor`, not the global invalid_cursor', () => {
    expect(toAdminError(new InvalidCursorError()).getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'validation_failed',
      message: 'Validation failed',
      details: [{ path: 'cursor', code: 'invalid_cursor' }],
    });
  });

  it('uses one 404 body however the record came to be unreachable', () => {
    expect(toAdminError(new NotFoundException('Role 1234 in tenant X')).getResponse()).toEqual(
      notFound().getResponse(),
    );
  });

  it('names no row on a duplicate, and only the given ids on a cycle', () => {
    expect(JSON.stringify(duplicateName().getResponse())).not.toMatch(UUID);
    expect(hierarchyCycle(['a', 'b']).getResponse()).toMatchObject({
      statusCode: 409,
      code: 'role_hierarchy_cycle',
      conflictingIds: ['a', 'b'],
    });
  });

  it('writes the mapped status and body, one body whatever the 401 said', () => {
    const a = recordingHost();
    const b = recordingHost();
    new AdminErrorFilter().catch(new UnauthorizedException('session revoked'), a.host);
    new AdminErrorFilter().catch(new UnauthorizedException(), b.host);
    expect(a.sent.status).toBe(401);
    expect(a.sent.body).toEqual(b.sent.body);
  });
});

describe('admin input helpers', () => {
  const Id = z.object({ id: z.string().uuid() });

  it('answers a malformed id and a missing row with the same 404 body', () => {
    const malformed = (() => {
      try {
        parseIdOr404(Id, { id: 'not-a-uuid' });
      } catch (error) {
        return error;
      }
      throw new Error('expected a throw');
    })();
    const missing = (() => {
      try {
        foundOr404(null);
      } catch (error) {
        return error;
      }
      throw new Error('expected a throw');
    })();
    expect(malformed).toEqual(notFound());
    expect(missing).toEqual(notFound());
    expect(foundOr404(0)).toBe(0);
  });

  it('answers a malformed body with 400 validation_failed', () => {
    expect(() => parseOr400(Id, {})).toThrowError(
      expect.objectContaining({ status: 400 }) as Error,
    );
    expect(parseOr400(Id, { id: '11111111-0000-4000-8000-000000000001' })).toEqual({
      id: '11111111-0000-4000-8000-000000000001',
    });
  });
});

describe('the details cap (T-0113 security review)', () => {
  it('validationFailed keeps the first MAX_ERROR_DETAILS details, in order', () => {
    const details = Array.from({ length: 120 }, (_, index) => ({
      path: `items.${index}`,
      code: 'invalid_type',
    }));
    const body = validationFailed(details).getResponse() as { details: unknown[] };
    expect(body.details).toEqual(details.slice(0, MAX_ERROR_DETAILS));
  });

  it('validationFailedFrom stops at the cap, whatever the number of issues', () => {
    const result = z.array(z.string()).safeParse(Array.from({ length: 100_000 }, () => 1));
    if (result.success) throw new Error('expected a failure');
    const started = performance.now();
    const body = validationFailedFrom(result.error).getResponse() as {
      details: { path: string }[];
    };
    expect(body.details).toHaveLength(MAX_ERROR_DETAILS);
    expect(body.details[0]?.path).toBe('0');
    expect(body.details[MAX_ERROR_DETAILS - 1]?.path).toBe(String(MAX_ERROR_DETAILS - 1));
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('an unrecognized-keys issue over the cap is capped too', () => {
    const keys = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`k${index}`, 1]));
    const result = z.object({}).strict().safeParse(keys);
    if (result.success) throw new Error('expected a failure');
    const body = validationFailedFrom(result.error).getResponse() as { details: unknown[] };
    expect(body.details).toHaveLength(MAX_ERROR_DETAILS);
  });
});
