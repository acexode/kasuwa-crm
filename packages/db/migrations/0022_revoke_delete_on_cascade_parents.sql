-- ---------------------------------------------------------------------------
-- 0022 - kasuwa_app may not DELETE "user", programme, business_unit or tenant
--        (T-0047; team/DECISIONS.md D-L55, follow-up to T-0046 / 0021).
--        D-A3: changes privileges on tenancy tables -> @acexode.
--
-- THE HOLE. user_programme's parent FKs are ON DELETE CASCADE (0001), and so
-- are programme -> business_unit and every tenant-scoped table -> tenant. A
-- referential action bypasses row security. So whoever can DELETE one of these
-- four rows removes memberships (and contacts, and everything under a tenant)
-- without ever touching user_programme, and 0021's tenant-admin guard on
-- membership deletes never runs. The policies on all four were too weak to
-- stop it: "user", business_unit and tenant are tenant-scoped only (0001), so
--   * any session in the tenant, including one that reaches no programme,
--     could delete the tenant admin's "user" row - the lockout T-0046 closed
--     for direct membership deletes;
--   * an agent reaching only A1 could delete the business unit and take A2,
--     a programme outside his scope, with it, members and contacts included;
--   * any session could delete its own tenant row and empty the tenant.
-- In other words, the cascades from these tables cross the programme boundary.
--
-- WHY A REVOKE, NOT A POLICY (lead ruling on T-0047).
--   No application code deletes any of the four (grep of apps/ and packages/,
--   raw SQL and Drizzle, for T-0047). Users are DEACTIVATED ("user".status,
--   granted in 0015 and read by resolve_session); programmes are ARCHIVED
--   (archiveProgramme is a status UPDATE); tenant offboarding is an operator
--   job on kasuwa_migrator. A privilege nothing uses is only attack surface.
--   A REVOKE is one statement, visible in the catalogue, and costs nothing per
--   row. Its 42501 depends on the table, never on the row, so the refusal
--   reveals nothing about which rows exist (CLAUDE.md 6.4).
--
--   If a real delete path is ever needed, it comes back as a lead decision:
--   re-grant DELETE together with a restrictive policy in the style of 0021,
--   and change the T-0047 acceptance suite first.
--
-- WHAT IS NOT TOUCHED.
--   * kasuwa_migrator owns the tables and keeps every privilege; seed,
--     provisioning and offboarding still delete and cascade as before.
--   * kasuwa_test_admin keeps DELETE: it is the test-only role and never
--     serves traffic.
--   * No trigger: a BEFORE DELETE trigger would also fire for the migrator.
--   * No SECURITY DEFINER function (CLAUDE.md 2.7); the census stays at two.
--
-- DEFAULT PRIVILEGES. bootstrap.sql grants SELECT, INSERT, UPDATE, DELETE on
-- every FUTURE kasuwa_migrator table to kasuwa_app. That is unchanged: it is
-- right for most tables, and it cannot re-grant on these four, which already
-- exist. No migration after 0001 re-grants DELETE on them (checked for
-- T-0047). The assertion below runs once, here; a later re-grant is caught by
-- the T-0047 acceptance suite, which runs against every build.
-- ---------------------------------------------------------------------------

-- REVOKE takes a brief lock on each table's catalogue entry. Catalogue-only, so
-- quick once held; fail fast rather than queue behind a long transaction and
-- block every session resolution (which reads "user" and programme) behind it.
-- Transaction-local: the runner wraps each file.
SET LOCAL lock_timeout = '2s';

REVOKE DELETE ON "user", programme, business_unit, tenant FROM kasuwa_app;

-- --- prove kasuwa_app cannot remove a row from any of the four ---------------
-- has_table_privilege sees every route a privilege can take: a direct grant,
-- PUBLIC, and any role kasuwa_app inherits. TRUNCATE is checked too, because
-- TRUNCATE skips RLS entirely and would make the revoke moot (kasuwa_app holds
-- none today; bootstrap's default privileges never grant it).
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  held text;
BEGIN
  SELECT pg_catalog.string_agg(t.rel::text || ':' || p.priv, ', ' ORDER BY t.rel::text, p.priv)
    INTO held
    FROM pg_catalog.unnest(ARRAY[
           'public."user"'::pg_catalog.regclass,
           'public.programme'::pg_catalog.regclass,
           'public.business_unit'::pg_catalog.regclass,
           'public.tenant'::pg_catalog.regclass
         ]) AS t(rel)
   CROSS JOIN pg_catalog.unnest(ARRAY['DELETE', 'TRUNCATE']) AS p(priv)
   WHERE pg_catalog.has_table_privilege(app_role, t.rel, p.priv);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION 'kasuwa_app can still remove rows that cascade across programmes (T-0047): %', held;
  END IF;
END
$$;
