import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0181 (M18 P0): portal scoped reads and D-P26 redaction.
 *
 * Scope from `portal_programme` only. A programme filter narrows within the
 * entitled set; an id outside it is one `404 not_found`, never `403`.
 *
 * THE CONTRACT (`docs/api/portal.openapi.yaml`):
 *
 *   listPortalProgrammes GET /api/v1/portal/programmes
 *   listPortalContacts   GET /api/v1/portal/contacts
 *   getPortalReport      GET /api/v1/portal/reports/:reportId
 *
 * D-P26 on timelines surfaced through reports/contacts:
 *   - field and consent changes: visible
 *   - activity subjects and bodies: never
 *   - actors: role labels only, never free-text staff names
 *
 * PENDING HTTP until portal guard and controllers exist. Helpers below fail at
 * sign-in until T-0179 lands.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const PROGRAMMES = '/api/v1/portal/programmes';
const CONTACTS = '/api/v1/portal/contacts';
const REPORT = (reportId: string) => `/api/v1/portal/reports/${reportId}`;

const PORTAL_SIGN_IN = '/api/v1/portal/sign-in';
const PORTAL_MFA = '/api/v1/portal/mfa';

async function portalSession(server: ReturnType<typeof request>): Promise<string> {
  const started = await server.post(PORTAL_SIGN_IN).send({
    tenantSlug: 'sahel-bpo',
    email: 'portal.reads@client.example',
    password: 'correct-horse-battery-staple',
  });
  expect(started.status, 'portal sign-in fixture').toBe(200);
  const finished = await server.post(PORTAL_MFA).send({
    challengeId: started.body.challengeId,
    code: '000000',
  });
  expect(finished.status, 'portal MFA fixture').toBe(200);
  const token = finished.body.token as string | undefined;
  expect(token, 'opaque portal bearer for acceptance').toBeDefined();
  return token as string;
}

describe('acceptance: portal reads (T-0181)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  describe('1. contract', () => {
    it('declares listPortalProgrammes, listPortalContacts and getPortalReport as implemented', () => {
      const spec = readFileSync(resolve(repoRoot, 'docs/api/portal.openapi.yaml'), 'utf8');
      for (const operationId of ['listPortalProgrammes', 'listPortalContacts', 'getPortalReport']) {
        expect(spec).toMatch(new RegExp(`operationId:\\s*${operationId}`));
        expect(spec).toMatch(new RegExp(`${operationId}[\\s\\S]*x-kasuwa-implemented:\\s*true`));
      }
    });
  });

  describe('2. programme and record scope', () => {
    it('lists only programmes entitled in portal_programme', async () => {
      const token = await portalSession(server());
      const response = await server().get(PROGRAMMES).set('authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      const ids = (response.body.data as { id: string }[]).map((row) => row.id).sort();
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).not.toContain(PROGRAMME_B1);
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('lists contacts only from entitled programmes', async () => {
      const token = await portalSession(server());
      const response = await server().get(CONTACTS).set('authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      const programmeIds = new Set(
        (response.body.data as { programmeId: string }[]).map((row) => row.programmeId),
      );
      expect(programmeIds.has(PROGRAMME_A2)).toBe(false);
      for (const contact of response.body.data as { id: string }[]) {
        expect(SEED_CONTACTS.some((seed) => seed.id === contact.id)).toBe(true);
      }
    });

    it('returns 404 for a contact in a sibling programme, not 403', async () => {
      const token = await portalSession(server());
      const sibling = SEED_CONTACTS.find((row) => row.programmeId === PROGRAMME_A2);
      expect(sibling).toBeDefined();
      const response = await server()
        .get(`${CONTACTS}/${sibling?.id}`)
        .set('authorization', `Bearer ${token}`);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('not_found');
    });

    it('returns 404 for a report outside scope with the same body as a missing id', async () => {
      const token = await portalSession(server());
      const missing = await server()
        .get(REPORT('11111111-0000-4000-8000-0000000r9999'))
        .set('authorization', `Bearer ${token}`);
      const foreign = await server()
        .get(REPORT('11111111-0000-4000-8000-0000000r8888'))
        .set('authorization', `Bearer ${token}`);
      expect(missing.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
    });
  });

  describe('3. D-P26 redaction', () => {
    it('never returns activity subjects, bodies or free-text actor names in report payloads', async () => {
      const token = await portalSession(server());
      const response = await server()
        .get(REPORT('programme-summary'))
        .set('authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      const raw = JSON.stringify(response.body);
      expect(raw).not.toMatch(/subject|body|nextStep/i);
      expect(raw).not.toMatch(/@tenant-a\.test/i);
      if (response.body.timeline !== undefined) {
        for (const entry of response.body.timeline as { actorLabel?: string; actorName?: string }[]) {
          expect(entry.actorName, 'D-P26: no staff names').toBeUndefined();
          expect(entry.actorLabel, 'D-P26: role label').toEqual(expect.any(String));
        }
      }
    });

    it('rejects client-supplied programme scope headers', async () => {
      const token = await portalSession(server());
      await server()
        .get(CONTACTS)
        .set('authorization', `Bearer ${token}`)
        .set('x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`)
        .expect(400);
    });
  });

  describe('4. cross-tenant isolation', () => {
    it('never mixes tenant B contacts into a tenant A portal session', async () => {
      const token = await portalSession(server());
      const response = await server().get(CONTACTS).set('authorization', `Bearer ${token}`);
      expect(response.status).toBe(200);
      const tenantBIds = new Set(
        SEED_CONTACTS.filter((row) => row.programmeId === PROGRAMME_B1).map((row) => row.id),
      );
      for (const row of response.body.data as { id: string }[]) {
        expect(tenantBIds.has(row.id)).toBe(false);
      }
    });
  });
});
