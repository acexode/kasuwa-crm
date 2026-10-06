-- ---------------------------------------------------------------------------
-- 0026 - account fields and the account hierarchy (T-0054, Agent 3; D-L69,
-- D-L65, D-L67, D-L73, D-L74, D-P24).
--
-- Gives `account` the columns the T-0052 contract names (docs/api/
-- records.openapi.yaml, `Account`), each with its standard field_def in the
-- T-0053 catalogue, in this one file:
--
--   owner_user_id      uuid    -> "user" through (tenant_id, owner_user_id)
--   industry           text    free text (the contract has no enum yet)
--   tier               text    CHECK: exactly the contract's AccountTier codes
--   tags               text[]  NOT NULL DEFAULT '{}', no NULL element
--   phones             jsonb   NOT NULL DEFAULT '[]', the contract's Phone shape
--   state, lga         text
--   parent_account_id  uuid    -> account through (tenant_id, programme_id, id)
--
-- `owner` is derived from owner_user_id and gets no column and no field_def
-- (D-L73). Health and deal rollups are not here (D-L69: no PRD owner yet).
--
-- Order of this file, and why:
--   1. locks, taken up front in a fixed order;
--   2. the clash pre-check (D-P24), BEFORE anything changes;
--   3. the phone-shape function, the columns, keys and checks;
--   4. indexes;
--   5. the hierarchy guard;
--   6. account.id made immutable for kasuwa_app;
--   7. the field_def backfill for every existing tenant, and its proof.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3; the same reasoning as 0019 for contact)
-- ---------------------------------------------------------------------------
-- Both new FKs are composite, because referential checks ignore row security:
--   - owner: (tenant_id, owner_user_id) -> "user" (tenant_id, id). A plain FK
--     on owner_user_id would accept another tenant's user. D-L67 (the owner
--     must belong to the account's PROGRAMME) is not enforced here; T-0055
--     checks it in the repository, as T-0041 does for contact (D-L74).
--   - parent: (tenant_id, programme_id, parent_account_id) -> account
--     (tenant_id, programme_id, id), using 0019's UNIQUE. A parent is always in
--     the same programme. A session that reaches A1 and A2 is not stopped by
--     RLS from linking across them; only the key stops it.
--   - An unreachable parent id and an invented one fail the same FK with the
--     same message: no existence oracle across the programme boundary.
--
-- MOVING BETWEEN PROGRAMMES. The key carries programme_id and has no CASCADE,
-- so moving ONE linked row is refused: a child alone no longer finds its
-- parent, and a parent alone strands its children. That holds per row only.
-- A single `UPDATE account SET programme_id = ...` that names a whole
-- hierarchy (its top-level account and every descendant) moves it: every row
-- still finds its parent at the end of the statement, and no row is left
-- referencing the old key. kasuwa_app can do that for any two programmes its
-- session reaches. The contract has no programmeId on UpdateAccountRequest,
-- and T-0055's PATCH must not accept one: moving a record between BPO
-- clients is a deliberate operation, never a field edit (D-L76 tracks
-- closing this in the schema). The hierarchy itself is unharmed by such a
-- move: depth and acyclicity do not change, and nothing in the target
-- programme can reference the moved rows before they commit.
--
-- ON DELETE / ON UPDATE of the parent FK: RESTRICT, both (D-L74, corrected).
--   - Why not NO ACTION, the default: NO ACTION accepts a referenced key that
--     is replaced within the same statement, because it checks only that SOME
--     row holds the key at the end. That lets one statement re-point every
--     child of A at another row without touching parent_account_id, so the
--     hierarchy guard (which watches parent_account_id) never fires. The
--     migration review committed a real cycle and a depth-7 chain that way:
--       UPDATE account SET id = CASE id WHEN A THEN <fresh> ELSE A END
--        WHERE id IN (A, C);
--     and the same with a writable CTE that deletes A and gives C its id.
--     RESTRICT refuses the change or delete of a key that a child still
--     references, whatever else the statement does, so both are refused.
--   - RESTRICT does not break offboarding: a tenant or programme delete
--     cascades into account through the RI machinery, which queues the
--     RESTRICT checks until the cascade has removed the children too, so
--     parent and child go together. A multi-row DELETE naming a parent and
--     its children succeeds for the same reason. (0019's header says the
--     opposite of RESTRICT; that reasoning was wrong, and 0019's
--     contact_account_same_programme_fk has the rotation exposure, D-L76.)
--   - Belt and braces: account.id is immutable for kasuwa_app (a BEFORE
--     UPDATE trigger, app.guard_account_id_fixed(), 42501), so the
--     application role cannot rotate an account id at all. That also closes
--     the account side of contact_account_same_programme_fk for that role.
--     The migrator may still correct an id; RESTRICT still guards the
--     hierarchy for it. Both identities are tested, as in 0023 and 0025, so a
--     SET ROLE from an app connection is still guarded.
--   - What should happen to children when a parent is deleted stays open
--     (D-L61); refusing is the answer that loses nothing.
-- The owner FK stays NO ACTION, as 0019's on contact: "user".id is not
-- writable by kasuwa_app (0015's column grants), so the rotation does not
-- apply, and no guard depends on it.
--
-- ---------------------------------------------------------------------------
-- VALUES
-- ---------------------------------------------------------------------------
--   - tier is a CHECK, not an enum type, for 0019's reason: changing the set is
--     a DROP/ADD CONSTRAINT in a new migration, which works inside the
--     runner's transaction. Codes only; P04's labels are i18n strings.
--   - tags: as contact_tags_no_null_element_check, but NOT NULL DEFAULT '{}'
--     (the contract never sends tags as null).
--   - phones (D-L74): the DATABASE checks the contract's `Phone` shape,
--     because this task has no API layer and an import or a script would
--     otherwise store a number screen-pop cannot match. app.is_phone_list()
--     accepts a JSON array whose every element is an object with exactly the
--     keys `type` (one of mobile, work, home, other) and `e164` (a string
--     matching the contract's ^\+[1-9][0-9]{6,14}$, written with [+] below
--     so it does not depend on standard_conforming_strings). Extra keys are
--     refused: the contract's Phone is closed (additionalProperties: false),
--     and a key stored here would be served back by T-0055 in breach of it.
--       The CHECK is `phones = '[]' OR app.is_phone_list(phones)`. The empty
--     list, which every existing row holds when this file runs and most rows
--     will hold afterwards, is accepted by a built-in comparison without
--     calling the function. The function is plpgsql, not SQL: a SQL function
--     with a subquery cannot be inlined, and the review measured it at about
--     33 us/row. See LOCK IMPACT for the numbers.
--       The function is IMMUTABLE and its rules are literals. Changing them
--     (a new phone type, a DND flag per number) is a new migration that
--     replaces the function AND re-validates the constraint, and it MUST do
--     so as ADD CONSTRAINT ... NOT VALID in an ordinary migration, then
--     VALIDATE CONSTRAINT (SHARE UPDATE EXCLUSIVE: reads and writes carry on)
--     in a following `-- kasuwa:no-transaction` file. By then rows hold real
--     phone lists and a validating ADD would hold ACCESS EXCLUSIVE for the
--     whole scan. CREATE OR REPLACE alone does not re-check stored rows.
--     Not SECURITY DEFINER; reads no table. CHECK evaluation runs as the
--     writer, so kasuwa_app needs EXECUTE.
--     contact.phones still has no database check (the API enforces it); the
--     function is written so contact could adopt it later.
--
-- ---------------------------------------------------------------------------
-- THE HIERARCHY GUARD (D-L74: no cycle, depth at most 5)
-- ---------------------------------------------------------------------------
-- A top-level account is depth 1; the deepest account may be depth 5.
--   - Self-parent: a CHECK (parent_account_id <> id), so it never reaches the
--     trigger.
--   - Everything else: app.guard_account_hierarchy(), an AFTER ROW trigger on
--     INSERT (when a parent is set) and on UPDATE OF parent_account_id (when it
--     changes to a non-null value). Clearing a parent can create neither a
--     cycle nor extra depth, so it is not checked.
--   - AFTER, not BEFORE: AFTER ROW triggers fire at the END of the statement,
--     so the walk sees every row the same statement wrote. That is what
--     refuses a two-row UPDATE that swaps parents, a two-row INSERT whose rows
--     name each other, and a multi-row INSERT of a chain listed child-first.
--   - The walk goes UP from the new parent, at most 5 rows, refusing if it
--     meets the row itself (a cycle) or passes depth 5. It then goes DOWN from
--     the row, at most 5 levels, to count the height of the subtree that moved
--     with it: depth(row) + height(subtree) - 1 must stay <= 5. Both walks are
--     bounded, so even a corrupt chain cannot loop or exhaust the stack.
--   - It refuses with SQLSTATE 23514 (check_violation) and the constraint name
--     `account_hierarchy`, so T-0055 can map it. Messages name the rule, never
--     an id or a name.
--   - The FK triggers (RI_ConstraintTrigger_*) sort before this trigger's
--     lower-case name and so fire first: an unknown or unreachable parent is
--     always the FK's 23503, never this guard's error, and the guard can rely
--     on every parent it walks to exist. If a row on the chain is nevertheless
--     not visible, the guard fails closed (refuses).
--   - It runs for EVERY role. kasuwa_migrator is BYPASSRLS but not exempt from
--     triggers. As kasuwa_app the walk is under RLS, which hides nothing it
--     needs: the parent and every descendant are in the row's own programme
--     (the composite key), and the writer must reach that programme to have
--     written the row at all (the policy's WITH CHECK). So no SECURITY DEFINER
--     (CLAUDE.md 2.7): the census stays at two.
--   - It watches parent_account_id only. A statement that re-points children
--     WITHOUT writing that column (by handing a parent's id to another row)
--     is what the RESTRICT parent FK and the immutable account.id stop: see
--     KEYS. The guard is sound only together with them.
--
-- CONCURRENCY: how two transactions are stopped from each adding half a cycle.
--   A walk that only reads committed rows cannot see a concurrent, uncommitted
--   half: T1 sets R1 -> R2, T2 sets R2 -> R1, each walk passes, both commit.
--   So before walking, the guard takes a TRANSACTION-SCOPED ADVISORY LOCK keyed
--   on the row's programme (two-key form: namespace 0x4b414348, ASCII 'KACH',
--   and hashtext(programme_id)). Every write that can lengthen or close a chain
--   in a programme takes the same lock, and holds it until COMMIT or ROLLBACK.
--     - The second writer blocks in its trigger until the first has finished.
--       Postgres marks a transaction committed (visible to new snapshots)
--       BEFORE it releases that transaction's locks, so when the second
--       writer is granted the lock, the first one's commit is already visible.
--     - In READ COMMITTED every query in a VOLATILE plpgsql function takes a
--       fresh snapshot, so the walk, which starts after the lock is granted,
--       sees the first writer's committed parent and refuses the cycle (or the
--       extra depth). If the first writer rolled back, there is nothing to see.
--     - So two commits "at the same instant" cannot both have passed the guard:
--       the checks are serialised by the lock, and each check runs against
--       everything committed before it. There is no window between one
--       writer's check and its commit in which another writer's check can run.
--   Why this lock and not another:
--     - Row locks on the chain (SELECT ... FOR SHARE) catch the cycle but not
--       depth: a child inserted under a leaf of a subtree that is moving
--       concurrently touches no row the mover locks. A per-programme lock
--       covers every shape, simply.
--     - A lock on the programme row would need UPDATE on programme for
--       kasuwa_app, and FOR UPDATE would also block every insert that checks a
--       FK against that programme.
--     - Per PROGRAMME, not per tenant: hierarchies never cross a programme, so
--       there is nothing to serialise across one, and a tenant-wide lock would
--       let one BPO client's writes delay (and so be timed by) another's.
--       hashtext() may map two programmes to one key; that only serialises
--       them, it never weakens the check.
--     - Only writes that set a parent take it. Plain inserts of top-level
--       accounts, and every update that leaves parent_account_id alone, never
--       wait.
--   Isolation level: the argument above needs a fresh snapshot after the
--   lock. REPEATABLE READ and SERIALIZABLE keep the transaction's first
--   snapshot, so a second writer there could miss the first one's commit. The
--   guard therefore refuses a hierarchy write outside READ COMMITTED (the
--   Postgres default and what withTenantTransaction uses) with SQLSTATE 0A000
--   and a message saying so, rather than check against a stale view.
--   Deadlocks: a transaction that sets parents in two programmes, against one
--   doing the reverse, can deadlock; Postgres detects it and aborts one
--   (40P01). Nothing in the application does that today.
--
-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------
--   - account_name_keyset_idx (tenant_id, programme_id, name, id): the keyset
--     for listAccounts' default sort=name (T-0055). Plain `name`, the
--     database collation; the account_keyset_idx of 0019 stays for
--     sort=createdAt.
--   - account_owner_idx (tenant_id, owner_user_id), partial on a set owner:
--     "my accounts", and the FK lookup if a user is ever deleted. Same shape
--     as contact_owner_idx.
--   - account_parent_idx (tenant_id, programme_id, parent_account_id),
--     partial on a set parent: the guard's downward walk, and the FK lookup
--     when a parent is deleted or re-keyed.
--
-- ---------------------------------------------------------------------------
-- METADATA (catalogue recipe in packages/db/src/standard-object-catalogue.ts)
-- ---------------------------------------------------------------------------
--   - PRE-CHECK FIRST (D-P24, recipe step 2): if any tenant already has a
--     CUSTOM field on its `account` object named like one of the eight, this
--     file stops before changing anything, naming the object, each clashing
--     field and the number of tenants. A custom field cannot silently become
--     standard (0025's trigger refuses it), and which one wins is a human
--     decision. A custom field of the same name on another object (say
--     contact.industry) is not a clash. Messages carry catalogue names and
--     counts only, never tenant data.
--   - BACKFILL: the eight standard field_defs, is_custom = false, on every
--     tenant's standard `account` object, as kasuwa_migrator (BYPASSRLS, so
--     every tenant). The jsonb literal below is this file's frozen copy of the
--     catalogue's eight new account entries; the seed and provisioning write
--     the same rows from STANDARD_OBJECT_CATALOGUE through
--     ensureStandardObjectDefs, and the T-0054 suite asserts all three agree.
--     ON CONFLICT DO NOTHING: after the pre-check, a row that is already there
--     is a STANDARD one (a tenant provisioned by the new release before this
--     file ran), and the proof below checks it has the catalogue's meaning.
--   - PROOF (recipe step 4): every tenant has every new field, standard, with
--     the catalogue's type, config and is_required and at least its
--     classification; and no standard field on `account` falls outside
--     {name} plus the eight.
--   - Classification: phones is `pii` (D-L74: a sole trader's number is
--     personal data); owner_user_id is a staff id, `none`, as on contact.
--   - Types follow the catalogue's rules: enumerated and free values are
--     `text`; owner_user_id is `text` (there is no `user` object definition);
--     parent_account_id is a real `lookup` to `account`.
--   - DEPLOY WINDOW: as 0025. A tenant provisioned by the previous release
--     between migrate and rollout gets no rows for these fields; after
--     rollout, call ensureStandardObjectDefs for every tenant (idempotent).
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
-- No populated cell exists yet (D-L65, D-L74), so this file uses plain DDL:
--   - object_def and field_def: ACCESS EXCLUSIVE for the whole file, as 0025
--     (catalogue tables, dozens of rows per tenant).
--   - account: ACCESS EXCLUSIVE for the whole file. The ADD COLUMNs are
--     metadata-only (constant defaults, no rewrite), but each new CHECK and
--     FK is validated by reading every account row, and the three indexes are
--     built by scanning it, all while that lock is held: reads and writes of
--     accounts wait for the rest of the file.
--   - "user": SHARE ROW EXCLUSIVE, taken up front, for the whole file (it is
--     what adding the owner FK takes anyway). It blocks writes to "user",
--     such as sign-in bookkeeping, not reads.
--   - How long, measured at 2M account rows (PG16 container, en_US.utf8,
--     ten programmes):
--       * the migration review, with the first version of this file: about
--         53 s under ACCESS EXCLUSIVE, about 48 s of it the phones CHECK (a
--         SQL function with a subquery, about 33 us/row);
--       * this version, on the builder's host: the whole ALTER TABLE (eight
--         columns, two FKs, four CHECKs) 0.6 s, of which the phones CHECK is
--         negligible, because every existing row holds '[]' and the CHECK
--         accepts that without calling the function. The first version's
--         CHECK took 11.8 s on the same host, so the review's 48 s scales to
--         about 1 s or less here;
--       * account_name_keyset_idx 12.7 s (a text sort under the database
--         collation), the owner and parent indexes 0.5 s together;
--       * in all about 14 s on this host, now dominated by the name index.
--     When phone lists are real (two numbers a row), the plpgsql function
--     costs about 11 us/row on this host (23 s at 2M rows, against 29 s for
--     the SQL version). That is why a later change to the phone rules must
--     go NOT VALID, then VALIDATE in a no-transaction file (VALUES).
--   - lock_timeout = 5s: the file fails fast instead of queueing behind a long
--     transaction (and making everything behind it queue too).
--   - At volume (the first populated cell onward) this would be split: the
--     CHECKs and FKs added NOT VALID here, then VALIDATE CONSTRAINT (SHARE
--     UPDATE EXCLUSIVE) and CREATE INDEX CONCURRENTLY in a following
--     `-- kasuwa:no-transaction` file. This file does not split the phones
--     CHECK: inside one transaction NOT VALID then VALIDATE would hold the
--     same ACCESS EXCLUSIVE, and the empty-list short-circuit already makes
--     its validation as cheap as a built-in check.
-- Steady-state cost: the guard runs only on writes that set a parent, reads
-- at most ten rows by key, and serialises only such writes, per programme.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied: it is one transaction and the
-- runner records it only on COMMIT. Fix the cause (a clash: rename or delete
-- the tenant's custom field, a human decision) and run `pnpm db:migrate` again.
-- To undo it after it has applied: never edit or delete this file or its
-- ledger row (append-only). Instead:
--   1. roll back the application first (T-0055 reads these columns), and the
--      catalogue entries in standard-object-catalogue.ts;
--   2. export the values of the eight columns if they hold data; dropping
--      them loses it;
--   3. in a NEW migration, as kasuwa_migrator: DROP TRIGGER
--      account_hierarchy_guard_insert, account_hierarchy_guard_update and
--      account_id_fixed; DROP FUNCTION app.guard_account_hierarchy() and
--      app.guard_account_id_fixed() (keep the id guard if D-L76's follow-up
--      has come to rely on it); DROP INDEX the three indexes;
--      ALTER TABLE account DROP COLUMN the eight (their constraints and FKs
--      go with them); DROP FUNCTION app.is_phone_list(jsonb); DELETE the eight
--      standard field_defs on `account` (their field_security_grant rows go
--      with them; the restrictive delete policy binds kasuwa_app only).
--
-- NO NEW TABLES, NO SECURITY DEFINER. account keeps RLS ENABLED and FORCED and
-- its 0019 policy; TENANT_SCOPED_TABLES is unchanged.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
LOCK TABLE object_def, field_def IN ACCESS EXCLUSIVE MODE;
LOCK TABLE account IN ACCESS EXCLUSIVE MODE;
-- What the owner FK takes anyway; taken here so every lock is in this order.
LOCK TABLE "user" IN SHARE ROW EXCLUSIVE MODE;

-- --- 2. the clash pre-check, before anything changes (D-P24) -----------------
DO $$
DECLARE
  new_fields constant text[] := ARRAY[
    'owner_user_id', 'industry', 'tier', 'tags', 'phones', 'state', 'lga', 'parent_account_id'
  ];
  clashes text;
BEGIN
  SELECT pg_catalog.string_agg(c.api_name || ' in ' || c.tenants || ' tenant(s)', '; '
                               ORDER BY c.api_name)
    INTO clashes
    FROM (
      SELECT f.api_name, pg_catalog.count(DISTINCT f.tenant_id) AS tenants
        FROM public.field_def f
        JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
       WHERE o.api_name = 'account'
         AND f.is_custom
         AND f.api_name = ANY (new_fields)
       GROUP BY f.api_name
    ) AS c;
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION '0026: custom field(s) on object account clash with new standard account fields: %. Nothing was applied. Rename or remove each custom field (a human decision: it has its own meaning and data), then re-run.', clashes;
  END IF;
END
$$;

-- --- 3. columns, keys and checks ---------------------------------------------
-- The contract's Phone, closed: see VALUES in the header. plpgsql, one
-- element at a time, returning at the first bad one; each test runs only
-- once the ones before it have established the type it needs.
CREATE FUNCTION app.is_phone_list(phones jsonb) RETURNS boolean
  LANGUAGE plpgsql
  IMMUTABLE
  PARALLEL SAFE
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  phone jsonb;
BEGIN
  IF jsonb_typeof(phones) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  FOR phone IN SELECT e.value FROM jsonb_array_elements(phones) AS e LOOP
    IF jsonb_typeof(phone) <> 'object' THEN
      RETURN false;
    END IF;
    IF (phone - 'type' - 'e164') <> '{}'::jsonb THEN
      RETURN false;  -- a key the contract does not have
    END IF;
    IF jsonb_typeof(phone -> 'type') IS DISTINCT FROM 'string'
       OR jsonb_typeof(phone -> 'e164') IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    IF (phone ->> 'type') NOT IN ('mobile', 'work', 'home', 'other') THEN
      RETURN false;
    END IF;
    IF (phone ->> 'e164') !~ '^[+][1-9][0-9]{6,14}$' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.is_phone_list(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_phone_list(jsonb) TO kasuwa_app, kasuwa_test_admin;

ALTER TABLE account
  ADD COLUMN owner_user_id      uuid,
  ADD COLUMN industry           text,
  ADD COLUMN tier               text,
  ADD COLUMN tags               text[] NOT NULL DEFAULT '{}',
  ADD COLUMN phones             jsonb  NOT NULL DEFAULT '[]',
  ADD COLUMN state              text,
  ADD COLUMN lga                text,
  ADD COLUMN parent_account_id  uuid,

  ADD CONSTRAINT account_owner_same_tenant_fk
    FOREIGN KEY (tenant_id, owner_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE NO ACTION,
  ADD CONSTRAINT account_parent_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, parent_account_id)
    REFERENCES account (tenant_id, programme_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,  -- not NO ACTION: see KEYS

  ADD CONSTRAINT account_tier_check
    CHECK (tier IN ('enterprise', 'mid_market', 'sme')),
  -- A tag list may be empty; a NULL element is never a tag.
  ADD CONSTRAINT account_tags_no_null_element_check
    CHECK (array_position(tags, NULL) IS NULL),
  -- The empty list without a function call: every row this file finds.
  ADD CONSTRAINT account_phones_shape_check
    CHECK (phones = '[]'::jsonb OR app.is_phone_list(phones)),
  -- The trigger below handles every longer cycle.
  ADD CONSTRAINT account_parent_not_self_check
    CHECK (parent_account_id <> id);

-- --- 4. indexes --------------------------------------------------------------
CREATE INDEX account_name_keyset_idx
  ON account (tenant_id, programme_id, name, id);
CREATE INDEX account_owner_idx
  ON account (tenant_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX account_parent_idx
  ON account (tenant_id, programme_id, parent_account_id) WHERE parent_account_id IS NOT NULL;

-- --- 5. the hierarchy guard --------------------------------------------------
-- VOLATILE (the default) on purpose: each query below must take a fresh
-- snapshot after the lock is granted. See CONCURRENCY in the header.
CREATE FUNCTION app.guard_account_hierarchy() RETURNS trigger
  LANGUAGE plpgsql
  VOLATILE
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  max_depth constant integer := 5;
  -- ASCII 'KACH': Kasuwa account hierarchy. Two-key advisory locks do not
  -- share a key space with one-key ones (the runner, provisioning).
  lock_namespace constant integer := 1262568264;
  cursor_id uuid;
  depth integer := 1;
  height integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'account hierarchy changes must run in READ COMMITTED: the hierarchy check needs to see transactions that commit while it waits'
      USING ERRCODE = 'feature_not_supported';  -- 0A000
  END IF;

  -- Serialise every parent-setting write in this programme until COMMIT.
  PERFORM pg_catalog.pg_advisory_xact_lock(lock_namespace,
                                           pg_catalog.hashtext(NEW.programme_id::text));

  -- Up: the row's depth, refusing a cycle back to the row itself.
  cursor_id := NEW.parent_account_id;
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'account hierarchy: an account cannot be its own ancestor'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'account_hierarchy';
    END IF;
    depth := depth + 1;
    IF depth > max_depth THEN
      RAISE EXCEPTION 'account hierarchy: deeper than % levels', max_depth
        USING ERRCODE = 'check_violation', CONSTRAINT = 'account_hierarchy';
    END IF;
    SELECT a.parent_account_id
      INTO cursor_id
      FROM public.account a
     WHERE a.tenant_id = NEW.tenant_id
       AND a.programme_id = NEW.programme_id
       AND a.id = cursor_id;
    IF NOT FOUND THEN
      -- The FK has already passed, so this is not reachable through a valid
      -- write; refuse rather than accept what could not be checked.
      RAISE EXCEPTION 'account hierarchy: the parent chain could not be verified'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'account_hierarchy';
    END IF;
  END LOOP;

  -- Down: the height of the subtree that hangs from the row (1 = no
  -- children). Bounded: it reads one level past what would still fit, which
  -- is enough to refuse, and never more.
  WITH RECURSIVE below (id, level) AS (
    SELECT NEW.id, 1
    UNION ALL
    SELECT c.id, b.level + 1
      FROM below b
      JOIN public.account c
        ON c.tenant_id = NEW.tenant_id
       AND c.programme_id = NEW.programme_id
       AND c.parent_account_id = b.id
     WHERE b.level <= max_depth - depth + 1
  )
  SELECT pg_catalog.max(b.level) INTO height FROM below b;

  IF depth + height - 1 > max_depth THEN
    RAISE EXCEPTION 'account hierarchy: deeper than % levels', max_depth
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_hierarchy';
  END IF;

  RETURN NULL;  -- AFTER trigger: the return value is ignored.
END;
$$;
-- Only the triggers call it; firing a trigger needs no EXECUTE.
REVOKE ALL ON FUNCTION app.guard_account_hierarchy() FROM PUBLIC;

CREATE TRIGGER account_hierarchy_guard_insert
  AFTER INSERT ON account
  FOR EACH ROW
  WHEN (NEW.parent_account_id IS NOT NULL)
  EXECUTE FUNCTION app.guard_account_hierarchy();

CREATE TRIGGER account_hierarchy_guard_update
  AFTER UPDATE OF parent_account_id ON account
  FOR EACH ROW
  WHEN (NEW.parent_account_id IS NOT NULL
        AND NEW.parent_account_id IS DISTINCT FROM OLD.parent_account_id)
  EXECUTE FUNCTION app.guard_account_hierarchy();

-- --- 6. account.id is fixed for the application role ------------------------
-- See KEYS: with the RESTRICT parent FK, this is what stops a statement from
-- re-pointing children by handing a parent's id to another row. Both
-- identities are tested, as in 0023 and 0025, so SET ROLE from an app
-- connection stays guarded; every other role passes through (the migrator may
-- still correct an id, and RESTRICT still guards the hierarchy for it).
CREATE FUNCTION app.guard_account_id_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'kasuwa_app' OR session_user = 'kasuwa_app' THEN
    RAISE EXCEPTION 'account.id is fixed at creation and cannot be changed by the application role'
      USING ERRCODE = 'insufficient_privilege';  -- 42501, as 0023 and 0025
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_account_id_fixed() FROM PUBLIC;

-- BEFORE, so the row is refused before any FK or hierarchy check runs. Fires
-- for every row of a bulk UPDATE and for the DO UPDATE arm of an upsert.
CREATE TRIGGER account_id_fixed
  BEFORE UPDATE OF id ON account
  FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id)
  EXECUTE FUNCTION app.guard_account_id_fixed();

-- --- 7. the standard field_defs: backfill, then prove ------------------------
DO $$
DECLARE
  -- Frozen copy of the eight new `account` entries of
  -- STANDARD_OBJECT_CATALOGUE (packages/db/src/standard-object-catalogue.ts).
  new_fields constant jsonb := '[
    {"api_name": "owner_user_id",     "label": "Owner",          "type": "text",   "classification": "none", "is_required": false, "config": {}},
    {"api_name": "industry",          "label": "Industry",       "type": "text",   "classification": "none", "is_required": false, "config": {}},
    {"api_name": "tier",              "label": "Tier",           "type": "text",   "classification": "none", "is_required": false, "config": {}},
    {"api_name": "tags",              "label": "Tags",           "type": "text",   "classification": "none", "is_required": false, "config": {}},
    {"api_name": "phones",            "label": "Phones",         "type": "phone",  "classification": "pii",  "is_required": false, "config": {}},
    {"api_name": "state",             "label": "State",          "type": "text",   "classification": "none", "is_required": false, "config": {}},
    {"api_name": "lga",               "label": "LGA",            "type": "text",   "classification": "none", "is_required": false, "config": {}},
    {"api_name": "parent_account_id", "label": "Parent account", "type": "lookup", "classification": "none", "is_required": false, "config": {"targetObjectApiName": "account"}}
  ]';
  -- Every standard field `account` may carry after this file.
  account_standard constant text[] := ARRAY[
    'name', 'owner_user_id', 'industry', 'tier', 'tags', 'phones', 'state', 'lga',
    'parent_account_id'
  ];
  classification_rank constant text[] := ARRAY['none', 'pii', 'sensitive'];
  affected_tenants bigint;
  stray_rows bigint;
  problem text;
BEGIN
  INSERT INTO public.field_def
    (id, tenant_id, object_id, api_name, label, type, classification, is_required, is_custom, config)
  SELECT gen_random_uuid(), o.tenant_id, o.id, f.api_name, f.label, f.type, f.classification,
         f.is_required, false, f.config
    FROM public.object_def o
   CROSS JOIN jsonb_to_recordset(new_fields)
           AS f (api_name text, label text, type text, classification text,
                 is_required boolean, config jsonb)
   WHERE o.api_name = 'account' AND NOT o.is_custom
  ON CONFLICT (tenant_id, object_id, api_name) DO NOTHING;

  -- A tenant with no standard `account` object got no fields above (a tenant
  -- provisioned by a release before 0025's, in its deploy window). Say so
  -- with the remedy, rather than as a missing field. Counts only.
  SELECT pg_catalog.count(*)
    INTO affected_tenants
    FROM public.tenant t
   WHERE NOT EXISTS (
           SELECT 1 FROM public.object_def o
            WHERE o.tenant_id = t.id AND o.api_name = 'account' AND NOT o.is_custom);
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0026: % tenant(s) have no standard account object, so they cannot be given the new account fields. Nothing was applied. Run ensureStandardObjectDefs (packages/db) for each of those tenants, as kasuwa_migrator, then re-run.',
      affected_tenants;
  END IF;

  -- Every tenant has every new field: standard, on its standard account
  -- object, with the catalogue's meaning and at least its classification.
  SELECT pg_catalog.count(DISTINCT t.id),
         pg_catalog.string_agg(DISTINCT 'account.' || c.api_name, ', ')
    INTO affected_tenants, problem
    FROM public.tenant t
   CROSS JOIN jsonb_to_recordset(new_fields)
           AS c (api_name text, type text, classification text, is_required boolean, config jsonb)
   WHERE NOT EXISTS (
           SELECT 1
             FROM public.field_def f
             JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
            WHERE f.tenant_id = t.id
              AND o.api_name = 'account' AND NOT o.is_custom
              AND f.api_name = c.api_name AND NOT f.is_custom
              AND f.type = c.type
              AND f.config = c.config
              AND f.is_required = c.is_required
              AND pg_catalog.array_position(classification_rank, f.classification)
               >= pg_catalog.array_position(classification_rank, c.classification));
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0026 backfill incomplete: % tenant(s) lack or mis-type the standard field(s) %',
      affected_tenants, problem;
  END IF;

  -- Nothing standard on `account` that the catalogue does not name. Names
  -- here are tenant data: counts only.
  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT f.tenant_id)
    INTO stray_rows, affected_tenants
    FROM public.field_def f
    JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE o.api_name = 'account' AND NOT o.is_custom
     AND NOT f.is_custom
     AND f.api_name <> ALL (account_standard);
  IF stray_rows > 0 THEN
    RAISE EXCEPTION '0026: % standard account field_def row(s) in % tenant(s) are not in the standard catalogue; mark them custom or remove them, then re-run',
      stray_rows, affected_tenants;
  END IF;
END
$$;
