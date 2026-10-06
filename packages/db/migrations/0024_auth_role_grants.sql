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
-- or reset a challenge's wrong-code counter. The tenant policies on those
-- tables were all it had to get past, and they are FOR ALL, tenant-only.
--
-- THE FIX. A separate LOGIN role, kasuwa_auth, created in bootstrap.sql (it is
-- applied outside the runner; asserted below). It is used only by the API's
-- auth module, through its own pool (AUTH_PG_POOL, apps/api/src/auth/). This
-- file gives it its privileges and takes kasuwa_app's writes away:
--
--   kasuwa_app (and PUBLIC) - no INSERT, UPDATE, DELETE or TRUNCATE on the
--     five auth tables. SELECT is KEPT: the tenant-transaction interceptor
--     re-reads auth_session on every bearer request, the admin home counts MFA
--     enrolment, and the sign-in read phase reads credentials (ADR-0013 says
--     why that phase stays on the app pool). The D-L66 sweeper's DELETE on
--     auth_challenge and auth_session is unchanged: its own policies confine
--     it to rows already past retention (0020).
--
--   kasuwa_auth -
--     the five auth tables + auth_rate_limit: SELECT, INSERT, DELETE, and
--       UPDATE on ONLY the columns the auth module changes. Narrowed so that
--       even SQL running on the auth pool cannot re-point a session at another
--       user, extend one, or rewrite a challenge's owner: auth_session's only
--       updatable column is revoked_at.
--     "user": SELECT, and UPDATE (updated_at) ONLY. The UPDATE is there
--       because lockUserForFactorWrite takes SELECT ... FOR UPDATE on the
--       enrolling user's row, which Postgres refuses without UPDATE on some
--       column; updated_at is the one column whose value means nothing to
--       security. 0023's guard trigger passes every role but kasuwa_app
--       through, so this column grant is the whole of what bounds kasuwa_auth
--       on "user", and the assertion below pins it.
--     tenant, user_programme: SELECT. withAuthTransaction confirms a tenant
--       by id; withTenantTransaction (the /auth/me/mfa/* routes run one on the
--       auth pool) resolves programme scope from user_programme.
--     schema app: USAGE; EXECUTE on the four context accessors the policies
--       above call, and on app.resolve_tenant_by_slug (sign-in has to find a
--       tenant before it has one). NOT app.resolve_session: the auth module
--       resolves a token on the app pool, so the second SECURITY DEFINER
--       function stays with the role it was argued for.
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
-- table to kasuwa_app, and names kasuwa_auth nowhere. A new auth table must
-- repeat this file's revoke and grant explicitly.
--
-- EXPAND AND CONTRACT IN ONE FILE, KNOWINGLY. The grants to kasuwa_auth are the
-- expand; the revoke from kasuwa_app is the contract. An API built before
-- T-0049 writes the auth tables as kasuwa_app, so against a database that has
-- run this file every sign-in it serves is 42501 until the new API (which
-- needs DATABASE_AUTH_URL) is deployed. That is acceptable only because no
-- populated cell exists (D-L65). Once one does, a change like this ships as two
-- migrations: the grants with the code that uses them, and the revoke in a
-- later release.
--
-- ROLLBACK: a later migration that re-grants kasuwa_app INSERT, UPDATE and
-- DELETE on the five tables (on user_mfa_backup_code, UPDATE on used_at only,
-- as 0017 had it), deployed with an API that no longer reads
-- DATABASE_AUTH_URL. kasuwa_auth's grants can stay; they widen nothing.
--
-- LOCKS (D-L65). Catalogue-only: GRANT and REVOKE rewrite pg_class.relacl and
-- scan nothing. Fail fast rather than queue behind a long transaction holding
-- "user" and block every session resolution behind this one.
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
      '< packages/db/sql/bootstrap.sql` (it is idempotent; `pnpm dev` does this for '
      'you), or drop the dev volume and run `pnpm dev`. See packages/db/CLAUDE.md.';
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

-- --- kasuwa_app loses every write on the five auth tables --------------------
-- A table-level REVOKE also revokes the matching column privileges, which is
-- what removes 0017's UPDATE (used_at) on user_mfa_backup_code. PUBLIC holds
-- nothing today; revoked anyway so that this file states the whole rule.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON auth_session, auth_challenge, user_credential, user_mfa_factor, user_mfa_backup_code
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

GRANT SELECT, INSERT, DELETE
  ON auth_session, auth_challenge, user_credential, user_mfa_factor, user_mfa_backup_code,
     auth_rate_limit
  TO kasuwa_auth;

GRANT UPDATE (revoked_at) ON auth_session TO kasuwa_auth;
GRANT UPDATE (method, attempt_count, consumed_at) ON auth_challenge TO kasuwa_auth;
GRANT UPDATE (password_hash, password_updated_at, updated_at) ON user_credential TO kasuwa_auth;
GRANT UPDATE (confirmed_at, last_used_step, updated_at) ON user_mfa_factor TO kasuwa_auth;
GRANT UPDATE (used_at) ON user_mfa_backup_code TO kasuwa_auth;
GRANT UPDATE (failed_count, first_failed_at, last_failed_at, locked_until)
  ON auth_rate_limit TO kasuwa_auth;

GRANT SELECT ON tenant, user_programme, "user" TO kasuwa_auth;
GRANT UPDATE (updated_at) ON "user" TO kasuwa_auth;

-- --- prove it ----------------------------------------------------------------
-- Read with the privilege functions, which see every route a privilege can
-- take (direct, PUBLIC, column-level, inherited), not information_schema.
DO $$
DECLARE
  auth_role constant pg_catalog.oid := 'kasuwa_auth'::pg_catalog.regrole;
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  auth_tables constant pg_catalog.regclass[] := ARRAY[
    'public.auth_session'::pg_catalog.regclass,
    'public.auth_challenge'::pg_catalog.regclass,
    'public.user_credential'::pg_catalog.regclass,
    'public.user_mfa_factor'::pg_catalog.regclass,
    'public.user_mfa_backup_code'::pg_catalog.regclass
  ];
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
  extra text;
BEGIN
  -- 1. kasuwa_app, PUBLIC and every role kasuwa_app can reach by membership
  --    hold no write on the five tables, bar the D-L66 sweeper's DELETE.
  SELECT pg_catalog.string_agg(r.rolname || ' ' || t.rel::text || ':' || p.priv, ', '
                               ORDER BY r.rolname, t.rel::text, p.priv)
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
   CROSS JOIN pg_catalog.unnest(auth_tables) AS t(rel)
   CROSS JOIN pg_catalog.unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
   WHERE CASE
           WHEN p.priv IN ('INSERT', 'UPDATE')
             THEN pg_catalog.has_any_column_privilege(r.rolname, t.rel::pg_catalog.oid, p.priv)
           ELSE pg_catalog.has_table_privilege(r.rolname, t.rel::pg_catalog.oid, p.priv)
         END
     AND NOT (r.rolname = 'kasuwa_sweeper' AND p.priv = 'DELETE'
              AND t.rel IN ('public.auth_session'::pg_catalog.regclass,
                            'public.auth_challenge'::pg_catalog.regclass));
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

  -- 3. Column-level: SELECT and INSERT on the six, SELECT on the three read
  --    tables, UPDATE on exactly the columns granted above, no REFERENCES.
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
     AND NOT (p.priv IN ('SELECT', 'INSERT') AND c.oid = ANY (writable))
     AND NOT (p.priv = 'SELECT' AND c.oid = ANY (read_only))
     AND NOT (p.priv = 'UPDATE' AND (c.oid, a.attname::text) IN (
           ('public.auth_session'::pg_catalog.regclass, 'revoked_at'),
           ('public.auth_challenge'::pg_catalog.regclass, 'method'),
           ('public.auth_challenge'::pg_catalog.regclass, 'attempt_count'),
           ('public.auth_challenge'::pg_catalog.regclass, 'consumed_at'),
           ('public.user_credential'::pg_catalog.regclass, 'password_hash'),
           ('public.user_credential'::pg_catalog.regclass, 'password_updated_at'),
           ('public.user_credential'::pg_catalog.regclass, 'updated_at'),
           ('public.user_mfa_factor'::pg_catalog.regclass, 'confirmed_at'),
           ('public.user_mfa_factor'::pg_catalog.regclass, 'last_used_step'),
           ('public.user_mfa_factor'::pg_catalog.regclass, 'updated_at'),
           ('public.user_mfa_backup_code'::pg_catalog.regclass, 'used_at'),
           ('public.auth_rate_limit'::pg_catalog.regclass, 'failed_count'),
           ('public.auth_rate_limit'::pg_catalog.regclass, 'first_failed_at'),
           ('public.auth_rate_limit'::pg_catalog.regclass, 'last_failed_at'),
           ('public.auth_rate_limit'::pg_catalog.regclass, 'locked_until'),
           ('public."user"'::pg_catalog.regclass, 'updated_at')));
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

  -- 5. Everything kasuwa_auth can touch is ENABLE + FORCE row level security:
  --    the role is bounded by the policies, so a table without them would be
  --    a cross-tenant read on the auth pool.
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO extra
    FROM pg_catalog.pg_class c
   WHERE c.oid = ANY (writable || read_only)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_auth can reach a table without ENABLE + FORCE RLS: %', extra;
  END IF;

  -- 6. No policy names kasuwa_auth: the PUBLIC policies are the whole rule.
  SELECT pg_catalog.string_agg(p.tablename || '.' || p.policyname, ', ') INTO extra
    FROM pg_catalog.pg_policies p
   WHERE 'kasuwa_auth' = ANY (p.roles);
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'a policy names kasuwa_auth (T-0049 adds none): %', extra;
  END IF;

  -- 7. Of the two SECURITY DEFINER functions, kasuwa_auth may run only the
  --    slug resolver, and PUBLIC may run neither (0003's rule, re-checked
  --    because this file grants on one of them).
  IF NOT pg_catalog.has_function_privilege(auth_role, 'app.resolve_tenant_by_slug(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'kasuwa_auth cannot resolve a workspace slug; sign-in cannot start.';
  END IF;
  IF pg_catalog.has_function_privilege(auth_role, 'app.resolve_session(bytea)', 'EXECUTE') THEN
    RAISE EXCEPTION 'kasuwa_auth can EXECUTE app.resolve_session; T-0049 keeps it on kasuwa_app.';
  END IF;
  IF pg_catalog.has_function_privilege('public', 'app.resolve_session(bytea)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'app.resolve_tenant_by_slug(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a SECURITY DEFINER function is executable by PUBLIC; REVOKE ALL ... FROM PUBLIC.';
  END IF;

  -- 8. It may create nothing, so it can own nothing (an owner can disable RLS).
  IF pg_catalog.has_database_privilege(auth_role, pg_catalog.current_database(), 'CREATE')
     OR pg_catalog.has_schema_privilege(auth_role, 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege(auth_role, 'app', 'CREATE') THEN
    RAISE EXCEPTION 'kasuwa_auth may CREATE in the database or a schema (T-0049 I1).';
  END IF;
END
$$;
