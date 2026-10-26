import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0159 (D-L196, D-L204): the Home layout moves from the browser's
 * localStorage to a per-user, tenant-scoped table, behind the existing
 * `HomeLayoutStore` interface, flagged `home_layout_server`.
 *
 * THE CONTRACT (`docs/api/records.openapi.yaml`, tag `me`, all `no-store`):
 *
 *   getHomeLayout    GET    /api/v1/me/home-layout   200 { role, items } | 404 not_found (nothing saved)
 *   putHomeLayout    PUT    /api/v1/me/home-layout   body { role, items } -> 200 the saved layout
 *   deleteHomeLayout DELETE /api/v1/me/home-layout   204, idempotent (Reset)
 *
 * `role` is one of rep, manager, support, bpo, exec. `items` is at most 19
 * `{ type, span }` objects: `type` a Home widget (`nba`, `agenda`, ...), `span` 4,
 * 6, 8 or 12. The body is CLOSED: a key the contract does not name is a 400.
 * A third operation, `deleteHomeLayout`, is added to the plan's two because
 * Reset (`HomeLayoutStore.clear`) has a caller, and cannot be a PUT of the default:
 * the screen filters the default by live sources, so it would store a narrowed one.
 *
 * THE TABLE. `home_layout`, primary key `(tenant_id, user_id)`: one layout per
 * user, scoped by the session, not by a programme (a new workspace user with no
 * programme still has a Home). It is tenant-scoped, RLS enabled and forced with a
 * policy pinned to the session's tenant AND user.
 *
 * What is held:
 *
 *   1. The table is in `TENANT_SCOPED_TABLES`, one row per user, enforced by
 *      the database (the RLS suite then checks enabled, forced and a policy).
 *   2. The round trip: nothing saved is a 404; PUT then GET returns what was put;
 *      a second PUT replaces it (never appends); DELETE removes it, twice is fine.
 *   3. It is the caller's own: another user in the same tenant, and any user of
 *      another tenant, never reads, replaces or deletes it, and a body or query
 *      naming a user or tenant is a 400 or ignored, never obeyed.
 *   4. The body is validated at the boundary: an unknown widget, a span the grid
 *      does not offer, more than 19 items, an unknown role or a stray key is a
 *      400 `validation_failed`, and nothing is stored.
 *   5. The database refuses what the API would never send: a row for another
 *      user, and a read of another user's row, on the app role.
 *   6. `no-store`, and one 401 for no credentials, a wrong tenant and an unknown user.
 *   7. The wiring: the flag `home_layout_server` is registered and off by default,
 *      the web has a server store beside the browser one, and a new e2e spec
 *      `tests/e2e/p03-home.spec.ts` carries the `@p03-home` tag with no skipped
 *      or `fixme` tests and no `waitForTimeout`.
 *
 * Out of scope, and not asserted here: running `@p03-home` in a browser (the e2e
 * harness and the nightly full gate do; D-L207), and migrating existing
 * localStorage layouts (not done: the browser store stays as the flag-off path).
 */

const ROUTE = '/api/v1/me/home-layout';
const repoRoot = resolve(__dirname, '..', '..', '..');
const LAYOUT = {
  role: 'rep',
  items: [
    { type: 'nba', span: 12 },
    { type: 'agenda', span: 6 },
    { type: 'deals', span: 6 },
  ],
};
const OTHER = { role: 'manager', items: [{ type: 'pipeline', span: 8 }] };

describe('acceptance: home layout on the server (T-0159)', () => {
  let app: INestApplication;
  let observer: Pool;
  let appPool: Pool;

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
  const as = (tenant: string, user: string) => asUser(tenant, user);
  const get = (h: Record<string, string>) => request(server()).get(ROUTE).set(h);
  const put = (h: Record<string, string>, body: unknown) =>
    request(server())
      .put(ROUTE)
      .set(h)
      .send(body as object);
  const del = (h: Record<string, string>) => request(server()).delete(ROUTE).set(h);
  const rows = async (tenant: string) =>
    Number(
      (
        await observer.query<{ n: string }>(
          'SELECT count(*) AS n FROM home_layout WHERE tenant_id = $1',
          [tenant],
        )
      ).rows[0]?.n,
    );

  // -------------------------------------------------------------------------
  describe('1. the table', () => {
    it('is tenant-scoped, and holds one row per user', async () => {
      expect(TENANT_SCOPED_TABLES).toContain('home_layout');
      const pk = await observer.query<{ cols: string }>(
        `SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
          WHERE i.indrelid = 'public.home_layout'::regclass AND i.indisprimary`,
      );
      expect(pk.rows[0]?.cols).toBe('tenant_id,user_id');
    });
  });

  // -------------------------------------------------------------------------
  describe('2. the round trip', () => {
    const me = as(TENANT_A, USER_A_AGENT_1);

    it('nothing saved is a 404 not_found', async () => {
      const response = await get(me);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ statusCode: 404, code: 'not_found' });
    });

    it('PUT then GET returns what was put, and a second PUT replaces it', async () => {
      const saved = await put(me, LAYOUT);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body).toEqual(LAYOUT);
      expect((await get(me)).body).toEqual(LAYOUT);

      expect((await put(me, OTHER)).status).toBe(200);
      expect((await get(me)).body, 'a second PUT must replace, not append').toEqual(OTHER);
      expect(await rows(TENANT_A), 'one row per user').toBe(1);
    });

    it('DELETE removes it, and deleting again is fine', async () => {
      await put(me, LAYOUT);
      expect((await del(me)).status).toBe(204);
      expect((await get(me)).status).toBe(404);
      expect((await del(me)).status, 'idempotent').toBe(204);
    });

    it('an empty layout is a valid layout, and is not the same as none saved', async () => {
      expect((await put(me, { role: 'rep', items: [] })).status).toBe(200);
      const read = await get(me);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ role: 'rep', items: [] });
    });

    it('a user with no programme can save one: it is the user’s, not a programme’s', async () => {
      const lonely = as(TENANT_A, USER_A_NO_PROGRAMME);
      expect((await put(lonely, LAYOUT)).status).toBe(200);
      expect((await get(lonely)).body).toEqual(LAYOUT);
    });
  });

  // -------------------------------------------------------------------------
  describe('3. it is the caller’s own', () => {
    it('another user in the same tenant never reads, replaces or deletes it', async () => {
      await put(as(TENANT_A, USER_A_SUPERVISOR), LAYOUT);
      const agent = as(TENANT_A, USER_A_AGENT_1);
      expect((await get(agent)).status, 'the agent has none of their own').toBe(404);

      await put(agent, OTHER);
      expect((await get(as(TENANT_A, USER_A_SUPERVISOR))).body).toEqual(LAYOUT);
      await del(agent);
      expect(
        (await get(as(TENANT_A, USER_A_SUPERVISOR))).body,
        'the agent’s DELETE hit the supervisor',
      ).toEqual(LAYOUT);
    });

    it('another tenant never reads or touches it', async () => {
      await put(as(TENANT_A, USER_A_SUPERVISOR), LAYOUT);
      const other = as(TENANT_B, USER_B_AGENT_1);
      expect((await get(other)).status).toBe(404);
      await put(other, OTHER);
      await del(other);
      expect(await rows(TENANT_A), 'tenant B changed tenant A').toBe(1);
      expect((await get(as(TENANT_A, USER_A_SUPERVISOR))).body).toEqual(LAYOUT);
    });

    it('a body or query that names a user or tenant is refused or ignored, never obeyed', async () => {
      const me = as(TENANT_A, USER_A_AGENT_1);
      for (const forged of [
        { ...LAYOUT, userId: USER_A_SUPERVISOR },
        { ...LAYOUT, tenantId: TENANT_B },
        { ...LAYOUT, programmeId: PROGRAMME_A1 },
      ]) {
        const response = await put(me, forged);
        expect(response.status, JSON.stringify(forged)).toBe(400);
        expect(response.body).toMatchObject({ code: 'validation_failed' });
      }
      expect(await rows(TENANT_A), 'a refused PUT stored something').toBe(0);

      await put(me, LAYOUT);
      const probed = await request(server())
        .get(ROUTE)
        .query({ userId: USER_A_SUPERVISOR, tenantId: TENANT_B })
        .set(me);
      expect(probed.body).toEqual(LAYOUT);
    });
  });

  // -------------------------------------------------------------------------
  describe('4. the body is validated at the boundary', () => {
    const me = as(TENANT_A, USER_A_AGENT_1);
    const items19 = Array.from({ length: 19 }, () => ({ type: 'nba', span: 4 }));
    const bad: Array<[string, unknown]> = [
      ['an unknown widget', { role: 'rep', items: [{ type: 'no-such-widget', span: 4 }] }],
      ['a span the grid does not offer', { role: 'rep', items: [{ type: 'nba', span: 5 }] }],
      ['more than 19 items', { role: 'rep', items: [...items19, { type: 'nba', span: 4 }] }],
      ['an unknown role', { role: 'ceo', items: [] }],
      ['a stray key on an item', { role: 'rep', items: [{ type: 'nba', span: 4, colour: 'red' }] }],
      ['items that are not an array', { role: 'rep', items: 'nba' }],
      ['no role', { items: [] }],
    ];
    for (const [label, body] of bad) {
      it(`${label} is a 400 validation_failed, and nothing is stored`, async () => {
        const response = await put(me, body);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: 'validation_failed' });
        expect(await rows(TENANT_A)).toBe(0);
      });
    }

    it('exactly 19 items is accepted', async () => {
      expect((await put(me, { role: 'rep', items: items19 })).status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  describe('5. the database refuses what the API would never send', () => {
    it('on the app role, a row for another user is refused and another user’s row is invisible', async () => {
      await observer.query(
        `INSERT INTO home_layout (tenant_id, user_id, role, items) VALUES ($1, $2, 'rep', '[]'::jsonb)`,
        [TENANT_A, USER_A_SUPERVISOR],
      );
      const seen = await withTenantTransaction(
        appPool,
        { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
        async (tx) => tx.query<{ n: number }>('SELECT count(*)::int AS n FROM home_layout'),
      );
      expect(seen[0]?.n, 'the agent saw the supervisor’s row').toBe(0);

      let code = '';
      try {
        await withTenantTransaction(
          appPool,
          { tenantId: TENANT_A, userId: USER_A_AGENT_1 },
          async (tx) => {
            await tx.query(
              `INSERT INTO home_layout (tenant_id, user_id, role, items) VALUES ($1, $2, 'rep', '[]'::jsonb)`,
              [TENANT_A, USER_A_SUPERVISOR],
            );
          },
        );
      } catch (error) {
        code = String((error as { code?: unknown }).code);
      }
      expect(code, 'an INSERT for another user must fail the policy').toBe('42501');
    });
  });

  // -------------------------------------------------------------------------
  describe('6. no-store, and one 401', () => {
    it('never caches any of the three operations', async () => {
      const me = as(TENANT_A, USER_A_AGENT_1);
      for (const response of [await put(me, LAYOUT), await get(me), await del(me)]) {
        expect(response.headers['cache-control']).toMatch(/no-store/);
      }
    });

    it('answers no credentials, a wrong tenant and an unknown user with the same 401', async () => {
      const ghost = '00000000-0000-4000-8000-00000000dead';
      const calls = [
        (h: Record<string, string>) => get(h),
        (h: Record<string, string>) => put(h, LAYOUT),
        (h: Record<string, string>) => del(h),
      ];
      for (const call of calls) {
        const answers = [
          await call({}),
          await call(as(TENANT_B, USER_A_AGENT_1)),
          await call(as(TENANT_A, ghost)),
        ];
        for (const answer of answers) expect(answer.status).toBe(401);
        expect(answers[1]?.body).toEqual(answers[0]?.body);
        expect(answers[2]?.body).toEqual(answers[0]?.body);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('7. the wiring', () => {
    it('registers the flag, off by default', () => {
      const flag = (FLAGS as Record<string, { defaultValue: boolean } | undefined>)
        .home_layout_server;
      expect(flag, 'home_layout_server is not in FLAGS').toBeDefined();
      expect(flag?.defaultValue).toBe(false);
    });

    it('keeps the HomeLayoutStore interface and the browser store, and adds a server store', () => {
      const dir = join(repoRoot, 'apps', 'web', 'components', 'home');
      const store = readFileSync(join(dir, 'layout-store.ts'), 'utf8');
      expect(store).toMatch(/export interface HomeLayoutStore/);
      expect(store).toMatch(/browserLayoutStore/);
      const serverStore = readdirSync(dir)
        .filter((name) => /\.(?:ts|tsx)$/.test(name))
        .some((name) =>
          /export (?:const|function) serverLayoutStore\b/.test(
            readFileSync(join(dir, name), 'utf8'),
          ),
        );
      expect(serverStore, 'no file under apps/web/components/home exports serverLayoutStore').toBe(
        true,
      );
    });

    it('has the @p03-home spec, with nothing skipped and no waitForTimeout', () => {
      const spec = join(repoRoot, 'tests', 'e2e', 'p03-home.spec.ts');
      expect(existsSync(spec), 'tests/e2e/p03-home.spec.ts is missing').toBe(true);
      const text = readFileSync(spec, 'utf8');
      expect(text).toMatch(/@p03-home/);
      expect(text, 'a skipped or fixme test is not a test').not.toMatch(
        /\.(?:skip|fixme)\(|\btest\.fixme\b/,
      );
      expect(text).not.toMatch(/waitForTimeout/);
    });
  });
});
