import { HttpException, HttpStatus } from '@nestjs/common';
import type { ZodError } from 'zod';
import { toDetails } from '../programmes/programmes.errors';

/**
 * The admin `Error` envelope for the portal-users routes (T-0030).
 *
 * Local because the shared admin envelope (D-L39, the admin-wave prep PR) has
 * not landed on main yet; once it has, these constructors are replaced by the
 * shared ones and this file goes. Same body shape either way.
 *
 * Nothing here carries the submitted address, the token, a row id or database
 * text.
 */

type PortalErrorCode = 'validation_failed' | 'not_found' | 'duplicate_name' | 'service_unavailable';

const REASON: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
};

export class PortalAdminError extends HttpException {
  constructor(
    status: HttpStatus,
    code: PortalErrorCode,
    message: string,
    details?: { path: string; code: string }[],
  ) {
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

/** THE one 404 body: absent, another tenant's, an unassigned sibling's, or not a uuid. */
export const portalNotFound = (): PortalAdminError =>
  new PortalAdminError(HttpStatus.NOT_FOUND, 'not_found', 'Not found');

/** Paths and reason codes only - never the submitted value, never Zod's message. */
export const portalValidationFailed = (error: ZodError): PortalAdminError =>
  new PortalAdminError(
    HttpStatus.BAD_REQUEST,
    'validation_failed',
    'Validation failed',
    error.issues.flatMap(toDetails),
  );

/**
 * The address already belongs to an active or suspended portal user of this
 * programme. The spec lists 409 for this operation but names no code for it;
 * `duplicate_name` at path `email` is the nearest in the enum (raised in the
 * T-0030 report). Never names the row or the address.
 */
export const portalAlreadyMember = (): PortalAdminError =>
  new PortalAdminError(
    HttpStatus.CONFLICT,
    'duplicate_name',
    'That address already has access to this programme.',
    [{ path: 'email', code: 'duplicate' }],
  );

/** The invitation could not be handed to the channel provider. Nothing was saved. */
export const portalSendUnavailable = (): PortalAdminError =>
  new PortalAdminError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'service_unavailable',
    'The invitation could not be sent. Try again shortly.',
  );
