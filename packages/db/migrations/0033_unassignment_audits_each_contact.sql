-- ---------------------------------------------------------------------------
-- 0033 - a programme removal audits each contact it unassigns
-- (T-0104, Agent 3; D-L101 as amended, D-L71, D-L106).
--
-- 0031 made removing a user from a programme unassign their contacts there,
-- and audited the removal with ONE programme event carrying the count. A
-- mistaken removal could then be undone only by point-in-time restore: the
-- log said how many contacts lost their owner, not which. D-L101 (amended
-- 2026-10-08) moves the fix here: besides the programme event, EACH contact
-- the removal unassigns gets its own audit event, so the removal can be
-- reversed from the audit log and each contact's timeline shows the owner
-- change (by name only, as every owner change on the timeline, D-L72).
--
-- In this one file:
--   1. CREATE OR REPLACE of app.unassign_removed_member_contacts(), 0031's
--      trigger function. Its steps (a) to (e) are 0031's, unchanged, and so
--      are the triggers that call it (a replaced function keeps its oid, so
--      both of 0031's triggers call the new body with no DDL on
--      user_programme). Only step (f) changes;
--   2. a self-check that the function and its triggers are what this header
--      says.
-- One transaction: a failure anywhere leaves 0031's function in place and no
-- ledger row. No new table, index, policy, trigger or grant; no data changes.
--
-- ---------------------------------------------------------------------------
-- THE PER-CONTACT EVENT (D-L101 amended, D-L106)
-- ---------------------------------------------------------------------------
-- One row per contact the removal unassigned, and for no other contact:
--   - action 'updated', object_type 'contact', object_id the contact, and
--     object_label the contact's id as text: the contact writer's label
--     (D-L63), never a name;
--   - programme_id the CONTACT's programme (which is the ended membership's:
--     0031 unassigns only in the member's own programme), so only its
--     members read it;
--   - the actor exactly as on the programme event: the session user, the
--     remover, with their role name; actor_kind 'system' when the session has
--     no user (the migrator, P3);
--   - changes EXACTLY [{ field 'ownerUserId', before the removed user's id
--     (uuid::text, canonical lower case, as the contact API records an owner
--     change since T-0104), after null, redacted false }]. A staff id is not
--     customer PII (D-L71). No contact name, phone, email or user name.
-- The programme event is unchanged: one per ended membership, count
-- included, "0" included, and no contact id.
--
-- WRITTEN EXACTLY WHERE THE PROGRAMME EVENT IS, AND NOWHERE ELSE (D-L106).
-- Both kinds come from ONE INSERT ... SELECT in step (f), fed by the same
-- UPDATE's RETURNING, after steps (a) to (e). So:
--   - a refusal (a), an offboarding cascade (b), a non-READ COMMITTED
--     transaction (c) or a same-key rewrite (e) writes neither kind;
--   - a contact that was not unassigned by this statement gets no event;
--   - a ROLLBACK takes both kinds away with the unassignment;
--   - the migrator path (P3) writes both kinds exactly when it wrote the
--     programme event before.
-- Set-based: the whole removal is still one UPDATE and one INSERT, whatever
-- the number of memberships or contacts; no loop over contacts.
--
-- CONCURRENCY: unchanged from 0031. Every membership lock of the statement,
-- exclusive, in ascending key order, BEFORE any contact row is touched; the
-- added rows are written after the UPDATE, in the same statement, and take
-- no lock any assigner waits for (audit_event is append-only, and the new
-- rows are invisible to everyone else until COMMIT). The deadlock analysis
-- and the multi-statement caveat in 0031's header stand as written.
--
-- NO SECURITY DEFINER (CLAUDE.md 2.7): SECURITY INVOKER, search_path pinned
-- to pg_catalog, every table schema-qualified, EXECUTE revoked from PUBLIC,
-- the definer census still two; step 2 checks all of it. The new rows pass
-- the same RLS as the programme event: 0008's isolation policy (the
-- session's tenant) and its restrictive actor-is-session policy.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT AND COST (D-L65)
-- ---------------------------------------------------------------------------
--   - This file: CREATE OR REPLACE FUNCTION takes no table lock; it updates
--     the function's pg_proc row. A removal running concurrently finishes on
--     the old body (it has already planned it) or starts on the new one.
--     lock_timeout = 5s as in 0031.
--   - Steady state, per removal statement, ON TOP OF 0031's cost: one more
--     audit_event row PER UNASSIGNED CONTACT, in the same INSERT as the
--     programme events. Each row is about 300 bytes of heap plus an entry
--     in each of audit_event's six indexes (primary key, (tenant_id, id),
--     time, actor, object, programme) and three foreign-key checks (tenant,
--     actor, programme), so WAL and time grow linearly with the number of
--     contacts unassigned. Measured by the builder (T-0104), one DELETE of
--     one membership owning 100,000 contacts, on a local Testcontainers
--     Postgres 16 under Docker Desktop, three runs of each body in
--     alternation, each rolled back: 0031's body took 6.9 to 8.8 s and wrote
--     63 to 65 MB of WAL; this body took 11.7 to 14.0 s and wrote 161 to
--     308 MB of WAL (the high figure includes full-page images after a
--     checkpoint). So about 1.6 times 0031's time, and about 100 MB or more
--     of extra WAL, per 100,000 contacts unassigned. The absolute times are
--     this host's, slower than 0031's review host; the ratio is the figure
--     to carry. All of it inside the removing transaction, which holds those contact
--     row locks and the membership locks until COMMIT. That is acceptable
--     for an operator's DELETE. 0031's rule for a future membership-removal
--     API applies with this extra weight: it must cap the contacts one
--     request may unassign, or hand larger removals to an async job that
--     unassigns (and audits) in batches, before it ships.
--   - audit_event grows by one row per unassigned contact. Its retention is
--     audit retention; nothing here prunes it.
--   - A removal that unassigns nothing costs what it did in 0031.
--
-- ---------------------------------------------------------------------------
-- REVERSIBILITY AND ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- This file changes no data. If it fails, nothing was applied (one
-- transaction; the runner records it only on COMMIT) and 0031's function
-- stays in force: fix the cause and run `pnpm db:migrate` again. To undo it
-- after it has applied, never edit or delete this file or its ledger row
-- (append-only). Reversing it drops D-L101's recoverability, so the decision
-- must be reversed first, and the T-0104 former-owner suite would go red, as
-- it should. Then, as kasuwa_migrator, a NEW migration re-creates 0031's
-- function body verbatim with CREATE OR REPLACE (no trigger DDL needed).
-- Events already written stay: audit_event is append-only (0008).
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. the function -------------------------------------------------------------
-- Steps 0 and (a) to (e) are 0031's, verbatim. VOLATILE (the default) on
-- purpose: each query below must take a fresh snapshot after the locks are
-- granted. Messages name the rule, never a row's ids or names.
CREATE OR REPLACE FUNCTION app.unassign_removed_member_contacts() RETURNS trigger
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  -- ASCII 'KMEM': Kasuwa membership. Must equal MEMBERSHIP_LOCK_NAMESPACE in
  -- packages/domain/core/src/contact/contact.repository.ts.
  lock_namespace constant integer := 1263355213;
  actor uuid := app.current_user_id();
  sees_every_row boolean;
  -- The ended memberships, as three aligned arrays (NULL when there are none).
  t_ids uuid[];
  p_ids uuid[];
  u_ids uuid[];
  lock_key integer;
BEGIN
  -- 0. The memberships this statement ended. ended_rows is the OLD TABLE of
  --    both triggers; kept_rows, the NEW TABLE, exists on UPDATE only.
  --    (Multi-argument `unnest(a, b, ...)` below is FROM-clause syntax, not a
  --    pg_catalog function, so it cannot be schema-qualified; search_path is
  --    pg_catalog in any case.)
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

  -- a. The session must see every contact it is about to unassign. NULL-safe:
  --    no tenant or no scope is a refusal, not a pass.
  SELECT r.rolbypassrls OR r.rolsuper
    INTO sees_every_row
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user;
  IF sees_every_row IS NOT TRUE
     AND EXISTS (SELECT 1
                   FROM unnest(t_ids, p_ids) AS e(tenant_id, programme_id)
                  WHERE (e.tenant_id = app.current_tenant_id()
                         AND e.programme_id = ANY (app.current_programme_ids())) IS NOT TRUE) THEN
    RAISE EXCEPTION 'a membership can only be removed by a session that reaches its programme, so that its contacts can be unassigned'
      USING ERRCODE = 'insufficient_privilege';  -- 42501
  END IF;

  -- b. Offboarding: drop memberships that went with their tenant, programme or user.
  SELECT pg_catalog.array_agg(e.tenant_id), pg_catalog.array_agg(e.programme_id),
         pg_catalog.array_agg(e.user_id)
    INTO t_ids, p_ids, u_ids
    FROM unnest(t_ids, p_ids, u_ids) AS e(tenant_id, programme_id, user_id)
   WHERE EXISTS (SELECT 1 FROM public.tenant t WHERE t.id = e.tenant_id)
     AND EXISTS (SELECT 1 FROM public.programme p
                  WHERE p.tenant_id = e.tenant_id AND p.id = e.programme_id)
     AND EXISTS (SELECT 1 FROM public."user" u
                  WHERE u.tenant_id = e.tenant_id AND u.id = e.user_id);
  IF t_ids IS NULL THEN
    RETURN NULL;
  END IF;

  -- c. The unassignment must see an assignment that commits while it waits.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'removing a programme member must run in READ COMMITTED: unassigning their contacts needs to see assignments that commit while it waits'
      USING ERRCODE = 'feature_not_supported';  -- 0A000
  END IF;

  -- d. Every membership lock, exclusive, in ascending key order, before any
  --    contact row is touched: owner checks for them wait for this COMMIT.
  FOR lock_key IN
    SELECT DISTINCT pg_catalog.hashtext(e.programme_id::text || '/' || e.user_id::text)
      FROM unnest(p_ids, u_ids) AS e(programme_id, user_id)
     ORDER BY 1
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(lock_namespace, lock_key);
  END LOOP;

  -- e. Still (again) a member by the end of the statement: nothing ended.
  SELECT pg_catalog.array_agg(e.tenant_id), pg_catalog.array_agg(e.programme_id),
         pg_catalog.array_agg(e.user_id)
    INTO t_ids, p_ids, u_ids
    FROM unnest(t_ids, p_ids, u_ids) AS e(tenant_id, programme_id, user_id)
   WHERE NOT EXISTS (SELECT 1 FROM public.user_programme up
                      WHERE up.tenant_id = e.tenant_id
                        AND up.programme_id = e.programme_id
                        AND up.user_id = e.user_id);
  IF t_ids IS NULL THEN
    RETURN NULL;
  END IF;

  -- f. One statement: unassign, in each member's own tenant and programme
  --    only, then, in ONE INSERT, one programme event per ended membership
  --    (the programme, the remover, the removed staff id and the count, "0"
  --    included; 0031's, unchanged) and one contact event per contact
  --    unassigned (T-0104: the owner change, removed id to null).
  WITH ended AS (
    SELECT e.tenant_id, e.programme_id, e.user_id
      FROM unnest(t_ids, p_ids, u_ids) AS e(tenant_id, programme_id, user_id)
  ),
  unassigned AS (
    UPDATE public.contact c
       SET owner_user_id = NULL,
           version = c.version + 1
      FROM ended e
     WHERE c.tenant_id = e.tenant_id
       AND c.owner_user_id = e.user_id
       AND c.programme_id = e.programme_id
    RETURNING c.id AS contact_id, e.tenant_id, e.programme_id, e.user_id
  ),
  -- One pass over the unassigned rows, not one per ended membership.
  counts AS (
    SELECT x.tenant_id, x.programme_id, x.user_id, pg_catalog.count(*) AS n
      FROM unassigned x
     GROUP BY x.tenant_id, x.programme_id, x.user_id
  ),
  -- The remover's role name, once per tenant rather than once per row.
  actor_role AS (
    SELECT u.tenant_id, r.name
      FROM public."user" u
      JOIN public.role r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
     WHERE u.id = actor
  ),
  events AS (
    SELECT e.tenant_id,
           'programme'::text AS object_type,
           p.id AS object_id,
           pg_catalog.left(coalesce(nullif(p.name, ''), p.id::text), 300) AS object_label,
           p.id AS programme_id,
           pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object(
               'field', 'removedMember', 'before', e.user_id::text,
               'after', NULL, 'redacted', false),
             pg_catalog.jsonb_build_object(
               'field', 'unassignedContacts', 'before', NULL,
               'after', coalesce(k.n, 0)::text,
               'redacted', false)) AS changes
      FROM ended e
      JOIN public.programme p ON p.tenant_id = e.tenant_id AND p.id = e.programme_id
      LEFT JOIN counts k
        ON k.tenant_id = e.tenant_id
       AND k.programme_id = e.programme_id
       AND k.user_id = e.user_id
    UNION ALL
    SELECT x.tenant_id,
           'contact'::text,
           x.contact_id,
           x.contact_id::text,
           x.programme_id,
           pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object(
               'field', 'ownerUserId', 'before', x.user_id::text,
               'after', NULL, 'redacted', false))
      FROM unassigned x
  )
  INSERT INTO public.audit_event
    (id, tenant_id, actor_kind, actor_user_id, actor_role_name,
     action, object_type, object_id, object_label, programme_id, changes)
  SELECT pg_catalog.gen_random_uuid(),
         v.tenant_id,
         CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END,
         actor,
         ar.name,
         'updated',
         v.object_type,
         v.object_id,
         v.object_label,
         v.programme_id,
         v.changes
    FROM events v
    LEFT JOIN actor_role ar ON ar.tenant_id = v.tenant_id;

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;

-- Only the triggers call it; firing a trigger needs no EXECUTE. CREATE OR
-- REPLACE keeps 0031's ACL; revoked again so this file stands on its own.
REVOKE ALL ON FUNCTION app.unassign_removed_member_contacts() FROM PUBLIC;

-- --- 2. prove it -------------------------------------------------------------------
-- Runs once, here. The standing guard is the T-0103 and T-0104 former-owner
-- acceptance suite.
DO $$
DECLARE
  fn constant pg_catalog.regprocedure :=
    'app.unassign_removed_member_contacts()'::pg_catalog.regprocedure;
  body text;
  holders text;
  definers integer;
BEGIN
  -- 0031's two triggers still call it, and nothing else does (a stray
  -- ROW-level copy would bring 0031's deadlock back).
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgfoid = fn
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgrelid = 'public.user_programme'::pg_catalog.regclass
         AND t.tgname IN ('user_programme_removal_unassigns_contacts',
                          'user_programme_rewrite_unassigns_contacts')) <> 2
     OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
          WHERE t.tgfoid = fn AND NOT t.tgisinternal) <> 2 THEN
    RAISE EXCEPTION '0033: app.unassign_removed_member_contacts() must be called by exactly 0031''s two enabled triggers on user_programme';
  END IF;

  -- And their shape, as 0031 asserted it: the lock ordering depends on a
  -- STATEMENT-level AFTER trigger that sees every ended membership at once.
  -- DELETE: STATEMENT (no ROW bit 1), AFTER (no BEFORE bit 2), DELETE (8);
  -- OLD TABLE ended_rows, no NEW TABLE, no WHEN.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.user_programme'::pg_catalog.regclass
         AND t.tgname = 'user_programme_removal_unassigns_contacts'
         AND NOT t.tgisinternal
         AND t.tgtype = 8
         AND t.tgqual IS NULL
         AND t.tgoldtable = 'ended_rows'
         AND t.tgnewtable IS NULL
         AND t.tgfoid = fn) <> 1 THEN
    RAISE EXCEPTION '0033: the trigger user_programme_removal_unassigns_contacts is conditional, or not AFTER DELETE FOR EACH STATEMENT REFERENCING OLD TABLE AS ended_rows';
  END IF;
  -- UPDATE: STATEMENT, AFTER, UPDATE (16), both transition tables, no WHEN,
  -- and NO column list. A trigger with transition tables may not name
  -- columns, so "the key columns" are judged inside the function (a key
  -- missing from kept_rows ended), and a permission-set change ends nothing.
  -- A column-limited trigger deparses as "AFTER UPDATE OF <columns> ON".
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.user_programme'::pg_catalog.regclass
         AND t.tgname = 'user_programme_rewrite_unassigns_contacts'
         AND NOT t.tgisinternal
         AND t.tgtype = 16
         AND t.tgqual IS NULL
         AND t.tgoldtable = 'ended_rows'
         AND t.tgnewtable = 'kept_rows'
         AND pg_catalog.pg_get_triggerdef(t.oid) LIKE '% AFTER UPDATE ON %'
         AND t.tgfoid = fn) <> 1 THEN
    RAISE EXCEPTION '0033: the trigger user_programme_rewrite_unassigns_contacts is conditional, column-limited, or not AFTER UPDATE FOR EACH STATEMENT REFERENCING OLD TABLE AS ended_rows NEW TABLE AS kept_rows';
  END IF;

  -- Invoker's rights, search_path pinned (CLAUDE.md 2.7).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid = fn
                AND (p.prosecdef
                     OR p.proconfig IS NULL
                     OR NOT ('search_path=pg_catalog' = ANY (p.proconfig)))) THEN
    RAISE EXCEPTION '0033: the trigger function is SECURITY DEFINER or has no pinned search_path';
  END IF;

  -- The new body: the locks still come before the UPDATE, and the per-contact
  -- event is written from the UPDATE's RETURNING.
  SELECT p.prosrc INTO body FROM pg_catalog.pg_proc p WHERE p.oid = fn;
  IF pg_catalog.strpos(body, 'pg_advisory_xact_lock') = 0
     OR pg_catalog.strpos(body, 'UPDATE public.contact') = 0
     OR pg_catalog.strpos(body, 'pg_advisory_xact_lock') > pg_catalog.strpos(body, 'UPDATE public.contact')
     OR pg_catalog.strpos(body, '''field'', ''ownerUserId''') = 0
     OR pg_catalog.strpos(body, 'FROM unassigned x') = 0 THEN
    RAISE EXCEPTION '0033: the trigger function body is not this file''s (locks before the UPDATE, one contact event per unassigned row)';
  END IF;

  -- No serving role can call it directly.
  SELECT pg_catalog.string_agg(r.rolname, ', ' ORDER BY r.rolname)
    INTO holders
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('kasuwa_app', 'kasuwa_auth', 'kasuwa_sweeper', 'kasuwa_test_admin')
     AND pg_catalog.has_function_privilege(r.oid, fn, 'EXECUTE');
  IF holders IS NOT NULL THEN
    RAISE EXCEPTION '0033: roles can EXECUTE the trigger function directly: %', holders;
  END IF;

  -- The definer census is still two in the schemas Kasuwa owns (CLAUDE.md 2.7).
  SELECT pg_catalog.count(*)::integer
    INTO definers
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname IN ('app', 'public');
  IF definers <> 2 THEN
    RAISE EXCEPTION '0033: expected exactly two SECURITY DEFINER functions in app and public, found %', definers;
  END IF;
END
$$;
