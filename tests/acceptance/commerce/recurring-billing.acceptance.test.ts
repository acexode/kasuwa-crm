import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  PROGRAMME_A1,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/** ACCEPTANCE — T-0176: recurring billing schedules (migration 0060). */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SCHEDULES = (programmeId: string) => `/api/v1/programmes/${programmeId}/billing-schedules`;
const FROM_INVOICE = (invoiceId: string) => `/api/v1/invoices/${invoiceId}/billing-schedule`;
const SCHEDULE = (scheduleId: string) => `/api/v1/billing-schedules/${scheduleId}`;
const SCHEDULE_STATUS = (scheduleId: string) => `/api/v1/billing-schedules/${scheduleId}/status`;
const SCHEDULE_GENERATE = (scheduleId: string) => `/api/v1/billing-schedules/${scheduleId}/generate`;
const QUOTES = (programmeId: string) => `/api/v1/programmes/${programmeId}/quotes`;
const FROM_QUOTE = (quoteId: string) => `/api/v1/quotes/${quoteId}/invoices`;
const QUOTE_STATUS = (quoteId: string) => `/api/v1/quotes/${quoteId}/status`;

const PRODUCT_A1 = '11111111-0000-4000-8000-0000001a0001';
const VARIANT_A1 = '11111111-0000-4000-8000-0000001b0001';
const NGN_BOOK_A1 = '11111111-0000-4000-8000-000000190001';

describe('acceptance: recurring billing (T-0176)', () => {
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

  async function draftInvoice(): Promise<string> {
    const created = await request(server())
      .post(QUOTES(PROGRAMME_A1))
      .set(writer())
      .send({
        priceBookId: NGN_BOOK_A1,
        lines: [{ productId: PRODUCT_A1, variantId: VARIANT_A1, quantity: 1 }],
      });
    expect(created.status).toBe(201);
    const quoteId = created.body.id as string;
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'sent' });
    await request(server()).post(QUOTE_STATUS(quoteId)).set(writer()).send({ status: 'accepted' });
    const inv = await request(server()).post(FROM_QUOTE(quoteId)).set(writer());
    expect(inv.status).toBe(201);
    return inv.body.id as string;
  }

  it('registers recurring_billing off by default', () => {
    expect(FLAGS.recurring_billing.defaultValue).toBe(false);
    expect(TENANT_SCOPED_TABLES).toContain('billing_schedule');
  });

  it('has migration 0060 commerce foundations on disk', () => {
    expect(existsSync(resolve(repoRoot, 'packages/db/migrations/0060_commerce_p1.sql'))).toBe(true);
  });

  it('creates a schedule from an invoice, lists, pauses, and defers invoice generation', async () => {
    const invoiceId = await draftInvoice();
    const created = await request(server())
      .post(FROM_INVOICE(invoiceId))
      .set(writer())
      .send({ cadence: 'monthly' });
    expect(created.status).toBe(201);
    expect(created.body.invoiceId).toBe(invoiceId);
    expect(created.body.status).toBe('active');

    const list = await request(server()).get(SCHEDULES(PROGRAMME_A1)).set(writer());
    expect(list.body.data).toHaveLength(1);

    const scheduleId = created.body.id as string;
    await request(server()).post(SCHEDULE_STATUS(scheduleId)).set(writer()).send({ status: 'paused' });
    await request(server()).post(SCHEDULE_STATUS(scheduleId)).set(writer()).send({ status: 'active' });

    const before = new Date(created.body.nextRunAt as string);
    const generated = await request(server()).post(SCHEDULE_GENERATE(scheduleId)).set(writer());
    expect(generated.body.invoiceGeneration).toBe('deferred');
    expect(new Date(generated.body.schedule.nextRunAt as string).getTime()).toBeGreaterThan(
      before.getTime(),
    );
  });

  it('refuses duplicate schedules and cross-tenant reads', async () => {
    const invoiceId = await draftInvoice();
    const first = await request(server())
      .post(FROM_INVOICE(invoiceId))
      .set(writer())
      .send({ cadence: 'quarterly' });
    expect(first.status).toBe(201);
    const dup = await request(server())
      .post(FROM_INVOICE(invoiceId))
      .set(writer())
      .send({ cadence: 'yearly' });
    expect(dup.status).toBe(409);

    expect(
      (await request(server()).get(SCHEDULE(first.body.id as string)).set(asUser(TENANT_B, USER_B_AGENT_1)))
        .status,
    ).toBe(404);
    expect(
      (await request(server())
        .get(SCHEDULE(first.body.id as string))
        .set(asUser(TENANT_A, USER_A_NO_PROGRAMME))).status,
    ).toBe(404);
  });
});
