/**
 * Self-test for ports.mjs: `node --test tests/e2e/scripts/ports.test.mjs`.
 *
 * Plain `node:test`, because no vitest project includes tests/e2e (the
 * Playwright specs live there) and this must not need Docker. It uses its own
 * port range and lock directory, so it never collides with a real e2e run on
 * the same machine. POSIX only: the ownership check is skipped on Windows.
 *
 * Every positive check here has a negative twin that is seen to fail first:
 * a lock that is skipped and one that is taken over, a squatter that is
 * skipped and a clean port that is not, a shadowed listener that throws and a
 * clean one that does not.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PortInUseError,
  assertListenersBelongTo,
  configurePorts,
  lockFile,
  releaseAllPorts,
  releasePort,
  reservePort,
} from './ports.mjs';

const FIRST = 31000;
const LAST = 31099;
const lockDir = mkdtempSync(join(tmpdir(), 'kasuwa-e2e-ports-test-'));
const portsModule = resolve(import.meta.dirname, 'ports.mjs');

function listen(port, host) {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(port, host, () => done(server));
  });
}

function close(server) {
  return new Promise((done) => server.close(() => done()));
}

/** A child that stays alive until killed, in a process group of its own. */
function spawnIdle(script = 'setInterval(() => {}, 1000)') {
  return spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
}

function firstLine(child) {
  return new Promise((done) => {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        done(buffer.split('\n')[0]);
      }
    });
    child.once('exit', () => done(buffer.split('\n')[0]));
  });
}

function stop(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

before(() => configurePorts({ first: FIRST, last: LAST, lockDir }));
after(() => {
  releaseAllPorts();
  rmSync(lockDir, { recursive: true, force: true });
});

describe('reservePort', () => {
  it('reserves the lowest free port in the range, records our pid, and releases it', async () => {
    const reservation = await reservePort('first');
    assert.equal(reservation.port, FIRST);
    assert.equal(readFileSync(lockFile(FIRST), 'utf8').split('\n')[0], String(process.pid));
    // Held, not just locked: a stranger's bind on the same address fails.
    await assert.rejects(listen(FIRST, '127.0.0.1'), { code: 'EADDRINUSE' });
    await reservation.handOff();
    const after = await listen(FIRST, '127.0.0.1'); // free for the child now
    await close(after);
    releasePort(FIRST);
    assert.equal(existsSync(lockFile(FIRST)), false);
  });

  it('skips a port locked by a live process, and takes over one whose owner is dead', async () => {
    const owner = spawnIdle();
    const exited = new Promise((done) => owner.once('exit', done));
    try {
      writeFileSync(lockFile(FIRST), `${owner.pid}\nanother run\n`);
      const skipped = await reservePort('live owner');
      releasePort(skipped.port);
      assert.equal(skipped.port, FIRST + 1, 'a live owner lost its port');
    } finally {
      stop(owner);
    }
    await exited;
    const reclaimed = await reservePort('dead owner');
    releasePort(reclaimed.port);
    assert.equal(reclaimed.port, FIRST, 'a dead owner kept its port');
  });

  it('skips a port that a process holding no lock is listening on, wildcard or loopback', async () => {
    const loopback = await listen(FIRST, '127.0.0.1');
    const wildcard = await listen(FIRST + 1, '::');
    try {
      const logs = [];
      const reservation = await reservePort('squatted', (line) => logs.push(line));
      releasePort(reservation.port);
      assert.equal(reservation.port, FIRST + 2);
      assert.match(logs.join('\n'), new RegExp(`port ${FIRST} has a listener`));
      assert.match(logs.join('\n'), new RegExp(`port ${FIRST + 1} has a listener`));
      assert.equal(existsSync(lockFile(FIRST)), false, 'a skipped port kept its lock');
    } finally {
      releaseAllPorts();
      await close(loopback);
      await close(wildcard);
    }
  });

  it('never gives two processes reserving at the same moment the same port', async () => {
    const script = `
      import(${JSON.stringify(portsModule)}).then(async (m) => {
        m.configurePorts({ first: ${FIRST}, last: ${LAST}, lockDir: ${JSON.stringify(lockDir)} });
        const ports = [];
        for (let i = 0; i < 5; i += 1) ports.push((await m.reservePort('race')).port);
        process.stdout.write(ports.join(',') + '\\n');
        setInterval(() => {}, 1000);
      });`;
    const children = Array.from({ length: 4 }, () => spawnIdle(script));
    try {
      const lines = await Promise.all(children.map(firstLine));
      const ports = lines.flatMap((line) => line.split(',').map(Number));
      assert.equal(ports.length, 20);
      assert.equal(new Set(ports).size, 20, `a port was handed out twice: ${lines.join(' | ')}`);
    } finally {
      children.forEach(stop);
    }
  });
});

describe('assertListenersBelongTo', () => {
  async function serverChild(port) {
    const child = spawnIdle(
      `require('node:net').createServer().listen(${port}, () => process.stdout.write('up\\n'))`,
    );
    await firstLine(child);
    return child;
  }

  it('accepts a port whose only listener is in the given process group', async () => {
    const child = await serverChild(FIRST + 50);
    try {
      await assertListenersBelongTo(FIRST + 50, child.pid);
    } finally {
      stop(child);
    }
  });

  it('throws when a stranger on 127.0.0.1 shadows our wildcard listener (no EADDRINUSE on macOS)', async () => {
    const child = await serverChild(FIRST + 51); // binds the wildcard, like the API
    let squatter;
    try {
      // On Linux this bind is refused; on macOS it succeeds and wins 127.0.0.1.
      squatter = await listen(FIRST + 51, '127.0.0.1').catch(() => undefined);
      if (squatter === undefined) {
        return; // Linux semantics: the shadow cannot happen, nothing to detect
      }
      await assert.rejects(assertListenersBelongTo(FIRST + 51, child.pid), PortInUseError);
    } finally {
      if (squatter) {
        await close(squatter);
      }
      stop(child);
    }
  });

  it('throws when the group given is not the listener\'s', async () => {
    const child = await serverChild(FIRST + 52);
    try {
      await assert.rejects(assertListenersBelongTo(FIRST + 52, process.pid), PortInUseError);
    } finally {
      stop(child);
    }
  });

  it('throws when nobody we can see is listening', async () => {
    await assert.rejects(assertListenersBelongTo(FIRST + 53, process.pid), PortInUseError);
  });
});
