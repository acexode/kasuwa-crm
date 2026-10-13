import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PIPELINE_TEMPLATE,
  DefaultPipelineRoleError,
  ensureDefaultPipelines,
  seedTransitions,
  type DefaultPipelineQuery,
} from './default-pipeline';

/**
 * T-0106: the template and the seed rule, without a database. What the rows
 * do under RLS and the stage rules is the acceptance suite's and the
 * integration test's job.
 */

const TENANT = '11111111-0000-4000-8000-000000000001';
const PROGRAMME = '11111111-0000-4000-8000-0000000c0001';

const names = (pairs: [number, number][]): string[] =>
  pairs
    .map(([from, to]) => {
      const stage = (at: number) => DEFAULT_PIPELINE_TEMPLATE.stages[at]?.name ?? '?';
      return `${stage(from)}>${stage(to)}`;
    })
    .sort();

describe('the default pipeline template (D-L113, R3)', () => {
  it('is the contract example: five open stages, then won, then lost, with their probabilities', () => {
    expect(DEFAULT_PIPELINE_TEMPLATE.name).toBe('B2B sales');
    expect(
      DEFAULT_PIPELINE_TEMPLATE.stages.map(
        (stage) => `${stage.name}:${stage.kind}:${stage.probabilityBp}:${stage.rottingAfterDays}`,
      ),
    ).toEqual([
      'Qualified:open:1000:14',
      'Discovery:open:2500:14',
      'Proposal:open:5000:14',
      'Negotiation:open:7000:14',
      'Contract:open:9000:21',
      'Won:won:10000:null',
      'Lost:lost:0:null',
    ]);
  });

  it('names requirement fields by field_def api_name, never the wire name (R2)', () => {
    const fields = DEFAULT_PIPELINE_TEMPLATE.stages.flatMap((stage) =>
      stage.requirements.flatMap((requirement) =>
        requirement.kind === 'field' ? [requirement.field] : [],
      ),
    );
    expect(fields).toEqual(['amount', 'expected_close_date', 'primary_contact_id']);
  });

  it('leaves the first open stage without requirements (every deal is created in it)', () => {
    expect(DEFAULT_PIPELINE_TEMPLATE.stages[0]?.requirements).toEqual([]);
  });
});

describe('seedTransitions (the contract seed rule, D-L88)', () => {
  const pairs = seedTransitions(DEFAULT_PIPELINE_TEMPLATE.stages);

  it('gives the template exactly the 30 pairs of the contract example', () => {
    expect(pairs).toHaveLength(30);
    expect(new Set(pairs.map(([from, to]) => `${from}>${to}`)).size).toBe(30);
    expect(pairs.some(([from, to]) => from === to)).toBe(false);
  });

  it('reaches won only from the last open stage, and lost from every open stage', () => {
    const all = names(pairs);
    expect(all.filter((pair) => pair.endsWith('>Won'))).toEqual(['Contract>Won']);
    expect(all.filter((pair) => pair.endsWith('>Lost'))).toEqual([
      'Contract>Lost',
      'Discovery>Lost',
      'Negotiation>Lost',
      'Proposal>Lost',
      'Qualified>Lost',
    ]);
    expect(all).not.toContain('Won>Lost');
    expect(all).not.toContain('Lost>Won');
  });

  it('moves forward one stage only, and back to any earlier open stage', () => {
    const all = names(pairs);
    expect(all).toContain('Qualified>Discovery');
    expect(all).not.toContain('Qualified>Proposal');
    expect(all).toContain('Contract>Qualified');
    expect(all).toContain('Won>Qualified');
    expect(all).toContain('Lost>Contract');
  });

  it('refuses a template without a won or a lost stage', () => {
    expect(() => seedTransitions([{ kind: 'open' }, { kind: 'won' }])).toThrow();
    expect(() => seedTransitions([{ kind: 'won' }, { kind: 'lost' }])).toThrow();
  });
});

describe('ensureDefaultPipelines', () => {
  function recorder(
    targets: string[],
    role = 'kasuwa_migrator',
  ): {
    query: DefaultPipelineQuery;
    calls: { text: string; values: readonly unknown[] }[];
  } {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const query: DefaultPipelineQuery = async (text, values) => {
      calls.push({ text, values });
      if (text.includes('current_user')) return [{ role }];
      return text.includes('FROM programme p') ? targets.map((id) => ({ id })) : [];
    };
    return { query, calls };
  }

  it('writes nothing for a tenant whose programmes all have a pipeline (idempotent)', async () => {
    const { query, calls } = recorder([]);
    expect(await ensureDefaultPipelines(query, TENANT)).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.values).toEqual([TENANT, null]);
  });

  it.each(['kasuwa_app', 'kasuwa_test_admin', 'postgres'])(
    'refuses the all-programmes path as %s, before reading or writing anything (D-L120)',
    async (role) => {
      const { query, calls } = recorder(['22222222-0000-4000-8000-0000000c0002'], role);
      await expect(ensureDefaultPipelines(query, TENANT)).rejects.toBeInstanceOf(
        DefaultPipelineRoleError,
      );
      expect(calls.map((call) => call.text)).toEqual(['SELECT current_user::text AS role']);
    },
  );

  it('the refusal names no tenant, programme or role', () => {
    const message = new DefaultPipelineRoleError().message;
    expect(message).not.toContain(TENANT);
    expect(message).not.toContain('kasuwa_app');
  });

  it('the programmeId path asks no role (createProgramme as kasuwa_app is unchanged)', async () => {
    const { query, calls } = recorder([], 'kasuwa_app');
    expect(await ensureDefaultPipelines(query, TENANT, PROGRAMME)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).not.toContain('current_user');
  });

  it('names the tenant in every statement and keeps every row in one pipeline', async () => {
    const { query, calls } = recorder([PROGRAMME]);
    expect(await ensureDefaultPipelines(query, TENANT, PROGRAMME)).toEqual([PROGRAMME]);
    expect(calls[0]?.values).toEqual([TENANT, PROGRAMME]);

    const [, pipeline, stages, requirements, transitions] = calls;
    const pipelineId = pipeline?.values[0];
    expect(pipeline?.values.slice(1)).toEqual([TENANT, PROGRAMME, 'B2B sales']);
    for (const call of [stages, requirements, transitions]) {
      expect(call?.values.slice(0, 3)).toEqual([TENANT, PROGRAMME, pipelineId]);
    }

    // Requirements and transitions name only stages written in this call.
    const stageIds = stages?.values[3] as string[];
    expect(stageIds).toHaveLength(7);
    expect(new Set(stageIds).size).toBe(7);
    for (const id of requirements?.values[4] as string[]) expect(stageIds).toContain(id);
    expect(requirements?.values[6]).toEqual([0, 0, 1, 2, 0, 1]);
    const from = transitions?.values[4] as string[];
    const to = transitions?.values[5] as string[];
    expect(from).toHaveLength(30);
    for (const id of [...from, ...to]) expect(stageIds).toContain(id);
  });
});
