import { z } from 'zod';
import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES } from './audit-writer';

/**
 * Boundary schemas for the audit routes (docs/api/admin.openapi.yaml, tag
 * `audit`). Every object is `.strict()`: the spec has no scope argument
 * anywhere, so a `programmeIds` — or a `tenantId` tucked inside `filters` — is
 * a 400 that names it, never a field quietly honoured or quietly dropped.
 */

/**
 * UTC ISO 8601 with a `Z` ("Inclusive, UTC" / "Exclusive, UTC"), and a real
 * calendar date: `2026-02-30T00:00:00Z` matches the shape, and Postgres would
 * refuse it later as a 500 rather than a 400. Round-tripping through `Date`
 * catches it, because `Date` rolls an impossible day over into the next month.
 */
const UtcDateTime = z.iso.datetime().refine((value) => {
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.slice(0, 10)
  );
});

const filterFields = {
  actorId: z.uuid().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  objectType: z.string().min(1).max(64).optional(),
  from: UtcDateTime.optional(),
  to: UtcDateTime.optional(),
  /** A literal prefix. Not a pattern, not a CIDR. */
  sourceIpPrefix: z.string().max(45).optional(),
};

export const ListAuditEventsQuery = z.strictObject({
  ...filterFields,
  cursor: z.string().min(1).max(512).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListAuditEventsQuery = z.infer<typeof ListAuditEventsQuery>;

/**
 * An export's filters. `objectType` is the closed list, not free text: the
 * request is recorded in the export's audit event, which every user of the
 * tenant can read, so a free-text field there would be a tenant-wide message
 * board (and a place for personal data to land).
 */
export const AuditFilters = z.strictObject({
  ...filterFields,
  objectType: z.enum(AUDIT_OBJECT_TYPES).optional(),
});
export type AuditFilters = z.infer<typeof AuditFilters>;

export const CreateAuditExportBody = z
  .strictObject({
    format: z.enum(['csv', 'json']),
    scope: z.enum(['filtered', 'last_90_days']),
    includeIpAddresses: z.boolean().default(false),
    filters: AuditFilters.optional(),
  })
  // `filters` applies "when `scope` is `filtered`". Accepting it with
  // `last_90_days` and ignoring it would export more than the caller asked for.
  .refine((body) => body.scope === 'filtered' || body.filters === undefined, {
    path: ['filters'],
    params: { reason: 'not_allowed_for_scope' },
  });
export type CreateAuditExportBody = z.infer<typeof CreateAuditExportBody>;

export const ExportIdParam = z.object({ exportId: z.uuid() });
