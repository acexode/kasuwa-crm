-- ---------------------------------------------------------------------------
-- 0030 - script authoring: the `script` and `script_version` tables (T-0113,
-- Agent 6; D-L88, D-L91, D-L93, D-L96, D-L76, D-L77, D-L65).
--
-- In-call scripts in manual mode (P10). A `script` is a programme's draft: its
-- name, source locale, graph and translations, edited in place under an
-- optimistic `revision`. Publishing snapshots the draft as a `script_version`,
-- numbered 1, 2, 3 per script, which nothing may ever change. Runs (T-0114)
-- pin a version, so "republishing never changes a run in progress" (M10 Q2) is
-- a property of this table, not of the API. In this one file:
--
--   1. locks, taken up front in a fixed order;
--   2. the two tables, their keys, checks, indexes, RLS and grants;
--   3. their triggers: updated_at on script (0018), the script key guard, and
--      the immutability of a published version;
--   4. audit_event's action CHECK gains `published` (D-L96), and nothing else;
--   5. a self-check of the security posture.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- NOT HERE: script_run (T-0114); the API (T-0113, apps/api/src/scripts); any
-- standard object_def or field_def. A script is configuration, not a record
-- with field security, so it has no metadata rows (as disposition has none).
--
-- ---------------------------------------------------------------------------
-- COLUMNS
-- ---------------------------------------------------------------------------
-- script
--   id, tenant_id, programme_id     the tenancy keys; fixed at creation (KEYS)
--   name               text NOT NULL, 1..120 characters; NOT unique (D-L91)
--   source_locale      text NOT NULL, one of the seven design locales
--   draft_graph        jsonb NOT NULL, the draft ScriptGraph. The default is
--                      the empty draft createScript writes when no graph is
--                      sent: a start id that names no node, so it is never
--                      publishable (`missing_start`).
--   draft_translations jsonb NOT NULL DEFAULT '{}', keyed by locale
--   revision           integer NOT NULL DEFAULT 1, the draft's concurrency
--                      token (D-L91: `revision`, since "version" here means a
--                      published version). The API advances it on every draft
--                      write with `WHERE revision = $sent`; 1..2^31-1 (D-L93).
--   published_revision integer NULL: the draft revision the latest version
--                      was published from. `hasUnpublishedChanges` is
--                      `published_revision IS DISTINCT FROM revision`.
--   created_at, updated_at  timestamptz NOT NULL DEFAULT now(); updated_at by
--                      app.touch_updated_at() (0018)
--
-- script_version (every row is a PUBLISHED version; there is no draft row)
--   id, tenant_id, programme_id, script_id   the keys
--   number             integer NOT NULL, 1, 2, 3 per script
--   name, source_locale     the draft's, as published
--   graph, translations     jsonb, the draft's, as published
--   changes            text[] NOT NULL DEFAULT '{}', the publisher's notes
--                      (at most 10, D-L91); wording, never logged or audited
--   published_at       timestamptz NOT NULL DEFAULT now()
--   published_by_user_id uuid NULL -> "user" (tenant_id, ...); the publisher.
--                      NULL only for a row written with no user to name
--   NO updated_at: a published version never changes (schema-hygiene pins it).
--
--   The jsonb shapes (ScriptGraph, Translations) are validated by the API with
--   Zod, with the 256 KiB cap (D-L93); the database checks only that each is
--   an object, so a malformed write can never be half-typed jsonb.
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3, D-L76)
-- ---------------------------------------------------------------------------
-- Every FK to a tenant-scoped table carries tenant_id, because referential
-- checks ignore row security:
--   - script (tenant_id, programme_id) -> programme: the script's programme is
--     in its tenant. ON DELETE CASCADE (offboarding).
--   - script_version (tenant_id, programme_id, script_id) -> script (tenant_id,
--     programme_id, id): a version always lives in ITS script's programme. A
--     supervisor who sees A1 and A2 is not stopped by RLS from attaching an A1
--     version to an A2 script; only the key stops it. An unreachable script
--     and an invented id fail the same FK with the same message (no existence
--     oracle across the BPO boundary). ON DELETE RESTRICT: a script with
--     versions is never deleted out from under a run that pins one.
--   - script_version (tenant_id, programme_id) -> programme and (tenant_id) ->
--     tenant: ON DELETE CASCADE, so offboarding reaches versions directly. The
--     RESTRICT check queued by the cascaded script delete runs at the end of
--     the outer statement (RI queries do not fire their AFTER triggers
--     early), by which time the versions are gone, as 0027 explains for
--     activity. The T-0113 suite deletes a programme and then a tenant holding
--     scripts with versions, as kasuwa_migrator.
--   - script_version (tenant_id, published_by_user_id) -> "user": RESTRICT
--     both ways. Not SET NULL: that is an UPDATE of a published version, which
--     the immutability trigger refuses, so a user delete would fail anyway,
--     and in the middle of an offboarding cascade at that.
--   - EVERY FK IS ON UPDATE RESTRICT (D-L76, D-L96). NO ACTION accepts a
--     one-statement rotation (`UPDATE script SET id = CASE id WHEN X THEN
--     <fresh> ELSE X END WHERE id IN (X, Y)`) that silently re-points X's
--     versions to Y. RESTRICT refuses changing a key a version references,
--     whatever else the statement does, for every role including the
--     migrator; it also refuses moving a script WITH versions to another
--     programme (its (tenant, programme, id) key changes). There is no ON
--     UPDATE CASCADE, which would carry published wording across a BPO
--     client boundary.
--
-- THE KEYS OF A SCRIPT ARE FIXED (the D-L76 allow-list, as 0027): id,
-- tenant_id and programme_id cannot change unless BOTH current_user AND
-- session_user are kasuwa_migrator. A BEFORE UPDATE row trigger,
-- app.guard_script_keys_fixed(), raises 42501 otherwise:
--   - kasuwa_app is refused, including after SET ROLE kasuwa_sweeper;
--     besides, it holds no UPDATE on the key columns at all (TENANCY);
--   - kasuwa_test_admin (BYPASSRLS) and any role created later are refused;
--   - kasuwa_migrator may still move a script that has NO versions (the
--     T-0113 suite's control); the RESTRICT FK refuses one that has.
-- A script "never moves" on the wire (updateScript has no programmeId).
--
-- A PUBLISHED VERSION IS IMMUTABLE FOR EVERY ROLE (D-L96). Every row of
-- script_version is a published version, so a BEFORE UPDATE row trigger with
-- NO WHEN clause, app.refuse_script_version_update(), refuses EVERY update,
-- a no-op `SET tenant_id = tenant_id` included, for kasuwa_app,
-- kasuwa_test_admin and kasuwa_migrator alike (42501, as 0008's append-only
-- audit_event). Correcting a published version is publishing a new one.
-- A superuser that must can SET session_replication_role; no process here
-- can. A future logical-replication cell move (ADR-0002 tooling) must keep
-- the trigger enabled on the subscriber (D-L92's note on 0029 applies).
--
-- DELETE of a version: a BEFORE DELETE row trigger,
-- app.guard_script_version_delete(), refuses unless current_user is
-- kasuwa_migrator. kasuwa_app holds no DELETE at all; kasuwa_test_admin is
-- refused by the trigger. Offboarding still works: a cascaded delete runs as
-- the referencing table's owner (kasuwa_migrator), whoever issued the
-- tenant or programme delete. Only current_user is read here, never
-- session_user, precisely so the cascade passes; the migrator deleting a
-- single version directly is a migration's power and is allowed.
--
-- The three guard functions read no table and only compare: SECURITY INVOKER,
-- pinned search_path, EXECUTE revoked (firing a trigger needs none). Not
-- SECURITY DEFINER (CLAUDE.md 2.7): the census stays at two.
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   - RLS ENABLED and FORCED on both; script_isolation and
--     script_version_isolation FOR ALL, tenant AND programme, WITH CHECK
--     identical to USING; both in TENANT_SCOPED_TABLES.
--   - GRANTS, as narrow as 0027's:
--       script, kasuwa_app: SELECT, INSERT, and UPDATE on name, source_locale,
--         draft_graph, draft_translations, revision, published_revision and
--         updated_at only. Never the keys or created_at. No DELETE: no
--         operation deletes a script (an UPDATE or DELETE naming an ungranted
--         column or privilege fails 42501 before any row is read). SELECT ...
--         FOR UPDATE (the API locks the draft row for every write and for
--         publish) needs UPDATE on one column, which it has.
--       script_version, kasuwa_app: SELECT and INSERT only. Publishing
--         inserts; nothing updates or deletes.
--       kasuwa_test_admin: full DML on both, as for contact and account (test
--         only); the triggers above are what bind it.
--     Nobody kasuwa_app can enter may TRUNCATE either table (TRUNCATE skips
--     RLS and row triggers); the self-check asserts it.
--   - The owner is kasuwa_migrator (it creates the tables).
--
-- ---------------------------------------------------------------------------
-- INDEXES (D-L65 keyset)
-- ---------------------------------------------------------------------------
--   - script_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id): the
--     version FK's target; its prefix serves the programme FK lookup
--     (offboarding) and listProgrammeScripts' programme filter.
--   - script_name_keyset_idx (tenant_id, name COLLATE "C", id): listScripts'
--     keyset order, by name then id, across the caller's programmes. "C" so
--     the order is code-point order whatever the cluster's collation, and so
--     the cursor's resolved position compares the same way the index sorts.
--   - script_version_number_key UNIQUE (tenant_id, programme_id, script_id,
--     number): two publishes can never mint one number (the T-0113 suite pins
--     it); its prefix serves the script FK lookup (RESTRICT checks, newest
--     first lists) and the programme and tenant FK lookups.
--   - published_by_user_id has no index: its FK is only checked when a "user"
--     row is deleted or re-keyed, which nothing does today (as 0027's
--     created_by_user_id).
--   - Built on empty tables here, so they cost nothing.
--
-- ---------------------------------------------------------------------------
-- AUDIT (D-L96)
-- ---------------------------------------------------------------------------
-- A publish is audited as a new action, `published`. audit_event_action_check
-- (0008) is replaced by the same list plus `published`, and nothing else. The
-- new list is a superset, so every existing row satisfies it.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
-- No populated cell exists yet (D-L65), so this file uses plain DDL:
--   - tenant, programme, "user": SHARE ROW EXCLUSIVE for the whole file, which
--     is what creating an FK that references them takes anyway. It blocks
--     writes to those tables (sign-in bookkeeping on "user"), not reads, for
--     well under a second: everything else here works on new, empty tables.
--   - audit_event: ACCESS EXCLUSIVE, for the CHECK swap. ADD CONSTRAINT
--     scans every row to validate it: reads and writes of the audit log (and
--     so every audited write in the API) wait for that scan. At volume (the
--     first populated cell onward) split it: ADD CONSTRAINT ... NOT VALID in
--     this shape (a catalogue change, brief), then VALIDATE CONSTRAINT in its
--     own transaction (SHARE UPDATE EXCLUSIVE: reads and writes carry on).
--   - Taken up front in one fixed order (parents, then audit_event), with
--     lock_timeout = 5s, so the file fails fast instead of queueing behind a
--     long transaction and making everything behind it queue too.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied: it is one transaction and the
-- runner records it only on COMMIT. Fix the cause and run `pnpm db:migrate`.
-- To undo it after it has applied: never edit or delete this file or its
-- ledger row (append-only). Instead:
--   1. roll back the application first (apps/api/src/scripts, the admin
--      listProgrammeScripts query, `published` in AuditAction), and the seed's
--      SEED_SCRIPTS, the schema.ts mirror and TENANT_SCOPED_TABLES;
--   2. export the scripts if they hold data: published wording may be what a
--      regulator asks to see was read on a call;
--   3. in a NEW migration, as kasuwa_migrator, with SET LOCAL lock_timeout:
--      DROP TABLE script_version, then script (their policies, triggers,
--      indexes and FKs go with them); DROP FUNCTION
--      app.guard_script_keys_fixed(), app.refuse_script_version_update() and
--      app.guard_script_version_delete();
--   4. `published` in audit_event_action_check: leave it while any row uses
--      it. Removing it is a CHECK swap that fails on the first such row, and
--      the audit log is append-only, so those rows stay.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
-- What the new FKs take anyway; taken here so every lock is in this order.
LOCK TABLE tenant, programme, "user" IN SHARE ROW EXCLUSIVE MODE;
-- What the CHECK swap takes. Held until COMMIT.
LOCK TABLE audit_event IN ACCESS EXCLUSIVE MODE;

-- --- 2. the tables -------------------------------------------------------------
CREATE TABLE script (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  programme_id        uuid        NOT NULL,
  name                text        NOT NULL,
  source_locale       text        NOT NULL,
  draft_graph         jsonb       NOT NULL DEFAULT '{"startNodeId": "start", "nodes": []}'::jsonb,
  draft_translations  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  revision            integer     NOT NULL DEFAULT 1,
  published_revision  integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT script_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT script_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT script_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,

  CONSTRAINT script_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT script_source_locale_check
    CHECK (source_locale IN ('en', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw')),
  CONSTRAINT script_draft_graph_check CHECK (jsonb_typeof(draft_graph) = 'object'),
  CONSTRAINT script_draft_translations_check CHECK (jsonb_typeof(draft_translations) = 'object'),
  CONSTRAINT script_revision_check CHECK (revision >= 1),
  CONSTRAINT script_published_revision_check
    CHECK (published_revision IS NULL OR published_revision >= 1)
);

CREATE INDEX script_name_keyset_idx ON script (tenant_id, name COLLATE "C", id);

CREATE TABLE script_version (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL,
  programme_id          uuid        NOT NULL,
  script_id             uuid        NOT NULL,
  number                integer     NOT NULL,
  name                  text        NOT NULL,
  source_locale         text        NOT NULL,
  graph                 jsonb       NOT NULL,
  translations          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  changes               text[]      NOT NULL DEFAULT '{}',
  published_at          timestamptz NOT NULL DEFAULT now(),
  published_by_user_id  uuid,

  CONSTRAINT script_version_number_key UNIQUE (tenant_id, programme_id, script_id, number),
  CONSTRAINT script_version_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT script_version_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- Not NO ACTION, and not CASCADE: see KEYS in the header.
  CONSTRAINT script_version_script_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, script_id)
    REFERENCES script (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT script_version_published_by_same_tenant_fk
    FOREIGN KEY (tenant_id, published_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  CONSTRAINT script_version_number_check CHECK (number >= 1),
  CONSTRAINT script_version_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT script_version_source_locale_check
    CHECK (source_locale IN ('en', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw')),
  CONSTRAINT script_version_graph_check CHECK (jsonb_typeof(graph) = 'object'),
  CONSTRAINT script_version_translations_check CHECK (jsonb_typeof(translations) = 'object'),
  CONSTRAINT script_version_changes_check CHECK (cardinality(changes) <= 10)
);

ALTER TABLE script ENABLE ROW LEVEL SECURITY;
ALTER TABLE script FORCE ROW LEVEL SECURITY;
CREATE POLICY script_isolation ON script FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

ALTER TABLE script_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_version FORCE ROW LEVEL SECURITY;
CREATE POLICY script_version_isolation ON script_version FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

-- Explicit, so this file does not silently depend on the bootstrap's default
-- privileges, and so TRUNCATE, REFERENCES and TRIGGER are never held.
REVOKE ALL ON script, script_version FROM PUBLIC, kasuwa_app, kasuwa_test_admin;
GRANT SELECT, INSERT ON script TO kasuwa_app;
GRANT UPDATE (name, source_locale, draft_graph, draft_translations, revision,
              published_revision, updated_at)
  ON script TO kasuwa_app;
GRANT SELECT, INSERT ON script_version TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON script, script_version TO kasuwa_test_admin;

-- --- 3. triggers ---------------------------------------------------------------
-- 0018's function, attached; no second copy.
CREATE TRIGGER script_touch_updated_at
  BEFORE UPDATE ON script FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

-- The keys are fixed for every role but the migrator: an allow-list. See
-- "THE KEYS OF A SCRIPT ARE FIXED" in the header. The message names the rule,
-- never a value.
CREATE FUNCTION app.guard_script_keys_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'kasuwa_migrator' AND session_user = 'kasuwa_migrator' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'script.id, tenant_id and programme_id are fixed at creation and cannot be changed by this role'
    USING ERRCODE = 'insufficient_privilege';  -- 42501, as 0023, 0025 and 0027
END;
$$;
REVOKE ALL ON FUNCTION app.guard_script_keys_fixed() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

-- BEFORE, so the row is refused before any FK or policy check runs. Fires for
-- every row of a bulk UPDATE and for the DO UPDATE arm of an upsert.
CREATE TRIGGER script_keys_fixed
  BEFORE UPDATE ON script FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id)
  EXECUTE FUNCTION app.guard_script_keys_fixed();

-- A published version is immutable for every role. No WHEN clause: a no-op
-- UPDATE is refused too. See the header.
CREATE FUNCTION app.refuse_script_version_update() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'a published script version is immutable; publish a new version instead'
    USING ERRCODE = 'insufficient_privilege';  -- 42501, as 0008's append-only audit_event
END;
$$;
REVOKE ALL ON FUNCTION app.refuse_script_version_update() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

CREATE TRIGGER script_version_immutable
  BEFORE UPDATE ON script_version FOR EACH ROW
  EXECUTE FUNCTION app.refuse_script_version_update();

-- Deleting a version: the migrator only, which is also the role a cascaded
-- (offboarding) delete runs as. See the header.
CREATE FUNCTION app.guard_script_version_delete() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'kasuwa_migrator' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a published script version cannot be deleted by this role'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION app.guard_script_version_delete() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

CREATE TRIGGER script_version_delete_guard
  BEFORE DELETE ON script_version FOR EACH ROW
  EXECUTE FUNCTION app.guard_script_version_delete();

-- --- 4. audit_event: `published` (D-L96) ---------------------------------------
-- 0008's ten, plus `published`, and nothing else.
ALTER TABLE audit_event
  DROP CONSTRAINT audit_event_action_check,
  ADD CONSTRAINT audit_event_action_check CHECK (action IN (
    'created', 'updated', 'deleted', 'exported', 'invited', 'viewed',
    'failed_sign_in', 'rejected', 'rotated', 'played_recording', 'published'
  ));

-- --- 5. prove the posture ------------------------------------------------------
-- Runs once, here. The standing guards are the T-0113 acceptance suite and
-- schema-hygiene, which run on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  held text;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.script', 'public.script_version'] LOOP
    IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
              FROM pg_catalog.pg_class c WHERE c.oid = t::pg_catalog.regclass) THEN
      RAISE EXCEPTION '0030: % RLS is not enabled and forced', t;
    END IF;
    IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c
                                    WHERE c.oid = t::pg_catalog.regclass))
       <> 'kasuwa_migrator' THEN
      RAISE EXCEPTION '0030: % is not owned by kasuwa_migrator', t;
    END IF;
    IF NOT (pg_catalog.has_table_privilege(app_role, t, 'SELECT')
            AND pg_catalog.has_table_privilege(app_role, t, 'INSERT')) THEN
      RAISE EXCEPTION '0030: kasuwa_app cannot read and insert %', t;
    END IF;
    IF pg_catalog.has_table_privilege(app_role, t, 'DELETE') THEN
      RAISE EXCEPTION '0030: kasuwa_app may DELETE from %', t;
    END IF;
  END LOOP;

  -- The draft is editable; the keys and created_at never are.
  IF NOT pg_catalog.has_column_privilege(app_role, 'public.script', 'draft_graph', 'UPDATE') THEN
    RAISE EXCEPTION '0030: kasuwa_app cannot edit a draft';
  END IF;
  SELECT pg_catalog.string_agg(c.col, ', ' ORDER BY c.col)
    INTO held
    FROM pg_catalog.unnest(ARRAY['id', 'tenant_id', 'programme_id', 'created_at']) AS c(col)
   WHERE pg_catalog.has_column_privilege(app_role, 'public.script', c.col, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0030: kasuwa_app may UPDATE script column(s) it must not: %', held;
  END IF;
  -- A published version takes no UPDATE from kasuwa_app on any column.
  SELECT pg_catalog.string_agg(a.attname, ', ' ORDER BY a.attname)
    INTO held
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.script_version'::pg_catalog.regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND pg_catalog.has_column_privilege(app_role, a.attrelid, a.attnum, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0030: kasuwa_app may UPDATE script_version column(s): %', held;
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger tg
       WHERE NOT tg.tgisinternal
         AND ((tg.tgrelid = 'public.script'::pg_catalog.regclass
               AND tg.tgname = 'script_keys_fixed')
           OR (tg.tgrelid = 'public.script_version'::pg_catalog.regclass
               AND tg.tgname IN ('script_version_immutable', 'script_version_delete_guard')))) <> 3 THEN
    RAISE EXCEPTION '0030: a script guard trigger is missing';
  END IF;
  -- The immutability trigger has no WHEN clause: a no-op UPDATE is refused too.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger tg
              WHERE tg.tgrelid = 'public.script_version'::pg_catalog.regclass
                AND tg.tgname = 'script_version_immutable' AND tg.tgqual IS NOT NULL) THEN
    RAISE EXCEPTION '0030: script_version_immutable must fire on every UPDATE';
  END IF;

  -- Every FK on either table is ON UPDATE RESTRICT (D-L76).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
              WHERE con.contype = 'f'
                AND con.conrelid IN ('public.script'::pg_catalog.regclass,
                                     'public.script_version'::pg_catalog.regclass)
                AND con.confupdtype <> 'r') THEN
    RAISE EXCEPTION '0030: a script FK is not ON UPDATE RESTRICT';
  END IF;

  -- TRUNCATE skips RLS entirely, and BYPASSRLS skips the policies. Checked for
  -- kasuwa_app AND every role it is a member of, whatever the INHERIT option.
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'TRUNCATE script' AS what
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.script', 'TRUNCATE')
     UNION ALL
     SELECT 'TRUNCATE script_version'
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.script_version', 'TRUNCATE')
     UNION ALL
     SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0030: kasuwa_app, or a role it can enter, can bypass script row security: %', held;
  END IF;
END
$$;
