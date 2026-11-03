import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { paymentProviderFor, type FakePaymentProvider } from '@kasuwa/payments-adapter';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PG_POOL } from '../database/database.module';
import { PaymentWebhooksController } from './payment-webhooks.controller';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  env: 'test',
  applied: [] as string[],
  seen: new Set<string>(),
  failReconcile: false,
}));

vi.mock('@kasuwa/config', () => ({ nodeEnv: () => state.env }));

vi.mock('@kasuwa/db', () => ({
  withAuthTransaction: async (
    _pool: unknown,
    scope: { tenantSlug: string },
    fn: (tx: unknown) => Promise<unknown>,
  ) =>
    fn({
      tenantId:
        scope.tenantSlug === 'acme'
          ? '11111111-1111-4111-8111-111111111111'
          : scope.tenantSlug === 'beta'
            ? '22222222-2222-4222-8222-222222222222'
            : null,
      query: async () => [{ id: 'admin-1' }],
    }),
  withTenantTransaction: async (
    _pool: unknown,
    session: unknown,
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn({ session }),
}));

vi.mock('../commerce/payment-links.service', () => {
  class PaymentReconciliationError extends Error {
    constructor(readonly causeClass: string) {
      super('payment reconciliation failed');
    }
  }
  return {
    PaymentReconciliationError,
    applyPaymentWebhookEvent: async (
      _tx: unknown,
      input: { providerLinkId: string; providerEventId: string },
    ) => {
      if (input.providerLinkId !== 'link-1') return 'missing';
      if (state.seen.has(input.providerEventId)) return 'duplicate';
      state.seen.add(input.providerEventId);
      if (state.failReconcile) throw new PaymentReconciliationError('QuoteInvalidTransitionError');
      state.applied.push(input.providerEventId);
      return 'applied';
    },
  };
});

const REJECT = { code: 'unauthorized' };

function signed(tenantId: string, providerLinkId = 'link-1', eventId = 'evt-1') {
  const provider = paymentProviderFor('test', tenantId) as FakePaymentProvider;
  return provider.signWebhook({
    eventId,
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    type: 'payment.paid',
    providerLinkId,
    reference: 'q-1',
  });
}

describe('PaymentWebhooksController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PaymentWebhooksController],
      providers: [{ provide: PG_POOL, useValue: {} }],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    state.env = 'test';
    state.applied = [];
    state.seen = new Set();
    state.failReconcile = false;
  });

  const post = (slug: string, body: ReturnType<typeof signed>) =>
    request(app.getHttpServer())
      .post(`/webhooks/fake/${slug}`)
      .set(body.headers)
      .set('content-type', 'application/json')
      .send(body.rawBody);

  it('applies a validly signed event once', async () => {
    const res = await post('acme', signed(TENANT_A));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(state.applied).toEqual(['evt-1']);
  });

  it('treats a duplicate delivery as a no-op that still answers 200', async () => {
    await post('acme', signed(TENANT_A));
    const res = await post('acme', signed(TENANT_A));
    expect(res.status).toBe(200);
    expect(state.applied).toEqual(['evt-1']);
  });

  it('answers another tenant signature with the one reject body', async () => {
    const res = await post('acme', signed(TENANT_B));
    expect(res.status).toBe(401);
    expect(res.body).toEqual(REJECT);
    expect(state.applied).toEqual([]);
  });

  it('answers an unknown link with the same reject body', async () => {
    const res = await post('acme', signed(TENANT_A, 'no-such-link'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual(REJECT);
  });

  it('answers an unknown tenant slug with the same reject body', async () => {
    const res = await post('nobody', signed(TENANT_A));
    expect(res.status).toBe(401);
    expect(res.body).toEqual(REJECT);
  });

  it.each(['development', 'production', 'staging'])(
    'refuses the fake provider when the environment is %s',
    async (env) => {
      state.env = env;
      const res = await post('acme', signed(TENANT_A));
      expect(res.status).toBe(401);
      expect(res.body).toEqual(REJECT);
      expect(state.applied).toEqual([]);
    },
  );

  it('answers a failed reconciliation 503 with no detail, so the provider retries', async () => {
    state.failReconcile = true;
    const res = await post('acme', signed(TENANT_A));
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('QuoteInvalidTransitionError');
  });
});
