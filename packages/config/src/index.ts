import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Environment loading for every Kasuwa process.
 *
 * Zod at the boundary (coding convention, CLAUDE.md): the process refuses to
 * start on an invalid environment rather than failing later with a confusing
 * runtime error. Nothing outside this package reads `process.env` directly —
 * a lint rule enforces that.
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
function findWorkspaceEnv(startDirectory: string = process.cwd()): string | undefined {
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

const envFile = findWorkspaceEnv();
// `override: false` (the default) means a real environment variable always wins
// over the file, which is what CI and containers rely on.
loadDotenv(envFile === undefined ? {} : { path: envFile });

const AuthMode = z.enum(['stub', 'jwt']);
export type AuthMode = z.infer<typeof AuthMode>;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  KASUWA_AUTH_MODE: AuthMode.default('stub'),

  DATABASE_URL: z.string().url(),
  DATABASE_MIGRATION_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(200).default(10),

  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  API_PORT: z.coerce.number().int().positive().default(3001),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  REALTIME_PORT: z.coerce.number().int().positive().default(3002),

  // NO LOCALE SETTINGS HERE. `@kasuwa/i18n` owns which languages exist and
  // which are offered, and it DERIVES the offered set from catalogue
  // completeness plus a named reviewer (D-P1, D-L27).
  //
  // A `SUPPORTED_LOCALES` environment variable used to sit here. It was unread
  // by anything, and it could widen the offered set past what the gate
  // considers finished — which is precisely the dishonest language menu the
  // gate exists to prevent, reachable by editing a deployment variable and
  // touching no code. Two sources of truth for the same fact, one of which can
  // lie silently. Removed rather than reconciled.
  //
  // If a deployment ever needs to offer fewer languages than are ready, that
  // is a feature flag, and it may only ever NARROW the derived set.
});

export type KasuwaEnv = z.infer<typeof EnvSchema>;

/**
 * Fail-closed guard for the stubbed auth context (team/DECISIONS.md D-L05).
 *
 * The stub resolves the caller from `x-kasuwa-*` request headers. That is safe
 * in development and required by the isolation tests, and catastrophic in
 * production. Refusing to boot is the only acceptable behaviour; there is a
 * unit test asserting this throws.
 */
export function assertAuthModeIsSafe(env: Pick<KasuwaEnv, 'NODE_ENV' | 'KASUWA_AUTH_MODE'>): void {
  if (env.NODE_ENV === 'production' && env.KASUWA_AUTH_MODE === 'stub') {
    throw new Error(
      'Refusing to start: KASUWA_AUTH_MODE=stub resolves the caller from request headers ' +
        'and must never run with NODE_ENV=production. See docs/adr/0007-stubbed-auth-context.md.',
    );
  }
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): KasuwaEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  assertAuthModeIsSafe(parsed.data);
  return parsed.data;
}

let cached: KasuwaEnv | undefined;

/** Memoised environment. Call `parseEnv` directly in tests to avoid the cache. */
export function env(): KasuwaEnv {
  cached ??= parseEnv();
  return cached;
}

/** Test helper: drop the memoised environment. */
export function resetEnvCache(): void {
  cached = undefined;
}
