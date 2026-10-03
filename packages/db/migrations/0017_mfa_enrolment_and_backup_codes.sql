-- ---------------------------------------------------------------------------
-- 0017 - MFA enrolment and backup codes (T-0012, M2).
--
-- Decisions: D-L13 (TOTP secrets are envelope-encrypted through
-- @kasuwa/auth-crypto), D-L54 (the provisioned first admin must enrol MFA on
-- first sign-in). Contract: docs/api/auth.openapi.yaml, operations
-- startMfaEnrolment, confirmMfaEnrolment, getMyMfa, startTotpReplacement,
-- confirmTotpReplacement, regenerateBackupCodes.
--
-- TWO CHANGES.
--
-- 1. user_mfa_factor may hold one PENDING factor beside the confirmed one.
--
--    Replacing a factor has to keep the old one working until the new one is
--    confirmed, otherwise a user who abandons the flow half-way has no second
--    factor at all. 0002's UNIQUE (tenant_id, user_id, type) allows exactly one
--    row per type, so it becomes two partial unique indexes: at most one
--    confirmed and at most one pending factor per user and type. Nothing that
--    was representable before stops being representable; this is a relaxation,
--    applied in one step because the old constraint cannot coexist with the
--    rows the new code writes.
--
--    A pending factor (confirmed_at IS NULL) NEVER satisfies a challenge: every
--    read that verifies a code selects `confirmed_at IS NOT NULL`, and the only
--    statement that sets confirmed_at runs after a correct code for that
--    factor's own secret.
--
-- 2. user_mfa_backup_code: single-use recovery codes, stored as a keyed hash.
--
--    The task says "hashed at rest like a password, never like a secret". The
--    code is never stored: code_hash is HMAC-SHA256 over the tenant id, the
--    user id and the normalised code, under a per-set data key from the same
--    KeyProvider that protects TOTP secrets (D-L13). The data key is stored
--    only wrapped. A dump of this table without the KMS key gives an attacker
--    nothing to test guesses against; argon2id per code was rejected because
--    verifying a submitted code against a set of ten would block the event loop
--    for ~0.9 s on every attempt. The reasoning is in the PR and the report.
--
--    used_at is set once, by a conditional UPDATE, which is what makes a code
--    single-use under concurrency. Used rows are kept (not deleted) so that the
--    count of remaining codes and the fact of use stay inspectable; a
--    regeneration deletes the whole set.
--
-- Every tenancy invariant applies in full:
--   1. tenant_id NOT NULL, FK to tenant.
--   2. RLS ENABLED *and* FORCED.
--   3. WITH CHECK identical to USING. Not programme-scoped: a credential
--      belongs to a user, not to a programme, exactly like user_mfa_factor.
--   4. The user FK is composite with tenant_id, so a code can never point at a
--      user in another tenant even with RLS bypassed.
--   5. Uniqueness is per (tenant, user), never global, so a collision can never
--      say anything about another tenant's rows.
--
-- Grants: kasuwa_app may UPDATE only used_at. Nothing in the application has a
-- reason to rewrite a hash or move a code between users.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. one pending factor beside the confirmed one -------------------------

CREATE UNIQUE INDEX user_mfa_factor_confirmed_key
  ON user_mfa_factor (tenant_id, user_id, type)
  WHERE confirmed_at IS NOT NULL;

CREATE UNIQUE INDEX user_mfa_factor_pending_key
  ON user_mfa_factor (tenant_id, user_id, type)
  WHERE confirmed_at IS NULL;

ALTER TABLE user_mfa_factor DROP CONSTRAINT user_mfa_factor_tenant_id_user_id_type_key;

COMMENT ON COLUMN user_mfa_factor.confirmed_at IS
  'Null while the factor is pending enrolment. A pending factor never satisfies a '
  'challenge; it becomes usable only when a code from its own secret is presented '
  'to the confirm operation (T-0012).';

-- --- 2. backup codes ---------------------------------------------------------

CREATE TABLE user_mfa_backup_code (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  user_id           uuid        NOT NULL,
  -- HMAC-SHA256(data key, 'user_mfa_backup_code:' || tenant || ':' || user || ':' || code).
  code_hash         bytea       NOT NULL,
  -- The per-set data key, wrapped by the KeyProvider. Never stored unwrapped.
  hash_key_wrapped  bytea       NOT NULL,
  hash_key_id       text        NOT NULL,
  hash_algorithm    text        NOT NULL,
  used_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_mfa_backup_code_user_same_tenant_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_mfa_backup_code_hash_length_check CHECK (octet_length(code_hash) = 32),
  CONSTRAINT user_mfa_backup_code_algorithm_check CHECK (hash_algorithm IN ('HS256-ENV1'))
);

CREATE UNIQUE INDEX user_mfa_backup_code_user_hash_key
  ON user_mfa_backup_code (tenant_id, user_id, code_hash);

-- The verify path: a user's unused codes.
CREATE INDEX user_mfa_backup_code_unused_idx
  ON user_mfa_backup_code (tenant_id, user_id)
  WHERE used_at IS NULL;

COMMENT ON TABLE user_mfa_backup_code IS
  'Single-use MFA recovery codes (T-0012). Only a keyed hash is stored; the codes '
  'exist in plaintext once, in the response that issued them.';

ALTER TABLE user_mfa_backup_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_backup_code FORCE ROW LEVEL SECURITY;
CREATE POLICY user_mfa_backup_code_isolation ON user_mfa_backup_code FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Restated rather than inherited from the bootstrap's default privileges, and
-- table-level UPDATE taken back so the column grant is the whole of it.
GRANT SELECT, INSERT, DELETE ON user_mfa_backup_code TO kasuwa_app, kasuwa_test_admin;
REVOKE UPDATE ON user_mfa_backup_code FROM kasuwa_app;
GRANT UPDATE (used_at) ON user_mfa_backup_code TO kasuwa_app;

DO $$
BEGIN
  IF has_column_privilege('kasuwa_app', 'public.user_mfa_backup_code', 'code_hash', 'UPDATE') THEN
    RAISE EXCEPTION 'kasuwa_app can UPDATE user_mfa_backup_code.code_hash after 0017';
  END IF;
  IF NOT (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.user_mfa_backup_code'::regclass) THEN
    RAISE EXCEPTION 'user_mfa_backup_code does not FORCE row level security';
  END IF;
END
$$;
