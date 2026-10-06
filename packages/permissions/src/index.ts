/**
 * Permission policy engine - Agent 1 (Platform & Security), PRD module M2.
 *
 * Answers "may this session DO this?" on top of what RLS already decided it
 * may SEE. Built in T-0032 to the model in team/DECISIONS.md D-L53:
 *
 *   - a permission set is granted per user per programme, on
 *     `user_programme.permission_set_id` (D-P9);
 *   - a tenant admin is a flag on the user, `"user".is_tenant_admin`;
 *   - both are re-read from the database on every request (`grants.ts`);
 *   - neither ever widens scope (D-L06: no wildcard).
 *
 * Covered today: the admin API's writes, `contact.write` for the contacts API
 * (T-0041, D-L63), and the agent set's field-limited contact update,
 * `contact.claim_and_set_status` (D-P14, T-0051). NOT yet modelled:
 * field-level and record-level decisions for business objects in general (the
 * authorisation matrix, a later M2 task), and any permission for a set other
 * than `admin` beyond that one `agent` grant.
 */

export {
  ADMIN_PERMISSION_SET_KEY,
  AGENT_PERMISSION_SET_KEY,
  PROGRAMME_ACTIONS,
  TENANT_ACTIONS,
  canProgramme,
  canTenant,
  canUpdateContact,
  contactUpdateWithinClaim,
  type Grants,
  type ProgrammeAction,
  type TenantAction,
} from './policy';
export { loadGrants, mayProgramme, mayTenant } from './grants';

/**
 * How far the engine reaches. Was `'not-implemented'` until T-0032; the
 * pending authorisation-matrix suite still expects that value and needs the
 * lead to update it when its task is assigned.
 */
export const PERMISSIONS_ENGINE_STATUS = 'admin-writes' as const;
