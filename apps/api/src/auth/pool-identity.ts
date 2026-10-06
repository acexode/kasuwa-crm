import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { AUTH_PG_POOL } from './auth-database.module';

/**
 * The roles the two pools must log in as (T-0049).
 *
 * Fixed, not configurable, on purpose. Both misconfigurations the T-0049 suite
 * considered fail loudly at the first request anyway (both URLs on kasuwa_app:
 * every sign-in is 42501; both on kasuwa_auth: every business route is 42501),
 * but "loudly at the first request" is a production outage, and a URL pointing
 * at the migrator (BYPASSRLS) fails at no request at all. Checking at boot
 * turns all three into a process that never starts.
 */
export const EXPECTED_POOL_ROLES = Object.freeze({
  app: 'kasuwa_app',
  auth: 'kasuwa_auth',
});

export interface ObservedPoolRole {
  currentUser: string | null;
  sessionUser: string | null;
}

export class PoolIdentityError extends Error {
  constructor(problems: readonly string[]) {
    super(
      `Refusing to start: the database connections do not log in as the roles T-0049 ` +
        `requires.\n${problems.map((problem) => `  ${problem}`).join('\n')}\n` +
        'DATABASE_URL must log in as kasuwa_app and DATABASE_AUTH_URL as kasuwa_auth.',
    );
    this.name = 'PoolIdentityError';
  }
}

/**
 * The problems with what each pool logged in as, or none.
 *
 * Pure, so it is unit-tested without a database. Role names are not secrets
 * and name no tenant or person, so they may appear in the message; the
 * connection strings never do.
 */
export function poolIdentityProblems(observed: {
  app: ObservedPoolRole;
  auth: ObservedPoolRole;
}): string[] {
  const problems: string[] = [];
  for (const pool of ['app', 'auth'] as const) {
    const expected = EXPECTED_POOL_ROLES[pool];
    const { currentUser, sessionUser } = observed[pool];
    const variable = pool === 'app' ? 'DATABASE_URL' : 'DATABASE_AUTH_URL';
    if (currentUser !== expected || sessionUser !== expected) {
      problems.push(
        `${variable} logs in as ${String(sessionUser)} (current role ${String(currentUser)}); ` +
          `expected ${expected}.`,
      );
    }
  }
  return problems;
}

/** Throws `PoolIdentityError` unless both pools are the roles T-0049 requires. */
export function assertPoolIdentity(observed: {
  app: ObservedPoolRole;
  auth: ObservedPoolRole;
}): void {
  const problems = poolIdentityProblems(observed);
  if (problems.length > 0) {
    throw new PoolIdentityError(problems);
  }
}

const WHO_SQL = 'SELECT current_user::text AS cu, session_user::text AS su';

async function whoIs(pool: Pool): Promise<ObservedPoolRole> {
  // The one bare `pool.query` on the auth pool: it reads no table, sets no
  // context and leaves nothing on the connection.
  const result = await pool.query<{ cu: string; su: string }>(WHO_SQL);
  const row = result.rows[0];
  return { currentUser: row?.cu ?? null, sessionUser: row?.su ?? null };
}

/**
 * Runs at application bootstrap, before `listen`, so a misconfigured process
 * never accepts a request.
 *
 * It lives in the auth module because it is the only place allowed to name
 * `AUTH_PG_POOL`.
 */
@Injectable()
export class PoolIdentityCheck implements OnApplicationBootstrap {
  constructor(
    @Inject(PG_POOL) private readonly appPool: Pool,
    @Inject(AUTH_PG_POOL) private readonly authPool: Pool,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const [app, auth] = await Promise.all([whoIs(this.appPool), whoIs(this.authPool)]);
    assertPoolIdentity({ app, auth });
  }
}
