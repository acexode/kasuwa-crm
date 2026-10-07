-- ---------------------------------------------------------------------------
-- 0027 - the activity table (T-0060, Agent 3; D-L65, D-L67, D-L69, D-L72,
-- D-L74, D-L76, D-L77, D-P18, D-P24).
--
-- A programme-scoped `activity`: a note, a task or a logged call, against a
-- contact, an account or both. In this one file:
--
--   1. locks, taken up front in a fixed order;
--   2. the clash pre-check (D-P24), BEFORE anything changes;
--   3. contact gains UNIQUE (tenant_id, programme_id, id), the target of the
--      new composite FK (D-L77);
--   4. the table, its keys, checks, indexes, RLS and grants;
--   5. its triggers: updated_at (0018), version (0019) and the key guard;
--   6. the standard `activity` object_def and its field_defs for every
--      existing tenant, and the proof;
--   7. a self-check of the security posture.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- NOT HERE: deal_id (the pipeline slice adds it); start, end, an IANA timezone
-- and reminders (P07); the activity API (T-0061).
--
-- ---------------------------------------------------------------------------
-- COLUMNS
-- ---------------------------------------------------------------------------
--   id, tenant_id, programme_id     the tenancy keys; fixed at creation (KEYS)
--   type        text NOT NULL       CHECK: note | task | call. Codes, never
--                                   labels; text and a CHECK, not an enum
--                                   type, for 0019's VALUE SETS reason
--   subject     text NULL           free text; classified pii (D-L77)
--   body        text NULL           free text; classified pii. Never logged.
--   due_at, completed_at            timestamptz NULL, for tasks only (below)
--   owner_user_id       uuid NULL   -> "user" through (tenant_id, owner_user_id)
--   contact_id          uuid NULL   -> contact (tenant_id, programme_id, id)
--   account_id          uuid NULL   -> account (tenant_id, programme_id, id)
--   created_by_user_id  uuid NULL   -> "user" through (tenant_id, ...); NULL is
--                                   "the system", as the timeline actor (D-L73)
--   version     integer NOT NULL DEFAULT 1, maintained by app.bump_version()
--   created_at, updated_at          timestamptz NOT NULL DEFAULT now();
--                                   updated_at by app.touch_updated_at()
--
--   - AT LEAST ONE TARGET: a CHECK that contact_id or account_id is set. CHECKs
--     run on INSERT and on every UPDATE, so an UPDATE cannot clear the last
--     one. Both may be set (a call to a contact about their account).
--   - TASK FIELDS (left to the builder by D-L77): due_at and completed_at may
--     be set on a TASK only; on a note or a call both stay NULL. A call's time
--     is when it was logged (created_at, D-L77 "Ordering") until P07 adds
--     start and end. Refusing now is the reversible choice: dropping a CHECK
--     later is instant, while adding one to a populated hot table needs the
--     NOT VALID / VALIDATE dance and a clean-up of rows that break it.
--   - subject and body are nullable with no length limit here: the API
--     (T-0061) validates input, and a limit chosen now without a contract
--     would be guessed. owner_user_id is nullable as contact's is (an
--     unassigned task).
--   - D-L67 (the owner must belong to the activity's programme) is the
--     repository's, as for contacts. The schema checks only the tenant.
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3)
-- ---------------------------------------------------------------------------
-- Every FK to a tenant-scoped table carries tenant_id, because referential
-- checks ignore row security:
--   - (tenant_id, programme_id) -> programme: the activity's programme is in
--     its tenant.
--   - (tenant_id, programme_id, contact_id) -> contact and (tenant_id,
--     programme_id, account_id) -> account: a target is always in the
--     activity's OWN programme. A supervisor who sees A1 and A2 is not stopped
--     by RLS from linking across them; only the key stops it. An unreachable
--     target and an invented one fail the same FK with the same message (no
--     existence oracle across the BPO boundary).
--   - (tenant_id, owner_user_id) and (tenant_id, created_by_user_id) ->
--     "user": a user in another tenant fails exactly as an invented id.
--
-- ON UPDATE / ON DELETE (D-L74, D-L76):
--   - contact, account, owner and creator FKs: RESTRICT, both. NO ACTION, the
--     default, accepts a referenced key that is replaced within the same
--     statement, so `UPDATE contact SET id = CASE id WHEN X THEN <fresh> ELSE
--     X END WHERE id IN (X, Y)` would silently re-point every activity on X to
--     Y. RESTRICT refuses changing or deleting a key that an activity still
--     references, whatever else the statement does. It also refuses moving a
--     contact or account that has activities to another programme: its
--     (tenant, programme, id) key changes. There is no ON UPDATE CASCADE, which
--     would carry the activity, body and all, across a BPO client boundary.
--   - What happens to activities when a contact, account or user is deleted
--     stays open (D-L61); refusing is the answer that loses nothing.
--   - tenant and programme FKs: ON DELETE CASCADE (offboarding), ON UPDATE
--     RESTRICT (an id is never re-keyed under its children).
--   - RESTRICT does not break offboarding. A tenant or programme delete
--     reaches activity directly through its own CASCADE FKs, and the RI
--     machinery runs the RESTRICT checks queued by the cascaded contact,
--     account and "user" deletes after those cascades, by which time the
--     activities are gone (as 0026's header explains for account's parent
--     FK). The T-0060 suite deletes a programme and then a tenant that hold
--     activities on contacts and accounts, as kasuwa_migrator.
--
-- THE KEYS OF AN ACTIVITY ARE FIXED (D-L76, D-L77, and the lead's allow-list
-- instruction after the 0026 re-review): id, tenant_id and programme_id cannot
-- change, except by kasuwa_migrator. A BEFORE UPDATE row trigger,
-- app.guard_activity_keys_fixed(), raises 42501 (insufficient_privilege, as
-- 0023 and 0025) unless BOTH current_user AND session_user are
-- kasuwa_migrator. That is an ALLOW-list:
--   - kasuwa_app is refused, including after SET ROLE kasuwa_sweeper
--     (current_user changes, session_user does not);
--   - kasuwa_test_admin (BYPASSRLS) is refused, and so is any role created
--     later and given UPDATE: nothing passes unless it is named here;
--   - kasuwa_migrator, which owns the table and runs migrations, may still
--     correct a key. The FKs still bind it: a corrected programme_id must
--     match the targets' programme.
--   - A superuser session is refused too (session_user is not the migrator);
--     a superuser that must, can SET session_replication_role. That is not a
--     path any process here has.
-- Re-homing an activity is never a field edit: it would carry a body that may
-- hold PII into another BPO client's programme. An activity's own programme
-- move is also refused by the target FK (the target stays behind) and, for a
-- session that cannot reach the new programme, by the policy's WITH CHECK.
-- kasuwa_app holds no UPDATE on the key columns at all (column grants, see
-- TENANCY), so its statement fails 42501 before any row is read; for every
-- other role but the migrator the trigger answers first, also 42501. Two
-- independent layers: the grant can be widened by mistake, the trigger binds
-- every role.
-- The guard reads no table and only compares: SECURITY INVOKER, pinned
-- search_path, EXECUTE revoked (firing a trigger needs none). Not a SECURITY
-- DEFINER (CLAUDE.md 2.7): the census stays at two.
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   - RLS ENABLED and FORCED; activity_isolation FOR ALL, tenant AND
--     programme, WITH CHECK identical to USING; in TENANT_SCOPED_TABLES.
--   - GRANTS (D-P18: agents log and complete; D-L77): kasuwa_app reads,
--     inserts and updates. It never TRUNCATEs (TRUNCATE skips RLS), and no
--     role it can enter may either; the self-check below asserts both.
--   - UPDATE is COLUMN-level for kasuwa_app (review): type, subject, body,
--     due_at, completed_at, owner_user_id, contact_id, account_id, version and
--     updated_at. Not created_by_user_id or created_at: they are the timeline's
--     actor and its ordering (D-L72, D-L77 "Ordering"), and an edit must never
--     be able to forge who logged an activity or when. Not id, tenant_id or
--     programme_id either; for those the key guard (below) is what binds every
--     role, because a column grant does not bind kasuwa_test_admin or a future
--     role given table-level UPDATE. An UPDATE naming an ungranted column
--     fails with 42501 on the statement, before any row is read.
--   - DELETE (D-L77 rules "SELECT, INSERT and UPDATE only"): kasuwa_app keeps
--     the DELETE privilege, but a RESTRICTIVE policy, activity_no_delete,
--     admits no row to DELETE for any role subject to RLS. Why not REVOKE: a
--     revoked DELETE raises 42501 on the statement, and the T-0060 suite runs
--     `DELETE FROM activity WHERE id = ANY (...)` as an A1 agent and expects
--     it to match nothing, not to fail. A refused DELETE matching zero rows
--     also reveals nothing about which rows exist (as 0025). The migrator
--     (BYPASSRLS) is unaffected, and referential cascades (offboarding) skip
--     row security, so a programme or tenant delete still removes activities.
--     When a delete path is decided (D-L61), drop the policy in a new
--     migration.
--   - kasuwa_test_admin: full DML, as for contact and account (test only).
--   - The owner is kasuwa_migrator (it creates the table).
--
-- ---------------------------------------------------------------------------
-- INDEXES (D-L65 keyset)
-- ---------------------------------------------------------------------------
--   - activity_contact_keyset_idx (tenant_id, programme_id, contact_id,
--     created_at DESC, id DESC) WHERE contact_id IS NOT NULL: one contact's
--     activities, newest first ("newest first" sorts by created_at, D-L77),
--     and the FK lookup when a contact is deleted or re-keyed.
--   - activity_account_keyset_idx: the same for account_id.
--   - activity_owner_due_idx (tenant_id, owner_user_id, due_at) WHERE
--     owner_user_id IS NOT NULL: "my tasks" by due time, and the owner FK
--     lookup.
--   - activity_programme_recent_idx (tenant_id, programme_id, created_at DESC,
--     id DESC), NOT partial: the lookup for the tenant and programme FKs
--     (review finding M1). Both keyset indexes above are partial on their
--     target, so the planner cannot use them for `WHERE tenant_id = $1 AND
--     programme_id = $2` alone; without this index, offboarding (deleting a
--     programme or a tenant) seq-scanned activity once per deleted parent
--     row. It also serves a programme-wide feed, newest first. Same shape as
--     contact_keyset_idx and account_keyset_idx; its leading tenant_id serves
--     the tenant FK.
--   - created_by_user_id has no index: its FK is only checked when a "user"
--     row is deleted or re-keyed, which nothing does today (0022, 0015); add
--     one when a user delete path exists.
--   - The activity indexes are built on an empty table here, so they cost
--     nothing.
--
-- ---------------------------------------------------------------------------
-- METADATA (the catalogue recipe in packages/db/src/standard-object-catalogue.ts)
-- ---------------------------------------------------------------------------
--   - PRE-CHECK FIRST (D-P24, recipe step 2): a tenant that already has a
--     CUSTOM object named `activity` stops this file before anything changes,
--     with a message naming `activity` and the number of such tenants. Which
--     object keeps the name is a human decision: the custom one has its own
--     meaning and data. A custom FIELD named `activity`, a custom object such
--     as `activity_log`, or a `subject` field on another object is not a
--     clash and is not counted. A custom field with a catalogue name on a
--     STANDARD `activity` object (only possible if the new release provisioned
--     a tenant before this file ran) is a clash too, and is counted
--     separately.
--   - BACKFILL: one standard `activity` object_def and eight standard
--     field_defs per tenant, is_custom = false, as kasuwa_migrator (BYPASSRLS,
--     so every tenant). The jsonb literals below are this file's frozen copy of
--     the catalogue's `activity` entry; the seed and provisioning write the
--     same rows from STANDARD_OBJECT_CATALOGUE through ensureStandardObjectDefs,
--     and the T-0060 suite asserts all three agree. ON CONFLICT DO NOTHING:
--     after the pre-check, a row already there is a standard one.
--   - Fields: type (text, required), subject (text, pii), body (textarea,
--     pii), due_at and completed_at (datetime), owner_user_id (text: there is
--     no `user` object definition, as on contact), contact_id (lookup to
--     contact) and account_id (lookup to account). id, tenant_id,
--     programme_id, version, timestamps and created_by_user_id get none: they
--     are never withheld, as on contact.
--   - PROOF (recipe step 4): every tenant has the object and every field,
--     standard, with the catalogue's type, config and is_required and at least
--     its classification; and nothing standard on `activity` falls outside
--     the eight.
--   - Messages carry catalogue names and counts only, never tenant data.
--   - DEPLOY WINDOW: as 0025. A tenant provisioned by the previous release
--     between migrate and rollout gets no `activity` rows; after rollout, call
--     ensureStandardObjectDefs for every tenant (idempotent).
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
-- No populated cell exists yet (D-L65, D-L77), so this file uses plain DDL:
--   - contact: ACCESS EXCLUSIVE for the whole file. ADD CONSTRAINT ... UNIQUE
--     builds a b-tree over (tenant_id, programme_id, id) by scanning every
--     contact row; reads and writes of contacts wait until COMMIT. This is the
--     cost of the file. Measured at 2M contact rows (postgres:16 containers,
--     default settings, maintenance_work_mem 64MB; 0019's columns, one phone
--     each, ten programmes, contact_keyset_idx present):
--       * the builder's host: 4.0 s, 5.3 s and 8.1 s over three runs;
--       * the migration review: 8 s to 25 s;
--       * so plan on about 4-12 s per million rows, which is about 20-60 s of
--         blocked contact reads and writes at PRD 2.13's 5M. The spread is
--         host load. Everything else in this file works on an empty table or
--         on catalogue rows and adds well under 0.1 s.
--   - object_def, field_def: ACCESS EXCLUSIVE for the whole file, as 0025 and
--     0026 (catalogue tables, dozens of rows per tenant). Because they are
--     taken first, they are HELD THROUGH THE CONTACT SCAN: every metadata read
--     (the field-security loader on every records request, the admin
--     catalogue screens) waits for the same 20-60 s at volume. That is
--     accepted here only because no populated cell exists (D-L65, D-L77).
--     The order exists so the clash pre-check runs against a locked catalogue
--     before the expensive scan, and a clash costs nothing.
--   - tenant, programme, "user", account: SHARE ROW EXCLUSIVE for the whole
--     file, which is what creating an FK that references them takes anyway.
--     It blocks writes to those tables (sign-in bookkeeping on "user", account
--     edits), not reads, for the same few seconds.
--   - Taken up front, in one fixed order (catalogue, then parents, then
--     contact), so this file cannot deadlock against itself and fails fast:
--     lock_timeout = 5s refuses to queue behind a long transaction (and make
--     everything behind it queue too).
--   - At volume (the first populated cell onward) this MUST be split:
--       1. a `-- kasuwa:no-transaction` file: CREATE UNIQUE INDEX CONCURRENTLY
--          on contact (tenant_id, programme_id, id) (SHARE UPDATE EXCLUSIVE:
--          reads and writes carry on; the review measured 7.4 s at 2M rows);
--       2. an ordinary file that does the contact work FIRST, taking the
--          catalogue lock only AFTER it: ALTER TABLE contact ADD CONSTRAINT
--          ... UNIQUE USING INDEX (catalogue-only, a brief ACCESS EXCLUSIVE;
--          the review measured 3.8 ms), then LOCK object_def, field_def, the
--          clash pre-check, the table and the backfill. Nothing in that file
--          then scans a populated table, so neither lock is held for long.
--   - Steady state: the new unique index costs every contact INSERT one more
--     b-tree insert, and an UPDATE that changes tenant_id, programme_id or id
--     (none of which the API does) one more. The activity triggers run only on
--     activity writes, and the key guard's WHEN clause skips the function on
--     every UPDATE that leaves the keys alone.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied: it is one transaction and the
-- runner records it only on COMMIT. Fix the cause (a clash: rename or delete
-- the tenant's custom `activity` object, a human decision) and run
-- `pnpm db:migrate` again.
-- To undo it after it has applied: never edit or delete this file or its
-- ledger row (append-only). Instead:
--   1. roll back the application first (T-0061 reads and writes activity),
--      and the `activity` entry in standard-object-catalogue.ts, the seed's
--      SEED_ACTIVITIES, the schema.ts mirror and TENANT_SCOPED_TABLES;
--   2. export the activities if they hold data; dropping the table loses
--      notes and call logs that may be records the tenant must keep;
--   3. in a NEW migration, as kasuwa_migrator: DROP TABLE activity (its
--      policies, triggers, indexes and FKs go with it); DROP FUNCTION
--      app.guard_activity_keys_fixed(); DELETE the standard `activity`
--      object_def rows (their field_defs and field_security_grant rows
--      cascade; the restrictive delete policies of 0025 bind kasuwa_app only);
--   4. contact's new UNIQUE (contact_tenant_programme_id_key) may stay: it is
--      harmless, and a later FK may rely on it. Drop it (ALTER TABLE contact
--      DROP CONSTRAINT, brief ACCESS EXCLUSIVE) only if nothing references it.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
LOCK TABLE object_def, field_def IN ACCESS EXCLUSIVE MODE;
-- What the new FKs take anyway; taken here so every lock is in this order.
LOCK TABLE tenant, programme, "user", account IN SHARE ROW EXCLUSIVE MODE;
-- What ADD CONSTRAINT ... UNIQUE takes. Every lock here is held until COMMIT;
-- the order only fixes the sequence in which they are queued for.
LOCK TABLE contact IN ACCESS EXCLUSIVE MODE;

-- --- 2. the clash pre-check, before anything changes (D-P24) -----------------
DO $$
DECLARE
  new_fields constant text[] := ARRAY[
    'type', 'subject', 'body', 'due_at', 'completed_at', 'owner_user_id', 'contact_id', 'account_id'
  ];
  custom_objects bigint;
  custom_fields bigint;
  problems text[] := ARRAY[]::text[];
BEGIN
  -- Exactly the name `activity`, exactly a custom object. Counted per tenant.
  SELECT pg_catalog.count(DISTINCT o.tenant_id)
    INTO custom_objects
    FROM public.object_def o
   WHERE o.api_name = 'activity' AND o.is_custom;

  -- A custom field of a catalogue name on a STANDARD activity object.
  SELECT pg_catalog.count(DISTINCT f.tenant_id)
    INTO custom_fields
    FROM public.field_def f
    JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE o.api_name = 'activity' AND NOT o.is_custom
     AND f.is_custom
     AND f.api_name = ANY (new_fields);

  IF custom_objects > 0 THEN
    problems := problems || pg_catalog.format(
      '%s tenant(s) already have a custom object named activity, the name of the new standard object',
      custom_objects);
  END IF;
  IF custom_fields > 0 THEN
    problems := problems || pg_catalog.format(
      '%s tenant(s) have a custom field on the standard activity object named like a new standard field',
      custom_fields);
  END IF;
  IF pg_catalog.cardinality(problems) > 0 THEN
    RAISE EXCEPTION '0027: %. Nothing was applied. Rename or remove each one (a human decision: it has its own meaning and data), then re-run.',
      pg_catalog.array_to_string(problems, '; ');
  END IF;
END
$$;

-- --- 3. contact: the key the composite FK needs (D-L77) ----------------------
-- contact has only its primary key (0001); a FK on (tenant_id, programme_id,
-- contact_id) needs a unique key on exactly those columns. Same shape as
-- account's (0019).
ALTER TABLE contact
  ADD CONSTRAINT contact_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id);

-- --- 4. the table --------------------------------------------------------------
CREATE TABLE activity (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  programme_id        uuid        NOT NULL,
  type                text        NOT NULL,
  subject             text,
  body                text,
  due_at              timestamptz,
  completed_at        timestamptz,
  owner_user_id       uuid,
  contact_id          uuid,
  account_id          uuid,
  created_by_user_id  uuid,
  -- Optimistic-concurrency counter (T-0039 pattern), maintained by
  -- activity_bump_version below.
  version             integer     NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT activity_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT activity_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT activity_owner_same_tenant_fk
    FOREIGN KEY (tenant_id, owner_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT activity_created_by_same_tenant_fk
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Not NO ACTION: see KEYS in the header.
  CONSTRAINT activity_contact_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, contact_id)
    REFERENCES contact (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT activity_account_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, account_id)
    REFERENCES account (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  CONSTRAINT activity_type_check CHECK (type IN ('note', 'task', 'call')),
  CONSTRAINT activity_target_check CHECK (contact_id IS NOT NULL OR account_id IS NOT NULL),
  CONSTRAINT activity_task_fields_check
    CHECK (type = 'task' OR (due_at IS NULL AND completed_at IS NULL)),
  CONSTRAINT activity_version_check CHECK (version >= 1)
);

CREATE INDEX activity_contact_keyset_idx
  ON activity (tenant_id, programme_id, contact_id, created_at DESC, id DESC)
  WHERE contact_id IS NOT NULL;
CREATE INDEX activity_account_keyset_idx
  ON activity (tenant_id, programme_id, account_id, created_at DESC, id DESC)
  WHERE account_id IS NOT NULL;
CREATE INDEX activity_owner_due_idx
  ON activity (tenant_id, owner_user_id, due_at)
  WHERE owner_user_id IS NOT NULL;
-- Not partial: the tenant and programme FK lookup (offboarding) and a
-- programme-wide feed, newest first. See INDEXES in the header.
CREATE INDEX activity_programme_recent_idx
  ON activity (tenant_id, programme_id, created_at DESC, id DESC);

ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_isolation ON activity FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));
-- RESTRICTIVE, AND-ed with activity_isolation: no row is ever admitted to a
-- DELETE by a role subject to RLS. See TENANCY in the header.
CREATE POLICY activity_no_delete ON activity
  AS RESTRICTIVE
  FOR DELETE
  USING (false);

-- Explicit, so this file does not silently depend on the bootstrap's default
-- privileges, and so TRUNCATE, REFERENCES and TRIGGER are never held.
REVOKE ALL ON activity FROM PUBLIC, kasuwa_app, kasuwa_test_admin;
GRANT SELECT, INSERT, DELETE ON activity TO kasuwa_app;
-- Column-level: never created_by_user_id or created_at, nor the keys. See
-- TENANCY in the header.
GRANT UPDATE (type, subject, body, due_at, completed_at, owner_user_id, contact_id, account_id,
              version, updated_at)
  ON activity TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON activity TO kasuwa_test_admin;

-- --- 5. triggers ---------------------------------------------------------------
-- 0018's and 0019's functions, attached; no second copy of either.
CREATE TRIGGER activity_touch_updated_at
  BEFORE UPDATE ON activity FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER activity_bump_version
  BEFORE UPDATE ON activity FOR EACH ROW
  WHEN (NEW.version IS NOT DISTINCT FROM OLD.version)
  EXECUTE FUNCTION app.bump_version();

-- The keys are fixed for every role but the migrator: an allow-list. See
-- "THE KEYS OF AN ACTIVITY ARE FIXED" in the header. The message names the
-- rule, never a value.
CREATE FUNCTION app.guard_activity_keys_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'kasuwa_migrator' AND session_user = 'kasuwa_migrator' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'activity.id, tenant_id and programme_id are fixed at creation and cannot be changed by this role'
    USING ERRCODE = 'insufficient_privilege';  -- 42501, as 0023 and 0025
END;
$$;
-- Only the trigger calls it; firing a trigger needs no EXECUTE. The bootstrap's
-- default EXECUTE grants are IN SCHEMA public only and do not reach this
-- function in schema app; naming kasuwa_app and kasuwa_test_admin here is
-- belt and braces, so the REVOKE holds even if a later default changes.
REVOKE ALL ON FUNCTION app.guard_activity_keys_fixed() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

-- BEFORE, so the row is refused before any FK or policy check runs. No column
-- list: the WHEN clause sees the final NEW, whatever set it. Fires for every row
-- of a bulk UPDATE and for the DO UPDATE arm of an upsert.
CREATE TRIGGER activity_keys_fixed
  BEFORE UPDATE ON activity FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id)
  EXECUTE FUNCTION app.guard_activity_keys_fixed();

-- --- 6. the standard activity object and fields: backfill, then prove --------
DO $$
DECLARE
  -- Frozen copy of the `activity` entry of STANDARD_OBJECT_CATALOGUE
  -- (packages/db/src/standard-object-catalogue.ts).
  new_object constant jsonb :=
    '{"api_name": "activity", "label": "Activity", "plural_label": "Activities"}';
  new_fields constant jsonb := '[
    {"api_name": "type",          "label": "Type",      "type": "text",     "classification": "none", "is_required": true,  "config": {}},
    {"api_name": "subject",       "label": "Subject",   "type": "text",     "classification": "pii",  "is_required": false, "config": {}},
    {"api_name": "body",          "label": "Body",      "type": "textarea", "classification": "pii",  "is_required": false, "config": {}},
    {"api_name": "due_at",        "label": "Due",       "type": "datetime", "classification": "none", "is_required": false, "config": {}},
    {"api_name": "completed_at",  "label": "Completed", "type": "datetime", "classification": "none", "is_required": false, "config": {}},
    {"api_name": "owner_user_id", "label": "Owner",     "type": "text",     "classification": "none", "is_required": false, "config": {}},
    {"api_name": "contact_id",    "label": "Contact",   "type": "lookup",   "classification": "none", "is_required": false, "config": {"targetObjectApiName": "contact"}},
    {"api_name": "account_id",    "label": "Account",   "type": "lookup",   "classification": "none", "is_required": false, "config": {"targetObjectApiName": "account"}}
  ]';
  classification_rank constant text[] := ARRAY['none', 'pii', 'sensitive'];
  affected_tenants bigint;
  stray_rows bigint;
  problem text;
BEGIN
  INSERT INTO public.object_def (id, tenant_id, api_name, label, plural_label, is_custom)
  SELECT gen_random_uuid(), t.id, new_object ->> 'api_name', new_object ->> 'label',
         new_object ->> 'plural_label', false
    FROM public.tenant t
  ON CONFLICT (tenant_id, api_name) DO NOTHING;

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

  -- Every tenant has the standard object...
  SELECT pg_catalog.count(*)
    INTO affected_tenants
    FROM public.tenant t
   WHERE NOT EXISTS (
           SELECT 1 FROM public.object_def o
            WHERE o.tenant_id = t.id AND o.api_name = 'activity' AND NOT o.is_custom);
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0027 backfill incomplete: % tenant(s) lack the standard object activity',
      affected_tenants;
  END IF;

  -- ...and every field, standard, on it, with the catalogue's meaning and at
  -- least its classification.
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
    RAISE EXCEPTION '0027 backfill incomplete: % tenant(s) lack or mis-type the standard field(s) %',
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
     AND NOT EXISTS (
           SELECT 1 FROM jsonb_to_recordset(new_fields) AS c (api_name text)
            WHERE c.api_name = f.api_name);
  IF stray_rows > 0 THEN
    RAISE EXCEPTION '0027: % standard activity field_def row(s) in % tenant(s) are not in the standard catalogue; mark them custom or remove them, then re-run',
      stray_rows, affected_tenants;
  END IF;
END
$$;

-- --- 7. prove the posture ------------------------------------------------------
-- Runs once, here. The standing guards are the T-0060 acceptance suite and the
-- activity integration tests, which run on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  held text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c WHERE c.oid = 'public.activity'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '0027: activity RLS is not enabled and forced';
  END IF;
  IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c
                                  WHERE c.oid = 'public.activity'::pg_catalog.regclass))
     <> 'kasuwa_migrator' THEN
    RAISE EXCEPTION '0027: activity is not owned by kasuwa_migrator';
  END IF;
  IF NOT (pg_catalog.has_table_privilege(app_role, 'public.activity', 'SELECT')
          AND pg_catalog.has_table_privilege(app_role, 'public.activity', 'INSERT')
          AND pg_catalog.has_column_privilege(app_role, 'public.activity', 'completed_at', 'UPDATE')
          AND pg_catalog.has_column_privilege(app_role, 'public.activity', 'body', 'UPDATE')) THEN
    RAISE EXCEPTION '0027: kasuwa_app cannot read, log and complete activities (D-P18)';
  END IF;
  -- The timeline's actor and ordering, and the keys, are never writable by an
  -- UPDATE from kasuwa_app (has_column_privilege also sees a table-level
  -- grant, so this fails if one is ever added back).
  SELECT pg_catalog.string_agg(c.col, ', ' ORDER BY c.col)
    INTO held
    FROM pg_catalog.unnest(ARRAY['id', 'tenant_id', 'programme_id', 'created_by_user_id',
                                 'created_at']) AS c(col)
   WHERE pg_catalog.has_column_privilege(app_role, 'public.activity', c.col, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0027: kasuwa_app may UPDATE activity column(s) it must not: %', held;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                  WHERE p.polrelid = 'public.activity'::pg_catalog.regclass
                    AND p.polname = 'activity_no_delete'
                    AND NOT p.polpermissive AND p.polcmd = 'd') THEN
    RAISE EXCEPTION '0027: the restrictive DELETE policy on activity is missing or not restrictive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.activity'::pg_catalog.regclass
                    AND t.tgname = 'activity_keys_fixed' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '0027: the activity key guard is missing';
  END IF;

  -- TRUNCATE skips RLS entirely, and BYPASSRLS skips the policies. Checked
  -- for kasuwa_app AND every role it is a member of, whatever the INHERIT
  -- option (kasuwa_app can SET ROLE to kasuwa_sweeper, D-L66), through every
  -- route a privilege can take (direct, PUBLIC, inherited).
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'TRUNCATE activity' AS what
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.activity', 'TRUNCATE')
     UNION ALL
     SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0027: kasuwa_app, or a role it can enter, can bypass activity row security: %', held;
  END IF;
END
$$;
