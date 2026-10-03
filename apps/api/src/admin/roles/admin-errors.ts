import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

/**
 * The error envelope of the admin API (`#/components/schemas/Error` in
 * docs/api/admin.openapi.yaml): `{ statusCode, error, code, message }`, plus
 * `details` on validation and `conflictingIds` on a hierarchy cycle.
 *
 * Applied with `@UseFilters` on the admin controllers ONLY. It deliberately
 * does not change the global behaviour the auth and contacts routes (and
 * their tests) depend on.
 *
 * What is NOT in this file matters as much: no database message, no submitted
 * value, and no identifier the caller did not send. A unique-violation text
 * names the conflicting row; a 404 that differs between "absent" and "another
 * tenant's" is an enumeration oracle.
 */

export type AdminErrorCode =
  | 'validation_failed'
  | 'not_authenticated'
  | 'not_permitted'
  | 'not_found'
  | 'duplicate_name'
  | 'stale_write'
  | 'role_hierarchy_cycle';

interface AdminErrorExtra {
  details?: { path: string; code: string }[];
  conflictingIds?: string[];
}

const REASON: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
};

export class AdminError extends HttpException {
  constructor(
    status: HttpStatus,
    code: AdminErrorCode,
    message: string,
    extra: AdminErrorExtra = {},
  ) {
    super(
      { statusCode: status, error: REASON[status] ?? 'Error', code, message, ...extra },
      status,
    );
  }
}

/** One body for: no such role, a role in another tenant, a malformed id. */
export const notFound = () => new AdminError(HttpStatus.NOT_FOUND, 'not_found', 'Not found');

/**
 * `NotPermitted`: the caller can already see the thing and may not perform this
 * action on it - e.g. a change to a padlocked permission set. Never used for
 * something the caller cannot see; that is `notFound`.
 */
export const notPermitted = () =>
  new AdminError(HttpStatus.FORBIDDEN, 'not_permitted', 'You do not have permission to do that.');

export const duplicateName = () =>
  new AdminError(HttpStatus.CONFLICT, 'duplicate_name', 'That name is already in use.', {
    details: [{ path: 'name', code: 'duplicate' }],
  });

export const staleWrite = () =>
  new AdminError(
    HttpStatus.CONFLICT,
    'stale_write',
    'Someone else saved changes while you were editing. Reload and try again.',
  );

/** `conflictingIds` must only ever contain ids the caller submitted. */
export const hierarchyCycle = (conflictingIds: string[]) =>
  new AdminError(
    HttpStatus.CONFLICT,
    'role_hierarchy_cycle',
    'A role cannot report to one of the roles beneath it.',
    { conflictingIds },
  );

const validationFailed = (details: { path: string; code: string }[] = []) =>
  new AdminError(HttpStatus.BAD_REQUEST, 'validation_failed', 'Validation failed', { details });

const notAuthenticated = () =>
  new AdminError(HttpStatus.UNAUTHORIZED, 'not_authenticated', 'Not authenticated');

/**
 * Maps everything an admin route can throw onto the envelope.
 *
 * Guards run inside the route's exception zone, so the stub guard's bare
 * `UnauthorizedException` and the scope-header `BadRequestException` arrive
 * here too and leave with a `code`. Any other status keeps its own body.
 */
@Catch(HttpException, ZodError)
export class AdminErrorFilter implements ExceptionFilter {
  catch(exception: HttpException | ZodError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = toAdminError(exception);
    response.status(mapped.getStatus()).json(mapped.getResponse());
  }
}

export function toAdminError(exception: HttpException | ZodError): HttpException {
  if (exception instanceof ZodError) {
    // Paths and reason codes only; never the submitted value.
    return validationFailed(
      exception.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
    );
  }
  if (exception instanceof AdminError) return exception;
  switch (exception.getStatus()) {
    case HttpStatus.BAD_REQUEST:
      return validationFailed();
    case HttpStatus.UNAUTHORIZED:
      return notAuthenticated();
    case HttpStatus.NOT_FOUND:
      return notFound();
    default:
      return exception;
  }
}
