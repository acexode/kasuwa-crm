import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  newId,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0185 (M08 P0, Phase 3 S3): conversations depth.
 *
 * THE CONTRACT (`docs/api/inbox.openapi.yaml`):
 *
 *   listConversations  GET  /api/v1/programmes/:programmeId/conversations
 *   getConversation    GET  /api/v1/conversations/:conversationId
 *   listMessages       GET  /api/v1/conversations/:conversationId/messages
 *
 * Scope is resolved from the session; a programme or conversation the caller
 * cannot reach is one 404. Message bodies are already redacted in storage.
 *
 * RULINGS (suite writer — lead amends before the build is approved):
 *
 *   R1. Tables `conversation`, `message` and `conversation_participant` land
 *       in migration 0052, are in TENANT_SCOPED_TABLES, and carry programme-
 *       scoped RLS (enabled and forced). `kasuwa_app` has SELECT and INSERT;
 *       no DELETE; no UPDATE of id / tenant_id / programme_id.
 *   R2. The three read operations are in inbox.openapi.yaml as implemented.
 *   R3. `crm_inbox` is registered and off by default / not production-ready.
 *   R4. Round trip: seed a conversation with a message and participant, list
 *       in programme, get by id, list messages in thread order.
 *   R5. Isolation: another programme, another tenant, and a user with no
 *       programme never see the row; each is one identical 404 body.
 *   R6. no-store on every answer; one 401 without credentials.
 *
 * Out of scope: send, webhooks, routing, templates, P08 screens.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const CONVERSATIONS = (programmeId: string) =>
  `/api/v1/programmes/${programmeId}/conversations`;
const CONVERSATION = (conversationId: string) => `/api/v1/conversations/${conversationId}`;
const MESSAGES = (conversationId: string) =>
  `/api/v1/conversations/${conversationId}/messages`;

const INBOX_TABLES = ['conversation', 'message', 'conversation_participant'] as const;

const CONTACT_A1 = '11111111-0000-4000-8000-0000000e0001';

describe('acceptance: conversations (T-0185)', () => {
  let app: INestApplication;
  let observer: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const reader = () => asUser(TENANT_A, USER_A_AGENT_1);
  let appPool: Pool;

  async function seedConversation(): Promise<string> {
    const conversationId = newId();
    const messageId = newId();
    const participantId = newId();
    await withTenantTransaction(
      appPool,
      { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
      async (tx) => {
        await tx.query(
          `INSERT INTO conversation
             (id, tenant_id, programme_id, contact_id, channel, status, subject, last_message_at)
           VALUES ($1, $2, $3, $4, 'whatsapp', 'open', 'Support thread', now())`,
          [conversationId, TENANT_A, PROGRAMME_A1, CONTACT_A1],
        );
        await tx.query(
          `INSERT INTO message
             (id, tenant_id, programme_id, conversation_id, direction, body_redacted)
           VALUES ($1, $2, $3, $4, 'inbound', 'redacted-body')`,
          [messageId, TENANT_A, PROGRAMME_A1, conversationId],
        );
        await tx.query(
          `INSERT INTO conversation_participant
             (id, tenant_id, programme_id, conversation_id, user_id, role)
           VALUES ($1, $2, $3, $4, $5, 'assignee')`,
          [participantId, TENANT_A, PROGRAMME_A1, conversationId, USER_A_AGENT_1],
        );
      },
    );
    return conversationId;
  }

  describe('1. schema and contract', () => {
    it('lists every inbox table in TENANT_SCOPED_TABLES', () => {
      for (const table of INBOX_TABLES) {
        expect(TENANT_SCOPED_TABLES, table).toContain(table);
      }
    });

    it('has migration 0052 on disk', () => {
      expect(
        existsSync(resolve(repoRoot, 'packages/db/migrations/0052_conversations.sql')),
      ).toBe(true);
    });

    it('declares the three read operations as implemented', () => {
      const spec = parse(
        readFileSync(resolve(repoRoot, 'docs/api/inbox.openapi.yaml'), 'utf8'),
      ) as {
        paths: Record<
          string,
          Record<string, { operationId?: string; 'x-kasuwa-implemented'?: boolean }>
        >;
      };
      const ops = Object.values(spec.paths).flatMap((methods) =>
        Object.values(methods).map((op) => ({
          id: op.operationId,
          implemented: op['x-kasuwa-implemented'],
        })),
      );
      for (const id of ['listConversations', 'getConversation', 'listMessages']) {
        const op = ops.find((row) => row.id === id);
        expect(op, id).toBeDefined();
        expect(op?.implemented, id).toBe(true);
      }
    });

    it('registers crm_inbox off by default', () => {
      expect(FLAGS.crm_inbox).toBeDefined();
      expect(FLAGS.crm_inbox.defaultValue).toBe(false);
      expect(FLAGS.crm_inbox.productionReady).toBe(false);
    });

    it('has RLS enabled and forced on every inbox table', async () => {
      const { rows } = await observer.query<{
        relname: string;
        rls: boolean;
        force: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [[...INBOX_TABLES]],
      );
      expect(rows.map((r) => r.relname).sort()).toEqual([...INBOX_TABLES].sort());
      for (const row of rows) {
        expect(row.rls, row.relname).toBe(true);
        expect(row.force, row.relname).toBe(true);
      }
    });

    it('refuses UPDATE of id/tenant/programme and has no DELETE for kasuwa_app (R1)', async () => {
      const { rows: colRows } = await observer.query<{
        table_name: string;
      }>(
        `SELECT table_name
           FROM information_schema.role_column_grants
          WHERE grantee = 'kasuwa_app'
            AND table_schema = 'public'
            AND table_name = ANY($1::text[])
            AND privilege_type = 'UPDATE'
            AND column_name IN ('id', 'tenant_id', 'programme_id')`,
        [[...INBOX_TABLES]],
      );
      expect(colRows).toEqual([]);

      const { rows: deleteRows } = await observer.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.role_table_grants
          WHERE grantee = 'kasuwa_app'
            AND table_schema = 'public'
            AND table_name = ANY($1::text[])
            AND privilege_type = 'DELETE'`,
        [[...INBOX_TABLES]],
      );
      expect(deleteRows).toEqual([]);
    });
  });

  describe('2. the round trip', () => {
    it('lists, gets and lists messages for a seeded conversation', async () => {
      const conversationId = await seedConversation();

      const listed = await request(server())
        .get(CONVERSATIONS(PROGRAMME_A1))
        .set(reader());
      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body.data).toEqual([
        expect.objectContaining({
          id: conversationId,
          programmeId: PROGRAMME_A1,
          contactId: CONTACT_A1,
          channel: 'whatsapp',
          status: 'open',
          subject: 'Support thread',
          participants: [
            expect.objectContaining({ userId: USER_A_AGENT_1, role: 'assignee' }),
          ],
        }),
      ]);

      const got = await request(server())
        .get(CONVERSATION(conversationId))
        .set(reader());
      expect(got.status).toBe(200);
      expect(got.headers['cache-control']).toBe('no-store');
      expect(got.body).toMatchObject({
        id: conversationId,
        programmeId: PROGRAMME_A1,
        channel: 'whatsapp',
      });

      const messages = await request(server())
        .get(MESSAGES(conversationId))
        .set(reader());
      expect(messages.status).toBe(200);
      expect(messages.headers['cache-control']).toBe('no-store');
      expect(messages.body.data).toEqual([
        expect.objectContaining({
          conversationId,
          direction: 'inbound',
          bodyRedacted: 'redacted-body',
        }),
      ]);
    });
  });

  describe('3. isolation and auth', () => {
    it('returns one 404 for another programme, tenant and no-programme user', async () => {
      const conversationId = await seedConversation();
      const notFoundBody = { code: 'not_found', message: expect.any(String) };

      const agentA2 = await request(server())
        .get(CONVERSATION(conversationId))
        .set(asUser(TENANT_A, USER_A_AGENT_2));
      expect(agentA2.status).toBe(404);
      expect(agentA2.body).toMatchObject(notFoundBody);

      const otherTenant = await request(server())
        .get(CONVERSATION(conversationId))
        .set(asUser(TENANT_B, USER_B_AGENT_1));
      expect(otherTenant.status).toBe(404);
      expect(otherTenant.body).toMatchObject(notFoundBody);

      const noProgramme = await request(server())
        .get(CONVERSATION(conversationId))
        .set(asUser(TENANT_A, USER_A_NO_PROGRAMME));
      expect(noProgramme.status).toBe(404);
      expect(noProgramme.body).toMatchObject(notFoundBody);

      const unreachableProgramme = await request(server())
        .get(CONVERSATIONS(PROGRAMME_B1))
        .set(reader());
      expect(unreachableProgramme.status).toBe(404);
      expect(unreachableProgramme.body).toMatchObject(notFoundBody);

      const outOfScopeProgrammeList = await request(server())
        .get(CONVERSATIONS(PROGRAMME_A2))
        .set(reader());
      expect(outOfScopeProgrammeList.status).toBe(404);
      expect(outOfScopeProgrammeList.body).toMatchObject(notFoundBody);
    });

    it('returns 401 without credentials', async () => {
      const res = await request(server()).get(CONVERSATIONS(PROGRAMME_A1));
      expect(res.status).toBe(401);
    });
  });
});
