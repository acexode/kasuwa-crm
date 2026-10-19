import { loadWorkspaceEnv, storageConfigured, storageEnv, workerEnv } from '@kasuwa/config';
import {
  handleNotificationEvent,
  IMPORT_HEADER_QUEUE,
  IMPORT_RETENTION_QUEUE,
  IMPORT_RUN_QUEUE,
} from '@kasuwa/domain-core';
import { featureFlagClient, initialiseFeatureFlags } from '@kasuwa/feature-flags';
import { S3ObjectStore } from '@kasuwa/storage-adapter';
import {
  consumeOutboxJob,
  createPool,
  OUTBOX_QUEUES,
  pruneAuthTables,
  readOutboxBacklog,
  refuseUsableTestAdminAtBoot,
  relayOutboxBatch,
  sweepOutbox,
  type OutboxQueuePort,
} from '@kasuwa/db';
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
import { outboxConsumerProcessor, refuseWrongPoolRolesAtBoot, startOutboxRelay } from './outbox';

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
 * TWO DATABASE CONNECTIONS (ADR-0018 amends what this header used to say):
 *
 *   - DATABASE_URL, kasuwa_app: NOBYPASSRLS, the same role the API runs as.
 *     Every job that touches tenant data uses it, inside withTenantTransaction.
 *   - DATABASE_RELAY_URL, kasuwa_relay: NOBYPASSRLS, a member of no role, a
 *     small pool (2) used by the outbox relay and its sweep ONLY. Its grants
 *     and policies (migration 0041) reach undispatched and expired
 *     outbox_event rows in every tenant, and nothing else. No other code in
 *     this process takes it, and no other process may hold it (the API,
 *     realtime, web and the operator commands refuse the variable).
 *
 * Before any queue or schedule exists, the process refuses to boot unless
 * DATABASE_URL logs in as kasuwa_app and DATABASE_RELAY_URL as kasuwa_relay
 * (ADR-0013 Decision 4, ADR-0018 point 11), and, outside development and
 * test, if kasuwa_test_admin is usable (T-0117).
 *
 * IMPORTANT for whoever adds the next job: jobs are NOT inside a tenant
 * transaction. A job that touches tenant data must open one itself with
 * `withTenantTransaction`, using the tenant and user recorded on the job
 * payload. There is no ambient tenant in a worker. A consumer of outbox
 * events uses `outboxConsumerProcessor` (./outbox.ts), which re-enters the
 * tenant as the event's actor and re-reads the event under RLS before the
 * handler runs (ADR-0018 point 8): Redis is transport, never authority.
 * The two deliberate cross-tenant exceptions get their reach from a
 * NOBYPASSRLS role, never from this process: the auth-retention job from
 * `kasuwa_sweeper` inside `pruneAuthTables` (D-L66), and the outbox relay from
 * `kasuwa_relay`; each role's policies admit only the rows its job needs.
 */

const HEARTBEAT_QUEUE = 'kasuwa.heartbeat';

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const configuration = workerEnv();
  const pool = createPool({
    connectionString: configuration.DATABASE_URL,
    max: configuration.DATABASE_POOL_MAX,
    applicationName: 'kasuwa-worker',
  });
  // The relay's own pool (ADR-0018 point 6): two connections, outbox only.
  const relayPool = createPool({
    connectionString: configuration.DATABASE_RELAY_URL,
    max: 2,
    applicationName: 'kasuwa-outbox-relay',
  });
  // An idle client's error (a restarted database) must not crash the process.
  // Nothing from the error is printed: a pg message can carry values.
  for (const each of [pool, relayPool]) {
    each.on('error', () => {
      process.stderr.write('a pooled database connection failed\n');
    });
  }
  // Before any queue or schedule: each pool must be the role it claims to be
  // (ADR-0018 point 11), and, outside development and test, kasuwa_test_admin
  // must not be usable (T-0117, D-L94). On the app pool.
  await refuseWrongPoolRolesAtBoot(pool, relayPool);
  await refuseUsableTestAdminAtBoot(pool, configuration.NODE_ENV);

  const connection = new IORedis(configuration.REDIS_URL, { maxRetriesPerRequest: null });

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
  // withTenantTransaction (import-jobs.ts); payloads are ids only.
  //   - header and run are behind the `crm_import` flag (D-L166), off by
  //     default: off, those queues are not consumed;
  //   - retention is ALWAYS consumed when an object store is configured
  //     (D-L167 N9): erasure must never wait on a feature switch.
  await initialiseFeatureFlags();
  const crmImport = await featureFlagClient().getBooleanValue('crm_import', false);
  const importWorkers: Worker[] = [];
  if (storageConfigured()) {
    const deps: ImportJobDeps = {
      pool,
      store: new S3ObjectStore(storageEnv()),
      redisUrl: configuration.REDIS_URL,
    };
    importWorkers.push(
      new Worker(IMPORT_RETENTION_QUEUE, async (job) => processImportRetention(deps, job.data), {
        connection,
        concurrency: 2,
      }),
    );
    if (crmImport) {
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
      );
    }
  }

  // --- the notifications consumer (T-0100, ADR-0018 point 8) ---------------
  // ALWAYS consumed, behind no flag: an event that is relayed and never
  // consumed would sit in BullMQ, and the producers append whether or not any
  // screen is on. It runs on the app pool (kasuwa_app): the helper re-enters
  // the tenant as the event's actor and re-reads the event under RLS first.
  const notificationsWorker = new Worker(
    OUTBOX_QUEUES.notifications,
    outboxConsumerProcessor(
      consumeOutboxJob,
      pool,
      OUTBOX_QUEUES.notifications,
      handleNotificationEvent,
      (line) => process.stdout.write(`${line}\n`),
    ),
    { connection, concurrency: 4 },
  );

  for (const worker of [heartbeatWorker, authRetentionWorker, ...importWorkers, notificationsWorker]) {
    worker.on('failed', (job) => {
      // The job id and queue only. An error from pg can carry row values.
      process.stderr.write(`job ${job?.id ?? 'unknown'} on ${worker.name} failed\n`);
    });
  }

  // --- the outbox relay (T-0098, ADR-0018) ---------------------------------
  // One BullMQ queue per consuming domain. The relay only enqueues; the
  // consumer of each queue is registered above (notifications, T-0100).
  const outboxQueues = Object.values(OUTBOX_QUEUES).map((name) => new Queue(name, { connection }));
  const outboxPorts: Record<string, OutboxQueuePort> = Object.fromEntries(
    outboxQueues.map((queue) => [queue.name, { addBulk: (jobs) => queue.addBulk(jobs) }]),
  );
  const relay = startOutboxRelay({
    relay: relayOutboxBatch,
    sweep: sweepOutbox,
    backlog: readOutboxBacklog,
    pool: relayPool,
    queues: outboxPorts,
    write: (line) => process.stdout.write(`${line}\n`),
  });

  process.stdout.write(
    `kasuwa worker listening on queues ${[HEARTBEAT_QUEUE, AUTH_RETENTION_QUEUE, ...importWorkers.map((w) => w.name), notificationsWorker.name].join(', ')}; ` +
      `relaying the outbox to ${outboxQueues.map((queue) => queue.name).join(', ')}\n`,
  );

  const shutdown = async (): Promise<void> => {
    await relay.stop();
    await heartbeatWorker.close();
    await authRetentionWorker.close();
    for (const worker of importWorkers) await worker.close();
    await notificationsWorker.close();
    await heartbeat.close();
    await authRetention.close();
    for (const queue of outboxQueues) await queue.close();
    await relayPool.end();
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
