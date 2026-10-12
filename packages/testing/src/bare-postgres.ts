import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * A Postgres 16 container with NOTHING applied: no bootstrap, no roles beyond
 * the superuser, no migrations.
 *
 * `startTestStack` always applies the role bootstrap before it hands anything
 * back, which is right for every suite that wants "a database like the
 * harness's". A suite that is ABOUT the bootstrap (which roles a real cell
 * gets, T-0117) has to choose which bootstrap files run, and roles are
 * cluster-wide, so a fresh database inside the shared container cannot show a
 * role's absence. This starts its own cluster and leaves every choice to the
 * caller.
 *
 * Same image, database name, superuser and durability settings as
 * `startTestStack`, so that a difference between the two is only ever the
 * bootstrap the caller applied. `bootstrap.sql` names the database `kasuwa`
 * literally, which is why the name is fixed.
 */

const POSTGRES_IMAGE = 'postgres:16-alpine';
const DATABASE_NAME = 'kasuwa';
const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'postgres';

export interface BarePostgres {
  /** The superuser, on the `kasuwa` database. Bootstrap files run as this. */
  superuserUrl: string;
  /** A connection string for any role, on the `kasuwa` database. */
  urlFor: (role: string, password: string) => string;
  stop: () => Promise<void>;
}

export async function startBarePostgres(): Promise<BarePostgres> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(DATABASE_NAME)
    .withUsername(SUPERUSER)
    .withPassword(SUPERUSER_PASSWORD)
    .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off'])
    .start();

  const urlFor = (role: string, password: string): string =>
    `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${container.getHost()}:` +
    `${container.getMappedPort(5432)}/${DATABASE_NAME}`;

  return {
    superuserUrl: urlFor(SUPERUSER, SUPERUSER_PASSWORD),
    urlFor,
    stop: async () => {
      await container.stop();
    },
  };
}
