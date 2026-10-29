-- 0062 - signup_attempt (T-0016): pre-tenant self-serve verification state.
SET LOCAL lock_timeout = '5s';

CREATE TABLE signup_attempt (
  id                    uuid        PRIMARY KEY,
  email_hash            bytea       NOT NULL,
  phone_hash            bytea       NOT NULL,
  payload               jsonb       NOT NULL,
  password_hash         text        NOT NULL,
  phone_otp_hash        bytea,
  email_otp_hash        bytea,
  phone_verified        boolean     NOT NULL DEFAULT false,
  email_verified        boolean     NOT NULL DEFAULT false,
  otp_attempt_count     integer     NOT NULL DEFAULT 0,
  expires_at            timestamptz NOT NULL,
  resend_available_at   timestamptz NOT NULL,
  provisioned_tenant_id uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT signup_attempt_otp_attempts_check CHECK (otp_attempt_count >= 0)
);

CREATE INDEX signup_attempt_expires_idx ON signup_attempt (expires_at);
CREATE INDEX signup_attempt_email_hash_idx ON signup_attempt (email_hash);

ALTER TABLE signup_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_attempt FORCE ROW LEVEL SECURITY;

-- Only the auth pool (kasuwa_auth) touches this table; kasuwa_app has no grant.
CREATE POLICY signup_attempt_auth ON signup_attempt FOR ALL TO kasuwa_auth
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON signup_attempt FROM PUBLIC, kasuwa_app, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON signup_attempt TO kasuwa_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON signup_attempt TO kasuwa_test_admin;

CREATE TRIGGER signup_attempt_touch_updated_at
  BEFORE UPDATE ON signup_attempt FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

DO $$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0061: there must be exactly two SECURITY DEFINER functions';
  END IF;
END $$;
