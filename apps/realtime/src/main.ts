import { loadWorkspaceEnv, realtimeServeEnv } from '@kasuwa/config';
import { createPool } from '@kasuwa/db';
import { startGateway } from './gateway';

/**
 * WebSocket gateway (T-0160, ADR-0020).
 *
 * It carries the inbox, wallboards, presence and the telephony agent-state
 * stream (S3 and later). Two rules, now enforced rather than promised:
 *
 *   1. A socket carries a tenant and a programme scope, established at connect
 *      time from the session, exactly like an HTTP request. A subscription
 *      naming a programme the socket is not scoped to is an error, not a filter.
 *   2. Fan-out is filtered server-side. "Send everything and let the client
 *      filter" is how a wallboard leaks another client's queue statistics.
 *
 * It connects as `kasuwa_app` (no new role, no third SECURITY DEFINER function)
 * and to Redis for events. It holds no other database URL.
 */
async function main(): Promise<void> {
  loadWorkspaceEnv();
  const configuration = realtimeServeEnv();
  const pool = createPool({
    connectionString: configuration.DATABASE_URL,
    max: configuration.DATABASE_POOL_MAX,
    applicationName: 'kasuwa-realtime',
  });
  // An idle client dropped by the server must not crash the gateway.
  pool.on('error', (error: Error) => {
    process.stderr.write(`kasuwa realtime: database pool error (${error.name})
`);
  });

  const gateway = await startGateway({
    pool,
    redisUrl: configuration.REDIS_URL,
    port: configuration.REALTIME_PORT,
    revalidateSeconds: configuration.REALTIME_REVALIDATE_SECONDS,
    allowedOrigin: configuration.REALTIME_ALLOWED_ORIGIN,
    insecureCookie: configuration.KASUWA_SESSION_COOKIE_INSECURE === '1',
  });

  process.stdout.write(`kasuwa realtime listening on ${gateway.port}\n`);

  const shutdown = (): void => {
    void gateway
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
