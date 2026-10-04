-- ---------------------------------------------------------------------------
-- 0020 - the auth-table sweep's policies: kasuwa_sweeper reaches only dead
--        rows (T-0045, D-L66, ADR-0012; amends ADR-0009 and 0004's header).
--
-- auth_challenge, auth_session and auth_rate_limit grow without bound unless
-- something deletes from them; auth_rate_limit grows with attacker traffic.
-- The sweep that prunes them (`pruneAuthTables`, packages/db/src/
-- auth-retention.ts) runs in apps/worker as kasuwa_app, and against the
-- policies as they stand kasuwa_app can prune nothing across tenants: the
-- tenant policies need app.tenant_id, and the rate-limit policy needs the
-- row's own key presented. A sweep knows neither.
--
-- 0004's header said the sweep "must run as the migrator, which is BYPASSRLS".
-- D-L66 overrules that: a BYPASSRLS connection in a long-running worker is the
-- escape hatch CLAUDE.md 2.1 and db invariant 6 rule out. Nor is a third
-- SECURITY DEFINER function acceptable (CLAUDE.md 2.7). Instead:
--
--   * `kasuwa_sweeper` (packages/db/sql/bootstrap.sql): NOLOGIN, NOBYPASSRLS,
--     granted to kasuwa_app WITH INHERIT FALSE, SET TRUE. kasuwa_app can enter
--     it with SET LOCAL ROLE and otherwise gets nothing from it - in
--     particular the policies below do NOT apply to a plain kasuwa_app
--     session, because a policy TO a role applies to sessions that have that
--     role's privileges, and NOINHERIT membership does not confer them.
--
--     SET membership is also a way IN for any SQL on a kasuwa_app connection
--     (`SET ROLE`, or `set_config('role', ...)` inside a SELECT). That is why
--     withTenantTransaction and withAuthTransaction verify, at start and at
--     commit, that current_user is still session_user, and reset the role
--     before a connection goes back to the pool (T-0045 security review).
--
--   * The policies below are `TO kasuwa_sweeper` only, FOR SELECT and FOR
--     DELETE, and the predicate of each IS the retention rule. The ordinary
--     policies (TO PUBLIC) still apply to the sweeper as well and are ORed in,
--     so what bounds the sweeper is "dead by retention, OR admitted by the
--     ordinary policy for the context in force". `pruneAuthTables` clears the
--     tenant and key GUCs and asserts that both accessors return NULL after
--     entering the role, so in the sweep's transaction the second half admits
--     nothing and only dead rows are reachable.
--
--   * Privileges: DELETE on the three tables, and SELECT on only the columns
--     the sweep reads - the key it deletes by and the timestamps of the rule.
--     No token hash, no user id, no tenant id, no counter. No INSERT, no
--     UPDATE, so neither WITH CHECK nor an UPDATE policy has anything to guard.
--     (The same is why the prune cannot use FOR UPDATE SKIP LOCKED: a
--     row-locking SELECT needs UPDATE. It uses a transaction-scoped advisory
--     lock per table instead.) RLS policy expressions are not subject to the
--     querying role's column privileges, so the ordinary policies, which read
--     tenant_id, still evaluate for the sweeper.
--
-- RETENTION, which the prune's own WHERE clauses repeat against the caller's
-- `now` as the second layer (CLAUDE.md 2.3):
--
--   auth_challenge   expires_at more than 1 day ago.
--   auth_session     expired, or revoked, more than 30 days ago.
--   auth_rate_limit  last failure more than 1 day ago AND no lock in force.
--                    One day is the longest failure window the API accepts
--                    (KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES max 1440), so the
--                    window has lapsed under every permitted configuration.
--                    If that maximum is ever raised, this policy must follow
--                    in a new migration, or the sweep resets live countdowns.
--                    apps/worker's unit tests pin the two together.
--
-- now() here is the transaction's start time, read by the database, not by
-- the caller: a sweeper transaction cannot move the line by lying about the
-- date.
--
-- kasuwa_app's own policies are UNCHANGED. A kasuwa_app transaction with no
-- context still sees no auth row, and tenant A still sees none of tenant B's;
-- tests/acceptance/platform/auth-retention.acceptance.test.ts asserts both.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '2s';

-- --- the role must be what D-L66 says it is ---------------------------------
-- Asserted, not assumed: bootstrap.sql is applied outside the migration runner,
-- and every property below is load-bearing.
DO $$
DECLARE
  sweeper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO sweeper FROM pg_catalog.pg_roles WHERE rolname = 'kasuwa_sweeper';
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'kasuwa_sweeper does not exist: this database was bootstrapped before D-L66. '
      'Re-apply the bootstrap as the superuser, then migrate again. Local dev: '
      '`docker exec -i kasuwa-postgres psql -U postgres -d kasuwa -v ON_ERROR_STOP=1 '
      '< packages/db/sql/bootstrap.sql` (it is idempotent), or drop the dev volume '
      '(`docker compose down`, then `docker volume rm <project>_kasuwa-pgdata`, '
      'see `docker volume ls`) and run `pnpm dev`. See packages/db/CLAUDE.md.';
  END IF;
  IF sweeper.rolbypassrls OR sweeper.rolsuper OR sweeper.rolcanlogin
     OR sweeper.rolcreaterole OR sweeper.rolcreatedb OR sweeper.rolreplication THEN
    RAISE EXCEPTION
      'kasuwa_sweeper must be NOLOGIN, NOBYPASSRLS, NOSUPERUSER, NOCREATEROLE, '
      'NOCREATEDB and NOREPLICATION (D-L66). Its policies are the only thing bounding it.';
  END IF;
  IF NOT pg_catalog.pg_has_role('kasuwa_app', 'kasuwa_sweeper', 'SET') THEN
    RAISE EXCEPTION
      'kasuwa_app cannot SET ROLE kasuwa_sweeper; the sweep cannot run (D-L66).';
  END IF;
  IF pg_catalog.pg_has_role('kasuwa_app', 'kasuwa_sweeper', 'USAGE') THEN
    RAISE EXCEPTION
      'kasuwa_app INHERITS kasuwa_sweeper. The sweeper''s dead-row policies '
      'would then apply to every kasuwa_app session: a forgotten tenant '
      'context becomes a cross-tenant read. Grant it WITH INHERIT FALSE.';
  END IF;
END
$$;

-- --- privileges --------------------------------------------------------------
-- The ordinary (TO PUBLIC) policies on these tables call the accessors below,
-- and they are evaluated for the sweeper too. In its transaction both return
-- NULL and admit nothing; the grants only let the evaluation run.
GRANT USAGE ON SCHEMA app TO kasuwa_sweeper;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO kasuwa_sweeper;
GRANT EXECUTE ON FUNCTION app.current_rate_limit_key() TO kasuwa_sweeper;

GRANT SELECT (id, expires_at) ON auth_challenge TO kasuwa_sweeper;
GRANT SELECT (id, expires_at, revoked_at) ON auth_session TO kasuwa_sweeper;
GRANT SELECT (key_hash, last_failed_at, locked_until) ON auth_rate_limit TO kasuwa_sweeper;
GRANT DELETE ON auth_challenge, auth_session, auth_rate_limit TO kasuwa_sweeper;

-- --- auth_challenge ----------------------------------------------------------
CREATE POLICY auth_challenge_sweep_select ON auth_challenge
  FOR SELECT TO kasuwa_sweeper
  USING (expires_at < now() - interval '1 day');
CREATE POLICY auth_challenge_sweep_delete ON auth_challenge
  FOR DELETE TO kasuwa_sweeper
  USING (expires_at < now() - interval '1 day');

-- --- auth_session ------------------------------------------------------------
CREATE POLICY auth_session_sweep_select ON auth_session
  FOR SELECT TO kasuwa_sweeper
  USING (expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days');
CREATE POLICY auth_session_sweep_delete ON auth_session
  FOR DELETE TO kasuwa_sweeper
  USING (expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days');

-- --- auth_rate_limit ---------------------------------------------------------
CREATE POLICY auth_rate_limit_sweep_select ON auth_rate_limit
  FOR SELECT TO kasuwa_sweeper
  USING (last_failed_at < now() - interval '1 day'
         AND (locked_until IS NULL OR locked_until < now()));
CREATE POLICY auth_rate_limit_sweep_delete ON auth_rate_limit
  FOR DELETE TO kasuwa_sweeper
  USING (last_failed_at < now() - interval '1 day'
         AND (locked_until IS NULL OR locked_until < now()));

-- --- prove nothing else reaches the sweeper ---------------------------------
-- Read from the catalogue with the privilege functions, which see every route
-- a privilege can take (direct, PUBLIC, column-level), rather than from
-- information_schema, which shows only grants the current role can see.
-- A later "GRANT ... ON ALL TABLES", a stray policy or a role membership would
-- make the sweeper a second kasuwa_app with a different set of holes.
DO $$
DECLARE
  sweeper constant pg_catalog.oid := 'kasuwa_sweeper'::pg_catalog.regrole;
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  allowed_tables constant pg_catalog.oid[] := ARRAY[
    'public.auth_challenge'::pg_catalog.regclass,
    'public.auth_session'::pg_catalog.regclass,
    'public.auth_rate_limit'::pg_catalog.regclass
  ]::pg_catalog.oid[];
  extra text;
BEGIN
  -- Table-level privileges: DELETE on the three tables, nothing else anywhere.
  -- SELECT is column-level only, so table-level SELECT must be false too.
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text || ':' || p.priv, ', ')
    INTO extra
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                      'REFERENCES', 'TRIGGER']) AS p(priv)
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_toast%'
     AND pg_catalog.has_table_privilege(sweeper, c.oid, p.priv)
     AND NOT (c.oid = ANY (allowed_tables) AND p.priv = 'DELETE');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_sweeper holds table privileges beyond D-L66: %', extra;
  END IF;

  -- Sequences: none.
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text, ', ') INTO extra
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'S'
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND (pg_catalog.has_sequence_privilege(sweeper, c.oid, 'USAGE')
       OR pg_catalog.has_sequence_privilege(sweeper, c.oid, 'SELECT')
       OR pg_catalog.has_sequence_privilege(sweeper, c.oid, 'UPDATE'));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_sweeper holds sequence privileges: %', extra;
  END IF;

  -- Column-level privileges: SELECT on exactly the columns granted above.
  SELECT pg_catalog.string_agg(c.oid::pg_catalog.regclass::text || '.' || a.attname || ':' || p.priv, ', ')
    INTO extra
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
   CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p(priv)
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_toast%'
     AND pg_catalog.has_column_privilege(sweeper, c.oid, a.attnum, p.priv)
     AND NOT (p.priv = 'SELECT' AND (c.oid, a.attname::text) IN (
           ('public.auth_challenge'::pg_catalog.regclass, 'id'),
           ('public.auth_challenge'::pg_catalog.regclass, 'expires_at'),
           ('public.auth_session'::pg_catalog.regclass, 'id'),
           ('public.auth_session'::pg_catalog.regclass, 'expires_at'),
           ('public.auth_session'::pg_catalog.regclass, 'revoked_at'),
           ('public.auth_rate_limit'::pg_catalog.regclass, 'key_hash'),
           ('public.auth_rate_limit'::pg_catalog.regclass, 'last_failed_at'),
           ('public.auth_rate_limit'::pg_catalog.regclass, 'locked_until')));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_sweeper holds column privileges beyond D-L66: %', extra;
  END IF;

  -- Policies: only the six above name the sweeper, and only for SELECT/DELETE.
  SELECT pg_catalog.string_agg(p.schemaname || '.' || p.tablename || '.' || p.policyname, ', ')
    INTO extra
    FROM pg_catalog.pg_policies p
   WHERE 'kasuwa_sweeper' = ANY (p.roles)
     AND NOT (p.schemaname = 'public'
              AND p.tablename IN ('auth_challenge', 'auth_session', 'auth_rate_limit')
              AND p.cmd IN ('SELECT', 'DELETE'));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'a policy names kasuwa_sweeper outside D-L66: %', extra;
  END IF;

  -- Memberships: the sweeper belongs to no role, kasuwa_app is its only
  -- member, and kasuwa_app cannot grant it onward.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = sweeper) THEN
    RAISE EXCEPTION 'kasuwa_sweeper is a member of another role; it must inherit nothing.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
              WHERE m.roleid = sweeper AND m.member <> app_role) THEN
    RAISE EXCEPTION 'a role other than kasuwa_app is a member of kasuwa_sweeper.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
              WHERE m.roleid = sweeper AND m.member = app_role AND m.admin_option) THEN
    RAISE EXCEPTION 'kasuwa_app holds kasuwa_sweeper WITH ADMIN OPTION; revoke the admin option.';
  END IF;
END
$$;
