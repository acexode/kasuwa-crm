-- ---------------------------------------------------------------------------
-- 0009 - the field-security matrix (M15/M2, T-0026, Agent 2).
--
-- Contract: docs/api/admin.openapi.yaml, operations getFieldSecurityMatrix and
-- updateFieldSecurityMatrix. Semantics: D-P9 (DECISION-LOG) and D-L45
-- (DECISIONS).
--
-- EXPAND ONLY. Three additions, nothing renamed, nothing dropped, and nothing
-- the running application reads today changes meaning:
--
--   1. field_def.classification - `none` | `pii` | `sensitive`. D-L45: a
--      column, not derived. NOT NULL with a constant default, so every
--      existing row and every existing INSERT (which does not name it) gets
--      `none`; on PG11+ a constant default is metadata-only, no rewrite.
--   2. object_def.field_security_version - the matrix's optimistic-concurrency
--      version, one per object. It lives on the object row for the same reason
--      role_hierarchy_version lives on the tenant row (0006): that is the one
--      row there is per matrix, and taking its lock (FOR NO KEY UPDATE, which
--      does not block foreign-key checks from field_def) serialises every
--      matrix write for that object. Per object, never a global sequence: a
--      shared counter would let one tenant watch another's admin activity.
--   3. field_security_grant - one row per (field, permission set) decision.
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE "FIXING" THE MISSING programme_id.
--
-- field_security_grant is tenant-scoped and deliberately NOT programme-scoped.
-- D-P9: the matrix has two axes, field and permission set. Programme scoping
-- comes from user_programme carrying the permission set that applies to that
-- person in that programme, so a decision is stored ONCE and resolved per
-- assignment. A programme column here is the third axis that decision
-- rejected: the same decision stored N times, and one admin's save silently
-- overwriting another's. The T-0026 acceptance suite asserts the absence
-- positively, for exactly this reason.
-- ---------------------------------------------------------------------------
--
-- Every tenancy invariant from 0001 applies in full:
--   1. tenant_id on every table, NOT NULL.
--   2. RLS ENABLED *and* FORCED.
--   3. The policy's WITH CHECK is identical to its USING.
--   4. Composite foreign keys carry tenant_id, so a decision can never pair a
--      field of one tenant with a permission set of another - not even with
--      RLS bypassed, because referential checks ignore row security.
--   5. Uniqueness is per tenant (the primary key leads with tenant_id).
--
-- A never-saved cell has NO row; the API reports it as `edit` (D-L45: today's
-- effective behaviour, since no FLS is enforced yet). A locked set (Admin) is
-- always reported `edit` and the API refuses to write it, so no row is ever
-- stored for one; the database does not need to know which set is locked.
--
-- Grants: kasuwa_app gets SELECT/INSERT/UPDATE/DELETE through the default
-- privileges in sql/bootstrap.sql; restated explicitly below so this file does
-- not silently depend on how the database was bootstrapped.
--
-- NO SECURITY DEFINER, no trigger, no function (CLAUDE.md 2.7).
-- ---------------------------------------------------------------------------

-- The ALTERs below take ACCESS EXCLUSIVE on field_def and object_def until
-- COMMIT. Both are definition catalogues (hundreds of rows per tenant) and the
-- changes are metadata-only, but fail fast rather than queue behind a long
-- transaction and stall every request in the cell behind us.
SET LOCAL lock_timeout = '5s';

-- --- 1. field_def.classification --------------------------------------------
-- Mirrors FIELD_CLASSIFICATIONS in packages/metadata-engine/src/field-security.ts
-- and the spec's FieldClassification enum. Extending the list is a new
-- expand migration (new constraint), never an edit here.
ALTER TABLE field_def
  ADD COLUMN classification text NOT NULL DEFAULT 'none'
  CONSTRAINT field_def_classification_check
    CHECK (classification IN ('none', 'pii', 'sensitive'));

-- --- 2. object_def.field_security_version -----------------------------------
-- Starts at 1 for every object, existing and new, so a client that has never
-- read a matrix cannot accidentally match it with a zero-valued default.
ALTER TABLE object_def
  ADD COLUMN field_security_version integer NOT NULL DEFAULT 1;

-- --- 3. field_security_grant ------------------------------------------------
CREATE TABLE field_security_grant (
  tenant_id          uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  field_id           uuid        NOT NULL,
  permission_set_id  uuid        NOT NULL,
  -- Ordered, and `edit` implies `read`: one column, never two booleans, so the
  -- state "edit but not read" cannot be stored (FieldAccessLevel).
  level              text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Each decision stored once (D-P9).
  PRIMARY KEY (tenant_id, field_id, permission_set_id),
  -- CASCADE: a decision about a field or a set that no longer exists means
  -- nothing, and leaving it would block deleting the definition.
  CONSTRAINT field_security_grant_field_same_tenant_fk
    FOREIGN KEY (tenant_id, field_id)
    REFERENCES field_def (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT field_security_grant_permission_set_same_tenant_fk
    FOREIGN KEY (tenant_id, permission_set_id)
    REFERENCES permission_set (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT field_security_grant_level_check
    CHECK (level IN ('none', 'read', 'edit'))
);
-- The primary key already serves the field side of the cascade and every
-- matrix read (tenant_id, field_id ...). This one serves deleting a set.
CREATE INDEX field_security_grant_tenant_set_idx
  ON field_security_grant (tenant_id, permission_set_id);

ALTER TABLE field_security_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_security_grant FORCE ROW LEVEL SECURITY;
-- Tenant predicate only - see the header. USING and WITH CHECK are identical,
-- so a session cannot write a row it could not read back.
CREATE POLICY field_security_grant_isolation ON field_security_grant FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON field_security_grant TO kasuwa_app, kasuwa_test_admin;
