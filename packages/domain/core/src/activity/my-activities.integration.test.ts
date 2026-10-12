import {
  createPool,
  PROGRAMME_A1,
  SEED_CONTACTS,
  TENANT_A,
  USER_A_AGENT_1,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { insertActivity } from './activity.repository';
import { listMyCalendar, listMyOpenTasks, timeZoneNameExists } from './my-activities.repository';

/**
 * T-0082 (review finding 4): the planner really uses 0034's partial indexes
 * for listMyActivities and listCalendar, as kasuwa_app, under
 * activity_isolation, and the open-task cursor SEEKS (a row comparison in the
 * index condition) rather than rescanning the bucket from its start.
 *
 * The repository's own statements are EXPLAINed: a TenantTx wrapper turns the
 * list statement (the one that starts with WITH) into `EXPLAIN (FORMAT JSON)`
 * and passes every other statement (the cursor's check) through. Sequential
 * scans are switched off for the transaction, because on a seed-sized table
 * a sequential scan is cheaper and would hide whether the index is usable at
 * all; what is asserted is that the index CAN serve the statement with RLS on,
 * which is exactly what a non-LEAKPROOF predicate would prevent. Everything
 * runs in a transaction that is rolled back. Invented text only.
 */

class Rollback extends Error {}

const AMAKA = SEED_CONTACTS.find((contact) => contact.givenNames === 'Amaka');
const HOUR = 60 * 60 * 1000;
const W = Date.UTC(2031, 2, 3);

interface PlanNode {
  'Node Type'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
}

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

describe('my activities: the planner uses 0034’s indexes under RLS (T-0082)', () => {
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Runs `work` as agent 1 in A1, seq scans off, rolls back; returns the plans. */
  async function explained(work: (tx: TenantTx) => Promise<void>): Promise<PlanNode[][]> {
    const plans: PlanNode[][] = [];
    await expect(
      withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
        const role = await tx.query<{ role: string }>('SELECT current_user AS role');
        expect(role[0]?.role, 'the test must run as the serving role').toBe('kasuwa_app');
        if (AMAKA === undefined) throw new Error('Fixture drift: no seeded contact Amaka');
        for (let index = 0; index < 6; index += 1) {
          await insertActivity(tx, PROGRAMME_A1, {
            type: 'task',
            subject: 'Invented task',
            body: null,
            dueAt: new Date(W + index * HOUR).toISOString(),
            startsAt: null,
            endsAt: null,
            ownerUserId: USER_A_AGENT_1,
            contactId: AMAKA.id,
            accountId: null,
          });
          await insertActivity(tx, PROGRAMME_A1, {
            type: 'meeting',
            subject: 'Invented meeting',
            body: null,
            dueAt: null,
            startsAt: new Date(W + index * HOUR).toISOString(),
            endsAt: new Date(W + index * HOUR + HOUR / 2).toISOString(),
            ownerUserId: USER_A_AGENT_1,
            contactId: AMAKA.id,
            accountId: null,
          });
        }
        await tx.query('ANALYZE activity');
        await tx.query('SET LOCAL enable_seqscan = off');
        const explaining: TenantTx = {
          session: tx.session,
          async query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            if (!text.trimStart().startsWith('WITH')) return tx.query<T>(text, values);
            const rows = await tx.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
              `EXPLAIN (FORMAT JSON) ${text}`,
              values,
            );
            const plan = rows[0]?.['QUERY PLAN'][0]?.Plan;
            if (plan === undefined) throw new Error('EXPLAIN returned no plan');
            plans.push(nodes(plan));
            return [] as T[];
          },
        };
        await work(explaining);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    return plans;
  }

  /** One line per plan node: type, index and its condition. */
  const summary = (plan: PlanNode[] | undefined) =>
    (plan ?? [])
      .map((node) =>
        [node['Node Type'], node['Index Name'], node['Index Cond']].filter(Boolean).join(' | '),
      )
      .join(' // ');

  const indexNames = (plan: PlanNode[]) =>
    plan.map((node) => node['Index Name']).filter((name) => name !== undefined);

  it('listMyActivities uses activity_owner_open_task_due_idx, and the cursor seeks in it', async () => {
    const plans = await explained(async (tx) => {
      const readable = [PROGRAMME_A1];
      await listMyOpenTasks(tx, {
        range: { from: new Date(W - HOUR), to: null, undated: true },
        dueReadableProgrammeIds: readable,
        cursorId: null,
        limit: 2,
      });
      const [first] = await tx.query<{ id: string }>(
        `SELECT id FROM activity WHERE owner_user_id = $1 AND type = 'task' AND due_at IS NOT NULL
          ORDER BY due_at, id LIMIT 1`,
        [USER_A_AGENT_1],
      );
      if (first === undefined) throw new Error('no planted task');
      await listMyOpenTasks(tx, {
        range: { from: new Date(W - HOUR), to: null, undated: true },
        dueReadableProgrammeIds: readable,
        cursorId: first.id,
        limit: 2,
      });
    });
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(indexNames(plan), summary(plan)).toContain('activity_owner_open_task_due_idx');
    }
    // The seek: the cursor's (due_at, id) is in the index condition.
    const seek = (plans[1] ?? []).filter(
      (node) =>
        node['Index Name'] === 'activity_owner_open_task_due_idx' &&
        /ROW\(.*due_at.*id\)\s*>/i.test(node['Index Cond'] ?? ''),
    );
    expect(seek.length, summary(plans[1])).toBeGreaterThan(0);
  });

  it('listCalendar uses activity_owner_meeting_starts_idx for meetings and activity_owner_due_idx for tasks', async () => {
    const plans = await explained(async (tx) => {
      await listMyCalendar(tx, {
        from: new Date(W),
        to: new Date(W + 24 * HOUR),
        dueReadableProgrammeIds: [PROGRAMME_A1],
        meetingReadableProgrammeIds: [PROGRAMME_A1],
        cursorId: null,
        limit: 3,
      });
    });
    expect(plans).toHaveLength(1);
    const names = indexNames(plans[0] ?? []);
    expect(names, summary(plans[0])).toContain('activity_owner_meeting_starts_idx');
    expect(names, summary(plans[0])).toContain('activity_owner_due_idx');
    // The meeting scan is bounded below by from - 24 h (0034's span CHECK).
    const meeting = (plans[0] ?? []).find(
      (node) => node['Index Name'] === 'activity_owner_meeting_starts_idx',
    );
    expect(meeting?.['Index Cond'] ?? '', summary(plans[0])).toMatch(
      /starts_at > .*starts_at < /s,
    );
  });

  it('a time zone name is exact: the server list has Asia/Kolkata, not Africa/LAGOS', async () => {
    await withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
      expect(await timeZoneNameExists(tx, 'Africa/Lagos')).toBe(true);
      expect(await timeZoneNameExists(tx, 'Asia/Kolkata')).toBe(true);
      expect(await timeZoneNameExists(tx, 'UTC')).toBe(true);
      expect(await timeZoneNameExists(tx, 'Africa/LAGOS')).toBe(false);
      expect(await timeZoneNameExists(tx, 'Asia/KOLKATA')).toBe(false);
      expect(await timeZoneNameExists(tx, 'WAT')).toBe(false);
    });
  });
});
