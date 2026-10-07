import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSION_SET_KEY,
  AGENT_PERMISSION_SET_KEY,
  PROGRAMME_ACTIONS,
  TENANT_ACTIONS,
  canProgramme,
  canTenant,
  canUpdateContact,
  contactUpdateWithinClaim,
  type Grants,
} from './policy';

// Invented ids; same shape as the seed's, nothing seeds them.
const P1 = '11111111-0000-4000-8000-00000032a001';
const P2 = '11111111-0000-4000-8000-00000032a002';
const OUTSIDE = '11111111-0000-4000-8000-00000032a099';

function grants(overrides: Partial<Grants> = {}): Grants {
  return {
    isTenantAdmin: false,
    reachableProgrammeIds: [P1, P2],
    programmeSets: new Map<string, string | null>([
      [P1, ADMIN_PERMISSION_SET_KEY],
      [P2, 'agent'],
    ]),
    ...overrides,
  };
}

describe('canTenant (D-L53: tenant-level writes need the tenant-admin flag)', () => {
  it('refuses every tenant-level action to a programme admin who is not a tenant admin', () => {
    // Holding `admin` in every reachable programme is still not tenant admin.
    const everywhere = grants({
      programmeSets: new Map([
        [P1, ADMIN_PERMISSION_SET_KEY],
        [P2, ADMIN_PERMISSION_SET_KEY],
      ]),
    });
    for (const action of TENANT_ACTIONS) {
      expect(canTenant(everywhere, action), action).toBe(false);
    }
  });

  it('permits every tenant-level action to a tenant admin, with or without memberships', () => {
    for (const subject of [
      grants({ isTenantAdmin: true }),
      grants({ isTenantAdmin: true, reachableProgrammeIds: [], programmeSets: new Map() }),
    ]) {
      for (const action of TENANT_ACTIONS) {
        expect(canTenant(subject, action), action).toBe(true);
      }
    }
  });
});

describe('canProgramme (D-L53: admin set in that programme, or tenant admin)', () => {
  it('permits every programme action where the admin set is held, and only the D-P14 grant where agent is', () => {
    const subject = grants();
    for (const action of PROGRAMME_ACTIONS) {
      expect(canProgramme(subject, action, P1), `${action} in P1`).toBe(true);
      expect(canProgramme(subject, action, P2), `${action} in P2 (agent)`).toBe(
        action === 'contact.claim_and_set_status',
      );
    }
  });

  // D-P14 for agent; D-P18 (answered 2026-10-06, T-0077) for the two supervisor sets.
  it.each([AGENT_PERMISSION_SET_KEY, 'team_lead', 'programme_manager'])(
    'gives the %s set nothing but contact.claim_and_set_status (D-P14, D-P18)',
    (key) => {
      const subject = grants({ programmeSets: new Map([[P1, key]]) });
      const permitted = PROGRAMME_ACTIONS.filter((action) => canProgramme(subject, action, P1));
      expect(permitted).toEqual(['contact.claim_and_set_status']);
    },
  );

  it('treats qa_analyst, client_portal, an unknown key and a NULL set as read-only', () => {
    for (const key of [
      'qa_analyst',
      'client_portal',
      'not_a_set',
      // Not an own property of the allow-list: must not reach Object.prototype.
      'constructor',
      '__proto__',
      null,
    ]) {
      const subject = grants({ programmeSets: new Map([[P1, key]]) });
      for (const action of PROGRAMME_ACTIONS) {
        expect(canProgramme(subject, action, P1), `${action} with ${String(key)}`).toBe(false);
      }
    }
  });

  it('refuses a membership row that is missing from the map', () => {
    const subject = grants({ programmeSets: new Map() });
    expect(canProgramme(subject, 'disposition.write', P1)).toBe(false);
  });

  it('lets a tenant admin act in every reachable programme, whatever set they hold there', () => {
    const subject = grants({ isTenantAdmin: true });
    for (const action of PROGRAMME_ACTIONS) {
      expect(canProgramme(subject, action, P2), action).toBe(true);
    }
  });

  it('never widens scope: an unreachable programme is refused even to a tenant admin holding admin there', () => {
    // D-L06. A grant row for a programme outside the resolved scope (stale,
    // forged, or simply not loaded) must not count.
    const subject = grants({
      isTenantAdmin: true,
      programmeSets: new Map([[OUTSIDE, ADMIN_PERMISSION_SET_KEY]]),
    });
    for (const action of PROGRAMME_ACTIONS) {
      expect(canProgramme(subject, action, OUTSIDE), action).toBe(false);
    }
  });
});

describe('account.write (T-0055, D-P18: account writes are admin-only)', () => {
  it('is held by the admin set in that programme and by no other set', () => {
    expect(canProgramme(grants(), 'account.write', P1), 'admin in P1').toBe(true);
    for (const key of [
      AGENT_PERMISSION_SET_KEY,
      'team_lead',
      'qa_analyst',
      'programme_manager',
      'client_portal',
      null,
    ]) {
      const subject = grants({ programmeSets: new Map([[P1, key]]) });
      expect(canProgramme(subject, 'account.write', P1), String(key)).toBe(false);
    }
  });

  it('is per programme: admin in P1 does not permit writing an account in P2', () => {
    expect(canProgramme(grants(), 'account.write', P2)).toBe(false);
  });

  it('is granted by the tenant-admin flag, whatever set is held, but never outside scope', () => {
    expect(canProgramme(grants({ isTenantAdmin: true }), 'account.write', P2)).toBe(true);
    expect(canProgramme(grants({ isTenantAdmin: true }), 'account.write', OUTSIDE)).toBe(false);
  });
});

describe('canUpdateContact (D-P14: agent may set status and own the record, nothing else)', () => {
  const ME = '11111111-0000-4000-8000-000000510001';
  const SOMEONE_ELSE = '11111111-0000-4000-8000-000000510002';
  /** Agent in P1, admin in P2, no tenant-admin flag. */
  const agentInP1 = grants({
    programmeSets: new Map([
      [P1, AGENT_PERMISSION_SET_KEY],
      [P2, ADMIN_PERMISSION_SET_KEY],
    ]),
  });

  it.each([
    ['status', { version: 3, status: 'contacted' }],
    ['owner to self', { version: 3, ownerUserId: ME }],
    ['owner to self in upper case', { version: 3, ownerUserId: ME.toUpperCase() }],
    ['status and owner to self', { version: 3, status: 'qualified', ownerUserId: ME }],
    // Values are validated after the decision; a bad one is the caller's 400.
    ['a status value the schema will reject', { version: 3, status: 'bogus' }],
    ['no version (the schema answers 400)', { status: 'contacted' }],
  ])('lets the agent set write %s', (_label, body) => {
    expect(canUpdateContact(agentInP1, P1, ME, body)).toBe(true);
  });

  it.each([
    ['another owner', { version: 3, ownerUserId: SOMEONE_ELSE }],
    ['a cleared owner', { version: 3, ownerUserId: null }],
    ['an owner that is not a string', { version: 3, ownerUserId: 7 }],
    ['displayName', { version: 3, displayName: 'Renamed' }],
    ['phones', { version: 3, phones: [] }],
    ['tags', { version: 3, tags: ['x'] }],
    ['consentState', { version: 3, consentState: 'opted_in' }],
    ['accountId', { version: 3, accountId: null }],
    ['programmeId', { version: 3, programmeId: P2 }],
    ['status with another field', { version: 3, status: 'customer', lga: 'Ikeja' }],
    ['owner to self with another field', { version: 3, ownerUserId: ME, tags: ['x'] }],
    ['a __proto__ key', JSON.parse('{"version":3,"__proto__":{"tags":["x"]}}') as unknown],
    // Keys match exactly: a case variant or padded key is not the field.
    ['a case-variant Status key', { version: 3, Status: 'contacted' }],
    ['an OWNERUSERID key', { version: 3, OWNERUSERID: ME }],
    ['an ownerUserID key', { version: 3, ownerUserID: ME }],
    ['a padded " status" key', { version: 3, ' status': 'contacted' }],
    ['an array body', [{ status: 'contacted' }]],
    ['a null body', null],
    ['a string body', 'status=contacted'],
  ])('refuses the agent set %s, whole', (_label, body) => {
    expect(canUpdateContact(agentInP1, P1, ME, body)).toBe(false);
  });

  it('is judged per programme: the agent grant in P1 does not reach a record elsewhere', () => {
    const agentOnly = grants({ programmeSets: new Map([[P1, AGENT_PERMISSION_SET_KEY]]) });
    expect(canUpdateContact(agentOnly, P2, ME, { version: 1, status: 'contacted' })).toBe(false);
    expect(canUpdateContact(agentOnly, OUTSIDE, ME, { version: 1, status: 'contacted' })).toBe(
      false,
    );
  });

  it('lets contact.write (admin set, or the tenant-admin flag) write any body', () => {
    const body = { version: 3, displayName: 'Renamed', ownerUserId: SOMEONE_ELSE };
    expect(canUpdateContact(agentInP1, P2, ME, body)).toBe(true);
    expect(canUpdateContact(grants({ isTenantAdmin: true }), P2, ME, body)).toBe(true);
    // The flag over the agent set: full write, not the narrow grant.
    const flagged = grants({
      isTenantAdmin: true,
      programmeSets: new Map([[P1, AGENT_PERMISSION_SET_KEY]]),
    });
    expect(canUpdateContact(flagged, P1, ME, body)).toBe(true);
  });

  it.each(['team_lead', 'programme_manager'])(
    'gives the %s set exactly the agent rule: status and owner to self, nothing else (D-P18)',
    (key) => {
      const subject = grants({ programmeSets: new Map([[P1, key]]) });
      expect(canUpdateContact(subject, P1, ME, { version: 1, status: 'contacted' })).toBe(true);
      expect(canUpdateContact(subject, P1, ME, { version: 1, ownerUserId: ME })).toBe(true);
      for (const body of [
        { version: 1, ownerUserId: SOMEONE_ELSE },
        { version: 1, ownerUserId: null },
        { version: 1, tags: ['x'] },
        { version: 1, status: 'customer', lga: 'Ikeja' },
      ]) {
        expect(canUpdateContact(subject, P1, ME, body), JSON.stringify(body)).toBe(false);
      }
      // Per programme, as for agent: the grant in P1 does not reach P2.
      expect(canUpdateContact(subject, P2, ME, { version: 1, status: 'contacted' })).toBe(false);
    },
  );

  it('keeps qa_analyst, client_portal and a NULL set read-only, even for status alone', () => {
    for (const key of ['qa_analyst', 'client_portal', null]) {
      const subject = grants({ programmeSets: new Map([[P1, key]]) });
      expect(canUpdateContact(subject, P1, ME, { version: 1, status: 'contacted' }), String(key)).toBe(
        false,
      );
    }
  });

  it('never widens scope: an agent grant on an unreachable programme counts for nothing', () => {
    const subject = grants({ programmeSets: new Map([[OUTSIDE, AGENT_PERMISSION_SET_KEY]]) });
    expect(canUpdateContact(subject, OUTSIDE, ME, { version: 1, status: 'contacted' })).toBe(false);
  });

  it('exposes the body rule on its own, for the same answer', () => {
    expect(contactUpdateWithinClaim({ version: 1, ownerUserId: ME }, ME)).toBe(true);
    expect(contactUpdateWithinClaim({ version: 1, ownerUserId: SOMEONE_ELSE }, ME)).toBe(false);
  });
});

describe('the action lists', () => {
  it('keep tenant-level and programme-scoped actions disjoint', () => {
    const tenant = new Set<string>(TENANT_ACTIONS);
    for (const action of PROGRAMME_ACTIONS) {
      expect(tenant.has(action), action).toBe(false);
    }
  });

  it('put programme create and update at tenant level (D-L40)', () => {
    expect(TENANT_ACTIONS).toEqual(
      expect.arrayContaining(['programme.create', 'programme.update']),
    );
  });
});
