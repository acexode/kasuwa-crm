-- ---------------------------------------------------------------------------
-- 0002 — real authentication (T-0001, M2).
--
-- Replaces the stubbed `x-kasuwa-*` header identity with server-issued
-- sessions. What this migration adds is only ever about *who* the caller is.
-- It adds nothing about *what* they can reach: there is no role, no permission
-- and no programme id anywhere below. Scope is still resolved from
-- user_programme inside withTenantTransaction, on every request, exactly as
-- before. If a later migration puts scope in a session row, the tenancy model
-- has been inverted.
--
-- Five tables, all carrying tenant_id, all ENABLE *and* FORCE row level
-- security, every policy's WITH CHECK identical to its USING, every foreign key
-- to a tenant-scoped parent composite on (tenant_id, id):
--
--   user_credential   one argon2id password hash per user
--   user_mfa_factor   enrolled second factors (TOTP only in T-0001)
--   auth_challenge    a second factor in progress; the bridge between the two
--                     sign-in steps, and the only thing the first step hands out
--   auth_session      an issued session, revocable, checked on every request
--   auth_attempt      failed first-factor attempts, keyed on a HASH of the
--                     submitted identifier so that no unknown email typed at a
--                     sign-in form is ever stored as text
--
-- Two SECURITY DEFINER functions exist because authentication has a genuine
-- bootstrap problem: before a session exists there is no tenant context, and
-- every RLS policy in the system reads one. They are deliberately the narrowest
-- possible shape — see the comments on each. Everything else in the sign-in
-- path runs inside a transaction with app.tenant_id set and
-- app.programme_ids = '{}', which means an authentication transaction can read
-- no programme-scoped row at all.
-- ---------------------------------------------------------------------------

-- --- user_credential -------------------------------------------------------
-- The hash only. No password, no reset token, no security question, no hint.
-- `password_hash` is an argon2id PHC string; the parameters live in the string
-- itself so they can be raised later without a migration.
CREATE TABLE user_credential (
  user_id              uuid        NOT NULL,
  tenant_id            uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  password_hash        text        NOT NULL,
  password_updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id),
  UNIQUE (tenant_id, user_id),
  CONSTRAINT user_credential_user_same_tenant_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_credential_tenant_idx ON user_credential (tenant_id);

ALTER TABLE user_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credential FORCE ROW LEVEL SECURITY;
-- Tenant-scoped only, for the same reason as "user": the sign-in transaction
-- has a tenant but no user and no programmes yet.
CREATE POLICY user_credential_isolation ON user_credential FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- --- user_mfa_factor -------------------------------------------------------
-- `secret` is the TOTP shared secret, base32. It is NOT encrypted at rest, and
-- that is a stated debt rather than an oversight: field-level encryption and
-- per-tenant key management are D-L13 in team/DECISIONS.md, which is BLOCKED.
-- Inventing a key-management scheme here would be guessing at a decision the
-- human has not made. Until then the secret is protected by RLS, by the app
-- role holding NOBYPASSRLS, and by never being selected into any response.
CREATE TABLE user_mfa_factor (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL,
  type          text        NOT NULL,
  label         text,
  secret        text        NOT NULL,
  confirmed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, type),
  CONSTRAINT user_mfa_factor_type_check CHECK (type IN ('totp')),
  CONSTRAINT user_mfa_factor_user_same_tenant_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_mfa_factor_tenant_user_idx ON user_mfa_factor (tenant_id, user_id);

ALTER TABLE user_mfa_factor ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mfa_factor FORCE ROW LEVEL SECURITY;
CREATE POLICY user_mfa_factor_isolation ON user_mfa_factor FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- --- auth_challenge --------------------------------------------------------
-- What the first factor hands out instead of a session. Holding one proves the
-- password was right; it grants nothing else, expires in minutes, is burned on
-- use and is burned after too many wrong codes.
CREATE TABLE auth_challenge (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL,
  method         text        NOT NULL,
  attempt_count  integer     NOT NULL DEFAULT 0,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_challenge_method_check CHECK (method IN ('totp', 'sms', 'backup_code')),
  CONSTRAINT auth_challenge_attempts_check CHECK (attempt_count >= 0),
  CONSTRAINT auth_challenge_user_same_tenant_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX auth_challenge_expiry_idx ON auth_challenge (expires_at);

ALTER TABLE auth_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_challenge FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_challenge_isolation ON auth_challenge FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- --- auth_session ----------------------------------------------------------
-- The token itself is never stored; only its SHA-256. A dump of this table
-- therefore hands an attacker nothing they can present.
--
-- The UNIQUE on token_hash is global rather than per-tenant on purpose, and it
-- is not an existence oracle: the value is 32 bytes of server-generated
-- randomness, never anything a caller supplies, so no request can provoke the
-- constraint and learn that a row exists in another tenant.
CREATE TABLE auth_session (
  id          uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  token_hash  bytea       NOT NULL UNIQUE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_session_user_same_tenant_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX auth_session_tenant_user_idx ON auth_session (tenant_id, user_id);
CREATE INDEX auth_session_expiry_idx ON auth_session (expires_at);

ALTER TABLE auth_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_session_isolation ON auth_session FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- --- auth_attempt ----------------------------------------------------------
-- Failed first-factor attempts, for lockout (design P01/1b).
--
-- Keyed on sha256(lower(email)) rather than the email, for two reasons. An
-- unknown address typed at a sign-in form is somebody's personal data that we
-- have no basis to store, and storing it would also let anyone fill this table
-- with arbitrary text. A hash counts just as well.
--
-- Counting happens whether or not the account exists, which is what keeps a
-- lockout from being evidence that an address is real.
CREATE TABLE auth_attempt (
  tenant_id        uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  identifier_hash  bytea       NOT NULL,
  failed_count     integer     NOT NULL DEFAULT 0,
  first_failed_at  timestamptz NOT NULL DEFAULT now(),
  last_failed_at   timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  PRIMARY KEY (tenant_id, identifier_hash),
  CONSTRAINT auth_attempt_count_check CHECK (failed_count >= 0)
);

ALTER TABLE auth_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_attempt_isolation ON auth_attempt FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- --- the two bootstrap functions -------------------------------------------
-- Authentication is the one place with a genuine chicken-and-egg problem: every
-- policy reads app.tenant_id, and before a session exists nobody has set it.
-- These two functions are the whole of the answer, and they are deliberately
-- minimal: both are STABLE, both take a single opaque argument, both return
-- identifiers and nothing else, both pin search_path, and neither can be
-- coaxed into returning a row of business data.
--
-- They are SECURITY DEFINER and owned by kasuwa_migrator, which holds
-- BYPASSRLS, so they are the only RLS-free read path in the system. Adding a
-- third one is an architecture decision, not a convenience.

-- Resolves a workspace slug to a tenant id. The slug is public — the caller
-- typed it into the sign-in form — and a tenant id alone grants nothing,
-- because reaching any row still needs a user whose membership resolves.
CREATE FUNCTION app.resolve_tenant_by_slug(p_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT t.id
    FROM public.tenant t
   WHERE t.slug = p_slug
     AND t.status <> 'suspended'
$$;

REVOKE ALL ON FUNCTION app.resolve_tenant_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_tenant_by_slug(text) TO kasuwa_app, kasuwa_test_admin;

-- Resolves a session token hash to the identity it names. Returns no row for a
-- session that is revoked, expired, or whose user is no longer active — which
-- is what makes disabling a user take effect on that user's NEXT request
-- rather than whenever their token happens to expire.
--
-- This is only the first of two checks. The application re-reads the same
-- session row inside the tenant transaction, under RLS, before serving
-- anything. Two independent layers; a mistake in one does not leak.
CREATE FUNCTION app.resolve_session(p_token_hash bytea)
  RETURNS TABLE (session_id uuid, tenant_id uuid, user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.tenant_id, s.user_id
    FROM public.auth_session s
    JOIN public."user" u
      ON u.id = s.user_id
     AND u.tenant_id = s.tenant_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.status = 'active'
$$;

REVOKE ALL ON FUNCTION app.resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_session(bytea) TO kasuwa_app, kasuwa_test_admin;
