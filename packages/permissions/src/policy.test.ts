import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSION_SET_KEY,
  PROGRAMME_ACTIONS,
  TENANT_ACTIONS,
  canProgramme,
  canTenant,
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
  it('permits every programme action where the admin set is held, and none where it is not', () => {
    const subject = grants();
    for (const action of PROGRAMME_ACTIONS) {
      expect(canProgramme(subject, action, P1), `${action} in P1`).toBe(true);
      expect(canProgramme(subject, action, P2), `${action} in P2 (agent)`).toBe(false);
    }
  });

  it('treats every set other than admin, an unknown key and a NULL set as read-only', () => {
    for (const key of [
      'agent',
      'team_lead',
      'qa_analyst',
      'programme_manager',
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
