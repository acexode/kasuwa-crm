-- 0065 - tighten kasuwa_app grants on inbox foundation tables (T-0185 R1).
-- 0052 granted table-level UPDATE and no column split; acceptance requires no
-- DELETE and no UPDATE on id / tenant_id / programme_id.

SET LOCAL lock_timeout = '5s';

LOCK TABLE conversation, message, conversation_participant IN SHARE ROW EXCLUSIVE MODE;

REVOKE ALL ON conversation, message, conversation_participant
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;

GRANT SELECT, INSERT ON conversation, message, conversation_participant TO kasuwa_app;
GRANT UPDATE (status, subject, last_message_at, updated_at) ON conversation TO kasuwa_app;
GRANT UPDATE (user_id, role, updated_at) ON conversation_participant TO kasuwa_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation, message, conversation_participant TO kasuwa_test_admin;

DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  tbl text;
  rel pg_catalog.regclass;
  col text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['conversation', 'message', 'conversation_participant'] LOOP
    rel := ('public.' || tbl)::pg_catalog.regclass;
    IF pg_catalog.has_table_privilege(app_role, rel, 'DELETE') THEN
      RAISE EXCEPTION '0065: kasuwa_app must not hold DELETE on %', tbl;
    END IF;
    FOREACH col IN ARRAY ARRAY['id', 'tenant_id', 'programme_id'] LOOP
      IF pg_catalog.has_column_privilege(app_role, rel, col, 'UPDATE') THEN
        RAISE EXCEPTION '0065: kasuwa_app must not UPDATE %.%', tbl, col;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT pg_catalog.has_column_privilege(app_role, 'public.conversation'::pg_catalog.regclass, 'last_message_at', 'UPDATE') THEN
    RAISE EXCEPTION '0065: kasuwa_app must UPDATE conversation.last_message_at';
  END IF;
  IF NOT pg_catalog.has_column_privilege(app_role, 'public.conversation_participant'::pg_catalog.regclass, 'role', 'UPDATE') THEN
    RAISE EXCEPTION '0065: kasuwa_app must UPDATE conversation_participant.role';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0065: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END $$;
