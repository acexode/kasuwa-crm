-- ---------------------------------------------------------------------------
-- 0012 - a real programme lifecycle column, and a way to create a programme
--        under RLS (T-0029, ruled in team/DECISIONS.md D-L46).
--
-- 1. programme.status
--
--    EXPAND ONLY. A new NOT NULL column with a constant default: Postgres 11+
--    stores the default in the catalogue and does not rewrite the table, so
--    every existing row reads 'active' - which is exactly what T-0024's API
--    reported as a constant. No backfill, no contract step. The CHECK admits
--    the four published `ProgrammeStatus` values (docs/api/admin.openapi.yaml)
--    and nothing else.
--
-- 2. programme_insert_in_tenant - a second, permissive FOR INSERT policy.
--
--    The FOR ALL policy from 0001 has WITH CHECK
--      tenant_id = app.current_tenant_id() AND id = ANY (app.current_programme_ids())
--    which a NEW programme can never satisfy: its id is not in anybody's
--    session yet, and T-0020 sealed the session GUCs so a transaction cannot
--    re-scope itself to include it. Permissive policies are OR-ed, so this
--    policy admits an INSERT whose row belongs to the session's tenant, and
--    adds nothing else:
--
--      * It is FOR INSERT only. SELECT, UPDATE and DELETE are still governed
--        by the FOR ALL policy alone, so reads and updates stay
--        programme-scoped. The 0001 policy is NOT altered.
--      * An INSERT policy has no USING clause (Postgres does not accept one),
--        so "WITH CHECK identical to USING" (CLAUDE.md 2.4) is held by the
--        FOR ALL policy, as before. This policy cannot admit a row to any
--        read; `rls-enforcement` still finds no policy whose qual is `true`.
--      * The tenant predicate is the whole check: a session cannot insert a
--        programme into another tenant, which is the cross-tenant INSERT the
--        isolation suite already attacks on every table.
--
--    Consequence the application must respect: the inserted row is NOT
--    readable in the transaction that inserted it, so the caller must not use
--    INSERT ... RETURNING (RETURNING is checked against the SELECT policies
--    and would fail). The repository builds its response from the values it
--    inserted (packages/domain/core/src/programme/programme-lifecycle.ts). The
--    creator's user_programme row is inserted in the same transaction; from
--    the next request the session's scope includes the new programme.
--
--    NO SECURITY DEFINER function is involved (CLAUDE.md 2.7), so no ADR.
--    Who may create a programme is the permissions engine's question; until
--    it exists any tenant user can (same gap as D-L40).
-- ---------------------------------------------------------------------------

-- The ALTERs take ACCESS EXCLUSIVE on programme until COMMIT. Fail fast rather
-- than queue behind a long transaction and stall every request behind us.
-- Transaction-local: the runner wraps each file.
SET LOCAL lock_timeout = '5s';

ALTER TABLE programme
  ADD COLUMN status text NOT NULL DEFAULT 'active';

ALTER TABLE programme
  ADD CONSTRAINT programme_status_check
  CHECK (status IN ('active', 'paused', 'draft', 'archived'));

-- The list's status filter and chip counts are always within one tenant.
CREATE INDEX programme_tenant_status_idx ON programme (tenant_id, status);

CREATE POLICY programme_insert_in_tenant ON programme
  AS PERMISSIVE
  FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
