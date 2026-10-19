import {
  createPool,
  PROGRAMME_A1,
  withTenantTransaction,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  TENANT_A,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { listAccounts, type AccountSort } from './account/account.repository';
import { listContacts, type ContactSort } from './contact/contact.repository';
import { encodeListCursor } from './cursor';

/**
 * T-0084, migration review M1: a session reaching exactly ONE programme sends
 * scalar `programme_id = $p`, so Postgres 16 takes the page order from a
 * programme-led (tenant_id, programme_id, key, id) index, and reads only that
 * programme's rows. A session reaching several sends `= ANY($p)` and is served
 * by 0035's tenant-led indexes (the list-indexes acceptance suite pins that).
 *
 * The plan is read as kasuwa_migrator on a skewed copy of the tenant (see
 * planOf), so it shows the planner's choice of index, not RLS: the list-indexes
 * acceptance suite pins that kasuwa_app can use these indexes under FORCE RLS.
 * With `= ANY` Postgres 16 cannot take the order from a programme-led index at
 * all, so these assertions are exactly the M1 change.
 */

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Parent Relationship'?: string;
  Plans?: PlanNode[];
}

function outerIndexes(node: PlanNode, table: string, out: string[] = []): string[] {
  if (node['Parent Relationship'] === 'InitPlan' || node['Parent Relationship'] === 'SubPlan') {
    return out;
  }
  if (node['Relation Name'] === table && node['Index Name'] !== undefined) {
    out.push(node['Index Name']);
  }
  for (const child of node.Plans ?? []) outerIndexes(child, table, out);
  return out;
}

function hasSort(node: PlanNode): boolean {
  return node['Node Type'] === 'Sort' || (node.Plans ?? []).some(hasSort);
}

const CONTACT_PROGRAMME_LED: Record<string, string> = {
  createdAt: 'contact_keyset_idx',
  updatedAt: 'contact_programme_updated_keyset_idx',
};
const ACCOUNT_PROGRAMME_LED: Record<string, string> = {
  createdAt: 'account_keyset_idx',
  updatedAt: 'account_programme_updated_keyset_idx',
  name: 'account_name_keyset_idx',
};

describe('list plans by session scope (T-0084, M1)', () => {
  let pool: ReturnType<typeof createPool>;
  /** kasuwa_migrator: seeds the skew in a transaction it always rolls back. */
  let migrator: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 1 });
  });

  afterAll(async () => {
    await pool.end();
    await migrator.end();
  });

  /**
   * Runs `list` as the user with a tx that records the page query, then
   * EXPLAINs that exact statement and its values on a skewed tenant: inside a
   * kasuwa_migrator transaction that adds 4,000 contacts and accounts to A1,
   * ANALYZEs, explains and ROLLS BACK, so no other test ever sees the rows.
   * The agent's programme (A2) is then a small share of the tenant, the case
   * a tenant-led index serves badly (it filters through A1's rows).
   */
  async function planOf(
    userId: string,
    table: 'contact' | 'account',
    list: (tx: TenantTx) => Promise<unknown>,
  ): Promise<{ indexes: string[]; sorted: boolean; text: string }> {
    const recorded: { text: string; values: readonly unknown[] }[] = [];
    await withTenantTransaction(pool, { tenantId: TENANT_A, userId }, async (tx) => {
      const recording: TenantTx = {
        session: tx.session,
        query: (text, values) => {
          recorded.push({ text, values: values ?? [] });
          return tx.query(text, values);
        },
      };
      await list(recording);
    });
    const page = recorded.find((entry) => /\bORDER BY\b/.test(entry.text));
    if (page === undefined) throw new Error('no page query was recorded');

    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO contact (id, tenant_id, programme_id, display_name)
         SELECT gen_random_uuid(), $1, $2, 'T-0084 skew ' || i FROM generate_series(1, 4000) AS i`,
        [TENANT_A, PROGRAMME_A1],
      );
      await client.query(
        `INSERT INTO account (id, tenant_id, programme_id, name)
         SELECT gen_random_uuid(), $1, $2, 'T-0084 skew ' || i FROM generate_series(1, 4000) AS i`,
        [TENANT_A, PROGRAMME_A1],
      );
      await client.query(`ANALYZE ${table}`);
      // Compare index paths only: the question is which index, not whether.
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_sort = off');
      const result = await client.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (FORMAT JSON) ${page.text}`,
        [...page.values],
      );
      const root = result.rows[0]?.['QUERY PLAN'][0]?.Plan;
      if (root === undefined) throw new Error('EXPLAIN returned no plan');
      return { indexes: outerIndexes(root, table), sorted: hasSort(root), text: page.text };
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  // T-0124 I5: displayName is no longer a sort key; every contact key remains.
  const contactSorts: ContactSort[] = ['-createdAt', 'createdAt', 'updatedAt', '-updatedAt'];
  const accountSorts: AccountSort[] = ['name', '-updatedAt', 'createdAt'];
  const someId = '11111111-0000-4000-8000-0000000000ff';

  it('a one-programme session pages contacts from a programme-led index, first page and deep', async () => {
    for (const sort of contactSorts) {
      const key = sort.replace(/^-/, '');
      for (const cursor of [undefined, encodeListCursor({ sort, id: someId })]) {
        const plan = await planOf(USER_A_AGENT_2, 'contact', (tx) =>
          listContacts(tx, { limit: 25, sort, cursor }),
        );
        expect(plan.text, sort).toMatch(/programme_id = \$\d+::uuid/);
        expect(plan.text, sort).not.toMatch(/programme_id = ANY/);
        expect(plan.indexes, `${sort} ${cursor ? 'deep' : 'first'}`).toEqual([
          CONTACT_PROGRAMME_LED[key],
        ]);
        expect(plan.sorted, sort).toBe(false);
      }
    }
  });

  it('a one-programme session pages accounts from a programme-led index, first page and deep', async () => {
    for (const sort of accountSorts) {
      const key = sort.replace(/^-/, '');
      for (const cursor of [undefined, encodeListCursor({ sort, id: someId })]) {
        const plan = await planOf(USER_A_AGENT_2, 'account', (tx) =>
          listAccounts(tx, { limit: 25, sort, cursor }),
        );
        expect(plan.indexes, `${sort} ${cursor ? 'deep' : 'first'}`).toEqual([
          ACCOUNT_PROGRAMME_LED[key],
        ]);
        expect(plan.sorted, sort).toBe(false);
      }
    }
  });

  it('a two-programme session sends = ANY and pages from a tenant-led index', async () => {
    const plan = await planOf(USER_A_SUPERVISOR, 'contact', (tx) =>
      listContacts(tx, { limit: 25, sort: 'updatedAt' }),
    );
    expect(plan.text).toMatch(/programme_id = ANY\(\$\d+::uuid\[\]\)/);
    expect(plan.indexes).toEqual(['contact_tenant_updated_keyset_idx']);
    expect(plan.sorted).toBe(false);
  });
});
