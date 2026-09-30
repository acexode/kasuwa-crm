import {
  createPool,
  newId,
  withTenantTransaction,
  PROGRAMME_A2,
  TENANT_A,
  USER_A_AGENT_2,
} from '@kasuwa/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { listContacts } from './contact.repository';

/**
 * T-0019 — keyset pagination at microsecond resolution.
 *
 * The regression test for FINDING-2 (team/reports/T-0004.md): `created_at` is
 * `timestamptz`, `pg` truncates it into a millisecond `Date`, and a cursor
 * built from that `Date` named a position EARLIER than the row it came from, so
 * every row in between was skipped permanently. Six rows, paged one at a time,
 * returned four.
 *
 * EVERY TIMESTAMP BELOW IS SUB-MILLISECOND ON PURPOSE. The suite that missed
 * this bug seeded whole minutes, which round-trip through a `Date` unharmed —
 * readable fixtures hid a production defect. Do not tidy these into round
 * numbers.
 *
 * The walk is compared against a direct `count(*)` in the same scope rather
 * than against a hard-coded number, so the test says "pagination returns
 * everything the session can see" rather than "pagination returns six".
 */
describe('listContacts keyset pagination', () => {
  // Typed off `createPool` so this package needs no direct dependency on `pg`.
  let pool: ReturnType<typeof createPool>;

  beforeAll(() => {
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
  });

  afterAll(async () => {
    await pool.end();
  });

  const session = { tenantId: TENANT_A, userId: USER_A_AGENT_2 };

  /** Page to exhaustion at `limit`, the way a client would. */
  async function walk(limit: number): Promise<string[]> {
    return withTenantTransaction(pool, session, async (tx) => {
      const collected: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const result = await listContacts(tx, { limit, cursor });
        for (const contact of result.data) {
          collected.push(contact.id);
        }
        if (result.nextCursor === null) {
          return collected;
        }
        cursor = result.nextCursor;
      }
      throw new Error('pagination did not terminate');
    });
  }

  async function visibleCount(): Promise<number> {
    return withTenantTransaction(pool, session, async (tx) => {
      const rows = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM contact');
      return Number(rows[0]?.n);
    });
  }

  /**
   * Three instants inside a single millisecond, plus one a microsecond away
   * from a second boundary. `now()` produces values like these constantly; a
   * bulk import produces nothing else.
   */
  const microsecondTimes = [
    '2026-04-01T12:00:00.000900Z',
    '2026-04-01T12:00:00.000500Z',
    '2026-04-01T12:00:00.000100Z',
    '2026-04-01T12:00:00.999999Z',
  ];
  const ids = microsecondTimes.map(() => newId());

  beforeAll(async () => {
    await withTenantTransaction(pool, session, async (tx) => {
      for (const [index, at] of microsecondTimes.entries()) {
        await tx.query(
          `INSERT INTO contact (id, tenant_id, programme_id, display_name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)`,
          [ids[index], TENANT_A, PROGRAMME_A2, `T-0019 micro ${index}`, at],
        );
      }
    });
  });

  afterAll(async () => {
    await withTenantTransaction(pool, session, async (tx) => {
      await tx.query('DELETE FROM contact WHERE id = ANY($1::uuid[])', [ids]);
    });
  });

  it('stored the fixtures with their microseconds intact', async () => {
    // A control. If Postgres or the insert path had rounded these to the
    // millisecond, the walk below would pass for the wrong reason.
    const stored = await withTenantTransaction(pool, session, async (tx) =>
      tx.query<{ at: string }>(
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
           FROM contact WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC`,
        [ids],
      ),
    );
    expect(stored.map((row) => row.at)).toEqual([...microsecondTimes].sort().reverse());
  });

  it('returns every row when paging one at a time through sub-millisecond rows', async () => {
    const seen = await walk(1);
    expect(new Set(seen).size, 'a row was returned twice').toBe(seen.length);
    expect(seen).toHaveLength(await visibleCount());
    for (const id of ids) {
      expect(seen, 'a sub-millisecond row was skipped').toContain(id);
    }
  });

  it('returns every row at other page sizes, and in one page', async () => {
    const total = await visibleCount();
    for (const limit of [2, 3, 100]) {
      const seen = await walk(limit);
      expect(new Set(seen).size, `duplicates at limit ${limit}`).toBe(seen.length);
      expect(seen, `rows dropped at limit ${limit}`).toHaveLength(total);
    }
  });

  it('orders strictly by (created_at, id) descending across the page boundary', async () => {
    // The ordering the cursor predicate depends on. If the cursor lost
    // precision the sequence would still be sorted — it would just be short —
    // so this is asserted alongside the completeness check, not instead of it.
    const seen = await walk(1);
    const microIndexes = ids.map((id) => seen.indexOf(id));
    expect(microIndexes.every((index) => index >= 0)).toBe(true);
    // .999999 is the newest, then .000900, .000500, .000100 — all four are
    // newer than every seeded row, which sits in 2026-01.
    expect([microIndexes[3], microIndexes[0], microIndexes[1], microIndexes[2]]).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('a cursor issued before this fix still pages, without erroring', async () => {
    // Millisecond cursors are accepted rather than rejected so that a deploy
    // does not 400 every in-flight paging session. Such a cursor points at the
    // truncated instant it always did; it is no worse than it was, and the next
    // cursor it yields is precise.
    const legacy = Buffer.from(
      JSON.stringify({ c: '2026-04-01T12:00:01.000Z', i: ids[0] }),
      'utf8',
    ).toString('base64url');

    const page = await withTenantTransaction(pool, session, async (tx) =>
      listContacts(tx, { limit: 10, cursor: legacy }),
    );
    expect(page.data.map((row) => row.id)).toEqual(expect.arrayContaining(ids));
  });
});
