import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { createPool } from '@kasuwa/db';
import type { Pool } from 'pg';

/**
 * The auth module's own connection pool (T-0049, D-P16, ADR-0013).
 *
 * Built from DATABASE_AUTH_URL, which logs in as `kasuwa_auth`: NOBYPASSRLS, a
 * member of no role, and since migration 0024 the ONLY role that may INSERT,
 * UPDATE or DELETE `auth_session`, `auth_challenge`, `user_credential`,
 * `user_mfa_factor` and `user_mfa_backup_code`. Everything else in the API runs
 * as `kasuwa_app` on `PG_POOL`, so SQL injected anywhere outside this
 * directory reaches none of those writes: the refusal is a privilege, not a
 * convention.
 *
 * THE TOKEN STAYS IN THIS DIRECTORY. No file under apps/ outside
 * apps/api/src/auth/ may name `AUTH_PG_POOL` (the T-0049 suite checks it
 * statically). The module is deliberately NOT global and AppModule does not
 * re-export the token, so a feature module cannot inject the pool even by
 * accident; AppModule imports this class and hosts the auth providers that use
 * it.
 *
 * WHAT THE POOL KEEPS. Nothing here weakens the tenancy model: every query on
 * this pool goes through `withAuthTransaction` or `withTenantTransaction`
 * (@kasuwa/db), so it runs under tenant RLS, under the role-forgery check
 * (`current_user = session_user` at start and at commit), and returns its
 * connection through `releaseClean`. There is no bare `pool.query` on it.
 */
export const AUTH_PG_POOL = Symbol('AUTH_PG_POOL');

export interface AuthDatabaseOptions {
  authDatabaseUrl: string;
  /** Sized like the app pool; see `AppModuleOptions.poolMax`. */
  poolMax?: number;
  /** As the app pool: a starved pool answers 503, never hangs (T-0045). */
  connectionTimeoutMillis?: number;
}

@Module({})
export class AuthDatabaseModule implements OnApplicationShutdown {
  /** Injected, not static, for the reason `DatabaseModule` gives. */
  constructor(@Inject(AUTH_PG_POOL) private readonly pool: Pool) {}

  static forRoot(options: AuthDatabaseOptions): DynamicModule {
    const pool = createPool({
      connectionString: options.authDatabaseUrl,
      max: options.poolMax ?? 10,
      applicationName: 'kasuwa-api-auth',
      ...(options.connectionTimeoutMillis === undefined
        ? {}
        : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
    });

    return {
      module: AuthDatabaseModule,
      providers: [{ provide: AUTH_PG_POOL, useValue: pool }],
      exports: [AUTH_PG_POOL],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
