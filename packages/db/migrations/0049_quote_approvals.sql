-- ---------------------------------------------------------------------------
-- 0049 - quote discount approvals (T-0166, M05 P0): approval_rule and
-- quote_approval. Programme-scoped; threshold and approver role per programme.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

LOCK TABLE tenant, programme, quote, "user"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE approval_rule (
  id                          uuid        PRIMARY KEY,
  tenant_id                   uuid        NOT NULL,
  programme_id                uuid        NOT NULL,
  threshold_bps               integer     NOT NULL,
  approver_permission_set_key text        NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT approval_rule_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT approval_rule_tenant_programme_key UNIQUE (tenant_id, programme_id),
  CONSTRAINT approval_rule_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT approval_rule_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT approval_rule_threshold_bps_check CHECK (threshold_bps BETWEEN 0 AND 10000),
  CONSTRAINT approval_rule_approver_key_check CHECK (
    approver_permission_set_key IN ('admin', 'team_lead', 'programme_manager')
  )
);

CREATE TABLE quote_approval (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  programme_id         uuid        NOT NULL,
  quote_id             uuid        NOT NULL,
  requested_by_user_id uuid        NOT NULL,
  discount_bps         integer     NOT NULL,
  status               text        NOT NULL DEFAULT 'pending',
  decided_by_user_id   uuid,
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quote_approval_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT quote_approval_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_approval_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_approval_quote_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, quote_id)
    REFERENCES quote (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT quote_approval_requested_by_same_tenant_fk
    FOREIGN KEY (tenant_id, requested_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT quote_approval_decided_by_same_tenant_fk
    FOREIGN KEY (tenant_id, decided_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT quote_approval_discount_bps_check CHECK (discount_bps BETWEEN 0 AND 10000),
  CONSTRAINT quote_approval_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT quote_approval_decision_shape_check CHECK (
    (status = 'pending'
      AND decided_by_user_id IS NULL
      AND decided_at IS NULL)
    OR
    (status IN ('approved', 'rejected')
      AND decided_by_user_id IS NOT NULL
      AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX quote_approval_pending_quote_key
  ON quote_approval (tenant_id, programme_id, quote_id)
  WHERE status = 'pending';

-- quote_approval_quote_idx covers (tenant_id, programme_id, …); no separate
-- programme-only index (T-0011 prefix rule — same as catalogue/quote drops).
CREATE INDEX quote_approval_quote_idx
  ON quote_approval (tenant_id, programme_id, quote_id);

ALTER TABLE approval_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_rule_isolation ON approval_rule FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

ALTER TABLE quote_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_approval_isolation ON quote_approval FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

REVOKE ALL ON approval_rule, quote_approval
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT ON approval_rule, quote_approval TO kasuwa_app;
GRANT UPDATE (threshold_bps, approver_permission_set_key, updated_at)
  ON approval_rule TO kasuwa_app;
GRANT UPDATE (status, decided_by_user_id, decided_at, updated_at)
  ON quote_approval TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_rule, quote_approval TO kasuwa_test_admin;

CREATE TRIGGER approval_rule_touch_updated_at
  BEFORE UPDATE ON approval_rule FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER quote_approval_touch_updated_at
  BEFORE UPDATE ON quote_approval FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  tbl text;
  rel pg_catalog.oid;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['approval_rule', 'quote_approval'] LOOP
    rel := ('public.' || tbl)::pg_catalog.regclass;
    IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
              FROM pg_catalog.pg_class c WHERE c.oid = rel) THEN
      RAISE EXCEPTION '0049: % RLS is not enabled and forced', tbl;
    END IF;
    IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = rel))
       <> 'kasuwa_migrator' THEN
      RAISE EXCEPTION '0049: % is not owned by kasuwa_migrator', tbl;
    END IF;
    IF NOT (pg_catalog.has_table_privilege(app_role, rel, 'SELECT')
            AND pg_catalog.has_table_privilege(app_role, rel, 'INSERT')) THEN
      RAISE EXCEPTION '0049: kasuwa_app lacks SELECT or INSERT on %', tbl;
    END IF;
    IF pg_catalog.has_table_privilege(app_role, rel, 'DELETE') THEN
      RAISE EXCEPTION '0049: kasuwa_app must not hold DELETE on %', tbl;
    END IF;
    IF pg_catalog.has_column_privilege(app_role, rel, 'id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'tenant_id', 'UPDATE')
       OR pg_catalog.has_column_privilege(app_role, rel, 'programme_id', 'UPDATE') THEN
      RAISE EXCEPTION '0049: kasuwa_app must not UPDATE id, tenant_id or programme_id of %', tbl;
    END IF;
  END LOOP;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0049: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END
$$;
