-- ---------------------------------------------------------------------------
-- 0044 - notification: the in-app notification inbox (T-0100, Agent 3;
-- ADR-0018, D-P29, D-P23, D-L87, D-L146, D-L156, D-L157, D-L161, D-L164).
--
-- A notification is written by the outbox consumer (apps/worker, through
-- @kasuwa/domain-core's handleNotificationEvent) and read, marked read, and
-- nothing else, by its recipient through the API. It holds identifiers and
-- codes only (D-P29): no name, subject, filename or value. Names are resolved
-- at read time under the READER's scope and field security.
--
-- In this one file: lock_timeout and locks; the table, its keys, checks and
-- indexes; RLS, policies and grants; a self-check of the posture. One
-- transaction: a failure anywhere leaves no trace, not even a ledger row.
--
-- ---------------------------------------------------------------------------
-- COLUMNS
-- ---------------------------------------------------------------------------
--   id                 uuid PK, minted by the consumer.
--   tenant_id          uuid NOT NULL.
--   programme_id       uuid NOT NULL: the programme of the object (the event's).
--   recipient_user_id  uuid NOT NULL: whose notification it is.
--   kind               text, a code: record_assigned, task_assigned or
--                      import_finished (NotificationKind in the contract).
--   object_type        text, a code: contact, account, deal, activity or import.
--                      The kind fixes it (CHECK).
--   object_id          uuid NOT NULL. NO foreign key: it names a row of any
--                      of five tables, and a notification must outlive the
--                      object it pointed at (the read path drops it; the 90-day
--                      purge of D-L146 is a deferred follow-up).
--   actor_user_id      uuid NOT NULL: who caused it (an import's actor is the
--                      user who started it). A RESTRICTIVE INSERT policy pins
--                      it to app.current_user_id(): the consumer inserts as the
--                      event's actor, so nobody can write a notification "from"
--                      someone else (the F-R3 reasoning of 0041).
--   source_event_id    uuid NOT NULL: the outbox event id. With the recipient it
--                      is the idempotency key (UNIQUE below). NO foreign key:
--                      the outbox row is swept after 7 to 30 days and the
--                      notification must outlive it.
--   created_at         timestamptz NOT NULL DEFAULT now(); the INSERT policy
--                      pins it to now(), so a row cannot be back-dated out of
--                      the newest-first window or dated into the future.
--   read_at            timestamptz NULL: set by the recipient.
--
-- ---------------------------------------------------------------------------
-- KEYS (CLAUDE.md 2.3; the 0027 pattern)
-- ---------------------------------------------------------------------------
-- Referential checks ignore row security, so every FK carries tenant_id:
--   - tenant_id -> tenant: ON DELETE CASCADE (offboarding; also what lets the
--     seed's TRUNCATE tenant CASCADE clear the table).
--   - (tenant_id, programme_id) -> programme: ON DELETE CASCADE.
--   - (tenant_id, recipient_user_id) -> "user": ON DELETE CASCADE. A user in
--     another tenant fails exactly as an invented id, and erasing a user
--     erases their inbox (NDPA).
--   - (tenant_id, actor_user_id) -> "user": ON DELETE CASCADE. A notification
--     whose actor is gone cannot say who assigned it; the offboarding delete
--     must not be blocked by an inbox row either.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCY WITHOUT ON CONFLICT (D-L164)
-- ---------------------------------------------------------------------------
-- UNIQUE (source_event_id, recipient_user_id) makes a replayed event write
-- nothing. The handler does NOT use INSERT ... ON CONFLICT DO NOTHING: that
-- statement requires SELECT rights, so PostgreSQL also checks the NEW row
-- against the SELECT policies, and the RESTRICTIVE recipient-only SELECT policy
-- below refuses the consumer (who inserts as the actor, not the recipient)
-- with 42501 on the FIRST insert. Widening that policy to admit the actor
-- would hand actors a read receipt (read_at) on their colleagues. So the
-- handler issues a plain INSERT inside a SAVEPOINT and treats SQLSTATE 23505
-- on notification_source_event_recipient_key as "already delivered". It never
-- uses RETURNING, for the same reason.
--
-- ---------------------------------------------------------------------------
-- TENANCY
-- ---------------------------------------------------------------------------
--   ENABLED and FORCED; in TENANT_SCOPED_TABLES and the schema.ts mirror. Every
--   policy is TO kasuwa_app (never PUBLIC):
--   - notification_tenant, permissive FOR ALL: tenant AND programme, WITH CHECK
--     identical to USING (CLAUDE.md 2.4). A reader who has left a programme
--     reads nothing of it.
--   - notification_recipient_select, RESTRICTIVE FOR SELECT: recipient_user_id
--     = app.current_user_id(). A colleague in the same programme, an admin and
--     the actor all read nothing (D-L157).
--   - notification_recipient_update, RESTRICTIVE FOR UPDATE: the same, USING
--     and WITH CHECK, so a recipient cannot hand a row to someone else.
--   - notification_insert_as_actor, RESTRICTIVE FOR INSERT: actor_user_id =
--     app.current_user_id() AND created_at = now() AND read_at IS NULL. INSERT
--     is deliberately NOT recipient-restricted: the consumer writes the
--     recipient's row as the event's actor.
--   GRANTS: kasuwa_app gets SELECT and INSERT, and UPDATE on read_at ONLY. No
--   DELETE (D-L146's purge is deferred and will need its own identity ruling),
--   no TRUNCATE (it skips RLS), REFERENCES or TRIGGER. kasuwa_relay,
--   kasuwa_auth, kasuwa_sweeper and PUBLIC hold nothing. kasuwa_test_admin:
--   full DML, as for every table (inert outside development and test).
--
-- INDEXES (none is a column-prefix of another; schema-hygiene)
--   - notification_pkey (id).
--   - notification_source_event_recipient_key UNIQUE (source_event_id,
--     recipient_user_id): the idempotency key.
--   - notification_recipient_idx (tenant_id, recipient_user_id, created_at
--     DESC, id DESC): the keyset list, and the lookup behind the recipient FK.
--   - notification_recipient_unread_idx: the same key WHERE read_at IS NULL: the
--     unread count and "mark all read" never walk read rows.
--   - notification_programme_idx (tenant_id, programme_id): the programme FK.
--   - notification_actor_idx (tenant_id, actor_user_id): the actor FK.
--   Built on an empty table.
--
-- NOT HERE: no SECURITY DEFINER function, no role, no extension, no new
-- app.* setting, no purge (D-L146: needs a retention ruling), and no index on
-- any other table.
--
-- LOCK IMPACT (D-L65): tenant, programme and "user" are held SHARE ROW
-- EXCLUSIVE for the file, which is what creating an FK that references them
-- takes anyway, taken up front in one order. lock_timeout = 5s refuses to
-- queue behind a long transaction.
--
-- EXPAND ONLY: a new table with no reader in old code. Old API and worker
-- builds run unchanged against it. A producer's event reaches the queue
-- whether or not the consumer is deployed; deploy the worker with this
-- migration, before relying on notifications.
--
-- ROLLBACK PLAN: if this file fails nothing was applied. To undo it after it
-- applied: never edit or delete it or its ledger row. Roll back the
-- application first (the worker's consumer, then the API routes and the
-- producers), then the schema.ts mirror and the TENANT_SCOPED_TABLES entry;
-- then, in a NEW migration, DROP TABLE notification. Unread notifications
-- are lost with it.
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- --- 1. locks, in a fixed order ----------------------------------------------
LOCK TABLE tenant, programme, "user" IN SHARE ROW EXCLUSIVE MODE;

-- --- 2. the table ---------------------------------------------------------------
CREATE TABLE notification (
  id                 uuid         PRIMARY KEY,
  tenant_id          uuid         NOT NULL,
  programme_id       uuid         NOT NULL,
  recipient_user_id  uuid         NOT NULL,
  kind               text         NOT NULL,
  object_type        text         NOT NULL,
  object_id          uuid         NOT NULL,
  actor_user_id      uuid         NOT NULL,
  source_event_id    uuid         NOT NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  read_at            timestamptz,

  CONSTRAINT notification_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT notification_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT notification_recipient_same_tenant_fk
    FOREIGN KEY (tenant_id, recipient_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT notification_actor_same_tenant_fk
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,

  -- The contract's closed vocabulary (NotificationKind, NotificationObjectType)
  -- and the pairing the contract fixes. A later kind is an additive migration.
  CONSTRAINT notification_kind_object_check CHECK (
    (kind = 'record_assigned' AND object_type IN ('contact', 'account', 'deal'))
    OR (kind = 'task_assigned' AND object_type = 'activity')
    OR (kind = 'import_finished' AND object_type = 'import')
  ),
  CONSTRAINT notification_source_event_recipient_key
    UNIQUE (source_event_id, recipient_user_id)
);

CREATE INDEX notification_recipient_idx
  ON notification (tenant_id, recipient_user_id, created_at DESC, id DESC);
CREATE INDEX notification_recipient_unread_idx
  ON notification (tenant_id, recipient_user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
CREATE INDEX notification_programme_idx
  ON notification (tenant_id, programme_id);
CREATE INDEX notification_actor_idx
  ON notification (tenant_id, actor_user_id);

-- --- 3. RLS and policies ------------------------------------------------------------
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_tenant ON notification FOR ALL TO kasuwa_app
  USING      (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND programme_id = ANY (app.current_programme_ids()));

-- RESTRICTIVE: AND-ed with notification_tenant. Only the recipient reads or
-- marks a row (D-L157). Not FOR ALL: INSERT is not recipient-restricted.
CREATE POLICY notification_recipient_select ON notification AS RESTRICTIVE
  FOR SELECT TO kasuwa_app
  USING (recipient_user_id = app.current_user_id());

CREATE POLICY notification_recipient_update ON notification AS RESTRICTIVE
  FOR UPDATE TO kasuwa_app
  USING      (recipient_user_id = app.current_user_id())
  WITH CHECK (recipient_user_id = app.current_user_id());

CREATE POLICY notification_insert_as_actor ON notification AS RESTRICTIVE
  FOR INSERT TO kasuwa_app
  WITH CHECK (actor_user_id = app.current_user_id()
              AND created_at = now()
              AND read_at IS NULL);

-- --- 4. grants ---------------------------------------------------------------------------
-- Explicit, so this file does not depend on the bootstrap's default
-- privileges (which would give kasuwa_app UPDATE and DELETE).
REVOKE ALL ON notification
  FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin;
GRANT SELECT, INSERT ON notification TO kasuwa_app;
GRANT UPDATE (read_at) ON notification TO kasuwa_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification TO kasuwa_test_admin;

-- --- 5. prove the posture ------------------------------------------------------------
-- Runs once, here. The standing guards are the T-0100 acceptance suites and
-- rls-enforcement, which run on every build.
DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
  rel constant pg_catalog.oid := 'public.notification'::pg_catalog.regclass;
  held text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity
            FROM pg_catalog.pg_class c WHERE c.oid = rel) THEN
    RAISE EXCEPTION '0044: notification RLS is not enabled and forced';
  END IF;
  IF pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = rel))
     <> 'kasuwa_migrator' THEN
    RAISE EXCEPTION '0044: notification is not owned by kasuwa_migrator';
  END IF;

  -- kasuwa_app: SELECT, INSERT, and UPDATE on read_at alone.
  IF NOT (pg_catalog.has_table_privilege(app_role, rel, 'SELECT')
          AND pg_catalog.has_table_privilege(app_role, rel, 'INSERT')
          AND pg_catalog.has_column_privilege(app_role, rel, 'read_at', 'UPDATE')) THEN
    RAISE EXCEPTION '0044: kasuwa_app cannot write and read notifications';
  END IF;
  SELECT pg_catalog.string_agg(a.attname::text, ', ' ORDER BY a.attname)
    INTO held
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname <> 'read_at'
     AND pg_catalog.has_column_privilege(app_role, rel, a.attname, 'UPDATE');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0044: kasuwa_app may UPDATE notification column(s) it must not: %', held;
  END IF;

  -- DELETE, TRUNCATE, REFERENCES, TRIGGER, UPDATE (table-level) and BYPASSRLS
  -- for kasuwa_app and every role it can enter.
  SELECT pg_catalog.string_agg(r.rolname || ':' || x.what, ', ' ORDER BY r.rolname, x.what)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN LATERAL (
     SELECT 'UPDATE (table)' AS what WHERE pg_catalog.has_table_privilege(r.oid, rel, 'UPDATE')
     UNION ALL SELECT 'DELETE' WHERE pg_catalog.has_table_privilege(r.oid, rel, 'DELETE')
     UNION ALL SELECT 'TRUNCATE' WHERE pg_catalog.has_table_privilege(r.oid, rel, 'TRUNCATE')
     UNION ALL SELECT 'REFERENCES' WHERE pg_catalog.has_any_column_privilege(r.oid, rel, 'REFERENCES')
     UNION ALL SELECT 'TRIGGER' WHERE pg_catalog.has_table_privilege(r.oid, rel, 'TRIGGER')
     UNION ALL SELECT 'BYPASSRLS' WHERE r.rolbypassrls
   ) AS x
   WHERE pg_catalog.pg_has_role(app_role, r.oid, 'MEMBER');
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0044: kasuwa_app, or a role it can enter, holds what it must not on notification: %', held;
  END IF;

  -- The relay, auth, the sweeper and PUBLIC hold nothing.
  SELECT pg_catalog.string_agg(r.rolname || ':' || p.priv, ', ' ORDER BY r.rolname, p.priv)
    INTO held
    FROM pg_catalog.pg_roles r
   CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
                                      'REFERENCES', 'TRIGGER']) AS p(priv)
   WHERE r.rolname IN ('kasuwa_relay', 'kasuwa_auth', 'kasuwa_sweeper')
     AND CASE WHEN p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              THEN pg_catalog.has_any_column_privilege(r.oid, rel, p.priv)
              ELSE pg_catalog.has_table_privilege(r.oid, rel, p.priv)
         END;
  IF held IS NOT NULL THEN
    RAISE EXCEPTION '0044: a role other than kasuwa_app holds a privilege on notification: %', held;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
              WHERE c.oid = rel AND a.grantee = 0) THEN
    RAISE EXCEPTION '0044: PUBLIC holds a privilege on notification';
  END IF;

  -- Policies: one permissive FOR ALL with WITH CHECK = USING; the three
  -- restrictive ones; every policy TO kasuwa_app and nobody else.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p
       WHERE p.polrelid = rel AND p.polpermissive AND p.polcmd = '*'
         AND pg_catalog.pg_get_expr(p.polqual, p.polrelid)
             = pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)) <> 1 THEN
    RAISE EXCEPTION '0044: notification needs one permissive FOR ALL policy with WITH CHECK = USING';
  END IF;
  IF (SELECT pg_catalog.array_agg(p.polcmd::text ORDER BY p.polcmd::text)
        FROM pg_catalog.pg_policy p
       WHERE p.polrelid = rel AND NOT p.polpermissive) IS DISTINCT FROM ARRAY['a', 'r', 'w'] THEN
    RAISE EXCEPTION '0044: notification needs exactly its restrictive INSERT, SELECT and UPDATE policies';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
              WHERE p.polrelid = rel AND p.polroles <> ARRAY[app_role]) THEN
    RAISE EXCEPTION '0044: a notification policy names a role other than kasuwa_app';
  END IF;

  -- CLAUDE.md 2.7: still exactly the two SECURITY DEFINER functions.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0044: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
END
$$;
