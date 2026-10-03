import { DISPOSITION_CATEGORIES } from '@kasuwa/domain-core';
import { z } from 'zod';

/**
 * Boundary schemas for the dispositions and programme-scripts routes
 * (docs/api/admin.openapi.yaml: DispositionWrite, DispositionPatch,
 * DispositionOrderRequest, and listProgrammeScripts' query).
 *
 * Every object is `.strict()`, matching the spec's `additionalProperties:
 * false`. A `programmeId` in a body is a scope argument the spec does not
 * have, and `position` is server-owned; both are a 400 naming the key rather
 * than a field quietly ignored.
 */

const Category = z.enum(DISPOSITION_CATEGORIES);
const Label = z.string().min(1).max(120);

export const ProgrammeIdParam = z.object({ programmeId: z.string().uuid() });

export const DispositionParams = z.object({
  programmeId: z.string().uuid(),
  dispositionId: z.string().uuid(),
});

export const DispositionWriteBody = z
  .object({
    code: z
      .string()
      .min(1)
      .max(16)
      .regex(/^[A-Z0-9_]+$/u),
    label: Label,
    category: Category,
    noteRequired: z.boolean().default(false),
    followUpRequired: z.boolean().default(false),
  })
  .strict();
export type DispositionWriteBody = z.infer<typeof DispositionWriteBody>;

export const DispositionPatchBody = z
  .object({
    label: Label.optional(),
    category: Category.optional(),
    noteRequired: z.boolean().optional(),
    followUpRequired: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type DispositionPatchBody = z.infer<typeof DispositionPatchBody>;

export const DispositionOrderBody = z
  .object({ dispositionIds: z.array(z.string().uuid()) })
  .strict();
export type DispositionOrderBody = z.infer<typeof DispositionOrderBody>;

export const ListProgrammeScriptsQuery = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
