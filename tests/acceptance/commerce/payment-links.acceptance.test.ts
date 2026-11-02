import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import {
  fakeWebhookSecretForTenant,
  FakePaymentProvider,
  FAKE_SIGNATURE_HEADER,
} from '@kasuwa/payments-adapter';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0169 (M05 P0, D-A3): payment links.
 *
 * Paid and expired only. Refunds and partial payments stay out (B3).
 * `paid` is not a client status. Unknown slug, bad signature, unknown link
 * and a signature made for another tenant share one 401 body.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const LINKS = (programmeId: string, quoteId: string) =>
  `/api/v1/programmes/${programmeId}/quotes/${quoteId}/payment-links`;
const LINK = (linkId: string) => `/api/v1/payment-links/${linkId}`;
const QUOTES = (programmeId: string) => `/api/v1/programmes/${programmeId}/quotes`;
const QUOTE = (quoteId: string) => `/api/v1/quotes/${quoteId}`;
const QUOTE_STATUS = (quoteId: string) => `/api/v1/quotes/${quoteId}/status`;

const NGN_BOOK_A1 = '11111111-0000-4000-8000-000000190001';
const PRODUCT_A1 = '11111111-0000-4000-8000-0000001a0001';
const VARIANT_A1 = '11111111-0000-4000-8000-0000001b0001';
const DEAL_A1 = '11111111-0000-4000-8000-000000170001';
const SLUG_A = 'sahel-bpo';

const NOT_AUTHENTICATED = {
  statusCode: 401,
  error: 'Unauthorized',
  code: 'not_authenticated',
  message: 'Not authenticated',
};

describe('acceptance: payment links (T-0169)', () => {
  let app: INestApplication;
  let observer: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const writer = () => asUser(TENANT_A, USER_A_AGENT_1);

  async function sentQuote(): Promise<{ id: string; totalMinor: string }> {
    const created = await request(server())
      .post(QUOTES(PROGRAMME_A1))
      .set(writer())
      .send({
        priceBookId: NGN_BOOK_A1,
        dealId: DEAL_A1,
        discountBps: 0,
        lines: [{ productId: PRODUCT_A1, variantId: VARIANT_A1, quantity: 1, discountBps: 0 }],
      });
    expect(created.status).toBe(201);
    const sent = await request(server())
      .post(QUOTE_STATUS(created.body.id as string))
      .set(writer())
      .send({ status: 'sent' });
    expect(sent.status).toBe(200);
    return { id: created.body.id as string, totalMinor: created.body.totalMinor as string };
  }

  function sign(tenantId: string, providerLinkId: string, type: 'payment.paid' | 'payment.expired', eventId: string) {
    return new FakePaymentProvider({ webhookSecret: fakeWebhookSecretForTenant(tenantId) }).signWebhook({
      eventId,
      occurredAt: new Date('2026-11-02T00:00:00.000Z'),
      type,
      providerLinkId,
      reference: 'quote',
    });
  }

  async function postWebhook(slug: string, signed: { rawBody: string; headers: Record<string, string> }) {
    const signature = signed.headers[FAKE_SIGNATURE_HEADER] ?? '';
    return request(server())
      .post(`/webhooks/fake/${slug}`)
      .set('content-type', 'application/json')
      .set(FAKE_SIGNATURE_HEADER, signature)
      .send(signed.rawBody);
  }

  it('registers payment_links off by default and not production-ready', () => {
    expect(FLAGS.payment_links.defaultValue).toBe(false);
    expect(FLAGS.payment_links.productionReady).toBe(false);
  });

  it('puts payment_link and payment_event in TENANT_SCOPED_TABLES', () => {
    expect(TENANT_SCOPED_TABLES).toContain('payment_link');
    expect(TENANT_SCOPED_TABLES).toContain('payment_event');
  });

  it('documents create, read and the webhook, and keeps paid off the client status enum', () => {
    const doc = parse(readFileSync(resolve(repoRoot, 'docs/api/commerce.openapi.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
      components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
    };
    expect(doc.paths['/api/v1/programmes/{programmeId}/quotes/{quoteId}/payment-links']?.post?.operationId).toBe(
      'createPaymentLink',
    );
    expect(doc.paths['/api/v1/payment-links/{linkId}']?.get?.operationId).toBe('getPaymentLink');
    expect(doc.paths['/webhooks/{provider}/{tenantSlug}']?.post?.operationId).toBe('receivePaymentWebhook');
    expect(doc.components.schemas.Quote?.properties?.status?.enum).toContain('paid');
    expect(doc.components.schemas.SetQuoteStatusRequest?.properties?.status?.enum).not.toContain('paid');
  });

  it('uses tenant-only RLS and does not add a third security definer', () => {
    const sql = readFileSync(resolve(repoRoot, 'packages/db/migrations/0051_payment_links.sql'), 'utf8');
    expect(sql).toContain('tenant_id = app.current_tenant_id()');
    expect(sql).not.toContain('current_programme_ids()');
    expect(sql).toContain('exactly two SECURITY DEFINER');
    expect(sql).toContain("'paid'");
  });

  it('refuses a client setting paid, then pays the quote from a signed webhook', async () => {
    const quote = await sentQuote();
    const refused = await request(server()).post(QUOTE_STATUS(quote.id)).set(writer()).send({ status: 'paid' });
    expect(refused.status).toBe(400);

    const created = await request(server())
      .post(LINKS(PROGRAMME_A1, quote.id))
      .set(writer())
      .send({ idempotencyKey: `pay-${quote.id}` });
    expect(created.status).toBe(201);
    expect(created.body.amountMinor).toBe(quote.totalMinor);
    expect(created.body.status).toBe('pending');
    expect(created.headers['cache-control']).toBe('no-store');

    const again = await request(server())
      .post(LINKS(PROGRAMME_A1, quote.id))
      .set(writer())
      .send({ idempotencyKey: `pay-${quote.id}` });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(created.body.id);

    const before = await observer.query<{ stage_id: string }>(
      'SELECT stage_id FROM deal WHERE id = $1',
      [DEAL_A1],
    );
    const signed = sign(TENANT_A, created.body.providerLinkId as string, 'payment.paid', `evt-${quote.id}`);
    const applied = await postWebhook(SLUG_A, signed);
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ status: 'paid', replay: false, dealMoved: false });

    const replay = await postWebhook(SLUG_A, signed);
    expect(replay.status).toBe(200);
    expect(replay.body.replay).toBe(true);

    const after = await request(server()).get(QUOTE(quote.id)).set(writer());
    expect(after.body.status).toBe('paid');
    const stage = await observer.query<{ stage_id: string }>('SELECT stage_id FROM deal WHERE id = $1', [DEAL_A1]);
    expect(stage.rows[0]?.stage_id).toBe(before.rows[0]?.stage_id);

    const link = await request(server()).get(LINK(created.body.id as string)).set(writer());
    expect(link.status).toBe(200);
    expect(link.body.status).toBe('paid');
    expect(JSON.stringify(link.body)).not.toMatch(/pan|cardNumber/i);
  });

  it('expires a link without marking the quote paid', async () => {
    const quote = await sentQuote();
    const created = await request(server())
      .post(LINKS(PROGRAMME_A1, quote.id))
      .set(writer())
      .send({ idempotencyKey: `exp-${quote.id}` });
    expect(created.status).toBe(201);
    const signed = sign(TENANT_A, created.body.providerLinkId as string, 'payment.expired', `exp-evt-${quote.id}`);
    const applied = await postWebhook(SLUG_A, signed);
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe('expired');
    const after = await request(server()).get(QUOTE(quote.id)).set(writer());
    expect(after.body.status).toBe('sent');
  });

  it('answers unknown slug, bad signature, unknown link and a cross-tenant signature with one 401', async () => {
    const quote = await sentQuote();
    const created = await request(server())
      .post(LINKS(PROGRAMME_A1, quote.id))
      .set(writer())
      .send({ idempotencyKey: `cross-${quote.id}` });
    expect(created.status).toBe(201);
    const good = sign(TENANT_A, created.body.providerLinkId as string, 'payment.paid', `cross-${quote.id}`);
    const otherTenant = sign(TENANT_B, created.body.providerLinkId as string, 'payment.paid', `cross-${quote.id}`);
    const unknownLink = sign(TENANT_A, 'missing-link', 'payment.paid', `missing-${quote.id}`);

    const unknownSlug = await postWebhook('no-such-workspace', good);
    const badSignature = await request(server())
      .post(`/webhooks/fake/${SLUG_A}`)
      .set('content-type', 'application/json')
      .set(FAKE_SIGNATURE_HEADER, 'deadbeef')
      .send(good.rawBody);
    const missing = await postWebhook(SLUG_A, unknownLink);
    const crossed = await postWebhook(SLUG_A, otherTenant);

    for (const response of [unknownSlug, badSignature, missing, crossed]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual(NOT_AUTHENTICATED);
    }

    const untouched = await request(server()).get(QUOTE(quote.id)).set(writer());
    expect(untouched.body.status).toBe('sent');
  });

  it('hides a link outside the caller programme and refuses a draft', async () => {
    const quote = await sentQuote();
    const created = await request(server())
      .post(LINKS(PROGRAMME_A1, quote.id))
      .set(writer())
      .send({ idempotencyKey: `hide-${quote.id}` });
    expect(created.status).toBe(201);

    const otherProgramme = await request(server())
      .get(LINK(created.body.id as string))
      .set(asUser(TENANT_A, USER_A_AGENT_2));
    const noProgramme = await request(server())
      .get(LINK(created.body.id as string))
      .set(asUser(TENANT_A, USER_A_NO_PROGRAMME));
    const otherTenant = await request(server())
      .get(LINK(created.body.id as string))
      .set(asUser(TENANT_B, USER_B_AGENT_1));
    expect(otherProgramme.status).toBe(404);
    expect(noProgramme.body).toEqual(otherProgramme.body);
    expect(otherTenant.body).toEqual(otherProgramme.body);

    const draft = await request(server())
      .post(QUOTES(PROGRAMME_A1))
      .set(writer())
      .send({
        priceBookId: NGN_BOOK_A1,
        lines: [{ productId: PRODUCT_A1, variantId: VARIANT_A1, quantity: 1 }],
      });
    expect(draft.status).toBe(201);
    const refused = await request(server())
      .post(LINKS(PROGRAMME_A1, draft.body.id as string))
      .set(writer())
      .send({ idempotencyKey: `draft-${draft.body.id as string}` });
    expect(refused.status).toBe(400);

    const missingProgramme = await request(server())
      .post(LINKS(PROGRAMME_A2, quote.id))
      .set(asUser(TENANT_A, USER_A_AGENT_2))
      .send({ idempotencyKey: 'nope' });
    expect(missingProgramme.status).toBe(404);
  });
});
