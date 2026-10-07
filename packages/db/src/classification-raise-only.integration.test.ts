import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { TENANT_A } from './fixtures';
import { createPool } from './pool';

/**
 * Migration 0029's raise-only guard on a standard field's classification,
 * beyond what the T-0102 acceptance suite pins (D-P25, D-L89):
 *
 *   - it judges the row AS STORED: a BEFORE trigger that rewrites
 *     NEW.classification downward (one sorting after any name 0029 could have
 *     picked) is still caught. This is why the guard is an AFTER trigger;
 *   - a MERGE that lowers is refused like an UPDATE;
 *   - an unranked value fails closed: with the CHECK dropped (the drift the
 *     guard cannot prevent), a standard field still cannot move to a value
 *     the scale does not place, while a custom field can;
 *   - the documented way out works, and only as stated: a migration (the
 *     table owner) disables the trigger by name in its own transaction,
 *     lowers, and re-enables it; 0025's guards stay on throughout;
 *   - the guard reads no table: it is not SECURITY DEFINER and its
 *     search_path is pinned.
 *
 * Everything runs as kasuwa_migrator (the table owner, and refused like any
 * other role) and rolls back.
 */

const RAISE_ONLY = 'field_def_classification_raise_only';

interface Refusal {
  code: string;
  constraint: string | undefined;
}

function refusalOf(error: unknown): Refusal {
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return {
    code: typeof code === 'string' ? code : String(error),
    constraint: typeof constraint === 'string' ? constraint : undefined,
  };
}

/** Runs one statement under a savepoint; resolves to its row count or its refusal. */
async function attempt(
  client: PoolClient,
  sql: string,
  values: unknown[] = [],
): Promise<number | Refusal> {
  await client.query('SAVEPOINT attempt');
  try {
    const result = await client.query(sql, values);
    await client.query('RELEASE SAVEPOINT attempt');
    return result.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT attempt');
    return refusalOf(error);
  }
}

describe('classification raise-only guard (0029)', () => {
  let migrator: Pool;

  /** Runs `work` in one migrator transaction that always rolls back. */
  async function inRollback(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await migrator.connect();
    try {
      await client.query('BEGIN');
      await work(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  async function standardField(
    client: PoolClient,
    objectApi: string,
    fieldApi: string,
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
        WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3 AND NOT f.is_custom`,
      [TENANT_A, objectApi, fieldApi],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error(`tenant A has no standard ${objectApi}.${fieldApi}`);
    return id;
  }

  async function classificationOf(client: PoolClient, id: string): Promise<string | undefined> {
    const result = await client.query<{ classification: string }>(
      'SELECT classification FROM field_def WHERE id = $1',
      [id],
    );
    return result.rows[0]?.classification;
  }

  beforeAll(() => {
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await migrator.end();
  });

  it('judges the stored row: a later BEFORE trigger that lowers NEW is still refused', async () => {
    await inRollback(async (client) => {
      const phones = await standardField(client, 'contact', 'phones');
      await client.query(`
        CREATE FUNCTION app.t0102_lower_on_label() RETURNS trigger
          LANGUAGE plpgsql SET search_path = pg_catalog
        AS $$ BEGIN NEW.classification := 'none'; RETURN NEW; END; $$`);
      // "zz" sorts after every trigger name on field_def: it fires last of
      // the BEFORE triggers, so a BEFORE guard could not have seen its change.
      await client.query(`
        CREATE TRIGGER field_def_zz_t0102_lower BEFORE UPDATE ON field_def
          FOR EACH ROW WHEN (NEW.label = 'T0102 lower me')
          EXECUTE FUNCTION app.t0102_lower_on_label()`);

      expect(
        await attempt(client, `UPDATE field_def SET label = 'T0102 lower me' WHERE id = $1`, [
          phones,
        ]),
      ).toEqual({ code: '23514', constraint: RAISE_ONLY });
      expect(await classificationOf(client, phones)).toBe('pii');
    });
  });

  it('refuses a MERGE that lowers, and lets one that raises through', async () => {
    await inRollback(async (client) => {
      const emails = await standardField(client, 'contact', 'emails');
      const merge = (to: string) =>
        attempt(
          client,
          `MERGE INTO field_def f
           USING (SELECT $1::uuid AS id, $2::text AS classification) s ON f.id = s.id
           WHEN MATCHED THEN UPDATE SET classification = s.classification`,
          [emails, to],
        );
      expect(await merge('none')).toEqual({ code: '23514', constraint: RAISE_ONLY });
      expect(await classificationOf(client, emails)).toBe('pii');
      expect(await merge('sensitive')).toBe(1);
      expect(await classificationOf(client, emails)).toBe('sensitive');
    });
  });

  it('fails closed on a value the scale does not rank, for standard fields only', async () => {
    await inRollback(async (client) => {
      const phones = await standardField(client, 'contact', 'phones');
      const contact = await client.query<{ id: string }>(
        `SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact'`,
        [TENANT_A],
      );
      const custom = await client.query<{ id: string }>(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom)
         VALUES (gen_random_uuid(), $1, $2, 't0102_band__c', 'Band', 'text', 'pii', true)
         RETURNING id`,
        [TENANT_A, contact.rows[0]?.id],
      );
      const customId = custom.rows[0]?.id;

      // The drift 0029's self-check refuses at migration time, staged here.
      await client.query('ALTER TABLE field_def DROP CONSTRAINT field_def_classification_check');

      expect(
        await attempt(client, `UPDATE field_def SET classification = 'restricted' WHERE id = $1`, [
          phones,
        ]),
      ).toEqual({ code: '23514', constraint: RAISE_ONLY });
      expect(await classificationOf(client, phones)).toBe('pii');

      expect(
        await attempt(client, `UPDATE field_def SET classification = 'restricted' WHERE id = $1`, [
          customId,
        ]),
      ).toBe(1);
    });
  });

  it('lets a migration lower one only by disabling the trigger by name, and nothing else', async () => {
    await inRollback(async (client) => {
      const subject = await standardField(client, 'activity', 'subject');
      await client.query(
        'ALTER TABLE field_def DISABLE TRIGGER field_def_classification_raise_only',
      );
      expect(
        await attempt(client, `UPDATE field_def SET classification = 'none' WHERE id = $1`, [
          subject,
        ]),
      ).toBe(1);
      // 0025's guards are separate and stay on.
      expect(
        await attempt(client, 'UPDATE field_def SET is_custom = true WHERE id = $1', [subject]),
      ).toEqual({ code: '23001', constraint: undefined });
      await client.query('ALTER TABLE field_def ENABLE TRIGGER field_def_classification_raise_only');

      expect(await classificationOf(client, subject)).toBe('none');
      expect(
        await attempt(client, `UPDATE field_def SET classification = 'pii' WHERE id = $1`, [
          subject,
        ]),
      ).toBe(1);
      expect(
        await attempt(client, `UPDATE field_def SET classification = 'none' WHERE id = $1`, [
          subject,
        ]),
      ).toEqual({ code: '23514', constraint: RAISE_ONLY });
    });
  });

  it('is an invoker-rights function with a pinned search_path, called by its trigger only', async () => {
    const result = await migrator.query<{
      definer: boolean;
      config: string[] | null;
      app_can_execute: boolean;
      trigger_type: number;
      enabled: string;
    }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('kasuwa_app', p.oid, 'EXECUTE') AS app_can_execute,
              t.tgtype::int AS trigger_type, t.tgenabled::text AS enabled
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'public.field_def'::regclass
          AND t.tgname = 'field_def_classification_raise_only'`,
    );
    expect(result.rows).toEqual([
      {
        definer: false,
        config: ['search_path=pg_catalog'],
        app_can_execute: false,
        // ROW (1) + UPDATE (16), no BEFORE bit: AFTER UPDATE FOR EACH ROW.
        trigger_type: 17,
        enabled: 'O',
      },
    ]);
  });
});
