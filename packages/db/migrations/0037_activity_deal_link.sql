-- ---------------------------------------------------------------------------
-- 0037 - activities linked to a deal: `activity.deal_id` (T-0111, Agent 3;
-- D-L88, D-L65, D-L76, D-L120, D-L129, D-P33).
--
-- D-L88 approved `activity.deal_id`; the T-0111 suite (R14-R17) pins its
-- shape. EXPAND ONLY: one nullable column, its key, its index, its grant and
-- its catalogue row. Nothing existing is changed or dropped. In this one file:
--
--   1. locks, taken up front in a fixed order (catalogue, deal, activity);
--   2. the clash pre-check (catalogue recipe step 2), BEFORE anything changes;
--   3. deal gains UNIQUE (tenant_id, programme_id, id), the target of the new
--      composite FK;
--   4. the column `deal_id` and its composite FK, RESTRICT both ways;
--   5. the deal timeline index;
--   6. kasuwa_app's column-level UPDATE on `deal_id`;
--   7. the standard field_def `deal_id` for every tenant, and the proof;
--   8. a self-check of what this file promises.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- NOT HERE: no new table, no new function, no trigger, no policy change, no
-- SECURITY DEFINER (CLAUDE.md 2.7: the census stays at two). 0027's
-- at-least-one-target CHECK is unchanged: `deal_id` is a LINK, never a target
-- (R1), so an activity still needs a contact or an account.
--
-- ---------------------------------------------------------------------------
-- THE COLUMN
-- ---------------------------------------------------------------------------
--   deal_id  uuid NULL, no default. Every existing activity is NULL (a
--            nullable column without a default is a catalogue-only ADD
--            COLUMN; nothing is backfilled or rewritten).
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3, D-L76, D-L88)
-- ---------------------------------------------------------------------------
--   - ONE FK, activity_deal_same_programme_fk: (tenant_id, programme_id,
--     deal_id) -> deal (tenant_id, programme_id, id). A deal is always in the
--     activity's OWN programme and tenant. Referential checks ignore row
--     security, so a supervisor who reads A1 and A2 is stopped only by this
--     key from linking an A1 activity to an A2 deal; a deal elsewhere and an
--     id that names nothing fail the same FK with the same message (R2: no
--     existence oracle across the BPO boundary). The API answers 400
--     unknown_reference before the database is asked.
--   - ON UPDATE RESTRICT and ON DELETE RESTRICT (D-L76, R16). NO ACTION, the
--     default, accepts a one-statement id rotation (`UPDATE deal SET id =
--     CASE ...`) that silently re-points every linked activity at another
--     deal; RESTRICT refuses changing or deleting a deal key that an activity
--     still references, the migrator included. Never CASCADE: deleting a deal
--     must never delete notes and call logs, and the API has no deal delete
--     (T-0105 R13).
--   - Offboarding still works: a programme or tenant delete reaches activity
--     and deal through their own CASCADE FKs, and the RESTRICT checks queued by
--     the cascaded deal deletes run after those cascades, by which time the
--     linked activities are gone (0026 and 0027 explain the same for contact
--     and account). The T-0111 suite deletes a programme and a tenant holding
--     linked activities, as kasuwa_migrator.
--   - THE TARGET KEY, deal_tenant_programme_id_key UNIQUE (tenant_id,
--     programme_id, id): deal had only (tenant_id, programme_id, pipeline_id,
--     id) (0036), and an FK needs a unique key on exactly its referenced
--     columns. D-L120 asks every deal unique key to lead with (tenant_id,
--     programme_id, pipeline_id) so that a key check cannot collide with
--     another tenant's or programme's row (an existence oracle). This key
--     leads with (tenant_id, programme_id) and then `id`, which is already
--     globally unique through the primary key: an INSERT naming another
--     tenant's deal id fails on the primary key first, exactly as it did
--     before this file, so the new key adds no answer that was not already
--     given. It is a deliberate, argued exception to D-L120's third column;
--     section 8 checks that it leads with tenant_id, programme_id.
--   - THE KEY GUARD (D-L76) IS UNCHANGED (R17): app.guard_activity_keys_fixed()
--     still fires only when id, tenant_id or programme_id change, so
--     kasuwa_app and kasuwa_test_admin may set, move and clear deal_id, and
--     neither may re-key an activity. No trigger is touched.
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   - No new table: activity keeps RLS ENABLED and FORCED, activity_isolation
--     (tenant AND programme, WITH CHECK identical to USING) and
--     activity_no_delete, all of which cover a new column unchanged.
--     TENANT_SCOPED_TABLES is unchanged.
--   - kasuwa_app gets UPDATE on exactly `deal_id` (0027 made its UPDATE
--     column-level; a new column is NOT covered by a column grant): linking,
--     moving and clearing the link are updates (R4). INSERT and SELECT are
--     table-level and already cover it. kasuwa_test_admin holds table-level
--     privileges (0027) and needs nothing new. Still no UPDATE on id,
--     tenant_id, programme_id, created_by_user_id or created_at.
--   - deal is unchanged apart from its new unique key: no grant, policy or
--     trigger of 0036 moves. Linking never writes the deal row (R4).
--
-- ---------------------------------------------------------------------------
-- INDEX (D-L65 keyset, D-P33, R15)
-- ---------------------------------------------------------------------------
--   - activity_deal_keyset_idx (tenant_id, programme_id, deal_id, created_at
--     DESC, id DESC) WHERE deal_id IS NOT NULL: one deal's activities, newest
--     first (D-L77), exactly 0027's contact and account keyset indexes for the
--     third link. It is also the lookup for the new FK when a deal is deleted
--     or re-keyed (the `deal_id = $n` equality implies the predicate).
--   - RLS-SAFE: plain columns, a plain IS NOT NULL predicate, and equality and
--     range comparisons through btree operators of uuid and timestamptz,
--     which are LEAKPROOF in PostgreSQL 16 (section 8 reads it and stops the
--     file if one is not; nothing here marks anything LEAKPROOF). The T-0111
--     suite replays the timeline's page and continuation queries as
--     kasuwa_app at 20,000 activities: no Sort and no Seq Scan.
--   - Partial, so it is not a column-prefix duplicate of any other index
--     (schema-hygiene, T-0011 rule (c)); the new unique key on deal is unique,
--     which that rule never flags.
--
-- ---------------------------------------------------------------------------
-- METADATA (the catalogue recipe in packages/db/src/standard-object-catalogue.ts)
-- ---------------------------------------------------------------------------
--   - PRE-CHECK FIRST: a tenant with a CUSTOM field named `deal_id` on its
--     STANDARD `activity` object stops this file before anything changes,
--     with a message naming the field and the number of such tenants. Which
--     field keeps the name is a human decision. The same name on another
--     object (deal_requirement_check has a column of that name, not a field),
--     or on a custom object, is not a clash.
--   - BACKFILL: one standard field_def per tenant on its standard `activity`
--     object, is_custom = false, as kasuwa_migrator (BYPASSRLS, so every
--     tenant): `deal_id` "Deal", lookup, config exactly
--     {"targetObjectApiName": "deal"}, classification none (an id, as
--     contact_id and account_id), not required (R5). The jsonb literal below
--     is this file's frozen copy of the catalogue's new entry; the seed and
--     provisioning write the same row from STANDARD_OBJECT_CATALOGUE through
--     ensureStandardObjectDefs. ON CONFLICT DO NOTHING: after the pre-check, a
--     row already there is a standard one.
--   - PROOF: every tenant has a standard `activity` object (else the remedy
--     is named), every tenant has the field with the catalogue's meaning, and
--     nothing standard on `activity` falls outside the eleven.
--   - Messages carry catalogue names and counts only, never tenant data.
--   - DEPLOY WINDOW (a required deploy step, as 0025 and 0034): a tenant
--     provisioned by the PREVIOUS release between `pnpm db:migrate` and the
--     new release's rollout gets no `deal_id` field_def, so its matrix fails
--     closed (the link withheld, deal timelines without activities). After
--     rollout, as kasuwa_migrator, run ensureStandardObjectDefs for every
--     tenant created since the migrate began; it is idempotent.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
-- WHY PLAIN DDL IS ACCEPTABLE HERE: no populated cell exists yet (D-L65,
-- D-L77, restated by D-L129 for this file). Every table this file touches holds
-- seed and test rows only, so each statement below completes in milliseconds
-- and nothing waits behind its locks for long. The same file against a
-- populated cell would block activity and deal traffic for the length of two
-- scans, which is why it MUST be split at volume (below).
--   - object_def, field_def: SHARE ROW EXCLUSIVE for the whole file, as 0028
--     and 0034 (blocks catalogue writes, not reads; dozens of rows per tenant).
--   - deal: ACCESS EXCLUSIVE for the whole file. ADD CONSTRAINT ... UNIQUE
--     builds a b-tree by scanning every deal row; adding the FK takes SHARE
--     ROW EXCLUSIVE on deal anyway, which the first lock already covers.
--   - activity: ACCESS EXCLUSIVE for the whole file. ADD COLUMN is
--     catalogue-only (nullable, no default); ADD CONSTRAINT ... FOREIGN KEY
--     validates by scanning activity (every row is NULL, so nothing is looked
--     up); CREATE INDEX scans once.
--   - Taken up front, in one fixed order (catalogue, deal, activity), so this
--     file cannot deadlock against itself; lock_timeout = 5s refuses to queue
--     behind a long transaction (and make everything behind it queue too).
--   - At volume (the first populated cell onward) split it into four files,
--     in this order:
--       1. a `-- kasuwa:no-transaction` file: CREATE UNIQUE INDEX CONCURRENTLY
--          on deal (tenant_id, programme_id, id) (SHARE UPDATE EXCLUSIVE:
--          deal reads and writes carry on);
--       2. an ordinary file: ADD COLUMN deal_id (catalogue-only), ALTER TABLE
--          deal ADD CONSTRAINT ... UNIQUE USING INDEX (catalogue-only), the FK
--          as NOT VALID (no scan), the grant and the catalogue rows;
--       3. a `-- kasuwa:no-transaction` file: CREATE INDEX CONCURRENTLY
--          activity_deal_keyset_idx, now that the column exists;
--       4. ALTER TABLE activity VALIDATE CONSTRAINT
--          activity_deal_same_programme_fk (SHARE UPDATE EXCLUSIVE: reads and
--          writes carry on; it may run in a no-transaction file, the runner
--          allows a lone VALIDATE CONSTRAINT there).
--   - Steady state: one more b-tree insert on every deal INSERT; a partial
--     index insert and one FK probe on deal only for an activity write that
--     carries a deal_id. Unlinked activities pay nothing.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied: it is one transaction and the
-- runner records it only on COMMIT. Fix the cause (a clash: rename or delete
-- the tenant's custom `deal_id` field, a human decision) and run
-- `pnpm db:migrate` again.
-- To undo it after it has applied: never edit or delete this file or its
-- ledger row (append-only). The column is additive, so the previous release
-- runs against it unchanged (it never names deal_id). In this order:
--   1. roll back the application (the `dealId` writes, listDealTimeline, the
--      catalogue entry, the schema.ts mirror); links already made stay in the
--      column, unread;
--   2. if the links must go: export them, then in a NEW migration, as
--      kasuwa_migrator, DROP INDEX activity_deal_keyset_idx; ALTER TABLE
--      activity DROP CONSTRAINT activity_deal_same_programme_fk, DROP COLUMN
--      deal_id; DELETE the standard `deal_id` field_def rows of `activity`
--      (their field_security_grant rows cascade);
--   3. deal's new UNIQUE (deal_tenant_programme_id_key) may stay: it is
--      harmless. Drop it (brief ACCESS EXCLUSIVE) only if nothing references
--      it.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
LOCK TABLE object_def, field_def IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE deal IN ACCESS EXCLUSIVE MODE;
LOCK TABLE activity IN ACCESS EXCLUSIVE MODE;

-- --- 2. the clash pre-check, before anything changes --------------------------
DO $$
DECLARE
  new_fields constant text[] := ARRAY['deal_id'];
  clashing_tenants bigint;
BEGIN
  SELECT pg_catalog.count(DISTINCT f.tenant_id)
    INTO clashing_tenants
    FROM public.field_def f
    JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE o.api_name = 'activity' AND NOT o.is_custom
     AND f.is_custom
     AND f.api_name = ANY (new_fields);
  IF clashing_tenants > 0 THEN
    RAISE EXCEPTION '0037: a custom field deal_id on the standard activity object clashes with the new standard activity field in % tenant(s). Nothing was applied. Rename or remove each custom field (a human decision: it has its own meaning and data), then re-run.',
      clashing_tenants;
  END IF;
END
$$;

-- --- 3. deal: the key the composite FK needs ----------------------------------
-- See KEYS in the header: led by (tenant_id, programme_id); id is already the
-- primary key, so this answers nothing the primary key did not.
ALTER TABLE deal
  ADD CONSTRAINT deal_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id);

-- --- 4. the column and its key --------------------------------------------------
-- Not NO ACTION and never CASCADE: see KEYS in the header.
ALTER TABLE activity
  ADD COLUMN deal_id uuid,
  ADD CONSTRAINT activity_deal_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, deal_id)
    REFERENCES deal (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMENT ON COLUMN activity.deal_id IS
  'The deal this activity is linked to (T-0111, D-L88): a link, never a target. Always in the activity''s programme (activity_deal_same_programme_fk). NULL when none.';

-- --- 5. the deal timeline index ---------------------------------------------------
-- One deal's activities, newest first, and the FK lookup. Plain columns and a
-- plain predicate only (RLS-safe, header).
CREATE INDEX activity_deal_keyset_idx
  ON activity (tenant_id, programme_id, deal_id, created_at DESC, id DESC)
  WHERE deal_id IS NOT NULL;

-- --- 6. grants ---------------------------------------------------------------------
-- 0027's UPDATE is column-level; a new column needs its own grant (R4: linking
-- is an update).
GRANT UPDATE (deal_id) ON activity TO kasuwa_app;

-- --- 7. the standard field: backfill, then prove ---------------------------------
DO $$
DECLARE
  -- Frozen copy of the new `activity` entry of STANDARD_OBJECT_CATALOGUE
  -- (packages/db/src/standard-object-catalogue.ts).
  new_fields constant jsonb := '[
    {"api_name": "deal_id", "label": "Deal", "type": "lookup", "classification": "none", "is_required": false, "config": {"targetObjectApiName": "deal"}}
  ]';
  -- Every standard field `activity` may carry after this file.
  activity_standard constant text[] := ARRAY[
    'type', 'subject', 'body', 'due_at', 'completed_at', 'starts_at', 'ends_at',
    'owner_user_id', 'contact_id', 'account_id', 'deal_id'
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
   WHERE o.api_name = 'activity' AND NOT o.is_custom
  ON CONFLICT (tenant_id, object_id, api_name) DO NOTHING;

  -- A tenant with no standard `activity` object got no field above (a tenant
  -- provisioned in 0027's deploy window). Say so with the remedy. Counts only.
  SELECT pg_catalog.count(*)
    INTO affected_tenants
    FROM public.tenant t
   WHERE NOT EXISTS (
           SELECT 1 FROM public.object_def o
            WHERE o.tenant_id = t.id AND o.api_name = 'activity' AND NOT o.is_custom);
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0037: % tenant(s) have no standard activity object, so they cannot be given the new activity field. Nothing was applied. Run ensureStandardObjectDefs (packages/db) for each of those tenants, as kasuwa_migrator, then re-run.',
      affected_tenants;
  END IF;

  -- Every tenant has the new field: standard, on its standard activity
  -- object, with the catalogue's meaning and at least its classification.
  SELECT pg_catalog.count(DISTINCT t.id),
         pg_catalog.string_agg(DISTINCT 'activity.' || c.api_name, ', ')
    INTO affected_tenants, problem
    FROM public.tenant t
   CROSS JOIN jsonb_to_recordset(new_fields)
           AS c (api_name text, type text, classification text, is_required boolean, config jsonb)
   WHERE NOT EXISTS (
           SELECT 1
             FROM public.field_def f
             JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
            WHERE f.tenant_id = t.id
              AND o.api_name = 'activity' AND NOT o.is_custom
              AND f.api_name = c.api_name AND NOT f.is_custom
              AND f.type = c.type
              AND f.config = c.config
              AND f.is_required = c.is_required
              AND pg_catalog.array_position(classification_rank, f.classification)
               >= pg_catalog.array_position(classification_rank, c.classification));
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0037 backfill incomplete: % tenant(s) lack or mis-type the standard field(s) %',
      affected_tenants, problem;
  END IF;

  -- Nothing standard on `activity` that the catalogue does not name. Names
  -- here are tenant data: counts only.
  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT f.tenant_id)
    INTO stray_rows, affected_tenants
    FROM public.field_def f
    JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE o.api_name = 'activity' AND NOT o.is_custom
     AND NOT f.is_custom
     AND f.api_name <> ALL (activity_standard);
  IF stray_rows > 0 THEN
    RAISE EXCEPTION '0037: % standard activity field_def row(s) in % tenant(s) are not in the standard catalogue; mark them custom or remove them, then re-run',
      stray_rows, affected_tenants;
  END IF;
END
$$;

-- --- 8. prove what this file promises -----------------------------------------
-- Runs once, here. The standing guards are the T-0111 and T-0060 acceptance
-- suites, which run on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  activity_rel constant pg_catalog.oid := 'public.activity'::pg_catalog.regclass;
  deal_rel constant pg_catalog.oid := 'public.deal'::pg_catalog.regclass;
  held text;
  counted bigint;
BEGIN
  -- RLS unchanged: ENABLED and FORCED on both tables, owned by the migrator.
  SELECT pg_catalog.string_agg(c.relname::text, ', ' ORDER BY c.relname) INTO held
    FROM pg_catalog.pg_class c
   WHERE c.oid IN (activity_rel, deal_rel)
     AND (NOT (c.relrowsecurity AND c.relforcerowsecurity)
          OR pg_catalog.pg_get_userbyid(c.relowner) <> 'kasuwa_migrator');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0037: RLS not enabled and forced, or not owned by kasuwa_migrator: %', held;
  END IF;
  -- activity_isolation is still a permissive FOR ALL policy whose USING
  -- calls app.current_tenant_id() and app.current_programme_ids(), and whose
  -- WITH CHECK is textually identical to its USING.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                  WHERE p.polrelid = activity_rel
                    AND p.polname = 'activity_isolation'
                    AND p.polpermissive AND p.polcmd = '*'
                    AND pg_catalog.strpos(pg_catalog.pg_get_expr(p.polqual, p.polrelid),
                                          'app.current_tenant_id()') > 0
                    AND pg_catalog.strpos(pg_catalog.pg_get_expr(p.polqual, p.polrelid),
                                          'app.current_programme_ids()') > 0
                    AND pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                      = pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)) THEN
    RAISE EXCEPTION '0037: activity_isolation is missing, no longer names tenant and programme, or its WITH CHECK is not its USING';
  END IF;

  -- The column: a nullable uuid, no default.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = activity_rel AND a.attname = 'deal_id' AND NOT a.attisdropped
                    AND a.atttypid = 'uuid'::pg_catalog.regtype AND NOT a.attnotnull
                    AND NOT a.atthasdef) THEN
    RAISE EXCEPTION '0037: activity.deal_id is not a nullable uuid without a default';
  END IF;

  -- The grant: UPDATE on deal_id; never a key, the creator or the creation time.
  IF NOT (pg_catalog.has_column_privilege(app_role, 'public.activity', 'deal_id', 'UPDATE')
          AND pg_catalog.has_column_privilege(app_role, 'public.activity', 'deal_id', 'INSERT')) THEN
    RAISE EXCEPTION '0037: kasuwa_app cannot link an activity to a deal (INSERT, UPDATE on deal_id)';
  END IF;
  SELECT pg_catalog.string_agg(c.col, ', ' ORDER BY c.col) INTO held
    FROM pg_catalog.unnest(ARRAY['id', 'tenant_id', 'programme_id', 'created_by_user_id',
                                 'created_at']) AS c(col)
   WHERE pg_catalog.has_column_privilege(app_role, 'public.activity', c.col, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0037: kasuwa_app may UPDATE activity column(s) it must not: %', held;
  END IF;

  -- Exactly one FK from activity to deal, through (tenant_id, programme_id,
  -- deal_id) -> (tenant_id, programme_id, id), RESTRICT on update and delete.
  -- (The two-array unnest below is FROM-clause syntax, which cannot be
  -- schema-qualified.)
  SELECT pg_catalog.count(*) INTO counted
    FROM pg_catalog.pg_constraint con
   WHERE con.contype = 'f' AND con.conrelid = activity_rel AND con.confrelid = deal_rel;
  IF counted <> 1 THEN
    RAISE EXCEPTION '0037: activity has % foreign key(s) to deal, expected exactly one', counted;
  END IF;
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint con
        WHERE con.contype = 'f' AND con.conrelid = activity_rel AND con.confrelid = deal_rel
          AND con.confupdtype = 'r' AND con.confdeltype = 'r'
          AND (SELECT pg_catalog.array_agg(la.attname::text || '->' || fa.attname::text
                                           ORDER BY la.attname)
                 FROM unnest(con.conkey, con.confkey) AS k(local_att, foreign_att)
                 JOIN pg_catalog.pg_attribute la
                   ON la.attrelid = con.conrelid AND la.attnum = k.local_att
                 JOIN pg_catalog.pg_attribute fa
                   ON fa.attrelid = con.confrelid AND fa.attnum = k.foreign_att)
              = ARRAY['deal_id->id', 'programme_id->programme_id', 'tenant_id->tenant_id']) THEN
    RAISE EXCEPTION '0037: the activity -> deal key is not (tenant_id, programme_id, deal_id) -> (tenant_id, programme_id, id), RESTRICT both ways';
  END IF;

  -- The key guard is 0027's, unchanged: a BEFORE UPDATE row trigger calling
  -- app.guard_activity_keys_fixed(), whose WHEN clause names id, tenant_id
  -- and programme_id and never deal_id, so setting the link never fires it
  -- (R17). The function itself never mentions deal_id either.
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = activity_rel
          AND t.tgname = 'activity_keys_fixed' AND NOT t.tgisinternal
          AND t.tgfoid = 'app.guard_activity_keys_fixed()'::pg_catalog.regprocedure
          AND pg_catalog.strpos(pg_catalog.pg_get_triggerdef(t.oid),
                                'BEFORE UPDATE ON public.activity FOR EACH ROW WHEN') > 0
          AND pg_catalog.strpos(pg_catalog.pg_get_triggerdef(t.oid),
                                'new.id IS DISTINCT FROM old.id') > 0
          AND pg_catalog.strpos(pg_catalog.pg_get_triggerdef(t.oid),
                                'new.tenant_id IS DISTINCT FROM old.tenant_id') > 0
          AND pg_catalog.strpos(pg_catalog.pg_get_triggerdef(t.oid),
                                'new.programme_id IS DISTINCT FROM old.programme_id') > 0
          AND pg_catalog.strpos(pg_catalog.pg_get_triggerdef(t.oid), 'deal_id') = 0
          AND pg_catalog.strpos((SELECT p.prosrc FROM pg_catalog.pg_proc p
                                  WHERE p.oid = t.tgfoid), 'deal_id') = 0) THEN
    RAISE EXCEPTION '0037: the activity key guard is missing or no longer 0027''s (BEFORE UPDATE, WHEN on id, tenant_id and programme_id only)';
  END IF;

  -- The timeline index: valid, its keys in the timeline's order (R15).
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_index x
         JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
        WHERE x.indrelid = activity_rel AND i.relname = 'activity_deal_keyset_idx'
          AND x.indisvalid AND x.indnkeyatts = 5
          AND pg_catalog.pg_get_indexdef(x.indexrelid, 1, true) = 'tenant_id'
          AND pg_catalog.pg_get_indexdef(x.indexrelid, 2, true) = 'programme_id'
          AND pg_catalog.pg_get_indexdef(x.indexrelid, 3, true) = 'deal_id'
          AND pg_catalog.pg_get_indexdef(x.indexrelid, 4, true) = 'created_at'
          AND pg_catalog.pg_get_indexdef(x.indexrelid, 5, true) = 'id'
          -- One column's indexdef carries no direction; indoption bit 0 is DESC.
          AND (x.indoption[3] & 1) = 1 AND (x.indoption[4] & 1) = 1
          AND pg_catalog.pg_get_expr(x.indpred, x.indrelid) = '(deal_id IS NOT NULL)') THEN
    RAISE EXCEPTION '0037: activity_deal_keyset_idx is missing, invalid or not keyed (tenant_id, programme_id, deal_id, created_at DESC, id DESC)';
  END IF;

  -- UNIQUE KEYS (D-L120, and the argued exception in KEYS): every unique key on
  -- deal but the primary key still leads with tenant_id, programme_id.
  SELECT pg_catalog.string_agg(ic.relname::text, ', ' ORDER BY ic.relname) INTO held
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
   WHERE i.indrelid = deal_rel AND i.indisunique AND NOT i.indisprimary
     AND (i.indnkeyatts < 3
          OR pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) <> 'tenant_id'
          OR pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) <> 'programme_id');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0037: deal unique key(s) not led by tenant_id, programme_id: %', held;
  END IF;

  -- The INDEX claim (D-P33): every operator the timeline compares key columns
  -- with is already LEAKPROOF in this server. Read only; nothing is marked
  -- LEAKPROOF here. If one is not, stop and escalate; never mark it.
  SELECT pg_catalog.string_agg(f.name, ', ' ORDER BY f.name)
    INTO held
    FROM pg_catalog.unnest(ARRAY['uuid_eq', 'uuid_lt', 'uuid_gt', 'timestamptz_eq',
                                 'timestamptz_lt', 'timestamptz_le', 'timestamptz_gt',
                                 'timestamptz_ge']) AS f(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                      WHERE p.oid = f.name::pg_catalog.regproc AND p.proleakproof);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0037: the timeline predicates use operator functions that are not LEAKPROOF: %; escalate (T-0111), do not mark them', held;
  END IF;

  -- Still exactly the two SECURITY DEFINER functions (CLAUDE.md 2.7).
  SELECT pg_catalog.count(*) INTO counted
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema');
  IF counted <> 2 THEN
    RAISE EXCEPTION '0037: % SECURITY DEFINER function(s), expected exactly two', counted;
  END IF;
END
$$;
