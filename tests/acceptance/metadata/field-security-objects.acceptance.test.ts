import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
  type TenantTx,
} from '@kasuwa/db';
import { FIELD_TYPES, fieldTypeSchema } from '@kasuwa/metadata-engine';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0023: `listFieldSecurityObjects`, `api_name` immutability
 * (D-P4) and no plain-text identity field types (D-P5).
 *
 * Three contracts, one file, because all three are about what the metadata
 * catalogue is allowed to say about itself.
 *
 * 1. `GET /api/v1/admin/field-security/objects` (docs/api/admin.openapi.yaml,
 *    `listFieldSecurityObjects`). The object tabs of P02/D come from
 *    `object_def`, per tenant, with a field count from `field_def`. Not a
 *    hard-coded five, and never another tenant's catalogue.
 *
 * 2. D-P4 (DECISION-LOG, 2026-10-02): `api_name` on `object_def` and
 *    `field_def` is immutable after insert, **enforced in the database, not
 *    only the API**. That is why these assertions run raw SQL as `kasuwa_app`
 *    inside an ordinary tenant transaction: an API-only guard passes an API
 *    test and fails this one. Labels stay editable.
 *
 * 3. D-P5: `nin` and `bvn` are not custom field types until D-L13's
 *    encryption is wired to M3. Removed from the database CHECK *and* from the
 *    metadata engine's type list — two layers, so that neither can drift back
 *    on its own.
 *
 * Every test that writes runs against a freshly reseeded database and the
 * suite reseeds when it finishes, so the metadata isolation suite (which
 * shares this database) starts clean whichever order the files run in.
 */

const LIST = '/api/v1/admin/field-security/objects';

// Tenant A: two objects, one with fields and one with none. Tenant B: one
// object whose name exists nowhere in tenant A, so a leak is unambiguous.
const OBJ_A_VISIT = '11111111-0000-4000-8000-0000002300a1';
const OBJ_A_EMPTY = '11111111-0000-4000-8000-0000002300a2';
const OBJ_B_INTEL = '22222222-0000-4000-8000-0000002300b1';
const FIELD_A_PRIORITY = '11111111-0000-4000-8000-0000002301a1';
/** Created by the D-P5 block only, so its inserts never touch a counted object. */
const OBJ_A_TYPES = '11111111-0000-4000-8000-0000002300a3';

interface SeedObject {
  id: string;
  tenantId: string;
  userId: string;
  apiName: string;
  label: string;
  fields: string[];
}

const SEED: readonly SeedObject[] = [
  {
    id: OBJ_A_VISIT,
    tenantId: TENANT_A,
    userId: USER_A_AGENT_1,
    apiName: 'site_visit',
    label: 'Site visit',
    fields: ['priority', 'visit_notes', 'visited_on'],
  },
  {
    id: OBJ_A_EMPTY,
    tenantId: TENANT_A,
    userId: USER_A_AGENT_1,
    apiName: 'branch_audit',
    label: 'Branch audit',
    fields: [],
  },
  {
    id: OBJ_B_INTEL,
    tenantId: TENANT_B,
    userId: USER_B_AGENT_1,
    apiName: 'competitor_intel',
    label: 'Competitor intel',
    fields: ['rival_name', 'threat_level'],
  },
];

interface ListedObject {
  objectApiName: string;
  label: string;
  fieldCount: number;
}

/** Resolves to the Postgres error code a promise rejected with, or fails. */
async function pgErrorCode(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : `non-pg error: ${String(error)}`;
  }
  throw new Error('expected the database to reject the statement, but it was accepted');
}

describe('acceptance: T-0023 field-security objects and metadata decisions', () => {
  let app: INestApplication;
  let pool: Pool;

  const asTenantA = <T>(work: (tx: TenantTx) => Promise<T>) =>
    withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, work);

  /** Inserts the fixture catalogue through the ordinary, RLS-bound path. */
  const seedCatalogue = async () => {
    for (const object of SEED) {
      await withTenantTransaction(
        pool,
        { tenantId: object.tenantId, userId: object.userId },
        async (tx) => {
          await tx.query(
            `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
             VALUES ($1, $2, $3, $4, true)`,
            [object.id, object.tenantId, object.apiName, object.label],
          );
          for (const [index, field] of object.fields.entries()) {
            const id = object.id === OBJ_A_VISIT && index === 0 ? FIELD_A_PRIORITY : null;
            await tx.query(
              `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
               VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $4, 'text')`,
              [id, object.tenantId, object.id, field],
            );
          }
        },
      );
    }
  };

  const list = (headers: Record<string, string>) =>
    request(app.getHttpServer()).get(LIST).set(headers);

  const items = (body: unknown): ListedObject[] => (body as { items: ListedObject[] }).items;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    pool = createPool({ connectionString: inject('databaseUrl'), max: 5 });
    await seedCatalogue();
    app = await createApi(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await reseed(inject('migrationUrl'));
  });

  // -------------------------------------------------------------------------
  // listFieldSecurityObjects
  // -------------------------------------------------------------------------
  describe('GET /api/v1/admin/field-security/objects', () => {
    it('refuses an unauthenticated caller with the spec’s uninformative 401', async () => {
      const response = await request(app.getHttpServer()).get(LIST);

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ statusCode: 401, code: 'not_authenticated' });
    });

    it('returns the caller tenant’s objects from object_def, with field counts from field_def', async () => {
      const response = await list(asUser(TENANT_A, USER_A_SUPERVISOR));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);

      const byName = new Map(items(response.body).map((item) => [item.objectApiName, item]));
      expect(byName.get('site_visit')).toEqual({
        objectApiName: 'site_visit',
        label: 'Site visit',
        fieldCount: 3,
      });
      // An object with no fields yet is still a tab; zero is a count, not an omission.
      expect(byName.get('branch_audit')).toEqual({
        objectApiName: 'branch_audit',
        label: 'Branch audit',
        fieldCount: 0,
      });
    });

    it('matches the FieldSecurityObjectList schema exactly — no ids, no data', async () => {
      const response = await list(asUser(TENANT_A, USER_A_SUPERVISOR)).expect(200);

      expect(Object.keys(response.body as object)).toEqual(['items']);
      for (const item of items(response.body)) {
        expect(Object.keys(item).sort()).toEqual(['fieldCount', 'label', 'objectApiName']);
        expect(typeof item.objectApiName).toBe('string');
        expect(typeof item.label).toBe('string');
        expect(Number.isInteger(item.fieldCount)).toBe(true);
      }
    });

    it('never lists another tenant’s objects, in either direction', async () => {
      const a = items((await list(asUser(TENANT_A, USER_A_SUPERVISOR)).expect(200)).body);
      const b = items((await list(asUser(TENANT_B, USER_B_AGENT_1)).expect(200)).body);

      const aNames = a.map((item) => item.objectApiName);
      const bNames = b.map((item) => item.objectApiName);

      // Both non-empty, so that a broken endpoint returning [] cannot pass.
      expect(aNames).toContain('site_visit');
      expect(bNames).toEqual(['competitor_intel']);
      expect(aNames).not.toContain('competitor_intel');
      expect(bNames).not.toContain('site_visit');
      expect(bNames).not.toContain('branch_audit');
      expect(b[0]?.fieldCount).toBe(2);
    });

    it('is tenant-scoped, not programme-scoped: agents on different programmes see one catalogue', async () => {
      // Metadata belongs to the tenant (0002 header). USER_A_AGENT_1 is in A1
      // only and USER_A_AGENT_2 in A2 only; their views must be identical.
      const sort = (rows: ListedObject[]) =>
        [...rows].sort((x, y) => x.objectApiName.localeCompare(y.objectApiName));

      const one = await list(asUser(TENANT_A, USER_A_AGENT_1)).expect(200);
      const two = await list(asUser(TENANT_A, USER_A_AGENT_2)).expect(200);

      expect(items(one.body).length).toBeGreaterThan(0);
      expect(sort(items(two.body))).toEqual(sort(items(one.body)));
    });
  });

  // -------------------------------------------------------------------------
  // D-P4 — api_name is immutable, enforced by the database
  // -------------------------------------------------------------------------
  describe('D-P4: api_name is immutable after insert, in the database', () => {
    it('rejects an UPDATE that changes object_def.api_name, and the row is unchanged', async () => {
      const code = await pgErrorCode(
        asTenantA((tx) =>
          tx.query(`UPDATE object_def SET api_name = 'renamed_visit' WHERE id = $1`, [OBJ_A_VISIT]),
        ),
      );
      // Any database-raised rejection is acceptable (trigger, rule, privilege);
      // what is not acceptable is the statement succeeding.
      expect(code).toMatch(/^[0-9A-Z]{5}$/);

      const rows = await asTenantA((tx) =>
        tx.query<{ api_name: string }>('SELECT api_name FROM object_def WHERE id = $1', [
          OBJ_A_VISIT,
        ]),
      );
      expect(rows).toEqual([{ api_name: 'site_visit' }]);
    });

    it('rejects an UPDATE that changes field_def.api_name, and the row is unchanged', async () => {
      const code = await pgErrorCode(
        asTenantA((tx) =>
          tx.query(`UPDATE field_def SET api_name = 'urgency' WHERE id = $1`, [FIELD_A_PRIORITY]),
        ),
      );
      expect(code).toMatch(/^[0-9A-Z]{5}$/);

      const rows = await asTenantA((tx) =>
        tx.query<{ api_name: string }>('SELECT api_name FROM field_def WHERE id = $1', [
          FIELD_A_PRIORITY,
        ]),
      );
      expect(rows).toEqual([{ api_name: 'priority' }]);
    });

    it('still lets the label change on both tables', async () => {
      // The guard must be on api_name, not on UPDATE as a whole: a blanket
      // "definitions are read-only" trigger would pass the two tests above.
      const objects = await asTenantA((tx) =>
        tx.query<{ label: string }>(
          `UPDATE object_def SET label = 'Field visit' WHERE id = $1 RETURNING label`,
          [OBJ_A_VISIT],
        ),
      );
      expect(objects).toEqual([{ label: 'Field visit' }]);

      const fields = await asTenantA((tx) =>
        tx.query<{ label: string }>(
          `UPDATE field_def SET label = 'Urgency' WHERE id = $1 RETURNING label`,
          [FIELD_A_PRIORITY],
        ),
      );
      expect(fields).toEqual([{ label: 'Urgency' }]);
    });
  });

  // -------------------------------------------------------------------------
  // D-P5 — no plain-text nin / bvn field types
  // -------------------------------------------------------------------------
  describe('D-P5: nin and bvn are not field types', () => {
    beforeAll(async () => {
      await asTenantA((tx) =>
        tx.query(
          `INSERT INTO object_def (id, tenant_id, api_name, label) VALUES ($1, $2, 'type_probe', 'Type probe')`,
          [OBJ_A_TYPES, TENANT_A],
        ),
      );
    });

    const insertField = (type: string, apiName: string) =>
      asTenantA((tx) =>
        tx.query(
          `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
           VALUES (gen_random_uuid(), $1, $2, $3, $3, $4)`,
          [TENANT_A, OBJ_A_TYPES, apiName, type],
        ),
      );

    it.each(['nin', 'bvn'])(
      'the database rejects a field_def of type %s with a CHECK violation',
      async (type) => {
        // 23514 = check_violation. Asserting the code, not just "it threw",
        // means an unrelated failure (bad FK, RLS) cannot pass for this one.
        await expect(pgErrorCode(insertField(type, `identity_${type}`))).resolves.toBe('23514');
      },
    );

    it('the database still accepts every type the metadata engine offers', async () => {
      // The other half of the parity: removing nin must not remove anything
      // else, and the engine must not offer a type the database refuses.
      for (const type of FIELD_TYPES) {
        await expect(insertField(type, `parity_${type}`)).resolves.toBeDefined();
      }
    });

    it('the metadata engine neither lists nor parses nin or bvn', () => {
      const offered: readonly string[] = FIELD_TYPES;
      expect(offered).not.toContain('nin');
      expect(offered).not.toContain('bvn');
      expect(fieldTypeSchema.safeParse('nin').success).toBe(false);
      expect(fieldTypeSchema.safeParse('bvn').success).toBe(false);
      // And the list was trimmed, not emptied.
      expect(offered).toContain('text');
      expect(offered).toContain('phone');
    });
  });
});
