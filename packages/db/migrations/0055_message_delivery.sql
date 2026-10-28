-- 0055 - message_delivery (T-0187 inbox pipelines)
SET LOCAL lock_timeout = '5s';
LOCK TABLE tenant, programme, message IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE message_delivery (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  programme_id        uuid NOT NULL,
  message_id          uuid NOT NULL,
  provider_message_id text,
  state               text NOT NULL DEFAULT 'queued',
  attempt             integer NOT NULL DEFAULT 0,
  last_error_code     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_delivery_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT message_delivery_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE,
  CONSTRAINT message_delivery_programme_fk FOREIGN KEY (tenant_id, programme_id) REFERENCES programme (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT message_delivery_message_fk FOREIGN KEY (tenant_id, programme_id, message_id) REFERENCES message (tenant_id, programme_id, id) ON DELETE CASCADE,
  CONSTRAINT message_delivery_state_check CHECK (state IN ('queued', 'sent', 'delivered', 'failed', 'dead'))
);

ALTER TABLE message_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY message_delivery_isolation ON message_delivery FOR ALL TO kasuwa_app
  USING (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids()));
REVOKE ALL ON message_delivery FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT, UPDATE ON message_delivery TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON message_delivery TO kasuwa_test_admin;
CREATE TRIGGER message_delivery_touch_updated_at BEFORE UPDATE ON message_delivery FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) EXECUTE FUNCTION app.touch_updated_at();
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE p.prosecdef AND p.pronamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0055: SECURITY DEFINER census';
  END IF;
END $$;
