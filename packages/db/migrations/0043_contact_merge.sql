-- ---------------------------------------------------------------------------
-- 0043 - contact soft delete and the merge trail (T-0095, Agent 3; D-P12,
-- D-P27, D-P28, D-L65, D-L146, D-L151, D-L153).
--
-- In this one file:
--
--   1. lock_timeout, then the locks, in a fixed order;
--   2. `contact.deleted_at timestamptz NULL`: no default, so every existing row
--      reads NULL without a rewrite (catalogue-only);
--   3. the `contact_merge` table, its keys, checks, indexes, RLS and grants;
--   4. the database half of D-P27's "hidden from every write": a merged-away
--      contact is frozen, and no activity or deal may point at one;
--   5. audit_event_action_check gains `merged` and `restored`, NOT VALID (a
--      strict superset, as 0030 did for `published`);
--   6. a self-check of the security posture.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- NOT HERE, deliberately:
--   - the 30-day hard delete and the snapshot purge (D-P27 says "the sweeper
--     role", but db invariant 8 confines kasuwa_sweeper to the auth tables).
--     A follow-up with its own identity ruling must ship before the first
--     populated cell (D-L65, D-L146);
--   - a DATABASE READ layer hiding merged-away rows. Every form of it needs a
--     new `app.*` setting (so undo can still reach the row it restores) or a
--     third SECURITY DEFINER function (CLAUDE.md 2.7). Both are escalations,
--     not implementation details, so the read hiding is the repositories'
--     predicate (`deleted_at IS NULL` on every contact read) until the lead
--     rules. The write layer (step 4) needs neither and is here;
--   - no index on `contact` (D-P33): the duplicates scan is a scoped scan;
--   - no role, no extension, no SECURITY DEFINER, no new `app.*` setting, no
--     VALIDATE CONSTRAINT.
--
-- ---------------------------------------------------------------------------
-- COLUMNS (contact_merge)
-- ---------------------------------------------------------------------------
--   id, tenant_id, programme_id   the tenancy keys
--   survivor_id, merged_id        the two contacts, both in programme_id (KEYS)
--   merged_by_user_id             the session user who merged (M1). The undo
--                                 right rests on it, so a RESTRICTIVE INSERT
--                                 policy pins it to app.current_user_id()
--   created_at                    `mergedAt` on the wire
--   undo_until                    created_at + exactly 720 hours (30 days, in
--                                 hours so the sum never depends on a session
--                                 TimeZone); CHECKed
--   undone_at, undone_by_user_id, survivor_reverted
--                                 NULL together until an undo sets all three
--   snapshot jsonb NOT NULL       the merged-away row as it was, the
--                                 survivor's prior values and its version
--                                 after the merge, and the ids of the moved
--                                 activities and deals. PII: served by no
--                                 operation, never logged, never audited.
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3; the 0027 pattern)
-- ---------------------------------------------------------------------------
-- Referential checks ignore row security, so every FK carries tenant_id:
--   - (tenant_id, programme_id, survivor_id) and (tenant_id, programme_id,
--     merged_id) -> contact (tenant_id, programme_id, id): both contacts are in
--     the merge's own programme. A supervisor who sees A1 and A2 is stopped
--     by the key, not by RLS. RESTRICT, both ways (0027's reason).
--   - (tenant_id, programme_id) -> programme and (tenant_id) -> tenant:
--     ON DELETE CASCADE (offboarding). RESTRICT does not block it: the RI
--     machinery runs the queued RESTRICT checks after the cascades.
--   - (tenant_id, merged_by_user_id) and (tenant_id, undone_by_user_id) ->
--     "user": a user in another tenant fails exactly as an invented id.
--   - CHECK survivor_id <> merged_id.
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   - RLS ENABLED and FORCED; contact_merge_isolation FOR ALL on tenant AND
--     programme, WITH CHECK identical to USING; in TENANT_SCOPED_TABLES.
--   - RESTRICTIVE INSERT: merged_by_user_id = app.current_user_id(), as
--     audit_event_actor_is_session does for the audit actor (0008). A merge
--     row in another user's name would hand that user the undo right.
--   - RESTRICTIVE INSERT also pins created_at = now() and undone_at IS NULL:
--     with the window CHECK, a merge row (and its PII snapshot) cannot be
--     back- or forward-dated to stretch the undo window.
--   - RESTRICTIVE UPDATE: USING (undone_at IS NULL AND undo_until > now()),
--     WITH CHECK (undone_by_user_id = app.current_user_id() AND undone_at =
--     now()). An undo is recorded once, inside the window, now, in the session
--     user's own name, and never cleared.
--   - GRANTS (M2): kasuwa_app SELECT and INSERT; UPDATE on undone_at,
--     undone_by_user_id and survivor_reverted ONLY. The identity of a merge,
--     its window and its snapshot are immutable for the application: an app
--     bug cannot extend a window, re-point a merge or rewrite what undo will
--     restore. No DELETE and no TRUNCATE (TRUNCATE skips RLS) for kasuwa_app
--     or any role it can enter; the self-check asserts it.
--
-- ---------------------------------------------------------------------------
-- THE WRITE LAYER (D-P27; step 4)
-- ---------------------------------------------------------------------------
--   - contact_merged_away_frozen: a BEFORE UPDATE row trigger on contact,
--     only when the row is merged away before AND after the statement. It
--     refuses the change (42501) unless the ONLY change is clearing the owner
--     (0031/0033's unassignment of a removed member reaches every contact of
--     the member, merged-away ones included, and must not fail). Undo is not
--     caught: it sets deleted_at back to NULL. kasuwa_migrator may still
--     correct a row (the 0027 allow-list).
--   - activity_contact_not_merged_away and deal_contact_not_merged_away:
--     BEFORE INSERT or UPDATE of the contact column; the contact is locked
--     FOR SHARE and then judged, so a child written during a merge waits for
--     it; a merged-away contact is refused (23503) exactly as an absent one
--     would be by the FK. The API
--     answers both with the invented id's body before they could fire; these
--     bind every other path.
--   The functions read only `contact`, under the invoker's own RLS (a child
--   and its contact share a programme by the composite keys): SECURITY
--   INVOKER, pinned search_path, EXECUTE revoked. Not definers: the census
--   stays at two.
--
-- ---------------------------------------------------------------------------
-- LOCKS (D-L65)
-- ---------------------------------------------------------------------------
-- No populated cell exists. contact is held ACCESS EXCLUSIVE for a
-- catalogue-only ADD COLUMN and a trigger; activity and deal SHARE ROW
-- EXCLUSIVE for their triggers; audit_event ACCESS EXCLUSIVE for a NOT VALID
-- CHECK swap (no scan). lock_timeout makes the file fail fast rather than
-- queue behind a long transaction.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks ----------------------------------------------------------------------
LOCK TABLE tenant, programme, "user" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE contact IN ACCESS EXCLUSIVE MODE;
LOCK TABLE activity, deal IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE audit_event IN ACCESS EXCLUSIVE MODE;

-- --- 2. contact.deleted_at ------------------------------------------------------------
ALTER TABLE contact ADD COLUMN deleted_at timestamptz;

-- --- 3. contact_merge ----------------------------------------------------------------
CREATE TABLE contact_merge (
  id                 uuid         PRIMARY KEY,
  tenant_id          uuid         NOT NULL,
  programme_id       uuid         NOT NULL,
  survivor_id        uuid         NOT NULL,
  merged_id          uuid         NOT NULL,
  merged_by_user_id  uuid         NOT NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  undo_until         timestamptz  NOT NULL,
  undone_at          timestamptz,
  undone_by_user_id  uuid,
  survivor_reverted  boolean,
  snapshot           jsonb        NOT NULL,

  CONSTRAINT contact_merge_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT contact_merge_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT contact_merge_survivor_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, survivor_id)
    REFERENCES contact (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT contact_merge_merged_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, merged_id)
    REFERENCES contact (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT contact_merge_merged_by_same_tenant_fk
    FOREIGN KEY (tenant_id, merged_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT contact_merge_undone_by_same_tenant_fk
    FOREIGN KEY (tenant_id, undone_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  CONSTRAINT contact_merge_distinct_check CHECK (survivor_id <> merged_id),
  CONSTRAINT contact_merge_window_check CHECK (undo_until = created_at + interval '720 hours'),
  CONSTRAINT contact_merge_undo_shape_check
    CHECK ((undone_at IS NULL) = (undone_by_user_id IS NULL)
           AND (undone_at IS NULL) = (survivor_reverted IS NULL)),
  CONSTRAINT contact_merge_snapshot_check CHECK (pg_catalog.jsonb_typeof(snapshot) = 'object')
);

-- The history, newest first per programme (listContactMerges reads the
-- programmes where the caller may write contacts), and the two lookups by
-- contact (already merged? merged away since?), which also serve the RESTRICT
-- checks of the contact FKs. None is a prefix of another.
CREATE INDEX contact_merge_recent_idx
  ON contact_merge (tenant_id, programme_id, created_at DESC, id DESC);
CREATE INDEX contact_merge_merged_idx
  ON contact_merge (tenant_id, programme_id, merged_id);
CREATE INDEX contact_merge_survivor_idx
  ON contact_merge (tenant_id, programme_id, survivor_id);

ALTER TABLE contact_merge ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_merge FORCE ROW LEVEL SECURITY;

CREATE POLICY contact_merge_isolation ON contact_merge FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

CREATE POLICY contact_merge_merger_is_session ON contact_merge
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (merged_by_user_id = app.current_user_id()
              AND created_at = now()
              AND undone_at IS NULL);

CREATE POLICY contact_merge_undo_once_as_session ON contact_merge
  AS RESTRICTIVE
  FOR UPDATE
  USING (undone_at IS NULL AND undo_until > now())
  WITH CHECK (undone_by_user_id = app.current_user_id() AND undone_at = now());

REVOKE ALL ON contact_merge
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT ON contact_merge TO kasuwa_app;
GRANT UPDATE (undone_at, undone_by_user_id, survivor_reverted) ON contact_merge TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_merge TO kasuwa_test_admin;

-- --- 4. the write layer -----------------------------------------------------------------
CREATE FUNCTION app.guard_contact_merged_away() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  -- Moved by every UPDATE (version, updated_at) or the one permitted change
  -- (owner_user_id), plus every STORED GENERATED column, read from the
  -- catalogue each time: those are not yet computed in a BEFORE trigger, and
  -- a column added by a later migration must not freeze the owner clearing.
  exempt_cols text[];
BEGIN
  IF current_user = 'kasuwa_migrator' AND session_user = 'kasuwa_migrator' THEN
    RETURN NEW;
  END IF;
  SELECT ARRAY['owner_user_id', 'version', 'updated_at']
         || coalesce(pg_catalog.array_agg(a.attname::text), ARRAY[]::text[])
    INTO exempt_cols
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = TG_RELID AND a.attgenerated = 's' AND NOT a.attisdropped;
  IF NEW.owner_user_id IS NULL
     AND (pg_catalog.to_jsonb(NEW) - exempt_cols) = (pg_catalog.to_jsonb(OLD) - exempt_cols) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a merged-away contact cannot be changed'
    USING ERRCODE = 'insufficient_privilege';  -- 42501
END;
$$;
REVOKE ALL ON FUNCTION app.guard_contact_merged_away()
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;

CREATE TRIGGER contact_merged_away_frozen
  BEFORE UPDATE ON contact FOR EACH ROW
  WHEN (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION app.guard_contact_merged_away();

-- TG_ARGV[0] names the child's contact column (a constant in each CREATE TRIGGER).
CREATE FUNCTION app.guard_child_of_merged_away_contact() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  target uuid := (pg_catalog.to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  merged_at timestamptz;
BEGIN
  IF target IS NULL THEN
    RETURN NEW;
  END IF;
  -- FOR SHARE: a merge holds the contact FOR UPDATE until it commits, so a
  -- child written during a merge waits here, then judges the merged row (it
  -- cannot slip in pointing at a contact the merge is taking away).
  SELECT c.deleted_at
    INTO merged_at
    FROM public.contact c
   WHERE c.tenant_id = NEW.tenant_id
     AND c.programme_id = NEW.programme_id
     AND c.id = target
     FOR SHARE;
  IF merged_at IS NOT NULL THEN
    RAISE EXCEPTION 'a record cannot point at a merged-away contact'
      USING ERRCODE = 'foreign_key_violation';  -- 23503, as the FK for an absent one
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_child_of_merged_away_contact()
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;

CREATE TRIGGER activity_contact_not_merged_away
  BEFORE INSERT OR UPDATE OF contact_id ON activity FOR EACH ROW
  WHEN (NEW.contact_id IS NOT NULL)
  EXECUTE FUNCTION app.guard_child_of_merged_away_contact('contact_id');

CREATE TRIGGER deal_contact_not_merged_away
  BEFORE INSERT OR UPDATE OF primary_contact_id ON deal FOR EACH ROW
  WHEN (NEW.primary_contact_id IS NOT NULL)
  EXECUTE FUNCTION app.guard_child_of_merged_away_contact('primary_contact_id');

-- --- 5. audit actions ------------------------------------------------------------------
-- Exactly 0030's list plus `merged` and `restored`. NOT VALID: a strict
-- superset admits every existing row, so no scan is needed (D-L65).
ALTER TABLE audit_event
  DROP CONSTRAINT audit_event_action_check,
  ADD CONSTRAINT audit_event_action_check CHECK (action IN (
    'created', 'updated', 'deleted', 'exported', 'invited', 'viewed',
    'failed_sign_in', 'rejected', 'rotated', 'played_recording', 'published',
    'merged', 'restored'
  )) NOT VALID;

-- --- 6. self-check -----------------------------------------------------------------------
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  held text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c WHERE c.oid = 'public.contact_merge'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '0043: contact_merge RLS is not enabled and forced';
  END IF;
  IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c
                                  WHERE c.oid = 'public.contact_merge'::pg_catalog.regclass))
     <> 'kasuwa_migrator' THEN
    RAISE EXCEPTION '0043: contact_merge is not owned by kasuwa_migrator';
  END IF;
  IF NOT (pg_catalog.has_table_privilege(app_role, 'public.contact_merge', 'SELECT')
          AND pg_catalog.has_table_privilege(app_role, 'public.contact_merge', 'INSERT')
          AND pg_catalog.has_column_privilege(app_role, 'public.contact_merge', 'undone_at', 'UPDATE')
          AND pg_catalog.has_column_privilege(app_role, 'public.contact', 'deleted_at', 'UPDATE')) THEN
    RAISE EXCEPTION '0043: kasuwa_app cannot merge, soft-delete and undo';
  END IF;
  -- Only the undo columns are writable (has_column_privilege also sees a
  -- table-level grant, so this fails if one is ever added back).
  SELECT pg_catalog.string_agg(c.col, ', ' ORDER BY c.col)
    INTO held
    FROM pg_catalog.unnest(ARRAY['id', 'tenant_id', 'programme_id', 'survivor_id', 'merged_id',
                                 'merged_by_user_id', 'created_at', 'undo_until',
                                 'snapshot']) AS c(col)
   WHERE pg_catalog.has_column_privilege(app_role, 'public.contact_merge', c.col, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0043: kasuwa_app may UPDATE contact_merge column(s) it must not: %', held;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                  WHERE p.polrelid = 'public.contact_merge'::pg_catalog.regclass
                    AND p.polname = 'contact_merge_merger_is_session'
                    AND NOT p.polpermissive AND p.polcmd = 'a') THEN
    RAISE EXCEPTION '0043: the restrictive INSERT policy on contact_merge is missing or not restrictive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                  WHERE p.polrelid = 'public.contact_merge'::pg_catalog.regclass
                    AND p.polname = 'contact_merge_undo_once_as_session'
                    AND NOT p.polpermissive AND p.polcmd = 'w') THEN
    RAISE EXCEPTION '0043: the restrictive UPDATE policy on contact_merge is missing or not restrictive';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                  WHERE p.polrelid = 'public.contact_merge'::pg_catalog.regclass
                    AND p.polname = 'contact_merge_isolation'
                    AND p.polpermissive AND p.polcmd = '*'
                    AND pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                      = pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)) THEN
    RAISE EXCEPTION '0043: contact_merge_isolation is missing, or its WITH CHECK differs from its USING';
  END IF;
  SELECT pg_catalog.string_agg(x.name, ', ' ORDER BY x.name)
    INTO held
    FROM (VALUES ('public.contact', 'contact_merged_away_frozen'),
                 ('public.activity', 'activity_contact_not_merged_away'),
                 ('public.deal', 'deal_contact_not_merged_away')) AS x(rel, name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                      WHERE t.tgrelid = x.rel::pg_catalog.regclass
                        AND t.tgname = x.name AND NOT t.tgisinternal AND t.tgenabled = 'O');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0043: write-layer trigger(s) missing or not enabled: %', held;
  END IF;
  -- DELETE, TRUNCATE and BYPASSRLS for kasuwa_app and every role it can enter.
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'DELETE contact_merge' AS what
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.contact_merge', 'DELETE')
     UNION ALL
     SELECT 'TRUNCATE contact_merge'
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.contact_merge', 'TRUNCATE')
     UNION ALL
     SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0043: kasuwa_app, or a role it can enter, can erase or bypass the merge trail: %', held;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')) <> 2 THEN
    RAISE EXCEPTION '0043: the definer-function census is not two (CLAUDE.md 2.7)';
  END IF;
END
$$;
