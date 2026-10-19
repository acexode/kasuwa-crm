/**
 * Environment parsing for every Kasuwa process.
 *
 * Zod at the boundary (coding convention, CLAUDE.md): a process refuses to
 * start on an invalid environment rather than failing later with a confusing
 * runtime error. Nothing outside this package reads `process.env` directly; a
 * lint rule enforces that, and so does the T-0014 acceptance suite.
 *
 * One schema per process (`apiEnv`, `workerEnv`, `realtimeEnv`, `webEnv`, and
 * `migratorEnv` for the operator commands), each over the same base, each
 * running the stub-auth guard. See `./schemas.mjs`. The API's and the worker's
 * also refuse the repository's dev database passwords and pg's PG* fallbacks
 * outside development and test (`./server-env.ts`, T-0117), and the migration
 * runner's target checks live in `./database-target.ts`.
 *
 * IMPORTING THIS MODULE HAS NO SIDE EFFECTS. It used to load the workspace
 * `.env` on import; now a server entry point calls `loadWorkspaceEnv()`
 * explicitly. The web process imports `@kasuwa/config/web` instead, which
 * cannot load anything. See `./dotenv.ts`.
 */
export {
  assertAuthModeIsSafe,
  assertKeyProviderIsSafe,
  assertSessionCookieIsSafe,
  assertThrottleIsNotACellWideCliff,
  isLoopbackHostname,
} from './guards.mjs';
// The header policy and fixed bodies the API and the web BFF share (ADR-0019,
// D-L149 #8). apps/web imports them from `@kasuwa/config/session`.
export {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  FORBIDDEN_SCOPE_HEADERS,
  INSECURE_SESSION_COOKIE_NAME,
  INTERNAL_ERROR_BODY,
  NOT_FOUND_BODY,
  SCOPE_HEADER_REJECTED_BODY,
  SESSION_COOKIE_NAME,
  STUB_TENANT_HEADER,
  STUB_USER_HEADER,
} from './session.mjs';
export type { AuthMode, KmsProvider, NodeEnvName } from './guards.mjs';
// apiEnv and workerEnv come from ./server-env, which adds the database
// credential guard (T-0117, D-L94) to the schemas in ./schemas.mjs.
export { migratorEnv, nodeEnv, realtimeEnv, webEnv } from './schemas.mjs';
export { apiEnv, workerEnv } from './server-env';
export {
  assertExplicitNodeEnv,
  assertMigrationTargetIsSafe,
  DEV_DATABASE_PASSWORDS,
  effectiveDatabaseTarget,
  isLocalDatabaseHost,
  namesLocalDatabaseHost,
  isPgEnvironmentVariable,
  saslprep,
} from './database-target';
export type { EffectiveDatabaseTarget, MigrationTargetDecision } from './database-target';
export type { ApiEnv, EnvSource, MigratorEnv, RealtimeEnv, WebEnv, WorkerEnv } from './schemas.mjs';
export { loadWorkspaceEnv } from './dotenv';
export { isStorageEnv, storageConfigured, storageEncryptionProblems, storageEnv } from './storage-env';
export type { StorageCredentials, StorageEnv, StorageSseMode } from './storage-env';
