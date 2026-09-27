import { describe, expect, it } from 'vitest';
import { assertAuthModeIsSafe, parseEnv } from './index';

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
