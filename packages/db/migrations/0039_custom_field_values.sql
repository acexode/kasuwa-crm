-- ---------------------------------------------------------------------------
-- 0039 - custom-field values on the standard record tables, and retire
-- instead of delete for custom field definitions (T-0089, Agent 2; ADR-0016,
-- D-L128, D-L65, D-P24, D-P25, D-P33, D-L140, D-L141).
--
-- EXPAND ONLY. In this one file:
--
--   1. lock_timeout, then the locks, in a fixed order (catalogue first, then
--      the four record tables in 0019/0027/0036 order);
--   2. `custom jsonb NOT NULL DEFAULT '{}'` on contact, account, activity and
--      deal, each with its three CHECKs, every one NOT VALID;
--   3. kasuwa_app's column-level UPDATE on `custom` where the table uses
--      column privileges (activity, 0027; deal, 0036);
--   4. `field_def.retired_at`;
--   5. ONE restrictive DELETE policy on field_def: a custom field of a
--      standard object is retired, never deleted, by the application;
--   6. 0025's freeze trigger extended to a custom field's `type`;
--   7. a self-check of what this file promises.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- NOT HERE, deliberately:
--   - no VALIDATE of the CHECKs (D-L65: expand now, validate in a later file,
--     outside the ACCESS EXCLUSIVE window of this one);
--   - no index of any kind on `custom` (D-P33, ADR-0016 item 8): under FORCE
--     RLS an index serves a predicate only if every function in it is
--     LEAKPROOF, and neither the jsonb containment operators nor `->>` are.
--     The supported custom filters are evaluated inside the already-scoped
--     keyset page;
--   - no new table, role, extension, function or SECURITY DEFINER (ADR-0016
--     item 10; CLAUDE.md 2.7: the census stays at two). One existing trigger
--     function is REPLACED (step 6), which adds no name;
--   - no data backfill: the default is a constant, so every existing row reads
--     `{}` without a rewrite.
--
-- ---------------------------------------------------------------------------
-- TENANCY (ADR-0016 items 1 and 10)
-- ---------------------------------------------------------------------------
-- The VALUE lives on the record row, so it is programme-scoped by that row's
-- own RLS policy (ENABLED, FORCED, WITH CHECK = USING, unchanged here). The
-- DEFINITION stays tenant-wide in field_def (ADR-0008, 0002 header): a custom
-- field belongs to the tenant, not to one programme. READ THIS BEFORE
-- "FIXING" THE MISSING programme_id ON field_def: there is none on purpose.
-- No policy on the four record tables changes; TENANT_SCOPED_TABLES does not
-- change.
--
-- ---------------------------------------------------------------------------
-- THE CHECKS (ADR-0016 item 2): defence in depth, not validation
-- ---------------------------------------------------------------------------
-- The API validates every value against the live definitions (a per-tenant,
-- per-object Zod schema). These guards only make sure no code path, and no
-- role, can store what the model forbids. CHECKs bind every role, the
-- migrator included (BYPASSRLS skips policies, never a CHECK).
--   <table>_custom_is_object  jsonb_typeof(custom) = 'object'
--   <table>_custom_keys       every TOP-LEVEL key matches ^[a-z][a-z0-9_]*__c$
--                             (D-P24), via jsonpath `keyvalue()`. Keys inside a
--                             value (a currency's amountMinor) are not checked.
--                             like_regex is POSIX ARE: `^` and `$` anchor at the
--                             ends of the whole key (no newline-sensitive mode),
--                             so `tier__c\n` and `ti\ner__c` fail. The path is
--                             `strict`, and the call `silent`: on a non-object
--                             it yields NULL rather than raising, so the
--                             is-object CHECK is what refuses an array or a
--                             scalar, as 23514.
--   <table>_custom_size       octet_length(custom::text) <= 32768: BYTES of the
--                             jsonb text form. A BACKSTOP only (D-L140): the
--                             API's own limit is 16 KiB on the keys the caller
--                             can see, so a caller never meets this one.
-- All three are IMMUTABLE expressions (jsonb_path_exists without _tz,
-- octet_length, the jsonb text cast), as a CHECK requires.
--
-- ---------------------------------------------------------------------------
-- RETIRE, NEVER DELETE (ADR-0016 item 9, D-L128 Q3)
-- ---------------------------------------------------------------------------
--   - `field_def.retired_at timestamptz NULL`, no default. NULL is live.
--   - field_def_delete_not_standard_object, RESTRICTIVE, FOR DELETE: kasuwa_app
--     may delete a field_def only when its object is a CUSTOM object. AND-ed
--     with 0002's permissive isolation policy and 0025's
--     field_def_delete_custom_only, so after this file kasuwa_app can delete
--     only a custom field of a custom object (S3 of the T-0089 storage suite).
--     A refused DELETE matches zero rows: it reveals nothing.
--   - Why a policy and not a trigger: the migrator's offboarding cascade from
--     `tenant` (0022) must still remove every definition. kasuwa_migrator is
--     BYPASSRLS and referential cascades skip row security, so a restrictive
--     policy binds the application only (0025 explains the same).
--   - The policy reads object_def through a correlated EXISTS on the row's own
--     (tenant_id, object_id), the composite key of 0002, under object_def's own
--     RLS besides. It names the tenant explicitly too, so it reads correctly on
--     its own.
--
-- ---------------------------------------------------------------------------
-- THE FREEZE (ADR-0016 item 9)
-- ---------------------------------------------------------------------------
-- A custom field's `type` is immutable for kasuwa_app: a change of type is a
-- new field, a copy, then retiring the old one. Implemented by REPLACING
-- 0025's app.guard_standard_field_def() and widening its trigger's WHEN, so
-- one function still answers "what may UPDATE not change on field_def":
--   - every role: is_custom never flips (23001, unchanged);
--   - a STANDARD field: unchanged from 0025 (object_id for every role, 23001;
--     type, config, is_required for kasuwa_app, 42501);
--   - a CUSTOM field: `type` for kasuwa_app, 42501. Its label, description,
--     classification (both ways, D-P25), config (picklist values are added)
--     and retired_at stay writable. The migrator is not frozen (S4: a
--     migration may still correct a definition), as 0025 leaves it for
--     standard fields.
-- The WHEN clause keeps every label edit, and every custom edit that leaves
-- the type alone, from running the function at all. 0029's classification
-- trigger is untouched.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
--   - contact, account, activity, deal: ACCESS EXCLUSIVE, held to COMMIT.
--     Every statement on them here is catalogue-only: ADD COLUMN with a
--     constant default (no rewrite since PG 11), ADD CONSTRAINT ... NOT VALID
--     (no scan), a GRANT. So the lock is held for milliseconds at any size;
--     reads and writes queue only for that long. lock_timeout = 5s makes the
--     file fail fast rather than queue behind a long transaction with every
--     request queued behind it.
--   - object_def: SHARE ROW EXCLUSIVE (the policy's subquery names it; nothing
--     here writes it). field_def: ACCESS EXCLUSIVE, which DROP TRIGGER needs
--     anyway; a definition catalogue, not a hot table.
--   - The VALIDATE that follows in a later file takes only SHARE UPDATE
--     EXCLUSIVE and scans without blocking reads or writes.
--
-- ---------------------------------------------------------------------------
-- REVERSIBILITY AND ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied (one transaction; the runner records
-- it only on COMMIT): fix the cause and run `pnpm db:migrate` again. After it
-- has applied, never edit or delete it (append-only). To undo, in NEW files:
--   - the policy and the trigger: DROP POLICY field_def_delete_not_standard_object
--     ON field_def; restore 0025's function body and WHEN clause by CREATE OR
--     REPLACE and DROP/CREATE TRIGGER. Both are catalogue-only.
--   - the columns are contract steps (expand -> migrate -> contract): only
--     after no deployed code reads `custom` or `retired_at`, and only once the
--     stored values have been dealt with under NDPA retention (ADR-0016
--     Consequences). Dropping `custom` destroys tenant data; it needs its own
--     decision.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order -------------------------------------------------
LOCK TABLE object_def IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE field_def IN ACCESS EXCLUSIVE MODE;
LOCK TABLE contact IN ACCESS EXCLUSIVE MODE;
LOCK TABLE account IN ACCESS EXCLUSIVE MODE;
LOCK TABLE activity IN ACCESS EXCLUSIVE MODE;
LOCK TABLE deal IN ACCESS EXCLUSIVE MODE;

-- --- 2. the columns and their guards ---------------------------------------------
-- One ALTER per table: the column and its three CHECKs, every CHECK NOT VALID
-- (see THE CHECKS above). The names sort is_object < keys < size, the order
-- Postgres evaluates them in.
ALTER TABLE contact
  ADD COLUMN custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT contact_custom_is_object
    CHECK (jsonb_typeof(custom) = 'object') NOT VALID,
  ADD CONSTRAINT contact_custom_keys
    CHECK (NOT jsonb_path_exists(
      custom, 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][a-z0-9_]*__c$"))', '{}', true
    )) NOT VALID,
  ADD CONSTRAINT contact_custom_size
    CHECK (octet_length(custom::text) <= 32768) NOT VALID;

ALTER TABLE account
  ADD COLUMN custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT account_custom_is_object
    CHECK (jsonb_typeof(custom) = 'object') NOT VALID,
  ADD CONSTRAINT account_custom_keys
    CHECK (NOT jsonb_path_exists(
      custom, 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][a-z0-9_]*__c$"))', '{}', true
    )) NOT VALID,
  ADD CONSTRAINT account_custom_size
    CHECK (octet_length(custom::text) <= 32768) NOT VALID;

ALTER TABLE activity
  ADD COLUMN custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT activity_custom_is_object
    CHECK (jsonb_typeof(custom) = 'object') NOT VALID,
  ADD CONSTRAINT activity_custom_keys
    CHECK (NOT jsonb_path_exists(
      custom, 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][a-z0-9_]*__c$"))', '{}', true
    )) NOT VALID,
  ADD CONSTRAINT activity_custom_size
    CHECK (octet_length(custom::text) <= 32768) NOT VALID;

ALTER TABLE deal
  ADD COLUMN custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT deal_custom_is_object
    CHECK (jsonb_typeof(custom) = 'object') NOT VALID,
  ADD CONSTRAINT deal_custom_keys
    CHECK (NOT jsonb_path_exists(
      custom, 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][a-z0-9_]*__c$"))', '{}', true
    )) NOT VALID,
  ADD CONSTRAINT deal_custom_size
    CHECK (octet_length(custom::text) <= 32768) NOT VALID;

COMMENT ON COLUMN contact.custom IS
  'Custom-field values (ADR-0016), keyed by field_def.api_name (...__c). Never logged; withheld keys are projected out in SQL.';
COMMENT ON COLUMN account.custom IS
  'Custom-field values (ADR-0016), keyed by field_def.api_name (...__c). Never logged; withheld keys are projected out in SQL.';
COMMENT ON COLUMN activity.custom IS
  'Custom-field values (ADR-0016), keyed by field_def.api_name (...__c). Never logged; withheld keys are projected out in SQL.';
COMMENT ON COLUMN deal.custom IS
  'Custom-field values (ADR-0016), keyed by field_def.api_name (...__c). Never logged; withheld keys are projected out in SQL.';

-- --- 3. grants -------------------------------------------------------------------
-- contact and account hold table-level UPDATE already (0019). activity (0027)
-- and deal (0036) use column privileges: a new column needs its own grant, and
-- only that one (a table-level UPDATE would also hand over the keys and
-- created_by_user_id). INSERT and SELECT are table-level on all four.
GRANT UPDATE (custom) ON activity TO kasuwa_app;
GRANT UPDATE (custom) ON deal TO kasuwa_app;

-- --- 4. retired_at -----------------------------------------------------------------
ALTER TABLE field_def ADD COLUMN retired_at timestamptz;

COMMENT ON COLUMN field_def.retired_at IS
  'When a custom field was retired (ADR-0016 item 9); NULL while live. A retired key is dropped from reads, refused on writes, and its api_name stays taken.';

-- --- 5. a custom field of a standard object is retired, never deleted ---------------
-- RESTRICTIVE, FOR DELETE: see RETIRE, NEVER DELETE in the header.
CREATE POLICY field_def_delete_not_standard_object ON field_def
  AS RESTRICTIVE
  FOR DELETE
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT EXISTS (
      SELECT 1
        FROM public.object_def o
       WHERE o.tenant_id = field_def.tenant_id
         AND o.id = field_def.object_id
         AND NOT o.is_custom
    )
  );

-- --- 6. the freeze, extended to a custom field's type ---------------------------------
-- Replaces 0025's body (same name, same signature, still SECURITY INVOKER with
-- a pinned search_path, reading nothing). Messages name the rule, never a value.
CREATE OR REPLACE FUNCTION app.guard_standard_field_def() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  -- Every role: what a definition IS.
  IF OLD.is_custom IS DISTINCT FROM NEW.is_custom THEN
    RAISE EXCEPTION 'field_def.is_custom is fixed at creation: a standard field cannot become custom, and a custom field cannot become standard'
      USING ERRCODE = 'restrict_violation';  -- 23001
  END IF;

  IF NOT OLD.is_custom THEN
    -- A standard field (0025, unchanged).
    IF OLD.object_id IS DISTINCT FROM NEW.object_id THEN
      RAISE EXCEPTION 'field_def.object_id of a standard field is fixed: a standard field cannot move to another object'
        USING ERRCODE = 'restrict_violation';  -- 23001
    END IF;
    IF (current_user = 'kasuwa_app' OR session_user = 'kasuwa_app')
       AND (OLD.type IS DISTINCT FROM NEW.type
            OR OLD.config IS DISTINCT FROM NEW.config
            OR OLD.is_required IS DISTINCT FROM NEW.is_required) THEN
      RAISE EXCEPTION 'field_def.type, config and is_required of a standard field are set by the catalogue and cannot be changed by the application role; the label can'
        USING ERRCODE = 'insufficient_privilege';  -- 42501
    END IF;
  ELSE
    -- A custom field (0039, ADR-0016 item 9): its type is fixed for the
    -- application role. Both identities are tested, as in 0023 and 0025.
    IF (current_user = 'kasuwa_app' OR session_user = 'kasuwa_app')
       AND OLD.type IS DISTINCT FROM NEW.type THEN
      RAISE EXCEPTION 'field_def.type of a custom field is fixed at creation: a change of type is a new field, then retiring the old one'
        USING ERRCODE = 'insufficient_privilege';  -- 42501
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- CREATE OR REPLACE keeps 0025's privileges; restated so this file does not
-- depend on that.
REVOKE ALL ON FUNCTION app.guard_standard_field_def() FROM PUBLIC;

-- The WHEN clause cannot be altered in place: drop and re-create, under the
-- ACCESS EXCLUSIVE lock taken above, so no UPDATE runs unguarded in between.
DROP TRIGGER field_def_standard_fixed ON field_def;

CREATE TRIGGER field_def_standard_fixed
  BEFORE UPDATE ON field_def
  FOR EACH ROW
  WHEN (
    OLD.is_custom IS DISTINCT FROM NEW.is_custom
    OR (
      NOT OLD.is_custom
      AND (OLD.object_id IS DISTINCT FROM NEW.object_id
           OR OLD.type IS DISTINCT FROM NEW.type
           OR OLD.config IS DISTINCT FROM NEW.config
           OR OLD.is_required IS DISTINCT FROM NEW.is_required)
    )
    OR (OLD.is_custom AND OLD.type IS DISTINCT FROM NEW.type)
  )
  EXECUTE FUNCTION app.guard_standard_field_def();

-- --- 7. prove what this file promises ------------------------------------------------
-- Runs once, here. The standing guards are the T-0089 storage suite.
DO $$
DECLARE
  record_tables constant text[] := ARRAY['contact', 'account', 'activity', 'deal'];
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY record_tables LOOP
    -- The column, NOT NULL, with its constant default.
    IF NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = pg_catalog.to_regclass('public.' || t)
            AND a.attname = 'custom' AND a.attnotnull AND a.atthasdef
            AND a.atttypid = 'jsonb'::pg_catalog.regtype) THEN
      RAISE EXCEPTION '0039: %.custom is missing, nullable or has no default', t;
    END IF;
    -- Exactly the three guards, each still unvalidated (D-L65).
    SELECT pg_catalog.count(*) INTO n
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = pg_catalog.to_regclass('public.' || t)
       AND c.contype = 'c'
       AND c.conname IN (t || '_custom_is_object', t || '_custom_keys', t || '_custom_size')
       AND NOT c.convalidated;
    IF n <> 3 THEN
      RAISE EXCEPTION '0039: % has % of its three custom CHECKs in the expected (unvalidated) state', t, n;
    END IF;
    -- No index mentions custom (D-P33).
    IF EXISTS (
         SELECT 1 FROM pg_catalog.pg_index i
          WHERE i.indrelid = pg_catalog.to_regclass('public.' || t)
            AND pg_catalog.pg_get_indexdef(i.indexrelid) ~ '\mcustom\M') THEN
      RAISE EXCEPTION '0039: an index on % mentions custom', t;
    END IF;
    -- RLS still ENABLED and FORCED.
    IF NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_class r
          WHERE r.oid = pg_catalog.to_regclass('public.' || t)
            AND r.relrowsecurity AND r.relforcerowsecurity) THEN
      RAISE EXCEPTION '0039: % lost ENABLE or FORCE ROW LEVEL SECURITY', t;
    END IF;
    -- The application role can write the column, but on activity and deal
    -- still holds no table-level UPDATE.
    IF NOT pg_catalog.has_column_privilege('kasuwa_app', 'public.' || t, 'custom', 'UPDATE') THEN
      RAISE EXCEPTION '0039: kasuwa_app cannot UPDATE %.custom', t;
    END IF;
    IF t IN ('activity', 'deal')
       AND pg_catalog.has_table_privilege('kasuwa_app', 'public.' || t, 'UPDATE') THEN
      RAISE EXCEPTION '0039: kasuwa_app holds table-level UPDATE on %', t;
    END IF;
  END LOOP;

  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = 'public.field_def'::pg_catalog.regclass
          AND p.polname = 'field_def_delete_not_standard_object'
          AND NOT p.polpermissive AND p.polcmd = 'd') THEN
    RAISE EXCEPTION '0039: the restrictive DELETE policy on field_def is missing or not restrictive';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger g
       WHERE g.tgrelid = 'public.field_def'::pg_catalog.regclass
         AND g.tgname = 'field_def_standard_fixed' AND NOT g.tgisinternal) <> 1 THEN
    RAISE EXCEPTION '0039: the field_def freeze trigger is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.field_def f WHERE f.retired_at IS NOT NULL) THEN
    RAISE EXCEPTION '0039: a definition was retired by the migration itself';
  END IF;
END
$$;
