import type { ConsumedOutboxEvent, TenantTx } from '@kasuwa/db';
import type { Grants } from '@kasuwa/permissions';
import { UnknownObjectDefError } from '@kasuwa/metadata-engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fieldAccess = vi.hoisted(() => ({
  level: 'edit' as 'edit' | 'read' | 'none',
  throws: false as false | 'unknown' | 'other',
}));

vi.mock('@kasuwa/metadata-engine/field-access-for-user', () => ({
  loadFieldAccessForUser: vi.fn(async (_tx: unknown, _object: string, _user: string, programmes: readonly string[]) => {
    if (fieldAccess.throws === 'unknown') throw new UnknownObjectDefError('contact');
    if (fieldAccess.throws === 'other') throw new Error('connection lost');
    return new Map(programmes.map((id) => [id, new Map([['owner_user_id', fieldAccess.level]])]));
  }),
}));

import {
  handleNotificationEvent,
  isDuplicateDelivery,
  isUndeliverable,
  recipientMayRead,
} from './notification-handler';

// Invented identifiers (CLAUDE.md 6.1).
const TENANT = '10000000-0000-4000-8000-0100000000a1';
const PROGRAMME = '10000000-0000-4000-8000-0100000000b1';
const ACTOR = '10000000-0000-4000-8000-0100000000c1';
const RECIPIENT = '10000000-0000-4000-8000-0100000000c2';
const OTHER = '10000000-0000-4000-8000-0100000000c3';
const RECORD = '10000000-0000-4000-8000-0100000000d1';
const EVENT = '10000000-0000-4000-8000-0100000000e1';

interface World {
  owner: string | null | 'absent';
  member: { is_tenant_admin: boolean; set_key: string | null } | null;
  job: { created_by_user_id: string; status: string } | null;
  insertError: unknown;
}

let world: World;
let asked: string[];

function fakeTx(): TenantTx {
  return {
    session: { tenantId: TENANT, userId: ACTOR, programmeIds: [PROGRAMME] },
    query: async (text: string) => {
      asked.push(text.replace(/\s+/gu, ' ').trim());
      if (/FROM (contact|account|deal|activity)\s+WHERE id/u.test(text)) {
        return world.owner === 'absent' ? [] : [{ owner_user_id: world.owner }];
      }
      if (/FROM "user" u/u.test(text)) return world.member === null ? [] : [world.member];
      if (/FROM import_job/u.test(text)) return world.job === null ? [] : [world.job];
      if (/^INSERT INTO notification/u.test(text.trim())) {
        if (world.insertError !== undefined) throw world.insertError;
        return [];
      }
      return [];
    },
  } as unknown as TenantTx;
}

function event(over: Partial<ConsumedOutboxEvent> = {}, payload: Record<string, unknown> = {}): ConsumedOutboxEvent {
  return {
    id: EVENT,
    tenantId: TENANT,
    programmeId: PROGRAMME,
    actorUserId: ACTOR,
    eventType: 'contact.owner_changed',
    schemaVersion: 1,
    aggregateType: 'contact',
    aggregateId: RECORD,
    payload: { contactId: RECORD, previousOwnerId: null, newOwnerId: RECIPIENT, ...payload },
    createdAt: '2026-10-19T10:00:00.000Z',
    ...over,
  };
}

const inserts = () => asked.filter((text) => text.startsWith('INSERT INTO notification'));

beforeEach(() => {
  world = {
    owner: RECIPIENT,
    member: { is_tenant_admin: false, set_key: 'agent' },
    job: null,
    insertError: undefined,
  };
  asked = [];
  fieldAccess.level = 'edit';
  fieldAccess.throws = false;
});

describe('handleNotificationEvent: owner events (T-0100 N-R1, N-R2, N-R3)', () => {
  it('writes one notification for the current owner, as the actor, in a savepoint, with no RETURNING', async () => {
    expect(await handleNotificationEvent(fakeTx(), event())).toBe('written');
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0]).not.toMatch(/RETURNING|ON CONFLICT/u);
    const order = asked.map((text) => text.split(' ')[0]);
    expect(order.slice(-3)).toEqual(['SAVEPOINT', 'INSERT', 'RELEASE']);
  });

  it('N-R1: the payload only gates. A different current owner writes nothing', async () => {
    world.owner = OTHER;
    expect(await handleNotificationEvent(fakeTx(), event())).toBe('skipped');
    expect(inserts()).toEqual([]);
  });

  it.each([
    ['the aggregate is gone, merged away or in another programme', 'absent' as const],
    ['the owner was cleared since', null],
  ])('writes nothing when %s', async (_name, owner) => {
    world.owner = owner;
    expect(await handleNotificationEvent(fakeTx(), event())).toBe('skipped');
    expect(inserts()).toEqual([]);
  });

  it('writes nothing for an unassignment event (D-P23)', async () => {
    expect(await handleNotificationEvent(fakeTx(), event({}, { newOwnerId: null }))).toBe('skipped');
    expect(asked).toEqual([]);
  });

  it('N-R2: never the actor', async () => {
    world.owner = ACTOR;
    expect(await handleNotificationEvent(fakeTx(), event({}, { newOwnerId: ACTOR }))).toBe('skipped');
    expect(inserts()).toEqual([]);
  });

  it('N-R2: never a recipient who is not an active member of the programme', async () => {
    world.member = null;
    expect(await handleNotificationEvent(fakeTx(), event())).toBe('skipped');
    expect(inserts()).toEqual([]);
  });

  it('N-R2: never a deal owner whose set reads no deals (D-L157)', async () => {
    world.member = { is_tenant_admin: false, set_key: 'client_portal' };
    const deal = event(
      { eventType: 'deal.owner_changed', aggregateType: 'deal' },
      { contactId: undefined, dealId: RECORD },
    );
    expect(await handleNotificationEvent(fakeTx(), deal)).toBe('skipped');
    expect(inserts()).toEqual([]);
    world.member = { is_tenant_admin: false, set_key: 'agent' };
    expect(await handleNotificationEvent(fakeTx(), deal)).toBe('written');
  });

  it.each(['none'] as const)('N-R3: owner_user_id withheld (%s) from the recipient writes nothing', async (level) => {
    fieldAccess.level = level;
    expect(await handleNotificationEvent(fakeTx(), event())).toBe('skipped');
    expect(inserts()).toEqual([]);
    fieldAccess.level = 'read';
    expect(await handleNotificationEvent(fakeTx(), event())).toBe('written');
  });

  it('N-R3: fails closed when the object has no field catalogue', async () => {
    fieldAccess.throws = 'unknown';
    expect(await handleNotificationEvent(fakeTx(), event())).toBe('skipped');
    expect(inserts()).toEqual([]);
  });

  it('D-L174: any other failure reading field access REJECTS (retried), never skipped', async () => {
    fieldAccess.throws = 'other';
    await expect(handleNotificationEvent(fakeTx(), event())).rejects.toThrow('connection lost');
    expect(inserts()).toEqual([]);
  });

  it('a payload whose aggregate id is not the row\'s writes nothing', async () => {
    expect(await handleNotificationEvent(fakeTx(), event({}, { contactId: OTHER }))).toBe('skipped');
    expect(asked).toEqual([]);
  });
});

describe('handleNotificationEvent: idempotency (D-L164)', () => {
  it('treats 23505 on the idempotency key as already delivered: rolls the savepoint back and RESOLVES', async () => {
    world.insertError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'notification_source_event_recipient_key',
    });
    expect(await handleNotificationEvent(fakeTx(), event())).toBe('duplicate');
    expect(asked.slice(-3).map((text) => text.split(' ').slice(0, 3).join(' '))).toEqual([
      'INSERT INTO notification',
      'ROLLBACK TO SAVEPOINT',
      'RELEASE SAVEPOINT kasuwa_notification_delivery',
    ]);
  });

  it('rejects for any other failure, so the job is retried', async () => {
    world.insertError = Object.assign(new Error('boom'), { code: '40001' });
    await expect(handleNotificationEvent(fakeTx(), event())).rejects.toThrow('boom');
    world.insertError = Object.assign(new Error('boom'), { code: '23505', constraint: 'notification_pkey' });
    await expect(handleNotificationEvent(fakeTx(), event())).rejects.toThrow('boom');
  });

  it.each([
    ['42501 (the actor lost the programme)', { code: '42501' }],
    ['23503 on the recipient FK', { code: '23503', constraint: 'notification_recipient_same_tenant_fk' }],
  ])('D-L174: %s is SKIPPED, not retried: the savepoint is rolled back and it resolves', async (_name, fields) => {
    world.insertError = Object.assign(new Error('refused'), fields);
    expect(await handleNotificationEvent(fakeTx(), event())).toBe('skipped');
    expect(asked.slice(-2).map((text) => text.split(' ').slice(0, 2).join(' '))).toEqual([
      'ROLLBACK TO',
      'RELEASE SAVEPOINT',
    ]);
  });

  it('isUndeliverable is 42501, and 23503 on the recipient FK only', () => {
    expect(isUndeliverable({ code: '42501' })).toBe(true);
    expect(isUndeliverable({ code: '23503', constraint: 'notification_recipient_same_tenant_fk' })).toBe(true);
    expect(isUndeliverable({ code: '23503', constraint: 'notification_actor_same_tenant_fk' })).toBe(false);
    expect(isUndeliverable({ code: '40001' })).toBe(false);
    expect(isUndeliverable(null)).toBe(false);
  });

  it('isDuplicateDelivery is exactly 23505 on that key', () => {
    expect(isDuplicateDelivery({ code: '23505', constraint: 'notification_source_event_recipient_key' })).toBe(true);
    expect(isDuplicateDelivery({ code: '23505', constraint: 'notification_pkey' })).toBe(false);
    expect(isDuplicateDelivery({ code: '23503', constraint: 'notification_source_event_recipient_key' })).toBe(false);
    expect(isDuplicateDelivery(null)).toBe(false);
    expect(isDuplicateDelivery('23505')).toBe(false);
  });
});

describe('handleNotificationEvent: import.finished', () => {
  const imported = (over: Partial<ConsumedOutboxEvent> = {}) =>
    event(
      { eventType: 'import.finished', aggregateType: 'import', actorUserId: RECIPIENT, ...over },
      { contactId: undefined, previousOwnerId: undefined, newOwnerId: undefined, importId: RECORD },
    );

  beforeEach(() => {
    world.job = { created_by_user_id: RECIPIENT, status: 'finished' };
    world.member = { is_tenant_admin: true, set_key: null };
  });

  it('notifies the creator, who is the actor: an import is exempt from the actor rule', async () => {
    expect(await handleNotificationEvent(fakeTx(), imported())).toBe('written');
    expect(inserts()).toHaveLength(1);
  });

  it('also for a failed job, but not for one still running', async () => {
    world.job = { created_by_user_id: RECIPIENT, status: 'failed' };
    expect(await handleNotificationEvent(fakeTx(), imported())).toBe('written');
    world.job = { created_by_user_id: RECIPIENT, status: 'running' };
    expect(await handleNotificationEvent(fakeTx(), imported())).toBe('skipped');
  });

  it('writes nothing when the actor is not the creator (a forged "finished your import")', async () => {
    expect(await handleNotificationEvent(fakeTx(), imported({ actorUserId: OTHER }))).toBe('skipped');
    expect(inserts()).toEqual([]);
  });

  it('writes nothing for an absent job or a creator who can no longer import', async () => {
    world.job = null;
    expect(await handleNotificationEvent(fakeTx(), imported())).toBe('skipped');
    world.job = { created_by_user_id: RECIPIENT, status: 'finished' };
    world.member = { is_tenant_admin: false, set_key: 'agent' };
    expect(await handleNotificationEvent(fakeTx(), imported())).toBe('skipped');
  });
});

describe('handleNotificationEvent: other types', () => {
  it('skips a type it does not serve, without a query', async () => {
    expect(await handleNotificationEvent(fakeTx(), event({ eventType: 'deal.stage_changed' }))).toBe('skipped');
    expect(asked).toEqual([]);
  });
});

describe('recipientMayRead', () => {
  const grants = (set: string | null, admin = false): Grants => ({
    isTenantAdmin: admin,
    reachableProgrammeIds: [PROGRAMME],
    programmeSets: new Map([[PROGRAMME, set]]),
  });

  it('deals need a pipeline-reading set; client_portal and a custom set read none', () => {
    expect(recipientMayRead(grants('agent'), 'deal', PROGRAMME)).toBe(true);
    expect(recipientMayRead(grants('client_portal'), 'deal', PROGRAMME)).toBe(false);
    expect(recipientMayRead(grants('my_custom_set'), 'deal', PROGRAMME)).toBe(false);
    expect(recipientMayRead(grants(null, true), 'deal', PROGRAMME)).toBe(true);
  });

  it('an import needs contact.import', () => {
    expect(recipientMayRead(grants('agent'), 'import', PROGRAMME)).toBe(false);
    expect(recipientMayRead(grants(null, true), 'import', PROGRAMME)).toBe(true);
  });

  it('contacts, accounts and activities need only membership of that programme', () => {
    for (const type of ['contact', 'account', 'activity'] as const) {
      expect(recipientMayRead(grants('client_portal'), type, PROGRAMME)).toBe(true);
      expect(recipientMayRead(grants('client_portal'), type, OTHER)).toBe(false);
    }
  });
});
