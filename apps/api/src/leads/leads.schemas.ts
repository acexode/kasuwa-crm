import {
  CONTACT_SORTS,
  DEFAULT_CONTACT_SORT,
  DEFAULT_PAGE_SIZE,
  LEAD_STATUSES,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
} from '@kasuwa/domain-core';
import { z } from 'zod';
import { text } from '../common/text';
import { CONTACT_SOURCES } from '../contacts/contacts.schemas';

/**
 * Boundary schema for listLeads (`GET /api/v1/leads`, T-0076), transcribed
 * from `docs/api/records.openapi.yaml`. Parse, never cast (CLAUDE.md 4).
 *
 * NOT strict, as listContacts: an unknown query parameter is ignored, never
 * honoured, so `?programmeId=`, `?lifecycle=all` or `?includeCustomers=`
 * neither widens nor narrows the view. `status` takes LEAD statuses only:
 * `customer` is 400, because this list never widens beyond leads (D-L75).
 *
 * There is no account filter (the task's "Watch for", L8 of the suite): an
 * `?account=` or `?accountId=` is an unknown parameter and so ignored, which
 * answers the same whatever account it names.
 */

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A repeated query parameter arrives as an array, a single one as a string. */
function many<T extends z.ZodTypeAny>(item: T, maxItems: number) {
  return z
    .preprocess(
      (value) => (value === undefined || Array.isArray(value) ? value : [value]),
      z.array(item).min(1).max(maxItems),
    )
    .optional();
}

export const ListLeadsQuery = z.object({
  // text(): no NUL (D-L78), which would otherwise reach Postgres as a 22021.
  q: text(1, 100).optional(),
  owner: many(
    z
      .string()
      .regex(/^(me|unassigned)$/u)
      .or(z.string().regex(UUID_PATTERN)),
    20,
  ),
  status: many(z.enum(LEAD_STATUSES), LEAD_STATUSES.length),
  source: many(z.enum(CONTACT_SOURCES), 10),
  sort: z.enum(CONTACT_SORTS).default(DEFAULT_CONTACT_SORT),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type ListLeadsQuery = z.infer<typeof ListLeadsQuery>;

/**
 * Query parameter -> the Contact property it filters, for the field-security
 * check: a filter on a field withheld anywhere the caller reaches is 400
 * `field_withheld` naming the PARAMETER (D-L82). `status` is checked whether
 * or not it is sent: the view itself is a filter on it.
 */
export const LEAD_FILTER_FIELDS = {
  owner: 'ownerUserId',
  status: 'status',
  source: 'source',
} as const;
