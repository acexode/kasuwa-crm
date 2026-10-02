import type { INestApplication } from '@nestjs/common';
import {
  BU_A,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  PROGRAMME_B2,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE â€” T-0024, the programmes admin API.
 *
 * Source: docs/api/admin.openapi.yaml, operations `listProgrammes`,
 * `getProgramme`, `updateProgramme` and `listProgrammeAgents`. Read the file
 * header there before arguing with an assertion here: points 1 (scope is
 * resolved, never supplied), 2 (out of scope is 404, never 403) and 4 (every
 * failure is a concrete `Error` body) are what most of this suite checks.
 *
 * Fixture shape relied on (packages/db/src/fixtures.ts, seed.ts):
 *   Tenant A  programmes A1 "Bank X Collections" / "Bank X"  (default)
 *                        A2 "Telco Y Care"       / "Telco Y"
 *   Tenant B  programmes B1 "Insurer Z Service"  / "Insurer Z" (default)
 *                        B2 "Retail W Sales"     / "Retail W"
 *   user_programme (skills ['voice'] on every row):
 *     USER_A_AGENT_1      -> A1
 *     USER_A_AGENT_2      -> A2
 *     USER_A_SUPERVISOR   -> A1, A2
 *     USER_A_NO_PROGRAMME -> nothing
 *     USER_B_AGENT_1      -> B1
 *
 * What is deliberately NOT asserted, because the spec does not yet define it or
 * no column backs it (T-0024 forbids a migration): `status` beyond being one of
 * the published enum values, `channels`, `agentCount`, `slaAttainment7d`,
 * `retentionSummary`, the overview cards, `presence` beyond its enum, changing
 * `status` through PATCH, and the audit row `x-kasuwa-audited` demands (there
 * is no audit table). Who may *edit* a programme they can read (`403
 * not_permitted`) waits on the permissions engine and is not tested either.
 */

const BASE = '/api/v1/admin/programmes';
const NOWHERE = '11111111-0000-4000-8000-0000000c9999';
const PROGRAMME_STATUSES = ['active', 'paused', 'draft', 'archived'];
const PRESENCE_VALUES = ['available', 'on_call', 'on_break', 'offline', null];

interface SeedProgramme {
  id: string;
  name: string;
  clientName: string | null;
}

interface SeedUser {
  id: string;
  displayName: string;
  programmeIds: string[];
}

const seededProgrammes: SeedProgramme[] = SEED_TENANTS.flatMap((tenant) => tenant.programmes);
const seededUsers: SeedUser[] = SEED_TENANTS.flatMap((tenant) => tenant.users);

function seededProgramme(id: string): SeedProgramme {
  const programme = seededProgrammes.find((candidate) => candidate.id === id);
  if (programme === undefined) {
    throw new Error(`Fixture drift: no seeded programme ${id}`);
  }
  return programme;
}

function membersOf(programmeId: string): SeedUser[] {
  return seededUsers.filter((user) => user.programmeIds.includes(programmeId));
}

interface ApiErrorBody {
  statusCode: number;
  error: string;
  code: string;
  message: string;
  details?: { path: string; code: string }[];
}

/** The spec's `Error` schema: four required fields, details as path + code only. */
function expectErrorShape(body: unknown, statusCode: number, code: string): ApiErrorBody {
  expect(body).toMatchObject({
    statusCode,
    error: expect.any(String),
    code,
    message: expect.any(String),
  });
  const typed = body as ApiErrorBody;
  if (typed.details !== undefined) {
    for (const detail of typed.details) {
      expect(Object.keys(detail).sort()).toEqual(['code', 'path']);
    }
  }
  return typed;
}

function expectProgrammeShape(item: unknown): void {
  // `Programme.required` is [id, name, status].
  expect(item).toMatchObject({
    id: expect.any(String),
    name: expect.any(String),
  });
  expect(PROGRAMME_STATUSES).toContain((item as { status: unknown }).status);
}

function expectPageShape(page: unknown): void {
  // `Page.required` is [nextCursor, hasMore].
  expect(page).toBeTypeOf('object');
  const typed = page as { nextCursor: unknown; hasMore: unknown };
  expect(typed.nextCursor === null || typeof typed.nextCursor === 'string').toBe(true);
  expect(typed.hasMore).toBeTypeOf('boolean');
}

const idsOf = (items: { id: string }[]) => items.map((item) => item.id).sort();

describe('acceptance (pending): programmes admin API (T-0024)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const get = (headers: Record<string, string>, path: string) =>
    request(server()).get(path).set(headers);
  const patch = (headers: Record<string, string>, path: string, body: unknown) =>
    request(server())
      .patch(path)
      .set(headers)
      .send(body as object);

  const supervisor = () => asUser(TENANT_A, USER_A_SUPERVISOR);

  async function currentVersion(programmeId: string): Promise<number> {
    const response = await get(supervisor(), `${BASE}/${programmeId}`).expect(200);
    const version: unknown = response.body.version;
    expect(Number.isInteger(version)).toBe(true);
    return version as number;
  }

  // --- listProgrammes --------------------------------------------------------

  describe('listProgrammes', () => {
    it('returns the ProgrammeList shape with exactly the callerâ€™s reachable programmes', async () => {
      const response = await get(supervisor(), BASE).expect(200);

      expect(response.body).toMatchObject({
        items: expect.any(Array),
        statusCounts: expect.any(Object),
      });
      expectPageShape(response.body.page);
      expect(response.body.page).toMatchObject({ nextCursor: null, hasMore: false });

      const items = response.body.items as { id: string; name: string; clientName: unknown }[];
      expect(idsOf(items)).toEqual([PROGRAMME_A1, PROGRAMME_A2].sort());
      for (const item of items) {
        expectProgrammeShape(item);
        const seed = seededProgramme(item.id);
        expect(item.name).toBe(seed.name);
        expect(item.clientName).toBe(seed.clientName);
      }
    });

    it('omits a same-tenant programme the caller is not assigned to, and every other tenantâ€™s', async () => {
      const agentOne = await get(asUser(TENANT_A, USER_A_AGENT_1), BASE).expect(200);
      expect(idsOf(agentOne.body.items)).toEqual([PROGRAMME_A1]);

      const agentTwo = await get(asUser(TENANT_A, USER_A_AGENT_2), BASE).expect(200);
      expect(idsOf(agentTwo.body.items)).toEqual([PROGRAMME_A2]);

      // Tenant B's agent is in B1 only: not B2 (same tenant, unassigned) and
      // nothing from tenant A.
      const tenantB = await get(asUser(TENANT_B, USER_B_AGENT_1), BASE).expect(200);
      expect(idsOf(tenantB.body.items)).toEqual([PROGRAMME_B1]);
      expect(idsOf(tenantB.body.items)).not.toContain(PROGRAMME_B2);
    });

    it('gives a user with no programme membership an empty list, not an error', async () => {
      const response = await get(asUser(TENANT_A, USER_A_NO_PROGRAMME), BASE).expect(200);

      expect(response.body.items).toEqual([]);
      expectPageShape(response.body.page);
      expect(response.body.page).toMatchObject({ nextCursor: null, hasMore: false });
    });

    it('filters by q over name and client name, inside the reachable set only', async () => {
      // "Telco" matches A2 by name; "Bank X" matches A1 by both.
      const byName = await get(supervisor(), `${BASE}?q=Telco`).expect(200);
      expect(idsOf(byName.body.items)).toEqual([PROGRAMME_A2]);

      // "Insurer Z" names a real programme â€” in tenant B. q must not reach it.
      const elsewhere = await get(supervisor(), `${BASE}?q=Insurer%20Z`).expect(200);
      expect(elsewhere.body.items).toEqual([]);

      // Agent 1 cannot find A2 by searching for it.
      const sibling = await get(asUser(TENANT_A, USER_A_AGENT_1), `${BASE}?q=Telco`).expect(200);
      expect(sibling.body.items).toEqual([]);
    });

    it('paginates with an opaque cursor, and a cursor does not carry scope to another caller', async () => {
      const first = await get(supervisor(), `${BASE}?pageSize=1`).expect(200);
      expect(first.body.items).toHaveLength(1);
      expect(first.body.page.hasMore).toBe(true);
      expect(first.body.page.nextCursor).toEqual(expect.any(String));
      const cursor = first.body.page.nextCursor as string;

      const second = await get(
        supervisor(),
        `${BASE}?pageSize=1&cursor=${encodeURIComponent(cursor)}`,
      ).expect(200);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.page).toMatchObject({ nextCursor: null, hasMore: false });

      const walked = [...first.body.items, ...second.body.items] as { id: string }[];
      expect(idsOf(walked)).toEqual([PROGRAMME_A1, PROGRAMME_A2].sort());

      // The supervisor's cursor replayed by agent 1: a 400, or a page of agent
      // 1's own programmes. Never A2.
      const replay = await get(
        asUser(TENANT_A, USER_A_AGENT_1),
        `${BASE}?pageSize=1&cursor=${encodeURIComponent(cursor)}`,
      );
      expect([200, 400]).toContain(replay.status);
      if (replay.status === 200) {
        expect(idsOf(replay.body.items)).not.toContain(PROGRAMME_A2);
      } else {
        expectErrorShape(replay.body, 400, 'validation_failed');
      }
    });

    it('rejects a pageSize outside 1..200 with a validation_failed body', async () => {
      for (const pageSize of ['0', '201', 'ten']) {
        const response = await get(supervisor(), `${BASE}?pageSize=${pageSize}`).expect(400);
        const body = expectErrorShape(response.body, 400, 'validation_failed');
        expect(body.details?.map((detail) => detail.path)).toContain('pageSize');
      }
    });

    it('does not widen the list for a client-supplied programmeIds argument', async () => {
      const response = await get(
        asUser(TENANT_A, USER_A_AGENT_1),
        `${BASE}?programmeIds=${PROGRAMME_A2}`,
      );
      // Rejecting the argument is fine; honouring it is the defect.
      expect([200, 400]).toContain(response.status);
      if (response.status === 200) {
        expect(idsOf(response.body.items)).toEqual([PROGRAMME_A1]);
      }
    });
  });

  // --- getProgramme ----------------------------------------------------------

  describe('getProgramme', () => {
    it('returns the ProgrammeDetail shape for a reachable programme', async () => {
      const response = await get(supervisor(), `${BASE}/${PROGRAMME_A1}`).expect(200);
      const seed = seededProgramme(PROGRAMME_A1);

      expectProgrammeShape(response.body);
      expect(response.body).toMatchObject({
        id: PROGRAMME_A1,
        name: seed.name,
        clientName: seed.clientName,
      });
      // `version` is required on ProgrammeDetail; it is what PATCH sends back.
      expect(Number.isInteger(response.body.version)).toBe(true);
      if (response.body.businessUnitId !== undefined) {
        expect(response.body.businessUnitId).toBe(BU_A);
      }
    });

    it('answers an unassigned same-tenant programme, another tenantâ€™s, and no programme at all with one identical 404', async () => {
      const agentOne = asUser(TENANT_A, USER_A_AGENT_1);

      const sibling = await get(agentOne, `${BASE}/${PROGRAMME_A2}`).expect(404);
      const otherTenant = await get(agentOne, `${BASE}/${PROGRAMME_B1}`).expect(404);
      const nothing = await get(agentOne, `${BASE}/${NOWHERE}`).expect(404);

      expectErrorShape(sibling.body, 404, 'not_found');
      // Same body, byte for byte: a difference is an existence oracle.
      expect(otherTenant.body).toEqual(sibling.body);
      expect(nothing.body).toEqual(sibling.body);
    });
  });

  // --- updateProgramme -------------------------------------------------------

  describe('updateProgramme', () => {
    it('renames a reachable programme, returns ProgrammeDetail, and moves the version on', async () => {
      try {
        const before = await currentVersion(PROGRAMME_A1);
        const renamed = 'Bank X Collections â€” Recoveries';

        const response = await patch(supervisor(), `${BASE}/${PROGRAMME_A1}`, {
          version: before,
          name: renamed,
        }).expect(200);

        expectProgrammeShape(response.body);
        expect(response.body).toMatchObject({ id: PROGRAMME_A1, name: renamed });
        expect(Number.isInteger(response.body.version)).toBe(true);
        expect(response.body.version).not.toBe(before);

        const reread = await get(supervisor(), `${BASE}/${PROGRAMME_A1}`).expect(200);
        expect(reread.body.name).toBe(renamed);
        expect(reread.body.version).toBe(response.body.version);

        // The version from before the write is now stale.
        const stale = await patch(supervisor(), `${BASE}/${PROGRAMME_A1}`, {
          version: before,
          clientName: 'Bank X Plc',
        }).expect(409);
        expectErrorShape(stale.body, 409, 'stale_write');

        const unchanged = await get(supervisor(), `${BASE}/${PROGRAMME_A1}`).expect(200);
        expect(unchanged.body.clientName).toBe(seededProgramme(PROGRAMME_A1).clientName);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('is 404 for an unassigned or foreign programme even with a correct version, and changes nothing', async () => {
      try {
        const version = await currentVersion(PROGRAMME_A2);
        const hijack = { version, name: 'Hijacked' };

        const sibling = await patch(
          asUser(TENANT_A, USER_A_AGENT_1),
          `${BASE}/${PROGRAMME_A2}`,
          hijack,
        ).expect(404);
        expectErrorShape(sibling.body, 404, 'not_found');

        const foreign = await patch(
          asUser(TENANT_B, USER_B_AGENT_1),
          `${BASE}/${PROGRAMME_A2}`,
          hijack,
        ).expect(404);
        expect(foreign.body).toEqual(sibling.body);

        const after = await get(supervisor(), `${BASE}/${PROGRAMME_A2}`).expect(200);
        expect(after.body.name).toBe(seededProgramme(PROGRAMME_A2).name);
        expect(after.body.version).toBe(version);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('rejects a body the spec does not accept with validation_failed, naming the path and never echoing the value', async () => {
      const marker = 'ZZ-MARKER-'.padEnd(201, 'x');
      const version = await currentVersion(PROGRAMME_A1);

      const cases: { body: unknown; path: string }[] = [
        { body: { name: 'No version' }, path: 'version' },
        { body: { version, name: '' }, path: 'name' },
        { body: { version, name: marker }, path: 'name' },
        // Archiving has its own operation; PATCH accepts active | paused only.
        { body: { version, status: 'archived' }, path: 'status' },
        // additionalProperties: false â€” and this one is a scope argument.
        { body: { version, programmeIds: [PROGRAMME_A2] }, path: 'programmeIds' },
      ];

      for (const { body, path } of cases) {
        const response = await patch(supervisor(), `${BASE}/${PROGRAMME_A1}`, body).expect(400);
        const error = expectErrorShape(response.body, 400, 'validation_failed');
        expect(
          error.details?.map((detail) => detail.path),
          `details for ${JSON.stringify(Object.keys(body as object))}`,
        ).toContain(path);
        expect(JSON.stringify(response.body)).not.toContain('ZZ-MARKER');
      }

      const after = await get(supervisor(), `${BASE}/${PROGRAMME_A1}`).expect(200);
      expect(after.body.name).toBe(seededProgramme(PROGRAMME_A1).name);
      expect(after.body.version).toBe(version);
    });

    it('treats name uniqueness as tenant-scoped: 409 duplicate_name inside the tenant, allowed across tenants', async () => {
      try {
        const takenName = seededProgramme(PROGRAMME_A1).name;

        const clash = await patch(supervisor(), `${BASE}/${PROGRAMME_A2}`, {
          version: await currentVersion(PROGRAMME_A2),
          name: takenName,
        }).expect(409);
        const error = expectErrorShape(clash.body, 409, 'duplicate_name');
        // Field path only â€” never the conflicting row.
        expect(JSON.stringify(error)).not.toContain(PROGRAMME_A1);

        // Tenant B may use tenant A's programme name: nothing to tell it.
        const tenantB = asUser(TENANT_B, USER_B_AGENT_1);
        const b1 = await get(tenantB, `${BASE}/${PROGRAMME_B1}`).expect(200);
        const renamed = await patch(tenantB, `${BASE}/${PROGRAMME_B1}`, {
          version: b1.body.version,
          name: takenName,
        }).expect(200);
        expect(renamed.body.name).toBe(takenName);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });
  });

  // --- listProgrammeAgents ---------------------------------------------------

  describe('listProgrammeAgents', () => {
    it('returns the seeded user_programme assignments for the programme and nobody else', async () => {
      const response = await get(supervisor(), `${BASE}/${PROGRAMME_A1}/agents`).expect(200);

      expect(response.body.items).toEqual(expect.any(Array));
      expectPageShape(response.body.page);

      const items = response.body.items as {
        userId: string;
        displayName: string;
        presence: unknown;
        skills?: unknown;
      }[];
      const expected = membersOf(PROGRAMME_A1);
      expect(items.map((item) => item.userId).sort()).toEqual(
        expected.map((user) => user.id).sort(),
      );
      // Members of A2 only, and the unassigned user, are not in A1's table.
      expect(items.map((item) => item.userId)).not.toContain(USER_A_AGENT_2);
      expect(items.map((item) => item.userId)).not.toContain(USER_A_NO_PROGRAMME);

      for (const item of items) {
        // Required: userId, displayName, presence (nullable, but present).
        expect(Object.keys(item)).toEqual(
          expect.arrayContaining(['userId', 'displayName', 'presence']),
        );
        const seed = expected.find((user) => user.id === item.userId);
        expect(item.displayName).toBe(seed?.displayName);
        expect(PRESENCE_VALUES).toContain(item.presence);
        if (item.skills !== undefined) {
          expect(item.skills).toEqual(['voice']);
        }
      }

      // No email address, no phone number (spec: "No email address, no phone number").
      const raw = JSON.stringify(response.body);
      expect(raw).not.toMatch(/@/u);
      expect(raw).not.toMatch(/\+\d{6,}/u);
    });

    it('paginates the agents table with an opaque cursor', async () => {
      const first = await get(supervisor(), `${BASE}/${PROGRAMME_A2}/agents?pageSize=1`).expect(
        200,
      );
      expect(first.body.items).toHaveLength(1);
      expect(first.body.page.hasMore).toBe(true);
      const cursor = first.body.page.nextCursor as string;
      expect(cursor).toEqual(expect.any(String));

      const second = await get(
        supervisor(),
        `${BASE}/${PROGRAMME_A2}/agents?pageSize=1&cursor=${encodeURIComponent(cursor)}`,
      ).expect(200);
      expect(second.body.page).toMatchObject({ nextCursor: null, hasMore: false });

      const walked = [...first.body.items, ...second.body.items] as { userId: string }[];
      expect(walked.map((item) => item.userId).sort()).toEqual(
        membersOf(PROGRAMME_A2)
          .map((user) => user.id)
          .sort(),
      );
    });

    it('is the same 404 for an unassigned, foreign or non-existent programme', async () => {
      const agentOne = asUser(TENANT_A, USER_A_AGENT_1);

      const sibling = await get(agentOne, `${BASE}/${PROGRAMME_A2}/agents`).expect(404);
      const foreign = await get(
        asUser(TENANT_B, USER_B_AGENT_1),
        `${BASE}/${PROGRAMME_A1}/agents`,
      ).expect(404);
      const nothing = await get(agentOne, `${BASE}/${NOWHERE}/agents`).expect(404);

      expectErrorShape(sibling.body, 404, 'not_found');
      expect(foreign.body).toEqual(sibling.body);
      expect(nothing.body).toEqual(sibling.body);
    });
  });

  // --- authentication and scope transport, across all four operations -------

  describe('authentication and scope headers', () => {
    const operations: { name: string; send: (headers: Record<string, string>) => request.Test }[] =
      [
        { name: 'listProgrammes', send: (headers) => get(headers, BASE) },
        { name: 'getProgramme', send: (headers) => get(headers, `${BASE}/${PROGRAMME_A1}`) },
        {
          name: 'updateProgramme',
          send: (headers) => patch(headers, `${BASE}/${PROGRAMME_A1}`, { version: 1, name: 'x' }),
        },
        {
          name: 'listProgrammeAgents',
          send: (headers) => get(headers, `${BASE}/${PROGRAMME_A1}/agents`),
        },
      ];

    it('is 401 without a usable session on every operation', async () => {
      for (const operation of operations) {
        const none = await operation.send({});
        expect(none.status, `${operation.name} with no credentials`).toBe(401);

        const bogus = await operation.send({ authorization: 'Bearer ksw_s1_not-a-real-session' });
        expect(bogus.status, `${operation.name} with a forged bearer token`).toBe(401);
        expectErrorShape(bogus.body, 401, 'not_authenticated');

        // A real user paired with the wrong tenant is not a user at all.
        const crossed = await operation.send(asUser(TENANT_B, USER_A_SUPERVISOR));
        expect(crossed.status, `${operation.name} as a user under the wrong tenant`).toBe(401);
      }
    });

    it('rejects a request that tries to supply its own programme scope, on every operation', async () => {
      for (const operation of operations) {
        for (const header of [
          'x-kasuwa-programme-ids',
          'x-kasuwa-programme-id',
          'x-kasuwa-scope',
        ]) {
          const response = await operation.send({
            ...asUser(TENANT_A, USER_A_AGENT_1),
            [header]: PROGRAMME_A2,
          });
          expect(response.status, `${operation.name} with ${header}`).toBe(400);
          expect(JSON.stringify(response.body)).not.toContain(seededProgramme(PROGRAMME_A2).name);
        }
      }
    });
  });
});
