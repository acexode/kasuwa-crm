import { RedisContainer } from '@testcontainers/redis';

/**
 * A real Redis for the suites that read what the API and worker put on a
 * BullMQ queue (T-0094's import jobs).
 *
 * Not a mock, for the reason `containers.ts` gives for Postgres: the import
 * suites assert what actually lands in Redis (ids only, no file content, the
 * retention delay), and a fake queue would only agree with whatever the code
 * under test already believes.
 *
 * Same image as `startTestStack({ redis: true })`, without a second Postgres:
 * the import suites share the global-setup database.
 *
 * Owned by the lead (T-0094 acceptance). Application code never imports
 * `@kasuwa/testing` (lint-enforced).
 */

const REDIS_IMAGE = 'redis:7-alpine';
const REDIS_PORT = 6379;

export interface StartedRedis {
  /** `redis://host:port`, as `REDIS_URL` would carry it. */
  url: string;
  host: string;
  port: number;
  stop: () => Promise<void>;
}

export async function startRedis(): Promise<StartedRedis> {
  const container = await new RedisContainer(REDIS_IMAGE).start();
  const host = container.getHost();
  const port = container.getMappedPort(REDIS_PORT);
  return {
    url: `redis://${host}:${port}`,
    host,
    port,
    stop: async () => {
      await container.stop();
    },
  };
}
