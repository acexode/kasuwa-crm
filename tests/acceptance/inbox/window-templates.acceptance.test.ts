import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  newId,
  PROGRAMME_A1,
  TENANT_A,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { FakeChannelProvider, FakeDndRegister } from '@kasuwa/channel-adapter';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

const repoRoot = resolve(__dirname, '..', '..', '..');
const TEMPLATES = (programmeId: string) =>
  `/api/v1/programmes/${programmeId}/message-templates`;
const MESSAGES = (conversationId: string) =>
  `/api/v1/conversations/${conversationId}/messages`;

const CONTACT_A1 = '11111111-0000-4000-8000-0000000e0001';

describe('acceptance: inbox window templates (T-0188)', () => {
  let offApp: INestApplication;
  let onApp: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    const dnd = new FakeDndRegister([]);
    offApp = await createApi(inject('databaseUrl'), {
      channelProvider: new FakeChannelProvider(),
      dndRegister: dnd,
    });
    onApp = await createApi(inject('databaseUrl'), {
      channelProvider: new FakeChannelProvider(),
      dndRegister: dnd,
      inboxTemplatesEnabled: true,
    });
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

  async function seedWhatsappConversation(inboundAgeHours: number | null): Promise<string> {
    const conversationId = newId();
    await withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, async (tx) => {
      await tx.query(
        `INSERT INTO conversation
           (id, tenant_id, programme_id, contact_id, channel, status)
         VALUES ($1, $2, $3, $4, 'whatsapp', 'open')`,
        [conversationId, TENANT_A, PROGRAMME_A1, CONTACT_A1],
      );
      if (inboundAgeHours !== null) {
        await tx.query(
          `INSERT INTO message
             (id, tenant_id, programme_id, conversation_id, direction, body_redacted)
           VALUES ($1, $2, $3, $4, 'inbound', 'hello')`,
          [newId(), TENANT_A, PROGRAMME_A1, conversationId],
        );
        if (inboundAgeHours > 0) {
          await tx.query(
            `UPDATE message SET created_at = now() - ($1::text || ' hours')::interval
              WHERE conversation_id = $2::uuid AND direction = 'inbound'`,
            [String(inboundAgeHours), conversationId],
          );
        }
      }
    });
    return conversationId;
  }

  it('registers inbox_templates and lists message_template in TENANT_SCOPED_TABLES', () => {
    expect(FLAGS.inbox_templates.owner).toBe('T-0188');
    expect(TENANT_SCOPED_TABLES).toContain('message_template');
    expect(
      existsSync(resolve(repoRoot, 'packages/db/migrations/0056_message_template.sql')),
    ).toBe(true);
  });

  it('returns 404 for template routes when the flag is off', async () => {
    const res = await request(offApp.getHttpServer())
      .get(TEMPLATES(PROGRAMME_A1))
      .set(reader());
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'not_found' });
  });

  it('creates and lists templates when the flag is on', async () => {
    const created = await request(onApp.getHttpServer())
      .post(TEMPLATES(PROGRAMME_A1))
      .set(reader())
      .send({
        name: 'Payment reminder',
        channel: 'whatsapp',
        category: 'utility',
        body: 'Your plan is ready',
      });
    expect(created.status).toBe(201);

    const list = await request(onApp.getHttpServer())
      .get(TEMPLATES(PROGRAMME_A1))
      .set(reader());
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it('refuses free-form send outside the window and accepts a template send', async () => {
    const conversationId = await seedWhatsappConversation(30);
    const blocked = await request(onApp.getHttpServer())
      .post(MESSAGES(conversationId))
      .set(reader())
      .send({
        body: 'Free reply',
        purpose: 'transactional',
        idempotencyKey: 'win-block-1',
      });
    expect(blocked.status).toBe(400);
    expect(blocked.body).toMatchObject({ code: 'window_closed' });

    const template = await request(onApp.getHttpServer())
      .post(TEMPLATES(PROGRAMME_A1))
      .set(reader())
      .send({
        name: 'Follow up',
        channel: 'whatsapp',
        category: 'utility',
        body: 'Approved template body',
      });
    const templateId = template.body.data.id as string;

    const ok = await request(onApp.getHttpServer())
      .post(MESSAGES(conversationId))
      .set(reader())
      .send({
        messageTemplateId: templateId,
        purpose: 'transactional',
        idempotencyKey: 'win-template-1',
      });
    expect(ok.status).toBe(201);
    expect(ok.body.message.bodyRedacted).toBe('Approved template body');
  });

  it('allows free-form send inside the window', async () => {
    const conversationId = await seedWhatsappConversation(2);
    const res = await request(onApp.getHttpServer())
      .post(MESSAGES(conversationId))
      .set(reader())
      .send({
        body: 'Inside window',
        purpose: 'transactional',
        idempotencyKey: 'win-open-1',
      });
    expect(res.status).toBe(201);
  });

  it('declares template operations in inbox.openapi.yaml', () => {
    const spec = parse(
      readFileSync(resolve(repoRoot, 'docs/api/inbox.openapi.yaml'), 'utf8'),
    ) as {
      paths: Record<string, Record<string, { operationId?: string; 'x-kasuwa-implemented'?: boolean }>>;
    };
    expect(spec.paths['/api/v1/programmes/{programmeId}/message-templates']?.get?.operationId).toBe(
      'listTemplates',
    );
  });
});
