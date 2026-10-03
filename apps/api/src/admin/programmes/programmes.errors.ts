import { HttpException, HttpStatus } from '@nestjs/common';
import type { ZodError, ZodIssue } from 'zod';

/**
 * The `Error` envelope of docs/api/admin.openapi.yaml, for the programmes
 * routes (T-0024). Same shape as `AuthError`; a separate class because the
 * code vocabulary is the admin contract's, not the auth contract's.
 *
 * Local to these routes on purpose: the global filters, and therefore every
 * existing route's error body, are untouched.
 */

type AdminErrorCode = 'validation_failed' | 'not_found' | 'stale_write' | 'duplicate_name';

interface ErrorDetail {
  path: string;
  code: string;
}

const REASON: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
};

export class AdminError extends HttpException {
  constructor(status: HttpStatus, code: AdminErrorCode, message: string, details?: ErrorDetail[]) {
    super(
      {
        statusCode: status,
        error: REASON[status] ?? 'Error',
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
      status,
    );
  }
}

/**
 * One body, byte for byte, for: no such programme, another tenant's, a
 * sibling the caller is not assigned to, and an id that is not a uuid at all.
 */
export function notFound(): AdminError {
  return new AdminError(HttpStatus.NOT_FOUND, 'not_found', 'Not found');
}

export function staleWrite(): AdminError {
  return new AdminError(
    HttpStatus.CONFLICT,
    'stale_write',
    'Someone else saved changes while you were editing. Reload and try again.',
  );
}

/** Field path only. Never the conflicting row, never the database's text. */
export function duplicateName(): AdminError {
  return new AdminError(
    HttpStatus.CONFLICT,
    'duplicate_name',
    'That name is already in use in this workspace.',
    [{ path: 'name', code: 'duplicate' }],
  );
}

/**
 * `confirmation` was not the programme's exact name. Path and reason only —
 * neither the submitted text nor the name is echoed.
 */
export function confirmationMismatch(): AdminError {
  return new AdminError(HttpStatus.BAD_REQUEST, 'validation_failed', 'Validation failed', [
    { path: 'confirmation', code: 'mismatch' },
  ]);
}

export function invalidCursor(): AdminError {
  return new AdminError(HttpStatus.BAD_REQUEST, 'validation_failed', 'Validation failed', [
    { path: 'cursor', code: 'invalid_cursor' },
  ]);
}

/**
 * Paths and reason codes only — never the submitted value, never Zod's
 * message (which can quote it). An unexpected key is reported at its own path,
 * so `{ programmeIds: [...] }` names `programmeIds` rather than the root.
 */
export function validationFailed(error: ZodError): AdminError {
  return new AdminError(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    error.issues.flatMap(toDetails),
  );
}

export function toDetails(issue: ZodIssue): ErrorDetail[] {
  const base = issue.path.map(String);
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({ path: [...base, key].join('.'), code: issue.code }));
  }
  const reason: unknown = issue.code === 'custom' ? issue.params?.['reason'] : undefined;
  return [{ path: base.join('.'), code: typeof reason === 'string' ? reason : issue.code }];
}
