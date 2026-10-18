import { databaseCredentialProblems } from './database-target';
import { storageEncryptionProblems } from './storage-env';
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
 * Each refuses an UNSET NODE_ENV (D-L95, T-0117 review M2 as narrowed):
 * `@kasuwa/config` would default it to development, which turns stub auth on
 * and every production guard off, so a real cell that forgot it would boot
 * as a laptop. NODE_ENV is read raw from `source`; an empty string is not
 * unset, it is invalid, and the schema refuses it. The other problems in the
 * same environment are reported in the same message.
 *
 * Outside development and test, each also refuses:
 *   - a database URL whose effective password is one of the repository's
 *     development passwords (`?password=` overrides and percent-encoding
 *     included);
 *   - any variable whose name starts with `PG`, and NODE_PG_FORCE_NATIVE,
 *     which pg (or libpq) would read.
 *
 * In every environment, each also refuses an invalid `S3_SSE_MODE`, and outside
 * development and test `S3_SSE_MODE=off` (T-0092, D-L128 Q3): a process that
 * will hold the object store must not boot with encryption at rest switched
 * off, even before it parses the rest of the store's settings (`storageEnv`).
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

const UNSET_NODE_ENV =
  '  NODE_ENV: must be set explicitly (development, test or production). Unset, it would ' +
  'default to development, which allows stub auth and turns off the production guards ' +
  '(D-L95).';

/**
 * Throws when NODE_ENV is absent from `source`, listing whatever else the
 * schema would refuse alongside it (parsed as development, so the list is the
 * structural problems only). Returns nothing when NODE_ENV is present.
 */
function refuseUnsetNodeEnv(
  processName: string,
  source: EnvSource,
  parse: (source: EnvSource) => unknown,
): void {
  if (source.NODE_ENV !== undefined) {
    return;
  }
  const others: string[] = [];
  try {
    parse({ ...source, NODE_ENV: 'development' });
  } catch (error) {
    const lines = (error as Error).message.split('\n');
    // A schema error's first line is its own "Invalid ... environment:" header.
    others.push(
      ...(lines[0]?.startsWith('Invalid ') ? lines.slice(1) : lines.map((l) => `  ${l}`)),
    );
  }
  refuse(processName, [UNSET_NODE_ENV, ...others]);
}

/**
 * The API process. Requires NODE_ENV (D-L95), `DATABASE_URL` and
 * `DATABASE_AUTH_URL` (T-0049); runs the three boot guards in `./schemas.mjs`
 * and the credential guard.
 */
export function apiEnv(source: EnvSource = process.env): ApiEnv {
  refuseUnsetNodeEnv('api', source, parseApiEnv);
  const parsed = parseApiEnv(source);
  refuse('api', storageEncryptionProblems(source));
  if (enforced(parsed.NODE_ENV)) {
    refuse('api', databaseCredentialProblems(source, ['DATABASE_URL', 'DATABASE_AUTH_URL']));
  }
  return parsed;
}

/**
 * The BullMQ worker process. Requires NODE_ENV (D-L95) and `DATABASE_URL`
 * (kasuwa_app); runs the stub-auth and key-provider guards and the credential
 * guard.
 */
export function workerEnv(source: EnvSource = process.env): WorkerEnv {
  refuseUnsetNodeEnv('worker', source, parseWorkerEnv);
  const parsed = parseWorkerEnv(source);
  refuse('worker', storageEncryptionProblems(source));
  if (enforced(parsed.NODE_ENV)) {
    refuse('worker', databaseCredentialProblems(source, ['DATABASE_URL']));
  }
  return parsed;
}
