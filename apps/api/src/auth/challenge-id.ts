/**
 * The identifier the first sign-in step hands out.
 *
 * It is opaque to the client and it carries the tenant, because it has to carry
 * something: the second step arrives with nothing but this id, and every RLS
 * policy in the system needs a tenant before any row can be read. The
 * alternatives were asking the client to repeat the workspace slug — one more
 * field to get wrong, and no more trustworthy — or a third SECURITY DEFINER
 * resolver, which would mean a new RLS-free read path for the sake of a
 * five-minute row.
 *
 * THE TENANT ID HERE IS IDENTITY, NOT SCOPE, AND IT IS NOT TRUSTED. It decides
 * only which tenant's `auth_challenge` table is searched. A forged tenant finds
 * no challenge; a real challenge still buys nothing without the code; and no
 * programme, role or permission is encoded anywhere in it. If this ever grows a
 * third component that grants something, the tenancy model has been inverted.
 */

export interface ChallengeReference {
  tenantId: string;
  challengeId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function formatChallengeId(reference: ChallengeReference): string {
  return `${reference.tenantId}.${reference.challengeId}`;
}

/**
 * Parses, or returns null. Both halves must be well-formed uuids: the value
 * reaches a query parameter, and "validate before you interpolate" holds even
 * when the driver is binding it.
 */
export function parseChallengeId(value: string): ChallengeReference | null {
  const parts = value.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [tenantId, challengeId] = parts;
  if (
    tenantId === undefined ||
    challengeId === undefined ||
    !UUID_PATTERN.test(tenantId) ||
    !UUID_PATTERN.test(challengeId)
  ) {
    return null;
  }
  return { tenantId, challengeId };
}
