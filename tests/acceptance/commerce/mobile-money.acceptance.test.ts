import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PROGRAMME_A1, TENANT_A, TENANT_SCOPED_TABLES, USER_A_AGENT_1 } from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { FakeMobileMoneyProvider, NullMobileMoneyProvider } from '@kasuwa/payments-adapter';
import { reseed } from '@kasuwa/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { setMobileMoneyProviderForTests } from '@kasuwa/api';
import { asUser, createApi } from '../support/api';

/** ACCEPTANCE — T-0177: M-Pesa / MoMo via payments-adapter (provisional B3). */

const repoRoot = resolve(__dirname, '..', '..', '..');
const MOBILE_PAYMENTS = (invoiceId: string) => `/api/v1/invoices/${invoiceId}/mobile-payments`;
const MOBILE_PAYMENT_STATUS = (paymentId: string) => `/api/v1/mobile-payments/${paymentId}/status`;
const QUOTES = (programmeId: string) => `/api/v1/programmes/${programmeId}/quotes`;
const FROM_QUOTE = (quoteId: string) => `/api/v1/quotes/${quoteId}/invoices`;
const QUOTE_STATUS = (quoteId: string) => `/api/v1/quotes/${quoteId}/status`;

const PRODUCT_A1 = '11111111-0000-4000-8000-0000001a0001';
const VARIANT_A1 = '11111111-0000-4000-8000-0000001b0001';
const NGN_BOOK_A1 = '11111111-0000-4000-8000-000000190001';

describe('acceptance: mobile money (T-0177)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    setMobileMoneyProviderForTests(new FakeMobileMoneyProvider());
    app = await createApi(inject('databaseUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    setMobileMoneyProviderForTests(undefined);
    await app?.close();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const writer = () => asUser(TENANT_A, USER_A_AGENT_1);

  async function draftInvoice(): Promise<string> {
    const created = await request(server())
      .post(QUOTES(PROGRAMME_A1))
      .set(writer())
      .send({
        priceBookId: NGN_BOOK_A1,
        lines: [{ productId: PRODUCT_A1, variantId: VARIANT_A1, quantity: 2 }],
      });
    const quoteId = created.body.id as string;
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'sent' });
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'accepted' });
    const inv = await request(server()).post(FROM_QUOTE(quoteId)).set(writer());
    return inv.body.id as string;
  }

  it('registers mobile_money off by default', () => {
    expect(FLAGS.mobile_money.defaultValue).toBe(false);
    expect(TENANT_SCOPED_TABLES).toContain('mobile_payment');
  });

  it('has migration 0060 commerce foundations on disk', () => {
    expect(existsSync(resolve(repoRoot, 'packages/db/migrations/0060_commerce_p1.sql'))).toBe(true);
  });

  it('starts mpesa and momo collections and allows paid or expired only', async () => {
    const invoiceId = await draftInvoice();
    const mpesa = await request(server())
      .post(MOBILE_PAYMENTS(invoiceId))
      .set(writer())
      .send({ kind: 'mpesa', idempotencyKey: 'mm-idem-1' });
    expect(mpesa.status).toBe(201);
    expect(mpesa.body.providerKind).toBe('mpesa');
    expect(mpesa.body.providerCollectionId).toMatch(/^fake-mm-/);

    await request(server())
      .post(MOBILE_PAYMENT_STATUS(mpesa.body.id as string))
      .set(writer())
      .send({ status: 'paid' });

    const invoice2 = await draftInvoice();
    const momo = await request(server())
      .post(MOBILE_PAYMENTS(invoice2))
      .set(writer())
      .send({ kind: 'momo', idempotencyKey: 'mm-idem-2' });
    await request(server())
      .post(MOBILE_PAYMENT_STATUS(momo.body.id as string))
      .set(writer())
      .send({ status: 'expired' });
  });

  it('fail-closes when the mobile-money provider is unavailable', async () => {
    setMobileMoneyProviderForTests(new NullMobileMoneyProvider());
    const invoiceId = await draftInvoice();
    const res = await request(server())
      .post(MOBILE_PAYMENTS(invoiceId))
      .set(writer())
      .send({ kind: 'mpesa', idempotencyKey: 'mm-fail-closed' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('provider_unavailable');
    setMobileMoneyProviderForTests(new FakeMobileMoneyProvider());
  });
});
