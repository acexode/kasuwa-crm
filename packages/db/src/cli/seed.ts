import { env } from '@kasuwa/config';
import { runSeed } from '../seed';

async function main(): Promise<void> {
  const url = env().DATABASE_MIGRATION_URL;
  if (!url) {
    throw new Error('DATABASE_MIGRATION_URL is not set. The seed runs as kasuwa_migrator.');
  }
  await runSeed({ connectionString: url, log: (m) => process.stdout.write(m + '\n') });
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
