import type { TenantTx } from '@kasuwa/db';
import type { FieldAccess } from '@kasuwa/metadata-engine';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { CONTACT_AUDIT_VALUE_FIELDS } from '../../contacts/contact-audit';
import {
  applyAuditFieldSecurity,
  loaderFor,
  objectsToLoad,
  redactForReader,
  type AuditValueSubject,
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

/** A reader who may edit every field of every object in both programmes. */
const EDIT_EVERYTHING = (fields: string[]): ReaderFieldAccess => {
  const all = Object.fromEntries(fields.map((field) => [field, 'edit' as const]));
  const access = accessOf({ [P1]: all, [P2]: all });
  return new Map([
    ['contact', access],
    ['account', access],
    ['activity', access],
  ]);
};

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

  it('every D-L72 value field can carry a value for a reader who may read it', () => {
    const access = EDIT_EVERYTHING([
      'status',
      'source',
      'preferred_language',
      'preferred_channel',
      'consent_state',
      'whatsapp_opt_in',
      'state',
      'lga',
      'tags',
    ]);
    const changes = CONTACT_AUDIT_VALUE_FIELDS.map((field) => change(field, null, 'invented'));
    expect(redactForReader(event('contact', P1, changes), access).changes).toEqual(changes);
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
    const judged = redactForReader(
      event('contact', null, [STATUS, LGA]),
      EDIT_EVERYTHING(['lga', 'status']),
    );
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

  it('the contact VALUE allow-list: a stored value on a name part, phone, email, owner, account or unknown field is redacted for a reader with edit', () => {
    const fields = [
      'givenNames',
      'familyName',
      'displayName',
      'companyName',
      'phones',
      'emails',
      'ownerUserId',
      'accountId',
      'dnd',
      'phoneNetwork',
      'nickname',
    ];
    const snake = fields.map((field) => field.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`));
    const access = EDIT_EVERYTHING([...fields, ...snake, 'lga']);
    const judged = redactForReader(
      event('contact', P1, [...fields.map((field) => change(field, 'Invented', 'Invented')), LGA]),
      access,
    );
    expect(judged.changes).toEqual([...fields.map((field) => redactedChange(field)), LGA]);
  });

  it('account and activity carry no value at all, for a reader with edit on every field', () => {
    const accountFields = ['name', 'industry', 'tier', 'tags', 'phones', 'state', 'lga'];
    const activityFields = ['type', 'subject', 'body', 'dueAt', 'completedAt', 'due_at'];
    const access = EDIT_EVERYTHING([...accountFields, ...activityFields]);
    expect(
      redactForReader(
        event(
          'account',
          P1,
          accountFields.map((field) => change(field, 'Invented', 'Invented')),
        ),
        access,
      ).changes,
    ).toEqual(accountFields.map((field) => redactedChange(field)));
    expect(
      redactForReader(
        event(
          'activity',
          P1,
          activityFields.map((field) => change(field, 'Invented', 'Invented')),
        ),
        access,
      ).changes,
    ).toEqual(activityFields.map((field) => redactedChange(field)));
  });

  it('a value field missing from the access map (a broken catalogue) is none', () => {
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

  it('judges a contact by the CONTACT matrix only', () => {
    const access: ReaderFieldAccess = new Map([
      ['account', accessOf({ [P1]: { lga: 'edit' } })],
      ['activity', accessOf({ [P1]: { lga: 'edit' } })],
    ]);
    expect(redactForReader(event('contact', P1, [LGA]), access).changes).toEqual([
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

  it('configuration objects pass unchanged; an object type outside the closed list is redacted', () => {
    const roleChange = change('name', 'Invented Role A', 'Invented Role B');
    expect(redactForReader(event('role', null, [roleChange]), new Map()).changes).toEqual([
      roleChange,
    ]);
    expect(redactForReader(event('programme', P1, [roleChange]), new Map()).changes).toEqual([
      roleChange,
    ]);
    const anything = EDIT_EVERYTHING(['lga']);
    expect(redactForReader(event('mystery_object', P1, [LGA]), anything).changes).toEqual([
      redactedChange('lga'),
    ]);
    expect(redactForReader(event('toString', P1, [LGA]), anything).changes).toEqual([
      redactedChange('lga'),
    ]);
  });

  it('a `tenant` event (provisioning, not in AUDIT_OBJECT_TYPES) is fully redacted: a conscious fail-closed rule', () => {
    // The shape provision-tenant.ts writes: system actor, no programme, values.
    const provisioned = event('tenant', null, [
      change('slug', null, 'invented-slug'),
      change('region', null, 'ZA'),
      change('region_cell', null, 'za-1'),
      change('business_unit_id', null, '99999999-0000-4000-8000-0000000000d1'),
      change('default_programme_id', null, P1),
      change('admin_user_id', null, USER),
      redactedChange('admin_email'),
    ]);
    const judged = redactForReader(provisioned, EDIT_EVERYTHING(['slug', 'region']));
    expect(judged.changes).toEqual(
      provisioned.changes.map((original) => redactedChange(original.field)),
    );
    // Even if a tenant event ever carried a programme, it stays redacted.
    expect(
      redactForReader({ ...provisioned, programmeId: P1 }, EDIT_EVERYTHING(['slug'])).changes,
    ).toEqual(provisioned.changes.map((original) => redactedChange(original.field)));
    expect(objectsToLoad([provisioned, { ...provisioned, programmeId: P1 }])).toEqual([]);
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

describe('objectsToLoad (no oracle on stored content)', () => {
  it('loads the contact matrix for any contact event with a programme, whatever its changes hold', () => {
    for (const changes of [[LGA], [redactedChange('lga')], [change('lga', null, null)], []]) {
      expect(objectsToLoad([event('contact', P1, changes)])).toEqual(['contact']);
    }
  });

  it('never loads for no-programme, configuration, unknown, account or activity events', () => {
    expect(
      objectsToLoad([
        event('contact', null, [LGA]),
        event('account', P1, [change('tier', 'sme', 'enterprise')]),
        event('activity', P1, [change('subject', null, 'x')]),
        event('role', null, [change('name', 'a', 'b')]),
        event('mystery_object', P1, [LGA]),
      ]),
    ).toEqual([]);
  });
});

describe('applyAuditFieldSecurity', () => {
  const S1 = '99999999-0000-4000-8000-0000000000b1';
  const S2 = '99999999-0000-4000-8000-0000000000b2';

  /**
   * A tenant transaction whose session reaches P1 (set S1: lga none) and P2
   * (set S2: lga read). It answers the real `loadFieldAccess` SQL and records
   * which object each access query asked for; any other query is a test bug.
   */
  function accessTx(): { tx: TenantTx; accessQueries: unknown[] } {
    const accessQueries: unknown[] = [];
    const tx: TenantTx = {
      session: { tenantId: TENANT, userId: USER, programmeIds: [P1, P2] },
      query: <T>(text: string, values: readonly unknown[] = []) => {
        if (!text.includes('FROM object_def o')) {
          return Promise.reject(new Error(`unexpected query: ${text.slice(0, 40)}`));
        }
        accessQueries.push(values[1]);
        return Promise.resolve([
          {
            fields: ['lga', 'status'],
            grants: [
              { field: 'lga', set: S1, locked: false, level: 'none' },
              { field: 'lga', set: S2, locked: false, level: 'read' },
            ],
            memberships: [
              { programme: P1, set: S1, locked: false },
              { programme: P2, set: S2, locked: false },
            ],
          },
        ] as T[]);
      },
    };
    return { tx, accessQueries };
  }

  it('takes the transaction, never a loader or an access map (asserted by tsc, `pnpm typecheck`)', () => {
    // Any other second parameter (a loader, a matrix) makes this a type error.
    expectTypeOf(applyAuditFieldSecurity<AuditValueSubject>).parameters.toEqualTypeOf<
      [readonly AuditValueSubject[], TenantTx]
    >();
  });

  it('reads the session’s own contact matrix once per request, however many events and programmes', async () => {
    const { tx, accessQueries } = accessTx();
    const page = [
      event('contact', P1, [LGA, STATUS]),
      event('contact', P2, [LGA]),
      event('contact', P1, [redactedChange('lga')]),
      event('account', P1, [change('tier', 'sme', 'enterprise')]),
    ];
    const judged = await applyAuditFieldSecurity(page, tx);
    expect(accessQueries).toEqual(['contact']);
    expect(judged.map((entry) => entry.changes)).toEqual([
      [redactedChange('lga'), STATUS],
      [LGA],
      [redactedChange('lga')],
      [redactedChange('tier')],
    ]);
  });

  it('queries the same whether a page’s contact changes carry values or not', async () => {
    const withValues = accessTx();
    const without = accessTx();
    await applyAuditFieldSecurity([event('contact', P1, [LGA])], withValues.tx);
    await applyAuditFieldSecurity([event('contact', P1, [redactedChange('lga')])], without.tx);
    expect(withValues.accessQueries).toEqual(without.accessQueries);
    expect(withValues.accessQueries).toEqual(['contact']);
  });

  it('queries nothing for a page with no contact event in a programme', async () => {
    const { tx, accessQueries } = accessTx();
    const judged = await applyAuditFieldSecurity(
      [event('role', null, [change('name', 'a', 'b')]), event('contact', null, [LGA])],
      tx,
    );
    expect(accessQueries).toEqual([]);
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
    expect((await loaderFor(tx)('contact')).size).toBe(0);
    expect(queries).toHaveLength(1);
  });

  it('any other failure propagates', async () => {
    const { tx } = fakeTx([P1], () => Promise.reject(new Error('connection lost')));
    await expect(loaderFor(tx)('contact')).rejects.toThrow('connection lost');
  });
});
