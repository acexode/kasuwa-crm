-- ---------------------------------------------------------------------------
-- 0025 - standard objects are metadata rows (T-0053, Agent 2; D-L69, D-P4,
-- D-P9, D-L45, D-L65).
--
-- Before this file, a tenant had object_def / field_def rows only for objects
-- it had created itself; contact and account existed only in code, and the
-- field-security matrix could only be stored for contact once a test planted a
-- `contact` row. D-L69 answers M15 Q10 for standard objects: they are metadata
-- rows. So:
--
--   1. BACKFILL. Every existing tenant gets one `object_def` for `contact` and
--      one for `account`, and one `field_def` per standard field, all with
--      `is_custom = false`. That is the meaning 0002's header already gives
--      the column ("is_custom = false marks a standard object"); no new column
--      is needed to mark a definition standard.
--   2. PROTECTION, so that a standard definition stays what it is:
--        - it cannot be DELETEd by kasuwa_app (restrictive policies, below);
--        - its api_name cannot change (already true since 0007, D-P4);
--        - it cannot stop being standard, and a standard field cannot move to
--          another object (trigger, below);
--        - its label, description and classification stay editable (D-P4).
--
-- New tenants get the same rows from code, in their own transaction: the seed
-- (`runSeed`) and tenant provisioning (`provisionTenant`) both write
-- STANDARD_OBJECT_CATALOGUE from packages/db/src/standard-object-catalogue.ts.
-- The VALUES lists below are this migration's frozen copy of that catalogue
-- as it stands today; the T-0053 acceptance suite builds a database whose
-- tenants pre-date this file and asserts the backfill, the seed and
-- provisioning produce the same catalogue. A later task that adds a standard
-- field (an `account` column, say) updates the catalogue AND backfills the
-- field in its own migration; it never edits this file.
--
-- FIELD NAMES. A field's api_name is the snake_case of the records contract's
-- wire name (docs/api/records.openapi.yaml: `givenNames` -> `given_names`),
-- the form 0002's CHECK admits and the T-0041 contact path already uses.
-- contact carries the WITHHOLDABLE properties only: the never-withheld ones
-- (id, programmeId, version, displayName, timestamps) would be matrix rows
-- that do nothing. account carries its business columns (today: `name`).
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE "FIXING" THE MISSING programme_id.
-- Metadata is tenant-scoped and deliberately NOT programme-scoped (0002
-- header, ADR-0008): every session in a tenant sees the same standard rows,
-- whichever programmes it reaches. Nothing here adds a programme predicate.
-- ---------------------------------------------------------------------------
--
-- PRE-EXISTING ROWS. A tenant may already hold a `contact` object_def (the
-- T-0041 suite plants one, with fields and field-security decisions). The
-- backfill KEEPS such rows - same id, label, type and grants - and only marks
-- them standard if they were not. Dropping and recreating them would silently
-- reset every field-security decision on them to `edit` (D-L45). A tenant's
-- own custom fields on those objects (any name not in the catalogue) are left
-- alone and stay custom and deletable.
--
-- WHY A RESTRICTIVE POLICY FOR DELETE, NOT A TRIGGER. A BEFORE DELETE trigger
-- fires for every role, including kasuwa_migrator's offboarding cascade from
-- `tenant` (0022, delete-guard D5): a tenant with standard rows could never be
-- removed. A RESTRICTIVE policy binds kasuwa_app only - the migrator is
-- BYPASSRLS and referential cascades skip row security - and a refused DELETE
-- matches zero rows, so it reveals nothing about which rows exist.
--
-- WHY A TRIGGER FOR UPDATE. A policy cannot compare OLD with NEW, and "is
-- still standard" and "is still on the same object" are exactly that
-- comparison. The trigger fires for every role, as 0007's api_name guard does:
-- standard-ness is fixed at INSERT, in both directions (a tenant cannot make
-- its own definition undeletable by flipping it standard either). The WHEN
-- clause means an ordinary label edit never runs the function.
--
-- NO SECURITY DEFINER (CLAUDE.md 2.7). The trigger function runs as the
-- invoker and reads nothing; it only raises. The census stays at two.
--
-- NO NEW TABLES. object_def and field_def keep RLS ENABLED and FORCED with
-- WITH CHECK identical to USING (0002); TENANT_SCOPED_TABLES is unchanged.
--
-- LOCKING (D-L65). object_def and field_def are definition catalogues
-- (dozens of rows per tenant), not hot tables. CREATE POLICY and CREATE
-- TRIGGER take short catalogue locks on them; fail fast rather than queue
-- behind a long transaction. The whole file is one transaction.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. backfill: the standard objects ---------------------------------------
-- A pre-existing row of the same name is kept and, if it was custom, marked
-- standard: the name belongs to the standard object. kasuwa_migrator is
-- BYPASSRLS, so this covers every tenant. Ids: gen_random_uuid() is D-L08's
-- safety net for rows written outside the application.
INSERT INTO object_def (id, tenant_id, api_name, label, plural_label, is_custom)
SELECT gen_random_uuid(), t.id, o.api_name, o.label, o.plural_label, false
  FROM tenant t
 CROSS JOIN (VALUES
   ('contact', 'Contact', 'Contacts'),
   ('account', 'Account', 'Accounts')
 ) AS o (api_name, label, plural_label)
ON CONFLICT (tenant_id, api_name)
  DO UPDATE SET is_custom = false
  WHERE object_def.is_custom;

-- --- 2. backfill: the standard fields ----------------------------------------
-- Same rule: an existing field of a catalogue name is kept (id, label, type,
-- config and its field_security_grant rows untouched) and marked standard.
INSERT INTO field_def
  (id, tenant_id, object_id, api_name, label, type, classification, is_required, is_custom, config)
SELECT gen_random_uuid(), o.tenant_id, o.id, f.api_name, f.label, f.type, f.classification,
       f.is_required, false, f.config::jsonb
  FROM object_def o
  JOIN (VALUES
    ('contact', 'given_names',        'Given names',        'text',    'pii',  false, '{}'),
    ('contact', 'family_name',        'Family name',        'text',    'pii',  false, '{}'),
    ('contact', 'phones',             'Phones',             'phone',   'pii',  false, '{}'),
    ('contact', 'emails',             'Emails',             'email',   'pii',  false, '{}'),
    ('contact', 'account_id',         'Account',            'lookup',  'none', false, '{"targetObjectApiName": "account"}'),
    ('contact', 'owner_user_id',      'Owner',              'text',    'none', false, '{}'),
    ('contact', 'status',             'Status',             'text',    'none', false, '{}'),
    ('contact', 'source',             'Source',             'text',    'none', false, '{}'),
    ('contact', 'tags',               'Tags',               'text',    'none', false, '{}'),
    ('contact', 'preferred_language', 'Preferred language', 'text',    'none', false, '{}'),
    ('contact', 'preferred_channel',  'Preferred channel',  'text',    'none', false, '{}'),
    ('contact', 'state',              'State',              'text',    'none', false, '{}'),
    ('contact', 'lga',                'LGA',                'text',    'none', false, '{}'),
    ('contact', 'dnd',                'Do not disturb',     'boolean', 'none', false, '{}'),
    ('contact', 'whatsapp_opt_in',    'WhatsApp opt-in',    'boolean', 'none', false, '{}'),
    ('contact', 'consent_state',      'Consent',            'text',    'none', false, '{}'),
    ('contact', 'phone_network',      'Phone network',      'text',    'none', false, '{}'),
    ('account', 'name',               'Name',               'text',    'none', true,  '{}')
  ) AS f (object_api_name, api_name, label, type, classification, is_required, config)
    ON f.object_api_name = o.api_name
 WHERE o.api_name IN ('contact', 'account')
ON CONFLICT (tenant_id, object_id, api_name)
  DO UPDATE SET is_custom = false
  WHERE field_def.is_custom;

-- --- 3. a standard definition cannot be deleted by kasuwa_app ----------------
-- RESTRICTIVE, so it is AND-ed with the permissive *_isolation policies of
-- 0002 and can only narrow them. FOR DELETE only: reads, inserts and label
-- updates are untouched. The tenant predicate is repeated so the policy reads
-- correctly on its own.
CREATE POLICY object_def_delete_custom_only ON object_def
  AS RESTRICTIVE
  FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND is_custom);

CREATE POLICY field_def_delete_custom_only ON field_def
  AS RESTRICTIVE
  FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND is_custom);

-- --- 4. standard-ness is fixed, and a standard field stays on its object ------
CREATE FUNCTION app.reject_standard_definition_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  -- Names the table, never a value: an api_name is tenant data and error text
  -- ends up in logs.
  RAISE EXCEPTION '%: a definition''s is_custom is fixed at creation, and a standard field cannot move to another object', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';  -- 23001, as 0007
END;
$$;

-- Only the triggers below call it; firing a trigger needs no EXECUTE.
REVOKE ALL ON FUNCTION app.reject_standard_definition_change() FROM PUBLIC;

CREATE TRIGGER object_def_standard_fixed
  BEFORE UPDATE ON object_def
  FOR EACH ROW
  WHEN (OLD.is_custom IS DISTINCT FROM NEW.is_custom)
  EXECUTE FUNCTION app.reject_standard_definition_change();

CREATE TRIGGER field_def_standard_fixed
  BEFORE UPDATE ON field_def
  FOR EACH ROW
  WHEN (
    OLD.is_custom IS DISTINCT FROM NEW.is_custom
    OR (NOT OLD.is_custom AND OLD.object_id IS DISTINCT FROM NEW.object_id)
  )
  EXECUTE FUNCTION app.reject_standard_definition_change();

-- --- 5. prove it -------------------------------------------------------------
-- Runs once, here. The standing guards are the T-0053 acceptance suite, which
-- runs on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  problem text;
BEGIN
  -- Every tenant has both standard objects and every standard field.
  SELECT pg_catalog.count(*)::text || ' tenant(s) lack the standard catalogue'
    INTO problem
    FROM public.tenant t
   WHERE (SELECT pg_catalog.count(*) FROM public.object_def o
           WHERE o.tenant_id = t.id AND o.api_name IN ('contact', 'account')
             AND NOT o.is_custom) <> 2
      OR (SELECT pg_catalog.count(*) FROM public.field_def f
            JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
           WHERE f.tenant_id = t.id AND o.api_name IN ('contact', 'account')
             AND NOT f.is_custom) < 18
  HAVING pg_catalog.count(*) > 0;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION '0025 backfill incomplete: %', problem;
  END IF;

  -- Both guards are in place.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p
       WHERE p.polname IN ('object_def_delete_custom_only', 'field_def_delete_custom_only')
         AND NOT p.polpermissive AND p.polcmd = 'd') <> 2 THEN
    RAISE EXCEPTION '0025: the restrictive DELETE policies are missing or not restrictive';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgname IN ('object_def_standard_fixed', 'field_def_standard_fixed')
         AND NOT t.tgisinternal) <> 2 THEN
    RAISE EXCEPTION '0025: the standard-definition triggers are missing';
  END IF;

  -- TRUNCATE skips RLS entirely and would make the DELETE policies moot.
  -- kasuwa_app holds none today (bootstrap's default privileges never grant
  -- it); assert it, through every route a privilege can take.
  IF pg_catalog.has_table_privilege(app_role, 'public.object_def', 'TRUNCATE')
     OR pg_catalog.has_table_privilege(app_role, 'public.field_def', 'TRUNCATE') THEN
    RAISE EXCEPTION '0025: kasuwa_app can TRUNCATE object_def or field_def, which bypasses the DELETE policies';
  END IF;
END
$$;
