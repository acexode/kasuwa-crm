import {
  FIELD_ACCESS_LEVELS,
  FIELD_CLASSIFICATIONS,
  type FieldSecurityMatrix,
} from '@kasuwa/metadata-engine';
import { z } from 'zod';

/**
 * Zod at the boundary for the field-security matrix, transcribed from
 * docs/api/admin.openapi.yaml (`getFieldSecurityMatrix`,
 * `updateFieldSecurityMatrix`, `FieldSecurityWrite`, `FieldSecurityMatrix`).
 *
 * Every object is `.strict()`: the spec says `additionalProperties: false` on
 * the write, and the property somebody adds is `programmeId` - an attempt to
 * supply scope (CLAUDE.md 2.2, D-P9). It is refused with 400, not ignored. The
 * query is strict for the same reason.
 */

const Level = z.enum(FIELD_ACCESS_LEVELS);

/** getFieldSecurityMatrix's query. */
export const FieldSecurityMatrixQuery = z.strictObject({
  object: z.string().min(1).max(64),
  q: z.string().max(200).optional(),
  sensitiveOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
export type FieldSecurityMatrixQuery = z.infer<typeof FieldSecurityMatrixQuery>;

/** `FieldSecurityWrite`. The same cell twice in one save is ambiguous, so it is refused. */
export const FieldSecurityWriteBody = z
  .strictObject({
    objectApiName: z.string().min(1).max(64),
    version: z.number().int(),
    changes: z
      .array(
        z
          .object({
            fieldApiName: z.string().min(1).max(64),
            permissionSetId: z.string().min(1).max(64),
            level: Level,
          })
          .strict(),
      )
      .min(1)
      .max(2000),
  })
  .refine(
    (body) =>
      new Set(body.changes.map((change) => `${change.fieldApiName}\u0000${change.permissionSetId}`))
        .size === body.changes.length,
    { path: ['changes'], message: 'duplicate cell' },
  );
export type FieldSecurityWriteBody = z.infer<typeof FieldSecurityWriteBody>;

/**
 * `FieldSecurityMatrix`, parsed on the way OUT as well. Strict at every level:
 * the response "never contains a field's data", and an id, a tenant id or a
 * programme that crept into a row would be published by accident.
 */
export const fieldSecurityMatrixSchema = z.strictObject({
  objectApiName: z.string(),
  version: z.number().int(),
  totalFieldCount: z.number().int().nonnegative(),
  rows: z.array(
    z
      .object({
        fieldApiName: z.string(),
        label: z.string(),
        classification: z.enum(FIELD_CLASSIFICATIONS),
        cells: z.array(
          z.object({ permissionSetId: z.string(), level: Level, locked: z.boolean() }).strict(),
        ),
      })
      .strict(),
  ),
});

export function toFieldSecurityMatrixResponse(matrix: FieldSecurityMatrix): FieldSecurityMatrix {
  return fieldSecurityMatrixSchema.parse(matrix);
}
