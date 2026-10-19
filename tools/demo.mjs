#!/usr/bin/env node
/**
 * `pnpm demo` — the local product demo in one command (docs/demo/DEMO.md).
 *
 *   1. checks Docker is up, the dialler stack is not, and the ports are free
 *   2. runs `tools/dev.mjs` (containers, migrate, the test seed, the four apps)
 *      with every built Phase 2 flag on, and only Postgres and Redis (the apps
 *      read nothing from OpenSearch or object storage yet; `--full` starts them)
 *   3. waits for the API and the web app, then adds the demo data
 *      (`tools/demo-seed.mjs`, through the real API)
 *   4. signs in for real and opens every demo screen once in a headless
 *      browser so `next dev` has compiled them before the audience arrives
 *      (`--no-warm` skips it)
 *
 * The app is the web app itself, on http://localhost:3000. Since T-0125 it
 * keeps a real session after sign-in (ADR-0019: an HttpOnly cookie behind
 * its own BFF), so the demo needs no front door of its own and no user
 * switcher: presenters sign in for real, as every user will.
 *
 * Ctrl+C stops everything it started, apps and containers. `pnpm demo:down`
 * does the same from another terminal (or after a crash).
 *
 * Every start re-runs the test seed, which truncates the tenancy tables first,
 * so a restart IS the reset to a clean demo state.
 *
 * Local development only: nothing here is meant for, or works against, a
 * shared environment. The seed and the demo seed both refuse non-local hosts.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const logDir = join(root, 'demo', 'logs');

/**
 * Every built, user-visible flag. `admin_live_api` shows labelled sample KPIs
 * in two admin panels whose endpoints do not exist yet. `self_serve_signup`
 * stays off: its endpoints answer 501.
 */
const DEMO_FLAGS = [
  'crm_records',
  'crm_accounts',
  'crm_record_view',
  'crm_leads',
  'crm_activities',
  'crm_scripts',
  'crm_pipeline',
  'crm_search',
  'admin_live_api',
];
/** Flags added to the demo automatically once their task has merged. */
const DEMO_FLAGS_WHEN_PRESENT = ['crm_custom_fields'];

const PORTS = { web: 3000, api: 3001, realtime: 3002 };

function log(message) {
  console.log(`[demo] ${message}`);
}

function demoFlags() {
  if (
    process.env.KASUWA_FEATURE_FLAGS_ON !== undefined &&
    process.env.KASUWA_FEATURE_FLAGS_ON.trim() !== ''
  ) {
    return process.env.KASUWA_FEATURE_FLAGS_ON;
  }
  const source = readFileSync(join(root, 'packages', 'feature-flags', 'src', 'index.ts'), 'utf8');
  const extra = DEMO_FLAGS_WHEN_PRESENT.filter((flag) =>
    new RegExp(`^\\s+${flag}: \\{`, 'm').test(source),
  );
  return [...DEMO_FLAGS, ...extra].join(',');
}

function docker(argv) {
  return spawnSync('docker', argv, { cwd: root, encoding: 'utf8' });
}

function portInUse(port) {
  return new Promise((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

async function waitFor(url, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error(
    `${label} did not answer within ${Math.round(timeoutMs / 1000)}s. See demo/logs/dev.log`,
  );
}

/** Processes started from this checkout by a previous run (or a crash). */
function killLeftovers() {
  const patterns = [
    `${root}/tools/dev.mjs`,
    `${root}/apps/`,
    `${root}/node_modules/.pnpm/next@`,
  ];
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const mine = String(process.pid);
  let killed = 0;
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null || match[1] === mine) continue;
    const command = match[2];
    const fromHere =
      patterns.some((pattern) => command.includes(pattern)) ||
      (command.includes(root) && /next dev|next-server|tsx watch|tsx src\/main/.test(command));
    if (fromHere) {
      try {
        process.kill(Number(match[1]), 'SIGTERM');
        killed += 1;
      } catch {
        // already gone
      }
    }
  }
  // next-server renames itself and carries no path: find what still listens
  // on the demo ports, and stop it only if it runs from this checkout.
  for (const port of Object.values(PORTS)) {
    const pids =
      spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
        .stdout ?? '';
    for (const pid of pids.split('\n').filter(Boolean)) {
      const cwd =
        spawnSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout ?? '';
      if (cwd.includes(`n${root}`)) {
        try {
          process.kill(Number(pid), 'SIGTERM');
          killed += 1;
        } catch {
          // already gone
        }
      }
    }
  }
  return killed;
}

function down() {
  const killed = killLeftovers();
  log(`stopped ${killed} demo process(es)`);
  const result = docker(['compose', 'down']);
  log(
    result.status === 0
      ? 'containers stopped (data volume kept)'
      : `docker compose down failed: ${result.stderr}`,
  );
}

async function main() {
  if (args.has('--down')) {
    down();
    return;
  }

  const info = docker(['info', '--format', '{{.ServerVersion}}']);
  if (info.status !== 0) {
    throw new Error(
      'Docker is not running. Start Docker Desktop, wait for it to settle, then retry.',
    );
  }
  const running = docker(['ps', '--format', '{{.Names}}']).stdout.split('\n').filter(Boolean);
  if (running.some((name) => name.startsWith('dialler'))) {
    throw new Error(
      'The dialler stack is running. Stop it first (one Docker stack at a time, CLAUDE.md).',
    );
  }
  for (const [name, port] of Object.entries(PORTS)) {
    if (await portInUse(port)) {
      throw new Error(
        `Port ${port} (${name}) is already in use. Run \`pnpm demo:down\`, or see "Troubleshooting" in docs/demo/DEMO.md.`,
      );
    }
  }
  if (!existsSync(join(root, '.env'))) {
    log('no .env yet: tools/dev.mjs will create it from .env.example');
  }

  mkdirSync(logDir, { recursive: true });
  const devLog = createWriteStream(join(logDir, 'dev.log'));
  const flags = demoFlags();
  log(`flags on: ${flags}`);
  const started = Date.now();

  const children = [];
  const env = {
    ...process.env,
    KASUWA_FEATURE_FLAGS_ON: flags,
    KASUWA_DEV_SERVICES: args.has('--full') ? '' : 'postgres,redis',
  };
  const dev = spawn('node', [join(root, 'tools', 'dev.mjs')], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(dev);
  dev.stdout.pipe(devLog);
  dev.stderr.pipe(devLog);

  let stopping = false;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    log('stopping...');
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    setTimeout(() => {
      killLeftovers();
      docker(['compose', 'down']);
      log('stopped. Containers are down; the data volume is kept.');
      process.exit(code);
    }, 2_000);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  dev.on('exit', (code) => {
    if (!stopping) {
      log(`tools/dev.mjs exited with ${code}. See demo/logs/dev.log`);
      stop(1);
    }
  });

  log('starting containers, migrating, seeding and starting the apps (logs: demo/logs/dev.log)...');
  await waitFor(`http://127.0.0.1:${PORTS.api}/health`, 'The API', 300_000);
  await waitFor(`http://127.0.0.1:${PORTS.web}/`, 'The web app', 300_000);
  log(`apps up after ${Math.round((Date.now() - started) / 1000)}s`);

  const seed = spawnSync('node', [join(root, 'tools', 'demo-seed.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
  process.stdout.write(seed.stdout);
  process.stderr.write(seed.stderr);
  if (seed.status !== 0) {
    log('the demo seed failed; the stack is still up with the plain test seed.');
  }

  if (!args.has('--no-warm')) {
    log('warming every demo screen (first compile in next dev; a few minutes)...');
    const warm = spawnSync('node', [join(root, 'tools', 'demo-smoke.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DEMO_ROLES: 'admin' },
    });
    if (warm.status !== 0) {
      log(`warm-up had trouble (not fatal): ${(warm.stderr || warm.stdout).slice(-400)}`);
    }
  }

  log(`ready after ${Math.round((Date.now() - started) / 1000)}s`);
  log('');
  log(`  open     http://localhost:${PORTS.web}   (exactly this address; sign in for real)`);
  log('  TOTP     node tools/demo-totp.mjs admin   (agent, agent2, unassigned, tenantb)');
  log('  switch   Sign out (top right), then sign in as the next person');
  log('  stop     Ctrl+C here (or `pnpm demo:down` elsewhere)');
}

main().catch((error) => {
  console.error(`[demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
