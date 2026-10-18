import {
  assertExplicitNodeEnv,
  assertMigrationTargetIsSafe,
  effectiveDatabaseTarget,
  loadWorkspaceEnv,
  migratorEnv,
  namesLocalDatabaseHost,
} from '@kasuwa/config';
import { Client } from 'pg';
import { runMigrations } from '../migrate';
import { runSeed } from '../seed';

/**
 * Drops and rebuilds the local schema, then reseeds. Local development only -
 * it refuses to run against anything but a localhost database.
 *
 * Objects are dropped explicitly rather than by dropping the public schema:
 * kasuwa_migrator owns the tables but not the schema itself.
 */
async function main(): Promise<void> {
  loadWorkspaceEnv();
  // First, before any connection (D-L103): NODE_ENV must be set explicitly.
  assertExplicitNodeEnv('db:reset');
  const url = migratorEnv().DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error('DATABASE_MIGRATION_URL is not set.');
  }
  // The host the URL names, as pg reads it (a `?host=` overrides the URL's;
  // naming none is not local, T-0117), and never echoed. Then the runner's own target checks, BEFORE the drop:
  // runMigrations would refuse too, but only after this had dropped
  // everything.
  if (!namesLocalDatabaseHost(effectiveDatabaseTarget(url, 'DATABASE_MIGRATION_URL'))) {
    throw new Error('db:reset refuses to run against a non-local database host.');
  }
  // Development and test only (T-0117 review m4): a target the runner would
  // treat as real is refused here, before any DROP, not after it.
  if (assertMigrationTargetIsSafe(url).enforce) {
    throw new Error(
      'db:reset refuses to run outside development and test. Set NODE_ENV=development ' +
        '(or test) for a local database; nothing was dropped.',
    );
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Every table in public, from the catalogue (D-L152): a hard-coded list
    // went stale the day a migration added a table, and left a database at
    // head half-dropped. Includes the authentication tables and the migration
    // ledger; stale password hashes and live sessions are not a reset.
    const { rows } = await client.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
    );
    if (rows.length > 0) {
      await client.query(`DROP TABLE IF EXISTS ${rows.map((row) => row.name).join(', ')} CASCADE`);
    }
    await client.query('DROP SCHEMA IF EXISTS app CASCADE');
  } finally {
    await client.end();
  }

  await runMigrations({ connectionString: url, log: (m) => process.stdout.write(m + '\n') });
  await runSeed({ connectionString: url, log: (m) => process.stdout.write(m + '\n') });
}

main().catch((error: unknown) => {
  process.stderr.write((error as Error).message + '\n');
  process.exitCode = 1;
});
