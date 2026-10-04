import {
  createPool,
  PROGRAMME_A1,
  SEED_CONTACTS,
  TENANT_A,
  USER_A_SUPERVISOR,
  withTenantTransaction,
} from '@kasuwa/db';
import { findProgrammeById, updateProgramme } from '@kasuwa/domain-core';
import { writeFieldSecurityMatrix } from '@kasuwa/metadata-engine';
import { reseed } from '@kasuwa/testing';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * ACCEPTANCE — T-0011, two schema habits corrected once, repo-wide.
 *
 *   1. No index is made redundant by another index on the same table.
 *   2. Every table carrying `updated_at` advances it on UPDATE.
 *   3. `contact_keyset_idx` survives, because deleting it is the cheapest
 *      wrong way to satisfy (1).
 *
 * Both invariants are asserted against the live catalogue and live rows, never
 * by reading migration SQL. They therefore keep holding for tables nobody has
 * written yet: a future migration that copies the old habit turns this red.
 *
 * WHAT THIS SUITE LEAVES TO THE BUILDER: how `updated_at` gets maintained (the
 * task recommends a BEFORE UPDATE trigger; nothing here inspects triggers), and
 * which redundant indexes are dropped. It only states what must be true after.
 *
 * Every write here either rolls back or is followed by `reseed`.
 */

/** Never a real row: same shape as the seed ids, nothing seeds it. */
const OBJ_PROBE = '11111111-0000-4000-8000-0000001100a1';
const OBJ_PROBE_API = 'schema_hygiene_probe';

/**
 * THE REDUNDANCY RULE. An index R is reported redundant when some other index
 * C on the same table makes it pure write cost. All of the following must hold;
 * if any is false the pair is treated as NOT comparable and nothing is
 * reported, so every exclusion below errs towards silence, never towards a
 * false alarm that would push someone into dropping a load-bearing index.
 *
 *   a. Both are btree. Only btree has the leading-column property that makes a
 *      prefix argument valid at all; a hash or GIN index on the same columns
 *      answers different questions.
 *
 *   b. R is NOT unique (and is not a primary key or exclusion index). A unique
 *      index on (tenant_id, x) enforces "x is unique per tenant"; a unique
 *      index on (tenant_id, x, y) does not imply it. A UNIQUE constraint whose
 *      index happens to be a prefix of another unique index enforces a
 *      different, stronger invariant and is never redundant. (Whether C is
 *      unique does not matter: any C serves R's lookups.)
 *
 *   c. Neither is partial (indpred IS NULL). A partial R may be tiny and serve
 *      exactly its predicate; a partial C does not contain every row R does.
 *      Proving predicate implication from the catalogue is not something a test
 *      should attempt, so a partial index is incomparable by definition.
 *
 *   d. Neither has an expression key (indexprs IS NULL). Two expression trees
 *      can be equivalent without being textually equal, and vice versa; a
 *      comparison would be either fragile or wrong. Incomparable.
 *
 *   e. R's key columns are a prefix of C's key columns, position by position,
 *      with the same operator class, the same collation and the same sort
 *      options (DESC / NULLS FIRST). A different opclass or collation means C
 *      cannot serve R's comparisons; a different sort option might still be
 *      served by a backward scan, but proving that is not worth the false
 *      positive, so it is treated as incomparable.
 *      "Prefix" includes EQUAL key lists: an exact duplicate of a non-unique
 *      index is the limiting case of the same waste. A pair of identical
 *      non-unique indexes is reported once, not twice.
 *
 *   f. Any INCLUDE (non-key) columns of R are among C's columns (key or
 *      INCLUDE). Otherwise R can answer an index-only scan C cannot, which is
 *      a plan C does not serve — the exact escalation case the task names.
 *
 *   g. C is valid (indisvalid). An index mid-CREATE CONCURRENTLY serves nothing.
 *
 * System schemas are excluded; everything else in the database is in scope.
 */
const REDUNDANT_INDEXES_SQL = `
WITH idx AS (
  SELECT i.indexrelid,
         i.indrelid,
         ic.relname                                  AS index_name,
         tn.nspname                                  AS schema_name,
         t.relname                                   AS table_name,
         am.amname,
         i.indisunique OR i.indisprimary OR i.indisexclusion AS enforces,
         i.indisvalid,
         i.indpred IS NOT NULL                       AS partial,
         i.indexprs IS NOT NULL                      AS has_expr,
         i.indnkeyatts                               AS nkey,
         (string_to_array(i.indkey::text, ' ')::int2[])        AS cols,
         (string_to_array(i.indclass::text, ' ')::oid[])       AS opclasses,
         (string_to_array(i.indcollation::text, ' ')::oid[])   AS collations,
         (string_to_array(i.indoption::text, ' ')::int2[])     AS options
    FROM pg_index i
    JOIN pg_class ic     ON ic.oid = i.indexrelid
    JOIN pg_class t      ON t.oid  = i.indrelid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    JOIN pg_am am        ON am.oid = ic.relam
   WHERE tn.nspname NOT IN ('pg_catalog', 'information_schema')
     AND tn.nspname NOT LIKE 'pg_toast%'
     AND tn.nspname NOT LIKE 'pg_temp%'
),
comparable AS (
  SELECT * FROM idx WHERE amname = 'btree' AND NOT partial AND NOT has_expr
)
SELECT r.schema_name, r.table_name, r.index_name AS redundant, c.index_name AS covered_by
  FROM comparable r
  JOIN comparable c
    ON c.indrelid = r.indrelid
   AND c.indexrelid <> r.indexrelid
 WHERE NOT r.enforces
   AND c.indisvalid
   AND r.nkey <= c.nkey
   AND r.cols[1:r.nkey]       = c.cols[1:r.nkey]
   AND r.opclasses[1:r.nkey]  = c.opclasses[1:r.nkey]
   AND r.collations[1:r.nkey] = c.collations[1:r.nkey]
   AND r.options[1:r.nkey]    = c.options[1:r.nkey]
   -- (f) R's INCLUDE columns must all be somewhere in C.
   AND r.cols[r.nkey + 1:] <@ c.cols
   -- An exact duplicate pair of non-unique indexes: report one of them.
   AND NOT (r.nkey = c.nkey AND NOT c.enforces
            AND r.cols = c.cols AND r.indexrelid < c.indexrelid)
 ORDER BY r.schema_name, r.table_name, r.index_name, c.index_name
`;

interface RedundantIndex {
  schema_name: string;
  table_name: string;
  redundant: string;
  covered_by: string;
}

/** Ordinary and partitioned tables carrying `updated_at`, outside system schemas. */
const TABLES_WITH_UPDATED_AT_SQL = `
SELECT t.relname AS table_name,
       EXISTS (SELECT 1 FROM pg_attribute a2
                WHERE a2.attrelid = t.oid AND a2.attname = 'tenant_id'
                  AND NOT a2.attisdropped) AS has_tenant_id
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_attribute a ON a.attrelid = t.oid
 WHERE n.nspname = 'public'
   AND t.relkind IN ('r', 'p')
   AND a.attname = 'updated_at'
   AND NOT a.attisdropped
 ORDER BY t.relname
`;

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Ids for rows planted inside rolled-back transactions. Nothing seeds them. */
const PLANT_ROLE = '11111111-0000-4000-8000-0000001100b1';
const PLANT_OBJECT = '11111111-0000-4000-8000-0000001100b2';
const PLANT_FIELD = '11111111-0000-4000-8000-0000001100b3';
const PLANT_DISPOSITION = '11111111-0000-4000-8000-0000001100b4';
const PLANT_PORTAL_USER = '11111111-0000-4000-8000-0000001100b5';

type Plant = (client: PoolClient) => Promise<void>;

/**
 * Every plant back-dates updated_at. A row inserted in the probing transaction
 * would otherwise carry now() — the transaction start — and a correctly
 * maintained updated_at := now() on the UPDATE would equal it, not exceed it,
 * making the case unpassable.
 */
const PAST = `now() - interval '1 minute'`;

const plantObject: Plant = async (client) => {
  await client.query(
    `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom, updated_at)
     VALUES ($1, $2, 't0011_plant', 'T-0011 plant', true, ${PAST})`,
    [PLANT_OBJECT, TENANT_A],
  );
};

const plantField: Plant = async (client) => {
  await plantObject(client);
  await client.query(
    `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, updated_at)
     VALUES ($1, $2, $3, 'plant_field', 'Plant field', 'text', ${PAST})`,
    [PLANT_FIELD, TENANT_A, PLANT_OBJECT],
  );
};

/**
 * One row for each table that carries updated_at but that the seed leaves
 * empty, so the generic case exercises every such table and not merely the
 * seeded ones. Used only when the table is empty, and always inside a
 * transaction that rolls back. Tenant A, programme A1 — the shared fixtures.
 */
const PLANTS: Record<string, Plant> = {
  role: async (client) => {
    await client.query(
      `INSERT INTO role (id, tenant_id, name, updated_at)
       VALUES ($1, $2, 'T-0011 plant', ${PAST})`,
      [PLANT_ROLE, TENANT_A],
    );
  },
  object_def: plantObject,
  field_def: plantField,
  field_security_grant: async (client) => {
    await plantField(client);
    await client.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level, updated_at)
       SELECT $1, $2, id, 'read', ${PAST}
         FROM permission_set WHERE tenant_id = $1 ORDER BY id LIMIT 1`,
      [TENANT_A, PLANT_FIELD],
    );
  },
  disposition: async (client) => {
    await client.query(
      `INSERT INTO disposition (id, tenant_id, programme_id, code, label, category, position,
                                updated_at)
       VALUES ($1, $2, $3, 'T0011', 'T-0011 plant', 'resolved', 999, ${PAST})`,
      [PLANT_DISPOSITION, TENANT_A, PROGRAMME_A1],
    );
  },
  programme_sla: async (client) => {
    await client.query(
      `INSERT INTO programme_sla (tenant_id, programme_id, pause_outside_operating_hours,
                                  pause_awaiting_customer, warn_at_percent_of_target,
                                  warn_notify_role, breach_notify_role, updated_at)
       VALUES ($1, $2, false, false, 80, 'team_lead', 'programme_manager', ${PAST})`,
      [TENANT_A, PROGRAMME_A1],
    );
  },
  programme_retention: async (client) => {
    await client.query(
      `INSERT INTO programme_retention (tenant_id, programme_id, call_recordings_days,
                                        message_transcripts_days, screen_recordings_days,
                                        qa_evaluations_days, on_expiry,
                                        redact_sensitive_numbers_in_transcripts, legal_hold,
                                        updated_at)
       VALUES ($1, $2, 30, 30, 30, 30, 'delete', true, false, ${PAST})`,
      [TENANT_A, PROGRAMME_A1],
    );
  },
  portal_user: async (client) => {
    await client.query(
      `INSERT INTO portal_user (id, tenant_id, programme_id, email, email_masked,
                                display_name, access, updated_at)
       VALUES ($1, $2, $3, 'plant.t0011@client.example', 'p***@client.example',
               'T-0011 plant', 'viewer', ${PAST})`,
      [PLANT_PORTAL_USER, TENANT_A, PROGRAMME_A1],
    );
  },
};

describe('acceptance: schema hygiene (T-0011)', () => {
  /** kasuwa_app — NOBYPASSRLS. What the API runs as. */
  let appPool: Pool;
  /** kasuwa_migrator — owns the schema, BYPASSRLS. Catalogue reads and probes. */
  let migrator: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await migrator?.end();
    await reseed(inject('migrationUrl'));
  });

  /** Runs `fn` on one migrator connection inside a transaction that always rolls back. */
  async function rolledBack<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      return await fn(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  // --- 1. redundant indexes ----------------------------------------------

  describe('no index is a column-prefix of another index on the same table', () => {
    it('the detector itself flags a planted redundant index and spares the look-alikes', async () => {
      // A check only ever observed passing is indistinguishable from one that
      // does nothing. So every run first proves, on a throwaway table, that the
      // query reports what it should and stays silent where the rule says so.
      const flagged = await rolledBack(async (client) => {
        await client.query(`
          CREATE TABLE t0011_probe (
            tenant_id uuid NOT NULL,
            a         text NOT NULL,
            b         text NOT NULL,
            c         text NOT NULL,
            UNIQUE (tenant_id, a, b)
          )`);
        // Redundant: plain prefix of the unique index.
        await client.query('CREATE INDEX t0011_planted_prefix ON t0011_probe (tenant_id)');
        // Redundant: exact duplicate of another non-unique index (one reported).
        await client.query('CREATE INDEX t0011_dup_1 ON t0011_probe (c, a)');
        await client.query('CREATE INDEX t0011_dup_2 ON t0011_probe (c, a)');
        // NOT redundant: a unique prefix enforces its own invariant (rule b).
        await client.query('CREATE UNIQUE INDEX t0011_unique_prefix ON t0011_probe (tenant_id, a)');
        // NOT redundant: partial (rule c).
        await client.query(`CREATE INDEX t0011_partial ON t0011_probe (tenant_id) WHERE c = 'x'`);
        // NOT redundant: expression key (rule d).
        await client.query('CREATE INDEX t0011_expr ON t0011_probe (lower(a))');
        // NOT redundant: different sort option on the prefix (rule e).
        await client.query('CREATE INDEX t0011_desc ON t0011_probe (tenant_id DESC)');
        // NOT redundant: INCLUDE column the covering index lacks (rule f).
        await client.query('CREATE INDEX t0011_include ON t0011_probe (tenant_id) INCLUDE (c)');

        const result = await client.query<RedundantIndex>(REDUNDANT_INDEXES_SQL);
        return result.rows
          .filter((row) => row.table_name === 't0011_probe')
          .map((row) => row.redundant);
      });

      expect([...new Set(flagged)].sort()).toEqual(['t0011_dup_2', 't0011_planted_prefix']);
    });

    it('holds over every index in the catalogue', async () => {
      const comparable = await migrator.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public'`,
      );
      // Guards the vacuous pass: a catalogue query against the wrong schema or
      // database would return no indexes and no redundancy.
      expect(Number(comparable.rows[0]?.n ?? 0)).toBeGreaterThan(20);

      const { rows } = await migrator.query<RedundantIndex>(REDUNDANT_INDEXES_SQL);
      const report = rows.map(
        (row) => `${row.table_name}.${row.redundant} is a prefix of ${row.covered_by}`,
      );
      expect(report, 'redundant indexes (each one is write cost the planner never needs)').toEqual(
        [],
      );
    });
  });

  // --- 2. updated_at ------------------------------------------------------

  describe('every table carrying updated_at advances it on UPDATE', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    /**
     * UPDATEs one row of `table`, setting `column` to its own value and never
     * mentioning updated_at — the shape of the UPDATE a future repository
     * forgets — and reports whether updated_at moved forward.
     *
     * updated_at travels as TEXT, never as a JS Date: Date truncates to
     * milliseconds, so a microsecond timestamp compared with its own truncation
     * looks as if it advanced. The first draft of this suite passed every table
     * but one on main for exactly that reason.
     */
    async function probeAdvance(
      client: PoolClient,
      table: string,
      column: string,
    ): Promise<'ok' | 'empty' | string> {
      const name = quoteIdent(table);
      const before = await client.query<{ ctid: string; updated_at: string }>(
        `SELECT ctid::text AS ctid, updated_at::text AS updated_at FROM ${name} LIMIT 1`,
      );
      const row = before.rows[0];
      if (row === undefined) return 'empty';
      const col = quoteIdent(column);
      const after = await client.query<{ advanced: boolean; before: string; after: string }>(
        `UPDATE ${name} SET ${col} = ${col}
          WHERE ctid = $1::tid
         RETURNING updated_at > $2::timestamptz AS advanced,
                   $2::timestamptz::text AS before, updated_at::text AS after`,
        [row.ctid, row.updated_at],
      );
      const written = after.rows[0];
      if (written === undefined) return `${table}: the UPDATE matched no row`;
      return written.advanced
        ? 'ok'
        : `${table}: updated_at stayed ${written.after} (was ${written.before})`;
    }

    it('the probe itself tells a maintained updated_at from an unmaintained one', async () => {
      // Proves the generic case below can both fail and pass: on a throwaway
      // table the probe reports stale with no maintenance, and ok once a
      // trigger maintains the column. Which mechanism T-0011 picks is the
      // builder's call; a trigger is used here only because it is the shortest.
      const outcomes = await rolledBack(async (client) => {
        await client.query(`
          CREATE TABLE t0011_ts_probe (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            updated_at timestamptz NOT NULL DEFAULT now() - interval '1 minute'
          )`);
        await client.query('INSERT INTO t0011_ts_probe DEFAULT VALUES');
        const unmaintained = await probeAdvance(client, 't0011_ts_probe', 'id');
        await client.query(`
          CREATE FUNCTION t0011_touch() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$`);
        await client.query(`
          CREATE TRIGGER t0011_touch BEFORE UPDATE ON t0011_ts_probe
          FOR EACH ROW EXECUTE FUNCTION t0011_touch()`);
        const maintained = await probeAdvance(client, 't0011_ts_probe', 'id');
        return { unmaintained, maintained };
      });
      expect(outcomes.unmaintained).toMatch(/^t0011_ts_probe: updated_at stayed /);
      expect(outcomes.maintained).toBe('ok');
    });

    it('generically: one row of every such table, updated without naming updated_at', async () => {
      const tables = await migrator.query<{ table_name: string; has_tenant_id: boolean }>(
        TABLES_WITH_UPDATED_AT_SQL,
      );
      // Not vacuous: there are many such tables today. If this drops to zero
      // the catalogue query is wrong, not the schema fixed.
      expect(tables.rows.length).toBeGreaterThan(5);

      const stale: string[] = [];
      const unexercised: string[] = [];
      for (const { table_name: table, has_tenant_id: hasTenantId } of tables.rows) {
        const outcome = await rolledBack(async (client) => {
          const column = hasTenantId ? 'tenant_id' : 'id';
          const seeded = await probeAdvance(client, table, column);
          if (seeded !== 'empty') return seeded;
          // The seed has no row here: plant one, in this same rolled-back
          // transaction, and probe that instead.
          const plant = PLANTS[table];
          if (plant === undefined) return 'empty';
          await plant(client);
          return probeAdvance(client, table, column);
        });
        if (outcome === 'empty') unexercised.push(table);
        else if (outcome !== 'ok') stale.push(outcome);
      }

      // `unexercised`: a table that was never exercised was never demonstrated,
      // and a skip that goes green is the vacuous pass this suite exists to
      // avoid. So a new table with updated_at and no seeded row fails here
      // until someone seeds a row for it or adds a plant to PLANTS above.
      // One assertion, so a failure always shows both lists.
      expect(
        { stale, unexercised },
        `${tables.rows.length} tables carry updated_at; stale = did not advance on UPDATE, unexercised = no seeded row and no plant`,
      ).toEqual({ stale: [], unexercised: [] });
    });

    it('as kasuwa_app inside a tenant transaction: a contact UPDATE advances it', async () => {
      const contact = SEED_CONTACTS.find(
        (candidate) => candidate.tenantId === TENANT_A && candidate.programmeId === PROGRAMME_A1,
      );
      if (contact === undefined) throw new Error('Fixture drift: no seeded contact in A1');

      const result = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        async (tx) => {
          // Text, not Date — see the generic case for why.
          const before = await tx.query<{ updated_at: string }>(
            'SELECT updated_at::text AS updated_at FROM contact WHERE tenant_id = $1 AND id = $2',
            [TENANT_A, contact.id],
          );
          const was = before[0]?.updated_at;
          if (was === undefined) throw new Error('seeded contact not visible to the session');
          const after = await tx.query<{ advanced: boolean; updated_at: string }>(
            `UPDATE contact SET display_name = $3
              WHERE tenant_id = $1 AND id = $2
             RETURNING updated_at > $4::timestamptz AS advanced, updated_at::text AS updated_at`,
            [TENANT_A, contact.id, `${contact.displayName} (renamed)`, was],
          );
          return { was, row: after[0] };
        },
      );

      expect(result.row, 'UPDATE matched the row').toBeDefined();
      expect(
        result.row?.advanced,
        `contact.updated_at stayed ${result.row?.updated_at} (was ${result.was})`,
      ).toBe(true);
    });

    it('through a real repository: writeFieldSecurityMatrix bumps object_def and advances updated_at', async () => {
      // A real UPDATE path that exists on main today and never mentions
      // updated_at: the matrix write bumps object_def.field_security_version.
      // That is a change to the row, and a sync cursor reading updated_at would
      // miss it.
      await migrator.query(
        `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
         VALUES ($1, $2, $3, 'Schema hygiene probe', true)`,
        [OBJ_PROBE, TENANT_A, OBJ_PROBE_API],
      );
      await migrator.query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
         VALUES (gen_random_uuid(), $1, $2, 'priority', 'priority', 'text')`,
        [TENANT_A, OBJ_PROBE],
      );
      // Text, not Date — see the generic case for why. Without `since` the
      // comparison is against the row's own value, so it reports false.
      const readObject = async (since?: string) => {
        const { rows } = await migrator.query<{
          updated_at: string;
          version: number;
          advanced: boolean;
        }>(
          `SELECT updated_at::text AS updated_at, field_security_version AS version,
                  updated_at > coalesce($3::timestamptz, updated_at) AS advanced
             FROM object_def WHERE tenant_id = $1 AND id = $2`,
          [TENANT_A, OBJ_PROBE, since ?? null],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('planted object_def vanished');
        return row;
      };
      const before = await readObject();

      const outcome = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        (tx) =>
          writeFieldSecurityMatrix(tx, {
            objectApiName: OBJ_PROBE_API,
            version: before.version,
            changes: [{ fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' }],
          }),
      );
      expect(outcome.kind, 'the matrix write was applied').toBe('saved');

      const after = await readObject(before.updated_at);
      expect(after.version, 'the repository did update object_def').toBe(before.version + 1);
      expect(
        after.advanced,
        `object_def.updated_at stayed ${after.updated_at} although field_security_version moved ${before.version} -> ${after.version}`,
      ).toBe(true);
    });

    it('through a real repository: updateProgramme advances it on every call, even twice in one transaction', async () => {
      // REGRESSION GUARD — passes on main, deliberately. Programme versions are
      // derived from updated_at (programme-version.ts) and the repository
      // writes a strictly-monotonic value itself. A naive trigger that
      // overwrites updated_at with now() would freeze it within a transaction
      // (now() is the transaction start), and the second rename below would
      // leave the version unchanged. Whatever policy T-0011 applies must not
      // regress this.
      const versions = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
        async (tx) => {
          const start = await findProgrammeById(tx, PROGRAMME_A1);
          if (start === null) throw new Error('Fixture drift: A1 not visible to the supervisor');
          const first = await updateProgramme(tx, PROGRAMME_A1, start.version, {
            name: `${start.name} (t0011 a)`,
          });
          if (first === null) throw new Error('first rename matched nothing');
          const second = await updateProgramme(tx, PROGRAMME_A1, first.version, {
            name: `${start.name} (t0011 b)`,
          });
          if (second === null) throw new Error('second rename matched nothing');
          return [start.version, first.version, second.version];
        },
      );

      const [v0, v1, v2] = versions;
      expect(v1, 'first update advanced the version').toBeGreaterThan(v0 ?? Infinity);
      expect(v2, 'second update in the same transaction advanced it again').toBeGreaterThan(
        v1 ?? Infinity,
      );
    });
  });

  // --- 3. the index that must stay ----------------------------------------

  it('contact_keyset_idx still exists, with the exact key order keyset pagination needs', async () => {
    // The cheapest wrong way to satisfy section 1 is to drop indexes until it
    // goes green. This one serves ORDER BY created_at DESC, id DESC within a
    // programme and no unique index replaces it.
    const { rows } = await migrator.query<{ definition: string }>(
      `SELECT pg_get_indexdef(c.oid) AS definition
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname = 'contact_keyset_idx'`,
    );
    expect(rows, 'contact_keyset_idx is missing').toHaveLength(1);
    expect(rows[0]?.definition).toMatch(
      /ON public\.contact USING btree \(tenant_id, programme_id, created_at DESC, id DESC\)$/,
    );
  });
});
