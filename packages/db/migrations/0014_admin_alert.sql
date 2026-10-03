-- ---------------------------------------------------------------------------
-- 0014 - admin-home alerts and per-user dismissal (P02/A, T-0031, Agent 7).
--
-- Contract: docs/api/admin.openapi.yaml, operations listAdminAlerts,
-- dismissAdminAlert, restoreAdminAlert and getSettingsMenuBadges.
--
-- D-L47: an alert belongs to a programme. A tenant-wide alert is stored once
-- per programme it concerns; there is no programme-less alert in this wave.
-- So admin_alert is programme-scoped exactly like contact: a member of A1 sees
-- A1's alerts and never A2's, and a user with no programme sees none.
--
-- Dismissal is per user, not per workspace ("one admin clearing an alert must
-- not hide it from another"), and reversible. One row per (alert, user): the
-- primary key is what makes a repeated PUT idempotent rather than a second row.
--
-- Every tenancy invariant from 0001 applies in full:
--   1. tenant_id on every table, NOT NULL, FK to tenant.
--   2. RLS ENABLED *and* FORCED.
--   3. Every policy's WITH CHECK is identical to its USING.
--   4. Composite foreign keys carry tenant_id, so an alert cannot point at
--      another tenant's programme and a dismissal cannot point at another
--      tenant's alert or user - not even with RLS bypassed, because
--      referential checks ignore row security.
--
-- admin_alert_dismissal repeats the alert's programme_id (held consistent by
-- the composite FK to admin_alert (tenant_id, programme_id, id)) so that its
-- policy can be programme-scoped without a subquery: a user removed from a
-- programme stops seeing their dismissals there along with the alerts. Its
-- policy is also pinned to app.current_user_id(): a session can read and write
-- only its own dismissals, which is the whole meaning of "per user".
--
-- What an alert row may hold (AdminAlert): Kasuwa users and Kasuwa
-- configuration, never a customer and never a contact detail. Nothing here can
-- enforce that on free text; the writers (none in this wave) must.
--
-- Grants: restated explicitly, as in 0006, so this file does not silently
-- depend on how the database was bootstrapped.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- admin_alert -------------------------------------------------------------
CREATE TABLE admin_alert (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id  uuid        NOT NULL,
  severity      text        NOT NULL,
  category      text        NOT NULL,
  title         text        NOT NULL,
  body          text        NOT NULL,
  source_label  text,
  raised_at     timestamptz NOT NULL DEFAULT now(),
  action_label  text,
  -- The settings-menu item the alert points at (a stable client key such as
  -- `ch-wa`). Free text by design: "a settingId the client does not recognise
  -- is ignored", which is what lets a badge ship before its screen.
  setting_id    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- The target of admin_alert_dismissal's composite foreign key.
  UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT admin_alert_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT admin_alert_severity_check
    CHECK (severity IN ('info', 'success', 'warning', 'danger')),
  CONSTRAINT admin_alert_category_check
    CHECK (category IN ('security', 'channels', 'compliance', 'billing', 'data')),
  CONSTRAINT admin_alert_title_length_check CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT admin_alert_body_length_check CHECK (char_length(body) BETWEEN 1 AND 2000)
);
CREATE INDEX admin_alert_tenant_programme_raised_idx
  ON admin_alert (tenant_id, programme_id, raised_at DESC);

ALTER TABLE admin_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_alert FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_alert_isolation ON admin_alert FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_alert TO kasuwa_app, kasuwa_test_admin;

-- --- admin_alert_dismissal ---------------------------------------------------
CREATE TABLE admin_alert_dismissal (
  alert_id      uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id  uuid        NOT NULL,
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  -- One dismissal row per user per alert.
  PRIMARY KEY (alert_id, user_id),
  CONSTRAINT admin_alert_dismissal_alert_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id, alert_id)
    REFERENCES admin_alert (tenant_id, programme_id, id) ON DELETE CASCADE,
  CONSTRAINT admin_alert_dismissal_user_same_tenant_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX admin_alert_dismissal_tenant_user_idx
  ON admin_alert_dismissal (tenant_id, user_id);

ALTER TABLE admin_alert_dismissal ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_alert_dismissal FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_alert_dismissal_isolation ON admin_alert_dismissal FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids())
              AND user_id = app.current_user_id())
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids())
              AND user_id = app.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_alert_dismissal TO kasuwa_app, kasuwa_test_admin;
