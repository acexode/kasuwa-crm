import { describe, expect, it } from 'vitest';
import { CreateActivityBody, UpdateActivityBody } from './activities.schemas';

// Invented ids (CLAUDE.md 6.1).
const CONTACT = '11111111-0000-4000-8000-0000006100f1';
const ACCOUNT = '11111111-0000-4000-8000-0000006100f2';

function reasons(result: { success: boolean; error?: { issues: unknown[] } }): unknown[] {
  if (result.success) return [];
  return (result.error?.issues ?? []).map((issue) => {
    const value = issue as { code: string; params?: { reason?: unknown }; keys?: string[] };
    return value.code === 'custom' ? value.params?.reason : value.code;
  });
}

describe('CreateActivityBody (T-0061)', () => {
  it('accepts a note on a contact, a task on an account, and both targets', () => {
    expect(CreateActivityBody.safeParse({ type: 'note', contactId: CONTACT }).success).toBe(true);
    expect(
      CreateActivityBody.safeParse({
        type: 'task',
        accountId: ACCOUNT,
        dueAt: '2026-12-01T09:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      CreateActivityBody.safeParse({ type: 'call', contactId: CONTACT, accountId: ACCOUNT })
        .success,
    ).toBe(true);
  });

  it('needs a target', () => {
    expect(reasons(CreateActivityBody.safeParse({ type: 'note' }))).toEqual(['target_required']);
    expect(
      reasons(CreateActivityBody.safeParse({ type: 'note', contactId: null, accountId: null })),
    ).toEqual(['target_required']);
  });

  it('allows a due time on a task only', () => {
    for (const type of ['note', 'call']) {
      expect(
        reasons(
          CreateActivityBody.safeParse({
            type,
            contactId: CONTACT,
            dueAt: '2026-12-01T09:00:00.000Z',
          }),
        ),
      ).toEqual(['task_only']);
    }
  });

  it.each([
    ['id', { id: CONTACT }],
    ['programmeId', { programmeId: CONTACT }],
    ['tenantId', { tenantId: CONTACT }],
    ['createdByUserId', { createdByUserId: CONTACT }],
    ['createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }],
    ['updatedAt', { updatedAt: '2020-01-01T00:00:00.000Z' }],
    ['completedAt', { completedAt: '2020-01-01T00:00:00.000Z' }],
    ['version', { version: 1 }],
    ['withheldFields', { withheldFields: [] }],
  ])('refuses a server-owned %s', (_label, extra) => {
    expect(
      CreateActivityBody.safeParse({ type: 'note', contactId: CONTACT, ...extra }).success,
    ).toBe(false);
  });

  it('refuses a NUL in the subject or body, an unknown type and a non-date due time', () => {
    for (const body of [
      { type: 'note', contactId: CONTACT, subject: 'Call\u0000back' },
      { type: 'note', contactId: CONTACT, body: 'x\u0000' },
      { type: 'email', contactId: CONTACT },
      { type: 'task', contactId: CONTACT, dueAt: 'tomorrow' },
      { type: 'task', contactId: CONTACT, dueAt: '2026-02-30T09:00:00.000Z' },
      // Year 0 passes Zod and the round trip, and Postgres refuses it (22008).
      { type: 'task', contactId: CONTACT, dueAt: '0000-01-01T00:00:00Z' },
      { type: 'task', contactId: CONTACT, dueAt: '1969-12-31T23:59:59Z' },
    ]) {
      expect(CreateActivityBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('UpdateActivityBody (T-0061, D-L81)', () => {
  it('takes version plus completed: true and/or an owner', () => {
    expect(UpdateActivityBody.safeParse({ version: 1, completed: true }).success).toBe(true);
    expect(UpdateActivityBody.safeParse({ version: 1, ownerUserId: CONTACT }).success).toBe(true);
    expect(UpdateActivityBody.safeParse({ version: 1, ownerUserId: null }).success).toBe(true);
  });

  it('needs a version and a change, and does not reopen', () => {
    expect(UpdateActivityBody.safeParse({ completed: true }).success).toBe(false);
    expect(reasons(UpdateActivityBody.safeParse({ version: 1 }))).toEqual(['nothing_to_update']);
    expect(UpdateActivityBody.safeParse({ version: 1, completed: false }).success).toBe(false);
    expect(UpdateActivityBody.safeParse({ version: 2 ** 31, completed: true }).success).toBe(false);
  });

  it.each(['contactId', 'accountId', 'programmeId', 'createdByUserId', 'completedAt', 'id'])(
    'refuses %s: no retarget, no move, nothing server-owned',
    (key) => {
      expect(
        UpdateActivityBody.safeParse({ version: 1, completed: true, [key]: CONTACT }).success,
      ).toBe(false);
    },
  );
});

describe('meetings on create (T-0082, W1)', () => {
  const START = '2031-03-03T09:00:00.000Z';
  const meeting = (extra: Record<string, unknown> = {}) => ({
    type: 'meeting',
    contactId: CONTACT,
    startsAt: START,
    endsAt: '2031-03-03T10:00:00.000Z',
    ...extra,
  });
  const details = (body: unknown) => {
    const result = CreateActivityBody.safeParse(body);
    return result.success
      ? []
      : result.error.issues.map(
          (issue) =>
            `${issue.path.join('.')}:${String(issue.code === 'custom' ? issue.params?.['reason'] : issue.code)}`,
        );
  };

  it('accepts a meeting with both times, up to exactly 24 hours', () => {
    expect(details(meeting())).toEqual([]);
    expect(details(meeting({ endsAt: '2031-03-04T09:00:00.000Z' }))).toEqual([]);
  });

  it('requires both times, end after start, at most 24 hours, all at their own path', () => {
    expect(details(meeting({ startsAt: undefined, endsAt: undefined }))).toEqual([
      'startsAt:required',
      'endsAt:required',
    ]);
    expect(details(meeting({ endsAt: START }))).toEqual(['endsAt:invalid_range']);
    expect(details(meeting({ endsAt: '2031-03-03T08:59:59.999Z' }))).toEqual([
      'endsAt:invalid_range',
    ]);
    expect(details(meeting({ endsAt: '2031-03-04T09:00:00.001Z' }))).toEqual(['endsAt:too_long']);
    expect(details(meeting({ dueAt: START }))).toEqual(['dueAt:task_only']);
  });

  it('refuses a null time, an offset and an impossible date', () => {
    for (const extra of [
      { startsAt: null },
      { endsAt: null },
      { startsAt: '2031-03-03T09:00:00+01:00' },
      { endsAt: '2031-02-30T10:00:00.000Z' },
    ]) {
      expect(CreateActivityBody.safeParse(meeting(extra)).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
  });

  it.each(['note', 'task', 'call'])('a time on a %s is meeting_only at that field', (type) => {
    for (const field of ['startsAt', 'endsAt']) {
      expect(details({ type, contactId: CONTACT, [field]: START })).toEqual([
        `${field}:meeting_only`,
      ]);
    }
  });
});

describe('UpdateActivityBody: snooze and reschedule (T-0082, W2)', () => {
  it('takes dueAt (nullable), startsAt and endsAt (never null)', () => {
    for (const body of [
      { version: 1, dueAt: '2031-03-03T09:00:00.000Z' },
      { version: 1, dueAt: null },
      { version: 1, startsAt: '2031-03-03T09:00:00.000Z' },
      { version: 1, endsAt: '2031-03-03T09:00:00.000Z' },
    ]) {
      expect(UpdateActivityBody.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
    for (const body of [
      { version: 1, startsAt: null },
      { version: 1, endsAt: null },
      { version: 1, dueAt: '2031-03-03T09:00:00+01:00' },
    ]) {
      expect(UpdateActivityBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
