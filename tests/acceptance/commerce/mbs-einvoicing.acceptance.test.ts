import type { INestApplication } from '@nestjs/common';
import { PROGRAMME_A1, TENANT_A, TENANT_SCOPED_TABLES, USER_A_AGENT_1 } from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { FakeMbsProvider, fakeIrn } from '@kasuwa/mbs-adapter';
import { reseed } from '@kasuwa/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { setMbsProviderForTests } from '@kasuwa/api';
import { asUser, createApi } from '../support/api';

/** ACCEPTANCE — T-0174: Fake MBS e-invoicing (provisional B4). */

const QUOTES = (programmeId: string) => `/api/v1/programmes/${programmeId}/quotes`;
const FROM_QUOTE = (quoteId: string) => `/api/v1/quotes/${quoteId}/invoices`;
const QUOTE_STATUS = (quoteId: string) => `/api/v1/quotes/${quoteId}/status`;
const EINVOICE = (invoiceId: string) => `/api/v1/invoices/${invoiceId}/einvoice`;
const EINVOICE_SUBMIT = (invoiceId: string) => `${EINVOICE(invoiceId)}/submit`;
const EINVOICE_RETRY = (invoiceId: string) => `${EINVOICE(invoiceId)}/retry`;

const PRODUCT_A1 = '11111111-0000-4000-8000-0000001a0001';
const VARIANT_A1 = '11111111-0000-4000-8000-0000001b0001';
const NGN_BOOK_A1 = '11111111-0000-4000-8000-000000190001';

describe('acceptance: mbs einvoicing (T-0174)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    setMbsProviderForTests(new FakeMbsProvider());
    app = await createApi(inject('databaseUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    setMbsProviderForTests(undefined);
    await app?.close();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const writer = () => asUser(TENANT_A, USER_A_AGENT_1);

  async function issuedInvoice(): Promise<string> {
    const created = await request(server())
      .post(QUOTES(PROGRAMME_A1))
      .set(writer())
      .send({
        priceBookId: NGN_BOOK_A1,
        lines: [{ productId: PRODUCT_A1, variantId: VARIANT_A1, quantity: 1 }],
      });
    const quoteId = created.body.id as string;
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'sent' });
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'accepted' });
    const inv = await request(server()).post(FROM_QUOTE(quoteId)).set(writer());
    return inv.body.id as string;
  }

  it('registers mbs_einvoicing off by default', () => {
    expect(FLAGS.mbs_einvoicing.defaultValue).toBe(false);
    expect(TENANT_SCOPED_TABLES).toContain('einvoice');
  });

  it('clears through Fake MBS with IRN and QR payload', async () => {
    const invoiceId = await issuedInvoice();
    const submitted = await request(server()).post(EINVOICE_SUBMIT(invoiceId)).set(writer());
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('cleared');
    expect(submitted.body.irn).toBe(fakeIrn(invoiceId));
    expect(submitted.body.qrPayload).toContain(submitted.body.irn);
  });

  it('retries after a simulated failure', async () => {
    const invoiceId = await issuedInvoice();
    await request(server())
      .post(`/api/v1/invoices/${invoiceId}/status`)
      .set(writer())
      .send({ status: 'issued' });
    // Force failure via invoice number pattern requires recreate — use provider that fails first submit
    const failProvider = new FakeMbsProvider();
    const original = failProvider.submit.bind(failProvider);
    let calls = 0;
    failProvider.submit = async (req) => {
      calls += 1;
      if (calls === 1) return { irn: '', qrPayload: '', outcome: 'failed' as const };
      return original(req);
    };
    setMbsProviderForTests(failProvider);
    const first = await request(server()).post(EINVOICE_SUBMIT(invoiceId)).set(writer());
    expect(first.body.status).toBe('failed');
    const retry = await request(server()).post(EINVOICE_RETRY(invoiceId)).set(writer());
    expect(retry.body.status).toBe('cleared');
    setMbsProviderForTests(new FakeMbsProvider());
  });
});
