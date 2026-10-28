-- ---------------------------------------------------------------------------
-- 0050 - quote_send (T-0167, M05 P0): a programme-scoped record of a quote
-- delivered by email through the channel adapter. WhatsApp send is out of
-- scope until S3. Only a successful provider send commits a row (fail closed).
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

LOCK TABLE tenant, programme, quote, "user"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE quote_send (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  programme_id         uuid        NOT NULL,
  quote_id             uuid        NOT NULL,
  channel              text        NOT NULL,
  status               text        NOT NULL,
  to_masked            text        NOT NULL,
  provider_message_id  text,
  quote_version        integer     NOT NULL,
  sent_by_user_id      uuid        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quote_send_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT quote_send_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_send_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_send_quote_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, quote_id)
    REFERENCES quote (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_send_sent_by_same_tenant_fk
    FOREIGN KEY (tenant_id, sent_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Email only until inbox S3 lands WhatsApp quote delivery.
  CONSTRAINT quote_send_channel_check CHECK (channel = 'email'),
  CONSTRAINT quote_send_status_check CHECK (status IN ('sent')),
  CONSTRAINT quote_send_quote_version_check CHECK (quote_version >= 1),
  CONSTRAINT quote_send_to_masked_len_check
    CHECK (char_length(to_masked) BETWEEN 1 AND 120)
);

CREATE INDEX quote_send_quote_idx
  ON quote_send (tenant_id, programme_id, quote_id);

ALTER TABLE quote_send ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_send FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_send_isolation ON quote_send FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

REVOKE ALL ON quote_send
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT ON quote_send TO kasuwa_app;
-- No UPDATE/DELETE for kasuwa_app: a send record is append-only evidence.
GRANT SELECT, INSERT, UPDATE, DELETE ON quote_send TO kasuwa_test_admin;

CREATE TRIGGER quote_send_touch_updated_at
  BEFORE UPDATE ON quote_send FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  rel pg_catalog.oid := 'public.quote_send'::pg_catalog.regclass;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c WHERE c.oid = rel) THEN
    RAISE EXCEPTION '0050: quote_send RLS is not enabled and forced';
  END IF;
  IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = rel))
     <> 'kasuwa_migrator' THEN
    RAISE EXCEPTION '0050: quote_send is not owned by kasuwa_migrator';
  END IF;
  IF NOT (pg_catalog.has_table_privilege(app_role, rel, 'SELECT')
          AND pg_catalog.has_table_privilege(app_role, rel, 'INSERT')) THEN
    RAISE EXCEPTION '0050: kasuwa_app lacks SELECT or INSERT on quote_send';
  END IF;
  IF pg_catalog.has_table_privilege(app_role, rel, 'UPDATE')
     OR pg_catalog.has_table_privilege(app_role, rel, 'DELETE') THEN
    RAISE EXCEPTION '0050: kasuwa_app must not hold UPDATE or DELETE on quote_send';
  END IF;
  IF pg_catalog.has_column_privilege(app_role, rel, 'id', 'UPDATE')
     OR pg_catalog.has_column_privilege(app_role, rel, 'tenant_id', 'UPDATE')
     OR pg_catalog.has_column_privilege(app_role, rel, 'programme_id', 'UPDATE') THEN
    RAISE EXCEPTION '0050: kasuwa_app must not UPDATE id, tenant_id or programme_id of quote_send';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0050: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END
$$;
