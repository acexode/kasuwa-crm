import { validationFailed, type AdminError } from '../common/admin-errors';

/**
 * The one error only the programme lifecycle can raise (T-0029). Everything
 * else the programmes routes throw is a shared constructor from
 * `../common/admin-errors`.
 *
 * `archiveProgramme`'s `confirmation` was not the programme's exact name.
 * Path and reason only: neither the submitted text nor the name is echoed.
 */
export const confirmationMismatch = (): AdminError =>
  validationFailed([{ path: 'confirmation', code: 'mismatch' }]);
