import type * as Pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionTenant } from './provision-tenant';
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
  failOn: string | null;
  ended: boolean;
}

const state = vi.hoisted((): FakeState => ({ sent: [], failOn: null, ended: false }));

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
      const params = (typeof arg === 'string' ? values : (arg as { values?: unknown[] }).values) ?? [];
      state.sent.push(text);
      if (state.failOn !== null && text.includes(state.failOn)) {
        throw new Error('injected failure');
      }
      if (text.includes("set_config('app.tenant_id'")) {
        this.gucs = {
          tenant_id: String(params[0]),
          user_id: String(params[1]),
          programme_ids: String(params[2]),
        };
        return { rows: [{}], rowCount: 1 };
      }
      if (text.includes("current_setting('app.tenant_id'")) {
        return { rows: [{ ...this.gucs }], rowCount: 1 };
      }
      if (text.includes('SELECT 1 FROM "user"')) {
        return { rows: [{}], rowCount: 1 };
      }
      if (text.includes('FROM business_unit')) {
        return { rows: [{ id: 'bu' }], rowCount: 1 };
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
  state.failOn = null;
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
