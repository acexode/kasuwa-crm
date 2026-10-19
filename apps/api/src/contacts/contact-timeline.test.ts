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
  it('lists every timeline field the caller may read, displayName when both name parts are', () => {
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
    // T-0076 added companyName (redacted): 17.
    expect(fields).toContain('companyName');
    expect(fields).toHaveLength(17);
  });

  it('omits companyName where it is withheld (T-0076)', () => {
    expect(visibleChangeFields(contactAccess({ companyName: 'none' }), A1)).not.toContain(
      'companyName',
    );
  });

  it('fails closed for a programme the access map does not carry', () => {
    expect(visibleChangeFields(contactAccess(), 'elsewhere')).toEqual([]);
  });

  it('displayName follows its name parts: withheld with either, readable with a read-only part (T-0124 I12)', () => {
    for (const part of ['givenNames', 'familyName'] as const) {
      expect(visibleChangeFields(contactAccess({ [part]: 'none' }), A1), part).not.toContain(
        'displayName',
      );
    }
    expect(visibleChangeFields(contactAccess({ familyName: 'read' }), A1)).toContain(
      'displayName',
    );
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

  it('shows a companyName change by name only, even if a row carries values (T-0076, D-L82)', () => {
    const [item] = map([
      change('companyName', { redacted: false, before: 'Probe Old Co', after: 'Probe New Co' }),
    ]);
    expect(item).toEqual({
      id: `ti_${'0'.repeat(31)}1`,
      type: 'field_changed',
      occurredAt: AT,
      actor: ACTOR,
      field: 'companyName',
      redacted: true,
    });
    expect(JSON.stringify(item)).not.toContain('Probe Old Co');
    expect(JSON.stringify(item)).not.toContain('Probe New Co');
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
    startsAt: null,
    endsAt: null,
    version: 3,
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
        startsAt: null,
        endsAt: null,
        version: 3,
      },
    ]);
  });

  it('carries a meeting with its times (T-0082), and omits a withheld start, not the item', () => {
    const meeting: TimelineActivityRow = {
      ...row,
      activityType: 'meeting',
      dueAt: null,
      startsAt: new Date('2026-12-02T09:00:00.000Z'),
      endsAt: new Date('2026-12-02T10:00:00.000Z'),
    };
    expect(toTimelineItems([meeting], activityAccess(), A1)[0]).toMatchObject({
      activityType: 'meeting',
      dueAt: null,
      startsAt: '2026-12-02T09:00:00.000Z',
      endsAt: '2026-12-02T10:00:00.000Z',
    });
    const [item] = toTimelineItems([meeting], activityAccess({ startsAt: 'none' }), A1);
    expect(item && 'startsAt' in item).toBe(false);
    expect(item).toMatchObject({ endsAt: '2026-12-02T10:00:00.000Z', version: 3 });
  });

  it('omits a withheld subject, body, due, completed, start or end time, never nulls it; keeps the version', () => {
    const [item] = toTimelineItems(
      [row],
      activityAccess({
        body: 'none',
        subject: 'none',
        dueAt: 'none',
        completedAt: 'none',
        startsAt: 'none',
        endsAt: 'none',
      }),
      A1,
    );
    expect(Object.keys(item ?? {}).sort()).toEqual(
      ['activityId', 'activityType', 'actor', 'id', 'occurredAt', 'type', 'version'].sort(),
    );
    expect(JSON.stringify(item)).not.toContain('Probe');
  });

  it('carries the row version, whatever the matrix withholds (T-0080, D-L85)', () => {
    const everything = Object.fromEntries(
      SECURED_ACTIVITY_FIELDS.map((field) => [field, 'none' as const]),
    );
    const [item] = toTimelineItems([{ ...row, version: 41 }], activityAccess(everything), A1);
    expect(item).toMatchObject({ type: 'activity', version: 41 });
  });

  it('refuses a type outside the contract rather than sending it', () => {
    expect(() =>
      toTimelineItems([{ ...row, activityType: 'email' }], activityAccess(), A1),
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
