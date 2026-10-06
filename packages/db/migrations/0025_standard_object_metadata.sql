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
--        - kasuwa_app cannot DELETE it (restrictive policies);
--        - kasuwa_app cannot INSERT a standard row except a catalogue object,
--          or a field on one, and only as an active tenant admin (restrictive
--          policies) - a tenant cannot mint undeletable definitions;
--        - its api_name cannot change (already true since 0007, D-P4);
--        - no role can flip is_custom, and no role can move a standard field
--          to another object (trigger);
--        - kasuwa_app cannot change a standard field's type, config or
--          is_required: its meaning belongs to the catalogue. A later
--          migration (kasuwa_migrator) still can, to correct it (trigger);
--        - its label, description and classification stay editable (D-P4).
--
-- New tenants get the same rows from code, in their own transaction: the seed
-- (`runSeed`) and tenant provisioning (`provisionTenant`) both call
-- `ensureStandardObjectDefs` with STANDARD_OBJECT_CATALOGUE from
-- packages/db/src/standard-object-catalogue.ts. The jsonb literals below are
-- this migration's frozen copy of that catalogue; the T-0053 acceptance suite
-- builds a database whose tenants pre-date this file and asserts that the
-- backfill, the seed and provisioning produce the same catalogue. A later
-- task that adds a standard field follows the recipe in that file (pre-check
-- clashes and RAISE, then insert, in its own migration); it never edits this
-- one.
--
-- DEPLOY WINDOW. This file backfills the tenants that exist when it runs. A
-- tenant provisioned by the PREVIOUS release after `db:migrate` and before the
-- new release is rolled out gets no standard rows (old code does not write
-- them). Either do not provision tenants between migrate and rollout, or,
-- after rollout, call `ensureStandardObjectDefs` for every tenant (idempotent:
-- it writes only what is missing). The contact read path fails closed on a
-- tenant with no `contact` definition, so the gap shows as errors, not leaks.
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
-- PRE-EXISTING ROWS ARE ADOPTED. A tenant may already hold a `contact`
-- object_def (the T-0041 suite plants one, with fields and field-security
-- decisions). The backfill KEEPS such rows - same id, label, description and
-- field_security_grant rows - because dropping and recreating them would
-- silently reset every field-security decision on them to `edit` (D-L45). It
-- marks them standard and gives an adopted field the catalogue's meaning:
-- `type`, `config` and `is_required` come from the catalogue, and
-- `classification` is RAISED to the catalogue's level, never lowered. A
-- tenant's own custom fields on those objects (any name not in the catalogue)
-- are left alone and stay custom and deletable.
--
-- WHY RESTRICTIVE POLICIES FOR DELETE AND INSERT, NOT TRIGGERS. A BEFORE
-- DELETE trigger fires for every role, including kasuwa_migrator's
-- offboarding cascade from `tenant` (0022, delete-guard D5): a tenant with
-- standard rows could never be removed. RESTRICTIVE policies bind kasuwa_app
-- only - the migrator is BYPASSRLS, so the seed, provisioning and offboarding
-- are untouched, and referential cascades skip row security. A refused DELETE
-- matches zero rows, so it reveals nothing about which rows exist. The
-- catalogue's object names ('contact', 'account') are written into the
-- INSERT policies; a migration that adds a standard object replaces them.
--
-- WHY A TRIGGER FOR UPDATE. A policy cannot compare OLD with NEW, and every
-- rule here is that comparison. The WHEN clauses mean an ordinary label edit
-- never runs a function. The kasuwa_app-only rule tests both current_user and
-- session_user, as 0023's guard does, so a SET ROLE from an app connection
-- (kasuwa_sweeper) is still guarded.
--
-- NO SECURITY DEFINER (CLAUDE.md 2.7). Both trigger functions run as the
-- invoker and read nothing; they only compare and raise. The census stays at
-- two.
--
-- NO NEW TABLES. object_def and field_def keep RLS ENABLED and FORCED with
-- WITH CHECK identical to USING (0002); TENANT_SCOPED_TABLES is unchanged.
--
-- LOCKING (D-L65). object_def and field_def are definition catalogues
-- (dozens of rows per tenant), not hot tables. Both are locked ACCESS
-- EXCLUSIVE up front, so the backfill, its checks and the guards are one
-- consistent step that no session can write into halfway; lock_timeout makes
-- that fail fast rather than queue behind a long transaction. The whole file
-- is one transaction.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';
LOCK TABLE object_def, field_def IN ACCESS EXCLUSIVE MODE;

-- --- 1. backfill, and prove it ----------------------------------------------
-- One DO block so the catalogue is written once and read by both the upserts
-- and the checks. kasuwa_migrator is BYPASSRLS, so this covers every tenant.
-- Ids: gen_random_uuid() is D-L08's safety net for rows written outside the
-- application. Messages name catalogue entries and counts, never tenant data.
DO $$
DECLARE
  standard_objects constant jsonb := '[
    {"api_name": "contact", "label": "Contact", "plural_label": "Contacts"},
    {"api_name": "account", "label": "Account", "plural_label": "Accounts"}
  ]';
  standard_fields constant jsonb := '[
    {"object": "contact", "api_name": "given_names",        "label": "Given names",        "type": "text",    "classification": "pii",  "is_required": false, "config": {}},
    {"object": "contact", "api_name": "family_name",        "label": "Family name",        "type": "text",    "classification": "pii",  "is_required": false, "config": {}},
    {"object": "contact", "api_name": "phones",             "label": "Phones",             "type": "phone",   "classification": "pii",  "is_required": false, "config": {}},
    {"object": "contact", "api_name": "emails",             "label": "Emails",             "type": "email",   "classification": "pii",  "is_required": false, "config": {}},
    {"object": "contact", "api_name": "account_id",         "label": "Account",            "type": "lookup",  "classification": "none", "is_required": false, "config": {"targetObjectApiName": "account"}},
    {"object": "contact", "api_name": "owner_user_id",      "label": "Owner",              "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "status",             "label": "Status",             "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "source",             "label": "Source",             "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "tags",               "label": "Tags",               "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "preferred_language", "label": "Preferred language", "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "preferred_channel",  "label": "Preferred channel",  "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "state",              "label": "State",              "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "lga",                "label": "LGA",                "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "dnd",                "label": "Do not disturb",     "type": "boolean", "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "whatsapp_opt_in",    "label": "WhatsApp opt-in",    "type": "boolean", "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "consent_state",      "label": "Consent",            "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "contact", "api_name": "phone_network",      "label": "Phone network",      "type": "text",    "classification": "none", "is_required": false, "config": {}},
    {"object": "account", "api_name": "name",               "label": "Name",               "type": "text",    "classification": "none", "is_required": true,  "config": {}}
  ]';
  -- field_def_classification_check's values, weakest first: a classification
  -- is only ever raised by the backfill.
  classification_rank constant text[] := ARRAY['none', 'pii', 'sensitive'];
  affected_tenants bigint;
  problem text;
BEGIN
  -- Objects. A pre-existing row of the same name is kept and, if it was
  -- custom, marked standard: the name belongs to the standard object.
  INSERT INTO public.object_def (id, tenant_id, api_name, label, plural_label, is_custom)
  SELECT gen_random_uuid(), t.id, o.api_name, o.label, o.plural_label, false
    FROM public.tenant t
   CROSS JOIN jsonb_to_recordset(standard_objects) AS o (api_name text, label text, plural_label text)
  ON CONFLICT (tenant_id, api_name)
    DO UPDATE SET is_custom = false
    WHERE object_def.is_custom;

  -- Fields. A pre-existing field of a catalogue name is adopted: id, label,
  -- description and grants kept; meaning from the catalogue; classification
  -- never lowered.
  INSERT INTO public.field_def
    (id, tenant_id, object_id, api_name, label, type, classification, is_required, is_custom, config)
  SELECT gen_random_uuid(), o.tenant_id, o.id, f.api_name, f.label, f.type, f.classification,
         f.is_required, false, f.config
    FROM public.object_def o
    JOIN jsonb_to_recordset(standard_fields)
           AS f (object text, api_name text, label text, type text, classification text,
                 is_required boolean, config jsonb)
      ON f.object = o.api_name
   WHERE NOT o.is_custom
  ON CONFLICT (tenant_id, object_id, api_name)
    DO UPDATE SET
      is_custom      = false,
      type           = EXCLUDED.type,
      config         = EXCLUDED.config,
      is_required    = EXCLUDED.is_required,
      classification = CASE
        WHEN pg_catalog.array_position(classification_rank, EXCLUDED.classification)
           > pg_catalog.array_position(classification_rank, field_def.classification)
        THEN EXCLUDED.classification
        ELSE field_def.classification
      END;

  -- Proof, per tenant and per catalogue entry (an anti-join, not a count):
  -- every tenant has every standard object, standard...
  SELECT pg_catalog.count(DISTINCT t.id),
         pg_catalog.string_agg(DISTINCT c.api_name, ', ')
    INTO affected_tenants, problem
    FROM public.tenant t
   CROSS JOIN jsonb_to_recordset(standard_objects) AS c (api_name text)
   WHERE NOT EXISTS (
           SELECT 1 FROM public.object_def o
            WHERE o.tenant_id = t.id AND o.api_name = c.api_name AND NOT o.is_custom);
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0025 backfill incomplete: % tenant(s) lack the standard object(s) %',
      affected_tenants, problem;
  END IF;

  -- ...and every standard field, standard, on its standard object, with the
  -- catalogue's type and is_required, and at least its classification.
  SELECT pg_catalog.count(DISTINCT t.id),
         pg_catalog.string_agg(DISTINCT c.object || '.' || c.api_name, ', ')
    INTO affected_tenants, problem
    FROM public.tenant t
   CROSS JOIN jsonb_to_recordset(standard_fields)
           AS c (object text, api_name text, type text, classification text, is_required boolean)
   WHERE NOT EXISTS (
           SELECT 1
             FROM public.field_def f
             JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
            WHERE f.tenant_id = t.id
              AND o.api_name = c.object AND NOT o.is_custom
              AND f.api_name = c.api_name AND NOT f.is_custom
              AND f.type = c.type
              AND f.is_required = c.is_required
              AND pg_catalog.array_position(classification_rank, f.classification)
               >= pg_catalog.array_position(classification_rank, c.classification));
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0025 backfill incomplete: % tenant(s) lack or mis-type the standard field(s) %',
      affected_tenants, problem;
  END IF;
END
$$;

-- --- 2. a standard definition cannot be deleted by kasuwa_app ----------------
-- RESTRICTIVE, so each is AND-ed with the permissive *_isolation policy of
-- 0002 and can only narrow it. FOR DELETE only. The tenant predicate is
-- repeated so the policy reads correctly on its own.
CREATE POLICY object_def_delete_custom_only ON object_def
  AS RESTRICTIVE
  FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND is_custom);

CREATE POLICY field_def_delete_custom_only ON field_def
  AS RESTRICTIVE
  FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND is_custom);

-- --- 3. kasuwa_app inserts a standard row only for the catalogue, as an admin -
-- A custom row (the metadata engine's only kind) is untouched. A standard one
-- is allowed only where it can restore the catalogue - an object named in it,
-- or a field on a standard object named in it - and only for an active tenant
-- admin (0021/0023's test). The migrator, which writes the catalogue in the
-- seed and provisioning, is BYPASSRLS and never reaches these.
CREATE POLICY object_def_insert_standard_by_tenant_admin ON object_def
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    is_custom
    OR (
      api_name IN ('contact', 'account')
      AND EXISTS (
        SELECT 1
          FROM "user" u
         WHERE u.tenant_id = app.current_tenant_id()
           AND u.id = app.current_user_id()
           AND u.is_tenant_admin
           AND u.status = 'active'
      )
    )
  );

CREATE POLICY field_def_insert_standard_by_tenant_admin ON field_def
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    is_custom
    OR (
      EXISTS (
        SELECT 1
          FROM object_def o
         WHERE o.tenant_id = app.current_tenant_id()
           AND o.id = field_def.object_id
           AND NOT o.is_custom
           AND o.api_name IN ('contact', 'account')
      )
      AND EXISTS (
        SELECT 1
          FROM "user" u
         WHERE u.tenant_id = app.current_tenant_id()
           AND u.id = app.current_user_id()
           AND u.is_tenant_admin
           AND u.status = 'active'
      )
    )
  );

-- --- 4. what UPDATE may not change -------------------------------------------
-- Messages name the table and the rule, never a value: an api_name is tenant
-- data and error text reaches logs.
CREATE FUNCTION app.guard_standard_object_def() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'object_def.is_custom is fixed at creation: a standard object cannot become custom, and a custom object cannot become standard'
    USING ERRCODE = 'restrict_violation';  -- 23001, as 0007
END;
$$;

CREATE FUNCTION app.guard_standard_field_def() RETURNS trigger
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
  IF OLD.object_id IS DISTINCT FROM NEW.object_id THEN
    RAISE EXCEPTION 'field_def.object_id of a standard field is fixed: a standard field cannot move to another object'
      USING ERRCODE = 'restrict_violation';  -- 23001
  END IF;
  -- The application role only: what a standard field MEANS. A migration
  -- (kasuwa_migrator) may still correct it. Both identities are tested, as in
  -- 0023, so SET ROLE from an app connection stays guarded.
  IF (current_user = 'kasuwa_app' OR session_user = 'kasuwa_app')
     AND (OLD.type IS DISTINCT FROM NEW.type
          OR OLD.config IS DISTINCT FROM NEW.config
          OR OLD.is_required IS DISTINCT FROM NEW.is_required) THEN
    RAISE EXCEPTION 'field_def.type, config and is_required of a standard field are set by the catalogue and cannot be changed by the application role; the label can'
      USING ERRCODE = 'insufficient_privilege';  -- 42501, as 0023
  END IF;
  RETURN NEW;
END;
$$;

-- Only the triggers below call them; firing a trigger needs no EXECUTE.
REVOKE ALL ON FUNCTION app.guard_standard_object_def() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.guard_standard_field_def() FROM PUBLIC;

CREATE TRIGGER object_def_standard_fixed
  BEFORE UPDATE ON object_def
  FOR EACH ROW
  WHEN (OLD.is_custom IS DISTINCT FROM NEW.is_custom)
  EXECUTE FUNCTION app.guard_standard_object_def();

-- The function runs only for a flip, or for a STANDARD row whose placement or
-- meaning changes; a custom field's edits, and every label edit, skip it.
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
  )
  EXECUTE FUNCTION app.guard_standard_field_def();

-- --- 5. prove the guards -----------------------------------------------------
-- Runs once, here. The standing guards are the T-0053 acceptance suite, which
-- runs on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  held text;
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p
       WHERE p.polname IN ('object_def_delete_custom_only', 'field_def_delete_custom_only')
         AND NOT p.polpermissive AND p.polcmd = 'd') <> 2 THEN
    RAISE EXCEPTION '0025: the restrictive DELETE policies are missing or not restrictive';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p
       WHERE p.polname IN ('object_def_insert_standard_by_tenant_admin',
                           'field_def_insert_standard_by_tenant_admin')
         AND NOT p.polpermissive AND p.polcmd = 'a') <> 2 THEN
    RAISE EXCEPTION '0025: the restrictive INSERT policies are missing or not restrictive';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgname IN ('object_def_standard_fixed', 'field_def_standard_fixed')
         AND NOT t.tgisinternal) <> 2 THEN
    RAISE EXCEPTION '0025: the standard-definition triggers are missing';
  END IF;

  -- TRUNCATE skips RLS entirely, and BYPASSRLS skips the policies: either
  -- would make the DELETE and INSERT guards moot. Checked for kasuwa_app AND
  -- every role it is a member of, whatever the INHERIT option - kasuwa_app can
  -- SET ROLE to kasuwa_sweeper (D-L66) - through every route a privilege can
  -- take (direct, PUBLIC, inherited).
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'TRUNCATE object_def' AS what
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.object_def', 'TRUNCATE')
     UNION ALL
     SELECT 'TRUNCATE field_def'
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.field_def', 'TRUNCATE')
     UNION ALL
     SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0025: kasuwa_app, or a role it can enter, can bypass the definition guards: %', held;
  END IF;
END
$$;
