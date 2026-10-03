import { TENANT_A, USER_A_SUPERVISOR } from '@kasuwa/db';

/**
 * The few rows the live P02 console needs that the shared seed does not carry
 * (T-0035).
 *
 * The shared seed (`packages/db/src/fixtures.ts`) has tenants, programmes,
 * users, memberships and permission sets — everything the isolation suite
 * needs — but no metadata objects. The field-security screen (`P02/D`–`D2`)
 * has nothing to show without one, and there is no HTTP API that creates an
 * object definition yet (that is the metadata builder, M3). So the e2e stack
 * adds ONE object with three fields to Tenant A, through the same
 * `withTenantTransaction` path the API uses — RLS and all — and nothing else.
 *
 * Everything else a live spec needs (roles, dispositions, a throwaway
 * programme) it creates through the real admin API, as an admin would.
 *
 * Kept deliberately small and in Tenant A only, so the second tenant is still
 * the untouched control the tenancy specs read.
 */

const A = '11111111-0000-4000-8000-';

/** The live console signs in as Musa Bello: Tenant A, member of A1 and A2. */
export const LIVE_ADMIN = { tenantId: TENANT_A, userId: USER_A_SUPERVISOR } as const;

export const LIVE_OBJECT = {
  id: `${A}000000110001`,
  apiName: 'field_visit',
  label: 'Field visit',
} as const;

export const LIVE_FIELDS = [
  {
    id: `${A}000000120001`,
    apiName: 'visit_outcome',
    label: 'Visit outcome',
    classification: 'none',
  },
  { id: `${A}000000120002`, apiName: 'visit_notes', label: 'Visit notes', classification: 'pii' },
  {
    id: `${A}000000120003`,
    apiName: 'household_income',
    label: 'Household income',
    classification: 'sensitive',
  },
] as const;
