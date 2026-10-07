import {
  accountFieldApiName,
  activityFieldAccessFromObjectAccess,
  activityFieldApiName,
  SECURED_ACTIVITY_FIELDS,
  WITHHOLDABLE_ACCOUNT_FIELDS,
  type AccountFieldAccess,
  type AccountFieldLevel,
  type ActivityFieldLevel,
  type TimelineActivityRow,
  type TimelineChangeRow,
} from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TIMELINE,
  ACCOUNT_TIMELINE_FIELDS,
  accountChangeItem,
  toAccountTimelineItems,
  visibleAccountChangeFields,
} from './account-timeline';
import { CONTACT_TIMELINE, toTimelineItems } from '../contacts/contact-timeline';

// Invented values only (CLAUDE.md 6.1).
const A1 = '11111111-0000-4000-8000-0000008000c1';
const ACTOR = { id: '11111111-0000-4000-8000-0000008000d1', displayName: 'Probe Actor' };
const AT = '2026-04-01T09:00:00.000Z';

const accountAccess = (overrides: Record<string, AccountFieldLevel> = {}): AccountFieldAccess =>
  new Map([
    [
      A1,
      new Map(
        WITHHOLDABLE_ACCOUNT_FIELDS.map(
          (field) => [accountFieldApiName(field), overrides[field] ?? 'edit'] as const,
        ),
      ),
    ],
  ]);

const activityAccess = (overrides: Record<string, ActivityFieldLevel> = {}) =>
  activityFieldAccessFromObjectAccess(
    new Map([
      [
        A1,
        new Map(
          SECURED_ACTIVITY_FIELDS.map(
            (field) => [activityFieldApiName(field), overrides[field] ?? 'edit'] as const,
          ),
        ),
      ],
    ]),
    [A1],
  );

function change(field: string, extra: Partial<TimelineChangeRow> = {}): TimelineChangeRow {
  return {
    kind: 'change',
    itemId: `ti_${'0'.repeat(31)}1`,
    occurredAt: AT,
    actor: ACTOR,
    field,
    redacted: true,
    before: null,
    after: null,
    ...extra,
  };
}

const activity: TimelineActivityRow = {
  kind: 'activity',
  itemId: `ti_${'0'.repeat(31)}2`,
  occurredAt: AT,
  actor: null,
  activityId: '11111111-0000-4000-8000-0000008000e1',
  activityType: 'task',
  subject: 'Probe subject',
  body: 'Probe body',
  dueAt: null,
  completedAt: null,
  version: 7,
};

describe('visibleAccountChangeFields (T-0080)', () => {
  it('is every Account field when nothing is withheld, in contract order', () => {
    expect(visibleAccountChangeFields(accountAccess(), A1)).toEqual([...ACCOUNT_TIMELINE_FIELDS]);
  });

  it('omits a withheld field, and never name', () => {
    const fields = visibleAccountChangeFields(
      accountAccess({ tier: 'none', phones: 'none', ownerUserId: 'none', tags: 'read' }),
      A1,
    );
    expect(fields).toContain('name');
    expect(fields).toContain('tags');
    expect(fields).not.toContain('tier');
    expect(fields).not.toContain('phones');
    expect(fields).not.toContain('ownerUserId');
  });

  it('fails closed for a programme the matrix does not carry: name only', () => {
    expect(visibleAccountChangeFields(accountAccess(), 'elsewhere')).toEqual(['name']);
  });

  it('never lists a contact field or a server-owned one', () => {
    const fields = visibleAccountChangeFields(accountAccess(), A1);
    for (const field of ['consentState', 'emails', 'accountId', 'programmeId', 'version']) {
      expect(fields).not.toContain(field);
    }
  });
});

describe('accountChangeItem: by name only, always (D-L78)', () => {
  it('never carries a value, even when a row recorded one', () => {
    for (const field of ['tier', 'tags', 'state', 'name']) {
      const item = accountChangeItem(
        change(field, { redacted: false, before: 'Probe Before', after: 'Probe After' }),
      );
      expect(item).toEqual({
        id: `ti_${'0'.repeat(31)}1`,
        type: 'field_changed',
        occurredAt: AT,
        actor: ACTOR,
        field,
        redacted: true,
      });
      expect(JSON.stringify(item)).not.toContain('Probe B');
    }
  });

  it('drops a name that is not an Account field, and never makes a consent item', () => {
    for (const field of ['consentState', 'emails', 'priority', 'programmeId']) {
      expect(accountChangeItem(change(field)), field).toBeNull();
    }
  });
});

describe('toAccountTimelineItems: activity items (T-0080, D-L85)', () => {
  it('is the very activity item of the contact timeline, version included', () => {
    const access = activityAccess({ subject: 'none' });
    const [onAccount] = toAccountTimelineItems([activity], access, A1);
    const [onContact] = toTimelineItems([activity], access, A1);
    expect(onAccount).toEqual(onContact);
    expect(onAccount).toMatchObject({ type: 'activity', version: 7 });
    expect('subject' in (onAccount ?? {})).toBe(false);
  });
});

describe('the two timelines share one operation and differ only in their spec', () => {
  it('each is put on its timeline by its own activity link', () => {
    expect(ACCOUNT_TIMELINE).toMatchObject({ subject: 'account', activityLink: 'accountId' });
    expect(CONTACT_TIMELINE).toMatchObject({ subject: 'contact', activityLink: 'contactId' });
  });
});
