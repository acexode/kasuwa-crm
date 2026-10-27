import { z } from 'zod';
import type { EnvSource } from './schemas.mjs';

/**
 * The object store's configuration (T-0092, ADR-0017 Decisions 5 and 6,
 * D-L128 Q1-Q3).
 *
 * One schema for every S3-compatible store a cell runs: AWS S3 in af-south-1
 * for `za-1` (no endpoint, and no static keys: the SDK's default chain, i.e.
 * workload identity), a licensed MinIO for a Lagos Silo cell, SeaweedFS in
 * development. There is no per-tier branch: a Bridge tenant shares its cell's
 * bucket under its own `tenant/<id>/` prefix (D-L128 Q2).
 *
 * Judged on the environment it is GIVEN (`process.env` only as the explicit
 * default a server entry point relies on, T-0094), never merged behind the
 * caller's back. The region and the bucket come from here and nowhere else;
 * nothing in a request can name either.
 *
 *   S3_REGION, S3_BUCKET     required
 *   S3_ENDPOINT              optional URL: the host the API and worker call
 *   S3_PUBLIC_ENDPOINT       optional URL: the host signed into browser URLs.
 *                            Defaults to S3_ENDPOINT. In development the two
 *                            differ (a Docker-internal host is unreachable
 *                            from a browser).
 *   S3_FORCE_PATH_STYLE      'true' | 'false' (default 'false'); MinIO and
 *                            SeaweedFS need 'true'
 *   S3_ACCESS_KEY_ID,
 *   S3_SECRET_ACCESS_KEY     optional TOGETHER: both or neither
 *   S3_SSE_MODE              'AES256' (default) | 'off'. 'off' is refused
 *                            outside development and test (D-L94); 'aws:kms'
 *                            is refused everywhere until the per-cell KMS task
 *                            (D-L128 Q3).
 *
 * ENDPOINT SCHEMES (D-L155): S3_ENDPOINT and S3_PUBLIC_ENDPOINT must be http:
 * or https: everywhere, and https: outside development and test. A signed
 * URL or a credentialled request over plain HTTP in a deployed cell would put
 * the signature, and the object, on the wire in clear.
 *
 * THE RESULT IS BRANDED (D-L155): `isStorageEnv` is true only for an object
 * this function returned, and S3ObjectStore refuses anything else, so a store
 * can never be built from a hand-assembled configuration that skipped these
 * checks.
 *
 * No refusal echoes a value: the messages carry variable names only.
 */

const StorageSchema = z.object({
  S3_ENDPOINT: z.url().optional(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).max(64),
  S3_BUCKET: z.string().min(3).max(63),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_SSE_MODE: z.enum(['AES256', 'off']).default('AES256'),
});

export type StorageSseMode = 'AES256' | 'off';

/** Static credentials. Absent: the SDK's default provider chain is used. */
export interface StorageCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * What `storageEnv` returns, and the only thing `S3ObjectStore` accepts.
 *
 * `credentials` is NON-ENUMERABLE: `JSON.stringify`, a spread and a structured
 * log of this object all leave it out, so logging the configuration by mistake
 * cannot print the secret.
 */
export interface StorageEnv {
  readonly endpoint: string | undefined;
  readonly publicEndpoint: string | undefined;
  readonly region: string;
  readonly bucket: string;
  readonly forcePathStyle: boolean;
  readonly sseMode: StorageSseMode;
  readonly credentials: StorageCredentials | undefined;
}

/** D-L94: only development and test may run with an unsafe setting. Unset counts as enforced. */
function enforced(nodeEnv: string | undefined): boolean {
  return nodeEnv !== 'development' && nodeEnv !== 'test';
}

function describe(error: z.ZodError): string[] {
  // Path and a fixed message. Zod's enum message would echo the input, so it is
  // rebuilt from the options alone, as in ./schemas.mjs.
  return error.issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    const message =
      issue.code === 'invalid_value'
        ? `must be one of ${issue.values.map((option) => `'${String(option)}'`).join(' | ')}`
        : issue.message;
    return `  ${path}: ${message}`;
  });
}

/**
 * The SSE rule alone, for processes that do not (yet) parse the whole store
 * configuration. Returns the problem lines; empty when the setting is safe.
 */
export function storageEncryptionProblems(source: EnvSource): string[] {
  const mode = source.S3_SSE_MODE;
  if (mode !== undefined && mode !== 'AES256' && mode !== 'off') {
    return ["  S3_SSE_MODE: must be one of 'AES256' | 'off'"];
  }
  if (mode === 'off' && enforced(source.NODE_ENV)) {
    return [
      '  S3_SSE_MODE: must not be off outside development and test. Every object a deployed ' +
        'cell stores is encrypted at rest (ADR-0017 Decision 6, D-L128 Q3).',
    ];
  }
  return [];
}

/** Every object `storageEnv` returned. Module-private: nothing else can add to it. */
const BRANDED = new WeakSet<object>();

/** True only for a configuration `storageEnv` returned. */
export function isStorageEnv(value: unknown): value is StorageEnv {
  return typeof value === 'object' && value !== null && BRANDED.has(value);
}

function endpointProblems(source: EnvSource): string[] {
  const problems: string[] = [];
  for (const name of ['S3_ENDPOINT', 'S3_PUBLIC_ENDPOINT'] as const) {
    const value = source[name];
    if (value === undefined) continue;
    let protocol: string;
    try {
      protocol = new URL(value).protocol;
    } catch {
      continue; // the schema reports an invalid URL
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      problems.push(`  ${name}: must be an http or https URL`);
    } else if (protocol !== 'https:' && enforced(source.NODE_ENV)) {
      problems.push(`  ${name}: must be https outside development and test`);
    }
  }
  return problems;
}

/**
 * True when `source` names an object store at all (S3_BUCKET is set). A
 * server process may then build one with `storageEnv`; without it, the
 * features that need storage stay off (T-0094's import routes answer 503).
 */
export function storageConfigured(source: EnvSource = process.env): boolean {
  const bucket = source.S3_BUCKET;
  return typeof bucket === 'string' && bucket !== '';
}

export function storageEnv(source: EnvSource = process.env): StorageEnv {
  const problems: string[] = [];
  const parsed = StorageSchema.safeParse(source);
  if (!parsed.success) problems.push(...describe(parsed.error));
  problems.push(...endpointProblems(source));

  const hasId = source.S3_ACCESS_KEY_ID !== undefined;
  const hasSecret = source.S3_SECRET_ACCESS_KEY !== undefined;
  if (hasId !== hasSecret) {
    problems.push(
      '  S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: set both or neither. Without either, the ' +
        "SDK's default credential chain (workload identity) is used.",
    );
  }
  // An invalid mode is already reported by the schema; only the D-L94 rule is added here.
  if (parsed.success) problems.push(...storageEncryptionProblems(source));

  if (problems.length > 0 || !parsed.success) {
    throw new Error(`Invalid storage environment:\n${problems.join('\n')}`);
  }

  const env = parsed.data;
  const config = {
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    sseMode: env.S3_SSE_MODE,
  };
  const credentials: StorageCredentials | undefined =
    env.S3_ACCESS_KEY_ID !== undefined && env.S3_SECRET_ACCESS_KEY !== undefined
      ? Object.freeze({ accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY })
      : undefined;
  Object.defineProperty(config, 'credentials', { value: credentials, enumerable: false });
  const frozen = Object.freeze(config) as StorageEnv;
  BRANDED.add(frozen);
  return frozen;
}
