-- ---------------------------------------------------------------------------
-- 0051 - payment_link / payment_event (T-0169, M05 P0): programme-scoped
-- payment links via payments-adapter. Refunds/partials are out of scope
-- (D-L212 provisional B3): status is pending | paid | expired | cancelled.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

LOCK TABLE tenant, programme, quote, "user"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE payment_link (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  programme_id        uuid        NOT NULL,
  quote_id            uuid        NOT NULL,
  provider            text        NOT NULL,
  provider_link_id    text        NOT NULL,
  url                 text        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending',
  amount_minor        bigint      NOT NULL,
  currency            text        NOT NULL,
  reference           text        NOT NULL,
  idempotency_key     text        NOT NULL,
  expires_at          timestamptz,
  created_by_user_id  uuid        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_link_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT payment_link_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_link_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_link_quote_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, quote_id)
    REFERENCES quote (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_link_created_by_same_tenant_fk
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT payment_link_provider_check CHECK (provider IN ('paystack', 'flutterwave', 'fake')),
  CONSTRAINT payment_link_status_check CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  CONSTRAINT payment_link_currency_check CHECK (currency IN ('NGN', 'GHS', 'KES', 'ZAR')),
  CONSTRAINT payment_link_amount_minor_check CHECK (amount_minor > 0 AND amount_minor < 1000000000000000000),
  CONSTRAINT payment_link_reference_len_check CHECK (char_length(reference) BETWEEN 1 AND 128),
  CONSTRAINT payment_link_idempotency_len_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  CONSTRAINT payment_link_url_len_check CHECK (char_length(url) BETWEEN 1 AND 2048),
  CONSTRAINT payment_link_provider_link_id_len_check CHECK (char_length(provider_link_id) BETWEEN 1 AND 256)
);

CREATE UNIQUE INDEX payment_link_idempotency_key
  ON payment_link (tenant_id, programme_id, idempotency_key);

CREATE UNIQUE INDEX payment_link_provider_link_key
  ON payment_link (tenant_id, provider, provider_link_id);

CREATE INDEX payment_link_quote_idx
  ON payment_link (tenant_id, programme_id, quote_id);

CREATE TABLE payment_event (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  programme_id        uuid        NOT NULL,
  payment_link_id     uuid        NOT NULL,
  provider_event_id   text        NOT NULL,
  event_type          text        NOT NULL,
  payment_method_token text,
  payment_method_last_four text,
  occurred_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_event_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT payment_event_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_event_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_event_link_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, payment_link_id)
    REFERENCES payment_link (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_event_type_check CHECK (event_type IN (
    'payment.paid', 'payment.expired', 'payment.failed'
  )),
  CONSTRAINT payment_event_last_four_check
    CHECK (payment_method_last_four IS NULL OR payment_method_last_four ~ '^\d{4}$'),
  CONSTRAINT payment_event_provider_event_id_len_check
    CHECK (char_length(provider_event_id) BETWEEN 1 AND 256)
);

CREATE UNIQUE INDEX payment_event_provider_event_key
  ON payment_event (tenant_id, provider_event_id);

CREATE INDEX payment_event_link_idx
  ON payment_event (tenant_id, programme_id, payment_link_id);

ALTER TABLE payment_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_link FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_link_isolation ON payment_link FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

ALTER TABLE payment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_event FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_event_isolation ON payment_event FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

REVOKE ALL ON payment_link, payment_event
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT ON payment_link TO kasuwa_app;
GRANT UPDATE (status, updated_at) ON payment_link TO kasuwa_app;
GRANT SELECT, INSERT ON payment_event TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_link, payment_event TO kasuwa_test_admin;

CREATE TRIGGER payment_link_touch_updated_at
  BEFORE UPDATE ON payment_link FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER payment_event_touch_updated_at
  BEFORE UPDATE ON payment_event FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  rel pg_catalog.oid;
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['payment_link', 'payment_event'] LOOP
    rel := ('public.' || tbl)::pg_catalog.regclass;
    IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
              FROM pg_catalog.pg_class c WHERE c.oid = rel) THEN
      RAISE EXCEPTION '0051: % RLS is not enabled and forced', tbl;
    END IF;
    IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = rel))
       <> 'kasuwa_migrator' THEN
      RAISE EXCEPTION '0051: % is not owned by kasuwa_migrator', tbl;
    END IF;
    IF NOT (pg_catalog.has_table_privilege(app_role, rel, 'SELECT')
            AND pg_catalog.has_table_privilege(app_role, rel, 'INSERT')) THEN
      RAISE EXCEPTION '0051: kasuwa_app lacks SELECT or INSERT on %', tbl;
    END IF;
    IF pg_catalog.has_table_privilege(app_role, rel, 'DELETE') THEN
      RAISE EXCEPTION '0051: kasuwa_app must not hold DELETE on %', tbl;
    END IF;
    IF pg_catalog.has_column_privilege(app_role, rel, 'id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'tenant_id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'programme_id', 'UPDATE') THEN
      RAISE EXCEPTION '0051: kasuwa_app must not UPDATE id, tenant_id or programme_id of %', tbl;
    END IF;
  END LOOP;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0051: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END $$;
