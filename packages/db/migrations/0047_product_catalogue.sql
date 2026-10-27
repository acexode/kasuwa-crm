-- ---------------------------------------------------------------------------
-- 0047 - product catalogue (T-0164, M05 P0): product, product_variant,
-- price_book, price_book_entry and tax_profile. Programme-scoped commerce
-- primitives for quotes and CPQ later slices.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

LOCK TABLE tenant, programme IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE tax_profile (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  programme_id uuid        NOT NULL,
  name         text        NOT NULL,
  rate_bps     integer     NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tax_profile_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT tax_profile_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT tax_profile_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT tax_profile_rate_bps_check CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  CONSTRAINT tax_profile_name_check CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE TABLE price_book (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  programme_id uuid        NOT NULL,
  name         text        NOT NULL,
  currency     text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT price_book_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT price_book_tenant_programme_currency_key UNIQUE (tenant_id, programme_id, currency),
  -- The target of price_book_entry's 4-column FK: an entry's currency is its book's.
  CONSTRAINT price_book_tenant_programme_id_currency_key UNIQUE (tenant_id, programme_id, id, currency),
  CONSTRAINT price_book_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT price_book_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT price_book_currency_check CHECK (currency IN ('NGN', 'GHS', 'KES', 'ZAR')),
  CONSTRAINT price_book_name_check CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE TABLE product (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  programme_id    uuid        NOT NULL,
  name            text        NOT NULL,
  description     text,
  sku             text,
  status          text        NOT NULL DEFAULT 'active',
  tax_profile_id  uuid,
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT product_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT product_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT product_tax_profile_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, tax_profile_id)
    REFERENCES tax_profile (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT product_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT product_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT product_version_check CHECK (version >= 1)
);

CREATE UNIQUE INDEX product_sku_key
  ON product (tenant_id, programme_id, sku)
  WHERE sku IS NOT NULL;
CREATE TABLE product_variant (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  programme_id uuid        NOT NULL,
  product_id   uuid        NOT NULL,
  name         text        NOT NULL,
  sku          text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_variant_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  -- The target of price_book_entry's variant FK: a variant OF THAT PRODUCT.
  CONSTRAINT product_variant_tenant_programme_product_id_key UNIQUE (tenant_id, programme_id, product_id, id),
  CONSTRAINT product_variant_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT product_variant_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT product_variant_product_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, product_id)
    REFERENCES product (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT product_variant_name_check CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE INDEX product_variant_product_idx ON product_variant (tenant_id, programme_id, product_id);

CREATE TABLE price_book_entry (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  programme_id  uuid        NOT NULL,
  price_book_id uuid        NOT NULL,
  product_id    uuid        NOT NULL,
  variant_id    uuid,
  amount_minor  bigint      NOT NULL,
  currency      text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT price_book_entry_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT price_book_entry_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- Book and currency together: an entry in another currency than its book is refused.
  CONSTRAINT price_book_entry_price_book_currency_fk
    FOREIGN KEY (tenant_id, programme_id, price_book_id, currency)
    REFERENCES price_book (tenant_id, programme_id, id, currency) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT price_book_entry_product_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, product_id)
    REFERENCES product (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- MATCH SIMPLE (the default): a NULL variant_id skips this check, as intended;
  -- a variant, when given, must belong to product_id.
  CONSTRAINT price_book_entry_variant_of_product_fk
    FOREIGN KEY (tenant_id, programme_id, product_id, variant_id)
    REFERENCES product_variant (tenant_id, programme_id, product_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- 0 to 18 nines, as deal (0036, D-L121): never past bigint.
  CONSTRAINT price_book_entry_amount_minor_check CHECK (amount_minor BETWEEN 0 AND 999999999999999999),
  CONSTRAINT price_book_entry_currency_check CHECK (currency IN ('NGN', 'GHS', 'KES', 'ZAR'))
);

CREATE UNIQUE INDEX price_book_entry_product_no_variant_key
  ON price_book_entry (tenant_id, programme_id, price_book_id, product_id)
  WHERE variant_id IS NULL;
CREATE UNIQUE INDEX price_book_entry_product_variant_key
  ON price_book_entry (tenant_id, programme_id, price_book_id, product_id, variant_id)
  WHERE variant_id IS NOT NULL;
CREATE INDEX price_book_entry_price_book_idx
  ON price_book_entry (tenant_id, programme_id, price_book_id);

ALTER TABLE tax_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_profile_isolation ON tax_profile FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

ALTER TABLE price_book ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_book FORCE ROW LEVEL SECURITY;
CREATE POLICY price_book_isolation ON price_book FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

ALTER TABLE product ENABLE ROW LEVEL SECURITY;
ALTER TABLE product FORCE ROW LEVEL SECURITY;
CREATE POLICY product_isolation ON product FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

ALTER TABLE product_variant ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variant FORCE ROW LEVEL SECURITY;
CREATE POLICY product_variant_isolation ON product_variant FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

ALTER TABLE price_book_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_book_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY price_book_entry_isolation ON price_book_entry FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

REVOKE ALL ON tax_profile, price_book, product, product_variant, price_book_entry
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
-- kasuwa_app: no DELETE, and UPDATE only on mutable columns, never id,
-- tenant_id, programme_id or the parent keys (0036's pattern).
GRANT SELECT, INSERT
  ON tax_profile, price_book, product, product_variant, price_book_entry
  TO kasuwa_app;
GRANT UPDATE (name, rate_bps, updated_at) ON tax_profile TO kasuwa_app;
GRANT UPDATE (name, updated_at) ON price_book TO kasuwa_app;
GRANT UPDATE (name, description, sku, status, tax_profile_id, version, updated_at)
  ON product TO kasuwa_app;
GRANT UPDATE (name, sku, updated_at) ON product_variant TO kasuwa_app;
GRANT UPDATE (amount_minor, currency, updated_at) ON price_book_entry TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON tax_profile, price_book, product, product_variant, price_book_entry
  TO kasuwa_test_admin;

CREATE TRIGGER tax_profile_touch_updated_at
  BEFORE UPDATE ON tax_profile FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER price_book_touch_updated_at
  BEFORE UPDATE ON price_book FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER product_touch_updated_at
  BEFORE UPDATE ON product FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER product_variant_touch_updated_at
  BEFORE UPDATE ON product_variant FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER price_book_entry_touch_updated_at
  BEFORE UPDATE ON price_book_entry FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  tbl text;
  rel pg_catalog.oid;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tax_profile', 'price_book', 'product', 'product_variant',
                             'price_book_entry'] LOOP
    rel := ('public.' || tbl)::pg_catalog.regclass;
    IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
              FROM pg_catalog.pg_class c WHERE c.oid = rel) THEN
      RAISE EXCEPTION '0047: % RLS is not enabled and forced', tbl;
    END IF;
    IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = rel))
       <> 'kasuwa_migrator' THEN
      RAISE EXCEPTION '0047: % is not owned by kasuwa_migrator', tbl;
    END IF;
    IF NOT (pg_catalog.has_table_privilege(app_role, rel, 'SELECT')
            AND pg_catalog.has_table_privilege(app_role, rel, 'INSERT')) THEN
      RAISE EXCEPTION '0047: kasuwa_app lacks SELECT or INSERT on %', tbl;
    END IF;
    IF pg_catalog.has_table_privilege(app_role, rel, 'DELETE') THEN
      RAISE EXCEPTION '0047: kasuwa_app must not hold DELETE on %', tbl;
    END IF;
    IF pg_catalog.has_column_privilege(app_role, rel, 'id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'tenant_id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'programme_id', 'UPDATE') THEN
      RAISE EXCEPTION '0047: kasuwa_app must not UPDATE id, tenant_id or programme_id of %', tbl;
    END IF;
  END LOOP;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0047: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END
$$;
