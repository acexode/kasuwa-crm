-- ---------------------------------------------------------------------------
-- 0052 - conversation / message / conversation_participant (T-0185, M08)
-- Programme-scoped inbox foundation. Search engine remains Postgres (ADR-0014).
-- ---------------------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

LOCK TABLE tenant, programme, contact, "user"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE conversation (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  programme_id    uuid        NOT NULL,
  contact_id      uuid        NOT NULL,
  channel         text        NOT NULL,
  status          text        NOT NULL DEFAULT 'open',
  subject         text,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conversation_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT conversation_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT conversation_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT conversation_contact_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, contact_id)
    REFERENCES contact (tenant_id, programme_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT conversation_channel_check CHECK (channel IN ('sms', 'whatsapp', 'email')),
  CONSTRAINT conversation_status_check CHECK (status IN ('open', 'pending', 'closed'))
);

CREATE INDEX conversation_contact_idx
  ON conversation (tenant_id, programme_id, contact_id);

CREATE TABLE message (
  id                 uuid        PRIMARY KEY,
  tenant_id          uuid        NOT NULL,
  programme_id       uuid        NOT NULL,
  conversation_id    uuid        NOT NULL,
  direction          text        NOT NULL,
  body_redacted      text        NOT NULL DEFAULT '',
  provider_message_id text,
  sent_by_user_id    uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_tenant_programme_id_key UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT message_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT message_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT message_conversation_same_programme_fk
    FOREIGN KEY (tenant_id, programme_id, conversation_id)
    REFERENCES conversation (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT message_sent_by_same_tenant_fk
    FOREIGN KEY (tenant_id, sent_by_user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT message_direction_check CHECK (direction IN ('inbound', 'outbound', 'note'))
);

CREATE INDEX message_conversation_idx
  ON message (tenant_id, programme_id, conversation_id, created_at);

CREATE TABLE conversation_participant (
  id               uuid        PRIMARY KEY,
  tenant_id        uuid        NOT NULL,
  programme_id     uuid        NOT NULL,
  conversation_id  uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  role             text        NOT NULL DEFAULT 'assignee',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conversation_participant_tenant_programme_id_key
    UNIQUE (tenant_id, programme_id, id),
  CONSTRAINT conversation_participant_unique_user
    UNIQUE (tenant_id, programme_id, conversation_id, user_id),
  CONSTRAINT conversation_participant_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT conversation_participant_programme_same_tenant_fk
    FOREIGN KEY (tenant_id, programme_id)
    REFERENCES programme (tenant_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT conversation_participant_conversation_fk
    FOREIGN KEY (tenant_id, programme_id, conversation_id)
    REFERENCES conversation (tenant_id, programme_id, id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT conversation_participant_user_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT conversation_participant_role_check
    CHECK (role IN ('assignee', 'watcher', 'transfer_target'))
);

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['conversation', 'message', 'conversation_participant'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO kasuwa_app
         USING (tenant_id = app.current_tenant_id()
                AND programme_id = ANY (app.current_programme_ids()))
         WITH CHECK (tenant_id = app.current_tenant_id()
                AND programme_id = ANY (app.current_programme_ids()))',
      tbl || '_isolation', tbl);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, kasuwa_app, kasuwa_auth, kasuwa_sweeper, kasuwa_relay, kasuwa_test_admin', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO kasuwa_app', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO kasuwa_test_admin', tbl);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW
         WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
         EXECUTE FUNCTION app.touch_updated_at()',
      tbl || '_touch_updated_at', tbl);
  END LOOP;
END $$;

DO $$
DECLARE
  app_role constant pg_catalog.oid := 'kasuwa_app'::pg_catalog.regrole;
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p
       WHERE p.prosecdef
         AND p.pronamespace NOT IN ('pg_catalog'::pg_catalog.regnamespace,
                                    'information_schema'::pg_catalog.regnamespace)) <> 2 THEN
    RAISE EXCEPTION '0052: there must be exactly two SECURITY DEFINER functions (CLAUDE.md 2.7)';
  END IF;
  IF NOT (pg_catalog.has_table_privilege(app_role, 'public.conversation'::pg_catalog.regclass, 'SELECT')) THEN
    RAISE EXCEPTION '0052: kasuwa_app lacks SELECT on conversation';
  END IF;
END $$;
