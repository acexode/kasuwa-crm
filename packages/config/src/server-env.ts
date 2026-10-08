import { databaseCredentialProblems } from './database-target';
import {
  apiEnv as parseApiEnv,
  workerEnv as parseWorkerEnv,
  type ApiEnv,
  type EnvSource,
  type WorkerEnv,
} from './schemas.mjs';

/**
 * The API and worker schemas, with the database-credential guard (T-0117,
 * D-L94) on top.
 *
 * `./schemas.mjs` holds the schemas and the boot guards that need nothing but
 * the parsed values. This adds the one guard that needs `pg-connection-string`
 * to judge a URL the way pg will, which must stay out of the web process's
 * module graph (see the note in `./database-target.ts`). The main entry
 * exports THESE `apiEnv` and `workerEnv`, so every server process gets the
 * guard; `./web.mjs` exports neither.
 *
 * Outside development and test, each refuses:
 *   - a database URL whose effective password is one of the repository's
 *     development passwords (`?password=` overrides and percent-encoding
 *     included);
 *   - PGHOST, PGPASSWORD or PGUSER, which pg would fall back to.
 *
 * Both read only `source`. Neither echoes a value.
 */

function refuse(processName: string, problems: readonly string[]): void {
  if (problems.length > 0) {
    throw new Error(`Invalid ${processName} environment:\n${problems.join('\n')}`);
  }
}

function enforced(nodeEnv: string): boolean {
  return nodeEnv !== 'development' && nodeEnv !== 'test';
}

/**
 * The API process. Requires `DATABASE_URL` and `DATABASE_AUTH_URL` (T-0049);
 * runs the three boot guards in `./schemas.mjs` and the credential guard.
 */
export function apiEnv(source: EnvSource = process.env): ApiEnv {
  const parsed = parseApiEnv(source);
  if (enforced(parsed.NODE_ENV)) {
    refuse('api', databaseCredentialProblems(source, ['DATABASE_URL', 'DATABASE_AUTH_URL']));
  }
  return parsed;
}

/**
 * The BullMQ worker process. Requires `DATABASE_URL` (kasuwa_app); runs the
 * stub-auth and key-provider guards and the credential guard.
 */
export function workerEnv(source: EnvSource = process.env): WorkerEnv {
  const parsed = parseWorkerEnv(source);
  if (enforced(parsed.NODE_ENV)) {
    refuse('worker', databaseCredentialProblems(source, ['DATABASE_URL']));
  }
  return parsed;
}
