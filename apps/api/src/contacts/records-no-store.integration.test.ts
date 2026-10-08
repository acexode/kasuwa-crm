import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TENANT_A, USER_A_AGENT_1 } from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../app.module';
import { STUB_TENANT_HEADER, STUB_USER_HEADER } from '../tenancy/auth-context';

/**
 * T-0080 (closing D-L90's follow-up): every records answer is
 * `Cache-Control: no-store`, through the real guard, interceptor, filters and
 * database. Nest sets the handlers' `@Header` after the guards, so the
 * guard's 401 and its scope-header 400 depend on the middleware alone; the
 * 400s and 404s thrown inside a handler are pinned too, so neither layer can
 * be dropped silently. Contacts first, then every other records controller.
 *
 * Each request is built immediately before it is awaited (see
 * me.controller.integration.test.ts).
 */

const CONTACTS = '/api/v1/contacts';
const ACCOUNTS = '/api/v1/accounts';
/** Invented; nothing seeds it. */
const NOWHERE = '11111111-0000-4000-8000-0000008000fe';

const AGENT = { [STUB_TENANT_HEADER]: TENANT_A, [STUB_USER_HEADER]: USER_A_AGENT_1 };

describe('records routes send Cache-Control: no-store on every answer (T-0080)', () => {
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
    // The two the lead named: a guard 401 and a handler 404 on a contacts route.
    ['contacts list, no credentials (guard 401)', () => request(server()).get(CONTACTS), 401],
    [
      'a contact that is nowhere (404)',
      () => request(server()).get(`${CONTACTS}/${NOWHERE}`).set(AGENT),
      404,
    ],
    ['contacts list, signed in', () => request(server()).get(CONTACTS).set(AGENT), 200],
    [
      'contacts list with a scope header (guard 400)',
      () => request(server()).get(CONTACTS).set(AGENT).set('x-kasuwa-scope', 'everything'),
      400,
    ],
    [
      'a contact id that is not a uuid (400)',
      () => request(server()).get(`${CONTACTS}/not-a-uuid`).set(AGENT),
      400,
    ],
    [
      'a contact timeline that is nowhere (404)',
      () => request(server()).get(`${CONTACTS}/${NOWHERE}/timeline`).set(AGENT),
      404,
    ],
    [
      'an account timeline that is not a uuid (404)',
      () => request(server()).get(`${ACCOUNTS}/not-a-uuid/timeline`).set(AGENT),
      404,
    ],
    [
      'an account that is nowhere (404)',
      () => request(server()).get(`${ACCOUNTS}/${NOWHERE}`).set(AGENT),
      404,
    ],
    ['leads list, no credentials (guard 401)', () => request(server()).get('/api/v1/leads'), 401],
    [
      'an activity write, no credentials (guard 401)',
      () => request(server()).post('/api/v1/activities').send({ type: 'note' }),
      401,
    ],
    [
      'an activity update that is nowhere (404)',
      () =>
        request(server())
          .patch(`/api/v1/activities/${NOWHERE}`)
          .set(AGENT)
          .send({ version: 1, completed: true }),
      404,
    ],
    [
      'my programmes, no credentials (guard 401)',
      () => request(server()).get('/api/v1/me/programmes'),
      401,
    ],
  ];

  it.each(CASES)('%s', async (_label, send, status) => {
    const response = await send();
    expect(response.status, response.text).toBe(status);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
