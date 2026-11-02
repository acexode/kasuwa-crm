import type { INestApplication } from '@nestjs/common';
import {
  PROGRAMME_A1,
  TENANT_A,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { FX_LOCK_TTL_MS } from '@kasuwa/domain-core';
import { reseed } from '@kasuwa/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/** ACCEPTANCE — T-0175: admin FX rates and 24h deal locks (provisional B5). */

const FX_RATES = (programmeId: string) => `/api/v1/programmes/${programmeId}/fx-rates`;
const FX_LATEST = (programmeId: string) => `/api/v1/programmes/${programmeId}/fx-rates/latest`;
const FX_LOCK = (dealId: string) => `/api/v1/deals/${dealId}/fx-lock`;

const DEAL_A1 = '11111111-0000-4000-8000-000000170001';

describe('acceptance: fx lock (T-0175)', () => {
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
  const admin = () => asUser(TENANT_A, USER_A_SUPERVISOR);
  const agent = () => asUser(TENANT_A, USER_A_AGENT_1);

  it('registers fx_lock off by default', () => {
    expect(FLAGS.fx_lock.defaultValue).toBe(false);
    expect(TENANT_SCOPED_TABLES).toContain('fx_rate');
    expect(TENANT_SCOPED_TABLES).toContain('fx_lock');
  });

  it('stores admin-entered rates and locks a deal for 24h', async () => {
    const rate = await request(server())
      .post(FX_RATES(PROGRAMME_A1))
      .set(admin())
      .send({ baseCurrency: 'NGN', quoteCurrency: 'GHS', rateMicros: '6500000' });
    expect(rate.status).toBe(201);
    expect(rate.body.rateMicros).toBe('6500000');

    const agentDenied = await request(server())
      .post(FX_RATES(PROGRAMME_A1))
      .set(agent())
      .send({ baseCurrency: 'NGN', quoteCurrency: 'GHS', rateMicros: '1' });
    expect(agentDenied.status).toBe(403);

    const latest = await request(server())
      .get(`${FX_LATEST(PROGRAMME_A1)}?baseCurrency=NGN&quoteCurrency=GHS`)
      .set(agent());
    expect(latest.status).toBe(200);
    expect(latest.body.rateMicros).toBe('6500000');

    const lock = await request(server())
      .post(FX_LOCK(DEAL_A1))
      .set(agent())
      .send({ baseCurrency: 'NGN', quoteCurrency: 'GHS' });
    expect(lock.status).toBe(201);
    expect(lock.body.rateMicros).toBe('6500000');
    const expires = new Date(lock.body.expiresAt).getTime();
    expect(expires - Date.now()).toBeLessThanOrEqual(FX_LOCK_TTL_MS + 5000);
    expect(expires - Date.now()).toBeGreaterThan(FX_LOCK_TTL_MS - 60000);

    const read = await request(server()).get(FX_LOCK(DEAL_A1)).set(agent());
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(lock.body.id);
  });
});
