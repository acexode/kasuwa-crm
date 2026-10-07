import type * as Pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstAdminGrantMissingError, provisionTenant } from './provision-tenant';
import { PROVISIONING_SAVEPOINT } from './savepoint-pool';

/**
 * provisionTenant is ONE transaction: a failure anywhere, including deep
 * inside the tenant transaction's population step, must roll back everything,
 * the bootstrap tenant and user rows included.
 *
 * No database here (unit project). `pg.Client` is replaced by a fake that
 * records every statement, answers the few reads the code depends on, and can
 * be told to fail on a chosen statement. The SQL itself is proved against
 * real Postgres by the T-0015 acceptance suite; this file proves the
 * transaction control around it. (`vi.mock` is hoisted above the imports.)
 */

interface FakeState {
  sent: string[];
  /** Parameters of each statement, index-aligned with `sent`. */
  params: unknown[][];
  failOn: string | null;
  /** What the first admin's grant lookup answers; null = no set granted. */
  grantKey: string | null;
  ended: boolean;
}

const state = vi.hoisted((): FakeState => ({
  sent: [],
  params: [],
  failOn: null,
  grantKey: 'admin',
  ended: false,
}));

vi.mock('pg', async (importOriginal) => {
  const original = await importOriginal<typeof Pg>();

  class FakeClient {
    private gucs: Record<string, string> = {};

    async connect(): Promise<void> {}

    async end(): Promise<void> {
      state.ended = true;
    }

    async query(arg: unknown, values?: unknown[]) {
      const text = typeof arg === 'string' ? arg : (arg as { text: string }).text;
      const params =
        (typeof arg === 'string' ? values : (arg as { values?: unknown[] }).values) ?? [];
      state.sent.push(text);
      state.params.push(params);
      if (state.failOn !== null && text.includes(state.failOn)) {
        throw new Error('injected failure');
      }
      if (text.includes("set_config('app.tenant_id'")) {
        this.gucs = {
          tenant_id: String(params[0]),
          user_id: String(params[1]),
          programme_ids: String(params[2]),
        };
        return { rows: [{ role_intact: true }], rowCount: 1 };
      }
      if (text.includes("current_setting('app.tenant_id'")) {
        // role_intact: assertScopeIntact also checks no role was switched (T-0045).
        return { rows: [{ ...this.gucs, role_intact: true }], rowCount: 1 };
      }
      if (text.includes('SELECT 1 FROM "user"')) {
        return { rows: [{}], rowCount: 1 };
      }
      if (text.includes('FROM business_unit')) {
        return { rows: [{ id: 'bu' }], rowCount: 1 };
      }
      if (text.includes('JOIN permission_set')) {
        return state.grantKey === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ key: state.grantKey }], rowCount: 1 };
      }
      if (text.includes('clock_timestamp()')) {
        return { rows: [{ at: '2026-10-03T10:00:00.000000Z' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  }

  return { ...original, Client: FakeClient, default: { ...original, Client: FakeClient } };
});

const options = {
  connectionString: 'postgres://kasuwa_migrator@127.0.0.1:5432/kasuwa',
  slug: 'harmattan',
  name: 'Harmattan Collections',
  adminEmail: 'founder@harmattan.test',
  adminDisplayName: 'Amina Lawal',
};

beforeEach(() => {
  state.sent = [];
  state.params = [];
  state.failOn = null;
  state.grantKey = 'admin';
  state.ended = false;
});

describe('provisionTenant transaction control', () => {
  it('commits once, at the very end, after releasing the tenant savepoint', async () => {
    await provisionTenant(options);
    expect(state.sent[0]).toBe('BEGIN');
    expect(state.sent.at(-1)).toBe('COMMIT');
    expect(state.sent.filter((s) => s === 'COMMIT')).toHaveLength(1);
    expect(state.sent).toContain(`SAVEPOINT ${PROVISIONING_SAVEPOINT}`);
    expect(state.sent).toContain(`RELEASE SAVEPOINT ${PROVISIONING_SAVEPOINT}`);
    expect(state.sent).not.toContain('ROLLBACK');
    expect(state.ended).toBe(true);
  });

  for (const failOn of [
    'INSERT INTO business_unit',
    'INSERT INTO user_credential',
    'INSERT INTO permission_set',
    'INSERT INTO object_def',
    'INSERT INTO field_def',
    'INSERT INTO programme',
    'INSERT INTO user_programme',
  ]) {
    it(`rolls back everything, bootstrap rows included, when population fails at: ${failOn}`, async () => {
      state.failOn = failOn;
      await expect(provisionTenant(options)).rejects.toThrow('injected failure');

      // The bootstrap rows were written in the outer transaction...
      const tenantAt = state.sent.findIndex((s) => s.startsWith('INSERT INTO tenant'));
      const userAt = state.sent.findIndex((s) => s.startsWith('INSERT INTO "user"'));
      expect(tenantAt).toBeGreaterThan(0);
      expect(userAt).toBeGreaterThan(tenantAt);

      // ...and nothing committed: the savepoint is rolled back, then the outer
      // transaction, which takes the tenant and user rows with it.
      expect(state.sent).not.toContain('COMMIT');
      expect(state.sent).not.toContain(`RELEASE SAVEPOINT ${PROVISIONING_SAVEPOINT}`);
      expect(state.sent).toContain(`ROLLBACK TO SAVEPOINT ${PROVISIONING_SAVEPOINT}`);
      expect(state.sent.at(-1)).toBe('ROLLBACK');
      expect(state.ended).toBe(true);
    });
  }

  it('rolls back when a bootstrap insert fails, before any tenant transaction opens', async () => {
    state.failOn = 'INSERT INTO "user"';
    await expect(provisionTenant(options)).rejects.toThrow('injected failure');
    expect(state.sent).not.toContain('COMMIT');
    expect(state.sent).not.toContain(`SAVEPOINT ${PROVISIONING_SAVEPOINT}`);
    expect(state.sent.at(-1)).toBe('ROLLBACK');
  });
});

describe('the first admin is an administrator (D-L53, T-0032)', () => {
  const indexOf = (prefix: string) => state.sent.findIndex((s) => s.trimStart().startsWith(prefix));

  it('writes "user".is_tenant_admin = true on the migrator connection, outside the tenant transaction', async () => {
    await provisionTenant(options);
    const userAt = indexOf('INSERT INTO "user"');
    expect(state.sent[userAt]).toMatch(/is_tenant_admin\)\s*VALUES \(.*'active', true\)/s);
    expect(userAt).toBeLessThan(state.sent.indexOf(`SAVEPOINT ${PROVISIONING_SAVEPOINT}`));
  });

  it('seeds the permission sets before createProgramme enrols the admin with the admin set', async () => {
    await provisionTenant(options);
    const lastSetAt = state.sent.findLastIndex((s) =>
      s.trimStart().startsWith('INSERT INTO permission_set'),
    );
    const programmeAt = indexOf('INSERT INTO programme');
    const membershipAt = indexOf('INSERT INTO user_programme');
    expect(
      state.params
        .filter((_, i) => state.sent[i]?.trimStart().startsWith('INSERT INTO permission_set'))
        .map((p) => p[2]),
    ).toContain('admin');
    expect(lastSetAt).toBeGreaterThan(-1);
    expect(lastSetAt).toBeLessThan(programmeAt);
    expect(state.sent[membershipAt]).toContain('permission_set_id');
    expect(state.params[membershipAt]).toContain('admin');
  });

  it('rolls everything back rather than provision a tenant whose admin holds no admin set', async () => {
    for (const grantKey of [null, 'agent']) {
      state.sent = [];
      state.params = [];
      state.grantKey = grantKey;
      await expect(provisionTenant(options)).rejects.toBeInstanceOf(FirstAdminGrantMissingError);
      expect(state.sent).not.toContain('COMMIT');
      expect(state.sent.at(-1)).toBe('ROLLBACK');
    }
  });
});

describe('the standard object definitions (T-0053)', () => {
  const indexOf = (prefix: string) => state.sent.findIndex((s) => s.trimStart().startsWith(prefix));

  it('are written inside the tenant transaction, for the new tenant, before COMMIT', async () => {
    await provisionTenant(options);
    const savepointAt = state.sent.indexOf(`SAVEPOINT ${PROVISIONING_SAVEPOINT}`);
    const releaseAt = state.sent.indexOf(`RELEASE SAVEPOINT ${PROVISIONING_SAVEPOINT}`);
    const objectsAt = indexOf('INSERT INTO object_def');
    const fieldsAt = indexOf('INSERT INTO field_def');
    expect(objectsAt).toBeGreaterThan(savepointAt);
    expect(fieldsAt).toBeGreaterThan(objectsAt);
    expect(fieldsAt).toBeLessThan(releaseAt);

    // The tenant id is the one the bootstrap row was created with.
    const tenantId = state.params[indexOf('INSERT INTO tenant')]?.[0];
    expect(state.params[objectsAt]?.[0]).toBe(tenantId);
    expect(state.params[fieldsAt]?.[0]).toBe(tenantId);
    expect(state.params[objectsAt]?.[2]).toEqual(['contact', 'account', 'activity']);
  });
});
