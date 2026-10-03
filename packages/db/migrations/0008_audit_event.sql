-- ---------------------------------------------------------------------------
-- 0008 - the admin audit log and its export requests (M2, T-0025).
--
-- Contract: docs/api/admin.openapi.yaml, operations listAuditEvents,
-- getAuditFilterOptions, createAuditExport and getAuditExport, and the
-- `x-kasuwa-audited` writes implemented when this landed: createRole,
-- updateRole, deleteRole, updateRoleHierarchy, createProgramme,
-- updateProgramme, archiveProgramme, updateFieldSecurityMatrix (D-L52) and
-- createAuditExport itself. With every implemented audited write covered,
-- this closes D-L38; each audited operation built later writes its own event.
--
-- ---------------------------------------------------------------------------
-- READ THIS BEFORE GRANTING ANYTHING ON THESE TABLES.
--
-- audit_event is APPEND-ONLY for the application. kasuwa_app may INSERT and
-- SELECT, and nothing else: no UPDATE, no DELETE, no TRUNCATE. An audit row
-- the application can rewrite is a row the subject of the audit can rewrite,
-- because the subject IS a user of the application. The default privileges in
-- sql/bootstrap.sql would hand kasuwa_app UPDATE and DELETE on every new table,
-- so they are REVOKED explicitly below, not merely left un-granted.
-- tests/acceptance/admin/audit-api.acceptance.test.ts asserts this with
-- has_table_privilege, which sees grants through PUBLIC and role membership.
--
-- A BEFORE UPDATE trigger additionally refuses UPDATE for every role,
-- including the owner. DELETE stays possible for the owner only, because
-- tenant offboarding (ON DELETE CASCADE from tenant) and a future retention job
-- both need it; neither runs as kasuwa_app.
-- ---------------------------------------------------------------------------
--
-- Every tenancy invariant from 0001 applies in full:
--   1. tenant_id on both tables, NOT NULL, FK to tenant.
--   2. RLS ENABLED *and* FORCED.
--   3. Each table's permissive policy has WITH CHECK identical to USING.
--   4. Composite foreign keys carry tenant_id: an event can never name an
--      actor or a programme in another tenant, even with RLS bypassed.
--
-- VISIBILITY (D-L48):
--   * An event with a programme_id is visible only to members of that
--     programme (app.current_programme_ids(), which withTenantTransaction
--     resolves from user_programme - never from the request).
--   * An event with no programme (role changes, exports) is visible to every
--     user of the tenant, until the permissions engine restricts reading the
--     audit log to admins.
--   * An export request is visible only to the user who made it
--     ("An exportId belonging to another caller is 404").
--
-- WHAT IS DELIBERATELY NOT STORED:
--   * No source IP address. AuditEntry.sourceIp is personal data under the
--     NDPA and nobody may see it yet (D-L48); recording it also needs a
--     decision on which proxy headers are trusted. A later expand migration
--     adds the column when both are settled. Until then the API answers a
--     sourceIpPrefix filter with an empty page, so the filter is not an oracle.
--   * No actor display name or email. The actor's name is joined from "user"
--     at read time, so an erasure request is honoured in one place and the
--     audit log never holds a second copy of anyone's identity.
--   * No foreign key on object_id: the log must outlive the object (a deleted
--     role keeps its row, with its name in object_label).
--
-- NOTE: `user` is a reserved word and is double-quoted wherever it appears.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- audit_event -----------------------------------------------------------
CREATE TABLE audit_event (
  id               uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  -- clock_timestamp(), not now(): several events written in one transaction
  -- (a hierarchy save moving three roles) keep their insertion order.
  occurred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_kind       text        NOT NULL,
  -- Null exactly when the actor is the system (a scheduled job is not a person).
  actor_user_id    uuid,
  -- The actor's role name when they acted: configuration, not personal data.
  actor_role_name  text,
  action           text        NOT NULL,
  object_type      text        NOT NULL,
  object_id        uuid,
  object_label     text        NOT NULL,
  programme_id     uuid,
  -- [{ field, before, after, redacted }], AuditChange in the spec.
  changes          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (tenant_id, id),
  CONSTRAINT audit_event_actor_kind_check CHECK (actor_kind IN ('user', 'system')),
  CONSTRAINT audit_event_actor_shape_check
    CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL)),
  CONSTRAINT audit_event_action_check CHECK (action IN (
    'created', 'updated', 'deleted', 'exported', 'invited', 'viewed',
    'failed_sign_in', 'rejected', 'rotated', 'played_recording'
  )),
  CONSTRAINT audit_event_object_type_check CHECK (char_length(object_type) BETWEEN 1 AND 64),
  CONSTRAINT audit_event_object_label_check CHECK (char_length(object_label) BETWEEN 1 AND 300),
  CONSTRAINT audit_event_changes_check CHECK (jsonb_typeof(changes) = 'array'),
  -- NO ACTION: a user who appears in the log is anonymised, never hard-deleted
  -- out from under it. A tenant delete cascades to both tables in one
  -- statement, which NO ACTION (checked at statement end) permits.
  CONSTRAINT audit_event_actor_same_tenant_fk
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES "user" (tenant_id, id),
  CONSTRAINT audit_event_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id) REFERENCES programme (tenant_id, id)
);
-- The list is newest first and keyset-paginated on (occurred_at, id).
CREATE INDEX audit_event_tenant_time_idx ON audit_event (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX audit_event_tenant_actor_idx ON audit_event (tenant_id, actor_user_id);
CREATE INDEX audit_event_tenant_object_idx ON audit_event (tenant_id, object_id);
CREATE INDEX audit_event_tenant_programme_idx ON audit_event (tenant_id, programme_id);

ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_event_isolation ON audit_event FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND (programme_id IS NULL OR programme_id = ANY (app.current_programme_ids())))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND (programme_id IS NULL OR programme_id = ANY (app.current_programme_ids())));

-- RESTRICTIVE, so it narrows the policy above rather than widening anything:
-- an application session can only write events whose actor is itself. The
-- API cannot attribute an action to somebody else, and cannot write a
-- `system` event at all - a system writer (a worker) is a later decision and
-- arrives with its own policy.
CREATE POLICY audit_event_actor_is_session ON audit_event AS RESTRICTIVE FOR INSERT
  WITH CHECK (actor_kind = 'user' AND actor_user_id = app.current_user_id());

-- Append-only for everyone, owner included. TRUNCATE and DELETE (tenant
-- cascade, retention) fire no UPDATE trigger. SECURITY INVOKER; names nothing.
CREATE FUNCTION app.audit_event_reject_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION app.audit_event_reject_update() FROM PUBLIC;

CREATE TRIGGER audit_event_append_only
  BEFORE UPDATE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION app.audit_event_reject_update();

-- --- audit_export ----------------------------------------------------------
-- A request for an export. The file is built by a worker (not yet written) and
-- emailed to the requester; this row never holds a URL. The worker must
-- re-resolve the requester's scope from user_programme when it runs, exactly as
-- a request would - `filters` narrows, it never carries scope. A
-- sourceIpPrefix filter is stored as null (given, value not kept).
CREATE TABLE audit_export (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  requested_by_user_id  uuid        NOT NULL,
  format                text        NOT NULL,
  scope                 text        NOT NULL,
  filters               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  include_ip_addresses  boolean     NOT NULL DEFAULT false,
  status                text        NOT NULL DEFAULT 'queued',
  requested_at          timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  UNIQUE (tenant_id, id),
  CONSTRAINT audit_export_format_check CHECK (format IN ('csv', 'json')),
  CONSTRAINT audit_export_scope_check CHECK (scope IN ('filtered', 'last_90_days')),
  CONSTRAINT audit_export_status_check
    CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  CONSTRAINT audit_export_filters_check CHECK (jsonb_typeof(filters) = 'object'),
  CONSTRAINT audit_export_requester_same_tenant_fk
    FOREIGN KEY (tenant_id, requested_by_user_id) REFERENCES "user" (tenant_id, id)
);
CREATE INDEX audit_export_tenant_requester_idx ON audit_export (tenant_id, requested_by_user_id);

ALTER TABLE audit_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_export FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_export_isolation ON audit_export FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND requested_by_user_id = app.current_user_id())
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND requested_by_user_id = app.current_user_id());

-- --- grants ----------------------------------------------------------------
-- Revoke what the bootstrap's default privileges granted, then grant exactly
-- what is needed. audit_export's status moves (queued -> running -> ready) are
-- the worker's, and get a column-level UPDATE grant when the worker exists.
REVOKE ALL ON audit_event, audit_export FROM PUBLIC, kasuwa_app, kasuwa_test_admin;
GRANT SELECT, INSERT ON audit_event, audit_export TO kasuwa_app;
GRANT SELECT ON audit_event, audit_export TO kasuwa_test_admin;
