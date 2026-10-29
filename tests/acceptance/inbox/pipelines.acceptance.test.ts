import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  FakeChannelProvider,
  FakeDndRegister,
  NullChannelProvider,
} from '@kasuwa/channel-adapter';
import {
  createPool,
  newId,
  PROGRAMME_A1,
  TENANT_A,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';

/**
 * ACCEPTANCE — T-0187 (M08 P0, Phase 3 S3): outbound send pipeline depth.
 *
 * THE CONTRACT (`docs/api/inbox.openapi.yaml`):
 *
 *   sendMessage  POST  /api/v1/conversations/:conversationId/messages
 *
 * RULINGS (suite writer — lead amends before the build is approved):
 *
 *   R1. `message_delivery` lands in migration 0055, is in TENANT_SCOPED_TABLES,
 *       programme-scoped RLS (enabled and forced). `kasuwa_app` has SELECT,
 *       INSERT and UPDATE; no DELETE.
 *   R2. `sendMessage` is marked implemented in inbox.openapi.yaml.
 *   R3. Send goes through `createChannelAdapter` with required `idempotencyKey`,
 *       scope from the session, destination from the conversation's contact.
 *   R4. Success is 201 with `message` (outbound, redacted body) and `delivery`
 *       (`state` from the provider, initially `queued` on the fake).
 *   R5. Typed errors: `validation_failed` (missing key), `dnd_refused` (403),
 *       `provider_rejected` (400), `service_unavailable` (503 fail-closed).
 *   R6. Fail closed: NullChannelProvider → 503 and no `message` / `message_delivery` row.
 *   R7. no-store; 404 for out-of-scope conversation.
 *
 * Out of scope: inbound webhooks, outbox worker, unknown slug / bad signature.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const MESSAGES = (conversationId: string) =>
  `/api/v1/conversations/${conversationId}/messages`;

const CONTACT_A1 = '11111111-0000-4000-8000-0000000e0001';
const CONTACT_A1_PHONE = '+2348031234001';

const PIPELINE_TABLES = ['message_delivery'] as const;

async function createApiWithChannel(
  databaseUrl: string,
  channelProvider: FakeChannelProvider | NullChannelProvider,
  dndRegister?: FakeDndRegister,
): Promise<INestApplication> {
  const options = withAuthDatabase({
    databaseUrl,
    poolMax: 5,
    channelProvider,
    ...(dndRegister === undefined ? {} : { dndRegister }),
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(options)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('acceptance: inbox pipelines (T-0187)', () => {
  let app: INestApplication;
  let failClosedApp: INestApplication;
  let dndApp: INestApplication;
  let appPool: Pool;
  let observer: Pool;
  let fake: FakeChannelProvider;

  beforeAll(async () => {
    fake = new FakeChannelProvider();
    app = await createApiWithChannel(inject('databaseUrl'), fake, new FakeDndRegister([]));
    failClosedApp = await createApiWithChannel(
      inject('databaseUrl'),
      new NullChannelProvider(),
    );
    dndApp = await createApiWithChannel(
      inject('databaseUrl'),
      new FakeChannelProvider(),
      new FakeDndRegister([CONTACT_A1_PHONE]),
    );
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await failClosedApp?.close();
    await dndApp?.close();
    await appPool?.end();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const reader = () => asUser(TENANT_A, USER_A_AGENT_1);

  async function seedWhatsappConversation(): Promise<string> {
    const conversationId = newId();
    await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        await tx.query(
          `INSERT INTO conversation
             (id, tenant_id, programme_id, contact_id, channel, status)
           VALUES ($1, $2, $3, $4, 'whatsapp', 'open')`,
          [conversationId, TENANT_A, PROGRAMME_A1, CONTACT_A1],
        );
      },
    );
    return conversationId;
  }

  describe('1. schema and contract', () => {
    it('lists message_delivery in TENANT_SCOPED_TABLES', () => {
      for (const table of PIPELINE_TABLES) {
        expect(TENANT_SCOPED_TABLES, table).toContain(table);
      }
    });

    it('has migration 0055 on disk', () => {
      expect(
        existsSync(resolve(repoRoot, 'packages/db/migrations/0055_message_delivery.sql')),
      ).toBe(true);
    });

    it('declares sendMessage as implemented', () => {
      const spec = parse(
        readFileSync(resolve(repoRoot, 'docs/api/inbox.openapi.yaml'), 'utf8'),
      ) as {
        paths: Record<
          string,
          Record<string, { operationId?: string; 'x-kasuwa-implemented'?: boolean }>
        >;
      };
      const post = spec.paths['/api/v1/conversations/{conversationId}/messages']?.post;
      expect(post?.operationId).toBe('sendMessage');
      expect(post?.['x-kasuwa-implemented']).toBe(true);
    });
  });

  describe('2. outbound send', () => {
    it('accepts a transactional send and persists message + delivery', async () => {
      const conversationId = await seedWhatsappConversation();
      const res = await request(server())
        .post(MESSAGES(conversationId))
        .set(reader())
        .send({
          body: 'Your payment plan is ready',
          purpose: 'transactional',
          idempotencyKey: 'accept-0187-tx-1',
        });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.message).toMatchObject({
        conversationId,
        direction: 'outbound',
        bodyRedacted: 'Your payment plan is ready',
        sentByUserId: USER_A_AGENT_1,
      });
      expect(res.body.delivery).toMatchObject({
        messageId: res.body.message.id,
        state: 'queued',
        attempt: 1,
      });
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]?.idempotencyKey).toBe(`inbox:${conversationId}:accept-0187-tx-1`);
      expect(fake.sent[0]?.to).toBe(CONTACT_A1_PHONE);

      const { rows } = await observer.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM message_delivery WHERE message_id = $1`,
        [res.body.message.id],
      );
      expect(rows[0]?.cnt).toBe('1');
    });

    it('refuses promotional send to a DND-registered number', async () => {
      const conversationId = await seedWhatsappConversation();
      const res = await request(dndApp.getHttpServer())
        .post(MESSAGES(conversationId))
        .set(reader())
        .send({
          body: 'Flash sale today',
          purpose: 'promotional',
          idempotencyKey: 'accept-0187-dnd',
        });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'dnd_refused' });
    });

    it('maps provider rejection to provider_rejected', async () => {
      const conversationId = await seedWhatsappConversation();
      fake.failNextSend('rejected');
      const res = await request(server())
        .post(MESSAGES(conversationId))
        .set(reader())
        .send({
          body: 'Hello',
          purpose: 'transactional',
          idempotencyKey: 'accept-0187-reject',
        });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'provider_rejected' });
    });

    it('requires idempotencyKey', async () => {
      const conversationId = await seedWhatsappConversation();
      const res = await request(server())
        .post(MESSAGES(conversationId))
        .set(reader())
        .send({ body: 'Hello', purpose: 'transactional' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'validation_failed' });
    });
  });

  describe('3. fail closed and isolation', () => {
    it('returns 503 and writes nothing when the provider is unavailable', async () => {
      const conversationId = await seedWhatsappConversation();
      const before = await observer.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM message`,
      );
      const res = await request(failClosedApp.getHttpServer())
        .post(MESSAGES(conversationId))
        .set(reader())
        .send({
          body: 'Hello',
          purpose: 'transactional',
          idempotencyKey: 'accept-0187-null',
        });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'service_unavailable' });
      const after = await observer.query<{ cnt: string }>(
        `SELECT count(*)::text AS cnt FROM message`,
      );
      expect(after.rows[0]?.cnt).toBe(before.rows[0]?.cnt);
    });

    it('returns 404 for an unknown conversation', async () => {
      const res = await request(server())
        .post(MESSAGES('00000000-0000-4000-8000-000000009999'))
        .set(reader())
        .send({
          body: 'Hello',
          purpose: 'transactional',
          idempotencyKey: 'accept-0187-404',
        });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'not_found' });
    });
  });
});
