import { HttpStatus } from '@nestjs/common';
import { AdminError } from '../common/admin-errors';

/**
 * The portal-users area's own constructors on top of the shared admin
 * envelope (D-L39). Neither carries the submitted address, the token, a row id
 * or database text.
 */

/**
 * The address already belongs to an active or suspended portal user of this
 * programme. The spec lists 409 for this operation but names no code for it;
 * `duplicate_name` at path `email` is the nearest in the enum (raised in the
 * T-0030 report). Unreachable until M18 adds the accept flow.
 */
export const portalAlreadyMember = (): AdminError =>
  new AdminError(
    HttpStatus.CONFLICT,
    'duplicate_name',
    'That address already has access to this programme.',
    { details: [{ path: 'email', code: 'duplicate' }] },
  );

/** The invitation could not be handed to the channel provider. Nothing was saved. */
export const portalSendUnavailable = (): AdminError =>
  new AdminError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'service_unavailable',
    'The invitation could not be sent. Try again shortly.',
  );
