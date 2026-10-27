import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { hashSessionToken } from '@kasuwa/auth-crypto';
import { resolveSessionIdentity } from '@kasuwa/db';
import IORedis from 'ioredis';
import type { Pool } from 'pg';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { EVENTS_CHANNEL, parseEvent } from './events';
import { decideHandshake, NOT_AUTHENTICATED_BODY, type HandshakeConfig } from './handshake';
import { Hub, resolveSubscription, type HubClient } from './hub';
import { keepsEveryProgramme, readLiveScope, type LiveScope } from './scope';

/**
 * The gateway (T-0160, ADR-0020): the HTTP Upgrade is authenticated, scope is
 * fixed at connect from the session, fan-out is filtered on the server, and a
 * revoked or narrowed session loses its socket within a revalidation interval.
 *
 * NOTHING HERE LOGS a token, a cookie, an id or an event. A failure is logged
 * as its class name only.
 */

export interface GatewayOptions extends HandshakeConfig {
  readonly pool: Pool;
  readonly redisUrl: string;
  readonly port: number;
  readonly revalidateSeconds: number;
}

export interface Gateway {
  readonly port: number;
  close(): Promise<void>;
}

/** A WebSocket close code for "your session ended" and "your scope changed". */
const CLOSE_SESSION_ENDED = 4401;
const CLOSE_SCOPE_CHANGED = 4403;
const CLOSE_UNAVAILABLE = 1011;
/** A socket whose revalidation fails this many times in a row is closed (fail closed). */
const MAX_REVALIDATION_FAILURES = 3;
const MAX_FRAME_BYTES = 4096;
/** setTimeout's ceiling; a longer session is simply re-armed on the next revalidation. */
const MAX_TIMER_MS = 2_147_483_000;

const NOT_FOUND_FRAME = { type: 'error', code: 'not_found' } as const;
const BAD_REQUEST_FRAME = { type: 'error', code: 'bad_request' } as const;

const SubscribeFrame = z.object({
  type: z.literal('subscribe'),
  programmeIds: z.array(z.string().max(64)).max(100).optional(),
});

function refuse(socket: Duplex, status: number, body: string): void {
  const reason =
    status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : 'Service Unavailable';
  socket.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\n` +
      'Content-Type: application/json\r\n' +
      'Cache-Control: no-store\r\n' +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
}

const UNAVAILABLE_BODY = JSON.stringify({
  statusCode: 503,
  error: 'Service Unavailable',
  code: 'service_unavailable',
  message: 'Try again shortly',
});

function logFailure(what: string, error: unknown): void {
  const name = error instanceof Error ? error.name : 'Error';
  process.stderr.write(`kasuwa realtime: ${what} (${name})\n`);
}

class Connection implements HubClient {
  readonly tenantId: string;
  readonly reachable: ReadonlySet<string>;
  subscribed: ReadonlySet<string>;
  alive = true;
  failures = 0;
  private expiry: NodeJS.Timeout | undefined;

  constructor(
    readonly socket: WebSocket,
    readonly scope: LiveScope,
  ) {
    this.tenantId = scope.tenantId;
    this.reachable = new Set(scope.programmeIds);
    this.subscribed = new Set(scope.programmeIds);
  }

  send(frame: unknown): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  /** Closes the socket at the session's expiry, not at the next revalidation. */
  armExpiry(expiresAt: Date, onExpired: () => void): void {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
    const wait = Math.max(0, Math.min(expiresAt.getTime() - Date.now(), MAX_TIMER_MS));
    this.expiry = setTimeout(onExpired, wait);
    this.expiry.unref();
  }

  dispose(): void {
    if (this.expiry !== undefined) clearTimeout(this.expiry);
  }
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const { pool } = options;
  const hub = new Hub();
  const connections = new Set<Connection>();

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const server: Server = createServer((_request, response) => {
    // Not a WebSocket upgrade. There is nothing else here.
    response.writeHead(426, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ statusCode: 426, code: 'upgrade_required' }));
  });

  const end = (connection: Connection, code: number): void => {
    connection.dispose();
    hub.remove(connection);
    connections.delete(connection);
    connection.socket.close(code);
  };

  wss.on('connection', (socket: WebSocket, _request: IncomingMessage, scope: LiveScope) => {
    const connection = new Connection(socket, scope);
    connections.add(connection);
    hub.add(connection);
    connection.armExpiry(scope.expiresAt, () => end(connection, CLOSE_SESSION_ENDED));

    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('close', () => {
      connection.dispose();
      hub.remove(connection);
      connections.delete(connection);
    });
    socket.on('error', () => {
      socket.terminate();
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        connection.send(BAD_REQUEST_FRAME);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(data.toString('utf8'));
      } catch {
        connection.send(BAD_REQUEST_FRAME);
        return;
      }
      // A `tenantId` in the frame is not read: zod strips it, and nothing here
      // has a tenant to choose.
      const frame = SubscribeFrame.safeParse(value);
      if (!frame.success) {
        connection.send(BAD_REQUEST_FRAME);
        return;
      }
      const result = resolveSubscription(connection.reachable, frame.data.programmeIds);
      if (!result.ok) {
        connection.send(NOT_FOUND_FRAME);
        return;
      }
      connection.subscribed = new Set(result.programmeIds);
      connection.send({ type: 'subscribed', programmeIds: result.programmeIds });
    });

    // The first frame says only that the socket is authenticated.
    connection.send({ type: 'hello', authenticated: true });
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    void (async () => {
      const decision = decideHandshake(request.headers, options);
      if (decision.kind === 'refuse') {
        refuse(socket, decision.status, decision.body);
        return;
      }
      const identity = await resolveSessionIdentity(pool, hashSessionToken(decision.token));
      const scope = identity === null ? null : await readLiveScope(pool, identity);
      if (scope === null) {
        refuse(socket, 401, NOT_AUTHENTICATED_BODY);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, scope);
      });
    })().catch((error: unknown) => {
      logFailure('handshake failed', error);
      refuse(socket, 503, UNAVAILABLE_BODY);
    });
  });

  // --- the event seam ------------------------------------------------------
  const subscriber = new IORedis(options.redisUrl, { maxRetriesPerRequest: null });
  subscriber.on('error', (error: unknown) => logFailure('redis error', error));
  subscriber.on('message', (_channel: string, message: string) => {
    const event = parseEvent(message);
    if (event !== null) hub.publish(event);
  });
  await subscriber.subscribe(EVENTS_CHANNEL);

  // --- revalidation and liveness ------------------------------------------
  let sweeping = false;
  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const connection of [...connections]) {
        if (!connection.alive) {
          connection.socket.terminate();
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
        try {
          const live = await readLiveScope(pool, {
            sessionId: connection.scope.sessionId,
            tenantId: connection.scope.tenantId,
            userId: connection.scope.userId,
          });
          connection.failures = 0;
          if (live === null) {
            end(connection, CLOSE_SESSION_ENDED);
          } else if (!keepsEveryProgramme(connection.reachable, live.programmeIds)) {
            end(connection, CLOSE_SCOPE_CHANGED);
          } else {
            connection.armExpiry(live.expiresAt, () => end(connection, CLOSE_SESSION_ENDED));
          }
        } catch (error) {
          connection.failures += 1;
          logFailure('revalidation failed', error);
          if (connection.failures >= MAX_REVALIDATION_FAILURES) end(connection, CLOSE_UNAVAILABLE);
        }
      }
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(() => void sweep(), options.revalidateSeconds * 1000);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, () => resolve());
  });

  return {
    port: options.port,
    close: async () => {
      clearInterval(timer);
      for (const connection of connections) end(connection, 1001);
      wss.close();
      subscriber.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
