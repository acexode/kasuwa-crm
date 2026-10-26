import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0152, recreate the e2e lock and fix the e2e README
 * (Phase 3 WS0 #1; brief section 7.2).
 *
 * Docker Desktop crashed about eight times during the UI programme when two e2e
 * runs overlapped, so e2e runs are serialised by one lock that every checkout
 * and worktree shares. The lead's script for it was never committed. This suite
 * holds the replacement, `tools/e2e-locked.sh`, and the README that tells the
 * next person to use it.
 *
 * The script is exercised for real, in `bash`, with `docker` and `pnpm` replaced
 * by stubs on PATH, so no Docker, browser or build is started. What is held:
 *
 *   1. It exists, is a bash script, and is committed executable.
 *
 *   2. It forwards its arguments: `tools/e2e-locked.sh --grep @x` runs
 *      `pnpm test:e2e -- --grep @x`, and exits with that command's own status.
 *
 *   3. The lock is a directory taken with `mkdir` (atomic). It is held for the
 *      whole run, holds `owner.pid` (the convention `tools/lead-verify.sh`
 *      already uses), and is released afterwards, whether the run passed or
 *      failed.
 *
 *   4. Two runs never overlap: the second waits for the first.
 *
 *   5. A lock whose owner pid is dead is stale and is taken over. A lock whose
 *      owner is alive is never taken, and a waiter gives up after
 *      `KASUWA_E2E_LOCK_TIMEOUT` seconds with exit 4, naming the owner.
 *
 *   6. Docker down is exit 3, with no `pnpm` run and no lock left behind.
 *
 *   7. The lock lives outside the checkout (`KASUWA_E2E_LOCK_DIR`, default under
 *      the system temp directory), so a second worktree meets the same lock.
 *
 *   8. `tests/e2e/README.md` documents the script, and its stub-auth section is
 *      gone: real sign-in plus the same-origin BFF (ADR-0019) replaced it, and
 *      "there is no mock server" stopped being true when the screen specs moved
 *      to contract mocks.
 *
 * Exit codes: 3 Docker is not running, 4 the lock wait timed out. Every other
 * status is the e2e command's own.
 *
 * Out of scope: `pnpm test:e2e` itself is unchanged and stays outside
 * `pnpm test` (CLAUDE.md section 3).
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const script = resolve(repoRoot, 'tools', 'e2e-locked.sh');
const readme = resolve(repoRoot, 'tests', 'e2e', 'README.md');

const scratch: string[] = [];
const children: Array<{ kill: () => boolean }> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

interface Sandbox {
  lockDir: string;
  log: string;
  /** The stub bin directory, put first on PATH by `bashArgs`. */
  bin: string;
  /** Variables the script and the stubs read, passed through `env`. */
  vars: Record<string, string>;
}

/**
 * Tests may not read `process.env` (lint), so the child's PATH is built by bash
 * itself: a one-line wrapper puts the stub directory first, then `exec env`
 * applies the variables and starts the script. The child inherits the rest of the
 * worker's environment untouched.
 */
const WRAPPER =
  'd="$1"; shift; if command -v cygpath >/dev/null 2>&1; then d="$(cygpath -u "$d")"; fi; export PATH="$d:$PATH"; exec env "$@"';

function bashArgs(box: Sandbox, args: string[]): string[] {
  const pairs = Object.entries(box.vars).map(([key, value]) => `${key}=${value}`);
  return ['-c', WRAPPER, 'e2e-lock-wrapper', box.bin, ...pairs, 'bash', script, ...args];
}

/** A PATH with a `docker` and a `pnpm` that record what they were asked and never start anything. */
function sandbox(extra: Record<string, string> = {}): Sandbox {
  const root = scratchDir('kasuwa-e2e-lock-').split('\\').join('/');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'pnpm.log');
  const lockDir = join(root, 'lock');

  writeFileSync(
    join(bin, 'docker'),
    '#!/usr/bin/env bash\n[ "${STUB_DOCKER:-up}" = "down" ] && exit 1\nexit 0\n',
  );
  writeFileSync(
    join(bin, 'pnpm'),
    [
      '#!/usr/bin/env bash',
      'printf "args:%s\\n" "$*" >> "$STUB_PNPM_LOG"',
      'if [ -d "$KASUWA_E2E_LOCK_DIR" ]; then printf "held\\n" >> "$STUB_PNPM_LOG"; fi',
      'if [ -f "$KASUWA_E2E_LOCK_DIR/owner.pid" ]; then printf "owner:%s\\n" "$(cat "$KASUWA_E2E_LOCK_DIR/owner.pid")" >> "$STUB_PNPM_LOG"; fi',
      'printf "start\\n" >> "$STUB_PNPM_LOG"',
      '[ -n "${STUB_PNPM_SLEEP:-}" ] && sleep "$STUB_PNPM_SLEEP"',
      'printf "end\\n" >> "$STUB_PNPM_LOG"',
      'exit "${STUB_PNPM_EXIT:-0}"',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  chmodSync(join(bin, 'pnpm'), 0o755);

  const vars: Record<string, string> = {
    KASUWA_E2E_LOCK_DIR: lockDir,
    KASUWA_E2E_LOCK_TIMEOUT: '5',
    STUB_PNPM_LOG: log,
    ...extra,
  };
  return { lockDir, log, bin, vars };
}

function run(args: string[], box: Sandbox) {
  const result = spawnSync('bash', bashArgs(box, args), { encoding: 'utf8', timeout: 25_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l !== '') : [];
}

/** The pid of a process that has already exited, as `bash` itself numbers it. */
function deadPid(): string {
  const result = spawnSync('bash', ['-c', 'echo $$'], { encoding: 'utf8' });
  return (result.stdout ?? '').trim();
}

/** A live `bash` that stays up, and the pid `bash` numbers it by. */
async function livePid(): Promise<string> {
  const child = spawn('bash', ['-c', 'echo $$; exec sleep 60'], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  return await new Promise<string>((resolvePid, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const first = out.split(/\r?\n/)[0];
      if (first !== undefined && /^\d+$/.test(first) && out.includes('\n')) resolvePid(first);
    });
    child.on('error', reject);
    child.on('exit', () => reject(new Error('the stand-in lock owner exited early')));
  });
}

describe('T-0152: tools/e2e-locked.sh exists', () => {
  it('is a bash script', () => {
    expect(existsSync(script), 'tools/e2e-locked.sh').toBe(true);
    expect(readFileSync(script, 'utf8')).toMatch(/^#!\/usr\/bin\/env bash\r?\n/);
  });

  it('is committed executable', () => {
    const staged = spawnSync('git', ['ls-files', '-s', 'tools/e2e-locked.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(staged.stdout, 'git ls-files -s tools/e2e-locked.sh').toMatch(/^100755 /);
  });
});

describe('T-0152: running the suite under the lock', () => {
  it('runs `pnpm test:e2e -- <args>` and exits with its status', () => {
    const box = sandbox({ STUB_PNPM_EXIT: '7' });
    const result = run(['--grep', '@harness'], box);
    expect(result.status).toBe(7);
    expect(lines(box.log)).toContain('args:test:e2e -- --grep @harness');
  });

  it('holds the lock while it runs, with the owner pid, and releases it afterwards', () => {
    const box = sandbox();
    expect(run([], box).status).toBe(0);
    const seen = lines(box.log);
    expect(seen).toContain('held');
    expect(seen.some((l) => /^owner:\d+$/.test(l)), 'owner.pid held a pid during the run').toBe(true);
    expect(existsSync(box.lockDir), 'the lock is released after a passing run').toBe(false);
  });

  it('releases the lock after a failing run too', () => {
    const box = sandbox({ STUB_PNPM_EXIT: '1' });
    expect(run([], box).status).toBe(1);
    expect(existsSync(box.lockDir)).toBe(false);
  });

  it('keeps the lock outside the checkout by default', () => {
    const text = readFileSync(script, 'utf8');
    expect(text).toMatch(/KASUWA_E2E_LOCK_DIR/);
    expect(text, 'a default under the system temp directory').toMatch(/\$\{TMPDIR:-\/tmp\}|\$TMPDIR|mktemp/);
  });
});

describe('T-0152: Docker down', () => {
  it('exits 3, runs nothing and leaves no lock', () => {
    const box = sandbox({ STUB_DOCKER: 'down' });
    const result = run([], box);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/docker/i);
    expect(lines(box.log), 'pnpm must not run').toEqual([]);
    expect(existsSync(box.lockDir)).toBe(false);
  });
});

describe('T-0152: two runs never overlap', () => {
  it('makes the second wait for the first', async () => {
    const box = sandbox({ STUB_PNPM_SLEEP: '1', KASUWA_E2E_LOCK_TIMEOUT: '20' });
    const start = () =>
      new Promise<number | null>((done) => {
        const child = spawn('bash', bashArgs(box, []), { stdio: 'ignore' });
        children.push(child);
        child.on('exit', (code) => done(code));
      });

    const [a, b] = await Promise.all([start(), start()]);
    expect([a, b]).toEqual([0, 0]);

    const seen = lines(box.log).filter((l) => l === 'start' || l === 'end');
    expect(seen, 'start, end, start, end: never two starts in a row').toEqual(['start', 'end', 'start', 'end']);
  });
});

describe('T-0152: a stale lock and a live lock', () => {
  it('takes over a lock whose owner is dead', () => {
    const box = sandbox();
    mkdirSync(box.lockDir);
    writeFileSync(join(box.lockDir, 'owner.pid'), deadPid());
    const result = run([], box);
    expect(result.status).toBe(0);
    expect(lines(box.log)).toContain('end');
    expect(existsSync(box.lockDir)).toBe(false);
  });

  it('never takes a lock whose owner is alive, and gives up with exit 4 naming the owner', async () => {
    const box = sandbox({ KASUWA_E2E_LOCK_TIMEOUT: '2' });
    const owner = await livePid();
    mkdirSync(box.lockDir);
    writeFileSync(join(box.lockDir, 'owner.pid'), owner);

    const result = run([], box);
    expect(result.status).toBe(4);
    expect(result.stderr, 'the message names the owner pid').toContain(owner);
    expect(lines(box.log), 'pnpm must not run').toEqual([]);
    expect(readFileSync(join(box.lockDir, 'owner.pid'), 'utf8').trim(), 'the live owner keeps its lock').toBe(owner);
  });
});

describe('T-0152: tests/e2e/README.md', () => {
  const text = existsSync(readme) ? readFileSync(readme, 'utf8') : '';

  it('documents the lock', () => {
    expect(text).toContain('tools/e2e-locked.sh');
    expect(text).toContain('KASUWA_E2E_LOCK_DIR');
  });

  it('names the suites that start the harness themselves, and the -t way to skip it', () => {
    expect(text).toMatch(/records-ui/);
    expect(text).toMatch(/session\//);
    expect(text).toMatch(/\s-t\s/);
  });

  it('no longer teaches stub-header authentication', () => {
    expect(text, 'the stub header sample').not.toMatch(/'x-kasuwa-tenant-id':\s*TENANT_A/);
    expect(text, 'the stub header claim').not.toMatch(/These are the stub auth headers/i);
  });

  it('describes real sign-in and the same-origin BFF, and what every mock must answer', () => {
    expect(text).toContain('ADR-0019');
    expect(text).toMatch(/__Host-kasuwa_session|BFF/);
    expect(text, 'every mock must answer the current-user read').toContain('/api/v1/auth/me');
  });

  it('no longer claims there is no mock server', () => {
    expect(text).not.toMatch(/There\s+is\s+no\s+mock\s+server/i);
  });
});
