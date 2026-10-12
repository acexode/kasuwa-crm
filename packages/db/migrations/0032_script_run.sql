-- ---------------------------------------------------------------------------
-- 0032 - script runs: the `script_run` table (T-0114, Agent 6; D-L88, D-L91,
-- D-L93, D-L104, D-L76, D-L65).
--
-- An agent walking one PUBLISHED script version for one contact, by hand
-- (P10, manual mode). A run pins the version it started on, records the path
-- it took, the compliance acknowledgements (server timestamps) and the form
-- answers (classified `sensitive`), and is completed with a disposition. In
-- this one file:
--
--   1. locks, taken up front in a fixed order;
--   2. script_version gains UNIQUE (tenant_id, programme_id, script_id, id),
--      the target of the run's version FK;
--   3. the table, its keys, checks, indexes, RLS and grants;
--   4. its key guard trigger;
--   5. a self-check of the security posture.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- NOT HERE: the API (apps/api/src/scripts, T-0114); call-bound runs (M09); a
-- supervisor or QA read (M11); the D-P27 sweeper, which will delete a
-- contact's runs before the contact. No new role, no new function beyond the
-- key guard, no SECURITY DEFINER (CLAUDE.md 2.7: the census stays at two).
--
-- ---------------------------------------------------------------------------
-- COLUMNS
-- ---------------------------------------------------------------------------
--   id, tenant_id, programme_id     the tenancy keys; fixed at creation (KEYS).
--                                   programme_id is the CONTACT's programme.
--   script_id, version_id   uuid NOT NULL: the version the run is pinned to,
--                           and its script. Never change (KEYS).
--   contact_id              uuid NOT NULL: who the run is about. Never changes:
--                           answers about one person must never move to
--                           another (R4).
--   started_by_user_id      uuid NOT NULL: the run's agent, the only person
--                           any run operation answers (D-L93). Never changes.
--   status                  text: in_progress | stopped | completed
--   outcome                 text NULL: completed | interrupted | superseded;
--                           set exactly when status is completed
--   stop_reason             text NULL: field_withheld | sensitive_field; set on
--                           a stopped run, kept when it completes
--   current_node_id         text NULL: the node the run is on; NULL exactly
--                           when completed
--   ended_at_node_id        text NULL: the node it completed on; set exactly
--                           when completed
--   path                    jsonb array of {nodeId, enteredAt, branchOutcome?}
--   acknowledgements        jsonb array of {nodeId, locale, profileLocale,
--                           acknowledgedAt}
--   answers                 jsonb object keyed by node id. CLASSIFIED
--                           SENSITIVE (D-L93): never logged, never audited,
--                           never in an error body. The API caps it at 262144
--                           UTF-8 bytes serialised (D-L93, N9).
--   unacknowledged_compliance_node_ids  text[]: set at an interrupted
--                           completion (D-L91), empty otherwise
--   disposition_id, activity_id, follow_up_task_id  uuid NULL, set at
--                           completion (no FK: see KEYS)
--   completion_digest       text NULL: a SHA-256 of the completing request, so
--                           an exact repeat is recognised (D-L91) without
--                           keeping a second copy of the note
--   revision                integer NOT NULL DEFAULT 1, the run's concurrency
--                           token; the API advances it on every write
--   started_at, completed_at  timestamptz
--   NO updated_at: `revision` and the timestamps in path, acknowledgements
--   and answers say when it changed (D-L104: with updated_at the seed would
--   have to carry a run for schema-hygiene).
--
--   The jsonb shapes are validated by the API with Zod; the database checks
--   only that each is the right kind of container.
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3, D-L76)
-- ---------------------------------------------------------------------------
-- Every FK to a tenant-scoped table carries tenant_id, because referential
-- checks ignore row security:
--   - (tenant_id, programme_id) -> programme and (tenant_id) -> tenant: ON
--     DELETE CASCADE (offboarding), ON UPDATE RESTRICT.
--   - (tenant_id, programme_id, script_id, version_id) -> script_version
--     (tenant_id, programme_id, script_id, id): a run lives in its version's
--     programme, AND names a version of its own script column (R3). A
--     supervisor who sees A1 and A2 is not stopped by RLS from naming an A2
--     version on an A1 run; only the key stops it. RESTRICT both ways.
--   - (tenant_id, programme_id, contact_id) -> contact (tenant_id,
--     programme_id, id): a run lives in its contact's programme. RESTRICT both
--     ways: never CASCADE or SET NULL (the D-P27 sweeper deletes a contact's
--     runs deliberately, before the contact). RESTRICT also refuses a
--     one-statement rotation of contact ids and moving a contact that has
--     runs to another programme. A real but unreachable contact and an
--     invented id fail the same FK with the same message.
--   - (tenant_id, started_by_user_id) -> "user" (tenant_id, id): RESTRICT
--     both ways (R3).
--   - EVERY FK IS ON UPDATE RESTRICT (D-L76).
--   - Offboarding: a tenant or programme delete reaches script_run directly
--     through its own CASCADE FKs; the RESTRICT checks queued by the cascaded
--     contact, version and "user" deletes run after those cascades, by which
--     time the runs are gone (as 0027 and 0030 explain). The T-0114 suite
--     deletes a programme and then a tenant holding runs, as kasuwa_migrator.
--   - disposition_id, activity_id and follow_up_task_id have NO FK: neither
--     disposition nor activity has a (tenant_id, programme_id, id) key to
--     reference, and adding one is a lock on two more tables this task does
--     not need. The API writes them inside the run's programme, in the
--     completing transaction. Tracked in the T-0114 report.
--
-- THE KEYS OF A RUN ARE FIXED (the D-L76 allow-list, as 0027 and 0030): id,
-- tenant_id, programme_id, script_id, version_id, contact_id and
-- started_by_user_id cannot change unless BOTH current_user AND session_user
-- are kasuwa_migrator. A BEFORE UPDATE row trigger,
-- app.guard_script_run_keys_fixed(), raises 42501 otherwise. kasuwa_app holds
-- no UPDATE on any of those columns either (TENANCY), so its statement fails
-- 42501 before any row is read; kasuwa_test_admin and any later role meet the
-- trigger. The guard reads no table and only compares: SECURITY INVOKER,
-- pinned search_path, EXECUTE revoked.
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   - RLS ENABLED and FORCED; script_run_isolation FOR ALL, tenant AND
--     programme, WITH CHECK identical to USING; in TENANT_SCOPED_TABLES.
--   - GRANTS: kasuwa_app SELECT and INSERT, and UPDATE on the run's moving
--     parts only (status, outcome, stop_reason, current_node_id,
--     ended_at_node_id, path, acknowledgements, answers,
--     unacknowledged_compliance_node_ids, disposition_id, activity_id,
--     follow_up_task_id, completion_digest, revision, completed_at). Never the
--     keys, the pinned version, the contact, the agent or started_at. No
--     DELETE: no operation deletes a run; the sweeper's path is D-P27's.
--     kasuwa_test_admin: full DML (test only); the key guard binds it.
--     Nobody kasuwa_app can enter may TRUNCATE it or bypass RLS (self-check).
--   - The owner is kasuwa_migrator.
--   - Own-agent-only (D-L93) is the API's rule, not a policy: RLS keeps the
--     programme boundary, and a supervisor's M11 read will need it as is.
--
-- ---------------------------------------------------------------------------
-- INDEXES (D-L65)
-- ---------------------------------------------------------------------------
--   - script_run_in_progress_key UNIQUE (tenant_id, programme_id,
--     started_by_user_id, contact_id, script_id) WHERE status = 'in_progress':
--     one run in progress per agent, contact and script, so two concurrent
--     starts can never both insert (startScriptRun's builder note).
--   - script_run_contact_idx (tenant_id, programme_id, contact_id): the
--     contact FK's RESTRICT lookup, the sweeper's delete, and a start's
--     lookup of the caller's own open runs on that contact.
--   - script_run_version_idx (tenant_id, programme_id, script_id, version_id):
--     the version FK's RESTRICT lookup (offboarding).
--   - Their (tenant_id, programme_id) prefix serves the programme and tenant
--     FK lookups. started_by_user_id has no index of its own: its FK is only
--     checked when a "user" row is deleted or re-keyed, which nothing does
--     today (as 0027's created_by_user_id).
--   - script_version_script_id_key UNIQUE (tenant_id, programme_id,
--     script_id, id): the version FK's target.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
-- No populated cell exists yet (D-L65), so this file uses plain DDL:
--   - tenant, programme, "user", contact: SHARE ROW EXCLUSIVE for the whole
--     file, which is what creating an FK that references them takes anyway.
--     It blocks writes to them (contact edits, sign-in bookkeeping), not
--     reads, for well under a second: nothing here scans them.
--   - script_version: ACCESS EXCLUSIVE, for ADD CONSTRAINT ... UNIQUE, which
--     builds a b-tree over every version. Versions are few (one per publish),
--     so this is milliseconds today; at volume, build the index CONCURRENTLY
--     in a `-- kasuwa:no-transaction` file first and attach it with UNIQUE
--     USING INDEX.
--   - Taken up front in one fixed order with lock_timeout = 5s. THE DEPLOY
--     MUST RETRY ON lock_timeout (SQLSTATE 55P03): nothing was applied.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied: it is one transaction and the
-- runner records it only on COMMIT. Fix the cause and run `pnpm db:migrate`.
-- To undo it after it has applied: never edit or delete this file or its
-- ledger row (append-only). Instead:
--   1. roll back the application first (the run operations in
--      apps/api/src/scripts, `script.run` in @kasuwa/permissions), and the
--      schema.ts mirror and TENANT_SCOPED_TABLES;
--   2. export the runs if they hold data: a run is the record that a
--      compliance statement was read on a call. Its answers are sensitive;
--      export them under the programme's retention rules or not at all;
--   3. in a NEW migration, as kasuwa_migrator, with SET LOCAL lock_timeout:
--      DROP TABLE script_run (its policy, trigger, indexes and FKs go with
--      it); DROP FUNCTION app.guard_script_run_keys_fixed();
--   4. script_version_script_id_key may stay: it is harmless. Drop it only
--      if nothing references it.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
-- What the new FKs take anyway; taken here so every lock is in this order.
LOCK TABLE tenant, programme, "user", contact IN SHARE ROW EXCLUSIVE MODE;
-- What ADD CONSTRAINT ... UNIQUE takes. Held until COMMIT.
LOCK TABLE script_version IN ACCESS EXCLUSIVE MODE;

-- --- 2. script_version: the key the run's version FK needs -------------------
-- (tenant_id, programme_id, script_id, id): a run names a version of its own
-- script, in its own programme (R3). A catalogue change plus an index build;
-- the immutability trigger fires on UPDATE only, so no version row changes.
ALTER TABLE script_version
  ADD CONSTRAINT script_version_script_id_key UNIQUE (tenant_id, programme_id, script_id, id);

-- --- 3. the table --------------------------------------------------------------
CREATE TABLE script_run (
  id                                   uuid        PRIMARY KEY,
  tenant_id                            uuid        NOT NULL,
  programme_id                         uuid        NOT NULL,
  script_id                            uuid        NOT NULL,
  version_id                           uuid        NOT NULL,
  contact_id                           uuid        NOT NULL,
  started_by_user_id                   uuid        NOT NULL,
  status                               text        NOT NULL DEFAULT 'in_progress',
  outcome                              text,
  stop_reason                          text,
  current_node_id                      text,
  ended_at_node_id                     text,
  path                                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
  acknowledgements                     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  answers                              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  unacknowledged_compliance_node_ids   text[]      NOT NULL DEFAULT '{}',
  disposition_id                       uuid,
  activity_id                          uuid,
  follow_up_task_id                    uuid,
  completion_digest                    text,
  revision                             integer     NOT NULL DEFAULT 1,
  started_at                           timestamptz NOT NULL DEFAULT now(),
  completed_at                         timestamptz,

  CONSTRAINT script_run_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT script_run_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- Not NO ACTION, and never CASCADE or SET NULL: see KEYS in the header.
  CONSTRAINT script_run_version_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, script_id, version_id)
    REFERENCES script_version (tenant_id, programme_id, script_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT script_run_contact_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, contact_id)
    REFERENCES contact (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT script_run_started_by_same_tenant_fk
    FOREIGN KEY (tenant_id, started_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  CONSTRAINT script_run_status_check
    CHECK (status IN ('in_progress', 'stopped', 'completed')),
  CONSTRAINT script_run_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('completed', 'interrupted', 'superseded')),
  CONSTRAINT script_run_stop_reason_check
    CHECK (stop_reason IS NULL OR stop_reason IN ('field_withheld', 'sensitive_field')),
  -- A completed run has an outcome, a time, an end node and no current node;
  -- an open run has none of those.
  CONSTRAINT script_run_completion_check
    CHECK ((status = 'completed') = (outcome IS NOT NULL)
           AND (status = 'completed') = (completed_at IS NOT NULL)
           AND (status = 'completed') = (ended_at_node_id IS NOT NULL)
           AND (status = 'completed') = (current_node_id IS NULL)),
  -- A stopped run says why; a run in progress has no stop reason.
  CONSTRAINT script_run_stopped_check
    CHECK ((status <> 'stopped' OR stop_reason IS NOT NULL)
           AND (status <> 'in_progress' OR stop_reason IS NULL)),
  -- Only a superseded run closes without a disposition and a call activity.
  CONSTRAINT script_run_disposition_check
    CHECK (outcome IS NULL
           OR (outcome = 'superseded') = (disposition_id IS NULL AND activity_id IS NULL)),
  CONSTRAINT script_run_node_id_check
    CHECK ((current_node_id IS NULL OR current_node_id ~ '^[a-z][a-z0-9_]{0,39}$')
           AND (ended_at_node_id IS NULL OR ended_at_node_id ~ '^[a-z][a-z0-9_]{0,39}$')),
  CONSTRAINT script_run_shape_check
    CHECK (jsonb_typeof(path) = 'array'
           AND jsonb_typeof(acknowledgements) = 'array'
           AND jsonb_typeof(answers) = 'object'),
  -- A flat list of node ids: one dimension (an empty array has none), no NULL.
  CONSTRAINT script_run_unacknowledged_shape_check
    CHECK ((array_ndims(unacknowledged_compliance_node_ids) IS NULL
            OR array_ndims(unacknowledged_compliance_node_ids) = 1)
           AND array_position(unacknowledged_compliance_node_ids, NULL) IS NULL
           AND cardinality(unacknowledged_compliance_node_ids) <= 200),
  CONSTRAINT script_run_revision_check CHECK (revision >= 1)
);

CREATE UNIQUE INDEX script_run_in_progress_key
  ON script_run (tenant_id, programme_id, started_by_user_id, contact_id, script_id)
  WHERE status = 'in_progress';
CREATE INDEX script_run_contact_idx ON script_run (tenant_id, programme_id, contact_id);
CREATE INDEX script_run_version_idx
  ON script_run (tenant_id, programme_id, script_id, version_id);

ALTER TABLE script_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_run FORCE ROW LEVEL SECURITY;
CREATE POLICY script_run_isolation ON script_run FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

-- Explicit, so this file does not silently depend on the bootstrap's default
-- privileges, and so TRUNCATE, REFERENCES and TRIGGER are never held.
REVOKE ALL ON script_run FROM PUBLIC, kasuwa_app, kasuwa_test_admin;
GRANT SELECT, INSERT ON script_run TO kasuwa_app;
GRANT UPDATE (status, outcome, stop_reason, current_node_id, ended_at_node_id, path,
              acknowledgements, answers, unacknowledged_compliance_node_ids,
              disposition_id, activity_id, follow_up_task_id, completion_digest,
              revision, completed_at)
  ON script_run TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON script_run TO kasuwa_test_admin;

-- --- 4. the key guard ------------------------------------------------------------
-- The keys and the pinned references are fixed for every role but the
-- migrator: an allow-list. The message names the rule, never a value.
CREATE FUNCTION app.guard_script_run_keys_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'kasuwa_migrator' AND session_user = 'kasuwa_migrator' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a script run''s keys, version, contact and agent are fixed at start and cannot be changed by this role'
    USING ERRCODE = 'insufficient_privilege';  -- 42501, as 0027 and 0030
END;
$$;
REVOKE ALL ON FUNCTION app.guard_script_run_keys_fixed() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

-- BEFORE, so the row is refused before any FK or policy check runs. Fires for
-- every row of a bulk UPDATE and for the DO UPDATE arm of an upsert.
CREATE TRIGGER script_run_keys_fixed
  BEFORE UPDATE ON script_run FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id
        OR NEW.script_id IS DISTINCT FROM OLD.script_id
        OR NEW.version_id IS DISTINCT FROM OLD.version_id
        OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
        OR NEW.started_by_user_id IS DISTINCT FROM OLD.started_by_user_id)
  EXECUTE FUNCTION app.guard_script_run_keys_fixed();

-- --- 5. prove the posture ------------------------------------------------------
-- Runs once, here. The standing guards are the T-0114 acceptance suite,
-- rls-enforcement and schema-hygiene, which run on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  held text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c WHERE c.oid = 'public.script_run'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '0032: script_run RLS is not enabled and forced';
  END IF;
  IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c
                                  WHERE c.oid = 'public.script_run'::pg_catalog.regclass))
     <> 'kasuwa_migrator' THEN
    RAISE EXCEPTION '0032: script_run is not owned by kasuwa_migrator';
  END IF;
  IF NOT (pg_catalog.has_table_privilege(app_role, 'public.script_run', 'SELECT')
          AND pg_catalog.has_table_privilege(app_role, 'public.script_run', 'INSERT')) THEN
    RAISE EXCEPTION '0032: kasuwa_app cannot read and insert script_run';
  END IF;
  IF pg_catalog.has_table_privilege(app_role, 'public.script_run', 'DELETE') THEN
    RAISE EXCEPTION '0032: kasuwa_app may DELETE from script_run';
  END IF;

  -- The run moves; its keys, pinned version, contact, agent and start never do.
  IF NOT pg_catalog.has_column_privilege(app_role, 'public.script_run', 'answers', 'UPDATE') THEN
    RAISE EXCEPTION '0032: kasuwa_app cannot record answers';
  END IF;
  SELECT pg_catalog.string_agg(c.col, ', ' ORDER BY c.col)
    INTO held
    FROM pg_catalog.unnest(ARRAY['id', 'tenant_id', 'programme_id', 'script_id', 'version_id',
                                 'contact_id', 'started_by_user_id', 'started_at']) AS c(col)
   WHERE pg_catalog.has_column_privilege(app_role, 'public.script_run', c.col, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0032: kasuwa_app may UPDATE script_run column(s) it must not: %', held;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger tg
                  WHERE NOT tg.tgisinternal
                    AND tg.tgrelid = 'public.script_run'::pg_catalog.regclass
                    AND tg.tgname = 'script_run_keys_fixed') THEN
    RAISE EXCEPTION '0032: the script_run key guard is missing';
  END IF;

  -- Every FK is ON UPDATE RESTRICT (D-L76), and the contact FK never deletes
  -- or orphans a run.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
              WHERE con.contype = 'f'
                AND con.conrelid = 'public.script_run'::pg_catalog.regclass
                AND con.confupdtype <> 'r') THEN
    RAISE EXCEPTION '0032: a script_run FK is not ON UPDATE RESTRICT';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
              WHERE con.contype = 'f'
                AND con.conrelid = 'public.script_run'::pg_catalog.regclass
                AND con.confrelid = 'public.contact'::pg_catalog.regclass
                AND con.confdeltype <> 'r') THEN
    RAISE EXCEPTION '0032: the script_run contact FK must be ON DELETE RESTRICT';
  END IF;

  -- TRUNCATE skips RLS entirely, and BYPASSRLS skips the policies. Checked for
  -- kasuwa_app AND every role it is a member of, whatever the INHERIT option.
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'TRUNCATE script_run' AS what
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.script_run', 'TRUNCATE')
     UNION ALL
     SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0032: kasuwa_app, or a role it can enter, can bypass script_run row security: %', held;
  END IF;
END
$$;
