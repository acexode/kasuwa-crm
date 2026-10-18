import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Client } from 'pg';
import { runMigrations, runSeed } from '@kasuwa/db';

/**
 * Real Postgres and Redis for integration and isolation tests.
 *
 * Postgres is not mocked and never will be. The entire tenancy model is RLS
 * policies evaluated by Postgres against session GUCs — a mock would assert
 * that our beliefs about our own code are self-consistent, which is exactly the
 * failure mode Addendum 3.1 warns about. If the database is not real, the
 * isolation suite tests nothing.
 *
 * The container runs the same two bootstrap files docker-compose runs, in the
 * same order, so roles and grants are identical in dev and CI:
 * packages/db/sql/bootstrap.sql (what real provisioning applies, with
 * kasuwa_test_admin an inert NOLOGIN placeholder), then bootstrap-test.sql,
 * which makes kasuwa_test_admin the BYPASSRLS login `testAdminUrl` names
 * (T-0117, D-L94). Only this harness and docker-compose apply the second file.
 */

const POSTGRES_IMAGE = 'postgres:16-alpine';
const REDIS_IMAGE = 'redis:7-alpine';
const DATABASE_NAME = 'kasuwa';
const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'postgres';

export interface TestStack {
  /** Connection string for kasuwa_app — NOBYPASSRLS. What the API uses. */
  databaseUrl: string;
  /**
   * Connection string for kasuwa_auth — NOBYPASSRLS, a member of no role. The
   * API's auth pool, and the only role that may write the auth tables (T-0049).
   */
  authDatabaseUrl: string;
  /**
   * Connection string for kasuwa_relay — NOBYPASSRLS, a member of no role. The
   * outbox relay's pool (T-0098, ADR-0018): undispatched and expired outbox
   * rows in every tenant, and nothing else.
   */
  relayDatabaseUrl: string;
  /** Connection string for kasuwa_migrator — owns the schema, BYPASSRLS. */
  migrationUrl: string;
  /** Connection string for kasuwa_test_admin — test setup and catalogue reads. */
  testAdminUrl: string;
  redisUrl: string;
  stop: () => Promise<void>;
}

/** In the order they must run: the file a real cell gets, then the test login. */
const BOOTSTRAP_FILES = ['bootstrap.sql', 'bootstrap-test.sql'] as const;

function bootstrapSql(file: (typeof BOOTSTRAP_FILES)[number]): string {
  // packages/testing/src -> packages/db/sql/<file>
  const path = resolve(__dirname, '..', '..', 'db', 'sql', file);
  return readFileSync(path, 'utf8');
}

function urlFor(container: StartedPostgreSqlContainer, role: string, password: string): string {
  return `postgres://${role}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/${DATABASE_NAME}`;
}

export interface StartStackOptions {
  /** Seed the fixture data after migrating. Defaults to true. */
  seed?: boolean;
  /** Start Redis too. Defaults to false — most suites do not need it. */
  redis?: boolean;
}

export async function startTestStack(options: StartStackOptions = {}): Promise<TestStack> {
  const postgres: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(DATABASE_NAME)
    .withUsername(SUPERUSER)
    .withPassword(SUPERUSER_PASSWORD)
    // Durability is irrelevant for a container that lives for one test run, and
    // fsync dominates migration time.
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off'])
    .start();

  let redis: StartedRedisContainer | undefined;
  if (options.redis === true) {
    redis = await new RedisContainer(REDIS_IMAGE).start();
  }

  // Roles and grants, as superuser: bootstrap.sql, then bootstrap-test.sql.
  const superuserClient = new Client({
    connectionString: urlFor(postgres, SUPERUSER, SUPERUSER_PASSWORD),
  });
  await superuserClient.connect();
  try {
    for (const file of BOOTSTRAP_FILES) {
      await superuserClient.query(bootstrapSql(file));
    }
  } finally {
    await superuserClient.end();
  }

  const migrationUrl = urlFor(postgres, 'kasuwa_migrator', 'kasuwa_migrator_dev');
  await runMigrations({ connectionString: migrationUrl });
  if (options.seed !== false) {
    await runSeed({ connectionString: migrationUrl });
  }

  return {
    databaseUrl: urlFor(postgres, 'kasuwa_app', 'kasuwa_app_dev'),
    authDatabaseUrl: urlFor(postgres, 'kasuwa_auth', 'kasuwa_auth_dev'),
    relayDatabaseUrl: urlFor(postgres, 'kasuwa_relay', 'kasuwa_relay_dev'),
    migrationUrl,
    testAdminUrl: urlFor(postgres, 'kasuwa_test_admin', 'kasuwa_test_admin_dev'),
    redisUrl: redis?.getConnectionUrl() ?? '',
    stop: async () => {
      await redis?.stop();
      await postgres.stop();
    },
  };
}

/** Restores the fixture data. Call after any test that writes. */
export async function reseed(migrationUrl: string): Promise<void> {
  await runSeed({ connectionString: migrationUrl });
}
