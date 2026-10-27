import { z } from 'zod';
import { text } from '../common/text';

/**
 * Boundary schemas for listPipelines and getPipelineBoard (T-0107),
 * transcribed from `docs/api/records.openapi.yaml`. Parse, never cast.
 *
 * NOT strict: an unknown query parameter is ignored, never honoured (R13), so
 * `?programmeId=`, `?tenantId=` or `?pipelineId=` neither widens nor narrows.
 *
 * What is deliberately NOT decided here, because the contract gives it its
 * own reason code rather than a generic schema error:
 *   - `pipelineId` (the path): a non-uuid is the one 404, decided by the
 *     scoped lookup before any of this runs (D-L115);
 *   - `stageId`: anything but an open or won stage of the pipeline is
 *     `unknown_reference` (R18), a non-uuid included, so it is taken as-is;
 *   - `currency` values: anything but NGN, GHS, KES or ZAR is
 *     `unknown_currency` (R19), lower case included;
 *   - `cursor`: any malformed cursor is the one `invalid_cursor` body (R8),
 *     over-long included, so only its type is checked here.
 */

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A repeated query parameter arrives as an array, a single one as a string. */
function many<T extends z.ZodType>(item: T, maxItems: number) {
  return z
    .preprocess(
      (value) => (value === undefined || Array.isArray(value) ? value : [value]),
      z.array(item).min(1).max(maxItems),
    )
    .optional();
}

/** True for a real calendar date `YYYY-MM-DD` (2031-02-30 is not one). */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const UTC_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$/;

/** A UTC date-time with a `Z` (the contract's ClosedSince): no offset, no bare date. */
export function isUtcDateTime(value: string): boolean {
  const match = UTC_DATE_TIME.exec(value);
  return (
    match !== null &&
    match[1] !== undefined &&
    isCalendarDate(match[1]) &&
    !Number.isNaN(Date.parse(value))
  );
}

const calendarDate = z.string().refine(isCalendarDate);

/**
 * The path of getPipeline and getPipelineBoard. Parsed only by
 * `reachablePipeline` (pipelines.service.ts) with `safeParse`, and a failure
 * there is THE one 404, never a 400 (D-L115, R4): a non-uuid, a missing id
 * and a value of the wrong type answer exactly as an unreachable pipeline.
 */
export const PipelineIdParam = z.object({ pipelineId: z.string().regex(UUID_PATTERN) });
export type PipelineIdParam = z.infer<typeof PipelineIdParam>;

export const ListPipelinesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListPipelinesQuery = z.infer<typeof ListPipelinesQuery>;

export const PipelineBoardQuery = z.object({
  // text(): no NUL (D-L78), which would otherwise reach Postgres as a 22021.
  q: text(1, 100).optional(),
  owner: many(
    z
      .string()
      .regex(/^(me|unassigned)$/u)
      .or(z.string().regex(UUID_PATTERN)),
    20,
  ),
  closeFrom: calendarDate.optional(),
  closeTo: calendarDate.optional(),
  currency: many(z.string(), 10),
  closedSince: z.string().refine(isUtcDateTime).optional(),
  stageId: z.unknown().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PipelineBoardQuery = z.infer<typeof PipelineBoardQuery>;

/** The contract's currencies (DealMoney, D-L115). Never converted. */
export const DEAL_CURRENCIES: readonly string[] = ['NGN', 'GHS', 'KES', 'ZAR'];

/** Query parameter -> the Deal field a filter on it reads, for `field_withheld` (I5). */
export const BOARD_FILTER_FIELDS = {
  owner: 'ownerUserId',
  closeFrom: 'expectedCloseDate',
  closeTo: 'expectedCloseDate',
  currency: 'amount',
} as const;
