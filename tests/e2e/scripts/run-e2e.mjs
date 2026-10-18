#!/usr/bin/env node
/**
 * `pnpm test:e2e` — one command from a clean checkout to a Playwright run
 * against the real stack.
 *
 *   1. a static fixture server, for the harness's own self-measurements
 *   2. Postgres via Testcontainers, migrated and seeded with the SAME fixtures
 *      the isolation suite uses (`packages/db/src/fixtures.ts`)
 *   3. apps/api, pointed at that container
 *   4. apps/web, BUILT for production (`next build`) and served with
 *      `next start` — the thing we deploy, so the bytes a spec measures are the
 *      bytes a user pays (T-0010, D-L28). Locally and in CI alike: one path, or
 *      the two sets of numbers disagree and nobody trusts either.
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
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PortInUseError,
  assertListenersBelongTo,
  listenersOn,
  releaseAllPorts,
  releasePort,
  reservePort,
} from './ports.mjs';

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

/** How many ports a server may be tried on before the run gives up. */
const MAX_PORT_ATTEMPTS = 3;

/**
 * Watch a just-spawned server for the two ways it can lose its port: saying
 * EADDRINUSE, or exiting. Listeners are added beside pipeTo's, not instead of
 * them, so the output still reaches the terminal unchanged.
 */
function watchStartup(child, port) {
  const watch = { child, port, addressInUse: false, exited: false };
  const scan = (chunk) => {
    if (String(chunk).includes('EADDRINUSE')) {
      watch.addressInUse = true;
    }
  };
  child.stdout?.on('data', scan);
  child.stderr?.on('data', scan);
  // 'close', not 'exit': 'exit' can fire before the last of stderr is read,
  // and an EADDRINUSE still in the pipe would be reported as a plain crash.
  child.once('close', () => {
    watch.exited = true;
  });
  return watch;
}

/**
 * Wait for OUR server to answer. A poll on real readiness, never a fixed sleep:
 * the whole harness is built on the premise that waiting on a clock is how a
 * suite becomes flaky.
 *
 * An answer is not enough on its own (see ports.mjs): every HTTP answer is
 * followed by a check that every listener on the port is in the process group
 * of the child this run spawned. A stranger's answer — ready or not — throws
 * PortInUseError, and so does the child reporting EADDRINUSE.
 */
async function waitForHttp(url, label, watch) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = 'no attempt made';
  for (;;) {
    if (watch.addressInUse) {
      throw new PortInUseError(watch.port, `was refused to ${label} (EADDRINUSE)`);
    }
    if (watch.exited) {
      throw new Error(`${label} exited before it answered at ${url}`);
    }
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      lastError = error.message;
    }
    if (response !== undefined) {
      await assertListenersBelongTo(watch.port, watch.child.pid);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
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

/**
 * EVERY CHILD LEADS ITS OWN PROCESS GROUP, AND IS STOPPED AS A GROUP.
 *
 * Each server is `pnpm exec <tool>`, so the process this script holds is the
 * pnpm wrapper, and the server itself (tsx and its node child, next-server)
 * sits one or two levels below it. `child.kill('SIGTERM')` signalled only the
 * wrapper; the servers survived as orphans, holding their ports and about a
 * gigabyte each. One lead verification of eleven records-ui and scripting-ui
 * suites left 11 API servers and 33 next-server processes running, ~7 GB on a
 * 16 GB machine.
 *
 * So on POSIX each child is spawned `detached`, which makes it the leader of a
 * new process group whose id is its pid, and everything it starts inherits
 * that group. Stopping signals the whole group (`process.kill(-pid)`), SIGTERM
 * first and SIGKILL if any member outlives the grace period.
 *
 * The price of `detached` is that a child no longer shares the terminal's
 * foreground group, so a Ctrl-C reaches this script and nothing else. That is
 * why the signal handlers at the bottom of this file exist: they are the only
 * thing that stops the servers when the runner is interrupted.
 *
 * Windows keeps `taskkill /T /F`, which walks the tree itself.
 */
const POSIX_GROUPS = process.platform !== 'win32';
const KILL_GRACE_MS = 5_000;

/** Every child this run started, so the final sweep can reach all of them. */
const started = new Set();
let shuttingDown = false;

function spawnGroup(command, args, options) {
  const child = spawn(command, args, { ...options, detached: POSIX_GROUPS });
  started.add(child);
  if (shuttingDown) {
    // Started by a main() that has not yet noticed a signal arrived. It is
    // stopped at once rather than left for a teardown that has already run.
    void killTree(child);
  }
  return child;
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

/** Whether ANY member of the child's group is alive, not just its leader. */
function groupAlive(child) {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function killTree(child) {
  if (child.pid === undefined) {
    // spawn itself failed; there is nothing to stop.
    return;
  }
  if (!POSIX_GROUPS) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    // `child.kill()` on Windows kills the shim, not the node process it
    // launched, and an orphaned Next dev server holds its port for the next run.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // The GROUP is the test, not the child: the pnpm wrapper exiting does not
  // take tsx or next-server with it, so a dead leader proves nothing.
  if (!groupAlive(child)) {
    return;
  }
  signalGroup(child, 'SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;
  while (groupAlive(child)) {
    if (Date.now() > deadline) {
      process.stderr.write(`[e2e] process group ${child.pid} outlived SIGTERM; sending SIGKILL\n`);
      signalGroup(child, 'SIGKILL');
      return;
    }
    await sleep(POLL_MS);
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

/**
 * In-process, so it binds port 0 and reports the port it was GIVEN: nothing is
 * released and re-bound later, so there is no gap for another process to take
 * it, and the kernel never hands out a port that is already bound.
 */
function startFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

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

  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      cleanups.push(() => new Promise((closed) => server.close(closed)));
      done(server.address().port);
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
  const child = spawnGroup('pnpm', ['exec', 'tsx', join('scripts', 'start-stack.ts')], {
    cwd: e2eRoot,
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Listened for at SPAWN, not at teardown. When start-stack fails early (no
  // container runtime, a bad migration) its 'exit' has already fired by the
  // time teardown runs, and a listener attached then waits forever — the
  // whole run hung after printing its error (found in T-0035, on a machine
  // without Docker).
  const exited = new Promise((done) => child.once('exit', done));

  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // Closing stdin asks start-stack to stop its container itself, which is
      // tidier than leaving it to Testcontainers' reaper.
      child.stdin.end();
      const timer = setTimeout(() => void killTree(child), SHUTDOWN_GRACE_MS);
      // Bounded even after the kill: on Windows `taskkill` of the shim may not
      // deliver an 'exit' for the process we hold, and teardown must finish.
      await Promise.race([exited, sleep(SHUTDOWN_GRACE_MS * 2)]);
      clearTimeout(timer);
    }
    // The wrapper's exit is not the tsx process's exit (see killTree).
    await killTree(child);
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

function startApi(databaseUrl, authDatabaseUrl, port) {
  const child = spawnGroup('pnpm', ['exec', 'tsx', join('src', 'main.ts')], {
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
      // kasuwa_auth: the only role that may write the auth tables (T-0049).
      // The API refuses to boot without it.
      DATABASE_AUTH_URL: authDatabaseUrl,
      API_PORT: String(port),
      LOG_LEVEL: 'error',
    },
  });
  pipeTo(child, 'api');
  cleanups.push(async () => {
    await killTree(child);
    await waitForPortClosed(port);
  });
  return child;
}

const WEB_DIR = join(repoRoot, 'apps', 'web');

/**
 * What no web process is given (T-0014). The web schema refuses to start, or
 * build, with a database URL or a server credential in its environment
 * (`WEB_FORBIDDEN` in packages/config/src/schemas.mjs): a browser-facing
 * process must never hold one. The harness inherits whatever shell started it,
 * so it drops them explicitly rather than trusting that shell. Node skips
 * `undefined` values when building a child's environment.
 */
const NO_DATABASE_URLS = {
  DATABASE_URL: undefined,
  DATABASE_MIGRATION_URL: undefined,
  DATABASE_AUTH_URL: undefined,
  KASUWA_KMS_LOCAL_MASTER_KEY: undefined,
  S3_ACCESS_KEY_ID: undefined,
  S3_SECRET_ACCESS_KEY: undefined,
  REDIS_URL: undefined,
  OPENSEARCH_URL: undefined,
};
const NEXT_ENV_FILE = join(WEB_DIR, 'next-env.d.ts');

/**
 * Next rewrites the TRACKED `next-env.d.ts` to point at whichever build
 * directory it last used. `next build` into the default `.next` writes the
 * same content it already has (Next skips an identical write), but the
 * self-serve dev server below uses `.next-self-serve` and does change it. So
 * the file is snapshotted before anything runs and put back after the build,
 * once both servers are up, and at teardown — a test run must not leave the
 * checkout dirty.
 */
function restoreNextEnv(original) {
  if (readFileSync(NEXT_ENV_FILE, 'utf8') !== original) {
    writeFileSync(NEXT_ENV_FILE, original, 'utf8');
  }
}

/**
 * `next build`, through apps/web's own wrapper (`build.mjs`), which pins
 * NODE_ENV=production so the ambient environment cannot change what is built.
 *
 * Every run builds afresh. A `.next` left over from an earlier checkout would
 * be measured as if it were the code under review, and the byte-budget
 * acceptance suite checks `BUILD_ID` is newer than the run for that reason.
 *
 * NEXT_PUBLIC_API_URL is passed at BUILD time as well as at start: the
 * `/api/v1` rewrite in next.config.mjs is resolved into the routes manifest by
 * `next build`, so the API's port has to be known before the build starts.
 *
 * KASUWA_FEATURE_FLAGS_ON is forced empty here too: the build evaluates nothing
 * flag-dependent today, but a developer's shell must never leak a flag into
 * the artefact the default server serves.
 */
function buildWeb(apiUrl) {
  const child = spawnGroup('node', ['build.mjs'], {
    cwd: WEB_DIR,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: apiUrl,
      NEXT_TELEMETRY_DISABLED: '1',
      KASUWA_FEATURE_FLAGS_ON: '',
      ...NO_DATABASE_URLS,
    },
  });
  pipeTo(child, 'web-build');
  cleanups.push(async () => killTree(child));
  return new Promise((done, fail) => {
    child.on('exit', (code) =>
      code === 0 ? done() : fail(new Error(`next build exited with ${code}`)),
    );
  });
}

/**
 * THE DEFAULT WEB SERVER — the production build, every flag at its default
 * (T-0010). `KASUWA_FEATURE_FLAGS_ON` is forced empty so a developer's shell
 * cannot leak a flag into it. This is the only server the byte budget measures.
 */
function startWeb(apiUrl, port) {
  const child = spawnGroup('pnpm', ['exec', 'next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: WEB_DIR,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // Every production process refuses an unset or `stub` auth mode
      // (T-0014), the web server included. The web process resolves no caller
      // itself: it proxies `/api/v1` to the API, which authenticates (and which
      // runs stub, under NODE_ENV=test, in this harness). So the web server
      // states the real mode, as a deployment would.
      KASUWA_AUTH_MODE: 'jwt',
      NEXT_PUBLIC_API_URL: apiUrl,
      NEXT_TELEMETRY_DISABLED: '1',
      KASUWA_FEATURE_FLAGS_ON: '',
      ...NO_DATABASE_URLS,
    },
  });
  pipeTo(child, 'web');
  cleanups.push(async () => {
    await killTree(child);
    await waitForPortClosed(port);
  });
  return child;
}

/**
 * THE SECOND WEB SERVER — `self_serve_signup` AND `admin_live_api` ON,
 * SERVER-SIDE (T-0007, T-0035).
 *
 * `P01/3`, `P01/4` and `P01/5.1` must be a 404 with the flag at its default
 * AND render with it on, and the acceptance suite reads both from ONE
 * Playwright run. A flag is per process, never per request — nothing a browser
 * sends may turn it on — so the run starts a second web process with the flag
 * named in its environment.
 *
 * IT IS `next dev`, NOT A PRODUCTION BUILD, AND IT CANNOT BE ONE.
 * `self_serve_signup` is marked `productionReady: false` in
 * `@kasuwa/feature-flags`, and a NODE_ENV=production process that names it in
 * `KASUWA_FEATURE_FLAGS_ON` refuses to boot (apps/web/instrumentation.ts) until
 * T-0016 ships the endpoints. That guard is the point; the harness does not
 * work around it. When T-0016 lifts the flag, this server can follow T-0010
 * onto `next start`. Nothing measures bytes here — a dev bundle is not a budget.
 *
 * It must not share `.next` with the production build, so it gets its own
 * build directory and its own generated tsconfig (both gitignored; see
 * `apps/web/next.config.mjs`).
 *
 * `admin_live_api` RIDES ON THE SAME PROCESS (T-0035). It is not
 * production-ready either, so a flag-on console could only ever be `next dev`
 * too, and a third Next process would cost the CI runner another gigabyte for
 * no extra evidence. It is a presentation switch, not an access control: it
 * swaps the two unbuilt KPI and skill-cover panels for labelled sample data,
 * and the console calls the same admin API either way. The two flags touch
 * disjoint screens — sign-up's three routes and two P02 panels — so neither
 * can mask the other. The `@p02-live` specs reach the
 * real API and the seeded database through this process with no interception;
 * the mocked `@p02` suite keeps running against the default server above, with
 * every flag at its default.
 */
const SELF_SERVE_DIST_DIR = '.next-self-serve';
const SELF_SERVE_TSCONFIG = 'tsconfig.e2e-self-serve.json';

function startSelfServeWeb(apiUrl, port) {
  writeFileSync(
    join(WEB_DIR, SELF_SERVE_TSCONFIG),
    `${JSON.stringify({ extends: './tsconfig.json' }, null, 2)}\n`,
    'utf8',
  );
  const child = spawnGroup('pnpm', ['exec', 'next', 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: WEB_DIR,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_PUBLIC_API_URL: apiUrl,
      NEXT_TELEMETRY_DISABLED: '1',
      KASUWA_FEATURE_FLAGS_ON: 'self_serve_signup,admin_live_api',
      ...NO_DATABASE_URLS,
      KASUWA_WEB_DIST_DIR: SELF_SERVE_DIST_DIR,
      KASUWA_WEB_TSCONFIG: SELF_SERVE_TSCONFIG,
    },
  });
  pipeTo(child, 'web:flags-on');
  cleanups.push(async () => {
    await killTree(child);
    await waitForPortClosed(port);
    // The dev build directory goes too. It is compiled output inside apps/web,
    // and the T-0014 acceptance scan walks apps/** for `process.env` reads,
    // skipping `.next` by name but not this sibling. Left behind, Next's
    // generated `middleware-build-manifest.js` fails that scan for any run
    // that follows an e2e run. `next dev` compiles on demand, so the next run
    // loses nothing it needs.
    rmSync(join(WEB_DIR, SELF_SERVE_DIST_DIR), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
  return child;
}

/**
 * THE THIRD WEB SERVER — `crm_records`, `crm_accounts`, `crm_record_view` AND
 * `crm_leads` ON, SERVER-SIDE (T-0042, T-0057, T-0062, T-0058, D-L64).
 *
 * The SAME production build as the default server (`next start` over `.next`),
 * because the `/contacts`, `/accounts`, `/contacts/[id]` and `/leads` byte
 * budgets are measured here and a dev bundle is not a budget (D-L28). No flag
 * here is production-ready, and a NODE_ENV=production process that names one refuses to boot — so this one
 * process runs with NODE_ENV=test, exactly as D-L64 rules. The guard itself is
 * untouched; the default server above stays flagless.
 *
 * `crm_accounts` RIDES ON THIS PROCESS (T-0057) rather than a fourth one: a
 * Next process costs the runner about a gigabyte, and the two flags gate
 * disjoint routes (`/contacts`, `/accounts`) in one CRM shell, whose nav links
 * each only where its flag is on. The stack file names it twice —
 * `webRecordsUrl` and `webAccountsUrl` — so a spec says which flag it relies
 * on, as `webLiveUrl` does for `webSelfServeUrl`.
 *
 * `crm_record_view` RIDES ON THIS PROCESS TOO (T-0062, D-L85): the P05 contact
 * record at `/contacts/[id]`. It sits in the CRM shell, whose Contacts link
 * needs `crm_records` wherever the record is served, and its byte budget is
 * measured on this same production build. `webRecordViewUrl` names this
 * process as well. The `@harness` tenancy spec drives `/contacts/[id]` here
 * against the real API, so it exercises the real record screen.
 *
 * `crm_leads` RIDES HERE TOO (T-0058), for the same reason, and is published
 * as `webLeadsUrl`. Its route, `/leads`, is disjoint from the others, and the
 * shell's nav links each screen only where its flag is on (`crmLiveNav()`), so
 * every link on every screen this process serves resolves here.
 *
 * `crm_activities` RIDES HERE TOO (T-0083), published as `webActivitiesUrl`.
 * The P07 screen's contact and account summaries link to `/contacts/[id]` and
 * `/accounts/[id]`, which this process serves, so every summary link resolves.
 * `crm_scripts` RIDES HERE TOO (T-0115, T-0116, D-L114): the P10 builder at
 * `/scripts`, the agent's run at `/script-runs/[runId]`, and the start control
 * on the contact record, which is why it sits beside `crm_records` and
 * `crm_record_view`. Published as `webScriptsUrl`. The `/scripts/[scriptId]`,
 * `/script-runs/[runId]` and (now with the start control) `/contacts/[id]`
 * budgets are all measured on this one build.
 * `crm_pipeline` RIDES HERE TOO (T-0109): the P06 board at
 * `/pipelines/[pipelineId]` and its index at `/pipelines`. Its cards' contact
 * and account summaries link to `/contacts/[id]` and `/accounts/[id]`, which
 * this process serves. Published as `webPipelineUrl`; the board's byte budget
 * is measured on this build.
 * `crm_search` RIDES HERE TOO (T-0087): the P27 screen at `/search` and the
 * Ctrl/Cmd+K palette in the CRM shell of every screen above. Its hits link to
 * `/contacts/[id]` and `/accounts/[id]`, and "see all" lands on `/contacts`,
 * `/leads` and `/accounts`, all served here. Published as `webSearchUrl`; the
 * `/search` byte budget is measured on this build, and the palette's weight
 * (loaded on first open only) is held by every other screen's budget here.
 */
function startRecordsWeb(apiUrl, port) {
  const child = spawnGroup('pnpm', ['exec', 'next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: WEB_DIR,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      // The real mode, as on the default server: the web process proxies
      // `/api/v1` and authenticates nobody itself (T-0014).
      KASUWA_AUTH_MODE: 'jwt',
      NEXT_PUBLIC_API_URL: apiUrl,
      NEXT_TELEMETRY_DISABLED: '1',
      KASUWA_FEATURE_FLAGS_ON: 'crm_records,crm_accounts,crm_record_view,crm_leads,crm_activities,crm_scripts,crm_pipeline,crm_search',
      ...NO_DATABASE_URLS,
    },
  });
  pipeTo(child, 'web:records');
  cleanups.push(async () => {
    await killTree(child);
    await waitForPortClosed(port);
  });
  return child;
}

/**
 * Reserve a port, hand it to a server and wait until THAT server answers on it.
 * If the port turns out to be taken (EADDRINUSE, or another process's listener
 * beside ours), the server is stopped and the whole thing is tried again on a
 * fresh port, up to MAX_PORT_ATTEMPTS times.
 *
 * `prepare(url)` runs while the port is still bound by this process, before
 * the server is spawned: the API uses it for the web build (which bakes in the
 * API's url) and the database, so the long gap is held by the OS.
 *
 * Returns `{ url, watch }`; `watch.child` is the spawned server.
 */
async function startOnReservedPort({ label, path = '', prepare, start }) {
  for (let attempt = 1; ; attempt += 1) {
    const reservation = await reservePort(label, log);
    const url = `http://127.0.0.1:${reservation.port}`;
    if (prepare !== undefined) {
      await prepare(url);
    }
    await reservation.handOff();
    const watch = watchStartup(start(reservation.port, url), reservation.port);
    try {
      await waitForHttp(`${url}${path}`, label, watch);
      return { url, watch };
    } catch (error) {
      if (!(error instanceof PortInUseError) || attempt >= MAX_PORT_ATTEMPTS) {
        throw error;
      }
      log(
        `${label}: ${error.message}; stopping it and retrying on another port (attempt ${attempt + 1} of ${MAX_PORT_ATTEMPTS})`,
      );
      await killTree(watch.child);
      releasePort(reservation.port);
    }
  }
}

/**
 * After Playwright: is every server still the only listener on its port? A
 * stranger that bound beside one mid-run (see ports.mjs) may have answered
 * some of the run's requests, so a green result could not be trusted.
 *
 * Only a FOREIGN listener counts here. A server of ours that died mid-run has
 * already failed the specs that needed it; it is not this check's business.
 */
async function findShadowedServers(servers) {
  if (process.platform === 'win32') {
    return []; // see assertListenersBelongTo
  }
  const shadowed = [];
  for (const { label, watch } of servers) {
    const listeners = await listenersOn(watch.port);
    const foreign = [...listeners].filter(([, pgid]) => pgid !== watch.child.pid).map(([pid]) => pid);
    if (foreign.length > 0) {
      shadowed.push(`${label}: port ${watch.port} is also held by pid ${foreign.join(', ')}`);
    }
  }
  return shadowed;
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
  // A group of its own too: interrupted, Playwright's workers and browsers
  // would otherwise outlive the runner. Pushed last, so stopped first.
  const child = spawnGroup('pnpm', args, {
    cwd: e2eRoot,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  cleanups.push(async () => killTree(child));
  return new Promise((done) => child.on('exit', (code) => done(code ?? 1)));
}

let teardownPromise;

/**
 * Idempotent: a signal can arrive while main() is still running, and main()'s
 * own `finally` then calls this a second time. Both get the same promise.
 */
function teardown() {
  teardownPromise ??= runTeardown();
  return teardownPromise;
}

async function runTeardown() {
  shuttingDown = true;
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      process.stderr.write(`[e2e] cleanup failed: ${error.message}\n`);
    }
  }
  cleanups.length = 0;
  // The sweep: every group this run started, whether or not a cleanup above
  // already stopped it (killTree is a no-op on a group that is gone). This is
  // what reaches Playwright and its browsers on an interrupted run, and any
  // server spawned after teardown began.
  await Promise.all([...started].map((child) => killTree(child)));
  // Last, once every server is stopped: the ports go back to the pool.
  releaseAllPorts();
}

/**
 * THE RUNNER'S OWN EXIT PATHS. Without these an interrupted run orphans every
 * server, because `detached` children do not receive the terminal's SIGINT
 * and do not die with the parent's session.
 *
 * A first signal runs the ordinary teardown (the database stack is asked to
 * remove its container). A second one, from someone who has stopped waiting,
 * SIGKILLs every group at once.
 */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
let signalExitCode;

for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    if (signalExitCode !== undefined) {
      killEveryGroupNow();
      process.exit(signalExitCode);
    }
    signalExitCode = code;
    process.stderr.write(`[e2e] ${signal} received; stopping every process this run started\n`);
    void teardown().finally(() => process.exit(code));
  });
}

/** Synchronous, for the paths that cannot wait: a second signal, process exit. */
function killEveryGroupNow() {
  if (!POSIX_GROUPS) {
    return;
  }
  for (const child of started) {
    if (child.pid !== undefined) {
      try {
        signalGroup(child, 'SIGKILL');
      } catch {
        // EPERM: not ours to kill, so not ours to leak either.
      }
    }
  }
}

// The last resort: whatever path ends this process — including an uncaught
// exception that skips teardown — no group it started outlives it. After a
// normal teardown every group is already gone and this does nothing.
process.on('exit', () => {
  killEveryGroupNow();
  // The port locks too. A lock whose owner is dead is reclaimed by the next
  // run anyway; this only spares it the check.
  releaseAllPorts();
});

// A SIGHUP usually means the terminal went away, and the next write to it
// fails with EIO or EPIPE. That must not crash the runner mid-teardown.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

async function main() {
  mkdirSync(artifactsDir, { recursive: true });

  if (!wantsOverBudget) {
    // Stale numbers from a previous run would be indistinguishable from numbers
    // this run produced, and the acceptance suite reads this file.
    rmSync(join(artifactsDir, 'harness-metrics.json'), { force: true });
    rmSync(join(artifactsDir, 'critical-path.json'), { force: true });
  }

  const fixturesPort = await startFixtureServer();
  const fixturesUrl = `http://127.0.0.1:${fixturesPort}`;
  log(`fixture server on ${fixturesUrl}`);

  let apiUrl = '';
  let webUrl = '';
  let webSelfServeUrl = '';
  let webRecordsUrl = '';
  const servers = [];

  if (!wantsOverBudget) {
    // The API's port is chosen first because the web build needs it (see
    // buildWeb). The build runs BEFORE the container starts, not beside it:
    // run side by side on a loaded machine, `next build`'s worker died with a
    // V8 fatal error once and hung in compile once, while the same build alone
    // succeeded every time. Forty seconds of wall clock is cheaper than a
    // harness that fails in setup for reasons unrelated to the change.
    //
    // Both happen inside `prepare`, while the API's port is still bound by
    // this process. If the API then loses its port anyway, the retry picks a
    // new one and rebuilds, because the old url is baked into the build.
    const nextEnv = readFileSync(NEXT_ENV_FILE, 'utf8');
    cleanups.push(async () => restoreNextEnv(nextEnv));
    let builtFor;
    let database;

    const api = await startOnReservedPort({
      label: 'the API',
      path: '/health',
      prepare: async (url) => {
        if (builtFor !== url) {
          log('building apps/web for production (next build)...');
          await buildWeb(url);
          restoreNextEnv(nextEnv);
          builtFor = url;
        }
        if (database === undefined) {
          log('starting Postgres (Testcontainers), migrating and seeding...');
          database = await startDatabase();
        }
      },
      start: (port) => startApi(database.databaseUrl, database.authDatabaseUrl, port),
    });
    apiUrl = api.url;
    servers.push({ label: 'the API', watch: api.watch });
    log(`api on ${apiUrl}`);

    // The production server is ready when it answers; the dev server also
    // compiles its first route on that request, which keeps the compile out of
    // a spec's navigation.
    const [web, selfServe, records] = await Promise.all([
      startOnReservedPort({ label: 'the web app', start: (port) => startWeb(apiUrl, port) }),
      startOnReservedPort({
        label: 'the self-serve web app',
        start: (port) => startSelfServeWeb(apiUrl, port),
      }),
      startOnReservedPort({
        label: 'the crm_records, crm_accounts, crm_record_view, crm_leads, crm_activities, crm_scripts, crm_pipeline and crm_search web app',
        start: (port) => startRecordsWeb(apiUrl, port),
      }),
    ]);
    webUrl = web.url;
    webSelfServeUrl = selfServe.url;
    webRecordsUrl = records.url;
    servers.push(
      { label: 'the web app', watch: web.watch },
      { label: 'the self-serve web app', watch: selfServe.watch },
      { label: 'the records web app', watch: records.watch },
    );
    restoreNextEnv(nextEnv);
    log(`web (next start, production build) on ${webUrl}`);
    log(`web (next dev, self_serve_signup + admin_live_api on) on ${webSelfServeUrl}`);
    log(
      `web (next start, production build, crm_records + crm_accounts + crm_record_view + crm_leads + crm_activities + crm_scripts + crm_pipeline + crm_search on) on ${webRecordsUrl}`,
    );
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
    `${JSON.stringify(
      // `webLiveUrl` is the same process as `webSelfServeUrl`, and
      // `webAccountsUrl`, `webRecordViewUrl`, `webLeadsUrl`, `webActivitiesUrl` and
      // `webScriptsUrl`, `webPipelineUrl` and `webSearchUrl` as `webRecordsUrl`; the
      // second name says which flag a spec is relying on (T-0035, T-0057, T-0062,
      // T-0058, T-0083, T-0115, T-0116, T-0109 and T-0087).
      {
        webUrl,
        webSelfServeUrl,
        webLiveUrl: webSelfServeUrl,
        webRecordsUrl,
        webAccountsUrl: webRecordsUrl,
        webRecordViewUrl: webRecordsUrl,
        webLeadsUrl: webRecordsUrl,
        webActivitiesUrl: webRecordsUrl,
        webScriptsUrl: webRecordsUrl,
        webPipelineUrl: webRecordsUrl,
        webSearchUrl: webRecordsUrl,
        apiUrl,
        fixturesUrl,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  log(`running playwright project "${projectName}"`);
  const playwrightCode = await runPlaywright();
  const shadowed = await findShadowedServers(servers);
  if (shadowed.length > 0) {
    for (const line of shadowed) {
      process.stderr.write(`[e2e] a foreign process was listening beside our server; this run's results cannot be trusted. ${line}\n`);
    }
    return 1;
  }
  return playwrightCode;
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

process.exit(signalExitCode ?? exitCode);
