#!/usr/bin/env node
/**
 * PostToolUse hook: run the unit tests affected by the file just edited.
 *
 * The point is a tight loop — a broken invariant surfaces in seconds rather
 * than at PR time. It runs the **unit** project only: integration and isolation
 * need Testcontainers and take tens of seconds, which is long enough that
 * someone would turn this hook off, and a hook that gets turned off protects
 * nothing.
 *
 * Full verification still happens before the PR (`pnpm test`) and in CI.
 *
 * RESOURCE LIMITS (2026-10-14, after this hook took down a 16 GB machine).
 * Every edit started `npx vitest` with the default forks pool (cpus - 1 = 15
 * workers), runs from several sessions and worktrees overlapped, and the
 * spawnSync timeout killed only `npx`, so the forked workers were orphaned and
 * kept growing to ~4 GB each. Four guards stop that:
 *   1. one run at a time on this machine, across every worktree and session: a
 *      lock directory in os.tmpdir(). A busy lock means skip (exit 0), never wait;
 *   2. `--pool=threads --maxWorkers=2`: workers are threads of one process, so
 *      killing that process kills them all;
 *   3. a heap cap per isolate (NODE_OPTIONS --max-old-space-size), so a leaking
 *      test fails loudly instead of eating the machine;
 *   4. the run gets its own process group, and a timeout — or this hook being
 *      killed — signals the whole group, so nothing survives as an orphan.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 3_000;
const MAX_WORKERS = '2';
const HEAP_MB = '1536';
const OUTPUT_LIMIT = 64_000;
const LOCK_DIR = join(tmpdir(), 'kasuwa-post-edit-tests.lock');

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
  });
}

const raw = await readStdin();

let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  process.exit(0);
}

const filePath = String(payload?.tool_input?.file_path ?? '').replace(/\\/g, '/');
if (!filePath || !/\.(ts|tsx)$/.test(filePath)) {
  process.exit(0);
}

// Markdown, config and generated files have no unit tests to run.
if (filePath.includes('/migrations/') || filePath.endsWith('.d.ts')) {
  process.exit(0);
}

// Scope the run to the package that owns the edited file. `nx affected` would
// be more precise but needs a git base, which is not meaningful mid-edit.
const match = /(packages\/domain\/[^/]+|packages\/[^/]+|apps\/[^/]+)\//.exec(filePath);
if (!match) {
  process.exit(0);
}

const projectDir = match[1];

// Run in the checkout that owns the edited file, not the session's cwd: a
// session can edit files in another worktree, and running there would test the
// wrong tree (and report its failures, or another tree's, as this edit's).
function repoRootOf(file) {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'vitest.workspace.ts'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const repoRoot =
  filePath.startsWith('/') || /^[A-Za-z]:\//.test(filePath) ? repoRootOf(filePath) : process.cwd();

// --- 1. One run at a time on this machine ------------------------------------

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
}

function takeLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(LOCK_DIR); // atomic: exactly one caller succeeds
      writeFileSync(join(LOCK_DIR, 'owner.pid'), String(process.pid));
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      let owner = 0;
      try {
        owner = Number.parseInt(readFileSync(join(LOCK_DIR, 'owner.pid'), 'utf8'), 10);
      } catch {
        // The owner may be between mkdir and writing its pid: treat as busy.
        return false;
      }
      if (alive(owner)) return false;
      // Stale: the owner died without cleaning up. Remove it and try once more.
      rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  }
  return false;
}

function releaseLock() {
  try {
    const owner = Number.parseInt(readFileSync(join(LOCK_DIR, 'owner.pid'), 'utf8'), 10);
    if (owner === process.pid) rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
}

if (!takeLock()) {
  // Another edit's run is in progress somewhere on this machine. Skipping keeps
  // runs from stacking up; the next edit, or `pnpm test:unit`, covers it.
  process.exit(0);
}

// --- 2-4. A bounded run in its own process group --------------------------------

const localVitest = join(repoRoot, 'node_modules', '.bin', 'vitest');
const command = existsSync(localVitest) ? localVitest : 'npx';
const args = [
  ...(command === 'npx' ? ['vitest'] : []),
  'run',
  '--project',
  'unit',
  '--passWithNoTests',
  '--silent',
  '--pool=threads',
  `--maxWorkers=${MAX_WORKERS}`,
  '--minWorkers=1',
  projectDir,
];

const inheritedNodeOptions = (process.env.NODE_OPTIONS ?? '')
  .split(/\s+/)
  .filter((option) => option && !option.startsWith('--max-old-space-size'));

const child = spawn(command, args, {
  cwd: repoRoot,
  // Its own process group on POSIX, so the whole tree can be signalled at once.
  detached: process.platform !== 'win32',
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_OPTIONS: [...inheritedNodeOptions, `--max-old-space-size=${HEAP_MB}`].join(' '),
  },
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout = (stdout + chunk).slice(-OUTPUT_LIMIT);
});
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-OUTPUT_LIMIT);
});

let finished = false;

function killTree(signal) {
  if (finished || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, signal); // negative pid: the whole process group
  } catch {
    // The group is already gone.
  }
}

function stopRun() {
  killTree('SIGTERM');
  setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS).unref();
}

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  stopRun();
}, TIMEOUT_MS);

// If this hook is itself stopped, take the run down with it and free the lock.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    killTree('SIGKILL');
    releaseLock();
    process.exit(0);
  });
}

const status = await new Promise((resolve) => {
  child.on('error', () => resolve(null));
  child.on('close', (code) => resolve(code));
});
finished = true;
clearTimeout(timer);
// Belt and braces: anything still in the group (a stray worker) goes too.
if (process.platform !== 'win32' && child.pid !== undefined) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Nothing left, as expected.
  }
}
releaseLock();

if (status === 0) {
  process.exit(0);
}

if (timedOut) {
  // A run cut short by the timeout says nothing about the edit (the machine may
  // simply be busy), so it does not block. The run and its workers are stopped.
  process.stderr.write(
    `post-edit unit tests for ${projectDir} timed out after ${TIMEOUT_MS / 1000}s and were stopped.\n`,
  );
  process.exit(0);
}

// Exit 2 surfaces the output to the model so it can fix the break immediately,
// rather than discovering it three edits later.
process.stderr.write(
  `Unit tests for ${projectDir} (in ${repoRoot}) are failing after your edit (vitest exit ${status}):\n\n` +
    `${stdout.slice(-4000)}\n${stderr.slice(-2000)}\n`,
);
process.exit(2);
