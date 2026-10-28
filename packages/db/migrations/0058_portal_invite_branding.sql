-- 0058 portal_invite (T-0180) + portal_branding (T-0182)
SET LOCAL lock_timeout = '5s';
CREATE TABLE portal_invite (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  email text NOT NULL,
  email_masked text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  invited_by_user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  UNIQUE (token_hash),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invited_by_user_id) REFERENCES "user"(tenant_id, id) ON DELETE RESTRICT
);
CREATE TABLE portal_branding (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  display_name text NOT NULL DEFAULT '',
  logo_object_id uuid,
  primary_token text NOT NULL DEFAULT 'brand.primary',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  UNIQUE (tenant_id, programme_id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['portal_invite','portal_branding'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kasuwa_app USING (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids())) WITH CHECK (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids()))', tbl||'_isolation', tbl);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO kasuwa_app', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO kasuwa_test_admin', tbl);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) EXECUTE FUNCTION app.touch_updated_at()', tbl||'_touch_updated_at', tbl);
  END LOOP;
END $$;
-- kasuwa_auth grants for portal_invite land with T-0180 (extend T-0049 I2).
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p WHERE p.prosecdef AND p.pronamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)) <> 2 THEN RAISE EXCEPTION '0058 census'; END IF; END $$;
