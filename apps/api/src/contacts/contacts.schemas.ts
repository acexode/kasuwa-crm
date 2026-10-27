import {
  CONTACT_SORTS,
  CONTACT_SOURCES,
  CONTACT_STATUSES,
  CONTACT_WRITABLE_FIELDS,
  DEFAULT_CONTACT_SORT,
  DEFAULT_PAGE_SIZE,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
} from '@kasuwa/domain-core';
import { z } from 'zod';
import { nameQuery } from '../common/name-query';

/**
 * Boundary schemas for the contacts API, transcribed from
 * `docs/api/records.openapi.yaml` (T-0039). Parse, never cast (CLAUDE.md 4).
 *
 * The list query is deliberately NOT strict: an unknown query parameter is
 * ignored, never honoured (url-and-header-manipulation expects a guessed
 * `?programmeId=` to answer 200 with the caller's own rows). The write bodies
 * ARE strict: an unknown or server-owned property is 400, which is how
 * `programmeId` on update and `tenantId` anywhere are refused.
 */

export {
  CONSENT_STATES,
  CONTACT_SOURCES,
  CONTACT_STATUSES,
  PHONE_TYPES,
  PREFERRED_CHANNELS,
} from '@kasuwa/domain-core';

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const ContactIdParam = z.object({ id: z.uuid() });

/** A repeated query parameter arrives as an array, a single one as a string. */
function many<T extends z.ZodType>(item: T, maxItems: number) {
  return z
    .preprocess(
      (value) => (value === undefined || Array.isArray(value) ? value : [value]),
      z.array(item).min(1).max(maxItems),
    )
    .optional();
}

const queryBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const ListContactsQuery = z.object({
  // A name only (T-0124 I7, I9): a NUL is 400, never a Postgres 22021 and so
  // a 500 (D-L78); a phone or an email is 400 identifier_in_url (R21).
  q: nameQuery(1, 100).optional(),
  owner: many(
    z
      .string()
      .regex(/^(me|unassigned)$/u)
      .or(z.string().regex(UUID_PATTERN)),
    20,
  ),
  status: many(z.enum(CONTACT_STATUSES), 10),
  source: many(z.enum(CONTACT_SOURCES), 10),
  tag: many(z.string().min(1).max(64), 20),
  state: many(z.string().min(1).max(64), 40),
  lga: many(z.string().min(1).max(64), 40),
  dnd: queryBoolean,
  whatsappOptIn: queryBoolean,
  // T-0094: the contacts one import created. An import the caller cannot see
  // (another tenant, programme, or no `contact.import`) is an empty page.
  importId: z.uuid().optional(),
  sort: z.enum(CONTACT_SORTS).default(DEFAULT_CONTACT_SORT),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuery>;

/**
 * Query parameter -> the Contact property it filters, for the field-security
 * check: a filter on a withheld field is 400 `field_withheld`, never ignored.
 */
export const FILTER_FIELDS = {
  owner: 'ownerUserId',
  status: 'status',
  source: 'source',
  tag: 'tags',
  state: 'state',
  lga: 'lga',
  dnd: 'dnd',
  whatsappOptIn: 'whatsappOptIn',
} as const;

/**
 * Properties both writes accept, as the contract names them: the shared
 * definitions in @kasuwa/domain-core (contact-write-schema.ts), which the
 * import worker parses every CSV row with too (T-0094), so the two can never
 * drift. Free text goes through `text()` (D-L78).
 */
const writableFields = {
  ...CONTACT_WRITABLE_FIELDS,
};

/** `CreateContactRequest`. Closed: `id`, `version`, `dnd`, `phoneNetwork`, timestamps are 400. */
export const CreateContactBody = z
  .object({
    programmeId: z.uuid().optional(),
    ...writableFields,
    source: z.enum(CONTACT_SOURCES).optional(),
    // T-0089: admitted here and validated separately, against the live
    // custom-field definitions (custom-fields/custom-values.ts): its schema is
    // per tenant and per object, so it cannot be a constant. Written out, not
    // spread: the T-0041 tripwire pins that only writableFields is spread.
    custom: z.unknown().optional(),
  })
  .strict();
export type CreateContactBody = z.infer<typeof CreateContactBody>;

/**
 * `UpdateContactRequest`. Closed, `version` plus at least one field. No
 * `programmeId` (moving a record across the BPO boundary is not an edit) and
 * no `source` (how a contact arrived does not change).
 */
export const UpdateContactBody = z
  .strictObject({
    // Postgres `integer`: anything larger is 22003 at `::integer`, a 500, not a 400.
    version: z.number().int().min(1).max(2_147_483_647),
    ...writableFields,
    displayName: writableFields.displayName.optional(),
    // T-0089: validated separately, against the live definitions.
    custom: z.unknown().optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    message: 'an update must change something',
    path: [],
    params: { reason: 'nothing_to_update' },
  });
export type UpdateContactBody = z.infer<typeof UpdateContactBody>;
