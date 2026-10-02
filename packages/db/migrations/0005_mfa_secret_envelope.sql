-- ---------------------------------------------------------------------------
-- 0005 — TOTP secrets get envelope encryption (D-L13).
--
-- 0002 stored `user_mfa_factor.secret` as base32 PLAINTEXT and said so, because
-- D-L13 was BLOCKED and inventing a key-management scheme would have been
-- guessing at a decision the human had not made. The security review assessed
-- the residual risk as backup exposure: anyone holding a database backup holds
-- every second factor, at which point the second factor stops helping.
--
-- D-L13 is now answered: ENVELOPE ENCRYPTION, ONE KMS KEY PER ENVIRONMENT.
--
-- WHAT ENVELOPE MEANS HERE, AND WHY NOT ONE KEY. Each secret gets its own
-- AES-256-GCM data key. The data key is wrapped by the environment's KMS key
-- and stored next to the ciphertext; the KMS key never leaves the KMS. Rotation
-- is then a re-wrap of a small blob per row under a new KMS key, rather than a
-- decrypt-and-rewrite of every secret — which is the difference between a
-- rotation that can be done and one that is permanently postponed.
--
-- THIS IS THE EXPAND STEP AND IT DOES NOT, BY ITSELF, CLOSE THE FINDING.
-- Migrations are append-only (ADR-0004): expand, migrate, contract. This file
-- adds the columns; the application writes BOTH forms and reads the new one
-- first, falling back to the old. The plaintext column is still populated, so a
-- backup is still enough, until a later migration backfills the remaining
-- legacy rows and DROPS `secret`. That contract migration is what closes the
-- finding, and it should follow closely — an expand step left in place
-- indefinitely is a half-measure wearing the clothes of a fix.
--
-- WHY THE KEY ID IS A COLUMN. So that two keys can be live at once. A rotation
-- introduces key N+1, new and re-wrapped rows record it, and `WHERE
-- secret_key_id = <old>` is the work queue. A single deployment-wide key id in
-- configuration would make every rotation a flag day.
--
-- NO RLS CHANGES. Columns are added to a table that already has RLS ENABLEd and
-- FORCEd with a policy whose WITH CHECK is identical to its USING (0002); a
-- column cannot be exempt from a row policy. TENANT_SCOPED_TABLES is unchanged
-- because no table is added.
-- ---------------------------------------------------------------------------

ALTER TABLE user_mfa_factor
  ADD COLUMN secret_ciphertext  bytea,
  ADD COLUMN secret_wrapped_key bytea,
  ADD COLUMN secret_key_id      text,
  ADD COLUMN secret_algorithm   text;

COMMENT ON COLUMN user_mfa_factor.secret_ciphertext IS
  'The TOTP secret under AES-256-GCM with a per-secret data key: iv || tag || body. '
  'Authenticated against the row (tenant id and factor id), so a ciphertext cannot '
  'be moved onto another user''s row.';
COMMENT ON COLUMN user_mfa_factor.secret_wrapped_key IS
  'The data key, encrypted under this environment''s KMS key. Never logged.';
COMMENT ON COLUMN user_mfa_factor.secret_key_id IS
  'Which KMS key wrapped the data key. Per row, so a rotation can be incremental.';
COMMENT ON COLUMN user_mfa_factor.secret_algorithm IS
  'On-disk format marker, e.g. A256GCM-ENV1. Stored rather than assumed so a future '
  'format can be introduced without guessing what old rows are.';
COMMENT ON COLUMN user_mfa_factor.secret IS
  'LEGACY plaintext base32 TOTP secret (0002). Being replaced by the secret_* columns '
  'above; nullable from 0005 so a ciphertext-only row is representable, and to be '
  'dropped by the contract migration once every row is encrypted.';

-- The four envelope columns are meaningless apart: a ciphertext with no wrapped
-- key cannot be opened, and a wrapped key with no ciphertext is noise. All four
-- or none, enforced rather than assumed.
ALTER TABLE user_mfa_factor
  ADD CONSTRAINT user_mfa_factor_envelope_complete_check CHECK (
    num_nonnulls(secret_ciphertext, secret_wrapped_key, secret_key_id, secret_algorithm)
      IN (0, 4)
  );

-- Expand: `secret` stops being NOT NULL so a row MAY be ciphertext-only. It is
-- not dropped here and existing rows keep their value — a rollback to the
-- previous application version must still be able to sign people in.
ALTER TABLE user_mfa_factor ALTER COLUMN secret DROP NOT NULL;

-- ...but a factor with neither form is a row that can never verify anything, and
-- would present to the application as "no second factor enrolled" — i.e. it
-- would silently drop MFA for that user. Refused at the database.
ALTER TABLE user_mfa_factor
  ADD CONSTRAINT user_mfa_factor_secret_present_check CHECK (
    secret IS NOT NULL OR secret_ciphertext IS NOT NULL
  );

-- The rotation work queue, and cheap: a partial index over the rows that carry a
-- key id, which is every encrypted row and no legacy one.
CREATE INDEX user_mfa_factor_secret_key_id_idx
  ON user_mfa_factor (secret_key_id)
  WHERE secret_key_id IS NOT NULL;
