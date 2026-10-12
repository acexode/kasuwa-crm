import {
  createPool,
  PROGRAMME_A1,
  SEED_ACCOUNTS,
  TENANT_A,
  USER_A_SUPERVISOR,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { ZodError } from 'zod';
import { AdminError, toAdminError } from '../admin/common/admin-errors';
import { convertContactFor } from './contact-convert';

/**
 * T-0076 — convertContact against real Postgres: one transaction, the
 * conditional UPDATE, the race and the repeat. The acceptance suite pins the
 * HTTP contract; this pins the mechanics underneath it, deterministically.
 *
 * Writes either roll back (`Rollback`) or touch only the contact this file
 * plants, which `afterEach` removes, as kasuwa_migrator. Values are invented
 * (CLAUDE.md 6.1); the planted id carries `7600` (T-0076).
 */

class Rollback extends Error {}

const PLANTED = '11111111-0000-4000-8000-00007601c001';
const IKOYI = SEED_ACCOUNTS.find((account) => account.programmeId === PROGRAMME_A1);

/** The status the error filter answers: an AdminError's own, a ZodError's 400. */
function statusOf(error: unknown): number | null {
  if (error instanceof ZodError) return toAdminError(error).getStatus();
  return error instanceof AdminError ? error.getStatus() : null;
}

describe('convertContact mechanics (T-0076)', () => {
  let pool: ReturnType<typeof createPool>;
  let migrationUrl: string;

  async function asMigrator<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: migrationUrl });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  }

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
    migrationUrl = inject('migrationUrl');
  });

  afterAll(async () => {
    await pool.end();
  });

  async function plant(): Promise<void> {
    await asMigrator((client) =>
      client.query(
        `INSERT INTO contact (id, tenant_id, programme_id, display_name, status)
         VALUES ($1, $2, $3, 'T0076 Probe Lead', 'new')`,
        [PLANTED, TENANT_A, PROGRAMME_A1],
      ),
    );
  }

  afterEach(async () => {
    await asMigrator(async (client) => {
      const linked = await client.query<{ account_id: string | null }>(
        'SELECT account_id FROM contact WHERE id = $1',
        [PLANTED],
      );
      await client.query('DELETE FROM contact WHERE id = $1', [PLANTED]);
      // Never the seeded account: only one a committed convert here created.
      const accountId = linked.rows[0]?.account_id;
      if (accountId !== null && accountId !== undefined && accountId !== IKOYI?.id) {
        await client.query('DELETE FROM account WHERE id = $1', [accountId]);
      }
    });
  });

  async function inRollback<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    let result: { value: T } | undefined;
    await expect(
      withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_SUPERVISOR }, async (tx) => {
        result = { value: await work(tx) };
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    if (result === undefined) throw new Error('the work did not finish');
    return result.value;
  }

  const versionOf = async (): Promise<number> =>
    asMigrator(async (client) => {
      const rows = await client.query<{ version: number }>(
        'SELECT version FROM contact WHERE id = $1',
        [PLANTED],
      );
      const version = rows.rows[0]?.version;
      if (version === undefined) throw new Error('the planted contact is gone');
      return version;
    });

  const accountsNamed = async (name: string): Promise<number> =>
    asMigrator(async (client) => {
      const rows = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM account WHERE name = $1',
        [name],
      );
      return rows.rows[0]?.n ?? -1;
    });

  /**
   * Holds the planted contact's row lock in a migrator transaction, starts a
   * convert, waits until that convert is blocked on the lock (so it has read
   * the row and, for `newAccount`, inserted its account), then commits a
   * concurrent edit that moves `version`. The convert's conditional UPDATE
   * then matches nothing.
   */
  async function convertAgainstConcurrentEdit(body: Record<string, unknown>): Promise<unknown> {
    const holder = new Client({ connectionString: migrationUrl });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM contact WHERE id = $1 FOR UPDATE', [PLANTED]);
      const outcome = withTenantTransaction(
        pool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        (tx) => convertContactFor(tx, PLANTED, body),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      // Wait for the convert's UPDATE to queue behind the held row lock.
      for (let attempt = 0; ; attempt += 1) {
        const waiting = await asMigrator((client) =>
          client.query<{ n: number }>(
            // pg_locks, not pg_stat_activity: another role's query text is
            // hidden from the migrator. A row-lock wait is an ungranted lock
            // on the holder's transaction id (or the tuple).
            `SELECT count(*)::int AS n FROM pg_locks
              WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`,
          ),
        );
        if ((waiting.rows[0]?.n ?? 0) > 0) break;
        if (attempt > 200) throw new Error('the convert never blocked on the row lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // The trigger bumps version, as any other writer's save would.
      await holder.query(`UPDATE contact SET lga = 'Ikeja' WHERE id = $1`, [PLANTED]);
      await holder.query('COMMIT');
      return await outcome;
    } finally {
      await holder.end();
    }
  }

  it('an exact repeat in place answers the same, writes nothing, whatever version it carries', async () => {
    await plant();
    const version = await versionOf();
    await inRollback(async (tx) => {
      const first = await convertContactFor(tx, PLANTED, {
        version,
        newAccount: { name: 'T0076 Probe Grains' },
      });
      expect(first.contact.status).toBe('qualified');
      expect(first.contact.version).toBe(version + 1);
      for (const repeatVersion of [version, version + 1, version + 7]) {
        const repeat = await convertContactFor(tx, PLANTED, {
          version: repeatVersion,
          newAccount: { name: 'T0076 Probe Grains' },
        });
        expect(repeat).toEqual(first);
      }
      const accounts = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM account WHERE tenant_id = $1 AND name = $2`,
        [TENANT_A, 'T0076 Probe Grains'],
      );
      expect(accounts[0]?.n, 'a repeat created a second account').toBe(1);
      const events = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE tenant_id = $1 AND object_type = 'contact' AND object_id = $2`,
        [TENANT_A, PLANTED],
      );
      expect(events[0]?.n, 'one event for one convert, none per repeat').toBe(1);
      // T-0104: the created account's own event, in this transaction, names only.
      const accountEvents = await tx.query<{ action: string; changes: unknown; label: string }>(
        `SELECT action, changes, object_label AS label FROM audit_event
          WHERE tenant_id = $1 AND object_type = 'account' AND object_id = $2`,
        [TENANT_A, first.account.id],
      );
      expect(accountEvents, 'one account event for the created account, none per repeat').toEqual([
        {
          action: 'created',
          label: first.account.id,
          changes: [{ field: 'name', before: null, after: null, redacted: true }],
        },
      ]);
    });
  });

  it('the status and the link are ONE update: version moves once, for a lead and for a customer', async () => {
    await plant();
    const version = await versionOf();
    await inRollback(async (tx) => {
      if (IKOYI === undefined) throw new Error('fixture drift: no seeded A1 account');
      const converted = await convertContactFor(tx, PLANTED, { version, accountId: IKOYI.id });
      expect(converted.contact).toMatchObject({
        status: 'qualified',
        accountId: IKOYI.id,
        version: version + 1,
      });
    });
    await asMigrator((client) =>
      client.query(`UPDATE contact SET status = 'customer' WHERE id = $1`, [PLANTED]),
    );
    const customerVersion = await versionOf();
    await inRollback(async (tx) => {
      if (IKOYI === undefined) throw new Error('fixture drift: no seeded A1 account');
      const converted = await convertContactFor(tx, PLANTED, {
        version: customerVersion,
        accountId: IKOYI.id,
      });
      expect(converted.contact).toMatchObject({
        status: 'customer',
        version: customerVersion + 1,
      });
    });
  });

  it('losing the race after inserting its account is 409, and the account rolls back with it', async () => {
    await plant();
    const version = await versionOf();
    const name = 'T0076 Probe Race Loser';
    const error = await convertAgainstConcurrentEdit({ version, newAccount: { name } });
    expect(statusOf(error), String(error)).toBe(409);
    expect(await accountsNamed(name), 'a refused convert left its account behind').toBe(0);
    expect(await versionOf(), 'only the concurrent edit moved the version').toBe(version + 1);
  });

  it('losing the race on a link is 409 too, and nothing of the convert is written', async () => {
    await plant();
    const version = await versionOf();
    if (IKOYI === undefined) throw new Error('fixture drift: no seeded A1 account');
    const error = await convertAgainstConcurrentEdit({ version, accountId: IKOYI.id });
    expect(statusOf(error), String(error)).toBe(409);
    const row = await asMigrator((client) =>
      client.query<{ status: string | null; account_id: string | null }>(
        'SELECT status, account_id FROM contact WHERE id = $1',
        [PLANTED],
      ),
    );
    expect(row.rows[0]).toEqual({ status: 'new', account_id: null });
  });

  it('maps every refusal to its status before anything is written', async () => {
    await plant();
    const version = await versionOf();
    const outcomes = await inRollback(async (tx) => {
      const attempt = async (body: unknown, id = PLANTED) => {
        try {
          await convertContactFor(tx, id, body);
          return 200;
        } catch (error) {
          return statusOf(error);
        }
      };
      return {
        missingContact: await attempt(
          { version, accountId: IKOYI?.id },
          '11111111-0000-4000-8000-00007601ffff',
        ),
        bothTargets: await attempt({ version, accountId: IKOYI?.id, newAccount: { name: 'X' } }),
        neither: await attempt({ version }),
        hugeVersion: await attempt({ version: 2 ** 31, accountId: IKOYI?.id }),
        nulInName: await attempt({ version, newAccount: { name: 'Bad\u0000 Co' } }),
        missingAccount: await attempt({
          version,
          accountId: '11111111-0000-4000-8000-00007601fffe',
        }),
        stale: await attempt({ version: version + 3, newAccount: { name: 'Stale Co' } }),
        array: await attempt([]),
      };
    });
    expect(outcomes).toEqual({
      missingContact: 404,
      bothTargets: 400,
      neither: 400,
      hugeVersion: 400,
      nulInName: 400,
      missingAccount: 404,
      stale: 409,
      array: 400,
    });
    expect(await versionOf()).toBe(version);
  });
});
