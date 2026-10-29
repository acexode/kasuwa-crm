import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createPool, PROGRAMME_A1, PROGRAMME_A2, TENANT_A, TENANT_SCOPED_TABLES } from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0179 (M18 P0, Phase 3 S2): portal identity, session and MFA.
 *
 * ADR-0021 / D-L212. Portal people are `portal_identity`, `portal_session` and
 * `portal_programme` — never `"user"` / `user_programme`. Scope is read from
 * `portal_programme` inside every tenant transaction; the client never supplies
 * authority. Session resolve uses a presented-token SELECT policy and
 * `app.current_portal_session_token()` — not a third `SECURITY DEFINER`.
 *
 * THE CONTRACT (`docs/api/portal.openapi.yaml`):
 *
 *   portalSignIn     POST /api/v1/portal/sign-in
 *   portalVerifyMfa  POST /api/v1/portal/mfa
 *   portalMe         GET  /api/v1/portal/me
 *
 * Browser transport: HttpOnly cookie `__Host-kasuwa_portal_session` (ADR-0021
 * open question 3 — separate from staff). Non-browser: Bearer opaque token.
 *
 * PENDING HTTP. Real assertions; they fail until the controller exists. Schema
 * and ADR guards may pass earlier. Run the blocking gate with everything else;
 * assign T-0179 only after this file is green without edits.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const SIGN_IN = '/api/v1/portal/sign-in';
const MFA = '/api/v1/portal/mfa';
const ME = '/api/v1/portal/me';
const PORTAL_COOKIE = '__Host-kasuwa_portal_session';

const PORTAL_IDENTITY_TABLES = ['portal_identity', 'portal_session', 'portal_programme'] as const;

const DEFINER_CENSUS = `SELECT n.nspname || '.' || p.proname AS name
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
 ORDER BY 1`;

describe('acceptance: portal auth (T-0179)', () => {
  let app: INestApplication;
  let observer: Pool;
  let migrator: Pool;
  /** kasuwa_app pool — presented-token probe must run as the serving role. */
  let appPool: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    migrator = createPool({ connectionString: inject('migrationUrl'), max: 2 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await migrator?.end();
    await appPool?.end();
  });

  const server = () => app.getHttpServer();

  describe('1. schema, contract and ADR-0021 guards', () => {
    it('lists every portal identity table in TENANT_SCOPED_TABLES', () => {
      for (const table of PORTAL_IDENTITY_TABLES) {
        expect(TENANT_SCOPED_TABLES, table).toContain(table);
      }
    });

    it('has RLS enabled and forced on portal_identity, portal_session and portal_programme', async () => {
      const state = await readTableSecurity(observer);
      for (const table of PORTAL_IDENTITY_TABLES) {
        const row = state.find((entry) => entry.table === table);
        expect(row, table).toBeDefined();
        expect(row?.rlsEnabled, `${table}: RLS off`).toBe(true);
        expect(row?.rlsForced, `${table}: RLS not FORCED`).toBe(true);
        expect(row?.policyCount, `${table}: no policy`).toBeGreaterThan(0);
      }
    });

    it('declares portalSignIn, portalVerifyMfa and portalMe as implemented in portal.openapi.yaml', () => {
      const spec = parse(
        readFileSync(resolve(repoRoot, 'docs/api/portal.openapi.yaml'), 'utf8'),
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
      for (const id of ['portalSignIn', 'portalVerifyMfa', 'portalMe']) {
        const row = ops.find((op) => op.id === id);
        expect(row, id).toBeDefined();
        expect(row?.implemented, id).toBe(true);
      }
    });

    it('registers client_portal off by default (feature flag)', () => {
      expect(FLAGS.client_portal).toBeDefined();
      expect(FLAGS.client_portal.defaultValue).toBe(false);
    });

    it('adds no third SECURITY DEFINER function (CLAUDE.md 2.7 / ADR-0021)', async () => {
      const { rows } = await migrator.query<{ name: string }>(DEFINER_CENSUS);
      expect(rows.map((r) => r.name)).toEqual(['app.resolve_session', 'app.resolve_tenant_by_slug']);
    });

    it('does not introduce app.resolve_portal_session or app.resolve_portal_invite', async () => {
      const { rows } = await migrator.query<{ proname: string }>(
        `SELECT proname FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app'
            AND proname IN ('resolve_portal_session', 'resolve_portal_invite', 'current_portal_session_token')`,
      );
      const names = rows.map((r) => r.proname).sort();
      expect(names, 'resolve_* definer must not exist').not.toContain('resolve_portal_session');
      expect(names, 'resolve_* definer must not exist').not.toContain('resolve_portal_invite');
      expect(names, 'GUC accessor for presented-token resolve').toContain('current_portal_session_token');
    });

    it('portal_session presented-token SELECT policy yields nothing without the GUC', async () => {
      const hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      await migrator.query(
        `INSERT INTO portal_identity
           (id, tenant_id, programme_id, email, email_masked, display_name, status)
         VALUES ($1, $2, $3, 'portal.auth.probe@client.example', 'p***@client.example', 'Probe', 'active')`,
        ['11111111-0000-4000-8000-000000f17901', TENANT_A, PROGRAMME_A1],
      );
      await migrator.query(
        `INSERT INTO portal_session
           (id, tenant_id, programme_id, portal_identity_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour')`,
        [
          '11111111-0000-4000-8000-000000f17902',
          TENANT_A,
          PROGRAMME_A1,
          '11111111-0000-4000-8000-000000f17901',
          hash,
        ],
      );

      // Connect as kasuwa_app directly — migrator cannot SET ROLE to kasuwa_app.
      // Match resolvePortalSessionIdentity (ADR-0021 §4): present the token hash
      // alone — no tenant GUC. Tenant isolation still ORs for in-session work, so
      // setting app.tenant_id here would admit the row without the token GUC.
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        const without = await client.query(`SELECT id FROM portal_session`);
        expect(without.rows, 'without token GUC: presented-token policy admits nothing').toHaveLength(
          0,
        );

        await client.query(`SELECT set_config('app.portal_session_token', $1, true)`, [hash]);
        const withGuc = await client.query(`SELECT id FROM portal_session`);
        expect(withGuc.rows, 'with token GUC: own session row').toHaveLength(1);

        await client.query(`SELECT set_config('app.portal_session_token', $1, true)`, [
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        ]);
        const wrong = await client.query(`SELECT id FROM portal_session`);
        expect(wrong.rows, 'wrong hash must not return the row').toHaveLength(0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('2. sign-in, MFA and session (HTTP)', () => {
    const CREDENTIALS = {
      tenantSlug: 'sahel-bpo',
      email: 'portal.client@client.example',
      password: 'correct-horse-battery-staple',
    };

    it('starts MFA for valid portal credentials without issuing a session on step one', async () => {
      const started = await request(server()).post(SIGN_IN).send(CREDENTIALS).expect(200);
      expect(started.body.mfaRequired).toBe(true);
      expect(started.body.challengeId).toEqual(expect.any(String));
      expect(JSON.stringify(started.body)).not.toMatch(/session|token|bearer/i);
      expect(started.headers['cache-control']).toBe('no-store');
    });

    it('is indistinguishable between an unknown email and a wrong password', async () => {
      const unknown = await request(server())
        .post(SIGN_IN)
        .send({ ...CREDENTIALS, email: 'nobody@client.example', password: 'x' });
      const wrong = await request(server())
        .post(SIGN_IN)
        .send({ ...CREDENTIALS, password: 'wrong' });
      expect(unknown.status).toBe(wrong.status);
      expect(unknown.body).toEqual(wrong.body);
    });

    it('completes MFA and returns portalMe with programmes from the database only', async () => {
      const started = await request(server()).post(SIGN_IN).send(CREDENTIALS).expect(200);
      const finished = await request(server())
        .post(MFA)
        .send({ challengeId: started.body.challengeId, code: '000000' })
        .expect(200);
      expect(finished.body.token ?? finished.headers['set-cookie']).toBeDefined();

      const bearer = finished.body.token as string | undefined;
      const me = bearer
        ? await request(server()).get(ME).set('authorization', `Bearer ${bearer}`)
        : await request(server()).get(ME).set('Cookie', finished.headers['set-cookie'] as string);
      expect(me.status).toBe(200);
      expect(me.body.programmes).toEqual(expect.any(Array));
      expect(me.body).not.toHaveProperty('programmeIdsClaim');
      expect(me.headers['cache-control']).toBe('no-store');
    });

    it('rejects staff stub headers on portal routes', async () => {
      await request(server())
        .get(ME)
        .set('x-kasuwa-tenant-id', TENANT_A)
        .set('x-kasuwa-user-id', '11111111-0000-4000-8000-000000020001')
        .expect(401);
    });

    it('rejects scope headers on portal routes', async () => {
      await request(server())
        .get(ME)
        .set('authorization', 'Bearer ksw_portal_not-real')
        .set('x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`)
        .expect(400);
    });

    it('does not treat a staff Bearer token as a portal session', async () => {
      const staff = await request(server())
        .post('/api/v1/auth/sign-in')
        .send({
          tenantSlug: 'sahel-bpo',
          email: 'tunde.agent@tenant-a.test',
          password: 'correct-horse-battery-staple',
        });
      if (staff.status !== 200) {
        expect(staff.status, 'staff sign-in fixture must exist for cross-guard test').toBe(200);
        return;
      }
      await request(server())
        .get(ME)
        .set('authorization', `Bearer ${staff.body.token ?? 'missing'}`)
        .expect(401);
    });

    it('names the portal session cookie separately from staff (ADR-0021)', async () => {
      const finished = await request(server())
        .post(MFA)
        .send({ challengeId: '00000000-0000-4000-8000-000000000099', code: '000000' });
      if (finished.status !== 200) {
        expect(finished.status).toBe(200);
        return;
      }
      const cookies = finished.headers['set-cookie'];
      const joined = Array.isArray(cookies) ? cookies.join(';') : String(cookies ?? '');
      expect(joined).toContain(PORTAL_COOKIE);
      expect(joined).not.toContain('__Host-kasuwa_session');
    });
  });
});
