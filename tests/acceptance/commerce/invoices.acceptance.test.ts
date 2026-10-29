import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  PROGRAMME_A1,
  PROGRAMME_A2,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0172: invoices from accepted quotes.
 * Migration 0057 `invoice` / `invoice_line`; numbering per programme. Flag `invoices`.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const INVOICES = (programmeId: string) => `/api/v1/programmes/${programmeId}/invoices`;
const FROM_QUOTE = (quoteId: string) => `/api/v1/quotes/${quoteId}/invoices`;
const INVOICE = (invoiceId: string) => `/api/v1/invoices/${invoiceId}`;
const INVOICE_STATUS = (invoiceId: string) => `/api/v1/invoices/${invoiceId}/status`;
const QUOTES = (programmeId: string) => `/api/v1/programmes/${programmeId}/quotes`;
const QUOTE_STATUS = (quoteId: string) => `/api/v1/quotes/${quoteId}/status`;

const PRODUCT_A1 = '11111111-0000-4000-8000-0000001a0001';
const VARIANT_A1 = '11111111-0000-4000-8000-0000001b0001';
const NGN_BOOK_A1 = '11111111-0000-4000-8000-000000190001';

describe('acceptance: invoices (T-0172)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const writer = () => asUser(TENANT_A, USER_A_AGENT_1);

  async function acceptedQuote(): Promise<string> {
    const created = await request(server())
      .post(QUOTES(PROGRAMME_A1))
      .set(writer())
      .send({
        priceBookId: NGN_BOOK_A1,
        lines: [{ productId: PRODUCT_A1, variantId: VARIANT_A1, quantity: 2 }],
      });
    expect(created.status).toBe(201);
    const quoteId = created.body.id as string;
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'sent' });
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'accepted' });
    return quoteId;
  }

  it('registers invoices off by default', () => {
    expect(FLAGS.invoices.defaultValue).toBe(false);
    expect(FLAGS.invoices.productionReady).toBe(false);
  });

  it('lists invoice tables in TENANT_SCOPED_TABLES', () => {
    expect(TENANT_SCOPED_TABLES).toContain('invoice');
    expect(TENANT_SCOPED_TABLES).toContain('invoice_line');
  });

  it('has migration 0057 on disk', () => {
    expect(existsSync(resolve(repoRoot, 'packages/db/migrations/0057_invoice.sql'))).toBe(true);
  });

  it('creates a draft invoice from an accepted quote with programme-scoped numbering', async () => {
    const quoteId = await acceptedQuote();
    const res = await request(server()).post(FROM_QUOTE(quoteId)).set(writer());
    expect(res.status).toBe(201);
    expect(res.body.quoteId).toBe(quoteId);
    expect(res.body.number).toMatch(/^INV-\d{4}$/);
    expect(res.body.status).toBe('draft');
    expect(res.body.totalMinor).toMatch(/^\d+$/);
    expect(res.headers['cache-control']).toBe('no-store');

    const secondQuote = await acceptedQuote();
    const second = await request(server()).post(FROM_QUOTE(secondQuote)).set(writer());
    expect(second.body.number).not.toBe(res.body.number);
  });

  it('refuses a non-accepted quote and duplicate invoice', async () => {
    const created = await request(server())
      .post(QUOTES(PROGRAMME_A1))
      .set(writer())
      .send({
        priceBookId: NGN_BOOK_A1,
        lines: [{ productId: PRODUCT_A1, variantId: VARIANT_A1, quantity: 1 }],
      });
    const quoteId = created.body.id as string;
    const early = await request(server()).post(FROM_QUOTE(quoteId)).set(writer());
    expect(early.status).toBe(400);
    expect(early.body.code).toBe('quote_not_accepted');

    const accepted = await acceptedQuote();
    await request(server()).post(FROM_QUOTE(accepted)).set(writer());
    const dup = await request(server()).post(FROM_QUOTE(accepted)).set(writer());
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('already_invoiced');
  });

  it('isolates programmes and tenants with one 404', async () => {
    const quoteId = await acceptedQuote();
    const created = await request(server()).post(FROM_QUOTE(quoteId)).set(writer());
    const invoiceId = created.body.id as string;

    expect(
      (await request(server()).get(INVOICE(invoiceId)).set(asUser(TENANT_A, USER_A_NO_PROGRAMME))).status,
    ).toBe(404);
    expect(
      (await request(server()).get(INVOICE(invoiceId)).set(asUser(TENANT_B, USER_B_AGENT_1))).status,
    ).toBe(404);
    // Lead-approved (D-L213): USER_A_AGENT_1 only reaches PROGRAMME_A1, so list
    // A2 as writer is correctly 404. Use SUPERVISOR (A1+A2) to prove A1 invoices
    // do not leak into the A2 list.
    const listA2 = await request(server())
      .get(INVOICES(PROGRAMME_A2))
      .set(asUser(TENANT_A, USER_A_SUPERVISOR));
    expect(listA2.status).toBe(200);
    expect(listA2.body.data.map((row: { id: string }) => row.id)).not.toContain(invoiceId);
  });

  it('issues an invoice through gated status transitions', async () => {
    const quoteId = await acceptedQuote();
    const created = await request(server()).post(FROM_QUOTE(quoteId)).set(writer());
    const invoiceId = created.body.id as string;
    const issued = await request(server())
      .post(INVOICE_STATUS(invoiceId))
      .set(writer())
      .send({ status: 'issued' });
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('issued');
    const bad = await request(server())
      .post(INVOICE_STATUS(invoiceId))
      .set(writer())
      .send({ status: 'draft' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_transition');
  });
});
