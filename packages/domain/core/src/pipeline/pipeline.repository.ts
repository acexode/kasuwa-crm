import type { TenantTx } from '@kasuwa/db';
import { decodeIdCursor, encodeIdCursor, InvalidCursorError } from '../cursor';

/**
 * Pipeline configuration reads (T-0107; listPipelines and getPipeline over
 * 0036's tables).
 *
 * SCOPE. Pipelines are programme-scoped. Every statement repeats the tenant
 * and the programme predicates RLS already enforces (CLAUDE.md 2.3), and the
 * programme list is the caller's `programmeIds` INTERSECTED with
 * `tx.session.programmeIds`: a caller may narrow the session's scope (the API
 * drops the programmes whose set reads no pipeline, D-L115), never widen it.
 * No statement here is built from user input; every value is bound.
 *
 * READS NEVER WRITE (R14): a programme without a pipeline (the deploy-window
 * gap, D-L120) simply lists none. Nothing here creates or repairs one.
 *
 * Nothing here logs. Pipeline and stage names are configuration, but labels
 * are free text and the habit is cheap.
 */

export interface PipelineSummary {
  id: string;
  programmeId: string;
  name: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type PipelineStageKind = 'open' | 'won' | 'lost';

export interface PipelineStageRow {
  id: string;
  name: string;
  kind: PipelineStageKind;
  position: number;
  probabilityBp: number;
  rottingAfterDays: number | null;
}

export interface PipelineRequirementRow {
  id: string;
  stageId: string;
  kind: 'field' | 'check';
  /** The field_def api_name (snake_case) of a `field` requirement, else null. */
  field: string | null;
  /** The label of a `check` requirement, else null. */
  label: string | null;
}

export interface PipelineTransitionRow {
  fromStageId: string;
  toStageId: string;
}

export interface PipelineDetail extends PipelineSummary {
  /** In position order. */
  stages: PipelineStageRow[];
  /** In stage position, then requirement position, order. */
  requirements: PipelineRequirementRow[];
  transitions: PipelineTransitionRow[];
}

export interface PipelinePage {
  data: PipelineSummary[];
  nextCursor: string | null;
}

interface SummaryRow {
  id: string;
  programme_id: string;
  name: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toSummary(row: SummaryRow): PipelineSummary {
  return {
    id: row.id,
    programmeId: row.programme_id,
    name: row.name,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The caller's programmes, never wider than the session's. */
export function withinSession(tx: TenantTx, programmeIds: readonly string[]): string[] {
  const session = new Set(tx.session.programmeIds);
  return programmeIds.filter((programmeId) => session.has(programmeId));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical uuid. A path id that is not one is the caller's one 404 (D-L115). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

const SUMMARY_COLUMNS = 'id, programme_id, name, version, created_at, updated_at';

/**
 * One page of the pipelines in `programmeIds`, by name then id (keyset only,
 * no count, D-P13). A `cursor` must name a pipeline the caller reaches, or it
 * is InvalidCursorError (R9): one refusal whatever the reason, so a cursor
 * cannot test whether an id exists.
 */
export async function listPipelines(
  tx: TenantTx,
  options: { programmeIds: readonly string[]; limit: number; cursor?: string | undefined },
): Promise<PipelinePage> {
  const cursorId = options.cursor === undefined ? undefined : decodeIdCursor(options.cursor);
  const programmeIds = withinSession(tx, options.programmeIds);
  if (programmeIds.length === 0) {
    if (cursorId !== undefined) throw new InvalidCursorError();
    return { data: [], nextCursor: null };
  }
  const values: unknown[] = [tx.session.tenantId, programmeIds];
  let seek = '';
  if (cursorId !== undefined) {
    // tenancy-reviewed: the cursor row is resolved inside the caller's tenant
    // and programmes (RLS besides); another programme's or tenant's id is
    // refused exactly as an invented one.
    const found = await tx.query<{ id: string }>(
      `SELECT id FROM pipeline
        WHERE id = $1::uuid AND tenant_id = $2 AND programme_id = ANY($3::uuid[])`,
      [cursorId, tx.session.tenantId, programmeIds],
    );
    if (found.length === 0) throw new InvalidCursorError();
    values.push(cursorId);
    seek = `AND (name, id) > (
              SELECT cursor_row.name, cursor_row.id
                FROM pipeline cursor_row
               WHERE cursor_row.id = $3::uuid
                 AND cursor_row.tenant_id = $1
                 AND cursor_row.programme_id = ANY($2::uuid[]))`;
  }
  values.push(options.limit + 1);
  // tenancy-reviewed: tenant AND the caller's programmes (within the session's).
  const rows = await tx.query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS}
       FROM pipeline
      WHERE tenant_id = $1
        AND programme_id = ANY($2::uuid[])
        ${seek}
      ORDER BY name, id
      LIMIT $${values.length}`,
    values,
  );
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const last = page.at(-1);
  return {
    data: page.map(toSummary),
    nextCursor: hasMore && last !== undefined ? encodeIdCursor(last.id) : null,
  };
}

/**
 * One pipeline in `programmeIds`, or null: absent, another tenant's, another
 * programme's and a non-uuid alike. The id is never parsed by Postgres unless
 * it is a uuid, so a malformed one cannot become a 22P02.
 */
export async function findPipeline(
  tx: TenantTx,
  id: unknown,
  programmeIds: readonly string[],
): Promise<PipelineSummary | null> {
  if (!isUuid(id)) return null;
  const reachable = withinSession(tx, programmeIds);
  if (reachable.length === 0) return null;
  // tenancy-reviewed: tenant AND the caller's programmes, as well as RLS.
  const rows = await tx.query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS}
       FROM pipeline
      WHERE id = $1::uuid
        AND tenant_id = $2
        AND programme_id = ANY($3::uuid[])`,
    [id, tx.session.tenantId, reachable],
  );
  const row = rows[0];
  return row === undefined ? null : toSummary(row);
}

interface StageRow {
  id: string;
  name: string;
  kind: PipelineStageKind;
  position: number;
  probability_bp: number;
  rotting_after_days: number | null;
}

/** A found pipeline's stages, in position order. */
export async function loadPipelineStages(
  tx: TenantTx,
  pipeline: PipelineSummary,
): Promise<PipelineStageRow[]> {
  // tenancy-reviewed: the pipeline's own tenant, programme and id, as well as RLS.
  const rows = await tx.query<StageRow>(
    `SELECT id, name, kind, position, probability_bp, rotting_after_days
       FROM pipeline_stage
      WHERE tenant_id = $1 AND programme_id = $2 AND pipeline_id = $3
      ORDER BY position`,
    [tx.session.tenantId, pipeline.programmeId, pipeline.id],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    position: row.position,
    probabilityBp: row.probability_bp,
    rottingAfterDays: row.rotting_after_days,
  }));
}

/** A found pipeline with its stages, requirements and transitions. */
export async function loadPipelineDetail(
  tx: TenantTx,
  pipeline: PipelineSummary,
): Promise<PipelineDetail> {
  const scope = [tx.session.tenantId, pipeline.programmeId, pipeline.id];
  const stages = await loadPipelineStages(tx, pipeline);
  // tenancy-reviewed: the pipeline's own tenant, programme and id, as well as RLS.
  const requirements = await tx.query<{
    id: string;
    stage_id: string;
    kind: 'field' | 'check';
    field: string | null;
    label: string | null;
  }>(
    `SELECT r.id, r.stage_id, r.kind, r.field, r.label
       FROM pipeline_stage_requirement r
       JOIN pipeline_stage s
         ON s.tenant_id = r.tenant_id AND s.programme_id = r.programme_id
        AND s.pipeline_id = r.pipeline_id AND s.id = r.stage_id
      WHERE r.tenant_id = $1 AND r.programme_id = $2 AND r.pipeline_id = $3
      ORDER BY s.position, r.position`,
    scope,
  );
  // tenancy-reviewed: as above.
  const transitions = await tx.query<{ from_stage_id: string; to_stage_id: string }>(
    `SELECT from_stage_id, to_stage_id
       FROM pipeline_stage_transition
      WHERE tenant_id = $1 AND programme_id = $2 AND pipeline_id = $3
      ORDER BY from_stage_id, to_stage_id`,
    scope,
  );
  return {
    ...pipeline,
    stages,
    requirements: requirements.map((row) => ({
      id: row.id,
      stageId: row.stage_id,
      kind: row.kind,
      field: row.field,
      label: row.label,
    })),
    transitions: transitions.map((row) => ({
      fromStageId: row.from_stage_id,
      toStageId: row.to_stage_id,
    })),
  };
}
