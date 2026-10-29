-- 0054 - portal_identity / portal_session / portal_programme (T-0179, ADR-0021 / D-L212)
SET LOCAL lock_timeout = '5s';
LOCK TABLE tenant, programme IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE portal_identity (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  -- Home programme (T-0030 programme_id on every portal_* table). Additional
  -- memberships live in portal_programme (ADR-0021); scope is re-read there.
  programme_id    uuid        NOT NULL,
  email           text        NOT NULL,
  email_masked    text        NOT NULL,
  display_name    text        NOT NULL DEFAULT '',
  status          text        NOT NULL DEFAULT 'active',
  -- Credential columns land with T-0179 auth depth (auth-pool revoke + T-0157
  -- allowlist). Schema only here so T-0049 / T-0157 census stay green.
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT portal_identity_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT portal_identity_tenant_email_key UNIQUE (tenant_id, email),
  CONSTRAINT portal_identity_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT portal_identity_programme_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT portal_identity_status_check CHECK (status IN ('active', 'suspended', 'invited')),
  CONSTRAINT portal_identity_email_len_check CHECK (char_length(email) BETWEEN 3 AND 320),
  CONSTRAINT portal_identity_email_masked_len_check CHECK (char_length(email_masked) BETWEEN 1 AND 120)
);

CREATE TABLE portal_session (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  programme_id         uuid        NOT NULL,
  portal_identity_id   uuid        NOT NULL,
  token_hash           text        NOT NULL,
  expires_at           timestamptz NOT NULL,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT portal_session_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT portal_session_token_hash_key UNIQUE (token_hash),
  CONSTRAINT portal_session_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT portal_session_programme_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT portal_session_identity_fk
    FOREIGN KEY (tenant_id, portal_identity_id)
    REFERENCES portal_identity (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT portal_session_token_hash_len_check CHECK (char_length(token_hash) = 64)
);

CREATE TABLE portal_programme (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  portal_identity_id   uuid        NOT NULL,
  programme_id         uuid        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT portal_programme_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT portal_programme_membership_key UNIQUE (tenant_id, portal_identity_id, programme_id),
  CONSTRAINT portal_programme_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT portal_programme_identity_fk
    FOREIGN KEY (tenant_id, portal_identity_id)
    REFERENCES portal_identity (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT portal_programme_programme_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT
);

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['portal_identity', 'portal_session', 'portal_programme'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO kasuwa_app
         USING (tenant_id = app.current_tenant_id())
         WITH CHECK (tenant_id = app.current_tenant_id())',
      tbl || '_isolation', tbl);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO kasuwa_app', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO kasuwa_test_admin', tbl);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW
         WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
         EXECUTE FUNCTION app.touch_updated_at()',
      tbl || '_touch_updated_at', tbl);
  END LOOP;
END $$;

-- kasuwa_auth grants for portal credential/session writes land with T-0179
-- (must extend T-0049 I2 allowlist explicitly). Until then, auth holds none.

DO $$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0054: there must be exactly two SECURITY DEFINER functions';
  END IF;
END $$;
