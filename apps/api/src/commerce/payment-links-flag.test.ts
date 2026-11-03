import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { PaymentLinksController, PaymentLinksQuoteController } from './payment-links.controller';
import {
  PAYMENT_LINKS_ENABLED_TOKEN,
  PaymentLinksEnabledGuard,
  paymentLinksEnabled,
} from './payment-links-flag';

const QUOTE = '33333333-3333-4333-8333-333333333333';

async function appWith(enabled: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [PaymentLinksQuoteController, PaymentLinksController],
    providers: [
      PaymentLinksEnabledGuard,
      { provide: PAYMENT_LINKS_ENABLED_TOKEN, useValue: enabled },
    ],
  })
    .overrideGuard(KasuwaAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideInterceptor(TenantTransactionInterceptor)
    .useValue({ intercept: (_c: unknown, next: { handle: () => unknown }) => next.handle() })
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('payment_links flag', () => {
  let off: INestApplication;
  beforeAll(async () => {
    off = await appWith(false);
  });
  afterAll(async () => {
    await off.close();
  });

  it('is off unless explicitly on', () => {
    expect(paymentLinksEnabled({})).toBe(false);
    expect(paymentLinksEnabled({ paymentLinksEnabled: false })).toBe(false);
    expect(paymentLinksEnabled({ paymentLinksEnabled: true })).toBe(true);
  });

  it('answers the create route 404 when off', async () => {
    const res = await request(off.getHttpServer())
      .post(`/api/v1/quotes/${QUOTE}/payment-links`)
      .send({ idempotencyKey: 'k' });
    expect(res.status).toBe(404);
  });

  it('answers the read route 404 when off', async () => {
    const res = await request(off.getHttpServer()).get(`/api/v1/payment-links/${QUOTE}`);
    expect(res.status).toBe(404);
  });

  it('lets the request through when on', () => {
    expect(new PaymentLinksEnabledGuard(true).canActivate()).toBe(true);
  });
});
