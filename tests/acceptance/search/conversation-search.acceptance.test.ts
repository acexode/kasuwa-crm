import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  newId,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0193: conversation as a search type. Scope is the session's.
 *
 *   R1. `conversation_search` off: `types=conversation` is `400 validation_failed`
 *       (unknown_type), and the default set stays the four.
 *   R2. On, a caller sees only conversations in programmes the session reaches.
 *       Text that exists only in another programme of the tenant, or in another
 *       tenant, finds nothing: the group is present and its hits are empty.
 *   R3. The match is on the subject or on a stored (redacted) message body.
 *   R4. Nothing outside the session is counted or hinted: no extra keys on the
 *       answer, and the other programme's text and ids appear nowhere in it.
 */

const SEARCH = '/api/v1/search';

function contactIn(programmeId: string): string {
  const contact = SEED_CONTACTS.find((row) => row.programmeId === programmeId);
  if (contact === undefined) throw new Error(`no seed contact in ${programmeId}`);
  return contact.id;
}

describe('acceptance: conversation search scope (T-0193)', () => {
  let on: INestApplication;
  let off: INestApplication;
  let pool: Pool;
  const ids = { a1: newId(), a2: newId(), a2Body: newId(), b1: newId() };

  async function seed(
    tenantId: string,
    userId: string,
    programmeId: string,
    conversationId: string,
    subject: string,
    body: string,
  ): Promise<void> {
    await withTenantTransaction(pool, { tenantId, userId }, async (tx) => {
      await tx.query(
        `INSERT INTO conversation
           (id, tenant_id, programme_id, contact_id, channel, status, subject, last_message_at)
         VALUES ($1, $2, $3, $4, 'whatsapp', 'open', $5, now())`,
        [conversationId, tenantId, programmeId, contactIn(programmeId), subject],
      );
      await tx.query(
        `INSERT INTO message
           (id, tenant_id, programme_id, conversation_id, direction, body_redacted)
         VALUES ($1, $2, $3, $4, 'inbound', $5)`,
        [newId(), tenantId, programmeId, conversationId, body],
      );
    });
  }

  beforeAll(async () => {
    on = await createApi(inject('databaseUrl'), { conversationSearchEnabled: true });
    off = await createApi(inject('databaseUrl'));
    pool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
    await reseed(inject('migrationUrl'));
    await seed(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, ids.a1, 'Zebra renewal', 'hello');
    await seed(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A2, ids.a2, 'Zebra hidden', 'hello');
    await seed(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A2, ids.a2Body, 'Plain', 'quokka secret');
    await seed(TENANT_B, USER_B_AGENT_1, PROGRAMME_B1, ids.b1, 'Zebra other tenant', 'quokka');
  });

  afterAll(async () => {
    await on?.close();
    await off?.close();
    await pool?.end();
    await reseed(inject('migrationUrl'));
  });

  const search = (app: INestApplication, q: string, types = 'conversation') =>
    request(app.getHttpServer())
      .get(SEARCH)
      .query({ q, types })
      .set(asUser(TENANT_A, USER_A_AGENT_1));

  it('R1: with the flag off, conversation is an unknown type', async () => {
    const response = await search(off, 'zebra');
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(ids.a1);
  });

  it('R2/R3: a programme-A1 agent finds only the A1 subject match', async () => {
    const response = await search(on, 'zebra');
    expect(response.status).toBe(200);
    const groups = response.body.groups as { type: string; hits: { id: string }[] }[];
    expect(groups.map((group) => group.type)).toEqual(['conversation']);
    expect(groups[0]?.hits.map((hit) => hit.id)).toEqual([ids.a1]);
    const text = JSON.stringify(response.body);
    for (const hidden of [ids.a2, ids.a2Body, ids.b1, 'hidden', 'other tenant']) {
      expect(text, `leaked ${hidden}`).not.toContain(hidden);
    }
  });

  it('R2: text that exists only in another programme or tenant finds nothing', async () => {
    const response = await search(on, 'quokka');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ groups: [{ type: 'conversation', hits: [] }] });
  });

  it('R4: the answer carries no count or hint beyond the groups', async () => {
    const response = await search(on, 'zebra');
    expect(Object.keys(response.body as object)).toEqual(['groups']);
  });

  it('R2: a supervisor who reaches both programmes sees both A hits and never tenant B', async () => {
    const response = await request(on.getHttpServer())
      .get(SEARCH)
      .query({ q: 'zebra', types: 'conversation' })
      .set(asUser(TENANT_A, USER_A_SUPERVISOR));
    const found = (response.body.groups[0].hits as { id: string }[]).map((hit) => hit.id).sort();
    expect(found).toEqual([ids.a1, ids.a2].sort());
    expect(JSON.stringify(response.body)).not.toContain(ids.b1);
  });
});
