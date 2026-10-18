#!/usr/bin/env node
/**
 * `pnpm dev` — one command from a clean checkout to a running stack.
 *
 *   1. create .env from .env.example if it is missing, and add any database
 *      connection a newer .env.example names that it lacks
 *   2. bring up Postgres, Redis, OpenSearch and SeaweedFS, and wait for health
 *   3. create the object-store bucket, re-apply the role bootstrap
 *      (idempotent), migrate and seed
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

const ALL_SERVICES = ['postgres', 'redis', 'opensearch', 'seaweedfs'];

/**
 * `KASUWA_DEV_SERVICES=postgres,redis` brings up only those containers. The
 * apps read nothing from OpenSearch yet, and nothing in a running app writes
 * object storage until the import endpoints (T-0094), so the demo
 * (tools/demo.mjs) skips both: OpenSearch alone is a large first pull and a
 * 512 MB heap. Postgres and Redis are always included; an unknown name stops
 * the script. The bucket step below runs only when seaweedfs is selected.
 */
function selectedServices(value) {
  if (value === undefined || value.trim() === '') {
    return ALL_SERVICES;
  }
  const named = value.split(',').map((name) => name.trim()).filter((name) => name !== '');
  const unknown = named.filter((name) => !ALL_SERVICES.includes(name));
  if (unknown.length > 0) {
    throw new Error(`KASUWA_DEV_SERVICES names unknown services: ${unknown.join(', ')}`);
  }
  return ALL_SERVICES.filter((name) => name === 'postgres' || name === 'redis' || named.includes(name));
}

const SERVICES = selectedServices(process.env.KASUWA_DEV_SERVICES);
const HEALTH_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 2_000;

/**
 * NODE_ENV per process, never in `.env` (D-L95). The API and the worker refuse
 * to boot with NODE_ENV unset, and `.env` must not set it: Nx injects that
 * file into every task, and NODE_ENV=development there breaks `next build`.
 * So each server process and operator command this script starts is given
 * `development` explicitly. The web process is left alone: `next dev` sets its
 * own.
 */
const DEV_PROCESS_ENV = { ...process.env, NODE_ENV: 'development' };

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

/**
 * Object-store settings a .env created before T-0092 lacks. Appended the same
 * way. A .env from before T-0092 also holds the old placeholder keys, which the
 * now-credentialled store refuses; `ensureEnvFile` says so rather than
 * overwriting a value the developer may have set.
 */
const STORAGE_SETTINGS = ['S3_PUBLIC_ENDPOINT', 'S3_FORCE_PATH_STYLE', 'S3_SSE_MODE'];
const OLD_STORAGE_PLACEHOLDER = 'kasuwa-local-placeholder';

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
  for (const name of [...REQUIRED_DATABASE_SETTINGS, ...STORAGE_SETTINGS]) {
    const line = example.get(name);
    if (!present.has(name) && line !== undefined) {
      appendFileSync(envPath, `\n${line}\n`);
      // The name only: the line carries a (development) password.
      console.log(`added ${name} to .env from .env.example`);
    }
  }
  if ((present.get('S3_ACCESS_KEY_ID') ?? '').endsWith(`=${OLD_STORAGE_PLACEHOLDER}`)) {
    console.log(
      'note: .env still has the old placeholder S3 keys, which the dev object store now ' +
        'refuses (T-0092). Copy S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY from .env.example.',
    );
  }
}

/** S3_BUCKET from .env (falling back to .env.example), checked against S3's naming rule. */
function devBucketName() {
  for (const file of ['.env', '.env.example']) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;
    const line = envLines(readFileSync(path, 'utf8')).get('S3_BUCKET');
    if (line !== undefined) {
      const name = line.slice('S3_BUCKET='.length).trim();
      // Also what keeps the name safe to put in the weed shell line below.
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) {
        throw new Error(`S3_BUCKET in ${file} is not a valid bucket name`);
      }
      return name;
    }
  }
  return 'kasuwa-local';
}

/**
 * Creates the dev bucket (ADR-0017 "Development and test"). Through `weed
 * shell` inside the container, as packages/testing's SeaweedFS helper does:
 * it needs no S3 credential, so the dev identity can stay without Admin.
 * SeaweedFS would also create a bucket on the first PUT to it, but a MinIO
 * cell would not, and code that only works because of that would break there.
 * Idempotent. The healthcheck covers the master, not the filer, so it retries
 * until the bucket is listed.
 */
async function createDevBucket() {
  const bucket = devBucketName();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'seaweedfs',
        'sh',
        '-c',
        `echo "s3.bucket.create -name ${bucket}" | weed shell -master=localhost:9333 >/dev/null 2>&1; ` +
          'echo "s3.bucket.list" | weed shell -master=localhost:9333 2>/dev/null',
      ],
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    if ((result.stdout ?? '').split(/\s+/).includes(bucket)) {
      console.log(`  bucket ${bucket}: ready`);
      return;
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`could not create the dev bucket ${bucket}; run "docker compose logs seaweedfs"`);
}

/**
 * Re-applies packages/db/sql/bootstrap.sql, then bootstrap-test.sql, as the
 * superuser.
 *
 * Postgres runs its init directory only when the volume is first created, so
 * a role added to the bootstrap later (kasuwa_sweeper in T-0045, kasuwa_auth
 * in T-0049) does not exist in an older dev database, and the migration that
 * needs it stops. Both files are idempotent and already mounted in the
 * container, so applying them on every start costs a few milliseconds.
 *
 * bootstrap-test.sql makes kasuwa_test_admin the harness's login (T-0117,
 * D-L94). It is development and test only; this is the dev stack. A volume
 * created before the split has no 20-bootstrap-test.sql in its init history
 * but already has the login, so applying it here keeps every dev database in
 * the state a new one starts in.
 */
function applyBootstrap() {
  for (const file of ['10-bootstrap.sql', '20-bootstrap-test.sql']) {
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
      `/docker-entrypoint-initdb.d/${file}`,
    ]);
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
      ...(app.name === 'web' ? {} : { env: DEV_PROCESS_ENV }),
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

  if (SERVICES.includes('seaweedfs')) {
    console.log('creating the object-store bucket...');
    await createDevBucket();
  }

  console.log('applying the role bootstrap...');
  applyBootstrap();
  console.log('migrating...');
  run('pnpm', ['--filter', '@kasuwa/db', 'migrate'], { env: DEV_PROCESS_ENV });
  console.log('seeding...');
  run('pnpm', ['--filter', '@kasuwa/db', 'seed'], { env: DEV_PROCESS_ENV });

  console.log('\nstack is up:');
  console.log('  web       http://localhost:3000');
  console.log('  api       http://localhost:3001/health');
  console.log('  realtime  ws://localhost:3002');
  if (SERVICES.includes('seaweedfs')) {
    console.log('  s3        http://localhost:59000 (signed requests only)');
  }
  console.log('');

  startApps();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
