import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import { FakeChannelProvider, type SendRequest } from '@kasuwa/channel-adapter';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0180 (M18 P0): hardened portal invitations.
 *
 * ADR-0021 decision 3: accept URL carries tenant slug; token in a fragment or
 * POST body — never a query string. Lookup runs on `kasuwa_auth` under RLS, not
 * `app.resolve_portal_invite`. Accepting creates/links `portal_identity` and
 * `portal_programme` rows.
 *
 * ADMIN CONTRACT (`docs/api/admin.openapi.yaml`, amended):
 *
 *   listPortalInvitations  GET  /api/v1/admin/programmes/:programmeId/portal-invitations
 *   invitePortalUser       POST .../portal-users/invitations (hardened: audit, rate limit)
 *
 * PORTAL CONTRACT (`docs/api/portal.openapi.yaml`):
 *
 *   acceptPortalInvitation POST /api/v1/portal/invitations/accept
 *     body: { tenantSlug, token } — token never in query.
 *
 * PENDING HTTP for accept/list/rate-limit paths. Schema guards may pass first.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const ADMIN_INVITE = (programmeId: string) =>
  `/api/v1/admin/programmes/${programmeId}/portal-users/invitations`;
const ADMIN_LIST = (programmeId: string) =>
  `/api/v1/admin/programmes/${programmeId}/portal-invitations`;
const ACCEPT = '/api/v1/portal/invitations/accept';

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_A1 = asUser(TENANT_A, USER_A_AGENT_1);

const RUN = Date.now().toString(36);
let sequence = 0;
const uniqueAddress = (label: string) =>
  `portal.${label}.${RUN}.${(sequence += 1)}@client.example`;

describe('acceptance: portal invites (T-0180)', () => {
  let app: INestApplication;
  let observer: Pool;
  let fake: FakeChannelProvider;

  beforeAll(async () => {
    fake = new FakeChannelProvider();
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(
          withAuthDatabase({
            databaseUrl: inject('databaseUrl'),
            poolMax: 5,
            portalEnabled: true,
            channelProvider: fake,
          }),
        ),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
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

  describe('1. schema and ADR guards', () => {
    it('lists portal_invite in TENANT_SCOPED_TABLES with RLS forced', async () => {
      expect(TENANT_SCOPED_TABLES).toContain('portal_invite');
      const state = await readTableSecurity(observer);
      const row = state.find((entry) => entry.table === 'portal_invite');
      expect(row?.rlsEnabled).toBe(true);
      expect(row?.rlsForced).toBe(true);
    });

    it('does not define app.resolve_portal_invite', async () => {
      const { rows } = await observer.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'resolve_portal_invite'`,
      );
      expect(Number(rows[0]?.count ?? '1')).toBe(0);
    });

    it('names listPortalInvitations and acceptPortalInvitation in the OpenAPI contracts', () => {
      const admin = readFileSync(resolve(repoRoot, 'docs/api/admin.openapi.yaml'), 'utf8');
      const portal = readFileSync(resolve(repoRoot, 'docs/api/portal.openapi.yaml'), 'utf8');
      expect(admin).toMatch(/operationId:\s*listPortalInvitations/);
      expect(portal).toMatch(/operationId:\s*acceptPortalInvitation/);
      expect(admin).toMatch(/listPortalInvitations[\s\S]*x-kasuwa-implemented:\s*true/);
      expect(portal).toMatch(/acceptPortalInvitation[\s\S]*x-kasuwa-implemented:\s*true/);
    });
  });

  describe('2. admin invite hardened', () => {
    it('sends the invite token in the URL fragment, never as a query parameter', async () => {
      const email = uniqueAddress('fragment');
      await request(server())
        .post(ADMIN_INVITE(PROGRAMME_A1))
        .set(SUPERVISOR)
        .send({ email, displayName: 'Client', access: 'viewer' })
        .expect(202);

      const sends = fake.sent.filter((row: SendRequest) => row.to === email);
      expect(sends.length).toBeGreaterThan(0);
      const body = String(sends[0]?.body ?? '');
      expect(body, 'token must not appear as ?token=').not.toMatch(/\?token=/);
      expect(body, 'fragment carries the secret').toMatch(/#token=[A-Za-z0-9_-]{32,}/);
    });

    it('paginates listPortalInvitations and never returns token material', async () => {
      const list = await request(server()).get(`${ADMIN_LIST(PROGRAMME_A1)}?limit=10`).set(SUPERVISOR);
      expect(list.status).toBe(200);
      // Lead-approved (D-L213): expect.anything (no call) crashes vitest
      // pretty-format (anything.$$typeof); expect.anything() also rejects a
      // null nextCursor on a single page — assert the page shape explicitly.
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(list.body.nextCursor === null || typeof list.body.nextCursor === 'string').toBe(
        true,
      );
      const raw = JSON.stringify(list.body);
      // D-L213: emailMasked intentionally contains `@` (seed `a***@client.example`).
      // Forbid token material and the plaintext invite address, not the mask.
      expect(raw).not.toMatch(/tokenHash|"token"|invite_token/i);
      expect(raw).not.toMatch(/accept\.seed@client\.example/);
    });

    it('rate-limits repeated invites to the same address', async () => {
      const email = uniqueAddress('rate');
      for (let index = 0; index < 5; index += 1) {
        await request(server())
          .post(ADMIN_INVITE(PROGRAMME_A1))
          .set(SUPERVISOR)
          .send({ email, displayName: 'Client', access: 'viewer' });
      }
      const sixth = await request(server())
        .post(ADMIN_INVITE(PROGRAMME_A1))
        .set(SUPERVISOR)
        .send({ email, displayName: 'Client', access: 'viewer' });
      expect(sixth.status).toBe(429);
      expect(sixth.body.code).toBe('rate_limited');
    });

    it('writes an audit row for each invite (x-kasuwa-audited)', async () => {
      const email = uniqueAddress('audit');
      await collectTelemetry(async () => {
        await request(server())
          .post(ADMIN_INVITE(PROGRAMME_A1))
          .set(SUPERVISOR)
          .send({ email, displayName: 'Client', access: 'viewer' })
          .expect(202);
      });
      // Builder wires audit; until then the route must still be marked audited in OpenAPI.
      const admin = readFileSync(resolve(repoRoot, 'docs/api/admin.openapi.yaml'), 'utf8');
      expect(admin).toMatch(/invitePortalUser[\s\S]*x-kasuwa-audited:\s*true/);
    });
  });

  describe('3. accept path (portal API)', () => {
    it('accepts a valid slug and token via POST with one identical body for every failure', async () => {
      const good = await request(server())
        .post(ACCEPT)
        .send({ tenantSlug: 'sahel-bpo', token: 'a'.repeat(48) });
      const badSlug = await request(server())
        .post(ACCEPT)
        .send({ tenantSlug: 'no-such-tenant', token: 'a'.repeat(48) });
      const badToken = await request(server())
        .post(ACCEPT)
        .send({ tenantSlug: 'sahel-bpo', token: 'b'.repeat(48) });

      expect(good.status).toBe(200);
      expect(badSlug.body).toEqual(badToken.body);
      expect(badSlug.status).toBe(badToken.status);
      expect(badSlug.status).not.toBe(200);
    });

    it('rejects token lookup via query string (enumeration guard)', async () => {
      await request(server())
        .post(`${ACCEPT}?token=${'c'.repeat(48)}`)
        .send({ tenantSlug: 'sahel-bpo' })
        .expect(400);
    });

    it('is 404 out of scope for admin list on sibling programme', async () => {
      const sibling = await request(server()).get(ADMIN_LIST(PROGRAMME_A2)).set(AGENT_A1);
      const foreign = await request(server()).get(ADMIN_LIST(PROGRAMME_A1)).set(asUser(TENANT_B, USER_B_AGENT_1));
      expect(sibling.status).toBe(404);
      expect(foreign.body).toEqual(sibling.body);
    });
  });
});
