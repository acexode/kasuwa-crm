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
 */
import { spawnSync } from 'node:child_process';

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

const result = spawnSync(
  'npx',
  ['vitest', 'run', '--project', 'unit', '--passWithNoTests', '--silent', projectDir],
  {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 120_000,
  },
);

if (result.status === 0) {
  process.exit(0);
}

// Exit 2 surfaces the output to the model so it can fix the break immediately,
// rather than discovering it three edits later.
process.stderr.write(
  `Unit tests for ${projectDir} are failing after your edit:\n\n` +
    `${(result.stdout ?? '').slice(-4000)}\n${(result.stderr ?? '').slice(-2000)}\n`,
);
process.exit(2);
