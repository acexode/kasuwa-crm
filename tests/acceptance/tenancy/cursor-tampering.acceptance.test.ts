import type { INestApplication } from '@nestjs/common';
import { PROGRAMME_A1, SEED_CONTACTS, TENANT_A, TENANT_B, USER_A_AGENT_1 } from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — pagination cursors are positions, not capabilities.
 *
 * Cursors are the classic place authority leaks into a client-editable value:
 * encode a tenant id "for convenience", and the cursor becomes a way to ask for
 * someone else's page. packages/domain/core/src/cursor.ts deliberately encodes
 * only `createdAt` and `id`, and this suite is what stops that changing.
 *
 * It also checks the mundane half — that pagination actually works — because a
 * cursor that never returns a second page would make every assertion here pass
 * for the wrong reason.
 */

const encode = (payload: unknown) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

describe('acceptance: cursor tampering', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) =>
    request(app.getHttpServer()).get(path).set(asUser(TENANT_A, USER_A_AGENT_1));

  it('paginates through the caller’s own programme and then stops', async () => {
    const firstPage = await get('/api/v1/contacts?limit=2').expect(200);
    expect(firstPage.body.data).toHaveLength(2);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await get(
      `/api/v1/contacts?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
    ).expect(200);

    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();

    const seen = [...firstPage.body.data, ...secondPage.body.data].map(
      (row: { id: string }) => row.id,
    );
    expect(new Set(seen).size).toBe(3);
    for (const row of [...firstPage.body.data, ...secondPage.body.data]) {
      expect((row as { programmeId: string }).programmeId).toBe(PROGRAMME_A1);
    }
  });

  it('ignores tenant and programme fields smuggled into a cursor', async () => {
    const tampered = encode({
      c: '2020-01-01T00:00:00.000Z',
      i: '00000000-0000-4000-8000-000000000000',
      tenantId: TENANT_B,
      programmeId: 'any',
      tenant_id: TENANT_B,
    });

    const response = await get(`/api/v1/contacts?cursor=${encodeURIComponent(tampered)}`).expect(
      200,
    );

    // The extra fields are not part of the schema, so they are dropped. The
    // position they encode is before every seeded row, so the page is empty —
    // but crucially it is empty, not tenant B's data.
    expect(response.body.data).toEqual([]);
  });

  it('cannot reach another tenant’s rows by pointing a cursor at them', async () => {
    const tenantBContact = SEED_CONTACTS.find((row) => row.tenantId === TENANT_B);
    expect(tenantBContact).toBeDefined();

    const pointed = encode({
      c: new Date(Date.parse(tenantBContact!.createdAt) + 60_000).toISOString(),
      i: tenantBContact!.id,
    });

    const response = await get(`/api/v1/contacts?cursor=${encodeURIComponent(pointed)}`).expect(
      200,
    );

    const tenantBIds = new Set(
      SEED_CONTACTS.filter((row) => row.tenantId === TENANT_B).map((row) => row.id),
    );
    for (const row of response.body.data as { id: string }[]) {
      expect(tenantBIds.has(row.id)).toBe(false);
    }
  });

  it('rejects a malformed cursor with 400 rather than ignoring it', async () => {
    await get('/api/v1/contacts?cursor=not-base64-json').expect(400);
    await get(`/api/v1/contacts?cursor=${encode({ c: 'not-a-date', i: 'not-a-uuid' })}`).expect(
      400,
    );
  });

  it('rejects a limit outside the allowed range', async () => {
    await get('/api/v1/contacts?limit=0').expect(400);
    await get('/api/v1/contacts?limit=1000').expect(400);
  });
});
