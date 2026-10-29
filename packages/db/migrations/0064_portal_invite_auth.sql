-- 0064 - portal_invite accept on kasuwa_auth (T-0180, ADR-0021).

SET LOCAL lock_timeout = '5s';

GRANT SELECT, UPDATE ON portal_invite TO kasuwa_auth;

CREATE POLICY portal_invite_auth_read ON portal_invite FOR SELECT TO kasuwa_auth
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY portal_invite_auth_update ON portal_invite FOR UPDATE TO kasuwa_auth
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT INSERT ON portal_identity TO kasuwa_auth;
GRANT UPDATE (status, display_name, email_masked) ON portal_identity TO kasuwa_auth;

CREATE POLICY portal_identity_auth_insert ON portal_identity FOR INSERT TO kasuwa_auth
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY portal_identity_auth_update ON portal_identity FOR UPDATE TO kasuwa_auth
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT INSERT ON portal_programme TO kasuwa_auth;

CREATE POLICY portal_programme_auth_insert ON portal_programme FOR INSERT TO kasuwa_auth
  WITH CHECK (tenant_id = app.current_tenant_id());

DO $$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0064: there must be exactly two SECURITY DEFINER functions';
  END IF;

  IF NOT pg_catalog.has_table_privilege('kasuwa_auth', 'portal_invite', 'SELECT')
     OR NOT pg_catalog.has_table_privilege('kasuwa_auth', 'portal_invite', 'UPDATE') THEN
    RAISE EXCEPTION 'kasuwa_auth must read and burn portal_invite (0064).';
  END IF;

  IF NOT pg_catalog.has_table_privilege('kasuwa_auth', 'portal_identity', 'INSERT')
     OR NOT pg_catalog.has_table_privilege('kasuwa_auth', 'portal_programme', 'INSERT') THEN
    RAISE EXCEPTION 'kasuwa_auth must link portal identities on accept (0064).';
  END IF;
END $$;
