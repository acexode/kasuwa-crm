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
      { type: 'meeting', contactId: CONTACT },
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
