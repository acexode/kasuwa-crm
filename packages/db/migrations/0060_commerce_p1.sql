-- 0060 S5 commerce P1 foundations: tax_line, einvoice, fx_rate, fx_lock, billing_schedule, mobile_payment
-- Provisional B3/B4/B5 (D-L212). Fake MBS / admin FX / fail-closed mobile money.
SET LOCAL lock_timeout = '5s';
CREATE TABLE tax_line (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('quote','invoice')),
  owner_id uuid NOT NULL,
  code text NOT NULL,
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE einvoice (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  irn text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','cleared','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE fx_rate (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  base_currency text NOT NULL CHECK (base_currency IN ('NGN','GHS','KES','ZAR')),
  quote_currency text NOT NULL CHECK (quote_currency IN ('NGN','GHS','KES','ZAR')),
  rate_micros bigint NOT NULL CHECK (rate_micros > 0),
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE fx_lock (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  deal_id uuid NOT NULL,
  rate_micros bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE billing_schedule (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  invoice_id uuid,
  cadence text NOT NULL CHECK (cadence IN ('monthly','quarterly','yearly')),
  next_run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
CREATE TABLE mobile_payment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  programme_id uuid NOT NULL,
  provider_kind text NOT NULL CHECK (provider_kind IN ('mpesa','momo','fake')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','expired')),
  amount_minor bigint NOT NULL,
  currency text NOT NULL CHECK (currency IN ('NGN','GHS','KES','ZAR')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, programme_id, id),
  FOREIGN KEY (tenant_id, programme_id) REFERENCES programme(tenant_id, id) ON DELETE CASCADE
);
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tax_line','einvoice','fx_rate','fx_lock','billing_schedule','mobile_payment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO kasuwa_app USING (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids())) WITH CHECK (tenant_id = app.current_tenant_id() AND programme_id = ANY (app.current_programme_ids()))', tbl||'_isolation', tbl);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO kasuwa_app', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO kasuwa_test_admin', tbl);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at) EXECUTE FUNCTION app.touch_updated_at()', tbl||'_touch_updated_at', tbl);
  END LOOP;
END $$;
DO $$ BEGIN IF (SELECT count(*) FROM pg_proc p WHERE p.prosecdef AND p.pronamespace NOT IN ('pg_catalog'::regnamespace,'information_schema'::regnamespace)) <> 2 THEN RAISE EXCEPTION '0060 census'; END IF; END $$;
