-- ---------------------------------------------------------------------------
-- 0051 - payment links (T-0169, M05 P0, D-A3).
--
-- A programme quote can be paid or its link can expire. Refunds, partial
-- payments and reconciliation stay out (B3). `paid` is webhook-only: the
-- public set-status request does not gain it.
--
-- RLS is tenant-scoped, not programme-scoped, on purpose. A webhook has no
-- user and therefore no user_programme session. Programme-scoped policies
-- read app.current_programme_ids(), which an authentication transaction sets
-- to empty, so they would hide every row from the signature check. The
-- repository still filters programme_id, and the quote update runs later
-- inside a real user transaction as the link's creator. No third
-- SECURITY DEFINER function (CLAUDE.md 2.7).
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

LOCK TABLE tenant, programme, quote, "user"
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE quote DROP CONSTRAINT quote_status_check;
ALTER TABLE quote ADD CONSTRAINT quote_status_check CHECK (status IN (
  'draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'paid'
));

CREATE TABLE payment_link (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  programme_id         uuid        NOT NULL,
  quote_id             uuid        NOT NULL,
  provider             text        NOT NULL,
  provider_link_id     text        NOT NULL,
  status               text        NOT NULL,
  amount_minor         bigint      NOT NULL,
  currency             text        NOT NULL,
  url                  text        NOT NULL,
  idempotency_key      text        NOT NULL,
  expires_at           timestamptz,
  paid_at              timestamptz,
  created_by_user_id   uuid        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_link_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT payment_link_idempotency_key UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT payment_link_provider_link_key UNIQUE (tenant_id, provider, provider_link_id),
  CONSTRAINT payment_link_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_link_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_link_quote_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, quote_id)
    REFERENCES quote (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT payment_link_created_by_same_tenant_fk
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT payment_link_provider_check CHECK (provider ~ '^[a-z]{1,32}$'),
  CONSTRAINT payment_link_provider_link_len_check
    CHECK (char_length(provider_link_id) BETWEEN 1 AND 256),
  CONSTRAINT payment_link_status_check CHECK (status IN ('pending', 'paid', 'expired')),
  CONSTRAINT payment_link_amount_check CHECK (amount_minor > 0),
  CONSTRAINT payment_link_currency_check CHECK (currency IN ('NGN', 'GHS', 'KES', 'ZAR')),
  CONSTRAINT payment_link_url_len_check CHECK (char_length(url) BETWEEN 1 AND 2048),
  CONSTRAINT payment_link_idempotency_len_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 128)
);

CREATE INDEX payment_link_quote_idx
  ON payment_link (tenant_id, programme_id, quote_id);

CREATE TABLE payment_event (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  programme_id       uuid        NOT NULL,
  payment_link_id    uuid        NOT NULL,
  provider           text        NOT NULL,
  event_id           text        NOT NULL,
  event_type         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_event_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT payment_event_provider_event_key UNIQUE (tenant_id, provider, event_id),
  CONSTRAINT payment_event_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_event_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT payment_event_link_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, payment_link_id)
    REFERENCES payment_link (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT payment_event_provider_check CHECK (provider ~ '^[a-z]{1,32}$'),
  CONSTRAINT payment_event_id_len_check CHECK (char_length(event_id) BETWEEN 1 AND 256),
  CONSTRAINT payment_event_type_check
    CHECK (event_type IN ('payment.paid', 'payment.expired', 'payment.failed'))
);

CREATE INDEX payment_event_link_idx
  ON payment_event (tenant_id, programme_id, payment_link_id);

-- Tenant-only: see the header. WITH CHECK matches USING.
ALTER TABLE payment_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_link FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_link_isolation ON payment_link FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE payment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_event FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_event_isolation ON payment_event FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON payment_link, payment_event
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT ON payment_link, payment_event TO kasuwa_app;
GRANT UPDATE (status, paid_at, updated_at) ON payment_link TO kasuwa_app;
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
  tbl text;
  rel pg_catalog.oid;
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
      RAISE EXCEPTION '0051: kasuwa_app must not DELETE %', tbl;
    END IF;
    IF pg_catalog.has_column_privilege(app_role, rel, 'id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'tenant_id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'programme_id', 'UPDATE') THEN
      RAISE EXCEPTION '0051: kasuwa_app must not UPDATE id, tenant_id or programme_id of %', tbl;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege(app_role, 'public.payment_event'::pg_catalog.regclass, 'UPDATE') THEN
    RAISE EXCEPTION '0051: kasuwa_app must not UPDATE payment_event';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0051: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END
$$;
