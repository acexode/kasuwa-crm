-- 0056 message_template (T-0188)
SET LOCAL lock_timeout = '5s';
CREATE TABLE message_template (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms','whatsapp','email')),
  category text NOT NULL CHECK (category IN ('utility','marketing','authentication','service')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE message_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_template FORCE ROW LEVEL SECURITY;
CREATE POLICY message_template_isolation ON message_template FOR ALL TO kasuwa_app
  USING (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids()));
REVOKE ALL ON message_template FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT, UPDATE ON message_template TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON message_template TO kasuwa_test_admin;
CREATE TRIGGER message_template_touch_updated_at BEFORE UPDATE ON message_template FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) EXECUTE FUNCTION app.touch_updated_at();
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p WHERE p.prosecdef AND p.pronamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)) <> 2 THEN RAISE EXCEPTION '0056 census'; END IF; END $$;
