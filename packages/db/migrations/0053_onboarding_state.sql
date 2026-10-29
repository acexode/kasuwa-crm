-- 0053 - onboarding_state (T-0018): resumable first-admin wizard behind onboarding_persistence.
SET LOCAL lock_timeout = '5s';
LOCK TABLE tenant, "user" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE onboarding_state (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  step            text        NOT NULL DEFAULT 'currency_language',
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT onboarding_state_tenant_user_key UNIQUE (tenant_id, user_id),
  CONSTRAINT onboarding_state_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT onboarding_state_user_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT onboarding_state_step_check CHECK (step IN (
    'currency_language', 'whatsapp', 'import', 'invite', 'checklist', 'done'
  ))
);

ALTER TABLE onboarding_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_state FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_state_isolation ON onboarding_state FOR ALL TO kasuwa_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON onboarding_state FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT, UPDATE ON onboarding_state TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_state TO kasuwa_test_admin;

CREATE TRIGGER onboarding_state_touch_updated_at
  BEFORE UPDATE ON onboarding_state FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

DO $$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0053: there must be exactly two SECURITY DEFINER functions';
  END IF;
END $$;
