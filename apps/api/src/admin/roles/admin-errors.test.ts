import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { duplicateName, hierarchyCycle, notFound, toAdminError } from './admin-errors';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

  it('reports Zod failures by path and reason only, never by value', () => {
    const parsed = z.object({ name: z.string().max(3) }).safeParse({ name: 'secret-value' });
    if (parsed.success) throw new Error('expected a parse failure');
    const body = toAdminError(parsed.error).getResponse();
    expect(body).toMatchObject({ statusCode: 400, code: 'validation_failed' });
    expect(JSON.stringify(body)).not.toContain('secret-value');
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
});
