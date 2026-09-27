import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadMigrations, runMigrations } from './migrate';

/**
 * Migration runner invariants, against a real Postgres.
 *
 * Migrations are the highest-consequence, least-reversible thing in the repo:
 * Addendum A1 section 3.4 puts them behind a reviewer for that reason. These
 * tests cover the two properties that make a reviewer's job possible — that
 * re-running is a no-op, and that an already-applied migration cannot be
 * quietly edited.
 */
describe('migration runner', () => {
  let migrationUrl: string;

  beforeAll(() => {
    migrationUrl = inject('migrationUrl');
  });

  it('is idempotent: a second run applies nothing', async () => {
    const result = await runMigrations({ connectionString: migrationUrl });
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied.length).toBeGreaterThan(0);
  });

  it('records a checksum for every applied migration', async () => {
    const client = new Client({ connectionString: migrationUrl });
    await client.connect();
    try {
      const recorded = await client.query<{ id: string; checksum: string }>(
        'SELECT id, checksum FROM _kasuwa_migration ORDER BY id',
      );
      const onDisk = loadMigrations();

      expect(recorded.rows.map((row) => row.id)).toEqual(onDisk.map((migration) => migration.id));
      for (const migration of onDisk) {
        const row = recorded.rows.find((candidate) => candidate.id === migration.id);
        expect(row?.checksum).toBe(migration.checksum);
      }
    } finally {
      await client.end();
    }
  });

  it('refuses to proceed when an applied migration has been edited', async () => {
    const client = new Client({ connectionString: migrationUrl });
    await client.connect();
    const target = loadMigrations()[0];
    expect(target).toBeDefined();

    try {
      await client.query('UPDATE _kasuwa_migration SET checksum = $1 WHERE id = $2', [
        'tampered',
        target!.id,
      ]);

      await expect(runMigrations({ connectionString: migrationUrl })).rejects.toThrow(
        /contents have changed/,
      );
    } finally {
      // Restore, or every later test in the run inherits the tampered state.
      await client.query('UPDATE _kasuwa_migration SET checksum = $1 WHERE id = $2', [
        target!.checksum,
        target!.id,
      ]);
      await client.end();
    }
  });

  it('applies migrations in filename order', () => {
    const ids = loadMigrations().map((migration) => migration.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('session context functions', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: inject('databaseUrl') });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('returns null for an unset tenant, which denies rather than matches', async () => {
    const result = await client.query<{ tenant: string | null }>(
      'SELECT app.current_tenant_id() AS tenant',
    );
    expect(result.rows[0]?.tenant).toBeNull();
  });

  it('treats an empty string as unset rather than raising', async () => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      const result = await client.query<{ tenant: string | null }>(
        'SELECT app.current_tenant_id() AS tenant',
      );
      expect(result.rows[0]?.tenant).toBeNull();
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('returns an empty array for an unset programme list', async () => {
    const result = await client.query<{ ids: string[] }>(
      'SELECT app.current_programme_ids() AS ids',
    );
    expect(result.rows[0]?.ids).toEqual([]);
  });

  it('scopes settings to the transaction, so a pooled connection cannot leak them', async () => {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.tenant_id', '11111111-0000-4000-8000-000000000001', true)",
    );
    const inside = await client.query<{ tenant: string | null }>(
      'SELECT app.current_tenant_id() AS tenant',
    );
    expect(inside.rows[0]?.tenant).not.toBeNull();
    await client.query('ROLLBACK');

    const outside = await client.query<{ tenant: string | null }>(
      'SELECT app.current_tenant_id() AS tenant',
    );
    expect(outside.rows[0]?.tenant).toBeNull();
  });
});
