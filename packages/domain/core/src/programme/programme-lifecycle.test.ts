import type { TenantTx } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';
import {
  ArchiveConfirmationMismatchError,
  archiveProgramme,
  BusinessUnitNotFoundError,
  createProgramme,
  getProgrammeArchivePreview,
} from './programme-lifecycle';
import {
  DuplicateProgrammeNameError,
  toProgrammeStatus,
  UnknownProgrammeStatusError,
} from './programme.repository';

/**
 * T-0029 lifecycle logic against a scripted TenantTx — no database. What the
 * SQL does under RLS is the acceptance suite's job; this pins the decisions
 * the code makes around it (D-L46).
 */

const TENANT = '11111111-0000-4000-8000-00000000000a';
const USER = '11111111-0000-4000-8000-000000000001';
const OWN = '11111111-0000-4000-8000-0000000c0001';
const SIBLING = '11111111-0000-4000-8000-0000000c0002';
const BU = '11111111-0000-4000-8000-0000000b0001';
const AT = '2026-10-03T09:00:00.123000Z';

interface Call {
  text: string;
  values: readonly unknown[];
}

type Responder = (text: string, values: readonly unknown[]) => unknown[] | Error;

function fakeTx(respond: Responder): { tx: TenantTx; calls: Call[] } {
  const calls: Call[] = [];
  const tx: TenantTx = {
    session: { tenantId: TENANT, userId: USER, programmeIds: [OWN] },
    query: async <T>(text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      const result = respond(text, values);
      if (result instanceof Error) {
        throw result;
      }
      return result as T[];
    },
  } as TenantTx;
  return { tx, calls };
}

function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error('db said something'), { code, constraint });
}

function programmeRow(status: string, updatedAt = AT) {
  return {
    id: OWN,
    business_unit_id: BU,
    name: 'Bank X Collections',
    client_name: null,
    is_default: false,
    status,
    updated_at_text: updatedAt,
    created_at_cursor: AT,
  };
}

const creating: Responder = (text) => {
  if (text.includes('FROM business_unit')) return [{ id: BU }];
  if (text.includes('clock_timestamp')) return [{ at: AT }];
  return [];
};

describe('createProgramme (T-0029, D-L46)', () => {
  it('inserts without RETURNING, starts active, and makes the session user — only — a member', async () => {
    const { tx, calls } = fakeTx(creating);
    const created = await createProgramme(tx, {
      name: 'Pesa Merchant Onboarding',
      clientName: 'Pesa Point',
      businessUnitId: BU,
    });

    expect(created).toMatchObject({
      name: 'Pesa Merchant Onboarding',
      clientName: 'Pesa Point',
      businessUnitId: BU,
      status: 'active',
      isDefault: false,
      version: Date.UTC(2026, 9, 3, 9, 0, 0, 123),
    });

    const insert = calls.find((call) => call.text.includes('INSERT INTO programme'));
    expect(insert?.text).not.toMatch(/RETURNING/iu);
    expect(insert?.values.slice(1, 3)).toEqual([TENANT, BU]);
    expect(insert?.values[0]).toBe(created.id);
    // created_at and updated_at are the transaction-clock instant read first:
    // 0015's creation marker relies on created_at never predating the
    // transaction (xid-wraparound guard). Not testable against a real
    // wraparound; this pins the value the policy depends on.
    expect(insert?.text).toMatch(/\$8::timestamptz, \$8::timestamptz/u);
    expect(insert?.values[7]).toBe(AT);

    const membership = calls.find((call) => call.text.includes('INSERT INTO user_programme'));
    // The creator holds the tenant's `admin` set in what they made (T-0032).
    expect(membership?.values).toEqual([USER, created.id, TENANT, 'admin']);
    expect(calls.filter((call) => call.text.includes('INSERT')).length).toBe(2);
  });

  it('gives the new programme its default pipeline, in the same transaction, for the session tenant (T-0106 R9)', async () => {
    const { tx, calls } = fakeTx((text, values) => {
      // The repair finds the programme just created, and only that one.
      if (text.includes('FROM programme p')) return [{ id: values[1] }];
      return creating(text, values);
    });
    const created = await createProgramme(tx, { name: 'Pesa Field Sales', businessUnitId: BU });

    const lookup = calls.find((call) => call.text.includes('FROM programme p'));
    expect(lookup?.values).toEqual([TENANT, created.id]);
    const pipeline = calls.find((call) => call.text.includes('INSERT INTO pipeline '));
    expect(pipeline?.values.slice(1)).toEqual([TENANT, created.id, 'B2B sales']);
    for (const table of ['pipeline_stage', 'pipeline_stage_requirement', 'pipeline_stage_transition']) {
      const insert = calls.find((call) => call.text.includes(`INSERT INTO ${table}\n`));
      expect(insert?.values.slice(0, 3), table).toEqual([TENANT, created.id, pipeline?.values[0]]);
    }
    // After the membership: the pipeline is written once the programme exists.
    const order = calls.map((call) => call.text);
    expect(order.findIndex((text) => text.includes('INSERT INTO pipeline '))).toBeGreaterThan(
      order.findIndex((text) => text.includes('INSERT INTO user_programme')),
    );
  });

  it('checks the business unit within the session tenant and inserts nothing when it is not there', async () => {
    const { tx, calls } = fakeTx((text) => (text.includes('FROM business_unit') ? [] : []));
    await expect(createProgramme(tx, { name: 'x', businessUnitId: BU })).rejects.toBeInstanceOf(
      BusinessUnitNotFoundError,
    );
    expect(calls[0]?.values).toEqual([BU, TENANT]);
    expect(calls.some((call) => call.text.includes('INSERT'))).toBe(false);
  });

  it('turns the tenant name constraint into DuplicateProgrammeNameError, with no database text', async () => {
    const { tx, calls } = fakeTx((text, values) =>
      text.includes('INSERT INTO programme')
        ? pgError('23505', 'programme_tenant_id_name_key')
        : creating(text, values),
    );
    const error = await createProgramme(tx, { name: 'Taken', businessUnitId: BU }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DuplicateProgrammeNameError);
    expect(String((error as Error).message)).not.toContain('programme_tenant_id_name_key');
    expect(calls.some((call) => call.text.includes('user_programme'))).toBe(false);
  });

  it('treats a business unit that fails the composite FK as not found', async () => {
    const { tx } = fakeTx((text, values) =>
      text.includes('INSERT INTO programme')
        ? pgError('23503', 'programme_bu_same_tenant_fk')
        : creating(text, values),
    );
    await expect(createProgramme(tx, { name: 'x', businessUnitId: BU })).rejects.toBeInstanceOf(
      BusinessUnitNotFoundError,
    );
  });
});

describe('getProgrammeArchivePreview (T-0029)', () => {
  it('is null for a programme outside the session, without counting anything', async () => {
    const { tx, calls } = fakeTx(() => []);
    expect(await getProgrammeArchivePreview(tx, SIBLING)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('counts memberships and reports the fixed fields', async () => {
    const { tx, calls } = fakeTx((text) =>
      text.includes('FROM user_programme') ? [{ n: 3 }] : [programmeRow('active')],
    );
    expect(await getProgrammeArchivePreview(tx, OWN)).toEqual({
      agentsLosingAccess: 3,
      openInteractionsBecomingReadOnly: 0,
      retentionSummary: null,
      portalUsersSignedOut: 0,
      restorableUntilDays: 30,
    });
    expect(calls.every((call) => !/UPDATE programme|INSERT|DELETE/u.test(call.text))).toBe(true);
  });
});

describe('archiveProgramme (T-0029, D-L46)', () => {
  it('is null for an unreachable programme before the confirmation is compared', async () => {
    const { tx } = fakeTx(() => []);
    expect(await archiveProgramme(tx, SIBLING, 'anything')).toBeNull();
  });

  it('refuses anything but the exact name, and writes nothing', async () => {
    for (const confirmation of ['bank x collections', 'Bank X Collections ', 'archive', '']) {
      const { tx, calls } = fakeTx(() => [{ name: 'Bank X Collections', status: 'active' }]);
      await expect(archiveProgramme(tx, OWN, confirmation)).rejects.toBeInstanceOf(
        ArchiveConfirmationMismatchError,
      );
      expect(calls.some((call) => call.text.includes('UPDATE programme'))).toBe(false);
    }
  });

  it('sets status archived and deletes nothing', async () => {
    const { tx, calls } = fakeTx((text) => {
      if (text.includes('FOR UPDATE')) return [{ name: 'Bank X Collections', status: 'active' }];
      return [programmeRow('archived', '2026-10-03T09:00:01.000000Z')];
    });
    const archived = await archiveProgramme(tx, OWN, 'Bank X Collections');
    expect(archived?.status).toBe('archived');
    expect(calls.filter((call) => call.text.includes('UPDATE programme')).length).toBe(1);
    expect(calls.some((call) => /DELETE/u.test(call.text))).toBe(false);
  });

  it('is idempotent: an archived programme is returned without another write', async () => {
    const { tx, calls } = fakeTx((text) => {
      if (text.includes('FOR UPDATE')) return [{ name: 'Bank X Collections', status: 'archived' }];
      return [programmeRow('archived')];
    });
    const again = await archiveProgramme(tx, OWN, 'Bank X Collections');
    expect(again?.status).toBe('archived');
    expect(calls.some((call) => call.text.includes('UPDATE programme'))).toBe(false);
  });
});

describe('toProgrammeStatus', () => {
  it('admits exactly the published values', () => {
    for (const status of ['active', 'paused', 'draft', 'archived']) {
      expect(toProgrammeStatus(status)).toBe(status);
    }
    for (const status of ['deleted', 'ACTIVE', '']) {
      expect(() => toProgrammeStatus(status)).toThrow(UnknownProgrammeStatusError);
    }
  });
});
