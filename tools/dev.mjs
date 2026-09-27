#!/usr/bin/env node
/**
 * `pnpm dev` — one command from a clean checkout to a running stack.
 *
 *   1. create .env from .env.example if it is missing
 *   2. bring up Postgres, Redis, OpenSearch and MinIO, and wait for health
 *   3. migrate and seed
 *   4. run api, web, worker and realtime together, prefixing their output
 *
 * Written in plain Node rather than a shell script because the team develops on
 * Windows and CI runs on Linux, and a bash-only dev script would mean the
 * primary developer's machine is the unsupported one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
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

function ensureEnvFile() {
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) {
    copyFileSync(resolve(root, '.env.example'), envPath);
    console.log('created .env from .env.example');
  }
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
