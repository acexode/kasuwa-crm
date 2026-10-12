import {
  activityFieldAccessFromObjectAccess,
  activityFieldApiName,
  SECURED_ACTIVITY_FIELDS,
  type Activity,
  type ActivityFieldLevel,
} from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { activityAuditEvent, activityCreateChanges, activityUpdateChanges } from './activity-audit';
import { toActivityWire } from './activity-wire';

// Invented values only (CLAUDE.md 6.1).
const A1 = '11111111-0000-4000-8000-000000610101';
const SUBJECT = 'Probe subject names Mrs Probe';
const BODY = 'Probe body text';

const activity: Activity = {
  id: '11111111-0000-4000-8000-000000610102',
  programmeId: A1,
  type: 'task',
  subject: SUBJECT,
  body: BODY,
  dueAt: new Date('2026-12-01T09:00:00.000Z'),
  completedAt: null,
  startsAt: null,
  endsAt: null,
  ownerUserId: '11111111-0000-4000-8000-000000610103',
  contactId: '11111111-0000-4000-8000-000000610104',
  accountId: null,
  createdByUserId: '11111111-0000-4000-8000-000000610105',
  version: 1,
  createdAt: new Date('2026-10-01T09:00:00.123Z'),
  updatedAt: new Date('2026-10-01T09:00:00.123Z'),
};

const access = (overrides: Record<string, ActivityFieldLevel> = {}) =>
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

describe('toActivityWire', () => {
  it('sends every property, no tenant id, UTC times', () => {
    const wire = toActivityWire(activity, access());
    expect(wire).toMatchObject({
      id: activity.id,
      programmeId: A1,
      type: 'task',
      subject: SUBJECT,
      dueAt: '2026-12-01T09:00:00.000Z',
      completedAt: null,
      accountId: null,
      createdAt: '2026-10-01T09:00:00.123Z',
      withheldFields: [],
    });
    expect('tenantId' in wire).toBe(false);
  });

  it('omits a withheld field, never nulls it, and names it', () => {
    const wire = toActivityWire(activity, access({ body: 'none', ownerUserId: 'none' }));
    expect('body' in wire).toBe(false);
    expect('ownerUserId' in wire).toBe(false);
    expect(wire.withheldFields).toEqual(['body', 'ownerUserId']);
    expect(JSON.stringify(wire)).not.toContain(BODY);
  });

  it('never withholds type, even when the matrix says none', () => {
    expect(toActivityWire(activity, access({ type: 'none' })).type).toBe('task');
  });
});

describe('activity audit (T-0061)', () => {
  it('records fields by name only: no subject or body text anywhere', () => {
    const changes = activityCreateChanges({
      type: 'task',
      subject: SUBJECT,
      body: BODY,
      contactId: activity.contactId,
      ownerUserId: null,
    });
    expect(changes.map((entry) => entry.field)).toEqual(['type', 'subject', 'body', 'contactId']);
    for (const entry of changes) expect(entry.redacted).toBe(true);
    const event = activityAuditEvent('created', activity, changes);
    expect(event).toMatchObject({
      objectType: 'activity',
      objectId: activity.id,
      objectLabel: activity.id,
      programmeId: A1,
    });
    expect(JSON.stringify(event)).not.toContain('Probe');
  });

  it('records completion when it newly happened, and the owner when it moved', () => {
    const done = { ...activity, completedAt: new Date(), version: 2 };
    expect(activityUpdateChanges(activity, done).map((entry) => entry.field)).toEqual([
      'completedAt',
    ]);
    expect(activityUpdateChanges(done, { ...done, version: 3 })).toEqual([]);
    expect(
      activityUpdateChanges(activity, { ...activity, ownerUserId: null }).map(
        (entry) => entry.field,
      ),
    ).toEqual(['ownerUserId']);
  });
});
