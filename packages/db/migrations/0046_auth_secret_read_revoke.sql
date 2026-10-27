-- ---------------------------------------------------------------------------
-- 0046 - kasuwa_app can no longer read a credential hash or an MFA secret
--        (T-0157, T-0075, ADR-0013 decision 6). D-A3: changes grants on
--        RLS-guarded tables -> @acexode.
--
-- THE GAP. 0024 took kasuwa_app's WRITES on the auth tables away and kept its
-- SELECT, because sign-in's first phase (the lock read and the account lookup,
-- which joins user_credential) ran on the app pool (ADR-0013 decision 4: an
-- accepted deviation from D-P16 with a named follow-up). So SQL injected
-- anywhere in a tenant could still read every password hash and every MFA
-- secret in that tenant, and RLS is the only thing between it and the next
-- tenant. A hash is an offline-crackable credential; a TOTP secret is a
-- standing second factor.
--
-- THE FIX. The code moved first (the same PR): sign-in's phase one now runs
-- on the kasuwa_auth pool, and every other secret read already did. This file
-- is the contract step. kasuwa_app keeps SELECT on exactly the columns the app
-- pool still needs and nothing else:
--
--   user_credential       none.      The app pool never needs a credential row.
--   user_mfa_factor       id, tenant_id, user_id, type, confirmed_at
--                         (GET /auth/me/mfa, and the admin home's MFA count).
--   user_mfa_backup_code  id, tenant_id, user_id, used_at
--                         (the unused-codes count).
--
-- Unreadable by kasuwa_app afterwards: user_credential.password_hash;
-- user_mfa_factor.secret (the LEGACY plaintext column, revoked, not dropped:
-- dropping is a contract migration of its own), secret_ciphertext,
-- secret_wrapped_key, secret_key_id, secret_algorithm; user_mfa_backup_code.
-- code_hash, hash_key_wrapped, hash_key_id, hash_algorithm.
-- auth_session.token_hash stays readable: it is a SHA-256 of a 256-bit random
-- token that the session interceptor re-reads on every bearer request.
--
-- WHY A TABLE-LEVEL REVOKE FIRST. bootstrap.sql's default privileges give
-- kasuwa_app table-level SELECT on every migrator table, and REVOKE SELECT
-- (column) does nothing while a table-level grant exists. So: revoke the table
-- privilege from kasuwa_app and PUBLIC, then GRANT back the named columns.
-- `SELECT *` from kasuwa_app is therefore 42501, on purpose.
--
-- NOT CHANGED: no policy, no row-level rule, no function (still exactly two
-- SECURITY DEFINER functions), no role, no write privilege. kasuwa_auth keeps
-- the table-level SELECT it was given in 0024 (asserted below).
--
-- EXPAND AND CONTRACT. The code ships in the same PR as this contract step.
-- That is acceptable only because no populated cell exists (D-L65). Once one
-- does, this ships as two releases: the code, then this file.
--
-- ROLLBACK. Re-grant SELECT on the three tables to kasuwa_app. An out-of-band
-- GRANT as kasuwa_migrator in an incident; the T-0157 suite fails on it, so it
-- cannot be a migration that passes CI.
--
-- LOCKS (D-L65). GRANT and REVOKE rewrite catalogue rows (pg_class.relacl,
-- pg_attribute.attacl) and scan no table. The lock_timeout is a guard: if a
-- future Postgres takes a stronger lock, fail fast rather than queue behind a
-- long transaction and stall every session resolution behind this one.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '2s';

-- --- the role this relies on must be there ----------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kasuwa_auth') THEN
    RAISE EXCEPTION
      'kasuwa_auth does not exist: 0024 requires it and this file moves sign-in onto it. '
      'Re-apply packages/db/sql/bootstrap.sql as the superuser, then migrate again.';
  END IF;
END
$$;

REVOKE SELECT ON user_credential, user_mfa_factor, user_mfa_backup_code FROM kasuwa_app, PUBLIC;

GRANT SELECT (id, tenant_id, user_id, type, confirmed_at) ON user_mfa_factor TO kasuwa_app;
GRANT SELECT (id, tenant_id, user_id, used_at) ON user_mfa_backup_code TO kasuwa_app;

-- --- asserted, not assumed ----------------------------------------------------
DO $$
DECLARE
  secret RECORD;
  readable RECORD;
BEGIN
  -- No table-level SELECT left for the app role or PUBLIC.
  IF pg_catalog.has_table_privilege('kasuwa_app', 'user_credential', 'SELECT')
     OR pg_catalog.has_table_privilege('kasuwa_app', 'user_mfa_factor', 'SELECT')
     OR pg_catalog.has_table_privilege('kasuwa_app', 'user_mfa_backup_code', 'SELECT') THEN
    RAISE EXCEPTION 'kasuwa_app still holds table-level SELECT on an auth secret table (0046).';
  END IF;

  -- None of the secret columns is readable by the app role.
  FOR secret IN
    SELECT t.tbl, t.col
      FROM (VALUES
        ('user_credential', 'password_hash'),
        ('user_mfa_factor', 'secret'),
        ('user_mfa_factor', 'secret_ciphertext'),
        ('user_mfa_factor', 'secret_wrapped_key'),
        ('user_mfa_factor', 'secret_key_id'),
        ('user_mfa_factor', 'secret_algorithm'),
        ('user_mfa_backup_code', 'code_hash'),
        ('user_mfa_backup_code', 'hash_key_wrapped'),
        ('user_mfa_backup_code', 'hash_key_id'),
        ('user_mfa_backup_code', 'hash_algorithm')
      ) AS t(tbl, col)
  LOOP
    IF pg_catalog.has_column_privilege('kasuwa_app', secret.tbl, secret.col, 'SELECT') THEN
      RAISE EXCEPTION 'kasuwa_app can still read %.% (0046).', secret.tbl, secret.col;
    END IF;
  END LOOP;

  -- The columns the app pool still needs are readable.
  FOR readable IN
    SELECT t.tbl, t.col
      FROM (VALUES
        ('user_mfa_factor', 'id'), ('user_mfa_factor', 'tenant_id'), ('user_mfa_factor', 'user_id'),
        ('user_mfa_factor', 'type'), ('user_mfa_factor', 'confirmed_at'),
        ('user_mfa_backup_code', 'id'), ('user_mfa_backup_code', 'tenant_id'),
        ('user_mfa_backup_code', 'user_id'), ('user_mfa_backup_code', 'used_at')
      ) AS t(tbl, col)
  LOOP
    IF NOT pg_catalog.has_column_privilege('kasuwa_app', readable.tbl, readable.col, 'SELECT') THEN
      RAISE EXCEPTION 'kasuwa_app can no longer read %.%, which the app pool needs (0046).',
        readable.tbl, readable.col;
    END IF;
  END LOOP;

  -- The auth role keeps its table-level SELECT: sign-in is on it now.
  IF NOT (pg_catalog.has_table_privilege('kasuwa_auth', 'user_credential', 'SELECT')
          AND pg_catalog.has_table_privilege('kasuwa_auth', 'user_mfa_factor', 'SELECT')
          AND pg_catalog.has_table_privilege('kasuwa_auth', 'user_mfa_backup_code', 'SELECT')) THEN
    RAISE EXCEPTION 'kasuwa_auth lost SELECT on an auth table it needs (0046).';
  END IF;
END
$$;
