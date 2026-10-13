import { describe, expect, it } from 'vitest';
import type { MyActivity } from '../../lib/activities-api';
import {
  DAY_MS,
  LOADING_BUCKET,
  MAX_WINDOW_DAYS,
  bucketAppended,
  bucketFailed,
  bucketLoaded,
  dayKey,
  leadingBlanks,
  localToUtc,
  meetingRule,
  placeEvents,
  rebaseTimes,
  rescheduleBody,
  shiftView,
  snoozeOptions,
  tasksView,
  timeForm,
  toLocalInput,
  versionOf,
  weekStart,
  windowOf,
  wireWindow,
  withVersion,
} from './activities-model';

/**
 * The pure half of P07. Every date here is built with the LOCAL Date
 * constructor and every expectation is stated in local terms, so the suite
 * holds in whatever zone the machine running it is in — exactly as the screen
 * must hold in whatever zone its browser is in.
 */

let n = 0;
function item(overrides: Partial<MyActivity> = {}): MyActivity {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    programmeId: '00000000-0000-4000-8000-0000000000aa',
    type: 'task',
    subject: 'Call back',
    dueAt: null,
    completedAt: null,
    startsAt: null,
    endsAt: null,
    contact: null,
    account: null,
    version: 1,
    withheldFields: [],
    ...overrides,
  };
}

function local(y: number, m: number, d: number, h = 0, mi = 0): Date {
  return new Date(y, m - 1, d, h, mi);
}

describe('buckets', () => {
  it('is loading until a bucket answers, caught up only when all three read and are empty', () => {
    const empty = bucketLoaded({ data: [], nextCursor: null });
    const failed = bucketFailed(LOADING_BUCKET, { code: 'network' });
    expect(tasksView({ overdue: LOADING_BUCKET, today: LOADING_BUCKET, upcoming: LOADING_BUCKET })).toBe('loading');
    expect(tasksView({ overdue: empty, today: empty, upcoming: empty })).toBe('caught-up');
    // A failed bucket is never "nothing due".
    expect(tasksView({ overdue: empty, today: failed, upcoming: empty })).toBe('buckets');
    expect(tasksView({ overdue: empty, today: LOADING_BUCKET, upcoming: empty })).toBe('buckets');
  });

  it('pages in served order, never repeating a row, and keeps the cursor it was served', () => {
    const [a, b, c] = [item(), item(), item()];
    const first = bucketLoaded({ data: [a, b], nextCursor: 'c1' });
    expect(first.cursor).toBe('c1');
    const second = bucketAppended(first, { data: [b, c], nextCursor: null });
    expect(second.rows.map((row) => row.id)).toEqual([a.id, b.id, c.id]);
    expect(second.cursor).toBeNull();
  });

  it('a failed re-read keeps the rows already drawn; a failed first read is an error', () => {
    const ready = bucketLoaded({ data: [item()], nextCursor: null });
    expect(bucketFailed(ready, { code: 'network' })).toBe(ready);
    expect(bucketFailed(LOADING_BUCKET, { code: 'network' })).toMatchObject({ phase: 'error', rows: [] });
  });
});

describe('the calendar window, in the browser’s zone', () => {
  it('a week is seven local days from Monday’s midnight, and contains the day it was asked for', () => {
    for (const anchor of [local(2026, 9, 30, 23, 30), local(2026, 10, 4, 12), local(2026, 9, 28)]) {
      const window = windowOf({ range: 'week', anchor });
      expect(window.from.getDay()).toBe(1);
      expect([window.from.getHours(), window.from.getMinutes()]).toEqual([0, 0]);
      expect(window.days).toHaveLength(7);
      expect(window.to.getTime()).toBe(local(window.from.getFullYear(), window.from.getMonth() + 1, window.from.getDate() + 7).getTime());
      expect(window.from.getTime() <= anchor.getTime() && anchor.getTime() < window.to.getTime()).toBe(true);
    }
    expect(dayKey(weekStart(local(2026, 9, 30, 23, 30)))).toBe('2026-09-28');
  });

  it('a month is its own days, first midnight to the next month’s, never over 42 days', () => {
    const september = windowOf({ range: 'month', anchor: local(2026, 9, 30, 23, 30) });
    expect(dayKey(september.from)).toBe('2026-09-01');
    expect(september.from.getTime()).toBe(local(2026, 9, 1).getTime());
    expect(september.to.getTime()).toBe(local(2026, 10, 1).getTime());
    expect(september.days.map(dayKey)).toHaveLength(30);
    expect(september.days.at(-1) && dayKey(september.days.at(-1) as Date)).toBe('2026-09-30');
    for (let month = 1; month <= 12; month += 1) {
      const window = windowOf({ range: 'month', anchor: local(2027, month, 15) });
      expect(window.to.getTime() - window.from.getTime()).toBeLessThanOrEqual(MAX_WINDOW_DAYS * DAY_MS);
    }
  });

  it('goes on the wire as UTC with a Z, and a window over 42 days is never sent', () => {
    const window = windowOf({ range: 'week', anchor: local(2026, 9, 30) });
    const wire = wireWindow(window);
    expect(wire?.from).toMatch(/Z$/);
    expect(wire?.to).toMatch(/Z$/);
    expect(Date.parse(wire?.from ?? '')).toBe(window.from.getTime());
    expect(wireWindow({ from: local(2026, 1, 1), to: local(2026, 2, 13), days: [] })).toBeNull();
    expect(wireWindow({ from: local(2026, 1, 1), to: local(2026, 1, 1), days: [] })).toBeNull();
  });

  it('pages a month to the first of the next or previous, so the 31st never skips a month', () => {
    const next = shiftView({ range: 'month', anchor: local(2027, 1, 31) }, 1);
    expect(dayKey(next.anchor)).toBe('2027-02-01');
    const previous = shiftView({ range: 'month', anchor: local(2026, 9, 1) }, -1);
    expect(dayKey(windowOf(previous).from)).toBe('2026-08-01');
    const week = shiftView({ range: 'week', anchor: local(2026, 9, 30) }, 1);
    expect(dayKey(windowOf(week).from)).toBe('2026-10-05');
  });

  it('pads a month so its first day sits under its weekday (Monday first)', () => {
    // 1 September 2026 is a Tuesday; 1 June 2026 a Monday.
    expect(leadingBlanks(windowOf({ range: 'month', anchor: local(2026, 9, 10) }))).toBe(1);
    expect(leadingBlanks(windowOf({ range: 'month', anchor: local(2026, 6, 10) }))).toBe(0);
  });

  it('puts each event on the local day it starts, one that began earlier on the first day, and a withheld time nowhere', () => {
    const window = windowOf({ range: 'week', anchor: local(2026, 9, 30) });
    const late = item({ type: 'meeting', startsAt: local(2026, 9, 30, 23, 30).toISOString(), endsAt: local(2026, 10, 1, 0, 30).toISOString() });
    const earlier = item({ type: 'meeting', startsAt: local(2026, 9, 27, 21).toISOString(), endsAt: local(2026, 9, 28, 3).toISOString() });
    const task = item({ dueAt: local(2026, 10, 2, 9).toISOString() });
    const hiddenDue = item({ dueAt: local(2026, 10, 2, 9).toISOString(), withheldFields: ['dueAt'] });
    const hiddenTimes = item({ type: 'meeting', withheldFields: ['startsAt', 'endsAt'] });
    const undated = item();
    const byDay = placeEvents([late, earlier, task, hiddenDue, hiddenTimes, undated], window);
    expect(byDay.get('2026-09-30')?.map((entry) => entry.id)).toEqual([late.id]);
    expect(byDay.get('2026-09-28')?.map((entry) => entry.id)).toEqual([earlier.id]);
    expect(byDay.get('2026-10-02')?.map((entry) => entry.id)).toEqual([task.id]);
    const placed = [...byDay.values()].flat().map((entry) => entry.id);
    expect(placed).not.toContain(hiddenDue.id);
    expect(placed).not.toContain(hiddenTimes.id);
    expect(placed).not.toContain(undated.id);
  });
});

describe('snooze presets', () => {
  it('offers only later times, tomorrow and next Monday at 09:00 local, and never the task’s own time', () => {
    const now = local(2026, 9, 30, 23, 30);
    const options = snoozeOptions(now, null);
    expect(options.map((option) => option.preset)).toEqual(['hour', 'tomorrow', 'nextWeek']);
    for (const option of options) expect(option.at.getTime()).toBeGreaterThan(now.getTime());
    const tomorrow = options.find((option) => option.preset === 'tomorrow')?.at as Date;
    expect([dayKey(tomorrow), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual(['2026-10-01', 9, 0]);
    const monday = options.find((option) => option.preset === 'nextWeek')?.at as Date;
    expect([dayKey(monday), monday.getDay(), monday.getHours()]).toEqual(['2026-10-05', 1, 9]);
    // Already due tomorrow at 09:00: that preset would send an unchanged time.
    expect(snoozeOptions(now, tomorrow.toISOString()).map((option) => option.preset)).toEqual(['hour', 'nextWeek']);
  });
});

describe('meeting times, checked before anything is sent', () => {
  const at = (h: number, mi = 0, d = 2) => local(2026, 10, d, h, mi).toISOString();
  it('needs both times, an end after the start, and at most 24 hours', () => {
    expect(meetingRule(at(14), null)).toBe('required');
    expect(meetingRule(null, at(15))).toBe('required');
    expect(meetingRule(at(14), at(14))).toBe('invalid_range');
    expect(meetingRule(at(14), at(13))).toBe('invalid_range');
    expect(meetingRule(at(14), at(14, 0, 3))).toBeNull();
    expect(meetingRule(at(14), at(14, 1, 3))).toBe('too_long');
    expect(meetingRule(at(14), at(15))).toBeNull();
  });
});

describe('rescheduling: version plus only what changed (D-L102)', () => {
  const meeting = item({
    type: 'meeting',
    startsAt: local(2026, 10, 2, 10).toISOString(),
    endsAt: local(2026, 10, 2, 11).toISOString(),
    version: 2,
  });

  it('prefills the served times as the browser’s wall clock, and reads them back exactly', () => {
    const form = timeForm(meeting);
    expect(form).toEqual({ startsAt: '2026-10-02T10:00', endsAt: '2026-10-02T11:00' });
    expect(localToUtc(form.startsAt ?? '')).toBe(meeting.startsAt);
    expect(toLocalInput(null)).toBe('');
    expect(timeForm(item({ dueAt: '2026-10-02T09:00:00.000Z', withheldFields: ['dueAt'] }))).toEqual({ dueAt: '' });
  });

  it('a resize sends only the end; a move sends both; nothing changed sends nothing', () => {
    const seed = timeForm(meeting);
    expect(rescheduleBody('meeting', 2, seed, seed)).toEqual({ kind: 'unchanged' });
    expect(rescheduleBody('meeting', 2, seed, { ...seed, endsAt: '2026-10-02T11:30' })).toEqual({
      kind: 'send',
      body: { version: 2, endsAt: local(2026, 10, 2, 11, 30).toISOString() },
    });
    const moved = rescheduleBody('meeting', 2, seed, { startsAt: '2026-10-02T13:00', endsAt: '2026-10-02T14:30' });
    expect(moved.kind === 'send' && Object.keys(moved.body).sort()).toEqual(['endsAt', 'startsAt', 'version']);
  });

  it('judges a meeting on the result, so a bad move is a message and never a request', () => {
    const seed = timeForm(meeting);
    expect(rescheduleBody('meeting', 2, seed, { ...seed, endsAt: '2026-10-02T09:00' })).toEqual({
      kind: 'invalid',
      field: 'endsAt',
      message: 'activities.meeting.error.invalid_range',
    });
    expect(rescheduleBody('meeting', 2, seed, { ...seed, endsAt: '2026-10-03T10:01' })).toMatchObject({
      kind: 'invalid',
      message: 'activities.meeting.error.too_long',
    });
    expect(rescheduleBody('task', 1, { dueAt: '2026-10-02T09:00' }, { dueAt: '' })).toMatchObject({
      kind: 'invalid',
      field: 'dueAt',
      message: 'activities.reschedule.error.dueRequired',
    });
  });

  it('after a 409, an untouched field takes the fresh value and is never sent', () => {
    const seed = timeForm(meeting);
    const typed = { ...seed, endsAt: '2026-10-02T11:30' };
    const fresh = { startsAt: '2026-10-02T09:30', endsAt: '2026-10-02T11:00' };
    const rebased = rebaseTimes(seed, typed, fresh, ['startsAt', 'endsAt']);
    expect(rebased.typed).toEqual({ startsAt: '2026-10-02T09:30', endsAt: '2026-10-02T11:30' });
    expect(rebased.conflicts).toEqual([]);
    const body = rescheduleBody('meeting', 3, rebased.seed, rebased.typed);
    expect(body.kind === 'send' && Object.keys(body.body).sort()).toEqual(['endsAt', 'version']);
    // A second 409 in a row: still only the end.
    const again = rebaseTimes(rebased.seed, rebased.typed, { startsAt: '2026-10-02T09:00', endsAt: '2026-10-02T11:00' }, ['startsAt', 'endsAt']);
    const second = rescheduleBody('meeting', 4, again.seed, again.typed);
    expect(second).toEqual({ kind: 'send', body: { version: 4, endsAt: local(2026, 10, 2, 11, 30).toISOString() } });
  });

  it('a field both people changed keeps what was typed and is flagged', () => {
    const seed = timeForm(meeting);
    const typed = { ...seed, endsAt: '2026-10-02T11:30' };
    const rebased = rebaseTimes(seed, typed, { startsAt: '2026-10-02T10:00', endsAt: '2026-10-02T11:15' }, ['startsAt', 'endsAt']);
    expect(rebased.typed.endsAt).toBe('2026-10-02T11:30');
    expect(rebased.conflicts).toEqual(['endsAt']);
  });

  it('never winds a version back, and writes with the newest one seen', () => {
    const known = withVersion(withVersion({}, meeting.id, 3), meeting.id, 2);
    expect(known[meeting.id]).toBe(3);
    expect(versionOf(meeting, known)).toBe(3);
    expect(versionOf({ ...meeting, version: 5 }, known)).toBe(5);
  });
});
