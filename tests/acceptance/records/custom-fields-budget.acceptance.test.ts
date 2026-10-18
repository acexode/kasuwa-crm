import { performance } from 'node:perf_hooks';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  TENANT_A,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import pg, { type Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, withAuthDatabase } from '../support/api';

/**
 * ACCEPTANCE — T-0089, ONE custom-field filter at the T-0084 latency budget
 * (ADR-0016 item 8: "T-0089's suite adds one custom-field filter to the
 * T-0084 latency budget at its 120k seed. If the budget fails, the filter is
 * withdrawn from the contract, not served slowly"; D-P33; D-L80; D-L135).
 * Written by QA for the lead before the build (D-L23, D-L25). The approach,
 * sizes and budget are records/list-indexes' (T-0084), restated here, never
 * imported; that suite is unchanged.
 *
 * WHAT THIS PINS. `GET /api/v1/contacts?custom[tier__c]=gold&sort=-createdAt`
 * on a tenant of 120,000 contacts, where one row in ten is `gold`:
 *
 *   B1 RESULTS. A first page and a deep page are exactly the rows a direct
 *      ORDER BY over the filter says (the D-L75 hazard: a filter that is
 *      ignored is fast and wrong, so speed alone proves nothing).
 *   B2 PLAN. Every statement the request sends that reads FROM contact,
 *      replayed as EXPLAIN (ANALYZE, FORMAT JSON) inside withTenantTransaction
 *      for the same user (kasuwa_app, the same RLS scope): no Seq Scan on
 *      contact, no Sort node (Incremental Sort allowed), no OFFSET; the
 *      page's outer scans of contact are index scans that together examine
 *      at most MAX_ROWS_EXAMINED rows. "Evaluated as a scan inside the
 *      already-scoped keyset page" (ADR-0016 item 8) is exactly this: the
 *      keyset index gives the order, the filter discards non-matches. Both a
 *      one-programme agent and the two-programme supervisor (list-indexes
 *      R1).
 *   B3 LATENCY. A first page and a deep page, best of three, each within
 *      PAGE_BUDGET_MS (150 ms, list-indexes I9's figure).
 *
 * RULINGS (this suite's; the lead may reverse)
 *   F1 Selectivity one in ten. A picklist of ten values, uniformly used, is
 *      the ordinary case; a page of 25 then examines about 250 rows (500 for
 *      the A1-only agent, whose index is not programme-led). A value used by
 *      almost no row degrades to a scan of the caller's scope with or
 *      without this filter; that is ADR-0015's question (an index side
 *      table), not this budget's.
 *   F2 The deep page is reached format-blind, as list-indexes I3: a `q`
 *      naming two marker rows (both `gold`) in the middle of the order,
 *      `limit=1`, gives a cursor; the cursor is then sent with the filter
 *      and without `q`.
 *   F3 The rows carry a second custom key (a 24-character text), so `custom`
 *      is a realistic two-key object, not a one-key toy.
 *
 * D-L23: on this branch `contact.custom` does not exist, so the seed itself
 * fails and every test fails for that reason. When the column exists but the
 * filter is ignored, B1 fails (unfiltered rows); when the filter is served by
 * a scan and sort, B2 and B3 fail.
 *
 * Fixtures: tenant A, A1, A2, its agent and supervisor from
 * packages/db/src/fixtures.ts, plus generated rows with ids in this suite's
 * range (`11111111-0089-...`), planted by kasuwa_migrator. No generated value
 * resembles a person: names are md5 fragments.
 */

const CONTACT_COUNT = 120_000;
const PAGE = 25;
const MAX_ROWS_EXAMINED = 2_000;
const PAGE_BUDGET_MS = 150;
const SEED_CHUNK = 10_000;
const MARKER_Q = 'zqxcfmarker';
const MID = CONTACT_COUNT / 2;

const TIER_FIELD = '11111111-0000-4000-8000-0089e0000001';
const NOTE_FIELD = '11111111-0000-4000-8000-0089e0000002';
const OTHER_TIERS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];

/** i is gold when i % 10 = 0, and the two markers (MID, MID + 2) are gold. */
const isGold = (i: number) => i % 10 === 0 || i === MID || i === MID + 2;

const SEED_SQL = `
INSERT INTO contact (id, tenant_id, programme_id, display_name, status, created_at, updated_at, custom)
SELECT ('11111111-0089-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
       $1::uuid,
       CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
       CASE WHEN i = $4 THEN '8000 ${MARKER_Q} a'
            WHEN i = $4 + 2 THEN '8000 ${MARKER_Q} b'
            ELSE substr(md5('n' || i), 1, 10) || ' ' || substr(md5('f' || i), 1, 8)
       END,
       'new',
       timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => i),
       timestamptz '2025-06-01 00:00:00+00' + make_interval(secs => i),
       jsonb_build_object(
         'tier__c', CASE WHEN i % 10 = 0 OR i IN ($4, $4 + 2) THEN 'gold'
                         ELSE ($7::text[])[i % 9 + 1] END,
         'note__c', substr(md5('c' || i), 1, 24))
  FROM generate_series($5::int, $6::int) AS i`;

interface Caller {
  label: string;
  userId: string;
  programmeIds: readonly string[];
}
const AGENT: Caller = { label: 'agent (A1)', userId: USER_A_AGENT_1, programmeIds: [PROGRAMME_A1] };
const SUPERVISOR: Caller = { label: 'supervisor (A1+A2)', userId: USER_A_SUPERVISOR, programmeIds: [PROGRAMME_A1, PROGRAMME_A2] };

// ---------------------------------------------------------------------------
// Statement recording and plans (list-indexes I2, restated).
// ---------------------------------------------------------------------------

interface Recorded {
  text: string;
  values: readonly unknown[];
}
type QueryFn = (this: unknown, ...args: unknown[]) => unknown;
const clientPrototype = pg.Client.prototype as unknown as { query: QueryFn };
const originalQuery = clientPrototype.query;
let recording: Recorded[] | null = null;

function startRecording(): void {
  clientPrototype.query = function recordingQuery(this: unknown, ...args: unknown[]) {
    const [first, second] = args;
    if (recording !== null) {
      if (typeof first === 'string') {
        recording.push({ text: first, values: Array.isArray(second) ? second : [] });
      } else if (typeof first === 'object' && first !== null && 'text' in first) {
        const config = first as { text: unknown; values?: unknown };
        if (typeof config.text === 'string') {
          const values = Array.isArray(second) ? second : Array.isArray(config.values) ? config.values : [];
          recording.push({ text: config.text, values });
        }
      }
    }
    return originalQuery.apply(this, args);
  };
}

function stopRecording(): void {
  clientPrototype.query = originalQuery;
  recording = null;
}

const readsContact = /\bFROM\s+"?contact"?(?![A-Za-z0-9_"])/i;
const isPageQuery = (text: string) => readsContact.test(text) && /\bORDER\s+BY\b/i.test(text) && /\bLIMIT\b/i.test(text);

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Parent Relationship'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode, inSubplan = false, out: { node: PlanNode; inSubplan: boolean }[] = []) {
  const here = inSubplan || node['Parent Relationship'] === 'SubPlan' || node['Parent Relationship'] === 'InitPlan';
  out.push({ node, inSubplan: here });
  for (const child of node.Plans ?? []) flatten(child, here, out);
  return out;
}

function planProblems(text: string, root: PlanNode, isPage: boolean): string[] {
  const problems: string[] = [];
  const nodes = flatten(root);
  if (/\bOFFSET\b/i.test(text)) problems.push('the SQL pages with OFFSET');
  for (const { node } of nodes) {
    if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'contact') problems.push('Seq Scan on contact');
    if (node['Node Type'] === 'Sort') problems.push('a Sort node (the order does not come from an index)');
  }
  if (isPage) {
    const outer = nodes.filter(({ node, inSubplan }) => !inSubplan && node['Relation Name'] === 'contact');
    if (outer.length === 0) problems.push('no outer scan of contact found in the plan');
    let examined = 0;
    for (const { node } of outer) {
      if (node['Node Type'] !== 'Index Scan' && node['Node Type'] !== 'Index Only Scan') {
        problems.push(`the page reads contact by ${node['Node Type']}, not an index scan`);
      }
      examined += ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 1);
    }
    if (examined > MAX_ROWS_EXAMINED) {
      problems.push(`the page examined ${examined} contact rows (budget ${MAX_ROWS_EXAMINED}): it scans, it does not seek`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

it('(self-check) the plan checker passes an index seek and names a Seq Scan, a Sort, OFFSET and an over-budget scan', () => {
  // Outside the seeded describe, so it runs (and must pass) before the build.
  const seek: PlanNode = {
    'Node Type': 'Limit',
    Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'contact', 'Actual Rows': 26, 'Rows Removed by Filter': 230, 'Actual Loops': 1 }],
  };
  expect(planProblems('SELECT id FROM contact ORDER BY created_at DESC LIMIT 26', seek, true)).toEqual([]);
  const scanAndSort: PlanNode = {
    'Node Type': 'Limit',
    Plans: [
      {
        'Node Type': 'Sort',
        Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'contact', 'Actual Rows': 6000, 'Rows Removed by Filter': 54000, 'Actual Loops': 1 }],
      },
    ],
  };
  const problems = planProblems('SELECT id FROM contact ORDER BY created_at DESC LIMIT 26 OFFSET 25', scanAndSort, true).join('\n');
  for (const expected of [/Seq Scan/, /Sort node/, /OFFSET/, /not an index scan/, /examined 60000/]) {
    expect(problems).toMatch(expected);
  }
  const filteredScan: PlanNode = {
    'Node Type': 'Limit',
    Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'contact', 'Actual Rows': 26, 'Rows Removed by Filter': 59000, 'Actual Loops': 1 }],
  };
  expect(planProblems('SELECT id FROM contact ORDER BY created_at DESC LIMIT 26', filteredScan, true).join('\n')).toMatch(/scans, it does not seek/);
  expect(isPageQuery('SELECT id FROM contact WHERE x ORDER BY created_at LIMIT 26')).toBe(true);
  expect(isPageQuery('SELECT id FROM contact_x ORDER BY created_at LIMIT 26')).toBe(false);
});

describe('acceptance: one custom-field filter at the T-0084 budget (T-0089)', () => {
  let app: INestApplication;
  let appPool: Pool;
  let migrator: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    const object = await migrator.query<{ id: string }>(
      `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact'`,
      [TENANT_A],
    );
    const objectId = object.rows[0]?.id;
    await migrator.query(
      `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
       VALUES ($1, $2, $3, 'tier__c', 'T-0089 tier', 'picklist', 'none', true, $4::jsonb),
              ($5, $2, $3, 'note__c', 'T-0089 note', 'text', 'none', true, '{}'::jsonb)`,
      [
        TIER_FIELD,
        TENANT_A,
        objectId,
        JSON.stringify({ values: ['gold', ...OTHER_TIERS].map((value) => ({ value, label: value })) }),
        NOTE_FIELD,
      ],
    );
    const t0 = performance.now();
    for (let from = 1; from <= CONTACT_COUNT; from += SEED_CHUNK) {
      await migrator.query(SEED_SQL, [
        TENANT_A,
        PROGRAMME_A1,
        PROGRAMME_A2,
        MID,
        from,
        Math.min(from + SEED_CHUNK - 1, CONTACT_COUNT),
        OTHER_TIERS,
      ]);
    }
    await migrator.query('ANALYZE contact');
    process.stdout.write(`custom-fields-budget: seeded in ${Math.round(performance.now() - t0)} ms\n`);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 }))],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  }, 300_000);

  afterAll(async () => {
    stopRecording();
    await app?.close();
    await appPool?.end();
    await migrator?.end();
    await reseed(inject('migrationUrl'));
  }, 120_000);

  type Row = Record<string, unknown>;

  async function okPage(caller: Caller, params: Record<string, string | undefined>): Promise<{ data: Row[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
    const response = await request(app.getHttpServer())
      .get(`/api/v1/contacts?${query.toString()}`)
      .set(asUser(TENANT_A, caller.userId));
    expect(response.status, `${JSON.stringify(params)}: ${response.text}`).toBe(200);
    const body = response.body as { data?: Row[]; nextCursor?: string | null };
    return { data: body.data ?? [], nextCursor: body.nextCursor ?? null };
  }

  const FILTER = { 'custom[tier__c]': 'gold', sort: '-createdAt' } as const;

  /** F2: a cursor at the first gold marker, issued under the filter. */
  async function deepCursor(caller: Caller): Promise<{ cursor: string; markerId: string }> {
    const page = await okPage(caller, { ...FILTER, q: MARKER_Q, limit: '1' });
    const marker = page.data[0];
    expect(marker, 'the gold marker rows are not found by q under the filter').toBeDefined();
    expect(page.nextCursor, 'two gold markers, limit 1, but no next cursor').not.toBeNull();
    return { cursor: String(page.nextCursor), markerId: String(marker?.id) };
  }

  /** Ground truth by a direct ORDER BY, as kasuwa_migrator (B1). */
  async function expectedGold(caller: Caller, afterId: string | null, limit: number): Promise<string[]> {
    const after = afterId === null ? '' : `AND (created_at, id) < (SELECT created_at, id FROM contact WHERE id = $3)`;
    const result = await migrator.query<{ id: string }>(
      `SELECT id FROM contact
        WHERE tenant_id = $1 AND programme_id = ANY ($2::uuid[]) AND custom->>'tier__c' = 'gold' ${after}
        ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
      afterId === null ? [TENANT_A, caller.programmeIds] : [TENANT_A, caller.programmeIds, afterId],
    );
    return result.rows.map((row) => row.id);
  }

  async function planOf(caller: Caller, params: Record<string, string | undefined>): Promise<string[]> {
    recording = [];
    startRecording();
    let statements: Recorded[];
    try {
      await okPage(caller, params);
    } finally {
      statements = recording ?? [];
      stopRecording();
    }
    const relevant = statements.filter((statement) => readsContact.test(statement.text));
    const problems: string[] = [];
    if (!relevant.some((statement) => isPageQuery(statement.text))) {
      problems.push(`no page query (FROM contact ... ORDER BY ... LIMIT) among ${statements.length} statements`);
    }
    for (const statement of relevant) {
      const rows = await withTenantTransaction(appPool, { tenantId: TENANT_A, userId: caller.userId }, (tx) =>
        tx.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, statement.values),
      );
      const root = rows[0]?.['QUERY PLAN'][0]?.Plan;
      if (root === undefined) {
        problems.push('EXPLAIN returned no plan');
        continue;
      }
      problems.push(...planProblems(statement.text, root, isPageQuery(statement.text)));
    }
    return problems;
  }

  async function timed(fn: () => Promise<unknown>): Promise<number> {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      await fn();
      best = Math.min(best, performance.now() - started);
    }
    return best;
  }

  it('the large tenant is seeded: 120,000 contacts, one in ten gold, the two markers gold', async () => {
    const counts = await migrator.query<{ total: string; gold: string; markers: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE custom->>'tier__c' = 'gold') AS gold,
              count(*) FILTER (WHERE display_name LIKE '%${MARKER_Q}%' AND custom->>'tier__c' = 'gold') AS markers
         FROM contact WHERE tenant_id = $1 AND id::text LIKE '11111111-0089-%'`,
      [TENANT_A],
    );
    const expectedGoldCount = Array.from({ length: CONTACT_COUNT }, (_, k) => k + 1).filter(isGold).length;
    expect(counts.rows[0]).toEqual({ total: String(CONTACT_COUNT), gold: String(expectedGoldCount), markers: '2' });
  });

  it('(B1) a first page and a deep page are exactly the gold rows a direct ORDER BY names, for both callers', async () => {
    for (const caller of [AGENT, SUPERVISOR]) {
      const first = await okPage(caller, { ...FILTER, limit: String(PAGE) });
      expect(first.data.map((row) => String(row.id)), `${caller.label} first page`).toEqual(await expectedGold(caller, null, PAGE));
      const { cursor, markerId } = await deepCursor(caller);
      const seen: string[] = [];
      let next: string | null = cursor;
      for (let page = 0; page < 4 && next !== null; page += 1) {
        const deep = await okPage(caller, { ...FILTER, limit: String(PAGE), cursor: next });
        seen.push(...deep.data.map((row) => String(row.id)));
        next = deep.nextCursor;
      }
      const expected = await expectedGold(caller, markerId, PAGE * 4);
      expect(expected).toHaveLength(PAGE * 4);
      expect(seen, `${caller.label} deep pages`).toEqual(expected);
    }
  }, 120_000);

  it('(B2) the filtered first and deep pages are served by the keyset index: no Seq Scan, no Sort, no OFFSET, a bounded seek', async () => {
    const problems: string[] = [];
    for (const caller of [AGENT, SUPERVISOR]) {
      const first = await planOf(caller, { ...FILTER, limit: String(PAGE) });
      problems.push(...first.map((p) => `${caller.label}, first page: ${p}`));
      const { cursor } = await deepCursor(caller);
      const deep = await planOf(caller, { ...FILTER, limit: String(PAGE), cursor });
      problems.push(...deep.map((p) => `${caller.label}, deep page: ${p}`));
    }
    expect([...new Set(problems)].join('\n')).toBe('');
  }, 120_000);

  it(`(B3) the filtered first page and deep page each answer within ${PAGE_BUDGET_MS} ms (best of three)`, async () => {
    const { cursor } = await deepCursor(SUPERVISOR);
    // Warm the route once, so the budget never measures start-up.
    await okPage(SUPERVISOR, { ...FILTER, limit: String(PAGE) });
    const first = await timed(() => okPage(SUPERVISOR, { ...FILTER, limit: String(PAGE) }));
    const deep = await timed(() => okPage(SUPERVISOR, { ...FILTER, limit: String(PAGE), cursor }));
    process.stdout.write(`custom-fields-budget latency: first ${first.toFixed(1)} ms, deep ${deep.toFixed(1)} ms\n`);
    expect(first, 'first page ms').toBeLessThanOrEqual(PAGE_BUDGET_MS);
    expect(deep, 'deep page ms').toBeLessThanOrEqual(PAGE_BUDGET_MS);
  }, 60_000);
});
