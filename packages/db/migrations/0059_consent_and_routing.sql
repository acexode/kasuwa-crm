-- 0059 consent_check (T-0189) + inbox_queue / canned_response (T-0190)
SET LOCAL lock_timeout = '5s';
CREATE TABLE consent_check (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  e164_hash text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('transactional','promotional')),
  outcome text NOT NULL CHECK (outcome IN ('allowed','dnd_refused','unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE inbox_queue (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE canned_response (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['consent_check','inbox_queue','canned_response'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kasuwa_app USING (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids())) WITH CHECK (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids()))', tbl||'_isolation', tbl);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO kasuwa_app', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO kasuwa_test_admin', tbl);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) EXECUTE FUNCTION app.touch_updated_at()', tbl||'_touch_updated_at', tbl);
  END LOOP;
END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p WHERE p.prosecdef AND p.pronamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)) <> 2 THEN RAISE EXCEPTION '0059 census'; END IF; END $$;
