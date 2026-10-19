import { newId, type TenantTx } from '@kasuwa/db';
import {
  customFilterClauses,
  customMergeSet,
  dealActorOf,
  dealProgrammeMember,
  dealProgrammeMemberFlag,
  dealProgrammeMemberJoin,
  decodeListCursor,
  encodeListCursor,
  foldForSearch,
  InvalidCursorError,
  type CustomFilters,
} from '@kasuwa/domain-core';
import type { CustomPatch } from '@kasuwa/metadata-engine';
import type { DealSort } from './deals.schemas';

/**
 * Deal and pipeline reads and writes for the deals API (T-0108; the tables
 * are 0036, T-0106).
 *
 * The record repositories' rules, unchanged (packages/domain/core/CLAUDE.md):
 *   - every function takes a TenantTx; tenant and programme scope come from
 *     `tx.session`, never from the caller;
 *   - every WHERE repeats `tenant_id` and the session's programmes even though
 *     RLS (deal_isolation, pipeline_isolation, ...) enforces both: two
 *     independent layers (CLAUDE.md 2.3);
 *   - an out-of-scope row is `null` here and `404` at the API;
 *   - no SQL is built from input: columns are constants, values are bound.
 *
 * What only this file knows about a deal:
 *   - its id is minted HERE (`newId()`), never accepted from a client;
 *   - `amount_minor` travels as TEXT both ways: bound as a validated digit
 *     string and cast `::bigint` in SQL, read back as `::text` (D-L121). No JS
 *     number and no JS bigint ever holds it here;
 *   - `expected_close_date` is read as `YYYY-MM-DD` text, never through a
 *     `Date` (a calendar date has no zone);
 *   - `id`, `tenant_id`, `programme_id`, `pipeline_id` and `created_at` are
 *     never in a SET (0036 grants kasuwa_app no UPDATE on them anyway);
 *   - `stage_entered_at`, `closed_at`, `updated_at` and `version` are the
 *     SERVER's (D-L120): set here from `now()` or by 0036's triggers, never
 *     from a body; a check's `checked_by_user_id` is the session user and its
 *     `checked_at` the column default.
 *
 * Nothing here decides permission, field security, membership (D-L67) or the
 * move's gates: the API does, before it calls a write. NOTHING HERE LOGS: a
 * deal's name and next step are personal data in practice (D-L115).
 */

export type StageKind = 'open' | 'won' | 'lost';

export interface PipelineRef {
  id: string;
  programmeId: string;
}

export interface Stage {
  id: string;
  kind: StageKind;
  position: number;
  probabilityBp: number;
  rottingAfterDays: number | null;
}

export interface Requirement {
  id: string;
  stageId: string;
  kind: 'field' | 'check';
  /** The field_def api_name (0036 R2), on a `field` requirement. */
  field: string | null;
}

export interface DealCheckRow {
  requirementId: string;
  checkedAt: Date;
  checkedByUserId: string;
  /** Null for a former checker, no longer a member of the deal's programme (D-L127). */
  checkedByDisplayName: string | null;
}

export interface Deal {
  id: string;
  programmeId: string;
  pipelineId: string;
  stageId: string;
  stageKind: StageKind;
  probabilityBp: number;
  rottingAfterDays: number | null;
  version: number;
  name: string;
  /** Digits, as Postgres rendered the bigint. */
  amountMinor: string | null;
  currency: string | null;
  /** `YYYY-MM-DD`. */
  expectedCloseDate: string | null;
  ownerUserId: string | null;
  /** Null for a former owner, no longer a member of the deal's programme (D-P23). */
  ownerDisplayName: string | null;
  primaryContactId: string | null;
  contactDisplayName: string | null;
  accountId: string | null;
  accountName: string | null;
  nextStep: string | null;
  stageEnteredAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  checks: DealCheckRow[];
}

interface DealRow {
  id: string;
  programme_id: string;
  pipeline_id: string;
  stage_id: string;
  stage_kind: string;
  probability_bp: number;
  rotting_after_days: number | null;
  version: number;
  name: string;
  amount_minor: string | null;
  currency: string | null;
  expected_close_date: string | null;
  owner_user_id: string | null;
  owner_display_name: string | null;
  primary_contact_id: string | null;
  contact_display_name: string | null;
  account_id: string | null;
  account_name: string | null;
  next_step: string | null;
  stage_entered_at: Date;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A stored stage kind outside 0036's CHECK. Impossible; carries no value. */
export class StageKindUnknownError extends Error {
  constructor() {
    super('A pipeline stage carries a kind outside the known set');
    this.name = 'StageKindUnknownError';
  }
}

function stageKind(value: string): StageKind {
  if (value === 'open' || value === 'won' || value === 'lost') return value;
  throw new StageKindUnknownError();
}

/**
 * One deal with its stage and its summaries, in one statement. Each summary
 * is a correlated subquery on THIS row, matched on the deal's own tenant (and
 * programme, for the contact, the account and the owner's membership), so it
 * is never a directory of anything the statement does not already return.
 *
 * The owner's name is read only while the owner is a member of the deal's
 * programme (D-P23): a former owner is an id and no name. The test is the
 * board's and the checks' (`dealProgrammeMember`, D-L127).
 *
 * tenancy-reviewed: every subquery is keyed to the deal row's own tenant_id
 * (and programme_id), the pair 0036's composite FKs hold; RLS on each table
 * besides. The stage join is on the full composite key.
 */
const OWNER_MEMBERSHIP = dealProgrammeMember('owner_membership', {
  tenantId: 'd.tenant_id',
  programmeId: 'd.programme_id',
  userId: 'd.owner_user_id',
});

const DEAL_SELECT = `
  SELECT d.id, d.programme_id, d.pipeline_id, d.stage_id,
         s.kind AS stage_kind, s.probability_bp, s.rotting_after_days,
         d.version, d.name,
         d.amount_minor::text AS amount_minor, d.currency,
         to_char(d.expected_close_date, 'YYYY-MM-DD') AS expected_close_date,
         d.owner_user_id,
         (SELECT u.display_name
            FROM "user" u
           WHERE u.tenant_id = d.tenant_id
             AND u.id = d.owner_user_id
             AND ${OWNER_MEMBERSHIP}) AS owner_display_name,
         d.primary_contact_id,
         (SELECT c.display_name
            FROM contact c
           WHERE c.tenant_id = d.tenant_id
             AND c.programme_id = d.programme_id
             AND c.id = d.primary_contact_id
             AND c.deleted_at IS NULL) AS contact_display_name,
         d.account_id,
         (SELECT a.name
            FROM account a
           WHERE a.tenant_id = d.tenant_id
             AND a.programme_id = d.programme_id
             AND a.id = d.account_id) AS account_name,
         d.next_step, d.stage_entered_at, d.closed_at, d.created_at, d.updated_at
    FROM deal d
    JOIN pipeline_stage s
      ON s.tenant_id = d.tenant_id
     AND s.programme_id = d.programme_id
     AND s.pipeline_id = d.pipeline_id
     AND s.id = d.stage_id`;

function toDeal(row: DealRow, checks: DealCheckRow[]): Deal {
  return {
    id: row.id,
    programmeId: row.programme_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    stageKind: stageKind(row.stage_kind),
    probabilityBp: row.probability_bp,
    rottingAfterDays: row.rotting_after_days,
    version: row.version,
    name: row.name,
    amountMinor: row.amount_minor,
    currency: row.currency,
    expectedCloseDate: row.expected_close_date,
    ownerUserId: row.owner_user_id,
    ownerDisplayName: row.owner_display_name,
    primaryContactId: row.primary_contact_id,
    contactDisplayName: row.contact_display_name,
    accountId: row.account_id,
    accountName: row.account_name,
    nextStep: row.next_step,
    stageEnteredAt: row.stage_entered_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    checks,
  };
}

/** Bound parameters, numbered as they are added. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Thrown for a programme outside the session. The API answers 404 before this. */
export class DealProgrammeOutOfScopeError extends Error {
  constructor() {
    super('Refusing to touch a deal in a programme outside the session scope');
    this.name = 'DealProgrammeOutOfScopeError';
  }
}

function assertInScope(tx: TenantTx, programmeId: string): void {
  if (!tx.session.programmeIds.includes(programmeId)) throw new DealProgrammeOutOfScopeError();
}

/**
 * The checker's membership in the deal's programme: the owner's test (D-P23,
 * D-L127). A check row's programme IS its deal's (0036's composite FK).
 */
const CHECKER_MEMBERSHIP_JOIN = dealProgrammeMemberJoin('checker_membership', {
  tenantId: 'k.tenant_id',
  programmeId: 'k.programme_id',
  userId: 'k.checked_by_user_id',
});
const CHECKER_IS_MEMBER = dealProgrammeMemberFlag('checker_membership');

/**
 * The checks ticked on these deals, with who ticked them. A checker is named
 * as they are named now while they are a member of the deal's programme, and
 * unnamed once they are not (D-L127, as a former owner, D-P23); the name is
 * not even read for a non-member. Membership for every check of every deal
 * is resolved in this one statement by one join (one probe per check),
 * never one statement per check or per deal.
 *
 * tenancy-reviewed: tenant from the session, the programme checked against
 * the session; the user joined on (tenant_id, id), the membership keyed on
 * the check's own tenant, programme and user; RLS on all three besides.
 */
async function checksFor(
  tx: TenantTx,
  programmeId: string,
  dealIds: readonly string[],
): Promise<Map<string, DealCheckRow[]>> {
  const byDeal = new Map<string, DealCheckRow[]>();
  if (dealIds.length === 0) return byDeal;
  const rows = await tx.query<{
    deal_id: string;
    requirement_id: string;
    checked_at: Date;
    checked_by_user_id: string;
    is_member: boolean;
    display_name: string | null;
  }>(
    `SELECT k.deal_id, k.requirement_id, k.checked_at, k.checked_by_user_id,
            ${CHECKER_IS_MEMBER} AS is_member,
            CASE WHEN ${CHECKER_IS_MEMBER} THEN u.display_name END AS display_name
       FROM deal_requirement_check k
       JOIN "user" u
         ON u.tenant_id = k.tenant_id AND u.id = k.checked_by_user_id
       ${CHECKER_MEMBERSHIP_JOIN}
      WHERE k.tenant_id = $1
        AND k.programme_id = $2
        AND k.programme_id = ANY($3::uuid[])
        AND k.deal_id = ANY($4::uuid[])
      ORDER BY k.deal_id, k.checked_at, k.requirement_id`,
    [tx.session.tenantId, programmeId, [...tx.session.programmeIds], [...dealIds]],
  );
  for (const row of rows) {
    const list = byDeal.get(row.deal_id) ?? [];
    list.push(checkRowOf(row));
    byDeal.set(row.deal_id, list);
  }
  return byDeal;
}

/** One check row, its checker judged by `dealActorOf` (the owner's rule). */
export function checkRowOf(row: {
  requirement_id: string;
  checked_at: Date;
  checked_by_user_id: string;
  is_member: boolean | null;
  display_name: string | null;
}): DealCheckRow {
  const checker = dealActorOf(row.checked_by_user_id, row.is_member, row.display_name);
  return {
    requirementId: row.requirement_id,
    checkedAt: row.checked_at,
    checkedByUserId: checker.id,
    checkedByDisplayName: checker.displayName,
  };
}

/**
 * One deal the session reaches, or null: another tenant's, a sibling
 * programme's and an absent one are the same `null`. `id` must already be a
 * uuid (the API answers anything else with the same 404 before calling).
 *
 * tenancy-reviewed: id AND tenant (session) AND programme in the session's
 * scope; RLS besides.
 */
export async function findDealById(tx: TenantTx, id: string): Promise<Deal | null> {
  const rows = await tx.query<DealRow>(
    `${DEAL_SELECT}
      WHERE d.id = $1::uuid
        AND d.tenant_id = $2::uuid
        AND d.programme_id = ANY($3::uuid[])`,
    [id, tx.session.tenantId, [...tx.session.programmeIds]],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const checks = await checksFor(tx, row.programme_id, [row.id]);
  return toDeal(row, checks.get(row.id) ?? []);
}

/**
 * One pipeline the session reaches, or null (one answer for another tenant's,
 * another programme's and none).
 *
 * tenancy-reviewed: id AND tenant (session) AND programme in the session's
 * scope; RLS besides.
 */
export async function findPipelineRef(tx: TenantTx, id: string): Promise<PipelineRef | null> {
  const rows = await tx.query<{ id: string; programme_id: string }>(
    `SELECT id, programme_id
       FROM pipeline
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND programme_id = ANY($3::uuid[])`,
    [id, tx.session.tenantId, [...tx.session.programmeIds]],
  );
  const row = rows[0];
  return row === undefined ? null : { id: row.id, programmeId: row.programme_id };
}

/**
 * A pipeline's stages, by position.
 *
 * tenancy-reviewed: tenant from the session, the programme checked against
 * the session, the pipeline named; RLS besides.
 */
export async function listStages(tx: TenantTx, pipeline: PipelineRef): Promise<Stage[]> {
  assertInScope(tx, pipeline.programmeId);
  const rows = await tx.query<{
    id: string;
    kind: string;
    position: number;
    probability_bp: number;
    rotting_after_days: number | null;
  }>(
    `SELECT id, kind, position, probability_bp, rotting_after_days
       FROM pipeline_stage
      WHERE tenant_id = $1
        AND programme_id = $2
        AND pipeline_id = $3
      ORDER BY position`,
    [tx.session.tenantId, pipeline.programmeId, pipeline.id],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: stageKind(row.kind),
    position: row.position,
    probabilityBp: row.probability_bp,
    rottingAfterDays: row.rotting_after_days,
  }));
}

/**
 * The requirements of one stage.
 *
 * tenancy-reviewed: tenant from the session, programme checked against the
 * session, pipeline and stage named; RLS besides.
 */
export async function listStageRequirements(
  tx: TenantTx,
  pipeline: PipelineRef,
  stageId: string,
): Promise<Requirement[]> {
  assertInScope(tx, pipeline.programmeId);
  const rows = await tx.query<{ id: string; stage_id: string; kind: string; field: string | null }>(
    `SELECT id, stage_id, kind, field
       FROM pipeline_stage_requirement
      WHERE tenant_id = $1
        AND programme_id = $2
        AND pipeline_id = $3
        AND stage_id = $4
      ORDER BY position`,
    [tx.session.tenantId, pipeline.programmeId, pipeline.id, stageId],
  );
  return rows.map((row) => ({
    id: row.id,
    stageId: row.stage_id,
    kind: row.kind === 'field' ? 'field' : 'check',
    field: row.field,
  }));
}

/**
 * Is (from, to) on the pipeline's allow-list?
 *
 * tenancy-reviewed: tenant from the session, programme checked against the
 * session, pipeline named; RLS besides.
 */
export async function transitionExists(
  tx: TenantTx,
  pipeline: PipelineRef,
  fromStageId: string,
  toStageId: string,
): Promise<boolean> {
  assertInScope(tx, pipeline.programmeId);
  const rows = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok
       FROM pipeline_stage_transition
      WHERE tenant_id = $1
        AND programme_id = $2
        AND pipeline_id = $3
        AND from_stage_id = $4
        AND to_stage_id = $5`,
    [tx.session.tenantId, pipeline.programmeId, pipeline.id, fromStageId, toStageId],
  );
  return rows.length > 0;
}

/** What a create or update writes, as the wire names it. `undefined` leaves a column alone. */
export interface DealValues {
  name?: string | undefined;
  /** Both or neither (0036's pair CHECK); `null` clears both. */
  amount?: { amountMinor: string; currency: string } | null | undefined;
  expectedCloseDate?: string | null | undefined;
  ownerUserId?: string | null | undefined;
  primaryContactId?: string | null | undefined;
  accountId?: string | null | undefined;
  nextStep?: string | null | undefined;
}

/** Column assignments from `values`. Column names are constants; only values are bound. */
function assignments(values: DealValues, params: Params): { column: string; value: string }[] {
  const result: { column: string; value: string }[] = [];
  if (values.name !== undefined)
    result.push({ column: 'name', value: `${params.add(values.name)}::text` });
  if (values.amount !== undefined) {
    // Text in, `::bigint` in SQL: never a JS number, never through numeric.
    result.push({
      column: 'amount_minor',
      value: `${params.add(values.amount === null ? null : values.amount.amountMinor)}::text::bigint`,
    });
    result.push({
      column: 'currency',
      value: `${params.add(values.amount === null ? null : values.amount.currency)}::text`,
    });
  }
  const plain: [keyof DealValues, string, string][] = [
    ['expectedCloseDate', 'expected_close_date', 'date'],
    ['ownerUserId', 'owner_user_id', 'uuid'],
    ['primaryContactId', 'primary_contact_id', 'uuid'],
    ['accountId', 'account_id', 'uuid'],
    ['nextStep', 'next_step', 'text'],
  ];
  for (const [key, column, cast] of plain) {
    const value = values[key];
    if (value === undefined) continue;
    result.push({ column, value: `${params.add(value)}::${cast}` });
  }
  return result;
}

/**
 * Inserts a deal in `pipeline`'s `stageId` (the first open stage, chosen by
 * the API). The id is minted here; `stage_entered_at`, `version` and the
 * timestamps are the columns' defaults.
 *
 * tenancy-reviewed: tenant from the session, programme checked against the
 * session; RLS WITH CHECK and the composite FKs refuse either independently.
 */
export async function insertDeal(
  tx: TenantTx,
  pipeline: PipelineRef,
  stageId: string,
  values: DealValues & { name: string },
  custom: Readonly<Record<string, unknown>> = {},
): Promise<Deal> {
  assertInScope(tx, pipeline.programmeId);
  const params = new Params();
  const id = newId();
  const columns = [
    { column: 'id', value: `${params.add(id)}::uuid` },
    { column: 'tenant_id', value: `${params.add(tx.session.tenantId)}::uuid` },
    { column: 'programme_id', value: `${params.add(pipeline.programmeId)}::uuid` },
    { column: 'pipeline_id', value: `${params.add(pipeline.id)}::uuid` },
    { column: 'stage_id', value: `${params.add(stageId)}::uuid` },
    // T-0089: validated by the API against the live definitions; never read back here.
    { column: 'custom', value: `${params.add(JSON.stringify(custom))}::jsonb` },
    ...assignments(values, params),
  ];
  await tx.query(
    `INSERT INTO deal (${columns.map((entry) => entry.column).join(', ')})
     VALUES (${columns.map((entry) => entry.value).join(', ')})`,
    params.values,
  );
  const deal = await findDealById(tx, id);
  if (deal === null) throw new Error('A deal written in this transaction could not be read back');
  return deal;
}

/**
 * Applies `values` to one deal iff its version is still `version`; false when
 * no row matched (the API's `409 stale_write`). `version = version + 1` is set
 * here, so 0036's trigger leaves it alone and it moves exactly once. Under
 * READ COMMITTED a concurrent writer with the same version blocks on the row
 * lock, re-evaluates the WHERE against the committed row and matches nothing:
 * exactly one wins (R14).
 *
 * `move`, when given, also changes the stage: `stage_entered_at` becomes the
 * statement's `now()`, and `closed_at` follows the target's kind (that same
 * instant on won or lost, NULL on open). 0036's guard re-checks the
 * transition.
 *
 * tenancy-reviewed: id AND tenant (session) AND programme (checked against the
 * session) AND version; RLS besides. SET names no key column.
 */
export async function updateDealIfVersion(
  tx: TenantTx,
  target: { id: string; programmeId: string; version: number },
  values: DealValues,
  move?: { toStageId: string; toKind: StageKind },
  custom?: CustomPatch,
): Promise<boolean> {
  assertInScope(tx, target.programmeId);
  const params = new Params();
  const sets = assignments(values, params).map((entry) => `${entry.column} = ${entry.value}`);
  // T-0089: merged per key, never returned (0039 grants UPDATE (custom) only).
  if (custom !== undefined) sets.push(customMergeSet(custom, (value) => params.add(value)));
  if (move !== undefined) {
    sets.push(`stage_id = ${params.add(move.toStageId)}::uuid`);
    sets.push('stage_entered_at = now()');
    sets.push(move.toKind === 'open' ? 'closed_at = NULL' : 'closed_at = now()');
  }
  sets.push('version = version + 1');
  const rows = await tx.query<{ id: string }>(
    `UPDATE deal
        SET ${sets.join(', ')}
      WHERE id = ${params.add(target.id)}::uuid
        AND tenant_id = ${params.add(tx.session.tenantId)}::uuid
        AND programme_id = ${params.add(target.programmeId)}::uuid
        AND version = ${params.add(target.version)}::integer
      RETURNING id`,
    params.values,
  );
  return rows.length > 0;
}

/**
 * Records check ticks on a deal, as the SESSION user at the server's time
 * (D-L120). A check already recorded is left exactly as it is: who and when
 * stay those of the first tick (R6). Insert-only (0036 grants no UPDATE).
 *
 * tenancy-reviewed: tenant and checker from the session, programme checked
 * against the session; the composite FKs keep the deal and requirement in the
 * row's pipeline, 0036's trigger the requirement's kind; RLS besides.
 */
export async function insertChecks(
  tx: TenantTx,
  deal: { id: string; programmeId: string; pipelineId: string },
  requirementIds: readonly string[],
): Promise<void> {
  assertInScope(tx, deal.programmeId);
  for (const requirementId of requirementIds) {
    await tx.query(
      `INSERT INTO deal_requirement_check
         (id, tenant_id, programme_id, pipeline_id, deal_id, requirement_id, checked_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid)
       ON CONFLICT ON CONSTRAINT deal_requirement_check_once_key DO NOTHING`,
      [
        newId(),
        tx.session.tenantId,
        deal.programmeId,
        deal.pipelineId,
        deal.id,
        requirementId,
        tx.session.userId,
      ],
    );
  }
}

// --- the list ----------------------------------------------------------------

const SORT_SPECS: Record<DealSort, { column: string; direction: 'ASC' | 'DESC' }> = {
  '-updatedAt': { column: 'updated_at', direction: 'DESC' },
  updatedAt: { column: 'updated_at', direction: 'ASC' },
  '-createdAt': { column: 'created_at', direction: 'DESC' },
  createdAt: { column: 'created_at', direction: 'ASC' },
  name: { column: 'name', direction: 'ASC' },
  '-name': { column: 'name', direction: 'DESC' },
  stageEnteredAt: { column: 'stage_entered_at', direction: 'ASC' },
  '-stageEnteredAt': { column: 'stage_entered_at', direction: 'DESC' },
};

export interface DealListFilters {
  /** Closed deals that closed before this instant are left out; open deals never. ISO, UTC. */
  closedSince: string;
  stageIds?: readonly string[] | undefined;
  /** `q`, as sent: folded here, as its SQL twin folds the name. */
  search?: string | undefined;
  ownerUserIds?: readonly string[] | undefined;
  ownerUnassigned?: boolean | undefined;
  currencies?: readonly string[] | undefined;
  closeFrom?: string | undefined;
  closeTo?: string | undefined;
  /** Custom-field equality and is-empty (T-0089), already judged by the API. */
  custom?: CustomFilters | undefined;
}

export interface ListDealsOptions {
  limit: number;
  sort: DealSort;
  cursor?: string | undefined;
  filters: DealListFilters;
}

/** The SQL twin of `foldForSearch`: NFD, drop U+0300-U+036F, lower. */
const FOLDED_NAME = `lower(regexp_replace(normalize(d.name, NFD), '[\\u0300-\\u036f]', '', 'g'))`;

/**
 * The WHERE of one pipeline's list: the session's tenant, the pipeline's
 * programme (which must be one the session reaches), the pipeline, then
 * filters that only narrow.
 *
 * tenancy-reviewed: tenant from the session and the programme both named and
 * required in SQL to be in the session's scope, before anything else; every
 * other clause is ANDed on. Values are bound; columns are constants.
 */
function listWhere(
  tx: TenantTx,
  pipeline: PipelineRef,
  filters: DealListFilters,
  params: Params,
): string[] {
  const where = [
    `d.tenant_id = ${params.add(tx.session.tenantId)}::uuid`,
    `d.programme_id = ${params.add(pipeline.programmeId)}::uuid`,
    `d.programme_id = ANY(${params.add([...tx.session.programmeIds])}::uuid[])`,
    `d.pipeline_id = ${params.add(pipeline.id)}::uuid`,
    `(d.closed_at IS NULL OR d.closed_at >= ${params.add(filters.closedSince)}::timestamptz)`,
  ];
  if (filters.stageIds !== undefined && filters.stageIds.length > 0) {
    where.push(`d.stage_id = ANY(${params.add([...filters.stageIds])}::uuid[])`);
  }
  if (filters.search !== undefined) {
    // strpos, not LIKE: `%` and `_` are literal characters (D-L115).
    where.push(`strpos(${FOLDED_NAME}, ${params.add(foldForSearch(filters.search))}) > 0`);
  }
  const ownerIds = filters.ownerUserIds ?? [];
  if (ownerIds.length > 0 || filters.ownerUnassigned === true) {
    const parts: string[] = [];
    if (ownerIds.length > 0)
      parts.push(`d.owner_user_id = ANY(${params.add([...ownerIds])}::uuid[])`);
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
  where.push(...customFilterClauses(filters.custom, (value) => params.add(value), 'd'));
  return where;
}

export interface DealPage {
  data: Deal[];
  nextCursor: string | null;
}

/**
 * One page of a pipeline's deals, keyset on an id-only cursor (D-L80).
 *
 * THE CURSOR (DealCursor, R22): it must name a deal of THIS pipeline that the
 * caller reaches and that the same filters still select. Anything else (no
 * such deal, another tenant's, programme's or pipeline's, or one the filters
 * no longer select) throws InvalidCursorError, one answer whatever the
 * reason, exactly as a malformed cursor: the cursor row is looked up under
 * the very WHERE of the page. Unlike the general `Cursor`, never an empty
 * page.
 */
export async function listDeals(
  tx: TenantTx,
  pipeline: PipelineRef,
  options: ListDealsOptions,
): Promise<DealPage> {
  assertInScope(tx, pipeline.programmeId);
  const spec = SORT_SPECS[options.sort];

  if (options.cursor !== undefined) {
    const cursorId = decodeListCursor(options.cursor, options.sort);
    const probe = new Params();
    const where = listWhere(tx, pipeline, options.filters, probe);
    where.push(`d.id = ${probe.add(cursorId)}::uuid`);
    const found = await tx.query<{ ok: number }>(
      `SELECT 1 AS ok FROM deal d WHERE ${where.join(' AND ')}`,
      probe.values,
    );
    if (found.length === 0) throw new InvalidCursorError();
  }

  const params = new Params();
  const where = listWhere(tx, pipeline, options.filters, params);
  if (options.cursor !== undefined) {
    const cursorId = decodeListCursor(options.cursor, options.sort);
    const operator = spec.direction === 'DESC' ? '<' : '>';
    // The position is the cursor row's CURRENT (key, id), read in scope.
    where.push(`(d.${spec.column}, d.id) ${operator} (
        SELECT cursor_row.${spec.column}, cursor_row.id
          FROM deal cursor_row
         WHERE cursor_row.id = ${params.add(cursorId)}::uuid
           AND cursor_row.tenant_id = ${params.add(tx.session.tenantId)}::uuid
           AND cursor_row.programme_id = ${params.add(pipeline.programmeId)}::uuid
           AND cursor_row.pipeline_id = ${params.add(pipeline.id)}::uuid)`);
  }
  const limit = params.add(options.limit + 1);
  const rows = await tx.query<DealRow>(
    `${DEAL_SELECT}
      WHERE ${where.join('\n        AND ')}
      ORDER BY d.${spec.column} ${spec.direction}, d.id ${spec.direction}
      LIMIT ${limit}`,
    params.values,
  );
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const checks = await checksFor(
    tx,
    pipeline.programmeId,
    page.map((row) => row.id),
  );
  const last = page.at(-1);
  return {
    data: page.map((row) => toDeal(row, checks.get(row.id) ?? [])),
    nextCursor:
      hasMore && last !== undefined ? encodeListCursor({ sort: options.sort, id: last.id }) : null,
  };
}
