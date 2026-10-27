import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0164 (M05 P0, Phase 3 S1): product catalogue.
 *
 * THE CONTRACT (`docs/api/commerce.openapi.yaml`):
 *
 *   listProducts          GET  /api/v1/programmes/:programmeId/products
 *   createProduct         POST /api/v1/programmes/:programmeId/products
 *   updateProduct         PATCH /api/v1/products/:productId
 *   listPriceBooks        GET  /api/v1/programmes/:programmeId/price-books
 *   upsertPriceBookEntry  PUT  /api/v1/price-books/:priceBookId/entries
 *   listTaxProfiles       GET  /api/v1/programmes/:programmeId/tax-profiles
 *
 * Money is `amountMinor` (string of digits) plus an ISO currency. Currencies
 * are only NGN, GHS, KES and ZAR (B6). Bodies are closed. Scope is resolved
 * from the session; a programme the caller cannot reach is one 404.
 *
 * What is held:
 *
 *   1. Migration 0047 tables exist, are in TENANT_SCOPED_TABLES, and carry
 *      programme-scoped RLS (enabled and forced).
 *   2. The six operations are in commerce.openapi.yaml as implemented.
 *   3. `crm_products` is registered and off by default.
 *   4. Round trip: create a product (optional variant and tax profile), list
 *      it in its programme only, update it, upsert a price-book entry, list
 *      price books and tax profiles.
 *   5. Isolation: another programme, another tenant, and a user with no
 *      programme never see the row; each is one identical 404 body.
 *   6. Validation: an unknown currency, a float amount, a stray body key, and
 *      an unreachable programme are refused (400 or 404).
 *   7. no-store on every answer; one 401 without credentials.
 *
 *   Lead amendments (D-L210), before any build was approved:
 *   8. Writes need `catalogue.write` (the admin set). An agent reads the
 *      catalogue and is refused every write with one 403 `not_permitted`.
 *   9. A price entry stays inside its book: a product of another programme or
 *      another product's variant is a 404; a currency other than the book's, an
 *      amount past bigint and more than 50 variants are 400s.
 *  10. The schema holds the same: no DELETE and no UPDATE of tenant, programme
 *      or id for the app role, and the foreign keys refuse a currency or variant
 *      mismatch whatever the code does.
 *
 * Out of scope: quotes, approvals, send, payments, P21 screens.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const PRODUCTS = (programmeId: string) => `/api/v1/programmes/${programmeId}/products`;
const PRODUCT = (productId: string) => `/api/v1/products/${productId}`;
const PRICE_BOOKS = (programmeId: string) => `/api/v1/programmes/${programmeId}/price-books`;
const PRICE_ENTRY = (priceBookId: string) => `/api/v1/price-books/${priceBookId}/entries`;
const TAX_PROFILES = (programmeId: string) => `/api/v1/programmes/${programmeId}/tax-profiles`;

const CATALOGUE_TABLES = [
  'product',
  'product_variant',
  'price_book',
  'price_book_entry',
  'tax_profile',
] as const;

describe('acceptance: product catalogue (T-0164)', () => {
  let app: INestApplication;
  let observer: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const as = (tenant: string, user: string) => asUser(tenant, user);

  describe('1. schema and contract', () => {
    it('lists every catalogue table in TENANT_SCOPED_TABLES', () => {
      for (const table of CATALOGUE_TABLES) {
        expect(TENANT_SCOPED_TABLES, table).toContain(table);
      }
    });

    it('has migration 0047 on disk', () => {
      expect(
        existsSync(resolve(repoRoot, 'packages/db/migrations/0047_product_catalogue.sql')),
      ).toBe(true);
    });

    it('declares the six commerce operations as implemented', () => {
      const spec = parse(
        readFileSync(resolve(repoRoot, 'docs/api/commerce.openapi.yaml'), 'utf8'),
      ) as {
        paths: Record<
          string,
          Record<string, { operationId?: string; 'x-kasuwa-implemented'?: boolean }>
        >;
      };
      const ops = Object.values(spec.paths).flatMap((methods) =>
        Object.values(methods).map((op) => ({
          id: op.operationId,
          implemented: op['x-kasuwa-implemented'],
        })),
      );
      for (const id of [
        'listProducts',
        'createProduct',
        'updateProduct',
        'listPriceBooks',
        'upsertPriceBookEntry',
        'listTaxProfiles',
      ]) {
        const op = ops.find((row) => row.id === id);
        expect(op, id).toBeDefined();
        expect(op?.implemented, id).toBe(true);
      }
    });

    it('registers crm_products off by default', () => {
      expect(FLAGS.crm_products).toBeDefined();
      expect(FLAGS.crm_products.defaultValue).toBe(false);
      expect(FLAGS.crm_products.productionReady).toBe(false);
    });

    it('has RLS enabled and forced on every catalogue table', async () => {
      const { rows } = await observer.query<{
        relname: string;
        rls: boolean;
        force: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [[...CATALOGUE_TABLES]],
      );
      expect(rows.map((r) => r.relname).sort()).toEqual([...CATALOGUE_TABLES].sort());
      for (const row of rows) {
        expect(row.rls, row.relname).toBe(true);
        expect(row.force, row.relname).toBe(true);
      }
    });
  });

  describe('2. the round trip', () => {
    it('lists seed tax profiles and price books for a reachable programme', async () => {
      const taxes = await request(server())
        .get(TAX_PROFILES(PROGRAMME_A1))
        .set(as(TENANT_A, USER_A_AGENT_1));
      expect(taxes.status).toBe(200);
      expect(taxes.headers['cache-control']).toBe('no-store');
      expect(Array.isArray(taxes.body.data)).toBe(true);
      expect(taxes.body.data.length).toBeGreaterThan(0);
      expect(taxes.body.data[0]).toMatchObject({
        programmeId: PROGRAMME_A1,
        name: expect.any(String),
        rateBps: expect.any(Number),
      });

      const books = await request(server())
        .get(PRICE_BOOKS(PROGRAMME_A1))
        .set(as(TENANT_A, USER_A_AGENT_1));
      expect(books.status).toBe(200);
      expect(books.body.data.length).toBeGreaterThan(0);
      for (const book of books.body.data as Array<{ currency: string }>) {
        expect(['NGN', 'GHS', 'KES', 'ZAR']).toContain(book.currency);
      }
    });

    it('creates, lists, updates a product and upserts a price-book entry', async () => {
      const agent = as(TENANT_A, USER_A_SUPERVISOR); // writes need catalogue.write (D-L210): the admin set
      const taxes = await request(server()).get(TAX_PROFILES(PROGRAMME_A1)).set(agent);
      const taxProfileId = taxes.body.data[0].id as string;
      const books = await request(server()).get(PRICE_BOOKS(PROGRAMME_A1)).set(agent);
      const ngnBook = (books.body.data as Array<{ id: string; currency: string }>).find(
        (b) => b.currency === 'NGN',
      );
      expect(ngnBook).toBeDefined();

      const created = await request(server())
        .post(PRODUCTS(PROGRAMME_A1))
        .set(agent)
        .send({
          name: 'Collections retainer',
          description: 'Monthly BPO retainer',
          sku: 'RET-001',
          taxProfileId,
          variants: [{ name: 'Standard', sku: 'RET-001-STD' }],
        });
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.body).toMatchObject({
        programmeId: PROGRAMME_A1,
        name: 'Collections retainer',
        sku: 'RET-001',
        status: 'active',
        taxProfileId,
      });
      expect(created.body.variants).toEqual([
        expect.objectContaining({ name: 'Standard', sku: 'RET-001-STD' }),
      ]);
      const productId = created.body.id as string;
      const variantId = created.body.variants[0].id as string;

      const listed = await request(server()).get(PRODUCTS(PROGRAMME_A1)).set(agent);
      expect(listed.status).toBe(200);
      expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(productId);

      const updated = await request(server())
        .patch(PRODUCT(productId))
        .set(agent)
        .send({ name: 'Collections retainer (NGN)', description: null });
      expect(updated.status).toBe(200);
      expect(updated.body.name).toBe('Collections retainer (NGN)');
      expect(updated.body.description).toBeNull();

      const priced = await request(server()).put(PRICE_ENTRY(ngnBook!.id)).set(agent).send({
        productId,
        variantId,
        amountMinor: '25000000',
        currency: 'NGN',
      });
      expect(priced.status).toBe(200);
      expect(priced.body).toMatchObject({
        priceBookId: ngnBook!.id,
        productId,
        variantId,
        amountMinor: '25000000',
        currency: 'NGN',
      });

      const booksAgain = await request(server()).get(PRICE_BOOKS(PROGRAMME_A1)).set(agent);
      const book = (booksAgain.body.data as Array<{ id: string; entries: unknown[] }>).find(
        (b) => b.id === ngnBook!.id,
      );
      expect(book?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ productId, variantId, amountMinor: '25000000' }),
        ]),
      );
    });
  });

  describe('3. isolation', () => {
    it('hides a product from another programme, another tenant, and a user with no programme', async () => {
      const created = await request(server())
        .post(PRODUCTS(PROGRAMME_A1))
        .set(as(TENANT_A, USER_A_SUPERVISOR))
        .send({ name: 'Scoped only', sku: 'SCOPED-1' });
      expect(created.status).toBe(201);
      const productId = created.body.id as string;

      const sibling = await request(server())
        .get(PRODUCTS(PROGRAMME_A2))
        .set(as(TENANT_A, USER_A_AGENT_2));
      expect(sibling.status).toBe(200);
      expect(sibling.body.data.map((row: { id: string }) => row.id)).not.toContain(productId);

      const otherTenantList = await request(server())
        .get(PRODUCTS(PROGRAMME_B1))
        .set(as(TENANT_B, USER_B_AGENT_1));
      expect(otherTenantList.status).toBe(200);
      expect(otherTenantList.body.data.map((row: { id: string }) => row.id)).not.toContain(
        productId,
      );

      const patchBodies = await Promise.all([
        request(server())
          .patch(PRODUCT(productId))
          .set(as(TENANT_A, USER_A_AGENT_2))
          .send({ name: 'stolen' }),
        request(server())
          .patch(PRODUCT(productId))
          .set(as(TENANT_B, USER_B_AGENT_1))
          .send({ name: 'stolen' }),
        request(server())
          .patch(PRODUCT(productId))
          .set(as(TENANT_A, USER_A_NO_PROGRAMME))
          .send({ name: 'stolen' }),
      ]);
      for (const res of patchBodies) {
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: 'not_found' });
      }
      expect(new Set(patchBodies.map((r) => JSON.stringify(r.body))).size).toBe(1);

      const unreachableProgramme = await request(server())
        .get(PRODUCTS(PROGRAMME_B1))
        .set(as(TENANT_A, USER_A_AGENT_1));
      expect(unreachableProgramme.status).toBe(404);
      expect(unreachableProgramme.body).toMatchObject({ code: 'not_found' });
    });

    it('the app role cannot read another programme row under RLS', async () => {
      const created = await request(server())
        .post(PRODUCTS(PROGRAMME_A1))
        .set(as(TENANT_A, USER_A_SUPERVISOR))
        .send({ name: 'RLS row', sku: 'RLS-1' });
      const productId = created.body.id as string;

      const appPool = createPool({ connectionString: inject('databaseUrl'), max: 1 });
      try {
        const seen = await withTenantTransaction(
          appPool,
          { tenantId: TENANT_A, userId: USER_A_AGENT_2 },
          async (tx) => {
            const rows = await tx.query<{ id: string }>('SELECT id FROM product WHERE id = $1', [
              productId,
            ]);
            return rows;
          },
        );
        expect(seen).toEqual([]);
      } finally {
        await appPool.end();
      }
    });
  });

  describe('4. validation and auth', () => {
    it('refuses a float amount, an unknown currency, a stray key, and no credentials', async () => {
      const agent = as(TENANT_A, USER_A_SUPERVISOR);
      const books = await request(server()).get(PRICE_BOOKS(PROGRAMME_A1)).set(agent);
      const ngnBook = (books.body.data as Array<{ id: string; currency: string }>).find(
        (b) => b.currency === 'NGN',
      );
      const created = await request(server())
        .post(PRODUCTS(PROGRAMME_A1))
        .set(agent)
        .send({ name: 'Priced', sku: 'P-1' });
      const productId = created.body.id as string;

      const floatAmount = await request(server())
        .put(PRICE_ENTRY(ngnBook!.id))
        .set(agent)
        .send({ productId, amountMinor: 250.5, currency: 'NGN' });
      expect(floatAmount.status).toBe(400);
      expect(floatAmount.body).toMatchObject({ code: 'validation_failed' });

      const badCurrency = await request(server())
        .put(PRICE_ENTRY(ngnBook!.id))
        .set(agent)
        .send({ productId, amountMinor: '100', currency: 'USD' });
      expect(badCurrency.status).toBe(400);
      expect(badCurrency.body).toMatchObject({ code: 'validation_failed' });

      const stray = await request(server())
        .post(PRODUCTS(PROGRAMME_A1))
        .set(agent)
        .send({ name: 'X', sku: 'X-1', tenantId: TENANT_A });
      expect(stray.status).toBe(400);
      expect(stray.body).toMatchObject({ code: 'validation_failed' });

      const anon = await request(server()).get(PRODUCTS(PROGRAMME_A1));
      expect(anon.status).toBe(401);
    });
  });
  // =========================================================================
  // Lead amendments (D-L210). The suite arrived in the build PR; these hold what
  // its first draft left to the implementation alone.
  // =========================================================================

  /** An NGN book of `programmeId`, read as `who`. */
  async function ngnBook(who: Record<string, string>, programmeId: string): Promise<string> {
    const books = await request(server()).get(PRICE_BOOKS(programmeId)).set(who);
    const book = (books.body.data as Array<{ id: string; currency: string }>).find(
      (b) => b.currency === 'NGN',
    );
    if (book === undefined) throw new Error(`fixture: ${programmeId} has no NGN price book`);
    return book.id;
  }

  async function product(
    who: Record<string, string>,
    programmeId: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string; variants: Array<{ id: string }> }> {
    const created = await request(server()).post(PRODUCTS(programmeId)).set(who).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body as { id: string; variants: Array<{ id: string }> };
  }

  describe('5. who may write (D-L210: catalogue.write, the admin set)', () => {
    it('an agent reads the catalogue but cannot create, edit or price it: one 403', async () => {
      const admin = as(TENANT_A, USER_A_SUPERVISOR);
      const agent = as(TENANT_A, USER_A_AGENT_1);
      const existing = await product(admin, PROGRAMME_A1, { name: 'Admin made', sku: 'ADM-1' });
      const book = await ngnBook(agent, PROGRAMME_A1);

      const reads = await Promise.all([
        request(server()).get(PRODUCTS(PROGRAMME_A1)).set(agent),
        request(server()).get(PRICE_BOOKS(PROGRAMME_A1)).set(agent),
        request(server()).get(TAX_PROFILES(PROGRAMME_A1)).set(agent),
      ]);
      for (const read of reads) expect(read.status).toBe(200);

      const writes = await Promise.all([
        request(server())
          .post(PRODUCTS(PROGRAMME_A1))
          .set(agent)
          .send({ name: 'Agent made', sku: 'AG-1' }),
        request(server()).patch(PRODUCT(existing.id)).set(agent).send({ name: 'renamed' }),
        request(server())
          .put(PRICE_ENTRY(book))
          .set(agent)
          .send({ productId: existing.id, amountMinor: '100', currency: 'NGN' }),
      ]);
      for (const write of writes) {
        expect(write.status).toBe(403);
        expect(write.body).toMatchObject({ code: 'not_permitted' });
      }
      const after = await request(server()).get(PRODUCTS(PROGRAMME_A1)).set(agent);
      const names = (after.body.data as Array<{ name: string }>).map((row) => row.name);
      expect(names, 'a refused write changed the catalogue').not.toContain('Agent made');
      expect(names).not.toContain('renamed');
    });
  });

  describe('6. references and money stay inside one book and one programme', () => {
    it('a product of another programme, or another product’s variant, is not priced: 404', async () => {
      const admin = as(TENANT_A, USER_A_SUPERVISOR); // admin in A1 and A2
      const a1Book = await ngnBook(admin, PROGRAMME_A1);
      const fromA2 = await product(admin, PROGRAMME_A2, { name: 'A2 only', sku: 'A2-1' });
      const one = await product(admin, PROGRAMME_A1, {
        name: 'One',
        sku: 'ONE',
        variants: [{ name: 'V1' }],
      });
      const two = await product(admin, PROGRAMME_A1, {
        name: 'Two',
        sku: 'TWO',
        variants: [{ name: 'V2' }],
      });

      const crossProgramme = await request(server())
        .put(PRICE_ENTRY(a1Book))
        .set(admin)
        .send({ productId: fromA2.id, amountMinor: '100', currency: 'NGN' });
      expect(crossProgramme.status).toBe(404);
      expect(crossProgramme.body).toMatchObject({ code: 'not_found' });

      const foreignVariant = await request(server())
        .put(PRICE_ENTRY(a1Book))
        .set(admin)
        .send({
          productId: one.id,
          variantId: two.variants[0]?.id,
          amountMinor: '100',
          currency: 'NGN',
        });
      expect(foreignVariant.status).toBe(404);
      expect(foreignVariant.body).toMatchObject({ code: 'not_found' });
    });

    it('an entry in another currency than its book, an amount beyond bigint, and too many variants are 400', async () => {
      const admin = as(TENANT_A, USER_A_SUPERVISOR);
      const book = await ngnBook(admin, PROGRAMME_A1);
      const item = await product(admin, PROGRAMME_A1, { name: 'Money', sku: 'MON-1' });

      const mismatch = await request(server())
        .put(PRICE_ENTRY(book))
        .set(admin)
        .send({ productId: item.id, amountMinor: '100', currency: 'GHS' });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body).toMatchObject({ code: 'validation_failed' });

      const huge = await request(server())
        .put(PRICE_ENTRY(book))
        .set(admin)
        .send({ productId: item.id, amountMinor: '1'.repeat(20), currency: 'NGN' });
      expect(huge.status, 'an amount past bigint must be a 400, never a 500').toBe(400);
      expect(huge.body).toMatchObject({ code: 'validation_failed' });

      const crowded = await request(server())
        .post(PRODUCTS(PROGRAMME_A1))
        .set(admin)
        .send({
          name: 'Crowded',
          variants: Array.from({ length: 51 }, (_, n) => ({ name: `V${String(n)}` })),
        });
      expect(crowded.status).toBe(400);
      expect(crowded.body).toMatchObject({ code: 'validation_failed' });
    });
  });

  describe('7. the database holds it too, whatever the code does', () => {
    it('the app role may not delete catalogue rows, nor move them between programmes or tenants', async () => {
      for (const table of CATALOGUE_TABLES) {
        const { rows } = await observer.query<{
          del: boolean;
          tenant: boolean;
          programme: boolean;
          id: boolean;
        }>(
          `SELECT has_table_privilege('kasuwa_app', $1, 'DELETE') AS del,
                  has_column_privilege('kasuwa_app', $1, 'tenant_id', 'UPDATE') AS tenant,
                  has_column_privilege('kasuwa_app', $1, 'programme_id', 'UPDATE') AS programme,
                  has_column_privilege('kasuwa_app', $1, 'id', 'UPDATE') AS id`,
          [`public.${table}`],
        );
        expect(rows[0], table).toEqual({ del: false, tenant: false, programme: false, id: false });
      }
    });

    it('an entry whose currency differs from its book, or whose variant is another product’s, is refused by the schema', async () => {
      const admin = as(TENANT_A, USER_A_SUPERVISOR);
      const book = await ngnBook(admin, PROGRAMME_A1);
      const one = await product(admin, PROGRAMME_A1, {
        name: 'DB one',
        variants: [{ name: 'D1' }],
      });
      const two = await product(admin, PROGRAMME_A1, {
        name: 'DB two',
        variants: [{ name: 'D2' }],
      });
      const appPool = createPool({ connectionString: inject('databaseUrl'), max: 1 });
      const insert = async (values: {
        productId: string;
        variantId: string | null;
        currency: string;
      }) => {
        try {
          await withTenantTransaction(
            appPool,
            { tenantId: TENANT_A, userId: USER_A_SUPERVISOR },
            async (tx) => {
              await tx.query(
                `INSERT INTO price_book_entry
                 (id, tenant_id, programme_id, price_book_id, product_id, variant_id, amount_minor, currency)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 100, $6)`,
                [TENANT_A, PROGRAMME_A1, book, values.productId, values.variantId, values.currency],
              );
            },
          );
          return 'accepted';
        } catch (error) {
          return String((error as { code?: unknown }).code);
        }
      };
      try {
        expect(
          await insert({ productId: one.id, variantId: null, currency: 'GHS' }),
          'GHS entry in an NGN book',
        ).toBe('23503');
        expect(
          await insert({
            productId: one.id,
            variantId: two.variants[0]?.id ?? null,
            currency: 'NGN',
          }),
          'another product’s variant',
        ).toBe('23503');
        expect(
          await insert({
            productId: one.id,
            variantId: one.variants[0]?.id ?? null,
            currency: 'NGN',
          }),
          'control',
        ).toBe('accepted');
      } finally {
        await appPool.end();
      }
    });
  });
});
