-- 0063 - portal_auth_challenge (T-0179, ADR-0021 / D-L213). Provisional MFA step
--        between password verify and portal_session issue. Presented-id SELECT
--        policy (non-definer GUC) so verify needs no tenantSlug. No third
--        SECURITY DEFINER.

SET LOCAL lock_timeout = '2s';
LOCK TABLE tenant, programme, portal_identity IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE portal_auth_challenge (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  programme_id         uuid        NOT NULL,
  portal_identity_id   uuid        NOT NULL,
  attempt_count        integer     NOT NULL DEFAULT 0,
  expires_at           timestamptz NOT NULL,
  consumed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT portal_auth_challenge_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT portal_auth_challenge_attempts_check CHECK (attempt_count >= 0),
  CONSTRAINT portal_auth_challenge_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT portal_auth_challenge_programme_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT portal_auth_challenge_identity_fk
    FOREIGN KEY (tenant_id, portal_identity_id)
    REFERENCES portal_identity (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX portal_auth_challenge_expiry_idx ON portal_auth_challenge (expires_at);
CREATE INDEX portal_auth_challenge_identity_idx
  ON portal_auth_challenge (tenant_id, portal_identity_id);

ALTER TABLE portal_auth_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_auth_challenge FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.current_portal_auth_challenge_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('app.portal_auth_challenge_id', true), '')::uuid
$$;

GRANT EXECUTE ON FUNCTION app.current_portal_auth_challenge_id()
  TO kasuwa_app, kasuwa_auth, kasuwa_test_admin, kasuwa_sweeper;

COMMENT ON FUNCTION app.current_portal_auth_challenge_id() IS
  'Portal MFA challenge id the current statement presents. NULL when unset.';

CREATE POLICY portal_auth_challenge_isolation ON portal_auth_challenge FOR ALL TO kasuwa_auth
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY portal_auth_challenge_presented ON portal_auth_challenge FOR SELECT TO kasuwa_auth
  USING (id = app.current_portal_auth_challenge_id());

REVOKE ALL ON portal_auth_challenge FROM PUBLIC, kasuwa_app, kasuwa_sweeper, kasuwa_relay;
GRANT SELECT, INSERT, DELETE ON portal_auth_challenge TO kasuwa_auth;
GRANT UPDATE (attempt_count, consumed_at) ON portal_auth_challenge TO kasuwa_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON portal_auth_challenge TO kasuwa_test_admin;

DO $$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0063: there must be exactly two SECURITY DEFINER functions';
  END IF;

  IF pg_catalog.has_table_privilege('kasuwa_app', 'portal_auth_challenge', 'SELECT') THEN
    RAISE EXCEPTION 'kasuwa_app must not read portal_auth_challenge (0063).';
  END IF;

  IF NOT pg_catalog.has_table_privilege('kasuwa_auth', 'portal_auth_challenge', 'INSERT')
     OR NOT pg_catalog.has_column_privilege('kasuwa_auth', 'portal_auth_challenge', 'attempt_count', 'UPDATE') THEN
    RAISE EXCEPTION 'kasuwa_auth must write portal_auth_challenge (0063).';
  END IF;
END $$;
