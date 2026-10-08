import { describe, expect, it, vi } from 'vitest';
import {
  assertMigrationTargetIsSafe,
  DEV_DATABASE_PASSWORDS,
  effectiveDatabaseTarget,
  isLocalDatabaseHost,
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
      password: SECRET,
    });
  });

  it('lets ?host= and ?password= override the URL, as pg-connection-string does', () => {
    const target = effectiveDatabaseTarget(
      url('kasuwa_app', SECRET, 'localhost', `?host=${REMOTE}&password=kasuwa_app_dev`),
      'X',
      {},
    );
    expect(target).toEqual({ host: REMOTE, password: 'kasuwa_app_dev' });
  });

  it('percent-decodes the password', () => {
    expect(effectiveDatabaseTarget(url('kasuwa_app', 'kasuwa%5Fapp%5Fdev'), 'X', {}).password).toBe(
      'kasuwa_app_dev',
    );
  });

  it("falls back to PGHOST and PGPASSWORD, then pg's default host, when the URL is silent", () => {
    expect(effectiveDatabaseTarget('postgres:///kasuwa', 'X', { PGHOST: REMOTE })).toEqual({
      host: REMOTE,
      password: undefined,
    });
    expect(
      effectiveDatabaseTarget('postgres://kasuwa_app@/kasuwa', 'X', { PGPASSWORD: SECRET }),
    ).toEqual({ host: 'localhost', password: SECRET });
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

  it('reads NODE_ENV raw: PGHOST decides the host when the URL names none', () => {
    const message = messageOf(() =>
      assertMigrationTargetIsSafe('postgres:///kasuwa', { PGHOST: REMOTE }),
    );
    expect(message).toContain('NODE_ENV');
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

  it.each(['PGHOST', 'PGPASSWORD', 'PGUSER'])('refuses %s in production by name', (name) => {
    const message = messageOf(() =>
      assertMigrationTargetIsSafe(url('kasuwa_migrator', SECRET), { ...PRODUCTION, [name]: 'x' }),
    );
    expect(message).toContain(name);
    expectNoSecret(message);
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

  it.each(['PGHOST', 'PGPASSWORD', 'PGUSER'])('both refuse %s in production by name', (name) => {
    for (const call of [
      () => apiEnv({ ...API_PRODUCTION, [name]: SECRET }),
      () => workerEnv({ ...WORKER_PRODUCTION, [name]: SECRET }),
    ]) {
      const message = messageOf(call);
      expect(message).toContain(name);
      expectNoSecret(message);
    }
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
