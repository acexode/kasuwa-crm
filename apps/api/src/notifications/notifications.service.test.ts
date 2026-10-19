import type { HttpException } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import type { NotificationRecord } from '@kasuwa/domain-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodError } from 'zod';
import { toAdminError } from '../admin/common/admin-errors';

const domain = vi.hoisted(() => ({
  rows: [] as unknown[],
  nextCursor: null as string | null,
  window: [] as unknown[],
  own: new Map<string, unknown>(),
  visible: new Map<string, string | null>(),
  actors: new Map<string, string>(),
  marked: [] as unknown[],
  setRead: [] as unknown[],
}));

vi.mock('@kasuwa/domain-core', async (importOriginal) => {
  const real: Record<string, unknown> = await importOriginal();
  return {
    ...real,
    listNotificationRows: vi.fn(async () => ({ rows: domain.rows, nextCursor: domain.nextCursor })),
    listUnreadWindow: vi.fn(async () => domain.window),
    findOwnNotification: vi.fn(async (_tx: unknown, id: string) => domain.own.get(id) ?? null),
    ownNotificationExists: vi.fn(async (_tx: unknown, id: string) => domain.own.has(id)),
    setNotificationRead: vi.fn(async (_tx: unknown, id: string, read: boolean) => {
      domain.setRead.push([id, read]);
      const row = domain.own.get(id) as NotificationRecord | undefined;
      return row === undefined ? null : { ...row, readAt: read ? new Date('2026-10-19T10:00:00.000Z') : null };
    }),
    markNotificationsRead: vi.fn(async (_tx: unknown, options: unknown) => {
      domain.marked.push(options);
    }),
    resolveNotificationObjects: vi.fn(async () => domain.visible),
    resolveNotificationActors: vi.fn(async () => domain.actors),
  };
});

import {
  listNotificationsFor,
  markAllReadFor,
  unreadCountFor,
  updateNotificationFor,
} from './notifications.service';

// Invented identifiers (CLAUDE.md 6.1).
const PROGRAMME = '13000000-0000-4000-8000-000000000001';
const ACTOR = '13000000-0000-4000-8000-000000000002';
const tx = { session: { tenantId: 't', userId: 'u', programmeIds: [PROGRAMME] }, query: vi.fn() } as unknown as TenantTx;

let counter = 0;
const id = () => `13000000-0000-4000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

function record(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: id(),
    programmeId: PROGRAMME,
    kind: 'record_assigned',
    objectType: 'contact',
    objectId: id(),
    actorUserId: ACTOR,
    createdAt: new Date('2026-10-19T09:00:00.000Z'),
    readAt: null,
    ...over,
  };
}

const key = (r: NotificationRecord) => `${r.objectType}:${r.objectId}`;

beforeEach(() => {
  domain.rows = [];
  domain.nextCursor = null;
  domain.window = [];
  domain.own = new Map();
  domain.visible = new Map();
  domain.actors = new Map();
  domain.marked = [];
  domain.setRead = [];
});

describe('listNotificationsFor', () => {
  it('drops an item whose object is not visible, never redacting it, and passes the cursor on', async () => {
    const shown = record();
    const dropped = record();
    domain.rows = [shown, dropped];
    domain.nextCursor = dropped.id;
    domain.visible.set(key(shown), 'Sample Name');
    domain.actors.set(`${ACTOR}:${PROGRAMME}`, 'Sample Actor');
    const page = await listNotificationsFor(tx, {});
    expect(page.nextCursor).toBe(dropped.id);
    expect(page.data).toEqual([
      {
        id: shown.id,
        kind: 'record_assigned',
        objectType: 'contact',
        objectId: shown.objectId,
        actor: { id: ACTOR, displayName: 'Sample Actor' },
        objectDisplayName: 'Sample Name',
        createdAt: '2026-10-19T09:00:00.000Z',
        readAt: null,
      },
    ]);
  });

  it('a withheld name is null, and an actor who left the programme is named null', async () => {
    const item = record({ readAt: new Date('2026-10-19T09:30:00.000Z') });
    domain.rows = [item];
    domain.visible.set(key(item), null);
    const page = await listNotificationsFor(tx, {});
    expect(page.data[0]).toMatchObject({
      objectDisplayName: null,
      actor: { id: ACTOR, displayName: null },
      readAt: '2026-10-19T09:30:00.000Z',
    });
  });

  it('a page where nothing is visible is empty, yet keeps its cursor: only null ends', async () => {
    domain.rows = [record(), record()];
    domain.nextCursor = domain.rows.length === 2 ? id() : null;
    const page = await listNotificationsFor(tx, { limit: '2' });
    expect(page.data).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
  });

  it('a bad query is a 400 before any read', async () => {
    await expect(listNotificationsFor(tx, { kind: 'mention' })).rejects.toThrow();
  });
});

describe('unreadCountFor', () => {
  const unreadRows = (count: number): NotificationRecord[] => Array.from({ length: count }, () => record());
  const seeVisible = (rows: NotificationRecord[]) => rows.forEach((row) => domain.visible.set(key(row), 'x'));

  it('counts visible items only', async () => {
    const rows = unreadRows(4);
    domain.window = rows;
    seeVisible(rows.slice(0, 3));
    expect(await unreadCountFor(tx)).toEqual({ count: 3, capped: false });
  });

  it('99 visible is { 99, false }; 100 is { 99, true }', async () => {
    domain.window = unreadRows(99);
    seeVisible(domain.window as NotificationRecord[]);
    expect(await unreadCountFor(tx)).toEqual({ count: 99, capped: false });
    domain.window = unreadRows(100);
    seeVisible(domain.window as NotificationRecord[]);
    expect(await unreadCountFor(tx)).toEqual({ count: 99, capped: true });
  });

  it('is zero when nothing is unread', async () => {
    expect(await unreadCountFor(tx)).toEqual({ count: 0, capped: false });
  });
});

describe('updateNotificationFor', () => {
  it('one 404 for a notification that is not the caller\'s, and nothing is written', async () => {
    await expect(updateNotificationFor(tx, { notificationId: id() }, { read: true })).rejects.toMatchObject({
      status: 404,
    });
    expect(domain.setRead).toEqual([]);
  });

  it('the same 404 for one whose object is no longer visible, judged BEFORE any write', async () => {
    const item = record();
    domain.own.set(item.id, item);
    await expect(updateNotificationFor(tx, { notificationId: item.id }, { read: true })).rejects.toMatchObject({
      status: 404,
    });
    expect(domain.setRead).toEqual([]);
  });

  it('marks read or unread and answers the item with its names', async () => {
    const item = record();
    domain.own.set(item.id, item);
    domain.visible.set(key(item), 'Sample Name');
    const read = await updateNotificationFor(tx, { notificationId: item.id }, { read: true });
    expect(read).toMatchObject({ id: item.id, objectDisplayName: 'Sample Name', readAt: '2026-10-19T10:00:00.000Z' });
    const unread = await updateNotificationFor(tx, { notificationId: item.id }, { read: false });
    expect(unread.readAt).toBeNull();
    expect(domain.setRead).toEqual([[item.id, true], [item.id, false]]);
  });

  it('a malformed id or body is a 400, before any read', async () => {
    await expect(updateNotificationFor(tx, { notificationId: 'x' }, { read: true })).rejects.toThrow();
    await expect(updateNotificationFor(tx, { notificationId: id() }, { read: 'yes' })).rejects.toThrow();
  });
});

describe('markAllReadFor', () => {
  it('marks, then answers the new visible count, never the number of rows changed', async () => {
    const stays = record();
    domain.window = [stays];
    domain.visible.set(key(stays), 'x');
    expect(await markAllReadFor(tx, { kind: 'task_assigned' })).toEqual({ count: 1, capped: false });
    expect(domain.marked).toEqual([{ kind: 'task_assigned' }]);
  });

  it('a throughId that is not the caller\'s own is one 400 at throughId, and marks nothing', async () => {
    const own = record();
    domain.own.set(own.id, own);
    const bodies: unknown[] = [];
    for (const throughId of [id(), 'not-a-uuid']) {
      try {
        await markAllReadFor(tx, { throughId });
      } catch (error) {
        // What the controller's AdminErrorFilter answers, for an AdminError and a ZodError alike.
        bodies.push(toAdminError(error as HttpException | ZodError).getResponse());
      }
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({ code: 'validation_failed', details: [{ path: 'throughId', code: 'invalid_value' }] });
    expect(domain.marked).toEqual([]);
    await markAllReadFor(tx, { throughId: own.id });
    expect(domain.marked).toEqual([{ throughId: own.id }]);
  });
});
