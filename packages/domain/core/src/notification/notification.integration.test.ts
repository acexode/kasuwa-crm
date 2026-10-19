import { randomUUID } from 'node:crypto';
import {
  createPool,
  PROGRAMME_A1,
  TENANT_A,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  withTenantTransaction,
} from '@kasuwa/db';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { handleNotificationEvent } from './notification-handler';
import {
  listNotificationRows,
  notificationObjectKey,
  resolveNotificationObjects,
} from './notification.repository';

/**
 * T-0100 against real Postgres and RLS: the two rules the acceptance suite
 * could not pin because T-0094 and T-0095 had not merged when it was written
 * (D-L164 "not pinned yet"):
 *
 *   - a contact merged away is DROPPED from a reader's notifications and is
 *     never the subject of a new one (D-L146, D-L163, D-P27);
 *   - `import.finished` notifies the creator, once, for an ended job only, and
 *     the import is dropped from the reader's list when they cannot import.
 *
 * Rows are planted by kasuwa_migrator and read through kasuwa_app. Every name
 * is synthetic.
 */

const id = (tail: string) => `11111111-0100-4000-8300-${tail.padStart(12, '0')}`;

describe('notifications: merged-away contacts and imports (T-0100)', () => {
  let migrator: Pool;
  let app: Pool;
  const planted: { contacts: string[]; jobs: string[]; objects: string[]; notifications: string[] } = {
    contacts: [],
    jobs: [],
    objects: [],
    notifications: [],
  };

  beforeAll(() => {
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    app = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterEach(async () => {
    await migrator.query('DELETE FROM notification WHERE id = ANY($1::uuid[])', [planted.notifications]);
    await migrator.query('DELETE FROM outbox_event WHERE aggregate_id = ANY($1::uuid[])', [
      [...planted.contacts, ...planted.jobs],
    ]);
    await migrator.query('DELETE FROM import_job WHERE id = ANY($1::uuid[])', [planted.jobs]);
    await migrator.query('DELETE FROM stored_object WHERE id = ANY($1::uuid[])', [planted.objects]);
    await migrator.query('DELETE FROM contact WHERE id = ANY($1::uuid[])', [planted.contacts]);
    for (const list of Object.values(planted)) list.length = 0;
  });

  afterAll(async () => {
    await app.end();
    await migrator.end();
  });

  async function plantContact(tail: string, deleted: boolean, owner: string | null = null): Promise<string> {
    const contactId = id(`c${tail}`);
    await migrator.query(
      `INSERT INTO contact (id, tenant_id, programme_id, display_name, given_names, family_name, owner_user_id, deleted_at)
       VALUES ($1, $2, $3, 'Zqncontact Sample Merge', 'Zqncontact', 'Sample Merge', $4,
               CASE WHEN $5::boolean THEN now() END)`,
      [contactId, TENANT_A, PROGRAMME_A1, owner, deleted],
    );
    planted.contacts.push(contactId);
    return contactId;
  }

  async function plantImport(tail: string, status: string, creator: string): Promise<string> {
    const objectId = id(`a${tail}`);
    const jobId = id(`b${tail}`);
    await migrator.query(
      `INSERT INTO stored_object (id, tenant_id, programme_id, key, purpose, declared_size_bytes, content_type, uploaded_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid,
               'tenant/' || $2::text || '/programme/' || $3::text || '/import/' || $1::text,
               'import', 10, 'text/csv', $4::uuid)`,
      [objectId, TENANT_A, PROGRAMME_A1, creator],
    );
    await migrator.query(
      `INSERT INTO import_job (id, tenant_id, programme_id, stored_object_id, created_by_user_id, status,
                               filename, size_bytes, content_type, part_count, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'zq-people.csv', 10, 'text/csv', 1,
               CASE WHEN $6 IN ('finished', 'failed') THEN now() END)`,
      [jobId, TENANT_A, PROGRAMME_A1, objectId, creator, status],
    );
    planted.objects.push(objectId);
    planted.jobs.push(jobId);
    return jobId;
  }

  /** An outbox event the way appendOutboxEvent would write it, as the actor. */
  async function plantEvent(
    actor: string,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const eventId = randomUUID();
    await migrator.query(
      `INSERT INTO outbox_event (id, tenant_id, programme_id, actor_user_id, event_type, schema_version,
                                 aggregate_type, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8::jsonb)`,
      [eventId, TENANT_A, PROGRAMME_A1, actor, eventType, aggregateType, aggregateId, JSON.stringify(payload)],
    );
    return eventId;
  }

  async function handle(
    actor: string,
    eventId: string,
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    return withTenantTransaction(app, { tenantId: TENANT_A, userId: actor }, (tx) =>
      handleNotificationEvent(tx, {
        id: eventId,
        tenantId: TENANT_A,
        programmeId: PROGRAMME_A1,
        actorUserId: actor,
        eventType,
        schemaVersion: 1,
        aggregateType,
        aggregateId,
        payload,
        createdAt: new Date().toISOString(),
      }),
    );
  }

  async function count(recipient: string): Promise<number> {
    const rows = await migrator.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification WHERE recipient_user_id = $1',
      [recipient],
    );
    planted.notifications.push(
      ...(await migrator.query<{ id: string }>('SELECT id FROM notification WHERE recipient_user_id = $1', [recipient])).rows.map(
        (row) => row.id,
      ),
    );
    return rows.rows[0]?.n ?? -1;
  }

  it('drops a merged-away contact from the reader\'s names and keeps a live one, naming it', async () => {
    const live = await plantContact('1', false);
    const mergedAway = await plantContact('2', true);
    const names = await withTenantTransaction(app, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, (tx) =>
      resolveNotificationObjects(tx, [
        { programmeId: PROGRAMME_A1, objectType: 'contact', objectId: live },
        { programmeId: PROGRAMME_A1, objectType: 'contact', objectId: mergedAway },
      ]),
    );
    expect(names.get(notificationObjectKey('contact', live))).toBe('Zqncontact Sample Merge');
    expect(names.has(notificationObjectKey('contact', mergedAway))).toBe(false);
  });

  it('writes no notification for a contact merged away since the event, and one for a live contact', async () => {
    const live = await plantContact('3', false, USER_A_AGENT_1);
    const mergedAway = await plantContact('4', true, USER_A_AGENT_1);
    for (const [contactId, expected] of [[mergedAway, 0], [live, 1]] as const) {
      const payload = { contactId, previousOwnerId: null, newOwnerId: USER_A_AGENT_1 };
      const eventId = await plantEvent(USER_A_SUPERVISOR, 'contact.owner_changed', 'contact', contactId, payload);
      await handle(USER_A_SUPERVISOR, eventId, 'contact.owner_changed', 'contact', contactId, payload);
      expect(await count(USER_A_AGENT_1)).toBe(expected === 0 ? 0 : 1);
    }
  });

  it('import.finished notifies the creator once for an ended job, never for a running one', async () => {
    const running = await plantImport('1', 'running', USER_A_SUPERVISOR);
    const ended = await plantImport('2', 'finished', USER_A_SUPERVISOR);
    const payloadOf = (jobId: string) => ({ importId: jobId });
    const first = await plantEvent(USER_A_SUPERVISOR, 'import.finished', 'import', running, payloadOf(running));
    await handle(USER_A_SUPERVISOR, first, 'import.finished', 'import', running, payloadOf(running));
    expect(await count(USER_A_SUPERVISOR)).toBe(0);
    const second = await plantEvent(USER_A_SUPERVISOR, 'import.finished', 'import', ended, payloadOf(ended));
    for (let delivery = 0; delivery < 2; delivery += 1) {
      await handle(USER_A_SUPERVISOR, second, 'import.finished', 'import', ended, payloadOf(ended));
    }
    expect(await count(USER_A_SUPERVISOR)).toBe(1);
    const row = await migrator.query<{ kind: string; object_type: string; actor_user_id: string }>(
      'SELECT kind, object_type, actor_user_id FROM notification WHERE recipient_user_id = $1',
      [USER_A_SUPERVISOR],
    );
    expect(row.rows).toEqual([
      { kind: 'import_finished', object_type: 'import', actor_user_id: USER_A_SUPERVISOR },
    ]);
  });

  it('an import is named for a reader who may import, and dropped for one who may not', async () => {
    const job = await plantImport('3', 'finished', USER_A_SUPERVISOR);
    const record = { programmeId: PROGRAMME_A1, objectType: 'import' as const, objectId: job };
    const asAdmin = await withTenantTransaction(app, { tenantId: TENANT_A, userId: USER_A_SUPERVISOR }, (tx) =>
      resolveNotificationObjects(tx, [record]),
    );
    expect(asAdmin.get(notificationObjectKey('import', job))).toBe('zq-people.csv');
    const asAgent = await withTenantTransaction(app, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, (tx) =>
      resolveNotificationObjects(tx, [record]),
    );
    expect(asAgent.has(notificationObjectKey('import', job))).toBe(false);
  });

  it('D-L174: once owner_user_id is withheld from the reader, an item they were assigned is gone from the list', async () => {
    const contactId = await plantContact('5', false, USER_A_AGENT_1);
    const field = await migrator.query<{ id: string; set_id: string }>(
      `SELECT f.id, ps.id AS set_id
         FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
         JOIN permission_set ps ON ps.tenant_id = f.tenant_id AND ps.key = 'agent'
        WHERE f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = 'owner_user_id' AND NOT o.is_custom`,
      [TENANT_A],
    );
    const [found] = field.rows;
    if (found === undefined) throw new Error('fixture drift: no contact.owner_user_id field_def');
    const notificationId = randomUUID();
    await migrator.query(
      `INSERT INTO notification (id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id, actor_user_id, source_event_id)
       VALUES ($1, $2, $3, $4, 'record_assigned', 'contact', $5, $6, $7)`,
      [notificationId, TENANT_A, PROGRAMME_A1, USER_A_AGENT_1, contactId, USER_A_SUPERVISOR, randomUUID()],
    );
    planted.notifications.push(notificationId);
    const visible = async (): Promise<boolean> =>
      withTenantTransaction(app, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
        const page = await listNotificationRows(tx, { limit: 10, unreadOnly: false });
        const names = await resolveNotificationObjects(tx, page.rows);
        return names.has(notificationObjectKey('contact', contactId));
      });
    expect(await visible(), 'control').toBe(true);
    await migrator.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, 'none')
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, found.id, found.set_id],
    );
    try {
      expect(await visible()).toBe(false);
    } finally {
      await migrator.query('DELETE FROM field_security_grant WHERE field_id = $1 AND permission_set_id = $2', [
        found.id,
        found.set_id,
      ]);
    }
  });
});
