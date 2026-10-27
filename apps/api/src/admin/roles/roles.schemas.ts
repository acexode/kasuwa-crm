import { z } from 'zod';

/**
 * Zod at the boundary, transcribed from docs/api/admin.openapi.yaml.
 *
 * Every object is `.strict()` because the spec says `additionalProperties:
 * false` — and because the property somebody adds is `programmeId`, which is an
 * attempt to supply scope (CLAUDE.md 2.2). It is refused, not ignored.
 */

const Uuid = z.uuid();
const RoleName = z.string().trim().min(1).max(120);

/** `CreateRoleRequest`. */
export const CreateRoleBody = z.strictObject({
  name: RoleName,
  parentRoleId: Uuid.nullable().optional(),
});
export type CreateRoleBody = z.infer<typeof CreateRoleBody>;

/** `UpdateRoleRequest`. `parentRoleId: null` makes the role top-level; absent leaves it. */
export const UpdateRoleBody = z.strictObject({
  name: RoleName.optional(),
  parentRoleId: Uuid.nullable().optional(),
});
export type UpdateRoleBody = z.infer<typeof UpdateRoleBody>;

/** `RoleHierarchyWrite`. A role moved twice in one save is ambiguous, so it is refused. */
export const RoleHierarchyBody = z
  .strictObject({
    version: z.number().int(),
    moves: z.array(z.object({ roleId: Uuid, parentRoleId: Uuid.nullable() }).strict()).min(1),
  })
  .refine((body) => new Set(body.moves.map((move) => move.roleId)).size === body.moves.length, {
    path: ['moves'],
    message: 'duplicate roleId',
  });
export type RoleHierarchyBody = z.infer<typeof RoleHierarchyBody>;

/** `RoleId` path parameter. A malformed id is answered as not found, never 400. */
export const RoleIdParam = z.object({ roleId: Uuid });

/** deleteRole's query: `reassignUsersToRoleId` is required even for an empty role. */
export const DeleteRoleQuery = z.strictObject({ reassignUsersToRoleId: Uuid });
