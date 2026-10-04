import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadMigrations, runMigrations } from '@kasuwa/db';

/**
 * ACCEPTANCE — T-0044, a marked non-transactional mode for the migration
 * runner (Agent 1, Platform & Security). Decision: D-L65.
 *
 * THE INTERFACE THIS FILE REQUIRES, and nothing else:
 *
 *   `@kasuwa/db` exports `runMigrations({ connectionString, migrationsDir })`
 *   returning `{ applied: string[]; alreadyApplied: string[] }`, and
 *   `loadMigrations(dir)` returning `{ id, sql, checksum }[]`. Both exist on
 *   main today; the builder must not change their shape. The marker is the
 *   exact line `-- kasuwa:no-transaction` as the FIRST line of a file.
 *
 *   A refusal (section 3) must throw an error whose message names the
 *   migration id and contains the text `no-transaction`, so an operator reading
 *   a failed deploy knows which file and which rule.
 *
 * Everything else is the builder's: how statements are split, how the
 * allowlist is matched, whether refusal is checked per file or for the whole
 * run up front, and the error wording beyond the two requirements above.
 *
 * HOW THE SUITE STAYS AWAY FROM THE REAL SCHEMA. Each test gets its own
 * throwaway directory of `.sql` files and its own Postgres schema, and drives
 * the runner with `search_path` pinned to that schema through the connection
 * string's `options` parameter. The runner creates `_kasuwa_migration`
 * unqualified, so it lands in the scratch schema too; the real
 * `public._kasuwa_migration` and the seeded data are never touched. The
 * schema is dropped afterwards. No superuser and no CREATEDB are needed:
 * `kasuwa_migrator` has CREATE on the database, which is all a schema takes.
 *
 * TRAPS THE BUILDER SHOULD KNOW ABOUT, since several tests aim at them:
 *
 *   - Sending a whole marked file as ONE query string does not work. Postgres
 *     runs a multi-statement simple query as a single implicit transaction, so
 *     two `CREATE INDEX CONCURRENTLY` statements in one string fail exactly as
 *     they would inside BEGIN. Statements have to be sent one at a time.
 *   - `ALTER TABLE t VALIDATE CONSTRAINT c, DROP COLUMN x` is valid SQL. An
 *     allowlist that matches a statement's PREFIX admits it.
 *   - With no transaction, session state persists for the rest of the run.
 *     That is why `SET`, `BEGIN` and friends are refused, not merely unlisted.
 *   - A failed `CREATE [UNIQUE] INDEX CONCURRENTLY` leaves an INVALID index
 *     behind, and a plain re-run then fails with "already exists". Section 4
 *     performs the cleanup the builder documents (drop the INVALID index
 *     `CONCURRENTLY`, fix the cause, re-run) and requires the
 *     create-rls-migration skill to say so.
 *   - A marked file with two statements where the second fails has already
 *     committed the first. That is inherent, not a bug; the file is still not
 *     recorded, and `IF NOT EXISTS` makes the re-run safe. Section 4 shows it.
 *
 * D-L23, observed on main before the mode exists: sections 1, 3, 4 and 6 fail
 * for the real reason (CONCURRENTLY refused inside the runner's BEGIN, marked
 * files with forbidden statements not refused, no docs). Section 2 passes, and
 * section 5 passes except its ordering test, which interleaves a CONCURRENTLY
 * file. Those passes are legitimate: they pin behaviour that already exists
 * and must survive the change. Section 6's negative cases would also hold on
 * main, which is why every one of them is paired in the same test with an
 * exact-marker control that must apply, so none of them can pass vacuously.
 */

const MARKER = '-- kasuwa:no-transaction';

/** 200 rows, unique names, one NOT VALID check to validate later. */
const WIDGET_TABLE = `
CREATE TABLE widget (
  id    integer PRIMARY KEY,
  name  text    NOT NULL
);
INSERT INTO widget (id, name) SELECT g, 'w' || g FROM generate_series(1, 200) AS g;
ALTER TABLE widget ADD CONSTRAINT widget_name_present CHECK (length(name) > 0) NOT VALID;
`;

let migrationUrl: string;

beforeAll(() => {
  migrationUrl = inject('migrationUrl');
});

interface Scratch {
  schema: string;
  dir: string;
  url: string;
  write: (name: string, content: string) => void;
  run: () => ReturnType<typeof runMigrations>;
  query: <Row extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<Row[]>;
  recorded: () => Promise<{ id: string; checksum: string }[]>;
  index: (name: string) => Promise<{ valid: boolean } | undefined>;
  exists: (relation: string) => Promise<boolean>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup !== undefined) {
      await cleanup();
    }
  }
});

function withSearchPath(url: string, schema: string): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

async function scratch(): Promise<Scratch> {
  const schema = `t0044_${randomBytes(6).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'kasuwa-t0044-'));
  const url = withSearchPath(migrationUrl, schema);

  // Autocommit, single statements: this client must never hold a transaction
  // open, or a CONCURRENTLY build in the runner would wait on it.
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);

  cleanups.push(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  const query = async <Row extends Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => (await admin.query<Row>(sql, params)).rows;

  return {
    schema,
    dir,
    url,
    write: (name, content) => writeFileSync(join(dir, name), content, 'utf8'),
    run: () => runMigrations({ connectionString: url, migrationsDir: dir }),
    query,
    recorded: async () => {
      const table = await query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`${schema}._kasuwa_migration`],
      );
      if (table[0]?.exists !== true) {
        return [];
      }
      return query<{ id: string; checksum: string }>(
        `SELECT id, checksum FROM ${schema}._kasuwa_migration ORDER BY id`,
      );
    },
    index: async (name) => {
      const rows = await query<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, name],
      );
      return rows[0];
    },
    exists: async (relation) => {
      const rows = await query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`${schema}.${relation}`],
      );
      return rows[0]?.exists === true;
    },
  };
}

/** A scratch schema with the widget table already applied by a prior run. */
async function withWidget(): Promise<Scratch> {
  const s = await scratch();
  s.write('0001_widget.sql', WIDGET_TABLE);
  const first = await s.run();
  expect(first.applied).toEqual(['0001_widget']);
  return s;
}

/** The error a promise rejects with. Fails the test, with a reason, if it resolves. */
async function rejection(promise: Promise<unknown>, why: string): Promise<Error> {
  let outcome: unknown;
  try {
    outcome = await promise;
  } catch (error) {
    expect(error, why).toBeInstanceOf(Error);
    return error as Error;
  }
  expect.fail(`${why}, but the runner resolved: ${JSON.stringify(outcome)}`);
}

function ids(rows: { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

/** Postgres refusing CONCURRENTLY inside BEGIN, or the runner refusing it up front and pointing at the marker. */
const IN_TRANSACTION = /cannot run inside a transaction block|no-transaction/i;

// ---------------------------------------------------------------------------
// 1. Marked files run outside a transaction.
// ---------------------------------------------------------------------------

describe('1. a file marked on its first line runs outside a transaction', () => {
  it('applies CREATE INDEX CONCURRENTLY, leaving a valid index and a record', async () => {
    const s = await withWidget();
    s.write(
      '0002_marked.sql',
      `${MARKER}\nCREATE INDEX CONCURRENTLY widget_name_idx ON widget (name);\n`,
    );

    const result = await s.run();

    expect(result.applied).toEqual(['0002_marked']);
    expect(await s.index('widget_name_idx'), 'the index must exist').toEqual({ valid: true });
    expect(ids(await s.recorded())).toEqual(['0001_widget', '0002_marked']);
  });

  it('sends statements one at a time: two CONCURRENTLY builds in one file both apply', async () => {
    // One query string with two statements is an implicit transaction in
    // Postgres. A runner that only drops its BEGIN fails here.
    const s = await withWidget();
    s.write(
      '0002_marked.sql',
      `${MARKER}\n` +
        `CREATE INDEX CONCURRENTLY widget_name_idx ON widget (name);\n` +
        `CREATE INDEX CONCURRENTLY widget_id_name_idx ON widget (id, name);\n`,
    );

    const result = await s.run();

    expect(result.applied).toEqual(['0002_marked']);
    expect(await s.index('widget_name_idx')).toEqual({ valid: true });
    expect(await s.index('widget_id_name_idx')).toEqual({ valid: true });
  });

  it('accepts every allowlisted form, with commentary around the statements', async () => {
    // Real migrations carry a header explaining themselves. A marked file must
    // be allowed one, and comments between statements, without tripping the
    // allowlist.
    const s = await withWidget();
    await s.query('CREATE INDEX widget_old_idx ON widget (id, name)');
    s.write(
      '0002_marked.sql',
      `${MARKER}\n` +
        `-- D-L65: hot table, so the index is built CONCURRENTLY and the check\n` +
        `-- added NOT VALID in 0001 is validated here, under SHARE UPDATE EXCLUSIVE.\n` +
        `\n` +
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS widget_name_uq ON widget (name);\n` +
        `\n` +
        `-- the old index is superseded\n` +
        `DROP INDEX CONCURRENTLY IF EXISTS widget_old_idx;\n` +
        `ALTER TABLE widget VALIDATE CONSTRAINT widget_name_present;\n`,
    );

    const result = await s.run();

    expect(result.applied).toEqual(['0002_marked']);
    expect(await s.index('widget_name_uq')).toEqual({ valid: true });
    expect(
      await s.index('widget_old_idx'),
      'DROP INDEX CONCURRENTLY must have run',
    ).toBeUndefined();
    const constraint = await s.query<{ validated: boolean }>(
      `SELECT convalidated AS validated FROM pg_constraint
        WHERE conname = 'widget_name_present' AND connamespace = $1::regnamespace`,
      [s.schema],
    );
    expect(constraint[0]?.validated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Unmarked files stay transactional. (Passes on main: existing behaviour.)
// ---------------------------------------------------------------------------

describe('2. an unmarked file is still one transaction', () => {
  it('fails CREATE INDEX CONCURRENTLY, records nothing and leaves no index', async () => {
    const s = await withWidget();
    s.write('0002_unmarked.sql', 'CREATE INDEX CONCURRENTLY widget_name_idx ON widget (name);\n');

    const error = await rejection(s.run(), 'CONCURRENTLY in an unmarked file must fail');

    // Either Postgres's own refusal, or the runner refusing up front and
    // pointing at the marker. Both keep the file transactional.
    expect(error.message).toMatch(/0002_unmarked/);
    expect(error.message).toMatch(IN_TRANSACTION);
    expect(ids(await s.recorded())).toEqual(['0001_widget']);
    expect(await s.index('widget_name_idx')).toBeUndefined();
  });

  it('rolls back every statement of a multi-statement file that fails midway', async () => {
    // Know what this catches. Today's runner sends the file as one string, and
    // Postgres makes that an implicit transaction even without BEGIN, so
    // deleting only the BEGIN leaves this green. It goes red (checked by hand
    // against a sabotaged runner) once statements are sent one by one without
    // a transaction, which is the regression T-0044's splitting invites.
    const s = await withWidget();
    s.write(
      '0002_unmarked.sql',
      `CREATE TABLE gadget (id integer PRIMARY KEY);\n` +
        `UPDATE widget SET name = 'changed';\n` +
        `CREATE INDEX widget_name_idx ON widget (name);\n` +
        `SELECT 1 / 0;\n`,
    );

    const error = await rejection(s.run(), 'division by zero must fail the file');

    expect(error.message).toMatch(/0002_unmarked/);
    expect(await s.exists('gadget'), 'CREATE TABLE must have been rolled back').toBe(false);
    expect(await s.index('widget_name_idx')).toBeUndefined();
    const changed = await s.query<{ n: string }>(
      `SELECT count(*) AS n FROM widget WHERE name = 'changed'`,
    );
    expect(changed[0]?.n, 'UPDATE must have been rolled back').toBe('0');
    expect(ids(await s.recorded())).toEqual(['0001_widget']);
  });
});

// ---------------------------------------------------------------------------
// 3. A marked file may contain only the allowlist; anything else is refused
//    before any of the file runs.
// ---------------------------------------------------------------------------

/**
 * Every case starts with an allowed CONCURRENTLY build and puts the forbidden
 * statement after it, so a runner that executes statements until it meets a
 * bad one is caught by the index still existing. Refusal must come first.
 */
const FORBIDDEN: readonly { name: string; sql: string }[] = [
  { name: 'CREATE TABLE', sql: 'CREATE TABLE smuggled (id integer);' },
  { name: 'UPDATE', sql: "UPDATE widget SET name = 'changed';" },
  { name: 'GRANT', sql: 'GRANT SELECT ON widget TO kasuwa_app;' },
  { name: 'DROP TABLE', sql: 'DROP TABLE widget;' },
  { name: 'a non-concurrent CREATE INDEX', sql: 'CREATE INDEX widget_plain_idx ON widget (id);' },
  {
    name: 'ALTER TABLE ... ADD CONSTRAINT',
    sql: 'ALTER TABLE widget ADD CONSTRAINT widget_id_positive CHECK (id > 0) NOT VALID;',
  },
  {
    // Valid SQL. A prefix match on "ALTER TABLE ... VALIDATE CONSTRAINT" admits it.
    name: 'VALIDATE CONSTRAINT with a second ALTER TABLE action riding along',
    sql: 'ALTER TABLE widget VALIDATE CONSTRAINT widget_name_present, DROP COLUMN name;',
  },
  { name: 'a DO block', sql: "DO $$ BEGIN UPDATE widget SET name = 'changed'; END $$;" },
  {
    name: 'explicit transaction control',
    sql: "BEGIN;\nUPDATE widget SET name = 'changed';\nCOMMIT;",
  },
  { name: 'SET, which would persist for the rest of the run', sql: 'SET search_path TO public;' },
  { name: 'VACUUM', sql: 'VACUUM widget;' },
  {
    name: 'REINDEX CONCURRENTLY, which is not on the list',
    sql: 'REINDEX TABLE CONCURRENTLY widget;',
  },
];

describe('3. a marked file containing anything outside the allowlist is refused before it runs', () => {
  it.each(FORBIDDEN)('refuses $name', async ({ sql }) => {
    const s = await withWidget();
    s.write(
      '0002_marked.sql',
      `${MARKER}\nCREATE INDEX CONCURRENTLY widget_name_idx ON widget (name);\n${sql}\n`,
    );

    const error = await rejection(
      s.run(),
      'a forbidden statement in a marked file must be refused',
    );

    expect(error.message, 'the error must name the file').toMatch(/0002_marked/);
    expect(error.message, 'the error must name the rule').toMatch(/no-transaction/i);

    // Nothing in the file ran, including the allowed statement before it.
    expect(ids(await s.recorded())).toEqual(['0001_widget']);
    expect(await s.index('widget_name_idx'), 'the allowed statement ran first').toBeUndefined();
    expect(await s.index('widget_plain_idx')).toBeUndefined();
    expect(await s.exists('smuggled')).toBe(false);
    expect(await s.exists('widget')).toBe(true);
    const state = await s.query<{ untouched: string; validated: boolean; constraints: string }>(
      `SELECT
         (SELECT count(*) FROM widget WHERE name = 'w' || id) AS untouched,
         (SELECT convalidated FROM pg_constraint
           WHERE conname = 'widget_name_present' AND connamespace = $1::regnamespace) AS validated,
         (SELECT count(*) FROM pg_constraint
           WHERE conrelid = 'widget'::regclass AND contype = 'c') AS constraints`,
      [s.schema],
    );
    expect(state[0]).toEqual({ untouched: '200', validated: false, constraints: '1' });
  });

  it('refuses a forbidden statement sharing a line with an allowed one', async () => {
    // A line-based checker sees one line starting with CREATE INDEX CONCURRENTLY.
    const s = await withWidget();
    s.write(
      '0002_marked.sql',
      `${MARKER}\nCREATE INDEX CONCURRENTLY widget_name_idx ON widget (name); DELETE FROM widget;\n`,
    );

    const error = await rejection(s.run(), 'DELETE in a marked file must be refused');

    expect(error.message).toMatch(/0002_marked/);
    expect(error.message).toMatch(/no-transaction/i);
    expect(await s.index('widget_name_idx')).toBeUndefined();
    const rows = await s.query<{ n: string }>('SELECT count(*) AS n FROM widget');
    expect(rows[0]?.n).toBe('200');
    expect(ids(await s.recorded())).toEqual(['0001_widget']);
  });
});

// ---------------------------------------------------------------------------
// 4. A marked file that fails is not recorded, and can be re-run once fixed.
// ---------------------------------------------------------------------------

describe('4. a failed marked file is not recorded and can be re-run after cleanup', () => {
  it('a CONCURRENTLY unique build that hits duplicates is not recorded, stops the run, and re-runs once fixed', async () => {
    const s = await withWidget();
    await s.query(`UPDATE widget SET name = 'w1' WHERE id = 2`);
    s.write(
      '0002_marked.sql',
      `${MARKER}\nCREATE UNIQUE INDEX CONCURRENTLY widget_name_uq ON widget (name);\n`,
    );
    s.write('0003_after.sql', `COMMENT ON TABLE widget IS 'after';\n`);

    const error = await rejection(s.run(), 'a unique build over duplicate names must fail');

    // The real failure, not the transaction-block refusal main gives.
    expect(error.message).toMatch(/0002_marked/);
    expect(error.message).toMatch(/could not create unique index|duplicate key/i);
    expect(ids(await s.recorded()), 'neither the failed file nor a later one').toEqual([
      '0001_widget',
    ]);
    // Postgres leaves an INVALID index behind; a runner that drops it itself is
    // also fine. What must never happen is a VALID unique index here.
    expect((await s.index('widget_name_uq'))?.valid ?? false).toBe(false);

    // The documented cleanup: fix the cause, drop the INVALID index
    // CONCURRENTLY, run again. Autocommit, one statement per call.
    await s.query(`UPDATE widget SET name = 'w2' WHERE id = 2`);
    await s.query('DROP INDEX CONCURRENTLY IF EXISTS widget_name_uq');

    const retry = await s.run();

    expect(retry.applied).toEqual(['0002_marked', '0003_after']);
    expect(await s.index('widget_name_uq')).toEqual({ valid: true });
    const onDisk = loadMigrations(s.dir).find((migration) => migration.id === '0002_marked');
    const recorded = (await s.recorded()).find((row) => row.id === '0002_marked');
    expect(recorded?.checksum).toBe(onDisk?.checksum);
  });

  it('a file that fails on its second statement is not recorded; IF NOT EXISTS makes the re-run safe', async () => {
    // The first build has committed by the time the second fails. That is the
    // nature of the mode; the file must still be unrecorded so it runs again.
    const s = await withWidget();
    await s.query(`UPDATE widget SET name = 'w1' WHERE id = 2`);
    s.write(
      '0002_marked.sql',
      `${MARKER}\n` +
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS widget_id_name_idx ON widget (id, name);\n` +
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS widget_name_uq ON widget (name);\n`,
    );

    const error = await rejection(s.run(), 'the second build must fail on duplicates');

    expect(error.message).toMatch(/0002_marked/);
    expect(error.message).toMatch(/could not create unique index|duplicate key/i);
    expect(ids(await s.recorded())).toEqual(['0001_widget']);
    expect(await s.index('widget_id_name_idx'), 'the first statement ran').toEqual({ valid: true });

    await s.query(`UPDATE widget SET name = 'w2' WHERE id = 2`);
    await s.query('DROP INDEX CONCURRENTLY IF EXISTS widget_name_uq');

    const retry = await s.run();

    expect(retry.applied).toEqual(['0002_marked']);
    expect(await s.index('widget_id_name_idx')).toEqual({ valid: true });
    expect(await s.index('widget_name_uq')).toEqual({ valid: true });
  });

  it('the create-rls-migration skill points at the mode and documents INVALID index cleanup', () => {
    // A text check, and only that: it proves the words are there, not that
    // they are right. Review reads the prose.
    const skill = readFileSync(
      resolve(__dirname, '..', '..', '..', '.claude', 'skills', 'create-rls-migration', 'SKILL.md'),
      'utf8',
    );
    expect(skill).toContain(MARKER);
    expect(skill).toMatch(/INVALID/);
    expect(skill).toMatch(/DROP INDEX CONCURRENTLY/);
  });
});

// ---------------------------------------------------------------------------
// 5. Records, checksums and ordering are unchanged.
//    The first four use VALIDATE CONSTRAINT, which also works inside a
//    transaction, so they pass on main: existing behaviour that must survive.
// ---------------------------------------------------------------------------

const VALIDATE_FILE = `${MARKER}\nALTER TABLE widget VALIDATE CONSTRAINT widget_name_present;\n`;

describe('5. records, checksums and ordering are unchanged for marked files', () => {
  it('records the same sha256 checksum loadMigrations computes', async () => {
    const s = await withWidget();
    s.write('0002_marked.sql', VALIDATE_FILE);

    await s.run();

    const expected = loadMigrations(s.dir).map(({ id, checksum }) => ({ id, checksum }));
    expect(await s.recorded()).toEqual(expected);
  });

  it('a second run is a no-op', async () => {
    const s = await withWidget();
    s.write('0002_marked.sql', VALIDATE_FILE);
    await s.run();

    const again = await s.run();

    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(['0001_widget', '0002_marked']);
  });

  it('refuses to proceed when an applied marked file has been edited', async () => {
    const s = await withWidget();
    s.write('0002_marked.sql', VALIDATE_FILE);
    await s.run();

    s.write('0002_marked.sql', `${VALIDATE_FILE}-- an innocent comment\n`);

    const error = await rejection(s.run(), 'an edited applied file must be refused');
    expect(error.message).toMatch(/0002_marked/);
    expect(error.message).toMatch(/contents have changed/);
  });

  it('treats adding or removing the marker on an applied file as an edit', async () => {
    // The marker line is part of the checksum. Toggling it is how somebody
    // would try to "re-run that file the other way".
    const s = await withWidget();
    s.write('0002_marked.sql', VALIDATE_FILE);
    s.write('0003_plain.sql', 'ALTER TABLE widget VALIDATE CONSTRAINT widget_name_present;\n');
    await s.run();

    s.write('0002_marked.sql', 'ALTER TABLE widget VALIDATE CONSTRAINT widget_name_present;\n');
    const removed = await rejection(s.run(), 'removing the marker must count as an edit');
    expect(removed.message).toMatch(
      /0002_marked.*contents have changed|contents have changed.*0002_marked/s,
    );

    s.write('0002_marked.sql', VALIDATE_FILE);
    s.write('0003_plain.sql', VALIDATE_FILE);
    const added = await rejection(s.run(), 'adding the marker must count as an edit');
    expect(added.message).toMatch(
      /0003_plain.*contents have changed|contents have changed.*0003_plain/s,
    );
  });

  it('applies marked and unmarked files interleaved, in filename order', async () => {
    // 0003 comments on the index 0002 builds and 0004 drops it, so any
    // reordering fails. Fails on main: 0002 cannot run there.
    const s = await scratch();
    s.write('0001_widget.sql', WIDGET_TABLE);
    s.write(
      '0002_marked.sql',
      `${MARKER}\nCREATE INDEX CONCURRENTLY widget_name_idx ON widget (name);\n`,
    );
    s.write('0003_plain.sql', `COMMENT ON INDEX widget_name_idx IS 'built in 0002';\n`);
    s.write('0004_marked.sql', `${MARKER}\nDROP INDEX CONCURRENTLY widget_name_idx;\n`);

    const result = await s.run();

    expect(result.applied).toEqual(['0001_widget', '0002_marked', '0003_plain', '0004_marked']);
    expect(ids(await s.recorded())).toEqual(result.applied);
    expect(await s.index('widget_name_idx')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. The marker counts only as the exact first line.
// ---------------------------------------------------------------------------

const BUILD = 'CREATE INDEX CONCURRENTLY widget_id_name_idx ON widget (id, name);';

const NOT_THE_MARKER: readonly { name: string; content: string }[] = [
  { name: 'on the second line, after a blank line', content: `\n${MARKER}\n${BUILD}\n` },
  {
    name: 'on the second line, after another comment',
    content: `-- add an index\n${MARKER}\n${BUILD}\n`,
  },
  {
    name: 'in the middle of the file',
    content: `COMMENT ON TABLE widget IS 'x';\n${MARKER}\n${BUILD}\n`,
  },
  { name: 'at the end of the file', content: `${BUILD}\n${MARKER}\n` },
  { name: 'indented', content: `  ${MARKER}\n${BUILD}\n` },
  { name: 'without the space after --', content: `--kasuwa:no-transaction\n${BUILD}\n` },
  { name: 'with a space after the colon', content: `-- kasuwa: no-transaction\n${BUILD}\n` },
  { name: 'in upper case', content: `-- KASUWA:NO-TRANSACTION\n${BUILD}\n` },
  { name: 'with an underscore', content: `-- kasuwa:no_transaction\n${BUILD}\n` },
  { name: 'without the hyphen', content: `-- kasuwa:notransaction\n${BUILD}\n` },
  { name: 'as a prefix of a longer word', content: `-- kasuwa:no-transactional\n${BUILD}\n` },
  { name: 'pluralised', content: `-- kasuwa:no-transactions\n${BUILD}\n` },
  { name: 'inside a longer comment', content: `-- not kasuwa:no-transaction\n${BUILD}\n` },
  { name: 'as a block comment', content: `/* kasuwa:no-transaction */\n${BUILD}\n` },
];

describe('6. only the exact marker on the first line opts a file out', () => {
  // Each case carries its own control: 0002 has the exact marker and must
  // apply, 0003 has the variant and must fail as a transactional file. Without
  // the control these would pass on main, where nothing is ever marked.
  it.each(NOT_THE_MARKER)('a marker $name leaves the file transactional', async ({ content }) => {
    const s = await withWidget();
    s.write(
      '0002_control.sql',
      `${MARKER}\nCREATE INDEX CONCURRENTLY widget_name_idx ON widget (name);\n`,
    );
    s.write('0003_variant.sql', content);

    const error = await rejection(s.run(), 'the variant must not be treated as marked');

    expect(error.message, 'the control (exact marker) must have applied first').toMatch(
      /0003_variant/,
    );
    expect(error.message).toMatch(IN_TRANSACTION);
    expect(ids(await s.recorded())).toEqual(['0001_widget', '0002_control']);
    expect(await s.index('widget_name_idx')).toEqual({ valid: true });
    expect(await s.index('widget_id_name_idx')).toBeUndefined();
  });

  it('recognises the marker in a file checked out with CRLF line endings', async () => {
    // Windows checkouts. The runner already normalises CRLF for the checksum;
    // the marker must survive the same checkout.
    const s = await withWidget();
    s.write(
      '0002_marked.sql',
      `${MARKER}\r\nCREATE INDEX CONCURRENTLY widget_name_idx ON widget (name);\r\n`,
    );

    const result = await s.run();

    expect(result.applied).toEqual(['0002_marked']);
    expect(await s.index('widget_name_idx')).toEqual({ valid: true });
  });
});
