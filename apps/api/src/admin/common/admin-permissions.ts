import type { TenantTx } from '@kasuwa/db';
import {
  mayProgramme,
  mayTenant,
  type ProgrammeAction,
  type TenantAction,
} from '@kasuwa/permissions';
import { notPermitted } from './admin-errors';

/**
 * The admin API's one way to ask the permissions engine (T-0032, D-L53).
 *
 * WHERE in a handler this is called is the whole contract, so every admin
 * write follows the same order:
 *
 *   1. the scope-header guard (400) and authentication (401) - before the
 *      handler runs at all;
 *   2. 404 for a record the caller cannot reach - the programme in the path,
 *      and for a disposition update or delete the disposition too. Always
 *      first: a 403 would confirm the record exists (CLAUDE.md 6.4);
 *   3. THIS - 403 `not_permitted` for a record the caller can see but may not
 *      act on. Before the body is parsed, so an unpermitted caller learns
 *      nothing from validation either;
 *   4. 400 `validation_failed`, for a permitted caller only.
 *
 * A refusal throws before anything is written, so it is never audited
 * (D-L53) - the audit row is written by the handler after the write.
 *
 * The decision is read from the database on every call (`@kasuwa/permissions`
 * `loadGrants`); nothing is cached on the request or the session.
 */

/** Tenant-level writes: the caller must be a tenant admin. */
export async function requireTenantPermission(tx: TenantTx, action: TenantAction): Promise<void> {
  if (!(await mayTenant(tx, action))) {
    throw notPermitted();
  }
}

/**
 * Programme-scoped writes: the `admin` set in this programme, or tenant admin.
 * Call only AFTER the programme has been resolved as reachable (404 first);
 * an unreachable programme is refused here too, but as defence in depth, not
 * as the answer the caller sees.
 */
export async function requireProgrammePermission(
  tx: TenantTx,
  action: ProgrammeAction,
  programmeId: string,
): Promise<void> {
  if (!(await mayProgramme(tx, action, programmeId))) {
    throw notPermitted();
  }
}
