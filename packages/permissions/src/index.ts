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
 * (T-0041, D-L63), the field-limited contact update
 * `contact.claim_and_set_status`, held by the `agent` set (D-P14, T-0051) and
 * the `team_lead` and `programme_manager` sets (D-P18, T-0077),
 * `account.write` for the accounts API (T-0055, admin-only per D-P18), and
 * activity writes, `activity.write` and `activity.reassign` (D-P18, D-L81,
 * T-0061), and the in-call script actions `script.write` (T-0113) and
 * `script.run` (T-0114, D-L88). NOT yet modelled: field-level and record-level decisions for
 * business objects in general (the authorisation matrix, a later M2 task).
 */

export {
  ADMIN_PERMISSION_SET_KEY,
  AGENT_PERMISSION_SET_KEY,
  PROGRAMME_ACTIONS,
  TENANT_ACTIONS,
  canProgramme,
  canReadPipelines,
  PIPELINE_READER_SET_KEYS,
  programmesReadingPipelines,
  PROGRAMME_MANAGER_PERMISSION_SET_KEY,
  QA_ANALYST_PERMISSION_SET_KEY,
  TEAM_LEAD_PERMISSION_SET_KEY,
  activityBodyAssignsOther,
  canTenant,
  canUpdateContact,
  canWriteActivity,
  contactUpdateWithinClaim,
  permissionSetKeysGranting,
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
