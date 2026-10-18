-- ---------------------------------------------------------------------------
-- 0040 - stored_object, the metadata row of every stored file (T-0092,
-- Agent 3; ADR-0017 Decision 3, D-L128, D-L146, D-L150, D-L76, D-L94).
--
-- Object storage has no row security. A file in the bucket is reached only
-- through its row here: the API issues a presigned URL only after it has read
-- the row inside the caller's tenant transaction, so RLS on this table is
-- what isolates the bytes, and the server-minted key prefix is the second
-- layer (ADR-0017 Decision 3). The import job table (T-0094) references it.
--
-- In this one file: locks; the table, its checks, keys and index; RLS and
-- grants; the guard trigger; and a self-check of the posture.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- ---------------------------------------------------------------------------
-- COLUMNS (exactly the T-0092 suite's list, R3)
-- ---------------------------------------------------------------------------
--   id                    uuid PK. IS the key's fileId (R1).
--   tenant_id, programme_id
--                         the tenancy keys; fixed at creation (GUARD)
--   key                   text NOT NULL UNIQUE. Equal, by CHECK, to
--                         tenant/<tenant_id>/programme/<programme_id>/<purpose>/<id>
--                         (R1). Derived from the row, so it is never an
--                         independent input that could point a row at another
--                         tenant's bytes; and since it can never change
--                         (GUARD), neither can the bytes a row names.
--   purpose               text NOT NULL, CHECK 'import' (the closed enum of
--                         @kasuwa/storage-adapter's STORAGE_PURPOSES). Text
--                         and a CHECK, not an enum type (0019's VALUE SETS).
--   declared_size_bytes   bigint NOT NULL, > 0: what the client declared, and
--                         what the part URLs are signed for.
--   verified_size_bytes   bigint NULL, >= 0: what `head` reported at complete.
--   content_type          text NOT NULL, 1..255 characters.
--   sha256                bytea NULL, 32 bytes when set.
--   status                text NOT NULL DEFAULT 'pending':
--                         pending | uploaded | rejected | deleted.
--   uploaded_by_user_id   uuid NOT NULL -> "user" (tenant_id, id).
--   created_at            timestamptz NOT NULL DEFAULT now().
--   expires_at            timestamptz NULL: when the sweeper (T-0094, D-L146)
--                         deletes the object. The repository sets 24 hours
--                         for a pending row; NULL is "no deadline set yet".
--
-- NO filename column (R3, D-L150): a filename is user text, PII-adjacent,
-- and lives on T-0094's import_job, where D-L148 erases it.
-- NO updated_at: the row's history is its status, and the audit events
-- (T-0094) record who moved it and when.
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3, D-L74, D-L76)
-- ---------------------------------------------------------------------------
--   - tenant_id -> tenant (id): ON DELETE CASCADE (offboarding), ON UPDATE
--     RESTRICT.
--   - (tenant_id, programme_id) -> programme (tenant_id, id): ON DELETE
--     CASCADE, ON UPDATE RESTRICT. A row's programme is in its tenant.
--   - (tenant_id, uploaded_by_user_id) -> "user" (tenant_id, id): ON DELETE
--     RESTRICT, ON UPDATE RESTRICT. A user in another tenant fails exactly as
--     an invented id. What a user delete does to their uploads stays open
--     (D-L61); refusing loses nothing. A tenant or programme delete still
--     works: it reaches stored_object through its own CASCADE FKs, and the
--     RESTRICT check queued by the cascaded "user" delete runs after them
--     (0026 and 0027 explain the RI ordering; the T-0092 suite deletes a
--     programme and a tenant holding rows, as kasuwa_migrator).
--   Referential checks ignore row security, so every FK to a tenant-scoped
--   table carries tenant_id.
--
-- DELETING A TENANT'S ROWS DOES NOT DELETE ITS BYTES. Offboarding runs
-- `deletePrefix(tenantStoragePrefix(id))` in @kasuwa/storage-adapter, which
-- removes every object and aborts every open upload under tenant/<id>/
-- (ADR-0017, D-L128 Q2, R10); the bucket lifecycle rule is the backstop
-- (D-L146).
--
-- ---------------------------------------------------------------------------
-- GUARD (D-L76's allow-list, as 0027 and 0036)
-- ---------------------------------------------------------------------------
-- app.guard_stored_object_fixed(), a BEFORE UPDATE row trigger, raises 42501
-- unless BOTH current_user AND session_user are kasuwa_migrator, when an
-- UPDATE would:
--   - change id, tenant_id, programme_id, purpose or key: a row can never be
--     re-pointed at other bytes, nor moved across a tenant or a BPO client;
--   - move a row OUT of `deleted`: deleted is terminal (R8). The bytes are
--     gone; a row claiming otherwise would issue URLs for nothing, or for
--     whatever a later upload put there.
-- That binds kasuwa_app (including after SET ROLE kasuwa_sweeper),
-- kasuwa_test_admin (BYPASSRLS) and any role added later. kasuwa_app also
-- holds no UPDATE on those columns at all (TENANCY), so its statement fails
-- 42501 before a row is read; two independent layers. The guard reads no
-- table: SECURITY INVOKER, pinned search_path, EXECUTE revoked. Not a
-- SECURITY DEFINER (CLAUDE.md 2.7): the census stays at two.
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   - RLS ENABLED and FORCED; stored_object_isolation FOR ALL, tenant AND
--     programme, WITH CHECK identical to USING; in TENANT_SCOPED_TABLES and
--     the schema.ts mirror.
--   - stored_object_insert_as_session, RESTRICTIVE FOR INSERT: a row is
--     inserted only as `pending`, unverified, unhashed, and uploaded by the
--     session's own user (app.current_user_id()), as audit_event's actor rule
--     (0008). kasuwa_app cannot claim an upload that never happened, nor
--     attribute one to somebody else. The migrator (BYPASSRLS) is unaffected.
--   - GRANTS: kasuwa_app gets SELECT and INSERT, and UPDATE on (status,
--     verified_size_bytes, sha256, expires_at) only. Never the keys, purpose,
--     key, uploaded_by_user_id, created_at, declared_size_bytes or
--     content_type: the declaration is what the URLs were signed for, and the
--     uploader and time are the audit trail's.
--   - NO DELETE for kasuwa_app (T-0092 task, suite T): rows move to
--     `deleted`. REVOKE rather than 0027's restrictive policy, so a DELETE is
--     42501 on the statement, which is what the suite pins. No TRUNCATE for it
--     or any role it can enter (the self-check). Cascades from a tenant or
--     programme delete skip privileges and row security, so offboarding still
--     removes rows.
--   - kasuwa_auth: nothing (REVOKE ALL, belt and braces: the bootstrap's
--     default privileges never name it).
--   - kasuwa_test_admin: full DML, as for every table (test only; inert
--     outside development and test, packages/db/CLAUDE.md invariant 10).
--   - Owned by kasuwa_migrator (it creates the table).
--
-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------
--   - stored_object_pkey (id).
--   - stored_object_key_key UNIQUE (key), on key alone (suite T): no two rows
--     ever name the same bytes, across every tenant.
--   - stored_object_programme_created_idx (tenant_id, programme_id,
--     created_at DESC, id DESC): the tenant and programme FK lookups
--     (offboarding would otherwise seq-scan once per deleted parent, 0027's
--     M1) and a programme's newest uploads first.
--   - uploaded_by_user_id has no index: its FK is checked only when a "user"
--     row is deleted or re-keyed, which nothing does (0022, 0027). Add one
--     with a user delete path. expires_at has none: the sweeper is a delayed
--     job per import (D-L146), not a scan. Add one if a scan appears.
--   All built on an empty table.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
--   - tenant, programme, "user": SHARE ROW EXCLUSIVE for the whole file, which
--     is what creating an FK that references them takes anyway, taken up
--     front in one order. It blocks writes to those tables (sign-in
--     bookkeeping on "user"), not reads, for the milliseconds the file takes:
--     every statement works on the new, empty table or the catalogue.
--   - lock_timeout = 5s: refuse to queue behind a long transaction.
--   - Steady state: the guard's WHEN clause skips the function on every
--     UPDATE that leaves the keys and a non-deleted status alone.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied (one transaction; the runner
-- records it only on COMMIT). Fix the cause and run `pnpm db:migrate` again.
-- To undo it after it has applied: never edit or delete this file or its
-- ledger row (append-only). Instead:
--   1. roll back the application first (@kasuwa/storage-adapter's
--      StoredObjectRepository, and T-0094 if it has shipped: import_job
--      references this table), then the schema.ts mirror and the
--      TENANT_SCOPED_TABLES entry;
--   2. delete the objects the rows name (deletePrefix per tenant) or let the
--      lifecycle rule expire them (D-L146): dropping the rows first would
--      leave bytes nothing can find;
--   3. in a NEW migration, as kasuwa_migrator: DROP TABLE stored_object (its
--      policies, trigger, indexes and FKs go with it), then DROP FUNCTION
--      app.guard_stored_object_fixed().
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
LOCK TABLE tenant, programme, "user" IN SHARE ROW EXCLUSIVE MODE;

-- --- 2. the table --------------------------------------------------------------
CREATE TABLE stored_object (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL,
  programme_id          uuid        NOT NULL,
  key                   text        NOT NULL,
  purpose               text        NOT NULL,
  declared_size_bytes   bigint      NOT NULL,
  verified_size_bytes   bigint,
  content_type          text        NOT NULL,
  sha256                bytea,
  status                text        NOT NULL DEFAULT 'pending',
  uploaded_by_user_id   uuid        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz,

  CONSTRAINT stored_object_key_key UNIQUE (key),

  CONSTRAINT stored_object_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT stored_object_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT stored_object_uploader_same_tenant_fk
    FOREIGN KEY (tenant_id, uploaded_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- R1: the key is the row's own path, character for character. uuid::text is
  -- Postgres's canonical lower-case form, as the adapter mints it.
  CONSTRAINT stored_object_key_matches_row CHECK (
    key = 'tenant/' || tenant_id::text || '/programme/' || programme_id::text
          || '/' || purpose || '/' || id::text
  ),
  CONSTRAINT stored_object_purpose_check CHECK (purpose IN ('import')),
  CONSTRAINT stored_object_status_check
    CHECK (status IN ('pending', 'uploaded', 'rejected', 'deleted')),
  CONSTRAINT stored_object_declared_size_check CHECK (declared_size_bytes > 0),
  CONSTRAINT stored_object_verified_size_check
    CHECK (verified_size_bytes IS NULL OR verified_size_bytes >= 0),
  CONSTRAINT stored_object_content_type_check
    CHECK (char_length(content_type) BETWEEN 1 AND 255),
  CONSTRAINT stored_object_sha256_check
    CHECK (sha256 IS NULL OR octet_length(sha256) = 32)
);

-- Not partial: the tenant and programme FK lookups. See INDEXES in the header.
CREATE INDEX stored_object_programme_created_idx
  ON stored_object (tenant_id, programme_id, created_at DESC, id DESC);

-- --- 3. RLS and grants -----------------------------------------------------------
ALTER TABLE stored_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE stored_object FORCE ROW LEVEL SECURITY;
CREATE POLICY stored_object_isolation ON stored_object FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));
-- RESTRICTIVE, AND-ed with the isolation policy on INSERT. See TENANCY.
CREATE POLICY stored_object_insert_as_session ON stored_object AS RESTRICTIVE FOR INSERT
  WITH CHECK (uploaded_by_user_id = app.current_user_id()
              AND status = 'pending'
              AND verified_size_bytes IS NULL
              AND sha256 IS NULL);

-- Explicit, so this file does not silently depend on the bootstrap's default
-- privileges (which would give kasuwa_app DELETE), and so TRUNCATE,
-- REFERENCES and TRIGGER are never held.
REVOKE ALL ON stored_object FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_test_admin;
GRANT SELECT, INSERT ON stored_object TO kasuwa_app;
-- Column-level: the status moves and what verification records. See TENANCY.
GRANT UPDATE (status, verified_size_bytes, sha256, expires_at) ON stored_object TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stored_object TO kasuwa_test_admin;

-- --- 4. the guard ----------------------------------------------------------------
-- An allow-list. See GUARD in the header. The message names the rule, never a
-- value.
CREATE FUNCTION app.guard_stored_object_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'kasuwa_migrator' AND session_user = 'kasuwa_migrator' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stored_object: the key, its parts and a deleted status are fixed and cannot be changed by this role'
    USING ERRCODE = 'insufficient_privilege';  -- 42501, as 0027 and 0036
END;
$$;
-- Only the trigger calls it; firing a trigger needs no EXECUTE.
REVOKE ALL ON FUNCTION app.guard_stored_object_fixed() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

-- BEFORE, so the row is refused before any FK or policy check runs. No column
-- list: the WHEN clause sees the final NEW, whatever set it.
CREATE TRIGGER stored_object_fixed
  BEFORE UPDATE ON stored_object FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id
        OR NEW.purpose IS DISTINCT FROM OLD.purpose
        OR NEW.key IS DISTINCT FROM OLD.key
        OR (OLD.status = 'deleted' AND NEW.status IS DISTINCT FROM 'deleted'))
  EXECUTE FUNCTION app.guard_stored_object_fixed();

-- --- 5. prove the posture ----------------------------------------------------------
-- Runs once, here. The standing guards are the T-0092 acceptance suite and
-- rls-enforcement, which run on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  held text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c WHERE c.oid = 'public.stored_object'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '0040: stored_object RLS is not enabled and forced';
  END IF;
  IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c
                                  WHERE c.oid = 'public.stored_object'::pg_catalog.regclass))
     <> 'kasuwa_migrator' THEN
    RAISE EXCEPTION '0040: stored_object is not owned by kasuwa_migrator';
  END IF;
  IF NOT (pg_catalog.has_table_privilege(app_role, 'public.stored_object', 'SELECT')
          AND pg_catalog.has_table_privilege(app_role, 'public.stored_object', 'INSERT')
          AND pg_catalog.has_column_privilege(app_role, 'public.stored_object', 'status', 'UPDATE')) THEN
    RAISE EXCEPTION '0040: kasuwa_app cannot read, create and move stored objects';
  END IF;
  -- has_column_privilege also sees a table-level grant, so this fails if one
  -- is ever added back.
  SELECT pg_catalog.string_agg(c.col, ', ' ORDER BY c.col)
    INTO held
    FROM pg_catalog.unnest(ARRAY['id', 'tenant_id', 'programme_id', 'key', 'purpose',
                                 'declared_size_bytes', 'content_type', 'uploaded_by_user_id',
                                 'created_at']) AS c(col)
   WHERE pg_catalog.has_column_privilege(app_role, 'public.stored_object', c.col, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0040: kasuwa_app may UPDATE stored_object column(s) it must not: %', held;
  END IF;
  IF pg_catalog.has_table_privilege('kasuwa_auth', 'public.stored_object', 'SELECT')
     OR pg_catalog.has_table_privilege('kasuwa_auth', 'public.stored_object', 'INSERT')
     OR pg_catalog.has_any_column_privilege('kasuwa_auth', 'public.stored_object', 'UPDATE')
     OR pg_catalog.has_table_privilege('kasuwa_auth', 'public.stored_object', 'DELETE') THEN
    RAISE EXCEPTION '0040: kasuwa_auth holds a privilege on stored_object';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.stored_object'::pg_catalog.regclass
                    AND t.tgname = 'stored_object_fixed' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '0040: the stored_object guard is missing';
  END IF;

  -- DELETE (rows move to deleted), TRUNCATE (skips RLS) and BYPASSRLS, for
  -- kasuwa_app AND every role it is a member of, whatever the INHERIT option
  -- (it can SET ROLE kasuwa_sweeper, D-L66), through every route a privilege
  -- can take (direct, PUBLIC, inherited).
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'DELETE stored_object' AS what
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.stored_object', 'DELETE')
     UNION ALL
     SELECT 'TRUNCATE stored_object'
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.stored_object', 'TRUNCATE')
     UNION ALL
     SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0040: kasuwa_app, or a role it can enter, can delete stored_object rows or bypass its row security: %', held;
  END IF;
END
$$;
