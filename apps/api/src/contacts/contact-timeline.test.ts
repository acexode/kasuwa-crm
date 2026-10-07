import {
  activityFieldAccessFromObjectAccess,
  activityFieldApiName,
  SECURED_ACTIVITY_FIELDS,
  WITHHOLDABLE_CONTACT_FIELDS,
  type ActivityFieldLevel,
  type ContactFieldAccess,
  type ContactFieldLevel,
  type TimelineActivityRow,
  type TimelineChangeRow,
} from '@kasuwa/domain-core';
import { describe, expect, it } from 'vitest';
import { TimelineQuery, toTimelineItems, visibleChangeFields } from './contact-timeline';

// Invented values only (CLAUDE.md 6.1).
const A1 = '11111111-0000-4000-8000-0000006100c1';
const ACTOR = { id: '11111111-0000-4000-8000-0000006100d1', displayName: 'Probe Actor' };
const AT = '2026-04-01T09:00:00.000Z';

const contactAccess = (overrides: Record<string, ContactFieldLevel> = {}): ContactFieldAccess =>
  new Map([
    [
      A1,
      new Map(
        WITHHOLDABLE_CONTACT_FIELDS.map((field) => [field, overrides[field] ?? 'edit'] as const),
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

const map = (rows: TimelineChangeRow[]) => toTimelineItems(rows, activityAccess(), A1);

describe('visibleChangeFields', () => {
  it('lists every timeline field the caller may read, and always displayName', () => {
    const fields = visibleChangeFields(contactAccess({ emails: 'none', consentState: 'none' }), A1);
    expect(fields).toContain('displayName');
    expect(fields).toContain('status');
    expect(fields).toContain('phones');
    expect(fields).not.toContain('emails');
    expect(fields).not.toContain('consentState');
  });

  it('never lists a field outside the closed union, readable or not', () => {
    const fields = visibleChangeFields(contactAccess(), A1);
    expect(fields).not.toContain('dnd');
    expect(fields).not.toContain('phoneNetwork');
    expect(fields).toHaveLength(16);
  });

  it('fails closed for a programme the access map does not carry', () => {
    expect(visibleChangeFields(contactAccess(), 'elsewhere')).toEqual(['displayName']);
  });
});

describe('toTimelineItems: change items (D-L72, D-L81)', () => {
  it('decodes recorded values back into the wire type', () => {
    const [status, optIn, tags, lga] = map([
      change('status', { redacted: false, before: 'new', after: 'contacted' }),
      change('whatsappOptIn', { redacted: false, before: 'false', after: 'true' }),
      change('tags', { redacted: false, before: '["Late payer"]', after: '["Late payer","VIP"]' }),
      change('lga', { redacted: false, before: null, after: 'Ikeja' }),
    ]);
    expect(status).toMatchObject({ type: 'field_changed', before: 'new', after: 'contacted' });
    expect(optIn).toMatchObject({ before: false, after: true });
    expect(tags).toMatchObject({ before: ['Late payer'], after: ['Late payer', 'VIP'] });
    expect(lga).toMatchObject({ before: null, after: 'Ikeja' });
    for (const item of [status, optIn, tags, lga]) expect('redacted' in (item ?? {})).toBe(false);
  });

  it('renders a legacy (redacted) value change without before, after or redacted', () => {
    const [item] = map([change('status')]);
    expect(item).toEqual({
      id: `ti_${'0'.repeat(31)}1`,
      type: 'field_changed',
      occurredAt: AT,
      actor: ACTOR,
      field: 'status',
    });
  });

  it('never sends a value for a redacted field, even if a row carries one', () => {
    const [item] = map([change('phones', { redacted: false, before: '+234', after: '+235' })]);
    expect(item).toEqual({
      id: `ti_${'0'.repeat(31)}1`,
      type: 'field_changed',
      occurredAt: AT,
      actor: ACTOR,
      field: 'phones',
      redacted: true,
    });
  });

  it('turns consentState into consent_changed, with values only when both are ConsentState codes', () => {
    const [valued, legacy, odd] = map([
      change('consentState', { redacted: false, before: 'unknown', after: 'opted_in' }),
      change('consentState'),
      change('consentState', { redacted: false, before: null, after: 'Opted in' }),
    ]);
    expect(valued).toMatchObject({ type: 'consent_changed', before: 'unknown', after: 'opted_in' });
    expect('field' in (valued ?? {})).toBe(false);
    expect(legacy).toEqual({
      id: legacy?.id,
      type: 'consent_changed',
      occurredAt: AT,
      actor: ACTOR,
    });
    expect('before' in (odd ?? {}) || 'after' in (odd ?? {})).toBe(false);
  });

  it('drops values that do not decode rather than sending them raw', () => {
    const [optIn, tags] = map([
      change('whatsappOptIn', { redacted: false, before: 'yes', after: 'true' }),
      change('tags', { redacted: false, before: 'not json', after: '["x"]' }),
    ]);
    expect('before' in (optIn ?? {})).toBe(false);
    expect('before' in (tags ?? {})).toBe(false);
  });
});

describe('toTimelineItems: activity items (T-0061)', () => {
  const row: TimelineActivityRow = {
    kind: 'activity',
    itemId: `ti_${'0'.repeat(31)}2`,
    occurredAt: AT,
    actor: null,
    activityId: '11111111-0000-4000-8000-0000006100e1',
    activityType: 'task',
    subject: 'Probe subject',
    body: 'Probe body',
    dueAt: new Date('2026-12-01T09:00:00.000Z'),
    completedAt: null,
  };

  it('sends the current state, exactly the item keys', () => {
    expect(toTimelineItems([row], activityAccess(), A1)).toEqual([
      {
        id: row.itemId,
        type: 'activity',
        occurredAt: AT,
        actor: null,
        activityId: row.activityId,
        activityType: 'task',
        subject: 'Probe subject',
        body: 'Probe body',
        dueAt: '2026-12-01T09:00:00.000Z',
        completedAt: null,
      },
    ]);
  });

  it('omits a withheld subject, body, due or completed time, never nulls it', () => {
    const [item] = toTimelineItems(
      [row],
      activityAccess({ body: 'none', subject: 'none', dueAt: 'none', completedAt: 'none' }),
      A1,
    );
    expect(Object.keys(item ?? {}).sort()).toEqual(
      ['activityId', 'activityType', 'actor', 'id', 'occurredAt', 'type'].sort(),
    );
    expect(JSON.stringify(item)).not.toContain('Probe');
  });

  it('refuses a type outside the contract rather than sending it', () => {
    expect(() =>
      toTimelineItems([{ ...row, activityType: 'meeting' }], activityAccess(), A1),
    ).toThrow();
  });
});

describe('TimelineQuery', () => {
  it('defaults limit to 25 and holds it to 1..100, never clamping', () => {
    expect(TimelineQuery.parse({})).toEqual({ limit: 25 });
    expect(TimelineQuery.parse({ limit: '100' }).limit).toBe(100);
    for (const limit of ['0', '101', 'ten', '1.5']) {
      expect(TimelineQuery.safeParse({ limit }).success, limit).toBe(false);
    }
  });
});
