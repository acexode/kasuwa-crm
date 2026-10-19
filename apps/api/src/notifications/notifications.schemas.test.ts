import { describe, expect, it } from 'vitest';
import {
  ListNotificationsQuery,
  MarkAllNotificationsReadBody,
  NotificationIdParam,
  UpdateNotificationBody,
} from './notifications.schemas';
import { toDetails } from '../admin/common/admin-errors';
import { ZodError } from 'zod';

const ID = '12000000-0000-4000-8000-000000000001';

function details(run: () => unknown): { path: string; code: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof ZodError) return error.issues.flatMap(toDetails);
    throw error;
  }
  return [];
}

describe('ListNotificationsQuery', () => {
  it('defaults to all, no kind, no cursor and 25 a page', () => {
    expect(ListNotificationsQuery.parse({})).toEqual({
      filter: 'all',
      kind: undefined,
      cursor: undefined,
      limit: 25,
    });
  });

  it('accepts every contract value and lower-cases the cursor', () => {
    expect(
      ListNotificationsQuery.parse({ filter: 'unread', kind: 'import_finished', cursor: ID.toUpperCase(), limit: '100' }),
    ).toEqual({ filter: 'unread', kind: 'import_finished', cursor: ID, limit: 100 });
  });

  it('ignores an unknown parameter, never honouring it', () => {
    expect(ListNotificationsQuery.parse({ programmeIds: '{x}' })).toMatchObject({ filter: 'all' });
  });

  it.each([
    [{ cursor: '%%%not-a-cursor%%%' }, 'cursor', 'invalid_cursor'],
    [{ cursor: '' }, 'cursor', 'invalid_cursor'],
    [{ cursor: ['a', 'b'] }, 'cursor', 'invalid_cursor'],
    [{ kind: 'mention' }, 'kind', 'invalid_value'],
    [{ kind: ['record_assigned', 'task_assigned'] }, 'kind', 'invalid_value'],
    [{ filter: 'starred' }, 'filter', 'invalid_value'],
    [{ limit: 'ten' }, 'limit', 'invalid_value'],
    [{ limit: '0' }, 'limit', 'out_of_range'],
    [{ limit: '101' }, 'limit', 'out_of_range'],
  ])('%j names %s with %s, never the value', (query, path, code) => {
    const found = details(() => ListNotificationsQuery.parse(query));
    expect(found).toEqual([{ path, code }]);
    expect(JSON.stringify(found)).not.toContain('mention');
  });
});

describe('UpdateNotificationBody and NotificationIdParam', () => {
  it('is exactly { read: boolean }', () => {
    expect(UpdateNotificationBody.parse({ read: false })).toEqual({ read: false });
    for (const body of [{ read: 'yes' }, {}, { read: true, recipientUserId: ID }, { read: true, readAt: '2026-01-01T00:00:00Z' }, null, []]) {
      expect(UpdateNotificationBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('a path id that is not a uuid is a 400 at notificationId', () => {
    expect(NotificationIdParam.parse({ notificationId: ID })).toEqual({ notificationId: ID });
    expect(details(() => NotificationIdParam.parse({ notificationId: 'not-a-uuid' }))[0]?.path).toBe('notificationId');
  });
});

describe('MarkAllNotificationsReadBody', () => {
  it('takes {}, a kind, a throughId or both', () => {
    expect(MarkAllNotificationsReadBody.parse({})).toEqual({ kind: undefined, throughId: undefined });
    expect(MarkAllNotificationsReadBody.parse({ kind: 'task_assigned', throughId: ID })).toEqual({
      kind: 'task_assigned',
      throughId: ID,
    });
  });

  it('a throughId that is not a uuid is invalid_value at throughId, as for one that names nothing', () => {
    expect(details(() => MarkAllNotificationsReadBody.parse({ throughId: 'not-a-uuid' }))).toEqual([
      { path: 'throughId', code: 'invalid_value' },
    ]);
  });

  it('is closed, and the body is required to be an object', () => {
    expect(details(() => MarkAllNotificationsReadBody.parse({ recipientUserId: ID }))).toEqual([
      { path: 'recipientUserId', code: 'unrecognized_keys' },
    ]);
    expect(MarkAllNotificationsReadBody.safeParse(undefined).success).toBe(false);
    expect(MarkAllNotificationsReadBody.safeParse([]).success).toBe(false);
  });
});
