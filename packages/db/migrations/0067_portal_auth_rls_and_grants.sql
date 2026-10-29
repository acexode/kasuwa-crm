-- 0067 - kasuwa_auth RLS on portal sign-in tables (T-0179); tax_line DELETE for
-- replaceTaxLines (T-0172); message UPDATE columns for inbox sends (T-0185/188).

SET LOCAL lock_timeout = '5s';

LOCK TABLE portal_identity, portal_session, portal_programme, tax_line, message
  IN SHARE ROW EXCLUSIVE MODE;

-- kasuwa_auth holds grants from 0061/0064 but had no SELECT policies on
-- portal_identity / portal_session under FORCE RLS — sign-in and MFA could not
-- read credentials or issue sessions.
CREATE POLICY portal_identity_auth_select ON portal_identity FOR SELECT TO kasuwa_auth
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY portal_session_auth_all ON portal_session FOR ALL TO kasuwa_auth
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY portal_programme_auth_select ON portal_programme FOR SELECT TO kasuwa_auth
  USING (tenant_id = app.current_tenant_id());

GRANT DELETE ON tax_line TO kasuwa_app;

GRANT UPDATE (direction, body_redacted, provider_message_id, sent_by_user_id, created_at, updated_at)
  ON message TO kasuwa_app;

DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  auth_role constant pg_catalog.oid := 'kasuwa_auth'::pg_catalog.regrole;
BEGIN
  IF NOT pg_catalog.has_table_privilege(app_role, 'tax_line', 'DELETE') THEN
    RAISE EXCEPTION '0067: kasuwa_app must DELETE tax_line for replaceTaxLines (T-0172).';
  END IF;

  IF NOT pg_catalog.has_column_privilege(app_role, 'public.message'::pg_catalog.regclass, 'created_at', 'UPDATE') THEN
    RAISE EXCEPTION '0067: kasuwa_app must UPDATE message.created_at (T-0185 fixtures).';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'portal_identity'
       AND policyname = 'portal_identity_auth_select'
  ) THEN
    RAISE EXCEPTION '0067: portal_identity_auth_select policy missing.';
  END IF;

  IF NOT pg_catalog.has_table_privilege(auth_role, 'portal_session', 'INSERT') THEN
    RAISE EXCEPTION '0067: kasuwa_auth must INSERT portal_session (0061).';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0067: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END $$;
