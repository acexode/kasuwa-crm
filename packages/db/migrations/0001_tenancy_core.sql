-- ---------------------------------------------------------------------------
-- 0001 - the tenancy hierarchy and one programme-scoped business object.
--
--   tenant -> business_unit -> programme -> user (via user_programme)
--   contact is the single programme-scoped object in the vertical slice.
--
-- Invariants enforced here (see docs/adr/0002-pooled-tenancy-via-rls.md):
--   1. Every table carries tenant_id (tenant itself uses its own id).
--   2. Every table has RLS ENABLED *and* FORCED. FORCE matters: without it the
--      table owner (kasuwa_migrator) silently bypasses its own policies.
--   3. Programme-scoped tables additionally filter on app.current_programme_ids().
--   4. Every policy has a WITH CHECK identical to its USING clause, so a session
--      cannot write a row it would not be allowed to read back.
--   5. Composite foreign keys carry tenant_id, so a child row can never point at
--      a parent in another tenant even if RLS were somehow bypassed.
--
-- NOTE ON THE `user` TABLE NAME: `user` is a reserved word in SQL and must be
-- double-quoted everywhere. This is deliberate - the founding pack section 3.4
-- names the entity `user`. Drizzle quotes all identifiers, so only hand-written
-- SQL needs care. See team/DECISIONS.md section C.
-- ---------------------------------------------------------------------------

-- --- tenant ----------------------------------------------------------------
CREATE TABLE tenant (
  id                uuid        PRIMARY KEY,
  name              text        NOT NULL,
  slug              text        NOT NULL UNIQUE,
  region_cell       text        NOT NULL DEFAULT 'za-1',
  locale_default    text        NOT NULL DEFAULT 'en-NG',
  currency_default  char(3)     NOT NULL DEFAULT 'NGN',
  status            text        NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_status_check CHECK (status IN ('active', 'suspended', 'trial'))
);

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant FOR ALL
  USING      (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

-- --- business_unit ---------------------------------------------------------
CREATE TABLE business_unit (
  id          uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);
CREATE INDEX business_unit_tenant_idx ON business_unit (tenant_id);

ALTER TABLE business_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_unit FORCE ROW LEVEL SECURITY;
CREATE POLICY business_unit_isolation ON business_unit FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- --- programme -------------------------------------------------------------
-- A programme is a BPO client engagement. Non-BPO tenants get exactly one
-- default programme so that no programme-scoped row ever has a null parent.
CREATE TABLE programme (
  id                uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  business_unit_id  uuid        NOT NULL,
  name              text        NOT NULL,
  client_name       text,
  is_default        boolean     NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id),
  CONSTRAINT programme_bu_same_tenant_fk
    FOREIGN KEY (tenant_id, business_unit_id)
    REFERENCES business_unit (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX programme_tenant_idx ON programme (tenant_id);

ALTER TABLE programme ENABLE ROW LEVEL SECURITY;
ALTER TABLE programme FORCE ROW LEVEL SECURITY;
-- A user sees only the programmes they are a member of, not every programme in
-- the tenant. This is what makes the URL-manipulation acceptance test meaningful.
CREATE POLICY programme_isolation ON programme FOR ALL
  USING      (tenant_id = app.current_tenant_id() AND id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id() AND id = ANY (app.current_programme_ids()));

-- --- user ------------------------------------------------------------------
CREATE TABLE "user" (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  email         text        NOT NULL,
  display_name  text        NOT NULL,
  locale        text        NOT NULL DEFAULT 'en-NG',
  status        text        NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, id),
  CONSTRAINT user_status_check CHECK (status IN ('active', 'disabled', 'invited'))
);
CREATE INDEX user_tenant_idx ON "user" (tenant_id);

ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;
-- Tenant-scoped only, NOT programme-scoped: resolving a session's programme
-- membership happens before app.programme_ids is known, so these two tables must
-- be readable with tenant scope alone. Which users a given user may *see* is a
-- permissions question (M2), not a tenancy question.
CREATE POLICY user_isolation ON "user" FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- --- user_programme --------------------------------------------------------
CREATE TABLE user_programme (
  user_id       uuid        NOT NULL,
  programme_id  uuid        NOT NULL,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  skills        text[]      NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, programme_id),
  CONSTRAINT user_programme_user_same_tenant_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_programme_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX user_programme_tenant_user_idx ON user_programme (tenant_id, user_id);

ALTER TABLE user_programme ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_programme FORCE ROW LEVEL SECURITY;
CREATE POLICY user_programme_isolation ON user_programme FOR ALL
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- --- contact ---------------------------------------------------------------
-- Minimal fields only (team/DECISIONS.md D-L12). consent_state, nin_token,
-- bvn_token, custom jsonb, preferred_channel/language and network detection are
-- M3 (Agent 3) and must not be added here.
CREATE TABLE contact (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id  uuid        NOT NULL,
  display_name  text        NOT NULL,
  given_names   text,
  family_name   text,
  phones        jsonb       NOT NULL DEFAULT '[]',
  emails        jsonb       NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE
);

-- Keyset pagination index: matches ORDER BY created_at DESC, id DESC exactly.
CREATE INDEX contact_keyset_idx
  ON contact (tenant_id, programme_id, created_at DESC, id DESC);

ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact FORCE ROW LEVEL SECURITY;
CREATE POLICY contact_isolation ON contact FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));
