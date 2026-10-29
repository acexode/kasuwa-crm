import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { DndRegister } from '@kasuwa/channel-adapter';
import {
  createPool,
  newId,
  PROGRAMME_A1,
  TENANT_A,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { hashE164ForConsent } from '@kasuwa/domain-core';
import { FakeChannelProvider, FakeDndRegister } from '@kasuwa/channel-adapter';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

const repoRoot = resolve(__dirname, '..', '..', '..');
const MESSAGES = (conversationId: string) =>
  `/api/v1/conversations/${conversationId}/messages`;

const CONTACT_A1 = '11111111-0000-4000-8000-0000000e0001';
const CONTACT_A1_PHONE = '+2348031234001';

class ThrowingDndRegister implements DndRegister {
  async isRegistered(): Promise<boolean> {
    throw new Error('register down');
  }
}

describe('acceptance: inbox consent and DND (T-0189)', () => {
  let app: INestApplication;
  let dndApp: INestApplication;
  let failApp: INestApplication;
  let observer: Pool;
  let pool: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'), {
      channelProvider: new FakeChannelProvider(),
      dndRegister: new FakeDndRegister([]),
    });
    dndApp = await createApi(inject('databaseUrl'), {
      channelProvider: new FakeChannelProvider(),
      dndRegister: new FakeDndRegister([CONTACT_A1_PHONE]),
    });
    failApp = await createApi(inject('databaseUrl'), {
      channelProvider: new FakeChannelProvider(),
      dndRegister: new ThrowingDndRegister(),
    });
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    pool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await dndApp?.close();
    await failApp?.close();
    await observer?.end();
    await pool?.end();
    await reseed(inject('migrationUrl'));
  });

  const reader = () => asUser(TENANT_A, USER_A_AGENT_1);

  async function seedWhatsappConversation(): Promise<string> {
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

  it('lists consent_check in TENANT_SCOPED_TABLES and migration 0059 on disk', () => {
    expect(TENANT_SCOPED_TABLES).toContain('consent_check');
    expect(
      existsSync(resolve(repoRoot, 'packages/db/migrations/0059_consent_and_routing.sql')),
    ).toBe(true);
  });

  it('audits allowed transactional send', async () => {
    const conversationId = await seedWhatsappConversation();
    const res = await request(app.getHttpServer())
      .post(MESSAGES(conversationId))
      .set(reader())
      .send({
        body: 'Receipt',
        purpose: 'transactional',
        idempotencyKey: 'consent-tx-1',
      });
    expect(res.status).toBe(201);

    const hash = hashE164ForConsent(TENANT_A, CONTACT_A1_PHONE);
    const { rows } = await observer.query<{ outcome: string; purpose: string }>(
      `SELECT outcome, purpose FROM consent_check
        WHERE tenant_id = $1::uuid AND programme_id = $2::uuid AND e164_hash = $3
        ORDER BY created_at DESC LIMIT 1`,
      [TENANT_A, PROGRAMME_A1, hash],
    );
    expect(rows[0]).toMatchObject({ outcome: 'allowed', purpose: 'transactional' });
  });

  it('audits dnd_refused and returns 403 for promotional send to a registered number', async () => {
    const conversationId = await seedWhatsappConversation();
    const res = await request(dndApp.getHttpServer())
      .post(MESSAGES(conversationId))
      .set(reader())
      .send({
        body: 'Sale',
        purpose: 'promotional',
        idempotencyKey: 'consent-dnd-1',
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'dnd_refused' });

    const hash = hashE164ForConsent(TENANT_A, CONTACT_A1_PHONE);
    const { rows } = await observer.query<{ outcome: string }>(
      `SELECT outcome FROM consent_check
        WHERE tenant_id = $1::uuid AND e164_hash = $2 ORDER BY created_at DESC LIMIT 1`,
      [TENANT_A, hash],
    );
    expect(rows[0]?.outcome).toBe('dnd_refused');
  });

  it('fail-closes when the register lookup throws', async () => {
    const conversationId = await seedWhatsappConversation();
    const res = await request(failApp.getHttpServer())
      .post(MESSAGES(conversationId))
      .set(reader())
      .send({
        body: 'Sale',
        purpose: 'promotional',
        idempotencyKey: 'consent-unavail-1',
      });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'service_unavailable' });

    const hash = hashE164ForConsent(TENANT_A, CONTACT_A1_PHONE);
    const { rows } = await observer.query<{ outcome: string }>(
      `SELECT outcome FROM consent_check
        WHERE tenant_id = $1::uuid AND e164_hash = $2 ORDER BY created_at DESC LIMIT 1`,
      [TENANT_A, hash],
    );
    expect(rows[0]?.outcome).toBe('unavailable');
  });
});
