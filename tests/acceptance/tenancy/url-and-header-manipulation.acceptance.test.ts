import type { INestApplication } from '@nestjs/common';
import {
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — a caller cannot widen their own scope by editing the request.
 *
 * Source: PRD US-1 AC2 ("even via global search or URL manipulation").
 *
 * The two attacks that matter:
 *   1. URL manipulation — asking for a specific record id that belongs to
 *      someone else. Must be 404, never 403: a 403 confirms the record exists.
 *   2. Header injection — supplying a programme scope directly. The stub auth
 *      transport is headers, so this is the obvious thing to try. Scope must be
 *      resolved server-side from user_programme, and an attempt to supply it
 *      must be rejected outright rather than silently ignored.
 */

const firstContactIn = (programmeId: string) => {
  const contact = SEED_CONTACTS.find((row) => row.programmeId === programmeId);
  if (contact === undefined) {
    throw new Error(`Fixture drift: no seeded contact in programme ${programmeId}`);
  }
  return contact;
};

describe('acceptance: URL and header manipulation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  it('serves a contact the caller is entitled to', async () => {
    const own = firstContactIn(PROGRAMME_A1);
    const response = await request(server())
      .get(`/api/v1/contacts/${own.id}`)
      .set(asUser(TENANT_A, USER_A_AGENT_1))
      .expect(200);

    expect(response.body.id).toBe(own.id);
  });

  it('returns 404, not 403, for a contact in another tenant', async () => {
    const otherTenant = firstContactIn(PROGRAMME_B1);
    await request(server())
      .get(`/api/v1/contacts/${otherTenant.id}`)
      .set(asUser(TENANT_A, USER_A_AGENT_1))
      .expect(404);
  });

  it('returns 404 for a contact in a sibling programme of the same tenant', async () => {
    const siblingProgramme = firstContactIn(PROGRAMME_A2);
    await request(server())
      .get(`/api/v1/contacts/${siblingProgramme.id}`)
      .set(asUser(TENANT_A, USER_A_AGENT_1))
      .expect(404);
  });

  it('is symmetric: tenant B cannot read tenant A either', async () => {
    const tenantAContact = firstContactIn(PROGRAMME_A1);
    await request(server())
      .get(`/api/v1/contacts/${tenantAContact.id}`)
      .set(asUser(TENANT_B, USER_B_AGENT_1))
      .expect(404);
  });

  it('rejects a request that tries to supply its own programme scope', async () => {
    await request(server())
      .get('/api/v1/contacts')
      .set(asUser(TENANT_A, USER_A_AGENT_1))
      .set('x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`)
      .expect(400);
  });

  it('rejects the singular scope header form too', async () => {
    await request(server())
      .get('/api/v1/contacts')
      .set(asUser(TENANT_A, USER_A_AGENT_1))
      .set('x-kasuwa-programme-id', PROGRAMME_A2)
      .expect(400);
  });

  it('ignores unknown query parameters rather than treating them as filters', async () => {
    // A caller guessing at a `programmeId` filter must not be able to pivot
    // into another programme, whether the parameter is honoured or not.
    const response = await request(server())
      .get(`/api/v1/contacts?programmeId=${PROGRAMME_A2}&tenantId=${TENANT_B}`)
      .set(asUser(TENANT_A, USER_A_AGENT_1))
      .expect(200);

    const programmes = new Set(
      (response.body.data as { programmeId: string }[]).map((row) => row.programmeId),
    );
    expect([...programmes]).toEqual([PROGRAMME_A1]);
  });

  it('rejects a malformed contact id rather than coercing it', async () => {
    await request(server())
      .get('/api/v1/contacts/not-a-uuid')
      .set(asUser(TENANT_A, USER_A_AGENT_1))
      .expect(400);
  });
});
