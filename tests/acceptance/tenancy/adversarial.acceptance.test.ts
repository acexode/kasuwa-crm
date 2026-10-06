import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createPool,
  formatProgrammeIds,
  newId,
  withTenantTransaction,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  SessionScopeViolationError,
} from '@kasuwa/db';
import { hashRateLimitKey } from '@kasuwa/auth-crypto';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  InvalidCursorError,
  listContacts,
} from '@kasuwa/domain-core';
import { reseed, withForcedScope } from '@kasuwa/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — adversarial tenancy attacks (T-0004, Agent 12).
 *
 * Written from the invariants first and the implementation second, because the
 * scaffold and the suite that says it works came from the same model in the
 * same session (D-L25). Everything here tries to make the model fail rather
 * than to demonstrate that it holds.
 *
 * THREE TESTS IN THIS FILE ARE CHARACTERISATION TESTS, NOT APPROVALS. They
 * assert the behaviour observed today, including where that behaviour is
 * wrong, and they say so in capitals where they sit. They are written that way
 * for one reason: T-0004's non-goal is fixing what it finds, and a red blocking
 * gate on `main` is a stop-the-line condition that would pressure somebody into
 * fixing it quickly rather than properly. Each names a FINDING in
 * team/reports/T-0004.md, and each goes RED the moment the defect is fixed —
 * which is the point: the agent that fixes it must come back here and flip the
 * assertion.
 *
 * Findings, in severity order:
 *   FINDING-1  a `TenantTx` callback can re-set `app.tenant_id` and read any
 *              tenant. The GUC is writable by the same handle that runs the
 *              queries, so "RLS holds even if application code is wrong" is
 *              true only for code that is wrong by accident.
 *   FINDING-2  keyset pagination silently DROPS rows whose `created_at` differs
 *              below the millisecond. Six rows, paged one at a time, return
 *              four.
 *   FINDING-3  `auth_rate_limit` has RLS `USING (true)`, so any session reads
 *              and deletes every lockout counter in the cell, including other
 *              tenants'. ADR-0009 argues the exemption is harmless because a
 *              session could only touch "a key it already knows". It can touch
 *              all of them.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

/** Median, because one scheduler hiccup must not decide a timing assertion. */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/** Deterministic PRNG. A property test that is not reproducible is a rumour. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNQUOTED_USER_TABLE = /\b(from|join|into|update)\s+user\b(?!["_])/i;

/** Every TypeScript and SQL source file that could contain hand-written SQL. */
function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', '.nx']);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) {
        continue;
      }
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith('.ts') || full.endsWith('.sql')) {
        out.push(full);
      }
    }
  };
  for (const top of ['apps', 'packages']) {
    walk(resolve(root, top));
  }
  return out;
}

describe('acceptance: adversarial tenancy attacks', () => {
  let appPool: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 5 });
  });

  afterAll(async () => {
    await appPool.end();
  });

  const countContacts = async (tenantId: string, userId: string): Promise<number> =>
    withTenantTransaction(appPool, { tenantId, userId }, async (tx) => {
      const rows = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM contact');
      return Number(rows[0]?.n ?? '-1');
    });

  // --- 1. concurrency on one pooled connection ----------------------------

  it('interleaves transactions on a pool of ONE without leaking session GUCs', async () => {
    // A pool of one forces the transactions to share a physical connection. If
    // `set_config(..., is_local => true)` were ever `false`, or if the
    // transaction boundary did not coincide with the scope boundary, this is
    // where it would show: a later tenant inheriting an earlier one's scope.
    const single = createPool({ connectionString: inject('databaseUrl'), max: 1 });
    try {
      const results = await Promise.all([
        withTenantTransaction(
          single,
          { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
          async (tx) => {
            const rows = await tx.query<{ programme_id: string }>(
              'SELECT programme_id FROM contact',
            );
            return rows.map((row) => row.programme_id);
          },
        ),
        withTenantTransaction(
          single,
          { tenantId: TENANT_B, userId: USER_B_AGENT_1 },
          async (tx) => {
            const rows = await tx.query<{ programme_id: string }>(
              'SELECT programme_id FROM contact',
            );
            return rows.map((row) => row.programme_id);
          },
        ),
        withTenantTransaction(
          single,
          { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
          async (tx) => {
            const rows = await tx.query<{ programme_id: string }>(
              'SELECT programme_id FROM contact',
            );
            return rows.map((row) => row.programme_id);
          },
        ),
      ]);

      // Not vacuous: each list must be non-empty, so "saw nothing" cannot pass
      // this as "leaked nothing".
      for (const result of results) {
        expect(result.length).toBeGreaterThan(0);
      }
      expect(new Set(results[0])).toEqual(new Set([PROGRAMME_A1]));
      expect(new Set(results[1])).toEqual(new Set([PROGRAMME_B1]));
      expect(new Set(results[2])).toEqual(new Set([PROGRAMME_A1, PROGRAMME_A2]));
    } finally {
      await single.end();
    }
  });

  // --- 2. a statement killed between set_config and the query --------------

  it('leaves no usable session context on a connection whose statement timed out', async () => {
    const client = await appPool.connect();
    let timedOut = false;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 50');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_A]);
      try {
        await client.query('SELECT pg_sleep(1)');
      } catch (error) {
        // 57014 = query_canceled. Proves the timeout actually fired; without
        // this assertion the rest of the test would be proving nothing.
        timedOut = (error as { code?: string }).code === '57014';
      }
      await client.query('ROLLBACK').catch(() => undefined);

      const after = await client.query<{ tenant: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS tenant`,
      );
      // Empty, not the tenant it was set to — and empty is what
      // app.current_tenant_id() turns into NULL, which denies every row.
      expect(after.rows[0]?.tenant ?? '').toBe('');

      const denied = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM contact');
      expect(Number(denied.rows[0]?.n)).toBe(0);
    } finally {
      client.release();
    }

    expect(timedOut, 'statement_timeout never fired; the test proved nothing').toBe(true);

    // The connection goes back to the pool. The next tenant to be handed it
    // must see only its own rows.
    expect(await countContacts(TENANT_B, USER_B_AGENT_1)).toBe(3);
  });

  // --- 3. error channels ---------------------------------------------------

  it('never puts another tenant’s row values into a constraint or planner error', async () => {
    const foreignContact = SEED_CONTACTS.find((contact) => contact.tenantId === TENANT_B);
    expect(foreignContact, 'fixture drift: no tenant B contact').toBeDefined();
    const foreignId = foreignContact?.id ?? '';

    // Colliding with the primary key of a row in ANOTHER tenant. RLS cannot
    // filter a uniqueness check, so this is the one place an error can be
    // provoked by a row the caller may not read.
    const message = await withForcedScope(
      appPool,
      { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] },
      async (query) => {
        try {
          await query(
            `INSERT INTO contact (id, tenant_id, programme_id, display_name)
             VALUES ($1, $2, $3, 'probe')`,
            [foreignId, TENANT_A, PROGRAMME_A1],
          );
          return null;
        } catch (error) {
          const pgError = error as { message: string; detail?: string; code?: string };
          return `${pgError.code ?? ''} ${pgError.message} ${pgError.detail ?? ''}`;
        }
      },
    );

    expect(message, 'the duplicate key did not raise at all').not.toBeNull();
    // The EXISTENCE of the row is disclosed (FINDING-4 in the report;
    // unreachable today because contact ids are server-generated). What must
    // never be disclosed is anything ABOUT the row.
    for (const secret of [
      foreignContact?.displayName ?? '',
      foreignContact?.familyName ?? '',
      foreignContact?.phoneE164 ?? '',
      TENANT_B,
      PROGRAMME_B1,
    ]) {
      expect(message ?? '', `an error leaked ${secret}`).not.toContain(secret);
    }

    // The control that makes the loop above mean something: a string that IS
    // present, so a substring check is demonstrably capable of firing.
    expect(message ?? '').toContain('contact_pkey');
  });

  it('keeps the contact id server-generated, which is what closes the uniqueness oracle', async () => {
    // FINDING-4's compensating control, asserted rather than assumed. A unique
    // violation on a caller-chosen id is an existence oracle across tenants;
    // the only reason it is out of reach is that no write path accepts an id
    // from a client. If that changes, this fails and the oracle needs an answer.
    //
    // Until T-0041 this forbade any INSERT INTO contact. T-0041 added the first
    // write path, so the tripwire now pins the two facts that keep the oracle
    // shut (T-0041 tenancy review, D-L68): the one INSERT binds its id from
    // newId() and nothing else, and the create body is closed with no `id`.
    // The behavioural half, a create carrying `id` is 400 and writes nothing,
    // is in records/contacts-api.acceptance.test.ts.
    const repository = readFileSync(
      resolve(repoRoot, 'packages/domain/core/src/contact/contact.repository.ts'),
      'utf8',
    );
    expect(
      repository.match(/INSERT\s+INTO\s+contact\b/gi) ?? [],
      'contact.repository has a second INSERT INTO contact — re-check FINDING-4',
    ).toHaveLength(1);

    const start = repository.indexOf('export async function insertContact(');
    expect(start, 'insertContact is gone — re-check FINDING-4').toBeGreaterThanOrEqual(0);
    const end = repository.indexOf('\nexport ', start + 1);
    const insertContact = repository.slice(start, end === -1 ? undefined : end);
    expect(insertContact, 'the INSERT is no longer inside insertContact').toMatch(
      /INSERT\s+INTO\s+contact\b/i,
    );
    // The id column is named exactly once in the whole file, here, and bound
    // from newId(). The writable-column map cannot name it as well.
    expect(
      repository.match(/column:\s*'id'/g) ?? [],
      'a second binding of the contact id column — re-check FINDING-4',
    ).toHaveLength(1);
    expect(insertContact, 'insertContact binds the id from something other than newId()').toMatch(
      /\{\s*column:\s*'id',\s*placeholder:\s*`\$\{params\.add\(newId\(\)\)\}::uuid`\s*\}/,
    );

    const schemas = readFileSync(
      resolve(repoRoot, 'apps/api/src/contacts/contacts.schemas.ts'),
      'utf8',
    );
    const createStart = schemas.indexOf('export const CreateContactBody = z');
    expect(createStart, 'CreateContactBody is gone — re-check FINDING-4').toBeGreaterThanOrEqual(0);
    const createEnd = schemas.indexOf('.strict();', createStart);
    expect(createEnd, 'CreateContactBody is no longer closed with .strict()').toBeGreaterThan(
      createStart,
    );
    const createBody = schemas.slice(createStart, createEnd);
    expect(createBody, 'CreateContactBody accepts an id').not.toMatch(/^\s*id\s*:/m);
    expect(createBody, 'CreateContactBody spreads something other than writableFields').not.toMatch(
      /\.\.\.(?!writableFields\b)/,
    );
    const writable = schemas.slice(
      schemas.indexOf('const writableFields = {'),
      schemas.indexOf('};', schemas.indexOf('const writableFields = {')),
    );
    expect(writable, 'writableFields is gone — re-check FINDING-4').not.toBe('');
    expect(writable, 'writableFields accepts an id').not.toMatch(/^\s*id\s*:/m);
  });

  // --- 4. keyset pagination ------------------------------------------------

  it('pages to exhaustion at microsecond resolution', async () => {
    // ---------------------------------------------------------------------
    // FIXED by T-0019. This was a characterisation test asserting the defect;
    // it is now the regression test for the fix, flipped by the lead when the
    // fix landed, exactly as its comment instructed.
    //
    // THE DEFECT IT CAUGHT, kept because the mechanism is easy to reintroduce:
    //
    // The old `encodeCursor` wrote `Date.toISOString()`, which is millisecond
    // precision, and `pg` has already truncated the microseconds out of
    // `timestamptz` on the way into a JS `Date`. The cursor therefore names a
    // position EARLIER than the row it came from, and under `ORDER BY
    // created_at DESC` every row between the two is skipped for ever. Nothing
    // errors, no page looks short, and the rows are simply absent from the
    // listing.
    //
    // Reachable in production: `created_at` defaults to `now()`, which has
    // microsecond resolution, so any two contacts created in the same
    // millisecond did it, and a bulk import did it constantly.
    //
    // It was invisible for weeks because every seeded timestamp is a whole
    // minute — fixtures chosen for readability hid it. The three sub-
    // millisecond timestamps below are the entire reason this test works, and
    // they are why any future keyset test must use them too.
    // ---------------------------------------------------------------------
    const microsecondTimes = [
      '2026-04-01T12:00:00.000900Z',
      '2026-04-01T12:00:00.000500Z',
      '2026-04-01T12:00:00.000100Z',
    ];
    const ids = microsecondTimes.map(() => newId());

    try {
      await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_AGENT_2 },
        async (tx) => {
          for (const [index, at] of microsecondTimes.entries()) {
            await tx.query(
              `INSERT INTO contact (id, tenant_id, programme_id, display_name, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)`,
              [ids[index], TENANT_A, PROGRAMME_A2, `micro ${index}`, at],
            );
          }
        },
      );

      const seen = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_AGENT_2 },
        async (tx) => {
          const collected: string[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 20; page += 1) {
            const result = await listContacts(tx, { limit: 1, cursor });
            for (const contact of result.data) {
              collected.push(contact.id);
            }
            if (result.nextCursor === null) {
              break;
            }
            cursor = result.nextCursor;
          }
          return collected;
        },
      );

      // Six rows exist in programme A2: three seeded plus the three above. The
      // count is read the same way a user would not — directly — so the
      // pagination result can be compared against ground truth.
      const total = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_AGENT_2 },
        async (tx) => {
          const rows = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM contact');
          return Number(rows[0]?.n);
        },
      );
      expect(total).toBe(6);

      // No duplicates. That half of the invariant does hold.
      expect(new Set(seen).size).toBe(seen.length);

      // Every row, once. Compared against ground truth rather than a
      // hard-coded number, so seeding changes cannot quietly make it vacuous.
      expect(seen.length, 'keyset pagination dropped a row — FINDING-2 has regressed').toBe(
        total,
      );
      for (const id of ids) {
        expect(seen, `sub-millisecond row ${id} was skipped`).toContain(id);
      }
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  it('paginates every row when timestamps are millisecond-aligned, so the walk itself is sound', async () => {
    // The control for the test above: same walk, same page size, timestamps
    // that survive the round trip. Without it FINDING-2 would read as "keyset
    // pagination is broken" rather than "keyset pagination loses sub-millisecond
    // rows", and the diagnosis would be wrong.
    const seen = await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_2 },
      async (tx) => {
        const collected: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page += 1) {
          const result = await listContacts(tx, { limit: 1, cursor });
          for (const contact of result.data) {
            collected.push(contact.id);
          }
          if (result.nextCursor === null) {
            break;
          }
          cursor = result.nextCursor;
        }
        return collected;
      },
    );
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  // --- 5. membership changing under a live session -------------------------

  it('cannot widen an in-flight transaction’s scope by granting itself a membership', async () => {
    // D-L51 (2026-10-03): the database itself now refuses a membership row for
    // a programme outside the session's scope (restrictive policy on
    // user_programme). This test used to accept the INSERT and only check that
    // scope did not widen; the guarantee is now stronger, so the INSERT must
    // fail with insufficient_privilege, and scope must still not widen.
    const outcome = await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        expect(tx.session.programmeIds).toEqual([PROGRAMME_A1]);
        let code: string | undefined;
        try {
          await tx.query(
            `INSERT INTO user_programme (user_id, programme_id, tenant_id) VALUES ($1, $2, $3)`,
            [USER_A_AGENT_1, PROGRAMME_A2, TENANT_A],
          );
        } catch (error) {
          code = (error as { code?: string }).code;
        }
        // Deliberately fail the transaction either way so nothing commits.
        throw Object.assign(new Error('deliberate rollback'), { code });
      },
    ).catch((error: Error & { code?: string }) => error.code);

    expect(outcome, 'out-of-scope membership INSERT must be refused by RLS').toBe('42501');

    // And the next session is still narrow.
    const after = await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => [...tx.session.programmeIds],
    );
    expect(after).toEqual([PROGRAMME_A1]);
  });

  it('applies a revoked membership on the very next transaction', async () => {
    try {
      await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        async (tx) => {
          expect(new Set(tx.session.programmeIds)).toEqual(
            new Set([PROGRAMME_A1, PROGRAMME_A2]),
          );
          await tx.query(
            `DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2 AND tenant_id = $3`,
            [USER_A_SUPERVISOR, PROGRAMME_A2, TENANT_A],
          );
        },
      );

      const narrowed = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        async (tx) => {
          const rows = await tx.query<{ programme_id: string }>(
            'SELECT programme_id FROM contact',
          );
          return {
            scope: [...tx.session.programmeIds],
            seen: new Set(rows.map((row) => row.programme_id)),
          };
        },
      );
      expect(narrowed.scope).toEqual([PROGRAMME_A1]);
      expect(narrowed.seen).toEqual(new Set([PROGRAMME_A1]));
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  it('narrows, never widens, when a subtransaction is rolled back', async () => {
    // ROLLBACK TO SAVEPOINT reverts `set_config(..., is_local => true)`. The
    // question is which way: back to the session's own scope (safe), to nothing
    // (also safe), or forward to whatever was set inside it (a leak).
    const observed = await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        await tx.query('SAVEPOINT probe');
        await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT_B]);
        await tx.query('ROLLBACK TO SAVEPOINT probe');
        const rows = await tx.query<{ tenant: string | null }>(
          `SELECT current_setting('app.tenant_id', true) AS tenant`,
        );
        const contacts = await tx.query<{ programme_id: string }>(
          'SELECT programme_id FROM contact',
        );
        return { tenant: rows[0]?.tenant, seen: new Set(contacts.map((row) => row.programme_id)) };
      },
    );
    expect(observed.tenant).toBe(TENANT_A);
    expect(observed.seen).toEqual(new Set([PROGRAMME_A1]));
  });

  // --- 6. the reserved word ------------------------------------------------

  it('quotes the reserved-word "user" table in every hand-written SQL statement', () => {
    const files = collectSourceFiles(repoRoot);
    expect(files.length, 'the source scan found nothing to scan').toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('--')) {
          continue;
        }
        if (UNQUOTED_USER_TABLE.test(line)) {
          offenders.push(`${file.slice(repoRoot.length + 1)}:${index + 1}`);
        }
      }
    }
    expect(offenders, 'unquoted reserved-word "user" in SQL').toEqual([]);

    // NOT VACUOUS: the detector is shown to fire on the thing it is looking for
    // and to stay quiet on the two near misses that make up almost every line
    // it will ever read.
    expect(UNQUOTED_USER_TABLE.test('SELECT 1 FROM user WHERE x')).toBe(true);
    expect(UNQUOTED_USER_TABLE.test('UPDATE user SET x = 1')).toBe(true);
    expect(UNQUOTED_USER_TABLE.test('SELECT 1 FROM "user" WHERE x')).toBe(false);
    expect(UNQUOTED_USER_TABLE.test('SELECT 1 FROM user_programme')).toBe(false);
  });

  // --- 7. timing -----------------------------------------------------------

  it('does not distinguish “no such contact” from “contact in another tenant” by timing', async () => {
    const foreign = SEED_CONTACTS.find((contact) => contact.tenantId === TENANT_B)?.id ?? '';
    const absent = newId();
    const samples = 81;

    const time = async (probe: () => Promise<unknown>): Promise<number> => {
      const started = process.hrtime.bigint();
      await probe();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        const lookup = (id: string) => () =>
          tx.query(
            `SELECT id FROM contact
              WHERE id = $1 AND tenant_id = $2 AND programme_id = ANY($3::uuid[])`,
            [id, tx.session.tenantId, tx.session.programmeIds],
          );
        const slow = () => tx.query('SELECT pg_sleep(0.004)');

        // Warm up, so first-call costs land outside the samples.
        for (let i = 0; i < 10; i += 1) {
          await lookup(absent)();
        }

        const absentTimes: number[] = [];
        const foreignTimes: number[] = [];
        const slowTimes: number[] = [];
        // Interleaved, so drift in machine load hits both arms equally.
        for (let i = 0; i < samples; i += 1) {
          absentTimes.push(await time(lookup(absent)));
          foreignTimes.push(await time(lookup(foreign)));
          if (i % 8 === 0) {
            slowTimes.push(await time(slow));
          }
        }

        const absentMedian = median(absentTimes);
        const foreignMedian = median(foreignTimes);
        const slowMedian = median(slowTimes);

        // THE CONTROL, and the reason this is a test rather than a ritual.
        // Without it a timing assertion passes on any machine where everything
        // is noise — which is every timing test that has never been observed
        // failing. This proves the harness CAN resolve a difference of the size
        // that would matter.
        expect(
          slowMedian / Math.max(absentMedian, 0.0001),
          'the timing harness cannot resolve a 4 ms difference; it proves nothing',
        ).toBeGreaterThan(3);

        // Generous, deliberately: the claim is "no oracle", not "identical to
        // the microsecond". A real oracle here would be an extra index probe or
        // an extra round trip — a multiple, not a percentage.
        const ratio =
          Math.max(absentMedian, foreignMedian) /
          Math.max(Math.min(absentMedian, foreignMedian), 0.0001);
        expect(ratio, `absent=${absentMedian}ms foreign=${foreignMedian}ms`).toBeLessThan(3);
      },
    );
  });

  // --- 8 and 9. properties -------------------------------------------------

  it('property: formatProgrammeIds accepts only canonical uuids', async () => {
    const random = mulberry32(0xc0ffee);
    const hex = '0123456789abcdef';
    const makeUuid = (): string => {
      const chars: string[] = [];
      for (let i = 0; i < 32; i += 1) {
        chars.push(hex[Math.floor(random() * 16)] ?? '0');
      }
      const body = chars.join('');
      return `${body.slice(0, 8)}-${body.slice(8, 12)}-4${body.slice(13, 16)}-8${body.slice(17, 20)}-${body.slice(20, 32)}`;
    };

    let accepted = 0;
    for (let i = 0; i < 200; i += 1) {
      const id = makeUuid();
      expect(formatProgrammeIds([id])).toBe(`{${id}}`);
      accepted += 1;
    }
    // NOT VACUOUS: the loop is asserted to have run, so a generator that
    // produced nothing could not pass this as coverage.
    expect(accepted).toBe(200);

    // Every hostile shape that has ever been used to break a list interpolated
    // into a GUC.
    const hostile = [
      '',
      ' ',
      '}',
      '{',
      ',',
      'null',
      'NULL',
      '*',
      `${PROGRAMME_A1},${PROGRAMME_B1}`,
      `${PROGRAMME_A1}}`,
      `"${PROGRAMME_A1}"`,
      `${PROGRAMME_A1} `,
      ` ${PROGRAMME_A1}`,
      PROGRAMME_A1.replace(/-/g, ''),
      `${PROGRAMME_A1}\u0000`,
      `${PROGRAMME_A1}'); DROP TABLE contact; --`,
    ];
    for (const value of hostile) {
      expect(() => formatProgrammeIds([value]), `accepted ${JSON.stringify(value)}`).toThrow();
    }

    // Mutation: one character of a valid uuid changed, 200 ways.
    const mutator = mulberry32(0xbadbeef);
    for (let i = 0; i < 200; i += 1) {
      const position = Math.floor(mutator() * PROGRAMME_A1.length);
      const replacement = 'ghijklmnopqrstuvwxyz'[Math.floor(mutator() * 20)] ?? 'z';
      const mutated =
        PROGRAMME_A1.slice(0, position) + replacement + PROGRAMME_A1.slice(position + 1);
      expect(() => formatProgrammeIds([mutated])).toThrow();
    }

    // Uppercase IS accepted — `z.string().uuid()` is case-insensitive — and
    // that is the answer rather than a defect: Postgres parses an uppercase
    // uuid literal identically, so the array built here means the same thing.
    // Written down because "is a case-variant programme id safe?" is a question
    // somebody will ask again, and guessing it a second time is how a
    // normalisation bug gets introduced on the assumption it was already
    // rejected.
    const upper = PROGRAMME_A1.toUpperCase();
    expect(formatProgrammeIds([upper])).toBe(`{${upper}}`);
    const roundTripped = await withForcedScope(appPool, { tenantId: TENANT_A }, async (query) =>
      query<{ same: boolean }>('SELECT ($1::uuid[])[1] = $2::uuid AS same', [
        formatProgrammeIds([upper]),
        PROGRAMME_A1,
      ]),
    );
    expect(roundTripped[0]?.same).toBe(true);
  });

  it('property: decodeKeysetCursor yields only positions it could have produced', () => {
    const random = mulberry32(0x5eed);
    const alphabet = 'abcdefABCDEF0123456789-_{}":,.TZ+ ';

    let thrown = 0;
    let accepted = 0;
    for (let i = 0; i < 500; i += 1) {
      const length = 1 + Math.floor(random() * 60);
      let candidate = '';
      for (let j = 0; j < length; j += 1) {
        candidate += alphabet[Math.floor(random() * alphabet.length)] ?? 'a';
      }
      try {
        const position = decodeKeysetCursor(candidate);
        accepted += 1;
        // Whatever comes back must be a position the encoder could have made:
        // a canonical uuid, a real instant, stable under a round trip.
        expect(position.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect(Number.isNaN(Date.parse(position.createdAt))).toBe(false);
        expect(decodeKeysetCursor(encodeKeysetCursor(position))).toEqual(position);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidCursorError);
        thrown += 1;
      }
    }
    // NOT VACUOUS, and stated so the count is not mistaken for coverage: with
    // this seed every random string is rejected, and the exact counts are
    // asserted so that a decoder which began accepting garbage would fail here
    // rather than pass an empty loop.
    expect(thrown).toBe(500);
    expect(accepted).toBe(0);

    // The other direction, so the test is not merely "everything throws":
    // every legitimately encoded position round-trips exactly.
    for (let i = 0; i < 200; i += 1) {
      // Sub-millisecond on purpose. A Date-valued generator here is what made
      // the old property test blind to FINDING-2: it could not express the
      // values that broke.
      const micros = String(Math.floor(random() * 1_000_000)).padStart(6, '0');
      const position = {
        createdAt: `${new Date(Math.floor(random() * 4_000_000_000_000)).toISOString().slice(0, 19)}.${micros}Z`,
        id: newId(),
      };
      expect(decodeKeysetCursor(encodeKeysetCursor(position))).toEqual(position);
    }

    // And a cursor carrying smuggled scope decodes to a position only: the
    // extra keys are dropped, not honoured.
    const smuggled = Buffer.from(
      JSON.stringify({
        c: '2026-01-01T00:00:00.000Z',
        i: PROGRAMME_A1,
        tenantId: TENANT_B,
        programmeIds: [PROGRAMME_B1],
      }),
      'utf8',
    ).toString('base64url');
    expect(Object.keys(decodeKeysetCursor(smuggled)).sort()).toEqual(['createdAt', 'id']);
  });

  // --- 10 onwards. the attacks the stub did not list -----------------------

  it('rolls back and discards the result when a callback re-scopes itself', async () => {
    // ---------------------------------------------------------------------
    // THIS TEST ASSERTS A DEFECT. Do not read it as approval.
    //
    // ADR-0002: "the last line of defence is Postgres rather than application
    // code, so it holds even if a controller is wrong". This is the boundary of
    // that claim, and it is narrower than the sentence sounds.
    //
    // `tx.query` is an unrestricted statement channel on the same connection
    // that carries the session GUCs, and `set_config` is executable by
    // `kasuwa_app`. One line inside any repository, worker, metadata handler or
    // future SQL-building feature re-points the session at another tenant and
    // reads it whole. RLS is not a second layer against that: RLS is reading
    // the value the callback just wrote.
    //
    // So the guarantee is "RLS holds against application code that is wrong by
    // accident", not "against application code that is compromised" — and the
    // isolation harness's own docstring asks the second question. Every other
    // tenancy control in the system sits ABOVE this line and goes with it.
    //
    // Not a live exploit: nothing in the repository does this, and no request
    // can inject SQL. It is a missing control, and the mitigation is an
    // architectural decision (Agent 1 / the lead) rather than a patch — a
    // `TenantTx` that refuses `set_config`, a setter that can only narrow, or
    // an explicit paragraph in ADR-0002 so the next reader is not misled.
    //
    // When it is closed this test goes RED. Replace the block with
    // `await expect(...).rejects.toThrow()`.
    // ---------------------------------------------------------------------
    const stolen = withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        expect(tx.session.tenantId).toBe(TENANT_A);
        await tx.query(
          `SELECT set_config('app.tenant_id', $1, true),
                  set_config('app.programme_ids', $2, true)`,
          [TENANT_B, `{${PROGRAMME_B1}}`],
        );
        const rows = await tx.query<{ tenant_id: string }>('SELECT tenant_id FROM contact');
        return rows.map((row) => row.tenant_id);
      },
    );

    // FIXED by T-0020. Flipped from a characterisation test by the lead.
    //
    // The re-scoping still WORKS — it cannot be prevented. A framework and its
    // callback are the same role on the same connection, `SET LOCAL` reaches
    // the GUC without `set_config`, and Postgres has no write-once transaction
    // state. ADR-0010 records the attempts and why each fails.
    //
    // What changed is that it no longer escapes: `assertScopeIntact` reads the
    // GUCs back before COMMIT, throws on divergence, and **discards the
    // callback's return value**. A forged read never leaves the transaction and
    // a forged write never commits.
    //
    // So this asserts detection, not prevention, and the distinction is the
    // whole point of the ADR — do not "strengthen" it into a claim the system
    // cannot make.
    await expect(stolen).rejects.toThrow(SessionScopeViolationError);
  });

  it('admits no auth_rate_limit row to a session that did not present its key', async () => {
    // ---------------------------------------------------------------------
    // THIS TEST ASSERTS A DEFECT. Do not read it as approval.
    //
    // `auth_rate_limit` is the one table with no tenant_id (ADR-0009), and its
    // policy is `USING (true)`. ADR-0009 argues the exemption is harmless
    // because "the only thing a session could do with unrestricted access is
    // increment or clear a counter for a key it already knows — which it can do
    // anyway by making sign-in requests". Both halves are wrong:
    //
    //   * SELECT is unrestricted, so a session ENUMERATES every key. ADR-0009's
    //     own text says the digest is unkeyed over a low-entropy input and a row
    //     is therefore "evidence that a named person attempted to sign in at a
    //     named workspace". Reading the table is reading that evidence for every
    //     other tenant in the cell — exactly the pseudonymised personal data the
    //     ADR says is in NDPA scope.
    //   * DELETE is unrestricted and unbounded. One statement clears every
    //     lockout in the cell, for every tenant. No sign-in request can do that,
    //     and lockout is the only bound on password guessing in the system.
    //
    // Owner: Agent 1 (M2 / auth). The fix is not "add tenant_id" — ADR-0009 is
    // right that it cannot have one. It is a narrower policy (a row visible only
    // to a session presenting its own key_hash), or the HMAC ADR-0009 already
    // wants, or moving the counter out of a table the app role writes freely.
    //
    // When it is closed this test goes RED.
    // ---------------------------------------------------------------------
    const victimKey = hashRateLimitKey(
      'signin',
      'rift-valley-contact',
      'wanjiru.agent@tenant-b.test',
    );
    const migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    try {
      // A lockout exists for a tenant B user, written the way the auth service
      // writes it.
      await migrator.query(
        `INSERT INTO auth_rate_limit (key_hash, failed_count, locked_until)
             VALUES ($1, 5, now() + interval '15 minutes')
        ON CONFLICT (key_hash) DO UPDATE
             SET failed_count = 5, locked_until = now() + interval '15 minutes'`,
        [victimKey],
      );

      const attack = await withForcedScope(
        appPool,
        { tenantId: TENANT_A, programmeIds: [PROGRAMME_A1] },
        async (query) => {
          const readable = await query<{ key_hash: Buffer; failed_count: number }>(
            'SELECT key_hash, failed_count FROM auth_rate_limit',
          );
          const cleared = await query<{ key_hash: Buffer }>(
            'DELETE FROM auth_rate_limit RETURNING key_hash',
          );
          return { readable, cleared: cleared.length };
        },
      );

      // FIXED by T-0020, flipped by the lead. The policy is now
      // `USING (key_hash = app.current_rate_limit_key())`, so a session that
      // presents no key sees nothing and can delete nothing.
      //
      // Both halves matter. Reading was disclosure — ADR-0009's own text calls
      // a row evidence that a named person attempted to sign in at a named
      // workspace, which is another tenant's personal data. Deleting was worse:
      // one statement cleared every lockout in the cell, which is the only
      // bound on password guessing.
      expect(
        attack.readable.some((row) => row.key_hash.equals(victimKey)),
        'FINDING-3 has regressed — a session read a key it did not present',
      ).toBe(false);
      expect(
        attack.cleared,
        'FINDING-3 has regressed — a session cleared lockouts it did not own',
      ).toBe(0);
    } finally {
      await migrator.query('DELETE FROM auth_rate_limit WHERE key_hash = $1', [victimKey]);
      await migrator.end();
    }
  });

  it('keeps the rate-limit key’s normalisation identical to the account lookup’s', async () => {
    // FINDING-5 — closed today, but by accident rather than by design, so it is
    // pinned here.
    //
    // `hashRateLimitKey` normalises with JavaScript `String.toLowerCase()`;
    // `AuthService.findAccount` matches with Postgres `lower()`. They are not
    // the same function. U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE) lowers
    // to "i" in Postgres under a UTF-8 collation and to "i" + U+0307 in
    // JavaScript — so an address containing it finds the SAME account while
    // producing a DIFFERENT rate-limit key. Every such spelling is a fresh
    // five-attempt budget against a real password, and lockout is the only
    // bound on guessing in the system.
    //
    // The only thing stopping it is that `SignInBody.email` is
    // `z.string().email()`, whose regex is ASCII-only. That is one relaxation
    // away from being untrue, and IDN email is a plausible ask for an
    // Africa-first product. If the schema is widened, this test must object.
    const { SignInBody } = (await import(
      resolve(repoRoot, 'apps/api/src/auth/auth.schemas.ts')
    )) as { SignInBody: { safeParse: (value: unknown) => { success: boolean } } };
    const dotted = 'wanjİru.agent@tenant-b.test';

    // 1. Postgres and JavaScript really do disagree — proven, not assumed.
    const rows = await withForcedScope(appPool, { tenantId: TENANT_A }, async (query) =>
      query<{ folded: string }>('SELECT lower($1::text) AS folded', [dotted]),
    );
    expect(rows[0]?.folded).toBe('wanjiru.agent@tenant-b.test');
    expect(dotted.toLowerCase()).not.toBe(rows[0]?.folded);
    expect(
      hashRateLimitKey('signin', 'rift-valley-contact', dotted).equals(
        hashRateLimitKey('signin', 'rift-valley-contact', 'wanjiru.agent@tenant-b.test'),
      ),
      'two identifiers Postgres folds together must not produce different rate-limit keys',
    ).toBe(false);

    // 2. …and the boundary is the whole of what keeps it unreachable. This is
    // the assertion that fires if anybody widens the schema.
    expect(
      SignInBody.safeParse({
        tenantSlug: 'rift-valley-contact',
        email: dotted,
        password: 'x',
      }).success,
      'the email schema now accepts a non-ASCII local part, so the rate-limit key ' +
        'no longer normalises the way the account lookup does (FINDING-5)',
    ).toBe(false);

    // Control: the ASCII form the schema does accept normalises identically in
    // both, so the assertion above is about Unicode rather than about a parser
    // that rejects everything.
    expect(
      SignInBody.safeParse({
        tenantSlug: 'rift-valley-contact',
        email: 'WANJIRU.AGENT@TENANT-B.TEST',
        password: 'x',
      }).success,
    ).toBe(true);
    expect('WANJIRU.AGENT@TENANT-B.TEST'.toLowerCase()).toBe('wanjiru.agent@tenant-b.test');
  });

  it('gives an authentication transaction no reach into business data at all', async () => {
    // `withAuthTransaction` sets app.programme_ids to '{}' and leaves
    // app.user_id unset. Its header comment claims such a transaction "can read
    // no business row at all — not one contact, not one programme". Asserted
    // here against the real policies rather than trusted, because that claim is
    // what the entire sign-in path's safety rests on.
    const reachable = await withForcedScope(
      appPool,
      // No userId at all, and an empty programme list — exactly the shape
      // `withAuthTransaction` establishes.
      { tenantId: TENANT_A, programmeIds: [] },
      async (query) => {
        const contacts = await query<{ n: string }>('SELECT count(*)::text AS n FROM contact');
        const programmes = await query<{ n: string }>('SELECT count(*)::text AS n FROM programme');
        const users = await query<{ n: string }>('SELECT count(*)::text AS n FROM "user"');
        const tenants = await query<{ n: string }>('SELECT count(*)::text AS n FROM tenant');
        return {
          contacts: Number(contacts[0]?.n),
          programmes: Number(programmes[0]?.n),
          users: Number(users[0]?.n),
          tenants: Number(tenants[0]?.n),
        };
      },
    );
    expect(reachable.contacts).toBe(0);
    expect(reachable.programmes).toBe(0);
    // Tenant-scoped rather than programme-scoped, and deliberately so: sign-in
    // must find the user before any programme is known. Non-zero here is the
    // control showing the zeros above are enforcement and not an empty database.
    expect(reachable.users).toBe(4);
    expect(reachable.tenants).toBe(1);
  });
});
