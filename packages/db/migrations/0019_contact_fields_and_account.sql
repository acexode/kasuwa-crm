-- ---------------------------------------------------------------------------
-- 0019 - contact fields and accounts (T-0040; D-L60 item 2, D-L61, D-L12).
--
-- Three changes, one file:
--   1. A new programme-scoped table, `account`, shaped exactly like contact.
--   2. The M3 columns D-L12 deferred, added to `contact`, including
--      contact.account_id.
--   3. An integer `version` on contact and account, for the optimistic
--      concurrency the T-0039 records contract requires (the same pattern as
--      programme_sla.version). The repository increments it (T-0041).
--
-- NOT here (D-L13): NIN and BVN. They arrive later as encrypted-only types
-- with a blind index. No column in this file may hold or derive from either.
-- Also not here: custom-field storage, and network-prefix detection (PRD Q5).
-- phone_network is free text that nothing populates yet.
--
-- TENANCY. Every invariant from 0001 holds for account:
--   - tenant_id NOT NULL, with an FK to tenant;
--   - RLS ENABLED *and* FORCED;
--   - one policy, scoped on tenant AND programme, with WITH CHECK identical to
--     USING;
--   - composite FKs carry tenant_id, because referential checks ignore row
--     security.
-- The two new FKs on contact are composite for the same reason:
--   - contact.owner_user_id: (tenant_id, owner_user_id) -> "user" (tenant_id, id).
--     A plain FK on owner_user_id would accept another tenant's user.
--   - contact.account_id: (tenant_id, programme_id, account_id)
--     -> account (tenant_id, programme_id, id). A contact can only belong to an
--     account in its own programme. A session that sees both A1 and A2 is not
--     stopped by RLS from linking across them; only the key stops it.
--
-- ON DELETE for the two new FKs: NO ACTION (the default), written out so it
-- reads as a choice. D-L61 leaves "what happens to contacts when an account or
-- owner is deleted" open. Refusing the delete is the only answer that loses no
-- data and can be relaxed later. Nothing hard-deletes a user or an account
-- today: users are disabled, not deleted. A tenant or programme delete still
-- cascades cleanly, because contact and its parent both go in the same
-- statement and NO ACTION is checked at the end of the statement. RESTRICT is
-- checked immediately and could fail depending on cascade order.
--   A plain ON DELETE SET NULL would be WRONG here. On a composite key it nulls
--   EVERY referencing column, so it would try to set contact.tenant_id (and,
--   for account_id, contact.programme_id) to NULL. NOT NULL would reject that,
--   so the parent delete would fail with a confusing error. If "unlink on
--   delete" is decided later, PG 15+ supports the column-list form:
--   ON DELETE SET NULL (account_id). That is a new migration.
--
-- VALUE SETS (D-L61; pinned by
-- tests/acceptance/records/contact-fields.acceptance.test.ts):
--   - Stored values are snake_case codes. Display labels ("Opted in", "Missed
--     call") are i18n strings and are rejected here.
--   - The sets are enforced with CHECK, not enum types. Adding a value is then
--     a DROP/ADD CONSTRAINT in a new migration, which works inside the runner's
--     per-file transaction. An enum's ADD VALUE does not work there, and an
--     enum value cannot be removed.
--   - status and source are nullable: the migration cannot know them for
--     existing rows, and inventing a value would be a lie.
--   - consent_state is NOT NULL DEFAULT 'unknown'. It never defaults to
--     consent. NULL is refused because `consent_state <> 'opted_in'` silently
--     drops NULL rows from exactly the "not consented" filters NDPA cares
--     about.
--   - preferred_language gets a BCP-47 FORMAT check (RFC 5646 langtag
--     structure, plus private-use tags). It is not checked against the UI
--     catalogue list in @kasuwa/i18n. That list says what Kasuwa's screens can
--     render, not what a customer speaks.
--
-- DND (D-L61). `dnd boolean NOT NULL DEFAULT false` cannot tell "checked
-- against the NCC register, not listed" from "never checked". No promotional
-- send may rely on dnd = false until a dnd_checked_at, or a register lookup at
-- send time, exists (M8/M13).
--
-- updated_at ON account. The schema maintains it (T-0011): a BEFORE UPDATE
-- trigger sets it to now() only when the statement left it unchanged, so a
-- statement that writes its own updated_at keeps it. This file attaches
-- 0018's app.touch_updated_at() to account; it does not define a second
-- function. 0018's self-check ran before account existed, so the
-- schema-hygiene suite (which reads the catalogue) is what holds this table
-- to the rule.
--
-- GRANTS: the same as contact (full DML for kasuwa_app and kasuwa_test_admin).
-- Restated explicitly, as in 0014, so this file does not silently depend on
-- the bootstrap's default privileges.
--
-- LOCKING. Ordered per the 0018 review: the new table, its policy, grants
-- and trigger first. The ALTER TABLE contact, which takes ACCESS EXCLUSIVE on
-- a hot table, comes last, so that lock is held for the shortest time.
--   - The constant defaults are metadata-only (no rewrite).
--   - The CHECKs and FKs validate by scanning contact. Every existing row is
--     NULL or default in the new columns, so the scan is quick.
--   - The two indexes on contact come after the ALTER, in the same
--     transaction, so the lock is already held.
--   - lock_timeout bounds the wait for the lock.
--   - At volume this would be split: ADD ... NOT VALID, then VALIDATE
--     CONSTRAINT in a later file.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- account -----------------------------------------------------------------
CREATE TABLE account (
  id            uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  programme_id  uuid        NOT NULL,
  name          text        NOT NULL,
  -- Optimistic-concurrency counter (T-0039 contract). The repository bumps
  -- it on update (T-0041); no trigger does.
  version       integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- The target of contact's composite account FK.
  UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT account_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT account_name_length_check CHECK (char_length(name) BETWEEN 1 AND 200)
);

-- Same shape as contact_keyset_idx, for the account list (next slice).
CREATE INDEX account_keyset_idx
  ON account (tenant_id, programme_id, created_at DESC, id DESC);

ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE account FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON account FOR ALL
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON account TO kasuwa_app, kasuwa_test_admin;

-- --- account.updated_at: 0018's trigger function, attached -------------------
CREATE TRIGGER account_touch_updated_at
  BEFORE UPDATE ON account FOR EACH ROW
  WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION app.touch_updated_at();

-- --- contact: the M3 columns -------------------------------------------------
ALTER TABLE contact
  ADD COLUMN owner_user_id      uuid,
  ADD COLUMN status             text,
  ADD COLUMN source             text,
  ADD COLUMN tags               text[],
  ADD COLUMN preferred_language text,
  ADD COLUMN preferred_channel  text,
  ADD COLUMN state              text,
  ADD COLUMN lga                text,
  ADD COLUMN dnd                boolean NOT NULL DEFAULT false,
  ADD COLUMN whatsapp_opt_in    boolean NOT NULL DEFAULT false,
  ADD COLUMN consent_state      text    NOT NULL DEFAULT 'unknown',
  ADD COLUMN phone_network      text,
  ADD COLUMN account_id         uuid,
  -- Optimistic-concurrency counter (T-0039: updateContact answers 409
  -- stale_write on a mismatch). The repository bumps it (T-0041); no trigger.
  ADD COLUMN version            integer NOT NULL DEFAULT 1,

  ADD CONSTRAINT contact_owner_same_tenant_fk
    FOREIGN KEY (tenant_id, owner_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE NO ACTION,
  ADD CONSTRAINT contact_account_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, account_id)
    REFERENCES account (tenant_id, programme_id, id) ON DELETE NO ACTION,

  ADD CONSTRAINT contact_version_check CHECK (version >= 1),
  ADD CONSTRAINT contact_status_check
    CHECK (status IN ('new', 'contacted', 'qualified', 'unqualified', 'customer')),
  ADD CONSTRAINT contact_source_check
    CHECK (source IN ('whatsapp', 'ussd', 'web_form', 'missed_call', 'import', 'api',
                      'manual', 'referral', 'walk_in')),
  ADD CONSTRAINT contact_preferred_channel_check
    CHECK (preferred_channel IN ('whatsapp', 'sms', 'voice', 'email')),
  ADD CONSTRAINT contact_consent_state_check
    CHECK (consent_state IN ('unknown', 'opted_in', 'pending', 'withdrawn')),
  -- RFC 5646 langtag structure:
  --   language [-extlang] [-script] [-region] *(-variant) *(-extension)
  --   [-privateuse]
  -- or a private-use tag on its own. Format only; not a registry lookup.
  ADD CONSTRAINT contact_preferred_language_bcp47_check
    CHECK (preferred_language ~ (
      '^(('
        || '([A-Za-z]{2,3}(-[A-Za-z]{3}){0,3}|[A-Za-z]{4,8})'
        || '(-[A-Za-z]{4})?'
        || '(-([A-Za-z]{2}|[0-9]{3}))?'
        || '(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*'
        || '(-[0-9A-WY-Za-wy-z](-[A-Za-z0-9]{2,8})+)*'
        || '(-[Xx](-[A-Za-z0-9]{1,8})+)?'
      || ')|([Xx](-[A-Za-z0-9]{1,8})+))$'
    )),
  -- A tag list may be empty; a NULL element is never a tag.
  ADD CONSTRAINT contact_tags_no_null_element_check
    CHECK (array_position(tags, NULL) IS NULL);

-- The FK lookups on parent delete, plus "contacts of this account" and
-- "my contacts". Partial, because most rows will carry neither for a while.
CREATE INDEX contact_account_idx
  ON contact (tenant_id, programme_id, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX contact_owner_idx
  ON contact (tenant_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
