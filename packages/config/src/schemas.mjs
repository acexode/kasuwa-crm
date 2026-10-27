// @ts-check
import { z } from 'zod';
import {
  assertAuthModeIsSafe,
  assertKeyProviderIsSafe,
  assertSessionCookieIsSafe,
  assertThrottleIsNotACellWideCliff,
} from './guards.mjs';

/**
 * One environment schema per process, over a shared base (T-0014, D-P8).
 *
 * Each process parses exactly what it reads and nothing else, and fails at
 * boot on what it needs: a missing `DATABASE_URL` stops the API and is
 * irrelevant to the web build. Before this, one schema demanded a database
 * URL of every process, which pushed the web process (the one that must never
 * hold one) outside the rule entirely.
 *
 * THIS MODULE LOADS NOTHING. It does not touch `.env` and it reads
 * `process.env` only as the default argument. Loading the workspace `.env` is
 * an explicit call a server entry point makes (`loadWorkspaceEnv`, in
 * `./dotenv.ts`), so that importing a schema can never put a database URL into
 * a process that did not ask for one. See the note at the top of `./web.mjs`.
 *
 * WHY THIS IS JAVASCRIPT, type-checked by TypeScript through `@ts-check` under
 * the workspace's strict settings: `apps/web/next.config.mjs` imports the web
 * schema, and Next loads that file with a native `import()` (it transpiles only
 * a config named `next.config.ts`, and the acceptance suite pins the `.mjs`).
 * Node 22.16 cannot import TypeScript (ERR_UNKNOWN_FILE_EXTENSION), so the web
 * schema, the base it shares and the guard it runs have to be JavaScript that
 * Node runs as-is. All the schemas live in this one module so that every zod
 * object comes from one zod instance, whichever module system loads it.
 *
 * Every schema runs `assertAuthModeIsSafe`. That is the one invariant here that
 * a refactor must not lose: it is what stops header-based stub auth booting
 * under NODE_ENV=production, and `KASUWA_AUTH_MODE` sits in the base schema,
 * with its `stub` default, so that no process can opt out of it by leaving the
 * field off ("this process does not do auth").
 */

/** A plain environment object. `process.env` is one. */
/** @typedef {Readonly<Record<string, string | undefined>>} EnvSource */

const NodeEnv = z.enum(['development', 'test', 'production']).default('development');

// --- base: what every process needs ----------------------------------------

const baseShape = {
  NODE_ENV: NodeEnv,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Read by the API; present in EVERY process so that every process runs the
  // stub-auth guard on it. The default is `stub`, so leaving it unset in
  // production refuses to boot, in every process. That is intended.
  KASUWA_AUTH_MODE: z.enum(['stub', 'jwt']).default('stub'),

  // --- observability (T-0005) ----------------------------------------------
  // The cell this process belongs to (`za-1`, a Silo tenant's own cell, ...).
  // Recorded as the `cell` attribute on every API span, so a trace can be
  // scoped to a deployment during an incident without anything that names a
  // person. A short lowercase slug, never free text: it lands in every span.
  KASUWA_CELL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/u)
    .default('local'),
};

// --- api -------------------------------------------------------------------

const ApiSchema = z.object({
  ...baseShape,

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
  // refuses to boot on it in production, and the provider itself refuses to be
  // constructed there — two layers, because the first can be skipped by
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

  // kasuwa_app: no BYPASSRLS, no DDL. The API's only connection. The migrator
  // URL is deliberately NOT here: no app process may hold it (D-L07, D-L54).
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(200).default(10),

  // kasuwa_auth: no BYPASSRLS, a member of no role. The ONLY role that may
  // write the auth tables (D-P16, T-0049, ADR-0013), used by the API's auth
  // module through its own pool and by nothing else. Required: without it no
  // sign-in can be recorded, so the API refuses to boot rather than 42501 on
  // the first one. API only - the worker's sweep runs as kasuwa_app entering
  // kasuwa_sweeper (D-L66) and needs none; the web process refuses it below.
  DATABASE_AUTH_URL: z.string().url(),

  API_PORT: z.coerce.number().int().positive().default(3001),

  // Where the import API enqueues its BullMQ jobs (T-0094). Optional: without
  // it the import writes answer 503 and every other route is unaffected.
  REDIS_URL: z.string().url().optional(),

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
/** @typedef {z.infer<typeof ApiSchema>} ApiEnv */

// --- worker ----------------------------------------------------------------

const WorkerSchema = z.object({
  ...baseShape,
  // BullMQ's connection.
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // kasuwa_app: no BYPASSRLS, no DDL - the same role and the same rule as the
  // API (D-L07, D-L54). Required since T-0045, whose auth-table prune is the
  // worker's first database job, so a worker without it fails at boot. The
  // migrator URL is deliberately NOT here: the prune runs as kasuwa_app and
  // enters the NOBYPASSRLS `kasuwa_sweeper` role (D-L66), and no app process
  // may hold the BYPASSRLS connection. Zod strips an unknown key, so a stray
  // DATABASE_MIGRATION_URL in the environment never reaches the worker.
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(200).default(2),

  // kasuwa_relay: no BYPASSRLS, a member of no role (ADR-0018, T-0098). The
  // outbox relay's own small pool, and the only connection in any process
  // that reaches undispatched events across tenants, so it belongs to this
  // process alone: every other schema refuses it by presence
  // (RELAY_FORBIDDEN below). Required: without it no event is ever
  // published. The worker checks at boot that it logs in as kasuwa_relay.
  DATABASE_RELAY_URL: z.string().url(),

  // GUARDS: the worker holds a database connection now, so it runs the
  // key-provider guard as `apiEnv` does (the rule this comment used to state
  // for that day). Only the provider is read: no worker job encrypts or
  // decrypts yet, so the worker holds no key id and no local master key. The
  // first job that does must add those fields beside this one.
  KASUWA_KMS_PROVIDER: z.enum(['local', 'aws-kms']).default('local'),
});
/** @typedef {z.infer<typeof WorkerSchema>} WorkerEnv */

// --- realtime --------------------------------------------------------------

const RealtimeSchema = z.object({
  ...baseShape,
  REALTIME_PORT: z.coerce.number().int().positive().default(3002),

  // kasuwa_app: the same role and the same rule as the API and the worker
  // (D-L07, D-L54). The gateway resolves a session through the existing
  // `app.resolve_session` and reads scope in a tenant transaction (T-0160,
  // ADR-0020): no `kasuwa_auth`, no migrator, no relay URL. Required, so a
  // gateway that could not authenticate anyone refuses to boot instead of
  // refusing every socket: that is `realtimeServeEnv`, which the process
  // calls. The base schema keeps both optional, because other processes' guards
  // and tests parse `realtimeEnv` without a database (T-0160).
  DATABASE_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(50).default(5),

  // The event seam (ADR-0020): Redis pub/sub, ids only.
  REDIS_URL: z.string().url().optional(),

  // The one web origin a BROWSER may connect from, exactly as it sends `Origin`
  // (scheme, host and port, lowercase, no path). Optional: without it a cookie
  // never authenticates a socket, and only Bearer clients connect.
  REALTIME_ALLOWED_ORIGIN: z.string().superRefine(refineOrigin).optional(),

  // How often a live socket's session and scope are re-read. "Fixed at connect"
  // must not mean a revoked user keeps receiving.
  REALTIME_REVALIDATE_SECONDS: z.coerce.number().int().min(1).max(300).default(30),

  // The relaxed cookie name, development and test only (assertSessionCookieIsSafe).
  KASUWA_SESSION_COOKIE_INSECURE: z.string().optional(),
});
/** @typedef {z.infer<typeof RealtimeSchema>} RealtimeEnv */

// --- operator commands: migrate, seed, reset, tenant:provision -------------

const MigratorSchema = z.object({
  ...baseShape,
  // kasuwa_migrator (BYPASSRLS). For operator commands only (D-L07, D-L54).
  // Optional here so that each command can say, in its own words, why it
  // needs it.
  DATABASE_MIGRATION_URL: z.string().url().optional(),
});
/** @typedef {z.infer<typeof MigratorSchema>} MigratorEnv */

// --- web -------------------------------------------------------------------

/**
 * A bare origin: `http:` or `https:`, a host, an optional port, and nothing
 * else (no userinfo, no path, no query, no fragment), written exactly as a
 * browser writes an `Origin` header. The issue messages never quote the
 * value: an operator who pastes a credential-bearing URL here must not find
 * it echoed in a boot log.
 *
 * @param {string} value
 * @param {z.RefinementCtx} context
 * @returns {void}
 */
function refineOrigin(value, context) {
  let url;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an absolute http(s) URL' });
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be http: or https:' });
    return;
  }
  if (url.username !== '' || url.password !== '') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must not carry credentials' });
    return;
  }
  if (value !== url.origin) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'must be a bare origin (scheme://host[:port], lowercase, no path, query or trailing slash)',
    });
  }
}


const WebSchema = z.object({
  ...baseShape,

  // THE BROWSER SESSION LAYER (ADR-0019, T-0125). All three are server-side
  // only: no `NEXT_PUBLIC_` name, so none is ever inlined into a bundle. The
  // browser never needs the API's address; it talks to its own origin, and the
  // BFF route handler (`app/api/v1/[...path]`) talks to the API.
  //
  // KASUWA_WEB_ORIGIN: this process's OWN origin, exactly as a browser sends
  // it in `Origin` (scheme, host and port; lowercase; no path, no trailing
  // slash, no userinfo). The CSRF check compares `Origin` with this and with
  // nothing else, never with `Host` or `X-Forwarded-Host` (point 4).
  // Required in every mode (amendment 3).
  KASUWA_WEB_ORIGIN: z.string().superRefine(refineOrigin),

  // KASUWA_API_INTERNAL_URL: where the BFF sends `/api/v1/*`, server-side,
  // with the session as `Authorization: Bearer` (point 1). It replaces the
  // `/api/v1` rewrite and `NEXT_PUBLIC_API_URL`. Read at runtime, so a build
  // is no longer tied to one API origin. An origin, with no credentials.
  // Required in every mode (amendment 3); https outside development and test
  // unless loopback (assertSessionCookieIsSafe).
  KASUWA_API_INTERNAL_URL: z.string().superRefine(refineOrigin),

  // KASUWA_SESSION_COOKIE_INSECURE: "1" drops `Secure` and the `__Host-`
  // prefix, for a browser that will not store a Secure cookie on
  // http://localhost. Development and test only; its presence refuses boot
  // anywhere else (point 8). A string, not a boolean, because presence is
  // the test and coercion would lose an empty value.
  KASUWA_SESSION_COOKIE_INSECURE: z.string().optional(),

  // Server-side only (no `NEXT_PUBLIC_` prefix): read by `next.config.mjs` and
  // never inlined. HARNESS-ONLY: a second dev server in the same checkout gets
  // its own build directory and generated tsconfig (T-0007). Unset, both are
  // Next's defaults.
  KASUWA_WEB_DIST_DIR: z.string().min(1).max(128).default('.next'),
  KASUWA_WEB_TSCONFIG: z.string().min(1).max(128).default('tsconfig.json'),

  // Server-side only. The object store's PUBLIC origin, the host signed into
  // the browser's presigned upload URLs (T-0092, ADR-0017): the one storage
  // setting the web process may hold, because a CSP `connect-src` must name it
  // (ADR-0019's build, T-0096). Never the internal S3_ENDPOINT and never the
  // keys: both are in WEB_FORBIDDEN below.
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
});
/** @typedef {z.infer<typeof WebSchema>} WebEnv */

/**
 * The BUILD's view of the same schema: the two session-layer URLs are optional
 * there, because `next build` serves no request and the artefact is started
 * later, under the runtime environment, where `webEnv()` requires them. When
 * given, they are still checked for shape.
 */
const WebBuildSchema = WebSchema.extend({
  KASUWA_WEB_ORIGIN: WebSchema.shape.KASUWA_WEB_ORIGIN.optional(),
  KASUWA_API_INTERNAL_URL: WebSchema.shape.KASUWA_API_INTERNAL_URL.optional(),
});
/** @typedef {z.infer<typeof WebBuildSchema>} WebBuildEnv */

/**
 * Names the web process must not be GIVEN, not merely need not read.
 *
 * Zod's `object()` strips unknown keys without complaint, so a schema that
 * simply omitted these would tolerate them, and a schema that tolerates a
 * database URL invites someone to set one. A browser-facing process holding a
 * database URL is the mistake the whole rule exists to prevent; the migrator
 * URL (BYPASSRLS, D-L07, D-L54) is the worst version of it.
 *
 * The rest are the other server-side credentials and internal endpoints the
 * development `.env` carries: the local KMS master key, the object-store
 * credentials and internal endpoint, and the Redis and OpenSearch URLs. None
 * is read by the web process, and each is something a browser-facing process
 * should not hold.
 *
 * Presence is the test, not validity: an empty `DATABASE_URL=` is refused too.
 * The value is never echoed.
 */
const WEB_FORBIDDEN = [
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_AUTH_URL',
  'DATABASE_RELAY_URL',
  'KASUWA_KMS_LOCAL_MASTER_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  // The internal object-store host (T-0092 R9): the browser reaches the store
  // only through S3_PUBLIC_ENDPOINT.
  'S3_ENDPOINT',
  'REDIS_URL',
  'OPENSEARCH_URL',
];

/**
 * The relay's connection (ADR-0018 point 11, D-L156). Only the worker may
 * hold it; the API, realtime and the operator commands refuse it by presence,
 * as the web process does (WEB_FORBIDDEN). Presence is the test, so an empty
 * value is refused too, and the value is never echoed. It also means the
 * variable can never go into the shared `.env`, which every server process
 * loads: `tools/dev.mjs` hands it to the worker alone.
 */
const RELAY_FORBIDDEN = ['DATABASE_RELAY_URL'];

/**
 * @param {string} processName
 * @param {EnvSource} source
 * @returns {string[]}
 */
function relayProblems(processName, source) {
  return RELAY_FORBIDDEN.filter((name) => source[name] !== undefined).map(
    (name) =>
      `  ${name}: must not be set for the ${processName} process. It is the outbox relay's ` +
      'cross-tenant connection and belongs to apps/worker alone (ADR-0018). Remove it from ' +
      'this process environment.',
  );
}

// --- parsing ---------------------------------------------------------------

/**
 * @param {z.ZodError} error
 * @returns {string[]}
 */
function describeIssues(error) {
  // Path and message only, and never the input. Zod's URL, string, regex and
  // number messages do not include the value, but its enum message does
  // ("Invalid enum value. Expected 'a' | 'b', received '<input>'"), so enum
  // issues are rewritten from their options alone. An operator who pastes a
  // secret into the wrong variable must not find it echoed in a boot log.
  return error.issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    const message =
      issue.code === 'invalid_enum_value'
        ? `must be one of ${issue.options.map((option) => `'${String(option)}'`).join(' | ')}`
        : issue.message;
    return `  ${path}: ${message}`;
  });
}

/**
 * @template {z.ZodTypeAny} S
 * @param {string} processName
 * @param {S} schema
 * @param {EnvSource} source
 * @param {readonly string[]} [extraProblems]
 * @returns {z.infer<S>}
 */
function parseOrThrow(processName, schema, source, extraProblems = []) {
  const parsed = schema.safeParse(source);
  const problems = [...extraProblems, ...(parsed.success ? [] : describeIssues(parsed.error))];
  if (problems.length > 0 || !parsed.success) {
    throw new Error(`Invalid ${processName} environment:\n${problems.join('\n')}`);
  }
  return parsed.data;
}

/**
 * @param {EnvSource} source
 * @returns {string[]}
 */
function webProblems(source) {
  return WEB_FORBIDDEN.filter((name) => source[name] !== undefined).map(
    (name) =>
      `  ${name}: must not be set for the web process. It is browser-facing and must never ` +
      'hold a database connection string or a server credential (T-0014). Remove it from ' +
      'this process environment.',
  );
}

/**
 * The API process. Requires `DATABASE_URL` and `DATABASE_AUTH_URL` (T-0049);
 * runs all three boot guards.
 *
 * @param {EnvSource} [source]
 * @returns {ApiEnv}
 */
export function apiEnv(source = process.env) {
  const parsed = parseOrThrow('api', ApiSchema, source, relayProblems('api', source));
  assertAuthModeIsSafe(parsed);
  assertKeyProviderIsSafe(parsed);
  assertThrottleIsNotACellWideCliff(parsed);
  return parsed;
}

/**
 * The BullMQ worker process. Requires `DATABASE_URL` (kasuwa_app) since
 * T-0045 and `DATABASE_RELAY_URL` (kasuwa_relay) since T-0098; runs the
 * stub-auth and key-provider guards.
 *
 * @param {EnvSource} [source]
 * @returns {WorkerEnv}
 */
export function workerEnv(source = process.env) {
  const parsed = parseOrThrow('worker', WorkerSchema, source);
  assertAuthModeIsSafe(parsed);
  assertKeyProviderIsSafe(parsed);
  return parsed;
}

/**
 * The WebSocket gateway process.
 *
 * @param {EnvSource} [source]
 * @returns {RealtimeEnv}
 */
export function realtimeEnv(source = process.env) {
  const parsed = parseOrThrow('realtime', RealtimeSchema, source, relayProblems('realtime', source));
  assertAuthModeIsSafe(parsed);
  assertSessionCookieIsSafe({
    NODE_ENV: parsed.NODE_ENV,
    KASUWA_SESSION_COOKIE_INSECURE: parsed.KASUWA_SESSION_COOKIE_INSECURE,
    KASUWA_WEB_ORIGIN: parsed.REALTIME_ALLOWED_ORIGIN,
  });
  return parsed;
}

/**
 * Operator commands that run on the migrator connection.
 *
 * @param {EnvSource} [source]
 * @returns {MigratorEnv}
 */
export function migratorEnv(source = process.env) {
  const parsed = parseOrThrow('migrator', MigratorSchema, source, relayProblems('migrator', source));
  assertAuthModeIsSafe(parsed);
  return parsed;
}

/**
 * The web SERVER process (`next dev`, `next start`). Refuses a database URL
 * and runs the stub-auth guard, like every other process.
 *
 * @param {EnvSource} [source]
 * @returns {WebEnv}
 */
export function webEnv(source = process.env) {
  const parsed = parseOrThrow('web', WebSchema, source, webProblems(source));
  assertAuthModeIsSafe(parsed);
  assertSessionCookieIsSafe(parsed);
  return parsed;
}

/**
 * The web BUILD (`next build`). The same schema, and it refuses a database URL
 * just the same, because the build is where values are inlined into the
 * bundle.
 *
 * It does not run the stub-auth or session-cookie guards, and does not require
 * the session layer's two URLs (ADR-0019); those are the only differences. A
 * build is not a boot: it serves no request and resolves no caller, and the
 * artefact it produces is started later by `next start`, under the runtime
 * environment, where `webEnv` runs the guard before the server accepts a
 * connection. Running it here as well would make every production build
 * demand a runtime auth setting it never uses (and CI builds with none).
 *
 * @param {EnvSource} [source]
 * @returns {WebBuildEnv}
 */
export function webBuildEnv(source = process.env) {
  return parseOrThrow('web build', WebBuildSchema, source, webProblems(source));
}

/**
 * NODE_ENV alone, without parsing the rest of the environment.
 *
 * Exists so that a library can refuse to run in production without demanding a
 * whole process schema. Callers today: the development key provider's
 * production guard and the API's default channel provider.
 *
 * @param {EnvSource} [source]
 * @returns {import('./guards.mjs').NodeEnvName}
 */
export function nodeEnv(source = process.env) {
  return NodeEnv.parse(source.NODE_ENV);
}
