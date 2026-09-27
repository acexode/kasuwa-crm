import { env } from '@kasuwa/config';
import { WebSocketServer } from 'ws';

/**
 * WebSocket gateway — stub.
 *
 * This process exists from day one because the founding pack (3.1) is explicit
 * that realtime is a genuinely different workload from the API and should not
 * be retrofitted later. It will carry the inbox, wallboards, presence and the
 * telephony agent-state stream.
 *
 * It currently authenticates nothing and subscribes to nothing. Two rules for
 * whoever builds it out (Agent 6 / Agent 11):
 *
 *   1. A socket carries a tenant and a programme scope, established at connect
 *      time from the session, exactly like an HTTP request. A subscription
 *      request naming a programme the socket is not scoped to is an error, not
 *      a filter.
 *   2. Fan-out must be filtered server-side. "Send everything and let the client
 *      filter" is how a wallboard leaks another client's queue statistics.
 */
async function main(): Promise<void> {
  const configuration = env();
  const server = new WebSocketServer({ port: configuration.REALTIME_PORT });

  server.on('connection', (socket) => {
    // No auth, no scope, no subscriptions. Echo only, so the process is
    // observably alive without pretending to do more than it does.
    socket.on('message', (data) => {
      socket.send(JSON.stringify({ type: 'echo', received: data.toString().slice(0, 256) }));
    });
    socket.send(JSON.stringify({ type: 'hello', authenticated: false }));
  });

  process.stdout.write(`kasuwa realtime listening on ${configuration.REALTIME_PORT}\n`);

  const shutdown = (): void => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
