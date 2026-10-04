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
--   * The policies below are `TO kasuwa_sweeper` only, FOR SELECT and FOR
--     DELETE, and the predicate of each IS the retention rule. Under the
--     sweeper, no SQL can read or delete a live row, because no policy admits
--     one. The ordinary policies (TO PUBLIC) still apply too and are ORed in;
--     in the prune's transaction no tenant and no key are set, so they admit
--     nothing.
--   * Grants: SELECT and DELETE on the three tables. No INSERT, no UPDATE, so
--     neither WITH CHECK nor an UPDATE policy has anything to guard. (The
--     same is why the prune cannot use FOR UPDATE SKIP LOCKED: a row-locking
--     SELECT needs UPDATE. It uses a transaction-scoped advisory lock per
--     table instead.)
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
--
-- now() here is the transaction's start time, read by the database, not by
-- the caller: a sweeper transaction cannot move the line by lying about the
-- date.
--
-- kasuwa_app's own policies are UNCHANGED. A kasuwa_app transaction with no
-- context still sees no auth row, and tenant A still sees none of tenant B's;
-- tests/acceptance/platform/auth-retention.acceptance.test.ts asserts both.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- the role must be what D-L66 says it is ---------------------------------
-- Asserted, not assumed: bootstrap.sql is applied outside the migration runner,
-- and every property below is load-bearing.
DO $$
DECLARE
  sweeper pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO sweeper FROM pg_roles WHERE rolname = 'kasuwa_sweeper';
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'kasuwa_sweeper does not exist. Apply packages/db/sql/bootstrap.sql '
      '(D-L66) before migration 0020.';
  END IF;
  IF sweeper.rolbypassrls OR sweeper.rolsuper OR sweeper.rolcanlogin
     OR sweeper.rolcreaterole OR sweeper.rolcreatedb THEN
    RAISE EXCEPTION
      'kasuwa_sweeper must be NOLOGIN, NOBYPASSRLS, NOSUPERUSER, NOCREATEROLE '
      'and NOCREATEDB (D-L66). Its policies are the only thing bounding it.';
  END IF;
  IF NOT pg_has_role('kasuwa_app', 'kasuwa_sweeper', 'SET') THEN
    RAISE EXCEPTION
      'kasuwa_app cannot SET ROLE kasuwa_sweeper; the sweep cannot run (D-L66).';
  END IF;
  IF pg_has_role('kasuwa_app', 'kasuwa_sweeper', 'USAGE') THEN
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

GRANT SELECT, DELETE ON auth_challenge, auth_session, auth_rate_limit TO kasuwa_sweeper;

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
-- The sweeper must hold no privilege on any other table, and no policy on any
-- other table may name it. A later "GRANT ... ON ALL TABLES" would make it a
-- second kasuwa_app with a different set of holes.
DO $$
DECLARE
  extra text;
BEGIN
  SELECT string_agg(DISTINCT table_name || ':' || privilege_type, ', ') INTO extra
    FROM information_schema.role_table_grants
   WHERE grantee = 'kasuwa_sweeper'
     AND NOT (table_name IN ('auth_challenge', 'auth_session', 'auth_rate_limit')
              AND privilege_type IN ('SELECT', 'DELETE'));
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_sweeper holds privileges beyond D-L66: %', extra;
  END IF;
END
$$;
