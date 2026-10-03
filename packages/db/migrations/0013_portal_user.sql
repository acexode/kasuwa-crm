-- ---------------------------------------------------------------------------
-- 0013 - client-portal users and their invitations (T-0030, M18 groundwork).
--
-- Contract: docs/api/admin.openapi.yaml, operations listPortalUsers and
-- invitePortalUser. Decisions: D-L49 (a re-invite is a resend with a rotated
-- token; the list returns only a masked address).
--
-- A portal user is an OUTSIDER - a BPO client's staff member - granted sight
-- of exactly ONE programme. So, unlike role and permission_set (0006), this
-- table is programme-scoped and programme_id is NOT NULL: a programme-less
-- portal user is a defect, not a tenant-wide one.
--
-- Every tenancy invariant from 0001 applies in full:
--   1. tenant_id NOT NULL, FK to tenant.
--   2. RLS ENABLED *and* FORCED.
--   3. The policy's WITH CHECK is identical to its USING, and both carry the
--      programme predicate, exactly as contact's do: a caller sees and writes
--      only invitations in programmes their session resolved from
--      user_programme.
--   4. The programme foreign key is composite with tenant_id, so a row can
--      never point at another tenant's programme even with RLS bypassed.
--   5. Uniqueness is per (tenant, programme), never global. A global unique
--      index on the address would let one tenant's answer disclose that
--      another tenant had invited that person - the existence oracle the
--      acceptance suite probes for.
--
-- The invite token is a credential. Only its SHA-256 is stored
-- (invite_token_hash), the same treatment as auth_session.token_hash; the
-- token is 32 random bytes, so an unkeyed digest is not guessable. A re-invite
-- overwrites the hash, which is what makes the previous token stop working.
-- Accepting (M18) will null it, which is what will make it single-use.
--
-- The address itself is stored in plaintext, as "user".email is: it is the
-- invitation's identity and a resend has to reach it. It is never returned by
-- the list (email_masked is), never logged, and never written to an audit row.
--
-- Grants: restated explicitly so this file does not silently depend on how the
-- database was bootstrapped (same as 0006).
-- ---------------------------------------------------------------------------

CREATE TABLE portal_user (
  id                       uuid        PRIMARY KEY,
  tenant_id                uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id             uuid        NOT NULL,
  email                    text        NOT NULL,
  -- What the row renders (PortalUser.emailMasked). Computed once, at invite.
  email_masked             text        NOT NULL,
  display_name             text        NOT NULL,
  access                   text        NOT NULL,
  status                   text        NOT NULL DEFAULT 'invited',
  -- SHA-256 of the current invite token; null once accepted (M18).
  invite_token_hash        bytea,
  invite_token_expires_at  timestamptz,
  invited_at               timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_user_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT portal_user_access_check CHECK (access IN ('viewer', 'reports_only')),
  CONSTRAINT portal_user_status_check CHECK (status IN ('invited', 'active', 'suspended')),
  CONSTRAINT portal_user_email_length_check CHECK (char_length(email) BETWEEN 3 AND 320),
  CONSTRAINT portal_user_display_name_length_check
    CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT portal_user_token_hash_length_check
    CHECK (invite_token_hash IS NULL OR octet_length(invite_token_hash) = 32)
);

-- One portal user per address per programme, case-insensitively. This is the
-- conflict target a re-invite resolves against (a resend, D-L49).
CREATE UNIQUE INDEX portal_user_programme_email_key
  ON portal_user (tenant_id, programme_id, lower(email));

-- The list: newest invitation first, within one programme.
CREATE INDEX portal_user_programme_list_idx
  ON portal_user (tenant_id, programme_id, invited_at DESC, id DESC);

-- The accept flow (M18) will look a token up by its digest.
CREATE UNIQUE INDEX portal_user_invite_token_hash_key
  ON portal_user (invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

ALTER TABLE portal_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_user FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_user_isolation ON portal_user FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON portal_user TO kasuwa_app, kasuwa_test_admin;
