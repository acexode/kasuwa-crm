-- ---------------------------------------------------------------------------
-- 0011 - programme SLA policy and record-retention policy (T-0028).
--
-- Contract: docs/api/admin.openapi.yaml, operations getProgrammeSla,
-- updateProgrammeSla, getProgrammeRetention and updateProgrammeRetention.
-- Semantics: D-L50.
--
-- Three tables, all programme-scoped:
--
--   * programme_sla         - one row per configured programme: clock rules,
--                             warning threshold, who is notified, version.
--   * programme_sla_target  - one row per channel target of that policy.
--   * programme_retention   - one row per configured programme.
--
-- No row means "not configured". For SLA the API then answers with the
-- platform default defined in code (version 0); for retention it answers 404.
-- Nothing is seeded here.
--
-- Durations carry their unit in the column name and are integers: seconds for
-- SLA targets, days for retention periods. A NULL SLA target means "no target"
-- (voice "Same call"); a retention period is never NULL.
--
-- call_recordings_days is STORED, NOT ENFORCED by Kasuwa: recording retention
-- belongs to the telephony platform (ADR-0003, D-T4 deferred). It is kept so
-- the screen round-trips and so the value exists when that is decided.
--
-- Every tenancy invariant from 0001 applies in full:
--   1. tenant_id on every table, NOT NULL, FK to tenant.
--   2. programme_id NOT NULL; composite FKs carry tenant_id, so a policy can
--      never point at another tenant's programme even with RLS bypassed.
--   3. RLS ENABLED *and* FORCED.
--   4. The one policy per table has a WITH CHECK identical to its USING, and
--      both filter on tenant AND the session's programme ids.
--
-- Grants: restated explicitly so this file does not depend on how the
-- database was bootstrapped (same as 0006).
-- ---------------------------------------------------------------------------

-- --- programme_sla ----------------------------------------------------------
CREATE TABLE programme_sla (
  tenant_id                       uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id                    uuid        NOT NULL,
  -- Optimistic-concurrency counter. Starts at 1; 0 is the unconfigured default.
  version                         integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  pause_outside_operating_hours   boolean     NOT NULL,
  pause_awaiting_customer         boolean     NOT NULL,
  warn_at_percent_of_target       integer     NOT NULL
    CHECK (warn_at_percent_of_target BETWEEN 1 AND 100),
  warn_notify_role                text        NOT NULL
    CHECK (warn_notify_role IN ('assigned_agent', 'team_lead', 'programme_manager',
                                'programme_manager_and_client')),
  breach_notify_role              text        NOT NULL
    CHECK (breach_notify_role IN ('assigned_agent', 'team_lead', 'programme_manager',
                                  'programme_manager_and_client')),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, programme_id),
  CONSTRAINT programme_sla_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE programme_sla ENABLE ROW LEVEL SECURITY;
ALTER TABLE programme_sla FORCE ROW LEVEL SECURITY;
CREATE POLICY programme_sla_isolation ON programme_sla FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON programme_sla TO kasuwa_app, kasuwa_test_admin;

-- --- programme_sla_target ---------------------------------------------------
CREATE TABLE programme_sla_target (
  tenant_id               uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id            uuid        NOT NULL,
  channel                 text        NOT NULL
    CHECK (channel IN ('whatsapp', 'voice', 'sms', 'email', 'ussd')),
  -- NULL = no target for this channel. Never 0: "no target" is not "instant".
  first_response_seconds  integer     CHECK (first_response_seconds >= 1),
  resolution_seconds      integer     CHECK (resolution_seconds >= 1),
  clock                   text        NOT NULL CHECK (clock IN ('business_hours', 'always')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- One target per channel per programme: a duplicate is refused by the API
  -- (400) and, independently, here.
  PRIMARY KEY (tenant_id, programme_id, channel),
  CONSTRAINT programme_sla_target_policy_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme_sla (tenant_id, programme_id) ON DELETE CASCADE
);

ALTER TABLE programme_sla_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE programme_sla_target FORCE ROW LEVEL SECURITY;
CREATE POLICY programme_sla_target_isolation ON programme_sla_target FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON programme_sla_target TO kasuwa_app, kasuwa_test_admin;

-- --- programme_retention ----------------------------------------------------
CREATE TABLE programme_retention (
  tenant_id                                 uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id                              uuid        NOT NULL,
  -- Starts at 1; the first write sends 0 ("no policy yet"), which is then stale.
  version                                   integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Stored and returned, NOT enforced by Kasuwa (D-T4): see the header.
  call_recordings_days                      integer     NOT NULL CHECK (call_recordings_days >= 1),
  message_transcripts_days                  integer     NOT NULL CHECK (message_transcripts_days >= 1),
  screen_recordings_days                    integer     NOT NULL CHECK (screen_recordings_days >= 1),
  qa_evaluations_days                       integer     NOT NULL CHECK (qa_evaluations_days >= 1),
  on_expiry                                 text        NOT NULL
    CHECK (on_expiry IN ('delete', 'anonymise')),
  redact_sensitive_numbers_in_transcripts   boolean     NOT NULL,
  legal_hold                                boolean     NOT NULL,
  created_at                                timestamptz NOT NULL DEFAULT now(),
  updated_at                                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, programme_id),
  CONSTRAINT programme_retention_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE programme_retention ENABLE ROW LEVEL SECURITY;
ALTER TABLE programme_retention FORCE ROW LEVEL SECURITY;
CREATE POLICY programme_retention_isolation ON programme_retention FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON programme_retention TO kasuwa_app, kasuwa_test_admin;
