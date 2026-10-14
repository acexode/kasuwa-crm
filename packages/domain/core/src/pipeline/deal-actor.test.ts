import { describe, expect, it } from 'vitest';
import {
  dealActorOf,
  DealActorUnresolvedError,
  DealMembershipSqlError,
  dealProgrammeMember,
  dealProgrammeMemberFlag,
  dealProgrammeMemberJoin,
} from './deal-actor';

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

describe('dealProgrammeMemberJoin (T-0123 review: one probe per check)', () => {
  it('is the same three keys as the EXISTS form, as a LEFT JOIN, with its flag', () => {
    const refs = {
      tenantId: 'k.tenant_id',
      programmeId: 'k.programme_id',
      userId: 'k.checked_by_user_id',
    };
    const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    const keys =
      'm.tenant_id = k.tenant_id AND m.programme_id = k.programme_id AND m.user_id = k.checked_by_user_id';
    expect(flat(dealProgrammeMemberJoin('m', refs))).toBe(`LEFT JOIN user_programme m ON ${keys}`);
    expect(flat(dealProgrammeMember('m', refs))).toContain(`WHERE ${keys}`);
    expect(dealProgrammeMemberFlag('m')).toBe('(m.user_id IS NOT NULL)');
  });
});

describe('the membership SQL builders take column references only (T-0123 security review)', () => {
  const good = {
    tenantId: 'd.tenant_id',
    programmeId: 'd.programme_id',
    userId: 'd.owner_user_id',
  };
  const hostile = [
    'd.owner_user_id OR true',
    'd.tenant_id; DROP TABLE deal',
    "'x'",
    '$1',
    'D.tenant_id',
    'a.b.c',
    '1col',
    '',
    'd.tenant_id--',
    'd.tenant_id ',
  ];

  it('accepts a bare column and an alias.column', () => {
    expect(() => dealProgrammeMember('m', good)).not.toThrow();
    expect(() => dealProgrammeMember('m', { ...good, userId: 'owner_user_id' })).not.toThrow();
  });

  it('refuses anything else, in every argument of every builder, without echoing it', () => {
    for (const bad of hostile) {
      const attempts: (() => unknown)[] = [
        () => dealProgrammeMember(bad, good),
        () => dealProgrammeMember('m', { ...good, tenantId: bad }),
        () => dealProgrammeMember('m', { ...good, programmeId: bad }),
        () => dealProgrammeMember('m', { ...good, userId: bad }),
        () => dealProgrammeMemberJoin(bad, good),
        () => dealProgrammeMemberJoin('m', { ...good, userId: bad }),
        () => dealProgrammeMemberFlag(bad),
      ];
      for (const attempt of attempts) {
        let caught: unknown;
        try {
          attempt();
        } catch (error) {
          caught = error;
        }
        expect(caught, `refused: ${JSON.stringify(bad)}`).toBeInstanceOf(DealMembershipSqlError);
        if (bad !== '') expect((caught as Error).message).not.toContain(bad);
      }
    }
  });

  it('an alias is one identifier, never alias.column', () => {
    expect(() => dealProgrammeMember('a.b', good)).toThrow(DealMembershipSqlError);
    expect(() => dealProgrammeMemberJoin('a.b', good)).toThrow(DealMembershipSqlError);
    expect(() => dealProgrammeMemberFlag('a.b')).toThrow(DealMembershipSqlError);
  });
});
