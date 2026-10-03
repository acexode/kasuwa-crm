import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  AuditProgrammeOutOfScopeError,
  change,
  changedFields,
  InvalidAuditEventError,
  recordAuditEvent,
  redactedChange,
  type AuditEventInput,
} from './audit-writer';

// Invented ids, shaped like the seed's and naming nothing real.
const TENANT = '99999999-0000-4000-8000-000000000001';
const USER = '99999999-0000-4000-8000-000000000002';
const IN_SCOPE = '99999999-0000-4000-8000-000000000003';
const OUT_OF_SCOPE = '99999999-0000-4000-8000-000000000004';
const ROLE = '99999999-0000-4000-8000-000000000005';

function fakeTx(): { tx: TenantTx; calls: { text: string; values: readonly unknown[] }[] } {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const tx: TenantTx = {
    session: { tenantId: TENANT, userId: USER, programmeIds: [IN_SCOPE] },
    query: <T>(text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return Promise.resolve([] as T[]);
    },
  };
  return { tx, calls };
}

const roleEvent: AuditEventInput = {
  action: 'updated',
  objectType: 'role',
  objectId: ROLE,
  objectLabel: 'Shift Lead',
  programmeId: null,
  changes: [change('name', 'Team Lead', 'Shift Lead')],
};

describe('changedFields', () => {
  it('keeps only fields whose value moved', () => {
    expect(
      changedFields([
        ['name', 'A', 'B'],
        ['parentRoleId', null, null],
        ['clientName', 'X', 'X'],
      ]),
    ).toEqual([{ field: 'name', before: 'A', after: 'B', redacted: false }]);
  });

  it('treats null to a value, and a value to null, as changes', () => {
    expect(
      changedFields([
        ['parentRoleId', null, ROLE],
        ['clientName', 'Bank X', null],
      ]),
    ).toHaveLength(2);
  });
});

describe('redactedChange', () => {
  it('carries the field and no value', () => {
    expect(redactedChange('filters.sourceIpPrefix')).toEqual({
      field: 'filters.sourceIpPrefix',
      before: null,
      after: null,
      redacted: true,
    });
  });
});

describe('recordAuditEvent', () => {
  it('binds tenant and actor from the session, never from the input', async () => {
    const { tx, calls } = fakeTx();
    const id = await recordAuditEvent(tx, roleEvent);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.text).toContain('INSERT INTO audit_event');
    expect(call?.text).toContain(`'user'`);
    expect(call?.values[0]).toBe(id);
    expect(call?.values[1]).toBe(TENANT);
    expect(call?.values[2]).toBe(USER);
    expect(JSON.parse(String(call?.values[8]))).toEqual(roleEvent.changes);
  });

  it('refuses a programme outside the session scope before touching the database', async () => {
    const { tx, calls } = fakeTx();
    await expect(
      recordAuditEvent(tx, { ...roleEvent, objectType: 'programme', programmeId: OUT_OF_SCOPE }),
    ).rejects.toBeInstanceOf(AuditProgrammeOutOfScopeError);
    expect(calls).toEqual([]);
  });

  it('accepts a programme the session reaches', async () => {
    const { tx, calls } = fakeTx();
    await recordAuditEvent(tx, { ...roleEvent, objectType: 'programme', programmeId: IN_SCOPE });
    expect(calls[0]?.values[7]).toBe(IN_SCOPE);
  });

  it('refuses a redacted change that carries a value, as a server error and not a 400', async () => {
    const { tx, calls } = fakeTx();
    const leaky = { field: 'phone', before: null, after: 'x', redacted: true };
    const attempt = recordAuditEvent(tx, { ...roleEvent, changes: [leaky] });
    await expect(attempt).rejects.toBeInstanceOf(InvalidAuditEventError);
    await expect(attempt).rejects.not.toHaveProperty('issues');
    expect(calls).toEqual([]);
  });

  it('refuses an object type nobody has agreed on', async () => {
    const { tx } = fakeTx();
    await expect(
      recordAuditEvent(tx, { ...roleEvent, objectType: 'contact' as 'role' }),
    ).rejects.toBeInstanceOf(InvalidAuditEventError);
  });

  it('refuses extra keys, so personal data cannot arrive as "one more field"', async () => {
    const { tx } = fakeTx();
    const withEmail = { ...roleEvent, actorEmail: 'someone@example.test' } as AuditEventInput;
    await expect(recordAuditEvent(tx, withEmail)).rejects.toBeInstanceOf(InvalidAuditEventError);
  });
});
