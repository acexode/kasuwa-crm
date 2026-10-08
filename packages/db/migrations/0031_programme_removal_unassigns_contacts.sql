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
--   1. app.unassign_removed_member_contacts(), the trigger function;
--   2. two AFTER ROW triggers on user_programme, one for DELETE and one for an
--      UPDATE that changes the membership's key;
--   3. a self-check that both are in place and are what this header says.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
-- No new table, policy or grant on a table; no data is changed by this file.
--
-- ---------------------------------------------------------------------------
-- THE RULE
-- ---------------------------------------------------------------------------
-- For each user_programme row that is deleted, or updated so that its
-- (tenant_id, user_id, programme_id) changes, the OLD membership has ended.
-- For that membership, in this order:
--   a. A session that cannot see the programme's contacts is refused
--      (42501). Under RLS an UPDATE silently skips rows it cannot see, so
--      unassigning "what we can see" would leave a non-member owner without a
--      word. For a kasuwa_app session this cannot happen on P1 (0021 policy 3
--      requires the programme in scope), and on P2 only through 0015's
--      creation-marker branch (a programme created in this transaction, which
--      can hold no contact). Roles with BYPASSRLS (the migrator) see all rows.
--   b. OFFBOARDING IS NOT A REMOVAL. If the membership's tenant, programme or
--      user no longer exists, the row went in a cascade from that parent
--      (migrator-only, 0022). Nothing is done:
--        - a programme or tenant delete cascades to the contacts as well, and
--          an audit row naming a deleted programme would fail its FK;
--        - a "user" delete stays refused by contact_owner_same_tenant_fk while
--          the user still owns contacts, exactly as before this file.
--   c. READ COMMITTED only (0A000 otherwise), as 0026's hierarchy guard: the
--      unassignment must see an assignment that commits while it waits (d).
--   d. The membership lock, exclusive (below, CONCURRENCY).
--   e. If the user is a member of the programme again by the end of the
--      statement (a multi-row rewrite that lands another row on the same
--      key), nothing is done.
--   f. UPDATE contact SET owner_user_id = NULL, version = version + 1 for
--      every contact in that tenant and programme owned by that user. Only
--      those three columns move (updated_at by 0018's trigger); 0019's
--      bump_version sees version changed and stays out, so it moves once.
--   g. ONE audit event (below), always: whether (f) unassigned many contacts
--      or none. Membership is a permission change (CLAUDE.md 6.7).
--
-- NOT A REMOVAL, and untouched: a permission-set change (the WHEN clause
-- skips it), an archived programme (archiveProgramme deletes nothing, D-L46)
-- and a disabled user (still a member, D-L81). Accounts and activities keep a
-- removed owner: T-0120 applies D-P23 to them (D-L99).
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
-- CONCURRENCY (D-L99's race, and its trap)
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
--   - The removal takes it EXCLUSIVE, in this trigger, after its row change
--     and before it unassigns.
--   - Every owner check (programmeMemberExists in @kasuwa/core) takes it
--     SHARED, in its own statement, BEFORE it reads user_programme, and holds
--     it to COMMIT.
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
-- Deadlock: the removal holds its user_programme row and then waits for the
-- advisory lock; an assigner holds the advisory lock and then a contact row.
-- No assigner waits for a user_programme row lock, so there is no cycle on
-- these paths. A cycle elsewhere is the server's 40P01, never a wrong owner.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER, AND WHY THESE CHOICES (the builder's, D-L99)
-- ---------------------------------------------------------------------------
--   - Not a foreign key from contact through user_programme (D-L67's other
--     idea): ON DELETE SET NULL (owner_user_id) would unassign, but it would
--     also refuse every non-member owner written before this file, and the
--     T-0103 suite plants exactly those as the migrator. It writes no audit.
--   - AFTER ROW, not BEFORE: it acts only on a row change that actually
--     happened (RLS-filtered rows never fire it), and it sees the whole
--     statement's result for step (e).
--   - Immediate, not deferred: the removing transaction sees its own
--     unassignment at once; nobody else does before COMMIT, and a ROLLBACK
--     takes both away. D-L99 leaves the choice to the builder.
--   - Two triggers on one function, because a WHEN clause on a DELETE trigger
--     cannot read NEW. The UPDATE trigger's WHEN names no column list
--     (`UPDATE OF ...` would miss a key change made by a BEFORE trigger).
--
-- NO SECURITY DEFINER (CLAUDE.md 2.7). The function runs as the invoker, under
-- the remover's RLS: a tenant-admin session that reaches the programme can
-- see and update its contacts and write its audit row, and step (a) refuses
-- any session that cannot. search_path is pinned to pg_catalog and every
-- table is schema-qualified. EXECUTE is revoked from PUBLIC (firing a trigger
-- needs none). The definer census stays at two; step 3 checks it.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
--   - user_programme: CREATE TRIGGER takes SHARE ROW EXCLUSIVE until COMMIT.
--     It blocks membership writes, not reads, so session resolution (which
--     reads user_programme on every request) keeps answering. No row is read
--     or rewritten here, so it is held for milliseconds at any size; no
--     NOT VALID / VALIDATE or CONCURRENTLY step applies.
--   - contact, audit_event and the rest: no DDL, no lock taken by this file.
--   - lock_timeout = 5s: fail fast instead of queueing behind a long
--     transaction.
-- Steady-state cost: one WHEN evaluation per user_programme row updated, and
-- per removal one advisory lock, one indexed UPDATE on contact
-- (contact_owner_idx) and one audit_event row. Each owner check gains one
-- advisory-lock statement.
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
--     SET LOCAL lock_timeout = '5s';
--     DROP TRIGGER user_programme_removal_unassigns_contacts ON user_programme;
--     DROP TRIGGER user_programme_rewrite_unassigns_contacts ON user_programme;
--     DROP FUNCTION app.unassign_removed_member_contacts();
-- DROP TRIGGER takes ACCESS EXCLUSIVE on user_programme, which blocks session
-- resolution while it waits: that is why lock_timeout is required. Contacts
-- already unassigned stay unassigned; their audit events say how many.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. the function -----------------------------------------------------------
-- VOLATILE (the default) on purpose: each query below must take a fresh
-- snapshot after the lock is granted. See CONCURRENCY in the header.
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
  unassigned integer;
BEGIN
  -- a. The session must see every contact it is about to unassign.
  SELECT r.rolbypassrls OR r.rolsuper
    INTO sees_every_row
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = current_user;
  IF NOT coalesce(sees_every_row, false)
     AND NOT (OLD.tenant_id = app.current_tenant_id()
              AND OLD.programme_id = ANY (app.current_programme_ids())) THEN
    RAISE EXCEPTION 'a membership can only be removed by a session that reaches its programme, so that its contacts can be unassigned'
      USING ERRCODE = 'insufficient_privilege';  -- 42501
  END IF;

  -- b. Offboarding: the membership went with its tenant, programme or user.
  IF NOT EXISTS (SELECT 1 FROM public.tenant t WHERE t.id = OLD.tenant_id)
     OR NOT EXISTS (SELECT 1 FROM public.programme p
                     WHERE p.tenant_id = OLD.tenant_id AND p.id = OLD.programme_id)
     OR NOT EXISTS (SELECT 1 FROM public."user" u
                     WHERE u.tenant_id = OLD.tenant_id AND u.id = OLD.user_id) THEN
    RETURN NULL;
  END IF;

  -- c. The unassignment must see an assignment that commits while it waits.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'removing a programme member must run in READ COMMITTED: unassigning their contacts needs to see assignments that commit while it waits'
      USING ERRCODE = 'feature_not_supported';  -- 0A000
  END IF;

  -- d. Exclusive on the membership: owner checks for it wait for this COMMIT.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    lock_namespace,
    pg_catalog.hashtext(OLD.programme_id::text || '/' || OLD.user_id::text));

  -- e. Still (again) a member by the end of the statement: nothing ended.
  IF EXISTS (SELECT 1 FROM public.user_programme up
              WHERE up.tenant_id = OLD.tenant_id
                AND up.programme_id = OLD.programme_id
                AND up.user_id = OLD.user_id) THEN
    RETURN NULL;
  END IF;

  -- f. Unassign, in this tenant and programme only.
  UPDATE public.contact c
     SET owner_user_id = NULL,
         version = c.version + 1
   WHERE c.tenant_id = OLD.tenant_id
     AND c.programme_id = OLD.programme_id
     AND c.owner_user_id = OLD.user_id;
  GET DIAGNOSTICS unassigned = ROW_COUNT;

  -- g. One event, always (a membership is a permission, CLAUDE.md 6.7): the
  --    programme, the remover, the removed staff id, the count ("0" included).
  INSERT INTO public.audit_event
    (id, tenant_id, actor_kind, actor_user_id, actor_role_name,
     action, object_type, object_id, object_label, programme_id, changes)
  SELECT pg_catalog.gen_random_uuid(),
         OLD.tenant_id,
         CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END,
         actor,
         (SELECT r.name
            FROM public."user" u
            JOIN public.role r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
           WHERE u.tenant_id = OLD.tenant_id AND u.id = actor),
         'updated',
         'programme',
         p.id,
         pg_catalog.left(coalesce(nullif(p.name, ''), p.id::text), 300),
         p.id,
         pg_catalog.jsonb_build_array(
           pg_catalog.jsonb_build_object(
             'field', 'removedMember', 'before', OLD.user_id::text,
             'after', NULL, 'redacted', false),
           pg_catalog.jsonb_build_object(
             'field', 'unassignedContacts', 'before', NULL,
             'after', unassigned::text, 'redacted', false))
    FROM public.programme p
   WHERE p.tenant_id = OLD.tenant_id
     AND p.id = OLD.programme_id;

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;

-- Only the triggers below call it; firing a trigger needs no EXECUTE.
REVOKE ALL ON FUNCTION app.unassign_removed_member_contacts() FROM PUBLIC;

-- --- 2. the triggers -------------------------------------------------------------
CREATE TRIGGER user_programme_removal_unassigns_contacts
  AFTER DELETE ON user_programme
  FOR EACH ROW
  EXECUTE FUNCTION app.unassign_removed_member_contacts();

-- A permission-set change keeps the membership: the WHEN clause skips it.
CREATE TRIGGER user_programme_rewrite_unassigns_contacts
  AFTER UPDATE ON user_programme
  FOR EACH ROW
  WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
        OR OLD.user_id IS DISTINCT FROM NEW.user_id
        OR OLD.programme_id IS DISTINCT FROM NEW.programme_id)
  EXECUTE FUNCTION app.unassign_removed_member_contacts();

-- --- 3. prove it -------------------------------------------------------------------
-- Runs once, here. The standing guard is the T-0103 acceptance suite.
DO $$
DECLARE
  fn constant pg_catalog.regprocedure :=
    'app.unassign_removed_member_contacts()'::pg_catalog.regprocedure;
  expected_when constant text :=
    '((old.tenant_id IS DISTINCT FROM new.tenant_id) OR (old.user_id IS DISTINCT FROM new.user_id) OR (old.programme_id IS DISTINCT FROM new.programme_id))';
  actual_when text;
  holders text;
  definers integer;
BEGIN
  -- DELETE: enabled ('O'), ROW (1) + DELETE (8), AFTER (no BEFORE bit 2), no WHEN.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.user_programme'::pg_catalog.regclass
         AND t.tgname = 'user_programme_removal_unassigns_contacts'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgtype = 9
         AND t.tgqual IS NULL
         AND t.tgfoid = fn) <> 1 THEN
    RAISE EXCEPTION '0031: the trigger user_programme_removal_unassigns_contacts is missing, disabled, conditional, or not AFTER DELETE FOR EACH ROW';
  END IF;

  -- UPDATE: enabled, ROW (1) + UPDATE (16), AFTER, no column list (an
  -- `UPDATE OF ...` trigger deparses as "AFTER UPDATE OF <columns> ON").
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid = 'public.user_programme'::pg_catalog.regclass
         AND t.tgname = 'user_programme_rewrite_unassigns_contacts'
         AND NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND t.tgtype = 17
         AND pg_catalog.pg_get_triggerdef(t.oid) LIKE '% AFTER UPDATE ON %'
         AND t.tgfoid = fn) <> 1 THEN
    RAISE EXCEPTION '0031: the trigger user_programme_rewrite_unassigns_contacts is missing, disabled, column-limited, or not AFTER UPDATE FOR EACH ROW';
  END IF;

  -- Its WHEN clause is exactly step 2's: a narrower one would let a key
  -- rewrite end a membership without unassigning.
  SELECT (pg_catalog.regexp_match(pg_catalog.pg_get_triggerdef(t.oid),
                                  ' WHEN \((.*)\) EXECUTE FUNCTION '))[1]
    INTO actual_when
    FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.user_programme'::pg_catalog.regclass
     AND t.tgname = 'user_programme_rewrite_unassigns_contacts';
  IF actual_when IS DISTINCT FROM expected_when THEN
    RAISE EXCEPTION '0031: the rewrite trigger''s WHEN clause is % but must be %',
      coalesce(actual_when, 'missing'), expected_when;
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

  -- The definer census is still two (CLAUDE.md 2.7).
  SELECT pg_catalog.count(*)::integer
    INTO definers
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema');
  IF definers <> 2 THEN
    RAISE EXCEPTION '0031: expected exactly two SECURITY DEFINER functions, found %', definers;
  END IF;
END
$$;
