import { describe, expect, it } from 'vitest';
import { assertAuthModeIsSafe, assertKeyProviderIsSafe, nodeEnv, parseEnv } from './index';

const BASE = {
  DATABASE_URL: 'postgres://kasuwa_app:pw@localhost:5432/kasuwa',
};

describe('environment validation', () => {
  it('parses a minimal valid environment', () => {
    const env = parseEnv({ ...BASE } as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.KASUWA_AUTH_MODE).toBe('stub');
  });

  it('refuses to start without a database url', () => {
    expect(() => parseEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it('coerces and bounds numeric settings', () => {
    const env = parseEnv({ ...BASE, API_PORT: '8080' } as NodeJS.ProcessEnv);
    expect(env.API_PORT).toBe(8080);
    expect(() => parseEnv({ ...BASE, DATABASE_POOL_MAX: '0' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('accepts a cell slug for telemetry and refuses free text (T-0005)', () => {
    const env = parseEnv({ ...BASE } as NodeJS.ProcessEnv);
    expect(env.KASUWA_CELL).toBe('local');
    expect(env.KASUWA_OTEL_EXPORTER).toBe('none');
    expect(parseEnv({ ...BASE, KASUWA_CELL: 'za-1' } as NodeJS.ProcessEnv).KASUWA_CELL).toBe(
      'za-1',
    );
    expect(() => parseEnv({ ...BASE, KASUWA_CELL: 'Adaeze Okonkwo' } as NodeJS.ProcessEnv)).toThrow(
      /KASUWA_CELL/,
    );
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

  it('refuses at parse time, so no process can start on it', () => {
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: 'production',
        // A real auth mode, so it is this guard that fires and not the one above.
        KASUWA_AUTH_MODE: 'jwt',
        KASUWA_TRUST_PROXY_HOPS: '1',
      } as NodeJS.ProcessEnv),
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
    expect(parseEnv({ ...BASE } as NodeJS.ProcessEnv).KASUWA_KMS_PROVIDER).toBe('local');
  });

  it('reads NODE_ENV alone, without demanding the rest of the environment', () => {
    // The development key provider's guard calls this; it must not require a
    // DATABASE_URL to be able to say "this is not production".
    expect(['development', 'test', 'production']).toContain(nodeEnv());
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

  it('refuses at parse time, so no process can start with it', () => {
    expect(() =>
      parseEnv({ ...BASE, NODE_ENV: 'production', KASUWA_AUTH_MODE: 'stub' } as NodeJS.ProcessEnv),
    ).toThrow(/Refusing to start/);
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
