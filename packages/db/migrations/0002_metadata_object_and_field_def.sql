-- ---------------------------------------------------------------------------
-- 0002 - metadata engine foundations: object_def and field_def (M15, T-0002).
--
-- These two tables are the storage model for custom objects and custom fields.
-- layout_def, validation_rule, record_type and custom_record are deliberately
-- NOT here; they are later tasks (docs/prd/M15-customisation-and-app-builder.md).
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE "FIXING" THE MISSING programme_id.
--
-- Metadata is tenant-scoped and deliberately **NOT** programme-scoped. A custom
-- field belongs to the tenant, not to one BPO client engagement: a tenant's own
-- admin must be able to configure the objects its agents use across every
-- programme, and an agent on programme A2 must see a definition created by an
-- agent on A1. Adding programme_id (or a programme predicate to the policies
-- below) would mean a BPO could not configure its own platform.
--
-- This is the one place in the schema where omitting programme_id is correct.
-- It is asserted POSITIVELY by
-- tests/acceptance/metadata/metadata-isolation.acceptance.test.ts, so a change
-- of heart here fails the isolation suite and says why. Which users may *edit*
-- a definition is a permissions question (M2), not a tenancy question - exactly
-- as for the "user" table in 0001.
-- ---------------------------------------------------------------------------
--
-- Every other tenancy invariant from 0001 applies in full:
--   1. tenant_id on every table.
--   2. RLS ENABLED *and* FORCED.
--   3. Every policy's WITH CHECK is identical to its USING.
--   4. Composite foreign keys carry tenant_id, so a field definition can never
--      point at another tenant's object definition.
--   5. Uniqueness is per tenant (and per object for fields), never global: two
--      tenants must both be able to call a field `priority`. A global unique
--      index would let the first tenant to define a name take it from everyone
--      else - a bug that only appears once there are two customers, which is
--      the worst moment to find it.
--
-- NOTE: `user` is a reserved word and is double-quoted wherever it appears.
-- Nothing here references it, but the rule holds for every later migration.
-- ---------------------------------------------------------------------------

-- --- object_def ------------------------------------------------------------
-- One row per object a tenant can hold records of. `is_custom = false` marks a
-- standard object (contact, case, ...) that the tenant has customised: the
-- standard object itself is defined in code, and the row exists so that custom
-- fields have a parent.
CREATE TABLE object_def (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  api_name      text        NOT NULL,
  label         text        NOT NULL,
  plural_label  text,
  description   text,
  is_custom     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Per tenant, never global.
  UNIQUE (tenant_id, api_name),
  -- The composite-foreign-key target used by field_def below.
  UNIQUE (tenant_id, id),
  -- An api_name reaches URLs, generated API shapes and eventually SQL
  -- identifiers. Constrain it in the database as well as in Zod, so a future
  -- code path that forgets to validate still cannot store something unquotable.
  CONSTRAINT object_def_api_name_shape_check
    CHECK (api_name ~ '^[a-z][a-z0-9_]{0,61}[a-z0-9]$')
);
CREATE INDEX object_def_tenant_idx ON object_def (tenant_id);

ALTER TABLE object_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_def FORCE ROW LEVEL SECURITY;
-- Tenant predicate only - see the header. USING and WITH CHECK are identical,
-- so a session cannot write a row it could not read back.
CREATE POLICY object_def_isolation ON object_def FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- --- field_def -------------------------------------------------------------
-- One row per field on an object. `config` carries type-specific settings
-- (picklist values, lookup target, precision); its shape is validated per type
-- in @kasuwa/metadata-engine rather than in SQL, because it varies by type.
CREATE TABLE field_def (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  object_id     uuid        NOT NULL,
  api_name      text        NOT NULL,
  label         text        NOT NULL,
  type          text        NOT NULL,
  description   text,
  is_required   boolean     NOT NULL DEFAULT false,
  is_custom     boolean     NOT NULL DEFAULT true,
  config        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Per tenant AND per object. The same name on the same object is still a
  -- conflict; the same name on a different object, or in another tenant, is not.
  UNIQUE (tenant_id, object_id, api_name),
  UNIQUE (tenant_id, id),
  -- This is what makes a cross-tenant parent impossible rather than merely
  -- unlikely: referential integrity checks bypass row security, so tenant_id
  -- has to be part of the key itself.
  CONSTRAINT field_def_object_same_tenant_fk
    FOREIGN KEY (tenant_id, object_id)
    REFERENCES object_def (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT field_def_api_name_shape_check
    CHECK (api_name ~ '^[a-z][a-z0-9_]{0,61}[a-z0-9]$'),
  -- The P0 field types from the PRD. Extending this list is an expand-phase
  -- migration (new constraint, backfill, then contract), never an edit here.
  -- `formula` and `rollup` are storable but not evaluable: the formula engine
  -- is a later task and nothing reads them today.
  CONSTRAINT field_def_type_check CHECK (type IN (
    'text', 'textarea', 'number', 'currency', 'date', 'datetime', 'boolean',
    'picklist', 'multipicklist', 'lookup', 'formula', 'rollup', 'phone',
    'email', 'url', 'nin'
  ))
);
CREATE INDEX field_def_tenant_object_idx ON field_def (tenant_id, object_id);

ALTER TABLE field_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_def FORCE ROW LEVEL SECURITY;
CREATE POLICY field_def_isolation ON field_def FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
