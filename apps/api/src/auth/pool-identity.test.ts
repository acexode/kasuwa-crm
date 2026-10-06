import { describe, expect, it } from 'vitest';
import {
  assertPoolIdentity,
  EXPECTED_POOL_ROLES,
  PoolIdentityError,
  poolIdentityProblems,
  type ObservedPoolRole,
} from './pool-identity';

/**
 * The boot-time role check (T-0049 review). Each misconfiguration below is one
 * a real deployment can make with two connection strings, and each must stop
 * the process before it listens.
 */

const as = (role: string | null): ObservedPoolRole => ({ currentUser: role, sessionUser: role });

describe('the boot-time pool identity check (T-0049)', () => {
  it('accepts kasuwa_app on the app pool and kasuwa_auth on the auth pool', () => {
    const observed = { app: as('kasuwa_app'), auth: as('kasuwa_auth') };
    expect(poolIdentityProblems(observed)).toEqual([]);
    expect(() => assertPoolIdentity(observed)).not.toThrow();
  });

  it('pins the roles, rather than taking them from configuration', () => {
    expect(EXPECTED_POOL_ROLES).toEqual({ app: 'kasuwa_app', auth: 'kasuwa_auth' });
    expect(Object.isFrozen(EXPECTED_POOL_ROLES)).toBe(true);
  });

  it.each([
    ['both URLs on kasuwa_app', 'kasuwa_app', 'kasuwa_app', ['DATABASE_AUTH_URL']],
    ['both URLs on kasuwa_auth', 'kasuwa_auth', 'kasuwa_auth', ['DATABASE_URL']],
    ['the URLs swapped', 'kasuwa_auth', 'kasuwa_app', ['DATABASE_URL', 'DATABASE_AUTH_URL']],
    ['the migrator (BYPASSRLS) as the auth pool', 'kasuwa_app', 'kasuwa_migrator', ['DATABASE_AUTH_URL']],
    ['the migrator as the app pool', 'kasuwa_migrator', 'kasuwa_auth', ['DATABASE_URL']],
    ['a superuser on both', 'postgres', 'postgres', ['DATABASE_URL', 'DATABASE_AUTH_URL']],
    ['no answer at all', null, null, ['DATABASE_URL', 'DATABASE_AUTH_URL']],
  ])('refuses %s, naming the variable to fix', (_label, app, auth, named) => {
    const problems = poolIdentityProblems({ app: as(app), auth: as(auth) });
    expect(problems.map((problem) => problem.split(' ')[0])).toEqual(named);
    expect(() => assertPoolIdentity({ app: as(app), auth: as(auth) })).toThrow(PoolIdentityError);
  });

  it('refuses a connection whose current role differs from its login role', () => {
    // A pool whose connections run `SET ROLE` on connect (an options string,
    // a pgbouncer setting) is not the role it logs in as.
    const problems = poolIdentityProblems({
      app: { currentUser: 'kasuwa_sweeper', sessionUser: 'kasuwa_app' },
      auth: as('kasuwa_auth'),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^DATABASE_URL /);
  });

  it('names roles and variables only, never a connection string', () => {
    let message = '';
    try {
      assertPoolIdentity({ app: as('kasuwa_auth'), auth: as('kasuwa_app') });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Refusing to start/);
    expect(message).not.toMatch(/postgres:\/\/|password|@/i);
  });
});
