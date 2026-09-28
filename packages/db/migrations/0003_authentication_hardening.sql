-- ---------------------------------------------------------------------------
-- 0003 — hardening the authentication tables added in 0002 (T-0001, round two).
--
-- Written after a security review of 0002 found two races and an enumeration
-- oracle. Everything here exists because something in 0002 was wrong, so each
-- section says what was wrong rather than only what it now does.
--
-- Five changes:
--
--   1. auth_rate_limit replaces auth_attempt. It is NOT TENANT-SCOPED, which
--      is a deliberate, reasoned exception to the rule that every table carries
--      tenant_id. See the capitalised note on the table and ADR-0009.
--   2. auth_attempt is DROPPED. It was introduced in 0002, in this same
--      unmerged change, and never reached any environment that is not thrown
--      away. Dropping it here rather than editing 0002 keeps migrations
--      append-only, which matters more than a tidy history; leaving it in place
--      half-used would leave a table whose own comment lied about its purpose,
--      which is exactly the failure mode the review criticised elsewhere.
--   3. user_mfa_factor gains last_used_step, so a TOTP code cannot be replayed
--      inside the ninety seconds it stays arithmetically valid.
--   4. app.resolve_session is replaced to check tenant status, so suspending a
--      tenant cuts off its existing sessions instead of only stopping new
--      sign-ins.
--   5. auth_challenge gains an index on (tenant_id, user_id), which the
--      per-user open-challenge cap reads on every sign-in.
--
-- It also ASSERTS, at the end, that neither SECURITY DEFINER function is
-- executable by PUBLIC. That is not decoration: see the note above the block.
-- ---------------------------------------------------------------------------

-- --- auth_rate_limit -------------------------------------------------------
--
-- THIS TABLE DELIBERATELY HAS NO tenant_id. IT IS THE ONLY ONE, AND IT IS AN
-- EXCEPTION TO CLAUDE.md SECTION 2 RULE 4, DECIDED IN ADR-0009 RATHER THAN
-- OVERLOOKED.
--
-- The reason is the whole point of the table. Its job is to count failed
-- sign-in attempts for a workspace that MAY NOT EXIST, so that an unknown
-- workspace slug and a wrong password produce the same countdown and the same
-- lockout. A counter that could only be kept for real tenants would answer
-- differently for a fake one after two requests, which is precisely the
-- enumeration oracle it is here to close. A table whose purpose is to answer
-- identically for tenants that do not exist cannot be scoped to a tenant.
--
-- It is therefore NOT in TENANT_SCOPED_TABLES. The catalogue invariant in
-- tests/acceptance/tenancy/rls-enforcement.acceptance.test.ts asserts set
-- equality over that list, so the exemption is named explicitly in
-- NON_TENANT_SCOPED_TABLES (packages/db/src/schema.ts) and honoured by
-- readTableSecurity (packages/testing/src/isolation.ts). A silent exemption
-- would have been worse than the finding.
--
-- What it holds is a SHA-256 and three integers: no address and no tenant id in
-- plain text, and no business data at all. It is NOT free of personal data,
-- though, and an earlier draft of this comment wrongly said it was. The digest
-- is unkeyed over a low-entropy input, so anyone with the table and a candidate
-- address can confirm a match offline — which makes a row evidence that a named
-- person attempted to sign in at a named workspace. That is pseudonymised
-- personal data under the NDPA: in scope for retention and for subject access.
-- An HMAC under a server-held key would remove that, and needs the key
-- management D-L13 is blocked on. Until then these rows are swept, not kept.
--
-- The key is computed from what the CALLER SUBMITTED, before anything is
-- resolved, which is what makes the real and the fake workspace take the same
-- path.
--
-- RLS is still enabled and forced, with a policy, because a table without one
-- is a hole regardless of what it holds. The policy is USING (true), and that
-- is not a shrug: there is no tenant to predicate on, and the only thing a
-- session could do with unrestricted access is increment or clear a counter for
-- a key it already knows — which it can do anyway by making sign-in requests.
-- Nothing here is worth reading and nothing here is worth stealing.
CREATE TABLE auth_rate_limit (
  key_hash         bytea       NOT NULL PRIMARY KEY,
  failed_count     integer     NOT NULL DEFAULT 0,
  first_failed_at  timestamptz NOT NULL DEFAULT now(),
  last_failed_at   timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  CONSTRAINT auth_rate_limit_count_check CHECK (failed_count >= 0)
);
CREATE INDEX auth_rate_limit_expiry_idx ON auth_rate_limit (last_failed_at);

ALTER TABLE auth_rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_rate_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_rate_limit_open ON auth_rate_limit FOR ALL
  USING      (true)
  WITH CHECK (true);

-- --- auth_attempt is gone --------------------------------------------------
-- Superseded by auth_rate_limit above. See the note at the top of this file for
-- why it is dropped rather than 0002 being edited.
DROP TABLE auth_attempt;

-- --- TOTP replay -----------------------------------------------------------
-- 0002 accepted a code for the whole +/- one step window and remembered
-- nothing, so the same six digits worked for ninety seconds. Anyone who saw the
-- code over a shoulder, in a screen share, or in a phished form could replay it
-- while the victim was still typing.
--
-- Storing the last accepted step and refusing anything at or below it makes a
-- code single-use. bigint because the step is a unix-time division and will
-- outlive int4.
ALTER TABLE user_mfa_factor ADD COLUMN last_used_step bigint;

COMMENT ON COLUMN user_mfa_factor.last_used_step IS
  'Highest TOTP step already accepted for this factor. A code at or below it is refused, so a code is single-use rather than valid for its whole drift window.';

-- --- suspension must contain -----------------------------------------------
-- 0002 filtered suspended tenants in app.resolve_tenant_by_slug, so a suspended
-- tenant could not START a sign-in — but nothing checked status when resolving
-- an existing session, so every session already issued ran happily to its own
-- expiry. For a platform where suspension may follow a compliance event, that
-- makes "suspended" look like a containment control without being one.
--
-- Checking it here, on every request, is better than revoking sessions at
-- suspension time: it takes effect immediately, it cannot miss a session that
-- was issued during the race, and un-suspending restores access without
-- reissuing anything.
CREATE OR REPLACE FUNCTION app.resolve_session(p_token_hash bytea)
  RETURNS TABLE (session_id uuid, tenant_id uuid, user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.tenant_id, s.user_id
    FROM public.auth_session s
    JOIN public."user" u
      ON u.id = s.user_id
     AND u.tenant_id = s.tenant_id
    JOIN public.tenant t
      ON t.id = s.tenant_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.status = 'active'
     AND t.status <> 'suspended'
$$;

-- --- an index the open-challenge cap needs ---------------------------------
-- Counting a user's currently-open challenges happens on every sign-in.
CREATE INDEX auth_challenge_tenant_user_idx ON auth_challenge (tenant_id, user_id);

-- --- assert the grants, do not assume them --------------------------------
-- `app.resolve_session` is replaced above with CREATE OR REPLACE, which
-- PRESERVES the existing ACL — so the `REVOKE ALL ... FROM PUBLIC` from 0002
-- still holds. That is the only reason it holds, and it is a thin reason.
--
-- A future DROP FUNCTION + CREATE FUNCTION, which is how anyone would change a
-- function's signature or return type, starts from a fresh ACL. Postgres grants
-- EXECUTE on a new function to PUBLIC by default, so that edit would silently
-- hand every role in the database the two RLS-free reads in this system, and
-- nothing anywhere would notice.
--
-- So the migration checks, rather than trusting that the next person reads the
-- comment. If this ever fires, do not remove the check: add the REVOKE back.
DO $$
BEGIN
  IF has_function_privilege('public', 'app.resolve_session(bytea)', 'EXECUTE') THEN
    RAISE EXCEPTION
      'app.resolve_session is executable by PUBLIC. It is a SECURITY DEFINER '
      'function and the only RLS-free read path in the system; REVOKE ALL ON '
      'FUNCTION app.resolve_session(bytea) FROM PUBLIC.';
  END IF;

  IF has_function_privilege('public', 'app.resolve_tenant_by_slug(text)', 'EXECUTE') THEN
    RAISE EXCEPTION
      'app.resolve_tenant_by_slug is executable by PUBLIC. It is a SECURITY '
      'DEFINER function; REVOKE ALL ON FUNCTION app.resolve_tenant_by_slug(text) '
      'FROM PUBLIC.';
  END IF;
END
$$;
