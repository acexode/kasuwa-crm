import { loadWorkspaceEnv, storageConfigured, storageEnv, workerEnv } from '@kasuwa/config';
import {
  IMPORT_HEADER_QUEUE,
  IMPORT_RETENTION_QUEUE,
  IMPORT_RUN_QUEUE,
} from '@kasuwa/domain-core';
import { S3ObjectStore } from '@kasuwa/storage-adapter';
import { createPool, pruneAuthTables, refuseUsableTestAdminAtBoot } from '@kasuwa/db';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import {
  AUTH_RETENTION_EVERY_MS,
  AUTH_RETENTION_JOB_NAME,
  AUTH_RETENTION_QUEUE,
  AUTH_RETENTION_SCHEDULER_ID,
  authRetentionJob,
  authRetentionLine,
} from './auth-retention';
import {
  processImportHeader,
  processImportRetention,
  processImportRun,
  type ImportJobDeps,
} from './import-jobs';

/**
 * BullMQ worker process.
 *
 * The shape every queue here follows:
 *
 *   - a single Redis connection with maxRetriesPerRequest: null, which BullMQ
 *     requires and which silently breaks blocking operations if forgotten
 *   - one queue per concern, named with a `kasuwa.` prefix
 *   - graceful shutdown, so a rolling deploy does not abandon in-flight jobs
 *
 * The database connection is DATABASE_URL, kasuwa_app: NOBYPASSRLS, the same
 * role the API runs as. There is no other connection in this process.
 *
 * IMPORTANT for whoever adds the next job: jobs are NOT inside a tenant
 * transaction. A job that touches tenant data must open one itself with
 * `withTenantTransaction`, using the tenant and user recorded on the job
 * payload. There is no ambient tenant in a worker. The auth-retention job is
 * the one deliberate exception, and it gets its cross-tenant reach from the
 * NOBYPASSRLS `kasuwa_sweeper` role inside `pruneAuthTables` (D-L66), whose
 * policies admit only rows already past retention - never from this process.
 */

const HEARTBEAT_QUEUE = 'kasuwa.heartbeat';

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const configuration = workerEnv();
  const connection = new IORedis(configuration.REDIS_URL, { maxRetriesPerRequest: null });
  const pool = createPool({
    connectionString: configuration.DATABASE_URL,
    max: configuration.DATABASE_POOL_MAX,
    applicationName: 'kasuwa-worker',
  });
  // Before any queue or schedule: outside development and test, refuse to
  // start when kasuwa_test_admin is usable (T-0117, D-L94). On the app pool.
  await refuseUsableTestAdminAtBoot(pool, configuration.NODE_ENV);

  const heartbeat = new Queue(HEARTBEAT_QUEUE, { connection });

  const heartbeatWorker = new Worker(
    HEARTBEAT_QUEUE,
    async (job) => {
      // Proves the queue round-trips.
      return { receivedAt: new Date().toISOString(), name: job.name };
    },
    { connection, concurrency: 1 },
  );

  // --- auth-table retention (T-0045) ---------------------------------------
  const authRetention = new Queue(AUTH_RETENTION_QUEUE, { connection });
  // Idempotent: every worker instance upserts the same scheduler id, so a
  // deploy that runs two instances still has one schedule.
  await authRetention.upsertJobScheduler(
    AUTH_RETENTION_SCHEDULER_ID,
    { every: AUTH_RETENTION_EVERY_MS },
    { name: AUTH_RETENTION_JOB_NAME, opts: { removeOnComplete: 100, removeOnFail: 100 } },
  );

  const authRetentionWorker = new Worker(
    AUTH_RETENTION_QUEUE,
    async () => {
      // Throws AuthRetentionJobError (class name only) on failure, so BullMQ's
      // stored failedReason and stack never carry a pg message.
      const run = await authRetentionJob(
        (appPool, options) => pruneAuthTables(appPool, options),
        pool,
        new Date(),
      );
      process.stdout.write(`${authRetentionLine(run)}\n`);
      return run;
    },
    { connection, concurrency: 1 },
  );

  // --- CSV import (T-0094) -------------------------------------------------
  // One worker per queue. Each job runs AS ITS CREATOR inside
  // withTenantTransaction (import-jobs.ts); payloads are ids only. Without an
  // object store configured, the import queues are not consumed.
  const importWorkers: Worker[] = [];
  if (storageConfigured()) {
    const deps: ImportJobDeps = {
      pool,
      store: new S3ObjectStore(storageEnv()),
      redisUrl: configuration.REDIS_URL,
    };
    importWorkers.push(
      new Worker(IMPORT_HEADER_QUEUE, async (job) => processImportHeader(deps, job.data), {
        connection,
        concurrency: 2,
      }),
      // Sequential batches per job (R5); one run at a time per worker.
      new Worker(IMPORT_RUN_QUEUE, async (job) => processImportRun(deps, job.data), {
        connection,
        concurrency: 1,
      }),
      new Worker(IMPORT_RETENTION_QUEUE, async (job) => processImportRetention(deps, job.data), {
        connection,
        concurrency: 2,
      }),
    );
  }

  for (const worker of [heartbeatWorker, authRetentionWorker, ...importWorkers]) {
    worker.on('failed', (job) => {
      // The job id and queue only. An error from pg can carry row values.
      process.stderr.write(`job ${job?.id ?? 'unknown'} on ${worker.name} failed\n`);
    });
  }

  process.stdout.write(
    `kasuwa worker listening on queues ${[HEARTBEAT_QUEUE, AUTH_RETENTION_QUEUE, ...importWorkers.map((w) => w.name)].join(', ')}\n`,
  );

  const shutdown = async (): Promise<void> => {
    await heartbeatWorker.close();
    await authRetentionWorker.close();
    for (const worker of importWorkers) await worker.close();
    await heartbeat.close();
    await authRetention.close();
    await pool.end();
    await connection.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
