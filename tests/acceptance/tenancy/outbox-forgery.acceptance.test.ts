import { randomUUID } from 'node:crypto';
import * as db from '@kasuwa/db';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import * as domainCore from '@kasuwa/domain-core';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

/**
 * ACCEPTANCE (TENANCY) — T-0098, forged outbox jobs (ADR-0018 point 8 and its
 * "Tests: Tenancy" line; D-P29; CLAUDE.md 6.5).
 *
 * Written by Agent 12 for the lead before assignment (D-L23, D-L25), from the
 * invariant, not from an implementation (none exists). The interfaces are
 * pinned in tests/acceptance/platform/outbox.acceptance.test.ts (I4, I6, I8,
 * I9); this file uses three of them:
 *
 *   appendOutboxEvent(tx, { id, eventType, programmeId, aggregateType,
 *                           aggregateId, payload })            — to produce
 *   relayOutboxBatch(relayPool, { queues, batchSize })          — to obtain the
 *       GENUINE envelope the relay puts on the queue, which every forgery
 *       below starts from (so this file pins the envelope's field names
 *       id, tenantId, programmeId, actorUserId, eventType, aggregateType and
 *       aggregateId, and nothing else about its shape)
 *   consumeOutboxJob(appPool, data, handler)                    — under attack
 *
 * ------------------------------------------------------------------------
 * THE THREAT. Redis is transport, not authority (ADR-0018 point 8). Anyone who
 * can write to Redis, or replay or edit a job, controls the envelope: which
 * tenant, which actor, which event id, which aggregate. The consumer re-enters
 * a tenant AS the actor the envelope names, with that actor's scope. So a
 * forged envelope is an attempt to run a handler (a notification insert in
 * T-0100) in a tenant, under a scope, or about an aggregate that the event
 * never had. The defence is the re-read: the row is fetched by id UNDER RLS in
 * the actor's own tenant transaction, and every identifying field must match.
 *
 * WHAT EVERY FORGERY MUST PRODUCE:
 *   - the handler is NEVER called (it is the only thing that could write);
 *   - consumeOutboxJob RESOLVES { outcome: 'dropped', reason } — a throw would
 *     make BullMQ retry a forgery five times and park it in the failed set;
 *   - no row changes in either tenant (digest of every row an attack or a
 *     helper could touch, as the migrator sees it);
 *   - nothing it returns or prints names either tenant or the aggregate
 *     ("no error text naming either").
 *
 * RULINGS (all three ACCEPTED by the lead in D-L156):
 *   F-R1. The re-read compares the actor and the tenant too, not only the
 *         programme, aggregate and type that ADR-0018 point 8 lists. The
 *         actor decides whose scope the handler runs under, so an envelope
 *         naming a WIDER actor than the row (an agent's event replayed as the
 *         supervisor) is a scope escalation, and Redis is "not trusted for
 *         scope".
 *   F-R2. reason 'forged' when the actor resolves and the row is missing or
 *         differs; 'actor_gone' when the actor no longer resolves (disabled).
 *         Where both are true at once (a cross-tenant actor), either reason is
 *         accepted: the order of the checks is the builder's.
 *   F-R3. BEYOND ADR-0018 — the app's outbox policy binds actor_user_id to
 *         the session user. ADR-0018 point 3 gives kasuwa_app "the usual
 *         tenant-and-programme predicate", so raw SQL inside a tenant (any
 *         agent) can INSERT an event naming ANOTHER actor in its programme
 *         (the supervisor). The relay publishes it, the consumer re-reads a
 *         row that matches its envelope exactly, and the handler runs as the
 *         supervisor, with the supervisor's scope, about whatever aggregate id
 *         the agent chose — including a contact in a programme the agent
 *         cannot see. appendOutboxEvent cannot be bypassed this way; raw SQL
 *         can. A RESTRICTIVE `FOR INSERT TO kasuwa_app` policy WITH CHECK
 *         (actor_user_id = app.current_user_id()) closes it: the permissive
 *         tenant policy keeps WITH CHECK = USING (CLAUDE.md 2.4), reads stay
 *         tenant-and-programme as the platform suite pins, and the consumer
 *         still reads the row as its own actor. The section 4 test is marked
 *         as this ruling (accepted, D-L156: the restrictive INSERT pins
 *         `actor_user_id = app.current_user_id()`).
 *
 * Every test here fails on main: there is no table, no export and no harness
 * value. None passes by construction.
 *
 * SECTION 5 (T-0100, a lead edit by Agent 12 under D-L23): the same forgeries
 * against the REAL notifications handler (`handleNotificationEvent` from
 * @kasuwa/domain-core), replays, raw-SQL events that pass the helper but aim
 * across a programme (D-L156) or a tenant, the N-R1 gate, and N-R5 (no raw
 * INSERT of a notification as another actor). Sections 0–4 are unchanged.
 */

const SUITE_APP_NAME = 'acceptance-t0098-forgery';
const NOTIFICATIONS_QUEUE = 'kasuwa.events.notifications';
const OWNER_CHANGED = 'contact.owner_changed';

// ---------------------------------------------------------------------------
// the pinned exports (see the platform suite's header)
// ---------------------------------------------------------------------------

interface OutboxEventInput {
  id: string;
  eventType: string;
  programmeId: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
}
type AppendOutboxEvent = (tx: TenantTx, event: OutboxEventInput) => Promise<unknown>;
interface OutboxJob {
  name: string;
  data: unknown;
  opts?: Record<string, unknown>;
}
type RelayOutboxBatch = (
  pool: Pool,
  options: {
    queues: Readonly<Record<string, { addBulk: (jobs: readonly OutboxJob[]) => Promise<unknown> }>>;
    batchSize: number;
  },
) => Promise<unknown>;
type ConsumeOutcome = { outcome: string; reason?: string; value?: unknown };
type ConsumeOutboxJob = (
  pool: Pool,
  data: unknown,
  handler: (tx: TenantTx, envelope: Record<string, unknown>) => Promise<unknown>,
) => Promise<ConsumeOutcome>;

function pinned<T>(name: string): T {
  const candidate: unknown = (db as Record<string, unknown>)[name];
  if (typeof candidate !== 'function') {
    throw new Error(`T-0098: @kasuwa/db does not export ${name}`);
  }
  return candidate as T;
}

function relayDatabaseUrl(): string {
  const value: unknown = (inject as unknown as (key: string) => unknown)('relayDatabaseUrl');
  if (typeof value !== 'string' || value === '') {
    throw new Error("The harness provides no inject('relayDatabaseUrl') (T-0098 I9).");
  }
  return value;
}

function seededContact(tenantId: string, programmeId: string, nth = 0): string {
  const found = SEED_CONTACTS.filter(
    (contact) => contact.tenantId === tenantId && contact.programmeId === programmeId,
  )[nth];
  if (found === undefined) throw new Error(`fixture: no seeded contact #${nth} in ${programmeId}`);
  return found.id;
}

const CONTACT_A1 = seededContact(TENANT_A, PROGRAMME_A1);
const CONTACT_A2 = seededContact(TENANT_A, PROGRAMME_A2);
const CONTACT_B1 = seededContact(TENANT_B, PROGRAMME_B1);

/** Strings no drop outcome or log line may contain. */
const NAMING_EITHER_TENANT: readonly string[] = [
  TENANT_A,
  TENANT_B,
  ...SEED_TENANTS.flatMap((tenant) => [tenant.name, tenant.slug]),
  CONTACT_A1,
  CONTACT_A2,
  CONTACT_B1,
];

describe('acceptance (tenancy): a forged outbox job writes nothing, anywhere (T-0098)', () => {
  let appPool: Pool;
  let observer: Pool;
  let relay: Pool | undefined;

  const relayPool = (): Pool => {
    relay ??= createPool({ connectionString: relayDatabaseUrl(), max: 2, applicationName: SUITE_APP_NAME });
    return relay;
  };

  /** Handler calls. Every forgery asserts this stays empty. */
  let calls: { session: { tenantId: string; userId: string; programmeIds: readonly string[] }; envelope: Record<string, unknown> }[];

  const handler = async (tx: TenantTx, envelope: Record<string, unknown>): Promise<string> => {
    calls.push({ session: { ...tx.session }, envelope });
    return 'handled';
  };

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2, applicationName: SUITE_APP_NAME });
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2, applicationName: SUITE_APP_NAME });
  });

  afterAll(async () => {
    await observer?.query('DELETE FROM outbox_event').catch(() => undefined);
    await relay?.end();
    await appPool?.end();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  beforeEach(async () => {
    calls = [];
    await observer.query('DELETE FROM outbox_event');
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  /** Produces an event through the real producer path, and returns its id. */
  async function produce(
    tenantId: string,
    userId: string,
    programmeId: string,
    contactId: string,
  ): Promise<string> {
    const id = randomUUID();
    const append = pinned<AppendOutboxEvent>('appendOutboxEvent');
    await withTenantTransaction(appPool, { tenantId, userId }, async (tx) => {
      await append(tx, {
        id,
        eventType: OWNER_CHANGED,
        programmeId,
        aggregateType: 'contact',
        aggregateId: contactId,
        payload: { contactId, previousOwnerId: userId, newOwnerId: userId },
      });
    });
    return id;
  }

  /** Runs the real relay once, and returns the envelope it enqueued per event id. */
  async function envelopes(): Promise<Map<string, Record<string, unknown>>> {
    const jobs: OutboxJob[] = [];
    const queues = {
      [NOTIFICATIONS_QUEUE]: {
        addBulk: async (batch: readonly OutboxJob[]) => {
          jobs.push(...batch);
          return batch;
        },
      },
    };
    await pinned<RelayOutboxBatch>('relayOutboxBatch')(relayPool(), { queues, batchSize: 100 });
    return new Map(
      jobs.map((job) => [
        String(job.opts?.jobId),
        JSON.parse(JSON.stringify(job.data)) as Record<string, unknown>,
      ]),
    );
  }

  async function genuine(
    tenantId: string,
    userId: string,
    programmeId: string,
    contactId: string,
  ): Promise<Record<string, unknown>> {
    const id = await produce(tenantId, userId, programmeId, contactId);
    const envelope = (await envelopes()).get(id);
    if (envelope === undefined) throw new Error('fixture: the relay enqueued no job for the event');
    // NON-VACUITY, per test: the untouched envelope IS handled, now, in this
    // state. Without it, a helper that drops every job passes every forgery.
    const control = await pinned<ConsumeOutboxJob>('consumeOutboxJob')(appPool, envelope, handler);
    expect(control, 'control: the genuine envelope was not handled').toMatchObject({ outcome: 'handled' });
    calls = [];
    return envelope;
  }

  /** Everything a handler or the helper could write, in both tenants. */
  async function worldDigest(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const table of ['outbox_event', 'contact', 'account', 'activity', 'deal', 'audit_event', 'user', 'user_programme']) {
      const result = await observer.query<{ d: string | null }>(
        `SELECT md5(string_agg(md5(row_to_json(t)::text), ',' ORDER BY md5(row_to_json(t)::text))) AS d
           FROM "${table}" t WHERE t.tenant_id = ANY($1::uuid[])`,
        [[TENANT_A, TENANT_B]],
      );
      out[table] = result.rows[0]?.d ?? 'empty';
    }
    return out;
  }

  /**
   * Delivers a job and returns what came back, capturing anything the helper
   * writes to stdout or stderr meanwhile. PARTIAL: a logger that writes to the
   * file descriptor directly (pino's sonic-boom, for one) is not seen here.
   * The worker-process test in the platform suite reads the real fds.
   */
  async function deliver(data: unknown): Promise<{ outcome: ConsumeOutcome | { threw: string }; printed: string }> {
    let printed = '';
    const capture = (chunk: unknown): boolean => {
      printed += typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      return true;
    };
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    try {
      const outcome = await pinned<ConsumeOutboxJob>('consumeOutboxJob')(appPool, data, handler);
      return { outcome, printed };
    } catch (error) {
      return { outcome: { threw: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, printed };
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  }

  async function expectDropped(
    data: unknown,
    reasons: readonly string[],
  ): Promise<void> {
    const before = await worldDigest();
    const { outcome, printed } = await deliver(data);
    expect(outcome, 'a forged job threw: BullMQ would retry it, and its message is a leak channel').not.toHaveProperty('threw');
    expect(outcome).toMatchObject({ outcome: 'dropped' });
    expect(reasons).toContain((outcome as ConsumeOutcome).reason);
    expect(calls, 'the handler ran for a forged job').toEqual([]);
    expect(await worldDigest(), 'a forged job changed a row').toEqual(before);
    const said = `${JSON.stringify(outcome)}\n${printed}`;
    expect(NAMING_EITHER_TENANT.filter((value) => said.includes(value))).toEqual([]);
  }

  // =========================================================================
  // 0. Controls: the genuine job is handled, under the actor's resolved scope.
  // =========================================================================

  describe('0. controls', () => {
    it('a genuine job is handled once, in the actor\'s tenant, with the scope user_programme gives', async () => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      const { outcome } = await deliver(envelope);
      expect(outcome).toMatchObject({ outcome: 'handled', value: 'handled' });
      expect(calls.map((call) => call.session)).toEqual([
        { tenantId: TENANT_A, userId: USER_A_AGENT_1, programmeIds: [PROGRAMME_A1] },
      ]);
      expect(calls[0]?.envelope.id).toBe(envelope.id);
    });

    it('a genuine job for an event the relay already published is still handled (the app\'s read ignores publish state)', async () => {
      const envelope = await genuine(TENANT_B, USER_B_AGENT_1, PROGRAMME_B1, CONTACT_B1);
      const published = await observer.query<{ p: boolean }>(
        'SELECT published_at IS NOT NULL AS p FROM outbox_event WHERE id = $1',
        [envelope.id],
      );
      expect(published.rows[0]?.p, 'control: the relay marked it published').toBe(true);
      const { outcome } = await deliver(envelope);
      expect(outcome).toMatchObject({ outcome: 'handled' });
    });
  });

  // =========================================================================
  // 1. The ADR's two tenancy forgeries.
  // =========================================================================

  describe('1. ADR-0018 "Tests: Tenancy"', () => {
    it("tenant B's tenant id with tenant A's event id (and B's own actor): dropped as forged", async () => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      await expectDropped({ ...envelope, tenantId: TENANT_B, actorUserId: USER_B_AGENT_1 }, ['forged']);
    });

    it("tenant B's tenant id with tenant A's event id and A's actor: dropped", async () => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      await expectDropped({ ...envelope, tenantId: TENANT_B }, ['forged', 'actor_gone']);
    });

    it("tenant A's actor with tenant B's aggregate: dropped as forged", async () => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      await expectDropped({ ...envelope, aggregateId: CONTACT_B1 }, ['forged']);
    });

    it("tenant A's actor naming tenant B's EVENT id: not visible under RLS, dropped as forged", async () => {
      const own = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      const foreign = await genuine(TENANT_B, USER_B_AGENT_1, PROGRAMME_B1, CONTACT_B1);
      await expectDropped({ ...own, id: foreign.id }, ['forged']);
    });
  });

  // =========================================================================
  // 2. Every other field an attacker controls.
  // =========================================================================

  describe('2. each identifying field, swapped', () => {
    it('another programme of the same tenant, for an actor in both (the supervisor): dropped as forged', async () => {
      const envelope = await genuine(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, CONTACT_A1);
      await expectDropped({ ...envelope, programmeId: PROGRAMME_A2 }, ['forged']);
    });

    it('F-R1: an agent\'s event replayed as the supervisor (a wider scope): dropped as forged', async () => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      await expectDropped({ ...envelope, actorUserId: USER_A_SUPERVISOR }, ['forged']);
    });

    it('the aggregate swapped for a contact the actor can ALSO see (the supervisor, an A2 contact): dropped as forged', async () => {
      const envelope = await genuine(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, CONTACT_A1);
      await expectDropped({ ...envelope, aggregateId: CONTACT_A2 }, ['forged']);
    });

    it.each([
      ['eventType', 'deal.stage_changed'],
      ['aggregateType', 'deal'],
      ['id', randomUUID()],
    ])('%s swapped: dropped as forged', async (field, value) => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      await expectDropped({ ...envelope, [field]: value }, ['forged']);
    });

    it('extra scope fields smuggled into a genuine envelope are ignored: the session is still resolved', async () => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      const { outcome } = await deliver({
        ...envelope,
        programmeIds: [PROGRAMME_A1, PROGRAMME_A2, PROGRAMME_B1],
        isTenantAdmin: true,
        session: { tenantId: TENANT_A, userId: USER_A_SUPERVISOR, programmeIds: [PROGRAMME_A2] },
      });
      // Handled or dropped are both safe; what must never happen is a wider session.
      if ((outcome as ConsumeOutcome).outcome === 'handled') {
        expect(calls.map((call) => call.session)).toEqual([
          { tenantId: TENANT_A, userId: USER_A_AGENT_1, programmeIds: [PROGRAMME_A1] },
        ]);
      } else {
        expect(outcome).toMatchObject({ outcome: 'dropped' });
        expect(calls).toEqual([]);
      }
    });
  });

  // =========================================================================
  // 3. Corrupt jobs and actors who no longer resolve.
  // =========================================================================

  describe('3. corrupt envelopes, and actors who no longer resolve', () => {
    it.each([
      ['null', null],
      ['a string', 'contact.owner_changed for Amaka Obi'],
      ['an array', [TENANT_A, USER_A_AGENT_1]],
      ['an empty object', {}],
    ])('a job whose data is %s: dropped as forged, never thrown', async (_name, data) => {
      await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1); // the control only
      await expectDropped(data, ['forged']);
    });

    it.each([
      ['tenantId', 'not-a-uuid'],
      ['actorUserId', "'; DELETE FROM outbox_event; --"],
      ['id', '00000000-0000-0000-0000-000000000000) OR (true'],
      ['tenantId', undefined],
    ])('a genuine envelope with %s = %j: dropped as forged, never thrown', async (field, value) => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      const data: Record<string, unknown> = { ...envelope, [field]: value };
      if (value === undefined) delete data[field];
      await expectDropped(data, ['forged']);
    });

    it('the actor was disabled after the event: dropped as actor_gone, never widened', async () => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      await observer.query(`UPDATE "user" SET status = 'disabled' WHERE id = $1`, [USER_A_AGENT_1]);
      await expectDropped(envelope, ['actor_gone']);
    });

    it("the actor was removed from the event's programme: dropped", async () => {
      const envelope = await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1);
      const removed = await observer.query(
        'DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2',
        [USER_A_AGENT_1, PROGRAMME_A1],
      );
      expect(removed.rowCount, 'control: the membership existed').toBe(1);
      await expectDropped(envelope, ['forged', 'actor_gone']);
    });

    it("a row naming another tenant's actor (written past every app check): published, then dropped", async () => {
      // Only the migrator can write this row; it stands for corruption.
      const id = randomUUID();
      await observer.query(
        `INSERT INTO outbox_event (id, tenant_id, programme_id, actor_user_id, event_type, schema_version,
                                   aggregate_type, aggregate_id, payload)
         VALUES ($1, $2, $3, $4, $5, 1, 'contact', $6, $7::jsonb)`,
        [id, TENANT_A, PROGRAMME_A1, USER_B_AGENT_1, OWNER_CHANGED, CONTACT_A1,
          JSON.stringify({ contactId: CONTACT_A1, previousOwnerId: USER_B_AGENT_1, newOwnerId: USER_B_AGENT_1 })],
      );
      const envelope = (await envelopes()).get(id);
      expect(envelope, 'control: the relay published the corrupt row').toBeDefined();
      await genuine(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, CONTACT_A1); // the control only
      await expectDropped(envelope, ['forged', 'actor_gone']);
    });
  });

  // =========================================================================
  // 4. F-R3 (beyond ADR-0018): raw SQL cannot write an event as someone else.
  // =========================================================================

  describe('4. F-R3: the outbox policy binds the actor to the session user', () => {
    it('an agent cannot INSERT an event naming the supervisor as its actor (42501), though it may name itself', async () => {
      const attempt = async (actor: string): Promise<string> => {
        const id = randomUUID();
        try {
          await withTenantTransaction(appPool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
            await tx.query(
              `INSERT INTO outbox_event (id, tenant_id, programme_id, actor_user_id, event_type, schema_version,
                                         aggregate_type, aggregate_id, payload)
               VALUES ($1, $2, $3, $4, $5, 1, 'contact', $6, $7::jsonb)`,
              [id, TENANT_A, PROGRAMME_A1, actor, OWNER_CHANGED, CONTACT_A2,
                JSON.stringify({ contactId: CONTACT_A2, previousOwnerId: actor, newOwnerId: actor })],
            );
          });
          return 'committed';
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          return typeof code === 'string' ? code : String(error);
        }
      };
      // Control: the same statement as itself commits, so the refusal below is
      // about the actor and nothing else.
      expect(await attempt(USER_A_AGENT_1)).toBe('committed');
      expect(await attempt(USER_A_SUPERVISOR), 'an agent wrote an event as the supervisor').toBe('42501');
      const landed = await observer.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM outbox_event WHERE actor_user_id = $1',
        [USER_A_SUPERVISOR],
      );
      expect(landed.rows[0]?.n).toBe(0);
    });
  });

  // =========================================================================
  // 5. T-0100 (lead edit, D-L23): the REAL notifications handler under the
  //    same forgeries, plus the raw-SQL attacks on events and on the
  //    notification table. The interfaces are pinned in
  //    tests/acceptance/records/notifications-api.acceptance.test.ts (I1–I3,
  //    N-R1, N-R5). Sections 0–4 above use a recording stub, which proves the
  //    helper never calls a handler for a forgery; this section proves the
  //    handler the worker really registers writes nothing for one, and that a
  //    row which passes the helper's checks still cannot aim a notification
  //    across a programme or a tenant.
  //
  //    On main every test here fails: no `notification` table, and no
  //    `handleNotificationEvent` export.
  // =========================================================================

  describe('5. T-0100: the real notifications handler writes nothing for a forged, replayed or misaimed job', () => {
    type Handler = (tx: TenantTx, envelope: Record<string, unknown>) => Promise<unknown>;
    type ConsumeBound = (
      pool: Pool,
      data: unknown,
      handler: Handler,
      options: { queue: string },
    ) => Promise<ConsumeOutcome>;

    let planted = 0;

    function realHandler(): Handler {
      const candidate: unknown = (domainCore as Record<string, unknown>).handleNotificationEvent;
      if (typeof candidate !== 'function') {
        throw new Error('T-0100 I1: @kasuwa/domain-core does not export handleNotificationEvent');
      }
      return candidate as Handler;
    }

    async function consumeReal(data: unknown): Promise<ConsumeOutcome | { threw: string }> {
      // Resolved outside the try: a missing export fails the test by name,
      // not as "a forged job threw".
      const handler = realHandler();
      try {
        return await pinned<ConsumeBound>('consumeOutboxJob')(appPool, data, handler, { queue: NOTIFICATIONS_QUEUE });
      } catch (error) {
        return { threw: error instanceof Error ? error.name : 'non-error' };
      }
    }

    /** A user in one programme with the `agent` set, planted by the migrator. */
    async function freshAgent(tenantId: string, programmeId: string): Promise<string> {
      planted += 1;
      const id = `11111111-0000-4000-8000-0100e9${planted.toString(16).padStart(6, '0')}`;
      await observer.query(
        `INSERT INTO "user" (id, tenant_id, email, display_name, is_tenant_admin) VALUES ($1, $2, $3, $4, false)`,
        [id, tenantId, `t0100.forgery.${planted}@example.test`, `Zqn Forgery Fixture ${planted}`],
      );
      await observer.query(
        `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
         SELECT $1, $2, $3, ps.id FROM permission_set ps WHERE ps.tenant_id = $3 AND ps.key = 'agent'`,
        [id, programmeId, tenantId],
      );
      return id;
    }

    /**
     * A producer, as T-0100's must behave (D-L161): lock and change the owner,
     * then append in the same transaction. Returns the genuine envelope the
     * real relay enqueued for it.
     */
    async function genuineAssignment(
      tenantId: string,
      actor: string,
      programmeId: string,
      contactId: string,
      newOwnerId: string,
    ): Promise<Record<string, unknown>> {
      const id = randomUUID();
      await withTenantTransaction(appPool, { tenantId, userId: actor }, async (tx) => {
        const locked = await tx.query<{ owner_user_id: string | null }>(
          'SELECT owner_user_id FROM contact WHERE id = $1 AND tenant_id = $2 AND programme_id = $3 FOR UPDATE',
          [contactId, tenantId, programmeId],
        );
        const previousOwnerId = locked[0]?.owner_user_id ?? null;
        await tx.query('UPDATE contact SET owner_user_id = $1 WHERE id = $2 AND tenant_id = $3', [newOwnerId, contactId, tenantId]);
        await pinned<AppendOutboxEvent>('appendOutboxEvent')(tx, {
          id,
          eventType: OWNER_CHANGED,
          programmeId,
          aggregateType: 'contact',
          aggregateId: contactId,
          payload: { contactId, previousOwnerId, newOwnerId },
        });
      });
      const envelope = (await envelopes()).get(id);
      if (envelope === undefined) throw new Error('fixture: the relay enqueued no job for the event');
      return envelope;
    }

    /** A raw event row, as any kasuwa_app session may INSERT it (actor = itself, F-R3). */
    async function rawEvent(
      tenantId: string,
      actor: string,
      programmeId: string,
      contactId: string,
      newOwnerId: string,
    ): Promise<Record<string, unknown>> {
      const id = randomUUID();
      await withTenantTransaction(appPool, { tenantId, userId: actor }, async (tx) => {
        await tx.query(
          `INSERT INTO outbox_event (id, tenant_id, programme_id, actor_user_id, event_type, schema_version,
                                     aggregate_type, aggregate_id, payload)
           VALUES ($1, $2, $3, $4, $5, 1, 'contact', $6, $7::jsonb)`,
          [id, tenantId, programmeId, actor, OWNER_CHANGED, contactId,
            JSON.stringify({ contactId, previousOwnerId: null, newOwnerId })],
        );
      });
      const envelope = (await envelopes()).get(id);
      if (envelope === undefined) throw new Error('fixture: the relay did not publish the raw event');
      return envelope;
    }

    async function notificationDigest(): Promise<string> {
      const result = await observer.query<{ d: string | null; n: number }>(
        `SELECT md5(string_agg(md5(row_to_json(t)::text), ',' ORDER BY md5(row_to_json(t)::text))) AS d, count(*)::int AS n
           FROM notification t WHERE t.tenant_id = ANY($1::uuid[])`,
        [[TENANT_A, TENANT_B]],
      );
      return `${result.rows[0]?.n ?? -1}:${result.rows[0]?.d ?? 'empty'}`;
    }

    async function notificationsFor(recipient: string): Promise<number> {
      const result = await observer.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM notification WHERE recipient_user_id = $1',
        [recipient],
      );
      return result.rows[0]?.n ?? -1;
    }

    beforeEach(async () => {
      await observer.query('DELETE FROM notification').catch(() => undefined);
    });

    it('control: a genuine assignment, consumed by the real handler, notifies the new owner exactly once', async () => {
      const recipient = await freshAgent(TENANT_A, PROGRAMME_A1);
      const envelope = await genuineAssignment(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, CONTACT_A1, recipient);
      expect(await consumeReal(envelope)).toMatchObject({ outcome: 'handled' });
      expect(await notificationsFor(recipient)).toBe(1);
    });

    it.each([
      ['tenant B with B\'s actor', () => ({ tenantId: TENANT_B, actorUserId: USER_B_AGENT_1 })],
      ['tenant B with A\'s actor', () => ({ tenantId: TENANT_B })],
      ['the aggregate swapped for tenant B\'s contact', () => ({ aggregateId: CONTACT_B1 })],
      ['the aggregate swapped for another A1 contact', () => ({ aggregateId: seededContact(TENANT_A, PROGRAMME_A1, 1) })],
      ['the programme swapped for A2', () => ({ programmeId: PROGRAMME_A2 })],
      ['F-R1: the actor swapped for the supervisor', () => ({ actorUserId: USER_A_SUPERVISOR })],
      ['an invented event id', () => ({ id: randomUUID() })],
      ['the event type swapped', () => ({ eventType: 'deal.owner_changed' })],
    ])('%s: dropped, and the notification table is unchanged', async (_name, swap) => {
      const recipient = await freshAgent(TENANT_A, PROGRAMME_A1);
      // The genuine event is the agent's own assignment of a contact to a
      // colleague, so the actor swap to the supervisor widens the scope.
      const agent = await freshAgent(TENANT_A, PROGRAMME_A1);
      const envelope = await genuineAssignment(TENANT_A, agent, PROGRAMME_A1, CONTACT_A1, recipient);
      const before = await notificationDigest();
      const outcome = await consumeReal({ ...envelope, ...swap() });
      expect(outcome, 'a forged job threw').not.toHaveProperty('threw');
      expect(outcome).toMatchObject({ outcome: 'dropped' });
      expect(await notificationDigest(), 'a forged job wrote a notification').toBe(before);
      // Non-vacuity: the untouched envelope does write.
      expect(await consumeReal(envelope)).toMatchObject({ outcome: 'handled' });
      expect(await notificationsFor(recipient)).toBe(1);
    });

    it('a replayed job (three times, then twice at once) leaves one notification and never throws', async () => {
      const recipient = await freshAgent(TENANT_A, PROGRAMME_A1);
      const envelope = await genuineAssignment(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, CONTACT_A1, recipient);
      for (let n = 0; n < 3; n += 1) expect(await consumeReal(envelope)).toMatchObject({ outcome: 'handled' });
      const concurrent = await Promise.all([consumeReal(envelope), consumeReal(envelope)]);
      expect(concurrent.filter((outcome) => 'threw' in outcome)).toEqual([]);
      expect(await notificationsFor(recipient)).toBe(1);
    });

    it('D-L156: a raw event in A1 naming an A2 contact (actor in both) is handled and notifies nobody', async () => {
      const ownerInA2 = await freshAgent(TENANT_A, PROGRAMME_A2);
      await observer.query('UPDATE contact SET owner_user_id = $1 WHERE id = $2', [ownerInA2, CONTACT_A2]);
      const envelope = await rawEvent(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, CONTACT_A2, ownerInA2);
      const before = await notificationDigest();
      const outcome = await consumeReal(envelope);
      expect(outcome, 'the row matches its envelope, so the helper hands it on').toMatchObject({ outcome: 'handled' });
      expect(await notificationDigest()).toBe(before);
      expect(await notificationsFor(ownerInA2)).toBe(0);
    });

    it('a raw event in tenant A naming tenant B\'s contact and owner notifies nobody in either tenant', async () => {
      await observer.query('UPDATE contact SET owner_user_id = $1 WHERE id = $2', [USER_B_AGENT_1, CONTACT_B1]);
      const agent = await freshAgent(TENANT_A, PROGRAMME_A1);
      const envelope = await rawEvent(TENANT_A, agent, PROGRAMME_A1, CONTACT_B1, USER_B_AGENT_1);
      const before = await notificationDigest();
      const outcome = await consumeReal(envelope);
      expect(outcome).not.toHaveProperty('threw');
      expect(await notificationDigest()).toBe(before);
    });

    it('N-R1: a raw event naming a newOwnerId who is not the owner notifies neither the named user nor the owner', async () => {
      const owner = await freshAgent(TENANT_A, PROGRAMME_A1);
      const named = await freshAgent(TENANT_A, PROGRAMME_A1);
      const agent = await freshAgent(TENANT_A, PROGRAMME_A1);
      await observer.query('UPDATE contact SET owner_user_id = $1 WHERE id = $2', [owner, CONTACT_A1]);
      const envelope = await rawEvent(TENANT_A, agent, PROGRAMME_A1, CONTACT_A1, named);
      expect(await consumeReal(envelope)).toMatchObject({ outcome: 'handled' });
      expect(await notificationsFor(named)).toBe(0);
      expect(await notificationsFor(owner)).toBe(0);
    });

    it('N-R5: raw SQL cannot INSERT a notification as another actor, in another programme or tenant, or for another tenant\'s user', async () => {
      const agent = await freshAgent(TENANT_A, PROGRAMME_A1);
      const recipient = await freshAgent(TENANT_A, PROGRAMME_A1);
      const attempt = async (row: { tenantId?: string; programmeId?: string; actor?: string; recipient?: string }): Promise<string> =>
        withTenantTransaction(appPool, { tenantId: TENANT_A, userId: agent }, (tx) =>
          tx.query(
            `INSERT INTO notification (id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id, actor_user_id, source_event_id)
             VALUES ($1, $2, $3, $4, 'record_assigned', 'contact', $5, $6, $7)`,
            [randomUUID(), row.tenantId ?? TENANT_A, row.programmeId ?? PROGRAMME_A1, row.recipient ?? recipient, CONTACT_A1, row.actor ?? agent, randomUUID()],
          ),
        ).then(() => 'committed', (error: { code?: string }) => error.code ?? 'error');
      // Control: as itself, in its programme, for a colleague: the consumer's own shape.
      expect(await attempt({})).toBe('committed');
      const before = await notificationDigest();
      expect(await attempt({ actor: USER_A_SUPERVISOR }), 'a notification "from" the supervisor').toBe('42501');
      expect(await attempt({ programmeId: PROGRAMME_A2 })).toBe('42501');
      expect(await attempt({ tenantId: TENANT_B, programmeId: PROGRAMME_B1 })).toBe('42501');
      expect(await attempt({ recipient: USER_B_AGENT_1 }), 'a tenant B recipient on a tenant A row').not.toBe('committed');
      expect(await notificationDigest()).toBe(before);
    });
  });
});
