import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0018, server-side first-admin onboarding (D-L205).
 *
 *   getOnboarding    GET  /api/v1/me/onboarding       200 | 404 (flag off or none saved)
 *   putOnboardingStep PUT /api/v1/me/onboarding/step  200
 *
 * Behind `onboarding_persistence` (on in `pnpm demo`, off elsewhere).
 */

const ROUTE = '/api/v1/me/onboarding';
const STEP_ROUTE = '/api/v1/me/onboarding/step';

describe('acceptance: onboarding persistence (T-0018)', () => {
  let app: INestApplication;
  let appOff: INestApplication;
  let observer: Pool;

  beforeAll(async () => {
    const url = inject('databaseUrl');
    app = await createApi(url, { onboardingPersistence: true });
    appOff = await createApi(url, { onboardingPersistence: false });
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await appOff?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const serverOff = () => appOff.getHttpServer();
  const me = asUser(TENANT_A, USER_A_SUPERVISOR);

  it('registers onboarding_state and the flag', () => {
    expect(TENANT_SCOPED_TABLES).toContain('onboarding_state');
    expect(FLAGS.onboarding_persistence?.defaultValue).toBe(false);
  });

  it('returns 404 when onboarding_persistence is off', async () => {
    const response = await request(serverOff()).get(ROUTE).set(me);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'not_found' });
  });

  it('returns 404 until a step is saved, then round-trips PUT and GET', async () => {
    expect((await request(server()).get(ROUTE).set(me)).status).toBe(404);

    const body = {
      step: 'currency_language',
      payload: { currency: 'ZAR', teamLanguage: 'en' },
    };
    const saved = await request(server()).put(STEP_ROUTE).set(me).send(body);
    expect(saved.status).toBe(200);
    expect(saved.body.step).toBe('currency_language');
    expect(saved.body.payload).toEqual(body.payload);

    const read = await request(server()).get(ROUTE).set(me);
    expect(read.status).toBe(200);
    expect(read.body.step).toBe('currency_language');
    expect(read.headers['cache-control']).toMatch(/no-store/);
  });

  it('scopes state to the session user', async () => {
    await request(server())
      .put(STEP_ROUTE)
      .set(me)
      .send({ step: 'whatsapp', payload: { skipped: true } });

    const other = asUser(TENANT_A, USER_A_AGENT_1);
    expect((await request(server()).get(ROUTE).set(other)).status).toBe(404);

    await request(server())
      .put(STEP_ROUTE)
      .set(asUser(TENANT_B, USER_B_AGENT_1))
      .send({ step: 'import', payload: {} });
    expect((await request(server()).get(ROUTE).set(me)).body.step).toBe('whatsapp');
  });
});
