-- ---------------------------------------------------------------------------
-- 0023 - who may UPDATE a "user" row (T-0048; team/DECISIONS.md D-L55, D-L53).
--        D-A3: changes the write rules on an RLS-guarded table -> @acexode.
--
-- THE GAP. 0015 column-grants UPDATE (email, display_name, locale, status,
-- role_id, updated_at) on "user" to kasuwa_app, and 0001's user_isolation
-- checks only the tenant. So any session in a tenant - including one that
-- reaches no programme - could set the tenant admin's status to 'disabled'
-- (a lockout: app.resolve_session requires 'active'), or rewrite another
-- member's email (a takeover path once email recovery exists). Found by the
-- T-0047 suite.
--
-- THE RULE, enforced by a BEFORE UPDATE row trigger for kasuwa_app:
--   * email never changes on the app role, for anyone, admin or not (U4):
--     there is no verified-change flow yet. When one is built it opens this
--     deliberately, in its own migration.
--   * a tenant admin ("user".is_tenant_admin for app.current_user_id() within
--     app.current_tenant_id(), D-L53) may change any other granted column of
--     any user RLS lets it reach - i.e. tenant-wide, never another tenant
--     (user_isolation still filters that to 0 rows). Programme scope is not
--     consulted: user administration is a tenant-level write (U3).
--   * anyone else - including an authentication transaction, which has a
--     tenant and no app.user_id - may touch only its own row, and only with
--     status and role_id unchanged. Everything else raises 42501.
--   * every role other than kasuwa_app passes through untouched: the migrator
--     (seed, provisioning, packages/testing's disableSeededUser) must keep
--     working, and a trigger fires for BYPASSRLS roles too. kasuwa_sweeper,
--     the only role kasuwa_app can SET ROLE to, holds no UPDATE on "user"
--     (0020 asserts its privileges), so the pass-through gives it nothing.
--
-- WHY A TRIGGER AND NOT A POLICY (suite header U2).
--   lockUserForFactorWrite (apps/api/src/auth/mfa-store.ts) takes
--   SELECT ... FROM "user" ... FOR UPDATE on the enrolling user's own row,
--   including inside withAuthTransaction where app.user_id is EMPTY.
--   PostgreSQL applies FOR UPDATE policies' USING to row locks, so a
--   restrictive FOR UPDATE policy that filters on the session's user or on
--   tenant admin would turn that lock into a silent 0-row no-op and reopen the
--   T-0012 enrolment race. A trigger does not run for SELECT ... FOR UPDATE at
--   all, and it raises rather than filters. 42501 does not breach CLAUDE.md
--   6.4: every member can already SELECT every "user" row of its tenant.
--   A "user" policy that subqueried "user" would also recurse; a trigger
--   reading "user" is an ordinary query under user_isolation (tenant-only, no
--   subquery), so there is no recursion.
--
-- NOT A DEFINER (CLAUDE.md 2.7). The function is SECURITY INVOKER: its read of
-- is_tenant_admin runs as kasuwa_app under user_isolation, exactly like 0021's
-- policies. search_path is pinned; EXECUTE is revoked from PUBLIC (firing a
-- trigger needs no EXECUTE privilege). The definer census stays at two.
--
-- COVERAGE. A FOR EACH ROW BEFORE UPDATE trigger fires for every row of a
-- bulk UPDATE and for the DO UPDATE arm of INSERT ... ON CONFLICT. No FK on
-- another table cascades an UPDATE into "user" (role_id's FK is NO ACTION),
-- and referential actions run as the table owner anyway.
--
-- RESIDUAL, recorded and not closed (ADR-0010 class, same as 0021): app.user_id
-- is a GUC kasuwa_app can re-set mid-transaction to an admin's id and restore
-- before COMMIT. Out of scope here as it is for every policy reading it.
-- Last-admin self-deactivation is ruled an application concern (suite header).
--
-- ORDER. Triggers fire in name order: user_touch_updated_at (0018) runs
-- before zz_user_update_guard. It only sets updated_at, which the guard does not
-- compare, so the order does not change any decision.
-- ---------------------------------------------------------------------------

-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on "user", which blocks writers
-- (and queues behind any open writer). Catalogue-only, quick once held; fail
-- fast rather than stall sign-in. Transaction-local: the runner wraps each
-- file.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION app.guard_user_update() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  -- Guarded whenever EITHER identity is the app role (migration-reviewer,
  -- T-0048): a SET ROLE from an app connection stays guarded even if some
  -- future role it can enter is ever granted UPDATE on "user". Only genuine
  -- non-app sessions (the migrator, the seed) pass through.
  IF current_user <> 'kasuwa_app' AND session_user <> 'kasuwa_app' THEN
    RETURN NEW;
  END IF;

  -- Messages name the rule, never a value or an id: error text reaches logs.
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'user.email cannot be changed by the application role'
      USING ERRCODE = 'insufficient_privilege';  -- 42501
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public."user" u
     WHERE u.tenant_id = app.current_tenant_id()
       AND u.id = app.current_user_id()
       AND u.is_tenant_admin
       AND u.status = 'active'
  ) THEN
    RETURN NEW;
  END IF;

  IF OLD.id = app.current_user_id()
     AND OLD.tenant_id = app.current_tenant_id()
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.role_id IS NOT DISTINCT FROM OLD.role_id
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'only a tenant admin may change this user'
    USING ERRCODE = 'insufficient_privilege';  -- 42501
END;
$$;

REVOKE ALL ON FUNCTION app.guard_user_update() FROM PUBLIC;

-- Named to sort LAST among BEFORE UPDATE triggers on "user" (they fire in name
-- order): a later trigger that rewrote NEW.email/status/role_id after the
-- guard would otherwise slip past it.
CREATE TRIGGER zz_user_update_guard
  BEFORE UPDATE ON "user"
  FOR EACH ROW
  EXECUTE FUNCTION app.guard_user_update();
