#!/usr/bin/env node
/**
 * `pnpm db:reset` (T-0122, D-L103). Defaults NODE_ENV to development ONLY when
 * it is unset, then runs the package script. It never overwrites a set value:
 * `NODE_ENV=production pnpm db:reset` must still be refused by the tool.
 * Node built-ins only; no shell assignment, so it works in cmd.exe.
 */
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
if (env.NODE_ENV === undefined) {
  env.NODE_ENV = 'development';
}

const result = spawnSync('pnpm', ['--filter', '@kasuwa/db', 'reset'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
