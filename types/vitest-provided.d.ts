import 'vitest';

/**
 * Types for the values packages/testing/src/global-setup.ts hands to tests via
 * Vitest `provide`/`inject`.
 *
 * It lives at the repo root rather than inside packages/testing because module
 * augmentation only applies where the declaration is in the compilation, and
 * three separate projects consume these values.
 */
declare module 'vitest' {
  interface ProvidedContext {
    /** kasuwa_app connection string - NOBYPASSRLS. What the API uses. */
    databaseUrl: string;
    /**
     * kasuwa_auth connection string - NOBYPASSRLS, a member of no role. The
     * API's auth pool; the only writer of the auth tables (T-0049, D-P16).
     */
    authDatabaseUrl: string;
    /**
     * kasuwa_relay connection string - NOBYPASSRLS, a member of no role. The
     * outbox relay's pool (T-0098, ADR-0018).
     */
    relayDatabaseUrl: string;
    /** A real Redis (T-0098): the outbox suite runs the worker against it. */
    redisUrl: string;
    /** kasuwa_migrator connection string - owns the schema, BYPASSRLS. */
    migrationUrl: string;
    /** kasuwa_test_admin connection string - test setup and catalogue reads. */
    testAdminUrl: string;
  }
}
