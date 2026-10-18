-- ---------------------------------------------------------------------------
-- Kasuwa database bootstrap: roles and grants.
--
-- WHICH FILE RUNS WHERE (T-0117, D-L92, D-L94):
--   bootstrap.sql       - THIS FILE. Applied by real provisioning, by
--                         docker-compose's postgres init directory and by
--                         packages/testing's Testcontainers harness, before
--                         any migration. Real provisioning applies this file
--                         and nothing else.
--   bootstrap-test.sql  - development and test ONLY: docker-compose's init
--                         directory (after this file) and packages/testing.
--                         It turns kasuwa_test_admin into the harness's
--                         BYPASSRLS login. Never apply it to a real cell; the
--                         migration runner and the API and worker boot refuse
--                         a database where it has been.
--
-- Run as the superuser. Idempotent: an existing role is left alone, so a
-- role created first by provisioning keeps its secrets-manager password.
--
-- The four passwords below are DEVELOPMENT ONLY, and outside development
-- and test the migration runner, the API and the worker refuse a connection
-- that would use one (D-L94). Real environments create kasuwa_migrator,
-- kasuwa_app, kasuwa_auth and kasuwa_relay with secrets-manager passwords
-- BEFORE applying
-- this file; see team/DECISIONS.md D-L07 and
-- docs/adr/0002-pooled-tenancy-via-rls.md.
--
-- Role model:
--   kasuwa_app        - used by apps/api, apps/worker, apps/realtime.
--                       NOBYPASSRLS, no DDL. This is the only role that ever
--                       serves a user request.
--   kasuwa_migrator   - owns the schema, runs DDL and the seed. BYPASSRLS so
--                       the seed can write across tenants. Never serves traffic.
--   kasuwa_test_admin - here, an INERT PLACEHOLDER: NOLOGIN, NOBYPASSRLS,
--                       NOINHERIT, no password, a member of nothing and with
--                       no members, and named in no grant or default
--                       privilege in this file. It exists only because
--                       applied migrations GRANT to it by name (D-L94); what
--                       they grant, nobody can use. bootstrap-test.sql makes
--                       it the harness's login (truncation between tests and
--                       catalogue assertions) and gives it its grants.
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
--   kasuwa_relay      - used only by apps/worker's outbox relay, through its
--                       own pool (DATABASE_RELAY_URL; ADR-0018, T-0098).
--                       NOBYPASSRLS. A member of no role, and no role is a
--                       member of it (never granted to kasuwa_app). It holds
--                       SELECT, DELETE and UPDATE on four publication columns
--                       of outbox_event, granted in migration 0041, and
--                       nothing else; its policies there admit only rows not
--                       yet dispatched or already past retention. No default
--                       privilege ever names it.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_migrator') THEN
    CREATE ROLE kasuwa_migrator LOGIN PASSWORD 'kasuwa_migrator_dev' BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_app') THEN
    CREATE ROLE kasuwa_app LOGIN PASSWORD 'kasuwa_app_dev' NOBYPASSRLS;
  END IF;
  -- The inert placeholder (D-L94). If the role already exists (an older dev
  -- volume, or a harness that has applied bootstrap-test.sql) it is left
  -- alone: re-asserting it here would break the harness login on every
  -- `pnpm dev`. Outside development and test the runner and the boot check
  -- refuse it unless it is inert.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_test_admin') THEN
    CREATE ROLE kasuwa_test_admin NOLOGIN NOBYPASSRLS NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_sweeper') THEN
    CREATE ROLE kasuwa_sweeper NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_auth') THEN
    CREATE ROLE kasuwa_auth LOGIN PASSWORD 'kasuwa_auth_dev' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_relay') THEN
    CREATE ROLE kasuwa_relay LOGIN PASSWORD 'kasuwa_relay_dev' NOBYPASSRLS;
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

-- The relay is bounded by its own policies on outbox_event and by grants that
-- name that one table (ADR-0018, T-0098). No membership in either direction:
-- unlike the sweeper it is never granted to kasuwa_app, so no SET ROLE on an
-- app connection reaches it. No default privilege below names it, and nothing
-- here gives it USAGE on schema app. Migration 0041 asserts all of this.
-- CONNECTION LIMIT 4 (D-L161): the worker's pool is 2, so two instances
-- overlapping in a deploy fit, and a leaked or abused credential cannot take
-- the cell's connection slots.
ALTER ROLE kasuwa_relay LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  CONNECTION LIMIT 4;

REVOKE ALL ON DATABASE kasuwa FROM PUBLIC;

GRANT CONNECT ON DATABASE kasuwa TO kasuwa_app, kasuwa_migrator, kasuwa_auth, kasuwa_relay;
GRANT CREATE ON DATABASE kasuwa TO kasuwa_migrator;

-- Postgres 15+ no longer grants CREATE on public to PUBLIC.
GRANT USAGE, CREATE ON SCHEMA public TO kasuwa_migrator;
GRANT USAGE ON SCHEMA public TO kasuwa_app, kasuwa_sweeper, kasuwa_auth, kasuwa_relay;

-- Everything the migrator creates is readable/writable by the app role, but the
-- app role never owns anything and therefore can never ALTER ... DISABLE RLS.
-- kasuwa_test_admin's matching default privileges are in bootstrap-test.sql.
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kasuwa_app;
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kasuwa_app;
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO kasuwa_app;
