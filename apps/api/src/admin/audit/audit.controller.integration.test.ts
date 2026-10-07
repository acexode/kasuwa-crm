import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TENANT_A, USER_A_AGENT_1 } from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../app.module';
import { STUB_TENANT_HEADER, STUB_USER_HEADER } from '../../tenancy/auth-context';

/**
 * T-0078 — every audit response is `Cache-Control: no-store`, through the
 * real guard, interceptor, filter and database. The handlers' `@Header` is
 * applied after the guards, so this pins the answers a handler never
 * produces: the guard's 401, its scope-header 400, a validation 400 and the
 * one 404, as well as the 200s.
 *
 * Each request is built immediately before it is awaited (see
 * me.controller.integration.test.ts).
 */

const EVENTS = '/api/v1/admin/audit/events';
const FILTER_OPTIONS = '/api/v1/admin/audit/filter-options';
const EXPORTS = '/api/v1/admin/audit/exports';
/** Invented; nothing seeds it. */
const NOWHERE_EXPORT = '11111111-0000-4000-8000-0000007800fe';

const AGENT = { [STUB_TENANT_HEADER]: TENANT_A, [STUB_USER_HEADER]: USER_A_AGENT_1 };

describe('audit routes send Cache-Control: no-store on every answer (T-0078)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          databaseUrl: inject('databaseUrl'),
          authDatabaseUrl: inject('authDatabaseUrl'),
          poolMax: 3,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => app.getHttpServer();

  const CASES: [string, () => request.Test, number][] = [
    ['events, signed in', () => request(server()).get(EVENTS).set(AGENT), 200],
    ['filter-options, signed in', () => request(server()).get(FILTER_OPTIONS).set(AGENT), 200],
    ['events, no credentials (guard 401)', () => request(server()).get(EVENTS), 401],
    [
      'filter-options, no credentials (guard 401)',
      () => request(server()).get(FILTER_OPTIONS),
      401,
    ],
    [
      'export poll, no credentials (guard 401)',
      () => request(server()).get(`${EXPORTS}/${NOWHERE_EXPORT}`),
      401,
    ],
    [
      'export request, no credentials (guard 401)',
      () => request(server()).post(EXPORTS).send({ format: 'csv', scope: 'last_90_days' }),
      401,
    ],
    [
      'events with a scope header (guard 400)',
      () => request(server()).get(EVENTS).set(AGENT).set('x-kasuwa-scope', 'everything'),
      400,
    ],
    [
      'events with an unknown query key (400)',
      () => request(server()).get(`${EVENTS}?programmeId=x`).set(AGENT),
      400,
    ],
    [
      'export poll for no such export (404)',
      () => request(server()).get(`${EXPORTS}/${NOWHERE_EXPORT}`).set(AGENT),
      404,
    ],
    [
      'export request by a non-admin (403)',
      () =>
        request(server()).post(EXPORTS).set(AGENT).send({ format: 'csv', scope: 'last_90_days' }),
      403,
    ],
  ];

  it.each(CASES)('%s', async (_label, send, status) => {
    const response = await send();
    expect(response.status, response.text).toBe(status);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
