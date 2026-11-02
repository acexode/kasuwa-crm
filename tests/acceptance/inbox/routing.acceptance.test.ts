import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  newId,
  PROGRAMME_A1,
  TENANT_A,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  withTenantTransaction,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

const repoRoot = resolve(__dirname, '..', '..', '..');
const QUEUES = (programmeId: string) => `/api/v1/programmes/${programmeId}/inbox-queues`;
const CANNED = (programmeId: string) => `/api/v1/programmes/${programmeId}/canned-responses`;
const ASSIGN = (conversationId: string) => `/api/v1/conversations/${conversationId}/assign`;
const TRANSFER = (conversationId: string) => `/api/v1/conversations/${conversationId}/transfer`;

const CONTACT_A1 = '11111111-0000-4000-8000-0000000e0001';

describe('acceptance: inbox routing (T-0190)', () => {
  let offApp: INestApplication;
  let onApp: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    offApp = await createApi(inject('databaseUrl'));
    onApp = await createApi(inject('databaseUrl'), { inboxRoutingEnabled: true });
    pool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await offApp?.close();
    await onApp?.close();
    await pool?.end();
    await reseed(inject('migrationUrl'));
  });

  const reader = () => asUser(TENANT_A, USER_A_AGENT_1);

  async function seedConversation(): Promise<string> {
    const conversationId = newId();
    await withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
      await tx.query(
        `INSERT INTO conversation
           (id, tenant_id, programme_id, contact_id, channel, status)
         VALUES ($1, $2, $3, $4, 'whatsapp', 'open')`,
        [conversationId, TENANT_A, PROGRAMME_A1, CONTACT_A1],
      );
    });
    return conversationId;
  }

  it('registers inbox_routing and tenant-scoped queue tables', () => {
    expect(FLAGS.inbox_routing.owner).toBe('T-0190');
    expect(TENANT_SCOPED_TABLES).toContain('inbox_queue');
    expect(TENANT_SCOPED_TABLES).toContain('canned_response');
    expect(
      existsSync(resolve(repoRoot, 'packages/db/migrations/0059_consent_and_routing.sql')),
    ).toBe(true);
  });

  it('returns 404 for routing routes when the flag is off', async () => {
    const res = await request(offApp.getHttpServer()).get(QUEUES(PROGRAMME_A1)).set(reader());
    expect(res.status).toBe(404);
  });

  it('creates and lists queues and canned responses', async () => {
    expect(
      (await request(onApp.getHttpServer()).post(QUEUES(PROGRAMME_A1)).set(reader()).send({ name: 'Collections' }))
        .status,
    ).toBe(201);
    expect((await request(onApp.getHttpServer()).get(QUEUES(PROGRAMME_A1)).set(reader())).body.data).toHaveLength(
      1,
    );
    expect(
      (
        await request(onApp.getHttpServer())
          .post(CANNED(PROGRAMME_A1))
          .set(reader())
          .send({ title: 'Greeting', body: 'Hello' })
      ).status,
    ).toBe(201);
    expect((await request(onApp.getHttpServer()).get(CANNED(PROGRAMME_A1)).set(reader())).body.data).toHaveLength(
      1,
    );
  });

  it('assigns and transfers conversation assignee', async () => {
    const conversationId = await seedConversation();
    const assign = await request(onApp.getHttpServer())
      .post(ASSIGN(conversationId))
      .set(reader())
      .send({ userId: USER_A_AGENT_1 });
    expect(assign.status).toBe(200);

    const transfer = await request(onApp.getHttpServer())
      .post(TRANSFER(conversationId))
      .set(reader())
      .send({ targetUserId: USER_A_AGENT_2 });
    expect(transfer.status).toBe(200);
    expect(
      transfer.body.participants.some(
        (p: { userId: string; role: string }) => p.userId === USER_A_AGENT_2 && p.role === 'assignee',
      ),
    ).toBe(true);
  });
});
