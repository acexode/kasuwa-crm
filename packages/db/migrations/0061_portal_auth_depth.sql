-- 0061 - portal sign-in depth: credential column, kasuwa_auth grants, presented-token
--        session resolve (T-0179, ADR-0021 / D-L212). D-A3: grant changes -> @acexode.
--
-- Extends T-0049 I2 and T-0157-style secret reads for portal_identity.password_hash.
-- No third SECURITY DEFINER function.

SET LOCAL lock_timeout = '2s';

ALTER TABLE portal_identity
  ADD COLUMN password_hash text;

COMMENT ON COLUMN portal_identity.password_hash IS
  'Argon2id hash; readable only on kasuwa_auth (T-0179). NULL until the identity sets a password.';

-- Case-insensitive uniqueness (ADR-0021): replace the raw-email unique constraint.
ALTER TABLE portal_identity DROP CONSTRAINT portal_identity_tenant_email_key;
CREATE UNIQUE INDEX portal_identity_tenant_email_lower_key
  ON portal_identity (tenant_id, lower(email));

-- --- presented-token session resolve (ADR-0021 decision 4) -------------------
CREATE OR REPLACE FUNCTION app.current_portal_session_token() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('app.portal_session_token', true), '')
$$;

GRANT EXECUTE ON FUNCTION app.current_portal_session_token()
  TO kasuwa_app, kasuwa_auth, kasuwa_test_admin, kasuwa_sweeper;

COMMENT ON FUNCTION app.current_portal_session_token() IS
  'SHA-256 hex digest of the portal session token the current statement presents. NULL when unset.';

CREATE POLICY portal_session_presented_token ON portal_session FOR SELECT
  USING (token_hash = app.current_portal_session_token());

-- --- kasuwa_app loses portal credential/session writes and secret reads ------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON portal_identity, portal_session
  FROM kasuwa_app, PUBLIC;

REVOKE SELECT ON portal_identity FROM kasuwa_app, PUBLIC;
GRANT SELECT (id, tenant_id, programme_id, email, email_masked, display_name, status,
              created_at, updated_at)
  ON portal_identity TO kasuwa_app;

REVOKE SELECT ON portal_session FROM kasuwa_app, PUBLIC;
GRANT SELECT (id, tenant_id, programme_id, portal_identity_id, expires_at, revoked_at,
              created_at, updated_at)
  ON portal_session TO kasuwa_app;

-- --- kasuwa_auth: portal identity tables (extends T-0049 I2) -----------------
GRANT SELECT, DELETE ON portal_session TO kasuwa_auth;
GRANT INSERT ON portal_session TO kasuwa_auth;
GRANT UPDATE (revoked_at) ON portal_session TO kasuwa_auth;

GRANT SELECT ON portal_identity TO kasuwa_auth;
GRANT UPDATE (password_hash) ON portal_identity TO kasuwa_auth;

GRANT SELECT ON portal_programme TO kasuwa_auth;

-- --- assertions --------------------------------------------------------------
DO $$
DECLARE
  secret RECORD;
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0061: there must be exactly two SECURITY DEFINER functions';
  END IF;

  IF pg_catalog.has_table_privilege('kasuwa_app', 'portal_identity', 'SELECT')
     OR pg_catalog.has_column_privilege('kasuwa_app', 'portal_identity', 'password_hash', 'SELECT') THEN
    RAISE EXCEPTION 'kasuwa_app must not read portal_identity.password_hash (0061).';
  END IF;

  IF pg_catalog.has_column_privilege('kasuwa_app', 'portal_session', 'token_hash', 'SELECT') THEN
    RAISE EXCEPTION 'kasuwa_app must not read portal_session.token_hash (0061).';
  END IF;

  IF NOT pg_catalog.has_column_privilege('kasuwa_auth', 'portal_identity', 'password_hash', 'SELECT')
     OR NOT pg_catalog.has_column_privilege('kasuwa_auth', 'portal_session', 'token_hash', 'SELECT') THEN
    RAISE EXCEPTION 'kasuwa_auth must read portal secrets for sign-in (0061).';
  END IF;

  IF NOT pg_catalog.has_table_privilege('kasuwa_auth', 'portal_session', 'INSERT') THEN
    RAISE EXCEPTION 'kasuwa_auth must INSERT portal_session (0061).';
  END IF;

  FOR secret IN
    SELECT 'portal_identity' AS tbl, 'password_hash' AS col
  LOOP
    IF pg_catalog.has_column_privilege('kasuwa_app', secret.tbl, secret.col, 'SELECT') THEN
      RAISE EXCEPTION 'kasuwa_app still reads %.%', secret.tbl, secret.col;
    END IF;
  END LOOP;
END $$;
