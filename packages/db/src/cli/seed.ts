import { env } from '@kasuwa/config';
import { runSeed } from '../seed';

/**
 * Seeds the local database. Local development only — it refuses to run against
 * anything but a localhost host, exactly as `db:reset` does.
 *
 * The guard is not hygiene, it is the difference between a fixture and a
 * credential. The seed installs five working users whose shared password and
 * TOTP secrets are committed to this repository and exported from
 * `@kasuwa/db`. Run against a shared environment, anyone who can read the
 * repository can sign in there with a valid second factor. The fixtures are
 * fine as fixtures; running them somewhere real is what makes them a way in.
 */
async function main(): Promise<void> {
  const url = env().DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error('DATABASE_MIGRATION_URL is not set. The seed runs as kasuwa_migrator.');
  }

  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(
      'db:seed refuses to run against a non-local host: ' +
        host +
        '. The seed installs users whose password and second-factor secrets are ' +
        'committed to the repository; running it anywhere shared publishes a way in.',
    );
  }

  await runSeed({ connectionString: url, log: (m) => process.stdout.write(m + '\n') });
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
