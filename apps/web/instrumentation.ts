import { initialiseFeatureFlags } from '@kasuwa/feature-flags';

/**
 * Runs once when the Next server starts (Next's instrumentation hook).
 *
 * Feature flags are otherwise initialised lazily, on the first request that
 * evaluates one — so a production web process with a not-production-ready flag
 * in `KASUWA_FEATURE_FLAGS_ON` would START, and then answer 500 on sign-in.
 * Initialising here moves that refusal to boot: the same fail-closed behaviour
 * the API already has in `main.ts`.
 *
 * There is no `NEXT_RUNTIME` check, because reading `process.env` outside
 * `@kasuwa/config` is lint-forbidden and the check is not needed: the guard is
 * a pure function of two environment variables and is safe to run in either
 * runtime.
 *
 * Next catches an error thrown here, logs "Failed to prepare server" and keeps
 * the process up answering 500 on every route — measured. That fails closed,
 * but a process that stays up is not a refusal to boot: a health check might
 * read "running" as "deployed". So the process exits, where the runtime has
 * `process.exit` (Node; the edge sandbox does not).
 */
export async function register(): Promise<void> {
  try {
    await initialiseFeatureFlags();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (typeof process.exit === 'function') {
      process.exit(1);
    }
    throw error;
  }
}
