-- 0068 - portal_session presented-token policy must not apply to kasuwa_app.
--
-- 0061 created portal_session_presented_token FOR SELECT (PUBLIC) while also
-- revoking kasuwa_app SELECT on token_hash. Postgres evaluates RLS policy
-- expressions with the privileges of the invoking role (ddl-rowsecurity), so
-- every kasuwa_app SELECT on portal_session failed with 42501 once that policy
-- was attached — including the live-session re-read under isolation.
--
-- Resolve runs on kasuwa_auth (ADR-0021: "auth (or app) repository"); that role
-- retains token_hash SELECT (0061). Restrict the presented-token policy to it.
-- kasuwa_app keeps portal_session_isolation for in-session work only.

SET LOCAL lock_timeout = '5s';

LOCK TABLE portal_session IN SHARE ROW EXCLUSIVE MODE;

DROP POLICY IF EXISTS portal_session_presented_token ON portal_session;

CREATE POLICY portal_session_presented_token ON portal_session FOR SELECT
  TO kasuwa_auth
  USING (token_hash = app.current_portal_session_token());

DO $$
DECLARE
  auth_role constant pg_catalog.oid := 'kasuwa_auth'::pg_catalog.regrole;
  app_role  constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  roles     pg_catalog.oid[];
BEGIN
  SELECT p.polroles INTO roles
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'portal_session'
     AND p.polname = 'portal_session_presented_token';

  IF roles IS NULL THEN
    RAISE EXCEPTION '0068: portal_session_presented_token policy missing';
  END IF;

  -- PUBLIC is recorded as oid 0 in polroles.
  IF 0 = ANY (roles) OR app_role = ANY (roles) THEN
    RAISE EXCEPTION '0068: portal_session_presented_token must not apply to PUBLIC or kasuwa_app';
  END IF;

  IF roles IS DISTINCT FROM ARRAY[auth_role] THEN
    RAISE EXCEPTION '0068: portal_session_presented_token must apply only to kasuwa_auth';
  END IF;

  IF pg_catalog.has_column_privilege(app_role, 'portal_session', 'token_hash', 'SELECT') THEN
    RAISE EXCEPTION '0068: kasuwa_app must still not read portal_session.token_hash';
  END IF;

  IF NOT pg_catalog.has_column_privilege(auth_role, 'portal_session', 'token_hash', 'SELECT') THEN
    RAISE EXCEPTION '0068: kasuwa_auth must read portal_session.token_hash for presented-token resolve';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0068: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END $$;
