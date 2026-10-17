import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '@kasuwa/domain-core';
import { z } from 'zod';
import { text } from '../common/text';

/**
 * Boundary schemas for the deals API (T-0108), transcribed from
 * `docs/api/records.openapi.yaml` (listDeals, createDeal, updateDeal,
 * moveDeal; CreateDealRequest, UpdateDealRequest, MoveDealRequest, DealMoney).
 * Parse, never cast (CLAUDE.md 4).
 *
 * The write bodies are CLOSED (`.strict()`): an unknown or server-owned key
 * (`stageId`, `pipelineId`, `programmeId`, `version` on create, a timestamp,
 * `checks` on create or update, `checkedBy`, a raw `__proto__` or
 * `constructor`) is 400 and never written (D-L120, R15). The list query is
 * NOT strict: an unknown parameter is ignored, never honoured (R18).
 *
 * MONEY (D-L121). `amountMinor` is a STRING of digits, at most 18, no sign, no
 * fraction, no exponent, no leading zero, validated here before any SQL. It
 * never becomes a JS number; the repository binds it as text and casts it
 * with `::bigint`. A currency must look like a code (three capitals) and then
 * be one of the four (`unknown_currency`, D-L115), as two separate checks, so
 * a well-formed unknown code gets its own reason.
 */

/** D-L115: the four currencies, exactly. Never converted. */
export const DEAL_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR'] as const;
export type DealCurrency = (typeof DEAL_CURRENCIES)[number];

/** DealMoney.amountMinor: 0 to 18 nines, no leading zero (D-L121). */
export const AMOUNT_MINOR_PATTERN = /^(0|[1-9][0-9]{0,17})$/;

/** The shape of an ISO 4217 code: three capitals (DealMoney.currency's pattern). */
export const CURRENCY_CODE = /^[A-Z]{3}$/u;

/** The reason a malformed amountMinor gets (the code is the builder's, R3). */
export const INVALID_AMOUNT_REASON = 'invalid_amount';

/** Postgres `integer`: a larger version is 22003 at `::integer`, a 500, not a 400. */
const VERSION = z.number().int().min(1).max(2_147_483_647);

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Whether a path id is a uuid at all. A path id that is not is the one 404, never a 400 (D-L115). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** `DealMoney`: closed, both parts required. */
export const DealMoney = z
  .object({
    amountMinor: z.string().superRefine((value, context) => {
      if (!AMOUNT_MINOR_PATTERN.test(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'not a minor-unit amount',
          params: { reason: INVALID_AMOUNT_REASON },
        });
      }
    }),
    currency: z.string().superRefine((value, context) => {
      const known = (DEAL_CURRENCIES as readonly string[]).includes(value);
      if (known) return;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'not a supported currency',
        // Three capitals is a code the server does not know; anything else
        // is not a currency code at all.
        params: { reason: CURRENCY_CODE.test(value) ? 'unknown_currency' : 'invalid_string' },
      });
    }),
  })
  .strict();
export type DealMoney = z.infer<typeof DealMoney>;

/**
 * A calendar date, `YYYY-MM-DD`, that exists: `2031-02-30` is 400 here, never
 * Postgres's 22008 as a 500. Year 0001 to 9999 (Postgres has no year 0).
 */
export const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(
    (value) => {
      if (Number(value.slice(0, 4)) < 1) return false;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    },
    { params: { reason: 'invalid_date' } },
  );

const uuid = z.string().regex(UUID_PATTERN);

/** The seven writable deal fields, as both writes name them. */
const writableFields = {
  name: text(1, 200),
  amount: DealMoney.nullable().optional(),
  expectedCloseDate: CalendarDate.nullable().optional(),
  ownerUserId: uuid.nullable().optional(),
  primaryContactId: uuid.nullable().optional(),
  accountId: uuid.nullable().optional(),
  nextStep: text(1, 200).nullable().optional(),
};

/** The writable wire fields, in contract order (field security judges these keys). */
export const DEAL_WRITABLE_FIELDS = [
  'name',
  'amount',
  'expectedCloseDate',
  'ownerUserId',
  'primaryContactId',
  'accountId',
  'nextStep',
] as const;
export type DealWritableField = (typeof DEAL_WRITABLE_FIELDS)[number];

/** `CreateDealRequest`. Closed. */
export const CreateDealBody = z.object(writableFields).strict();
export type CreateDealBody = z.infer<typeof CreateDealBody>;

/** `UpdateDealRequest`. Closed: `version` plus at least one field (D-L102). */
export const UpdateDealBody = z
  .object({ version: VERSION, ...writableFields, name: writableFields.name.optional() })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'version'), {
    message: 'an update must change something',
    path: [],
    params: { reason: 'nothing_to_update' },
  });
export type UpdateDealBody = z.infer<typeof UpdateDealBody>;

/** The fields a move may fill: the contract's DealRequirementField, as wire names. */
export const MOVE_FIELDS = [
  'amount',
  'expectedCloseDate',
  'nextStep',
  'primaryContactId',
  'accountId',
] as const;
export type MoveField = (typeof MOVE_FIELDS)[number];

/** `MoveDealFields`: closed, at least one, a value and never `null`. */
const MoveDealFields = z
  .object({
    amount: DealMoney.optional(),
    expectedCloseDate: CalendarDate.optional(),
    nextStep: text(1, 200).optional(),
    primaryContactId: uuid.optional(),
    accountId: uuid.optional(),
  })
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, {
    message: 'fields must name at least one requirement',
    path: [],
    params: { reason: 'too_small' },
  });

/**
 * `MoveDealRequest`. Closed. `toStageId` is any string here: whether it names
 * a stage of the deal's pipeline is one `unknown_reference` answer, a non-uuid
 * included (R4), decided by the service.
 */
export const MoveDealBody = z
  .object({
    version: VERSION,
    toStageId: z.string().max(64),
    fields: MoveDealFields.optional(),
    checks: z
      .array(uuid)
      .max(20)
      .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
        message: 'checks repeat',
        params: { reason: 'not_unique' },
      })
      .optional(),
  })
  .strict();
export type MoveDealBody = z.infer<typeof MoveDealBody>;

/** listDeals' sort keys: never a withheld value (D-L115). */
export const DEAL_SORTS = [
  '-updatedAt',
  'updatedAt',
  '-createdAt',
  'createdAt',
  'name',
  '-name',
  'stageEnteredAt',
  '-stageEnteredAt',
] as const;
export type DealSort = (typeof DEAL_SORTS)[number];
export const DEFAULT_DEAL_SORT: DealSort = '-updatedAt';

/** A repeated query parameter arrives as an array, a single one as a string. */
function many<T extends z.ZodTypeAny>(item: T, maxItems: number) {
  return z
    .preprocess(
      (value) => (value === undefined || Array.isArray(value) ? value : [value]),
      z.array(item).min(1).max(maxItems),
    )
    .optional();
}

/** UTC with a `Z` and a real calendar date, as the contract's date-times. */
const UtcDateTime = z
  .string()
  .datetime()
  .refine(
    (value) => {
      const year = Number(value.slice(0, 4));
      if (!(year >= 1970 && year <= 9999)) return false;
      const parsed = new Date(value);
      return (
        !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.slice(0, 10)
      );
    },
    { params: { reason: 'invalid_date' } },
  );

/**
 * listDeals' query. `stageId` items are any string: one that is not a stage
 * of this pipeline, a non-uuid included, is `unknown_reference` (decided by
 * the service). A `currency` item must look like a code; an unknown code is
 * `unknown_currency` (the service, as in a body).
 */
export const ListDealsQuery = z.object({
  q: text(1, 100).optional(),
  owner: many(
    z
      .string()
      .regex(/^(me|unassigned)$/u)
      .or(uuid),
    20,
  ),
  closeFrom: CalendarDate.optional(),
  closeTo: CalendarDate.optional(),
  currency: many(z.string().regex(/^[A-Z]{3}$/u), 10),
  closedSince: UtcDateTime.optional(),
  stageId: many(z.string().max(64), 20),
  sort: z.enum(DEAL_SORTS).default(DEFAULT_DEAL_SORT),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type ListDealsQuery = z.infer<typeof ListDealsQuery>;

/** Query parameter -> the Deal field it filters, for the `field_withheld` check. */
export const DEAL_FILTER_FIELDS = {
  owner: 'ownerUserId',
  currency: 'amount',
  closeFrom: 'expectedCloseDate',
  closeTo: 'expectedCloseDate',
} as const;
