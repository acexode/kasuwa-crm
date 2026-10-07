import type { TenantTx } from '@kasuwa/db';
import type { FieldAccess } from '@kasuwa/metadata-engine';
import { describe, expect, it, vi } from 'vitest';
import {
  applyAuditFieldSecurity,
  loaderFor,
  objectsToLoad,
  redactForReader,
  type AuditValueSubject,
  type FieldSecuredObject,
  type ReaderFieldAccess,
} from './audit-field-security';
import { change, redactedChange } from './audit-writer';

// Invented ids, shaped like the seed's and naming nothing real.
const TENANT = '99999999-0000-4000-8000-000000000001';
const USER = '99999999-0000-4000-8000-000000000002';
const P1 = '99999999-0000-4000-8000-0000000000a1';
const P2 = '99999999-0000-4000-8000-0000000000a2';
const OUTSIDE = '99999999-0000-4000-8000-0000000000a3';

type Level = 'none' | 'read' | 'edit';

/** Programme -> api_name -> level, as `loadFieldAccess` answers. */
function accessOf(byProgramme: Record<string, Record<string, Level>>): FieldAccess {
  return new Map(
    Object.entries(byProgramme).map(([programme, fields]) => [
      programme,
      new Map(Object.entries(fields)),
    ]),
  );
}

function event(
  objectType: string,
  programmeId: string | null,
  changes: AuditValueSubject['changes'],
): AuditValueSubject & { id: string } {
  return { id: `${objectType}-${programmeId ?? 'none'}`, objectType, programmeId, changes };
}

const LGA = change('lga', 'Invented Lga One', 'Invented Lga Two');
const STATUS = change('status', 'new', 'contacted');

describe('redactForReader (T-0078)', () => {
  it('per field: a field the reader holds at none is redacted, a readable one in the same event is kept', () => {
    const access: ReaderFieldAccess = new Map([
      ['contact', accessOf({ [P1]: { lga: 'none', status: 'read' } })],
    ]);
    const judged = redactForReader(event('contact', P1, [LGA, STATUS]), access);
    expect(judged.changes).toEqual([redactedChange('lga'), STATUS]);
  });

  it('read and edit both see the values', () => {
    for (const level of ['read', 'edit'] as const) {
      const access: ReaderFieldAccess = new Map([
        ['contact', accessOf({ [P1]: { lga: level, status: level } })],
      ]);
      expect(redactForReader(event('contact', P1, [LGA, STATUS]), access).changes).toEqual([
        LGA,
        STATUS,
      ]);
    }
  });

  it('per programme: judged in the EVENT’s programme, never "withheld anywhere" or "readable anywhere"', () => {
    const access: ReaderFieldAccess = new Map([
      ['contact', accessOf({ [P1]: { lga: 'none' }, [P2]: { lga: 'read' } })],
    ]);
    expect(redactForReader(event('contact', P1, [LGA]), access).changes).toEqual([
      redactedChange('lga'),
    ]);
    expect(redactForReader(event('contact', P2, [LGA]), access).changes).toEqual([LGA]);
  });

  it('a programme the access does not carry (outside the session) is none', () => {
    const access: ReaderFieldAccess = new Map([['contact', accessOf({ [P1]: { lga: 'edit' } })]]);
    expect(redactForReader(event('contact', OUTSIDE, [LGA]), access).changes).toEqual([
      redactedChange('lga'),
    ]);
  });

  it('no programme: every value is redacted, even for a reader who may edit the field everywhere (F4)', () => {
    const access: ReaderFieldAccess = new Map([
      ['contact', accessOf({ [P1]: { lga: 'edit', status: 'edit' } })],
    ]);
    const judged = redactForReader(event('contact', null, [STATUS, LGA]), access);
    expect(judged.changes).toEqual([redactedChange('status'), redactedChange('lga')]);
  });

  it('maps the wire name to the field_def api_name: preferredChannel is judged by preferred_channel', () => {
    const preferred = change('preferredChannel', 'voice', 'sms');
    const readable: ReaderFieldAccess = new Map([
      ['contact', accessOf({ [P1]: { preferred_channel: 'read', preferredChannel: 'none' } })],
    ]);
    expect(redactForReader(event('contact', P1, [preferred]), readable).changes).toEqual([
      preferred,
    ]);
    const withheld: ReaderFieldAccess = new Map([
      ['contact', accessOf({ [P1]: { preferred_channel: 'none', preferredChannel: 'edit' } })],
    ]);
    expect(redactForReader(event('contact', P1, [preferred]), withheld).changes).toEqual([
      redactedChange('preferredChannel'),
    ]);
  });

  it('an unknown field fails closed: a name the object does not secure is redacted, whatever the map says', () => {
    const access: ReaderFieldAccess = new Map([
      [
        'contact',
        accessOf({
          [P1]: { nickname: 'edit', display_name: 'edit', displayName: 'edit', lga: 'edit' },
        }),
      ],
    ]);
    const judged = redactForReader(
      event('contact', P1, [
        change('nickname', null, 'Invented'),
        change('displayName', null, 'Invented Person'),
        LGA,
      ]),
      access,
    );
    expect(judged.changes).toEqual([
      redactedChange('nickname'),
      redactedChange('displayName'),
      LGA,
    ]);
  });

  it('a secured field missing from the access map (a broken catalogue) is none', () => {
    const access: ReaderFieldAccess = new Map([['contact', accessOf({ [P1]: {} })]]);
    expect(redactForReader(event('contact', P1, [LGA]), access).changes).toEqual([
      redactedChange('lga'),
    ]);
  });

  it('an object whose access was never loaded is none for every field', () => {
    expect(redactForReader(event('contact', P1, [LGA]), new Map()).changes).toEqual([
      redactedChange('lga'),
    ]);
  });

  it('a stored redacted change stays redacted, values dropped, for a reader who may edit the field', () => {
    const access: ReaderFieldAccess = new Map([['contact', accessOf({ [P1]: { lga: 'edit' } })]]);
    const stored = { field: 'lga', before: 'Invented', after: 'Invented', redacted: true };
    expect(redactForReader(event('contact', P1, [stored]), access).changes).toEqual([
      redactedChange('lga'),
    ]);
  });

  it('account and activity are judged by THEIR object’s matrix, not the contact’s', () => {
    const access: ReaderFieldAccess = new Map([
      ['contact', accessOf({ [P1]: { industry: 'edit', subject: 'edit', tier: 'edit' } })],
      ['account', accessOf({ [P1]: { industry: 'none', tier: 'read' } })],
      ['activity', accessOf({ [P1]: { subject: 'none', due_at: 'read' } })],
    ]);
    const industry = change('industry', null, 'Invented Industry');
    const tier = change('tier', 'sme', 'enterprise');
    expect(redactForReader(event('account', P1, [industry, tier]), access).changes).toEqual([
      redactedChange('industry'),
      tier,
    ]);
    const subject = change('subject', null, 'Invented Subject');
    const due = change('dueAt', null, '2026-12-01T09:00:00.000Z');
    expect(redactForReader(event('activity', P1, [subject, due]), access).changes).toEqual([
      redactedChange('subject'),
      due,
    ]);
  });

  it('an account name (never withheld on the wire, never recorded as a value) is redacted', () => {
    const access: ReaderFieldAccess = new Map([['account', accessOf({ [P1]: { name: 'edit' } })]]);
    expect(
      redactForReader(event('account', P1, [change('name', null, 'Invented Name')]), access)
        .changes,
    ).toEqual([redactedChange('name')]);
  });

  it('configuration objects pass unchanged; an object type outside the closed list is redacted', () => {
    const roleChange = change('name', 'Invented Role A', 'Invented Role B');
    expect(redactForReader(event('role', null, [roleChange]), new Map()).changes).toEqual([
      roleChange,
    ]);
    expect(redactForReader(event('programme', P1, [roleChange]), new Map()).changes).toEqual([
      roleChange,
    ]);
    expect(redactForReader(event('mystery_object', P1, [LGA]), new Map()).changes).toEqual([
      redactedChange('lga'),
    ]);
    expect(redactForReader(event('toString', P1, [LGA]), new Map()).changes).toEqual([
      redactedChange('lga'),
    ]);
  });

  it('keeps the event, every change and its field order, and every other property', () => {
    const entry = { ...event('contact', P1, [LGA, STATUS]), objectLabel: 'x', action: 'updated' };
    const judged = redactForReader(entry, new Map());
    expect(judged).toEqual({
      ...entry,
      changes: [redactedChange('lga'), redactedChange('status')],
    });
    expect(entry.changes).toEqual([LGA, STATUS]);
  });
});

describe('objectsToLoad', () => {
  it('names each field-secured object a page needs, once, and nothing for no-programme, configuration or redacted-only events', () => {
    expect(
      objectsToLoad([
        event('contact', P1, [LGA]),
        event('contact', P2, [STATUS]),
        event('account', P1, [change('tier', 'sme', 'enterprise')]),
        event('activity', P1, [redactedChange('subject')]),
        event('activity', null, [change('subject', null, 'x')]),
        event('role', null, [change('name', 'a', 'b')]),
        event('mystery_object', P1, [LGA]),
      ]).sort(),
    ).toEqual(['account', 'contact']);
  });
});

describe('applyAuditFieldSecurity', () => {
  it('loads each object’s access once per request, however many events and programmes the page holds', async () => {
    const load = vi.fn((object: FieldSecuredObject) =>
      Promise.resolve(
        object === 'contact'
          ? accessOf({ [P1]: { lga: 'none', status: 'read' }, [P2]: { lga: 'read' } })
          : accessOf({ [P1]: { tier: 'read' } }),
      ),
    );
    const page = [
      event('contact', P1, [LGA, STATUS]),
      event('contact', P2, [LGA]),
      event('contact', P1, [LGA]),
      event('account', P1, [change('tier', 'sme', 'enterprise')]),
      event('account', P1, [change('tier', 'enterprise', 'sme')]),
    ];
    const judged = await applyAuditFieldSecurity(page, load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls.map(([object]) => object).sort()).toEqual(['account', 'contact']);
    expect(judged.map((entry) => entry.changes)).toEqual([
      [redactedChange('lga'), STATUS],
      [LGA],
      [redactedChange('lga')],
      [change('tier', 'sme', 'enterprise')],
      [change('tier', 'enterprise', 'sme')],
    ]);
  });

  it('loads nothing for a page with no value to judge', async () => {
    const load = vi.fn(() => Promise.resolve(accessOf({})));
    const judged = await applyAuditFieldSecurity(
      [event('role', null, [change('name', 'a', 'b')]), event('contact', null, [LGA])],
      load,
    );
    expect(load).not.toHaveBeenCalled();
    expect(judged[1]?.changes).toEqual([redactedChange('lga')]);
  });
});

describe('loaderFor', () => {
  function fakeTx(
    programmeIds: string[],
    answer: () => Promise<unknown[]>,
  ): { tx: TenantTx; queries: string[] } {
    const queries: string[] = [];
    const tx: TenantTx = {
      session: { tenantId: TENANT, userId: USER, programmeIds },
      query: <T>(text: string) => {
        queries.push(text);
        return answer() as Promise<T[]>;
      },
    };
    return { tx, queries };
  }

  it('reads nothing for a session that reaches no programme', async () => {
    const { tx, queries } = fakeTx([], () => Promise.resolve([]));
    expect((await loaderFor(tx)('contact')).size).toBe(0);
    expect(queries).toEqual([]);
  });

  it('an object the tenant has no definition for reads as nothing readable, not an error', async () => {
    const { tx, queries } = fakeTx([P1], () => Promise.resolve([]));
    expect((await loaderFor(tx)('activity')).size).toBe(0);
    expect(queries).toHaveLength(1);
  });

  it('any other failure propagates', async () => {
    const { tx } = fakeTx([P1], () => Promise.reject(new Error('connection lost')));
    await expect(loaderFor(tx)('contact')).rejects.toThrow('connection lost');
  });
});
