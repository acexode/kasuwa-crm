import { HttpStatus } from '@nestjs/common';
import { AdminError } from '../common/admin-errors';

/**
 * The one error only programme retention can raise (T-0028). Everything else
 * these routes throw is a shared constructor from `../common/admin-errors`.
 */
export const legalHoldActive = (): AdminError =>
  new AdminError(
    HttpStatus.CONFLICT,
    'legal_hold_active',
    'A legal hold is on. Lift the hold and save, then shorten retention in a separate save.',
  );
