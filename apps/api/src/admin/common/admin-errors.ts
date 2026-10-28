import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import { InvalidCursorError } from '@kasuwa/domain-core';
import type { Response } from 'express';
import { ZodError, type z } from 'zod';
import { wireIssueCode, wireIssues } from '../../common/zod-issue-code';
import { SCOPE_HEADER_REJECTED_BODY } from '../../tenancy/auth-context';

/** True only for the guards' fixed scope-header body, compared field by field. */
function isScopeHeaderRefusal(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const { code, details } = body as { code?: unknown; details?: unknown };
  const [expected] = SCOPE_HEADER_REJECTED_BODY.details;
  if (code !== SCOPE_HEADER_REJECTED_BODY.code || !Array.isArray(details)) return false;
  if (details.length !== 1) return false;
  const [detail] = details as { path?: unknown; code?: unknown }[];
  return detail?.path === expected.path && detail.code === expected.code;
}

/**
 * The error envelope of the whole admin API (`#/components/schemas/Error` in
 * docs/api/admin.openapi.yaml): `{ statusCode, error, code, message }`, plus
 * `details` on validation and the conflict codes. One file for every admin
 * area (D-L39); an area adds its own constructors (see roles' `hierarchyCycle`)
 * on top of `AdminError`, never a second envelope.
 *
 * Applied to admin controllers ONLY, through `@AdminController`. It does not
 * change the global behaviour the auth and contacts routes depend on.
 *
 * What is NOT in this file matters as much: no database message, no submitted
 * value, and no identifier the caller did not send. A unique-violation text
 * names the conflicting row; a 404 that differs between "absent" and "another
 * tenant's" is an enumeration oracle.
 */

/** The spec's `Error.code` enum, verbatim. */
export type AdminErrorCode =
  | 'validation_failed'
  | 'not_authenticated'
  | 'not_permitted'
  | 'not_found'
  | 'duplicate_name'
  | 'duplicate_code'
  /** admin.openapi.yaml (T-0088): a custom-field limit (T-0089). */
  | 'limit_reached'
  | 'stale_write'
  | 'role_hierarchy_cycle'
  | 'role_in_use'
  | 'legal_hold_active'
  /** scripting.openapi.yaml (T-0112): a draft that is not complete enough to publish (T-0113). */
  | 'script_invalid'
  /** scripting.openapi.yaml (T-0112): the run operations' conflicts (T-0114). */
  | 'script_not_published'
  | 'run_completed'
  | 'run_stopped'
  | 'run_at_end'
  | 'compliance_unacknowledged'
  | 'answers_incomplete'
  | 'disposition_not_live'
  | 'disposition_requirements_unmet'
  /** records.openapi.yaml (T-0105): moveDeal's conflicts (T-0108). */
  | 'transition_not_allowed'
  | 'requirements_unmet'
  /** commerce.openapi.yaml (T-0165): setQuoteStatus / updateQuote. */
  | 'invalid_transition'
  | 'not_editable'
  /** commerce.openapi.yaml (T-0165 / D-L211): product with no book entry. */
  | 'no_price'
  /** commerce.openapi.yaml (T-0166): discount approval request / decide. */
  | 'below_threshold'
  | 'no_approval_rule'
  | 'already_pending'
  | 'not_pending'
  | 'not_draft'
  /** records.openapi.yaml (T-0093): the import operations' conflicts (T-0094). */
  | 'import_status_conflict'
  | 'upload_mismatch'
  /** records.openapi.yaml (T-0093): createContactMerge and undoContactMerge (T-0095). */
  | 'already_merged'
  | 'undo_expired'
  | 'too_many_requests'
  | 'not_implemented'
  | 'service_unavailable'
  | 'internal_error';

export interface AdminErrorDetail {
  path: string;
  code: string;
}

export interface AdminErrorExtra {
  details?: AdminErrorDetail[];
  /** Only ever ids the caller submitted. */
  conflictingIds?: string[];
}

const REASON: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.GONE]: 'Gone',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
  [HttpStatus.NOT_IMPLEMENTED]: 'Not Implemented',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
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

export const notAuthenticated = (): AdminError =>
  new AdminError(HttpStatus.UNAUTHORIZED, 'not_authenticated', 'Not authenticated');

/**
 * THE one 404 body. Use it for: no such record, another tenant's record, a
 * sibling programme's record, and an id that is not even well-formed. Never
 * add the id, the type of record, or a reason - each one is an oracle.
 */
export const notFound = (): AdminError =>
  new AdminError(HttpStatus.NOT_FOUND, 'not_found', 'Not found');

/**
 * `NotPermitted`: narrow, and never a substitute for `notFound`. The caller can
 * already see the thing and may not perform this action on it - e.g. a change
 * to a padlocked permission set (T-0026). If unsure, it is `notFound`.
 */
export const notPermitted = (): AdminError =>
  new AdminError(HttpStatus.FORBIDDEN, 'not_permitted', 'You do not have permission to do that.');

export const staleWrite = (): AdminError =>
  new AdminError(
    HttpStatus.CONFLICT,
    'stale_write',
    'Someone else saved changes while you were editing. Reload and try again.',
  );

/** Field path only. Never the conflicting row, never the database's text. */
export const duplicateName = (message = 'That name is already in use.'): AdminError =>
  new AdminError(HttpStatus.CONFLICT, 'duplicate_name', message, {
    details: [{ path: 'name', code: 'duplicate' }],
  });

/**
 * The most `details` one error carries (T-0113 security review). A body with
 * 100,000 bad elements must not become a 100,000-entry response: the first
 * 50, in the order they were found (Zod's issue order, which follows the
 * body), and nothing more. The order is deterministic, so a client fixing
 * them one by one sees the same list each time.
 */
export const MAX_ERROR_DETAILS = 50;

export const validationFailed = (details: readonly AdminErrorDetail[] = []): AdminError =>
  new AdminError(HttpStatus.BAD_REQUEST, 'validation_failed', 'Validation failed', {
    details: details.slice(0, MAX_ERROR_DETAILS),
  });

/** The spec has no `invalid_cursor` code; a bad cursor is `validation_failed` at `cursor`. */
export const invalidCursor = (): AdminError =>
  validationFailed([{ path: 'cursor', code: 'invalid_cursor' }]);

/** Paths and reason codes only - never the submitted value, never Zod's message. */
export const validationFailedFrom = (error: ZodError): AdminError => {
  // Stop building details at the cap, rather than mapping every issue first.
  const details: AdminErrorDetail[] = [];
  for (const issue of wireIssues(error.issues)) {
    for (const detail of toDetails(issue)) {
      if (details.length >= MAX_ERROR_DETAILS) return validationFailed(details);
      details.push(detail);
    }
  }
  return validationFailed(details);
};

/**
 * An unexpected key is reported at its own path, so `{ programmeIds: [...] }`
 * names `programmeIds` rather than the root. A custom issue may carry a stable
 * `params.reason`, which becomes the code.
 */
export function toDetails(issue: z.core.$ZodIssue): AdminErrorDetail[] {
  const base = issue.path.map(String);
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({ path: [...base, key].join('.'), code: issue.code }));
  }
  const reason: unknown = issue.code === 'custom' ? issue.params?.['reason'] : undefined;
  return [
    { path: base.join('.'), code: typeof reason === 'string' ? reason : wireIssueCode(issue) },
  ];
}

/**
 * Maps everything an admin route can throw onto the envelope.
 *
 * Guards run inside the route's exception zone, so the stub guard's bare
 * `UnauthorizedException`, the session guard's `AuthError` and the
 * scope-header `BadRequestException` arrive here too and leave with a `code`
 * and no echo of their message. Any other status keeps its own body; a
 * non-HTTP error is not caught here: it falls through to the global
 * `UnexpectedErrorFilter` (T-0036), which answers the fixed `internal_error`
 * 500 and logs only the error's class, code and route template.
 */
export function toAdminError(
  exception: HttpException | ZodError | InvalidCursorError,
): HttpException {
  if (exception instanceof ZodError) return validationFailedFrom(exception);
  if (exception instanceof InvalidCursorError) return invalidCursor();
  if (exception instanceof AdminError) return exception;
  switch (exception.getStatus()) {
    case HttpStatus.BAD_REQUEST:
      // The auth guards' scope-header refusal (D-L63) keeps its one fixed
      // detail. Matched by value, so nothing the request sent can ride along:
      // the header name and value are never in the body.
      return isScopeHeaderRefusal(exception.getResponse())
        ? validationFailed([...SCOPE_HEADER_REJECTED_BODY.details])
        : validationFailed();
    case HttpStatus.UNAUTHORIZED:
      return notAuthenticated();
    case HttpStatus.NOT_FOUND:
      return notFound();
    default:
      return exception;
  }
}

@Catch(HttpException, ZodError, InvalidCursorError)
export class AdminErrorFilter implements ExceptionFilter {
  catch(exception: HttpException | ZodError | InvalidCursorError, host: ArgumentsHost): void {
    const mapped = toAdminError(exception);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(mapped.getStatus())
      .json(mapped.getResponse());
  }
}
