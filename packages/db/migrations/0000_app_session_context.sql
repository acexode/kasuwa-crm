-- ---------------------------------------------------------------------------
-- 0000 — request session context used by every RLS policy in the system.
--
-- Every request opens a transaction and sets three GUCs via set_config(..., true)
-- (transaction-local). Policies read them ONLY through the accessor functions
-- below, never through current_setting() directly, so that the fail-closed
-- semantics live in exactly one place.
--
-- Fail-closed semantics:
--   * GUC unset          -> current_setting(..., true) returns NULL -> policy NULL -> row denied
--   * GUC set to ''      -> nullif() returns NULL                   -> row denied
--   * GUC set to garbage -> cast raises 22P02                       -> query errors (loud deny)
--
-- There is deliberately NO wildcard/"all programmes" value. See D-L06 in
-- team/DECISIONS.md: the session always carries an explicit enumerated list.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO kasuwa_app, kasuwa_test_admin;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Returns '{}' when unset, which makes `x = ANY(app.current_programme_ids())`
-- false rather than NULL. Either way the row is denied; '{}' is just clearer.
CREATE OR REPLACE FUNCTION app.current_programme_ids() RETURNS uuid[]
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT coalesce(nullif(current_setting('app.programme_ids', true), '')::uuid[], '{}'::uuid[])
$$;

GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO kasuwa_app, kasuwa_test_admin;
GRANT EXECUTE ON FUNCTION app.current_user_id() TO kasuwa_app, kasuwa_test_admin;
GRANT EXECUTE ON FUNCTION app.current_programme_ids() TO kasuwa_app, kasuwa_test_admin;
