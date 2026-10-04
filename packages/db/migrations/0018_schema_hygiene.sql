-- ---------------------------------------------------------------------------
-- 0018 - schema hygiene: drop redundant indexes, maintain updated_at (T-0011).
--
-- Two repo-wide habits found by migration-reviewer on T-0002, corrected once.
-- No RLS policy changes; no table gains or loses a column.
--
-- 1. REDUNDANT INDEXES.
--
--    Each index dropped below is a plain btree whose key list is a strict
--    leading prefix of another btree on the same table, with no INCLUDE
--    columns, no predicate and no expression. The planner can answer every
--    lookup it serves from the longer index, so it is pure write cost.
--
--      business_unit_tenant_idx    (tenant_id)            UNIQUE (tenant_id, id)
--      programme_tenant_idx        (tenant_id)            UNIQUE (tenant_id, id),
--                                                         programme_tenant_status_idx
--      user_tenant_idx             (tenant_id)            UNIQUE (tenant_id, id),
--                                                         user_tenant_role_idx
--      user_credential_tenant_idx  (tenant_id)            UNIQUE (tenant_id, user_id)
--      object_def_tenant_idx       (tenant_id)            UNIQUE (tenant_id, id)
--      field_def_tenant_object_idx (tenant_id, object_id) UNIQUE (tenant_id, object_id, api_name)
--
--    Checked with EXPLAIN ANALYZE on the repositories' real queries over a
--    1,000-tenant volume (120k field_def rows), before and after the drop in a
--    rolled-back transaction: every plan keeps its shape and cost, the planner
--    simply names the covering index. listFieldDefs and loadFields get
--    cheaper - the unique index returns rows already in api_name order, so the
--    Sort node disappears. The evidence is in the T-0011 PR.
--
--    contact_keyset_idx is NOT touched: (tenant_id, programme_id, created_at
--    DESC, id DESC) serves keyset pagination and no other index covers it.
--
--    Plain DROP INDEX, not CONCURRENTLY: the runner wraps each file in a
--    transaction, which CONCURRENTLY refuses. The ACCESS EXCLUSIVE lock is
--    held only for the catalogue change, and lock_timeout bounds the wait.
--
-- 2. updated_at IS MAINTAINED BY THE SCHEMA.
--
--    Until now every table defaulted updated_at to now() on INSERT and nothing
--    ever moved it again unless a repository remembered to. A stale timestamp
--    that looks maintained is worse than none: it gets used for sync cursors
--    and "what changed since" queries, and it is believed.
--
--    app.touch_updated_at() is one BEFORE UPDATE trigger function, attached
--    to every table carrying updated_at. It sets updated_at := now() ONLY when
--    the statement left the column unchanged (the WHEN clause on each
--    trigger). A statement that writes its own updated_at keeps it. That is
--    load-bearing, not a nicety: the programme repository derives its version
--    from updated_at and writes a strictly increasing value itself
--    (programme-version.ts NEXT_UPDATED_AT_SQL), because now() is fixed for
--    the whole transaction. An always-now() trigger would freeze the version
--    across two updates in one transaction and break its optimistic
--    concurrency guard.
--
--    Known consequence: an UPDATE that deliberately re-assigns updated_at its
--    OLD value is indistinguishable from one that never mentioned it, and is
--    bumped. The one such statement today is the repeat-delete branch of
--    deleteDispositionWithPrevious, on a row that is already soft-deleted and
--    no longer listed anywhere.
--
--    The function is NOT SECURITY DEFINER (CLAUDE.md 2.7): it runs as the
--    caller, reads no table, and only assigns to NEW, which needs no
--    privilege - so it behaves identically for kasuwa_app under FORCE RLS and
--    for kasuwa_migrator. search_path is pinned anyway, so now() can never
--    resolve to a shadowing function. Firing a trigger needs no EXECUTE
--    grant, so EXECUTE is revoked from PUBLIC.
--
--    A future table with updated_at must attach the trigger in its own
--    migration. tests/acceptance/tenancy/schema-hygiene.acceptance.test.ts
--    reads the catalogue, not this file, and fails for a table that forgets.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. updated_at ----------------------------------------------------------

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.touch_updated_at() FROM PUBLIC;

CREATE TRIGGER tenant_touch_updated_at
  BEFORE UPDATE ON tenant FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER business_unit_touch_updated_at
  BEFORE UPDATE ON business_unit FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER programme_touch_updated_at
  BEFORE UPDATE ON programme FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER user_touch_updated_at
  BEFORE UPDATE ON "user" FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER contact_touch_updated_at
  BEFORE UPDATE ON contact FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER user_credential_touch_updated_at
  BEFORE UPDATE ON user_credential FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER user_mfa_factor_touch_updated_at
  BEFORE UPDATE ON user_mfa_factor FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER object_def_touch_updated_at
  BEFORE UPDATE ON object_def FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER field_def_touch_updated_at
  BEFORE UPDATE ON field_def FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER role_touch_updated_at
  BEFORE UPDATE ON role FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER permission_set_touch_updated_at
  BEFORE UPDATE ON permission_set FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER field_security_grant_touch_updated_at
  BEFORE UPDATE ON field_security_grant FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER disposition_touch_updated_at
  BEFORE UPDATE ON disposition FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER programme_sla_touch_updated_at
  BEFORE UPDATE ON programme_sla FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER programme_retention_touch_updated_at
  BEFORE UPDATE ON programme_retention FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER portal_user_touch_updated_at
  BEFORE UPDATE ON portal_user FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

-- Self-check: every table carrying updated_at has the trigger. Fails the
-- migration rather than shipping a half-applied policy.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger t
        WHERE t.tgrelid = c.oid
          AND t.tgfoid = 'app.touch_updated_at()'::regprocedure
          AND NOT t.tgisinternal);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0018: updated_at is not maintained on: %', missing;
  END IF;
END
$$;

-- --- 2. redundant indexes ---------------------------------------------------
-- Last on purpose (migration-reviewer, T-0011): DROP INDEX takes ACCESS
-- EXCLUSIVE on the table and holds it until COMMIT. Done first, those locks
-- would be held on "user" and programme - blocking sign-in reads - while the
-- transaction queued for sixteen trigger locks above. Here they are held only
-- for the final catalogue change.

DROP INDEX business_unit_tenant_idx;
DROP INDEX programme_tenant_idx;
DROP INDEX user_tenant_idx;
DROP INDEX user_credential_tenant_idx;
DROP INDEX object_def_tenant_idx;
DROP INDEX field_def_tenant_object_idx;
