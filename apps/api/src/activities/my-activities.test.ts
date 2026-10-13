import {
  activityFieldAccessFromObjectAccess,
  activityFieldApiName,
  decodeActivityCursor,
  encodeActivityCursor,
  InvalidCursorError,
  SECURED_ACTIVITY_FIELDS,
  type Activity,
  type ActivityFieldLevel,
  type MyActivityRow,
} from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { meetingTimeInferable, typeDetails } from './activities.service';
import { activityCreateChanges, activityUpdateChanges } from './activity-audit';
import { bucketRange, isIanaTimeZone, nextLocalMidnight } from './activity-buckets';
import { toActivityWire } from './activity-wire';
import { programmesReading, toMyActivityWire } from './my-activities';
import { ListCalendarQuery, ListMyActivitiesQuery } from './my-activities.schemas';

// Invented values only (CLAUDE.md 6.1).
const A1 = '11111111-0000-4000-8000-000000820a01';
const A2 = '11111111-0000-4000-8000-000000820a02';
const ID = '11111111-0000-4000-8000-000000820a03';
const CONTACT = '11111111-0000-4000-8000-000000820a04';
const ACCOUNT = '11111111-0000-4000-8000-000000820a05';
const SUBJECT = 'Probe subject names Mrs Probe';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const access = (
  overrides: Record<string, ActivityFieldLevel> = {},
  second: Record<string, ActivityFieldLevel> | null = null,
) => {
  const levels = (over: Record<string, ActivityFieldLevel>) =>
    new Map(
      SECURED_ACTIVITY_FIELDS.map(
        (field) => [activityFieldApiName(field), over[field] ?? 'edit'] as const,
      ),
    );
  const map = new Map([[A1, levels(overrides)]]);
  if (second !== null) map.set(A2, levels(second));
  return activityFieldAccessFromObjectAccess(map, second === null ? [A1] : [A1, A2]);
};

// ---------------------------------------------------------------------------

describe('isIanaTimeZone (T-0082)', () => {
  it('accepts canonical names, region links and UTC', () => {
    for (const zone of [
      'Africa/Lagos',
      'Africa/Johannesburg',
      'Africa/Nairobi',
      'Asia/Kolkata',
      'America/Los_Angeles',
      'America/Argentina/Buenos_Aires',
      'UTC',
    ]) {
      expect(isIanaTimeZone(zone), zone).toBe(true);
    }
  });

  it('refuses abbreviations, legacy ids, offsets, paths, whitespace, NUL, case and length', () => {
    for (const zone of [
      'WAT',
      'EAT',
      'EST',
      'CAT',
      'IST',
      'GMT',
      '+01:00',
      'UTC+1',
      'GMT+01:00',
      '../etc/passwd',
      'Africa/../../etc/passwd',
      'Africa/Lagoss',
      'Mars/Olympus_Mons',
      'Africa/Lagos ',
      ' Africa/Lagos',
      'Africa Lagos',
      'Africa/Lagos\u0000',
      'Africa/Lagos/Ikeja/Extra/Deep',
      'africa/lagos',
      'Africa/LAGOS',
      'AFRICA/LAGOS',
      'America/LOS_ANGELES',
      'SystemV/AST4',
      'SystemV/EST5EDT',
      `Africa/${'L'.repeat(70)}`,
      '',
    ]) {
      expect(isIanaTimeZone(zone), JSON.stringify(zone)).toBe(false);
    }
  });
});

describe('nextLocalMidnight (T-0082, D-L105)', () => {
  const noon = Date.UTC(2026, 9, 12, 12, 0, 0);

  it('is the next local midnight in WAT, SAST, EAT, IST and UTC', () => {
    expect(iso(nextLocalMidnight('Africa/Lagos', noon))).toBe('2026-10-12T23:00:00.000Z');
    expect(iso(nextLocalMidnight('Africa/Johannesburg', noon))).toBe('2026-10-12T22:00:00.000Z');
    expect(iso(nextLocalMidnight('Africa/Nairobi', noon))).toBe('2026-10-12T21:00:00.000Z');
    expect(iso(nextLocalMidnight('Asia/Kolkata', noon))).toBe('2026-10-12T18:30:00.000Z');
    expect(iso(nextLocalMidnight('UTC', noon))).toBe('2026-10-13T00:00:00.000Z');
  });

  it('is strictly after now: at midnight itself, the next one', () => {
    const lagos = Date.UTC(2026, 9, 12, 23, 0, 0);
    expect(nextLocalMidnight('Africa/Lagos', lagos - 1)).toBe(lagos);
    expect(nextLocalMidnight('Africa/Lagos', lagos)).toBe(lagos + DAY);
  });

  it('across DST: a 25-hour day when Los Angeles falls back, a 23-hour day when it springs forward', () => {
    // 2026-11-01: PDT -> PST.
    const fallStart = nextLocalMidnight('America/Los_Angeles', Date.UTC(2026, 10, 1, 6, 59, 59));
    expect(iso(fallStart)).toBe('2026-11-01T07:00:00.000Z');
    expect(nextLocalMidnight('America/Los_Angeles', fallStart) - fallStart).toBe(25 * HOUR);
    // 2026-03-08: PST -> PDT.
    const springStart = nextLocalMidnight('America/Los_Angeles', Date.UTC(2026, 2, 8, 7, 59, 59));
    expect(iso(springStart)).toBe('2026-03-08T08:00:00.000Z');
    expect(nextLocalMidnight('America/Los_Angeles', springStart) - springStart).toBe(23 * HOUR);
    // In the middle of the long day, "today" still ends at the next local midnight.
    expect(iso(nextLocalMidnight('America/Los_Angeles', Date.UTC(2026, 10, 1, 12)))).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  it('when the clocks jump over midnight, the next day starts at its first instant (01:00)', () => {
    // America/Havana springs forward at 00:00 -> 01:00 on 2026-03-08 (CST -> CDT).
    const evening = Date.UTC(2026, 2, 8, 3, 0, 0); // 22:00 CST on 2026-03-07
    const start = nextLocalMidnight('America/Havana', evening);
    expect(iso(start)).toBe('2026-03-08T05:00:00.000Z'); // 01:00 CDT
    const wall = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Havana',
      hourCycle: 'h23',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(start);
    expect(wall).toBe('08, 01:00');
    // One millisecond earlier it was still the 7th.
    expect(nextLocalMidnight('America/Havana', start - 1)).toBe(start);
  });
});

describe('bucketRange (T-0082, L1)', () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  const midnight = Date.UTC(2026, 9, 12, 23, 0, 0);

  it('splits time into disjoint buckets at now and the next local midnight', () => {
    expect(bucketRange('overdue', 'Africa/Lagos', now)).toEqual({
      from: null,
      to: new Date(now),
      undated: false,
    });
    expect(bucketRange('today', 'Africa/Lagos', now)).toEqual({
      from: new Date(now),
      to: new Date(midnight),
      undated: false,
    });
    expect(bucketRange('upcoming', 'Africa/Lagos', now)).toEqual({
      from: new Date(midnight),
      to: null,
      undated: true,
    });
  });

  it('today across the fall-back day in Los Angeles is 25 hours long', () => {
    const start = Date.UTC(2026, 10, 1, 7, 0, 0);
    const today = bucketRange('today', 'America/Los_Angeles', start);
    expect((today.to?.getTime() ?? 0) - (today.from?.getTime() ?? 0)).toBe(25 * HOUR);
  });
});

// ---------------------------------------------------------------------------

describe('query schemas (T-0082)', () => {
  const codes = (result: {
    success: boolean;
    error?: { issues: { path: (string | number)[]; code: string; params?: unknown }[] };
  }) =>
    result.success
      ? []
      : (result.error?.issues ?? []).map((issue) => {
          const reason =
            issue.code === 'custom'
              ? (issue.params as { reason?: string } | undefined)?.reason
              : issue.code;
          return `${issue.path.join('.')}:${String(reason)}`;
        });

  it('listMyActivities: invalid_time_zone at timeZone, whatever the value', () => {
    for (const timeZone of ['WAT', '', 'Mars/Olympus_Mons', 'Africa/Lagos\u0000']) {
      expect(codes(ListMyActivitiesQuery.safeParse({ timeZone, bucket: 'today' }))).toEqual([
        'timeZone:invalid_time_zone',
      ]);
    }
  });

  it('listMyActivities: bucket and limit are required and bounded; repeats are 400', () => {
    const ok = ListMyActivitiesQuery.safeParse({ timeZone: 'Africa/Lagos', bucket: 'upcoming' });
    expect(ok.success && ok.data.limit).toBe(25);
    for (const query of [
      { timeZone: 'Africa/Lagos' },
      { timeZone: 'Africa/Lagos', bucket: 'Today' },
      { timeZone: 'Africa/Lagos', bucket: ['today', 'overdue'] },
      { timeZone: ['Africa/Lagos', 'Africa/Nairobi'], bucket: 'today' },
      { timeZone: 'Africa/Lagos', bucket: 'today', limit: '0' },
      { timeZone: 'Africa/Lagos', bucket: 'today', limit: '101' },
      { timeZone: 'Africa/Lagos', bucket: 'today', limit: '1.5' },
      { timeZone: 'Africa/Lagos', bucket: 'today', limit: '' },
    ]) {
      expect(ListMyActivitiesQuery.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it('listCalendar: to after from, at most 42 days, never clamped', () => {
    const from = Date.UTC(2031, 2, 3);
    const window = (to: number) => ({ from: iso(from), to: iso(to) });
    expect(codes(ListCalendarQuery.safeParse(window(from + 42 * DAY)))).toEqual([]);
    expect(codes(ListCalendarQuery.safeParse(window(from)))).toEqual(['to:invalid_window']);
    expect(codes(ListCalendarQuery.safeParse(window(from - 1)))).toEqual(['to:invalid_window']);
    expect(codes(ListCalendarQuery.safeParse(window(from + 42 * DAY + 1)))).toEqual([
      'to:window_too_long',
    ]);
    for (const bad of ['2031-03-03', '2031-03-03T00:00:00+01:00', '0000-01-01T00:00:00.000Z']) {
      expect(ListCalendarQuery.safeParse({ from: bad, to: iso(from + DAY) }).success).toBe(false);
    }
  });
});

describe('activity cursors (T-0082, D-L80)', () => {
  it('carry one id and the list kind, and round-trip', () => {
    const cursor = encodeActivityCursor('tasks', ID);
    expect(decodeActivityCursor('tasks', cursor)).toBe(ID);
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    expect(JSON.parse(text)).toEqual({ k: 't', i: ID });
  });

  it('one error for every malformation, and for the other list’s cursor', () => {
    for (const bad of [
      'not-a-cursor',
      '!!!!',
      'abc\u0000',
      Buffer.from('{"id":1}').toString('base64url'),
      ID,
      'A'.repeat(513),
      '',
      Buffer.from(JSON.stringify({ k: 't', i: ID, extra: 1 })).toString('base64url'),
      encodeActivityCursor('calendar', ID),
    ]) {
      expect(() => decodeActivityCursor('tasks', bad), JSON.stringify(bad)).toThrow(
        InvalidCursorError,
      );
    }
  });
});

// ---------------------------------------------------------------------------

const row: MyActivityRow = {
  id: ID,
  programmeId: A1,
  type: 'task',
  subject: SUBJECT,
  dueAt: new Date('2031-03-03T09:00:00.000Z'),
  completedAt: null,
  startsAt: null,
  endsAt: null,
  contactId: CONTACT,
  contactDisplayName: 'Probe Person',
  accountId: ACCOUNT,
  accountName: 'Probe Traders',
  version: 4,
};

describe('toMyActivityWire (T-0082, L3)', () => {
  it('is exactly the MyActivity keys: summaries, no body, no owner', () => {
    const wire = toMyActivityWire(row, access());
    expect(wire).toEqual({
      id: ID,
      programmeId: A1,
      type: 'task',
      subject: SUBJECT,
      dueAt: '2031-03-03T09:00:00.000Z',
      completedAt: null,
      startsAt: null,
      endsAt: null,
      contact: { id: CONTACT, displayName: 'Probe Person' },
      account: { id: ACCOUNT, name: 'Probe Traders' },
      version: 4,
      withheldFields: [],
    });
    expect(Object.keys(wire).at(-1)).toBe('withheldFields');
  });

  it('a missing link is null, not withheld', () => {
    const wire = toMyActivityWire(
      { ...row, contactId: null, contactDisplayName: null, accountId: null, accountName: null },
      access(),
    );
    expect(wire).toMatchObject({ contact: null, account: null, withheldFields: [] });
  });

  it('omits and names withheld fields; contact follows contactId, account accountId', () => {
    const wire = toMyActivityWire(
      row,
      access({ subject: 'none', contactId: 'none', accountId: 'none', completedAt: 'none' }),
    );
    for (const key of ['subject', 'contact', 'account', 'completedAt']) {
      expect(key in wire, key).toBe(false);
    }
    expect(wire.withheldFields).toEqual(['subject', 'completedAt', 'contact', 'account']);
    expect(JSON.stringify(wire)).not.toContain('Probe');
  });

  it('is judged in the activity’s own programme', () => {
    const both = access({}, { subject: 'none' });
    expect(toMyActivityWire({ ...row, programmeId: A2 }, both).withheldFields).toEqual(['subject']);
    expect(toMyActivityWire(row, both).withheldFields).toEqual([]);
  });
});

describe('programmesReading (T-0082, L3)', () => {
  it('keeps only the programmes where every named time is readable', () => {
    const matrix = access({ dueAt: 'none' }, { endsAt: 'none' });
    expect(programmesReading(matrix, [A1, A2], ['dueAt'])).toEqual([A2]);
    expect(programmesReading(matrix, [A1, A2], ['startsAt', 'endsAt'])).toEqual([A1]);
    expect(programmesReading(access({ dueAt: 'read' }), [A1], ['dueAt'])).toEqual([A1]);
    // Fails closed: a programme the matrix does not carry reads nothing.
    expect(programmesReading(access(), [A2], ['dueAt'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('typeDetails: the rules judged on the stored row (T-0082, W2)', () => {
  const START = Date.UTC(2031, 2, 3, 9);
  const meeting = {
    type: 'meeting' as const,
    startsAt: new Date(START),
    endsAt: new Date(START + HOUR),
  };
  const task = { type: 'task' as const, startsAt: null, endsAt: null };
  const at = (current: Pick<Activity, 'type' | 'startsAt' | 'endsAt'>, body: object) =>
    typeDetails(current, body).map((detail) => `${detail.path}:${detail.code}`);

  it('dueAt and completing are a task’s; times are a meeting’s', () => {
    expect(at(task, { dueAt: iso(START) })).toEqual([]);
    expect(at(task, { dueAt: null, completed: true })).toEqual([]);
    expect(at(meeting, { dueAt: null })).toEqual(['dueAt:task_only']);
    expect(at(meeting, { completed: true })).toEqual(['completed:task_only']);
    for (const type of ['task', 'note', 'call'] as const) {
      const current = { type, startsAt: null, endsAt: null };
      expect(at(current, { startsAt: iso(START) })).toEqual(['startsAt:meeting_only']);
      expect(at(current, { endsAt: iso(START) })).toEqual(['endsAt:meeting_only']);
    }
  });

  it('a meeting’s span is judged on the result, at the field sent', () => {
    expect(at(meeting, { endsAt: iso(START + 2 * HOUR) })).toEqual([]);
    expect(at(meeting, { startsAt: iso(START + 30 * 60 * 1000) })).toEqual([]);
    expect(at(meeting, { startsAt: iso(START + HOUR) })).toEqual(['startsAt:invalid_range']);
    expect(at(meeting, { endsAt: iso(START) })).toEqual(['endsAt:invalid_range']);
    expect(at(meeting, { endsAt: iso(START + DAY + 1) })).toEqual(['endsAt:too_long']);
    expect(at(meeting, { startsAt: iso(START + HOUR - DAY - 1) })).toEqual(['startsAt:too_long']);
    expect(at(meeting, { endsAt: iso(START + DAY) })).toEqual([]);
    // Both sent: judged at endsAt; each alone would fail against the stored other.
    expect(at(meeting, { startsAt: iso(START + 3 * DAY), endsAt: iso(START + 3 * DAY + HOUR) })).toEqual(
      [],
    );
    expect(at(meeting, { startsAt: iso(START), endsAt: iso(START - 1) })).toEqual([
      'endsAt:invalid_range',
    ]);
  });
});

describe('the audit and the Activity for meetings (T-0082, W3)', () => {
  const base: Activity = {
    id: ID,
    programmeId: A1,
    type: 'meeting',
    subject: SUBJECT,
    body: null,
    dueAt: null,
    completedAt: null,
    startsAt: new Date('2031-03-03T09:00:00.000Z'),
    endsAt: new Date('2031-03-03T10:00:00.000Z'),
    ownerUserId: null,
    contactId: CONTACT,
    accountId: null,
    dealId: null,
    createdByUserId: null,
    version: 1,
    createdAt: new Date('2026-10-01T09:00:00.000Z'),
    updatedAt: new Date('2026-10-01T09:00:00.000Z'),
  };

  it('names exactly the times whose value changed, never a value', () => {
    const resized = { ...base, endsAt: new Date('2031-03-03T11:00:00.000Z') };
    expect(activityUpdateChanges(base, resized)).toEqual([
      { field: 'endsAt', before: null, after: null, redacted: true },
    ]);
    const same = { ...base, startsAt: new Date(base.startsAt?.getTime() ?? 0) };
    expect(activityUpdateChanges(base, same)).toEqual([]);
    const dragged = {
      ...base,
      startsAt: new Date('2031-03-04T09:00:00.000Z'),
      endsAt: new Date('2031-03-04T10:00:00.000Z'),
    };
    const changes = activityUpdateChanges(base, dragged);
    expect(changes.map((change) => change.field)).toEqual(['startsAt', 'endsAt']);
    expect(JSON.stringify(changes)).not.toContain('2031');
    const task = { ...base, type: 'task' as const, startsAt: null, endsAt: null, dueAt: null };
    expect(
      activityUpdateChanges(task, { ...task, dueAt: new Date('2031-03-03T09:00:00.000Z') }).map(
        (change) => change.field,
      ),
    ).toEqual(['dueAt']);
  });

  it('a meeting create names startsAt and endsAt', () => {
    const changes = activityCreateChanges({
      type: 'meeting',
      contactId: CONTACT,
      startsAt: '2031-03-03T09:00:00.000Z',
      endsAt: '2031-03-03T10:00:00.000Z',
    });
    expect(changes.map((change) => change.field)).toEqual([
      'type',
      'startsAt',
      'endsAt',
      'contactId',
    ]);
    expect(JSON.stringify(changes)).not.toContain('2031');
  });

  it('the Activity carries both times, omits a withheld one and names it', () => {
    expect(toActivityWire(base, access())).toMatchObject({
      dueAt: null,
      startsAt: '2031-03-03T09:00:00.000Z',
      endsAt: '2031-03-03T10:00:00.000Z',
    });
    const wire = toActivityWire(base, access({ startsAt: 'none' }));
    expect('startsAt' in wire).toBe(false);
    expect(wire.withheldFields).toEqual(['startsAt']);
  });
});

describe('meetingTimeInferable: D-L110 (T-0082 security review M1)', () => {
  it('a time write needs at least read on the other time, in the activity’s programme', () => {
    expect(meetingTimeInferable(access(), A1, 'endsAt')).toBe(false);
    expect(meetingTimeInferable(access({ startsAt: 'read' }), A1, 'endsAt')).toBe(false);
    expect(meetingTimeInferable(access({ startsAt: 'none' }), A1, 'endsAt')).toBe(true);
    expect(meetingTimeInferable(access({ endsAt: 'none' }), A1, 'startsAt')).toBe(true);
    // Only the OTHER time counts, and only for the two meeting times.
    expect(meetingTimeInferable(access({ startsAt: 'none' }), A1, 'startsAt')).toBe(false);
    expect(meetingTimeInferable(access({ startsAt: 'none' }), A1, 'dueAt')).toBe(false);
    // Judged in the activity's own programme; an unknown one fails closed.
    expect(meetingTimeInferable(access({}, { startsAt: 'none' }), A2, 'endsAt')).toBe(true);
    expect(meetingTimeInferable(access({}, { startsAt: 'none' }), A1, 'endsAt')).toBe(false);
    expect(meetingTimeInferable(access(), A2, 'endsAt')).toBe(true);
  });
});
