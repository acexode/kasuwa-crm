import * as z from 'zod/mini';
import {
  Deal,
  dealPath,
  moveDealBody,
  pipelineRequest,
  withSearch,
  type DealMoney,
  type MoveDealBody,
  type PipelineResult,
} from './pipelines-api';

/**
 * The deal detail's half of `docs/api/records.openapi.yaml` (T-0110, P06/05):
 * `getDeal` and `moveDeal` read as the full Deal (who ticked each check, and
 * when), `updateDeal`, `listDealTimeline` (T-0111), `createActivity` with
 * `dealId`, and `getCurrentUser` (the caller's id, for "assign to me").
 *
 * Its own module, beside `pipelines-api.ts` and on its transport, so the board
 * (T-0109) ships none of it.
 *
 * SAME-ORIGIN, NO SCOPE ARGUMENT, NOTHING CACHED, as `pipelines-api.ts` says.
 * MONEY IS A STRING. WITHHELD IS NOT NULL: a withheld property is omitted and
 * named in `withheldFields`; `null` is "no value".
 */

const ACTIVITIES_PATH = '/api/v1/activities';
const ME_PATH = '/api/v1/auth/me';

/** One requirement check on a deal: who ticked it (named as they are now, or `null` for a former checker, D-L127) and when. */
export const DealCheck = z.object({
  requirementId: z.string(),
  checkedAt: z.string(),
  checkedBy: z.object({ id: z.string(), displayName: z.nullable(z.string()) }),
});
export type DealCheck = z.infer<typeof DealCheck>;

/** The Deal as the detail reads it: the board's shape with each check's checker and time. */
export const DealDetail = z.extend(Deal, { checks: z.array(DealCheck) });
export type DealDetail = z.infer<typeof DealDetail>;

export function getDealDetail(id: string): Promise<PipelineResult<DealDetail>> {
  return pipelineRequest(dealPath(id), DealDetail);
}

/**
 * UpdateDealRequest as this screen sends it: `version` plus ONLY what the
 * person changed (D-L102). `null` clears. `ownerUserId` only ever the caller
 * ("assign to me", R11).
 */
export interface UpdateDealBody {
  readonly version: number;
  /** A per-key merge of custom-field values (T-0091): only what changed; `null` clears. */
  readonly custom?: Readonly<Record<string, unknown>>;
  readonly name?: string;
  readonly amount?: DealMoney | null;
  readonly expectedCloseDate?: string | null;
  readonly nextStep?: string | null;
  readonly primaryContactId?: string | null;
  readonly accountId?: string | null;
  readonly ownerUserId?: string;
}

export function updateDeal(id: string, body: UpdateDealBody): Promise<PipelineResult<DealDetail>> {
  return pipelineRequest(dealPath(id), DealDetail, body, 'PATCH');
}

export function moveDealDetail(
  id: string,
  body: MoveDealBody,
): Promise<PipelineResult<DealDetail>> {
  return pipelineRequest(`${dealPath(id)}/move`, DealDetail, moveDealBody(body));
}

// ---------------------------------------------------------------------------
// The timeline (T-0111): field changes by name only, and activities
// ---------------------------------------------------------------------------

export const DEAL_TIMELINE_FIELDS = [
  'name',
  'amount',
  'expectedCloseDate',
  'ownerUserId',
  'primaryContactId',
  'accountId',
  'nextStep',
  'stageId',
  'checks',
] as const;
export type DealTimelineField = (typeof DEAL_TIMELINE_FIELDS)[number];

const TimelineActor = z.object({ id: z.string(), displayName: z.string() });

const DealFieldChangedItem = z.object({
  id: z.string(),
  type: z.literal('field_changed'),
  occurredAt: z.string(),
  actor: z.nullable(TimelineActor),
  field: z.enum(DEAL_TIMELINE_FIELDS),
  redacted: z.literal(true),
});

export const DEAL_ACTIVITY_KINDS = ['note', 'task', 'call', 'meeting'] as const;

const DealActivityItem = z.object({
  id: z.string(),
  type: z.literal('activity'),
  occurredAt: z.string(),
  actor: z.nullable(TimelineActor),
  activityId: z.string(),
  activityType: z.enum(DEAL_ACTIVITY_KINDS),
  subject: z.optional(z.nullable(z.string())),
  body: z.optional(z.nullable(z.string())),
  dueAt: z.optional(z.nullable(z.string())),
  completedAt: z.optional(z.nullable(z.string())),
  startsAt: z.optional(z.nullable(z.string())),
  endsAt: z.optional(z.nullable(z.string())),
  version: z.optional(z.int()),
});

export const DealTimelineItem = z.discriminatedUnion('type', [
  DealFieldChangedItem,
  DealActivityItem,
]);
export type DealTimelineItem = z.infer<typeof DealTimelineItem>;

export const DealTimelinePage = z.object({
  data: z.array(DealTimelineItem),
  nextCursor: z.nullable(z.string()),
});
export type DealTimelinePage = z.infer<typeof DealTimelinePage>;

/** One page, newest first. The cursor is echoed exactly as served; no limit (the server's 25), no total. */
export function listDealTimeline(
  id: string,
  cursor: string | null,
): Promise<PipelineResult<DealTimelinePage>> {
  const params = new URLSearchParams();
  if (cursor !== null) params.set('cursor', cursor);
  return pipelineRequest(withSearch(`${dealPath(id)}/timeline`, params), DealTimelinePage);
}

// ---------------------------------------------------------------------------
// Logging an activity against the deal (D-L129)
// ---------------------------------------------------------------------------

export const DealActivity = z.object({
  id: z.string(),
  type: z.enum(DEAL_ACTIVITY_KINDS),
  version: z.int(),
  subject: z.optional(z.nullable(z.string())),
  body: z.optional(z.nullable(z.string())),
  dueAt: z.optional(z.nullable(z.string())),
  completedAt: z.optional(z.nullable(z.string())),
  startsAt: z.optional(z.nullable(z.string())),
  endsAt: z.optional(z.nullable(z.string())),
  withheldFields: z.array(z.string()),
});
export type DealActivity = z.infer<typeof DealActivity>;

/** The deal's own targets: its served primary contact and account, whichever the caller can see. Never another. */
export interface DealActivityTargets {
  readonly contactId: string | null;
  readonly accountId: string | null;
}

export interface DealActivityDraft {
  readonly type: 'note' | 'task' | 'call';
  readonly subject?: string;
  readonly body?: string;
  /** UTC, with a `Z`. Tasks only. */
  readonly dueAt?: string;
  /** Custom-field values (T-0091): the filled ones only, on a create. */
  readonly custom?: Readonly<Record<string, unknown>>;
}

/**
 * createActivity's body: the type, `dealId`, the deal's targets, and only the
 * text typed (an empty box is left out, never `""`). No owner (the caller is
 * the default) and no programme.
 */
export function dealActivityBody(
  dealId: string,
  targets: DealActivityTargets,
  draft: DealActivityDraft,
): Record<string, unknown> {
  const body: Record<string, unknown> = { type: draft.type, dealId };
  if (targets.contactId !== null) body.contactId = targets.contactId;
  if (targets.accountId !== null) body.accountId = targets.accountId;
  const subject = draft.subject?.trim() ?? '';
  const text = draft.body?.trim() ?? '';
  if (subject !== '') body.subject = subject;
  if (text !== '') body.body = text;
  if (draft.type === 'task' && draft.dueAt !== undefined) body.dueAt = draft.dueAt;
  if (draft.custom !== undefined && Object.keys(draft.custom).length > 0) body.custom = draft.custom;
  return body;
}

export function createDealActivity(
  dealId: string,
  targets: DealActivityTargets,
  draft: DealActivityDraft,
): Promise<PipelineResult<DealActivity>> {
  return pipelineRequest(ACTIVITIES_PATH, DealActivity, dealActivityBody(dealId, targets, draft));
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/** getCurrentUser, narrowed to the id "assign to me" sends. The email is never read. */
export const Caller = z.object({ id: z.string(), displayName: z.string() });
export type Caller = z.infer<typeof Caller>;

export function getCaller(): Promise<PipelineResult<Caller>> {
  return pipelineRequest(ME_PATH, Caller);
}
