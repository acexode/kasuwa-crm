import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0166 (M05 P0, Phase 3 S1): in-app discount approvals.
 *
 * THE CONTRACT (`docs/api/commerce.openapi.yaml`):
 *
 *   listApprovals    GET  /api/v1/programmes/:programmeId/approvals
 *   requestApproval  POST /api/v1/quotes/:quoteId/approvals
 *   decideApproval   POST /api/v1/approvals/:approvalId/decision
 *
 * RULINGS (suite writer — lead amends before the build is approved):
 *
 *   R1. Tables `approval_rule` and `quote_approval` land in migration 0049,
 *       are in TENANT_SCOPED_TABLES, and carry programme-scoped RLS (enabled
 *       and forced). `kasuwa_app` has SELECT and INSERT; no DELETE; no UPDATE
 *       of id / tenant_id / programme_id (D-L210 shape).
 *   R2. `approval_rule` is one row per programme (`UNIQUE (tenant_id,
 *       programme_id)`). `threshold_bps` is 0..10000. Approver role key is
 *       one of `admin` | `team_lead` | `programme_manager`. PROGRAMME_A1 is
 *       seeded at 1500 bps with `programme_manager`.
 *   R3. `quote_approval` statuses: `pending` | `approved` | `rejected`. At
 *       most one pending approval per quote.
 *   R4. Effective discount is the greater of quote-level and any line-level
 *       `discountBps`. Request succeeds only when it is STRICTLY GREATER than
 *       the programme rule threshold; otherwise 400 `below_threshold`. No
 *       rule → 400 `no_approval_rule`.
 *   R5. `requestApproval` needs `quotes.write` (D-L211: agent and up). The
 *       quote must be `draft` (else 409 `not_draft`). A second pending request
 *       is 409 `already_pending`. Snapshot `discountBps` on the row.
 *   R6. `decideApproval` needs `quotes.approve` (admin / team_lead /
 *       programme_manager / tenant-admin). Body `{ decision: approved|rejected }`.
 *       Non-pending → 409 `not_pending`. An agent is 403 `not_permitted`.
 *   R7. `listApprovals` is open to programme members; returns the programme's
 *       approvals newest first.
 *   R8. `quote_approvals` is registered, off by default, not production-ready;
 *       on in `pnpm demo`.
 *   R9. Request appends outbox event `quote.approval_requested` (ids only:
 *       approvalId, quoteId). Notification delivery may skip until kinds
 *       expand — do not invent a substitute bus.
 *  R10. Isolation: another programme, another tenant, and a user with no
 *       programme never see the row; each is one identical 404 body.
 *       no-store on every answer; one 401 without credentials.
 *
 * Out of scope: PDF/send, payments, P21 screens, WhatsApp notify delivery.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const APPROVALS = (programmeId: string) => `/api/v1/programmes/${programmeId}/approvals`;
const REQUEST = (quoteId: string) => `/api/v1/quotes/${quoteId}/approvals`;
const DECIDE = (approvalId: string) => `/api/v1/approvals/${approvalId}/decision`;
const QUOTES = (programmeId: string) => `/api/v1/programmes/${programmeId}/quotes`;

const TABLES = ['approval_rule', 'quote_approval'] as const;

const PRODUCT_A1 = '11111111-0000-4000-8000-0000001a0001';
const VARIANT_A1 = '11111111-0000-4000-8000-0000001b0001';
const NGN_BOOK_A1 = '11111111-0000-4000-8000-000000190001';
const DEAL_A1 = '11111111-0000-4000-8000-000000170001';
const CONTACT_A1 = '11111111-0000-4000-8000-0000000e0001';

describe('acceptance: discount approvals (T-0166)', () => {
  let app: INestApplication;
  let observer: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const as = (tenant: string, user: string) => asUser(tenant, user);
  const writer = () => as(TENANT_A, USER_A_AGENT_1);
  const approver = () => as(TENANT_A, USER_A_SUPERVISOR);

  const draftAboveThreshold = (overrides: Record<string, unknown> = {}) => ({
    priceBookId: NGN_BOOK_A1,
    dealId: DEAL_A1,
    contactId: CONTACT_A1,
    discountBps: 2000,
    validUntil: '2026-12-31T23:59:59.000Z',
    lines: [
      {
        productId: PRODUCT_A1,
        variantId: VARIANT_A1,
        quantity: 1,
        discountBps: 0,
      },
    ],
    ...overrides,
  });

  async function createDiscountedQuote(
    headers: Record<string, string>,
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await request(server())
      .post(QUOTES(PROGRAMME_A1))
      .set(headers)
      .send(draftAboveThreshold(body));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  describe('1. schema and contract', () => {
    it('lists every approval table in TENANT_SCOPED_TABLES', () => {
      for (const table of TABLES) {
        expect(TENANT_SCOPED_TABLES, table).toContain(table);
      }
    });

    it('has migration 0049 on disk', () => {
      expect(
        existsSync(resolve(repoRoot, 'packages/db/migrations/0049_quote_approvals.sql')),
      ).toBe(true);
    });

    it('declares the three approval operations as implemented', () => {
      const spec = parse(
        readFileSync(resolve(repoRoot, 'docs/api/commerce.openapi.yaml'), 'utf8'),
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
      for (const id of ['listApprovals', 'requestApproval', 'decideApproval']) {
        const op = ops.find((row) => row.id === id);
        expect(op, id).toBeDefined();
        expect(op?.implemented, id).toBe(true);
      }
    });

    it('registers quote_approvals off by default', () => {
      expect(FLAGS.quote_approvals).toBeDefined();
      expect(FLAGS.quote_approvals.defaultValue).toBe(false);
      expect(FLAGS.quote_approvals.productionReady).toBe(false);
    });

    it('has RLS enabled and forced on every approval table', async () => {
      const { rows } = await observer.query<{
        relname: string;
        rls: boolean;
        force: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [[...TABLES]],
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.rls, row.relname).toBe(true);
        expect(row.force, row.relname).toBe(true);
      }
    });

    it('seeds PROGRAMME_A1 with a 1500 bps programme_manager rule', async () => {
      const { rows } = await observer.query<{
        threshold_bps: number;
        approver_permission_set_key: string;
      }>(
        `SELECT threshold_bps, approver_permission_set_key
           FROM approval_rule
          WHERE programme_id = $1::uuid`,
        [PROGRAMME_A1],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.threshold_bps).toBe(1500);
      expect(rows[0]?.approver_permission_set_key).toBe('programme_manager');
    });
  });

  describe('2. request, decide, list', () => {
    it('requests, lists, and decides an approval above threshold', async () => {
      const quoteId = await createDiscountedQuote(writer());
      const requested = await request(server()).post(REQUEST(quoteId)).set(writer());
      expect(requested.status, JSON.stringify(requested.body)).toBe(201);
      expect(requested.headers['cache-control']).toBe('no-store');
      expect(requested.body).toMatchObject({
        quoteId,
        programmeId: PROGRAMME_A1,
        discountBps: 2000,
        status: 'pending',
        decidedByUserId: null,
        decidedAt: null,
      });
      expect(requested.body.requestedByUserId).toBe(USER_A_AGENT_1);

      const listed = await request(server()).get(APPROVALS(PROGRAMME_A1)).set(writer());
      expect(listed.status).toBe(200);
      expect(listed.body.data.some((row: { id: string }) => row.id === requested.body.id)).toBe(
        true,
      );

      const decided = await request(server())
        .post(DECIDE(requested.body.id))
        .set(approver())
        .send({ decision: 'approved' });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      expect(decided.body).toMatchObject({
        status: 'approved',
        decidedByUserId: USER_A_SUPERVISOR,
      });
      expect(decided.body.decidedAt).toEqual(expect.any(String));
    });

    it('refuses a discount at or below the threshold with 400 below_threshold', async () => {
      const quoteId = await createDiscountedQuote(writer(), { discountBps: 1500 });
      const res = await request(server()).post(REQUEST(quoteId)).set(writer());
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('below_threshold');
    });

    it('refuses a second pending request with 409 already_pending', async () => {
      const quoteId = await createDiscountedQuote(writer());
      expect((await request(server()).post(REQUEST(quoteId)).set(writer())).status).toBe(201);
      const again = await request(server()).post(REQUEST(quoteId)).set(writer());
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('already_pending');
    });

    it('refuses decide without quotes.approve (agent) with 403', async () => {
      const quoteId = await createDiscountedQuote(writer());
      const requested = await request(server()).post(REQUEST(quoteId)).set(writer());
      expect(requested.status).toBe(201);
      const res = await request(server())
        .post(DECIDE(requested.body.id))
        .set(writer())
        .send({ decision: 'approved' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_permitted');
    });

    it('refuses a closed decision with 409 not_pending', async () => {
      const quoteId = await createDiscountedQuote(writer());
      const requested = await request(server()).post(REQUEST(quoteId)).set(writer());
      await request(server())
        .post(DECIDE(requested.body.id))
        .set(approver())
        .send({ decision: 'rejected' });
      const again = await request(server())
        .post(DECIDE(requested.body.id))
        .set(approver())
        .send({ decision: 'approved' });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('not_pending');
    });

    it('appends quote.approval_requested to the outbox on request', async () => {
      const quoteId = await createDiscountedQuote(writer());
      const requested = await request(server()).post(REQUEST(quoteId)).set(writer());
      expect(requested.status).toBe(201);
      const { rows } = await observer.query<{
        event_type: string;
        aggregate_type: string;
        payload: { approvalId: string; quoteId: string };
      }>(
        `SELECT event_type, aggregate_type, payload
           FROM outbox_event
          WHERE event_type = 'quote.approval_requested'
            AND aggregate_id = $1::uuid`,
        [requested.body.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.aggregate_type).toBe('quote_approval');
      expect(rows[0]?.payload).toEqual({
        approvalId: requested.body.id,
        quoteId,
      });
    });
  });

  describe('3. isolation and auth', () => {
    it('answers one 404 for other programme, other tenant, and no-programme', async () => {
      const quoteId = await createDiscountedQuote(writer());
      const requested = await request(server()).post(REQUEST(quoteId)).set(writer());
      expect(requested.status).toBe(201);
      const approvalId = requested.body.id as string;

      const bodies: unknown[] = [];
      for (const call of [
        request(server()).get(APPROVALS(PROGRAMME_A2)).set(as(TENANT_A, USER_A_AGENT_1)),
        request(server()).get(APPROVALS(PROGRAMME_B1)).set(as(TENANT_B, USER_B_AGENT_1)),
        request(server()).get(APPROVALS(PROGRAMME_A1)).set(as(TENANT_A, USER_A_NO_PROGRAMME)),
        request(server()).post(DECIDE(approvalId)).set(as(TENANT_B, USER_B_AGENT_1)).send({
          decision: 'approved',
        }),
        request(server()).post(REQUEST(quoteId)).set(as(TENANT_B, USER_B_AGENT_1)),
      ]) {
        const res = await call;
        expect(res.status, JSON.stringify(res.body)).toBe(404);
        bodies.push(res.body);
      }
      for (const body of bodies.slice(1)) {
        expect(body).toEqual(bodies[0]);
      }
    });

    it('answers 401 without credentials', async () => {
      const res = await request(server()).get(APPROVALS(PROGRAMME_A1));
      expect(res.status).toBe(401);
    });
  });
});
