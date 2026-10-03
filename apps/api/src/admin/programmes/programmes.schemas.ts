import { PROGRAMME_STATUSES, type ProgrammeStatus } from '@kasuwa/domain-core';
import { z } from 'zod';

/**
 * Boundary schemas for the programmes routes (docs/api/admin.openapi.yaml).
 *
 * Every object is `.strict()`. The spec has no scope argument anywhere, so a
 * `programmeIds` (or anything else unexpected) is a 400 that names it — not a
 * field quietly ignored, which would leave a caller believing it had narrowed
 * or widened something.
 */

/** One list, owned by the domain next to the column's CHECK constraint (0012). */
export { PROGRAMME_STATUSES, type ProgrammeStatus };

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

/** `templateId` is undefined in the spec today: "Sending one is 400". */
const NotSupported = z
  .unknown()
  .refine(() => false, { params: { reason: 'not_supported' } })
  .optional();

/**
 * `CreateProgrammeRequest`. No `status`: a new programme starts `active`
 * (D-L46), and an undeclared field is refused by `.strict()` at its own path.
 *
 * `countryCode` is validated against the spec's pattern but **not stored** —
 * `programme` has no country column, and adding one is outside T-0029's
 * migration. The create response therefore omits it rather than echo a value
 * nothing persisted.
 */
export const CreateProgrammeBody = z
  .object({
    name: Name,
    clientName: z
      .string()
      .trim()
      .max(200)
      .optional()
      .transform((value) => (value === undefined || value === '' ? null : value)),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/u)
      .optional(),
    businessUnitId: z.string().uuid(),
    templateId: NotSupported,
  })
  .strict();
export type CreateProgrammeBody = z.infer<typeof CreateProgrammeBody>;

/**
 * `ArchiveProgrammeRequest`. `confirmation` is compared byte for byte with the
 * programme's name — never trimmed or case-folded, so `"Name "` is a mismatch.
 * The comparison itself happens against the locked row, not here.
 */
export const ArchiveProgrammeBody = z
  .object({ confirmation: z.string().max(1000) })
  .strict();
export type ArchiveProgrammeBody = z.infer<typeof ArchiveProgrammeBody>;
