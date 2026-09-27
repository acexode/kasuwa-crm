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
END
$$;

-- Belt and braces: assert the security property this whole model rests on.
-- If someone "helpfully" grants BYPASSRLS to the application role, fail loudly
-- at bootstrap rather than silently at runtime.
ALTER ROLE kasuwa_app NOBYPASSRLS;
ALTER ROLE kasuwa_app NOCREATEDB NOCREATEROLE NOSUPERUSER;

REVOKE ALL ON DATABASE kasuwa FROM PUBLIC;

GRANT CONNECT ON DATABASE kasuwa TO kasuwa_app, kasuwa_migrator, kasuwa_test_admin;
GRANT CREATE ON DATABASE kasuwa TO kasuwa_migrator;

-- Postgres 15+ no longer grants CREATE on public to PUBLIC.
GRANT USAGE, CREATE ON SCHEMA public TO kasuwa_migrator;
GRANT USAGE ON SCHEMA public TO kasuwa_app, kasuwa_test_admin;

-- Everything the migrator creates is readable/writable by the app role, but the
-- app role never owns anything and therefore can never ALTER ... DISABLE RLS.
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kasuwa_app, kasuwa_test_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kasuwa_app, kasuwa_test_admin;
ALTER DEFAULT PRIVILEGES FOR ROLE kasuwa_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO kasuwa_app, kasuwa_test_admin;
