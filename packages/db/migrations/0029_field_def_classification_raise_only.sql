-- ---------------------------------------------------------------------------
-- 0029 - a standard field's classification may be raised, never lowered
-- (T-0102, Agent 2; D-P25, D-L89, D-L65).
--
-- D-P25 (answered): a tenant may RAISE a standard field's classification
-- (`contact.phones` from `pii` to `sensitive`), never LOWER it (`pii` to
-- `none`). Classification drives redaction, export and DSAR handling (NDPA);
-- declassifying a phone number would switch those protections off. Custom
-- fields stay freely classifiable. Before this file, 0025's header called
-- classification "editable (D-P4)", but D-P4 covers labels only, and any role
-- that can write field_def could lower it.
--
-- In this one file:
--   1. the catalogue lock;
--   2. app.guard_field_def_classification_raise_only() and its trigger;
--   3. a self-check that the guard is in place, that it is what this header
--      says, and that the scale it ranks is exactly the CHECK's values.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
-- No data changes, no new tables, no new policies, no grants.
--
-- ---------------------------------------------------------------------------
-- THE RULE (D-L89)
-- ---------------------------------------------------------------------------
--   - An UPDATE of a field_def row whose OLD row is standard (`is_custom =
--     false`) and whose new classification ranks BELOW the old one is
--     refused. Judged on OLD.is_custom, so a statement that also flips
--     is_custom cannot dodge it (0025 refuses every flip in any case).
--   - THE SCALE is ranked explicitly, weakest first: none < pii < sensitive,
--     the same `classification_rank` 0025 to 0028 use, and exactly the values
--     field_def_classification_check (0009) admits. The values happen to sort
--     alphabetically in rank order, so a text comparison would pass every
--     test today; it is not used, because the next value will not be so
--     obliging. Step 3 stops this file if the CHECK admits a value the scale
--     does not place, and the T-0102 suite asserts the same on every build.
--     A migration that adds a value to the CHECK must rank it here, by
--     replacing this function in the same file.
--   - AN UNRANKED VALUE FAILS CLOSED. If either side of a change to a
--     standard row is not on the scale (only possible if the CHECK and the
--     scale have drifted apart), the change is refused with the same
--     SQLSTATE and constraint: the guard cannot prove it is not a lowering.
--     A value the CHECK refuses never reaches the guard (below).
--   - Raising succeeds. Setting the same value is not a change: the WHEN
--     clause skips the function and the UPDATE succeeds, including a
--     whole-table `SET classification = classification`.
--   - NO ROLE IS EXEMPT: kasuwa_app, kasuwa_migrator and kasuwa_test_admin
--     alike (D-L89; the T-0102 suite checks that these are the only roles
--     that can UPDATE the column). Superusers are outside the model. A FUTURE
--     MIGRATION THAT MUST LOWER ONE says so explicitly, as the table's owner
--     (kasuwa_migrator), in one file and so one transaction:
--         ALTER TABLE field_def DISABLE TRIGGER field_def_classification_raise_only;
--         UPDATE field_def SET classification = ... WHERE ...;
--         ALTER TABLE field_def ENABLE TRIGGER field_def_classification_raise_only;
--     with its reason in its header. ALTER TABLE ... TRIGGER takes SHARE ROW
--     EXCLUSIVE until COMMIT, so no other session writes field_def while the
--     guard is off. kasuwa_app owns nothing and cannot do this (42501, pinned
--     by the T-0102 suite), nor set session_replication_role.
--   - THE REFUSAL is SQLSTATE 23514 (check_violation) with CONSTRAINT =
--     'field_def_classification_raise_only', as 0026's `account_hierarchy`.
--     23001 and 42501 already mean other refusals on field_def (0025's guards),
--     and the CHECK's own 23514 is told apart by its constraint name. The
--     future admin write (T-0089) maps the pair to its 400; it never reads the
--     message. The message names the rule and the scale, never an id, an
--     api_name or a label (labels are tenant-editable, D-P4).
--   - ATOMIC: the refusal aborts the statement, so one lowering in a bulk
--     UPDATE (or in the DO UPDATE arm of an upsert, or a MERGE) changes
--     nothing, raises and custom rows included.
--   - RLS is untouched. A row the session cannot see is never updated, so the
--     trigger never fires for it: a lowering aimed at another tenant's row
--     matches nothing, exactly like an id that does not exist. No oracle.
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE TRIGGER, AND WHY AFTER (the builder's choice, D-L89)
-- ---------------------------------------------------------------------------
-- The task's wording is "extend the T-0053 freeze trigger"; the suite leaves
-- the choice to the builder. This file adds a trigger BESIDE 0025's
-- `field_def_standard_fixed` rather than replacing it, because:
--   - extending would mean CREATE OR REPLACE of app.guard_standard_field_def()
--     and a DROP and re-CREATE of its trigger to widen the WHEN clause. 0025
--     would then no longer describe what runs, and a reader of either file
--     would have to know about the other;
--   - the rules differ in kind. 0025's function mixes every-role rules (23001)
--     with kasuwa_app-only rules (42501). This one binds every role, has its
--     own SQLSTATE and constraint, and its own way out (DISABLE TRIGGER by
--     name, above), which would otherwise switch 0025's guards off with it;
--   - its WHEN clause stays exact: the function runs only when a standard
--     row's classification actually changes. Label edits, custom fields and
--     equal values never run it.
-- It is an AFTER ROW trigger, not BEFORE, so it judges the row as it will be
-- stored:
--   - BEFORE triggers fire in name order and each may rewrite NEW; a BEFORE
--     guard is only as good as the triggers that sort after it. An AFTER
--     trigger sees the final row, whatever any BEFORE trigger does, today or
--     later;
--   - the CHECK runs before AFTER triggers, so an unknown value is always the
--     CHECK's 23514 (field_def_classification_check), never reported as a
--     lowering;
--   - the WHEN clause is evaluated when the row is updated, so a non-matching
--     row queues no event. field_def is a small catalogue (dozens of rows per
--     tenant), so the queue for a bulk statement is small too.
-- A statement that lowers AND flips is_custom is refused by 0025's BEFORE
-- trigger first (23001); either refusal leaves the row unchanged.
--
-- NO SECURITY DEFINER (CLAUDE.md 2.7): the function runs as the invoker,
-- reads no table, only compares and raises; search_path is pinned to
-- pg_catalog. EXECUTE is revoked from PUBLIC (firing a trigger needs none).
-- The census stays at two. No new tables: TENANT_SCOPED_TABLES is unchanged,
-- and field_def keeps RLS ENABLED and FORCED with its 0002/0025 policies.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
--   - field_def: SHARE ROW EXCLUSIVE, taken first and held until COMMIT. It is
--     what CREATE TRIGGER takes anyway. It blocks writes to field_def (a label
--     edit, a custom field created), not reads, so field security keeps
--     answering. Nothing in this file reads or rewrites a field_def row: the
--     self-check reads the system catalogue only. So the lock is held for
--     milliseconds at any size, and no NOT VALID / VALIDATE or CONCURRENTLY
--     step applies. field_def is not a hot table (D-L65) in any case.
--   - object_def, contact and the rest are not touched.
--   - lock_timeout = 5s: the file fails fast instead of queueing behind a long
--     transaction (and making everything behind it queue too).
-- Steady-state cost: one WHEN evaluation per field_def row updated; the
-- function runs only when a standard row's classification changes.
--
-- ---------------------------------------------------------------------------
-- REVERSIBILITY AND ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- No data is changed, so undoing this file loses nothing. If it fails, nothing
-- was applied (one transaction; the runner records it only on COMMIT): fix the
-- cause and run `pnpm db:migrate` again. To undo it after it has applied, never
-- edit or delete this file or its ledger row (append-only); instead, in a NEW
-- migration, as kasuwa_migrator:
--     DROP TRIGGER field_def_classification_raise_only ON field_def;
--     DROP FUNCTION app.guard_field_def_classification_raise_only();
-- That reopens D-P25, so it needs the decision reversed first; the T-0102
-- suite would go red, as it should.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. the catalogue lock ----------------------------------------------------
LOCK TABLE field_def IN SHARE ROW EXCLUSIVE MODE;

-- --- 2. the guard ---------------------------------------------------------------
-- Messages name the rule and the scale, never a value of the row.
CREATE FUNCTION app.guard_field_def_classification_raise_only() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  -- field_def_classification_check's values, weakest first. Ranked explicitly:
  -- never compare classifications as text.
  scale constant text[] := ARRAY['none', 'pii', 'sensitive'];
  old_rank integer;
  new_rank integer;
BEGIN
  old_rank := pg_catalog.array_position(scale, OLD.classification);
  new_rank := pg_catalog.array_position(scale, NEW.classification);

  IF old_rank IS NULL OR new_rank IS NULL THEN
    RAISE EXCEPTION 'field_def.classification of a standard field is outside the ranked scale (none < pii < sensitive), so the change cannot be shown not to lower it'
      USING ERRCODE = 'check_violation',  -- 23514
            CONSTRAINT = 'field_def_classification_raise_only',
            HINT = 'A migration that adds a classification value must rank it in app.guard_field_def_classification_raise_only().';
  END IF;

  IF new_rank < old_rank THEN
    RAISE EXCEPTION 'field_def.classification of a standard field can be raised, never lowered (none < pii < sensitive)'
      USING ERRCODE = 'check_violation',  -- 23514
            CONSTRAINT = 'field_def_classification_raise_only',
            HINT = 'Keep the classification or raise it. Custom fields can be classified freely.';
  END IF;

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;

-- Only the trigger below calls it; firing a trigger needs no EXECUTE.
REVOKE ALL ON FUNCTION app.guard_field_def_classification_raise_only() FROM PUBLIC;

-- Judged on the OLD row: a standard field stays raise-only even in a statement
-- that also sets is_custom. Equal values skip the function entirely.
CREATE TRIGGER field_def_classification_raise_only
  AFTER UPDATE ON field_def
  FOR EACH ROW
  WHEN (NOT OLD.is_custom AND OLD.classification IS DISTINCT FROM NEW.classification)
  EXECUTE FUNCTION app.guard_field_def_classification_raise_only();

-- --- 3. prove the guard ---------------------------------------------------------
-- Runs once, here. The standing guard is the T-0102 acceptance suite, which
-- runs on every build.
DO $$
DECLARE
  scale constant text[] := ARRAY['none', 'pii', 'sensitive'];
  guard constant pg_catalog.regprocedure :=
    'app.guard_field_def_classification_raise_only()'::pg_catalog.regprocedure;
  admitted text[];
  holders text;
BEGIN
  -- The trigger: present, enabled for ordinary sessions ('O'), a ROW trigger
  -- on UPDATE only and AFTER (tgtype = ROW 1 + UPDATE 16; no BEFORE bit 2),
  -- calling this function.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.field_def'::pg_catalog.regclass
         AND t.tgname = 'field_def_classification_raise_only'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgtype = 17
         AND t.tgfoid = guard) <> 1 THEN
    RAISE EXCEPTION '0029: the trigger field_def_classification_raise_only is missing, disabled, or not AFTER UPDATE FOR EACH ROW';
  END IF;

  -- The function: invoker's rights, search_path pinned (CLAUDE.md 2.7).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid = guard
                AND (p.prosecdef
                     OR p.proconfig IS NULL
                     OR NOT ('search_path=pg_catalog' = ANY (p.proconfig)))) THEN
    RAISE EXCEPTION '0029: the guard function is SECURITY DEFINER or has no pinned search_path';
  END IF;

  -- No serving role can call it directly.
  SELECT pg_catalog.string_agg(r.rolname, ', ' ORDER BY r.rolname)
    INTO holders
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('kasuwa_app', 'kasuwa_auth', 'kasuwa_sweeper', 'kasuwa_test_admin')
     AND pg_catalog.has_function_privilege(r.oid, guard, 'EXECUTE');
  IF holders IS NOT NULL THEN
    RAISE EXCEPTION '0029: roles can EXECUTE the guard function directly: %', holders;
  END IF;

  -- The scale ranks exactly the values the CHECK admits: a value on one and
  -- not the other means someone added it without deciding where it ranks.
  SELECT pg_catalog.array_agg(DISTINCT m[1])
    INTO admitted
    FROM pg_catalog.pg_constraint c
   CROSS JOIN LATERAL pg_catalog.regexp_matches(
           pg_catalog.pg_get_constraintdef(c.oid), '''([^'']*)''', 'g') AS m
   WHERE c.conrelid = 'public.field_def'::pg_catalog.regclass
     AND c.conname = 'field_def_classification_check';
  IF admitted IS NULL OR NOT (admitted @> scale AND admitted <@ scale) THEN
    RAISE EXCEPTION '0029: field_def_classification_check admits % but the raise-only scale ranks %',
      coalesce(admitted::text, 'nothing'), scale::text;
  END IF;
END
$$;
