-- ---------------------------------------------------------------------------
-- 0048 - quotes (T-0165, M05 P0): quote and quote_line. Programme-scoped
-- quotes with line items, discounts, validity and gated status changes.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

LOCK TABLE tenant, programme, deal, contact, product, product_variant
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE quote (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  programme_id    uuid        NOT NULL,
  deal_id         uuid,
  contact_id      uuid,
  currency        text        NOT NULL,
  status          text        NOT NULL DEFAULT 'draft',
  discount_bps    integer     NOT NULL DEFAULT 0,
  valid_until     timestamptz,
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quote_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT quote_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- MATCH SIMPLE: NULL deal_id skips; a deal must be of this programme.
  CONSTRAINT quote_deal_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, deal_id)
    REFERENCES deal (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT quote_contact_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, contact_id)
    REFERENCES contact (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT quote_currency_check CHECK (currency IN ('NGN', 'GHS', 'KES', 'ZAR')),
  CONSTRAINT quote_status_check CHECK (status IN (
    'draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled'
  )),
  CONSTRAINT quote_discount_bps_check CHECK (discount_bps BETWEEN 0 AND 10000),
  CONSTRAINT quote_version_check CHECK (version >= 1)
);

CREATE INDEX quote_programme_idx
  ON quote (tenant_id, programme_id);

CREATE TABLE quote_line (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  programme_id       uuid        NOT NULL,
  quote_id           uuid        NOT NULL,
  product_id         uuid        NOT NULL,
  variant_id         uuid,
  quantity           integer     NOT NULL,
  unit_amount_minor  bigint      NOT NULL,
  discount_bps       integer     NOT NULL DEFAULT 0,
  sort_order         integer     NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quote_line_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT quote_line_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_line_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_line_quote_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, quote_id)
    REFERENCES quote (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_line_product_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, product_id)
    REFERENCES product (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- MATCH SIMPLE: NULL variant_id skips; a variant must belong to product_id.
  CONSTRAINT quote_line_variant_of_product_fk
    FOREIGN KEY (tenant_id, programme_id, product_id, variant_id)
    REFERENCES product_variant (tenant_id, programme_id, product_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT quote_line_quantity_check CHECK (quantity BETWEEN 1 AND 999999),
  CONSTRAINT quote_line_unit_amount_minor_check
    CHECK (unit_amount_minor BETWEEN 0 AND 999999999999999999),
  CONSTRAINT quote_line_discount_bps_check CHECK (discount_bps BETWEEN 0 AND 10000),
  CONSTRAINT quote_line_sort_order_check CHECK (sort_order >= 0)
);

CREATE INDEX quote_line_quote_idx
  ON quote_line (tenant_id, programme_id, quote_id);

ALTER TABLE quote ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_isolation ON quote FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

ALTER TABLE quote_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_line FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_line_isolation ON quote_line FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

REVOKE ALL ON quote, quote_line
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT ON quote, quote_line TO kasuwa_app;
-- quote_line DELETE is required so a draft update can replace the line set
-- (there is no ON DELETE CASCADE write path from quote for the app role).
GRANT DELETE ON quote_line TO kasuwa_app;
GRANT UPDATE (deal_id, contact_id, discount_bps, valid_until, status, version, updated_at)
  ON quote TO kasuwa_app;
GRANT UPDATE (product_id, variant_id, quantity, unit_amount_minor, discount_bps, sort_order, updated_at)
  ON quote_line TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON quote, quote_line TO kasuwa_test_admin;

CREATE TRIGGER quote_touch_updated_at
  BEFORE UPDATE ON quote FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER quote_line_touch_updated_at
  BEFORE UPDATE ON quote_line FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  tbl text;
  rel pg_catalog.oid;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['quote', 'quote_line'] LOOP
    rel := ('public.' || tbl)::pg_catalog.regclass;
    IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
              FROM pg_catalog.pg_class c WHERE c.oid = rel) THEN
      RAISE EXCEPTION '0048: % RLS is not enabled and forced', tbl;
    END IF;
    IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = rel))
       <> 'kasuwa_migrator' THEN
      RAISE EXCEPTION '0048: % is not owned by kasuwa_migrator', tbl;
    END IF;
    IF NOT (pg_catalog.has_table_privilege(app_role, rel, 'SELECT')
            AND pg_catalog.has_table_privilege(app_role, rel, 'INSERT')) THEN
      RAISE EXCEPTION '0048: kasuwa_app lacks SELECT or INSERT on %', tbl;
    END IF;
    IF tbl = 'quote' AND pg_catalog.has_table_privilege(app_role, rel, 'DELETE') THEN
      RAISE EXCEPTION '0048: kasuwa_app must not hold DELETE on quote';
    END IF;
    IF tbl = 'quote_line' AND NOT pg_catalog.has_table_privilege(app_role, rel, 'DELETE') THEN
      RAISE EXCEPTION '0048: kasuwa_app must hold DELETE on quote_line for draft line replace';
    END IF;
    IF pg_catalog.has_column_privilege(app_role, rel, 'id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'tenant_id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'programme_id', 'UPDATE') THEN
      RAISE EXCEPTION '0048: kasuwa_app must not UPDATE id, tenant_id or programme_id of %', tbl;
    END IF;
  END LOOP;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0048: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END
$$;
