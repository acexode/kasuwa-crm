import {
  CONTACT_SORTS,
  DEFAULT_CONTACT_SORT,
  DEFAULT_PAGE_SIZE,
  E164,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
} from '@kasuwa/domain-core';
import { z } from 'zod';
import { text } from '../common/text';

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

export const CONTACT_STATUSES = [
  'new',
  'contacted',
  'qualified',
  'unqualified',
  'customer',
] as const;
export const CONTACT_SOURCES = [
  'whatsapp',
  'ussd',
  'web_form',
  'missed_call',
  'import',
  'api',
  'manual',
  'referral',
  'walk_in',
] as const;
export const PREFERRED_CHANNELS = ['whatsapp', 'sms', 'voice', 'email'] as const;
export const CONSENT_STATES = ['unknown', 'opted_in', 'pending', 'withdrawn'] as const;
export const PHONE_TYPES = ['mobile', 'work', 'home', 'other'] as const;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const ContactIdParam = z.object({ id: z.string().uuid() });

/** A repeated query parameter arrives as an array, a single one as a string. */
function many<T extends z.ZodTypeAny>(item: T, maxItems: number) {
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
  // text(): a NUL is 400, never a Postgres 22021 and so a 500 (D-L78).
  q: text(1, 100).optional(),
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

const Phone = z
  .object({
    type: z.enum(PHONE_TYPES),
    e164: z.string().regex(E164),
  })
  .strict();

const Email = z.string().max(254).email();

/**
 * RFC 5646 langtag structure, the same expression as 0019's
 * contact_preferred_language_bcp47_check, so a bad tag is a 400 here rather
 * than a CHECK violation (a 500) there.
 */
const BCP47 = new RegExp(
  '^((' +
    '([A-Za-z]{2,3}(-[A-Za-z]{3}){0,3}|[A-Za-z]{4,8})' +
    '(-[A-Za-z]{4})?' +
    '(-([A-Za-z]{2}|[0-9]{3}))?' +
    '(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*' +
    '(-[0-9A-WY-Za-wy-z](-[A-Za-z0-9]{2,8})+)*' +
    '(-[Xx](-[A-Za-z0-9]{1,8})+)?' +
    ')|([Xx](-[A-Za-z0-9]{1,8})+))$',
);

/**
 * Properties both writes accept, as the contract names them. The free-text
 * names go through `text()` (D-L78): a NUL is 400 `invalid_character`, never
 * a Postgres 22021 (a 500); lengths are counted in code points.
 */
const writableFields = {
  displayName: text(1, 200),
  givenNames: text(0, 200).nullable().optional(),
  familyName: text(0, 200).nullable().optional(),
  // T-0076 (D-L82): 1..200 code points, no NUL; `null` clears it, "" is 400.
  companyName: text(1, 200).nullable().optional(),
  phones: z.array(Phone).max(10).optional(),
  emails: z.array(Email).max(10).optional(),
  accountId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  preferredLanguage: z.string().max(35).regex(BCP47).nullable().optional(),
  preferredChannel: z.enum(PREFERRED_CHANNELS).nullable().optional(),
  state: z.string().max(64).nullable().optional(),
  lga: z.string().max(64).nullable().optional(),
  whatsappOptIn: z.boolean().optional(),
  consentState: z.enum(CONSENT_STATES).optional(),
};

/** `CreateContactRequest`. Closed: `id`, `version`, `dnd`, `phoneNetwork`, timestamps are 400. */
export const CreateContactBody = z
  .object({
    programmeId: z.string().uuid().optional(),
    ...writableFields,
    source: z.enum(CONTACT_SOURCES).optional(),
  })
  .strict();
export type CreateContactBody = z.infer<typeof CreateContactBody>;

/**
 * `UpdateContactRequest`. Closed, `version` plus at least one field. No
 * `programmeId` (moving a record across the BPO boundary is not an edit) and
 * no `source` (how a contact arrived does not change).
 */
export const UpdateContactBody = z
  .object({
    // Postgres `integer`: anything larger is 22003 at `::integer`, a 500, not a 400.
    version: z.number().int().min(1).max(2_147_483_647),
    ...writableFields,
    displayName: writableFields.displayName.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    message: 'an update must change something',
    path: [],
    params: { reason: 'nothing_to_update' },
  });
export type UpdateContactBody = z.infer<typeof UpdateContactBody>;
