import type { Page, Request, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  A_PHARMACY,
  CURRENCIES,
  CURRENT_USER,
  C_ALPHA,
  C_BETA,
  DEAL_ID,
  D_N2,
  HOSTILE_ACCOUNT_ID,
  HOSTILE_CONTACT_ID,
  HOSTILE_NAME,
  ME,
  NOW_MS,
  OTHER,
  PICK_ACCOUNTS,
  PICK_CONTACTS,
  PIPELINE_ONE,
  PIPELINE_TWO,
  PROGRAMME_ONE,
  PROGRAMME_TWO,
  RECORDS_CONTRACT_SOURCE,
  R_BUDGET,
  R_DRIFT,
  R_QUOTE,
  S_DISCOVERY,
  S_NEGOTIATION,
  S_PROPOSAL,
  S_QUALIFIED,
  WITHHOLDABLE_FIELDS,
  answerProblems,
  asDeal,
  baseDeals,
  daysAgo,
  validateBody,
  withheldIn,
  type PipelineConfig,
  type Stage,
  type StoredCheck,
  type StoredDeal,
} from './pipeline-mock';
import { CUSTOM_FIELDS_PATH, CustomFieldsServer, type CustomFieldsSetup } from './custom-values-mock';

/**
 * The deal detail's half of `docs/api/records.openapi.yaml`, served into the
 * browser by Playwright for T-0110 (the P06/05 deal detail, `/deals/[dealId]`):
 * `getDeal`, `updateDeal`, `moveDeal`, `listDealTimeline`, `createActivity`
 * (with `dealId`), `getPipeline` (stage names and requirement labels), the
 * pickers (`listContacts` and `listAccounts`, `q` only), `listMyProgrammes`
 * and `getCurrentUser`.
 *
 * It IMPORTS `pipeline-mock.ts` (T-0109's, hash-pinned by both suites) and
 * never edits it: the pipelines, stages, requirements, people, contacts,
 * accounts, the base deals and the validator are that file's, so the two
 * screens cannot disagree about what a deal is. T-0109's mock cannot serve
 * this screen as it stands: its getDeal refuses any deal the screen was not
 * first served on the board, and updateDeal, the timeline and createActivity
 * are violations there.
 *
 * ---------------------------------------------------------------------------
 * EVERY ANSWER CHECKED AGAINST THE CONTRACT
 *
 *   Every body this mock answers with is validated, strictly (a property the
 *   schema does not name is a fault), against the schema the contract
 *   declares for that operation and status. A fault is the MOCK's, recorded
 *   in `mockFaults`, which the spec's `afterEach` requires to be empty. The
 *   one exception is `hostileSummaries` (summary ids that are not uuids, on
 *   purpose), filed in `plantedFaults` exactly as T-0109's mock does.
 *
 *   A former checker is served `checkedBy.displayName: null` (D-L127). That
 *   is contract-valid only since the lead's DealActor edit in this branch, so
 *   the extra deals' load-time check below proves the edit is there.
 *
 * WHAT IS NOT IN THE CONTRACT, AND IS THEREFORE DECLARED HERE
 *
 *   - The base deals are T-0109's (`baseDeals()`). This file adds X_FULL,
 *     X_MINE and X_LONG (synthetic names only, CLAUDE.md 6.1) and the
 *     timelines. Only deals with a timeline below have items; the rest have
 *     none.
 *   - Field security: T-0109's per-programme matrix (PROGRAMME_TWO withholds
 *     amount, ownerUserId and expectedCloseDate), unless `withheld` replaces
 *     it for every programme. `readOnly` names deal fields the caller reads
 *     but may not edit: the contract has no way to say so before a write, so
 *     updateDeal's `403 field_not_editable` is how the screen learns it.
 *   - The activity's `deal_id` field security (`activityDealLink`): `hidden`
 *     (neither read nor written: no activity item on the timeline, and a
 *     create naming `dealId` is `403 field_not_editable`), or `writeOnly`
 *     (written, never read: the create succeeds, the answer withholds
 *     `dealId`, and the timeline shows no activity item).
 *   - Rights (`role`): `team_lead` by default (`deal.write_any`,
 *     `deal.reassign`, `activity.write`); `agent` (edits and moves its own
 *     open deals; no reassign); `qa_analyst` (reads only: every write 403).
 *   - Membership: ME and OTHER are members of every programme. FORMER_OWNER
 *     (T-0109's) and FORMER_CHECKER are not; a timeline actor is always
 *     named (TimelineActor, D-L81), FORMER_MEMBER included.
 *
 * WHAT THE MOCK ENFORCES ON EVERY REQUEST (recorded as `violations`, the
 * SCREEN's fault; `afterEach` in the spec fails a test that has any)
 *
 *   - Only the operations above. Anything else under `/api/v1/` is a
 *     violation (a board read from the detail, an updateActivity, a US$ rate,
 *     products, quotes, a count), unless `behindBoard` hands the board's own
 *     operations to the routes installed before this one (T-0109's mock).
 *   - No request header names a programme or a tenant (CLAUDE.md 2.2).
 *   - A deal id in a path that is not a uuid is never sent (the route's real
 *     404 reads nothing). getDeal takes no query.
 *   - getPipeline only for the pipeline of a deal the screen was served.
 *   - The timeline: `cursor` and `limit` only, `limit` 1..100, a cursor only
 *     for the deal it was served for, echoed exactly.
 *   - updateDeal, the D-L102 rules, judged against the deal as it was served
 *     at the `version` sent:
 *       the closed `UpdateDealRequest`; a version the screen was served; a
 *       version already answered 409 is a blind retry; a field sent with the
 *       value the deal already held is not "only what changed"; a field sent
 *       with the value somebody else just replaced undoes their save; a
 *       withheld field is never sent; `ownerUserId` only ever the caller
 *       (R11: the screen offers "assign to me" and nothing else); a contact
 *       or account only one the picker served in the deal's programme; a
 *       blank name is never sent; `amount.currency` one of the four.
 *   - moveDeal: T-0109's rules, against this mock's own record of what was
 *     served (see that file's header).
 *   - createActivity: the closed body; `dealId` the deal on screen; the
 *     targets exactly the deal's served `primaryContactId` (as `contactId`)
 *     and `accountId`, whichever are served and non-null, never a withheld
 *     one; at least one; `dueAt` on a task only; `ownerUserId` absent or the
 *     caller; no empty string for subject or body.
 *
 * SERVER BEHAVIOUR THE SCREEN DEPENDS ON, IMPLEMENTED AS THE CONTRACT SAYS
 *
 *   - Error order: updateDeal 404, 403 (the action, owner_not_self,
 *     field_not_editable), 400, 409; moveDeal as T-0109's; createActivity
 *     404, 403, 400. A refusal writes nothing.
 *   - Every successful write appends to the deal's timeline: one
 *     `field_changed` item per field an update changed; a move's `stageId`
 *     item, one per field it filled and a `checks` item when it ticked one;
 *     an `activity` item for a create. A write answers the new Deal (or
 *     Activity) and advances `version`.
 *   - The timeline: newest first (`occurredAt`, then item id, descending);
 *     field items for a field withheld from the caller omitted; activity
 *     items omitted when the activity's deal link is withheld; omission
 *     before the page is cut; keyset only.
 *   - `concurrent`: before each of the screen's writes (update or move) of
 *     the named deal lands, somebody else (OTHER) saves the next change in
 *     the list, so that write is `409 stale_write`; a re-read serves it.
 *   - `requirementDrift` / `transitionDrift`: as T-0109's (the server judges
 *     against the new configuration from the start; getPipeline serves the
 *     old one on the first read and the new one after).
 * ---------------------------------------------------------------------------
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The records contract, read here as well, for the operations T-0109's mock does not cover. */
const CONTRACT: unknown = parse(readFileSync(resolve(repoRoot, RECORDS_CONTRACT_SOURCE), 'utf8'));

function at(node: unknown, ...path: string[]): unknown {
  let current: unknown = node;
  for (const segment of path) {
    if (!isJson(current)) throw new Error(`contract: nothing at ${path.join('.')}`);
    current = current[segment];
  }
  if (current === undefined) throw new Error(`contract: nothing at ${path.join('.')}`);
  return current;
}

/** Follows a local `$ref` (`#/components/…`). */
function local(node: unknown): unknown {
  if (isJson(node) && typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    return local(at(CONTRACT, ...node.$ref.slice(2).split('/')));
  }
  return node;
}

const PIPELINES_PATH = '/api/v1/pipelines';
const DEALS_PATH = '/api/v1/deals';
const ACTIVITIES_PATH = '/api/v1/activities';
const CONTACTS_PATH = '/api/v1/contacts';
const ACCOUNTS_PATH = '/api/v1/accounts';
const PROGRAMMES_PATH = '/api/v1/me/programmes';
const ME_PATH = '/api/v1/auth/me';

const OP = {
  getPipeline: [`${PIPELINES_PATH}/{pipelineId}`, 'get'],
  getDeal: [`${DEALS_PATH}/{dealId}`, 'get'],
  updateDeal: [`${DEALS_PATH}/{dealId}`, 'patch'],
  moveDeal: [`${DEALS_PATH}/{dealId}/move`, 'post'],
  listDealTimeline: [`${DEALS_PATH}/{dealId}/timeline`, 'get'],
  createActivity: [ACTIVITIES_PATH, 'post'],
  listContacts: [CONTACTS_PATH, 'get'],
  listAccounts: [ACCOUNTS_PATH, 'get'],
  listMyProgrammes: [PROGRAMMES_PATH, 'get'],
} as const;

export type DealOperation = keyof typeof OP | 'getCurrentUser';

/**
 * What is wrong with answering `operation` with `status` and `body`, judged
 * strictly against the response the contract declares. An undeclared status
 * is itself a problem.
 */
export function dealAnswerProblems(operation: DealOperation, status: number, body: unknown): string[] {
  if (operation === 'getCurrentUser') return answerProblems('getCurrentUser', status, body);
  const [path, method] = OP[operation];
  const responses = at(CONTRACT, 'paths', path, method, 'responses') as Json;
  const declared = responses[String(status)];
  if (declared === undefined) return [`${operation} declares no ${status} response`];
  const schema = at(local(declared), 'content', 'application/json', 'schema');
  return validateBody(body, schema, `${operation} ${status}`, CONTRACT, true);
}

/** The `code`s an operation can answer with, from its error responses' examples. */
export function dealErrorCodes(operation: keyof typeof OP): string[] {
  const [path, method] = OP[operation];
  const codes = new Set<string>();
  for (const [status, raw] of Object.entries(at(CONTRACT, 'paths', path, method, 'responses') as Json)) {
    if (status.startsWith('2')) continue;
    const json = at(local(raw), 'content', 'application/json') as Json;
    const examples = [json.example, ...Object.values((json.examples ?? {}) as Json).map((entry) => (isJson(entry) ? entry.value : undefined))];
    for (const example of examples) {
      if (isJson(example) && typeof example.code === 'string') codes.add(example.code);
    }
  }
  return [...codes].sort();
}

function errorExample(response: string, name?: string): Json {
  const json = at(local(at(CONTRACT, 'components', 'responses', response)), 'content', 'application/json') as Json;
  return clone(name === undefined ? json.example : at(json.examples, name, 'value')) as Json;
}

function validation(response: string, details: { path: string; code: string }[]): Json {
  const body = errorExample(response, 'badCursor');
  body.details = details;
  return body;
}

const notFound = (): Json => errorExample('PipelineRecordNotFound');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

/** The Limit parameter's bounds and default (25, 1..100). */
const LIMIT = local(at(CONTRACT, 'components', 'parameters', 'Limit')) as { schema: { default: number; minimum: number; maximum: number } };
export const TIMELINE_DEFAULT_LIMIT = LIMIT.schema.default;

// ---------------------------------------------------------------------------
// People (synthetic text only, CLAUDE.md 6.1)
// ---------------------------------------------------------------------------

/** Ticked a check, then left the programme: served `checkedBy.displayName: null` (D-L127). */
export const FORMER_CHECKER = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e0a', displayName: 'Synthetic Former Checker' };
/** Acted on the deal, then left the programme: still named on the timeline (TimelineActor, D-L81). */
export const FORMER_MEMBER = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e0b', displayName: 'Synthetic Former Member' };

const MEMBERS = new Set([ME.id, OTHER.id]);

/** A check whose requirement is no longer in the pipeline's configuration (it stays recorded on the deal). */
export const ORPHAN_REQUIREMENT_ID = '4c5d6e7f-8a9b-4c0d-8e1f-2a3b4c5d6e77';

// ---------------------------------------------------------------------------
// Deals: T-0109's base deals plus three of this screen's own
// ---------------------------------------------------------------------------

const DEAL_SCHEMA = at(CONTRACT, 'components', 'schemas', 'Deal');
const PIPELINES: readonly PipelineConfig[] = [PIPELINE_ONE, PIPELINE_TWO];

function pipelineOf(id: string): PipelineConfig {
  const pipeline = PIPELINES.find((candidate) => candidate.id === id);
  if (pipeline === undefined) throw new Error(`no pipeline ${id}`);
  return pipeline;
}

function stageIn(pipeline: PipelineConfig, stageId: string): Stage | undefined {
  return pipeline.stages.find((stage) => stage.id === stageId);
}

const tick = (requirementId: string, when: string, by: { id: string; displayName: string }): StoredCheck => ({
  requirementId,
  checkedAt: when,
  checkedBy: clone(by),
});

function own(n: number, stage: Stage, name: string, extra: Partial<StoredDeal>): StoredDeal {
  return {
    id: DEAL_ID(n),
    pipelineId: PIPELINE_ONE.id,
    stageId: stage.id,
    version: 1,
    name,
    amount: null,
    expectedCloseDate: null,
    ownerUserId: ME.id,
    contact: null,
    account: null,
    nextStep: null,
    stageEnteredAt: daysAgo(1),
    closedAt: null,
    checks: [],
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    ...extra,
  };
}

/**
 * Everything on the header at once: an amount whose weighted value is the
 * contract's example (1500000015 at 70% is 1050000010.5, half-even to
 * 1050000010), a contact and an account, a next step, a close date, owned by
 * OTHER (so a team lead may take it), and three checks: one by a member, one
 * by a FORMER checker (D-L127) and one whose requirement is no longer
 * configured.
 */
export const X_FULL = own(0xc01, S_NEGOTIATION, 'Synthetic Foods Q4 supply', {
  amount: { amountMinor: '1500000015', currency: 'NGN' },
  expectedCloseDate: '2026-10-31',
  ownerUserId: OTHER.id,
  contact: clone(C_ALPHA),
  account: clone(A_PHARMACY),
  nextStep: 'Send the revised quote',
  stageEnteredAt: daysAgo(9),
  checks: [tick(R_BUDGET.id, daysAgo(20), OTHER), tick(R_QUOTE.id, daysAgo(9), FORMER_CHECKER), tick(ORPHAN_REQUIREMENT_ID, daysAgo(30), ME)],
  version: 5,
  updatedAt: daysAgo(1),
});

/** The caller's own deal, in Proposal WITHOUT Proposal's check (a requirement can be unmet in the current stage), contact only, shillings. */
export const X_MINE = own(0xc02, S_PROPOSAL, 'Synthetic kiosk renewal', {
  amount: { amountMinor: '7500050', currency: 'KES' },
  contact: clone(C_BETA),
  stageEnteredAt: daysAgo(3),
  version: 3,
});

/** More history than any legal page (130 items): "load older" is needed whatever limit the screen sends. Account only. */
export const X_LONG = own(0xc03, S_DISCOVERY, 'Synthetic long history', {
  account: clone(A_PHARMACY),
  stageEnteredAt: daysAgo(2),
  version: 2,
});

/** Out of the caller's reach (another programme or tenant): the one 404. */
export const OUT_OF_SCOPE_DEAL_ID = DEAL_ID(0xd99);
/** Names nothing at all: the same 404. */
export const NO_SUCH_DEAL_ID = DEAL_ID(0xd98);

const OWN_DEALS: readonly StoredDeal[] = [X_FULL, X_MINE, X_LONG];

for (const row of OWN_DEALS) {
  const problems = validateBody(serveRow(row, withheldIn(PROGRAMME_ONE.id), PIPELINE_ONE), DEAL_SCHEMA, `deal ${row.id}`, CONTRACT, true);
  if (problems.length > 0) {
    throw new Error(`${row.name} disagrees with ${RECORDS_CONTRACT_SOURCE}: ${problems.join('; ')} (a former checker needs DealActor.displayName nullable, D-L127)`);
  }
}

/** The base store: T-0109's deals and this screen's own. */
export function detailDeals(): readonly StoredDeal[] {
  return [...baseDeals(), ...OWN_DEALS];
}

/**
 * The Deal this caller is served for `row`, with `withheld` applied: the
 * named fields and their companions omitted and listed; a checker who is no
 * longer a member unnamed (D-L127). T-0109's `asDeal` builds the rest.
 */
function serveRow(row: StoredDeal, withheld: readonly string[], config: PipelineConfig): Json {
  const out = asDeal(row, { ...config, programmeId: PROGRAMME_ONE.id });
  out.programmeId = config.programmeId;
  const companions: Readonly<Record<string, string>> = { amount: 'weightedAmount', ownerUserId: 'owner', primaryContactId: 'contact', accountId: 'account' };
  for (const field of withheld) {
    delete out[field];
    const companion = companions[field];
    if (companion !== undefined) delete out[companion];
  }
  out.withheldFields = WITHHOLDABLE_FIELDS.filter((field) => withheld.includes(field));
  out.checks = (out.checks as { requirementId: string; checkedAt: string; checkedBy: { id: string; displayName: string | null } }[]).map((entry) => ({
    ...entry,
    checkedBy: { id: entry.checkedBy.id, displayName: MEMBERS.has(entry.checkedBy.id) ? entry.checkedBy.displayName : null },
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

export type ActivityType = 'note' | 'task' | 'call' | 'meeting';

export interface StoredActivity {
  activityId: string;
  activityType: ActivityType;
  subject: string | null;
  body: string | null;
  dueAt: string | null;
  completedAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  version: number;
}

export interface StoredItem {
  id: string;
  occurredAt: string;
  actor: { id: string; displayName: string } | null;
  field?: string;
  activity?: StoredActivity;
}

/** The deal fields whose timeline items field security can withhold (Deal's own names). */
const ITEM_FIELD_WITHHELD: Readonly<Record<string, string>> = {
  amount: 'amount',
  expectedCloseDate: 'expectedCloseDate',
  ownerUserId: 'ownerUserId',
  primaryContactId: 'primaryContactId',
  accountId: 'accountId',
  nextStep: 'nextStep',
};

let itemCounter = 0;
function itemId(): string {
  itemCounter += 1;
  return `ti_${itemCounter.toString(16).padStart(8, '0')}7e1d0c2b3a4f45e6a7b8c9d0`;
}

const fieldItem = (field: string, occurredAt: string, actor: StoredItem['actor']): StoredItem => ({ id: itemId(), occurredAt, actor: clone(actor), field });

function activityItem(n: number, occurredAt: string, actor: StoredItem['actor'], activity: Partial<StoredActivity> & { activityType: ActivityType }): StoredItem {
  return {
    id: itemId(),
    occurredAt,
    actor: clone(actor),
    activity: {
      activityId: `5e2a7b1c-3d4f-4a6b-8c9d-${n.toString(16).padStart(12, '0')}`,
      subject: null,
      body: null,
      dueAt: null,
      completedAt: null,
      startsAt: null,
      endsAt: null,
      version: 1,
      ...activity,
    },
  };
}

/** X_FULL's history: every deal field name once, the four activity types, the system and a former member. */
export const ITEM_CALL = activityItem(0xe01, daysAgo(0, 3), OTHER, { activityType: 'call', subject: 'Pricing call', body: 'Wants the Q4 prices held until Friday.', version: 2 });
export const ITEM_NEXT_STEP = fieldItem('nextStep', daysAgo(1), ME);
/** Due 2026-10-14T14:00Z: 15:00 in Lagos. */
export const ITEM_TASK = activityItem(0xe02, daysAgo(2), ME, { activityType: 'task', subject: 'Send the revised quote', dueAt: '2026-10-14T14:00:00.000Z', version: 3 });
/** 09:00 to 10:00 UTC: 10:00 to 11:00 in Lagos. */
export const ITEM_MEETING = activityItem(0xe03, daysAgo(3), ME, { activityType: 'meeting', subject: 'Site walk-through', startsAt: '2026-10-08T09:00:00.000Z', endsAt: '2026-10-08T10:00:00.000Z' });
export const ITEM_STAGE = fieldItem('stageId', daysAgo(9), ME);
export const ITEM_CHECKS = fieldItem('checks', daysAgo(9), ME);
export const ITEM_CLOSE = fieldItem('expectedCloseDate', daysAgo(9), ME);
export const ITEM_OWNER = fieldItem('ownerUserId', daysAgo(12), null);
export const ITEM_NOTE = activityItem(0xe04, daysAgo(14), FORMER_MEMBER, { activityType: 'note', body: 'Prefers calls after two in the afternoon.' });
export const ITEM_AMOUNT = fieldItem('amount', daysAgo(20), ME);
export const ITEM_CONTACT = fieldItem('primaryContactId', daysAgo(25), null);
export const ITEM_ACCOUNT = fieldItem('accountId', daysAgo(30), ME);
export const ITEM_NAME = fieldItem('name', daysAgo(30, 1), ME);

/** The deal fields a field_changed item may name (DealFieldChangedItem's enum). */
export const TIMELINE_FIELDS: readonly string[] = (at(CONTRACT, 'components', 'schemas', 'DealFieldChangedItem', 'properties', 'field', 'enum') as unknown[]).map(String);

export const LONG_TIMELINE_LENGTH = 130;
export const LONG_OLDEST_SUBJECT = 'Synthetic oldest note on record';

function letters(n: number): string {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  return `${a[Math.floor(n / 26) % 26] ?? 'a'}${a[n % 26] ?? 'a'}`;
}

function initialTimelines(): Map<string, StoredItem[]> {
  const timelines = new Map<string, StoredItem[]>();
  timelines.set(X_FULL.id, clone([ITEM_CALL, ITEM_NEXT_STEP, ITEM_TASK, ITEM_MEETING, ITEM_STAGE, ITEM_CHECKS, ITEM_CLOSE, ITEM_OWNER, ITEM_NOTE, ITEM_AMOUNT, ITEM_CONTACT, ITEM_ACCOUNT, ITEM_NAME]));
  timelines.set(X_LONG.id, LONG_ITEMS.map((entry) => clone(entry)));
  timelines.set(D_N2.id, D_N2_ITEMS.map((entry) => clone(entry)));
  timelines.set(E_Q1_ID, E_Q1_ITEMS.map((entry) => clone(entry)));
  return timelines;
}

const LONG_ITEMS: readonly StoredItem[] = Array.from({ length: LONG_TIMELINE_LENGTH }, (_, n) =>
  activityItem(0xf00 + n, new Date(NOW_MS - (n + 1) * 3_600_000).toISOString(), ME, {
    activityType: 'note',
    subject: n === LONG_TIMELINE_LENGTH - 1 ? LONG_OLDEST_SUBJECT : `Generated note ${letters(n)}`,
  }),
);

/** D_N2 (contact only): one linked note and its creation. */
const D_N2_ITEMS: readonly StoredItem[] = [
  activityItem(0xe10, daysAgo(0, 5), ME, { activityType: 'note', body: 'Kiosk owners want weekly delivery.' }),
  fieldItem('name', daysAgo(30), ME),
];

/** T-0109's E_Q1 (PROGRAMME_TWO: amount, owner and close date withheld from the caller). */
const E_Q1_ID = DEAL_ID(0x801);
const E_Q1_ITEMS: readonly StoredItem[] = [
  fieldItem('nextStep', daysAgo(1), ME),
  fieldItem('amount', daysAgo(2), ME),
  fieldItem('ownerUserId', daysAgo(3), ME),
  fieldItem('expectedCloseDate', daysAgo(4), ME),
  fieldItem('stageId', daysAgo(5), ME),
  fieldItem('name', daysAgo(30), ME),
];

/** The item as served (DealTimelineItem). */
function serveItem(entry: StoredItem): Json {
  if (entry.activity !== undefined) {
    const { activityId, activityType, subject, body, dueAt, completedAt, startsAt, endsAt, version } = entry.activity;
    return { id: entry.id, type: 'activity', occurredAt: entry.occurredAt, actor: clone(entry.actor), activityId, activityType, subject, body, dueAt, completedAt, startsAt, endsAt, version };
  }
  return { id: entry.id, type: 'field_changed', occurredAt: entry.occurredAt, actor: clone(entry.actor), field: entry.field, redacted: true };
}

function ordered(items: readonly StoredItem[]): StoredItem[] {
  return [...items].sort((a, b) => (a.occurredAt !== b.occurredAt ? (a.occurredAt < b.occurredAt ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export type ActivityDealLink = 'hidden' | 'writeOnly';

/** What the timeline serves for `items`, in order, field security applied, before paging. */
export function visibleItems(items: readonly StoredItem[], withheld: readonly string[], link?: ActivityDealLink): StoredItem[] {
  return ordered(items).filter((entry) => {
    if (entry.activity !== undefined) return link === undefined;
    const guarded = ITEM_FIELD_WITHHELD[String(entry.field)];
    return guarded === undefined || !withheld.includes(guarded);
  });
}

/** The served timeline of a deal as the mock starts, for the spec's oracles. */
export function timelineOf(dealId: string, withheld: readonly string[] = [], link?: ActivityDealLink): Json[] {
  return visibleItems(initialTimelines().get(dealId) ?? [], withheld, link).map(serveItem);
}

/** Activity ids minted by createActivity, in order. */
export const NEW_ACTIVITY_IDS: readonly string[] = Array.from({ length: 8 }, (_, n) => `5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4d${(n + 1).toString(16).padStart(2, '0')}`);

/** Everything the mock serves as record data, for checks that tell it from UI copy (en-XA). */
export function servedDealData(): string {
  return JSON.stringify({
    deals: detailDeals().map((row) => ({ ...row, rendered: serveRow(row, [], pipelineOf(row.pipelineId)) })),
    pipelines: PIPELINES,
    drift: R_DRIFT,
    timelines: [...initialTimelines().values()].flat().map(serveItem),
    hostile: [HOSTILE_NAME, 'Synthetic Hostile Contact', 'Synthetic Hostile Account'],
    contacts: PICK_CONTACTS,
    accounts: PICK_ACCOUNTS,
    people: [ME, OTHER, FORMER_MEMBER],
    programmes: [PROGRAMME_ONE, PROGRAMME_TWO],
    me: CURRENT_USER,
  });
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface DealMockOptions {
  /** The caller's rights in every programme. Default `team_lead`. */
  readonly role?: 'team_lead' | 'agent' | 'qa_analyst';
  /** Deal fields withheld from the caller in EVERY programme (replaces T-0109's matrix). */
  readonly withheld?: readonly string[];
  /** Deal fields the caller reads but may not edit: updateDeal sending one is 403 field_not_editable. */
  readonly readOnly?: readonly string[];
  /** The activity's deal link under field security. */
  readonly activityDealLink?: ActivityDealLink;
  /** Hold every read until `release()`: the loading frame, without a clock. */
  readonly hold?: boolean;
  /** Abort every read, as a dropped connection does. */
  readonly networkFailure?: boolean;
  /** Abort every listDealTimeline read. */
  readonly timelineFailure?: boolean;
  /** Hold every write until `releaseWrites()`. */
  readonly holdWrites?: boolean;
  /** Serve D_Q_MARKUP's contact and account summaries with ids that are not uuids. */
  readonly hostileSummaries?: boolean;
  /** Somebody else saves `dealId` before each of the screen's writes of it lands: a 409 each. */
  readonly concurrent?: { readonly dealId: string; readonly changes: readonly Readonly<Partial<Record<'name' | 'expectedCloseDate' | 'nextStep', string>>>[] };
  /** The server added R_DRIFT to Discovery after the screen's first getPipeline. */
  readonly requirementDrift?: boolean;
  /** The server removed Qualified → Discovery from the allow-list after the screen's first getPipeline. */
  readonly transitionDrift?: boolean;
  /** Hand the board's operations (listPipelines, the board, listDeals, createDeal) to the routes installed before this mock. */
  readonly behindBoard?: boolean;
  /**
   * Custom-field definitions, values and field security (T-0091, lead edit),
   * served by `custom-values-mock.ts`: listCustomFields, the projected
   * `custom` on every Deal and Activity this mock answers with, and the
   * per-key merge of updateDeal's `custom` (checked after the 403s, before the
   * 400s and the 409) and createActivity's. Absent: listCustomFields lists
   * nothing and no deal carries `custom`, so the T-0110 journeys are unchanged.
   */
  readonly customFields?: CustomFieldsSetup;
}

export interface RecordedWrite {
  readonly method: 'PATCH' | 'POST';
  readonly path: string;
  readonly body: unknown;
  status?: number;
}

export interface DealMock {
  /** Every request this mock answered, in order. */
  readonly requests: URL[];
  /** The same requests as `METHOD /path`, in order: tells a re-read from a write on the same path. */
  readonly calls: string[];
  readonly dealReads: URL[];
  readonly pipelineReads: URL[];
  readonly timelineReads: URL[];
  readonly pickerReads: URL[];
  /** Every write, in order, with the status it was answered. */
  readonly writes: RecordedWrite[];
  /** Contract breaches by the SCREEN. Must be empty at the end of every test. */
  readonly violations: string[];
  /** Answers the MOCK built that its contract rejects. Must be empty, always. */
  readonly mockFaults: string[];
  /** The deliberate contract breaches `hostileSummaries` serves. */
  readonly plantedFaults: string[];
  /** The deals as they now stand. */
  readonly store: StoredDeal[];
  /** The timelines as they now stand, by deal id. */
  readonly timelines: Map<string, StoredItem[]>;
  /** The custom-field half (T-0091): definition reads, custom writes and stored values. */
  readonly custom: CustomFieldsServer;
  release(): void;
  releaseWrites(): void;
}

function pathOf(request: Request): string {
  return new URL(request.url()).pathname;
}

export function isGetDeal(request: Request, dealId?: string): boolean {
  const path = pathOf(request);
  return request.method() === 'GET' && (dealId === undefined ? /^\/api\/v1\/deals\/[^/]+$/.test(path) : path === `${DEALS_PATH}/${dealId}`);
}

export function isUpdateDeal(request: Request, dealId?: string): boolean {
  const path = pathOf(request);
  return request.method() === 'PATCH' && (dealId === undefined ? /^\/api\/v1\/deals\/[^/]+$/.test(path) : path === `${DEALS_PATH}/${dealId}`);
}

export function isDealTimeline(request: Request, dealId?: string): boolean {
  const path = pathOf(request);
  return request.method() === 'GET' && (dealId === undefined ? /^\/api\/v1\/deals\/[^/]+\/timeline$/.test(path) : path === `${DEALS_PATH}/${dealId}/timeline`);
}

export function isCreateActivity(request: Request): boolean {
  return request.method() === 'POST' && pathOf(request) === ACTIVITIES_PATH;
}

const UPDATE_SCHEMA = at(CONTRACT, 'components', 'schemas', 'UpdateDealRequest');
const MOVE_SCHEMA = at(CONTRACT, 'components', 'schemas', 'MoveDealRequest');
const ACTIVITY_SCHEMA = at(CONTRACT, 'components', 'schemas', 'CreateActivityRequest');
const PICKER_PARAMETERS = ['q', 'limit', 'cursor', 'sort'];

/** Wire field → stored property. */
const FIELD_PATHS: Readonly<Record<string, keyof StoredDeal>> = {
  name: 'name',
  amount: 'amount',
  expectedCloseDate: 'expectedCloseDate',
  ownerUserId: 'ownerUserId',
  nextStep: 'nextStep',
  primaryContactId: 'contact',
  accountId: 'account',
};

/** A wire value and a stored value, compared as the person would see them. */
function canonical(input: unknown): string {
  if (isJson(input) && 'amountMinor' in input) return `${String(input.amountMinor)} ${String(input.currency)}`;
  if (isJson(input)) return String(input.id);
  return JSON.stringify(input ?? null);
}

function serverTime(n: number): string {
  return new Date(NOW_MS + n * 1000).toISOString();
}

export async function installDealMock(page: Page, options: DealMockOptions = {}): Promise<DealMock> {
  const role = options.role ?? 'team_lead';
  const store = detailDeals().map((row) => clone(row));
  if (options.hostileSummaries === true) {
    const target = store.find((row) => row.name === HOSTILE_NAME);
    if (target !== undefined) {
      target.contact = { id: HOSTILE_CONTACT_ID, displayName: 'Synthetic Hostile Contact' };
      target.account = { id: HOSTILE_ACCOUNT_ID, name: 'Synthetic Hostile Account' };
    }
  }
  const timelines = initialTimelines();
  const requests: URL[] = [];
  const calls: string[] = [];
  const dealReads: URL[] = [];
  const pipelineReads: URL[] = [];
  const timelineReads: URL[] = [];
  const pickerReads: URL[] = [];
  const writes: RecordedWrite[] = [];
  const violations: string[] = [];
  const mockFaults: string[] = [];
  const plantedFaults: string[] = [];
  const custom = new CustomFieldsServer(options.customFields, violations);
  const servedVersions = new Map<string, Set<number>>();
  const servedRows = new Map<string, Map<number, StoredDeal>>();
  /** What the screen was last served of each deal: which fields it could see. */
  const servedWithheld = new Map<string, readonly string[]>();
  const refusedVersions = new Map<string, Set<number>>();
  const overwritten = new Map<string, Map<string, string>>();
  const screenConfig = new Map<string, PipelineConfig>();
  const pipelineReadCount = new Map<string, number>();
  const servedTargets = new Map<string, string>();
  const timelineCursors = new Map<string, { dealId: string; afterId: string }>();
  let cursorCount = 0;
  let writeCount = 0;
  let activityCount = 0;
  let concurrentStep = 0;

  let release: () => void = () => undefined;
  const gate = options.hold === true ? new Promise<void>((done) => (release = done)) : Promise.resolve();
  let releaseWrites: () => void = () => undefined;
  const writeGate = options.holdWrites === true ? new Promise<void>((done) => (releaseWrites = done)) : Promise.resolve();

  const withheldFor = (row: StoredDeal): readonly string[] => options.withheld ?? withheldIn(pipelineOf(row.pipelineId).programmeId);

  const serverConfig = (pipeline: PipelineConfig): PipelineConfig => {
    if (pipeline.id !== PIPELINE_ONE.id || (options.requirementDrift !== true && options.transitionDrift !== true)) return pipeline;
    const next = clone(pipeline);
    next.version += 1;
    next.updatedAt = daysAgo(0, 1);
    if (options.requirementDrift === true) next.stages.find((stage) => stage.id === S_DISCOVERY.id)?.requirements.push(clone(R_DRIFT));
    if (options.transitionDrift === true) {
      next.transitions = next.transitions.filter((pair) => !(pair.fromStageId === S_QUALIFIED.id && pair.toStageId === S_DISCOVERY.id));
    }
    return next;
  };

  const sanitised = (body: unknown): unknown =>
    JSON.parse(
      JSON.stringify(body)
        .split(JSON.stringify(HOSTILE_CONTACT_ID))
        .join(JSON.stringify(C_BETA.id))
        .split(JSON.stringify(HOSTILE_ACCOUNT_ID))
        .join(JSON.stringify(A_PHARMACY.id)),
    ) as unknown;

  const answer = (route: Route, operation: DealOperation, status: number, body: unknown): Promise<void> => {
    const honest = new Set(options.hostileSummaries === true ? dealAnswerProblems(operation, status, sanitised(body)) : []);
    for (const problem of dealAnswerProblems(operation, status, body)) {
      (options.hostileSummaries === true && !honest.has(problem) ? plantedFaults : mockFaults).push(problem);
    }
    return route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
  };

  const serve = (row: StoredDeal): Json => {
    const versions = servedVersions.get(row.id) ?? new Set<number>();
    versions.add(row.version);
    servedVersions.set(row.id, versions);
    const rows = servedRows.get(row.id) ?? new Map<number, StoredDeal>();
    rows.set(row.version, clone(row));
    servedRows.set(row.id, rows);
    const withheld = withheldFor(row);
    servedWithheld.set(row.id, withheld);
    const out = serveRow(row, withheld, serverConfig(pipelineOf(row.pipelineId))) as Json & { withheldFields: string[] };
    return custom.decorate(out, 'deal', row.id, pipelineOf(row.pipelineId).programmeId);
  };

  const readBody = (request: Request, label: string): unknown => {
    try {
      return request.postDataJSON() as unknown;
    } catch {
      violations.push(`${label} body is not JSON`);
      return undefined;
    }
  };

  /** The deal a path names, or an answer already sent (a malformed id is the screen's fault; an unreachable one is the API's 404). */
  const resolveDeal = (route: Route, rawId: string, operation: DealOperation): StoredDeal | undefined => {
    const id = decodeURIComponent(rawId);
    if (!UUID_PATTERN.test(id)) {
      violations.push(`${operation} was sent "${id}", which is not a uuid: a malformed route id is a real 404 that reads nothing`);
      void answer(route, operation, 404, notFound());
      return undefined;
    }
    const row = store.find((candidate) => candidate.id === id.toLowerCase());
    if (row === undefined) {
      void answer(route, operation, 404, notFound());
      return undefined;
    }
    return row;
  };

  const appendItems = (dealId: string, items: StoredItem[]): void => {
    timelines.set(dealId, [...(timelines.get(dealId) ?? []), ...items]);
  };

  /** Somebody else saves first, if `concurrent` names this deal and has a change left. */
  const concurrentSave = (row: StoredDeal): void => {
    if (options.concurrent === undefined || options.concurrent.dealId !== row.id) return;
    const change = options.concurrent.changes[concurrentStep];
    if (change === undefined) return;
    concurrentStep += 1;
    const old = overwritten.get(row.id) ?? new Map<string, string>();
    const when = serverTime(writeCount + 1);
    for (const [field, value] of Object.entries(change)) {
      const before = (row as unknown as Record<string, unknown>)[field];
      if (typeof before === 'string') old.set(field, before);
      (row as unknown as Record<string, unknown>)[field] = value;
      appendItems(row.id, [fieldItem(field, when, OTHER)]);
    }
    overwritten.set(row.id, old);
    row.version += 1;
    row.updatedAt = when;
  };

  const checkVersion = (row: StoredDeal, version: number, problems: string[]): void => {
    if (!(servedVersions.get(row.id) ?? new Set<number>()).has(version)) {
      problems.push(`version ${String(version)} for ${row.id} is a version the screen was never served`);
    } else if ((refusedVersions.get(row.id) ?? new Set<number>()).has(version)) {
      problems.push(`version ${version} for ${row.id} was already refused with 409: a blind retry, not a re-read`);
    }
  };

  const refuseStale = (row: StoredDeal, version: number): boolean => {
    if (version === row.version) return false;
    const refused = refusedVersions.get(row.id) ?? new Set<number>();
    refused.add(version);
    refusedVersions.set(row.id, refused);
    return true;
  };

  /** D-L102 against the row as served at `version`: unchanged values and undone saves. */
  const lostUpdateProblems = (row: StoredDeal, version: number, fields: Json, problems: string[]): void => {
    const servedAt = servedRows.get(row.id)?.get(version);
    for (const [key, value] of Object.entries(fields)) {
      const property = FIELD_PATHS[key];
      if (property === undefined || servedAt === undefined) continue;
      const held = servedAt[property];
      if (canonical(held) === canonical(value)) {
        problems.push(`${key} was sent with the value the deal already held at version ${version}: send only what the person changed (D-L102)`);
      }
      const before = overwritten.get(row.id)?.get(key);
      if (before !== undefined && canonical(before) === canonical(value) && canonical(held) !== canonical(value)) {
        problems.push(`${key} was sent with the value somebody else just replaced: that undoes their save (D-L102)`);
      }
    }
  };

  const pickerProblems = (pipeline: PipelineConfig, fields: Json, prefix: string): string[] => {
    const out: string[] = [];
    for (const key of ['primaryContactId', 'accountId'] as const) {
      const value = fields[key];
      if (typeof value !== 'string') continue;
      const programme = servedTargets.get(value);
      if (programme === undefined) out.push(`${prefix}${key}=${value} was never offered by the picker`);
      else if (programme !== pipeline.programmeId) out.push(`${prefix}${key}=${value} is in another programme: the picker must offer only the deal’s programme’s records`);
    }
    return out;
  };

  const applyFields = (row: StoredDeal, fields: Json): void => {
    if ('name' in fields && typeof fields.name === 'string') row.name = fields.name;
    if ('amount' in fields) row.amount = isJson(fields.amount) ? { amountMinor: String(fields.amount.amountMinor), currency: String(fields.amount.currency) } : null;
    if ('expectedCloseDate' in fields) row.expectedCloseDate = typeof fields.expectedCloseDate === 'string' ? fields.expectedCloseDate : null;
    if ('nextStep' in fields) row.nextStep = typeof fields.nextStep === 'string' ? fields.nextStep : null;
    if ('ownerUserId' in fields) row.ownerUserId = typeof fields.ownerUserId === 'string' ? fields.ownerUserId : null;
    if ('primaryContactId' in fields) {
      const contact = PICK_CONTACTS.find((entry) => entry.id === fields.primaryContactId);
      row.contact = typeof fields.primaryContactId === 'string' ? { id: fields.primaryContactId, displayName: String(contact?.displayName ?? '') } : null;
    }
    if ('accountId' in fields) {
      const account = PICK_ACCOUNTS.find((entry) => entry.id === fields.accountId);
      row.account = typeof fields.accountId === 'string' ? { id: fields.accountId, name: String(account?.name ?? '') } : null;
    }
  };

  const actionRefused = (row: StoredDeal): boolean => {
    if (role === 'qa_analyst') return true;
    if (role !== 'agent') return false;
    const closed = stageIn(serverConfig(pipelineOf(row.pipelineId)), row.stageId)?.kind !== 'open';
    return withheldFor(row).includes('ownerUserId') || row.ownerUserId !== ME.id || closed;
  };

  // ----- getCurrentUser, listMyProgrammes ---------------------------------------

  const me = (route: Route): Promise<void> => answer(route, 'getCurrentUser', 200, clone(CURRENT_USER));
  const programmes = (route: Route): Promise<void> => answer(route, 'listMyProgrammes', 200, { data: [clone(PROGRAMME_ONE), clone(PROGRAMME_TWO)] });

  // ----- getPipeline ---------------------------------------------------------------

  const getPipeline = async (route: Route, url: URL, rawId: string): Promise<void> => {
    pipelineReads.push(url);
    await gate;
    if (options.networkFailure === true) return route.abort('internetdisconnected');
    const id = decodeURIComponent(rawId);
    const pipeline = PIPELINES.find((candidate) => candidate.id === id.toLowerCase());
    if (!UUID_PATTERN.test(id) || pipeline === undefined) {
      violations.push(`getPipeline named ${id}, which is no pipeline of a deal the screen was served`);
      return answer(route, 'getPipeline', 404, notFound());
    }
    if (options.behindBoard !== true && !store.some((row) => row.pipelineId === pipeline.id && servedVersions.has(row.id))) {
      violations.push(`getPipeline read ${pipeline.name} before any deal of it was served: the detail reads the pipeline of its deal`);
    }
    if (url.search !== '') violations.push(`getPipeline takes no query; it was sent ${url.search}`);
    const reads = (pipelineReadCount.get(pipeline.id) ?? 0) + 1;
    pipelineReadCount.set(pipeline.id, reads);
    const config = reads === 1 ? pipeline : serverConfig(pipeline);
    screenConfig.set(pipeline.id, clone(config));
    return answer(route, 'getPipeline', 200, clone(config));
  };

  // ----- getDeal -------------------------------------------------------------------

  const getDeal = async (route: Route, url: URL, rawId: string): Promise<void> => {
    dealReads.push(url);
    await gate;
    if (options.networkFailure === true) return route.abort('internetdisconnected');
    if (url.search !== '') violations.push(`getDeal takes no query; it was sent ${url.search}`);
    const row = resolveDeal(route, rawId, 'getDeal');
    if (row === undefined) return;
    return answer(route, 'getDeal', 200, serve(row));
  };

  // ----- listDealTimeline -------------------------------------------------------------

  const timeline = async (route: Route, url: URL, rawId: string): Promise<void> => {
    timelineReads.push(url);
    await gate;
    if (options.networkFailure === true || options.timelineFailure === true) return route.abort('internetdisconnected');
    const row = resolveDeal(route, rawId, 'listDealTimeline');
    if (row === undefined) return;
    const problems: string[] = [];
    for (const name of new Set(url.searchParams.keys())) {
      if (!['cursor', 'limit'].includes(name)) problems.push(`listDealTimeline declares no "${name}" parameter`);
      if (url.searchParams.getAll(name).length > 1) problems.push(`${name} was sent more than once`);
    }
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? TIMELINE_DEFAULT_LIMIT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < LIMIT.schema.minimum || limit > LIMIT.schema.maximum) {
      problems.push(`limit=${String(rawLimit)} is outside 1..100, which the API refuses, never clamps`);
    }
    const cursor = url.searchParams.get('cursor');
    const bound = cursor === null ? undefined : timelineCursors.get(cursor);
    if (cursor !== null && (bound === undefined || bound.dealId !== row.id)) {
      problems.push(`timeline cursor "${cursor}" was not served for this deal — echo it exactly, never build or move it`);
    }
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, 'listDealTimeline', 400, validation('ValidationFailed', [{ path: 'cursor', code: 'invalid_cursor' }]));
    }
    const items = visibleItems(timelines.get(row.id) ?? [], withheldFor(row), options.activityDealLink);
    const start = bound === undefined ? 0 : items.findIndex((entry) => entry.id === bound.afterId) + 1;
    const page = items.slice(start, start + limit);
    const last = page.at(-1);
    let nextCursor: string | null = null;
    if (start + limit < items.length && last !== undefined) {
      cursorCount += 1;
      nextCursor = `dGltZWxpbmU${String(cursorCount).padStart(4, '0')}x`;
      timelineCursors.set(nextCursor, { dealId: row.id, afterId: last.id });
    }
    return answer(route, 'listDealTimeline', 200, { data: page.map(serveItem), nextCursor });
  };

  // ----- updateDeal -----------------------------------------------------------------

  const updateDeal = async (route: Route, request: Request, rawId: string): Promise<void> => {
    const body = readBody(request, 'updateDeal');
    const write: RecordedWrite = { method: 'PATCH', path: pathOf(request), body };
    writes.push(write);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, 'updateDeal', status, payload);
    };
    const row = resolveDeal(route, rawId, 'updateDeal');
    if (row === undefined) {
      write.status = 404;
      return;
    }
    if (!servedVersions.has(row.id)) violations.push(`updateDeal named ${row.id}, which the screen was never served`);
    const pipeline = pipelineOf(row.pipelineId);
    const withheld = withheldFor(row);
    const fields: Json = isJson(body) ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'version')) : {};
    const version = isJson(body) ? Number(body.version) : Number.NaN;

    // The screen's rules: recorded whatever the API then answers.
    const problems = validateBody(body, UPDATE_SCHEMA, '').map((problem) => `updateDeal: ${problem}`);
    const sentWithheld = Object.keys(fields).filter((key) => withheld.includes(key));
    if (sentWithheld.length > 0) problems.push(`updateDeal sent ${sentWithheld.join(', ')}, which the caller cannot read — a lock is never an input`);
    if ('ownerUserId' in fields && fields.ownerUserId !== ME.id) {
      problems.push(`updateDeal sent ownerUserId=${String(fields.ownerUserId)}: the screen offers "assign to me" and nothing else (R11)`);
    }
    if (typeof fields.name === 'string' && fields.name.trim() === '') problems.push('updateDeal sent a blank name');
    if (isJson(fields.amount) && typeof fields.amount.currency === 'string' && !CURRENCIES.includes(fields.amount.currency)) {
      problems.push(`updateDeal amount.currency=${fields.amount.currency} is not one of ${CURRENCIES.join(', ')}`);
    }
    problems.push(...pickerProblems(pipeline, fields, 'updateDeal '));
    const wireProblems: string[] = [];
    checkVersion(row, version, wireProblems);
    lostUpdateProblems(row, version, fields, wireProblems);
    violations.push(...problems, ...wireProblems.map((problem) => `updateDeal: ${problem}`));

    // 403: the action, decided before the body is read.
    if (actionRefused(row)) return reply(403, errorExample('DealNotPermitted', 'action'));
    if ('ownerUserId' in fields && fields.ownerUserId !== ME.id && role !== 'team_lead') {
      return reply(403, errorExample('DealNotPermitted', 'ownerNotSelf'));
    }
    const notEditable = Object.keys(fields).filter((key) => withheld.includes(key) || (options.readOnly ?? []).includes(key));
    if (notEditable.length > 0) {
      const refusal = errorExample('DealNotPermitted', 'field');
      refusal.details = notEditable.map((path) => ({ path, code: 'field_not_editable' }));
      return reply(403, refusal);
    }
    // T-0091: `custom` is a per-key merge, checked by the custom half (its own 403s, then 400s).
    const customAnswer = 'custom' in fields ? custom.checkPatch('deal', row.id, pipeline.programmeId, fields.custom, 'updateDeal') : undefined;
    if (customAnswer !== undefined) return reply(customAnswer.status, customAnswer.body);
    // 400: the body.
    if (problems.length > 0) return reply(400, validation('DealValidationFailed', [{ path: 'body', code: 'invalid_string' }]));

    concurrentSave(row);
    // 409 stale_write.
    if (refuseStale(row, version)) return reply(409, errorExample('StaleWrite'));

    writeCount += 1;
    const when = serverTime(writeCount);
    const changed = Object.keys(fields).filter((key) => FIELD_PATHS[key] !== undefined);
    applyFields(row, fields);
    if (isJson(fields.custom)) custom.applyPatch('deal', row.id, fields.custom);
    row.version += 1;
    row.updatedAt = when;
    appendItems(row.id, changed.map((field) => fieldItem(field, when, ME)));
    return reply(200, serve(row));
  };

  // ----- moveDeal -------------------------------------------------------------------

  const moveDeal = async (route: Route, request: Request, rawId: string): Promise<void> => {
    const body = readBody(request, 'moveDeal');
    const write: RecordedWrite = { method: 'POST', path: pathOf(request), body };
    writes.push(write);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, 'moveDeal', status, payload);
    };
    const row = resolveDeal(route, rawId, 'moveDeal');
    if (row === undefined) {
      write.status = 404;
      return;
    }
    if (!servedVersions.has(row.id)) violations.push(`moveDeal named ${row.id}, which the screen was never served`);
    const pipeline = pipelineOf(row.pipelineId);
    const config = serverConfig(pipeline);
    const seen = screenConfig.get(pipeline.id) ?? pipeline;
    const withheld = withheldFor(row);

    if (actionRefused(row)) return reply(403, errorExample('DealNotPermitted', 'action'));
    if (!isJson(body)) {
      violations.push('moveDeal body is not an object');
      return reply(400, validation('DealValidationFailed', [{ path: 'body', code: 'invalid_type' }]));
    }
    const fields = isJson(body.fields) ? body.fields : {};
    const sentWithheld = Object.keys(fields).filter((key) => withheld.includes(key));
    if (sentWithheld.length > 0) {
      violations.push(`moveDeal sent ${sentWithheld.join(', ')}, which the caller cannot read — a lock is never filled`);
      const refusal = errorExample('DealNotPermitted', 'field');
      refusal.details = sentWithheld.map((path) => ({ path, code: 'field_not_editable' }));
      return reply(403, refusal);
    }

    concurrentSave(row);

    const problems = validateBody(body, MOVE_SCHEMA, '');
    const errors: { path: string; code: string }[] = [];
    const toStageId = typeof body.toStageId === 'string' ? body.toStageId : '';
    const target = stageIn(config, toStageId);
    if (target === undefined) {
      violations.push(`moveDeal toStageId=${toStageId} is not a stage of the deal’s pipeline`);
      return reply(400, validation('DealValidationFailed', [{ path: 'toStageId', code: 'unknown_reference' }]));
    }
    const targetFields = new Map(target.requirements.filter((entry) => entry.kind === 'field').map((entry) => [String(entry.field), entry]));
    const targetChecks = new Set(target.requirements.filter((entry) => entry.kind === 'check').map((entry) => entry.id));
    for (const key of Object.keys(fields)) {
      if (!targetFields.has(key)) errors.push({ path: `fields.${key}`, code: 'not_a_requirement' });
    }
    const checks = Array.isArray(body.checks) ? body.checks.map(String) : [];
    for (const [index, requirementId] of checks.entries()) {
      if (!targetChecks.has(requirementId)) errors.push({ path: `checks.${index}`, code: 'not_a_requirement' });
    }
    for (const problem of pickerProblems(pipeline, fields, 'moveDeal ')) {
      violations.push(problem);
      errors.push({ path: 'fields', code: 'unknown_reference' });
    }
    const version = Number(body.version);
    checkVersion(row, version, problems);
    const servedAt = servedRows.get(row.id)?.get(version);
    if (servedAt !== undefined && servedAt.stageId === row.stageId && !seen.transitions.some((pair) => pair.fromStageId === row.stageId && pair.toStageId === toStageId)) {
      problems.push(`a move from ${row.stageId} to ${toStageId} is not on the allow-list the screen read: say so and send nothing`);
    }
    lostUpdateProblems(row, version, fields, problems);
    for (const requirementId of checks) {
      if (servedAt?.checks.some((entry) => entry.requirementId === requirementId) === true) {
        problems.push(`check ${requirementId} is already recorded on the deal: the prompt shows it met, never asks again`);
      }
    }
    violations.push(
      ...problems.map((problem) => `moveDeal: ${problem}`),
      ...errors.filter((error) => error.code === 'not_a_requirement').map((error) => `moveDeal: ${error.path} is not one of the target stage’s requirements`),
    );
    const shapeProblems = problems.filter((problem) => !/never served|blind retry|already held|just replaced|already recorded|allow-list/.test(problem));
    if (shapeProblems.length > 0 || errors.length > 0) {
      return reply(400, validation('DealValidationFailed', errors.length > 0 ? errors : [{ path: 'body', code: 'invalid_string' }]));
    }
    const requiredWithheld = [...targetFields.keys()].filter((field) => withheld.includes(field));
    if (requiredWithheld.length > 0) {
      const refusal = errorExample('DealNotPermitted', 'field');
      refusal.details = requiredWithheld.map((path) => ({ path, code: 'field_not_editable' }));
      return reply(403, refusal);
    }
    if (refuseStale(row, version)) return reply(409, errorExample('DealMoveConflict', 'stale'));
    if (!config.transitions.some((pair) => pair.fromStageId === row.stageId && pair.toStageId === toStageId)) {
      return reply(409, errorExample('DealMoveConflict', 'transition'));
    }
    const unmet = target.requirements.filter((requirement) => {
      if (requirement.kind === 'check') return !checks.includes(requirement.id) && !row.checks.some((entry) => entry.requirementId === requirement.id);
      const field = String(requirement.field);
      if (field in fields) return false;
      const property = FIELD_PATHS[field];
      return property === undefined || row[property] === null;
    });
    if (unmet.length > 0) {
      const refusal = errorExample('RequirementsUnmet');
      refusal.details = unmet.map((requirement) => ({ path: `requirements.${requirement.id}`, code: 'requirement_unmet' }));
      return reply(422, refusal);
    }

    writeCount += 1;
    const when = serverTime(writeCount);
    applyFields(row, fields);
    for (const requirementId of checks) row.checks.push({ requirementId, checkedAt: when, checkedBy: clone(ME) });
    row.stageId = target.id;
    row.stageEnteredAt = when;
    row.closedAt = target.kind === 'open' ? null : when;
    row.version += 1;
    row.updatedAt = when;
    appendItems(row.id, [
      fieldItem('stageId', when, ME),
      ...Object.keys(fields).map((field) => fieldItem(field, when, ME)),
      ...(checks.length > 0 ? [fieldItem('checks', when, ME)] : []),
    ]);
    return reply(200, serve(row));
  };

  // ----- createActivity ----------------------------------------------------------------

  const createActivity = async (route: Route, request: Request): Promise<void> => {
    const body = readBody(request, 'createActivity');
    const write: RecordedWrite = { method: 'POST', path: ACTIVITIES_PATH, body };
    writes.push(write);
    await writeGate;
    const reply = (status: number, payload: unknown): Promise<void> => {
      write.status = status;
      return answer(route, 'createActivity', status, payload);
    };
    if (!isJson(body)) {
      violations.push('createActivity body is not an object');
      return reply(400, validation('ValidationFailed', [{ path: 'body', code: 'invalid_type' }]));
    }
    const problems = validateBody(body, ACTIVITY_SCHEMA, '').map((problem) => `createActivity: ${problem}`);
    const dealId = typeof body.dealId === 'string' ? body.dealId : '';
    const row = store.find((candidate) => candidate.id === dealId);
    if (row === undefined || !servedVersions.has(dealId)) {
      problems.push(`createActivity dealId=${String(body.dealId)} is not the deal on screen: an activity here is linked to this deal`);
    }
    if (row !== undefined && servedVersions.has(row.id)) {
      const served = servedRows.get(row.id)?.get(Math.max(...(servedVersions.get(row.id) ?? new Set([0]))));
      const seen = servedWithheld.get(row.id) ?? [];
      const contactId = seen.includes('primaryContactId') ? null : (served?.contact?.id ?? null);
      const accountId = seen.includes('accountId') ? null : (served?.account?.id ?? null);
      if ((body.contactId ?? null) !== contactId) {
        problems.push(`createActivity contactId=${String(body.contactId)}: the deal's served primary contact is ${String(contactId)} — send it, and nothing else, as the target`);
      }
      if ((body.accountId ?? null) !== accountId) {
        problems.push(`createActivity accountId=${String(body.accountId)}: the deal's served account is ${String(accountId)} — send it, and nothing else, as the target`);
      }
      if (contactId === null && accountId === null) problems.push('createActivity was sent for a deal with no contact or account the caller can see: the composer must not be offered');
    }
    if (body.type !== 'task' && body.dueAt !== undefined && body.dueAt !== null) problems.push('createActivity sent dueAt on a non-task');
    if (body.ownerUserId !== undefined && body.ownerUserId !== ME.id) problems.push(`createActivity sent ownerUserId=${String(body.ownerUserId)}: only the caller`);
    for (const key of ['subject', 'body'] as const) {
      // '' is the schema's (minLength 1); whitespace alone is this screen's rule.
      if (typeof body[key] === 'string' && String(body[key]).length > 0 && String(body[key]).trim() === '') problems.push(`createActivity sent a blank ${key}; leave it out`);
    }
    violations.push(...problems);

    if (role === 'qa_analyst') return reply(403, errorExample('NotPermitted', 'action'));
    if (options.activityDealLink === 'hidden') {
      const refusal = errorExample('NotPermitted', 'field');
      refusal.details = [{ path: 'dealId', code: 'field_not_editable' }];
      return reply(403, refusal);
    }
    // T-0091: `custom` on a create carries values only, checked for the activity object.
    const customAnswer = row === undefined ? undefined : custom.checkCreate('activity', pipelineOf(row.pipelineId).programmeId, body.custom, 'createActivity');
    if (customAnswer !== undefined) return reply(customAnswer.status, customAnswer.body);
    if (problems.length > 0 || row === undefined) return reply(400, validation('ValidationFailed', [{ path: 'body', code: 'invalid_string' }]));

    writeCount += 1;
    const when = serverTime(writeCount);
    const id = NEW_ACTIVITY_IDS[activityCount] ?? `5e2a7b1c-3d4f-4a6b-8c9d-0e1f2a3b4dff`;
    activityCount += 1;
    const type = String(body.type) as ActivityType;
    const stored: StoredActivity = {
      activityId: id,
      activityType: type,
      subject: typeof body.subject === 'string' ? body.subject : null,
      body: typeof body.body === 'string' ? body.body : null,
      dueAt: typeof body.dueAt === 'string' ? body.dueAt : null,
      completedAt: null,
      startsAt: typeof body.startsAt === 'string' ? body.startsAt : null,
      endsAt: typeof body.endsAt === 'string' ? body.endsAt : null,
      version: 1,
    };
    appendItems(row.id, [{ id: itemId(), occurredAt: when, actor: { id: ME.id, displayName: ME.displayName }, activity: stored }]);
    const activity: Json = {
      id,
      programmeId: pipelineOf(row.pipelineId).programmeId,
      type,
      subject: stored.subject,
      body: stored.body,
      dueAt: stored.dueAt,
      completedAt: null,
      startsAt: stored.startsAt,
      endsAt: stored.endsAt,
      ownerUserId: typeof body.ownerUserId === 'string' ? body.ownerUserId : null,
      contactId: typeof body.contactId === 'string' ? body.contactId : null,
      accountId: typeof body.accountId === 'string' ? body.accountId : null,
      dealId: row.id,
      createdByUserId: ME.id,
      version: 1,
      createdAt: when,
      updatedAt: when,
      withheldFields: [],
    };
    if (options.activityDealLink === 'writeOnly') {
      delete activity.dealId;
      activity.withheldFields = ['dealId'];
    }
    custom.storeCreated(id, body.custom);
    custom.decorate(activity as Json & { withheldFields: string[] }, 'activity', id, String(activity.programmeId));
    return reply(201, activity);
  };

  // ----- the pickers ----------------------------------------------------------------------

  const picker = async (route: Route, url: URL, kind: 'contact' | 'account'): Promise<void> => {
    pickerReads.push(url);
    await gate;
    if (options.networkFailure === true) return route.abort('internetdisconnected');
    const operation = kind === 'contact' ? 'listContacts' : 'listAccounts';
    const problems: string[] = [];
    for (const name of new Set(url.searchParams.keys())) {
      if (!PICKER_PARAMETERS.includes(name)) problems.push(`${operation} (a deal picker) is sent "${name}"`);
    }
    const q = url.searchParams.get('q');
    if (q !== null && (q.length < 1 || q.length > 100)) problems.push(`q is ${q.length} characters; 1..100`);
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null && !(Number.isInteger(Number(rawLimit)) && Number(rawLimit) >= 1 && Number(rawLimit) <= 100)) problems.push(`limit=${rawLimit} is outside 1..100`);
    if (problems.length > 0) {
      violations.push(...problems.map((problem) => `${url.search}: ${problem}`));
      return answer(route, operation, 400, validation('ValidationFailed', [{ path: 'query', code: 'invalid_string' }]));
    }
    const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const rows = (kind === 'contact' ? PICK_CONTACTS : PICK_ACCOUNTS).filter((entry) =>
      q === null ? true : fold(String(kind === 'contact' ? entry.displayName : entry.name)).includes(fold(q)),
    );
    for (const entry of rows) servedTargets.set(String(entry.id), String(entry.programmeId));
    return answer(route, operation, 200, { data: clone(rows), nextCursor: null });
  };

  // ----- routing ----------------------------------------------------------------------------

  await page.route(
    (url) => url.pathname.startsWith('/api/v1/'),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const boardOperation =
        (url.pathname === PIPELINES_PATH && method === 'GET') ||
        (/^\/api\/v1\/pipelines\/[^/]+\/(board|deals)$/.test(url.pathname) && ['GET', 'POST'].includes(method));
      if (options.behindBoard === true && boardOperation) return route.fallback();
      requests.push(url);
      calls.push(`${method} ${url.pathname}`);
      for (const header of Object.keys(request.headers())) {
        if (/programme|tenant/i.test(header)) violations.push(`${method} ${url.pathname} was sent a "${header}" header — scope is never supplied`);
      }
      if (url.pathname === ME_PATH && method === 'GET') return me(route);
      if (url.pathname === PROGRAMMES_PATH && method === 'GET') return programmes(route);
      if (url.pathname === CUSTOM_FIELDS_PATH && method === 'GET') return custom.answerList(route);
      const pipelineMatch = /^\/api\/v1\/pipelines\/([^/]+)$/.exec(url.pathname);
      if (pipelineMatch !== null && method === 'GET') return getPipeline(route, url, pipelineMatch[1] ?? '');
      const dealMatch = /^\/api\/v1\/deals\/([^/]+)(\/move|\/timeline)?$/.exec(url.pathname);
      if (dealMatch !== null) {
        const rawId = dealMatch[1] ?? '';
        if (dealMatch[2] === undefined && method === 'GET') return getDeal(route, url, rawId);
        if (dealMatch[2] === undefined && method === 'PATCH') return updateDeal(route, request, rawId);
        if (dealMatch[2] === '/move' && method === 'POST') return moveDeal(route, request, rawId);
        if (dealMatch[2] === '/timeline' && method === 'GET') return timeline(route, url, rawId);
      }
      if (url.pathname === ACTIVITIES_PATH && method === 'POST') return createActivity(route, request);
      if (url.pathname === CONTACTS_PATH && method === 'GET') return picker(route, url, 'contact');
      if (url.pathname === ACCOUNTS_PATH && method === 'GET') return picker(route, url, 'account');
      violations.push(`${method} ${url.pathname} is not an operation the deal detail uses`);
      return route.fulfill({ status: 404, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(notFound()) });
    },
  );

  return {
    requests,
    calls,
    dealReads,
    pipelineReads,
    timelineReads,
    pickerReads,
    writes,
    violations,
    mockFaults,
    plantedFaults,
    store,
    timelines,
    custom,
    release: () => release(),
    releaseWrites: () => releaseWrites(),
  };
}

/** A day in milliseconds, for the spec. */
export const DAY_MS = DAY;
