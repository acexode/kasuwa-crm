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
 * running the stub-auth guard. See `./schemas.mjs`.
 *
 * IMPORTING THIS MODULE HAS NO SIDE EFFECTS. It used to load the workspace
 * `.env` on import; now a server entry point calls `loadWorkspaceEnv()`
 * explicitly. The web process imports `@kasuwa/config/web` instead, which
 * cannot load anything. See `./dotenv.ts`.
 */
export {
  assertAuthModeIsSafe,
  assertKeyProviderIsSafe,
  assertThrottleIsNotACellWideCliff,
} from './guards.mjs';
export type { AuthMode, KmsProvider, NodeEnvName } from './guards.mjs';
export { apiEnv, migratorEnv, nodeEnv, realtimeEnv, webEnv, workerEnv } from './schemas.mjs';
export type { ApiEnv, EnvSource, MigratorEnv, RealtimeEnv, WebEnv, WorkerEnv } from './schemas.mjs';
export { loadWorkspaceEnv } from './dotenv';
