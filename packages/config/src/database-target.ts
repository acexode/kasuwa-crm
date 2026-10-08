import { parse as parseConnectionString } from 'pg-connection-string';
import { migratorEnv, type EnvSource } from './schemas.mjs';

/**
 * Guards on WHERE a process connects and WITH WHAT, for T-0117 (D-L92, D-L94).
 *
 * Three holes, one module:
 *
 *   - The repository's development passwords. `bootstrap.sql` creates the
 *     login roles with literal dev passwords so that a fresh dev volume works
 *     with no configuration. Real provisioning creates each role first with a
 *     secrets-manager password, and the bootstrap's `IF NOT EXISTS` then leaves
 *     it alone. If provisioning forgets, the cell's roles have passwords that
 *     are in a public repository. Outside development and test, a connection
 *     that would authenticate with one of them is refused.
 *   - pg's environment. `pg` reads PGHOST, PGPASSWORD and PGUSER when the
 *     connection string does not say, PGPASSFILE names the pgpass file it
 *     reads when no password is given, and PGOPTIONS, PGPORT, PGSSLMODE and
 *     the rest change the connection too; NODE_PG_FORCE_NATIVE swaps the
 *     driver for libpq, which reads every libpq variable. So a URL that looks
 *     fine can connect somewhere else, as someone else, differently. Outside
 *     development and test, ANY variable whose name starts with `PG` (case
 *     ignored, as Windows does), and NODE_PG_FORCE_NATIVE, is refused outright
 *     (T-0117 review m2): every connection is a URL from `@kasuwa/config`, and
 *     nothing else may steer it. Messages name the variable, never the value.
 *     A default `~/.pgpass` (no PGPASSFILE) is not detected; that is a
 *     documented limit.
 *   - An unset NODE_ENV. The dev `.env` deliberately sets none (Nx would leak
 *     it into `next build`), and `@kasuwa/config` then defaults to
 *     development, which relaxes every guard. That is right on a laptop and
 *     wrong against a real database. The API and the worker therefore refuse
 *     an unset NODE_ENV outright (D-L95, `./server-env.ts`); dev and test
 *     entry points set it per process (tools/dev.mjs, the e2e harness,
 *     vitest). The migration runner keeps the D-L94 rule: an unset NODE_ENV
 *     is refused unless the connection string itself names a local host. A
 *     URL that names no host is NOT local, whatever PGHOST or pg's default
 *     would make of it (lead ruling on T-0117; domain-core's provisioning
 *     guard already treats it so). DOCUMENTED LIMIT: loopback is not proof of
 *     a laptop. cloud-sql-proxy, `kubectl port-forward` and SSH tunnels all
 *     listen on 127.0.0.1, so an unset NODE_ENV through one of them migrates
 *     as development. A real cell reached that way is still caught by the
 *     API and worker boot checks at its next deploy.
 *
 * JUDGED AS PG WILL USE IT. `pg` parses a connection string with
 * `pg-connection-string`, where a `?host=` or `?password=` query parameter
 * OVERRIDES the URL's own, and the password is percent-decoded. A guard that
 * read `new URL(u).hostname` or `.password` would be fooled by all three, so
 * this module asks the same parser pg asks, then applies pg's own fallbacks
 * (the PG* variable, then pg's default) from the environment it was given.
 *
 * NOTHING HERE ECHOES A VALUE. Messages name a variable or a role and say why;
 * never a URL, a host or a password. An operator who pastes a secret into the
 * wrong variable must not find it in a boot log.
 *
 * WHY THIS IS TYPESCRIPT, NOT `.mjs` LIKE THE SCHEMAS: `pg-connection-string`
 * must stay out of the web process's module graph. `apps/web` imports
 * `./web.mjs`, which imports `./schemas.mjs`; Next bundles that for every
 * runtime its instrumentation hook runs in, and the parser can `require('fs')`.
 * So the schemas import nothing from here, and `./server-env.ts` composes
 * these checks onto the API and worker schemas instead.
 */

/**
 * The repository's development passwords (D-L94). Each is in
 * `packages/db/sql/bootstrap.sql`, `bootstrap-test.sql`, `.env.example` or
 * docker-compose (the superuser's `postgres`, T-0117 review m5), so each is
 * public. Not secrets: a list of things that must never BE one.
 */
export const DEV_DATABASE_PASSWORDS: readonly string[] = Object.freeze([
  'kasuwa_migrator_dev',
  'kasuwa_app_dev',
  'kasuwa_auth_dev',
  'kasuwa_test_admin_dev',
  'postgres',
]);

/**
 * True for an environment variable that can steer a pg connection: any name
 * starting with `PG` (compared without case: Windows environment names are
 * case-insensitive), and NODE_PG_FORCE_NATIVE, which swaps in libpq.
 */
export function isPgEnvironmentVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('PG') || upper === 'NODE_PG_FORCE_NATIVE';
}

/** pg's own default host, used when neither the URL nor PGHOST names one. */
const PG_DEFAULT_HOST = 'localhost';

/** Loopback names, exactly (D-L94 R5). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Local means a loopback TCP host from the list D-L94 R5 states: `localhost`,
 * `127.0.0.1`, `::1` and names ending in `.localhost`. Compared without case,
 * as DNS names are. NOT local:
 *   - other 127/8 addresses (the ruling's list is exact);
 *   - a Unix socket path, because a socket can front a proxy to anywhere
 *     (cloud SQL proxies are sockets);
 *   - a multi-host list, even one that starts with localhost;
 *   - a name that merely starts with `localhost`.
 */
export function isLocalDatabaseHost(host: string): boolean {
  const name = host.toLowerCase();
  return (
    LOCAL_HOSTS.has(name) || (name.endsWith('.localhost') && name.length > '.localhost'.length)
  );
}

/** The connection could not be parsed the way pg parses it. The value is never echoed. */
export class UnparseableConnectionStringError extends Error {
  constructor(variable: string) {
    super(`${variable}: cannot be parsed as a PostgreSQL connection string.`);
    this.name = 'UnparseableConnectionStringError';
  }
}

export interface EffectiveDatabaseTarget {
  /** The host pg will connect to: the URL's, else PGHOST, else pg's default. */
  host: string;
  /**
   * The host the connection string itself names (a `?host=` included), or
   * undefined when it names none and pg would fall back.
   */
  namedHost: string | undefined;
  /** The password pg will send: the URL's, else PGPASSWORD. Undefined when neither says. */
  password: string | undefined;
}

/**
 * The host and password `pg` will use for `connectionString`, given the
 * environment `source`.
 *
 * `pg` treats an empty value as absent (`config[key] || PG* || default`), so
 * this does too. It does not read a pgpass file, which pg would consult when
 * no password is given at all; see the T-0117 report.
 *
 * Throws `UnparseableConnectionStringError` naming `variable`, never the value.
 */
export function effectiveDatabaseTarget(
  connectionString: string,
  variable: string,
  source: EnvSource = process.env,
): EffectiveDatabaseTarget {
  let parsed: ReturnType<typeof parseConnectionString>;
  try {
    parsed = parseConnectionString(connectionString);
  } catch {
    // Deliberately not chained: the parser's error can carry the input.
    throw new UnparseableConnectionStringError(variable);
  }
  const namedHost = nonEmpty(parsed.host);
  const host = namedHost ?? nonEmpty(source.PGHOST) ?? PG_DEFAULT_HOST;
  const password = nonEmpty(parsed.password) ?? nonEmpty(source.PGPASSWORD);
  return { host, namedHost, password };
}

/**
 * True only when the connection string itself names a local host. A string
 * that names none is NOT local: the host would come from PGHOST or pg's
 * default, which are not part of the URL anyone reviewed (lead ruling on
 * T-0117, the same rule as domain-core's provisioning guard).
 */
export function namesLocalDatabaseHost(target: EffectiveDatabaseTarget): boolean {
  return target.namedHost !== undefined && isLocalDatabaseHost(target.namedHost);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * SASLprep (RFC 4013) exactly as pg applies it before SCRAM
 * (`pg/lib/crypto/sasl.js`, pg 8.23): RFC 3454 C.1.2 non-ASCII spaces become
 * U+0020, the B.1 "mapped to nothing" characters are removed, then NFKC. The
 * server prepares the stored verifier the same way, so a password that
 * differs from a dev one only by, say, a soft hyphen or a fullwidth letter
 * AUTHENTICATES as it (T-0117 review m1). The two character classes are
 * copied from pg; keep them in step if pg changes.
 */
export function saslprep(password: string): string {
  const nonAsciiSpace = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/gu;
  const mappedToNothing =
    // eslint-disable-next-line no-misleading-character-class -- RFC 3454 B.1, as pg has it
    /[\u00AD\u034F\u1806\u180B\u180C\u180D\u200C\u200D\u2060\uFE00-\uFE0F\uFEFF]/gu;
  return password.replace(nonAsciiSpace, ' ').replace(mappedToNothing, '').normalize('NFKC');
}

const PREPARED_DEV_PASSWORDS: ReadonlySet<string> = new Set(DEV_DATABASE_PASSWORDS.map(saslprep));

/**
 * True when `password`, prepared as pg prepares it for SCRAM, is one of the
 * repository's development passwords.
 */
export function isDevDatabasePassword(password: string | undefined): boolean {
  return password !== undefined && PREPARED_DEV_PASSWORDS.has(saslprep(password));
}

/** The pg-steering variables set in `source`, by name, sorted. Presence is the test. */
export function pgFallbacksSet(source: EnvSource): string[] {
  return Object.keys(source)
    .filter((name) => source[name] !== undefined && isPgEnvironmentVariable(name))
    .sort();
}

/**
 * The problems with a server process's database connections outside
 * development and test, or none. One line per problem, in the shape
 * `parseOrThrow` uses, each naming a variable and never its value.
 */
export function databaseCredentialProblems(
  source: EnvSource,
  variables: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const name of pgFallbacksSet(source)) {
    problems.push(
      `  ${name}: must not be set outside development and test. pg (or libpq) reads ` +
        'it, so it can redirect, re-authenticate or reconfigure a connection that looks ' +
        'correct. Put everything in the connection URL (D-L94).',
    );
  }
  for (const variable of variables) {
    const connectionString = source[variable];
    if (connectionString === undefined) {
      continue;
    }
    let target: EffectiveDatabaseTarget;
    try {
      target = effectiveDatabaseTarget(connectionString, variable, source);
    } catch (error) {
      problems.push(`  ${(error as Error).message}`);
      continue;
    }
    if (isDevDatabasePassword(target.password)) {
      problems.push(
        `  ${variable}: carries one of the repository's development passwords. Outside ` +
          'development and test every database password comes from the secrets manager; ' +
          'set the role password there and in this URL (D-L94).',
      );
    }
  }
  return problems;
}

/** What `assertMigrationTargetIsSafe` decided. */
export interface MigrationTargetDecision {
  /**
   * True outside development and test: the runner must then also refuse a
   * usable `kasuwa_test_admin`, which only the database can tell it.
   */
  enforce: boolean;
  /** NODE_ENV as parsed, for the runner's messages. */
  nodeEnv: 'development' | 'test' | 'production';
}

/**
 * The migration runner's environment checks (T-0117, D-L94), made BEFORE it
 * connects, so a refusal can never depend on reaching the host.
 *
 *   1. `migratorEnv(source)`: the environment must be valid (an empty or
 *      unknown NODE_ENV is invalid, not unset) and pass the stub-auth guard.
 *   2. NODE_ENV absent from `source` (read RAW, not through the default) is
 *      allowed only when the connection string names a local host (a string
 *      naming no host is not local); it is then treated as development, which
 *      is what a local `pnpm db:migrate` is.
 *   3. Outside development and test: no variable starting with `PG`, and no
 *      NODE_PG_FORCE_NATIVE, is set, and the password pg will send is not one
 *      of the repository's (compared after SASLprep).
 *
 * Throws with a message that names the variable and the reason, never the
 * URL, the host or the password. Returns whether the runner must enforce the
 * role check.
 */
export function assertMigrationTargetIsSafe(
  connectionString: string,
  source: EnvSource = process.env,
): MigrationTargetDecision {
  const parsed = migratorEnv(source);
  const variable = 'the migration connection string';

  if (source.NODE_ENV === undefined) {
    if (!namesLocalDatabaseHost(effectiveDatabaseTarget(connectionString, variable, source))) {
      throw new Error(
        'Refusing to migrate: NODE_ENV is not set and the connection string does not name ' +
          'a local database host. ' +
          'An unset NODE_ENV defaults to development, which turns off the production ' +
          'guards. Set NODE_ENV=production (or development or test) explicitly. Nothing ' +
          'was applied (D-L94).',
      );
    }
    return { enforce: false, nodeEnv: 'development' };
  }

  if (parsed.NODE_ENV === 'development' || parsed.NODE_ENV === 'test') {
    return { enforce: false, nodeEnv: parsed.NODE_ENV };
  }

  const problems = [...pgFallbacksSet(source)].map(
    (name) =>
      `  ${name} is set. pg (or libpq) reads it, so it can redirect, re-authenticate ` +
      'or reconfigure the migration. Put everything in the URL.',
  );
  const { password } = effectiveDatabaseTarget(connectionString, variable, source);
  if (isDevDatabasePassword(password)) {
    problems.push(
      '  the migration connection string carries one of the repository’s development ' +
        'passwords. Set kasuwa_migrator’s password from the secrets manager.',
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `Refusing to migrate with NODE_ENV=${parsed.NODE_ENV} (D-L94); nothing was applied:\n` +
        problems.join('\n'),
    );
  }
  return { enforce: true, nodeEnv: parsed.NODE_ENV };
}
