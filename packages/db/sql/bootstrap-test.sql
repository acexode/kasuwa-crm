-- ---------------------------------------------------------------------------
-- Kasuwa TEST bootstrap: makes kasuwa_test_admin the harness's login.
--
-- DEVELOPMENT AND TEST ONLY (T-0117, D-L92, D-L94). Applied, as the
-- superuser, AFTER bootstrap.sql and BEFORE any migration, by exactly:
--   - docker-compose's postgres init directory (20-bootstrap-test.sql, after
--     10-bootstrap.sql), and `pnpm dev` re-applies it with bootstrap.sql;
--   - packages/testing's Testcontainers harness (startTestStack).
-- Real provisioning NEVER applies it. A real cell has kasuwa_test_admin only
-- as the inert placeholder bootstrap.sql creates, and the migration runner and
-- the API and worker boot refuse, outside development and test, a database
-- where this file has been applied.
--
-- What the harness needs from the role: truncation and fixture writes across
-- tenants between tests, and catalogue reads. Hence BYPASSRLS, CONNECT, USAGE
-- on public, and the same default privileges kasuwa_app has on everything the
-- migrator creates. The migrations grant it the rest by name (schema app, the
-- app.* functions, and the tables that revoke defaults).
--
-- No other power: never SUPERUSER, CREATEROLE, CREATEDB or REPLICATION, and a
-- member of no role, with no members, exactly as the placeholder is.
--
-- Idempotent, and it changes nothing when re-applied. Unlike bootstrap.sql it
-- DOES re-assert the role, because what it asserts is the harness's login.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- Normally bootstrap.sql has created the placeholder already; create it here
  -- too so that the order of the two files cannot leave the harness without it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasuwa_test_admin') THEN
    CREATE ROLE kasuwa_test_admin NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

ALTER ROLE kasuwa_test_admin LOGIN BYPASSRLS PASSWORD 'kasuwa_test_admin_dev'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT CONNECT ON DATABASE kasuwa TO kasuwa_test_admin;
GRANT USAGE ON SCHEMA public TO kasuwa_test_admin;

ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kasuwa_test_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kasuwa_test_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO kasuwa_test_admin;
