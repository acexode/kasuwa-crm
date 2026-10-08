import {
  assertMigrationTargetIsSafe,
  effectiveDatabaseTarget,
  isLocalDatabaseHost,
  loadWorkspaceEnv,
  migratorEnv,
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
  const url = migratorEnv().DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error('DATABASE_MIGRATION_URL is not set.');
  }
  // The host pg will actually use (a `?host=` overrides the URL's, T-0117),
  // and never echoed. Then the runner's own target checks, BEFORE the drop:
  // runMigrations would refuse too, but only after this had dropped
  // everything.
  if (!isLocalDatabaseHost(effectiveDatabaseTarget(url, 'DATABASE_MIGRATION_URL').host)) {
    throw new Error('db:reset refuses to run against a non-local database host.');
  }
  assertMigrationTargetIsSafe(url);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Every table, including the authentication ones. A reset that leaves
    // stale password hashes and live session rows behind is not a reset, and a
    // half-dropped schema makes the next migration run fail on a table that
    // already exists.
    await client.query(
      'DROP TABLE IF EXISTS ' +
        'auth_rate_limit, auth_session, auth_challenge, user_mfa_backup_code, user_mfa_factor, ' +
        'user_credential, ' +
        'contact, account, user_programme, "user", programme, business_unit, tenant, ' +
        '_kasuwa_migration CASCADE',
    );
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
