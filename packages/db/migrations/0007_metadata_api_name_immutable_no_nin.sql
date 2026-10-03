-- ---------------------------------------------------------------------------
-- 0007 - metadata: api_name is immutable (D-P4); no plain-text `nin` field
-- type (D-P5). T-0023, Agent 2.
--
-- Both decisions are in team/DECISION-LOG.md under 2026-10-02.
--
-- D-P4. An api_name reaches URLs, generated API shapes, saved reports,
-- integrations and eventually SQL identifiers. Renaming one silently breaks
-- every one of those, so it is immutable after insert and the LABEL is what a
-- tenant edits. The decision says "enforced in the database, not only the
-- API": an API-only guard is bypassed by the next code path that forgets it.
-- Hence a trigger, which fires for every role including the table owner.
--
-- The guard is on api_name, NOT on UPDATE as a whole. Labels, descriptions and
-- config stay editable; the WHEN clause means the trigger function only runs
-- when api_name actually changes, so an ordinary label edit pays nothing.
-- `IS DISTINCT FROM` rather than `<>` so that the comparison cannot be
-- side-stepped by NULL (api_name is NOT NULL today; this does not rely on it).
--
-- D-P5. `nin` was storable as a plain-text custom field type (0002). An
-- identity number in a plain-text column is exactly the data D-L13's envelope
-- encryption exists for, and that mechanism is not wired to M3 yet. Until it
-- is, neither `nin` nor `bvn` is a field type. (`bvn` was never in 0002's list;
-- the new constraint keeps it out.) When they return they come back as
-- encrypted-only types with a blind index, via a later expand migration.
--
-- Existing `nin` rows: there should be none - no API has ever created a field
-- definition. If there are, this migration FAILS rather than converting them.
-- Silently re-typing an identity field as `text` would keep the identity
-- numbers and lose the one marker saying what they are. A human decides what
-- happens to that data; the migration does not.
--
-- NO SECURITY DEFINER. The trigger function runs as the invoker and reads
-- nothing; it only compares OLD and NEW. Not a hole in RLS (CLAUDE.md 2.7).
--
-- NO NEW TABLES, NO RLS CHANGES. Both tables already have RLS ENABLEd and
-- FORCEd with WITH CHECK identical to USING (0002); TENANT_SCOPED_TABLES is
-- unchanged.
--
-- LOCKING. The constraint swap takes ACCESS EXCLUSIVE on field_def for the
-- duration of one validating scan. field_def is a definition catalogue
-- (hundreds of rows per tenant, not the tens of millions PRD 2.13 means), so a
-- NOT VALID / VALIDATE split would buy nothing - and inside the runner's
-- one-transaction-per-file it would buy nothing anyway, because the lock from
-- ADD is held to commit. The whole file is atomic: it applies completely or
-- not at all.
-- ---------------------------------------------------------------------------

-- --- D-P4: api_name is immutable -------------------------------------------

CREATE FUNCTION app.reject_api_name_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  -- The message names the table and column, never a value: the api_name is
  -- tenant data and error text ends up in logs.
  RAISE EXCEPTION '%.api_name is immutable after creation; change the label instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';  -- 23001
END;
$$;

-- Nobody calls a trigger function directly; the triggers below are its only
-- callers, and firing a trigger needs no EXECUTE privilege.
REVOKE ALL ON FUNCTION app.reject_api_name_change() FROM PUBLIC;

CREATE TRIGGER object_def_api_name_immutable
  BEFORE UPDATE ON object_def
  FOR EACH ROW
  WHEN (OLD.api_name IS DISTINCT FROM NEW.api_name)
  EXECUTE FUNCTION app.reject_api_name_change();

CREATE TRIGGER field_def_api_name_immutable
  BEFORE UPDATE ON field_def
  FOR EACH ROW
  WHEN (OLD.api_name IS DISTINCT FROM NEW.api_name)
  EXECUTE FUNCTION app.reject_api_name_change();

-- --- D-P5: no nin (and no bvn) field type ----------------------------------

-- Fail loudly, with a count and no values, if any identity-typed definition
-- exists. kasuwa_migrator is BYPASSRLS, so this sees every tenant's rows; the
-- validating ADD CONSTRAINT below would also refuse them, but this says why.
DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending FROM field_def WHERE type IN ('nin', 'bvn');
  IF offending > 0 THEN
    RAISE EXCEPTION
      '0007: % field_def row(s) have type nin or bvn. Not converting them (D-P5); '
      'decide what happens to that data, then re-run.', offending
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- Same constraint name as 0002, so that the next change to the type list has
-- one obvious thing to replace. Mirrors FIELD_TYPES in
-- packages/metadata-engine/src/types.ts; the T-0023 acceptance suite asserts
-- the two agree in both directions.
ALTER TABLE field_def DROP CONSTRAINT field_def_type_check;
ALTER TABLE field_def ADD CONSTRAINT field_def_type_check CHECK (type IN (
  'text', 'textarea', 'number', 'currency', 'date', 'datetime', 'boolean',
  'picklist', 'multipicklist', 'lookup', 'formula', 'rollup', 'phone',
  'email', 'url'
));
