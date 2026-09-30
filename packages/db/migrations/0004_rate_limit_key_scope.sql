-- ---------------------------------------------------------------------------
-- 0004 — auth_rate_limit stops being readable and deletable by every session
--        in the cell (T-0020, from T-0004 FINDING-3).
--
-- 0003 gave auth_rate_limit the policy `USING (true) WITH CHECK (true)`, on an
-- argument written out in ADR-0009 and in 0003's own comment:
--
--     "the only thing a session could do with unrestricted access is increment
--      or clear a counter for a key it already knows — which it can do anyway
--      by making sign-in requests"
--
-- Both halves of that were false against the policy as written.
--
--   * SELECT was unrestricted, so any session enumerated EVERY key in the cell.
--     ADR-0009 itself says the digest is unkeyed over a low-entropy input and
--     that a row is therefore evidence that a named person attempted to sign in
--     at a named workspace. That is pseudonymised personal data under the NDPA,
--     belonging to other tenants' users, and a full table scan is not "a key it
--     already knows".
--   * DELETE was unrestricted AND unbounded. One statement cleared every
--     lockout in the cell, for every tenant. No sign-in request can do that,
--     and lockout is the only bound on password guessing in the system.
--
-- THE EXEMPTION FROM tenant_id IS UNCHANGED AND STILL CORRECT. A counter whose
-- job is to answer identically for a workspace that does not exist cannot be
-- scoped to a tenant; that is ADR-0009 and it is not reopened here. What
-- changes is only the policy: a row is admitted to a session that PRESENTS
-- THAT ROW'S key_hash, and to no other.
--
-- Why that keeps the property the table exists for: the key is computed from
-- what the caller submitted — sha256('signin' : slug : email) — before anything
-- is resolved. A slug naming no tenant produces a key just as usable as a real
-- one, so the unresolved-workspace INSERT still succeeds, the countdown still
-- counts, and the two paths stay indistinguishable. Nothing in the
-- enumeration-oracle fix depended on the policy being open.
--
-- Why presenting a key is not a caller choosing its own scope (root CLAUDE.md
-- section 2 rule 2): it CONFINES, it cannot widen. The GUC admits exactly one
-- hash out of the whole table, and a caller able to compute that hash can
-- already drive that counter by making sign-in requests. It carries no tenant
-- and grants nothing beyond the single row.
--
-- The table now has two layers like every other table: this policy, and the
-- `key_hash = $1` predicate the repository still writes. 0003's comment noted
-- that having only one layer was a real reduction. It no longer has one.
--
-- CONSEQUENCE FOR THE SWEEP, WHICH IS NOT BUILT YET. `last_failed_at` is
-- indexed for a retention sweep (ADR-0009). A sweep deletes rows whose keys it
-- does NOT know, so it cannot run as kasuwa_app under this policy and must run
-- as kasuwa_migrator, which is BYPASSRLS and is already the role for bulk and
-- cross-tenant work. That is written into ADR-0009 so the sweep task meets it
-- as a requirement rather than as a failure.
-- ---------------------------------------------------------------------------

-- --- the accessor ----------------------------------------------------------
--
-- Same shape and the same fail-closed semantics as the three accessors in 0000,
-- and for the same reason: a policy must never call current_setting() directly,
-- so that "unset means deny" lives in exactly one place.
--
--   * GUC unset or ''  -> NULL -> `key_hash = NULL` is NULL -> row denied
--   * GUC set to junk  -> decode() raises -> loud deny
--
-- NOT SECURITY DEFINER. It reads a session setting and returns bytea; it
-- touches no table and needs no privilege the caller lacks. The count of
-- SECURITY DEFINER functions in this system stays at two (root CLAUDE.md
-- section 2 rule 7).
CREATE OR REPLACE FUNCTION app.current_rate_limit_key() RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT decode(nullif(current_setting('app.rate_limit_key', true), ''), 'hex')
$$;

GRANT EXECUTE ON FUNCTION app.current_rate_limit_key() TO kasuwa_app, kasuwa_test_admin;

COMMENT ON FUNCTION app.current_rate_limit_key() IS
  'The auth_rate_limit key the current statement is acting on, read from app.rate_limit_key. NULL when unset, which denies every row.';

-- --- the policy ------------------------------------------------------------
--
-- WITH CHECK is identical to USING, as everywhere else: a session cannot write
-- a row it could not read back. Here that also means a session cannot insert a
-- counter under a key other than the one it presented.
DROP POLICY auth_rate_limit_open ON auth_rate_limit;

CREATE POLICY auth_rate_limit_presented_key ON auth_rate_limit FOR ALL
  USING      (key_hash = app.current_rate_limit_key())
  WITH CHECK (key_hash = app.current_rate_limit_key());

COMMENT ON TABLE auth_rate_limit IS
  'Failed-authentication counters, keyed on a hash of what the caller submitted. Deliberately not tenant-scoped (ADR-0009). A row is visible only to a session presenting its key_hash in app.rate_limit_key (ADR-0009 as amended by T-0020).';

-- --- prove the policy is the one that is there -----------------------------
--
-- 0003 ends by asserting its grants rather than trusting a comment, after a
-- reviewer found a compensating control that existed only in prose. Same idea:
-- if a later migration re-opens this table, everything above becomes a story
-- about something that is no longer true, and nothing would say so.
DO $$
DECLARE
  open_policies int;
BEGIN
  SELECT count(*) INTO open_policies
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'auth_rate_limit'
     AND (pg_get_expr(p.polqual, p.polrelid) = 'true'
       OR pg_get_expr(p.polwithcheck, p.polrelid) = 'true');

  IF open_policies > 0 THEN
    RAISE EXCEPTION
      'auth_rate_limit has a policy that admits every row. That is T-0004 '
      'FINDING-3: any session can then enumerate every key in the cell and '
      'clear every lockout in it. See migration 0004 and ADR-0009.';
  END IF;
END
$$;
