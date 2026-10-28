import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import { FakeChannelProvider, NullChannelProvider } from '@kasuwa/channel-adapter';
import {
  createPool,
  PROGRAMME_A1,
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
import { asUser, withAuthDatabase } from '../support/api';

/**
 * ACCEPTANCE — T-0167 (M05 P0, Phase 3 S1): quote PDF and email send.
 *
 * THE CONTRACT (`docs/api/commerce.openapi.yaml`):
 *
 *   renderQuotePdf  GET   /api/v1/quotes/:quoteId/pdf
 *   sendQuote       POST  /api/v1/quotes/:quoteId/send
 *
 * RULINGS (suite writer — lead amends before the build is approved):
 *
 *   R1. Table `quote_send` lands in migration 0050, is in TENANT_SCOPED_TABLES,
 *       and carries programme-scoped RLS (enabled and forced). `kasuwa_app`
 *       has SELECT and INSERT only — no UPDATE or DELETE; no UPDATE of id /
 *       tenant_id / programme_id.
 *   R2. Channel is `email` only. A body with `whatsapp` (or anything else) is
 *       400 `validation_failed`. WhatsApp quote delivery is after S3.
 *   R3. Send goes through `@kasuwa/channel-adapter` with `channel: 'email'`
 *       and `purpose: 'transactional'`. Scope is the session tenant and the
 *       quote's programme — never taken from the request.
 *   R4. Fail closed: when the provider is unavailable (NullChannelProvider /
 *       production default), send is 503 `service_unavailable` and no
 *       `quote_send` row is written; a draft does not flip to `sent`.
 *   R5. A successful send is 202 with a QuoteSend (masked `toMasked`, never
 *       the full address). A draft transitions to `sent`. Resend of an
 *       already-sent quote is allowed. Terminal statuses are 409
 *       `not_sendable`.
 *   R6. `renderQuotePdf` returns `application/pdf` whose bytes start with
 *       `%PDF` and are deterministic for the same quote. Programme members
 *       may read it; out of scope is one 404.
 *   R7. AMENDED (D-L211): send needs `quotes.write` (agent and up). A
 *       read-only set (qa_analyst) is 403 `not_permitted` on send and may
 *       still render the PDF.
 *   R8. `quote_send` flag is registered, off by default, not production-ready.
 *       `crm_quotes` remains the quotes API flag.
 *   R9. Isolation: another programme, another tenant, and a user with no
 *       programme never see the quote or a send; each is one identical 404.
 *       no-store on every answer; one 401 without credentials.
 *  R10. Never log the recipient address or the email body.
 *
 * Out of scope: WhatsApp send, payment links, approvals, P21 screens.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const QUOTE = (quoteId: string) => `/api/v1/quotes/${quoteId}`;
const QUOTE_PDF = (quoteId: string) => `/api/v1/quotes/${quoteId}/pdf`;
const QUOTE_SEND = (quoteId: string) => `/api/v1/quotes/${quoteId}/send`;
const QUOTES = (programmeId: string) => `/api/v1/programmes/${programmeId}/quotes`;

const SEED_QUOTE = '11111111-0000-4000-8000-0000001d0001';
const PRODUCT_A1 = '11111111-0000-4000-8000-0000001a0001';
const VARIANT_A1 = '11111111-0000-4000-8000-0000001b0001';
/** Seeded A1 NGN price book (kind 19) — D-L211: create names the book, not a price. */
const NGN_BOOK_A1 = '11111111-0000-4000-8000-000000190001';

let addressSeq = 0;
const uniqueAddress = (label: string) =>
  `acceptance.quote-send.${label}.${String((addressSeq += 1))}@client.example`;

async function createApiWithChannel(
  databaseUrl: string,
  channelProvider: FakeChannelProvider | NullChannelProvider,
): Promise<INestApplication> {
  const options = withAuthDatabase({ databaseUrl, poolMax: 5, channelProvider });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(options)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('acceptance: quote send (T-0167)', () => {
  let app: INestApplication;
  let failClosedApp: INestApplication;
  let fake: FakeChannelProvider;
  let observer: Pool;

  beforeAll(async () => {
    fake = new FakeChannelProvider();
    app = await createApiWithChannel(inject('databaseUrl'), fake);
    failClosedApp = await createApiWithChannel(inject('databaseUrl'), new NullChannelProvider());
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await failClosedApp?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const as = (tenant: string, user: string) => asUser(tenant, user);
  const writer = () => as(TENANT_A, USER_A_SUPERVISOR);
  const reader = () => as(TENANT_A, USER_A_AGENT_1);
  const sentTo = (address: string) => fake.sent.filter((message) => message.to === address);

  const draftBody = () => ({
    priceBookId: NGN_BOOK_A1,
    discountBps: 0,
    lines: [
      {
        productId: PRODUCT_A1,
        variantId: VARIANT_A1,
        quantity: 1,
        discountBps: 0,
      },
    ],
  });

  describe('1. schema and contract', () => {
    it('lists quote_send in TENANT_SCOPED_TABLES', () => {
      expect(TENANT_SCOPED_TABLES).toContain('quote_send');
    });

    it('has migration 0050 on disk', () => {
      expect(
        existsSync(resolve(repoRoot, 'packages/db/migrations/0050_quote_send.sql')),
      ).toBe(true);
    });

    it('declares renderQuotePdf and sendQuote as implemented', () => {
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
      for (const id of ['renderQuotePdf', 'sendQuote']) {
        const op = ops.find((row) => row.id === id);
        expect(op, id).toBeDefined();
        expect(op?.implemented, id).toBe(true);
      }
    });

    it('registers quote_send off by default', () => {
      expect(FLAGS.quote_send).toBeDefined();
      expect(FLAGS.quote_send.defaultValue).toBe(false);
      expect(FLAGS.quote_send.productionReady).toBe(false);
    });

    it('has RLS enabled and forced on quote_send', async () => {
      const { rows } = await observer.query<{
        relname: string;
        rls: boolean;
        force: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'quote_send'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.rls).toBe(true);
      expect(rows[0]?.force).toBe(true);
    });

    it('refuses UPDATE/DELETE and id/tenant/programme UPDATE for kasuwa_app (R1)', async () => {
      const { rows: colRows } = await observer.query(
        `SELECT column_name
           FROM information_schema.role_column_grants
          WHERE grantee = 'kasuwa_app'
            AND table_schema = 'public'
            AND table_name = 'quote_send'
            AND privilege_type = 'UPDATE'
            AND column_name IN ('id', 'tenant_id', 'programme_id')`,
      );
      expect(colRows).toEqual([]);

      const { rows: tableRows } = await observer.query<{ privilege_type: string }>(
        `SELECT privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'kasuwa_app'
            AND table_schema = 'public'
            AND table_name = 'quote_send'
            AND privilege_type IN ('UPDATE', 'DELETE')`,
      );
      expect(tableRows).toEqual([]);
    });
  });

  describe('2. PDF render', () => {
    it('returns application/pdf bytes starting with %PDF, no-store', async () => {
      const response = await request(server())
        .get(QUOTE_PDF(SEED_QUOTE))
        .set(reader())
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(String(response.headers['content-type'])).toMatch(/application\/pdf/);
      const body = response.body as Buffer;
      expect(body.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    });

    it('is deterministic for the same quote', async () => {
      const parsePdf = (res: request.Response, callback: (err: Error | null, body: Buffer) => void) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      };
      const a = await request(server()).get(QUOTE_PDF(SEED_QUOTE)).set(reader()).buffer(true).parse(parsePdf);
      const b = await request(server()).get(QUOTE_PDF(SEED_QUOTE)).set(reader()).buffer(true).parse(parsePdf);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect((a.body as Buffer).equals(b.body as Buffer)).toBe(true);
    });

    it('is 404 out of programme / tenant / no-programme, and 401 without credentials', async () => {
      expect(
        (await request(server()).get(QUOTE_PDF(SEED_QUOTE)).set(as(TENANT_A, USER_A_NO_PROGRAMME)))
          .status,
      ).toBe(404);
      expect(
        (await request(server()).get(QUOTE_PDF(SEED_QUOTE)).set(as(TENANT_A, USER_A_AGENT_2))).status,
      ).toBe(404);
      expect(
        (await request(server()).get(QUOTE_PDF(SEED_QUOTE)).set(as(TENANT_B, USER_B_AGENT_1))).status,
      ).toBe(404);
      expect((await request(server()).get(QUOTE_PDF(SEED_QUOTE))).status).toBe(401);
    });
  });

  describe('3. send by email', () => {
    it('sends through the email channel and records quote_send (R3, R5)', async () => {
      const address = uniqueAddress('ok');
      const created = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(draftBody());
      expect(created.status).toBe(201);
      const quoteId = created.body.id as string;

      const sent = await request(server())
        .post(QUOTE_SEND(quoteId))
        .set(writer())
        .send({ channel: 'email', to: address });
      expect(sent.status).toBe(202);
      expect(sent.headers['cache-control']).toBe('no-store');
      expect(sent.body).toMatchObject({
        quoteId,
        programmeId: PROGRAMME_A1,
        channel: 'email',
        status: 'sent',
      });
      expect(sent.body.toMasked).toMatch(/@client\.example$/);
      expect(JSON.stringify(sent.body)).not.toContain(address);
      expect(sent.body).not.toHaveProperty('to');

      expect(sentTo(address)).toHaveLength(1);
      expect(sentTo(address)[0]).toMatchObject({
        channel: 'email',
        to: address,
        purpose: 'transactional',
        scope: { tenantId: TENANT_A, programmeId: PROGRAMME_A1 },
      });

      const after = await request(server()).get(QUOTE(quoteId)).set(reader());
      expect(after.body.status).toBe('sent');

      const { rows } = await observer.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM quote_send WHERE quote_id = $1::uuid`,
        [quoteId],
      );
      expect(rows[0]?.n).toBe('1');
    });

    it('refuses whatsapp at the body boundary (R2)', async () => {
      const address = uniqueAddress('wa');
      const response = await request(server())
        .post(QUOTE_SEND(SEED_QUOTE))
        .set(writer())
        .send({ channel: 'whatsapp', to: address });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('validation_failed');
      expect(sentTo(address)).toHaveLength(0);
    });

    it('is 403 for a read-only set without quotes.write (R7, D-L211)', async () => {
      await observer.query(
        `UPDATE user_programme
            SET permission_set_id = (SELECT id FROM permission_set WHERE tenant_id = $1 AND key = 'qa_analyst')
          WHERE user_id = $2 AND programme_id = $3`,
        [TENANT_A, USER_A_AGENT_1, PROGRAMME_A1],
      );
      const address = uniqueAddress('readonly');
      const response = await request(server())
        .post(QUOTE_SEND(SEED_QUOTE))
        .set(reader())
        .send({ channel: 'email', to: address });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('not_permitted');
      expect(sentTo(address)).toHaveLength(0);
    });

    it('is 409 not_sendable for a terminal status (R5)', async () => {
      const address = uniqueAddress('terminal');
      const created = await request(server())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(draftBody());
      const quoteId = created.body.id as string;
      await request(server())
        .post(`${QUOTE(quoteId)}/status`)
        .set(writer())
        .send({ status: 'sent' });
      await request(server())
        .post(`${QUOTE(quoteId)}/status`)
        .set(writer())
        .send({ status: 'accepted' });

      const response = await request(server())
        .post(QUOTE_SEND(quoteId))
        .set(writer())
        .send({ channel: 'email', to: address });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('not_sendable');
      expect(sentTo(address)).toHaveLength(0);
    });

    it('fails closed with NullChannelProvider: 503 and no row (R4)', async () => {
      const address = uniqueAddress('null');
      const created = await request(failClosedApp.getHttpServer())
        .post(QUOTES(PROGRAMME_A1))
        .set(writer())
        .send(draftBody());
      expect(created.status).toBe(201);
      const quoteId = created.body.id as string;

      const response = await request(failClosedApp.getHttpServer())
        .post(QUOTE_SEND(quoteId))
        .set(writer())
        .send({ channel: 'email', to: address });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('service_unavailable');

      const after = await request(failClosedApp.getHttpServer())
        .get(QUOTE(quoteId))
        .set(reader());
      expect(after.body.status).toBe('draft');

      const { rows } = await observer.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM quote_send WHERE quote_id = $1::uuid`,
        [quoteId],
      );
      expect(rows[0]?.n).toBe('0');
    });

    it('is one 404 out of scope and sends nothing (R9)', async () => {
      const address = uniqueAddress('iso');
      for (const headers of [
        as(TENANT_A, USER_A_NO_PROGRAMME),
        as(TENANT_A, USER_A_AGENT_2),
        as(TENANT_B, USER_B_AGENT_1),
      ]) {
        const response = await request(server())
          .post(QUOTE_SEND(SEED_QUOTE))
          .set(headers)
          .send({ channel: 'email', to: address });
        expect(response.status, JSON.stringify(response.body)).toBe(404);
        expect(response.body.code).toBe('not_found');
      }
      expect(sentTo(address)).toHaveLength(0);
      expect(
        (
          await request(server())
            .post(QUOTE_SEND(SEED_QUOTE))
            .send({ channel: 'email', to: address })
        ).status,
      ).toBe(401);
    });
  });
});
