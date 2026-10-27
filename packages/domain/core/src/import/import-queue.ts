import { z } from 'zod';

/**
 * The import queues (T-0094 suite interface B): the API enqueues, apps/worker
 * processes. Every payload is exactly `{ tenantId, userId, importId }`, ids
 * only, where `userId` is the import's creator: no filename, header, mapping,
 * cell, URL or key ever reaches Redis, in the data or the options.
 */

export const IMPORT_HEADER_QUEUE = 'kasuwa.import.header';
export const IMPORT_RUN_QUEUE = 'kasuwa.import.run';
export const IMPORT_RETENTION_QUEUE = 'kasuwa.import.retention';
export const IMPORT_QUEUES = [
  IMPORT_HEADER_QUEUE,
  IMPORT_RUN_QUEUE,
  IMPORT_RETENTION_QUEUE,
] as const;
export type ImportQueueName = (typeof IMPORT_QUEUES)[number];

/** BullMQ job names (fixed text, never user input). */
export const IMPORT_JOB_NAMES: Readonly<Record<ImportQueueName, string>> = {
  [IMPORT_HEADER_QUEUE]: 'import.header',
  [IMPORT_RUN_QUEUE]: 'import.run',
  [IMPORT_RETENTION_QUEUE]: 'import.retention',
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Retention (D-L128 Q5, D-L146, D-L160 ruling 3): an abandoned upload goes 24
 * hours after createImport; a raw file 7 days after the job ends, and also 7
 * days after a successful complete. A job still running when its retention
 * falls due is left alone and checked again later.
 */
export const IMPORT_RETENTION = Object.freeze({
  abandonedUploadMs: DAY_MS,
  rawFileMs: 7 * DAY_MS,
  recheckRunningMs: DAY_MS,
});

/** `{ tenantId, userId, importId }`, closed: an extra key is refused. */
export const ImportJobPayload = z.strictObject({
  tenantId: z.uuid(),
  userId: z.uuid(),
  importId: z.uuid(),
});
export type ImportJobPayload = z.infer<typeof ImportJobPayload>;

/**
 * Fixed BullMQ options: bounded history, nothing but numbers, and retries
 * with exponential backoff (D-L167). A processor acts only on a row in the
 * status it expects, so a retry after a transient failure (the start
 * transaction, the bucket) picks up where the job stood, and a retry after
 * the job moved on changes nothing.
 */
export const IMPORT_JOB_OPTIONS = Object.freeze({
  removeOnComplete: 1000,
  removeOnFail: 1000,
  attempts: 3,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 10_000 }),
});

/**
 * BullMQ connection options from a `redis://` URL (BullMQ takes options, not
 * a URL). The URL comes from configuration only; it is never logged.
 */
export function redisConnectionOptions(redisUrl: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
} {
  const url = new URL(redisUrl);
  const db = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined;
  return {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
    ...(url.username === '' ? {} : { username: decodeURIComponent(url.username) }),
    ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
    ...(db === undefined || !Number.isInteger(db) ? {} : { db }),
  };
}
