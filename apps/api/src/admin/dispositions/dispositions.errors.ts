import { HttpStatus } from '@nestjs/common';
import { AdminError, validationFailed } from '../common/admin-errors';

/**
 * The dispositions area's own error constructors, on the one admin envelope
 * (admin/common/admin-errors.ts, D-L39). Never the submitted value, never a
 * database message, never an identifier.
 */

/** The field and nothing else — the clash may be with a deleted row (D-L47). */
export const duplicateCode = (): AdminError =>
  new AdminError(
    HttpStatus.CONFLICT,
    'duplicate_code',
    'That code is already used in this programme.',
    {
      details: [{ path: 'code', code: 'duplicate' }],
    },
  );

/**
 * A reorder that is not exactly the programme's live list, each id once — a
 * subset, a duplicate, a foreign or an unknown id alike (D-L47). One detail,
 * naming the field, so the answer cannot tell which ids exist elsewhere.
 */
export const incompleteOrder = (): AdminError =>
  validationFailed([{ path: 'dispositionIds', code: 'not_complete_list' }]);
