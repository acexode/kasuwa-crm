import type { TenantTx } from '@kasuwa/db';
import { z } from 'zod';
import { foldForSearch } from '../contact/phone';
import { weightedAmountMinor, weightedAmountSql } from './deal-board';
import { dealActorOf, dealProgrammeMember, type DealActor } from './deal-actor';
import type { PipelineSummary } from './pipeline.repository';

/**
 * The board's deal reads (T-0107; getPipelineBoard over 0036's `deal`).
 *
 * SCOPE. Every statement names the pipeline's own tenant, programme and id
 * explicitly, as well as RLS (CLAUDE.md 2.3): the API found the pipeline in
 * the caller's scope first, and its programme is one the session reaches. The
 * tenant comes from `tx.session`. No SQL here is built from user input: column
 * names are constants and every value is bound.
 *
 * PLANS (D-P33, R20). A column's cards are ONE outer statement on `deal`
 * whose leading predicates are equalities on the board indexes' leading
 * columns (tenant_id, programme_id, pipeline_id, stage_id) and whose ORDER BY
 * is exactly the index's remaining columns:
 *   - open: `deal_board_open_idx`, ORDER BY stage_entered_at, id;
 *   - won:  `deal_board_closed_idx`, ORDER BY closed_at DESC, id DESC, with
 *     `closed_at IS NOT NULL` (the index's predicate) and `closed_at >=
 *     closedSince` (an index condition).
 * The cursor seek is a row comparison on the same columns against the cursor
 * row read by primary key, so a deep page seeks rather than scans. Every key
 * column is uuid or timestamptz, whose operators are LEAKPROOF (0036's
 * self-check), so they stay index conditions under FORCE RLS.
 *
 * MONEY. `amount_minor` leaves Postgres as text and stays a string; totals are
 * summed in `numeric` and leave as text. Neither a JS number nor a bigint
 * ever holds one, so nothing above 2^53 loses a digit and nothing reaches
 * JSON.stringify as a bigint (D-L120).
 *
 * Nothing here logs: deal names and next steps are pii (D-L115).
 */

export type BoardColumnKind = 'open' | 'won';

export interface BoardColumn {
  stageId: string;
  kind: BoardColumnKind;
  probabilityBp: number;
}

/** Already validated filters; each "any of", different filters AND. */
export interface BoardFilters {
  /** `q`, raw. Folded here (case and diacritics), matched literally. */
  search?: string | undefined;
  /** User ids (`me` already resolved). */
  ownerUserIds?: readonly string[] | undefined;
  ownerUnassigned?: boolean | undefined;
  currencies?: readonly string[] | undefined;
  /** YYYY-MM-DD, inclusive. */
  closeFrom?: string | undefined;
  closeTo?: string | undefined;
}

export interface BoardQuery {
  pipeline: PipelineSummary;
  /** UTC date-time; the won column covers closed_at >= this. */
  closedSince: string;
  filters: BoardFilters;
}

export interface StageTotal {
  currency: string;
  amountMinor: string;
  weightedAmountMinor: string;
}

export interface ColumnTally {
  count: number;
  /** One per currency, sorted by code. */
  totals: StageTotal[];
}

export interface DealCard {
  id: string;
  programmeId: string;
  pipelineId: string;
  stageId: string;
  version: number;
  name: string;
  amountMinor: string | null;
  currency: string | null;
  weightedAmountMinor: string | null;
  expectedCloseDate: string | null;
  ownerUserId: string | null;
  /** `displayName` null for a former owner (not a member of the deal's programme, D-P23). */
  owner: { id: string; displayName: string | null } | null;
  primaryContactId: string | null;
  contact: { id: string; displayName: string } | null;
  accountId: string | null;
  account: { id: string; name: string } | null;
  nextStep: string | null;
  stageEnteredAt: Date;
  closedAt: Date | null;
  checks: {
    requirementId: string;
    checkedAt: Date;
    /** `displayName` null for a former checker (D-L127, as the owner, D-P23). */
    checkedBy: DealActor;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

/** Bound parameters, numbered as they are added. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** The SQL twin of `foldForSearch`, on the deal's name. */
const FOLDED_NAME = `lower(regexp_replace(normalize(d.name, NFD), '[\\u0300-\\u036f]', '', 'g'))`;

/**
 * The pipeline's own tenant, programme and id, then the filters.
 *
 * tenancy-reviewed: tenant from the session; programme and pipeline from a
 * pipeline the API already found inside the caller's scope. Every filter can
 * only narrow.
 */
/** The placeholders `baseWhere` bound the pipeline's own tenant, programme and id to. */
interface BoardScope {
  tenantId: string;
  programmeId: string;
  pipelineId: string;
}

function baseWhere(
  tx: TenantTx,
  query: BoardQuery,
  params: Params,
): { where: string[]; scope: BoardScope } {
  const scope: BoardScope = {
    tenantId: params.add(tx.session.tenantId),
    programmeId: params.add(query.pipeline.programmeId),
    pipelineId: params.add(query.pipeline.id),
  };
  const where = [
    `d.tenant_id = ${scope.tenantId}::uuid`,
    `d.programme_id = ${scope.programmeId}::uuid`,
    `d.pipeline_id = ${scope.pipelineId}::uuid`,
  ];
  const { filters } = query;
  const owners = filters.ownerUserIds ?? [];
  if (owners.length > 0 || filters.ownerUnassigned === true) {
    const parts: string[] = [];
    if (owners.length > 0) parts.push(`d.owner_user_id = ANY(${params.add([...owners])}::uuid[])`);
    if (filters.ownerUnassigned === true) parts.push('d.owner_user_id IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }
  if (filters.currencies !== undefined && filters.currencies.length > 0) {
    where.push(`d.currency = ANY(${params.add([...filters.currencies])}::text[])`);
  }
  if (filters.closeFrom !== undefined) {
    where.push(`d.expected_close_date >= ${params.add(filters.closeFrom)}::date`);
  }
  if (filters.closeTo !== undefined) {
    where.push(`d.expected_close_date <= ${params.add(filters.closeTo)}::date`);
  }
  if (filters.search !== undefined) {
    // strpos, not LIKE or a regex: `%` and `_` are literal characters (D-L115).
    where.push(`strpos(${FOLDED_NAME}, ${params.add(foldForSearch(filters.search))}) > 0`);
  }
  return { where, scope };
}

/** The won window, on `closed_at` (R5), as plain comparisons the closed index serves. */
function wonWindow(query: BoardQuery, params: Params): string {
  return `d.closed_at IS NOT NULL AND d.closed_at >= ${params.add(query.closedSince)}::timestamptz`;
}

const TallyRow = z.object({
  stage_id: z.string(),
  currency: z.string().nullable(),
  n: z.number().int(),
  amount_minor: z.string().regex(/^\d+$/).nullable(),
  weighted_minor: z.string().regex(/^\d+$/).nullable(),
});

/**
 * Exact counts and per-currency totals for every column, after the filters,
 * over the whole stage (D-P19). One statement. Lost is never a column, and
 * the won column counts only `closedSince` onwards.
 */
export async function tallyBoardColumns(
  tx: TenantTx,
  query: BoardQuery,
  columns: readonly BoardColumn[],
): Promise<Map<string, ColumnTally>> {
  const tallies = new Map<string, ColumnTally>(
    columns.map((column) => [column.stageId, { count: 0, totals: [] }]),
  );
  if (columns.length === 0) return tallies;
  const params = new Params();
  const { where } = baseWhere(tx, query, params);
  const openIds = columns.filter((c) => c.kind === 'open').map((c) => c.stageId);
  const wonIds = columns.filter((c) => c.kind === 'won').map((c) => c.stageId);
  const parts: string[] = [];
  if (openIds.length > 0) parts.push(`d.stage_id = ANY(${params.add(openIds)}::uuid[])`);
  if (wonIds.length > 0) {
    parts.push(`(d.stage_id = ANY(${params.add(wonIds)}::uuid[]) AND ${wonWindow(query, params)})`);
  }
  where.push(`(${parts.join(' OR ')})`);
  // tenancy-reviewed: baseWhere's tenant, programme and pipeline; the stage
  // join is on the deal's own composite key (0036's FK).
  const rows = await tx.query(
    `SELECT d.stage_id, d.currency, count(*)::int AS n,
            sum(d.amount_minor)::text AS amount_minor,
            sum(${weightedAmountSql('d.amount_minor', 's.probability_bp')})::text AS weighted_minor
       FROM deal d
       JOIN pipeline_stage s
         ON s.tenant_id = d.tenant_id AND s.programme_id = d.programme_id
        AND s.pipeline_id = d.pipeline_id AND s.id = d.stage_id
      WHERE ${where.join('\n        AND ')}
      GROUP BY d.stage_id, d.currency`,
    params.values,
  );
  for (const raw of rows) {
    const row = TallyRow.parse(raw);
    const tally = tallies.get(row.stage_id);
    if (tally === undefined) continue;
    tally.count += row.n;
    if (row.currency !== null && row.amount_minor !== null && row.weighted_minor !== null) {
      tally.totals.push({
        currency: row.currency,
        amountMinor: row.amount_minor,
        weightedAmountMinor: row.weighted_minor,
      });
    }
  }
  for (const tally of tallies.values()) {
    tally.totals.sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  }
  return tallies;
}

/**
 * Whether `dealId` names a deal of this column that the same filters (and,
 * for won, the same window) still select (the contract's BoardCursor). The
 * caller refuses the cursor otherwise, with one body whatever the reason.
 */
export async function boardColumnSelects(
  tx: TenantTx,
  query: BoardQuery,
  column: BoardColumn,
  dealId: string,
): Promise<boolean> {
  const params = new Params();
  const { where } = baseWhere(tx, query, params);
  where.push(`d.stage_id = ${params.add(column.stageId)}::uuid`);
  if (column.kind === 'won') where.push(wonWindow(query, params));
  where.push(`d.id = ${params.add(dealId)}::uuid`);
  // tenancy-reviewed: baseWhere's tenant, programme and pipeline.
  const rows = await tx.query(
    `SELECT 1 AS hit FROM deal d WHERE ${where.join('\n        AND ')}`,
    params.values,
  );
  return rows.length > 0;
}

/**
 * The membership test of the owner in THE DEAL'S programme (D-P23), and the
 * name read only for a member, as contacts do. Correlated on this row only.
 * The same test names each check's user (D-L127, T-0123): `deal-actor.ts`.
 */
const OWNER_MEMBERSHIP = dealProgrammeMember('owner_membership', {
  tenantId: 'd.tenant_id',
  programmeId: 'd.programme_id',
  userId: 'd.owner_user_id',
});

/** The checker's membership in the deal's programme (D-L127): the owner's test. */
const CHECKER_MEMBERSHIP = dealProgrammeMember('checker_membership', {
  tenantId: 'd.tenant_id',
  programmeId: 'd.programme_id',
  userId: 'deal_check.checked_by_user_id',
});

const CARD_COLUMNS = `
  d.id, d.programme_id, d.pipeline_id, d.stage_id, d.version, d.name,
  d.amount_minor::text AS amount_minor, d.currency,
  d.expected_close_date::text AS expected_close_date,
  d.owner_user_id,
  CASE WHEN d.owner_user_id IS NULL THEN NULL ELSE ${OWNER_MEMBERSHIP} END AS owner_is_member,
  (SELECT owner_user.display_name FROM "user" owner_user
    WHERE owner_user.tenant_id = d.tenant_id AND owner_user.id = d.owner_user_id
      AND ${OWNER_MEMBERSHIP}) AS owner_display_name,
  d.primary_contact_id,
  (SELECT deal_contact.display_name FROM contact deal_contact
    WHERE deal_contact.tenant_id = d.tenant_id AND deal_contact.programme_id = d.programme_id
      AND deal_contact.id = d.primary_contact_id) AS contact_display_name,
  d.account_id,
  (SELECT deal_account.name FROM account deal_account
    WHERE deal_account.tenant_id = d.tenant_id AND deal_account.programme_id = d.programme_id
      AND deal_account.id = d.account_id) AS account_name,
  d.next_step, d.stage_entered_at, d.closed_at, d.created_at, d.updated_at,
  (SELECT coalesce(json_agg(json_build_object(
            'requirementId', deal_check.requirement_id,
            'checkedAt', deal_check.checked_at,
            'checkedBy', deal_check.checked_by_user_id,
            'checkedByIsMember', ${CHECKER_MEMBERSHIP},
            'checkedByName', CASE WHEN ${CHECKER_MEMBERSHIP} THEN check_user.display_name END)),
          '[]'::json)
     FROM deal_requirement_check deal_check
     JOIN "user" check_user
       ON check_user.tenant_id = deal_check.tenant_id
      AND check_user.id = deal_check.checked_by_user_id
    WHERE deal_check.tenant_id = d.tenant_id AND deal_check.programme_id = d.programme_id
      AND deal_check.pipeline_id = d.pipeline_id AND deal_check.deal_id = d.id) AS checks`;

const CheckJson = z.object({
  requirementId: z.string().uuid(),
  checkedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  checkedBy: z.string().uuid(),
  checkedByIsMember: z.boolean(),
  /** Read only for a member of the deal's programme (D-L127). */
  checkedByName: z.string().nullable(),
});

const CardRow = z.object({
  id: z.string(),
  programme_id: z.string(),
  pipeline_id: z.string(),
  stage_id: z.string(),
  version: z.number().int(),
  name: z.string(),
  amount_minor: z.string().regex(/^\d+$/).nullable(),
  currency: z.string().nullable(),
  expected_close_date: z.string().nullable(),
  owner_user_id: z.string().nullable(),
  owner_is_member: z.boolean().nullable(),
  owner_display_name: z.string().nullable(),
  primary_contact_id: z.string().nullable(),
  contact_display_name: z.string().nullable(),
  account_id: z.string().nullable(),
  account_name: z.string().nullable(),
  next_step: z.string().nullable(),
  stage_entered_at: z.date(),
  closed_at: z.date().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
  checks: z.array(CheckJson),
});

/** Carries no identifier: the composite FKs of 0036 make each of these impossible. */
export class DealCardUnresolvedError extends Error {
  constructor() {
    super('A deal card references a row that could not be read');
    this.name = 'DealCardUnresolvedError';
  }
}

type CardCheck = DealCard['checks'][number];

/**
 * Checks in the order they were ticked, ties by requirement id. Sorted here
 * rather than by an ordered aggregate in the card statement: PostgreSQL 16
 * plans `json_agg(... ORDER BY ...)` with a Sort node, and the card
 * statement carries none (R20).
 */
export function byCheckedAtThenRequirement(a: CardCheck, b: CardCheck): number {
  const at = a.checkedAt.getTime() - b.checkedAt.getTime();
  if (at !== 0) return at;
  return a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0;
}

function toCard(raw: unknown, probabilityBp: number): DealCard {
  const row = CardRow.parse(raw);
  const owner: DealCard['owner'] =
    row.owner_user_id === null
      ? null
      : dealActorOf(row.owner_user_id, row.owner_is_member, row.owner_display_name);
  let contact: DealCard['contact'] = null;
  if (row.primary_contact_id !== null) {
    if (row.contact_display_name === null) throw new DealCardUnresolvedError();
    contact = { id: row.primary_contact_id, displayName: row.contact_display_name };
  }
  let account: DealCard['account'] = null;
  if (row.account_id !== null) {
    if (row.account_name === null) throw new DealCardUnresolvedError();
    account = { id: row.account_id, name: row.account_name };
  }
  return {
    id: row.id,
    programmeId: row.programme_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    version: row.version,
    name: row.name,
    amountMinor: row.amount_minor,
    currency: row.currency,
    weightedAmountMinor:
      row.amount_minor === null ? null : weightedAmountMinor(row.amount_minor, probabilityBp),
    expectedCloseDate: row.expected_close_date,
    ownerUserId: row.owner_user_id,
    owner,
    primaryContactId: row.primary_contact_id,
    contact,
    accountId: row.account_id,
    account,
    nextStep: row.next_step,
    stageEnteredAt: row.stage_entered_at,
    closedAt: row.closed_at,
    checks: row.checks
      .map((check) => ({
        requirementId: check.requirementId,
        checkedAt: new Date(check.checkedAt),
        checkedBy: dealActorOf(check.checkedBy, check.checkedByIsMember, check.checkedByName),
      }))
      .sort(byCheckedAtThenRequirement),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * One page of a column's cards, after `afterDealId` when given (the caller
 * has checked it with `boardColumnSelects`). One extra row decides whether a
 * page follows.
 */
export async function boardColumnCards(
  tx: TenantTx,
  query: BoardQuery,
  column: BoardColumn,
  options: { limit: number; afterDealId?: string | undefined },
): Promise<{ cards: DealCard[]; hasMore: boolean }> {
  const params = new Params();
  const { where, scope } = baseWhere(tx, query, params);
  const stage = params.add(column.stageId);
  where.push(`d.stage_id = ${stage}::uuid`);
  const won = column.kind === 'won';
  if (won) where.push(wonWindow(query, params));
  if (options.afterDealId !== undefined) {
    // The cursor row by primary key, inside the same tenant, programme,
    // pipeline and stage, read by an uncorrelated subquery (an InitPlan), so
    // the comparison against it is an index condition and the page seeks.
    // tenancy-reviewed: the scope placeholders are the ones baseWhere bound,
    // never assumed positions, so reordering baseWhere cannot re-point them.
    const cursorId = params.add(options.afterDealId);
    const cursorRow = `FROM deal cursor_row
           WHERE cursor_row.id = ${cursorId}::uuid
             AND cursor_row.tenant_id = ${scope.tenantId}::uuid
             AND cursor_row.programme_id = ${scope.programmeId}::uuid
             AND cursor_row.pipeline_id = ${scope.pipelineId}::uuid
             AND cursor_row.stage_id = ${stage}::uuid`;
    if (won) {
      // Spelled out rather than as a row comparison: the closed index's key
      // columns are DESC. `closed_at <= key` is the index condition; the OR
      // only drops the cursor's own ties already served.
      const closedAt = `(SELECT cursor_row.closed_at ${cursorRow})`;
      where.push(
        `d.closed_at <= ${closedAt}`,
        `(d.closed_at < ${closedAt} OR d.id < (SELECT cursor_row.id ${cursorRow}))`,
      );
    } else {
      where.push(
        `(d.stage_entered_at, d.id) > (SELECT cursor_row.stage_entered_at, cursor_row.id ${cursorRow})`,
      );
    }
  }
  const order = won ? 'd.closed_at DESC, d.id DESC' : 'd.stage_entered_at, d.id';
  // The LIMIT is a subquery on purpose (D-P33, R20). Postgres multiplies the
  // selectivities of tenant, programme, pipeline and stage as if they were
  // independent, though the stage decides the other three, so it
  // underestimates a column by orders of magnitude; with a constant LIMIT at
  // or above that estimate it may then prefer the RLS policy's
  // `programme_id = ANY(...)` as an index condition, which gives up the
  // index order, and Sort the whole stage (observed on the won column under
  // the T-0107 plans block). A LIMIT the planner cannot read is costed as 10%
  // of the estimated rows, so the ordered board-index path wins unless the
  // estimate is wrong in the other direction. The rows read are the same.
  // Extended statistics on (programme_id, pipeline_id, stage_id) would fix
  // the estimate itself; that is a migration, raised in the T-0107 report.
  const limit = `(SELECT ${params.add(options.limit + 1)}::int)`;
  // tenancy-reviewed: baseWhere's tenant, programme and pipeline, then narrowing only.
  const rows = await tx.query(
    `SELECT ${CARD_COLUMNS}
       FROM deal d
      WHERE ${where.join('\n        AND ')}
      ORDER BY ${order}
      LIMIT ${limit}`,
    params.values,
  );
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  return { cards: page.map((row) => toCard(row, column.probabilityBp)), hasMore };
}
