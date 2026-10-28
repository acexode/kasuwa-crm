import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_PERMISSION_SETS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0158 (T-0079, D-L84): `GET /api/v1/me/capabilities`.
 *
 * The web hides write controls a user cannot use, and the script builder 404s a
 * non-writer. Both need to know what the caller may DO, and `/auth/me` says
 * nothing about it on purpose (no roles, no permissions, no programme ids). This
 * is the one scoped read that does: the caller's OWN capabilities, derived from
 * the same grants the API enforces, re-read on every request.
 *
 * THE SHAPE (a closed JSON object, `docs/api/auth.openapi.yaml`,
 * `getMyCapabilities`, tag `me`, `Cache-Control: no-store`):
 *
 *   { tenant:     { admin: boolean, can: TenantAction[] },
 *     programmes: [ { id: uuid, can: ProgrammeAction[] } ] }
 *
 * - `tenant.admin` mirrors the user's tenant-admin flag; `tenant.can` lists the
 *   tenant actions that flag grants (`role.write`, `custom_field.write`, ...),
 *   and is empty without it.
 * - `programmes` has one entry per programme the session can REACH (a tenant
 *   admin who is not a member of a programme does not see it, D-L06); each
 *   lists every programme action the caller holds there. Names are not here:
 *   `listMyProgrammes` already serves them.
 * - Every `can` array is sorted ascending and holds no duplicates.
 *
 * What is held:
 *
 *   1. The shape is exact: those keys and no others, at every level, so nothing
 *      (a role name, a permission-set id, another user) can ride along.
 *   2. An agent holds the agent set and nothing else; an admin holds more; a
 *      team lead holds the agent set plus its three extras; a QA analyst and a
 *      client portal user hold nothing. Per programme, not per tenant.
 *   3. The tenant admin flag is the only source of `tenant.can`.
 *   4. It is read live: change a set or the flag between two requests and the
 *      next response changes (nothing is cached for the session).
 *   5. It reveals only the caller's own: never another tenant's id, programme
 *      or user, and a user with no programme gets an empty list.
 *   6. `no-store`, and one identical 401 for no credentials, a real user under
 *      the wrong tenant and an unknown user.
 *
 * Out of scope, and not asserted: the web (it hides controls through this read,
 * held by the e2e tags `@p04-accounts-writers` and `@p10-builder-access-404`),
 * and what each action means (the permissions engine suite, T-0032).
 */

const AGENT_CAN = [
  'activity.write',
  'contact.claim_and_set_status',
  'deal.write',
  'quotes.write', // D-L211 (T-0165): reps quote
  'script.run',
].sort();
const TEAM_LEAD_CAN = [
  ...AGENT_CAN,
  'activity.reassign',
  'deal.reassign',
  'deal.write_any',
  'quotes.approve', // T-0166: team_lead decides discount approvals
].sort();

function setId(key: string): string {
  const set = SEED_PERMISSION_SETS.find((s) => s.tenantId === TENANT_A && s.key === key);
  if (set === undefined) throw new Error(`Fixture drift: tenant A has no permission set '${key}'`);
  return set.id;
}

const ADMIN_SET = setId('admin');

interface Capabilities {
  tenant: { admin: boolean; can: string[] };
  programmes: Array<{ id: string; can: string[] }>;
}

describe('acceptance: GET /api/v1/me/capabilities (T-0158)', () => {
  let app: INestApplication;
  /** kasuwa_migrator, BYPASSRLS: plants grants, never serves. */
  let observer: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  async function assign(userId: string, programmeId: string, permissionSetId: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id) DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSetId],
    );
  }

  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query(
      'UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2 AND tenant_id = $3',
      [value, userId, TENANT_A],
    );
  }

  beforeEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  async function capabilities(headers: Record<string, string>): Promise<Capabilities> {
    const response = await request(server()).get('/api/v1/me/capabilities').set(headers);
    expect(response.status, `body: ${JSON.stringify(response.body)}`).toBe(200);
    return response.body as Capabilities;
  }

  const byProgramme = (body: Capabilities, id: string) => body.programmes.find((p) => p.id === id);

  // -------------------------------------------------------------------------

  it('1. the shape is closed at every level', async () => {
    const body = await capabilities(asUser(TENANT_A, USER_A_SUPERVISOR));
    expect(Object.keys(body).sort()).toEqual(['programmes', 'tenant']);
    expect(Object.keys(body.tenant).sort()).toEqual(['admin', 'can']);
    expect(
      body.programmes.length,
      'non-vacuous: the supervisor reaches programmes',
    ).toBeGreaterThan(0);
    for (const programme of body.programmes) {
      expect(Object.keys(programme).sort()).toEqual(['can', 'id']);
    }
    for (const list of [body.tenant.can, ...body.programmes.map((p) => p.can)]) {
      expect(list, 'sorted ascending, no duplicates').toEqual([...new Set(list)].sort());
    }
  });

  describe('2. per programme, by permission set', () => {
    it('an agent holds the agent set in its programme and nothing else', async () => {
      const body = await capabilities(asUser(TENANT_A, USER_A_AGENT_1));
      expect(body.tenant).toEqual({ admin: false, can: [] });
      expect(body.programmes.map((p) => p.id)).toEqual([PROGRAMME_A1]);
      expect(byProgramme(body, PROGRAMME_A1)?.can).toEqual(AGENT_CAN);
      expect(AGENT_CAN, 'the agent cannot write contacts, accounts or scripts').not.toContain(
        'script.write',
      );
    });

    it('an admin set holds the write actions the agent set lacks', async () => {
      const body = await capabilities(asUser(TENANT_A, USER_A_SUPERVISOR));
      for (const id of [PROGRAMME_A1, PROGRAMME_A2]) {
        const can = byProgramme(body, id)?.can ?? [];
        for (const action of ['account.write', 'contact.write', 'script.write', ...AGENT_CAN]) {
          expect(can, `admin in ${id} lacks ${action}`).toContain(action);
        }
      }
    });

    it('a team lead holds the agent set plus its extras (incl. quotes.approve)', async () => {
      await assign(USER_A_AGENT_1, PROGRAMME_A1, setId('team_lead'));
      const body = await capabilities(asUser(TENANT_A, USER_A_AGENT_1));
      expect(byProgramme(body, PROGRAMME_A1)?.can).toEqual(TEAM_LEAD_CAN);
    });

    for (const key of ['qa_analyst', 'client_portal']) {
      it(`${key} holds nothing`, async () => {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, setId(key));
        const body = await capabilities(asUser(TENANT_A, USER_A_AGENT_1));
        expect(byProgramme(body, PROGRAMME_A1)?.can).toEqual([]);
      });
    }
  });

  describe('3. the tenant admin flag is the only source of tenant actions', () => {
    it('the flag grants them; without it there are none, whatever the programme set', async () => {
      const admin = await capabilities(asUser(TENANT_A, USER_A_SUPERVISOR));
      expect(admin.tenant.admin).toBe(true);
      expect(admin.tenant.can).toEqual(
        expect.arrayContaining(['custom_field.write', 'role.write']),
      );

      await assign(USER_A_AGENT_1, PROGRAMME_A1, ADMIN_SET);
      const notAdmin = await capabilities(asUser(TENANT_A, USER_A_AGENT_1));
      expect(notAdmin.tenant, 'an admin SET is not the tenant flag').toEqual({
        admin: false,
        can: [],
      });
    });
  });

  describe('4. it is read live', () => {
    it('a changed permission set shows on the next request', async () => {
      const before = await capabilities(asUser(TENANT_A, USER_A_AGENT_1));
      expect(byProgramme(before, PROGRAMME_A1)?.can).toEqual(AGENT_CAN);
      await assign(USER_A_AGENT_1, PROGRAMME_A1, ADMIN_SET);
      const after = await capabilities(asUser(TENANT_A, USER_A_AGENT_1));
      expect(byProgramme(after, PROGRAMME_A1)?.can).toContain('script.write');
    });

    it('a removed tenant-admin flag shows on the next request', async () => {
      expect((await capabilities(asUser(TENANT_A, USER_A_SUPERVISOR))).tenant.admin).toBe(true);
      await setTenantAdmin(USER_A_SUPERVISOR, false);
      const after = await capabilities(asUser(TENANT_A, USER_A_SUPERVISOR));
      expect(after.tenant).toEqual({ admin: false, can: [] });
    });

    it('a removed membership drops the programme on the next request', async () => {
      await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [
        USER_A_AGENT_1,
        PROGRAMME_A1,
      ]);
      const after = await capabilities(asUser(TENANT_A, USER_A_AGENT_1));
      expect(after.programmes).toEqual([]);
    });
  });

  describe('5. it reveals only the caller’s own', () => {
    it('a user with no programme gets an empty list and no tenant actions', async () => {
      const body = await capabilities(asUser(TENANT_A, USER_A_NO_PROGRAMME));
      expect(body).toEqual({ tenant: { admin: false, can: [] }, programmes: [] });
    });

    it('a tenant B user never sees a tenant A programme, and tenant A never sees B’s', async () => {
      const b = await capabilities(asUser(TENANT_B, USER_B_AGENT_1));
      const a = await capabilities(asUser(TENANT_A, USER_A_SUPERVISOR));
      const aIds = a.programmes.map((p) => p.id);
      const bIds = b.programmes.map((p) => p.id);
      expect(bIds.length, 'non-vacuous: the B user reaches a programme').toBeGreaterThan(0);
      for (const id of bIds) expect(aIds).not.toContain(id);
      expect(JSON.stringify(b)).not.toContain(TENANT_A);
      expect(JSON.stringify(a)).not.toContain(TENANT_B);
    });

    it('a tenant admin who is not a member of a programme does not see it', async () => {
      await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [
        USER_A_SUPERVISOR,
        PROGRAMME_A2,
      ]);
      const body = await capabilities(asUser(TENANT_A, USER_A_SUPERVISOR));
      expect(body.programmes.map((p) => p.id)).toEqual([PROGRAMME_A1]);
    });

    it('nothing a caller sends chooses whose capabilities are read', async () => {
      const own = await capabilities(asUser(TENANT_A, USER_A_AGENT_1));
      const probed = await request(server())
        .get('/api/v1/me/capabilities')
        .query({ userId: USER_A_SUPERVISOR, programmeId: PROGRAMME_A2, tenantId: TENANT_B })
        .set(asUser(TENANT_A, USER_A_AGENT_1));
      expect(probed.status).toBe(200);
      expect(probed.body).toEqual(own);
    });
  });

  describe('6. no-store, and one 401', () => {
    it('is never cached', async () => {
      const response = await request(server())
        .get('/api/v1/me/capabilities')
        .set(asUser(TENANT_A, USER_A_AGENT_1));
      expect(response.headers['cache-control']).toMatch(/no-store/);
    });

    it('answers no credentials, a wrong tenant and an unknown user with the same 401', async () => {
      const unknownUser = '00000000-0000-4000-8000-00000000dead';
      const answers = await Promise.all([
        request(server()).get('/api/v1/me/capabilities'),
        request(server()).get('/api/v1/me/capabilities').set(asUser(TENANT_B, USER_A_AGENT_1)),
        request(server()).get('/api/v1/me/capabilities').set(asUser(TENANT_A, unknownUser)),
      ]);
      for (const answer of answers) expect(answer.status).toBe(401);
      expect(answers[1]?.body).toEqual(answers[0]?.body);
      expect(answers[2]?.body).toEqual(answers[0]?.body);
    });
  });
});
