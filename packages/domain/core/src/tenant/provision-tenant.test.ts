import { describe, expect, it } from 'vitest';
import {
  assertProvisioningTarget,
  assertValidTenantSlug,
  buildTenantProvisionedAuditEvent,
  InvalidProvisioningInputError,
  InvalidRegionError,
  InvalidTenantSlugError,
  newSetupCredential,
  provisionTenant,
  RegionNotServedError,
  resolveRegion,
} from './provision-tenant';

const quiet = () => undefined;

describe('assertProvisioningTarget', () => {
  it('lets every spelling of a local host through without a word', () => {
    const logs: string[] = [];
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      assertProvisioningTarget(`postgres://m@${host}:5432/kasuwa`, false, (m) => logs.push(m));
    }
    expect(logs).toEqual([]);
  });

  it('refuses a non-local host without the opt-in, naming the switch', () => {
    for (const host of ['db.staging.internal', '10.0.0.5', 'localhost.evil.test']) {
      expect(() =>
        assertProvisioningTarget(`postgres://m@${host}:5432/kasuwa`, false, quiet),
      ).toThrow(/non-local.*(allowNonLocalDatabase|--allow-non-local)/s);
    }
  });

  it('lets a non-local host through with the opt-in, and logs it loudly with the host', () => {
    const logs: string[] = [];
    assertProvisioningTarget('postgres://m@db.prod.internal/kasuwa', true, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/non-local/i);
    expect(logs[0]).toContain('db.prod.internal');
  });

  it('refuses a malformed or non-postgres connection string without echoing it', () => {
    for (const bad of ['not a url', 'mysql://u:hunter2@localhost/x']) {
      let caught: unknown;
      try {
        assertProvisioningTarget(bad, false, quiet);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidProvisioningInputError);
      expect((caught as Error).message).not.toContain('hunter2');
    }
  });
});

describe('resolveRegion', () => {
  it('defaults to ZA in za-1 when omitted (D-P2)', () => {
    expect(resolveRegion(undefined)).toEqual({ region: 'ZA', regionCell: 'za-1' });
    expect(resolveRegion('ZA')).toEqual({ region: 'ZA', regionCell: 'za-1' });
  });

  it('refuses anything that is not a region code', () => {
    for (const region of ['Lagos', 'EU', '', 'za-1', 'za', null, 7]) {
      expect(() => resolveRegion(region)).toThrow(InvalidRegionError);
    }
  });

  it('refuses NG and KE until their cells exist, rather than mislabelling za-1 data', () => {
    expect(() => resolveRegion('NG')).toThrow(RegionNotServedError);
    expect(() => resolveRegion('KE')).toThrow(RegionNotServedError);
  });
});

describe('assertValidTenantSlug', () => {
  it('returns a valid slug and refuses an invalid one with a typed error', () => {
    expect(assertValidTenantSlug('sahel-bpo')).toBe('sahel-bpo');
    expect(() => assertValidTenantSlug('admin')).toThrow(InvalidTenantSlugError);
    expect(() => assertValidTenantSlug(42)).toThrow(InvalidTenantSlugError);
  });
});

describe('newSetupCredential', () => {
  it('is long, URL-safe and different every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const credential = newSetupCredential();
      expect(credential).toMatch(/^[A-Za-z0-9_-]{32}$/);
      seen.add(credential);
    }
    expect(seen.size).toBe(50);
  });
});

describe('buildTenantProvisionedAuditEvent', () => {
  it('matches the audit_event columns, carries ids only, and redacts the admin email', () => {
    const event = buildTenantProvisionedAuditEvent({
      tenantId: 't-1',
      slug: 'harmattan',
      region: 'ZA',
      regionCell: 'za-1',
      businessUnitId: 'bu-1',
      programmeId: 'p-1',
      adminUserId: 'u-1',
    });
    expect(event).toMatchObject({
      tenantId: 't-1',
      actorKind: 'system',
      actorUserId: null,
      action: 'created',
      objectType: 'tenant',
      objectId: 't-1',
      objectLabel: 'harmattan',
      programmeId: null,
    });
    expect(event.changes.find((c) => c.field === 'region_cell')?.after).toBe('za-1');
    expect(event.changes.find((c) => c.field === 'admin_email')).toEqual({
      field: 'admin_email',
      before: null,
      after: null,
      redacted: true,
    });
    for (const change of event.changes) {
      expect(change.after === null || typeof change.after === 'string').toBe(true);
    }
  });
});

describe('provisionTenant, before it touches a database', () => {
  const base = {
    slug: 'harmattan',
    name: 'Harmattan Collections',
    adminEmail: 'founder@harmattan.test',
    adminDisplayName: 'Amina Lawal',
  };

  it('refuses a remote host before opening a connection', async () => {
    await expect(
      provisionTenant({ ...base, connectionString: 'postgres://m@db.staging.internal/kasuwa' }),
    ).rejects.toThrow(/non-local/i);
  });

  it('refuses bad input before opening a connection', async () => {
    // Port 1 on loopback: if validation did not stop it, connect would fail
    // with ECONNREFUSED instead of the typed error asserted here.
    const local = 'postgres://m@127.0.0.1:1/kasuwa';
    await expect(
      provisionTenant({ ...base, connectionString: local, region: 'EU' as never }),
    ).rejects.toBeInstanceOf(InvalidRegionError);
    await expect(
      provisionTenant({ ...base, connectionString: local, slug: 'www' }),
    ).rejects.toBeInstanceOf(InvalidTenantSlugError);
    await expect(
      provisionTenant({ ...base, connectionString: local, adminEmail: 'not-an-email' }),
    ).rejects.toBeInstanceOf(InvalidProvisioningInputError);
  });

  it('never puts the admin email in a validation error', async () => {
    const email = 'founder@harmattan';
    await expect(
      provisionTenant({
        ...base,
        connectionString: 'postgres://m@127.0.0.1:1/kasuwa',
        adminEmail: email,
      }),
    ).rejects.toThrow(/adminEmail/);
    await provisionTenant({
      ...base,
      connectionString: 'postgres://m@127.0.0.1:1/kasuwa',
      adminEmail: email,
    }).catch((error: Error) => expect(error.message).not.toContain(email));
  });
});
