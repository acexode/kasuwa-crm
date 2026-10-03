-- ---------------------------------------------------------------------------
-- 0010 - dispositions (M10 configuration surface, T-0027).
--
-- Contract: docs/api/admin.openapi.yaml, operations listDispositions,
-- createDisposition, reorderDispositions, updateDisposition and
-- deleteDisposition. Semantics: team/DECISION-LOG.md D-L47.
--
-- A disposition belongs to a PROGRAMME, so this is programme-scoped data in
-- the `contact` pattern: tenant_id and programme_id both NOT NULL, a composite
-- foreign key to programme (tenant_id, id), and an RLS policy that filters on
-- the tenant AND the session's programme list.
--
-- Every tenancy invariant from 0001 applies in full:
--   1. tenant_id on the table, NOT NULL.
--   2. RLS ENABLED *and* FORCED.
--   3. The policy's WITH CHECK is identical to its USING.
--   4. The composite foreign key carries tenant_id: a disposition can never
--      belong to another tenant's programme, not even if RLS were bypassed,
--      because referential checks ignore row security.
--   5. Uniqueness is per programme, never global.
--
-- Soft delete (D-L47). `DELETE` at the API sets `deleted_at` and clears
-- `position`; the row stays, so a past interaction that joins to it keeps its
-- label and reports can group it under "Deleted". Consequences:
--   * `code` stays reserved. The unique key below covers deleted rows too, so
--     a code can never be reissued with a different meaning.
--   * Only live rows hold a position. `position` is NULL exactly when the row
--     is deleted (the CHECK), and NULLs are distinct in a unique key, so the
--     live order is distinct and >= 1 (gaps are allowed and harmless).
--   * kasuwa_app has no DELETE on this table. A hard delete would break every
--     historical report that joins to it, so the application cannot issue
--     one. Rows still go with their tenant or programme (ON DELETE CASCADE),
--     because referential actions run as the table owner.
--
-- The position key is DEFERRABLE INITIALLY IMMEDIATE so that a reorder - one
-- UPDATE permuting every live position - is checked at the end of the
-- statement rather than row by row, where a permutation collides with itself
-- half-way through. Concurrent writers to one programme's list are serialised
-- by the API taking the programme row FOR NO KEY UPDATE first.
-- ---------------------------------------------------------------------------

CREATE TABLE disposition (
  id                  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id        uuid        NOT NULL,
  code                text        NOT NULL,
  label               text        NOT NULL,
  category            text        NOT NULL,
  note_required       boolean     NOT NULL DEFAULT false,
  follow_up_required  boolean     NOT NULL DEFAULT false,
  active              boolean     NOT NULL DEFAULT true,
  position            integer,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disposition_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE,
  -- Including deleted rows: a code, once used in a programme, is reserved.
  CONSTRAINT disposition_programme_code_key UNIQUE (tenant_id, programme_id, code),
  CONSTRAINT disposition_programme_position_key UNIQUE (tenant_id, programme_id, position)
    DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT disposition_code_check CHECK (code ~ '^[A-Z0-9_]{1,16}$'),
  CONSTRAINT disposition_label_length_check CHECK (char_length(label) BETWEEN 1 AND 120),
  CONSTRAINT disposition_category_check CHECK (
    category IN ('promise_to_pay', 'resolved', 'callback', 'escalated', 'not_reached')
  ),
  CONSTRAINT disposition_position_check CHECK (position >= 1),
  CONSTRAINT disposition_position_iff_live_check CHECK (
    (deleted_at IS NULL) = (position IS NOT NULL)
  )
);

ALTER TABLE disposition ENABLE ROW LEVEL SECURITY;
ALTER TABLE disposition FORCE ROW LEVEL SECURITY;
CREATE POLICY disposition_isolation ON disposition FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

-- Restated rather than inherited from bootstrap.sql's default privileges, and
-- narrower than them: no DELETE for the application (soft delete, above).
GRANT SELECT, INSERT, UPDATE ON disposition TO kasuwa_app;
REVOKE DELETE ON disposition FROM kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON disposition TO kasuwa_test_admin;
