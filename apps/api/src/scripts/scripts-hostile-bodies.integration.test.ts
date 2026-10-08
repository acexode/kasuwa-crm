import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SEED_SCRIPTS, TENANT_A, USER_A_SUPERVISOR } from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../app.module';
import { STUB_TENANT_HEADER, STUB_USER_HEADER } from '../tenancy/auth-context';

/**
 * T-0113 security review: hostile bodies through the real app (guard,
 * interceptor, filters, body parser and database). Each is answered 400
 * quickly, with at most 50 details, and the event loop is never held.
 * A script author sends them, so they reach the body checks.
 */

const AUTHOR = { [STUB_TENANT_HEADER]: TENANT_A, [STUB_USER_HEADER]: USER_A_SUPERVISOR };
const seeded = SEED_SCRIPTS[0];
if (seeded === undefined) throw new Error('Fixture drift: the seed carries no script');
const SCRIPT = `/api/v1/scripts/${seeded.id}`;

/** The review's body: `{"x":"\u0000","a":{...}}`, nested to about 512 KiB. */
function nestedAttack(bytes = 500 * 1024): string {
  const level = '{"x":"\\u0000","a":';
  const depth = Math.floor((bytes - 2) / (level.length + 1));
  return `{"revision":1,"graph":${level.repeat(depth)}{}${'}'.repeat(depth)}}`;
}

describe('hostile script bodies are refused fast (T-0113)', () => {
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

  it('the nested 512 KiB body is one 400 too_deep', async () => {
    const started = Date.now();
    const response = await request(server())
      .patch(SCRIPT)
      .set(AUTHOR)
      .set('Content-Type', 'application/json')
      .send(nestedAttack());
    expect(response.status, response.text.slice(0, 300)).toBe(400);
    expect(response.body).toMatchObject({
      code: 'validation_failed',
      details: [{ path: '', code: 'too_deep' }],
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a 512 KiB nodes: [{}, {}, ...] is one 400 too_big at graph.nodes', async () => {
    const body = `{"revision":1,"graph":{"startNodeId":"a","nodes":[${'{},'.repeat(170_000)}{}]}}`;
    const started = Date.now();
    const response = await request(server())
      .patch(SCRIPT)
      .set(AUTHOR)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(response.status, response.text.slice(0, 300)).toBe(400);
    expect(response.body).toMatchObject({
      code: 'validation_failed',
      details: [{ path: 'graph.nodes', code: 'too_big' }],
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a body of thousands of NULs carries at most 50 details', async () => {
    const changes = Array.from({ length: 5000 }, () => '\u0000');
    const response = await request(server())
      .post(`${SCRIPT}/versions`)
      .set(AUTHOR)
      .send({ revision: 1, changes });
    expect(response.status).toBe(400);
    const details = (response.body as { details: unknown[] }).details;
    expect(details.length).toBeGreaterThan(0);
    expect(details.length).toBeLessThanOrEqual(50);
  });

  it('a urlencoded body is not parsed: the write is a 400, never applied', async () => {
    const response = await request(server())
      .patch(SCRIPT)
      .set(AUTHOR)
      .type('form')
      .send('revision=1&name=Renamed');
    expect(response.status).toBe(400);
    const read = await request(server()).get(SCRIPT).set(AUTHOR);
    expect((read.body as { name: string }).name).toBe(seeded.name);
  });
});
