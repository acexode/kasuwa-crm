#!/usr/bin/env node
/**
 * Production build wrapper for apps/web.
 *
 * `next build` behaves differently depending on the ambient NODE_ENV, and it is
 * not robust to NODE_ENV=development: it compiles, then fails prerendering the
 * Pages Router fallback with "<Html> should not be imported outside of
 * pages/_document".
 *
 * Nx injects the workspace .env into every task, so a developer with
 * NODE_ENV=development in their .env got a build failure that did not reproduce
 * under `pnpm --filter @kasuwa/web build` and said nothing about the cause. It
 * cost an hour to find. NODE_ENV has been removed from .env.example as well,
 * but a production build should not depend on the ambient environment at all,
 * which is what this wrapper guarantees.
 *
 * Next is invoked through its resolved bin path rather than the PATH, so this
 * works the same under pnpm, Nx and CI.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');

const result = spawnSync(process.execPath, [nextBin, 'build'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' },
});

process.exit(result.status ?? 1);
