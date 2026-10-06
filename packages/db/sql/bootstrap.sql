-- ---------------------------------------------------------------------------
-- Kasuwa database bootstrap: roles and grants.
--
-- Applied by (a) docker-compose's postgres init directory for local dev and
-- (b) packages/testing's Testcontainers harness. Keep it idempotent.
--
-- The passwords below are DEVELOPMENT ONLY. Real environments inject role
-- passwords from the cloud secrets manager; see team/DECISIONS.md D-L07 and
-- docs/adr/0002-pooled-tenancy-via-rls.md.
--
-- Role model:
--   kasuwa_app        - used by apps/api, apps/worker, apps/realtime.
--                       NOBYPASSRLS, no DDL. This is the only role that ever
--                       serves a user request.
--   kasuwa_migrator   - owns the schema, runs DDL and the seed. BYPASSRLS so
--                       the seed can write across tenants. Never serves traffic.
--   kasuwa_test_admin - Testcontainers only: truncation between tests and
--                       catalogue assertions.
--   kasuwa_sweeper    - NOLOGIN, NOBYPASSRLS. Entered only by SET LOCAL ROLE
--                       from a kasuwa_app transaction, to prune auth rows past
--                       retention (D-L66, ADR-0012). Its only policies admit
--                       rows already dead; SELECT and DELETE on three tables.
--   kasuwa_auth       - used only by the API's auth module, through its own
--                       pool (D-P16, ADR-0013). NOBYPASSRLS. The only role
--                       that may write the auth tables. A member of no role,
--                       and no role is a member of it, so kasuwa_app can never
--                       SET ROLE to it. Its table grants are explicit, in
--                       migrations: no default privilege ever names it.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_migrator') THEN
    CREATE ROLE kasuwa_migrator LOGIN PASSWORD 'kasuwa_migrator_dev' BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_app') THEN
    CREATE ROLE kasuwa_app LOGIN PASSWORD 'kasuwa_app_dev' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_test_admin') THEN
    CREATE ROLE kasuwa_test_admin LOGIN PASSWORD 'kasuwa_test_admin_dev' BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_sweeper') THEN
    CREATE ROLE kasuwa_sweeper NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_auth') THEN
    CREATE ROLE kasuwa_auth LOGIN PASSWORD 'kasuwa_auth_dev' NOBYPASSRLS;
  END IF;
END
$$;

-- Belt and braces: assert the security property this whole model rests on.
-- If someone "helpfully" grants BYPASSRLS to the application role, fail loudly
-- at bootstrap rather than silently at runtime.
ALTER ROLE kasuwa_app NOBYPASSRLS;
ALTER ROLE kasuwa_app NOCREATEDB NOCREATEROLE NOSUPERUSER;

-- The sweeper is bounded only by its policies; it must never bypass them.
ALTER ROLE kasuwa_sweeper NOLOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- INHERIT FALSE is load-bearing: with inheritance the sweeper's dead-row
-- policies would apply to every kasuwa_app session. SET TRUE lets the prune
-- enter it with SET LOCAL ROLE. PostgreSQL 16 syntax; migration 0020 asserts it.
GRANT kasuwa_sweeper TO kasuwa_app WITH INHERIT FALSE, SET TRUE;

-- The auth role is bounded by tenant RLS and by grants that name each table.
-- No membership in either direction: the T-0049 suite asserts both.
ALTER ROLE kasuwa_auth LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

REVOKE ALL ON DATABASE kasuwa FROM PUBLIC;

GRANT CONNECT ON DATABASE kasuwa TO kasuwa_app, kasuwa_migrator, kasuwa_test_admin, kasuwa_auth;
GRANT CREATE ON DATABASE kasuwa TO kasuwa_migrator;

-- Postgres 15+ no longer grants CREATE on public to PUBLIC.
GRANT USAGE, CREATE ON SCHEMA public TO kasuwa_migrator;
GRANT USAGE ON SCHEMA public TO kasuwa_app, kasuwa_test_admin, kasuwa_sweeper, kasuwa_auth;

-- Everything the migrator creates is readable/writable by the app role, but the
-- app role never owns anything and therefore can never ALTER ... DISABLE RLS.
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kasuwa_app, kasuwa_test_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kasuwa_app, kasuwa_test_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO kasuwa_app, kasuwa_test_admin;
