import type { INestApplication } from '@nestjs/common';
import {
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — tenant and programme isolation through the HTTP API.
 *
 * Source: PRD US-1 AC2, "The agent cannot search, view or open records from
 * Programme B, even via global search or URL manipulation (verified by
 * automated isolation tests)." Founding pack 3.3 makes this suite blocking.
 *
 * Fixture shape being relied on (packages/db/src/fixtures.ts):
 *   Tenant A  programme A1: 3 contacts, programme A2: 3 contacts
 *   Tenant B  programme B1: 3 contacts, programme B2: 3 contacts
 *   USER_A_AGENT_1      -> A1 only
 *   USER_A_AGENT_2      -> A2 only
 *   USER_A_SUPERVISOR   -> A1 and A2
 *   USER_A_NO_PROGRAMME -> no membership at all
 *   USER_B_AGENT_1      -> B1 only
 */

const contactsIn = (programmeId: string) =>
  SEED_CONTACTS.filter((contact) => contact.programmeId === programmeId);

describe('acceptance: contact list isolation over HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (headers: Record<string, string>, path = '/api/v1/contacts') =>
    request(app.getHttpServer()).get(path).set(headers);

  it('returns only the contacts of the programmes the caller belongs to', async () => {
    const response = await get(asUser(TENANT_A, USER_A_AGENT_1)).expect(200);

    const returnedIds = (response.body.data as { id: string }[]).map((row) => row.id).sort();
    const expectedIds = contactsIn(PROGRAMME_A1)
      .map((contact) => contact.id)
      .sort();

    expect(returnedIds).toEqual(expectedIds);
  });

  it('never returns another tenant’s contacts', async () => {
    const tenantA = await get(asUser(TENANT_A, USER_A_SUPERVISOR)).expect(200);
    const tenantB = await get(asUser(TENANT_B, USER_B_AGENT_1)).expect(200);

    const aIds = new Set((tenantA.body.data as { id: string }[]).map((row) => row.id));
    const bIds = new Set((tenantB.body.data as { id: string }[]).map((row) => row.id));

    // The two result sets must be disjoint, and neither may be empty — an
    // assertion that both are empty would pass trivially if the endpoint broke.
    expect(aIds.size).toBeGreaterThan(0);
    expect(bIds.size).toBeGreaterThan(0);
    for (const id of bIds) {
      expect(aIds.has(id)).toBe(false);
    }
  });

  it('does not leak a sibling programme inside the same tenant', async () => {
    const response = await get(asUser(TENANT_A, USER_A_AGENT_1)).expect(200);
    const programmes = new Set(
      (response.body.data as { programmeId: string }[]).map((row) => row.programmeId),
    );

    expect([...programmes]).toEqual([PROGRAMME_A1]);
    expect(programmes.has(PROGRAMME_A2)).toBe(false);
  });

  it('gives a multi-programme user the union of their programmes and nothing more', async () => {
    const response = await get(asUser(TENANT_A, USER_A_SUPERVISOR)).expect(200);
    const programmes = new Set(
      (response.body.data as { programmeId: string }[]).map((row) => row.programmeId),
    );

    expect([...programmes].sort()).toEqual([PROGRAMME_A1, PROGRAMME_A2].sort());
  });

  it('returns nothing at all for a user with no programme membership', async () => {
    const response = await get(asUser(TENANT_A, USER_A_NO_PROGRAMME)).expect(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.nextCursor).toBeNull();
  });

  it('rejects a real user id paired with the wrong tenant id', async () => {
    // USER_A_AGENT_2 exists, but not in tenant B. The session resolver must not
    // find them, and the response must not distinguish this from "no such user".
    await get(asUser(TENANT_B, USER_A_AGENT_2)).expect(401);
  });

  it('rejects an unauthenticated request rather than defaulting to any tenant', async () => {
    await request(app.getHttpServer()).get('/api/v1/contacts').expect(401);
  });

  it('rejects a syntactically valid but unknown user', async () => {
    await get(asUser(TENANT_A, '99999999-0000-4000-8000-999999999999')).expect(401);
  });
});
