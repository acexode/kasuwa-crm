import { newId } from './ids';

/**
 * The default pipeline every programme starts with (T-0106, D-L113).
 *
 * ONE template, read by three writers: `createProgramme` (a new programme,
 * R9), `ensureStandardObjectDefs` (the seed and the deploy-window repair,
 * R10) and, as a frozen copy, migration 0036 (the backfill of programmes that
 * pre-date it, R11). The T-0106 suite asserts all three produce exactly the
 * contract's getPipeline example (docs/api/records.openapi.yaml): "B2B sales",
 * seven stages, their probabilities, rotting days and requirements, version 1.
 *
 * A stage's position is its index in `stages`. Requirement `field`s are
 * field_def api_names (snake_case, R2). Changing this template changes what
 * NEW programmes get; existing pipelines are configuration and are never
 * rewritten from it.
 */

export type PipelineStageKind = 'open' | 'won' | 'lost';

export type PipelineRequirementTemplate =
  | { readonly kind: 'field'; readonly field: string }
  | { readonly kind: 'check'; readonly label: string };

export interface PipelineStageTemplate {
  readonly name: string;
  readonly kind: PipelineStageKind;
  readonly probabilityBp: number;
  /** Open stages only; `null` on won and lost. */
  readonly rottingAfterDays: number | null;
  readonly requirements: readonly PipelineRequirementTemplate[];
}

export interface PipelineTemplate {
  readonly name: string;
  readonly stages: readonly PipelineStageTemplate[];
}

export const DEFAULT_PIPELINE_TEMPLATE: PipelineTemplate = {
  name: 'B2B sales',
  stages: [
    { name: 'Qualified', kind: 'open', probabilityBp: 1000, rottingAfterDays: 14, requirements: [] },
    { name: 'Discovery', kind: 'open', probabilityBp: 2500, rottingAfterDays: 14, requirements: [] },
    {
      name: 'Proposal',
      kind: 'open',
      probabilityBp: 5000,
      rottingAfterDays: 14,
      requirements: [{ kind: 'check', label: 'Budget range confirmed with the customer' }],
    },
    {
      name: 'Negotiation',
      kind: 'open',
      probabilityBp: 7000,
      rottingAfterDays: 14,
      requirements: [
        { kind: 'field', field: 'amount' },
        { kind: 'field', field: 'expected_close_date' },
        { kind: 'check', label: 'Quote sent to the customer' },
      ],
    },
    {
      name: 'Contract',
      kind: 'open',
      probabilityBp: 9000,
      rottingAfterDays: 21,
      requirements: [
        { kind: 'field', field: 'primary_contact_id' },
        { kind: 'check', label: 'Purchase order received' },
      ],
    },
    { name: 'Won', kind: 'won', probabilityBp: 10000, rottingAfterDays: null, requirements: [] },
    { name: 'Lost', kind: 'lost', probabilityBp: 0, rottingAfterDays: null, requirements: [] },
  ],
};

/**
 * The contract's seed rule (getPipeline, D-L88), as [from, to] stage
 * POSITIONS: forward one stage (the last open stage forward is won), back to
 * any earlier open stage, lost from any open stage, and from won or lost back
 * to any open stage. Never a stage to itself; each pair once.
 */
export function seedTransitions(
  stages: readonly Pick<PipelineStageTemplate, 'kind'>[],
): [number, number][] {
  const opens = stages.flatMap((stage, position) => (stage.kind === 'open' ? [position] : []));
  const won = stages.findIndex((stage) => stage.kind === 'won');
  const lost = stages.findIndex((stage) => stage.kind === 'lost');
  if (opens.length === 0 || won === -1 || lost === -1) {
    throw new Error('A pipeline template needs an open, a won and a lost stage');
  }
  const pairs: [number, number][] = [];
  opens.forEach((from, index) => {
    pairs.push([from, opens[index + 1] ?? won]);
    for (const earlier of opens.slice(0, index)) pairs.push([from, earlier]);
    pairs.push([from, lost]);
  });
  for (const closed of [won, lost]) {
    for (const open of opens) pairs.push([closed, open]);
  }
  const seen = new Set<string>();
  return pairs.filter(([from, to]) => {
    const key = `${from}>${to}`;
    if (from === to || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Same shape as StandardCatalogueQuery; repeated so this file stands alone. */
export type DefaultPipelineQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/**
 * Gives every programme of ONE tenant that has no pipeline the default one,
 * in the caller's transaction, and returns the ids of the programmes it
 * created one for. `programmeId` narrows it to one programme
 * (createProgramme).
 *
 * IDEMPOTENT: a programme that already has any pipeline is left alone (same
 * ids, nothing written), so a second call changes nothing.
 *
 * WHO MAY CALL IT:
 *   - kasuwa_migrator (the seed, provisioning, an operator's repair): every
 *     programme of the tenant.
 *   - kasuwa_app inside withTenantTransaction: the programmes its policies
 *     admit, i.e. those in scope and the one this transaction created (0036's
 *     use of 0015's creation marker). That is how createProgramme seeds the
 *     pipeline of the programme it has just made, before the scope that
 *     would include it exists.
 *
 * NOT CONCURRENCY-SAFE against itself for the same programme: two
 * simultaneous first calls could both write a pipeline (there is no unique
 * key, because pipeline.write will allow more than one per programme). The
 * callers are a programme's own creating transaction, the seed and an
 * operator's repair, which do not race.
 *
 * tenancy-reviewed: `tenantId` is the only tenant named, in every statement;
 * createProgramme passes `tx.session.tenantId` and the seed its fixture
 * tenant. Every value is a bound parameter. Fresh ids (D-L08), never shared.
 */
export async function ensureDefaultPipelines(
  query: DefaultPipelineQuery,
  tenantId: string,
  programmeId?: string,
): Promise<string[]> {
  const targets = await query(
    `SELECT p.id
       FROM programme p
      WHERE p.tenant_id = $1::uuid
        AND ($2::uuid IS NULL OR p.id = $2::uuid)
        AND NOT EXISTS (SELECT 1 FROM pipeline x
                         WHERE x.tenant_id = p.tenant_id AND x.programme_id = p.id)
      ORDER BY p.id`,
    [tenantId, programmeId ?? null],
  );
  const created: string[] = [];
  for (const row of targets) {
    const target = String(row.id);
    await insertDefaultPipeline(query, tenantId, target);
    created.push(target);
  }
  return created;
}

async function insertDefaultPipeline(
  query: DefaultPipelineQuery,
  tenantId: string,
  programmeId: string,
): Promise<void> {
  const template = DEFAULT_PIPELINE_TEMPLATE;
  const pipelineId = newId();
  const stageIds = template.stages.map(() => newId());
  const stageAt = (position: number): string => {
    const id = stageIds[position];
    if (id === undefined) throw new Error(`No stage at position ${position}`);
    return id;
  };
  const requirements = template.stages.flatMap((stage, position) =>
    stage.requirements.map((requirement, index) => ({
      stageId: stageAt(position),
      position: index,
      kind: requirement.kind,
      field: requirement.kind === 'field' ? requirement.field : null,
      label: requirement.kind === 'check' ? requirement.label : null,
    })),
  );
  const transitions = seedTransitions(template.stages);

  // tenancy-reviewed: tenant and programme from the caller (see above).
  await query(
    `INSERT INTO pipeline (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)`,
    [pipelineId, tenantId, programmeId, template.name],
  );
  await query(
    `INSERT INTO pipeline_stage
       (id, tenant_id, programme_id, pipeline_id, name, kind, position, probability_bp,
        rotting_after_days)
     SELECT s.id, $1::uuid, $2::uuid, $3::uuid, s.name, s.kind, s.position, s.probability_bp,
            s.rotting_after_days
       FROM unnest($4::uuid[], $5::text[], $6::text[], $7::integer[], $8::integer[],
                   $9::integer[])
            AS s (id, name, kind, position, probability_bp, rotting_after_days)`,
    [
      tenantId,
      programmeId,
      pipelineId,
      stageIds,
      template.stages.map((stage) => stage.name),
      template.stages.map((stage) => stage.kind),
      template.stages.map((_stage, position) => position),
      template.stages.map((stage) => stage.probabilityBp),
      template.stages.map((stage) => stage.rottingAfterDays),
    ],
  );
  await query(
    `INSERT INTO pipeline_stage_requirement
       (id, tenant_id, programme_id, pipeline_id, stage_id, kind, position, field, label)
     SELECT r.id, $1::uuid, $2::uuid, $3::uuid, r.stage_id, r.kind, r.position, r.field, r.label
       FROM unnest($4::uuid[], $5::uuid[], $6::text[], $7::integer[], $8::text[], $9::text[])
            AS r (id, stage_id, kind, position, field, label)`,
    [
      tenantId,
      programmeId,
      pipelineId,
      requirements.map(() => newId()),
      requirements.map((requirement) => requirement.stageId),
      requirements.map((requirement) => requirement.kind),
      requirements.map((requirement) => requirement.position),
      requirements.map((requirement) => requirement.field),
      requirements.map((requirement) => requirement.label),
    ],
  );
  await query(
    `INSERT INTO pipeline_stage_transition
       (id, tenant_id, programme_id, pipeline_id, from_stage_id, to_stage_id)
     SELECT t.id, $1::uuid, $2::uuid, $3::uuid, t.from_stage_id, t.to_stage_id
       FROM unnest($4::uuid[], $5::uuid[], $6::uuid[]) AS t (id, from_stage_id, to_stage_id)`,
    [
      tenantId,
      programmeId,
      pipelineId,
      transitions.map(() => newId()),
      transitions.map(([from]) => stageAt(from)),
      transitions.map(([, to]) => stageAt(to)),
    ],
  );
}
