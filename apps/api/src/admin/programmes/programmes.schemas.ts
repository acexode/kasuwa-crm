import { z } from 'zod';

/**
 * Boundary schemas for the programmes routes (docs/api/admin.openapi.yaml).
 *
 * Every object is `.strict()`. The spec has no scope argument anywhere, so a
 * `programmeIds` (or anything else unexpected) is a 400 that names it — not a
 * field quietly ignored, which would leave a caller believing it had narrowed
 * or widened something.
 */

export const PROGRAMME_STATUSES = ['active', 'paused', 'draft', 'archived'] as const;
export type ProgrammeStatus = (typeof PROGRAMME_STATUSES)[number];

const PageSize = z.coerce.number().int().min(1).max(200).default(50);
const Cursor = z.string().min(1).max(512).optional();
const Q = z
  .string()
  .max(200)
  .optional()
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value.trim()));

export const ProgrammeIdParam = z.object({ programmeId: z.string().uuid() });

export const ListProgrammesQuery = z
  .object({
    q: Q,
    status: z.enum(PROGRAMME_STATUSES).optional(),
    cursor: Cursor,
    pageSize: PageSize,
  })
  .strict();
export type ListProgrammesQuery = z.infer<typeof ListProgrammesQuery>;

export const ListProgrammeAgentsQuery = z
  .object({ q: Q, cursor: Cursor, pageSize: PageSize })
  .strict();

const Name = z.string().trim().min(1).max(200);

export const UpdateProgrammeBody = z
  .object({
    version: z.number().int().nonnegative(),
    name: Name.optional(),
    clientName: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .optional()
      .transform((value) => (value === '' ? null : value)),
    /**
     * The spec accepts `active | paused`, but `programme` has no lifecycle
     * column and T-0024 forbids the migration that would add one. The lead's
     * ruling: refuse any status change rather than accept one and drop it.
     */
    status: z
      .unknown()
      .refine(() => false, { params: { reason: 'not_supported' } })
      .optional(),
  })
  .strict();
export type UpdateProgrammeBody = z.infer<typeof UpdateProgrammeBody>;
