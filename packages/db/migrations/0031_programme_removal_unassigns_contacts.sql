-- ---------------------------------------------------------------------------
-- 0031 - removing a user from a programme unassigns their contacts there
-- (T-0103, Agent 3; D-P23, D-L99, D-L67, D-L65).
--
-- D-P23 (answered 2026-10-07): nobody sees the name of a person who no longer
-- shares the contact's programme. Two halves:
--   - READS (no SQL here): the contact repository's owner subquery reads a
--     name only for an owner who is a member of the contact's programme;
--     anyone else reads as `owner: { id, displayName: null }`, a former owner.
--   - REMOVAL (this file): when a user stops being a member of a programme,
--     their contacts in that programme are unassigned in the same
--     transaction, and the removal is audited: one event per ended
--     membership, carrying the count of contacts unassigned ("0" included).
--
-- WHERE REMOVAL HAPPENS (D-L99). No application code deletes or rewrites a
-- user_programme row, and no admin operation does. The paths are the
-- database's own, so the rule lives here, as a trigger, and stays the
-- backstop when a membership-removal API arrives:
--   P1. DELETE by kasuwa_app in a tenant-admin session that reaches the
--       programme (0021 policy 3);
--   P2. UPDATE of user_id or programme_id by the same session (0021 policy 1
--       and 0015): the old member leaves the old programme;
--   P3. kasuwa_migrator (operator jobs).
--
-- In this one file:
--   1. contact_owner_programme_idx, so a removal reads only its programme;
--   2. app.unassign_removed_member_contacts(), the trigger function;
--   3. two AFTER STATEMENT triggers on user_programme with transition tables,
--      one for DELETE and one for UPDATE;
--   4. a self-check that all of it is in place and is what this header says.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
-- No new table, policy or grant on a table; no data is changed by this file.
--
-- ---------------------------------------------------------------------------
-- THE RULE
-- ---------------------------------------------------------------------------
-- A STATEMENT that deletes user_programme rows, or updates them so that a
-- (tenant_id, programme_id, user_id) key no longer exists in the statement's
-- NEW rows, has ENDED those memberships. Once per statement, for the set of
-- memberships it ended, in this order:
--   a. A session that cannot see one of those programmes' contacts is
--      refused (42501). Under RLS an UPDATE silently skips rows it cannot
--      see, so unassigning "what we can see" would leave a non-member owner
--      without a word. The test is NULL-safe (`IS NOT TRUE`): a session with
--      no tenant or no scope is refused, never waved through. For a
--      kasuwa_app session this cannot happen on P1 (0021 policy 3 requires
--      the programme in scope), and on P2 only through 0015's
--      creation-marker branch (a programme created in this transaction, which
--      can hold no contact). Roles with BYPASSRLS (the migrator) see all rows.
--   b. OFFBOARDING IS NOT A REMOVAL. A membership whose tenant, programme or
--      user no longer exists went in a cascade from that parent
--      (migrator-only, 0022). It is dropped from the set:
--        - a programme or tenant delete cascades to the contacts as well, and
--          an audit row naming a deleted programme would fail its FK;
--        - a "user" delete stays refused by contact_owner_same_tenant_fk while
--          the user still owns contacts, exactly as before this file.
--   c. READ COMMITTED only (0A000 otherwise), as 0026's hierarchy guard: the
--      unassignment must see an assignment that commits while it waits (d).
--   d. EVERY membership lock in the set, exclusive, in ascending key order,
--      BEFORE any contact is touched (CONCURRENCY, below).
--   e. A membership whose user is a member of that programme again by the
--      end of the statement (a multi-row rewrite that lands another row on
--      the same key) is dropped from the set: nothing ended.
--   f. ONE statement: UPDATE contact SET owner_user_id = NULL, version =
--      version + 1 for every contact owned by a member of the set in that
--      member's tenant and programme; and ONE audit event per membership of
--      the set (below), whether it unassigned many contacts or none
--      (membership is a permission change, CLAUDE.md 6.7). Only those three
--      contact columns move (updated_at by 0018's trigger); 0019's
--      bump_version sees version changed and stays out, so it moves once.
--
-- NOT A REMOVAL, and untouched: a permission-set change (its key is still in
-- the NEW rows, so it ends nothing and takes no lock), an archived programme
-- (archiveProgramme deletes nothing, D-L46) and a disabled user (still a
-- member, D-L81). Accounts and activities keep a removed owner: T-0120
-- applies D-P23 to them (D-L99).
--
-- ---------------------------------------------------------------------------
-- THE AUDIT EVENT (D-L99)
-- ---------------------------------------------------------------------------
-- One row per ENDED membership (lead ruling on the T-0103 build: every real
-- removal is audited, because a membership is a permission, CLAUDE.md 6.7;
-- this goes past D-L99's "one per removal that unassigns anything"). A
-- removal that unassigned nothing still writes its event, with
-- `unassignedContacts` "0". No event for what is not an ended membership:
-- step (b)'s offboarding cascades and step (e)'s same-key rewrite. Shaped as
-- the programme events of programmes.controller (action 'updated', object_type
-- 'programme', object_id and programme_id the programme, label its name):
--   - programme_id is the membership's programme, so only its members read it
--     (an event with no programme is tenant-wide, D-L48);
--   - the actor is the session user (app.current_user_id()), the remover, with
--     their role name as the audit writer records it. 0008's restrictive
--     policy holds a kasuwa_app session to exactly that. A session with no
--     user (the migrator, P3) writes actor_kind 'system';
--   - changes: `removedMember` (before: the removed user's id, a staff id and
--     not customer PII, D-L71; after: null) and `unassignedContacts` (before:
--     null; after: the count as a decimal string, AuditChange's type);
--   - NO contact id, contact name, phone, user display name or email,
--     anywhere in the row.
-- kasuwa_test_admin cannot INSERT into audit_event (0008), so every removal
-- it makes is refused, fail closed (accepted by the lead). It never exists in
-- a real cell (D-L92).
--
-- ---------------------------------------------------------------------------
-- CONCURRENCY (D-L99's race, its trap, and the deadlock the review found)
-- ---------------------------------------------------------------------------
-- An owner assignment checks membership (D-L67) and then writes the contact.
-- Without a lock, a removal can commit between the two: the check saw the
-- uncommitted removal's row, the unassignment ran before the assignment's
-- write, and the contact ends owned by a non-member.
--
-- The trap: the natural lock, `SELECT ... FROM user_programme FOR KEY SHARE`,
-- is filtered by 0021's restrictive UPDATE policy for every non-admin session
-- (PostgreSQL applies UPDATE policies to row-locking SELECTs), so an agent's
-- D-P14 self-claim would find no row and fail. 0021's header forbids row
-- locks on user_programme for that reason.
--
-- So the lock is a transaction-scoped ADVISORY lock, which RLS does not touch,
-- on the membership's key:
--     (namespace 0x4b4d454d, ASCII 'KMEM',
--      hashtext(programme_id::text || '/' || user_id::text))
-- in the two-key form, which shares no key space with the one-key locks (the
-- runner) or another namespace (0026's 'KACH', the sweep's 'KSWP').
--   - The removal takes it EXCLUSIVE, in this trigger, for every membership
--     the statement ended, before it touches a contact.
--   - Every owner check (programmeMemberExists in @kasuwa/core) takes it
--     SHARED, in its own statement, BEFORE it reads user_programme, and holds
--     it to COMMIT. Every writer of contact.owner_user_id must make that
--     check; it refuses to run outside READ COMMITTED.
-- Both orders end with no non-member owner:
--   - check first: the removal waits for the assigning transaction to commit,
--     then its UPDATE (a new statement, so a fresh READ COMMITTED snapshot)
--     sees the new owner and unassigns it;
--   - removal first: the check waits for the removal to commit, then reads
--     user_programme with a fresh snapshot, finds no membership, and the API
--     answers 400 unknown_reference, the body an invented id gets (D-L67).
-- The key text is built from uuid::text on both sides (canonical lower case),
-- so the two always agree. A hashtext collision makes two unrelated
-- memberships wait for each other, never skip a wait.
--
-- DEADLOCK (migration review, major 1, reproduced on the first version). A
-- ROW-level trigger locked and unassigned one membership at a time. One
-- statement ending memberships A and B, racing an assignment that moves a
-- contact from A to B, deadlocked: the removal unassigned (row-locked) the
-- contact under A and then waited for B's lock, while the assigner held B's
-- shared lock and waited for that contact row. 40P01, and the assigner got a
-- 500. This version takes ALL of a statement's membership locks first, in
-- ascending key order, and only then touches contact rows. While it waits it
-- holds no contact row lock (only its own user_programme rows, which no
-- assigner waits for), and an assigner holds at most one membership lock, so
-- that cycle cannot form. What remains, stated rather than hidden: a single
-- TRANSACTION that ends memberships in two separate statements takes the
-- second statement's locks after the first's, so two such transactions
-- removing overlapping sets in opposite orders can still deadlock with EACH
-- OTHER. The server's 40P01 then rolls one back whole: never a wrong owner,
-- and no membership-removal API exists yet to issue that pattern.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER, AND WHY THESE CHOICES (the builder's, D-L99)
-- ---------------------------------------------------------------------------
--   - Not a foreign key from contact through user_programme (D-L67's other
--     idea): ON DELETE SET NULL (owner_user_id) would unassign, but it would
--     also refuse every non-member owner written before this file, and the
--     T-0103 suite plants exactly those as the migrator. It writes no audit.
--   - AFTER STATEMENT with transition tables, not FOR EACH ROW: only a
--     statement-level trigger sees every membership the statement ended at
--     once, which the lock ordering above needs. RLS-filtered rows are not in
--     the transition tables, so they end nothing.
--   - Immediate, not deferred: the removing transaction sees its own
--     unassignment at once; nobody else does before COMMIT, and a ROLLBACK
--     takes both away. D-L99 leaves the choice to the builder.
--   - Two triggers on one function: a trigger with transition tables may name
--     only one event, and an UPDATE trigger with them may not have a column
--     list. The function reads ended_rows (OLD TABLE) on both, and kept_rows
--     (NEW TABLE) on UPDATE only.
--
-- NO SECURITY DEFINER (CLAUDE.md 2.7). The function runs as the invoker, under
-- the remover's RLS: a tenant-admin session that reaches the programme can
-- see and update its contacts and write its audit rows, and step (a) refuses
-- any session that cannot. search_path is pinned to pg_catalog and every
-- table is schema-qualified. EXECUTE is revoked from PUBLIC (firing a trigger
-- needs none). The definer census stays at two; step 4 checks it.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT AND COST (D-L65; migration review, major 2)
-- ---------------------------------------------------------------------------
--   - contact: CREATE INDEX contact_owner_programme_idx takes SHARE on contact
--     until COMMIT, which blocks contact writes (not reads) while the index
--     builds, a scan of every row. Accepted inside the transaction because no
--     populated cell exists (D-L65). On a populated cell, build it first,
--     outside a transaction, and make this step a no-op:
--         SET lock_timeout = '5s';
--         CREATE INDEX CONCURRENTLY IF NOT EXISTS contact_owner_programme_idx
--           ON contact (tenant_id, owner_user_id, programme_id)
--           WHERE owner_user_id IS NOT NULL;
--     (CONCURRENTLY cannot run inside the runner's transaction until the
--     D-L65 runner task adds a non-transactional mode; a failed concurrent
--     build leaves an INVALID index to DROP INDEX CONCURRENTLY and retry.)
--     It supersedes contact_owner_idx's prefix for "my contacts" as well;
--     dropping the older index is a later contract step, not this file's.
--   - user_programme: CREATE TRIGGER takes SHARE ROW EXCLUSIVE until COMMIT.
--     It blocks membership writes, not reads, so session resolution (which
--     reads user_programme on every request) keeps answering. No row is read
--     or rewritten here.
--   - audit_event and the rest: no DDL, no lock taken by this file.
--   - lock_timeout = 5s: fail fast instead of queueing behind a long
--     transaction.
-- Steady-state cost:
--   - every UPDATE statement on user_programme runs the function once; a
--     permission-set change ends nothing and returns before any lock;
--   - per removal statement: one advisory lock per ended membership, one
--     UPDATE on contact reading only the ended memberships' owned rows
--     through contact_owner_programme_idx, and one audit row per membership;
--   - the migration review measured the unassignment at about 2.45 s per
--     100,000 contacts owned by the removed user in that programme, all of it
--     inside the removing transaction, holding those contact row locks and
--     the membership lock until COMMIT. That is acceptable for an operator's
--     DELETE. A future membership-removal API must cap the number of contacts
--     one request may unassign, or hand larger removals to an async job that
--     unassigns in batches, before it ships.
--   - each owner check gains one advisory-lock statement.
-- EXISTING ROWS: non-member owners written before this file are not
-- backfilled (lead ruling, D-L65): the read path shows them as former owners.
--
-- ---------------------------------------------------------------------------
-- REVERSIBILITY AND ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- This file changes no data. If it fails, nothing was applied (one
-- transaction; the runner records it only on COMMIT): fix the cause and run
-- `pnpm db:migrate` again. To undo it after it has applied, never edit or
-- delete this file or its ledger row (append-only). That reopens D-P23's
-- removal half, so the decision must be reversed first; the T-0103 suite
-- would go red, as it should. Then, as kasuwa_migrator, in a NEW migration:
--     SET LOCAL lock_timeout = '2s';
--     DROP TRIGGER user_programme_removal_unassigns_contacts ON user_programme;
--     DROP TRIGGER user_programme_rewrite_unassigns_contacts ON user_programme;
--     DROP FUNCTION app.unassign_removed_member_contacts();
-- DROP TRIGGER takes ACCESS EXCLUSIVE on user_programme, which blocks session
-- resolution (every request) while it waits: hence 2s, as 0021 uses for the
-- same table. Keep contact_owner_programme_idx unless it is unused; dropping
-- it is DROP INDEX CONCURRENTLY, outside a transaction. Contacts already
-- unassigned stay unassigned; their audit events say how many.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. the index ----------------------------------------------------------------
-- Equality on all three columns in step (f); partial, like contact_owner_idx,
-- because unowned rows are never read by it.
CREATE INDEX contact_owner_programme_idx
  ON contact (tenant_id, owner_user_id, programme_id)
  WHERE owner_user_id IS NOT NULL;

-- --- 2. the function -------------------------------------------------------------
-- VOLATILE (the default) on purpose: each query below must take a fresh
-- snapshot after the locks are granted. See CONCURRENCY in the header.
-- Messages name the rule, never a row's ids or names.
CREATE FUNCTION app.unassign_removed_member_contacts() RETURNS trigger
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
  --    only, then one event per ended membership: the programme, the
  --    remover, the removed staff id and the count ("0" included).
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
    RETURNING e.tenant_id, e.programme_id, e.user_id
  )
  INSERT INTO public.audit_event
    (id, tenant_id, actor_kind, actor_user_id, actor_role_name,
     action, object_type, object_id, object_label, programme_id, changes)
  SELECT pg_catalog.gen_random_uuid(),
         e.tenant_id,
         CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END,
         actor,
         (SELECT r.name
            FROM public."user" u
            JOIN public.role r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
           WHERE u.tenant_id = e.tenant_id AND u.id = actor),
         'updated',
         'programme',
         p.id,
         pg_catalog.left(coalesce(nullif(p.name, ''), p.id::text), 300),
         p.id,
         pg_catalog.jsonb_build_array(
           pg_catalog.jsonb_build_object(
             'field', 'removedMember', 'before', e.user_id::text,
             'after', NULL, 'redacted', false),
           pg_catalog.jsonb_build_object(
             'field', 'unassignedContacts', 'before', NULL,
             'after', (SELECT pg_catalog.count(*)
                         FROM unassigned x
                        WHERE x.tenant_id = e.tenant_id
                          AND x.programme_id = e.programme_id
                          AND x.user_id = e.user_id)::text,
             'redacted', false))
    FROM ended e
    JOIN public.programme p ON p.tenant_id = e.tenant_id AND p.id = e.programme_id;

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;

-- Only the triggers below call it; firing a trigger needs no EXECUTE.
REVOKE ALL ON FUNCTION app.unassign_removed_member_contacts() FROM PUBLIC;

-- --- 3. the triggers -------------------------------------------------------------
CREATE TRIGGER user_programme_removal_unassigns_contacts
  AFTER DELETE ON user_programme
  REFERENCING OLD TABLE AS ended_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.unassign_removed_member_contacts();

-- A permission-set change keeps its key in kept_rows, so it ends nothing.
CREATE TRIGGER user_programme_rewrite_unassigns_contacts
  AFTER UPDATE ON user_programme
  REFERENCING OLD TABLE AS ended_rows NEW TABLE AS kept_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.unassign_removed_member_contacts();

-- --- 4. prove it -------------------------------------------------------------------
-- Runs once, here. The standing guard is the T-0103 acceptance suite.
DO $$
DECLARE
  fn constant pg_catalog.regprocedure :=
    'app.unassign_removed_member_contacts()'::pg_catalog.regprocedure;
  holders text;
  definers integer;
BEGIN
  -- DELETE: enabled ('O'), STATEMENT (no ROW bit 1), AFTER (no BEFORE bit 2),
  -- DELETE (8); OLD TABLE ended_rows, no NEW TABLE, no WHEN.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.user_programme'::pg_catalog.regclass
         AND t.tgname = 'user_programme_removal_unassigns_contacts'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgtype = 8
         AND t.tgqual IS NULL
         AND t.tgoldtable = 'ended_rows'
         AND t.tgnewtable IS NULL
         AND t.tgfoid = fn) <> 1 THEN
    RAISE EXCEPTION '0031: the trigger user_programme_removal_unassigns_contacts is missing, disabled, conditional, or not AFTER DELETE FOR EACH STATEMENT REFERENCING OLD TABLE AS ended_rows';
  END IF;

  -- UPDATE: enabled, STATEMENT, AFTER, UPDATE (16), both transition tables,
  -- no WHEN, no column list (an `UPDATE OF ...` trigger deparses as
  -- "AFTER UPDATE OF <columns> ON").
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.user_programme'::pg_catalog.regclass
         AND t.tgname = 'user_programme_rewrite_unassigns_contacts'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgtype = 16
         AND t.tgqual IS NULL
         AND t.tgoldtable = 'ended_rows'
         AND t.tgnewtable = 'kept_rows'
         AND pg_catalog.pg_get_triggerdef(t.oid) LIKE '% AFTER UPDATE ON %'
         AND t.tgfoid = fn) <> 1 THEN
    RAISE EXCEPTION '0031: the trigger user_programme_rewrite_unassigns_contacts is missing, disabled, conditional, column-limited, or not AFTER UPDATE FOR EACH STATEMENT REFERENCING OLD TABLE AS ended_rows NEW TABLE AS kept_rows';
  END IF;

  -- No other user trigger on user_programme calls the function (a stray
  -- ROW-level copy would bring the deadlock back).
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgfoid = fn AND NOT t.tgisinternal) <> 2 THEN
    RAISE EXCEPTION '0031: app.unassign_removed_member_contacts() must be called by exactly the two triggers above';
  END IF;

  -- The index: present, valid, on exactly (tenant_id, owner_user_id,
  -- programme_id), partial on owned rows.
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'public.contact'::pg_catalog.regclass
          AND c.relname = 'contact_owner_programme_idx'
          AND i.indisvalid
          AND pg_catalog.pg_get_indexdef(i.indexrelid)
              LIKE '%(tenant_id, owner_user_id, programme_id) WHERE (owner_user_id IS NOT NULL)') THEN
    RAISE EXCEPTION '0031: contact_owner_programme_idx is missing, invalid, or not on (tenant_id, owner_user_id, programme_id) WHERE owner_user_id IS NOT NULL';
  END IF;

  -- The function: invoker's rights, search_path pinned (CLAUDE.md 2.7).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid = fn
                AND (p.prosecdef
                     OR p.proconfig IS NULL
                     OR NOT ('search_path=pg_catalog' = ANY (p.proconfig)))) THEN
    RAISE EXCEPTION '0031: the trigger function is SECURITY DEFINER or has no pinned search_path';
  END IF;

  -- No serving role can call it directly.
  SELECT pg_catalog.string_agg(r.rolname, ', ' ORDER BY r.rolname)
    INTO holders
    FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('kasuwa_app', 'kasuwa_auth', 'kasuwa_sweeper', 'kasuwa_test_admin')
     AND pg_catalog.has_function_privilege(r.oid, fn, 'EXECUTE');
  IF holders IS NOT NULL THEN
    RAISE EXCEPTION '0031: roles can EXECUTE the trigger function directly: %', holders;
  END IF;

  -- The definer census is still two in the schemas Kasuwa owns (CLAUDE.md
  -- 2.7). Counted in app and public only, so an extension's own definer in
  -- its schema cannot fail this file.
  SELECT pg_catalog.count(*)::integer
    INTO definers
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname IN ('app', 'public');
  IF definers <> 2 THEN
    RAISE EXCEPTION '0031: expected exactly two SECURITY DEFINER functions in app and public, found %', definers;
  END IF;
END
$$;
