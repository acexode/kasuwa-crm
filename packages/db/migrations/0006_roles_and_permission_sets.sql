-- ---------------------------------------------------------------------------
-- 0006 - the role hierarchy and the permission-set catalogue (M2, T-0022).
--
-- Contract: docs/api/admin.openapi.yaml, operations listRoles .. deleteRole,
-- updateRoleHierarchy and listPermissionSets.
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE "FIXING" THE MISSING programme_id.
--
-- Both tables are tenant-scoped and deliberately NOT programme-scoped:
--
--   * role - "Roles are tenant-wide and carry no programme" (listRoles). The
--     hierarchy is one tree per tenant; whether a grant can later be narrowed
--     to a programme is the permissions engine's question, not this table's.
--   * permission_set - D-P9: the field-security matrix is tenant-level on
--     permission sets, and programme scoping will come from user_programme
--     carrying the set for that assignment, not from a programme column here.
--
-- Which users may *edit* either is a permissions question (M2), exactly as for
-- "user" and object_def.
-- ---------------------------------------------------------------------------
--
-- Every tenancy invariant from 0001 applies in full:
--   1. tenant_id on every table, NOT NULL.
--   2. RLS ENABLED *and* FORCED.
--   3. Every policy's WITH CHECK is identical to its USING.
--   4. Composite foreign keys carry tenant_id: a role can never report to, and
--      a user can never hold, a role in another tenant - not even if RLS were
--      bypassed, because referential checks ignore row security.
--   5. Uniqueness is per tenant, never global. A global unique index on a name
--      would make tenant B's 409 disclose that tenant A has a role called that.
--
-- Grants: kasuwa_app gets SELECT/INSERT/UPDATE/DELETE through the default
-- privileges in sql/bootstrap.sql; they are restated explicitly below so this
-- file does not silently depend on how the database was bootstrapped.
--
-- Concurrency: the API's cycle check is safe against concurrent writers only
-- because every role write first takes the tenant row FOR NO KEY UPDATE
-- (apps/api/src/admin/roles/roles.service.ts). Any future writer of
-- role.parent_role_id - an import job, a seed, a script - must take the same
-- lock, or the trigger below becomes the only thing standing between two
-- concurrent moves and a committed cycle.
--
-- NOTE: `user` is a reserved word and is double-quoted wherever it appears.
-- ---------------------------------------------------------------------------

-- The ALTERs on tenant and "user" below take ACCESS EXCLUSIVE until COMMIT.
-- Fail fast rather than queue behind a long transaction and stall every
-- request in the cell behind us. Transaction-local: the runner wraps each file.
SET LOCAL lock_timeout = '5s';

-- --- role ------------------------------------------------------------------
CREATE TABLE role (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name            text        NOT NULL,
  -- Null for a top-level role. MATCH SIMPLE (the default) skips the composite
  -- check when this is null, which is exactly the semantics wanted.
  parent_role_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- NO ACTION, not CASCADE and not SET NULL: deleting a role re-parents its
  -- children first (deleteRole). A cascade would silently delete a subtree,
  -- and SET NULL on a composite key would null tenant_id too.
  CONSTRAINT role_parent_same_tenant_fk
    FOREIGN KEY (tenant_id, parent_role_id)
    REFERENCES role (tenant_id, id),
  CONSTRAINT role_not_own_parent_check CHECK (parent_role_id IS DISTINCT FROM id),
  CONSTRAINT role_name_length_check CHECK (char_length(name) BETWEEN 1 AND 120)
);
-- Per tenant, case-insensitively: "Team Lead" and "team lead" side by side in
-- one tree is a mistake, not two roles.
CREATE UNIQUE INDEX role_tenant_name_key ON role (tenant_id, lower(name));
CREATE INDEX role_tenant_parent_idx ON role (tenant_id, parent_role_id);

ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;
CREATE POLICY role_isolation ON role FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON role TO kasuwa_app, kasuwa_test_admin;

-- The hierarchy must be a forest. The API checks this before every write and
-- answers 409 role_hierarchy_cycle; this trigger is the second, independent
-- layer, so a code path that forgets the check fails instead of storing a
-- loop that every "who is beneath whom" query would then walk forever.
--
-- SECURITY INVOKER (the default) - NOT a definer function (CLAUDE.md 2.7). It
-- runs under the caller's RLS, which is sufficient: the composite foreign key
-- already guarantees every ancestor is in the same tenant. It returns nothing
-- and its error names no identifier.
--
-- AFTER ... FOR EACH ROW fires at the end of the statement, so a multi-row
-- UPDATE (updateRoleHierarchy) is judged on its final shape, not on the
-- intermediate states between rows.
CREATE FUNCTION app.role_assert_acyclic() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.parent_role_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- UNION (not UNION ALL) terminates even on a cycle, because a repeated
  -- (id, parent_role_id) pair adds no new row.
  IF EXISTS (
    WITH RECURSIVE ancestors (id, parent_role_id) AS (
      SELECT r.id, r.parent_role_id
        FROM public.role r
       WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.parent_role_id
      UNION
      SELECT r.id, r.parent_role_id
        FROM public.role r
        JOIN ancestors a ON r.id = a.parent_role_id
       WHERE r.tenant_id = NEW.tenant_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'role hierarchy would contain a cycle'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.role_assert_acyclic() FROM PUBLIC;

CREATE TRIGGER role_acyclic
  AFTER INSERT OR UPDATE OF parent_role_id ON role
  FOR EACH ROW EXECUTE FUNCTION app.role_assert_acyclic();

-- --- the hierarchy version -------------------------------------------------
-- RoleList.version is "of the hierarchy as a whole", for optimistic
-- concurrency on PUT /roles/hierarchy. It lives on the tenant row because that
-- is the one row per tenant there is, and because taking that row's lock
-- (FOR NO KEY UPDATE, which does not block foreign-key checks from other
-- tables) serialises every hierarchy write in a tenant - without that, two
-- concurrent moves that are each acyclic alone could commit a cycle together.
--
-- Per tenant, never a global sequence: a shared counter would let one tenant
-- watch another's rate of admin activity.
--
-- Metadata-only on PG11+: a constant default needs no table rewrite.
ALTER TABLE tenant ADD COLUMN role_hierarchy_version integer NOT NULL DEFAULT 1;

-- --- user.role_id ----------------------------------------------------------
-- Which role a person holds, at most one, tenant-wide (Role.userCount, and
-- deleteRole's "move its people"). Nullable: nobody holds a role until one is
-- assigned, and the existing application never reads this column, so the
-- change is backward compatible (expand only).
ALTER TABLE "user" ADD COLUMN role_id uuid;
-- A plain FK, validated in place: every role_id was null a moment ago, so the
-- check is trivial, and ADD COLUMN above already holds ACCESS EXCLUSIVE on
-- "user" for the rest of this transaction anyway.
ALTER TABLE "user"
  ADD CONSTRAINT user_role_same_tenant_fk
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id);
-- Not CONCURRENTLY: "user" is thousands of rows per tenant, not millions, and
-- CONCURRENTLY cannot run inside the runner's per-file transaction.
CREATE INDEX user_tenant_role_idx ON "user" (tenant_id, role_id);

-- --- permission_set --------------------------------------------------------
-- The columns of the field-security matrix (listPermissionSets). This table
-- NAMES permission sets; it defines no grant and no assignment. `key` is the
-- spec's `permissionSetId` - a stable string, unique per tenant.
CREATE TABLE permission_set (
  id          uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  key         text        NOT NULL,
  label       text        NOT NULL,
  -- The Admin column's padlock: "Admins always have full access".
  locked      boolean     NOT NULL DEFAULT false,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  -- Composite-foreign-key target for user_programme's set (D-P9, next task).
  UNIQUE (tenant_id, id),
  CONSTRAINT permission_set_key_shape_check CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT permission_set_label_length_check CHECK (char_length(label) BETWEEN 1 AND 120)
);

ALTER TABLE permission_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_set FORCE ROW LEVEL SECURITY;
CREATE POLICY permission_set_isolation ON permission_set FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON permission_set TO kasuwa_app, kasuwa_test_admin;
