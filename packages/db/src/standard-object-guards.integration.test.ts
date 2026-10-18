import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { TENANT_A, USER_A_AGENT_1, USER_A_SUPERVISOR } from './fixtures';
import { newId } from './ids';
import { createPool } from './pool';
import { withTenantTransaction, type TenantTx } from './session';
import {
  ensureStandardObjectDefs,
  STANDARD_OBJECT_CATALOGUE,
  StandardCatalogueIncompleteError,
} from './standard-object-catalogue';

/**
 * Migration 0025's guards on standard definitions, beyond what the T-0053
 * acceptance suite pins (review fixes on PR #91):
 *
 *   - kasuwa_app never inserts a standard row, tenant admin included
 *     (restrictive INSERT policies); custom rows are untouched;
 *   - kasuwa_app cannot change a standard field's type, config or
 *     is_required, while the migrator still can and labels stay editable;
 *   - `ensureStandardObjectDefs` is idempotent, restores a missing row, and
 *     throws when something in the tenant stops it completing the catalogue.
 *
 * USER_A_SUPERVISOR is tenant A's tenant admin; USER_A_AGENT_1 is not. Every
 * write rolls back.
 */

class Rollback extends Error {}

/** Runs `work` as a tenant-A session and rolls back; returns its value or the Postgres error code. */
async function asApp<T>(
  pool: Pool,
  userId: string,
  work: (tx: TenantTx) => Promise<T>,
): Promise<{ ok: T } | { code: string }> {
  let result: T | undefined;
  try {
    await withTenantTransaction(pool, { tenantId: TENANT_A, userId }, async (tx) => {
      result = await work(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return { ok: result as T };
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === 'string' ? code : String(error) };
  }
  throw new Error('unreachable: the callback always throws');
}

async function standardIds(pool: Pool) {
  const rows = await pool.query<{ id: string; oid: string }>(
    `SELECT o.id AS oid, f.id
       FROM object_def o
       JOIN field_def f ON f.tenant_id = o.tenant_id AND f.object_id = o.id
      WHERE o.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = 'emails'`,
    [TENANT_A],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error('tenant A has no standard contact.emails');
  return { contactId: row.oid, emailsId: row.id };
}

describe('standard definition guards (0025)', () => {
  let appPool: Pool;
  let migrator: Pool;

  beforeAll(() => {
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await appPool.end();
    await migrator.end();
  });

  describe('INSERT of a standard row by kasuwa_app', () => {
    const insertObject = (apiName: string, isCustom: boolean) => (tx: TenantTx) =>
      tx.query(
        `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
         VALUES ($1, $2, $3, $3, $4)`,
        [newId(), TENANT_A, apiName, isCustom],
      );
    const insertField = (objectId: string, apiName: string, isCustom: boolean) => (tx: TenantTx) =>
      tx.query(
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
         VALUES ($1, $2, $3, $4, $4, 'text', $5)`,
        [newId(), TENANT_A, objectId, apiName, isCustom],
      );

    it.each([
      ['the tenant admin', USER_A_SUPERVISOR],
      ['an agent', USER_A_AGENT_1],
    ])('refuses %s any standard object, catalogue name or not', async (_who, userId) => {
      expect(await asApp(appPool, userId, insertObject('t0053_rogue', false))).toEqual({
        code: '42501',
      });
      // 42501 (policy), not 23505 (contact exists): the policy is the first refusal.
      expect(await asApp(appPool, userId, insertObject('contact', false))).toEqual({
        code: '42501',
      });
      // The same object as custom is the ordinary path.
      expect(await asApp(appPool, userId, insertObject('t0053_rogue', true))).toEqual({ ok: [] });
    });

    it.each([
      ['the tenant admin', USER_A_SUPERVISOR],
      ['an agent', USER_A_AGENT_1],
    ])('refuses %s any standard field, on a standard object or a custom one', async (_who, userId) => {
      const { contactId } = await standardIds(migrator);
      expect(await asApp(appPool, userId, insertField(contactId, 't0053_extra', false))).toEqual({
        code: '42501',
      });
      // Re-review finding: a standard, required currency field minted on
      // contact would be undeletable, frozen, and would pre-empt a later
      // catalogue field of that name.
      expect(
        await asApp(appPool, userId, (tx) =>
          tx.query(
            `INSERT INTO field_def
               (id, tenant_id, object_id, api_name, label, type, is_required, is_custom, config)
             VALUES ($1, $2, $3, 'x_std', 'X', 'currency', true, false, '{"currencyCode": "NGN"}')`,
            [newId(), TENANT_A, contactId],
          ),
        ),
      ).toEqual({ code: '42501' });

      const onCustom = await asApp(appPool, userId, async (tx) => {
        const objectId = newId();
        await tx.query(
          `INSERT INTO object_def (id, tenant_id, api_name, label) VALUES ($1, $2, 't0053_parent', 'P')`,
          [objectId, TENANT_A],
        );
        return insertField(objectId, 't0053_extra', false)(tx);
      });
      expect(onCustom).toEqual({ code: '42501' });
    });

    it('still lets anyone in the tenant add a custom field to a standard object', async () => {
      const { contactId } = await standardIds(migrator);
      expect(
        await asApp(appPool, USER_A_AGENT_1, insertField(contactId, 't0053_custom', true)),
      ).toEqual({ ok: [] });
    });
  });

  describe("UPDATE of a standard field's meaning", () => {
    it.each([
      ['type', `type = 'text'`],
      ['config', `config = '{"x": "y"}'::jsonb`],
      ['is_required', 'is_required = NOT is_required'],
    ])('refuses kasuwa_app a change to %s, even as the tenant admin', async (_column, set) => {
      const { emailsId } = await standardIds(migrator);
      expect(
        await asApp(appPool, USER_A_SUPERVISOR, (tx) =>
          tx.query(`UPDATE field_def SET ${set} WHERE id = $1 RETURNING id`, [emailsId]),
        ),
      ).toEqual({ code: '42501' });
    });

    it('lets kasuwa_app edit a standard label and a custom field’s label, but not its type (0039, ADR-0016 item 9)', async () => {
      const { contactId, emailsId } = await standardIds(migrator);
      const customId = newId();
      const result = await asApp(appPool, USER_A_SUPERVISOR, async (tx) => {
        const label = await tx.query<{ label: string }>(
          `UPDATE field_def SET label = 'Email addresses' WHERE id = $1 RETURNING label`,
          [emailsId],
        );
        await tx.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
           VALUES ($1, $2, $3, 't0053_tier', 'Tier', 'text')`,
          [customId, TENANT_A, contactId],
        );
        const custom = await tx.query<{ label: string }>(
          `UPDATE field_def SET label = 'Service tier' WHERE id = $1 RETURNING label`,
          [customId],
        );
        return [label[0]?.label, custom[0]?.label];
      });
      expect(result).toEqual({ ok: ['Email addresses', 'Service tier'] });
      // Since 0039 a custom field's type is frozen for kasuwa_app too: a change
      // of type is a new field, then retiring the old one.
      const refused = await asApp(appPool, USER_A_SUPERVISOR, async (tx) => {
        await tx.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
           VALUES ($1, $2, $3, 't0053_tier', 'Tier', 'text')`,
          [customId, TENANT_A, contactId],
        );
        return tx.query(`UPDATE field_def SET type = 'textarea' WHERE id = $1 RETURNING type`, [customId]);
      });
      expect(refused).toEqual({ code: '42501' });
    });

    it('lets a migration (kasuwa_migrator) correct a standard field’s type', async () => {
      const { emailsId } = await standardIds(migrator);
      const client = await migrator.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query<{ type: string }>(
          `UPDATE field_def SET type = 'text' WHERE id = $1 RETURNING type`,
          [emailsId],
        );
        expect(updated.rows).toEqual([{ type: 'text' }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('ensureStandardObjectDefs', () => {
    const catalogueSize = STANDARD_OBJECT_CATALOGUE.reduce(
      (n, object) => n + object.fields.length,
      0,
    );

    it('is idempotent on a tenant that has the catalogue, and restores a missing row', async () => {
      const client = await migrator.connect();
      const snapshot = async () =>
        (
          await client.query<{ id: string; api_name: string }>(
            `SELECT f.id, o.api_name || '.' || f.api_name AS api_name
               FROM field_def f JOIN object_def o ON o.tenant_id = f.tenant_id AND o.id = f.object_id
              WHERE f.tenant_id = $1 AND NOT f.is_custom AND NOT o.is_custom
              ORDER BY 2`,
            [TENANT_A],
          )
        ).rows;
      const run = () =>
        ensureStandardObjectDefs(
          (text, values) => client.query(text, [...values]).then((result) => result.rows),
          TENANT_A,
        );
      try {
        await client.query('BEGIN');
        const before = await snapshot();
        expect(before).toHaveLength(catalogueSize);

        await run();
        expect(await snapshot(), 'a second call changed the catalogue').toEqual(before);

        await client.query(
          `DELETE FROM field_def WHERE tenant_id = $1 AND id = $2`,
          [TENANT_A, before.find((row) => row.api_name === 'contact.lga')?.id],
        );
        await run();
        const after = await snapshot();
        expect(after.map((row) => row.api_name)).toEqual(before.map((row) => row.api_name));
        expect(after.filter((row) => row.api_name !== 'contact.lga')).toEqual(
          before.filter((row) => row.api_name !== 'contact.lga'),
        );
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    /** Plants `setUp` as the migrator, runs ensure, rolls back; returns what ensure threw. */
    async function ensureAfter(setUp: string[]): Promise<unknown> {
      const client = await migrator.connect();
      try {
        await client.query('BEGIN');
        for (const statement of setUp) await client.query(statement, [TENANT_A]);
        await ensureStandardObjectDefs(
          (text, values) => client.query(text, [...values]).then((result) => result.rows),
          TENANT_A,
        );
        return undefined;
      } catch (error) {
        return error;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    it('throws, naming the entries, when a custom object holds a standard object name', async () => {
      const error = await ensureAfter([
        `DELETE FROM object_def WHERE tenant_id = $1 AND api_name = 'contact'`,
        `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
         VALUES (gen_random_uuid(), $1, 'contact', 'Contact', true)`,
      ]);
      expect(error).toBeInstanceOf(StandardCatalogueIncompleteError);
      const entries = (error as StandardCatalogueIncompleteError).entries;
      expect(entries).toContain('contact');
      expect(entries).toContain('contact.emails');
      expect(entries.some((entry) => entry.startsWith('account'))).toBe(false);
    });

    it('throws when a custom field holds a standard field name', async () => {
      const error = await ensureAfter([
        `DELETE FROM field_def f USING object_def o
          WHERE o.tenant_id = f.tenant_id AND o.id = f.object_id
            AND f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = 'lga'`,
        `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, is_custom)
         SELECT gen_random_uuid(), $1, o.id, 'lga', 'LGA', 'text', true
           FROM object_def o WHERE o.tenant_id = $1 AND o.api_name = 'contact'`,
      ]);
      expect(error).toBeInstanceOf(StandardCatalogueIncompleteError);
      expect((error as StandardCatalogueIncompleteError).entries).toEqual(['contact.lga']);
    });

    it('throws when an existing standard field has another type', async () => {
      const error = await ensureAfter([
        `UPDATE field_def f SET type = 'text'
           FROM object_def o
          WHERE o.tenant_id = f.tenant_id AND o.id = f.object_id
            AND f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = 'emails'`,
      ]);
      expect((error as StandardCatalogueIncompleteError).entries).toEqual(['contact.emails']);
    });
  });
});
