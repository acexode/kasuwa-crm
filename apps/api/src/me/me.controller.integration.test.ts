import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PROGRAMME_A1,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
} from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../app.module';
import { STUB_TENANT_HEADER, STUB_USER_HEADER } from '../tenancy/auth-context';

/**
 * T-0043 — GET /api/v1/me/programmes through the real guard, interceptor and
 * database. The acceptance suite owns the scope rules; this pins the edges of
 * the route itself: `no-store`, and one 401 for no credentials, a real user
 * under the wrong tenant and an unknown user, none of them naming anything.
 *
 * Each request is built immediately before it is awaited: supertest closes the
 * ephemeral server it started once the requests it knows about settle, so a
 * request built earlier and awaited later is refused.
 */

const ME_PROGRAMMES = '/api/v1/me/programmes';
/** Invented; nothing seeds it. */
const NOWHERE_USER = '11111111-0000-4000-8000-0000004300fe';

const as = (tenantId: string, userId: string) => ({
  [STUB_TENANT_HEADER]: tenantId,
  [STUB_USER_HEADER]: userId,
});

const programmeNames = SEED_TENANTS.flatMap((tenant) => tenant.programmes).map(
  (programme) => programme.name,
);

describe('GET /api/v1/me/programmes (T-0043)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot({ databaseUrl: inject('databaseUrl'), poolMax: 3 })],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('answers the caller its own programmes, closed, with Cache-Control: no-store', async () => {
    const response = await request(app.getHttpServer())
      .get(ME_PROGRAMMES)
      .set(as(TENANT_A, USER_A_AGENT_1));
    expect(response.status, response.text).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.body as { data: { id: string; name: string }[] };
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.map((row) => row.id)).toEqual([PROGRAMME_A1]);
    for (const row of body.data) expect(Object.keys(row).sort()).toEqual(['id', 'name']);
  });

  const UNAUTHENTICATED: [string, Record<string, string>][] = [
    ['no credentials', {}],
    ['a real user under the wrong tenant', as(TENANT_B, USER_A_AGENT_2)],
    ['an unknown user', as(TENANT_A, NOWHERE_USER)],
  ];

  it.each(UNAUTHENTICATED)('%s is 401 and names no programme', async (_label, headers) => {
    const response = await request(app.getHttpServer()).get(ME_PROGRAMMES).set(headers);
    expect(response.status, response.text).toBe(401);
    for (const name of programmeNames) expect(response.text).not.toContain(name);
  });

  it('answers all three unauthenticated callers with one identical body (no oracle)', async () => {
    const bodies: string[] = [];
    for (const [, headers] of UNAUTHENTICATED) {
      // Built and awaited one at a time (see the header).
      const response = await request(app.getHttpServer()).get(ME_PROGRAMMES).set(headers);
      expect(response.status, response.text).toBe(401);
      bodies.push(response.text);
    }
    // Vacuity guard: an empty body would make "identical" meaningless.
    expect(bodies[0]?.length ?? 0).toBeGreaterThan(0);
    expect(new Set(bodies).size, `distinguishable 401 bodies: ${bodies.join(' | ')}`).toBe(1);
  });

  it('sends the contact list Cache-Control: no-store too (it carries owner names)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/contacts')
      .set(as(TENANT_A, USER_A_AGENT_1));
    expect(response.status, response.text).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
