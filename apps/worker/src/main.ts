import { loadWorkspaceEnv, workerEnv } from '@kasuwa/config';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

/**
 * BullMQ worker process — wiring only, no business jobs.
 *
 * The queues that will live here (workflow execution, webhook delivery,
 * imports, AI jobs, retention purges) belong to modules that do not exist yet.
 * What the scaffold establishes is the shape:
 *
 *   - a single Redis connection with maxRetriesPerRequest: null, which BullMQ
 *     requires and which silently breaks blocking operations if forgotten
 *   - one queue per concern, named with a `kasuwa.` prefix
 *   - graceful shutdown, so a rolling deploy does not abandon in-flight jobs
 *
 * IMPORTANT for whoever adds the first real job: jobs are NOT inside a tenant
 * transaction. A job that touches tenant data must open one itself with
 * `withTenantTransaction`, using the tenant and user recorded on the job
 * payload. There is no ambient tenant in a worker.
 */

const HEARTBEAT_QUEUE = 'kasuwa.heartbeat';

async function main(): Promise<void> {
  loadWorkspaceEnv();
  const configuration = workerEnv();
  const connection = new IORedis(configuration.REDIS_URL, { maxRetriesPerRequest: null });

  const heartbeat = new Queue(HEARTBEAT_QUEUE, { connection });

  const worker = new Worker(
    HEARTBEAT_QUEUE,
    async (job) => {
      // Proves the queue round-trips. Delete this when the first real job lands.
      return { receivedAt: new Date().toISOString(), name: job.name };
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    process.stderr.write(`job ${job?.id ?? 'unknown'} failed: ${error.message}\n`);
  });

  process.stdout.write(`kasuwa worker listening on queue ${HEARTBEAT_QUEUE}\n`);

  const shutdown = async (): Promise<void> => {
    await worker.close();
    await heartbeat.close();
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
