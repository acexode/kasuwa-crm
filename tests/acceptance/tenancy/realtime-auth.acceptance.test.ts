import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { INSECURE_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from '@kasuwa/config';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

/**
 * ACCEPTANCE — T-0160 (D-L149 #6, ADR-0019 open question 6): the realtime
 * process authenticates every socket and fans events out by scope, server side.
 *
 * THE GAP. `apps/realtime` today accepts anyone who can reach its port, says
 * `authenticated: false`, and echoes input. It has no tenant, no programme and no
 * subscription. Nothing is published through it yet, which is why nothing has
 * leaked; the moment S3 pushes inbox events through it, "send everything and let
 * the client filter" would show one client another's queue. No browser connects
 * to it until this task lands.
 *
 * PINNED INTERFACES (everything else is the builder's; the ADR records them):
 *
 *   I1. The process is `apps/realtime/src/main.ts`, started like the worker is
 *       (`tsx src/main.ts`). It reads `REALTIME_PORT`, `DATABASE_URL` (the
 *       `kasuwa_app` role: no new role, and no third SECURITY DEFINER function,
 *       it reuses `app.resolve_session`), `REDIS_URL`, `REALTIME_ALLOWED_ORIGIN`
 *       (the one web origin a browser may connect from) and
 *       `REALTIME_REVALIDATE_SECONDS` (default 30). It prints `listening on <port>`.
 *   I2. The credential, read at the HTTP Upgrade, before any frame:
 *       `Authorization: Bearer ksw_s1_...` (non-browser clients), or the session
 *       cookie `__Host-kasuwa_session` (a browser: the BFF's cookie, ADR-0019) with
 *       an `Origin` equal to `REALTIME_ALLOWED_ORIGIN`. Never a query-string
 *       token, never stub headers, never both a cookie and a Bearer, never the
 *       relaxed `kasuwa_session` name unless the process is started with
 *       `KASUWA_SESSION_COOKIE_INSECURE=1`.
 *   I3. Every refusal is one HTTP 401 with one body, and no WebSocket frame. A
 *       scope header (`x-kasuwa-programme-ids` and its kin) is a 400, as at the API.
 *   I4. On success the first frame is `{ "type": "hello", "authenticated": true }`
 *       and carries no id. The echo handler is gone. Scope (tenant, user and the
 *       programmes the session reaches, read from `user_programme`) is fixed on
 *       the socket at connect. The client never names a tenant.
 *   I5. `{ "type": "subscribe", "programmeIds": [...] }` is answered
 *       `{ "type": "subscribed", "programmeIds": [...] }`, or, if any id is
 *       outside the socket's scope, one `{ "type": "error", "code": "not_found" }`
 *       whether the programme is out of scope, in another tenant or does not
 *       exist. An empty list or no list means every programme in scope.
 *   I6. The event seam: Redis channel `kasuwa.realtime.events`, JSON
 *       `{ tenantId, programmeId, type, ids }` (D-P29: ids only). A socket gets
 *       `{ "type": "event", "event": { type, programmeId, ids } }` (no tenant id)
 *       only when the event's tenant is the socket's and its programme is in the
 *       socket's subscribed set. An event missing a field, or from a tenant other
 *       than the socket's, goes to no one.
 *   I7. Revocation bites: a revoked session, or one removed from `user_programme`,
 *       stops receiving and its socket is closed within a few revalidation
 *       intervals, not at the next reconnect.
 *
 * Driven against the REAL process, real Postgres (RLS, `kasuwa_app`) and real
 * Redis from the harness. A real WebSocket client (`ws`, resolved from
 * `apps/realtime`, so no dependency is added here).
 *
 * "Not delivered" is proved without sleeping: forbidden events are published
 * first, then one event the socket may see. Redis keeps channel order, so when
 * that sentinel arrives, anything earlier that was going to arrive already has.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const realtimeDir = join(repoRoot, 'apps', 'realtime');
const ORIGIN = 'https://app.kasuwa.test';
const CHANNEL = 'kasuwa.realtime.events';
const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

interface Ws {
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
  terminate(): void;
}
type WsCtor = new (url: string, options?: { headers?: Record<string, string> }) => Ws;

interface Refused {
  refused: { status: number; body: string };
}
interface Open {
  ws: Ws;
  frames: Array<Record<string, unknown>>;
  closed: Promise<void>;
  isClosed: () => boolean;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

/** `PUBLISH channel message` over a raw socket: the harness's Redis needs no client library here. */
function publish(redisUrl: string, message: unknown): Promise<void> {
  const { hostname, port } = new URL(redisUrl);
  const body = typeof message === 'string' ? message : JSON.stringify(message);
  const parts = ['PUBLISH', CHANNEL, body];
  const wire = `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')}`;
  return new Promise((resolveDone, reject) => {
    const socket = createConnection({ host: hostname, port: Number(port === '' ? '6379' : port) });
    socket.on('connect', () => socket.write(wire));
    socket.on('data', () => {
      socket.end();
      resolveDone();
    });
    socket.on('error', reject);
  });
}

describe('acceptance: realtime authenticates and filters server side (T-0160)', () => {
  let observer: Pool;
  let child: ChildProcess | undefined;
  let output = '';
  let port = 0;
  let Socket: WsCtor;
  const open: Ws[] = [];
  const redisUrl = (): string => inject('redisUrl');

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    Socket = createRequire(join(realtimeDir, 'package.json'))('ws') as WsCtor;
    port = await freePort();
    const tsx = createRequire(join(realtimeDir, 'package.json')).resolve('tsx/cli');
    child = spawn(process.execPath, [tsx, 'src/main.ts'], {
      cwd: realtimeDir,
      env: {
        NODE_ENV: 'test',
        REALTIME_PORT: String(port),
        DATABASE_URL: inject('databaseUrl'),
        REDIS_URL: redisUrl(),
        REALTIME_ALLOWED_ORIGIN: ORIGIN,
        REALTIME_REVALIDATE_SECONDS: '1',
        HOME: tmpdir(),
        TMPDIR: tmpdir(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    await vi.waitFor(
      () => {
        if (!output.includes(`listening on ${String(port)}`)) {
          throw new Error(`realtime not listening yet. Output:\n${output}`);
        }
      },
      { timeout: 45_000, interval: 100 },
    );
  }, 90_000);

  afterAll(async () => {
    for (const ws of open) ws.terminate();
    if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  /** A live session row for a seeded user. The harness mints it as the migrator: `kasuwa_app` cannot. */
  async function session(
    tenantId: string,
    userId: string,
    options: { expiresInMs?: number; revoked?: boolean } = {},
  ): Promise<{ token: string; id: string }> {
    const token = `ksw_s1_${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    await observer.query(
      `INSERT INTO auth_session (id, tenant_id, user_id, token_hash, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval, ${options.revoked === true ? 'now()' : 'NULL'})`,
      [id, tenantId, userId, sha256(token), String(options.expiresInMs ?? 3_600_000)],
    );
    return { token, id };
  }

  function connect(headers: Record<string, string>, query = ''): Promise<Open | Refused> {
    return new Promise((resolveConnect, reject) => {
      const frames: Array<Record<string, unknown>> = [];
      let closedFlag = false;
      let onClosed: () => void = () => undefined;
      const closed = new Promise<void>((resolveClosed) => {
        onClosed = resolveClosed;
      });
      const ws = new Socket(`ws://127.0.0.1:${String(port)}/${query}`, { headers });
      open.push(ws);
      ws.on('message', (data: unknown) => {
        frames.push(JSON.parse(String(data)) as Record<string, unknown>);
      });
      ws.on('close', () => {
        closedFlag = true;
        onClosed();
      });
      ws.on('open', () => resolveConnect({ ws, frames, closed, isClosed: () => closedFlag }));
      ws.on('unexpected-response', (_request: unknown, response: unknown) => {
        const res = response as {
          statusCode?: number;
          on: (event: string, listener: (chunk?: Buffer) => void) => void;
        };
        let body = '';
        res.on('data', (chunk) => {
          body += (chunk ?? Buffer.alloc(0)).toString('utf8');
        });
        res.on('end', () => resolveConnect({ refused: { status: res.statusCode ?? 0, body } }));
      });
      ws.on('error', (error: unknown) => {
        // `unexpected-response` handles a refusal; anything else is a real failure.
        setTimeout(() => reject(error instanceof Error ? error : new Error(String(error))), 50);
      });
    });
  }

  async function connected(headers: Record<string, string>): Promise<Open> {
    const result = await connect(headers);
    if ('refused' in result) {
      throw new Error(
        `expected a socket, got ${String(result.refused.status)}: ${result.refused.body}`,
      );
    }
    await vi.waitFor(() => expect(result.frames.length).toBeGreaterThan(0), { timeout: 10_000 });
    return result;
  }

  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  function event(tenantId: string, programmeId: string | undefined, type = 'conversation.updated') {
    return {
      tenantId,
      ...(programmeId === undefined ? {} : { programmeId }),
      type,
      ids: [randomUUID()],
    };
  }

  /** Delivered `event` frames, by event type. */
  const delivered = (frames: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
    frames.filter((f) => f.type === 'event').map((f) => f.event as Record<string, unknown>);

  async function waitSentinel(open_: Open, marker: string): Promise<void> {
    await vi.waitFor(
      () => expect(delivered(open_.frames).some((e) => e.type === marker)).toBe(true),
      { timeout: 10_000, interval: 25 },
    );
  }

  // =========================================================================
  // 1. Who may connect (I2, I3).
  // =========================================================================

  describe('1. the handshake refuses everything but a live session, identically', () => {
    it('answers every refusal with one 401 body, and sends no frame', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1);
      const expired = await session(TENANT_A, USER_A_AGENT_1, { expiresInMs: -60_000 });
      const revoked = await session(TENANT_A, USER_A_AGENT_1, { revoked: true });
      const cookie = (token: string, name = SESSION_COOKIE_NAME) => ({
        cookie: `${name}=${token}`,
      });

      const cases: Array<[string, Record<string, string>, string?]> = [
        ['no credential', {}],
        ['a garbage token', bearer(`ksw_s1_${randomBytes(32).toString('base64url')}`)],
        ['a malformed token', bearer('not-a-token')],
        ['an expired session', bearer(expired.token)],
        ['a revoked session', bearer(revoked.token)],
        ['a live token in the query string only', {}, `?token=${live.token}`],
        ['a live Bearer plus a query-string token', bearer(live.token), `?token=${live.token}`],
        [
          'stub identity headers',
          { 'x-kasuwa-tenant-id': TENANT_A, 'x-kasuwa-user-id': USER_A_AGENT_1 },
        ],
        [
          'a Bearer and a cookie together',
          { ...bearer(live.token), ...cookie(live.token), origin: ORIGIN },
        ],
        ['a cookie with no Origin', cookie(live.token)],
        [
          'a cookie from the wrong Origin',
          { ...cookie(live.token), origin: 'https://evil.example' },
        ],
        [
          'the relaxed cookie name, which this process does not accept',
          { ...cookie(live.token, INSECURE_SESSION_COOKIE_NAME), origin: ORIGIN },
        ],
      ];

      const bodies = new Set<string>();
      for (const [label, headers, query] of cases) {
        const result = await connect(headers, query);
        expect('refused' in result, `${label}: a socket opened`).toBe(true);
        if (!('refused' in result)) continue;
        expect(result.refused.status, label).toBe(401);
        bodies.add(result.refused.body);
        for (const secret of [live.token, expired.token, revoked.token]) {
          expect(result.refused.body, `${label} echoes a token`).not.toContain(secret);
        }
      }
      expect([...bodies], 'refusals must be indistinguishable').toHaveLength(1);
    });

    it('refuses a scope header with a 400', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1);
      const result = await connect({
        ...bearer(live.token),
        'x-kasuwa-programme-ids': PROGRAMME_A2,
      });
      expect('refused' in result && result.refused.status).toBe(400);
    });

    it('accepts a live Bearer, and a cookie with the allowed Origin', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1);
      const viaBearer = await connected(bearer(live.token));
      expect(viaBearer.frames[0]).toEqual({ type: 'hello', authenticated: true });
      const viaCookie = await connected({
        cookie: `${SESSION_COOKIE_NAME}=${live.token}`,
        origin: ORIGIN,
      });
      expect(viaCookie.frames[0]).toEqual({ type: 'hello', authenticated: true });
    });

    it('says nothing about who it is, and no longer echoes', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1);
      const socket = await connected(bearer(live.token));
      expect(JSON.stringify(socket.frames[0])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      socket.ws.send('ping');
      socket.ws.send(JSON.stringify({ type: 'subscribe', programmeIds: [PROGRAMME_A1] }));
      await vi.waitFor(
        () => expect(socket.frames.some((f) => f.type === 'subscribed')).toBe(true),
        {
          timeout: 10_000,
        },
      );
      expect(
        socket.frames.some((f) => f.type === 'echo'),
        'the echo handler is still there',
      ).toBe(false);
    });
  });

  // =========================================================================
  // 2. What a socket may subscribe to (I4, I5).
  // =========================================================================

  describe('2. a subscription outside the session’s scope is one identical error', () => {
    it('refuses another programme, another tenant’s programme and a random id the same way', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1);
      const socket = await connected(bearer(live.token));
      const errors: string[] = [];
      for (const id of [PROGRAMME_A2, PROGRAMME_B1, randomUUID()]) {
        const before = socket.frames.length;
        socket.ws.send(JSON.stringify({ type: 'subscribe', programmeIds: [id] }));
        await vi.waitFor(() => expect(socket.frames.length).toBeGreaterThan(before), {
          timeout: 10_000,
        });
        const frame = socket.frames[socket.frames.length - 1] as Record<string, unknown>;
        expect(frame.type).toBe('error');
        expect(frame.code).toBe('not_found');
        expect(JSON.stringify(frame), 'the error names the id it refused').not.toContain(id);
        errors.push(JSON.stringify(frame));
      }
      expect(new Set(errors).size, 'the three refusals must be one body').toBe(1);
    });

    it('ignores a tenant id the client supplies', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1);
      const socket = await connected(bearer(live.token));
      socket.ws.send(
        JSON.stringify({ type: 'subscribe', tenantId: TENANT_B, programmeIds: [PROGRAMME_B1] }),
      );
      await vi.waitFor(() => expect(socket.frames.some((f) => f.type === 'error')).toBe(true), {
        timeout: 10_000,
      });
    });
  });

  // =========================================================================
  // 3. What a socket receives (I6).
  // =========================================================================

  describe('3. events are filtered by tenant and programme on the server', () => {
    it('an agent in A1 receives A1 events and nothing from A2, B1 or a malformed event', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1);
      const socket = await connected(bearer(live.token));
      const own = event(TENANT_A, PROGRAMME_A1, 'own.event');

      await publish(redisUrl(), event(TENANT_A, PROGRAMME_A2, 'other.programme'));
      await publish(redisUrl(), event(TENANT_B, PROGRAMME_B1, 'other.tenant'));
      await publish(
        redisUrl(),
        event(TENANT_B, PROGRAMME_A1, 'foreign.tenant.with.my.programme.id'),
      );
      await publish(redisUrl(), event(TENANT_A, undefined, 'no.programme'));
      await publish(redisUrl(), 'not json at all');
      await publish(redisUrl(), own);
      await waitSentinel(socket, 'own.event');

      expect(delivered(socket.frames).map((e) => e.type)).toEqual(['own.event']);
      const received = delivered(socket.frames)[0] as Record<string, unknown>;
      expect(Object.keys(received).sort(), 'an event carries no tenant id').toEqual([
        'ids',
        'programmeId',
        'type',
      ]);
      expect(received.ids).toEqual(own.ids);
    });

    it('a supervisor in A1 and A2 receives both, and a user with no programme receives nothing', async () => {
      const supervisor = await connected(
        bearer((await session(TENANT_A, USER_A_SUPERVISOR)).token),
      );
      const nobody = await connected(bearer((await session(TENANT_A, USER_A_NO_PROGRAMME)).token));

      await publish(redisUrl(), event(TENANT_A, PROGRAMME_A1, 'a1'));
      await publish(redisUrl(), event(TENANT_A, PROGRAMME_A2, 'a2'));
      await publish(redisUrl(), event(TENANT_B, PROGRAMME_B1, 'b1'));
      await publish(redisUrl(), event(TENANT_A, PROGRAMME_A1, 'end'));
      await waitSentinel(supervisor, 'end');
      await waitSentinel(supervisor, 'a2');

      expect(
        delivered(supervisor.frames)
          .map((e) => e.type)
          .sort(),
      ).toEqual(['a1', 'a2', 'end']);
      expect(delivered(nobody.frames), 'a user with no programme got an event').toEqual([]);
    });

    it('a subscription narrows delivery to the programmes named', async () => {
      const supervisor = await connected(
        bearer((await session(TENANT_A, USER_A_SUPERVISOR)).token),
      );
      supervisor.ws.send(JSON.stringify({ type: 'subscribe', programmeIds: [PROGRAMME_A1] }));
      await vi.waitFor(
        () => expect(supervisor.frames.some((f) => f.type === 'subscribed')).toBe(true),
        {
          timeout: 10_000,
        },
      );
      await publish(redisUrl(), event(TENANT_A, PROGRAMME_A2, 'not.subscribed'));
      await publish(redisUrl(), event(TENANT_A, PROGRAMME_A1, 'subscribed'));
      await waitSentinel(supervisor, 'subscribed');
      expect(delivered(supervisor.frames).map((e) => e.type)).toEqual(['subscribed']);
    });

    it('a tenant B user never receives tenant A events', async () => {
      const b = await connected(bearer((await session(TENANT_B, USER_B_AGENT_1)).token));
      await publish(redisUrl(), event(TENANT_A, PROGRAMME_A1, 'a.only'));
      await publish(redisUrl(), event(TENANT_B, PROGRAMME_B1, 'b.sentinel'));
      await waitSentinel(b, 'b.sentinel');
      expect(delivered(b.frames).map((e) => e.type)).toEqual(['b.sentinel']);
    });
  });

  // =========================================================================
  // 4. Scope is not frozen against revocation (I7).
  // =========================================================================

  describe('4. revocation closes the socket', () => {
    it('a revoked session stops receiving and is closed', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1);
      const socket = await connected(bearer(live.token));
      await observer.query('UPDATE auth_session SET revoked_at = now() WHERE id = $1', [live.id]);
      await vi.waitFor(() => expect(socket.isClosed()).toBe(true), {
        timeout: 15_000,
        interval: 100,
      });
      await publish(redisUrl(), event(TENANT_A, PROGRAMME_A1, 'after.revocation'));
      expect(delivered(socket.frames).map((e) => e.type)).not.toContain('after.revocation');
    }, 30_000);

    it('a membership removed from user_programme closes the socket', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1);
      const socket = await connected(bearer(live.token));
      await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [
        USER_A_AGENT_1,
        PROGRAMME_A1,
      ]);
      await vi.waitFor(() => expect(socket.isClosed()).toBe(true), {
        timeout: 15_000,
        interval: 100,
      });
    }, 30_000);

    it('a session that expires closes the socket', async () => {
      const live = await session(TENANT_A, USER_A_AGENT_1, { expiresInMs: 3_000 });
      const socket = await connected(bearer(live.token));
      await vi.waitFor(() => expect(socket.isClosed()).toBe(true), {
        timeout: 20_000,
        interval: 100,
      });
    }, 30_000);
  });

  it('never logs a token', () => {
    expect(output).not.toMatch(/ksw_s1_/);
  });
});
