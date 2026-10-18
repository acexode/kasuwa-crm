/**
 * PORTS FOR THE E2E RUNNER: RESERVED ACROSS RUNS, AND CHECKED FOR WHO ANSWERS.
 *
 * The runner used to ask the OS for a free port (`listen(0)`), close the socket
 * and hand the NUMBER to a child that bound it seconds — for the API, minutes,
 * across the whole `next build` — later. Three things went wrong with that:
 *
 *   1. Time of check, time of use. Another worktree's run asking the same
 *      question in that gap got the same answer. 2026-10-18: an activities-screen
 *      run's API died with EADDRINUSE on 49169, and 32 tests failed.
 *
 *   2. `listen(0)` draws from the OS ephemeral range (49152–65535 on macOS and
 *      Windows, 32768–60999 on Linux), which is also where every in-process
 *      acceptance server (`app.listen(0)`, supertest) and every outgoing
 *      connection gets its port. Those are bound when the kernel picks them, so
 *      they are safe by themselves — but the runner then BOUND THEM AGAIN later,
 *      explicitly, from a stale number.
 *
 *   3. On macOS (BSD sockets) with SO_REUSEADDR, which Node always sets, a
 *      listener on 127.0.0.1:P and a listener on the wildcard `::`:P do NOT
 *      conflict, in either order. Neither gets EADDRINUSE, and a connection to
 *      127.0.0.1:P reaches the specific one. The API binds the wildcard
 *      (`app.listen(port)`), the web servers bind 127.0.0.1, and every client
 *      dials 127.0.0.1. So a stale port could leave the API booted, healthy and
 *      silently shadowed, with readiness answered by somebody else's process —
 *      and an acceptance suite's in-process API could be shadowed in the same
 *      way by a `next start` this runner put on "its" port. That is the
 *      mechanism behind the two foreign answers in D-L139 (a 401 in another
 *      error format, a response with no Cache-Control).
 *
 * So:
 *
 *   - Ports come from 20000–29999, below every OS's ephemeral range, so nothing
 *     the kernel hands out lands on one.
 *   - A port is RESERVED across processes by a lock file in
 *     `<tmpdir>/kasuwa-e2e-ports/` naming the owner pid. The file is written
 *     whole under a temporary name and then hard-linked into place, which is
 *     atomic and fails if the name exists, so no reader ever sees a lock with
 *     no owner in it. A lock whose owner is dead is stale and is taken over.
 *   - Before a reserved port is handed out it is probed: anything that accepts
 *     a connection on 127.0.0.1 or ::1 means it is taken by something that
 *     does not use these locks, and the port is skipped. Then the runner BINDS
 *     it and keeps it bound until the moment before the child is spawned, so
 *     the long gap (the web build) is held by the OS, not merely by a promise.
 *   - Readiness is verified to come from the process this run spawned
 *     (`assertListenersBelongTo`): every listener on the port must be in the
 *     child's process group. Any other listener, or one the check cannot see,
 *     is a PortInUseError, and the runner retries on another port.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Below Linux's 32768 and macOS/Windows's 49152 ephemeral floors. */
export const PORT_RANGE = Object.freeze({ first: 20000, last: 29999 });

export const LOCK_DIR = join(tmpdir(), 'kasuwa-e2e-ports');

/**
 * What reservePort scans and where it keeps its locks. Only ports.test.mjs
 * changes it, so the test cannot collide with a real run on the machine.
 */
const config = { first: PORT_RANGE.first, last: PORT_RANGE.last, lockDir: LOCK_DIR };

export function configurePorts({ first, last, lockDir }) {
  config.first = first;
  config.last = last;
  config.lockDir = lockDir;
}

/** The port is held by a process that is not the one this run spawned. */
export class PortInUseError extends Error {
  constructor(port, detail) {
    super(`port ${port} ${detail}`);
    this.name = 'PortInUseError';
    this.port = port;
  }
}

/** port -> the socket holding it until hand-off (null once handed off). */
const reservations = new Map();

export function lockFile(port) {
  return join(config.lockDir, `${port}.lock`);
}

function uniqueSuffix() {
  return `${process.pid}.${randomBytes(4).toString('hex')}`;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === 'EPERM';
  }
}

function readOwner(file) {
  try {
    return Number.parseInt(readFileSync(file, 'utf8').split('\n')[0], 10);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Take the lock file for `port`, or return false if a live process holds it.
 *
 * A stale lock is RENAMED aside before it is deleted, never unlinked by path:
 * two runs that both judged it stale would otherwise race, and the second
 * unlink could delete the fresh lock the first had just linked. If the file
 * moved aside turns out to name a live owner, that is exactly that race, and
 * it is linked back.
 */
function tryLock(port, label) {
  const file = lockFile(port);
  const draft = join(config.lockDir, `.${port}.${uniqueSuffix()}.draft`);
  writeFileSync(draft, `${process.pid}\n${label}\n`, 'utf8');
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        linkSync(draft, file);
        return true;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
      const owner = readOwner(file);
      if (owner === undefined) {
        continue; // released between our link and our read
      }
      if (alive(owner)) {
        return false;
      }
      const aside = join(config.lockDir, `.${port}.${uniqueSuffix()}.stale`);
      try {
        renameSync(file, aside);
      } catch (error) {
        if (error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      const moved = readOwner(aside);
      if (moved !== undefined && moved !== owner && alive(moved)) {
        try {
          linkSync(aside, file);
        } catch {
          // Someone re-took the name meanwhile; their lock stands.
        }
        rmSync(aside, { force: true });
        return false;
      }
      rmSync(aside, { force: true });
    }
    return false;
  } finally {
    rmSync(draft, { force: true });
  }
}

function unlock(port) {
  const file = lockFile(port);
  if (readOwner(file) === process.pid) {
    rmSync(file, { force: true });
  }
}

/** Whether anything accepts a TCP connection on host:port. */
function answers(port, host) {
  return new Promise((done) => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    // ECONNREFUSED, or no IPv6 at all: nobody there.
    socket.once('error', () => done(false));
  });
}

/** Bind 127.0.0.1:port and keep it; undefined if the bind is refused. */
function hold(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(undefined));
    server.listen(port, '127.0.0.1', () => done(server));
  });
}

/**
 * Reserve a port from PORT_RANGE for this process.
 *
 * Returns `{ port, handOff }`. The port stays BOUND by this process until
 * `handOff()` resolves; call it immediately before spawning the child that will
 * bind it. The lock file stays until `releasePort` or `releaseAllPorts`.
 *
 * The scan is sequential from the bottom of the range, not random: which port a
 * run gets is then predictable, which is what makes a squatter reproducible in a
 * test. Concurrent runs contend for the same low ports, and the lock decides.
 */
export async function reservePort(label, log = () => {}) {
  mkdirSync(config.lockDir, { recursive: true });
  for (let port = config.first; port <= config.last; port += 1) {
    if (reservations.has(port) || !tryLock(port, label)) {
      continue;
    }
    if ((await answers(port, '127.0.0.1')) || (await answers(port, '::1'))) {
      log(`port ${port} has a listener that holds no kasuwa-e2e lock; skipping it`);
      unlock(port);
      continue;
    }
    const server = await hold(port);
    if (server === undefined) {
      log(`port ${port} refused a bind; skipping it`);
      unlock(port);
      continue;
    }
    reservations.set(port, server);
    log(`reserved port ${port} for ${label}`);
    return {
      port,
      handOff: () =>
        new Promise((done) => {
          const holder = reservations.get(port);
          reservations.set(port, null);
          if (!holder) {
            done();
            return;
          }
          holder.close(() => done());
        }),
    };
  }
  throw new Error(
    `no free port in ${config.first}-${config.last}: every one is locked or in use (see ${config.lockDir})`,
  );
}

export function releasePort(port) {
  const holder = reservations.get(port);
  if (holder) {
    holder.close();
  }
  reservations.delete(port);
  unlock(port);
}

/** Synchronous, so the runner's `exit` handler can call it. */
export function releaseAllPorts() {
  for (const port of [...reservations.keys()]) {
    releasePort(port);
  }
}

/** The ports this process currently holds a lock on (for tests). */
export function reservedPorts() {
  return [...reservations.keys()];
}

function run(command, args) {
  return new Promise((done, fail) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout) => {
      if (error && error.code === 'ENOENT') {
        fail(new Error(`${command} is required to verify who is listening on an e2e port, and was not found`));
        return;
      }
      // lsof and ps exit 1 when they match nothing; an empty list is the answer.
      done(stdout ?? '');
    });
  });
}

/** pid -> process group id, for every process listening on `port`. */
export async function listenersOn(port) {
  const pids = (await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']))
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid));
  const unique = [...new Set(pids)];
  if (unique.length === 0) {
    return new Map();
  }
  const groups = new Map();
  const table = await run('ps', ['-o', 'pid=,pgid=', '-p', unique.join(',')]);
  for (const line of table.split('\n')) {
    const [pid, pgid] = line.trim().split(/\s+/).map((field) => Number.parseInt(field, 10));
    if (Number.isInteger(pid) && Number.isInteger(pgid)) {
      groups.set(pid, pgid);
    }
  }
  for (const pid of unique) {
    if (!groups.has(pid)) {
      groups.set(pid, undefined); // exited between lsof and ps
    }
  }
  return groups;
}

/**
 * Throw PortInUseError unless every listener on `port` belongs to process group
 * `groupId` — the group the runner's child leads (it is spawned `detached`).
 *
 * "Every", not "some": on macOS our wildcard listener and a stranger's
 * 127.0.0.1 listener coexist, and the stranger is the one clients reach. And
 * none visible after an HTTP answer means the answer came from a process this
 * user cannot inspect, which is not ours either.
 *
 * Windows: skipped. There is no lsof, and the runner kills Windows trees with
 * taskkill rather than process groups, so there is no group to compare
 * against. Reservation and the range still apply there.
 */
export async function assertListenersBelongTo(port, groupId) {
  if (process.platform === 'win32') {
    return;
  }
  const listeners = await listenersOn(port);
  if (listeners.size === 0) {
    throw new PortInUseError(port, 'answered, but no listener of ours is on it');
  }
  const foreign = [...listeners].filter(([, pgid]) => pgid !== groupId).map(([pid]) => pid);
  if (foreign.length > 0) {
    throw new PortInUseError(
      port,
      `is also held by pid ${foreign.join(', ')}, outside this run's process group ${groupId}`,
    );
  }
}
