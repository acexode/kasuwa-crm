import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { appendOutboxEvent, OutboxEventRefusedError } from './outbox';
import {
  OutboxRelayConfigError,
  OutboxRelayRoleError,
  readOutboxBacklog,
  relayOutboxBatch,
  sweepOutbox,
  type OutboxJob,
} from './outbox-relay';
import { PROGRAMME_A1, PROGRAMME_A2, TENANT_A, USER_A_AGENT_1 } from './fixtures';
import { createPool } from './pool';
import { withTenantTransaction } from './session';

/**
 * T-0098 builder tests, beyond the acceptance suites: the relay functions
 * refuse a pool that is not kasuwa_relay, the relay policy refuses a
 * future-dated last_attempt_at (the publish-backoff lever), a poison row
 * blocks only its own aggregate, and appendOutboxEvent's refusals leave the
 * transaction usable. Invented identifiers only.
 */
describe('outbox: relay role, backoff lever and refusals (T-0098)', () => {
  let app: Pool;
  let relay: Pool;
  let migrator: Pool;

  const queues = (sink: OutboxJob[]) => ({
    'kasuwa.events.notifications': {
      addBulk: async (jobs: OutboxJob[]) => {
        sink.push(...jobs);
        return jobs;
      },
    },
  });

  beforeAll(() => {
    app = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    relay = createPool({ connectionString: inject('relayDatabaseUrl'), max: 2 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  beforeEach(async () => {
    await migrator.query('DELETE FROM outbox_event');
  });

  afterAll(async () => {
    await migrator.query('DELETE FROM outbox_event');
    await app.end();
    await relay.end();
    await migrator.end();
  });

  async function plant(options: { aggregateId?: string; payload?: unknown } = {}): Promise<string> {
    const id = randomUUID();
    const aggregateId = options.aggregateId ?? randomUUID();
    await migrator.query(
      `INSERT INTO outbox_event (id, tenant_id, programme_id, actor_user_id, event_type,
                                 schema_version, aggregate_type, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, 'contact.owner_changed', 1, 'contact', $5, $6::jsonb)`,
      [
        id,
        TENANT_A,
        PROGRAMME_A1,
        USER_A_AGENT_1,
        aggregateId,
        JSON.stringify(
          options.payload ?? { contactId: aggregateId, previousOwnerId: null, newOwnerId: USER_A_AGENT_1 },
        ),
      ],
    );
    return id;
  }

  it('relay, sweep and backlog refuse the app pool and the migrator pool', async () => {
    const sink: OutboxJob[] = [];
    for (const wrong of [app, migrator]) {
      await expect(relayOutboxBatch(wrong, { queues: queues(sink), batchSize: 10 })).rejects.toBeInstanceOf(
        OutboxRelayRoleError,
      );
      await expect(sweepOutbox(wrong, { batchSize: 10 })).rejects.toBeInstanceOf(OutboxRelayRoleError);
      await expect(readOutboxBacklog(wrong)).rejects.toBeInstanceOf(OutboxRelayRoleError);
    }
    // Control: the relay pool passes.
    await expect(readOutboxBacklog(relay)).resolves.toEqual({ pending: 0, oldestPendingSeconds: 0 });
  });

  it('refuses to run without the queue a registered event routes to, before connecting', async () => {
    await expect(relayOutboxBatch(relay, { queues: {}, batchSize: 10 })).rejects.toBeInstanceOf(
      OutboxRelayConfigError,
    );
  });

  it('the relay cannot future-date last_attempt_at to park an event (42501), but may set it to now()', async () => {
    const id = await plant();
    const code = await relay
      .query(`UPDATE outbox_event SET last_attempt_at = now() + interval '1 day' WHERE id = $1`, [id])
      .then(() => 'accepted', (error: { code?: string }) => error.code ?? 'unknown');
    expect(code).toBe('42501');
    const marked = await relay.query(
      'UPDATE outbox_event SET attempts = attempts + 1, last_attempt_at = now() WHERE id = $1',
      [id],
    );
    expect(marked.rowCount).toBe(1);
  });

  it('a row that failed earlier can still be published later (its old last_attempt_at passes)', async () => {
    const id = await plant();
    await migrator.query(
      `UPDATE outbox_event SET attempts = 3, last_attempt_at = now() - interval '2 days' WHERE id = $1`,
      [id],
    );
    const sink: OutboxJob[] = [];
    const result = await relayOutboxBatch(relay, { queues: queues(sink), batchSize: 10 });
    expect(result.outcomes).toEqual([
      { id, eventType: 'contact.owner_changed', attempt: 4, outcome: 'published' },
    ]);
  });

  it('a poison row in backoff blocks only its own aggregate, not the batch', async () => {
    const aggregate = randomUUID();
    const poison = await plant({ aggregateId: aggregate, payload: { contactId: aggregate, note: 'x' } });
    const behind = await plant({ aggregateId: aggregate });
    const other = await plant();
    const first: OutboxJob[] = [];
    const run = await relayOutboxBatch(relay, { queues: queues(first), batchSize: 10 });
    expect(first.map((job) => job.opts.jobId)).toEqual([other]);
    expect(run.outcomes.find((o) => o.id === poison)?.outcome).toBe('rejected');
    expect(run.outcomes.some((o) => o.id === behind)).toBe(false);
    // The poison row is now in backoff: the row behind it is not even claimed.
    const second: OutboxJob[] = [];
    const again = await relayOutboxBatch(relay, { queues: queues(second), batchSize: 10 });
    expect(again.claimed).toBe(0);
    expect(second).toEqual([]);
  });

  it('appendOutboxEvent refuses an aggregate the payload does not name, and the tx stays usable', async () => {
    const contactId = randomUUID();
    const outcome = await withTenantTransaction(app, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
      const refused = await appendOutboxEvent(tx, {
        id: randomUUID(),
        eventType: 'contact.owner_changed',
        programmeId: PROGRAMME_A1,
        aggregateType: 'contact',
        aggregateId: randomUUID(),
        payload: { contactId, previousOwnerId: null, newOwnerId: null },
      }).catch((error: unknown) => error);
      const outOfScope = await appendOutboxEvent(tx, {
        id: randomUUID(),
        eventType: 'contact.owner_changed',
        programmeId: PROGRAMME_A2,
        aggregateType: 'contact',
        aggregateId: contactId,
        payload: { contactId, previousOwnerId: null, newOwnerId: null },
      }).catch((error: unknown) => error);
      await tx.query('SELECT 1');
      return { refused, outOfScope };
    });
    expect(outcome.refused).toBeInstanceOf(OutboxEventRefusedError);
    expect((outcome.refused as OutboxEventRefusedError).refusal).toBe('invalid_payload');
    expect((outcome.outOfScope as OutboxEventRefusedError).refusal).toBe('programme_out_of_scope');
    const rows = await migrator.query('SELECT 1 FROM outbox_event');
    expect(rows.rowCount).toBe(0);
  });
});
