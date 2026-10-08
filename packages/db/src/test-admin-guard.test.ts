import { describe, expect, it } from 'vitest';
import {
  readTestAdminUsability,
  refuseUsableTestAdminAtBoot,
  TEST_ADMIN_ROLE,
  testAdminUsabilityReasons,
  UsableTestAdminError,
  type CatalogueReader,
} from './test-admin-guard';

/**
 * T-0117 (D-L94): what counts as a usable kasuwa_test_admin, and when the
 * boot check asks. The catalogue is faked here; the integration test reads
 * the real one as kasuwa_app, and the acceptance suite drives the runner.
 */

type Row = Parameters<typeof testAdminUsabilityReasons>[0] & object;

const INERT: Row = {
  rolcanlogin: false,
  rolbypassrls: false,
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  has_members: false,
  is_member: false,
};

/** A reader that answers one row (or none) and records what it was asked. */
function reader(row: Row | undefined): CatalogueReader & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    query: async <R extends Record<string, unknown>>(text: string, values?: unknown[]) => {
      calls.push([text, values]);
      return { rows: (row === undefined ? [] : [row]) as unknown as R[] };
    },
  };
}

describe('testAdminUsabilityReasons', () => {
  it('finds nothing wrong with the inert placeholder, or with no role at all', () => {
    expect(testAdminUsabilityReasons(INERT)).toEqual([]);
    expect(testAdminUsabilityReasons(undefined)).toEqual([]);
  });

  it.each([
    ['rolcanlogin', /LOGIN/u],
    ['rolbypassrls', /BYPASSRLS/u],
    ['rolsuper', /superuser/u],
    ['rolcreaterole', /CREATEROLE/u],
    ['rolcreatedb', /CREATEDB/u],
    ['rolreplication', /REPLICATION/u],
    ['has_members', /member of it/u],
    ['is_member', /member of another role/u],
  ] as const)('refuses %s', (field, reason) => {
    const reasons = testAdminUsabilityReasons({ ...INERT, [field]: true });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(reason);
  });
});

describe('readTestAdminUsability', () => {
  it('asks the catalogue about kasuwa_test_admin by parameter', async () => {
    const fake = reader({ ...INERT, rolcanlogin: true });
    expect(await readTestAdminUsability(fake)).toEqual(['it can log in (LOGIN)']);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.[1]).toEqual([TEST_ADMIN_ROLE]);
    expect(String(fake.calls[0]?.[0])).toMatch(/pg_catalog\.pg_roles/u);
  });

  it('exempts only an ADMIN-only membership held by a SUPERUSER or CREATEROLE role', async () => {
    // T-0117 review M1: ADMIN OPTION lets any other holder grant the role to
    // itself with SET. The integration test proves the catalogue agrees.
    const fake = reader(INERT);
    await readTestAdminUsability(fake);
    const sql = String(fake.calls[0]?.[0]).replace(/\s+/gu, ' ');
    expect(sql).toContain(
      'WHERE m.roleid = r.oid AND (m.inherit_option OR m.set_option ' +
        'OR NOT (holder.rolsuper OR holder.rolcreaterole))',
    );
    // A membership of another role: no exemption at all.
    expect(sql).toContain('WHERE m.member = r.oid) AS is_member');
  });
});

describe('refuseUsableTestAdminAtBoot', () => {
  it.each(['development', 'test'])('does not even ask in %s', async (nodeEnv) => {
    const fake = reader({ ...INERT, rolcanlogin: true, rolbypassrls: true });
    await expect(refuseUsableTestAdminAtBoot(fake, nodeEnv)).resolves.toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it('starts in production when the role is inert or absent', async () => {
    await expect(refuseUsableTestAdminAtBoot(reader(INERT), 'production')).resolves.toBeUndefined();
    await expect(
      refuseUsableTestAdminAtBoot(reader(undefined), 'production'),
    ).resolves.toBeUndefined();
  });

  it('refuses in production when the role can log in or bypass RLS, naming it', async () => {
    const attempt = refuseUsableTestAdminAtBoot(
      reader({ ...INERT, rolcanlogin: true, rolbypassrls: true }),
      'production',
    );
    await expect(attempt).rejects.toBeInstanceOf(UsableTestAdminError);
    await expect(attempt).rejects.toThrow(/kasuwa_test_admin/u);
    await expect(attempt).rejects.toThrow(/NODE_ENV=production/u);
    await expect(attempt).rejects.toThrow(/LOGIN.*BYPASSRLS/u);
  });

  it('treats any NODE_ENV other than development and test as enforced', async () => {
    await expect(
      refuseUsableTestAdminAtBoot(reader({ ...INERT, rolcanlogin: true }), 'staging'),
    ).rejects.toBeInstanceOf(UsableTestAdminError);
  });

  it('never names a password or a connection string', () => {
    const message = new UsableTestAdminError('Refusing to start', 'production', ['x']).message;
    expect(message).not.toMatch(/_dev\b|postgres(?:ql)?:\/\//u);
  });
});
