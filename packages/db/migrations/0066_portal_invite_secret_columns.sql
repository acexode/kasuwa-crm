-- 0066 - kasuwa_app must not SELECT portal_invite.token_hash (T-0157 / T-0180).
-- 0058 granted table-level SELECT; 0061 already column-split portal_identity /
-- portal_session. Mirror that split for portal_invite.

SET LOCAL lock_timeout = '5s';

LOCK TABLE portal_invite IN SHARE ROW EXCLUSIVE MODE;

REVOKE SELECT ON portal_invite FROM kasuwa_app, PUBLIC;
GRANT SELECT (id, tenant_id, programme_id, email, email_masked, status,
              invited_by_user_id, expires_at, created_at, updated_at)
  ON portal_invite TO kasuwa_app;

DO $$
BEGIN
  IF pg_catalog.has_column_privilege('kasuwa_app', 'portal_invite', 'token_hash', 'SELECT') THEN
    RAISE EXCEPTION 'kasuwa_app must not read portal_invite.token_hash (0066).';
  END IF;

  IF NOT pg_catalog.has_column_privilege('kasuwa_app', 'portal_invite', 'email_masked', 'SELECT') THEN
    RAISE EXCEPTION 'kasuwa_app must still list portal invites without the digest (0066).';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0066: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END $$;
