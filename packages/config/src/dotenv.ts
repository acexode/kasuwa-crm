import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

/**
 * Loading the workspace `.env`, as an EXPLICIT CALL (T-0014).
 *
 * This used to happen as a side effect of importing `@kasuwa/config`. The
 * development `.env` holds `DATABASE_URL` and `DATABASE_MIGRATION_URL`, so any
 * process that imported the package for any reason, the web server included,
 * had both put into its own environment. A rule that says "the web process
 * must never hold a database URL" cannot sit on top of a module whose import
 * hands it one.
 *
 * So nothing loads `.env` unless an entry point asks. The server processes
 * (api, worker, realtime) and the operator commands (migrate, seed, reset,
 * tenant:provision) call `loadWorkspaceEnv()` first thing in their `main`.
 * The web process never does, and its entry point (`@kasuwa/config/web`)
 * does not even export this.
 */

/**
 * Find the workspace root's .env by walking up from the current directory.
 *
 * dotenv defaults to process.cwd(), which is the *package* directory whenever a
 * script runs through `pnpm --filter` or an Nx target - so `pnpm db:migrate`
 * would look in packages/db and find nothing. There is one .env for the whole
 * workspace; this makes every entry point agree on where it is.
 *
 * The walk stops at the directory holding pnpm-workspace.yaml so it cannot
 * wander above the repository and pick up an unrelated .env.
 */
function findWorkspaceEnv(startDirectory: string): string | undefined {
  let directory = resolve(startDirectory);

  for (;;) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    if (existsSync(join(directory, 'pnpm-workspace.yaml'))) {
      return undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/**
 * Load the workspace `.env` into `process.env`, if there is one. Returns the
 * file it loaded, or `undefined`. Safe to call more than once.
 *
 * `override: false` (dotenv's default) means a real environment variable always
 * wins over the file, which is what CI and containers rely on. In a deployed
 * container there is no `.env` above the working directory and this is a no-op.
 */
export function loadWorkspaceEnv(startDirectory: string = process.cwd()): string | undefined {
  const envFile = findWorkspaceEnv(startDirectory);
  if (envFile !== undefined) {
    loadDotenv({ path: envFile });
  }
  return envFile;
}
