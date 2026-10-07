-- ---------------------------------------------------------------------------
-- 0028 - contact.company_name (T-0076, Agent 3; D-P17, D-P24, D-L65, D-L73,
-- D-L82).
--
-- D-P17 (answered): a lead is a stage of a contact, and `contact` gains a
-- `company_name`, the free-text organisation the person says they are with
-- (the P04/01 Leads table's Company column; `Contact.companyName` in
-- docs/api/records.openapi.yaml). It is not a link: `account_id` is the link,
-- and a lead often has a company long before anyone creates an account.
--
-- In this one file:
--   1. the catalogue lock (object_def, field_def);
--   2. the clash pre-check (D-P24), BEFORE anything changes;
--   3. the standard field_def for every existing tenant, and the proof;
--   4. only then the contact lock, the column and its CHECK.
-- Locks are always taken catalogue first, then contact.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- ---------------------------------------------------------------------------
-- THE COLUMN
-- ---------------------------------------------------------------------------
--   company_name  text NULL, no default. NULL is "no company recorded".
--   - contact_company_name_length_check: 1..200 characters (char_length counts
--     code points, as the contract's maxLength and the API's text() do). The
--     API refuses "" and anything over 200 first (D-L82), so this is the
--     second layer for an import or a script, never a user-facing error. An
--     empty string is refused rather than stored because "" and NULL would be
--     two spellings of "no company". U+0000 cannot be stored in text at all;
--     the API refuses it as 400 (D-L78).
--   - contact_company_name_length_check STAYS NOT VALID, ON PURPOSE (D-L65:
--     contact is the hot table). A validating ADD CONSTRAINT scans all of
--     contact under the ACCESS EXCLUSIVE lock (the migration review measured
--     0.5-0.8 s at 3M rows), which D-L65 forbids. NOT VALID skips that scan
--     and still binds every INSERT and UPDATE from now on. No existing row
--     can break it: the column is created by this same transaction, so every
--     existing row holds NULL, which a CHECK accepts. A later migration MAY
--     validate it, in a `-- kasuwa:no-transaction` file:
--       ALTER TABLE contact VALIDATE CONSTRAINT contact_company_name_length_check;
--     which takes only SHARE UPDATE EXCLUSIVE (reads and writes carry on). It
--     is a catalogue formality, not a repair.
--   - No index. `q` on listLeads matches company_name with the same strpos
--     scan as the name parts (D-L68 tracks a search index for all of them).
--     No sort key uses it: field security can withhold it.
--   - Grants: contact's table-level SELECT, INSERT, UPDATE and DELETE for
--     kasuwa_app (0001/0019) cover the new column. No column grant to add or
--     revoke.
--   - RLS: contact keeps ENABLED, FORCED and its 0001 policy; a new column
--     needs no policy of its own. TENANT_SCOPED_TABLES is unchanged.
--
-- ---------------------------------------------------------------------------
-- METADATA (catalogue recipe in packages/db/src/standard-object-catalogue.ts)
-- ---------------------------------------------------------------------------
--   - PRE-CHECK FIRST (D-P24, recipe step 2): if any tenant already has a
--     CUSTOM field `company_name` on its `contact` object, this file stops
--     before changing anything, naming the object, the field and the number
--     of tenants. A custom field cannot silently become standard (0025's
--     trigger refuses it), and which one wins is a human decision. A custom
--     `company_name` on ANOTHER object (say account) is not a clash and is not
--     counted. Messages carry catalogue names and counts only, never tenant
--     data.
--   - BACKFILL: one standard field_def `company_name` (label "Company", type
--     text, not required, config {}), is_custom = false, on every tenant's
--     standard `contact` object, as kasuwa_migrator (BYPASSRLS, so every
--     tenant). The jsonb literal below is this file's frozen copy of the
--     catalogue's entry; the seed and provisioning write the same row from
--     STANDARD_OBJECT_CATALOGUE through ensureStandardObjectDefs, and the
--     T-0076 suite asserts that all three agree. ON CONFLICT DO NOTHING:
--     after the pre-check, a row already there is a STANDARD one (a tenant
--     provisioned by the new release before this file ran), and the proof
--     checks it has the catalogue's meaning.
--   - CLASSIFICATION: `pii` (D-L82). A sole trader's company is a person's
--     name ("Adaeze Okonkwo Trading"), as an account name can be (D-L63,
--     D-L74). The audit trail records it by name only, never its value.
--   - PROOF (recipe step 4): every tenant has the field, standard, with the
--     catalogue's type, config and is_required and at least its
--     classification; and no standard field on `contact` falls outside the
--     catalogue's eighteen.
--   - DEPLOY WINDOW: as 0025. A tenant provisioned by the previous release
--     between migrate and rollout gets no row for this field; field security
--     then reads company_name as `none` for it (fail closed), and the field
--     is withheld until, after rollout, ensureStandardObjectDefs is run for
--     every tenant (idempotent).
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
-- No populated cell exists yet (D-L65), but this file is cheap at any size:
--   - object_def and field_def: SHARE ROW EXCLUSIVE for the whole file, taken
--     first. It blocks writes to the catalogue (a tenant admin creating a
--     custom field, so no custom `company_name` can appear between the
--     pre-check and the backfill) and lets every read through, so field
--     security keeps answering. The backfill and its proof scale with the
--     number of tenants (one field_def row each, per-tenant checks).
--   - contact: ACCESS EXCLUSIVE, taken LAST (step 4), after all the
--     per-tenant work, and held only for ADD COLUMN, the NOT VALID CHECK and
--     the COMMENT until COMMIT. None of those reads a contact row: ADD COLUMN
--     with no default is a catalogue change (no rewrite) and NOT VALID skips
--     the scan. So contact's blocking time grows with neither the table nor
--     the number of tenants. The migration review measured about 1 s of
--     contact blocking at 2,000 tenants when contact was locked up front
--     (held across the backfill), and about 5 ms with this order.
--   - Lock order is always catalogue, then contact, so this file cannot
--     deadlock against another that follows the same order.
--   - lock_timeout = 5s: the file fails fast instead of queueing behind a long
--     transaction (and making everything behind it queue too).
-- Steady-state cost: the CHECK on writes that set company_name, nothing else.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied: it is one transaction and the
-- runner records it only on COMMIT. Fix the cause (a clash: rename or delete
-- the tenant's custom contact.company_name, a human decision, then move its
-- values if they should survive) and run `pnpm db:migrate` again.
-- To undo it after it has applied: never edit or delete this file or its
-- ledger row (append-only). Instead:
--   1. roll back the application first (T-0076 reads and writes the column,
--      and serves Contact.companyName), and the catalogue entry in
--      standard-object-catalogue.ts;
--   2. export company_name values if they hold data; dropping the column
--      loses them;
--   3. in a NEW migration, as kasuwa_migrator: ALTER TABLE contact DROP
--      COLUMN company_name (its CHECK goes with it); DELETE the standard
--      field_def `company_name` on `contact` (its field_security_grant rows go
--      with it; the restrictive delete policy binds kasuwa_app only).
--
-- NO NEW TABLES, NO SECURITY DEFINER (CLAUDE.md 2.7: the census stays at two).
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. the catalogue lock (contact is locked last, in step 4) --------------
LOCK TABLE object_def, field_def IN SHARE ROW EXCLUSIVE MODE;

-- --- 2. the clash pre-check, before anything changes (D-P24) -----------------
DO $$
DECLARE
  clashing_tenants bigint;
BEGIN
  SELECT pg_catalog.count(DISTINCT f.tenant_id)
    INTO clashing_tenants
    FROM public.field_def f
    JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE o.api_name = 'contact'
     AND f.is_custom
     AND f.api_name = 'company_name';
  IF clashing_tenants > 0 THEN
    RAISE EXCEPTION '0028: a custom field company_name on object contact clashes with the new standard contact field company_name in % tenant(s). Nothing was applied. Rename or remove each custom field (a human decision: it has its own meaning and data), then re-run.',
      clashing_tenants;
  END IF;
END
$$;

-- --- 3. the standard field_def: backfill, then prove -------------------------
DO $$
DECLARE
  -- Frozen copy of the new `contact` entry of STANDARD_OBJECT_CATALOGUE
  -- (packages/db/src/standard-object-catalogue.ts).
  new_fields constant jsonb := '[
    {"api_name": "company_name", "label": "Company", "type": "text", "classification": "pii", "is_required": false, "config": {}}
  ]';
  -- Every standard field `contact` may carry after this file.
  contact_standard constant text[] := ARRAY[
    'given_names', 'family_name', 'company_name', 'phones', 'emails', 'account_id',
    'owner_user_id', 'status', 'source', 'tags', 'preferred_language', 'preferred_channel',
    'state', 'lga', 'dnd', 'whatsapp_opt_in', 'consent_state', 'phone_network'
  ];
  classification_rank constant text[] := ARRAY['none', 'pii', 'sensitive'];
  affected_tenants bigint;
  stray_rows bigint;
  problem text;
BEGIN
  INSERT INTO public.field_def
    (id, tenant_id, object_id, api_name, label, type, classification, is_required, is_custom, config)
  SELECT gen_random_uuid(), o.tenant_id, o.id, f.api_name, f.label, f.type, f.classification,
         f.is_required, false, f.config
    FROM public.object_def o
   CROSS JOIN jsonb_to_recordset(new_fields)
           AS f (api_name text, label text, type text, classification text,
                 is_required boolean, config jsonb)
   WHERE o.api_name = 'contact' AND NOT o.is_custom
  ON CONFLICT (tenant_id, object_id, api_name) DO NOTHING;

  -- A tenant with no standard `contact` object got no field above (a tenant
  -- provisioned by a release before 0025's, in its deploy window). Say so
  -- with the remedy, rather than as a missing field. Counts only.
  SELECT pg_catalog.count(*)
    INTO affected_tenants
    FROM public.tenant t
   WHERE NOT EXISTS (
           SELECT 1 FROM public.object_def o
            WHERE o.tenant_id = t.id AND o.api_name = 'contact' AND NOT o.is_custom);
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0028: % tenant(s) have no standard contact object, so they cannot be given the new contact field. Nothing was applied. Run ensureStandardObjectDefs (packages/db) for each of those tenants, as kasuwa_migrator, then re-run.',
      affected_tenants;
  END IF;

  -- Every tenant has the new field: standard, on its standard contact
  -- object, with the catalogue's meaning and at least its classification.
  SELECT pg_catalog.count(DISTINCT t.id),
         pg_catalog.string_agg(DISTINCT 'contact.' || c.api_name, ', ')
    INTO affected_tenants, problem
    FROM public.tenant t
   CROSS JOIN jsonb_to_recordset(new_fields)
           AS c (api_name text, type text, classification text, is_required boolean, config jsonb)
   WHERE NOT EXISTS (
           SELECT 1
             FROM public.field_def f
             JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
            WHERE f.tenant_id = t.id
              AND o.api_name = 'contact' AND NOT o.is_custom
              AND f.api_name = c.api_name AND NOT f.is_custom
              AND f.type = c.type
              AND f.config = c.config
              AND f.is_required = c.is_required
              AND pg_catalog.array_position(classification_rank, f.classification)
               >= pg_catalog.array_position(classification_rank, c.classification));
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0028 backfill incomplete: % tenant(s) lack or mis-type the standard field(s) %',
      affected_tenants, problem;
  END IF;

  -- Nothing standard on `contact` that the catalogue does not name. Names
  -- here are tenant data: counts only.
  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT f.tenant_id)
    INTO stray_rows, affected_tenants
    FROM public.field_def f
    JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE o.api_name = 'contact' AND NOT o.is_custom
     AND NOT f.is_custom
     AND f.api_name <> ALL (contact_standard);
  IF stray_rows > 0 THEN
    RAISE EXCEPTION '0028: % standard contact field_def row(s) in % tenant(s) are not in the standard catalogue; mark them custom or remove them, then re-run',
      stray_rows, affected_tenants;
  END IF;
END
$$;

-- --- 4. only now lock contact: the column and its check -----------------------
-- Last, so contact is held ACCESS EXCLUSIVE only for the catalogue-only
-- statements below, never across the per-tenant work above (LOCK IMPACT).
LOCK TABLE contact IN ACCESS EXCLUSIVE MODE;

ALTER TABLE contact ADD COLUMN company_name text;

ALTER TABLE contact
  ADD CONSTRAINT contact_company_name_length_check
  CHECK (pg_catalog.char_length(company_name) BETWEEN 1 AND 200) NOT VALID;

COMMENT ON COLUMN contact.company_name IS
  'Free-text company the person says they are with (D-P17). Not a link: account_id is. Classified pii (D-L82). NULL is none.';
