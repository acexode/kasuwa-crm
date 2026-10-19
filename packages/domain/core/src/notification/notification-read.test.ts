import type { TenantTx } from '@kasuwa/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  ownerLevel: 'edit' as 'edit' | 'read' | 'none',
  nameLevel: 'edit' as 'edit' | 'none',
  rows: [] as { id: string; programme_id: string; name: string | null }[],
}));

vi.mock('@kasuwa/metadata-engine', async (importOriginal) => {
  const real: Record<string, unknown> = await importOriginal();
  return {
    ...real,
    loadFieldAccess: vi.fn(async (_tx: unknown, _object: string) =>
      new Map([
        [
          PROGRAMME,
          new Map([
            ['owner_user_id', world.ownerLevel],
            ['given_names', world.nameLevel],
            ['family_name', world.nameLevel],
          ]),
        ],
      ]),
    ),
  };
});

vi.mock('@kasuwa/permissions', async (importOriginal) => {
  const real: Record<string, unknown> = await importOriginal();
  return {
    ...real,
    loadGrants: vi.fn(async () => ({
      isTenantAdmin: true,
      reachableProgrammeIds: [PROGRAMME],
      programmeSets: new Map(),
    })),
  };
});

import { notificationObjectKey, resolveNotificationObjects } from './notification.repository';

// Invented identifiers (CLAUDE.md 6.1).
const PROGRAMME = '15000000-0000-4000-8000-000000000001';
const CONTACT = '15000000-0000-4000-8000-000000000002';
const JOB = '15000000-0000-4000-8000-000000000003';

const tx = {
  session: { tenantId: 't', userId: 'u', programmeIds: [PROGRAMME] },
  query: async () => world.rows,
} as unknown as TenantTx;

const contact = { programmeId: PROGRAMME, objectType: 'contact' as const, objectId: CONTACT };

beforeEach(() => {
  world.ownerLevel = 'edit';
  world.nameLevel = 'edit';
  world.rows = [{ id: CONTACT, programme_id: PROGRAMME, name: 'Sample Name' }];
});

describe('resolveNotificationObjects: the read-time owner check (D-L174)', () => {
  it('names a visible item', async () => {
    const found = await resolveNotificationObjects(tx, [contact]);
    expect(found.get(notificationObjectKey('contact', CONTACT))).toBe('Sample Name');
  });

  it('drops the item, not just the name, once owner_user_id is withheld from the reader', async () => {
    world.ownerLevel = 'none';
    const found = await resolveNotificationObjects(tx, [contact]);
    expect(found.has(notificationObjectKey('contact', CONTACT))).toBe(false);
  });

  it('read-only owner access still shows the item', async () => {
    world.ownerLevel = 'read';
    expect((await resolveNotificationObjects(tx, [contact])).size).toBe(1);
  });

  it('a withheld NAME keeps the item, with a null name', async () => {
    world.nameLevel = 'none';
    const found = await resolveNotificationObjects(tx, [contact]);
    expect(found.get(notificationObjectKey('contact', CONTACT))).toBeNull();
  });

  it('an import has no owner field and is not dropped by the owner check', async () => {
    world.ownerLevel = 'none';
    world.rows = [{ id: JOB, programme_id: PROGRAMME, name: 'zq-people.csv' }];
    const found = await resolveNotificationObjects(tx, [
      { programmeId: PROGRAMME, objectType: 'import', objectId: JOB },
    ]);
    expect(found.get(notificationObjectKey('import', JOB))).toBe('zq-people.csv');
  });
});
