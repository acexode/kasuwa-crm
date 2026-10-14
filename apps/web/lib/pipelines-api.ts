import { z } from 'zod';

/**
 * The browser's half of the pipelines and deals operations in
 * `docs/api/records.openapi.yaml` (T-0105 to T-0108): `listPipelines`,
 * `getPipeline`, `getPipelineBoard`, `listDeals`, `createDeal`, `getDeal` and
 * `moveDeal`, plus the two pickers the requirement prompt searches with
 * (`listContacts` and `listAccounts`, `q` only). The P06 board (T-0109) reads
 * and writes through here and nowhere else.
 *
 * SAME-ORIGIN. Relative `/api/v1/...` paths, rewritten by `next.config.mjs`.
 *
 * SCOPE IS NEVER AN ARGUMENT (CLAUDE.md 2.2). No programme parameter and no
 * header: the session and `user_programme` decide what a caller reaches.
 * `owner` is a filter on the deal, not a scope.
 *
 * MONEY IS A STRING, ALWAYS (D-L88, D-P19). `amountMinor` and the totals are
 * decimal strings of up to 18 and 24 digits; a JS number is exact only to
 * 2^53. Nothing here turns one into a number, and nothing formats one:
 * `lib/deal-money.ts` does, with Intl and BigInt.
 *
 * WITHHELD IS NOT NULL. Field security OMITS a property and names it in
 * `withheldFields`; a present `null` means "no value". Every withholdable
 * property is therefore `.optional()`, and a screen asks `withheld()` first.
 *
 * SWITCH ON `code`, NEVER ON `message`. The screen localises as
 * `records.error.<code>`; `details` carry paths and reasons, never values.
 */

export const PIPELINES_PATH = '/api/v1/pipelines';
export const DEALS_PATH = '/api/v1/deals';
const CONTACTS_PATH = '/api/v1/contacts';
const ACCOUNTS_PATH = '/api/v1/accounts';

/** DealMoney's currencies (D-L88, D-L115): four, never USD, never converted. */
export const DEAL_CURRENCIES = ['NGN', 'GHS', 'KES', 'ZAR'] as const;
export type DealCurrency = (typeof DEAL_CURRENCIES)[number];

export function isDealCurrency(value: string): value is DealCurrency {
  return (DEAL_CURRENCIES as readonly string[]).includes(value);
}

export const DealMoney = z.object({
  amountMinor: z.string().regex(/^(0|[1-9][0-9]{0,17})$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type DealMoney = z.infer<typeof DealMoney>;

export const StageTotal = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountMinor: z.string().regex(/^(0|[1-9][0-9]{0,23})$/),
  weightedAmountMinor: z.string().regex(/^(0|[1-9][0-9]{0,23})$/),
});
export type StageTotal = z.infer<typeof StageTotal>;

export const REQUIREMENT_FIELDS = ['amount', 'expectedCloseDate', 'nextStep', 'primaryContactId', 'accountId'] as const;
export const RequirementField = z.enum(REQUIREMENT_FIELDS);
export type RequirementField = z.infer<typeof RequirementField>;

export const StageRequirement = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('field'), field: RequirementField }),
  z.object({ id: z.string(), kind: z.literal('check'), label: z.string() }),
]);
export type StageRequirement = z.infer<typeof StageRequirement>;

export const StageKind = z.enum(['open', 'won', 'lost']);
export type StageKind = z.infer<typeof StageKind>;

export const PipelineStage = z.object({
  id: z.string(),
  name: z.string(),
  kind: StageKind,
  position: z.number().int(),
  probabilityBp: z.number().int(),
  rottingAfterDays: z.number().int().nullable(),
  requirements: z.array(StageRequirement),
});
export type PipelineStage = z.infer<typeof PipelineStage>;

export const Pipeline = z.object({
  id: z.string(),
  programmeId: z.string(),
  name: z.string(),
  version: z.number().int(),
  stages: z.array(PipelineStage),
  transitions: z.array(z.object({ fromStageId: z.string(), toStageId: z.string() })),
});
export type Pipeline = z.infer<typeof Pipeline>;

export const PipelineSummary = z.object({ id: z.string(), name: z.string() });
export type PipelineSummary = z.infer<typeof PipelineSummary>;

export const PipelinePage = z.object({ data: z.array(PipelineSummary), nextCursor: z.string().nullable() });
export type PipelinePage = z.infer<typeof PipelinePage>;

export const DealRotting = z.enum(['fresh', 'stale', 'rotting']);
export type DealRotting = z.infer<typeof DealRotting>;

/**
 * One deal: a board card and a list row alike. Summary ids are plain strings
 * on purpose: the screen links a summary only from a well-formed uuid, and a
 * malformed one must still draw the card (as text), not fail the whole board.
 */
export const Deal = z.object({
  id: z.string(),
  programmeId: z.string(),
  pipelineId: z.string(),
  stageId: z.string(),
  version: z.number().int(),
  name: z.string(),
  amount: DealMoney.nullable().optional(),
  weightedAmount: DealMoney.nullable().optional(),
  expectedCloseDate: z.string().nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
  owner: z.object({ id: z.string(), displayName: z.string().nullable() }).nullable().optional(),
  primaryContactId: z.string().nullable().optional(),
  contact: z.object({ id: z.string(), displayName: z.string() }).nullable().optional(),
  accountId: z.string().nullable().optional(),
  account: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  nextStep: z.string().nullable().optional(),
  stageEnteredAt: z.string(),
  closedAt: z.string().nullable(),
  rotting: DealRotting.nullable(),
  checks: z.array(z.object({ requirementId: z.string() })),
  withheldFields: z.array(z.string()),
});
export type Deal = z.infer<typeof Deal>;

export const DealPage = z.object({ data: z.array(Deal), nextCursor: z.string().nullable() });
export type DealPage = z.infer<typeof DealPage>;

export const BoardStage = z.object({
  stageId: z.string(),
  count: z.number().int(),
  totals: z.array(StageTotal).optional(),
  cards: z.array(Deal),
  nextCursor: z.string().nullable(),
});
export type BoardStage = z.infer<typeof BoardStage>;

export const PipelineBoard = z.object({
  pipelineId: z.string(),
  closedSince: z.string(),
  withheldFields: z.array(z.string()),
  stages: z.array(BoardStage),
});
export type PipelineBoard = z.infer<typeof PipelineBoard>;

/** `true` when field security withheld `field` from this caller. */
export function withheld(holder: { readonly withheldFields: readonly string[] }, field: string): boolean {
  return holder.withheldFields.includes(field);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** The request never arrived, or the answer was not the contract's. */
export const NETWORK = 'network' as const;

export interface PipelineErrorDetail {
  readonly path: string;
  readonly code: string;
}

export interface PipelineError {
  /** The HTTP status, or 0 when the request never arrived or the answer was not the contract's. */
  readonly status: number;
  /** The contract's `code`, or `network`. */
  readonly code: string;
  readonly details: readonly PipelineErrorDetail[];
}

export type PipelineResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: PipelineError };

const ApiError = z.object({
  code: z.string(),
  details: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});

const NETWORK_FAILURE: PipelineError = { status: 0, code: NETWORK, details: [] };

/**
 * One same-origin request, its answer parsed with `schema`. There is no header
 * argument: nothing a screen sends may name a scope. Nothing is cached: every
 * answer carries personal data at a URL that is the same for every user. A
 * body goes as POST unless `method` says PATCH (the deal detail's updateDeal,
 * T-0110, in `lib/deal-detail-api.ts`).
 */
export async function pipelineRequest<T>(
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  body?: unknown,
  method?: 'POST' | 'PATCH',
): Promise<PipelineResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : (method ?? 'POST'),
      cache: 'no-store',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, error: NETWORK_FAILURE };
  }
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = schema.safeParse(payload);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: NETWORK_FAILURE };
  }
  const parsed = ApiError.safeParse(payload);
  return parsed.success
    ? { ok: false, error: { status: response.status, code: parsed.data.code, details: parsed.data.details ?? [] } }
    : { ok: false, error: NETWORK_FAILURE };
}

function pipelinePath(id: string): string {
  return `${PIPELINES_PATH}/${encodeURIComponent(id)}`;
}

export function dealPath(id: string): string {
  return `${DEALS_PATH}/${encodeURIComponent(id)}`;
}

export function withSearch(path: string, params: URLSearchParams): string {
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listPipelines(cursor?: string): Promise<PipelineResult<PipelinePage>> {
  const params = new URLSearchParams();
  if (cursor !== undefined) params.set('cursor', cursor);
  return pipelineRequest(withSearch(PIPELINES_PATH, params), PipelinePage);
}

export function getPipeline(id: string): Promise<PipelineResult<Pipeline>> {
  return pipelineRequest(pipelinePath(id), Pipeline);
}

/**
 * The filters the board and the list share (R14). Only parameters the
 * contract declares; a filter on a withheld field is never built (the screen
 * does not offer it), and `closedSince` is absent for the server's 90 days.
 */
export interface DealFilters {
  readonly q: string;
  readonly owner: readonly string[];
  readonly currency: readonly string[];
  readonly closeFrom: string;
  readonly closeTo: string;
  /** A UTC date-time with a `Z`, or `null` for the server's default window. */
  readonly closedSince: string | null;
}

/** `q`'s `maxLength`. */
export const DEAL_QUERY_MAX = 100;

export function filterParams(filters: DealFilters): URLSearchParams {
  const params = new URLSearchParams();
  const q = filters.q.trim().slice(0, DEAL_QUERY_MAX).trim();
  if (q !== '') params.set('q', q);
  for (const value of filters.owner) params.append('owner', value);
  if (filters.closeFrom !== '') params.set('closeFrom', filters.closeFrom);
  if (filters.closeTo !== '') params.set('closeTo', filters.closeTo);
  for (const value of filters.currency) params.append('currency', value);
  if (filters.closedSince !== null) params.set('closedSince', filters.closedSince);
  return params;
}

/** The whole board, or one column's next page (its `stageId` with its `cursor`, the same filters). */
export function getPipelineBoard(
  id: string,
  filters: DealFilters,
  page?: { readonly stageId: string; readonly cursor: string },
): Promise<PipelineResult<PipelineBoard>> {
  const params = filterParams(filters);
  if (page !== undefined) {
    params.set('stageId', page.stageId);
    params.set('cursor', page.cursor);
  }
  return pipelineRequest(withSearch(`${pipelinePath(id)}/board`, params), PipelineBoard);
}

/** listDeals' fixed sort keys this screen offers: none of them a field security could withhold. */
export const DEAL_SORTS = ['-updatedAt', '-createdAt', 'name', 'stageEnteredAt'] as const;
export type DealSort = (typeof DEAL_SORTS)[number];
export const DEFAULT_DEAL_SORT: DealSort = '-updatedAt';

export function listDeals(id: string, filters: DealFilters, sort: DealSort, cursor?: string): Promise<PipelineResult<DealPage>> {
  const params = filterParams(filters);
  if (sort !== DEFAULT_DEAL_SORT) params.set('sort', sort);
  if (cursor !== undefined) params.set('cursor', cursor);
  return pipelineRequest(withSearch(`${pipelinePath(id)}/deals`, params), DealPage);
}

export function getDeal(id: string): Promise<PipelineResult<Deal>> {
  return pipelineRequest(dealPath(id), Deal);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * CreateDealRequest as this screen sends it: a name and only the optional
 * fields the person filled (R7). Never `ownerUserId` (the caller is the owner
 * by default; reassignment is the deal detail's), never a programme, pipeline
 * or stage: the server puts a new deal in the first open stage.
 */
export interface CreateDealBody {
  readonly name: string;
  readonly amount?: DealMoney;
  readonly expectedCloseDate?: string;
  readonly nextStep?: string;
}

export function createDeal(pipelineId: string, body: CreateDealBody): Promise<PipelineResult<Deal>> {
  const sent: CreateDealBody = {
    name: body.name,
    ...(body.amount === undefined ? {} : { amount: { amountMinor: body.amount.amountMinor, currency: body.amount.currency } }),
    ...(body.expectedCloseDate === undefined ? {} : { expectedCloseDate: body.expectedCloseDate }),
    ...(body.nextStep === undefined ? {} : { nextStep: body.nextStep }),
  };
  return pipelineRequest(`${pipelinePath(pipelineId)}/deals`, Deal, sent);
}

/** Values for the target stage's field requirements: only what the person filled. */
export interface MoveFields {
  amount?: DealMoney;
  expectedCloseDate?: string;
  nextStep?: string;
  primaryContactId?: string;
  accountId?: string;
}

/** MoveDealRequest: `version` and `toStageId`, plus `fields` and `checks` only when there are any. */
export interface MoveDealBody {
  readonly version: number;
  readonly toStageId: string;
  readonly fields?: MoveFields;
  readonly checks?: readonly string[];
}

/** The body as sent: `fields` and `checks` only when there are any. */
export function moveDealBody(body: MoveDealBody): MoveDealBody {
  return {
    version: body.version,
    toStageId: body.toStageId,
    ...(body.fields === undefined || Object.keys(body.fields).length === 0 ? {} : { fields: body.fields }),
    ...(body.checks === undefined || body.checks.length === 0 ? {} : { checks: body.checks }),
  };
}

export function moveDeal(id: string, body: MoveDealBody): Promise<PipelineResult<Deal>> {
  return pipelineRequest(`${dealPath(id)}/move`, Deal, moveDealBody(body));
}

// ---------------------------------------------------------------------------
// The requirement prompt's pickers
// ---------------------------------------------------------------------------

export interface PickerRow {
  readonly id: string;
  readonly programmeId: string;
  readonly name: string;
}

const PickedContacts = z.object({
  data: z.array(z.object({ id: z.string(), programmeId: z.string(), displayName: z.string() })),
});
const PickedAccounts = z.object({
  data: z.array(z.object({ id: z.string(), programmeId: z.string(), name: z.string() })),
});

/**
 * Contacts or accounts whose name matches `q`, from the deal's own programme
 * only: the API scopes the search to what the caller reaches, and a record of
 * another programme the caller also reaches is never offered (the move would
 * be `400 unknown_reference`).
 */
export async function searchRecords(
  kind: 'primaryContactId' | 'accountId',
  q: string,
  programmeId: string,
): Promise<PipelineResult<readonly PickerRow[]>> {
  const params = new URLSearchParams({ q: q.trim().slice(0, DEAL_QUERY_MAX) });
  if (kind === 'primaryContactId') {
    const result = await pipelineRequest(withSearch(CONTACTS_PATH, params), PickedContacts);
    if (!result.ok) return result;
    return {
      ok: true,
      value: result.value.data
        .filter((row) => row.programmeId === programmeId)
        .map((row) => ({ id: row.id, programmeId: row.programmeId, name: row.displayName })),
    };
  }
  const result = await pipelineRequest(withSearch(ACCOUNTS_PATH, params), PickedAccounts);
  if (!result.ok) return result;
  return { ok: true, value: result.value.data.filter((row) => row.programmeId === programmeId) };
}
