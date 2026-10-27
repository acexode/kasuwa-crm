import { z } from 'zod';
import { requestRecords, type RecordsResult } from './records-request';

/**
 * What the caller may DO (T-0158, D-L84): `getMyCapabilities`,
 * `docs/api/auth.openapi.yaml`. It lets a screen leave out the write controls
 * the API would answer 403 to. It is a convenience, never the gate: the API
 * decides every write again, and a screen that cannot read this answer
 * (offline, a 5xx) draws its controls, so the API's 403 is still said plainly.
 *
 * No ids are sent. The session decides whose capabilities these are.
 */
export const MY_CAPABILITIES_PATH = '/api/v1/me/capabilities';

export const Capabilities = z.object({
  tenant: z.object({ admin: z.boolean(), can: z.array(z.string()) }),
  programmes: z.array(z.object({ id: z.string(), can: z.array(z.string()) })),
});
export type Capabilities = z.infer<typeof Capabilities>;

export async function getMyCapabilities(): Promise<RecordsResult<Capabilities>> {
  return requestRecords(MY_CAPABILITIES_PATH, Capabilities);
}

/** Does the caller hold `action` in at least one programme they reach? */
export function mayInAnyProgramme(capabilities: Capabilities, action: string): boolean {
  return capabilities.programmes.some((programme) => programme.can.includes(action));
}

export function mayInProgramme(
  capabilities: Capabilities,
  action: string,
  programmeId: string,
): boolean {
  return (
    capabilities.programmes
      .find((programme) => programme.id === programmeId)
      ?.can.includes(action) ?? false
  );
}

/**
 * One read per page lifetime, shared by every screen that asks. A failed read
 * is not kept, so the next screen asks again. Sign-out is a full navigation, so
 * the next session never sees this one's answer.
 */
let cached: Promise<Capabilities | null> | null = null;

export function loadMyCapabilities(): Promise<Capabilities | null> {
  if (cached === null) {
    cached = getMyCapabilities().then((result) => {
      if (!result.ok) {
        cached = null;
        return null;
      }
      return result.value;
    });
  }
  return cached;
}

/** For tests. */
export function resetCapabilitiesCache(): void {
  cached = null;
}
