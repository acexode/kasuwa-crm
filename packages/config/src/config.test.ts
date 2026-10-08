import { describe, expect, it } from 'vitest';
import {
  apiEnv,
  assertAuthModeIsSafe,
  assertKeyProviderIsSafe,
  migratorEnv,
  nodeEnv,
  realtimeEnv,
  webEnv,
  workerEnv,
  type EnvSource,
} from './index';
import * as mainEntry from './index';
import * as webEntry from './web.mjs';
import { webBuildEnv } from './web.mjs';

// Invented values only. The marker lets a test prove a refusal never echoes it.
const MARKER = 'n0t-a-pw-unit-91x';
const DATABASE_URL = `postgres://kasuwa_app:${MARKER}@localhost:5432/kasuwa`;
const MIGRATION_URL = `postgres://kasuwa_migrator:${MARKER}@localhost:5432/kasuwa`;
const AUTH_URL = `postgres://kasuwa_auth:${MARKER}@localhost:5432/kasuwa`;

/** apiEnv and workerEnv refuse an unset NODE_ENV (D-L95), so fixtures name one. */
const DEV: EnvSource = { NODE_ENV: 'development' };
const API_BASE: EnvSource = { ...DEV, DATABASE_URL, DATABASE_AUTH_URL: AUTH_URL };

describe('api environment', () => {
  it('parses a minimal valid environment', () => {
    const env = apiEnv({ ...API_BASE });
    expect(env.NODE_ENV).toBe('development');
    expect(env.KASUWA_AUTH_MODE).toBe('stub');
  });

  it('refuses an unset NODE_ENV, naming it, rather than defaulting to development (D-L95)', () => {
    let message = '';
    try {
      apiEnv({ DATABASE_URL, DATABASE_AUTH_URL: AUTH_URL });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Invalid api environment:\n {2}NODE_ENV: must be set explicitly/u);
    expect(message).not.toContain(MARKER);
  });

  it('reports the other problems alongside an unset NODE_ENV', () => {
    expect(() => apiEnv({})).toThrow(/NODE_ENV: must be set[\s\S]*DATABASE_URL/u);
  });

  it('refuses to start without a database url', () => {
    expect(() => apiEnv({})).toThrow(/DATABASE_URL/);
  });

  it('coerces and bounds numeric settings', () => {
    expect(apiEnv({ ...API_BASE, API_PORT: '8080' }).API_PORT).toBe(8080);
    expect(() => apiEnv({ ...API_BASE, DATABASE_POOL_MAX: '0' })).toThrow();
  });

  it('accepts a cell slug for telemetry and refuses free text (T-0005)', () => {
    const env = apiEnv({ ...API_BASE });
    expect(env.KASUWA_CELL).toBe('local');
    expect(env.KASUWA_OTEL_EXPORTER).toBe('none');
    expect(apiEnv({ ...API_BASE, KASUWA_CELL: 'za-1' }).KASUWA_CELL).toBe('za-1');
    expect(() => apiEnv({ ...API_BASE, KASUWA_CELL: 'Adaeze Okonkwo' })).toThrow(/KASUWA_CELL/);
  });

  it('does not carry the migrator url, which no app process may hold', () => {
    const env: Record<string, unknown> = {
      ...apiEnv({ ...API_BASE, DATABASE_MIGRATION_URL: MIGRATION_URL }),
    };
    expect(env).not.toHaveProperty('DATABASE_MIGRATION_URL');
  });

  it('does not leak the database credential when it refuses one', () => {
    let message = '';
    try {
      apiEnv({ DATABASE_URL: `not a url ${MARKER}`, DATABASE_AUTH_URL: AUTH_URL });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain(MARKER);
  });

  describe('the auth connection (T-0049, D-P16)', () => {
    it('requires DATABASE_AUTH_URL and returns it', () => {
      expect(apiEnv({ ...API_BASE }).DATABASE_AUTH_URL).toBe(AUTH_URL);
      expect(() => apiEnv({ DATABASE_URL })).toThrow(/DATABASE_AUTH_URL/);
    });

    it('refuses a malformed one by name, without echoing it', () => {
      let message = '';
      try {
        apiEnv({ DATABASE_URL, DATABASE_AUTH_URL: `not a url ${MARKER}` });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/DATABASE_AUTH_URL/);
      expect(message).not.toContain(MARKER);
    });

    it('is carried by no other process schema', () => {
      const worker: Record<string, unknown> = {
        ...workerEnv({ ...DEV, DATABASE_URL, DATABASE_AUTH_URL: AUTH_URL }),
      };
      const realtime: Record<string, unknown> = {
        ...realtimeEnv({ DATABASE_AUTH_URL: AUTH_URL }),
      };
      const migrator: Record<string, unknown> = {
        ...migratorEnv({ DATABASE_AUTH_URL: AUTH_URL }),
      };
      expect(worker).not.toHaveProperty('DATABASE_AUTH_URL');
      expect(realtime).not.toHaveProperty('DATABASE_AUTH_URL');
      expect(migrator).not.toHaveProperty('DATABASE_AUTH_URL');
    });
  });
});

describe('per-process schemas parse only what their process needs', () => {
  it('realtime and migrator do not need a DATABASE_URL', () => {
    expect(() => realtimeEnv({})).not.toThrow();
    expect(() => migratorEnv({})).not.toThrow();
  });

  it('the worker needs DATABASE_URL (T-0045) and never keeps the migrator URL', () => {
    expect(() => workerEnv({ ...DEV })).toThrow(/DATABASE_URL/);
    const env: Record<string, unknown> = {
      ...workerEnv({ ...DEV, DATABASE_URL, DATABASE_MIGRATION_URL: MIGRATION_URL }),
    };
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
    expect(env).not.toHaveProperty('DATABASE_MIGRATION_URL');
  });

  it('the worker refuses an unset NODE_ENV, naming it (D-L95)', () => {
    expect(() => workerEnv({ DATABASE_URL })).toThrow(/NODE_ENV: must be set explicitly/u);
  });

  it('refuses a production worker on the local key provider', () => {
    const production = {
      DATABASE_URL,
      NODE_ENV: 'production',
      KASUWA_AUTH_MODE: 'jwt',
    } satisfies EnvSource;
    expect(() => workerEnv(production)).toThrow(/KASUWA_KMS_PROVIDER=local/);
    expect(() => workerEnv({ ...production, KASUWA_KMS_PROVIDER: 'aws-kms' })).not.toThrow();
  });

  it('reads each process its own settings', () => {
    expect(
      workerEnv({ ...DEV, DATABASE_URL, REDIS_URL: 'redis://cache.example:6379' }).REDIS_URL,
    ).toBe('redis://cache.example:6379');
    expect(realtimeEnv({ REALTIME_PORT: '4002' }).REALTIME_PORT).toBe(4002);
    expect(migratorEnv({ DATABASE_MIGRATION_URL: MIGRATION_URL }).DATABASE_MIGRATION_URL).toBe(
      MIGRATION_URL,
    );
  });

  it('judges the object it is given, not process.env', () => {
    // Nothing but the argument decides: an empty object parses to defaults.
    expect(webEnv({}).NEXT_PUBLIC_API_URL).toBe('http://127.0.0.1:3001');
    expect(() => apiEnv({})).toThrow(/DATABASE_URL/);
  });
});

describe('web environment', () => {
  it('parses with nothing set, using the harness defaults', () => {
    const env = webEnv({});
    expect(env.KASUWA_WEB_DIST_DIR).toBe('.next');
    expect(env.KASUWA_WEB_TSCONFIG).toBe('tsconfig.json');
  });

  it('refuses the database urls and server credentials by name, without echoing them', () => {
    for (const name of [
      'DATABASE_URL',
      'DATABASE_MIGRATION_URL',
      'DATABASE_AUTH_URL',
      'KASUWA_KMS_LOCAL_MASTER_KEY',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'REDIS_URL',
      'OPENSEARCH_URL',
    ]) {
      for (const parse of [webEnv, webBuildEnv]) {
        let message = '';
        try {
          parse({ [name]: DATABASE_URL });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, `${parse.name} accepted ${name}`).toMatch(new RegExp(`${name}:`));
        expect(message).not.toContain(MARKER);
      }
    }
  });

  it('refuses an EMPTY database url too: presence is the test, not validity', () => {
    expect(() => webEnv({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
    expect(() => webEnv({ DATABASE_AUTH_URL: '' })).toThrow(/DATABASE_AUTH_URL/);
    expect(() => webBuildEnv({ DATABASE_AUTH_URL: '' })).toThrow(/DATABASE_AUTH_URL/);
  });

  it('reports a forbidden name and a schema error together', () => {
    expect(() => webEnv({ DATABASE_URL, NEXT_PUBLIC_API_URL: 'not a url' })).toThrow(
      /DATABASE_URL[\s\S]*NEXT_PUBLIC_API_URL/,
    );
  });

  it('the build does not run the stub-auth guard; the server does', () => {
    const production: EnvSource = { NODE_ENV: 'production' };
    expect(() => webBuildEnv(production)).not.toThrow();
    expect(() => webEnv(production)).toThrow(/Refusing to start/);
    expect(() => webEnv({ ...production, KASUWA_AUTH_MODE: 'jwt' })).not.toThrow();
  });

  it('the web entry point exports the web schema and nothing that loads .env', () => {
    expect(Object.keys(webEntry).sort()).toEqual(['webBuildEnv', 'webEnv']);
  });

  it('keeps the guard-free build parse off the main entry', () => {
    expect(Object.keys(mainEntry)).not.toContain('webBuildEnv');
  });
});

describe('error messages never echo the input', () => {
  it('rewrites an enum issue from its options, without the received value', () => {
    let message = '';
    try {
      apiEnv({ ...API_BASE, KASUWA_AUTH_MODE: MARKER });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/KASUWA_AUTH_MODE: must be one of 'stub' \| 'jwt'/);
    expect(message).not.toContain(MARKER);
    expect(message).not.toMatch(/received/);
  });
});

describe('envelope-encryption key provider guard (D-L13)', () => {
  /**
   * The same shape as the stub-auth guard below and for the same reason: the
   * local provider keeps its master key in the application process, so running
   * it in production stores the lock next to the key. Two layers — this, and
   * the provider refusing to be constructed at all under NODE_ENV=production.
   */
  it('refuses the local key provider in production', () => {
    expect(() =>
      assertKeyProviderIsSafe({ NODE_ENV: 'production', KASUWA_KMS_PROVIDER: 'local' }),
    ).toThrow(/Refusing to start/);
  });

  it('refuses at parse time, so the API cannot start on it', () => {
    expect(() =>
      apiEnv({
        ...API_BASE,
        NODE_ENV: 'production',
        // A real auth mode, so it is this guard that fires and not the one below.
        KASUWA_AUTH_MODE: 'jwt',
        KASUWA_TRUST_PROXY_HOPS: '1',
      }),
    ).toThrow(/KASUWA_KMS_PROVIDER=local/);
  });

  it('allows the local provider outside production, which is where it belongs', () => {
    expect(() =>
      assertKeyProviderIsSafe({ NODE_ENV: 'development', KASUWA_KMS_PROVIDER: 'local' }),
    ).not.toThrow();
    expect(() =>
      assertKeyProviderIsSafe({ NODE_ENV: 'test', KASUWA_KMS_PROVIDER: 'local' }),
    ).not.toThrow();
  });

  it('allows a KMS provider in production', () => {
    expect(() =>
      assertKeyProviderIsSafe({ NODE_ENV: 'production', KASUWA_KMS_PROVIDER: 'aws-kms' }),
    ).not.toThrow();
  });

  it('defaults to the local provider, which is only reachable outside production', () => {
    expect(apiEnv({ ...API_BASE }).KASUWA_KMS_PROVIDER).toBe('local');
  });

  it('reads NODE_ENV alone, without demanding the rest of the environment', () => {
    // The development key provider's guard calls this; it must not require a
    // DATABASE_URL to be able to say "this is not production".
    expect(['development', 'test', 'production']).toContain(nodeEnv());
    expect(nodeEnv({})).toBe('development');
    expect(nodeEnv({ NODE_ENV: 'production' })).toBe('production');
    expect(() => nodeEnv({ NODE_ENV: 'prod' })).toThrow();
  });
});

describe('stub auth guard', () => {
  /**
   * The single most important assertion in this package. The stub resolver
   * trusts request headers for identity; shipping it to production would mean
   * anyone can claim to be any user in any tenant. See D-L05 and ADR-0007.
   */
  it('refuses stub auth in production', () => {
    expect(() =>
      assertAuthModeIsSafe({ NODE_ENV: 'production', KASUWA_AUTH_MODE: 'stub' }),
    ).toThrow(/Refusing to start/);
  });

  it('refuses at parse time in every process schema, explicit or defaulted', () => {
    const server: EnvSource = { ...API_BASE, NODE_ENV: 'production' };
    for (const parse of [apiEnv, workerEnv, realtimeEnv, migratorEnv, webEnv]) {
      const env = parse === webEnv ? { NODE_ENV: 'production' } : server;
      expect(() => parse({ ...env, KASUWA_AUTH_MODE: 'stub' }), parse.name).toThrow(
        /Refusing to start/,
      );
      expect(() => parse(env), `${parse.name} with the stub default`).toThrow(/Refusing to start/);
    }
  });

  it('allows stub auth outside production', () => {
    expect(() =>
      assertAuthModeIsSafe({ NODE_ENV: 'development', KASUWA_AUTH_MODE: 'stub' }),
    ).not.toThrow();
    expect(() =>
      assertAuthModeIsSafe({ NODE_ENV: 'test', KASUWA_AUTH_MODE: 'stub' }),
    ).not.toThrow();
  });

  it('allows a real auth mode in production', () => {
    expect(() =>
      assertAuthModeIsSafe({ NODE_ENV: 'production', KASUWA_AUTH_MODE: 'jwt' }),
    ).not.toThrow();
  });
});
