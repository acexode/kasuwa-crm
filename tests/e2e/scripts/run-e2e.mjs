#!/usr/bin/env node
/**
 * `pnpm test:e2e` — one command from a clean checkout to a Playwright run
 * against the real stack.
 *
 *   1. a static fixture server, for the harness's own self-measurements
 *   2. Postgres via Testcontainers, migrated and seeded with the SAME fixtures
 *      the isolation suite uses (`packages/db/src/fixtures.ts`)
 *   3. apps/api, pointed at that container
 *   4. apps/web, warmed up so the first navigation in a spec is not also the
 *      first compile
 *   5. Playwright
 *
 * It is plain Node rather than Playwright's own `webServer` because the API's
 * DATABASE_URL is not knowable until the container has a mapped port, and
 * because the team develops on Windows — a bash-only runner would make the
 * primary developer's machine the unsupported one.
 *
 * WHY THE PROJECT IS CHOSEN HERE
 *
 * `tests/e2e/fixtures/over-budget.spec.ts` exists to fail. It lives in its own
 * Playwright project so the normal run can ignore it, and this script selects
 * that project only when the caller asks for `@over-budget`. That run needs no
 * database, so it starts the fixture server alone and finishes in seconds.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection, createServer as createSocketServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const scriptsDir = resolve(import.meta.dirname);
const e2eRoot = resolve(scriptsDir, '..');
const repoRoot = resolve(e2eRoot, '..', '..');
const artifactsDir = join(e2eRoot, '.artifacts');
const assetsDir = join(e2eRoot, 'fixtures', 'assets');

const STARTUP_TIMEOUT_MS = 240_000;
const POLL_MS = 250;
const SHUTDOWN_GRACE_MS = 10_000;

const forwardedArgs = process.argv.slice(2).filter((argument) => argument !== '--');
const wantsOverBudget = forwardedArgs.join(' ').includes('over-budget');
const projectName = wantsOverBudget ? 'over-budget' : 'chromium';

const cleanups = [];

function log(message) {
  process.stdout.write(`[e2e] ${message}\n`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createSocketServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/**
 * Wait for a server to answer. A poll on real readiness, never a fixed sleep:
 * the whole harness is built on the premise that waiting on a clock is how a
 * suite becomes flaky.
 */
async function waitForHttp(url, label) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = 'no attempt made';
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    if (Date.now() > deadline) {
      throw new Error(`${label} never became ready at ${url} (last: ${lastError})`);
    }
    await sleep(POLL_MS);
  }
}

async function waitForPortClosed(port) {
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  for (;;) {
    const open = await new Promise((done) => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.on('connect', () => {
        socket.destroy();
        done(true);
      });
      socket.on('error', () => done(false));
    });
    if (!open || Date.now() > deadline) {
      return;
    }
    await sleep(POLL_MS);
  }
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    // `child.kill()` on Windows kills the shim, not the node process it
    // launched, and an orphaned Next dev server holds its port for the next run.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

/** Deterministic filler, so a fixture page's byte count is exact and repeatable. */
function filler(bytes) {
  const body = '/* kasuwa e2e filler */\n';
  const unit = '/* 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef */\n';
  let out = body;
  while (out.length + unit.length <= bytes) {
    out += unit;
  }
  return out.padEnd(bytes, ' ');
}

function startFixtureServer(port) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);

    if (url.pathname === '/filler.css') {
      const bytes = Number(url.searchParams.get('bytes') ?? '1024');
      const payload = Buffer.from(filler(bytes), 'utf8');
      response.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'content-length': String(payload.byteLength),
        'cache-control': 'no-store',
      });
      response.end(payload);
      return;
    }

    const name = url.pathname === '/' ? '/shell.html' : url.pathname;
    const file = join(assetsDir, name.replace(/^\/+/, ''));
    if (!file.startsWith(assetsDir) || !existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }

    const payload = readFileSync(file);
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(payload.byteLength),
      'cache-control': 'no-store',
    });
    response.end(payload);
  });

  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => {
      cleanups.push(() => new Promise((closed) => server.close(closed)));
      done(server);
    });
  });
}

function pipeTo(child, label) {
  const forward = (stream, target) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') {
          target.write(`[${label}] ${line}\n`);
        }
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
}

/** Start the seeded Postgres container and return its connection strings. */
function startDatabase() {
  const child = spawn('pnpm', ['exec', 'tsx', join('scripts', 'start-stack.ts')], {
    cwd: e2eRoot,
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  cleanups.push(async () => {
    child.stdin.end();
    const exited = new Promise((done) => child.on('exit', done));
    const timer = setTimeout(() => killTree(child), SHUTDOWN_GRACE_MS);
    await exited;
    clearTimeout(timer);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[db] ${chunk}`));

  return new Promise((done, fail) => {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('{')) {
        done(JSON.parse(line));
      }
    });
    child.on('exit', (code) => fail(new Error(`the database stack exited with ${code}`)));
  });
}

function startApi(databaseUrl, port) {
  const child = spawn('pnpm', ['exec', 'tsx', join('src', 'main.ts')], {
    cwd: join(repoRoot, 'apps', 'api'),
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // The stub guard asserts an identity and grants no scope of its own; the
      // database still decides what that identity reaches. @kasuwa/config
      // refuses to boot this combination with NODE_ENV=production.
      KASUWA_AUTH_MODE: 'stub',
      DATABASE_URL: databaseUrl,
      API_PORT: String(port),
      LOG_LEVEL: 'error',
    },
  });
  pipeTo(child, 'api');
  cleanups.push(async () => {
    killTree(child);
    await waitForPortClosed(port);
  });
  return child;
}

function startWeb(apiUrl, port) {
  const child = spawn('pnpm', ['exec', 'next', 'dev', '-p', String(port)], {
    cwd: join(repoRoot, 'apps', 'web'),
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_PUBLIC_API_URL: apiUrl,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });
  pipeTo(child, 'web');
  cleanups.push(async () => {
    killTree(child);
    await waitForPortClosed(port);
  });
  return child;
}

function runPlaywright() {
  const args = [
    'exec',
    'playwright',
    'test',
    '--config',
    'playwright.config.ts',
    '--project',
    projectName,
    ...forwardedArgs,
  ];
  const child = spawn('pnpm', args, {
    cwd: e2eRoot,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  return new Promise((done) => child.on('exit', (code) => done(code ?? 1)));
}

async function teardown() {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      process.stderr.write(`[e2e] cleanup failed: ${error.message}\n`);
    }
  }
  cleanups.length = 0;
}

async function main() {
  mkdirSync(artifactsDir, { recursive: true });

  if (!wantsOverBudget) {
    // Stale numbers from a previous run would be indistinguishable from numbers
    // this run produced, and the acceptance suite reads this file.
    rmSync(join(artifactsDir, 'harness-metrics.json'), { force: true });
  }

  const fixturesPort = await freePort();
  await startFixtureServer(fixturesPort);
  const fixturesUrl = `http://127.0.0.1:${fixturesPort}`;
  log(`fixture server on ${fixturesUrl}`);

  let apiUrl = '';
  let webUrl = '';

  if (!wantsOverBudget) {
    log('starting Postgres (Testcontainers), migrating and seeding...');
    const database = await startDatabase();

    const apiPort = await freePort();
    apiUrl = `http://127.0.0.1:${apiPort}`;
    startApi(database.databaseUrl, apiPort);
    await waitForHttp(`${apiUrl}/health`, 'the API');
    log(`api on ${apiUrl}`);

    const webPort = await freePort();
    webUrl = `http://127.0.0.1:${webPort}`;
    startWeb(apiUrl, webPort);
    // Next compiles a route on first request. Doing that here rather than
    // inside a spec keeps the compile out of the measured navigation.
    await waitForHttp(webUrl, 'the web app');
    log(`web on ${webUrl}`);
  }

  // One file per Playwright project, not a shared `stack.json`. Two
  // `pnpm test:e2e` runs in one checkout both wrote the shared name, and the
  // `over-budget` run writes empty urls — so a concurrent normal run failed
  // every remaining test with `navigating to ""`, which looks exactly like a
  // broken route and is not. It cost the T-0007 builder three runs and then
  // turned the blocking isolation gate red, because the harness acceptance
  // suite runs this script twice by design.
  //
  // `support/stack.ts` reads the same name from `test.info().project.name`.
  writeFileSync(
    join(artifactsDir, `stack.${projectName}.json`),
    `${JSON.stringify({ webUrl, apiUrl, fixturesUrl }, null, 2)}\n`,
    'utf8',
  );

  log(`running playwright project "${projectName}"`);
  return runPlaywright();
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  process.stderr.write(`[e2e] ${error.stack ?? error.message}\n`);
  exitCode = 1;
} finally {
  await teardown();
}

process.exit(exitCode);
