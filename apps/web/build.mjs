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
 *
 * THE DATABASE URLS ARE NOT FORWARDED (T-0014). `next.config.mjs` refuses to
 * build with `DATABASE_URL` or `DATABASE_MIGRATION_URL` in the environment,
 * because a browser-facing build must never hold one. The same Nx behaviour
 * that leaked NODE_ENV puts both into this process: Nx loads the workspace
 * `.env` into every task, and the development `.env` holds them. So the child
 * is not given them. This is the one launcher that knowingly receives Nx's
 * `.env`, which is why the removal lives here; `next build`, `next dev` and
 * `next start` run any other way still refuse them outright. Setting a key to
 * `undefined` drops it from the child's environment (Node skips undefined
 * values), and reads nothing.
 *
 * The spread below is the only `process.env` access in apps/web, and the one
 * exemption the T-0014 acceptance suite allows: it forwards the environment
 * unread.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');

const result = spawnSync(process.execPath, [nextBin, 'build'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: undefined,
    DATABASE_MIGRATION_URL: undefined,
  },
});

process.exit(result.status ?? 1);
