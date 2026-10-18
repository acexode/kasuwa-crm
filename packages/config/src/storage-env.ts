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
 * Judged on the environment it is GIVEN, never `process.env` behind the
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
 * No refusal echoes a value: the messages carry variable names only.
 */

const StorageSchema = z.object({
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
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
      issue.code === 'invalid_enum_value'
        ? `must be one of ${issue.options.map((option) => `'${String(option)}'`).join(' | ')}`
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

export function storageEnv(source: EnvSource): StorageEnv {
  const problems: string[] = [];
  const parsed = StorageSchema.safeParse(source);
  if (!parsed.success) problems.push(...describe(parsed.error));

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
  return Object.freeze(config) as StorageEnv;
}
