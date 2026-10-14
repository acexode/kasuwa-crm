import { describe, expect, it } from 'vitest';
import { dealActorOf, DealActorUnresolvedError, dealProgrammeMember } from './deal-actor';

// Invented id and name; nothing seeds them.
const USER = '11111111-0000-4000-8000-012300000001';
const NAME = 'T0123 Synthetic Checker';

describe('dealActorOf (T-0123, D-L127, D-P23)', () => {
  it('a member of the deal’s programme is named', () => {
    expect(dealActorOf(USER, true, NAME)).toEqual({ id: USER, displayName: NAME });
  });

  it('a non-member is unnamed, the id kept, even if a name was read beside it', () => {
    expect(dealActorOf(USER, false, NAME)).toEqual({ id: USER, displayName: null });
    expect(dealActorOf(USER, false, null)).toEqual({ id: USER, displayName: null });
  });

  it('an unknown membership is not membership', () => {
    expect(dealActorOf(USER, null, NAME)).toEqual({ id: USER, displayName: null });
  });

  it('a member whose name cannot be read is an error carrying no identifier, never a former actor', () => {
    let caught: unknown;
    try {
      dealActorOf(USER, true, null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DealActorUnresolvedError);
    expect(String((caught as Error).message)).not.toContain(USER);
  });
});

describe('dealProgrammeMember (T-0123)', () => {
  it('is a user_programme row keyed on the row’s tenant, the deal’s programme and the user, nothing else', () => {
    const sql = dealProgrammeMember('m', {
      tenantId: 'k.tenant_id',
      programmeId: 'k.programme_id',
      userId: 'k.checked_by_user_id',
    });
    const flat = sql.replace(/\s+/g, ' ').trim();
    expect(flat).toBe(
      'EXISTS ( SELECT 1 FROM user_programme m WHERE m.tenant_id = k.tenant_id AND m.programme_id = k.programme_id AND m.user_id = k.checked_by_user_id)',
    );
    // Neither the tenant-admin flag nor another programme enters the test.
    expect(flat).not.toMatch(/is_tenant_admin|tenant_admin|ANY\(/i);
  });
});
