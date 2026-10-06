import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { toAdminError } from '../admin/common/admin-errors';
import { FORBIDDEN_SCOPE_HEADERS } from './auth-context';
import { StubAuthGuard } from './stub-auth.guard';

const contextWith = (headers: Record<string, string>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

describe('StubAuthGuard scope headers (D-L63)', () => {
  it.each(FORBIDDEN_SCOPE_HEADERS)(
    'refuses %s with the shared validation_failed envelope, echoing nothing',
    (header) => {
      const value = '11111111-0000-4000-8000-0000000c0002';
      let thrown: unknown;
      try {
        new StubAuthGuard().canActivate(contextWith({ [header]: value }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
      const body = (thrown as BadRequestException).getResponse();
      expect(body).toMatchObject({
        statusCode: 400,
        error: 'Bad Request',
        code: 'validation_failed',
        message: 'Validation failed',
      });
      expect(JSON.stringify(body)).not.toContain(value);
      expect(JSON.stringify(body)).not.toContain(header);

      // Through the shared envelope filter (contacts and admin routes): the
      // fixed detail survives, and still nothing the request sent.
      const mapped = toAdminError(thrown as BadRequestException).getResponse();
      expect(mapped).toMatchObject({
        code: 'validation_failed',
        details: [{ path: 'headers', code: 'scope_header_not_accepted' }],
      });
      expect(JSON.stringify(mapped)).not.toContain(value);
      expect(JSON.stringify(mapped)).not.toContain(header);
    },
  );

  it('does not let any other 400 borrow the scope-header detail', () => {
    const other = toAdminError(
      new BadRequestException({ code: 'validation_failed', details: [{ path: 'x', code: 'y' }] }),
    ).getResponse();
    expect(other).toMatchObject({ code: 'validation_failed', details: [] });
  });
});
