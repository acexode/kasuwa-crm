import { loadWorkspaceEnv, migratorEnv } from '@kasuwa/config';
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
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error('db:reset refuses to run against a non-local host: ' + host);
  }

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
        'contact, user_programme, "user", programme, business_unit, tenant, ' +
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
