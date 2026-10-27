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
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0165 (M05 P0, Phase 3 S1): quotes.
 *
 * THE CONTRACT (`docs/api/commerce.openapi.yaml`):
 *
 *   createQuote     POST   /api/v1/programmes/:programmeId/quotes
 *   listQuotes      GET    /api/v1/programmes/:programmeId/quotes
 *   getQuote        GET    /api/v1/quotes/:quoteId
 *   updateQuote     PATCH  /api/v1/quotes/:quoteId
 *   setQuoteStatus  POST   /api/v1/quotes/:quoteId/status
 *
 * Money is `amountMinor` (string of digits, 1–18) plus an ISO currency.
 * Currencies are only NGN, GHS, KES and ZAR (B6). Bodies are closed. Scope is
 * resolved from the session; a programme the caller cannot reach is one 404.
 *
 * RULINGS (suite writer — lead amends before the build is approved):
 *
 *   R1. Tables `quote` and `quote_line` land in migration 0048, are in
 *       TENANT_SCOPED_TABLES, and carry programme-scoped RLS (enabled and
 *       forced). `kasuwa_app` has SELECT and INSERT; `quote` has no DELETE;
 *       `quote_line` may DELETE (draft line replace); no UPDATE of id /
 *       tenant_id / programme_id (D-L210 shape, plus line replace).
 *   R2. Status values: `draft` | `sent` | `accepted` | `rejected` |
 *       `expired` | `cancelled`. Create always starts as `draft`.
 *   R3. Gated transitions (only these succeed; anything else is 400
 *       `invalid_transition`):
 *         draft  → sent | cancelled
 *         sent   → accepted | rejected | expired | cancelled
 *       Terminal statuses accept no further transition.
 *   R4. `updateQuote` is allowed only while `draft`. A non-draft update is
 *       409 `not_editable`. Every successful draft update bumps `version`
 *       by 1 (starts at 1).
 *   R5. A quote may optionally reference a deal and/or a contact of the same
 *       programme. A deal or contact of another programme (or missing) is
 *       404 `not_found` on create/update — never 400, so existence outside
 *       scope is not confirmed.
 *   R6. Lines reference a product (required) and optional variant of the same
 *       programme. Cross-programme product/variant → 404. Quantity is an
 *       integer 1..999999. `unitAmountMinor` is `/^\d{1,18}$/`. Optional
 *       `discountBps` on the quote and on each line is 0..10000.
 *   R7. Currency is required on create and must match every line's implied
 *       money currency; a stray currency on a line body is refused (400). The
 *       quote currency cannot change after create.
 *   R8. `validUntil` is an optional ISO-8601 date-time (UTC). Past values are
 *       accepted on draft (expiry is a status transition, not auto).
 *   R9. Writes need `quotes.write` (admin set and tenant-admin flag only,
 *       mirroring `catalogue.write`). An agent reads and is refused every
 *       write with 403 `not_permitted`. Reads stay open to programme members.
 *  R10. `crm_quotes` is registered and off by default / not production-ready.
 *  R11. Totals: response includes `subtotalMinor` (sum of line
 *       quantity × unitAmountMinor before discounts), `discountMinor` (quote
 *       + line discounts applied in minor units, integer arithmetic), and
 *       `totalMinor` (subtotal − discount, never negative). Server computes;
 *       the client never posts totals.
 *  R12. Isolation: another programme, another tenant, and a user with no
 *       programme never see the row; each is one identical 404 body.
 *       no-store on every answer; one 401 without credentials.
 *
 * Out of scope: approvals, PDF/send, payments, P21 screens, FX lock.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const QUOTES = (programmeId: string) => `/api/v1/programmes/${programmeId}/quotes`;
const QUOTE = (quoteId: string) => `/api/v1/quotes/${quoteId}`;
const QUOTE_STATUS = (quoteId: string) => `/api/v1/quotes/${quoteId}/status`;

const QUOTE_TABLES = ['quote', 'quote_line'] as const;

/** Seeded fixtures from @kasuwa/db (kinds 0e / 17 / 1a / 1b). */
const CONTACT_A1 = '11111111-0000-4000-8000-0000000e0001';
const DEAL_A1 = '11111111-0000-4000-8000-000000170001';
const PRODUCT_A1 = '11111111-0000-4000-8000-0000001a0001';
const VARIANT_A1 = '11111111-0000-4000-8000-0000001b0001';
const PRODUCT_MISSING = '11111111-0000-4000-8000-0000001affff';

describe('acceptance: quotes (T-0165)', () => {
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
  const writer = () => as(TENANT_A, USER_A_SUPERVISOR);
  const reader = () => as(TENANT_A, USER_A_AGENT_1);

  const draftBody = (overrides: Record<string, unknown> = {}) => ({
    currency: 'NGN',
    dealId: DEAL_A1,
    contactId: CONTACT_A1,
    discountBps: 0,
    validUntil: '2026-12-31T23:59:59.000Z',
    lines: [
      {
        productId: PRODUCT_A1,
        variantId: VARIANT_A1,
        quantity: 2,
        unitAmountMinor: '25000000',
        discountBps: 0,
      },
    ],
    ...overrides,
  });

  describe('1. schema and contract', () => {
    it('lists every quote table in TENANT_SCOPED_TABLES', () => {
      for (const table of QUOTE_TABLES) {
        expect(TENANT_SCOPED_TABLES, table).toContain(table);
      }
    });

    it('has migration 0048 on disk', () => {
      expect(
        existsSync(resolve(repoRoot, 'packages/db/migrations/0048_quotes.sql')),
      ).toBe(true);
    });

    it('declares the five quote operations as implemented', () => {
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
        'createQuote',
        'listQuotes',
        'getQuote',
        'updateQuote',
        'setQuoteStatus',
      ]) {
        const op = ops.find((row) => row.id === id);
        expect(op, id).toBeDefined();
        expect(op?.implemented, id).toBe(true);
      }
    });

    it('registers crm_quotes off by default', () => {
      expect(FLAGS.crm_quotes).toBeDefined();
      expect(FLAGS.crm_quotes.defaultValue).toBe(false);
      expect(FLAGS.crm_quotes.productionReady).toBe(false);
    });

    it('has RLS enabled and forced on every quote table', async () => {
      const { rows } = await observer.query<{
        relname: string;
        rls: boolean;
        force: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [[...QUOTE_TABLES]],
      );
      expect(rows.map((r) => r.relname).sort()).toEqual([...QUOTE_TABLES].sort());
      for (const row of rows) {
        expect(row.rls, row.relname).toBe(true);
        expect(row.force, row.relname).toBe(true);
      }
    });

    it('refuses UPDATE of id/tenant/programme; quote has no DELETE; quote_line may (R1)', async () => {
      const { rows: colRows } = await observer.query<{
        table_name: string;
        privilege_type: string;
        column_name: string | null;
      }>(
        `SELECT table_name, privilege_type, column_name
           FROM information_schema.role_column_grants
          WHERE grantee = 'kasuwa_app'
            AND table_schema = 'public'
            AND table_name = ANY($1::text[])
            AND privilege_type = 'UPDATE'
            AND column_name IN ('id', 'tenant_id', 'programme_id')`,
        [[...QUOTE_TABLES]],
      );
      expect(colRows).toEqual([]);

      const { rows: tableRows } = await observer.query<{
        table_name: string;
        privilege_type: string;
      }>(
        `SELECT table_name, privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'kasuwa_app'
            AND table_schema = 'public'
            AND table_name = ANY($1::text[])
            AND privilege_type = 'DELETE'`,
        [[...QUOTE_TABLES]],
      );
      expect(tableRows.map((r) => r.table_name).sort()).toEqual(['quote_line']);
    });
  });

  describe('2. the round trip', () => {
    it('creates, lists, gets and updates a draft quote with computed totals', async () => {
      const created = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(draftBody());
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.body).toMatchObject({
        programmeId: PROGRAMME_A1,
        currency: 'NGN',
        status: 'draft',
        version: 1,
        dealId: DEAL_A1,
        contactId: CONTACT_A1,
        discountBps: 0,
        // 2 × 25000000 = 50000000
        subtotalMinor: '50000000',
        discountMinor: '0',
        totalMinor: '50000000',
      });
      expect(created.body.lines).toEqual([
        expect.objectContaining({
          productId: PRODUCT_A1,
          variantId: VARIANT_A1,
          quantity: 2,
          unitAmountMinor: '25000000',
          discountBps: 0,
        }),
      ]);
      const quoteId = created.body.id as string;

      const listed = await request(server()).get(QUOTES(PROGRAMME_A1)).set(reader());
      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(quoteId);

      const got = await request(server()).get(QUOTE(quoteId)).set(reader());
      expect(got.status).toBe(200);
      expect(got.body.id).toBe(quoteId);

      const updated = await request(server())
        .patch(QUOTE(quoteId))
        .set(writer())
        .send({
          discountBps: 1000,
          lines: [
            {
              productId: PRODUCT_A1,
              variantId: VARIANT_A1,
              quantity: 1,
              unitAmountMinor: '25000000',
              discountBps: 0,
            },
          ],
        });
      expect(updated.status).toBe(200);
      expect(updated.body.version).toBe(2);
      expect(updated.body.discountBps).toBe(1000);
      // subtotal 25000000; quote discount 10% → 2500000; total 22500000
      expect(updated.body.subtotalMinor).toBe('25000000');
      expect(updated.body.discountMinor).toBe('2500000');
      expect(updated.body.totalMinor).toBe('22500000');
    });

    it('moves draft → sent → accepted and refuses an illegal transition', async () => {
      const created = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(draftBody({ dealId: null, contactId: null }));
      expect(created.status).toBe(201);
      const quoteId = created.body.id as string;

      const sent = await request(server())
        .post(QUOTE_STATUS(quoteId))
        .set(writer())
        .send({ status: 'sent' });
      expect(sent.status).toBe(200);
      expect(sent.body.status).toBe('sent');

      const bad = await request(server())
        .post(QUOTE_STATUS(quoteId))
        .set(writer())
        .send({ status: 'draft' });
      expect(bad.status).toBe(400);
      expect(bad.body).toMatchObject({ code: 'invalid_transition' });

      const accepted = await request(server())
        .post(QUOTE_STATUS(quoteId))
        .set(writer())
        .send({ status: 'accepted' });
      expect(accepted.status).toBe(200);
      expect(accepted.body.status).toBe('accepted');

      const afterTerminal = await request(server())
        .post(QUOTE_STATUS(quoteId))
        .set(writer())
        .send({ status: 'cancelled' });
      expect(afterTerminal.status).toBe(400);
      expect(afterTerminal.body).toMatchObject({ code: 'invalid_transition' });

      const editSent = await request(server())
        .patch(QUOTE(quoteId))
        .set(writer())
        .send({ discountBps: 500 });
      expect(editSent.status).toBe(409);
      expect(editSent.body).toMatchObject({ code: 'not_editable' });
    });
  });

  describe('3. isolation', () => {
    it('hides a quote from another programme, another tenant, and a user with no programme', async () => {
      const created = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(draftBody());
      expect(created.status).toBe(201);
      const quoteId = created.body.id as string;

      const sibling = await request(server())
        .get(QUOTES(PROGRAMME_A2))
        .set(as(TENANT_A, USER_A_AGENT_2));
      expect(sibling.status).toBe(200);
      expect(sibling.body.data.map((row: { id: string }) => row.id)).not.toContain(quoteId);

      const otherTenant = await request(server())
        .get(QUOTES(PROGRAMME_B1))
        .set(as(TENANT_B, USER_B_AGENT_1));
      expect(otherTenant.status).toBe(200);
      expect(otherTenant.body.data.map((row: { id: string }) => row.id)).not.toContain(quoteId);

      const gets = await Promise.all([
        request(server()).get(QUOTE(quoteId)).set(as(TENANT_A, USER_A_AGENT_2)),
        request(server()).get(QUOTE(quoteId)).set(as(TENANT_B, USER_B_AGENT_1)),
        request(server()).get(QUOTE(quoteId)).set(as(TENANT_A, USER_A_NO_PROGRAMME)),
      ]);
      for (const res of gets) {
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ code: 'not_found' });
      }
      expect(new Set(gets.map((r) => JSON.stringify(r.body))).size).toBe(1);

      const unreachable = await request(server())
        .post(QUOTES(PROGRAMME_B1))
        .set(writer())
        .send(draftBody());
      expect(unreachable.status).toBe(404);
      expect(unreachable.body).toMatchObject({ code: 'not_found' });
    });
  });

  describe('4. validation and permissions', () => {
    it('refuses an agent write with 403 not_permitted (R9)', async () => {
      const res = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(reader())
        .send(draftBody());
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'not_permitted' });
    });

    it('refuses unknown currency, float amount, oversize amount, stray keys (R6/R7)', async () => {
      const badCurrency = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(draftBody({ currency: 'USD' }));
      expect(badCurrency.status).toBe(400);

      const floatAmount = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(
          draftBody({
            lines: [
              {
                productId: PRODUCT_A1,
                quantity: 1,
                unitAmountMinor: '12.5',
              },
            ],
          }),
        );
      expect(floatAmount.status).toBe(400);

      const oversize = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(
          draftBody({
            lines: [
              {
                productId: PRODUCT_A1,
                quantity: 1,
                unitAmountMinor: '1'.repeat(20),
              },
            ],
          }),
        );
      expect(oversize.status).toBe(400);

      const stray = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(draftBody({ totalMinor: '1' }));
      expect(stray.status).toBe(400);
    });

    it('404s a missing product and a cross-scope deal (R5/R6)', async () => {
      const missingProduct = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(
          draftBody({
            lines: [
              {
                productId: PRODUCT_MISSING,
                quantity: 1,
                unitAmountMinor: '100',
              },
            ],
          }),
        );
      expect(missingProduct.status).toBe(404);
      expect(missingProduct.body).toMatchObject({ code: 'not_found' });

      // Contact of PROGRAMME_A2 used while posting into A1.
      const contactA2 = '11111111-0000-4000-8000-0000000e0011';
      const crossContact = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(draftBody({ contactId: contactA2, dealId: null }));
      expect(crossContact.status).toBe(404);
      expect(crossContact.body).toMatchObject({ code: 'not_found' });
    });

    it('answers 401 without credentials and no-store on errors', async () => {
      const res = await request(server()).get(QUOTES(PROGRAMME_A1));
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });
});
