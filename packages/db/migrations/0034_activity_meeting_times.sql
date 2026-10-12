-- ---------------------------------------------------------------------------
-- 0034 - a meeting's times on `activity` (T-0082, Agent 3; D-L105, D-L107,
-- D-L87, D-P22).
--
-- P07's meetings: a fourth activity type, `meeting`, with a start and an end.
-- In this one file:
--
--   1. locks, taken up front in a fixed order (catalogue, then activity);
--   2. the clash pre-check (catalogue recipe step 2), BEFORE anything changes;
--   3. the columns `starts_at` and `ends_at`, `meeting` in the type CHECK, the
--      meeting-times CHECK and the 24-hour span CHECK;
--   4. kasuwa_app's column-level UPDATE on the two new columns;
--   5. two partial indexes for "my open tasks" and "my meetings";
--   6. the standard field_defs `starts_at` and `ends_at` for every tenant,
--      and the proof;
--   7. a self-check of what this file promises.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- NOT HERE (D-P22, D-P29, D-L105): attendees, a location, an IANA time zone
-- per meeting, reminders, an external calendar id. No new table, no new
-- function, no SECURITY DEFINER (CLAUDE.md 2.7: the census stays at two).
--
-- ---------------------------------------------------------------------------
-- COLUMNS
-- ---------------------------------------------------------------------------
--   starts_at  timestamptz NULL   a meeting's start, UTC in the database
--   ends_at    timestamptz NULL   a meeting's end
--
--   - THE MEETING-TIMES CHECK (D-L107): a meeting has BOTH times and its end
--     is after its start (equal is not after); a note, a task or a call has
--     NEITHER. CHECKs run on INSERT and on every UPDATE, so an UPDATE that
--     changes a meeting's type, or clears one time, is refused as well.
--   - THE SPAN CHECK (T-0082 migration review): a meeting lasts at most 24
--     hours, `ends_at - starts_at <= interval '24 hours'`. The API refuses a
--     longer one first (`400 too_long`, MEETING_MAX_MS in
--     apps/api/src/activities/activities.schemas.ts, the same 24 hours); the
--     CHECK is the backstop for every other writer, and it is what lets
--     listCalendar bound its meeting scan to `starts_at > from - 24 hours`.
--     If the limit ever moves, it moves here, in that constant and in the
--     calendar bound together, in a new migration.
--   - 0027's task-fields CHECK is unchanged: due_at and completed_at stay
--     task-only, so a meeting has no due time and is never completed.
--   - Nullable, no default: ADD COLUMN is a catalogue-only change, and no
--     existing row is a meeting, so every existing row already satisfies the
--     new CHECK (it is validated by the scan below all the same).
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   - No new table: activity keeps RLS ENABLED and FORCED and its
--     activity_isolation policy (tenant AND programme, WITH CHECK = USING),
--     which covers new columns without change. TENANT_SCOPED_TABLES is
--     unchanged.
--   - kasuwa_app gets UPDATE on exactly the two new columns (0027 made its
--     UPDATE column-level; a new column is NOT covered by a column grant).
--     Snooze and reschedule (D-P18, D-L87) are updates. INSERT and SELECT are
--     table-level grants and already cover them. kasuwa_test_admin holds
--     table-level privileges (0027) and needs nothing new.
--   - The key guard (0027) is untouched: id, tenant_id and programme_id stay
--     fixed for every role but the migrator.
--
-- ---------------------------------------------------------------------------
-- INDEXES (D-L65 keyset; the T-0082 escalation question)
-- ---------------------------------------------------------------------------
--   - activity_owner_open_task_due_idx (tenant_id, owner_user_id, due_at, id)
--     WHERE type = 'task' AND completed_at IS NULL: listMyActivities, the
--     caller's own OPEN tasks by due time, ties by id, undated last (btree
--     ASC sorts NULLs last, which is exactly the contract's order).
--   - activity_owner_meeting_starts_idx (tenant_id, owner_user_id, starts_at,
--     id) WHERE type = 'meeting': listCalendar's meetings by start.
--   - listCalendar's tasks (open AND completed, by due time) use 0027's
--     activity_owner_due_idx (tenant_id, owner_user_id, due_at).
--   - RLS-SAFE: every key is a plain column and every predicate a plain
--     column comparison against a constant or a bound parameter, through
--     btree operators of uuid, text and timestamptz, all LEAKPROOF in
--     PostgreSQL 16 (section 7 below checks it, and stops the file if one is
--     not). No expression key, no function in a predicate, and nothing here
--     marks anything LEAKPROOF. So the planner may use either
--     index under activity_isolation (the escalation in the task file does
--     not arise).
--   - Both partial, so neither is a column-prefix duplicate of another index
--     (schema-hygiene T-0011's rule (c)).
--   - Built on the table as it is: no populated cell exists (D-L65), so a
--     plain CREATE INDEX under the ACCESS EXCLUSIVE lock below. At volume the
--     two indexes move to a `-- kasuwa:no-transaction` file built
--     CONCURRENTLY, as 0027's header describes.
--
-- ---------------------------------------------------------------------------
-- METADATA (the catalogue recipe in packages/db/src/standard-object-catalogue.ts)
-- ---------------------------------------------------------------------------
--   - PRE-CHECK FIRST: a tenant with a CUSTOM field named `starts_at` or
--     `ends_at` on its STANDARD `activity` object stops this file before
--     anything changes, with a message naming the fields and the number of
--     such tenants. Which field keeps the name is a human decision. The same
--     name on another object, or on a custom object, is not a clash.
--   - BACKFILL: two standard field_defs per tenant on its standard
--     `activity` object, is_custom = false, as kasuwa_migrator (BYPASSRLS, so
--     every tenant). The jsonb literal below is this file's frozen copy of the
--     catalogue's two new entries; the seed and provisioning write the same
--     rows from STANDARD_OBJECT_CATALOGUE through ensureStandardObjectDefs.
--     ON CONFLICT DO NOTHING: after the pre-check, a row already there is a
--     standard one.
--   - Fields: starts_at "Starts" and ends_at "Ends", datetime, not required,
--     classification none (as due_at): a time is not personal data on its
--     own. Field security may still withhold either (D-L107).
--   - PROOF: every tenant has a standard `activity` object (else the remedy
--     is named), every tenant has both fields with the catalogue's meaning,
--     and nothing standard on `activity` falls outside the ten.
--   - Messages carry catalogue names and counts only, never tenant data.
--   - DEPLOY WINDOW (a required deploy step, as 0025): a tenant provisioned
--     by the PREVIOUS release between `pnpm db:migrate` and the new release's
--     rollout is created from the old catalogue, so it gets no starts_at or
--     ends_at field_def (and its field matrix then fails closed: both times
--     withheld, every meeting dropped from that tenant's calendar). After
--     rollout, as kasuwa_migrator, run ensureStandardObjectDefs
--     (packages/db/src/standard-object-catalogue.ts) for every tenant created
--     since the migrate began; it is idempotent, so running it for every
--     tenant is also safe. Or do not provision in that window.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
-- No populated cell exists yet (D-L65), so this file uses plain DDL:
--   - object_def, field_def: SHARE ROW EXCLUSIVE for the whole file, as 0028
--     (blocks catalogue writes, not reads; dozens of rows per tenant).
--   - activity: ACCESS EXCLUSIVE for the whole file. ADD COLUMN is
--     catalogue-only; ADD CONSTRAINT ... CHECK scans every activity row once
--     per constraint, and each CREATE INDEX scans once. At volume, split:
--     the CHECKs as NOT VALID then VALIDATE CONSTRAINT in a second file
--     (SHARE UPDATE EXCLUSIVE: reads and writes carry on), and the indexes
--     CONCURRENTLY in a `-- kasuwa:no-transaction` file.
--   - lock_timeout = 5s refuses to queue behind a long transaction.
--   - Steady state: two more partial-index inserts on a task or meeting
--     write; nothing on a note or a call (outside both predicates).
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied: it is one transaction and the
-- runner records it only on COMMIT. Fix the cause (a clash: rename or delete
-- the tenant's custom field, a human decision) and run `pnpm db:migrate`.
-- To undo it after it has applied: never edit or delete this file or its
-- ledger row (append-only). THERE IS NO CODE-ONLY ROLLBACK ONCE A MEETING
-- EXISTS: the previous release does not know the type, so its timeline reads
-- (which refuse an unknown type rather than send it) fail on any record with
-- a meeting. In this order:
--   1. stop new meetings: switch off whatever creates them (P07's composer),
--      or ship a build of this release that refuses `type: meeting` on
--      createActivity;
--   2. export the meetings if they hold data: they are records a tenant may
--      need to keep;
--   3. in a NEW migration, as kasuwa_migrator: convert the meetings (to notes,
--      clearing both times) or DELETE them, so that no row needs the type;
--   4. only then roll the application back, with the two catalogue entries,
--      the schema.ts mirror and ACTIVITY_TYPES;
--   5. optionally, in a later NEW migration: DROP the two indexes; DROP
--      CONSTRAINT activity_meeting_times_check and activity_meeting_span_check;
--      re-create activity_type_check as note | task | call; DROP COLUMN
--      starts_at, ends_at; DELETE the two standard field_defs (their
--      field_security_grant rows cascade). The old release ignores the
--      columns, so this step can wait.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
LOCK TABLE object_def, field_def IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE activity IN ACCESS EXCLUSIVE MODE;

-- --- 2. the clash pre-check, before anything changes --------------------------
DO $$
DECLARE
  new_fields constant text[] := ARRAY['starts_at', 'ends_at'];
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
    RAISE EXCEPTION '0034: a custom field starts_at or ends_at on the standard activity object clashes with the new standard activity fields in % tenant(s). Nothing was applied. Rename or remove each custom field (a human decision: it has its own meaning and data), then re-run.',
      clashing_tenants;
  END IF;
END
$$;

-- --- 3. the columns and their checks -------------------------------------------
ALTER TABLE activity
  ADD COLUMN starts_at timestamptz,
  ADD COLUMN ends_at   timestamptz;

-- `meeting` joins the codes. Dropped and re-created in the same statement, so
-- no moment exists in which the type is unchecked.
ALTER TABLE activity
  DROP CONSTRAINT activity_type_check,
  ADD CONSTRAINT activity_type_check CHECK (type IN ('note', 'task', 'call', 'meeting'));

-- D-L107: a meeting has both times, end after start; nothing else has either.
ALTER TABLE activity
  ADD CONSTRAINT activity_meeting_times_check CHECK (
    CASE WHEN type = 'meeting'
         THEN starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at
         ELSE starts_at IS NULL AND ends_at IS NULL
    END
  );

-- The span backstop (header, COLUMNS): at most 24 hours, as the API's
-- MEETING_MAX_MS. NULL times pass here and are the check above's business.
ALTER TABLE activity
  ADD CONSTRAINT activity_meeting_span_check CHECK (
    type <> 'meeting' OR ends_at - starts_at <= interval '24 hours'
  );

COMMENT ON COLUMN activity.starts_at IS
  'A meeting''s start (T-0082, D-L107). NULL on a note, a task or a call; set on every meeting.';
COMMENT ON COLUMN activity.ends_at IS
  'A meeting''s end, after starts_at (T-0082, D-L107). At most 24 hours after it (activity_meeting_span_check).';

-- --- 4. grants -------------------------------------------------------------------
-- 0027's UPDATE is column-level; a new column needs its own grant (snooze and
-- reschedule are updates, D-P18, D-L87).
GRANT UPDATE (starts_at, ends_at) ON activity TO kasuwa_app;

-- --- 5. indexes ------------------------------------------------------------------
-- listMyActivities: the caller's own open tasks by due time, ties by id,
-- undated last. Plain columns and plain predicates only (RLS-safe, header).
CREATE INDEX activity_owner_open_task_due_idx
  ON activity (tenant_id, owner_user_id, due_at, id)
  WHERE type = 'task' AND completed_at IS NULL;

-- listCalendar: the caller's own meetings by start, ties by id.
CREATE INDEX activity_owner_meeting_starts_idx
  ON activity (tenant_id, owner_user_id, starts_at, id)
  WHERE type = 'meeting';

-- --- 6. the standard fields: backfill, then prove --------------------------------
DO $$
DECLARE
  -- Frozen copy of the two new `activity` entries of STANDARD_OBJECT_CATALOGUE
  -- (packages/db/src/standard-object-catalogue.ts).
  new_fields constant jsonb := '[
    {"api_name": "starts_at", "label": "Starts", "type": "datetime", "classification": "none", "is_required": false, "config": {}},
    {"api_name": "ends_at",   "label": "Ends",   "type": "datetime", "classification": "none", "is_required": false, "config": {}}
  ]';
  -- Every standard field `activity` may carry after this file.
  activity_standard constant text[] := ARRAY[
    'type', 'subject', 'body', 'due_at', 'completed_at', 'starts_at', 'ends_at',
    'owner_user_id', 'contact_id', 'account_id'
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
    RAISE EXCEPTION '0034: % tenant(s) have no standard activity object, so they cannot be given the new activity fields. Nothing was applied. Run ensureStandardObjectDefs (packages/db) for each of those tenants, as kasuwa_migrator, then re-run.',
      affected_tenants;
  END IF;

  -- Every tenant has both new fields: standard, on its standard activity
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
    RAISE EXCEPTION '0034 backfill incomplete: % tenant(s) lack or mis-type the standard field(s) %',
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
    RAISE EXCEPTION '0034: % standard activity field_def row(s) in % tenant(s) are not in the standard catalogue; mark them custom or remove them, then re-run',
      stray_rows, affected_tenants;
  END IF;
END
$$;

-- --- 7. prove what this file promises -----------------------------------------
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  held text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c WHERE c.oid = 'public.activity'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '0034: activity RLS is not enabled and forced';
  END IF;
  IF NOT (pg_catalog.has_column_privilege(app_role, 'public.activity', 'starts_at', 'UPDATE')
          AND pg_catalog.has_column_privilege(app_role, 'public.activity', 'ends_at', 'UPDATE')) THEN
    RAISE EXCEPTION '0034: kasuwa_app cannot reschedule a meeting (UPDATE on starts_at, ends_at)';
  END IF;
  IF EXISTS (SELECT 1
               FROM pg_catalog.unnest(ARRAY['id', 'tenant_id', 'programme_id',
                                            'created_by_user_id', 'created_at']) AS c(col)
              WHERE pg_catalog.has_column_privilege(app_role, 'public.activity', c.col, 'UPDATE')) THEN
    RAISE EXCEPTION '0034: kasuwa_app may UPDATE an activity column it must not';
  END IF;
  -- The INDEXES claim: every operator the two lists compare with is already
  -- LEAKPROOF in this server, so the planner may use the indexes under
  -- activity_isolation. Read only; nothing is marked LEAKPROOF here.
  SELECT pg_catalog.string_agg(f.name, ', ' ORDER BY f.name)
    INTO held
    FROM pg_catalog.unnest(ARRAY['texteq', 'uuid_eq', 'uuid_lt', 'uuid_gt', 'timestamptz_eq',
                                 'timestamptz_lt', 'timestamptz_le', 'timestamptz_gt',
                                 'timestamptz_ge']) AS f(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                      WHERE p.oid = f.name::pg_catalog.regproc AND p.proleakproof);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0034: the list predicates use operator functions that are not LEAKPROOF: %; escalate (T-0082), do not mark them', held;
  END IF;
END
$$;
