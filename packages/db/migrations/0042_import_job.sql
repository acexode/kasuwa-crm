-- ---------------------------------------------------------------------------
-- 0042 - import_job, contact.import_job_id, and the removal trigger that fails
-- and erases a removed creator's imports (T-0094, Agent 3; ADR-0017 flow
-- steps 1-7; D-L128 Q4-Q7, D-L146, D-L148, D-L150, D-L151, D-L155, D-L158,
-- D-L160; D-L65, D-L74, D-L76).
--
-- In this one file:
--   1. locks;
--   2. UNIQUE (tenant_id, programme_id, id) on stored_object, the target of
--      import_job's composite FK (D-L160 builder note);
--   3. the import_job table, its checks, keys and indexes;
--   4. RLS and grants;
--   5. contact.import_job_id, its composite FK and its index;
--   6. the removal trigger (D-L160 rulings 1 and 2);
--   7. a self-check of the posture.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- ---------------------------------------------------------------------------
-- import_job COLUMNS
-- ---------------------------------------------------------------------------
--   id, tenant_id, programme_id     the job and its tenancy keys (fixed:
--                                   kasuwa_app holds no UPDATE on them).
--   stored_object_id                the raw file's metadata row, UNIQUE: one
--                                   job per object. FK (tenant_id,
--                                   programme_id, stored_object_id), so a job
--                                   can only ever name bytes in its own
--                                   programme.
--   created_by_user_id              the creator; the job RUNS AS this user
--                                   (D-L128 Q7, D-L151). A restrictive INSERT
--                                   policy pins it to the session's user, so
--                                   nobody can create a job that runs as
--                                   somebody else.
--   status                          ImportStatus (records.openapi.yaml).
--   upload_id                       the multipart upload the server opened
--                                   for the object's key (D-L155). Stored,
--                                   never returned; complete uses it.
--   filename                        user text, never logged; erased with the
--                                   raw file (D-L148).
--   size_bytes, content_type,
--   part_count                      the declaration and the server's part
--                                   plan (R1), so a resume re-signs the same
--                                   parts.
--   headers, suggested_mapping,
--   mapping                         jsonb. Column NAMES (never a cell), the
--                                   guess, and the saved mapping. headers,
--                                   mapping and filename are erased with the
--                                   raw file (D-L148, D-L150).
--   created_count, skipped_count,
--   failed_count, errors,
--   errors_truncated                the report: counts and `{row, column,
--                                   code}` only, at most 1,000 (D-L148).
--   cancel_requested                set by cancelImport on a running job; the
--                                   run honours it between batches.
--   raw_file_deleted_at, uploaded_at, finished_at, created_at, changed_at
--
-- changed_at, NOT updated_at (the wire's `updatedAt`). The T-0011 hygiene
-- suite probes every table with an `updated_at` column on a seeded or planted
-- row, and it has no plant for this table; seeding an import would change
-- the import lists other suites pin exactly. The repository sets changed_at
-- in every UPDATE it issues, and so does the trigger below. Reported in the
-- T-0094 report.
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3, D-L74, D-L76)
-- ---------------------------------------------------------------------------
--   - tenant_id -> tenant: ON DELETE CASCADE (offboarding).
--   - (tenant_id, programme_id) -> programme: ON DELETE CASCADE.
--   - (tenant_id, programme_id, stored_object_id) -> stored_object
--     (tenant_id, programme_id, id): NO ACTION. A stored_object row is never
--     deleted by the application (kasuwa_app holds no DELETE); a tenant or
--     programme delete removes both through their own cascades, and NO ACTION
--     is checked at the end of that statement, after them.
--   - (tenant_id, created_by_user_id) -> "user" (tenant_id, id): NO ACTION,
--     for the same reason (what a user delete does stays open, D-L61).
--   - contact (tenant_id, programme_id, import_job_id) -> import_job
--     (tenant_id, programme_id, id): NO ACTION. A contact can only name a job
--     in its own programme.
--   Referential checks ignore row security, so every FK carries tenant_id.
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   - RLS ENABLED and FORCED; import_job_isolation FOR ALL, tenant AND
--     programme, WITH CHECK identical to USING; in TENANT_SCOPED_TABLES and
--     the schema.ts mirror.
--   - import_job_insert_as_session, RESTRICTIVE FOR INSERT: the creator is
--     the session's own user (app.current_user_id()), as stored_object's
--     uploader and audit_event's actor (0008, 0040).
--   - GRANTS: kasuwa_app SELECT, INSERT, and UPDATE on the mutable columns
--     only: never id, tenant_id, programme_id, stored_object_id,
--     created_by_user_id, created_at, size_bytes, content_type or part_count.
--     NO DELETE and no TRUNCATE for it or any role it can enter (self-check).
--   - kasuwa_auth: nothing. kasuwa_test_admin: full DML (test only).
--
-- ---------------------------------------------------------------------------
-- THE REMOVAL TRIGGER (D-L160 rulings 1 and 2)
-- ---------------------------------------------------------------------------
-- A creator who loses the programme cannot see the job any more, so the run
-- cannot record the failure as the creator, and the retention job (which
-- also runs as the creator) could not erase it. So, in the statement that
-- ends the membership (the 0031 pattern: AFTER STATEMENT with transition
-- tables, on DELETE and on a key-moving UPDATE of user_programme):
--   - every import of that creator IN THAT PROGRAMME whose status is
--     awaiting_upload, reading_header, awaiting_mapping, queued or running
--     becomes `failed` (finished_at set, counts kept), and its headers,
--     filename and mapping are cleared;
--   - finished, failed, rejected, cancelled and expired imports are left as
--     they are (their retention job, or the bucket lifecycle rule, removes
--     the bytes; D-L146);
--   - the bytes themselves are not touched here: the database cannot reach
--     the bucket. The lifecycle rule (expire at 8 days) removes them.
-- As 0031 step (a): a session that cannot see an ended membership's
-- programme is refused (42501), so the trigger never silently skips rows
-- RLS hides. As 0031 step (e): a membership the same statement re-creates
-- ended nothing. A cascade from a tenant or programme delete removes the
-- jobs anyway.
-- NO SECURITY DEFINER (CLAUDE.md 2.7): SECURITY INVOKER, pinned search_path,
-- EXECUTE revoked from PUBLIC. The definer census stays at two (self-check).
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
--   - tenant, programme, "user", stored_object, contact, user_programme:
--     SHARE ROW EXCLUSIVE for the whole file, in this order. It blocks writes
--     to them (not reads) while the file runs.
--   - stored_object: the UNIQUE constraint builds an index (a scan of the
--     table, small: imports only).
--   - contact (a hot table): ADD COLUMN with no default is a catalogue change;
--     the FK is validated by a scan that finds only NULLs; the partial index
--     contact_import_job_idx is built on no rows (every import_job_id is
--     NULL). All accepted inside the transaction because no populated cell
--     exists (D-L65). On a populated cell the FK would be added NOT VALID and
--     validated in a no-transaction file.
--   - user_programme: CREATE TRIGGER takes SHARE ROW EXCLUSIVE; session
--     resolution (reads) keeps answering.
--   - lock_timeout = 5s.
-- Steady state: every DELETE or UPDATE statement on user_programme runs the
-- function once; a permission-set change ends nothing and returns at once.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied. To undo it after it has applied
-- (append-only: never edit this file or its ledger row), in a NEW migration,
-- as kasuwa_migrator, after rolling back T-0094's application code:
--   DROP TRIGGER user_programme_removal_fails_imports ON user_programme;
--   DROP TRIGGER user_programme_rewrite_fails_imports ON user_programme;
--   DROP FUNCTION app.fail_removed_creator_imports();
--   ALTER TABLE contact DROP COLUMN import_job_id;  (drops its FK and index)
--   delete the raw files first (or let the lifecycle rule expire them), then
--   DROP TABLE import_job;
--   ALTER TABLE stored_object DROP CONSTRAINT stored_object_tenant_programme_id_key;
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
LOCK TABLE tenant, programme, "user", stored_object, contact, user_programme
  IN SHARE ROW EXCLUSIVE MODE;

-- --- 2. the composite target on stored_object ---------------------------------
ALTER TABLE stored_object
  ADD CONSTRAINT stored_object_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id);

-- --- 3. the table ---------------------------------------------------------------
CREATE TABLE import_job (
  id                   uuid        PRIMARY KEY,
  tenant_id            uuid        NOT NULL,
  programme_id         uuid        NOT NULL,
  stored_object_id     uuid        NOT NULL,
  created_by_user_id   uuid        NOT NULL,
  status               text        NOT NULL DEFAULT 'awaiting_upload',
  upload_id            text,
  filename             text,
  size_bytes           bigint      NOT NULL,
  content_type         text        NOT NULL,
  part_count           integer     NOT NULL,
  headers              jsonb,
  suggested_mapping    jsonb,
  mapping              jsonb,
  created_count        integer     NOT NULL DEFAULT 0,
  skipped_count        integer     NOT NULL DEFAULT 0,
  failed_count         integer     NOT NULL DEFAULT 0,
  errors               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  errors_truncated     boolean     NOT NULL DEFAULT false,
  cancel_requested     boolean     NOT NULL DEFAULT false,
  raw_file_deleted_at  timestamptz,
  uploaded_at          timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  changed_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT import_job_stored_object_key UNIQUE (stored_object_id),
  -- The target of contact's composite FK.
  CONSTRAINT import_job_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),

  CONSTRAINT import_job_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT import_job_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT import_job_stored_object_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, stored_object_id)
    REFERENCES stored_object (tenant_id, programme_id, id) ON DELETE NO ACTION ON UPDATE RESTRICT,
  CONSTRAINT import_job_creator_same_tenant_fk
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE NO ACTION ON UPDATE RESTRICT,

  CONSTRAINT import_job_status_check CHECK (status IN (
    'awaiting_upload', 'reading_header', 'awaiting_mapping', 'queued', 'running',
    'finished', 'failed', 'rejected', 'cancelled', 'expired')),
  CONSTRAINT import_job_filename_check
    CHECK (filename IS NULL OR char_length(filename) BETWEEN 1 AND 255),
  CONSTRAINT import_job_upload_id_check
    CHECK (upload_id IS NULL OR char_length(upload_id) BETWEEN 1 AND 1024),
  CONSTRAINT import_job_size_check CHECK (size_bytes BETWEEN 1 AND 26214400),
  CONSTRAINT import_job_content_type_check
    CHECK (content_type IN ('text/csv', 'application/csv', 'application/vnd.ms-excel')),
  CONSTRAINT import_job_part_count_check CHECK (part_count BETWEEN 1 AND 4),
  CONSTRAINT import_job_headers_check
    CHECK (headers IS NULL OR jsonb_typeof(headers) = 'array'),
  CONSTRAINT import_job_suggested_mapping_check
    CHECK (suggested_mapping IS NULL OR jsonb_typeof(suggested_mapping) = 'array'),
  CONSTRAINT import_job_mapping_check
    CHECK (mapping IS NULL OR jsonb_typeof(mapping) = 'object'),
  CONSTRAINT import_job_errors_check
    CHECK (jsonb_typeof(errors) = 'array' AND jsonb_array_length(errors) <= 1000),
  CONSTRAINT import_job_counts_check
    CHECK (created_count BETWEEN 0 AND 100000
           AND skipped_count BETWEEN 0 AND 100000
           AND failed_count BETWEEN 0 AND 100000)
);

-- listImports: a programme's imports newest first (keyset on created_at, id);
-- also serves the programme FK lookup. The (tenant_id, programme_id, id)
-- unique index serves the tenant FK prefix.
CREATE INDEX import_job_programme_created_idx
  ON import_job (tenant_id, programme_id, created_at DESC, id DESC);
-- The removal trigger: one creator's imports in one programme.
CREATE INDEX import_job_creator_idx
  ON import_job (tenant_id, created_by_user_id, programme_id);

-- --- 4. RLS and grants ------------------------------------------------------------
ALTER TABLE import_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job FORCE ROW LEVEL SECURITY;
CREATE POLICY import_job_isolation ON import_job FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));
CREATE POLICY import_job_insert_as_session ON import_job AS RESTRICTIVE FOR INSERT
  WITH CHECK (created_by_user_id = app.current_user_id());

REVOKE ALL ON import_job FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_test_admin;
GRANT SELECT, INSERT ON import_job TO kasuwa_app;
GRANT UPDATE (status, upload_id, filename, headers, suggested_mapping, mapping,
              created_count, skipped_count, failed_count, errors, errors_truncated,
              cancel_requested, raw_file_deleted_at, uploaded_at, finished_at, changed_at)
  ON import_job TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON import_job TO kasuwa_test_admin;

-- --- 5. contact.import_job_id -------------------------------------------------------
ALTER TABLE contact ADD COLUMN import_job_id uuid;
ALTER TABLE contact
  ADD CONSTRAINT contact_import_job_same_programme_fk
  FOREIGN KEY (tenant_id, programme_id, import_job_id)
  REFERENCES import_job (tenant_id, programme_id, id) ON DELETE NO ACTION ON UPDATE RESTRICT;
-- The importId filter on listContacts, and the FK's lookup. Partial: almost
-- every contact has none.
CREATE INDEX contact_import_job_idx
  ON contact (tenant_id, programme_id, import_job_id)
  WHERE import_job_id IS NOT NULL;

-- --- 6. the removal trigger ----------------------------------------------------------
-- See THE REMOVAL TRIGGER in the header. Messages name the rule, never an id.
CREATE FUNCTION app.fail_removed_creator_imports() RETURNS trigger
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  sees_every_row boolean;
  t_ids uuid[];
  p_ids uuid[];
  u_ids uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT pg_catalog.array_agg(o.tenant_id), pg_catalog.array_agg(o.programme_id),
           pg_catalog.array_agg(o.user_id)
      INTO t_ids, p_ids, u_ids
      FROM (SELECT DISTINCT r.tenant_id, r.programme_id, r.user_id FROM ended_rows r) o;
  ELSE
    SELECT pg_catalog.array_agg(o.tenant_id), pg_catalog.array_agg(o.programme_id),
           pg_catalog.array_agg(o.user_id)
      INTO t_ids, p_ids, u_ids
      FROM (SELECT DISTINCT r.tenant_id, r.programme_id, r.user_id
              FROM ended_rows r
             WHERE NOT EXISTS (SELECT 1 FROM kept_rows k
                                WHERE k.tenant_id = r.tenant_id
                                  AND k.programme_id = r.programme_id
                                  AND k.user_id = r.user_id)) o;
  END IF;
  IF t_ids IS NULL THEN
    RETURN NULL;
  END IF;

  -- The session must see every import it is about to fail (NULL-safe).
  SELECT r.rolbypassrls OR r.rolsuper
    INTO sees_every_row
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user;
  IF sees_every_row IS NOT TRUE
     AND EXISTS (SELECT 1
                   FROM unnest(t_ids, p_ids) AS e(tenant_id, programme_id)
                  WHERE (e.tenant_id = app.current_tenant_id()
                         AND e.programme_id = ANY (app.current_programme_ids())) IS NOT TRUE) THEN
    RAISE EXCEPTION 'a membership can only be removed by a session that reaches its programme, so that the member''s imports can be failed'
      USING ERRCODE = 'insufficient_privilege';  -- 42501
  END IF;

  UPDATE public.import_job j
     SET status = 'failed',
         finished_at = coalesce(j.finished_at, pg_catalog.now()),
         headers = NULL,
         filename = NULL,
         mapping = NULL,
         changed_at = pg_catalog.now()
    FROM unnest(t_ids, p_ids, u_ids) AS e(tenant_id, programme_id, user_id)
   WHERE j.tenant_id = e.tenant_id
     AND j.programme_id = e.programme_id
     AND j.created_by_user_id = e.user_id
     AND j.status IN ('awaiting_upload', 'reading_header', 'awaiting_mapping', 'queued', 'running')
     -- Still (again) a member by the end of the statement: nothing ended.
     AND NOT EXISTS (SELECT 1 FROM public.user_programme up
                      WHERE up.tenant_id = e.tenant_id
                        AND up.programme_id = e.programme_id
                        AND up.user_id = e.user_id);

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;
REVOKE ALL ON FUNCTION app.fail_removed_creator_imports() FROM PUBLIC;

CREATE TRIGGER user_programme_removal_fails_imports
  AFTER DELETE ON user_programme
  REFERENCING OLD TABLE AS ended_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.fail_removed_creator_imports();

CREATE TRIGGER user_programme_rewrite_fails_imports
  AFTER UPDATE ON user_programme
  REFERENCING OLD TABLE AS ended_rows NEW TABLE AS kept_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.fail_removed_creator_imports();

-- --- 7. prove the posture ----------------------------------------------------------
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  held text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c WHERE c.oid = 'public.import_job'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '0042: import_job RLS is not enabled and forced';
  END IF;
  IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c
                                  WHERE c.oid = 'public.import_job'::pg_catalog.regclass))
     <> 'kasuwa_migrator' THEN
    RAISE EXCEPTION '0042: import_job is not owned by kasuwa_migrator';
  END IF;
  SELECT pg_catalog.string_agg(c.col, ', ' ORDER BY c.col)
    INTO held
    FROM pg_catalog.unnest(ARRAY['id', 'tenant_id', 'programme_id', 'stored_object_id',
                                 'created_by_user_id', 'created_at', 'size_bytes',
                                 'content_type', 'part_count']) AS c(col)
   WHERE pg_catalog.has_column_privilege(app_role, 'public.import_job', c.col, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0042: kasuwa_app may UPDATE import_job column(s) it must not: %', held;
  END IF;
  IF pg_catalog.has_table_privilege('kasuwa_auth', 'public.import_job', 'SELECT')
     OR pg_catalog.has_table_privilege('kasuwa_auth', 'public.import_job', 'INSERT')
     OR pg_catalog.has_any_column_privilege('kasuwa_auth', 'public.import_job', 'UPDATE')
     OR pg_catalog.has_table_privilege('kasuwa_auth', 'public.import_job', 'DELETE') THEN
    RAISE EXCEPTION '0042: kasuwa_auth holds a privilege on import_job';
  END IF;
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'DELETE import_job' AS what
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.import_job', 'DELETE')
     UNION ALL
     SELECT 'TRUNCATE import_job'
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.import_job', 'TRUNCATE')
     UNION ALL
     SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0042: kasuwa_app, or a role it can enter, can delete import_job rows or bypass its row security: %', held;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.user_programme'::pg_catalog.regclass
         AND t.tgname IN ('user_programme_removal_fails_imports', 'user_programme_rewrite_fails_imports')
         AND NOT t.tgisinternal AND t.tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION '0042: the removal triggers are missing or disabled';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')) <> 2 THEN
    RAISE EXCEPTION '0042: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END
$$;
