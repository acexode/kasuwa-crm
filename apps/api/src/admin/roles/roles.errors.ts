import { HttpStatus } from '@nestjs/common';
import { AdminError } from '../common/admin-errors';

/**
 * The one error only the role hierarchy can raise. Everything else the roles
 * routes throw is a shared constructor from `../common/admin-errors`.
 *
 * `conflictingIds` must only ever contain ids the caller submitted.
 */
export const hierarchyCycle = (conflictingIds: string[]): AdminError =>
  new AdminError(
    HttpStatus.CONFLICT,
    'role_hierarchy_cycle',
    'A role cannot report to one of the roles beneath it.',
    { conflictingIds },
  );
