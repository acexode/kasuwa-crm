-- ---------------------------------------------------------------------------
-- 0024 - kasuwa_auth is the only writer of the auth tables (T-0049, D-P16,
--        ADR-0013). D-A3: changes grants on RLS-guarded tables -> @acexode.
--
-- THE GAP (D-P16). Every statement the API runs was kasuwa_app, so the
-- database could not tell the auth module from any other code. SQL injected
-- anywhere in a tenant could mint an auth_session for the tenant admin (which
-- app.resolve_session then honours), overwrite a password hash, delete MFA
-- factors and backup codes, give a backdoor "user" a credential, un-revoke or
-- extend a session, reset the TOTP replay watermark, revive a used backup code
-- or reset a challenge's wrong-code counter. It could also delete another
-- user's MFA lockout row in auth_rate_limit, by presenting that user's key
-- (computable from the tenant and user ids) - the T-0049 reviews found this.
-- The policies on those tables were all it had to get past.
--
-- THE FIX. A separate LOGIN role, kasuwa_auth, created in bootstrap.sql (it is
-- applied outside the runner; asserted below). It is used only by the API's
-- auth module, through its own pool (AUTH_PG_POOL, apps/api/src/auth/). This
-- file gives it its privileges and takes kasuwa_app's writes away:
--
--   kasuwa_app (and PUBLIC) - no INSERT, UPDATE, DELETE or TRUNCATE on the
--     five auth tables or on auth_rate_limit. SELECT is KEPT: the
--     tenant-transaction interceptor re-reads auth_session on every bearer
--     request, the admin home counts MFA enrolment, and the sign-in read phase
--     reads the lock and the credential on the app pool (ADR-0013, Decision 4:
--     an accepted deviation from D-P16, with a named follow-up). The D-L66
--     sweeper's DELETE on auth_challenge, auth_session and auth_rate_limit is
--     unchanged: its own policies confine it to rows past retention (0020).
--
--   kasuwa_auth -
--     the five auth tables + auth_rate_limit: SELECT, DELETE, INSERT, and
--       UPDATE on ONLY the columns the auth module changes:
--         auth_session          revoked_at
--         auth_challenge        method, attempt_count, consumed_at
--         user_credential       password_hash (see below)
--         user_mfa_factor       confirmed_at, last_used_step, updated_at
--         user_mfa_backup_code  used_at
--         auth_rate_limit       failed_count, first_failed_at, last_failed_at,
--                               locked_until
--       So even SQL running on the auth pool cannot extend a session, re-point
--       it at another user, or rewrite a challenge's owner.
--     user_mfa_factor INSERT is on every column EXCEPT the legacy plaintext
--       `secret` (D-L13): new factors are envelope-only, and this makes that a
--       privilege rather than a convention.
--     user_credential UPDATE is password_hash ONLY. No code changes a hash
--       yet; the review asked for updated_at alone, but the T-0049 acceptance
--       suite's control (auth-role, "the write kasuwa_app was refused,
--       kasuwa_auth may make") runs `UPDATE user_credential SET password_hash
--       = password_hash` as kasuwa_auth, so password_hash is the narrowest
--       grant the suite accepts. updated_at needs no grant: the 0018 trigger
--       sets it.
--     "user": SELECT, and UPDATE (updated_at) ONLY. The UPDATE is there
--       because lockUserForFactorWrite takes SELECT ... FOR UPDATE on the
--       enrolling user's row, which Postgres refuses without UPDATE on some
--       column; updated_at is the one column whose value means nothing to
--       security. 0023's guard trigger passes every role but kasuwa_app
--       through, so this column grant is the whole of what bounds kasuwa_auth
--       on "user", and the assertions below pin it.
--     tenant, user_programme: SELECT. withAuthTransaction confirms a tenant
--       by id; withTenantTransaction (the /auth/me/mfa/* writes run one on the
--       auth pool) resolves programme scope from user_programme.
--     schema app: USAGE; EXECUTE on the four context accessors the policies
--       above call, and on app.resolve_tenant_by_slug (sign-in has to find a
--       tenant before it has one). NOT app.resolve_session: the auth module
--       resolves a token on the app pool, so that SECURITY DEFINER function
--       stays with the role it was argued for.
--     No INSERT on "user" (the suite allows one; no flow needs it yet), no
--       business table, no sequence, no TRUNCATE, REFERENCES or TRIGGER.
--
-- WHY A GRANT AND NOT A POLICY. A policy TO kasuwa_auth that the app role
-- fails would be a silent 0-row match; a missing privilege is 42501 and is
-- visible in the catalogue. The suite requires the refusal to be a privilege.
--
-- RLS IS UNCHANGED. kasuwa_auth is NOBYPASSRLS and every policy on these
-- tables is FOR ALL TO PUBLIC with WITH CHECK = USING, so the auth pool is
-- bound by the same tenant (and presented-key) predicates as before. No policy
-- is added, dropped or changed here, and none names kasuwa_auth.
--
-- STILL TRUE: exactly two SECURITY DEFINER functions (CLAUDE.md 2.7), no role
-- reachable from kasuwa_app or kasuwa_auth holds BYPASSRLS, and kasuwa_auth is
-- a member of nothing, so no SET ROLE leads into or out of it.
--
-- DEFAULT PRIVILEGES. bootstrap.sql still grants DML on every FUTURE migrator
-- table to kasuwa_app, and names kasuwa_auth nowhere (asserted below). A new
-- auth table must repeat this file's revoke and grant explicitly
-- (packages/db/CLAUDE.md).
--
-- EXPAND AND CONTRACT SHIP IN ONE FILE. The grants to kasuwa_auth are the
-- expand; the revoke from kasuwa_app is the contract. An API built before
-- T-0049 writes the auth tables as kasuwa_app, so against a database that has
-- run this file every sign-in it serves is 42501 until the new API (which
-- needs DATABASE_AUTH_URL) is deployed. That is acceptable ONLY under D-L65,
-- because no populated cell exists. Once one does, a change like this ships
-- as two migrations: the grants with the code that uses them, and the revoke
-- in a later release.
--
-- ROLLBACK. Re-granting kasuwa_app its old writes (INSERT, UPDATE, DELETE on
-- the five tables and auth_rate_limit; on user_mfa_backup_code, UPDATE on
-- used_at only, as 0017 had it) is enough on its own to make BOTH the old and
-- the new API work: the new one never writes through kasuwa_app, and
-- kasuwa_auth's grants widen nothing. But that re-grant cannot be a migration
-- that passes CI, because the T-0049 suite (I3) fails on it. So in an incident
-- it is an out-of-band GRANT run as kasuwa_migrator, recorded, and reconciled
-- by a later migration or reverted. Rolling forward (deploying the T-0049 API
-- with DATABASE_AUTH_URL set) is usually the faster fix.
--
-- LOCKS (D-L65). GRANT and REVOKE rewrite catalogue rows (pg_class.relacl,
-- pg_attribute.attacl, pg_namespace, pg_proc) and scan no table; during review
-- only AccessShareLocks on the catalogue were observed for this file, nothing
-- on the tables themselves. The lock_timeout is kept as a guard: if a future
-- Postgres takes a stronger lock, fail fast rather than queue behind a long
-- transaction and stall every session resolution behind this one.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '2s';

-- --- the role must be what D-P16 / suite I1 says it is ----------------------
-- Asserted, not assumed: bootstrap.sql runs outside the migration runner.
DO $$
DECLARE
  auth_role pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO auth_role FROM pg_catalog.pg_roles WHERE rolname = 'kasuwa_auth';
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'kasuwa_auth does not exist: this database was bootstrapped before T-0049. '
      'Re-apply the bootstrap as the superuser, then migrate again. Local dev: '
      '`docker exec -i kasuwa-postgres psql -U postgres -d kasuwa -v ON_ERROR_STOP=1 '
      '< packages/db/sql/bootstrap.sql` (it is idempotent). Real environments: '
      'create kasuwa_auth with its secrets-manager password, then apply the '
      'bootstrap. See packages/db/CLAUDE.md.';
  END IF;
  IF NOT auth_role.rolcanlogin OR auth_role.rolbypassrls OR auth_role.rolsuper
     OR auth_role.rolcreaterole OR auth_role.rolcreatedb OR auth_role.rolreplication THEN
    RAISE EXCEPTION
      'kasuwa_auth must be LOGIN, NOBYPASSRLS, NOSUPERUSER, NOCREATEROLE, NOCREATEDB '
      'and NOREPLICATION (T-0049). Tenant RLS is part of what bounds it.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
              WHERE m.member = auth_role.oid OR m.roleid = auth_role.oid) THEN
    RAISE EXCEPTION
      'kasuwa_auth is a member of a role, or a role is a member of it. Either way a '
      'SET ROLE crosses the boundary this role exists to draw (T-0049).';
  END IF;
END
$$;

-- --- kasuwa_app loses every write on the six auth tables ---------------------
-- A table-level REVOKE also revokes the matching column privileges, which is
-- what removes 0017's UPDATE (used_at) on user_mfa_backup_code. PUBLIC holds
-- nothing today; revoked anyway so that this file states the whole rule.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON auth_session, auth_challenge, user_credential, user_mfa_factor, user_mfa_backup_code,
     auth_rate_limit
  FROM kasuwa_app, PUBLIC;

-- --- kasuwa_auth: what the auth module needs, and nothing else ---------------
GRANT USAGE ON SCHEMA app TO kasuwa_auth;
GRANT EXECUTE ON FUNCTION
  app.current_tenant_id(),
  app.current_user_id(),
  app.current_programme_ids(),
  app.current_rate_limit_key(),
  app.resolve_tenant_by_slug(text)
  TO kasuwa_auth;

GRANT SELECT, DELETE
  ON auth_session, auth_challenge, user_credential, user_mfa_factor, user_mfa_backup_code,
     auth_rate_limit
  TO kasuwa_auth;

GRANT INSERT
  ON auth_session, auth_challenge, user_credential, user_mfa_backup_code, auth_rate_limit
  TO kasuwa_auth;
-- Every column but the legacy plaintext `secret` (D-L13).
GRANT INSERT (id, tenant_id, user_id, type, label, confirmed_at, created_at, updated_at,
              last_used_step, secret_ciphertext, secret_wrapped_key, secret_key_id,
              secret_algorithm)
  ON user_mfa_factor TO kasuwa_auth;

GRANT UPDATE (revoked_at) ON auth_session TO kasuwa_auth;
GRANT UPDATE (method, attempt_count, consumed_at) ON auth_challenge TO kasuwa_auth;
GRANT UPDATE (password_hash) ON user_credential TO kasuwa_auth;
GRANT UPDATE (confirmed_at, last_used_step, updated_at) ON user_mfa_factor TO kasuwa_auth;
GRANT UPDATE (used_at) ON user_mfa_backup_code TO kasuwa_auth;
GRANT UPDATE (failed_count, first_failed_at, last_failed_at, locked_until)
  ON auth_rate_limit TO kasuwa_auth;

GRANT SELECT ON tenant, user_programme, "user" TO kasuwa_auth;
GRANT UPDATE (updated_at) ON "user" TO kasuwa_auth;

-- --- prove it ----------------------------------------------------------------
-- Read with the privilege functions, which see every route a privilege can
-- take (direct, PUBLIC, column-level, inherited), not information_schema.
-- The NEGATIVE checks say nothing beyond the plan is held; the POSITIVE ones
-- say everything in the plan landed, so a typo cannot pass as "narrower".
DO $$
DECLARE
  auth_role constant pg_catalog.oid := 'kasuwa_auth'::pg_catalog.regrole;
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  sweeper constant pg_catalog.oid := 'kasuwa_sweeper'::pg_catalog.regrole;
  -- The six tables only kasuwa_auth may write.
  writable constant pg_catalog.oid[] := ARRAY[
    'public.auth_session'::pg_catalog.regclass,
    'public.auth_challenge'::pg_catalog.regclass,
    'public.user_credential'::pg_catalog.regclass,
    'public.user_mfa_factor'::pg_catalog.regclass,
    'public.user_mfa_backup_code'::pg_catalog.regclass,
    'public.auth_rate_limit'::pg_catalog.regclass
  ]::pg_catalog.oid[];
  read_only constant pg_catalog.oid[] := ARRAY[
    'public.tenant'::pg_catalog.regclass,
    'public.user_programme'::pg_catalog.regclass,
    'public."user"'::pg_catalog.regclass
  ]::pg_catalog.oid[];
  -- The sweeper's DELETE, D-L66: the one write on these tables kasuwa_app can
  -- reach (by SET ROLE), confined by its policies to rows past retention.
  swept constant pg_catalog.oid[] := ARRAY[
    'public.auth_session'::pg_catalog.regclass,
    'public.auth_challenge'::pg_catalog.regclass,
    'public.auth_rate_limit'::pg_catalog.regclass
  ]::pg_catalog.oid[];
  update_columns constant text[][] := ARRAY[
    ['public.auth_session', 'revoked_at'],
    ['public.auth_challenge', 'method'],
    ['public.auth_challenge', 'attempt_count'],
    ['public.auth_challenge', 'consumed_at'],
    ['public.user_credential', 'password_hash'],
    ['public.user_mfa_factor', 'confirmed_at'],
    ['public.user_mfa_factor', 'last_used_step'],
    ['public.user_mfa_factor', 'updated_at'],
    ['public.user_mfa_backup_code', 'used_at'],
    ['public.auth_rate_limit', 'failed_count'],
    ['public.auth_rate_limit', 'first_failed_at'],
    ['public.auth_rate_limit', 'last_failed_at'],
    ['public.auth_rate_limit', 'locked_until'],
    ['public."user"', 'updated_at']
  ];
  extra text;
BEGIN
  -- 1. kasuwa_app, PUBLIC and every role kasuwa_app can reach by membership
  --    hold no write on the six tables, bar the D-L66 sweeper's DELETE.
  SELECT pg_catalog.string_agg(r.rolname || ' ' || t.rel::pg_catalog.regclass::text || ':' || p.priv,
                               ', ' ORDER BY r.rolname, t.rel, p.priv)
    INTO extra
    FROM (
      WITH RECURSIVE reach(oid) AS (
        SELECT app_role
        UNION
        SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN reach ON m.member = reach.oid
      )
      SELECT ro.rolname::text AS rolname FROM pg_catalog.pg_roles ro
       WHERE ro.oid IN (SELECT oid FROM reach)
      UNION ALL
      SELECT 'public'
    ) r
   CROSS JOIN pg_catalog.unnest(writable) AS t(rel)
   CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
   WHERE CASE
           WHEN p.priv IN ('INSERT', 'UPDATE')
             THEN pg_catalog.has_any_column_privilege(r.rolname, t.rel, p.priv)
           ELSE pg_catalog.has_table_privilege(r.rolname, t.rel, p.priv)
         END
     AND NOT (r.rolname = 'kasuwa_sweeper' AND p.priv = 'DELETE' AND t.rel = ANY (swept));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'a role other than kasuwa_auth can still write the auth tables (D-P16): %', extra;
  END IF;

  -- 2. kasuwa_auth's table-level privileges: DELETE on the six writable
  --    tables, nothing else anywhere (SELECT, INSERT and UPDATE are checked
  --    per column below).
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text || ':' || p.priv, ', ')
    INTO extra
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN pg_catalog.unnest(ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(priv)
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_toast%'
     AND pg_catalog.has_table_privilege(auth_role, c.oid, p.priv)
     AND NOT (p.priv = 'DELETE' AND c.oid = ANY (writable));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth holds table privileges beyond T-0049: %', extra;
  END IF;

  -- 3. Column-level: SELECT on the six and the three read tables, INSERT on
  --    the six except user_mfa_factor.secret, UPDATE on exactly the columns
  --    granted above, no REFERENCES.
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text || '.' || a.attname || ':' || p.priv, ', ')
    INTO extra
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(priv)
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_toast%'
     AND pg_catalog.has_column_privilege(auth_role, c.oid, a.attnum, p.priv)
     AND NOT (p.priv = 'SELECT' AND c.oid = ANY (writable || read_only))
     AND NOT (p.priv = 'INSERT' AND c.oid = ANY (writable)
              AND NOT (c.oid = 'public.user_mfa_factor'::pg_catalog.regclass
                       AND a.attname = 'secret'))
     AND NOT (p.priv = 'UPDATE' AND EXISTS (
           SELECT 1 FROM pg_catalog.generate_subscripts(update_columns, 1) AS i
            WHERE c.oid = update_columns[i][1]::pg_catalog.regclass
              AND a.attname = update_columns[i][2]));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth holds column privileges beyond T-0049: %', extra;
  END IF;

  -- 4. Sequences: none.
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO extra
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'S'
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND (pg_catalog.has_sequence_privilege(auth_role, c.oid, 'USAGE')
       OR pg_catalog.has_sequence_privilege(auth_role, c.oid, 'SELECT')
       OR pg_catalog.has_sequence_privilege(auth_role, c.oid, 'UPDATE'));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth holds sequence privileges: %', extra;
  END IF;

  -- 5. POSITIVE: everything the plan grants actually landed.
  --    5a. SELECT and DELETE on the six; SELECT on the three read tables.
  SELECT pg_catalog.string_agg(t.rel::pg_catalog.regclass::text || ':' || p.priv, ', ')
    INTO extra
    FROM pg_catalog.unnest(writable) AS t(rel)
   CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'DELETE']) AS p(priv)
   WHERE NOT pg_catalog.has_table_privilege(auth_role, t.rel, p.priv);
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth is missing a planned privilege: %', extra;
  END IF;
  SELECT pg_catalog.string_agg(t.rel::pg_catalog.regclass::text || ':SELECT', ', ')
    INTO extra
    FROM pg_catalog.unnest(read_only) AS t(rel)
   WHERE NOT pg_catalog.has_table_privilege(auth_role, t.rel, 'SELECT');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth is missing a planned read: %', extra;
  END IF;

  --    5b. INSERT on every column of the six, except user_mfa_factor.secret.
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text || '.' || a.attname || ':INSERT', ', ')
    INTO extra
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   WHERE c.oid = ANY (writable)
     AND NOT (c.oid = 'public.user_mfa_factor'::pg_catalog.regclass AND a.attname = 'secret')
     AND NOT pg_catalog.has_column_privilege(auth_role, c.oid, a.attnum, 'INSERT');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth is missing a planned INSERT column: %', extra;
  END IF;

  --    5c. Each planned UPDATE column.
  SELECT pg_catalog.string_agg(update_columns[i][1] || '.' || update_columns[i][2] || ':UPDATE', ', ')
    INTO extra
    FROM pg_catalog.generate_subscripts(update_columns, 1) AS i
   WHERE NOT pg_catalog.has_column_privilege(auth_role, update_columns[i][1]::pg_catalog.regclass,
                                             update_columns[i][2], 'UPDATE');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth is missing a planned UPDATE column: %', extra;
  END IF;

  --    5d. USAGE on app, EXECUTE on the accessors and the slug resolver.
  IF NOT pg_catalog.has_schema_privilege(auth_role, 'app', 'USAGE') THEN
    RAISE EXCEPTION 'kasuwa_auth has no USAGE on schema app; every policy check fails.';
  END IF;
  SELECT pg_catalog.string_agg(f, ', ') INTO extra
    FROM pg_catalog.unnest(ARRAY[
           'app.current_tenant_id()',
           'app.current_user_id()',
           'app.current_programme_ids()',
           'app.current_rate_limit_key()',
           'app.resolve_tenant_by_slug(text)'
         ]) AS f
   WHERE NOT pg_catalog.has_function_privilege(auth_role, f, 'EXECUTE');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth cannot EXECUTE: %', extra;
  END IF;

  --    5e. The sweeper still holds its DELETE on its three tables (D-L66):
  --        the revoke above must not have reached it.
  SELECT pg_catalog.string_agg(t.rel::pg_catalog.regclass::text, ', ') INTO extra
    FROM pg_catalog.unnest(swept) AS t(rel)
   WHERE NOT pg_catalog.has_table_privilege(sweeper, t.rel, 'DELETE');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_sweeper lost its DELETE (D-L66 prune would stop): %', extra;
  END IF;

  -- 6. Everything kasuwa_auth can touch is ENABLE + FORCE row level security:
  --    the role is bounded by the policies, so a table without them would be
  --    a cross-tenant read on the auth pool.
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO extra
    FROM pg_catalog.pg_class c
   WHERE c.oid = ANY (writable || read_only)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth can reach a table without ENABLE + FORCE RLS: %', extra;
  END IF;

  -- 7. No policy names kasuwa_auth: the PUBLIC policies are the whole rule.
  SELECT pg_catalog.string_agg(p.tablename || '.' || p.policyname, ', ') INTO extra
    FROM pg_catalog.pg_policies p
   WHERE 'kasuwa_auth' = ANY (p.roles);
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'a policy names kasuwa_auth (T-0049 adds none): %', extra;
  END IF;

  -- 8. Every SECURITY DEFINER function, wherever it is: kasuwa_auth may
  --    EXECUTE app.resolve_tenant_by_slug and no other, and PUBLIC none. A
  --    definer added later is caught here as well as by CLAUDE.md 2.7.
  SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') INTO extra
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND pg_catalog.has_function_privilege(auth_role, p.oid, 'EXECUTE')
     AND p.oid <> 'app.resolve_tenant_by_slug(text)'::pg_catalog.regprocedure::pg_catalog.oid;
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth can EXECUTE a SECURITY DEFINER function beyond the slug resolver: %', extra;
  END IF;
  SELECT pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ') INTO extra
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'a SECURITY DEFINER function is executable by PUBLIC; REVOKE ALL ... FROM PUBLIC: %', extra;
  END IF;

  -- 9. No default privilege names kasuwa_auth, as grantor or grantee: a future
  --    table must never hand it anything by accident.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d
              WHERE d.defaclrole = auth_role
                 OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a
                             WHERE a.grantee = auth_role)) THEN
    RAISE EXCEPTION 'a pg_default_acl entry names kasuwa_auth (T-0049 I1).';
  END IF;

  -- 10. It may create nothing, so it can own nothing (an owner can disable RLS).
  IF pg_catalog.has_database_privilege(auth_role, pg_catalog.current_database(), 'CREATE')
     OR pg_catalog.has_schema_privilege(auth_role, 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege(auth_role, 'app', 'CREATE') THEN
    RAISE EXCEPTION 'kasuwa_auth may CREATE in the database or a schema (T-0049 I1).';
  END IF;
END
$$;
