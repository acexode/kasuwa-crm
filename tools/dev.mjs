#!/usr/bin/env node
/**
 * `pnpm dev` — one command from a clean checkout to a running stack.
 *
 *   1. create .env from .env.example if it is missing, and add any database
 *      connection a newer .env.example names that it lacks
 *   2. bring up Postgres, Redis, OpenSearch and MinIO, and wait for health
 *   3. re-apply the role bootstrap (idempotent), migrate and seed
 *   4. run api, web, worker and realtime together, prefixing their output
 *
 * Written in plain Node rather than a shell script because the team develops on
 * Windows and CI runs on Linux, and a bash-only dev script would mean the
 * primary developer's machine is the unsupported one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const SERVICES = ['postgres', 'redis', 'opensearch', 'seaweedfs'];
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 2_000;

const APPS = [
  { name: 'api', filter: '@kasuwa/api', colour: '[36m' },
  { name: 'web', filter: '@kasuwa/web', colour: '[35m' },
  { name: 'worker', filter: '@kasuwa/worker', colour: '[33m' },
  { name: 'realtime', filter: '@kasuwa/realtime', colour: '[32m' },
];
const RESET = '[0m';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

/**
 * Database connections the API cannot boot without, which a .env created
 * before they existed will not have. Copied from .env.example (development
 * values only; that file is committed) rather than left for the API to fail
 * on. Never overwrites a value the developer has set.
 */
const REQUIRED_DATABASE_SETTINGS = ['DATABASE_AUTH_URL'];

/** `NAME=value` lines of an env file, by name. Comments and blanks skipped. */
function envLines(text) {
  const lines = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (match) {
      lines.set(match[1], line);
    }
  }
  return lines;
}

function ensureEnvFile() {
  const envPath = resolve(root, '.env');
  const examplePath = resolve(root, '.env.example');
  if (!existsSync(envPath)) {
    copyFileSync(examplePath, envPath);
    console.log('created .env from .env.example');
    return;
  }
  const present = envLines(readFileSync(envPath, 'utf8'));
  const example = envLines(readFileSync(examplePath, 'utf8'));
  for (const name of REQUIRED_DATABASE_SETTINGS) {
    const line = example.get(name);
    if (!present.has(name) && line !== undefined) {
      appendFileSync(envPath, `\n${line}\n`);
      // The name only: the line carries a (development) password.
      console.log(`added ${name} to .env from .env.example`);
    }
  }
}

/**
 * Re-applies packages/db/sql/bootstrap.sql as the superuser.
 *
 * Postgres runs its init directory only when the volume is first created, so
 * a role added to the bootstrap later (kasuwa_sweeper in T-0045, kasuwa_auth
 * in T-0049) does not exist in an older dev database, and the migration that
 * needs it stops. The file is idempotent and is already mounted in the
 * container, so applying it on every start costs a few milliseconds.
 */
function applyBootstrap() {
  run('docker', [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-q',
    '-U',
    'postgres',
    '-d',
    'kasuwa',
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    '/docker-entrypoint-initdb.d/10-bootstrap.sql',
  ]);
}

function containerHealth(service) {
  const idResult = spawnSync('docker', ['compose', 'ps', '-q', service], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const id = (idResult.stdout ?? '').trim();
  if (id === '') {
    return 'missing';
  }
  const inspect = spawnSync(
    'docker',
    [
      'inspect',
      '-f',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      id,
    ],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
  );
  return (inspect.stdout ?? '').trim();
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const pending = new Set(SERVICES);

  while (pending.size > 0) {
    for (const service of [...pending]) {
      const status = containerHealth(service);
      if (status === 'healthy' || status === 'running') {
        pending.delete(service);
        console.log(`  ${service}: ${status}`);
      } else if (status === 'unhealthy' || status === 'exited') {
        throw new Error(`${service} is ${status}; run "docker compose logs ${service}"`);
      }
    }
    if (pending.size === 0) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${[...pending].join(', ')}`);
    }
    await new Promise((done) => setTimeout(done, HEALTH_POLL_MS));
  }
}

function startApps() {
  const children = APPS.map((app) => {
    const child = spawn('pnpm', ['--filter', app.filter, 'dev'], {
      cwd: root,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const prefix = `${app.colour}[${app.name}]${RESET} `;
    const forward = (stream, target) => {
      stream.setEncoding('utf8');
      let buffer = '';
      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          target.write(`${prefix}${line}\n`);
        }
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);

    child.on('exit', (code) => {
      console.log(`${prefix}exited with ${code}`);
    });
    return child;
  });

  const shutdown = () => {
    for (const child of children) {
      child.kill('SIGTERM');
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  ensureEnvFile();

  console.log('starting containers...');
  run('docker', ['compose', 'up', '-d', ...SERVICES]);
  await waitForHealth();

  console.log('applying the role bootstrap...');
  applyBootstrap();
  console.log('migrating...');
  run('pnpm', ['--filter', '@kasuwa/db', 'migrate']);
  console.log('seeding...');
  run('pnpm', ['--filter', '@kasuwa/db', 'seed']);

  console.log('\nstack is up:');
  console.log('  web       http://localhost:3000');
  console.log('  api       http://localhost:3001/health');
  console.log('  realtime  ws://localhost:3002');
  console.log('  minio     http://localhost:9001\n');

  startApps();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
