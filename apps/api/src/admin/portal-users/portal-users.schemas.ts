import { z } from 'zod';

/**
 * Request schemas for the client-portal users routes (T-0030), transcribed
 * from docs/api/admin.openapi.yaml. Strict everywhere: `additionalProperties:
 * false` in the spec, and a `programmeId` or `tenantId` in a body is a client
 * trying to supply its own scope (CLAUDE.md 2.2), which is refused by name.
 */

export const PortalProgrammeIdParam = z.strictObject({ programmeId: z.uuid() });

/** `#/components/schemas/InvitePortalUserRequest`. */
export const InvitePortalUserBody = z.strictObject({
  email: z.string().max(320).email(),
  displayName: z.string().max(200).optional(),
  access: z.enum(['viewer', 'reports_only']),
});
export type InvitePortalUserBody = z.infer<typeof InvitePortalUserBody>;
