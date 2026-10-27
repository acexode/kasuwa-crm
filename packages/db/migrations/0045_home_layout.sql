-- ---------------------------------------------------------------------------
-- 0045 - home_layout: the P03 Home layout, per user, on the server (T-0159,
-- D-L196, D-L204). Until now it lived in the browser's localStorage.
--
-- WHAT IS HELD. One row per user: the user's role view (rep, manager, support,
-- bpo, exec) and an ordered list of at most 19 `{ type, span }` widget slots.
-- Widget types and widths only: no record, name, number or anything read from
-- another table. The vocabulary of `type` and `span` is validated at the API
-- boundary (zod, apps/api), not here: the widget list is a product decision
-- that changes without a migration, and the database holds a layout it cannot
-- misinterpret either way. The database does bound the SHAPE: an array, no
-- more than 19 entries, a closed role.
--
-- NO programme_id, ON PURPOSE (CLAUDE.md 2.3 asks for it on programme-scoped
-- data). A Home layout is about the person, not a programme: a workspace
-- user with no programme at all still has a Home, and a user in three
-- programmes has one layout, not three. The scope here is the tenant AND the
-- user, both from the session (app.current_tenant_id(), app.current_user_id()).
-- Nothing in the row is business data of any programme.
--
-- KEYS. Primary key (tenant_id, user_id): one layout per user, enforced by the
-- database. Referential checks ignore row security, so both foreign keys
-- carry tenant_id (the 0027 pattern):
--   - tenant_id -> tenant: ON DELETE CASCADE (offboarding; also what lets the
--     seed's TRUNCATE tenant CASCADE clear the table).
--   - (tenant_id, user_id) -> "user": ON DELETE CASCADE, so erasing a user
--     erases their layout. ON UPDATE RESTRICT on both, as everywhere.
-- Both are covered by the primary key's leading columns: no extra index.
--
-- TENANCY. ENABLED and FORCED; in TENANT_SCOPED_TABLES and the schema.ts
-- mirror. One policy, FOR ALL TO kasuwa_app (never PUBLIC):
--   home_layout_own: tenant_id = app.current_tenant_id() AND user_id =
--   app.current_user_id(), WITH CHECK identical to USING (CLAUDE.md 2.4). A
--   colleague, an admin and another tenant read and write nothing of it.
-- GRANTS: kasuwa_app gets SELECT, INSERT, DELETE, and UPDATE on (role, items,
-- updated_at) only: tenant, user and created_at never change after INSERT.
-- No TRUNCATE (it skips RLS), REFERENCES or TRIGGER. kasuwa_relay,
-- kasuwa_auth, kasuwa_sweeper and PUBLIC hold nothing. kasuwa_test_admin: full
-- DML, as for every table (inert outside development and test).
--
-- updated_at is kept by 0018's app.touch_updated_at(); this file defines no
-- second function.
--
-- NOT HERE: no SECURITY DEFINER function, no role, no extension, no new
-- app.* setting, and no migration of existing localStorage layouts (decided:
-- not worth it; the browser store stays as the flag-off path).
--
-- LOCK IMPACT (D-L65): tenant and "user" are held SHARE ROW EXCLUSIVE for the
-- file, which is what creating a foreign key that references them takes
-- anyway. lock_timeout = 5s refuses to queue behind a long transaction.
--
-- EXPAND ONLY: a new table with no reader in old code. Old API builds run
-- unchanged against it, and the flag `home_layout_server` is off by default.
--
-- ROLLBACK PLAN: if this file fails nothing was applied. To undo it after it
-- applied: never edit or delete it or its ledger row. Turn the flag off and
-- roll back the API route, the schema.ts mirror and the TENANT_SCOPED_TABLES
-- entry; then, in a NEW migration, DROP TABLE home_layout (which takes ACCESS
-- EXCLUSIVE on it and on tenant and "user" while it runs: SET LOCAL
-- lock_timeout, quiet window). Users fall back to their browser layout.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
LOCK TABLE tenant, "user" IN SHARE ROW EXCLUSIVE MODE;

-- --- 2. the table ------------------------------------------------------------
CREATE TABLE home_layout (
  tenant_id   uuid         NOT NULL,
  user_id     uuid         NOT NULL,
  role        text         NOT NULL,
  items       jsonb        NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT home_layout_pkey PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT home_layout_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT home_layout_user_same_tenant_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,

  CONSTRAINT home_layout_role_check
    CHECK (role IN ('rep', 'manager', 'support', 'bpo', 'exec')),
  CONSTRAINT home_layout_items_check
    CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) <= 19)
);

CREATE TRIGGER home_layout_touch_updated_at
  BEFORE UPDATE ON home_layout FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

-- --- 3. row-level security ---------------------------------------------------
ALTER TABLE home_layout ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_layout FORCE ROW LEVEL SECURITY;

CREATE POLICY home_layout_own ON home_layout FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND user_id = app.current_user_id())
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND user_id = app.current_user_id());

-- --- 4. grants ---------------------------------------------------------------
-- Explicit, so this file does not depend on the bootstrap's default
-- privileges (which would give kasuwa_app a table-level UPDATE).
REVOKE ALL ON home_layout
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT, DELETE ON home_layout TO kasuwa_app;
GRANT UPDATE (role, items, updated_at) ON home_layout TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON home_layout TO kasuwa_test_admin;

-- --- 5. prove the posture ----------------------------------------------------
-- Runs once, here. The standing guards are the T-0159 acceptance suite and
-- rls-enforcement, which run on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  rel constant pg_catalog.oid := 'public.home_layout'::pg_catalog.regclass;
  held text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c WHERE c.oid = rel) THEN
    RAISE EXCEPTION '0045: home_layout RLS is not enabled and forced';
  END IF;
  IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = rel))
     <> 'kasuwa_migrator' THEN
    RAISE EXCEPTION '0045: home_layout is not owned by kasuwa_migrator';
  END IF;

  -- kasuwa_app: SELECT, INSERT, DELETE, and UPDATE on role, items, updated_at.
  IF NOT (pg_catalog.has_table_privilege(app_role, rel, 'SELECT')
          AND pg_catalog.has_table_privilege(app_role, rel, 'INSERT')
          AND pg_catalog.has_table_privilege(app_role, rel, 'DELETE')
          AND pg_catalog.has_column_privilege(app_role, rel, 'items', 'UPDATE')) THEN
    RAISE EXCEPTION '0045: kasuwa_app cannot read and write home_layout';
  END IF;
  SELECT pg_catalog.string_agg(a.attname::text, ', ' ORDER BY a.attname)
    INTO held
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('role', 'items', 'updated_at')
     AND pg_catalog.has_column_privilege(app_role, rel, a.attname, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0045: kasuwa_app may UPDATE home_layout column(s) it must not: %', held;
  END IF;

  -- TRUNCATE, REFERENCES, TRIGGER, a table-level UPDATE and BYPASSRLS for
  -- kasuwa_app and every role it can enter.
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'UPDATE (table)' AS what WHERE pg_catalog.has_table_privilege(r.oid, rel, 'UPDATE')
     UNION ALL SELECT 'TRUNCATE' WHERE pg_catalog.has_table_privilege(r.oid, rel, 'TRUNCATE')
     UNION ALL SELECT 'REFERENCES' WHERE pg_catalog.has_any_column_privilege(r.oid, rel, 'REFERENCES')
     UNION ALL SELECT 'TRIGGER' WHERE pg_catalog.has_table_privilege(r.oid, rel, 'TRIGGER')
     UNION ALL SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0045: kasuwa_app, or a role it can enter, holds what it must not on home_layout: %', held;
  END IF;

  -- The relay, auth, the sweeper and PUBLIC hold nothing.
  SELECT pg_catalog.string_agg(r.rolname || ':' || p.priv, ', ' ORDER BY r.rolname, p.priv)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                      'REFERENCES', 'TRIGGER']) AS p(priv)
   WHERE r.rolname IN ('kasuwa_relay', 'kasuwa_auth', 'kasuwa_sweeper')
     AND CASE WHEN p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              THEN pg_catalog.has_any_column_privilege(r.oid, rel, p.priv)
              ELSE pg_catalog.has_table_privilege(r.oid, rel, p.priv)
         END;
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0045: a role other than kasuwa_app holds a privilege on home_layout: %', held;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
              WHERE c.oid = rel AND a.grantee = 0) THEN
    RAISE EXCEPTION '0045: PUBLIC holds a privilege on home_layout';
  END IF;

  -- Policy: exactly one, permissive, FOR ALL, WITH CHECK = USING, TO kasuwa_app.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p
       WHERE p.polrelid = rel AND p.polpermissive AND p.polcmd = '*'
         AND p.polroles = ARRAY[app_role]
         AND pg_catalog.pg_get_expr(p.polqual, p.polrelid)
             = pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)) <> 1
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = rel) <> 1 THEN
    RAISE EXCEPTION '0045: home_layout needs exactly one FOR ALL policy to kasuwa_app, WITH CHECK = USING';
  END IF;

  -- CLAUDE.md 2.7: still exactly the two SECURITY DEFINER functions.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0045: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END
$$;
