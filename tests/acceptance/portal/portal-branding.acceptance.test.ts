import { readFileSync } from 'node:fs';
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
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { SEMANTIC_TOKEN_NAMES } from '@kasuwa/ui';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0182 (M18 P1): portal white-label branding per programme.
 *
 * ADMIN CONTRACT (`docs/api/admin.openapi.yaml`):
 *
 *   getPortalBranding  GET /api/v1/admin/programmes/:programmeId/portal-branding
 *   putPortalBranding  PUT /api/v1/admin/programmes/:programmeId/portal-branding
 *
 * Schema: `portal_branding` (migration 0058) — display name, optional logo
 * object id, `primary_token` chosen from Design v1.1 semantic ramp only.
 *
 * PENDING HTTP until admin routes exist. Table invariants may pass first.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const BRANDING = (programmeId: string) =>
  `/api/v1/admin/programmes/${programmeId}/portal-branding`;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_A1 = asUser(TENANT_A, USER_A_AGENT_1);
const TENANT_B_USER = asUser(TENANT_B, USER_B_AGENT_1);

const NOWHERE = '11111111-0000-4000-8000-0000000b9999';

describe('acceptance: portal branding (T-0182)', () => {
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
  });

  const server = () => app.getHttpServer();

  describe('1. schema and contract', () => {
    it('lists portal_branding in TENANT_SCOPED_TABLES with programme_id NOT NULL', async () => {
      expect(TENANT_SCOPED_TABLES).toContain('portal_branding');
      const { rows } = await observer.query<{ nullable: string }>(
        `SELECT is_nullable AS nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'portal_branding' AND column_name = 'programme_id'`,
      );
      expect(rows[0]?.nullable).toBe('NO');
      const state = await readTableSecurity(observer);
      const row = state.find((entry) => entry.table === 'portal_branding');
      expect(row?.rlsEnabled).toBe(true);
      expect(row?.rlsForced).toBe(true);
    });

    it('names getPortalBranding and putPortalBranding as implemented in admin.openapi.yaml', () => {
      const spec = readFileSync(resolve(repoRoot, 'docs/api/admin.openapi.yaml'), 'utf8');
      for (const operationId of ['getPortalBranding', 'putPortalBranding']) {
        expect(spec).toMatch(new RegExp(`operationId:\\s*${operationId}`));
        expect(spec).toMatch(new RegExp(`${operationId}[\\s\\S]*x-kasuwa-implemented:\\s*true`));
      }
    });
  });

  describe('2. admin round trip', () => {
    it('returns defaults then persists display name and a v1.1 semantic primary_token', async () => {
      const before = await request(server()).get(BRANDING(PROGRAMME_A1)).set(SUPERVISOR);
      expect(before.status).toBe(200);
      expect(before.body.programmeId).toBe(PROGRAMME_A1);
      expect(before.body.primaryToken).toEqual(expect.any(String));
      expect(SEMANTIC_TOKEN_NAMES).toContain(before.body.primaryToken);

      const token = SEMANTIC_TOKEN_NAMES.find((name) => name !== before.body.primaryToken) ??
        SEMANTIC_TOKEN_NAMES[0];
      const updated = await request(server())
        .put(BRANDING(PROGRAMME_A1))
        .set(SUPERVISOR)
        .send({
          displayName: 'Bank X Collections Portal',
          primaryToken: token,
          logoObjectId: null,
        });
      expect(updated.status).toBe(200);
      expect(updated.body.displayName).toBe('Bank X Collections Portal');
      expect(updated.body.primaryToken).toBe(token);

      const after = await request(server()).get(BRANDING(PROGRAMME_A1)).set(SUPERVISOR);
      expect(after.body).toEqual(updated.body);
      expect(after.headers['cache-control']).toBe('no-store');
    });

    it('rejects a colour literal or unknown token (400)', async () => {
      const badColour = await request(server())
        .put(BRANDING(PROGRAMME_A1))
        .set(SUPERVISOR)
        .send({ displayName: 'X', primaryToken: 'ff00ff' });
      expect(badColour.status).toBe(400);

      const badToken = await request(server())
        .put(BRANDING(PROGRAMME_A1))
        .set(SUPERVISOR)
        .send({ displayName: 'X', primaryToken: 'not.a.real.token' });
      expect(badToken.status).toBe(400);
    });

    it('is the same 404 for sibling, foreign and missing programmes', async () => {
      const sibling = await request(server()).get(BRANDING(PROGRAMME_A2)).set(AGENT_A1);
      const foreign = await request(server()).get(BRANDING(PROGRAMME_A1)).set(TENANT_B_USER);
      const missing = await request(server()).get(BRANDING(NOWHERE)).set(SUPERVISOR);
      expect(sibling.status).toBe(404);
      expect(foreign.body).toEqual(sibling.body);
      expect(missing.body).toEqual(sibling.body);
    });

    it('does not leak branding from tenant B to tenant A callers', async () => {
      await request(server())
        .put(BRANDING(PROGRAMME_B1))
        .set(TENANT_B_USER)
        .send({ displayName: 'Tenant B Only', primaryToken: SEMANTIC_TOKEN_NAMES[0] })
        .expect(200);

      const peek = await request(server()).get(BRANDING(PROGRAMME_B1)).set(SUPERVISOR);
      expect(peek.status).toBe(404);
    });
  });
});
