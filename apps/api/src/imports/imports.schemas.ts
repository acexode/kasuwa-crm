import { CALLING_CODES, IMPORT_LIMITS, IMPORT_STANDARD_FIELDS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '@kasuwa/domain-core';
import { z } from 'zod';

/**
 * Boundary schemas for the import API (records.openapi.yaml, `imports` tag,
 * T-0093 contract). Every body is closed: a part count, key, tenant, upload
 * id or file id is 400 (R3). Details carry paths and reason codes only, never
 * a value or a filename.
 */

const reason = (ctx: z.RefinementCtx, code: string) =>
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid', params: { reason: code } });

export const IMPORT_CONTENT_TYPES = ['text/csv', 'application/csv', 'application/vnd.ms-excel'] as const;

/** 1..255 code points, no `/`, `\`, NUL or other control character (the contract's pattern). */
function hasForbiddenFilenameCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '/' || character === '\\' || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const ImportIdParam = z.object({ importId: z.string().uuid() });

export const CreateImportBody = z
  .object({
    programmeId: z.string().uuid(),
    filename: z.string().superRefine((value, ctx) => {
      const length = [...value].length;
      if (length < 1 || length > 255 || hasForbiddenFilenameCharacter(value)) reason(ctx, 'invalid_string');
    }),
    sizeBytes: z
      .number()
      .int()
      .min(1)
      .superRefine((value, ctx) => {
        if (value > IMPORT_LIMITS.maxFileBytes) reason(ctx, 'file_too_large');
      }),
    contentType: z.string().superRefine((value, ctx) => {
      if (!(IMPORT_CONTENT_TYPES as readonly string[]).includes(value)) reason(ctx, 'unsupported_type');
    }),
  })
  .strict();
export type CreateImportBody = z.infer<typeof CreateImportBody>;

const partNumber = z.number().int().min(1).max(IMPORT_LIMITS.maxParts);

export const IssueImportUploadUrlsBody = z
  .object({
    partNumbers: z
      .array(partNumber)
      .min(1)
      .max(IMPORT_LIMITS.maxParts)
      .superRefine((value, ctx) => {
        if (new Set(value).size !== value.length) reason(ctx, 'not_unique');
      }),
  })
  .strict();

export const CompleteImportUploadBody = z
  .object({
    parts: z
      .array(z.object({ partNumber, etag: z.string().min(1).max(256) }).strict())
      .min(1)
      .max(IMPORT_LIMITS.maxParts),
  })
  .strict();

const ImportField = z.union([
  z.enum(IMPORT_STANDARD_FIELDS),
  z.string().regex(/^custom\.[a-z][a-z0-9_]*__c$/u),
]);

export const ImportColumnsSchema = z
  .array(
    z
      .object({
        index: z.number().int().min(0).max(IMPORT_LIMITS.maxColumns - 1),
        field: ImportField.nullable(),
      })
      .strict(),
  )
  .min(1)
  .max(IMPORT_LIMITS.maxColumns);

const COUNTRIES = Object.keys(CALLING_CODES) as [keyof typeof CALLING_CODES, ...(keyof typeof CALLING_CODES)[]];

export const PutImportMappingBody = z
  .object({
    columns: ImportColumnsSchema.optional(),
    fromImportId: z.string().uuid().optional(),
    defaultCountry: z.enum(COUNTRIES),
    ownerUserId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Exactly one of columns and fromImportId (the contract's oneOf).
    if ((value.columns === undefined) === (value.fromImportId === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid', path: ['columns'], params: { reason: 'one_of' } });
    }
  });
export type PutImportMappingBody = z.infer<typeof PutImportMappingBody>;

export const ListImportsQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
