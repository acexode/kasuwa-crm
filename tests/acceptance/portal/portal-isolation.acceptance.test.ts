import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  seedSignIn,
  TENANT_A,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
} from '@kasuwa/db';
import { freshSeededTotpCode, readTableSecurity } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0183 (M18 P0): portal tenancy-adversarial suite.
 *
 * ADR-0021: staff and portal identity graphs never meet. A portal session must
 * not reach staff record routes; a staff session must not reach portal routes.
 * Programme and tenant probes use one `404 not_found` body (CLAUDE.md 6.4).
 *
 * Extends TENANT_SCOPED_TABLES coverage for every `portal_*` table introduced
 * for M18. No third `SECURITY DEFINER` function.
 *
 * Depends on T-0179 session helpers for portal bearer tokens.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');

const PORTAL_ME = '/api/v1/portal/me';
const PORTAL_CONTACTS = '/api/v1/portal/contacts';
const STAFF_CONTACTS = '/api/v1/contacts';
const STAFF_ME = '/api/v1/auth/me';

const PORTAL_SIGN_IN = '/api/v1/portal/sign-in';
const PORTAL_MFA = '/api/v1/portal/mfa';
const STAFF_SIGN_IN = '/api/v1/auth/sign-in';
const STAFF_MFA = '/api/v1/auth/mfa';

const PORTAL_TABLE_PREFIX = 'portal_';

async function portalBearer(server: ReturnType<typeof request>): Promise<string> {
  const started = await server.post(PORTAL_SIGN_IN).send({
    tenantSlug: 'sahel-bpo',
    email: 'portal.isolation@client.example',
    password: 'correct-horse-battery-staple',
  });
  expect(started.status).toBe(200);
  const finished = await server.post(PORTAL_MFA).send({
    challengeId: started.body.challengeId,
    code: '000000',
  });
  expect(finished.status).toBe(200);
  return finished.body.token as string;
}

async function staffBearer(server: ReturnType<typeof request>): Promise<string> {
  // Lead-approved (D-L213): staff MFA rejects provisional 000000 (portal-only).
  // Use seeded TOTP via freshSeededTotpCode; staff session wire uses accessToken.
  const credentials = seedSignIn(USER_A_AGENT_1);
  if (credentials === undefined) {
    throw new Error('seed drift: USER_A_AGENT_1 has no sign-in fixture');
  }
  const started = await server.post(STAFF_SIGN_IN).send({
    tenantSlug: credentials.tenantSlug,
    email: credentials.email,
    password: credentials.password,
  });
  expect(started.status).toBe(200);
  if (started.body.mfaRequired === true) {
    const finished = await server.post(STAFF_MFA).send({
      challengeId: started.body.challengeId,
      code: freshSeededTotpCode(USER_A_AGENT_1),
    });
    expect(finished.status).toBe(200);
    expect(finished.body.accessToken).toEqual(expect.any(String));
    return finished.body.accessToken as string;
  }
  expect(started.body.accessToken).toEqual(expect.any(String));
  return started.body.accessToken as string;
}

describe('acceptance: portal isolation (T-0183)', () => {
  let app: INestApplication;
  let observer: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
  });

  const http = () => request(app.getHttpServer());

  describe('1. TENANT_SCOPED_TABLES and RLS for portal_*', () => {
    it('lists every public portal_* table in TENANT_SCOPED_TABLES with RLS forced', async () => {
      const { rows } = await observer.query<{ table: string }>(
        `SELECT table_name AS table FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name LIKE 'portal_%' ORDER BY 1`,
      );
      expect(rows.length).toBeGreaterThan(0);
      const state = await readTableSecurity(observer);
      for (const { table } of rows) {
        expect(TENANT_SCOPED_TABLES, table).toContain(table);
        const row = state.find((entry) => entry.table === table);
        expect(row?.rlsEnabled, table).toBe(true);
        expect(row?.rlsForced, table).toBe(true);
      }
    });

    it('never registers portal tables under NON_TENANT_SCOPED_TABLES', async () => {
      const db = await import('@kasuwa/db');
      for (const table of TENANT_SCOPED_TABLES.filter((name) => name.startsWith(PORTAL_TABLE_PREFIX))) {
        expect(db.NON_TENANT_SCOPED_TABLES).not.toContain(table);
      }
    });
  });

  describe('2. cross-graph auth (portal vs staff)', () => {
    it('rejects a portal bearer on staff /auth/me and /contacts', async () => {
      const portal = await portalBearer(http());
      await http().get(STAFF_ME).set('authorization', `Bearer ${portal}`).expect(401);
      await http().get(STAFF_CONTACTS).set('authorization', `Bearer ${portal}`).expect(401);
    });

    it('rejects a staff bearer on portal /me and /contacts', async () => {
      const staff = await staffBearer(http());
      await http().get(PORTAL_ME).set('authorization', `Bearer ${staff}`).expect(401);
      await http().get(PORTAL_CONTACTS).set('authorization', `Bearer ${staff}`).expect(401);
    });

    it('rejects stub staff headers on portal routes', async () => {
      await http()
        .get(PORTAL_CONTACTS)
        .set(asUser(TENANT_A, USER_A_AGENT_1))
        .expect(401);
    });
  });

  describe('3. programme and tenant URL manipulation', () => {
    const firstIn = (programmeId: string) => {
      const row = SEED_CONTACTS.find((contact) => contact.programmeId === programmeId);
      if (row === undefined) {
        throw new Error(`fixture drift: no contact in ${programmeId}`);
      }
      return row;
    };

    it('portal contact reads return 404 for sibling programme and other tenant ids', async () => {
      const portal = await portalBearer(http());
      const sibling = firstIn(PROGRAMME_A2);
      const foreign = firstIn(PROGRAMME_B1);

      const siblingRes = await http()
        .get(`${PORTAL_CONTACTS}/${sibling.id}`)
        .set('authorization', `Bearer ${portal}`);
      const foreignRes = await http()
        .get(`${PORTAL_CONTACTS}/${foreign.id}`)
        .set('authorization', `Bearer ${portal}`);

      expect(siblingRes.status).toBe(404);
      expect(foreignRes.body).toEqual(siblingRes.body);
    });

    it('staff contact reads stay unchanged: sibling programme is 404 for an agent', async () => {
      const sibling = firstIn(PROGRAMME_A2);
      await http()
        .get(`${STAFF_CONTACTS}/${sibling.id}`)
        .set(asUser(TENANT_A, USER_A_AGENT_1))
        .expect(404);
    });

    it('portal routes reject scope headers (400), same as staff API', async () => {
      const portal = await portalBearer(http());
      await http()
        .get(PORTAL_CONTACTS)
        .set('authorization', `Bearer ${portal}`)
        .set('x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`)
        .expect(400);
      await http()
        .get(STAFF_CONTACTS)
        .set(asUser(TENANT_A, USER_A_AGENT_1))
        .set('x-kasuwa-programme-id', PROGRAMME_A2)
        .expect(400);
    });
  });

  describe('4. ADR-0021 definer census (regression)', () => {
    it('still exactly two SECURITY DEFINER functions after portal migrations', async () => {
      const { rows } = await observer.query<{ name: string }>(
        `SELECT n.nspname || '.' || p.proname AS name
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY 1`,
      );
      expect(rows.map((r) => r.name)).toEqual(['app.resolve_session', 'app.resolve_tenant_by_slug']);
    });

    it('does not add resolve_portal_session to the codebase or migrations', () => {
      const migrations = readFileSync(
        resolve(repoRoot, 'packages/db/migrations/0054_portal_identity.sql'),
        'utf8',
      );
      expect(migrations).not.toMatch(/resolve_portal_session/);
      expect(migrations).not.toMatch(/resolve_portal_invite/);
    });
  });

  describe('5. supervisor cannot widen portal scope via staff multi-programme membership', () => {
    it('portal session lists only portal_programme rows, not every staff programme', async () => {
      const portal = await portalBearer(http());
      const me = await http().get(PORTAL_ME).set('authorization', `Bearer ${portal}`);
      expect(me.status).toBe(200);
      const programmeIds = (me.body.programmes as { id: string }[]).map((row) => row.id).sort();
      expect(programmeIds).not.toEqual([PROGRAMME_A1, PROGRAMME_A2].sort());

      // Staff supervisor sees both programmes on the staff API (control).
      const staffList = await http().get(STAFF_CONTACTS).set(asUser(TENANT_A, USER_A_SUPERVISOR));
      expect(staffList.status).toBe(200);
      const staffProgrammes = new Set(
        (staffList.body.data as { programmeId: string }[]).map((row) => row.programmeId),
      );
      expect([...staffProgrammes].sort()).toEqual([PROGRAMME_A1, PROGRAMME_A2].sort());
    });
  });
});
