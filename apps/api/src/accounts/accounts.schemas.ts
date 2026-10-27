import {
  ACCOUNT_SORTS,
  CONTACT_SORTS,
  DEFAULT_ACCOUNT_SORT,
  DEFAULT_PAGE_SIZE,
  E164,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  type ContactSort,
} from '@kasuwa/domain-core';
import { z } from 'zod';
import { text } from '../common/text';

/**
 * Boundary schemas for the accounts API, transcribed from
 * `docs/api/records.openapi.yaml` (T-0052). Parse, never cast (CLAUDE.md 4).
 *
 * The query schemas are deliberately NOT strict: an unknown query parameter is
 * ignored, never honoured, so `?programmeId=` neither narrows nor widens. The
 * write bodies ARE strict: an unknown or server-owned property is 400, which
 * is how `programmeId` on update (D-L76), `tenantId` anywhere and a raw
 * `__proto__` key are refused.
 *
 * Every free-text value goes through `text()`: no NUL (D-L78), lengths in code
 * points as the contract counts them.
 */

export const ACCOUNT_TIERS = ['enterprise', 'mid_market', 'sme'] as const;
export const PHONE_TYPES = ['mobile', 'work', 'home', 'other'] as const;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const AccountIdParam = z.object({ accountId: z.uuid() });

/** A repeated query parameter arrives as an array, a single one as a string. */
function many<T extends z.ZodType>(item: T, maxItems: number) {
  return z
    .preprocess(
      (value) => (value === undefined || Array.isArray(value) ? value : [value]),
      z.array(item).min(1).max(maxItems),
    )
    .optional();
}

const cursor = z.string().min(1).max(MAX_CURSOR_LENGTH).optional();
const limit = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE);

export const ListAccountsQuery = z.object({
  q: text(1, 100).optional(),
  owner: many(
    z
      .string()
      .regex(/^(me|unassigned)$/u)
      .or(z.string().regex(UUID_PATTERN)),
    20,
  ),
  tier: many(z.enum(ACCOUNT_TIERS), 10),
  industry: many(text(1, 64), 20),
  tag: many(text(1, 64), 20),
  state: many(text(1, 64), 40),
  lga: many(text(1, 64), 40),
  sort: z.enum(ACCOUNT_SORTS).default(DEFAULT_ACCOUNT_SORT),
  cursor,
  limit,
});
export type ListAccountsQuery = z.infer<typeof ListAccountsQuery>;

/**
 * Query parameter -> the Account property it filters, for the field-security
 * check: a filter on a field withheld anywhere the caller reaches is 400
 * `field_withheld` naming the PARAMETER, never silently ignored.
 */
export const ACCOUNT_FILTER_FIELDS = {
  owner: 'ownerUserId',
  tier: 'tier',
  industry: 'industry',
  tag: 'tags',
  state: 'state',
  lga: 'lga',
} as const;

/**
 * listAccountContacts sorts as listContacts does, newest first by default.
 * It was `displayName` until T-0124 (I5): a default order on a withholdable
 * name ranks the rows by a value the caller may not read.
 */
export const DEFAULT_ACCOUNT_CONTACT_SORT: ContactSort = '-createdAt';

export const ListAccountContactsQuery = z.object({
  sort: z.enum(CONTACT_SORTS).default(DEFAULT_ACCOUNT_CONTACT_SORT),
  cursor,
  limit,
});
export type ListAccountContactsQuery = z.infer<typeof ListAccountContactsQuery>;

/** `Phone`: closed, E.164 only. */
const Phone = z.strictObject({
  type: z.enum(PHONE_TYPES),
  e164: z.string().regex(E164),
});

/** Properties both writes accept, as the contract names them. */
const writableFields = {
  name: text(1, 200),
  ownerUserId: z.uuid().nullable().optional(),
  industry: text(1, 64).nullable().optional(),
  tier: z.enum(ACCOUNT_TIERS).nullable().optional(),
  tags: z.array(text(1, 64)).max(50).optional(),
  phones: z.array(Phone).max(10).optional(),
  state: text(0, 64).nullable().optional(),
  lga: text(0, 64).nullable().optional(),
  parentAccountId: z.uuid().nullable().optional(),
};

/** `custom` (T-0089): admitted here, validated against the live definitions separately. */
const customField = { custom: z.unknown().optional() };

/** `CreateAccountRequest`. Closed: `id`, `version`, `owner`, timestamps, `withheldFields` are 400. */
export const CreateAccountBody = z.strictObject({
  programmeId: z.uuid().optional(),
  ...writableFields,
  ...customField,
});
export type CreateAccountBody = z.infer<typeof CreateAccountBody>;

/**
 * `UpdateAccountRequest`. Closed, `version` plus at least one field. No
 * `programmeId`: moving an account across the BPO boundary is not a field
 * edit (D-L76), so sending it, even with the account's own programme, is 400.
 */
export const UpdateAccountBody = z
  .strictObject({
    // Postgres `integer`: anything larger is 22003 at `::integer`, a 500, not a 400.
    version: z.number().int().min(1).max(2_147_483_647),
    ...writableFields,
    name: writableFields.name.optional(),
    ...customField,
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    message: 'an update must change something',
    path: [],
    params: { reason: 'nothing_to_update' },
  });
export type UpdateAccountBody = z.infer<typeof UpdateAccountBody>;
