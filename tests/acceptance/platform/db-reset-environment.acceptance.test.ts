import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { resolve, sep } from 'node:path';
import { isLocalDatabaseHost } from '@kasuwa/config';
import { loadMigrations, runMigrations, runSeed, TENANT_A, TENANT_B } from '@kasuwa/db';
import { startBarePostgres, type BarePostgres } from '@kasuwa/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * ACCEPTANCE — T-0122, destructive dev tools need an explicit environment
 * (Agent 1, Platform & Security). Decisions: D-L103, with D-L95 and D-L94.
 *
 * Written before the build (D-L23), from the task file and the decisions, not
 * from an implementation (D-L25).
 *
 * THE HOLE. `pnpm db:reset` drops every table. Today it refuses a non-local
 * host and anything `assertMigrationTargetIsSafe` would enforce, but with
 * NODE_ENV UNSET and a loopback URL it runs. Loopback is not a laptop:
 * `kubectl port-forward`, cloud-sql-proxy and SSH tunnels all listen on
 * 127.0.0.1, so an operator with a tunnel open and no NODE_ENV drops whatever
 * the tunnel reaches. D-L95 lets the migration RUNNER accept that case because
 * the API and worker boot checks catch a real cell at its next deploy. A DROP
 * cannot be caught later, so D-L103 does not extend the allowance to
 * destructive tools.
 *
 * ---------------------------------------------------------------------------
 * THE INTERFACE THIS FILE REQUIRES, and nothing else
 * ---------------------------------------------------------------------------
 *
 *  I1. The destructive tool is `packages/db/src/cli/reset.ts`, run by the
 *      `@kasuwa/db` package script `reset`, which stays exactly
 *      `tsx src/cli/reset.ts`. The GUARD LIVES IN THE TOOL, not only in the
 *      root wrapper: `pnpm --filter @kasuwa/db reset` and a bare `tsx` run must
 *      refuse too. This file runs it as pnpm would: tsx, cwd `packages/db`.
 *  I2. With NODE_ENV absent from the process environment, the tool exits
 *      non-zero BEFORE it opens any connection, drops nothing, and its output
 *      (stdout and stderr together) names `NODE_ENV` and contains no URL, no
 *      host, no port and no password. Wording beyond `NODE_ENV` is the
 *      builder's.
 *  I3. NODE_ENV=development and NODE_ENV=test are allowed: the tool drops,
 *      re-migrates and re-seeds a local database and exits 0.
 *  I4. Every other refusal it has today stays (pinned here; they pass on
 *      main): a non-local host, judged as pg judges it (`?host=` overrides);
 *      production; and values config's enum rejects (empty, `staging`,
 *      `Development`). Each refuses before connecting.
 *  I5. ORDER (task: "stay, in the same order, before any DROP"). In
 *      `reset.ts`, comments removed, the host check
 *      (`effectiveDatabaseTarget(` and `namesLocalDatabaseHost(`) comes
 *      before `assertMigrationTargetIsSafe(`, which comes before the first
 *      `.connect(`, which comes before the first `DROP `. Both calls stay in
 *      `reset.ts` itself. Where the NEW check sits is the builder's, as long as
 *      it is before `.connect(` (I2 tests that by behaviour, not by text).
 *  I6. The root script `db:reset` in the workspace `package.json` is
 *      `node <file> ...`, where `<file>` is a `.mjs`, `.cjs` or `.js` file
 *      under `tools/` (the one place the process.env lint rule and T-0014's
 *      scan exempt). No `cross-env`, no shell `NODE_ENV=...` assignment, no
 *      `set NODE_ENV`: it has to work in cmd.exe and PowerShell. The wrapper
 *      imports only `node:` built-ins and relative files (no new dependency).
 *  I7. Through the root script, an unset NODE_ENV becomes development and the
 *      reset works on a local container (the task's acceptance line).
 *  I8. The wrapper DEFAULTS NODE_ENV; it never overrides one that is set.
 *      `NODE_ENV=production pnpm db:reset` is refused today (the runner's
 *      guard enforces); a wrapper that writes `NODE_ENV: 'development'`
 *      unconditionally (the `tools/dev.mjs` pattern) would turn that refusal
 *      into a full drop. This file pins that it stays refused.
 *
 * Everything else is the builder's: the wrapper's name and arguments, whether
 * it spawns pnpm or tsx, the exact refusal text, and where the shared
 * "explicit environment" check lives (a helper in `@kasuwa/config` that a
 * future destructive tool can call is the natural shape).
 *
 * THE TRAP: `db:reset` IS BROKEN ON MAIN, WITH ANY NODE_ENV. Its DROP names a
 * hard-coded list of thirteen tables written before `object_def` existed.
 * Against a database at head it drops those, `_kasuwa_migration` and the
 * `app` schema, then re-runs every migration and fails at
 * `0002_metadata_object_and_field_def: relation "object_def" already exists`,
 * leaving a half-dropped database. That is the tracked follow-up in
 * DECISIONS.md ("`db:reset` drop list ... replace it with a catalogue query").
 * I3 and I7 (the task's own "still works on a local container") cannot pass
 * until it is fixed, so it is in this task's scope. A catalogue query over the
 * tables in `public` was enough in a throwaway check; whatever the builder
 * uses, it stays after the guards (I5).
 *
 * ---------------------------------------------------------------------------
 * HOW THE FILE IS BUILT
 * ---------------------------------------------------------------------------
 *
 * ITS OWN CLUSTER. The shared harness database is used by every other suite;
 * a reset there would drop it under them. So this file starts a bare
 * Postgres 16 with `startBarePostgres`, applies `bootstrap.sql` and
 * `bootstrap-test.sql` as docker-compose does (a "local container"), migrates
 * and seeds it, and plants a MARKER: a comment on `tenant`, `contact` and
 * `_kasuwa_migration`, three tables every reset drops. "Drops nothing" means
 * the fingerprint (every public table with its comment, the migration count,
 * the `app` schema, the tenant count) is identical before and after.
 *
 * BEFORE CONNECTING. Where the target matters only as "did anything connect",
 * the URL points at a TCP listener on 127.0.0.1 that counts connections and
 * hangs up. A refusal is zero connections. On main the unset case connects
 * (then fails on the hang-up), so that test fails for the real reason.
 *
 * THE CHILD'S ENVIRONMENT. Tests may not read `process.env` (lint). The child
 * inherits the worker's environment with `vi.stubEnv` applied just around the
 * spawn call and removed straight after: NODE_ENV (vitest sets `test`), the
 * three DATABASE_* URLs, KASUWA_AUTH_MODE and the PG* variables a guard reads.
 * `loadWorkspaceEnv()` never overrides a set variable, so the URL given wins
 * over a developer's `.env`. A `.env` that sets NODE_ENV would make "unset"
 * impossible to test; `.env.example` says it must not, and section 0 checks.
 *
 * D-L23, observed on main: 7 of 18 fail, each for a real reason. An unset
 * NODE_ENV with a loopback URL connects (the counter sees 1) and drops (the
 * marker is gone); the root script is `pnpm --filter`, not a node wrapper;
 * and the allowed resets (I3, I7) exit 1 on the stale drop list above. The 11
 * passes are section 0's preconditions, the I4 refusals, the I5 order and the
 * I8 production refusal: pins the change must not break. Every refusal is
 * judged by zero connections or an unchanged fingerprint, never by exit code
 * alone, and section 1's first test shows that the tool does connect when
 * nothing stops it, so no refusal can pass because the tool simply fails.
 * A throwaway prototype (guard, catalogue drop, wrapper; not committed) made
 * all 18 pass; the same wrapper overriding NODE_ENV unconditionally failed
 * I8.
 */

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const DB_PACKAGE = resolve(REPO_ROOT, 'packages', 'db');
const RESET_TS = resolve(DB_PACKAGE, 'src', 'cli', 'reset.ts');
const BOOTSTRAP_SQL = resolve(DB_PACKAGE, 'sql', 'bootstrap.sql');
const BOOTSTRAP_TEST_SQL = resolve(DB_PACKAGE, 'sql', 'bootstrap-test.sql');
const WORKSPACE_ENV = resolve(REPO_ROOT, '.env');

const MIGRATOR_PASSWORD = 'kasuwa_migrator_dev';
const TEST_ADMIN_PASSWORD = 'kasuwa_test_admin_dev';
/** RFC 2606: `.invalid` never resolves, so nothing can be reached by accident. */
const REMOTE_HOST = 'db.t0122.invalid';

/** A reset re-runs every migration and re-hashes the seed passwords. */
const RESET_TIMEOUT_MS = 180_000;

/** The variables stubbed around every spawn. `undefined` removes one. */
type ChildEnv = Readonly<Record<string, string | undefined>>;
const CLEARED: ChildEnv = {
  NODE_ENV: undefined,
  DATABASE_URL: undefined,
  DATABASE_AUTH_URL: undefined,
  DATABASE_MIGRATION_URL: undefined,
  KASUWA_AUTH_MODE: undefined,
  PGHOST: undefined,
  PGPORT: undefined,
  PGUSER: undefined,
  PGPASSWORD: undefined,
  PGDATABASE: undefined,
  PGPASSFILE: undefined,
  PGOPTIONS: undefined,
  PGSSLMODE: undefined,
  NODE_PG_FORCE_NATIVE: undefined,
};

// --- child processes ---------------------------------------------------------

interface Run {
  status: number | null;
  output: string;
}

/**
 * Spawns with the worker's environment plus `env`, stubbed only for the
 * duration of the (synchronous) spawn call. Resolves when the child exits.
 */
function spawnWith(
  env: ChildEnv,
  command: string,
  args: readonly string[],
  options: { cwd: string; shell: boolean },
): Promise<Run> {
  for (const [name, value] of Object.entries({ ...CLEARED, ...env })) {
    vi.stubEnv(name, value);
  }
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } finally {
    vi.unstubAllEnvs();
  }
  return new Promise((done) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      output += `\n[spawn] ${error.message}`;
    });
    child.on('close', (status) => done({ status, output }));
  });
}

/** I1: `@kasuwa/db`'s `reset` script, run the way pnpm runs it. */
function packageReset(env: ChildEnv): Promise<Run> {
  const tsxCli = createRequire(resolve(DB_PACKAGE, 'package.json')).resolve('tsx/cli');
  return spawnWith(env, process.execPath, [tsxCli, 'src/cli/reset.ts'], {
    cwd: DB_PACKAGE,
    shell: false,
  });
}

/** I6, I7, I8: the root `db:reset` script string, run in the repo root through a shell. */
function rootReset(env: ChildEnv): Promise<Run> {
  return spawnWith(env, rootScripts()['db:reset'] ?? 'exit 97', [], {
    cwd: REPO_ROOT,
    shell: true,
  });
}

function rootScripts(): Record<string, string | undefined> {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return manifest.scripts ?? {};
}

// --- the connection counter ------------------------------------------------------

interface Counter {
  port: number;
  connections: () => number;
  close: () => Promise<void>;
}

/** A TCP listener on 127.0.0.1 that counts connections and hangs up on each. */
async function startCounter(): Promise<Counter> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ready());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the counter has no TCP port');
  }
  return {
    port: address.port,
    connections: () => count,
    close: () =>
      new Promise<void>((closed) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => closed());
      }),
  };
}

// --- the cluster -------------------------------------------------------------------

let cluster: BarePostgres;
let counter: Counter;
/** The migrator on the cluster, host as Testcontainers reports it. */
let migratorUrl: string;

function withHost(url: string, host: string): string {
  const parsed = new URL(url);
  parsed.hostname = host;
  return parsed.href;
}

function counterUrl(host = '127.0.0.1'): string {
  return `postgresql://kasuwa_migrator:${MIGRATOR_PASSWORD}@${host}:${counter.port}/kasuwa`;
}

async function query<Row extends Record<string, unknown>>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<Row>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** The tables every reset drops, and that therefore carry the marker. */
const MARKED_TABLES = ['tenant', 'contact', '_kasuwa_migration'] as const;

async function plantMarker(): Promise<string> {
  const marker = `t0122-marker-${randomBytes(6).toString('hex')}`;
  for (const table of MARKED_TABLES) {
    await query(cluster.superuserUrl, `COMMENT ON TABLE public.${table} IS '${marker}'`);
  }
  return marker;
}

interface Fingerprint {
  tables: string;
  migrations: number;
  appSchema: boolean;
  tenants: number;
}

/** Read as the superuser, which sees past RLS: every table, its comment, and the counts. */
async function fingerprint(): Promise<Fingerprint> {
  const [row] = await query<{
    tables: string | null;
    migrations: string;
    app_schema: boolean;
    tenants: string;
  }>(
    cluster.superuserUrl,
    `SELECT
       (SELECT string_agg(c.relname || '=' || coalesce(obj_description(c.oid, 'pg_class'), ''),
                          ',' ORDER BY c.relname)
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')) AS tables,
       (SELECT count(*) FROM public._kasuwa_migration)::text AS migrations,
       EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'app') AS app_schema,
       (SELECT count(*) FROM public.tenant)::text AS tenants`,
  );
  if (row === undefined) throw new Error('the fingerprint query returned no row');
  return {
    tables: row.tables ?? '',
    migrations: Number(row.migrations),
    appSchema: row.app_schema,
    tenants: Number(row.tenants),
  };
}

async function markerOn(table: (typeof MARKED_TABLES)[number]): Promise<string | null> {
  const rows = await query<{ comment: string | null }>(
    cluster.superuserUrl,
    `SELECT obj_description(to_regclass($1), 'pg_class') AS comment`,
    [`public.${table}`],
  );
  return rows[0]?.comment ?? null;
}

// --- assertions ----------------------------------------------------------------------

/** I2: no URL, no host, no port, no password in what the tool printed. */
function expectNothingNamed(run: Run, url: string): void {
  const parsed = new URL(url);
  expect(run.output, 'the output carries a connection string').not.toMatch(/postgres(?:ql)?:\/\//iu);
  expect(run.output, 'the output names the host').not.toContain(parsed.hostname);
  if (parsed.port !== '') {
    expect(run.output, 'the output names the port').not.toContain(parsed.port);
  }
  expect(run.output, 'the output carries the password').not.toContain(MIGRATOR_PASSWORD);
  // Not merely absent from the cases above: localhost spelled any way.
  expect(run.output).not.toMatch(/\blocalhost\b|127\.0\.0\.1|::1/iu);
}

/** An allowed run: exit 0, every marked table rebuilt, every migration applied, the seed back. */
async function expectReset(run: Run): Promise<void> {
  expect(run.status, `the reset did not exit 0:\n${run.output}`).toBe(0);
  for (const table of MARKED_TABLES) {
    expect(await markerOn(table), `${table} was not dropped and rebuilt`).toBeNull();
  }
  const after = await fingerprint();
  expect(after.migrations, 'not every migration was re-applied').toBe(loadMigrations().length);
  expect(after.appSchema).toBe(true);
  const tenants = await query<{ id: string }>(
    cluster.urlFor('kasuwa_test_admin', TEST_ADMIN_PASSWORD),
    'SELECT id FROM public.tenant WHERE id = ANY($1::uuid[]) ORDER BY id',
    [[TENANT_A, TENANT_B]],
  );
  expect(tenants.map((row) => row.id).sort(), 'the seed did not run').toEqual(
    [TENANT_A, TENANT_B].sort(),
  );
}

/**
 * SQL- and TS-agnostic comment removal for a source file: `//` and block
 * comments go, string and template literals stay. Enough for reset.ts.
 */
function withoutComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (char === "'" || char === '"' || char === '`') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        end += source[end] === '\\' ? 2 : 1;
      }
      out += source.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------

beforeAll(async () => {
  counter = await startCounter();
  cluster = await startBarePostgres();
  // A local container, as docker-compose builds one.
  await query(cluster.superuserUrl, readFileSync(BOOTSTRAP_SQL, 'utf8'));
  await query(cluster.superuserUrl, readFileSync(BOOTSTRAP_TEST_SQL, 'utf8'));
  migratorUrl = cluster.urlFor('kasuwa_migrator', MIGRATOR_PASSWORD);
  await runMigrations({ connectionString: migratorUrl, env: { NODE_ENV: 'test' } });
  await runSeed({ connectionString: migratorUrl, env: { NODE_ENV: 'test' } });
}, RESET_TIMEOUT_MS);

afterAll(async () => {
  vi.unstubAllEnvs();
  await counter?.close();
  await cluster?.stop();
});

describe('0. preconditions (if one fails, the rest of this file proves nothing)', () => {
  // These pass on main by design: they check the test's own footing.
  it('the cluster is reached on a loopback host: the case D-L103 is about', () => {
    expect(isLocalDatabaseHost(new URL(migratorUrl).hostname)).toBe(true);
  });

  it('the workspace .env, if there is one, sets no NODE_ENV (.env.example says it must not)', () => {
    if (!existsSync(WORKSPACE_ENV)) return; // No .env: nothing can set it. Legitimately vacuous.
    const setsNodeEnv = readFileSync(WORKSPACE_ENV, 'utf8')
      .split(/\r?\n/u)
      .some((line) => /^\s*(?:export\s+)?NODE_ENV\s*=/u.test(line));
    expect(setsNodeEnv, 'remove NODE_ENV from .env (D-L95); "unset" cannot be tested').toBe(false);
  });

  it('the @kasuwa/db reset script is still `tsx src/cli/reset.ts` (I1)', () => {
    const manifest = JSON.parse(readFileSync(resolve(DB_PACKAGE, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts?.reset).toBe('tsx src/cli/reset.ts');
  });
});

describe('1. an unset NODE_ENV is refused before connecting, and drops nothing (I2)', () => {
  it('against a loopback listener: refused, zero connections, names NODE_ENV and nothing else', async () => {
    const url = counterUrl();
    const before = counter.connections();
    const run = await packageReset({ DATABASE_MIGRATION_URL: url });

    expect(counter.connections() - before, `the tool connected before refusing:\n${run.output}`).toBe(0);
    expect(run.status, 'the tool exited 0 with NODE_ENV unset').not.toBe(0);
    expect(run.output).toContain('NODE_ENV');
    expectNothingNamed(run, url);
  }, RESET_TIMEOUT_MS);

  it('against a real local database on `localhost`: refused, and every table is still there', async () => {
    const marker = await plantMarker();
    const before = await fingerprint();
    expect(before.tables).toContain(`tenant=${marker}`);

    const url = withHost(migratorUrl, 'localhost');
    const run = await packageReset({ DATABASE_MIGRATION_URL: url });

    expect(await fingerprint(), `the tool changed the database:\n${run.output}`).toEqual(before);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('NODE_ENV');
    expectNothingNamed(run, url);
  }, RESET_TIMEOUT_MS);
});

describe('2. NODE_ENV=development and NODE_ENV=test are allowed (I3)', () => {
  it.each(['development', 'test'])(
    'NODE_ENV=%s resets a local database: dropped, re-migrated, re-seeded, exit 0',
    async (nodeEnv) => {
      await plantMarker();
      const run = await packageReset({ NODE_ENV: nodeEnv, DATABASE_MIGRATION_URL: migratorUrl });
      await expectReset(run);
    },
    RESET_TIMEOUT_MS,
  );
});

describe('3. the existing refusals stay, each before connecting (I4; pins, pass on main)', () => {
  it.each([
    ['production', { NODE_ENV: 'production', KASUWA_AUTH_MODE: 'jwt' }],
    ['an empty NODE_ENV', { NODE_ENV: '' }],
    ['NODE_ENV=staging', { NODE_ENV: 'staging' }],
    ['NODE_ENV=Development', { NODE_ENV: 'Development' }],
  ] as const)('%s against a loopback listener: refused, zero connections', async (_label, env) => {
    const url = counterUrl();
    const before = counter.connections();
    const run = await packageReset({ ...env, DATABASE_MIGRATION_URL: url });

    expect(counter.connections() - before, `the tool connected before refusing:\n${run.output}`).toBe(0);
    expect(run.status).not.toBe(0);
    expectNothingNamed(run, url);
  }, RESET_TIMEOUT_MS);

  it.each([
    ['a non-local host', (url: string) => withHost(url, REMOTE_HOST)],
    [
      'a loopback URL whose ?host= names a non-local host (pg obeys the parameter)',
      (url: string) => `${withHost(url, 'localhost')}?host=${REMOTE_HOST}`,
    ],
  ])('NODE_ENV=development with %s: refused, nothing named', async (_label, shape) => {
    const marker = await plantMarker();
    const before = await fingerprint();
    const url = shape(migratorUrl);
    const run = await packageReset({ NODE_ENV: 'development', DATABASE_MIGRATION_URL: url });

    expect(run.status).not.toBe(0);
    expect(await fingerprint()).toEqual(before);
    expect(await markerOn('tenant')).toBe(marker);
    // A DNS failure would say ENOTFOUND <host>: the refusal must come first.
    expect(run.output).not.toContain(REMOTE_HOST);
    expect(run.output).not.toMatch(/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/u);
    expect(run.output).not.toContain(MIGRATOR_PASSWORD);
  }, RESET_TIMEOUT_MS);
});

describe('4. the existing checks run in the same order, before any DROP (I5)', () => {
  it('reset.ts: host check, then assertMigrationTargetIsSafe, then connect, then DROP', () => {
    const code = withoutComments(readFileSync(RESET_TS, 'utf8'));
    const at = (needle: string): number => code.indexOf(needle);

    const effective = at('effectiveDatabaseTarget(');
    const local = at('namesLocalDatabaseHost(');
    const safe = at('assertMigrationTargetIsSafe(');
    const connect = at('.connect(');
    const drop = at('DROP ');

    for (const [name, position] of Object.entries({ effective, local, safe, connect, drop })) {
      expect(position, `${name} is not in reset.ts`).toBeGreaterThanOrEqual(0);
    }
    expect(Math.max(effective, local), 'the host check moved after assertMigrationTargetIsSafe').toBeLessThan(safe);
    expect(safe, 'assertMigrationTargetIsSafe moved after the connection').toBeLessThan(connect);
    expect(connect).toBeLessThan(drop);
  });
});

describe('5. the root `pnpm db:reset` sets NODE_ENV through a small node wrapper (I6)', () => {
  const WRAPPER = /^node\s+("?)([^\s"]+\.(?:mjs|cjs|js))\1(?:\s|$)/u;

  function wrapperPath(): string | undefined {
    const match = WRAPPER.exec(rootScripts()['db:reset'] ?? '');
    return match?.[2] === undefined ? undefined : resolve(REPO_ROOT, match[2]);
  }

  it('the script is `node tools/<file>`, with no cross-env and no shell assignment', () => {
    const script = rootScripts()['db:reset'] ?? '';
    expect(script, 'db:reset is not `node <file> ...`').toMatch(WRAPPER);
    expect(script).not.toMatch(/cross-env|dotenv-cli|\bNODE_ENV\s*=|\bset\s+NODE_ENV\b|\$env:/iu);

    const file = wrapperPath();
    expect(file, 'no wrapper file is named').toBeDefined();
    if (file === undefined) return;
    expect(existsSync(file), `${file} does not exist`).toBe(true);
    expect(file.startsWith(resolve(REPO_ROOT, 'tools') + sep), 'the wrapper is not under tools/').toBe(true);
  });

  it('the wrapper imports only node: built-ins and relative files (no new dependency)', () => {
    const file = wrapperPath();
    expect(file, 'no wrapper file is named').toBeDefined();
    if (file === undefined || !existsSync(file)) {
      throw new Error('the wrapper file does not exist');
    }
    const code = withoutComments(readFileSync(file, 'utf8'));
    const specifiers = [
      ...code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/gu),
      ...code.matchAll(/\bimport\s*['"]([^'"]+)['"]/gu),
      ...code.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu),
    ].map((match) => match[1] ?? '');
    // A wrapper with no import at all is possible but implausible (it has to
    // spawn something); the list is checked, not its length.
    const foreign = specifiers.filter((name) => !name.startsWith('node:') && !name.startsWith('.'));
    expect(foreign, 'the wrapper imports a package').toEqual([]);
  });
});

describe('6. the root script still resets a local container, and never overrides a set NODE_ENV (I7, I8)', () => {
  it('NODE_ENV unset through `pnpm db:reset`: reset, exit 0', async () => {
    await plantMarker();
    const run = await rootReset({ DATABASE_MIGRATION_URL: migratorUrl });
    await expectReset(run);
  }, RESET_TIMEOUT_MS);

  it('NODE_ENV=production through `pnpm db:reset` is still refused: the wrapper defaults, never overrides', async () => {
    const marker = await plantMarker();
    const before = await fingerprint();
    const run = await rootReset({
      NODE_ENV: 'production',
      KASUWA_AUTH_MODE: 'jwt',
      DATABASE_MIGRATION_URL: migratorUrl,
    });

    expect(await fingerprint(), `production was reset:\n${run.output}`).toEqual(before);
    expect(await markerOn('tenant')).toBe(marker);
    expect(run.status).not.toBe(0);
  }, RESET_TIMEOUT_MS);
});
