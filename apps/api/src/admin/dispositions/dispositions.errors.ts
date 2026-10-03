import { HttpStatus } from '@nestjs/common';
import type { z, ZodError } from 'zod';
import { toDetails } from '../programmes/programmes.errors';
import { AdminError } from '../roles/admin-errors';

/**
 * The dispositions routes' errors, on the admin `Error` envelope.
 *
 * Built on the roles `AdminError` because these controllers use the roles
 * `AdminErrorFilter` (which gives the guard's bare 401 and scope-header 400
 * their `code`), and that filter passes an `AdminError` through untouched but
 * flattens any other 400 to an empty `validation_failed`. Details come from the
 * programmes `toDetails`, which reports an unexpected key at its own path.
 *
 * Never the submitted value, never a database message, never an identifier.
 */

/** One body for every unreachable programme or disposition, and a malformed id. */
export function notFound(): AdminError {
  return new AdminError(HttpStatus.NOT_FOUND, 'not_found', 'Not found');
}

export function validationFailed(error: ZodError): AdminError {
  return new AdminError(HttpStatus.BAD_REQUEST, 'validation_failed', 'Validation failed', {
    details: error.issues.flatMap(toDetails),
  });
}

/** The field and nothing else — the clash may be with a deleted row (D-L47). */
export function duplicateCode(): AdminError {
  return new AdminError(
    HttpStatus.CONFLICT,
    'duplicate_code',
    'That code is already used in this programme.',
    { details: [{ path: 'code', code: 'duplicate' }] },
  );
}

/** A reorder that is not exactly the programme's live list, each id once. */
export function incompleteOrder(): AdminError {
  return new AdminError(HttpStatus.BAD_REQUEST, 'validation_failed', 'Validation failed', {
    details: [{ path: 'dispositionIds', code: 'not_complete_list' }],
  });
}

/** Parses a body or query, or throws the `validation_failed` envelope. */
export function parseBody<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationFailed(result.error);
  }
  return result.data as z.output<S>;
}

export function invalidCursor(): AdminError {
  return new AdminError(HttpStatus.BAD_REQUEST, 'validation_failed', 'Validation failed', {
    details: [{ path: 'cursor', code: 'invalid_cursor' }],
  });
}
