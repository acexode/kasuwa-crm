import { env } from '@kasuwa/config';
import { runMigrations } from '../migrate';

async function main(): Promise<void> {
  const url = env().DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error(
      'DATABASE_MIGRATION_URL is not set. Migrations run as kasuwa_migrator, never as kasuwa_app.',
    );
  }
  const result = await runMigrations({
    connectionString: url,
    log: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(
    `migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already up to date\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
