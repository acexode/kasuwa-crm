import type { INestApplication } from '@nestjs/common';
import { PROGRAMME_A1, TENANT_A, TENANT_SCOPED_TABLES, USER_A_AGENT_1 } from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/** ACCEPTANCE — T-0173: VAT / multi-tax (`tax_line`, migration 0060). */

const QUOTES = (programmeId: string) => `/api/v1/programmes/${programmeId}/quotes`;
const FROM_QUOTE = (quoteId: string) => `/api/v1/quotes/${quoteId}/invoices`;
const QUOTE_STATUS = (quoteId: string) => `/api/v1/quotes/${quoteId}/status`;
const INVOICE = (invoiceId: string) => `/api/v1/invoices/${invoiceId}`;

const PRODUCT_A1 = '11111111-0000-4000-8000-0000001a0001';
const VARIANT_A1 = '11111111-0000-4000-8000-0000001b0001';
const NGN_BOOK_A1 = '11111111-0000-4000-8000-000000190001';

describe('acceptance: vat multitax (T-0173)', () => {
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

  async function invoiceFromQuote(): Promise<{ quoteTotal: string; invoiceId: string; invoiceTotal: string }> {
    const created = await request(server())
      .post(QUOTES(PROGRAMME_A1))
      .set(writer())
      .send({
        priceBookId: NGN_BOOK_A1,
        lines: [{ productId: PRODUCT_A1, variantId: VARIANT_A1, quantity: 2 }],
      });
    const quoteId = created.body.id as string;
    const quoteTotal = created.body.totalMinor as string;
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'sent' });
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'accepted' });
    const inv = await request(server()).post(FROM_QUOTE(quoteId)).set(writer());
    return { quoteTotal, invoiceId: inv.body.id as string, invoiceTotal: inv.body.totalMinor as string };
  }

  it('registers vat_multitax off by default', () => {
    expect(FLAGS.vat_multitax.defaultValue).toBe(false);
    expect(TENANT_SCOPED_TABLES).toContain('tax_line');
  });

  it('adds 7.5% VAT tax lines and includes tax in invoice totalMinor', async () => {
    const { quoteTotal, invoiceId, invoiceTotal } = await invoiceFromQuote();
    const detail = await request(server()).get(INVOICE(invoiceId)).set(writer());
    expect(detail.status).toBe(200);
    expect(detail.body.taxLines.length).toBeGreaterThan(0);
    expect(detail.body.taxLines[0].code).toBe('VAT');
    expect(detail.body.taxLines[0].rateBps).toBe(750);
    expect(detail.body.taxMinor).toMatch(/^\d+$/);
    expect(BigInt(detail.body.taxMinor)).toBeGreaterThan(0n);
    expect(BigInt(invoiceTotal)).toBe(BigInt(quoteTotal) + BigInt(detail.body.taxMinor));
  });
});
