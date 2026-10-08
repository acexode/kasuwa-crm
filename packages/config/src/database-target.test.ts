import { describe, expect, it, vi } from 'vitest';
import {
  assertMigrationTargetIsSafe,
  DEV_DATABASE_PASSWORDS,
  effectiveDatabaseTarget,
  isDevDatabasePassword,
  isLocalDatabaseHost,
  isPgEnvironmentVariable,
  namesLocalDatabaseHost,
  saslprep,
} from './database-target';
import { apiEnv, workerEnv, type EnvSource } from './index';

/**
 * T-0117 (D-L94): the database-target guards. The acceptance suite
 * (tests/acceptance/tenancy/test-admin-absent) proves them end to end against
 * real clusters; this pins the parsing and each branch, fast.
 *
 * Invented values only. SECRET stands in for a secrets-manager password, and
 * every refusal is checked never to echo it, a dev password, or a URL.
 */
const SECRET = 'n0t-a-real-pw-t0117-4c2';
const REMOTE = 'db.t0117-unit.invalid';
const url = (role: string, password: string, host = REMOTE, suffix = ''): string =>
  `postgres://${role}:${password}@${host}:5432/kasuwa${suffix}`;

const PRODUCTION: EnvSource = { NODE_ENV: 'production', KASUWA_AUTH_MODE: 'jwt' };
const API_PRODUCTION: EnvSource = {
  ...PRODUCTION,
  KASUWA_KMS_PROVIDER: 'aws-kms',
  KASUWA_KMS_KEY_ID: 'alias/kasuwa-t0117-unit',
  KASUWA_TRUST_PROXY_HOPS: '1',
  DATABASE_URL: url('kasuwa_app', SECRET),
  DATABASE_AUTH_URL: url('kasuwa_auth', SECRET),
};
const WORKER_PRODUCTION: EnvSource = {
  ...PRODUCTION,
  KASUWA_KMS_PROVIDER: 'aws-kms',
  DATABASE_URL: url('kasuwa_app', SECRET),
};

/**
 * T-0117 review m2: every PG* name refuses (case ignored), and so does
 * NODE_PG_FORCE_NATIVE. Values are SECRET, so a message that echoed one fails.
 */
const PG_STEERING = [
  'PGHOST',
  'PGPASSWORD',
  'PGUSER',
  'PGPASSFILE',
  'PGOPTIONS',
  'PGPORT',
  'PGSSLMODE',
  'PGAPPNAME',
  'pgsslrootcert',
  'NODE_PG_FORCE_NATIVE',
];

/**
 * T-0117 review m1: passwords pg's SASLprep turns into a dev one, so the
 * server would accept them for it. Each inserts or swaps one character.
 */
const SASLPREP_DISGUISES: readonly (readonly [string, string])[] = [
  ['a soft hyphen (U+00AD)', 'kasuwa_app\u00AD_dev'],
  ['a zero-width joiner (U+200D)', 'kasuwa\u200D_app_dev'],
  ['a byte-order mark (U+FEFF)', '\uFEFFkasuwa_app_dev'],
  ['a fullwidth letter (U+FF4B)', '\uFF4Basuwa_app_dev'],
];

function messageOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

function expectNoSecret(message: string, extra: readonly string[] = []): void {
  for (const secret of [SECRET, REMOTE, ...DEV_DATABASE_PASSWORDS, ...extra]) {
    expect(message).not.toContain(secret);
  }
  expect(message).not.toMatch(/postgres(?:ql)?:\/\//u);
}

describe('effectiveDatabaseTarget judges what pg will use', () => {
  it('reads the host and password from the URL', () => {
    expect(effectiveDatabaseTarget(url('kasuwa_app', SECRET), 'X', {})).toEqual({
      host: REMOTE,
      namedHost: REMOTE,
      password: SECRET,
    });
  });

  it('lets ?host= and ?password= override the URL, as pg-connection-string does', () => {
    const target = effectiveDatabaseTarget(
      url('kasuwa_app', SECRET, 'localhost', `?host=${REMOTE}&password=kasuwa_app_dev`),
      'X',
      {},
    );
    expect(target).toEqual({ host: REMOTE, namedHost: REMOTE, password: 'kasuwa_app_dev' });
  });

  it('percent-decodes the password', () => {
    expect(effectiveDatabaseTarget(url('kasuwa_app', 'kasuwa%5Fapp%5Fdev'), 'X', {}).password).toBe(
      'kasuwa_app_dev',
    );
  });

  it("falls back to PGHOST and PGPASSWORD, then pg's default host, when the URL is silent", () => {
    expect(effectiveDatabaseTarget('postgres:///kasuwa', 'X', { PGHOST: REMOTE })).toEqual({
      host: REMOTE,
      namedHost: undefined,
      password: undefined,
    });
    expect(
      effectiveDatabaseTarget('postgres://kasuwa_app@/kasuwa', 'X', { PGPASSWORD: SECRET }),
    ).toEqual({ host: 'localhost', namedHost: undefined, password: SECRET });
  });

  it('reports a Unix socket path as the host', () => {
    expect(effectiveDatabaseTarget('/var/run/postgresql kasuwa', 'X', {}).host).toBe(
      '/var/run/postgresql',
    );
  });
});

describe('isLocalDatabaseHost is exactly the D-L94 R5 list', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]', 'db.localhost'])(
    '%s is local',
    (host) => {
      expect(isLocalDatabaseHost(host)).toBe(true);
    },
  );

  it.each([
    REMOTE,
    'localhost.t0117.invalid',
    '127.0.0.2',
    '.localhost',
    '/var/run/postgresql',
    'localhost,db.t0117.invalid',
    '',
  ])('%j is not local', (host) => {
    expect(isLocalDatabaseHost(host)).toBe(false);
  });
});

describe('namesLocalDatabaseHost: only a host the URL itself names can be local', () => {
  it.each([
    ['localhost in the URL', url('kasuwa_app', SECRET, 'localhost'), {}, true],
    ['127.0.0.1 in the URL', url('kasuwa_app', SECRET, '127.0.0.1'), {}, true],
    [
      'localhost overridden by ?host=',
      url('kasuwa_app', SECRET, 'localhost', `?host=${REMOTE}`),
      {},
      false,
    ],
    ['no host, no PGHOST', 'postgres:///kasuwa', {}, false],
    ['no host, PGHOST=localhost', 'postgres:///kasuwa', { PGHOST: 'localhost' }, false],
  ] as const)('%s -> %s', (_what, connectionString, env, local) => {
    expect(namesLocalDatabaseHost(effectiveDatabaseTarget(connectionString, 'X', env))).toBe(local);
  });
});

describe('isPgEnvironmentVariable (T-0117 review m2)', () => {
  it.each(PG_STEERING)('%s steers pg', (name) => {
    expect(isPgEnvironmentVariable(name)).toBe(true);
  });

  it.each(['PATH', 'HOME', 'NODE_ENV', 'APGAR', 'DATABASE_URL', 'NODE_PG'])(
    '%s does not',
    (name) => {
      expect(isPgEnvironmentVariable(name)).toBe(false);
    },
  );
});

describe('dev passwords are compared after SASLprep, as pg does (T-0117 review m1)', () => {
  it('saslprep maps non-ASCII spaces, removes B.1 characters and applies NFKC', () => {
    expect(saslprep('a\u00A0b')).toBe('a b');
    expect(saslprep('a\u00ADb\u200Dc\uFEFFd')).toBe('abcd');
    expect(saslprep('\uFF4B')).toBe('k');
    expect(saslprep('kasuwa_app_dev')).toBe('kasuwa_app_dev');
  });

  it.each(SASLPREP_DISGUISES)('a dev password with %s is still a dev password', (_how, pw) => {
    expect(pw).not.toBe('kasuwa_app_dev');
    expect(isDevDatabasePassword(pw)).toBe(true);
  });

  it('the superuser password `postgres` is a dev password (review m5)', () => {
    expect(DEV_DATABASE_PASSWORDS).toContain('postgres');
    expect(isDevDatabasePassword('postgres')).toBe(true);
    expect(isDevDatabasePassword('\uFF50ostgres')).toBe(true);
  });

  it('a password that merely resembles one is not', () => {
    expect(isDevDatabasePassword('kasuwa_app_dev2')).toBe(false);
    expect(isDevDatabasePassword(SECRET)).toBe(false);
    expect(isDevDatabasePassword(undefined)).toBe(false);
  });
});

describe('assertMigrationTargetIsSafe', () => {
  it('enforces the role check in production with a secret password', () => {
    expect(assertMigrationTargetIsSafe(url('kasuwa_migrator', SECRET), PRODUCTION)).toEqual({
      enforce: true,
      nodeEnv: 'production',
    });
  });

  it.each([
    ['development', { NODE_ENV: 'development' }],
    ['test', { NODE_ENV: 'test' }],
  ] as const)('relaxes everything in %s, PG* and dev passwords included', (name, env) => {
    expect(
      assertMigrationTargetIsSafe(url('kasuwa_migrator', 'kasuwa_migrator_dev'), {
        ...env,
        PGHOST: REMOTE,
      }),
    ).toEqual({ enforce: false, nodeEnv: name });
  });

  it('treats an unset NODE_ENV against a local host as development', () => {
    expect(
      assertMigrationTargetIsSafe(url('kasuwa_migrator', 'kasuwa_migrator_dev', 'localhost'), {}),
    ).toEqual({ enforce: false, nodeEnv: 'development' });
  });

  it.each([
    ['a remote host', url('kasuwa_migrator', SECRET)],
    [
      'localhost overridden by ?host=',
      url('kasuwa_migrator', SECRET, 'localhost', `?host=${REMOTE}`),
    ],
    ['a socket', `/var/run/postgresql kasuwa`],
  ])('refuses an unset NODE_ENV against %s, naming NODE_ENV', (_what, connectionString) => {
    const message = messageOf(() => assertMigrationTargetIsSafe(connectionString, {}));
    expect(message).toContain('NODE_ENV');
    expectNoSecret(message);
  });

  it.each([
    ['no PGHOST (pg would use localhost)', 'postgres:///kasuwa', {}],
    ['PGHOST=localhost', 'postgres:///kasuwa', { PGHOST: 'localhost' }],
    ['PGHOST remote', 'postgres:///kasuwa', { PGHOST: REMOTE }],
    ['userinfo and no host', 'postgres://kasuwa_migrator@/kasuwa', {}],
    ['an empty ?host=', 'postgres:///kasuwa?host=', {}],
  ] as const)(
    'refuses an unset NODE_ENV when the URL names no host (%s): not local',
    (_what, connectionString, env) => {
      const message = messageOf(() => assertMigrationTargetIsSafe(connectionString, env));
      expect(message).toContain('NODE_ENV');
      expectNoSecret(message);
    },
  );

  it('a hostless URL is still accepted when NODE_ENV says development or test', () => {
    expect(assertMigrationTargetIsSafe('postgres:///kasuwa', { NODE_ENV: 'development' })).toEqual({
      enforce: false,
      nodeEnv: 'development',
    });
  });

  it.each(['', 'staging', 'Production'])('refuses NODE_ENV=%j as invalid', (nodeEnv) => {
    const message = messageOf(() =>
      assertMigrationTargetIsSafe(url('kasuwa_migrator', SECRET), {
        ...PRODUCTION,
        NODE_ENV: nodeEnv,
      }),
    );
    expect(message).toContain('NODE_ENV');
    expectNoSecret(message);
  });

  it.each([
    ['in the URL', url('kasuwa_migrator', 'kasuwa_migrator_dev')],
    ['percent-encoded', url('kasuwa_migrator', 'kasuwa%5Fmigrator%5Fdev')],
    [
      'as a ?password= override',
      url('kasuwa_migrator', SECRET, REMOTE, '?password=kasuwa_app_dev'),
    ],
  ])('refuses a dev password %s in production', (_how, connectionString) => {
    const message = messageOf(() => assertMigrationTargetIsSafe(connectionString, PRODUCTION));
    expect(message).toMatch(/password/iu);
    expectNoSecret(message, ['kasuwa%5Fmigrator%5Fdev']);
  });

  it('refuses a dev password supplied through PGPASSWORD, naming the variable', () => {
    const message = messageOf(() =>
      assertMigrationTargetIsSafe('postgres://kasuwa_migrator@db.t0117-unit.invalid/kasuwa', {
        ...PRODUCTION,
        PGPASSWORD: 'kasuwa_migrator_dev',
      }),
    );
    expect(message).toContain('PGPASSWORD');
    expect(message).toMatch(/development passwords/u);
    expectNoSecret(message);
  });

  it.each(PG_STEERING)('refuses %s in production by name', (name) => {
    const message = messageOf(() =>
      assertMigrationTargetIsSafe(url('kasuwa_migrator', SECRET), { ...PRODUCTION, [name]: 'x' }),
    );
    expect(message).toContain(name);
    expectNoSecret(message);
  });

  it.each(SASLPREP_DISGUISES)('refuses a dev password disguised by %s', (_how, pw) => {
    const message = messageOf(() =>
      assertMigrationTargetIsSafe(url('kasuwa_migrator', encodeURIComponent(pw)), PRODUCTION),
    );
    expect(message).toMatch(/development passwords/u);
    expectNoSecret(message, [pw]);
  });

  it('refuses the superuser password in production', () => {
    const message = messageOf(() =>
      assertMigrationTargetIsSafe(url('postgres', 'postgres'), PRODUCTION),
    );
    expect(message).toMatch(/development passwords/u);
  });

  it('refuses a stub auth mode in production before anything else (migratorEnv)', () => {
    expect(() =>
      assertMigrationTargetIsSafe(url('kasuwa_migrator', SECRET), { NODE_ENV: 'production' }),
    ).toThrow(/KASUWA_AUTH_MODE=stub/u);
  });
});

describe('apiEnv and workerEnv refuse dev passwords and PG* outside development and test', () => {
  it('boot in production with secret passwords (control)', () => {
    expect(() => apiEnv(API_PRODUCTION)).not.toThrow();
    expect(() => workerEnv(WORKER_PRODUCTION)).not.toThrow();
  });

  it.each(DEV_DATABASE_PASSWORDS)('apiEnv refuses DATABASE_AUTH_URL carrying %s', (password) => {
    const message = messageOf(() =>
      apiEnv({ ...API_PRODUCTION, DATABASE_AUTH_URL: url('kasuwa_auth', password) }),
    );
    expect(message).toContain('DATABASE_AUTH_URL');
    expect(message).not.toContain('DATABASE_URL:');
    expectNoSecret(message);
  });

  it.each(DEV_DATABASE_PASSWORDS)('workerEnv refuses DATABASE_URL carrying %s', (password) => {
    const message = messageOf(() =>
      workerEnv({ ...WORKER_PRODUCTION, DATABASE_URL: url('kasuwa_app', password) }),
    );
    expect(message).toContain('DATABASE_URL');
    expectNoSecret(message);
  });

  it('workerEnv sees through ?password= and percent-encoding', () => {
    for (const databaseUrl of [
      url('kasuwa_app', SECRET, REMOTE, '?password=kasuwa_app_dev'),
      url('kasuwa_app', 'kasuwa%5Fapp%5Fdev'),
    ]) {
      const message = messageOf(() =>
        workerEnv({ ...WORKER_PRODUCTION, DATABASE_URL: databaseUrl }),
      );
      expect(message).toContain('DATABASE_URL');
      expectNoSecret(message, ['kasuwa%5Fapp%5Fdev']);
    }
  });

  it.each(PG_STEERING)('both refuse %s in production by name', (name) => {
    for (const call of [
      () => apiEnv({ ...API_PRODUCTION, [name]: SECRET }),
      () => workerEnv({ ...WORKER_PRODUCTION, [name]: SECRET }),
    ]) {
      const message = messageOf(call);
      expect(message).toContain(name);
      expectNoSecret(message);
    }
  });

  it.each(SASLPREP_DISGUISES)('apiEnv refuses a dev password disguised by %s', (_how, pw) => {
    const message = messageOf(() =>
      apiEnv({ ...API_PRODUCTION, DATABASE_URL: url('kasuwa_app', encodeURIComponent(pw)) }),
    );
    expect(message).toContain('DATABASE_URL');
    expectNoSecret(message, [pw, encodeURIComponent(pw)]);
  });

  it('both accept dev passwords and PG* in development and test (control)', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(() =>
        apiEnv({
          NODE_ENV: nodeEnv,
          PGHOST: 'localhost',
          DATABASE_URL: url('kasuwa_app', 'kasuwa_app_dev', 'localhost'),
          DATABASE_AUTH_URL: url('kasuwa_auth', 'kasuwa_auth_dev', 'localhost'),
        }),
      ).not.toThrow();
      expect(() =>
        workerEnv({
          NODE_ENV: nodeEnv,
          PGUSER: 'kasuwa_app',
          DATABASE_URL: url('kasuwa_app', 'kasuwa_app_dev', 'localhost'),
        }),
      ).not.toThrow();
    }
  });

  it('reads only the source it was given, never process.env', () => {
    vi.stubEnv('PGHOST', REMOTE);
    try {
      expect(() => workerEnv(WORKER_PRODUCTION)).not.toThrow();
      expect(() => apiEnv(API_PRODUCTION)).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
