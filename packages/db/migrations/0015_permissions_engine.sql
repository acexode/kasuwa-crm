-- ---------------------------------------------------------------------------
-- 0015 - the permissions engine's schema (T-0032; team/DECISIONS.md D-L53,
--        D-L51, D-L40). D-A3: changes RLS policies and grants -> @acexode.
--
-- RLS decides what a session may SEE. This migration adds what the engine
-- needs to decide what it may DO, and closes the one place the database still
-- trusted the application about programme membership (D-L51).
--
-- 1. user_programme.permission_set_id  (D-P9: a grant is per user per programme)
--
--    EXPAND ONLY. Nullable, no default: NULL means "no permission" (M1), which
--    is what every existing row meant a moment ago. No backfill here; the seed
--    and the creator's enrolment set it. The composite foreign key carries
--    tenant_id (0006 built `permission_set (tenant_id, id)` as its target), so
--    a membership can never name another tenant's set even if RLS were
--    bypassed. ON DELETE: NO ACTION - nothing deletes a permission set today,
--    and a cascade would silently delete memberships; SET NULL on a composite
--    key would null tenant_id as well.
--
-- 2. "user".is_tenant_admin  (D-L53: a tenant-level flag, not derived)
--
--    NOT NULL DEFAULT false: a constant default, so Postgres 11+ records it in
--    the catalogue without a table rewrite, and every existing user reads
--    "not a tenant admin" - fail closed.
--
--    kasuwa_app may NOT write this column. Until now kasuwa_app held
--    table-level INSERT and UPDATE on "user" (bootstrap default privileges),
--    so any statement on the request connection could have made its own user
--    a tenant admin. Those two privileges are replaced by column-level grants
--    on every OTHER column. Who becomes a tenant admin is an operator action
--    (provisioning and the seed run as kasuwa_migrator) until an endpoint
--    for it exists and is argued for.
--    Consequence for later migrations: a new "user" column is not writable by
--    kasuwa_app until that migration grants it. That is deliberate: a column
--    on the table that defines privilege is opted in, not inherited.
--
-- 3. D-L51 - the database guards programme membership.
--
--    user_programme_isolation (0001) checks only tenant_id, so any code path
--    that wrote a user_programme row could enrol anyone in ANY programme of
--    the tenant - across the BPO client boundary. Two RESTRICTIVE policies
--    (AND-ed with every permissive one, so they can only narrow; 0008's
--    audit_event_actor_is_session is the precedent) now require that an
--    INSERTed or UPDATEd membership row is for a programme that is EITHER
--      (a) already in the session's scope, app.current_programme_ids(); OR
--      (b) created by this very transaction.
--    No new PERMISSIVE FOR INSERT policy is added (permissive policies are
--    OR-ed; a new one could only widen). SELECT and DELETE are untouched: the
--    session resolver reads user_programme before programme scope is known.
--
--    THE MARKER FOR (b), AND WHY IT IS NOT A SETTING.
--    The obvious marker is a transaction-local GUC set by createProgramme.
--    It is forgeable: every custom `app.*` setting is user-settable, and
--    kasuwa_app can set_config() it from any statement on the request
--    connection (ADR-0010 makes this argument for the scope GUCs). The marker
--    has to be something the session cannot produce except by actually
--    creating a programme. That is the programme row's own `xmin`: the server
--    stamps it with the id of the transaction that wrote the row version, and
--    no SQL can choose it. "Created in this transaction" is therefore
--      p.xmin = pg_current_xact_id_if_assigned()::xid
--    - the 32-bit xid of the current top-level transaction. `_if_assigned`
--    rather than pg_current_xact_id(): it never forces an xid onto a
--    read-only transaction (the predicate also sits in a SELECT policy on
--    programme, below), and it is NULL - so the predicate is false - when
--    the transaction has written nothing. A row version written by THIS
--    transaction is either a programme it inserted (programme_insert_in_tenant
--    holds that to the session's tenant) or one it updated, and an UPDATE
--    must first pass the programme-scoped FOR ALL policy - so (b) can never
--    name an existing out-of-scope programme. Fail-closed edge: an INSERT
--    made inside a SAVEPOINT is stamped with the subtransaction's xid, which
--    does not match, so a membership for it is REFUSED, never admitted.
--    No code path does that today.
--
--    For (b) to be checkable at all, the policy's subquery must be able to
--    see the new programme row, and today it cannot: the FOR ALL policy only
--    admits ids already in scope (that is why createProgramme cannot use
--    RETURNING - see 0012). So programme gains one PERMISSIVE FOR SELECT
--    policy, programme_visible_to_creating_transaction, with the same
--    predicate plus the tenant. It admits exactly the rows this transaction
--    itself wrote and already knows, for the rest of that transaction, and
--    nothing else: no other session's row can ever carry this transaction's
--    xid. It is FOR SELECT only, so it grants no UPDATE or DELETE (those stay
--    with the FOR ALL policy), and it is not a FOR INSERT policy, so the
--    permissive-INSERT allow-list (permissions acceptance) is unchanged.
--    CLAUDE.md 2.4 ("WITH CHECK identical to USING") is still held by the
--    FOR ALL policy; a FOR SELECT policy cannot carry a WITH CHECK.
--
--    NO SECURITY DEFINER function, view or owner trick is involved
--    (CLAUDE.md 2.7): every read in these policies runs as kasuwa_app, under
--    RLS. The census in the permissions acceptance suite still finds exactly
--    two definers.
-- ---------------------------------------------------------------------------

-- The ALTERs take ACCESS EXCLUSIVE on "user", user_programme and programme
-- until COMMIT. Fail fast rather than queue behind a long transaction.
-- Transaction-local: the runner wraps each file.
SET LOCAL lock_timeout = '5s';

-- --- 1. the grant column ------------------------------------------------------

ALTER TABLE user_programme ADD COLUMN permission_set_id uuid;

ALTER TABLE user_programme
  ADD CONSTRAINT user_programme_permission_set_same_tenant_fk
  FOREIGN KEY (tenant_id, permission_set_id)
  REFERENCES permission_set (tenant_id, id);

-- The FK's referencing side, for a future "who holds this set" and for the
-- planner when a set is ever deleted. Tenant first, like every other index.
CREATE INDEX user_programme_tenant_permission_set_idx
  ON user_programme (tenant_id, permission_set_id);

-- --- 2. the tenant-admin flag -------------------------------------------------

ALTER TABLE "user" ADD COLUMN is_tenant_admin boolean NOT NULL DEFAULT false;

REVOKE INSERT, UPDATE ON "user" FROM kasuwa_app;
GRANT INSERT (id, tenant_id, email, display_name, locale, status, role_id, created_at, updated_at)
  ON "user" TO kasuwa_app;
GRANT UPDATE (email, display_name, locale, status, role_id, updated_at)
  ON "user" TO kasuwa_app;

-- --- 3. D-L51 ------------------------------------------------------------------

CREATE POLICY programme_visible_to_creating_transaction ON programme
  AS PERMISSIVE
  FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    AND xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
  );

CREATE POLICY user_programme_insert_in_scope ON user_programme
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      programme_id = ANY (app.current_programme_ids())
      OR EXISTS (
        SELECT 1
          FROM programme p
         WHERE p.tenant_id = user_programme.tenant_id
           AND p.id = user_programme.programme_id
           AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
      )
    )
  );

CREATE POLICY user_programme_update_in_scope ON user_programme
  AS RESTRICTIVE
  FOR UPDATE
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      programme_id = ANY (app.current_programme_ids())
      OR EXISTS (
        SELECT 1
          FROM programme p
         WHERE p.tenant_id = user_programme.tenant_id
           AND p.id = user_programme.programme_id
           AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
      )
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      programme_id = ANY (app.current_programme_ids())
      OR EXISTS (
        SELECT 1
          FROM programme p
         WHERE p.tenant_id = user_programme.tenant_id
           AND p.id = user_programme.programme_id
           AND p.xmin = pg_catalog.pg_current_xact_id_if_assigned()::xid
      )
    )
  );
