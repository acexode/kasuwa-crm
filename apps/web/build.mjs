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
 * THE CHILD GETS AN ALLOWLIST, NOT THE ENVIRONMENT (T-0014). The same Nx
 * behaviour that leaked NODE_ENV loads the whole workspace `.env` into this
 * process: database URLs, the local KMS master key, object-store credentials.
 * A denylist of those would leak the next secret someone adds to `.env`. So
 * `next build` is given only the names below: what Node and Next need to run
 * (on Linux and on Windows), and what the web build itself reads. Anything
 * else, including any credential, never reaches it. `next.config.mjs` still
 * refuses a database URL or server credential outright when the web app is
 * built or started any other way.
 *
 * The spread below is the only `process.env` access in apps/web, and the one
 * form the T-0014 acceptance suite exempts. It copies the environment so that
 * the filter can select variables by NAME; no value is read or inspected.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** Exact names, compared case-insensitively (Windows spells it `Path`). */
const ALLOWED_NAMES = new Set([
  // The process itself: executable lookup, temp files, home, locale, terminal.
  'PATH',
  'PATHEXT',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'FORCE_COLOR',
  'NO_COLOR',
  'CI',
  'NODE_OPTIONS',
  // Windows: Node, SWC/WASM and child processes need these to start at all.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  // What the web build reads: the base schema, the flags, Next's own switch.
  'LOG_LEVEL',
  'KASUWA_CELL',
  'KASUWA_AUTH_MODE',
  'KASUWA_FEATURE_FLAGS_ON',
  'NEXT_TELEMETRY_DISABLED',
]);
/** Prefixes: public build-time values, and the harness's web-only settings. */
const ALLOWED_PREFIXES = ['NEXT_PUBLIC_', 'KASUWA_WEB_'];

function isAllowed(name) {
  const upper = name.toUpperCase();
  return ALLOWED_NAMES.has(upper) || ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

const childEnv = Object.fromEntries(
  Object.entries({ ...process.env }).filter(([name]) => isAllowed(name)),
);

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');

const result = spawnSync(process.execPath, [nextBin, 'build'], {
  stdio: 'inherit',
  env: { ...childEnv, NODE_ENV: 'production' },
});

process.exit(result.status ?? 1);
