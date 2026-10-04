-- ---------------------------------------------------------------------------
-- 0021 - who may assign a permission set, and who may remove a membership
--        (T-0046; team/DECISIONS.md D-L55, D-L53, D-L51). D-A3: changes RLS
--        policies -> @acexode.
--
-- Closes the two user_programme gaps the T-0032 security review left open.
-- Three RESTRICTIVE policies. Restrictive policies are AND-ed with every
-- permissive one, so each can only narrow what 0001's user_programme_isolation
-- and 0015's two scope policies already allow. No permissive policy is added,
-- so the permissive-INSERT allow-list (permissions acceptance) is unchanged.
--
-- THE SESSION'S USER, AND WHY THERE IS NO NEW DEFINER (CLAUDE.md 2.7).
--   "Is the session a tenant admin" is read the way every other policy reads
--   the session: app.current_user_id() against "user".is_tenant_admin (D-L53),
--   by a plain subquery that runs as kasuwa_app under "user"'s own RLS. That
--   policy (0001 user_isolation) is tenant-scoped and does not read
--   user_programme, so the subquery sees the session's own user row and cannot
--   recurse. kasuwa_app cannot write is_tenant_admin (0015 column privileges),
--   so a session cannot make itself an admin. No SECURITY DEFINER function,
--   view or owner trick is involved; the definer census stays at two.
--
--   RESIDUAL, recorded and not closed (ADR-0010 class): app.user_id is a GUC
--   kasuwa_app can re-set mid-transaction to a tenant admin's id and restore
--   before COMMIT. withTenantTransaction's scope seal detects a change still
--   in force at COMMIT; it does not detect a change that was restored. No
--   design without a new role or a definer closes this; the same residual
--   already applies to every policy that reads app.user_id.
--
-- 1. user_programme_update_by_tenant_admin  (FOR UPDATE, D-L55 gap 1)
--
--    USING requires the session's user to be a tenant admin, so for anyone
--    else every UPDATE of user_programme is FILTERED: 0 rows, no error. That
--    is the same answer an out-of-scope UPDATE already gets, so the refusal
--    does not reveal that the row exists (CLAUDE.md 6.4). It covers the whole
--    row, not only permission_set_id: rewriting user_id (taking over another
--    member's `admin` membership) or programme_id is an assignment too, and a
--    column privilege would miss it. A tenant admin is still bounded by 0015's
--    user_programme_update_in_scope: tenant admin never widens scope (D-L53 M4).
--    INSERT ... ON CONFLICT DO UPDATE by a non-admin is refused here as well
--    (an upsert raises on a failed UPDATE USING rather than filtering), and in
--    any case policy 2 refuses the proposed row first if it carries a set.
--    WITH CHECK is identical to USING.
--
--    No application code updates user_programme today; the only writers are
--    createProgramme (INSERT, as a tenant admin), the seed and provisioning
--    (both kasuwa_migrator, which bypasses RLS).
--
-- 2. user_programme_insert_set_by_tenant_admin  (FOR INSERT, D-L55 gap 1)
--
--    A membership INSERTed WITH a permission set is an assignment as surely as
--    an UPDATE. Without this, a non-admin could delete his own membership and
--    insert it back carrying `admin`. WITH CHECK admits a row whose
--    permission_set_id is NULL (no permission, D-P9 M1) from anyone 0015
--    already admits, and a row carrying a set only from a tenant admin. A WITH
--    CHECK cannot filter, so a refused INSERT is 42501, and the whole
--    transaction (including any DELETE before it) rolls back.
--    createProgramme's creator enrolment inserts the `admin` set: it is a
--    tenant-level write that already requires tenant admin (D-L53), so it is
--    unaffected.
--
-- 3. user_programme_delete_in_scope  (FOR DELETE, D-L55 gap 2)
--
--    DELETE was tenant-only (0001). It now requires BOTH:
--      (a) programme scope, like INSERT (D-L51): a membership in a programme
--          the session does not reach is filtered, 0 rows; AND
--      (b) a tenant-admin session, the same check as policy 1 (lead ruling on
--          the T-0046 review). Without it, any member of a programme could
--          delete the tenant admin's membership there: a lockout. It is also
--          defence in depth behind the T-0032 engine. A non-admin DELETE is
--          filtered, 0 rows, the same answer as "no such row" (CLAUDE.md 6.4).
--    Tenant admin never widens scope: (a) still bounds an admin (D-L53 M4).
--    Unlike 0015's INSERT and UPDATE policies this one has NO creation-marker
--    branch, deliberately. No code path deletes a membership of a programme
--    created in the same transaction, and without the branch the marker forge
--    (UPDATE a reachable programme to stamp its xmin, then delete in an
--    unreachable one) has nothing to borrow. A tenant admin can still delete
--    his own membership in a programme he reaches; the narrowed scope applies
--    from the next transaction, because scope is resolved once at transaction
--    start. No application code deletes from user_programme today (checked
--    for T-0046). FK cascades from "user" or programme are referential
--    actions, which bypass row security, so they are unaffected.
--
--    NOT changed, and recorded: a non-admin may still INSERT a membership with
--    a NULL set into a programme he reaches. It grants no permission; it is
--    the engine's application-level decision until an endpoint that writes
--    memberships exists.
-- ---------------------------------------------------------------------------

-- CREATE POLICY takes ACCESS EXCLUSIVE on user_programme until COMMIT. The
-- change is catalogue-only (no scan, no rewrite), so it is quick once the lock
-- is held; fail fast rather than queue behind a long transaction and block
-- every session resolution behind it. Transaction-local: the runner wraps each
-- file.
-- ROW LOCKS (migration-reviewer, T-0046): PostgreSQL applies UPDATE policies'
-- USING to SELECT ... FOR UPDATE / FOR SHARE. Any row lock taken on
-- user_programme - directly, or a FOR UPDATE without OF on a join that includes
-- it - silently returns 0 rows to a non-admin. Never lock user_programme in
-- scope resolution or a join; it would fail closed into an outage.
--
-- 2s, not 5s: every request's scope resolution reads user_programme, and new
-- readers queue behind CREATE POLICY's ACCESS EXCLUSIVE while it waits.
SET LOCAL lock_timeout = '2s';

-- --- 1. only a tenant admin may change a membership ---------------------------

CREATE POLICY user_programme_update_by_tenant_admin ON user_programme
  AS RESTRICTIVE
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
        FROM "user" u
       WHERE u.tenant_id = app.current_tenant_id()
         AND u.id = app.current_user_id()
         AND u.is_tenant_admin
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM "user" u
       WHERE u.tenant_id = app.current_tenant_id()
         AND u.id = app.current_user_id()
         AND u.is_tenant_admin
    )
  );

-- --- 2. only a tenant admin may insert a membership carrying a set ------------

CREATE POLICY user_programme_insert_set_by_tenant_admin ON user_programme
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    permission_set_id IS NULL
    OR EXISTS (
      SELECT 1
        FROM "user" u
       WHERE u.tenant_id = app.current_tenant_id()
         AND u.id = app.current_user_id()
         AND u.is_tenant_admin
    )
  );

-- --- 3. membership DELETE is programme-scoped ---------------------------------

CREATE POLICY user_programme_delete_in_scope ON user_programme
  AS RESTRICTIVE
  FOR DELETE
  USING (
    tenant_id = app.current_tenant_id()
    AND programme_id = ANY (app.current_programme_ids())
    AND EXISTS (
      SELECT 1
        FROM "user" u
       WHERE u.tenant_id = app.current_tenant_id()
         AND u.id = app.current_user_id()
         AND u.is_tenant_admin
    )
  );
