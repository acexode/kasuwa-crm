-- ---------------------------------------------------------------------------
-- 0036 - the pipeline and deal tables, and a default pipeline per programme
-- (T-0106, Agent 3; D-L65, D-L76, D-L88, D-L113, D-L115, D-L117, D-P33).
--
-- Six programme-scoped tables in the 0027 pattern, the rules the schema can
-- hold, the standard `deal` object, and the default pipeline for every
-- programme that already exists. In this one file:
--
--   1. locks, taken up front in a fixed order;
--   2. the clash pre-check (the catalogue recipe), BEFORE anything changes;
--   3. the six tables, their keys, checks, indexes, RLS and grants;
--   4. their triggers: updated_at (0018), version (0019), the key guard
--      (D-L76), the stage rules, the move rule (R5) and the check rule (R7);
--   5. the standard `deal` object_def and its field_defs for every existing
--      tenant, and the proof;
--   6. the default pipeline for every existing programme (R11), and the proof;
--   7. a self-check of the security posture, including the LEAKPROOF check.
-- One transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- NOT HERE: the API (T-0107, T-0108), activity.deal_id (T-0111), a pipeline
-- configuration write (waits for the pipeline.write contract), deal deletion.
--
-- ---------------------------------------------------------------------------
-- TABLES (columns pinned by the T-0106 suite, R1)
-- ---------------------------------------------------------------------------
--   pipeline                   a programme's pipeline. name 1..100. version and
--                              updated_at are maintained by triggers.
--   pipeline_stage             kind open | won | lost; position 0..99, unique
--                              in its pipeline; probability_bp 0..10000 (won
--                              10000, lost 0); rotting_after_days 2..365 on an
--                              open stage (DEFAULT 14), NULL on won and lost.
--   pipeline_stage_transition  the move allow-list: (from, to) once per
--                              pipeline, never a stage to itself.
--   pipeline_stage_requirement kind field | check. A field requirement names a
--                              deal field_def api_name (R2: amount,
--                              expected_close_date, next_step,
--                              primary_contact_id, account_id; the contract's
--                              DealRequirementField, snake_case) and no label;
--                              a check requirement has a label of 1..200 and
--                              no field. position 0..19, unique per stage: at
--                              most 20 requirements per stage (R4), held by
--                              the key and a CHECK rather than a count.
--   deal                       amount_minor bigint 0..999999999999999999
--                              (D-L121; a fraction is refused, never rounded)
--                              and currency
--                              NGN | GHS | KES | ZAR (D-L115), both set or both
--                              NULL (R6); name 1..200; next_step 1..200 when
--                              set. name and next_step are free text that holds
--                              names in practice: classified pii (D-L115),
--                              never logged.
--   deal_requirement_check     who ticked a check requirement, and when. Once
--                              per deal and requirement (R7).
--
-- Every table carries pipeline_id (except pipeline itself), so composite FKs,
-- not triggers, keep each row in its pipeline: a stage, a transition's two
-- stages, a requirement's stage, a deal's stage, a check's deal and its
-- requirement all match on (tenant_id, programme_id, pipeline_id, id).
--
-- ---------------------------------------------------------------------------
-- RULES THE SCHEMA HOLDS (and the ones it leaves to the API)
-- ---------------------------------------------------------------------------
--   - EXACTLY ONE won and ONE lost stage, AT LEAST ONE open stage, AT MOST 30
--     stages per pipeline. Two partial unique indexes refuse a second won or
--     lost stage at once; a DEFERRABLE INITIALLY DEFERRED constraint trigger,
--     app.check_pipeline_stage_rules(), checks the counts at COMMIT (or at
--     SET CONSTRAINTS ... IMMEDIATE), on pipeline INSERT and on every stage
--     INSERT, UPDATE and DELETE. Deferred because a pipeline and its stages are
--     written by several statements, and no single row is wrong on its own.
--     It binds every role, the migrator included (BYPASSRLS bypasses no
--     trigger). A pipeline that no longer exists (a cascade) is skipped.
--   - R5, "stage_id changes only through the move path": the part the schema
--     can hold. A BEFORE UPDATE trigger, app.guard_deal_stage_move(), refuses
--     a stage change that is not a transition of the deal's own pipeline, for
--     every role but kasuwa_migrator (the allow-list, as the key guard, so the
--     migrator can correct data). Requirements, rights, closed_at and
--     stage_entered_at on a move are the API's (T-0108).
--   - R7: a check names only a `check` requirement of the deal's own pipeline
--     (the composite FK holds the pipeline, a BEFORE trigger the kind);
--     kasuwa_app may INSERT a check but never UPDATE or DELETE it.
--   - Left to the API (the suite header, "THE BUILDER'S"): closed_at agreeing
--     with the stage kind, the first open stage having no requirements, and a
--     deal's owner being a member of its programme (D-L67, as for contacts).
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3, D-L76)
-- ---------------------------------------------------------------------------
-- Every FK to a tenant-scoped row carries tenant_id, and every FK to a
-- programme-scoped row also carries programme_id: referential checks ignore
-- row security, so only the key keeps a row in its programme. A real A2
-- contact and an invented id fail the same FK with the same message (no
-- existence oracle across the BPO boundary).
--
-- UNIQUE KEYS (D-L120): every unique key and unique index but the primary key
-- leads with (tenant_id, programme_id), and on the five tables below pipeline
-- with (tenant_id, programme_id, pipeline_id). A unique check, like an FK
-- check, ignores row security, and a non-deferrable one fires at the row,
-- before the FK's end-of-statement check.
-- A key on (pipeline_id, ...) alone let a kasuwa_app INSERT that names
-- another tenant's pipeline under its own tenant and programme collide with
-- that tenant's stages (23505) when the pipeline exists, and reach the FK
-- (23503) when it does not: an existence oracle. Led by the row's own tenant
-- and programme, no key can collide with another tenant's or programme's row,
-- so both reach the same FK with the same error. Section 7 checks the
-- leading columns.
--
-- ON UPDATE RESTRICT on EVERY FK (D-L76): NO ACTION accepts a one-statement
-- id rotation that re-points a deal at another row. RESTRICT also refuses
-- moving a contact or account that has deals to another programme.
-- ON DELETE:
--   - tenant and programme FKs: CASCADE (offboarding, as kasuwa_migrator);
--   - inside the configuration (stage -> pipeline, transition and requirement
--     -> stage) and check -> deal: CASCADE, so removing a pipeline or a deal
--     removes its parts. Only the migrator can delete any of these;
--   - deal -> stage and check -> requirement: RESTRICT. A stage that holds
--     deals, or a requirement that has been ticked, cannot vanish silently;
--   - deal -> contact, account and owner, check -> user: RESTRICT, never
--     CASCADE (R8): deleting a contact never silently deletes a deal (D-P27's
--     sweeper decides).
--   - RESTRICT does not break offboarding: a programme or tenant delete
--     reaches every one of these tables through its own CASCADE FK, and the
--     RESTRICT checks queued by the cascaded deletes run after those cascades
--     (as 0026 and 0027 explain). The T-0106 suite deletes a programme and
--     then a tenant holding all six kinds of row, as kasuwa_migrator.
--
-- THE KEYS ARE FIXED (D-L76, the allow-list form): app.guard_pipeline_keys_fixed()
-- raises 42501 unless BOTH current_user and session_user are kasuwa_migrator,
-- on a change of:
--   pipeline                    id, tenant_id, programme_id
--   pipeline_stage              id, tenant_id, programme_id, pipeline_id
--   pipeline_stage_transition   id, tenant_id, programme_id, pipeline_id,
--                               from_stage_id, to_stage_id
--   pipeline_stage_requirement  id, tenant_id, programme_id, pipeline_id,
--                               stage_id, kind (a ticked check must stay a check)
--   deal                        id, tenant_id, programme_id, pipeline_id
--   deal_requirement_check      every column but checked_at's default: id,
--                               tenant_id, programme_id, pipeline_id, deal_id,
--                               requirement_id, checked_by_user_id, checked_at
-- kasuwa_app, kasuwa_test_admin (BYPASSRLS) and any role created later are
-- refused; a superuser session too. kasuwa_app also holds no UPDATE on any of
-- those columns (TENANCY), so its statement fails on the privilege first. The
-- guard reads no table and only compares: SECURITY INVOKER, pinned
-- search_path, EXECUTE revoked (firing a trigger needs none). Not a SECURITY
-- DEFINER (CLAUDE.md 2.7): the census stays at two.
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   - RLS ENABLED and FORCED on all six; each has ONE policy, FOR ALL, naming
--     app.current_tenant_id() and app.current_programme_ids(), with WITH CHECK
--     identical to USING; all six are in TENANT_SCOPED_TABLES.
--   - deal and deal_requirement_check: tenant AND programme in scope, exactly
--     as activity.
--   - THE FOUR CONFIGURATION TABLES add 0015's creation marker to the same
--     policy (R9, D-L117): tenant AND (programme in scope OR the programme was
--     created by THIS transaction). Why: createProgramme runs as kasuwa_app in
--     the admin API, inside a transaction whose scope was resolved before the
--     programme existed, and it must leave the new programme with its default
--     pipeline when it commits. Neither a SECURITY DEFINER function nor a
--     tenant-wide policy is used. The marker is 0015's, verbatim:
--         p.xmin = pg_current_xact_id_if_assigned()::xid
--         AND p.created_at >= date_trunc('milliseconds', transaction_timestamp())
--     read through programme's own RLS (0015's
--     programme_visible_to_creating_transaction). What it admits, and why it
--     admits nothing new: a row version of programme carries this
--     transaction's xid only if this transaction INSERTED it (0012 holds that
--     to the session's tenant) or UPDATED it (which needs the programme in
--     scope already, under programme's FOR ALL policy). So the marker branch
--     names the programme this transaction just created, or one the session
--     already reaches; never an existing out-of-scope programme. The
--     created_at term rules out a frozen pre-wraparound row (0015's
--     argument). An INSERT made in a SAVEPOINT carries the subtransaction's
--     xid and fails closed. deal and deal_requirement_check do NOT get the
--     branch: nothing creates a deal in the transaction that creates its
--     programme.
--     No permissive FOR INSERT policy is added (the permissions suite's
--     allow-list is unchanged): each table keeps one FOR ALL policy.
--   - GRANTS (G; T-0105 R13 has no configuration write and no deal deletion):
--       kasuwa_app: SELECT on all six; INSERT on all six (the configuration
--         tables for createProgramme's default pipeline, R9; deal and check for
--         T-0108); UPDATE on deal, column-level (never the keys, pipeline_id or
--         created_at); NO UPDATE on the configuration tables or on checks ("a
--         recorded check stays recorded"); NO DELETE anywhere and no TRUNCATE.
--         REVOKE rather than a restrictive policy: 42501 on the statement,
--         decided by the table and never by the row (the delete-guard
--         suite's recommendation).
--       kasuwa_test_admin: full DML (test only).
--       The owner is kasuwa_migrator (it creates the tables).
--
-- ---------------------------------------------------------------------------
-- INDEXES (D-P33: plain columns only; LEAKPROOF is checked, never set)
-- ---------------------------------------------------------------------------
--   - deal_board_open_idx (tenant_id, programme_id, pipeline_id, stage_id,
--     stage_entered_at, id): an open column, oldest in the stage first (R14);
--     also the deal -> stage FK lookup and the programme FK lookup.
--   - deal_board_closed_idx (tenant_id, programme_id, pipeline_id, stage_id,
--     closed_at DESC, id DESC) WHERE closed_at IS NOT NULL: the won and lost
--     columns, newest first, within closedSince (R14).
--   - deal_contact_idx, deal_account_idx (tenant_id, programme_id, <fk>) and
--     deal_owner_idx (tenant_id, owner_user_id), partial on NOT NULL: the FK
--     lookups (a contact, account or user delete or re-key) and "my deals".
--   - The unique keys that are FK targets also serve the referencing side's
--     lookups (they lead with tenant_id, programme_id, pipeline_id).
--   - Every key column compared under the policies is uuid or timestamptz;
--     their btree operators are LEAKPROOF in PostgreSQL 16, which section 7
--     reads (and stops the file if one is not). No expression key and no
--     function call in any predicate; nothing here marks anything LEAKPROOF.
--
-- ---------------------------------------------------------------------------
-- METADATA (the catalogue recipe in packages/db/src/standard-object-catalogue.ts)
-- ---------------------------------------------------------------------------
--   - PRE-CHECK FIRST (R12): a tenant with a CUSTOM object named `deal` stops
--     this file before anything changes, with a message naming `deal` and the
--     number of such tenants. Look-alikes (a custom `deal_note` object, a
--     custom `deal` field on contact) are not counted. A custom field of a
--     catalogue name on a STANDARD `deal` object is counted separately.
--   - BACKFILL: one standard `deal` object_def and seven standard field_defs
--     per tenant (R13): name (text, required, pii), amount (number),
--     expected_close_date (date), owner_user_id (text, as on contact),
--     primary_contact_id (lookup to contact), account_id (lookup to account),
--     next_step (text, pii). The jsonb below is this file's frozen copy of the
--     catalogue's `deal` entry; the seed and provisioning write the same rows
--     through ensureStandardObjectDefs, and the T-0106 suite asserts all three
--     agree. `amount` is the withholdable wire field; amount_minor and
--     currency get none. id, keys, version and timestamps get none.
--   - PROOF: every tenant has the object and every field, standard, with the
--     catalogue's type, config and is_required and at least its
--     classification; nothing standard on `deal` falls outside the seven.
--   - Messages carry catalogue names and counts only, never tenant data.
--
-- ---------------------------------------------------------------------------
-- THE DEFAULT PIPELINE (D-L113, R3, R11)
-- ---------------------------------------------------------------------------
--   - Every programme that has no pipeline gets one, WHATEVER ITS STATUS
--     (active, paused, draft or archived: archived is restorable for 30 days).
--   - The template is the contract's getPipeline example ("B2B sales", seven
--     stages, its probabilities, rotting days and requirements), version 1.
--     The jsonb below is this file's frozen copy of DEFAULT_PIPELINE_TEMPLATE
--     (packages/db/src/default-pipeline.ts). Its transitions are the
--     contract's seed rule (forward one stage, back to any earlier open stage,
--     won only from the last open stage, lost from any open stage, won and
--     lost back to any open stage, no self-pair): the 30 pairs below, frozen
--     by stage position.
--   - Fresh ids for every row (gen_random_uuid()), never shared.
--   - New programmes get theirs from createProgramme (R9), and
--     ensureStandardObjectDefs repairs any programme without one (R10), e.g.
--     one created by the previous release between `pnpm db:migrate` and the
--     rollout (DEPLOY WINDOW, as 0025). Both are idempotent.
--
-- ---------------------------------------------------------------------------
-- LOCK IMPACT (D-L65)
-- ---------------------------------------------------------------------------
-- No populated cell exists yet (D-L65), so this file uses plain DDL:
--   - object_def, field_def: ACCESS EXCLUSIVE for the whole file, as 0025 to
--     0027 (catalogue tables, dozens of rows per tenant), so the pre-check runs
--     against a locked catalogue.
--   - tenant, programme, "user", contact, account: SHARE ROW EXCLUSIVE for the
--     whole file, which creating an FK that references them takes anyway. On
--     programme it also means no programme can be created between the
--     backfill's read and COMMIT, so none is left without a pipeline. Writes
--     to those tables wait; reads do not.
--   - The six tables are new and empty; the backfill writes about 45 rows per
--     programme. Well under a second for thousands of programmes.
--   - lock_timeout = 5s: fail fast rather than queue behind a long transaction.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK PLAN
-- ---------------------------------------------------------------------------
-- If this file fails, nothing was applied (one transaction, recorded only on
-- COMMIT). Fix the cause (a clash: rename or delete the tenant's custom `deal`
-- object, a human decision) and run `pnpm db:migrate` again.
-- To undo it after it has applied: never edit or delete this file or its
-- ledger row (append-only). Instead:
--   1. roll back the application first (createProgramme's default pipeline,
--      ensureStandardObjectDefs' repair, the `deal` catalogue entry, the seed's
--      SEED_DEALS, the schema.ts mirror and TENANT_SCOPED_TABLES);
--   2. export the deals if they hold data;
--   3. in a NEW migration, as kasuwa_migrator: DROP TABLE
--      deal_requirement_check, deal, pipeline_stage_requirement,
--      pipeline_stage_transition, pipeline_stage, pipeline (in that order);
--      DROP FUNCTION app.guard_pipeline_keys_fixed(),
--      app.check_pipeline_stage_rules(), app.guard_deal_stage_move(),
--      app.guard_requirement_check_kind(); DELETE the standard `deal`
--      object_def rows (their field_defs and grants cascade).
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
LOCK TABLE object_def, field_def IN ACCESS EXCLUSIVE MODE;
-- What the new FKs take anyway; taken here so every lock is in this order.
LOCK TABLE tenant, programme, "user", contact, account IN SHARE ROW EXCLUSIVE MODE;

-- --- 2. the clash pre-check, before anything changes (R12) -------------------
DO $$
DECLARE
  new_fields constant text[] := ARRAY[
    'name', 'amount', 'expected_close_date', 'owner_user_id', 'primary_contact_id', 'account_id',
    'next_step'
  ];
  custom_objects bigint;
  custom_fields bigint;
  problems text[] := ARRAY[]::text[];
BEGIN
  -- Exactly the name `deal`, exactly a custom object. Counted per tenant.
  SELECT pg_catalog.count(DISTINCT o.tenant_id)
    INTO custom_objects
    FROM public.object_def o
   WHERE o.api_name = 'deal' AND o.is_custom;

  -- A custom field of a catalogue name on a STANDARD deal object.
  SELECT pg_catalog.count(DISTINCT f.tenant_id)
    INTO custom_fields
    FROM public.field_def f
    JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE o.api_name = 'deal' AND NOT o.is_custom
     AND f.is_custom
     AND f.api_name = ANY (new_fields);

  IF custom_objects > 0 THEN
    problems := problems || pg_catalog.format(
      '%s tenant(s) already have a custom object named deal, the name of the new standard object',
      custom_objects);
  END IF;
  IF custom_fields > 0 THEN
    problems := problems || pg_catalog.format(
      '%s tenant(s) have a custom field on the standard deal object named like a new standard field',
      custom_fields);
  END IF;
  IF pg_catalog.cardinality(problems) > 0 THEN
    RAISE EXCEPTION '0036: %. Nothing was applied. Rename or remove each one (a human decision: it has its own meaning and data), then re-run.',
      pg_catalog.array_to_string(problems, '; ');
  END IF;
END
$$;

-- --- 3. the tables -------------------------------------------------------------

CREATE TABLE pipeline (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL,
  programme_id  uuid        NOT NULL,
  name          text        NOT NULL,
  -- Optimistic-concurrency counter (T-0039 pattern), maintained by
  -- pipeline_bump_version below.
  version       integer     NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pipeline_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT pipeline_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- The target of every stage's FK; also the programme FK's lookup.
  CONSTRAINT pipeline_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT pipeline_name_check CHECK (pg_catalog.char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT pipeline_version_check CHECK (version >= 1)
);

CREATE TABLE pipeline_stage (
  id                  uuid    PRIMARY KEY,
  tenant_id           uuid    NOT NULL,
  programme_id        uuid    NOT NULL,
  pipeline_id         uuid    NOT NULL,
  name                text    NOT NULL,
  kind                text    NOT NULL,
  position            integer NOT NULL,
  probability_bp      integer NOT NULL,
  rotting_after_days  integer DEFAULT 14,

  CONSTRAINT pipeline_stage_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT pipeline_stage_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT pipeline_stage_pipeline_fk
    FOREIGN KEY (tenant_id, programme_id, pipeline_id)
    REFERENCES pipeline (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- The target of the transition, requirement and deal FKs: a stage OF THIS
  -- PIPELINE. Also the pipeline FK's lookup.
  CONSTRAINT pipeline_stage_pipeline_id_key UNIQUE (tenant_id, programme_id, pipeline_id, id),
  -- Deferrable, so a later reorder can swap positions in one transaction.
  -- Leads with tenant_id, programme_id (D-L120): see UNIQUE KEYS in the header.
  CONSTRAINT pipeline_stage_position_key
    UNIQUE (tenant_id, programme_id, pipeline_id, position)
    DEFERRABLE INITIALLY IMMEDIATE,

  CONSTRAINT pipeline_stage_kind_check CHECK (kind IN ('open', 'won', 'lost')),
  CONSTRAINT pipeline_stage_name_check CHECK (pg_catalog.char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT pipeline_stage_position_check CHECK (position BETWEEN 0 AND 99),
  CONSTRAINT pipeline_stage_probability_check
    CHECK (probability_bp BETWEEN 0 AND 10000
           AND (kind <> 'won' OR probability_bp = 10000)
           AND (kind <> 'lost' OR probability_bp = 0)),
  -- CASE, not OR: an open stage with a NULL rotting_after_days must be FALSE,
  -- never NULL (a NULL CHECK passes).
  CONSTRAINT pipeline_stage_rotting_check
    CHECK (CASE WHEN kind = 'open'
                THEN rotting_after_days IS NOT NULL AND rotting_after_days BETWEEN 2 AND 365
                ELSE rotting_after_days IS NULL
           END)
);

-- At most one won and one lost stage per pipeline, refused at once; "exactly
-- one" is the deferred trigger's. Predicates are plain comparisons. Keyed on
-- (tenant_id, programme_id, pipeline_id), never pipeline_id alone (D-L120).
CREATE UNIQUE INDEX pipeline_stage_one_won_key
  ON pipeline_stage (tenant_id, programme_id, pipeline_id) WHERE kind = 'won';
CREATE UNIQUE INDEX pipeline_stage_one_lost_key
  ON pipeline_stage (tenant_id, programme_id, pipeline_id) WHERE kind = 'lost';

CREATE TABLE pipeline_stage_transition (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  programme_id   uuid NOT NULL,
  pipeline_id    uuid NOT NULL,
  from_stage_id  uuid NOT NULL,
  to_stage_id    uuid NOT NULL,

  CONSTRAINT pipeline_stage_transition_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT pipeline_stage_transition_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- Both ends are stages of the row's own pipeline.
  CONSTRAINT pipeline_stage_transition_from_fk
    FOREIGN KEY (tenant_id, programme_id, pipeline_id, from_stage_id)
    REFERENCES pipeline_stage (tenant_id, programme_id, pipeline_id, id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT pipeline_stage_transition_to_fk
    FOREIGN KEY (tenant_id, programme_id, pipeline_id, to_stage_id)
    REFERENCES pipeline_stage (tenant_id, programme_id, pipeline_id, id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  -- A pair once; also the from FK's lookup and the move rule's probe.
  CONSTRAINT pipeline_stage_transition_pair_key
    UNIQUE (tenant_id, programme_id, pipeline_id, from_stage_id, to_stage_id),
  CONSTRAINT pipeline_stage_transition_not_self_check CHECK (from_stage_id <> to_stage_id)
);

-- The to FK's lookup (a stage delete or re-key).
CREATE INDEX pipeline_stage_transition_to_idx
  ON pipeline_stage_transition (tenant_id, programme_id, pipeline_id, to_stage_id);

CREATE TABLE pipeline_stage_requirement (
  id            uuid    PRIMARY KEY,
  tenant_id     uuid    NOT NULL,
  programme_id  uuid    NOT NULL,
  pipeline_id   uuid    NOT NULL,
  stage_id      uuid    NOT NULL,
  kind          text    NOT NULL,
  position      integer NOT NULL,
  field         text,
  label         text,

  CONSTRAINT pipeline_stage_requirement_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT pipeline_stage_requirement_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT pipeline_stage_requirement_stage_fk
    FOREIGN KEY (tenant_id, programme_id, pipeline_id, stage_id)
    REFERENCES pipeline_stage (tenant_id, programme_id, pipeline_id, id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  -- The target of the check FK: a requirement OF THE DEAL'S PIPELINE.
  CONSTRAINT pipeline_stage_requirement_pipeline_id_key
    UNIQUE (tenant_id, programme_id, pipeline_id, id),
  -- The contract's array order; also the stage FK's lookup.
  CONSTRAINT pipeline_stage_requirement_position_key
    UNIQUE (tenant_id, programme_id, pipeline_id, stage_id, position),

  CONSTRAINT pipeline_stage_requirement_kind_check CHECK (kind IN ('field', 'check')),
  -- 0..19, unique per stage: at most 20 requirements per stage (R4).
  CONSTRAINT pipeline_stage_requirement_position_check CHECK (position BETWEEN 0 AND 19),
  -- R2: the field_def api_name of a standard deal field (the contract's
  -- DealRequirementField, snake_case), and no label; or a label and no field.
  CONSTRAINT pipeline_stage_requirement_shape_check
    CHECK (CASE kind
             WHEN 'field' THEN field IS NOT NULL
                           AND field IN ('amount', 'expected_close_date', 'next_step',
                                         'primary_contact_id', 'account_id')
                           AND label IS NULL
             WHEN 'check' THEN field IS NULL
                           AND label IS NOT NULL
                           AND pg_catalog.char_length(label) BETWEEN 1 AND 200
             ELSE false
           END)
);

CREATE TABLE deal (
  id                   uuid          PRIMARY KEY,
  tenant_id            uuid          NOT NULL,
  programme_id         uuid          NOT NULL,
  pipeline_id          uuid          NOT NULL,
  stage_id             uuid          NOT NULL,
  name                 text          NOT NULL,
  -- Minor units (kobo, pesewa, ...) as bigint: never a float, never numeric
  -- (CLAUDE.md 4, D-L121). bigint input refuses a fraction rather than rounding.
  amount_minor         bigint,
  currency             text,
  expected_close_date  date,
  owner_user_id        uuid,
  primary_contact_id   uuid,
  account_id           uuid,
  next_step            text,
  stage_entered_at     timestamptz   NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  -- Optimistic-concurrency counter, maintained by deal_bump_version below.
  version              integer       NOT NULL DEFAULT 1,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT deal_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT deal_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- A stage of the deal's own pipeline, in its own programme.
  CONSTRAINT deal_stage_same_pipeline_fk
    FOREIGN KEY (tenant_id, programme_id, pipeline_id, stage_id)
    REFERENCES pipeline_stage (tenant_id, programme_id, pipeline_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Never NO ACTION and never CASCADE: see KEYS in the header (R8).
  CONSTRAINT deal_primary_contact_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, primary_contact_id)
    REFERENCES contact (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT deal_account_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, account_id)
    REFERENCES account (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT deal_owner_same_tenant_fk
    FOREIGN KEY (tenant_id, owner_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The target of the check FK: a deal OF THIS PIPELINE.
  CONSTRAINT deal_pipeline_id_key UNIQUE (tenant_id, programme_id, pipeline_id, id),

  CONSTRAINT deal_name_check CHECK (pg_catalog.char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT deal_next_step_check
    CHECK (next_step IS NULL OR pg_catalog.char_length(next_step) BETWEEN 1 AND 200),
  -- 0 to 18 nines (D-L121): the bound numeric(18,0) once implied, stated.
  CONSTRAINT deal_amount_check CHECK (amount_minor BETWEEN 0 AND 999999999999999999),
  -- D-L115: these four, exactly. Never converted.
  CONSTRAINT deal_currency_check CHECK (currency IN ('NGN', 'GHS', 'KES', 'ZAR')),
  -- DealMoney is the pair (R6).
  CONSTRAINT deal_money_pair_check CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CONSTRAINT deal_version_check CHECK (version >= 1)
);

-- R14: the board's columns, under FORCE RLS, with no Sort.
CREATE INDEX deal_board_open_idx
  ON deal (tenant_id, programme_id, pipeline_id, stage_id, stage_entered_at, id);
CREATE INDEX deal_board_closed_idx
  ON deal (tenant_id, programme_id, pipeline_id, stage_id, closed_at DESC, id DESC)
  WHERE closed_at IS NOT NULL;
-- The FK lookups for a contact, account or user delete or re-key.
CREATE INDEX deal_contact_idx
  ON deal (tenant_id, programme_id, primary_contact_id)
  WHERE primary_contact_id IS NOT NULL;
CREATE INDEX deal_account_idx
  ON deal (tenant_id, programme_id, account_id)
  WHERE account_id IS NOT NULL;
CREATE INDEX deal_owner_idx
  ON deal (tenant_id, owner_user_id)
  WHERE owner_user_id IS NOT NULL;

CREATE TABLE deal_requirement_check (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL,
  programme_id        uuid        NOT NULL,
  pipeline_id         uuid        NOT NULL,
  deal_id             uuid        NOT NULL,
  requirement_id      uuid        NOT NULL,
  checked_by_user_id  uuid        NOT NULL,
  checked_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT deal_requirement_check_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT deal_requirement_check_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  -- The deal and the requirement share the row's pipeline.
  CONSTRAINT deal_requirement_check_deal_fk
    FOREIGN KEY (tenant_id, programme_id, pipeline_id, deal_id)
    REFERENCES deal (tenant_id, programme_id, pipeline_id, id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT deal_requirement_check_requirement_fk
    FOREIGN KEY (tenant_id, programme_id, pipeline_id, requirement_id)
    REFERENCES pipeline_stage_requirement (tenant_id, programme_id, pipeline_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT deal_requirement_check_checked_by_same_tenant_fk
    FOREIGN KEY (tenant_id, checked_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Once per deal and requirement (R7); also the deal FK's lookup.
  CONSTRAINT deal_requirement_check_once_key
    UNIQUE (tenant_id, programme_id, pipeline_id, deal_id, requirement_id)
);

CREATE INDEX deal_requirement_check_requirement_idx
  ON deal_requirement_check (tenant_id, programme_id, pipeline_id, requirement_id);
CREATE INDEX deal_requirement_check_checked_by_idx
  ON deal_requirement_check (tenant_id, checked_by_user_id);

-- --- RLS ---------------------------------------------------------------------
-- See TENANCY in the header. The configuration tables carry 0015's creation
-- marker in the SAME expression for USING and WITH CHECK.

ALTER TABLE pipeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_isolation ON pipeline FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND (programme_id = ANY (app.current_programme_ids())
                   OR EXISTS (SELECT 1 FROM programme p
                               WHERE p.tenant_id = pipeline.tenant_id
                                 AND p.id = pipeline.programme_id
                                 AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
                                 AND p.created_at >= date_trunc('milliseconds', transaction_timestamp()))))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND (programme_id = ANY (app.current_programme_ids())
                   OR EXISTS (SELECT 1 FROM programme p
                               WHERE p.tenant_id = pipeline.tenant_id
                                 AND p.id = pipeline.programme_id
                                 AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
                                 AND p.created_at >= date_trunc('milliseconds', transaction_timestamp()))));

ALTER TABLE pipeline_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stage FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_stage_isolation ON pipeline_stage FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND (programme_id = ANY (app.current_programme_ids())
                   OR EXISTS (SELECT 1 FROM programme p
                               WHERE p.tenant_id = pipeline_stage.tenant_id
                                 AND p.id = pipeline_stage.programme_id
                                 AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
                                 AND p.created_at >= date_trunc('milliseconds', transaction_timestamp()))))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND (programme_id = ANY (app.current_programme_ids())
                   OR EXISTS (SELECT 1 FROM programme p
                               WHERE p.tenant_id = pipeline_stage.tenant_id
                                 AND p.id = pipeline_stage.programme_id
                                 AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
                                 AND p.created_at >= date_trunc('milliseconds', transaction_timestamp()))));

ALTER TABLE pipeline_stage_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stage_transition FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_stage_transition_isolation ON pipeline_stage_transition FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND (programme_id = ANY (app.current_programme_ids())
                   OR EXISTS (SELECT 1 FROM programme p
                               WHERE p.tenant_id = pipeline_stage_transition.tenant_id
                                 AND p.id = pipeline_stage_transition.programme_id
                                 AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
                                 AND p.created_at >= date_trunc('milliseconds', transaction_timestamp()))))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND (programme_id = ANY (app.current_programme_ids())
                   OR EXISTS (SELECT 1 FROM programme p
                               WHERE p.tenant_id = pipeline_stage_transition.tenant_id
                                 AND p.id = pipeline_stage_transition.programme_id
                                 AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
                                 AND p.created_at >= date_trunc('milliseconds', transaction_timestamp()))));

ALTER TABLE pipeline_stage_requirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stage_requirement FORCE ROW LEVEL SECURITY;
CREATE POLICY pipeline_stage_requirement_isolation ON pipeline_stage_requirement FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND (programme_id = ANY (app.current_programme_ids())
                   OR EXISTS (SELECT 1 FROM programme p
                               WHERE p.tenant_id = pipeline_stage_requirement.tenant_id
                                 AND p.id = pipeline_stage_requirement.programme_id
                                 AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
                                 AND p.created_at >= date_trunc('milliseconds', transaction_timestamp()))))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND (programme_id = ANY (app.current_programme_ids())
                   OR EXISTS (SELECT 1 FROM programme p
                               WHERE p.tenant_id = pipeline_stage_requirement.tenant_id
                                 AND p.id = pipeline_stage_requirement.programme_id
                                 AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
                                 AND p.created_at >= date_trunc('milliseconds', transaction_timestamp()))));

ALTER TABLE deal ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal FORCE ROW LEVEL SECURITY;
CREATE POLICY deal_isolation ON deal FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

ALTER TABLE deal_requirement_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_requirement_check FORCE ROW LEVEL SECURITY;
CREATE POLICY deal_requirement_check_isolation ON deal_requirement_check FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

-- --- grants --------------------------------------------------------------------
-- Explicit, so this file does not silently depend on the bootstrap's default
-- privileges, and so DELETE, TRUNCATE, REFERENCES and TRIGGER are never held by
-- kasuwa_app. See TENANCY in the header.
REVOKE ALL ON pipeline, pipeline_stage, pipeline_stage_transition, pipeline_stage_requirement,
              deal, deal_requirement_check
  FROM PUBLIC, kasuwa_app, kasuwa_test_admin;
GRANT SELECT, INSERT
  ON pipeline, pipeline_stage, pipeline_stage_transition, pipeline_stage_requirement,
     deal, deal_requirement_check
  TO kasuwa_app;
-- Column-level: never id, tenant_id, programme_id, pipeline_id or created_at.
GRANT UPDATE (name, amount_minor, currency, expected_close_date, owner_user_id,
              primary_contact_id, account_id, next_step, stage_id, stage_entered_at,
              closed_at, version, updated_at)
  ON deal TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON pipeline, pipeline_stage, pipeline_stage_transition, pipeline_stage_requirement,
     deal, deal_requirement_check
  TO kasuwa_test_admin;

-- --- 4. triggers ---------------------------------------------------------------
-- 0018's and 0019's functions, attached; no second copy of either.
CREATE TRIGGER pipeline_touch_updated_at
  BEFORE UPDATE ON pipeline FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER pipeline_bump_version
  BEFORE UPDATE ON pipeline FOR EACH ROW
  WHEN (NEW.version IS NOT DISTINCT FROM OLD.version)
  EXECUTE FUNCTION app.bump_version();
CREATE TRIGGER deal_touch_updated_at
  BEFORE UPDATE ON deal FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER deal_bump_version
  BEFORE UPDATE ON deal FOR EACH ROW
  WHEN (NEW.version IS NOT DISTINCT FROM OLD.version)
  EXECUTE FUNCTION app.bump_version();

-- The key guard: an allow-list. See "THE KEYS ARE FIXED" in the header. The
-- message names the table and the rule, never a value.
CREATE FUNCTION app.guard_pipeline_keys_fixed() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'kasuwa_migrator' AND session_user = 'kasuwa_migrator' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%: the keys and parent references are fixed at creation and cannot be changed by this role',
    TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';  -- 42501, as 0027 and 0032
END;
$$;
REVOKE ALL ON FUNCTION app.guard_pipeline_keys_fixed() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

-- BEFORE, so the row is refused before any FK or policy check runs. The WHEN
-- clause sees the final NEW, whatever set it.
CREATE TRIGGER pipeline_keys_fixed
  BEFORE UPDATE ON pipeline FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id)
  EXECUTE FUNCTION app.guard_pipeline_keys_fixed();
CREATE TRIGGER pipeline_stage_keys_fixed
  BEFORE UPDATE ON pipeline_stage FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id
        OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id)
  EXECUTE FUNCTION app.guard_pipeline_keys_fixed();
CREATE TRIGGER pipeline_stage_transition_keys_fixed
  BEFORE UPDATE ON pipeline_stage_transition FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id
        OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
        OR NEW.from_stage_id IS DISTINCT FROM OLD.from_stage_id
        OR NEW.to_stage_id IS DISTINCT FROM OLD.to_stage_id)
  EXECUTE FUNCTION app.guard_pipeline_keys_fixed();
CREATE TRIGGER pipeline_stage_requirement_keys_fixed
  BEFORE UPDATE ON pipeline_stage_requirement FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id
        OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
        OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
        OR NEW.kind IS DISTINCT FROM OLD.kind)
  EXECUTE FUNCTION app.guard_pipeline_keys_fixed();
CREATE TRIGGER deal_keys_fixed
  BEFORE UPDATE ON deal FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id
        OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id)
  EXECUTE FUNCTION app.guard_pipeline_keys_fixed();
CREATE TRIGGER deal_requirement_check_keys_fixed
  BEFORE UPDATE ON deal_requirement_check FOR EACH ROW
  WHEN (NEW.id IS DISTINCT FROM OLD.id
        OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.programme_id IS DISTINCT FROM OLD.programme_id
        OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id
        OR NEW.deal_id IS DISTINCT FROM OLD.deal_id
        OR NEW.requirement_id IS DISTINCT FROM OLD.requirement_id
        OR NEW.checked_by_user_id IS DISTINCT FROM OLD.checked_by_user_id
        OR NEW.checked_at IS DISTINCT FROM OLD.checked_at)
  EXECUTE FUNCTION app.guard_pipeline_keys_fixed();

-- The stage rules, at COMMIT. See "RULES THE SCHEMA HOLDS" in the header. It
-- reads under the caller's row security: a kasuwa_app session can only write a
-- stage into a pipeline its policy admits (WITH CHECK), and the same policy
-- lets it read that pipeline back here. The message names the rule, never a
-- value.
CREATE FUNCTION app.check_pipeline_stage_rules() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
DECLARE
  targets uuid[] := ARRAY[]::uuid[];
  tenants uuid[] := ARRAY[]::uuid[];
  i integer;
  open_count bigint;
  won_count bigint;
  lost_count bigint;
  total_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'pipeline' THEN
    targets := ARRAY[NEW.id];
    tenants := ARRAY[NEW.tenant_id];
  ELSE
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      targets := targets || NEW.pipeline_id;
      tenants := tenants || NEW.tenant_id;
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      targets := targets || OLD.pipeline_id;
      tenants := tenants || OLD.tenant_id;
    END IF;
  END IF;

  FOR i IN 1 .. pg_catalog.cardinality(targets) LOOP
    -- A pipeline that is gone (a cascade, or a delete of the whole pipeline)
    -- has no rule left to break.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.pipeline p WHERE p.tenant_id = tenants[i] AND p.id = targets[i]);
    SELECT pg_catalog.count(*) FILTER (WHERE s.kind = 'open'),
           pg_catalog.count(*) FILTER (WHERE s.kind = 'won'),
           pg_catalog.count(*) FILTER (WHERE s.kind = 'lost'),
           pg_catalog.count(*)
      INTO open_count, won_count, lost_count, total_count
      FROM public.pipeline_stage s
     WHERE s.tenant_id = tenants[i] AND s.pipeline_id = targets[i];
    IF open_count < 1 OR won_count <> 1 OR lost_count <> 1 OR total_count > 30 THEN
      RAISE EXCEPTION 'a pipeline needs at least one open stage, exactly one won and one lost stage, and at most 30 stages'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'pipeline_stage_rules';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.check_pipeline_stage_rules() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

CREATE CONSTRAINT TRIGGER pipeline_stage_rules
  AFTER INSERT ON pipeline
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_pipeline_stage_rules();
CREATE CONSTRAINT TRIGGER pipeline_stage_rules
  AFTER INSERT OR UPDATE OR DELETE ON pipeline_stage
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.check_pipeline_stage_rules();

-- R5: a deal's stage moves only along a transition of its own pipeline, for
-- every role but the migrator (the key guard's allow-list). Reads the
-- transition under the caller's row security: the deal's own pipeline, which
-- a session that can update the deal can read.
CREATE FUNCTION app.guard_deal_stage_move() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'kasuwa_migrator' AND session_user = 'kasuwa_migrator' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM public.pipeline_stage_transition t
        WHERE t.tenant_id = OLD.tenant_id
          AND t.programme_id = OLD.programme_id
          AND t.pipeline_id = OLD.pipeline_id
          AND t.pipeline_id = NEW.pipeline_id
          AND t.from_stage_id = OLD.stage_id
          AND t.to_stage_id = NEW.stage_id) THEN
    RAISE EXCEPTION 'a deal changes stage only along a transition of its pipeline'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deal_stage_transition';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_deal_stage_move() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

CREATE TRIGGER deal_stage_move
  BEFORE UPDATE ON deal FOR EACH ROW
  WHEN (NEW.stage_id IS DISTINCT FROM OLD.stage_id)
  EXECUTE FUNCTION app.guard_deal_stage_move();

-- R7: a check names a `check` requirement. The composite FK holds the
-- pipeline and the existence; this holds the kind. A requirement the caller
-- cannot read is left to the FK and the policy (no oracle: nothing is said
-- about a row the caller cannot see).
CREATE FUNCTION app.guard_requirement_check_kind() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.pipeline_stage_requirement r
        WHERE r.tenant_id = NEW.tenant_id
          AND r.programme_id = NEW.programme_id
          AND r.pipeline_id = NEW.pipeline_id
          AND r.id = NEW.requirement_id
          AND r.kind <> 'check') THEN
    RAISE EXCEPTION 'only a check requirement can be ticked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deal_requirement_check_kind';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_requirement_check_kind() FROM PUBLIC, kasuwa_app, kasuwa_test_admin;

CREATE TRIGGER deal_requirement_check_kind
  BEFORE INSERT OR UPDATE ON deal_requirement_check FOR EACH ROW
  EXECUTE FUNCTION app.guard_requirement_check_kind();

-- --- 5. the standard deal object and fields: backfill, then prove ------------
DO $$
DECLARE
  -- Frozen copy of the `deal` entry of STANDARD_OBJECT_CATALOGUE
  -- (packages/db/src/standard-object-catalogue.ts).
  new_object constant jsonb :=
    '{"api_name": "deal", "label": "Deal", "plural_label": "Deals"}';
  new_fields constant jsonb := '[
    {"api_name": "name",                "label": "Name",                "type": "text",   "classification": "pii",  "is_required": true,  "config": {}},
    {"api_name": "amount",              "label": "Amount",              "type": "number", "classification": "none", "is_required": false, "config": {}},
    {"api_name": "expected_close_date", "label": "Expected close date", "type": "date",   "classification": "none", "is_required": false, "config": {}},
    {"api_name": "owner_user_id",       "label": "Owner",               "type": "text",   "classification": "none", "is_required": false, "config": {}},
    {"api_name": "primary_contact_id",  "label": "Primary contact",     "type": "lookup", "classification": "none", "is_required": false, "config": {"targetObjectApiName": "contact"}},
    {"api_name": "account_id",          "label": "Account",             "type": "lookup", "classification": "none", "is_required": false, "config": {"targetObjectApiName": "account"}},
    {"api_name": "next_step",           "label": "Next step",           "type": "text",   "classification": "pii",  "is_required": false, "config": {}}
  ]';
  classification_rank constant text[] := ARRAY['none', 'pii', 'sensitive'];
  affected_tenants bigint;
  stray_rows bigint;
  problem text;
BEGIN
  INSERT INTO public.object_def (id, tenant_id, api_name, label, plural_label, is_custom)
  SELECT gen_random_uuid(), t.id, new_object ->> 'api_name', new_object ->> 'label',
         new_object ->> 'plural_label', false
    FROM public.tenant t
  ON CONFLICT (tenant_id, api_name) DO NOTHING;

  INSERT INTO public.field_def
    (id, tenant_id, object_id, api_name, label, type, classification, is_required, is_custom, config)
  SELECT gen_random_uuid(), o.tenant_id, o.id, f.api_name, f.label, f.type, f.classification,
         f.is_required, false, f.config
    FROM public.object_def o
   CROSS JOIN jsonb_to_recordset(new_fields)
           AS f (api_name text, label text, type text, classification text,
                 is_required boolean, config jsonb)
   WHERE o.api_name = 'deal' AND NOT o.is_custom
  ON CONFLICT (tenant_id, object_id, api_name) DO NOTHING;

  -- Every tenant has the standard object...
  SELECT pg_catalog.count(*)
    INTO affected_tenants
    FROM public.tenant t
   WHERE NOT EXISTS (
           SELECT 1 FROM public.object_def o
            WHERE o.tenant_id = t.id AND o.api_name = 'deal' AND NOT o.is_custom);
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0036 backfill incomplete: % tenant(s) lack the standard object deal',
      affected_tenants;
  END IF;

  -- ...and every field, standard, on it, with the catalogue's meaning and at
  -- least its classification.
  SELECT pg_catalog.count(DISTINCT t.id),
         pg_catalog.string_agg(DISTINCT 'deal.' || c.api_name, ', ')
    INTO affected_tenants, problem
    FROM public.tenant t
   CROSS JOIN jsonb_to_recordset(new_fields)
           AS c (api_name text, type text, classification text, is_required boolean, config jsonb)
   WHERE NOT EXISTS (
           SELECT 1
             FROM public.field_def f
             JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
            WHERE f.tenant_id = t.id
              AND o.api_name = 'deal' AND NOT o.is_custom
              AND f.api_name = c.api_name AND NOT f.is_custom
              AND f.type = c.type
              AND f.config = c.config
              AND f.is_required = c.is_required
              AND pg_catalog.array_position(classification_rank, f.classification)
               >= pg_catalog.array_position(classification_rank, c.classification));
  IF affected_tenants > 0 THEN
    RAISE EXCEPTION '0036 backfill incomplete: % tenant(s) lack or mis-type the standard field(s) %',
      affected_tenants, problem;
  END IF;

  -- Nothing standard on `deal` that the catalogue does not name. Names here
  -- are tenant data: counts only.
  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT f.tenant_id)
    INTO stray_rows, affected_tenants
    FROM public.field_def f
    JOIN public.object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
   WHERE o.api_name = 'deal' AND NOT o.is_custom
     AND NOT f.is_custom
     AND NOT EXISTS (
           SELECT 1 FROM jsonb_to_recordset(new_fields) AS c (api_name text)
            WHERE c.api_name = f.api_name);
  IF stray_rows > 0 THEN
    RAISE EXCEPTION '0036: % standard deal field_def row(s) in % tenant(s) are not in the standard catalogue; mark them custom or remove them, then re-run',
      stray_rows, affected_tenants;
  END IF;
END
$$;

-- --- 6. the default pipeline for every existing programme (R11) --------------
DO $$
DECLARE
  -- Frozen copy of DEFAULT_PIPELINE_TEMPLATE (packages/db/src/default-pipeline.ts),
  -- the contract's getPipeline example. A stage's position is its index here.
  template_name constant text := 'B2B sales';
  stages constant jsonb := '[
    {"name": "Qualified",   "kind": "open", "probability_bp": 1000,  "rotting_after_days": 14,   "requirements": []},
    {"name": "Discovery",   "kind": "open", "probability_bp": 2500,  "rotting_after_days": 14,   "requirements": []},
    {"name": "Proposal",    "kind": "open", "probability_bp": 5000,  "rotting_after_days": 14,   "requirements": [
      {"kind": "check", "field": null, "label": "Budget range confirmed with the customer"}]},
    {"name": "Negotiation", "kind": "open", "probability_bp": 7000,  "rotting_after_days": 14,   "requirements": [
      {"kind": "field", "field": "amount", "label": null},
      {"kind": "field", "field": "expected_close_date", "label": null},
      {"kind": "check", "field": null, "label": "Quote sent to the customer"}]},
    {"name": "Contract",    "kind": "open", "probability_bp": 9000,  "rotting_after_days": 21,   "requirements": [
      {"kind": "field", "field": "primary_contact_id", "label": null},
      {"kind": "check", "field": null, "label": "Purchase order received"}]},
    {"name": "Won",         "kind": "won",  "probability_bp": 10000, "rotting_after_days": null, "requirements": []},
    {"name": "Lost",        "kind": "lost", "probability_bp": 0,     "rotting_after_days": null, "requirements": []}
  ]';
  -- The seed rule's 30 pairs, by stage position (from, to): forward one stage
  -- (Contract forward is Won), back to any earlier open stage, lost from any
  -- open stage, won and lost back to any open stage.
  transitions constant integer[] := ARRAY[
    [0, 1], [0, 6],
    [1, 0], [1, 2], [1, 6],
    [2, 0], [2, 1], [2, 3], [2, 6],
    [3, 0], [3, 1], [3, 2], [3, 4], [3, 6],
    [4, 0], [4, 1], [4, 2], [4, 3], [4, 5], [4, 6],
    [5, 0], [5, 1], [5, 2], [5, 3], [5, 4],
    [6, 0], [6, 1], [6, 2], [6, 3], [6, 4]
  ];
  target record;
  new_pipeline uuid;
  missing bigint;
BEGIN
  -- Every status: active, paused, draft and archived alike (R11).
  FOR target IN
    SELECT p.tenant_id, p.id
      FROM public.programme p
     WHERE NOT EXISTS (SELECT 1 FROM public.pipeline x
                        WHERE x.tenant_id = p.tenant_id AND x.programme_id = p.id)
     ORDER BY p.tenant_id, p.id
  LOOP
    new_pipeline := gen_random_uuid();
    INSERT INTO public.pipeline (id, tenant_id, programme_id, name)
    VALUES (new_pipeline, target.tenant_id, target.id, template_name);

    INSERT INTO public.pipeline_stage
      (id, tenant_id, programme_id, pipeline_id, name, kind, position, probability_bp,
       rotting_after_days)
    SELECT gen_random_uuid(), target.tenant_id, target.id, new_pipeline,
           s.value ->> 'name', s.value ->> 'kind', (s.ordinality - 1)::integer,
           (s.value ->> 'probability_bp')::integer, (s.value ->> 'rotting_after_days')::integer
      FROM jsonb_array_elements(stages) WITH ORDINALITY AS s (value, ordinality);

    INSERT INTO public.pipeline_stage_requirement
      (id, tenant_id, programme_id, pipeline_id, stage_id, kind, position, field, label)
    SELECT gen_random_uuid(), target.tenant_id, target.id, new_pipeline, st.id,
           r.value ->> 'kind', (r.ordinality - 1)::integer, r.value ->> 'field', r.value ->> 'label'
      FROM jsonb_array_elements(stages) WITH ORDINALITY AS s (value, ordinality)
     CROSS JOIN LATERAL jsonb_array_elements(s.value -> 'requirements')
           WITH ORDINALITY AS r (value, ordinality)
      JOIN public.pipeline_stage st
        ON st.tenant_id = target.tenant_id AND st.pipeline_id = new_pipeline
       AND st.position = (s.ordinality - 1)::integer;

    INSERT INTO public.pipeline_stage_transition
      (id, tenant_id, programme_id, pipeline_id, from_stage_id, to_stage_id)
    SELECT gen_random_uuid(), target.tenant_id, target.id, new_pipeline, f.id, t.id
      FROM pg_catalog.generate_subscripts(transitions, 1) AS n
      JOIN public.pipeline_stage f
        ON f.tenant_id = target.tenant_id AND f.pipeline_id = new_pipeline
       AND f.position = transitions[n][1]
      JOIN public.pipeline_stage t
        ON t.tenant_id = target.tenant_id AND t.pipeline_id = new_pipeline
       AND t.position = transitions[n][2];
  END LOOP;

  -- The proof: every programme has a pipeline, and every default pipeline has
  -- the template's 7 stages, 6 requirements and 30 transitions.
  SELECT pg_catalog.count(*) INTO missing
    FROM public.programme p
   WHERE NOT EXISTS (SELECT 1 FROM public.pipeline x
                      WHERE x.tenant_id = p.tenant_id AND x.programme_id = p.id);
  IF missing > 0 THEN
    RAISE EXCEPTION '0036 backfill incomplete: % programme(s) have no pipeline', missing;
  END IF;
  SELECT pg_catalog.count(*) INTO missing
    FROM public.pipeline x
   WHERE (SELECT pg_catalog.count(*) FROM public.pipeline_stage s WHERE s.pipeline_id = x.id) <> 7
      OR (SELECT pg_catalog.count(*) FROM public.pipeline_stage_requirement r
           WHERE r.pipeline_id = x.id) <> 6
      OR (SELECT pg_catalog.count(*) FROM public.pipeline_stage_transition t
           WHERE t.pipeline_id = x.id) <> 30;
  IF missing > 0 THEN
    RAISE EXCEPTION '0036 backfill incomplete: % default pipeline(s) do not match the template', missing;
  END IF;
END
$$;

-- --- 7. prove the posture ------------------------------------------------------
-- Runs once, here. The standing guards are the T-0106 acceptance suite and
-- the pipeline integration tests, which run on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  six constant text[] := ARRAY['pipeline', 'pipeline_stage', 'pipeline_stage_transition',
                               'pipeline_stage_requirement', 'deal', 'deal_requirement_check'];
  held text;
BEGIN
  SELECT pg_catalog.string_agg(t, ', ' ORDER BY t) INTO held
    FROM pg_catalog.unnest(six) AS t
    JOIN pg_catalog.pg_class c ON c.oid = ('public.' || t)::pg_catalog.regclass
   WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity)
      OR pg_catalog.pg_get_userbyid(c.relowner) <> 'kasuwa_migrator';
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0036: RLS not enabled and forced, or not owned by kasuwa_migrator: %', held;
  END IF;

  -- No DELETE for kasuwa_app anywhere (T-0105 R13); SELECT and INSERT on all.
  SELECT pg_catalog.string_agg(t, ', ' ORDER BY t) INTO held
    FROM pg_catalog.unnest(six) AS t
   WHERE pg_catalog.has_table_privilege(app_role, 'public.' || t, 'DELETE')
      OR NOT pg_catalog.has_table_privilege(app_role, 'public.' || t, 'SELECT')
      OR NOT pg_catalog.has_table_privilege(app_role, 'public.' || t, 'INSERT');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0036: kasuwa_app holds DELETE, or lacks SELECT or INSERT, on: %', held;
  END IF;

  -- UPDATE only on deal's business columns: never a key, a parent reference,
  -- created_at, nor anything on the configuration tables or the checks.
  SELECT pg_catalog.string_agg(t, ', ' ORDER BY t) INTO held
    FROM pg_catalog.unnest(ARRAY['pipeline', 'pipeline_stage', 'pipeline_stage_transition',
                                 'pipeline_stage_requirement', 'deal_requirement_check']) AS t
   WHERE pg_catalog.has_any_column_privilege(app_role, 'public.' || t, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0036: kasuwa_app may UPDATE: %', held;
  END IF;
  SELECT pg_catalog.string_agg(c.col, ', ' ORDER BY c.col) INTO held
    FROM pg_catalog.unnest(ARRAY['id', 'tenant_id', 'programme_id', 'pipeline_id',
                                 'created_at']) AS c(col)
   WHERE pg_catalog.has_column_privilege(app_role, 'public.deal', c.col, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0036: kasuwa_app may UPDATE deal column(s) it must not: %', held;
  END IF;
  IF NOT pg_catalog.has_column_privilege(app_role, 'public.deal', 'stage_id', 'UPDATE') THEN
    RAISE EXCEPTION '0036: kasuwa_app cannot move a deal (UPDATE on stage_id)';
  END IF;

  -- Every FK is ON UPDATE RESTRICT (D-L76); the deal's contact and account
  -- FKs never cascade (R8).
  SELECT pg_catalog.string_agg(con.conname, ', ' ORDER BY con.conname) INTO held
    FROM pg_catalog.pg_constraint con
   WHERE con.contype = 'f'
     AND con.conrelid = ANY (ARRAY(SELECT ('public.' || t)::pg_catalog.regclass::pg_catalog.oid
                                     FROM pg_catalog.unnest(six) AS t))
     AND (con.confupdtype <> 'r'
          OR (con.conrelid = 'public.deal'::pg_catalog.regclass
              AND con.confrelid IN ('public.contact'::pg_catalog.regclass,
                                    'public.account'::pg_catalog.regclass)
              AND con.confdeltype <> 'r'));
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0036: FK(s) not ON UPDATE RESTRICT, or a deal contact/account FK that is not ON DELETE RESTRICT: %', held;
  END IF;

  -- Each table's key guard is attached.
  SELECT pg_catalog.string_agg(t, ', ' ORDER BY t) INTO held
    FROM pg_catalog.unnest(six) AS t
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger tg
                      WHERE NOT tg.tgisinternal
                        AND tg.tgrelid = ('public.' || t)::pg_catalog.regclass
                        AND tg.tgname = t || '_keys_fixed');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0036: the key guard is missing on: %', held;
  END IF;

  -- UNIQUE KEYS (D-L120): every unique index but the primary key leads with
  -- tenant_id, programme_id, and, below pipeline, pipeline_id. A key that
  -- does not can collide with another tenant's row: an existence oracle.
  SELECT pg_catalog.string_agg(ic.relname, ', ' ORDER BY ic.relname) INTO held
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
   WHERE i.indisunique AND NOT i.indisprimary
     AND tc.oid = ANY (ARRAY(SELECT ('public.' || t)::pg_catalog.regclass::pg_catalog.oid
                               FROM pg_catalog.unnest(six) AS t))
     AND (i.indnkeyatts < 3
          OR pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) <> 'tenant_id'
          OR pg_catalog.pg_get_indexdef(i.indexrelid, 2, true) <> 'programme_id'
          OR (tc.relname <> 'pipeline'
              AND pg_catalog.pg_get_indexdef(i.indexrelid, 3, true) <> 'pipeline_id'));
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0036: unique key(s) not led by tenant_id, programme_id (and pipeline_id below pipeline): %', held;
  END IF;

  -- TRUNCATE skips RLS entirely, and BYPASSRLS skips the policies. Checked for
  -- kasuwa_app AND every role it is a member of, whatever the INHERIT option
  -- (it can SET ROLE to kasuwa_sweeper, D-L66). DELETE too (G).
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'TRUNCATE or DELETE ' || t AS what
       FROM pg_catalog.unnest(six) AS t
      WHERE pg_catalog.has_table_privilege(r.oid, 'public.' || t, 'TRUNCATE')
         OR pg_catalog.has_table_privilege(r.oid, 'public.' || t, 'DELETE')
     UNION ALL
     SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0036: kasuwa_app, or a role it can enter, can bypass pipeline row security: %', held;
  END IF;

  -- The INDEXES claim (D-P33): every operator the board and the policies
  -- compare key columns with is already LEAKPROOF in this server, so the
  -- planner may use the indexes under row security. Read only; nothing is
  -- marked LEAKPROOF here. If one is not, stop and escalate; never mark it.
  SELECT pg_catalog.string_agg(f.name, ', ' ORDER BY f.name)
    INTO held
    FROM pg_catalog.unnest(ARRAY['texteq', 'uuid_eq', 'uuid_lt', 'uuid_gt', 'timestamptz_eq',
                                 'timestamptz_lt', 'timestamptz_le', 'timestamptz_gt',
                                 'timestamptz_ge']) AS f(name)
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                      WHERE p.oid = f.name::pg_catalog.regproc AND p.proleakproof);
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0036: the board predicates use operator functions that are not LEAKPROOF: %; escalate (T-0106), do not mark them', held;
  END IF;
END
$$;
