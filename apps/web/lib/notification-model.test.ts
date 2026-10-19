import { describe, expect, it } from 'vitest';
import { ACTOR_MARK, OBJECT_MARK, appendPage, dayKey, groupByDay, markAllCovered, previousDay, relativeDay, removeItem, sentenceKey, sentenceParts, sentenceVariant, setItemState, unreadIn } from './notification-model';
import type { NotificationItem } from './notifications-api';

function item(id: string, createdAt: string, extra: Partial<NotificationItem> = {}): NotificationItem {
  return { id, kind: 'record_assigned', objectType: 'contact', objectId: id, actorName: 'A', objectName: 'B', createdAt, readAt: null, ...extra };
}

describe('days are the reader’s local dates', () => {
  it('puts 23:30 UTC on the 17th on the 18th in Lagos and the 17th in UTC', () => {
    expect(dayKey('2026-10-17T23:30:00Z', 'Africa/Lagos')).toBe('2026-10-18');
    expect(dayKey('2026-10-17T23:30:00Z', 'UTC')).toBe('2026-10-17');
    expect(dayKey('2026-10-17T23:30:00Z', 'Pacific/Kiritimati')).toBe('2026-10-18');
  });

  it('knows yesterday by date arithmetic, across a month and a year', () => {
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2027-01-01')).toBe('2026-12-31');
    expect(relativeDay('2026-10-18', '2026-10-18')).toBe('today');
    expect(relativeDay('2026-10-17', '2026-10-18')).toBe('yesterday');
    expect(relativeDay('2026-10-10', '2026-10-18')).toBe('other');
  });

  it('groups in served order, one group per day', () => {
    const groups = groupByDay([item('a', '2026-10-18T09:00:00Z'), item('b', '2026-10-17T23:30:00Z'), item('c', '2026-10-17T12:00:00Z'), item('d', '2026-10-16T12:00:00Z')], 'Africa/Lagos');
    expect(groups.map((group) => [group.day, group.items.map((row) => row.id)])).toEqual([
      ['2026-10-18', ['a', 'b']],
      ['2026-10-17', ['c']],
      ['2026-10-16', ['d']],
    ]);
  });
});

describe('sentences', () => {
  it('chooses the variant from which names were served, never a stand-in', () => {
    expect(sentenceVariant({ actorName: 'A', objectName: 'B' })).toBe('both');
    expect(sentenceVariant({ actorName: 'A', objectName: null })).toBe('actor');
    expect(sentenceVariant({ actorName: null, objectName: 'B' })).toBe('object');
    expect(sentenceVariant({ actorName: null, objectName: null })).toBe('none');
    expect(sentenceVariant({ actorName: '', objectName: '' })).toBe('none');
  });

  it('has one key per kind and object type', () => {
    expect(sentenceKey('task_assigned', 'activity')).toBe('task_assigned.activity');
  });

  it('splits at the name marks wherever the translator put them', () => {
    expect(sentenceParts(`${ACTOR_MARK} assigned you ${OBJECT_MARK}.`)).toEqual([
      { kind: 'actor', text: '' },
      { kind: 'text', text: ' assigned you ' },
      { kind: 'object', text: '' },
      { kind: 'text', text: '.' },
    ]);
    expect(sentenceParts(`${OBJECT_MARK} ← ${ACTOR_MARK}`).map((part) => part.kind)).toEqual(['object', 'text', 'actor']);
    expect(sentenceParts('plain')).toEqual([{ kind: 'text', text: 'plain' }]);
  });
});

describe('what a write does to the drawn list', () => {
  const list = [item('a', '2026-10-18T09:00:00Z'), item('b', '2026-10-18T08:00:00Z', { kind: 'task_assigned', objectType: 'activity' }), item('c', '2026-10-18T07:00:00Z', { readAt: '2026-10-18T07:30:00Z' })];

  it('shows the server’s state for one item, and removes one', () => {
    expect(setItemState(list, 'a', '2026-10-18T10:00:00Z')[0]?.readAt).toBe('2026-10-18T10:00:00Z');
    expect(setItemState(list, 'c', null)[2]?.readAt).toBeNull();
    expect(removeItem(list, 'b').map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('marks all, or all of one kind, keeping a first readAt', () => {
    expect(markAllCovered(list, null, 'T', 'a').map((row) => row.readAt)).toEqual(['T', 'T', '2026-10-18T07:30:00Z']);
    expect(markAllCovered(list, 'task_assigned', 'T', 'a').map((row) => row.readAt)).toEqual([null, 'T', '2026-10-18T07:30:00Z']);
    expect(unreadIn(list, null)).toBe(2);
    expect(unreadIn(list, 'task_assigned')).toBe(1);
  });

  it('covers only what is at or older than the bound, by position (N3)', () => {
    expect(markAllCovered(list, null, 'T', 'b').map((row) => row.readAt)).toEqual([null, 'T', '2026-10-18T07:30:00Z']);
    // A bound that is no longer drawn was the newest: everything drawn is older.
    expect(markAllCovered(list, null, 'T', 'gone').map((row) => row.readAt)).toEqual(['T', 'T', '2026-10-18T07:30:00Z']);
  });

  it('appends in served order without drawing an id twice', () => {
    expect(appendPage(list, [list[2] as NotificationItem, item('d', '2026-10-17T00:00:00Z')]).map((row) => row.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
