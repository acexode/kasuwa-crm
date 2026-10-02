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

  // --- authentication policy (T-0001) ------------------------------------
  // Numbers, not behaviour. They are here rather than hard-coded so that an
  // operator can tighten them without a deploy, and so that the values a
  // deployment actually runs with are visible in one place at boot.
  //
  // The defaults are the ones the P01 design states: lock after five failed
  // attempts, for fifteen minutes, counting within a fifteen-minute window.
  // Raising the threshold to make a test pass would be moving a security
  // default to suit the code, which is the same mistake as editing the test.
  KASUWA_AUTH_LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(100).default(5),
  KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES: z.coerce.number().int().positive().max(1440).default(15),
  KASUWA_AUTH_LOCKOUT_MINUTES: z.coerce.number().int().positive().max(1440).default(15),

  // A second factor must be completed within ten minutes of the first, and may
  // be got wrong five times before the challenge is burned.
  KASUWA_AUTH_CHALLENGE_MINUTES: z.coerce.number().int().positive().max(60).default(10),
  KASUWA_AUTH_CHALLENGE_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),

  // Wrong codes allowed against one USER before their second factor locks,
  // across every challenge they open. This is the number that bounds what a
  // stolen password is worth: burning a single challenge bounds nothing,
  // because the attacker just opens another.
  KASUWA_AUTH_MFA_MAX_ATTEMPTS: z.coerce.number().int().positive().max(100).default(10),
  KASUWA_AUTH_MAX_OPEN_CHALLENGES: z.coerce.number().int().positive().max(50).default(3),

  // NOTE: there is deliberately no switch for single-use TOTP codes. One
  // existed briefly and was removed rather than left plumbed to nothing: an
  // operator reading this schema would have believed there was a way to turn
  // the control off, and there is not. Codes are single-use, always
  // (RFC 6238 section 5.2). A test suite that needs to sign one user in
  // repeatedly resets the fixture watermark with `resetSeededTotpUsage`.

  // Sign-in requests one client address may make per minute. A resource
  // control, not a credential one: argon2id costs 19 MiB per call and runs for
  // unknown addresses too, so an unbounded flood exhausts the cell for every
  // tenant on it.
  KASUWA_AUTH_SIGN_IN_PER_MINUTE: z.coerce.number().int().min(0).max(10_000).default(60),

  // Sign-in requests one client address may have IN FLIGHT at once. The
  // per-minute count above bounds how often; this bounds how many at a time,
  // which is what actually bounds argon2 slots and pool connections. A client
  // may legitimately spend a whole minute's allowance inside one second.
  KASUWA_AUTH_SIGN_IN_IN_FLIGHT: z.coerce.number().int().min(0).max(1_000).default(4),

  // How many reverse proxies sit in front of this process.
  //
  // 0 means "nothing is in front": the per-client throttle keys on the socket
  // peer, which is then the real client. Any other value means the Nth-from-last
  // entry of `X-Forwarded-For` is the client, and the hops closer than that are
  // ours and are not to be believed.
  //
  // It is a HOP COUNT rather than a boolean on purpose. "Trust the header" with
  // no count is the classic spoofable configuration — a caller sets
  // `X-Forwarded-For: 1.2.3.4` and picks their own rate-limit bucket.
  KASUWA_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(0),

  // The IANA zone a lockout's retry time is labelled with. ONE value per cell,
  // never per tenant: deriving it from the tenant made the response for a
  // workspace that does not exist differ from one that does, and disclosed the
  // hosting region of any workspace an attacker could name.
  KASUWA_CELL_TIME_ZONE: z.string().min(1).max(64).default('Africa/Lagos'),

  // --- observability (T-0005) ----------------------------------------------
  // The cell this process belongs to (`za-1`, a Silo tenant's own cell, ...).
  // Recorded as the `cell` attribute on every API span, so a trace can be
  // scoped to a deployment during an incident without anything that names a
  // person. A short lowercase slug, never free text: it lands in every span.
  KASUWA_CELL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/u)
    .default('local'),
  // Where spans and logs go. `none` installs nothing (the API calls are no-ops);
  // `console` writes them to stdout. There is no OTLP option yet because there
  // is no collector to send to (D-A4); adding one is a dependency and a
  // decision about where telemetry is hosted, which is an NDPA question.
  KASUWA_OTEL_EXPORTER: z.enum(['none', 'console']).default('none'),

  // PROVISIONAL, and flagged as such in team/reports/T-0001.md. Session
  // lifetime, refresh and concurrent-session policy are product decisions the
  // human has not made; twelve hours with no refresh is the conservative
  // reading of "a working day, and sign in again tomorrow".
  KASUWA_AUTH_SESSION_HOURS: z.coerce.number().int().positive().max(720).default(12),

  // --- envelope encryption (D-L13) ---------------------------------------
  // ONE KMS KEY PER ENVIRONMENT, and the key id is recorded on every encrypted
  // row so a rotation can introduce a second key without a flag day.
  //
  // `local` is the development provider: it holds its master key in process,
  // so it protects a stolen backup and nothing else. `assertKeyProviderIsSafe`
  // below refuses to boot on it in production, and the provider itself refuses
  // to be constructed there — two layers, because the first can be skipped by
  // building the provider directly.
  KASUWA_KMS_PROVIDER: z.enum(['local', 'aws-kms']).default('local'),
  /** The environment's key: an ARN or alias for aws-kms, an opaque name for local. */
  KASUWA_KMS_KEY_ID: z.string().min(1).max(512).optional(),
  /**
   * Base64 32-byte master key for the local provider. Optional: without it the
   * published development constant is used, which is what lets `pnpm db:seed`
   * and the API agree with no configuration at all. Never set in production —
   * production cannot use this provider.
   */
  KASUWA_KMS_LOCAL_MASTER_KEY: z.string().optional(),

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

/**
 * Fail-closed guard for envelope encryption (team/DECISIONS.md D-L13).
 *
 * The local key provider keeps its master key in the application process, next
 * to the ciphertext it protects. That is useful in development — it is what
 * makes a stolen backup useless — and it is not a key-management system. In
 * production the key must live in a KMS, which is the whole of the D-L13
 * answer, so the process refuses to start on the local provider there.
 *
 * Deliberately shaped like `assertAuthModeIsSafe`: same failure, same reason,
 * and one place to look for "what will stop a mis-configured production boot".
 */
export function assertKeyProviderIsSafe(
  env: Pick<KasuwaEnv, 'NODE_ENV' | 'KASUWA_KMS_PROVIDER'>,
): void {
  if (env.NODE_ENV === 'production' && env.KASUWA_KMS_PROVIDER === 'local') {
    throw new Error(
      'Refusing to start: KASUWA_KMS_PROVIDER=local holds its master key in this process ' +
        'and must never run with NODE_ENV=production. Set KASUWA_KMS_PROVIDER=aws-kms and ' +
        'KASUWA_KMS_KEY_ID to this environment’s KMS key. See team/DECISIONS.md D-L13.',
    );
  }
}

/**
 * NODE_ENV alone, without parsing the rest of the environment.
 *
 * Exists so that a library can refuse to run in production without demanding a
 * DATABASE_URL — `parseEnv` is all-or-nothing by design, and a test harness
 * that builds its own connection string has no reason to satisfy it. The one
 * caller today is the development key provider's production guard.
 *
 * Still the only package allowed to read process.env, which is the point.
 */
export function nodeEnv(): KasuwaEnv['NODE_ENV'] {
  return EnvSchema.shape.NODE_ENV.parse(process.env.NODE_ENV);
}

/**
 * The per-client sign-in throttle must not silently become a cell-wide ceiling.
 *
 * `SignInThrottleGuard` keys on the socket peer, so behind a load balancer
 * every request in the cell arrives from ONE address and shares ONE bucket. At
 * the shipped default of sixty a minute that is not a rate limit, it is an
 * availability cliff: the sixty-first legitimate sign-in in a minute — across
 * every tenant on the cell — gets a 429, and nothing in the logs says why.
 *
 * The guard's source comment has always been honest about this. A comment in a
 * source file is not a deployment control, which is the whole reason this
 * function exists: the process refuses to start in the configuration that
 * produces the outage, rather than producing it quietly.
 *
 * Two ways to satisfy it, and both are legitimate:
 *   - set KASUWA_TRUST_PROXY_HOPS, so the throttle keys on the real client; or
 *   - raise KASUWA_AUTH_SIGN_IN_PER_MINUTE above the cell-wide floor, i.e.
 *     accept that it is a crude global cap and size it like one.
 */
const CELL_WIDE_SIGN_IN_FLOOR = 600;

export function assertThrottleIsNotACellWideCliff(
  env: Pick<
    KasuwaEnv,
    'NODE_ENV' | 'KASUWA_TRUST_PROXY_HOPS' | 'KASUWA_AUTH_SIGN_IN_PER_MINUTE'
  >,
): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }
  if (env.KASUWA_TRUST_PROXY_HOPS > 0) {
    return;
  }
  if (env.KASUWA_AUTH_SIGN_IN_PER_MINUTE === 0) {
    // Explicitly disabled. A deliberate choice, and not this check's business.
    return;
  }
  if (env.KASUWA_AUTH_SIGN_IN_PER_MINUTE < CELL_WIDE_SIGN_IN_FLOOR) {
    throw new Error(
      'Refusing to start: KASUWA_TRUST_PROXY_HOPS is 0, so the sign-in throttle keys ' +
        'on the socket peer. Behind a load balancer that is ONE bucket for the whole ' +
        `cell, and KASUWA_AUTH_SIGN_IN_PER_MINUTE=${env.KASUWA_AUTH_SIGN_IN_PER_MINUTE} ` +
        `would then reject every tenant's sign-ins past that many per minute. Either ` +
        'set KASUWA_TRUST_PROXY_HOPS to the number of proxies in front of this process, ' +
        `or raise the limit above ${CELL_WIDE_SIGN_IN_FLOOR} and treat it as the ` +
        'cell-wide cap it would be.',
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
  assertKeyProviderIsSafe(parsed.data);
  assertThrottleIsNotACellWideCliff(parsed.data);
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
