import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  BU_A,
  BU_B,
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_TENANTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0029, programme lifecycle: create, archive preview, archive,
 * and a real `programme.status` column.
 *
 * Source: docs/api/admin.openapi.yaml, operations `createProgramme`,
 * `getProgrammeArchivePreview` and `archiveProgramme`, plus the schemas
 * `CreateProgrammeRequest`, `Programme`, `ProgrammeDetail`,
 * `ArchiveProgrammeRequest`, `ArchivePreview` and `Error`. The shape checks
 * below are hand-transcribed from those schemas — this package has no OpenAPI
 * validator. If the spec and this file disagree, the spec is right and this
 * file is the defect: say so in the report, do not edit it.
 *
 * What T-0024 left behind: `status` was the constant `active` (no column).
 * This suite asserts the constant is gone — a status written to the column is
 * the status the API reports, and an archive is visible through
 * `listProgrammes` and `getProgramme`.
 *
 * Fixture shape relied on (packages/db/src/fixtures.ts, seed.ts):
 *   Tenant A  BU_A  programmes A1 "Bank X Collections", A2 "Telco Y Care"
 *   Tenant B  BU_B  programmes B1 "Insurer Z Service", B2 "Retail W Sales"
 *   user_programme:
 *     USER_A_AGENT_1 -> A1   USER_A_AGENT_2 -> A2   USER_A_SUPERVISOR -> A1, A2
 *     USER_A_NO_PROGRAMME -> nothing                USER_B_AGENT_1 -> B1
 *
 * Callers: there is no permissions engine, so tenant A is driven as
 * USER_A_SUPERVISOR and tenant B as USER_B_AGENT_1. `403 not_permitted` is not
 * exercised (who may create or archive is the permissions engine's question).
 * If T-0029 introduces an admin check these callers must pass it; raise it
 * rather than widening anything.
 *
 * Deliberately NOT asserted, because the spec does not define it:
 *   - the status a new programme starts in (`active` or `draft`) — only that it
 *     is a published `ProgrammeStatus` and is not `archived`;
 *   - whether the unfiltered list includes archived programmes — the suite
 *     reads them through `?status=archived` and `statusCounts`;
 *   - what archiving an already-archived programme returns;
 *   - restore (no operation exists), templates (always 400), the audit row
 *     `x-kasuwa-audited` demands (no audit table).
 *
 * Writes: every test that writes reseeds in `finally`, and `afterAll` reseeds
 * again (`TRUNCATE tenant CASCADE` in the seed clears anything keyed to a
 * tenant, including programmes created here).
 */

const BASE = '/api/v1/admin/programmes';
const NOWHERE = '11111111-0000-4000-8000-0000000c9999';
const NO_SUCH_BU = '11111111-0000-4000-8000-0000000b9999';
const PROGRAMME_STATUSES = ['active', 'paused', 'draft', 'archived'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unique per run so a name never collides with an earlier, unreseeded run. */
const RUN = Date.now().toString(36);
let sequence = 0;
const uniqueName = (label: string) => `${label} ${RUN}-${(sequence += 1)}`;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const TENANT_B_USER = asUser(TENANT_B, USER_B_AGENT_1);

type Json = Record<string, unknown>;

const seededProgrammes = SEED_TENANTS.flatMap((tenant) => tenant.programmes);

function seededName(id: string): string {
  const programme = seededProgrammes.find((candidate) => candidate.id === id);
  if (programme === undefined) {
    throw new Error(`Fixture drift: no seeded programme ${id}`);
  }
  return programme.name;
}

// --- shape checks transcribed from docs/api/admin.openapi.yaml -------------

/** `#/components/schemas/Programme` — required [id, name, status]. */
function expectProgramme(value: unknown, where = 'Programme'): Json {
  expect(value, `${where}: not an object`).toEqual(expect.any(Object));
  const programme = value as Json;
  expect(programme.id, `${where}.id`).toMatch(UUID);
  expect(programme.name, `${where}.name`).toEqual(expect.any(String));
  expect(PROGRAMME_STATUSES, `${where}.status`).toContain(programme.status);
  // Scope is resolved, never carried (spec header point 1).
  expect(programme, `${where} must not carry tenantId`).not.toHaveProperty('tenantId');
  return programme;
}

/** `#/components/schemas/ProgrammeDetail` — Programme plus required `version`. */
function expectProgrammeDetail(value: unknown, where = 'ProgrammeDetail'): Json {
  const detail = expectProgramme(value, where);
  expect(Number.isInteger(detail.version), `${where}.version must be an integer`).toBe(true);
  return detail;
}

/** `#/components/schemas/ArchivePreview`. */
function expectArchivePreview(value: unknown): Json {
  expect(value, 'ArchivePreview: not an object').toEqual(expect.any(Object));
  const preview = value as Json;
  for (const field of [
    'agentsLosingAccess',
    'openInteractionsBecomingReadOnly',
    'portalUsersSignedOut',
    'restorableUntilDays',
  ]) {
    expect(Number.isInteger(preview[field]), `ArchivePreview.${field} must be an integer`).toBe(
      true,
    );
    expect(preview[field] as number, `ArchivePreview.${field} is a count`).toBeGreaterThanOrEqual(
      0,
    );
  }
  if (preview.retentionSummary !== undefined) {
    expect(
      preview.retentionSummary === null || typeof preview.retentionSummary === 'string',
      'ArchivePreview.retentionSummary is a string or null',
    ).toBe(true);
  }
  return preview;
}

/** `#/components/schemas/Error`, with the `code` the operation names. */
function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, body: ${JSON.stringify(response.body)}`,
  ).toBe(status);
  const body = response.body as Json;
  expect(body.statusCode, 'Error.statusCode').toBe(status);
  expect(body.error, 'Error.error (the reason phrase)').toEqual(expect.any(String));
  expect(body.code, 'Error.code — clients switch on this, never on message').toBe(code);
  expect(body.message, 'Error.message').toEqual(expect.any(String));
  const details = body.details as { path: string; code: string }[] | undefined;
  for (const detail of details ?? []) {
    // Field paths and reason codes only — never the value, never a DB message.
    expect(Object.keys(detail).sort()).toEqual(['code', 'path']);
  }
  return body;
}

function detailPaths(body: Json): string[] {
  const details = body.details as { path: string }[] | undefined;
  return (details ?? []).map((detail) => detail.path);
}

const idsOf = (items: { id: string }[]) => items.map((item) => item.id).sort();

// ---------------------------------------------------------------------------

describe('acceptance: programme lifecycle (T-0029)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Used only to observe rows, never to serve. */
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

  const server = () => app.getHttpServer();
  const get = (headers: Record<string, string>, path: string) =>
    request(server()).get(path).set(headers);
  const post = (headers: Record<string, string>, path: string, body: unknown) =>
    request(server())
      .post(path)
      .set(headers)
      .send(body as object);

  const archivePath = (id: string) => `${BASE}/${id}/archive`;
  const previewPath = (id: string) => `${BASE}/${id}/archive-preview`;

  async function count(sql: string, values: unknown[]): Promise<number> {
    const result = await observer.query<{ n: number }>(sql, values);
    return result.rows[0]?.n ?? -1;
  }

  const programmeRowsIn = (tenantId: string) =>
    count('SELECT count(*)::int AS n FROM programme WHERE tenant_id = $1', [tenantId]);
  const membersOf = (programmeId: string) =>
    count('SELECT count(*)::int AS n FROM user_programme WHERE programme_id = $1', [programmeId]);
  const contactsOf = (programmeId: string) =>
    count('SELECT count(*)::int AS n FROM contact WHERE programme_id = $1', [programmeId]);

  /** Row counts of every tenant-scoped table, per seeded tenant. */
  async function tenantRowCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const table of TENANT_SCOPED_TABLES) {
      const column = table === 'tenant' ? 'id' : 'tenant_id';
      for (const tenantId of [TENANT_A, TENANT_B]) {
        counts.set(
          `${table}/${tenantId}`,
          await count(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, [
            tenantId,
          ]),
        );
      }
    }
    return counts;
  }

  async function readStatus(programmeId: string): Promise<string | undefined> {
    const result = await observer.query<{ status: string }>(
      'SELECT status FROM programme WHERE id = $1',
      [programmeId],
    );
    return result.rows[0]?.status;
  }

  async function createAsSupervisor(name: string): Promise<Json> {
    const response = await post(SUPERVISOR, BASE, {
      name,
      clientName: 'Pesa Point',
      countryCode: 'NG',
      businessUnitId: BU_A,
    });
    expect(response.status, `createProgramme: ${JSON.stringify(response.body)}`).toBe(201);
    return expectProgramme(response.body, 'createProgramme response');
  }

  // --- createProgramme -------------------------------------------------------

  describe('createProgramme', () => {
    it('is 201 with the Programme shape, and the creator — and only the creator — gets a user_programme row', async () => {
      try {
        const name = uniqueName('Pesa Merchant Onboarding');
        const created = await createAsSupervisor(name);

        expect(created.name).toBe(name);
        expect(created.clientName).toBe('Pesa Point');
        if (created.countryCode !== undefined) {
          expect(created.countryCode).toBe('NG');
        }
        // A new programme is never born archived. Whether it is `active` or
        // `draft` the spec does not say.
        expect(created.status).not.toBe('archived');
        const id = created.id as string;

        const members = await observer.query<{ user_id: string; tenant_id: string }>(
          'SELECT user_id, tenant_id FROM user_programme WHERE programme_id = $1',
          [id],
        );
        expect(members.rows).toEqual([{ user_id: USER_A_SUPERVISOR, tenant_id: TENANT_A }]);

        const row = await observer.query<{ tenant_id: string; business_unit_id: string }>(
          'SELECT tenant_id, business_unit_id FROM programme WHERE id = $1',
          [id],
        );
        expect(row.rows).toEqual([{ tenant_id: TENANT_A, business_unit_id: BU_A }]);

        // Reachable by its creator on the next request: scope is re-resolved
        // from user_programme every time.
        const detail = await get(SUPERVISOR, `${BASE}/${id}`).expect(200);
        expectProgrammeDetail(detail.body);
        expect(detail.body).toMatchObject({ id, name, status: created.status });
        if (detail.body.businessUnitId !== undefined) {
          expect(detail.body.businessUnitId).toBe(BU_A);
        }

        const list = await get(SUPERVISOR, `${BASE}?pageSize=200`).expect(200);
        expect(idsOf(list.body.items as { id: string }[])).toContain(id);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('is unreachable to every unassigned user in the tenant and to other tenants — the same 404 as no programme at all', async () => {
      try {
        const created = await createAsSupervisor(uniqueName('Telco Y Retention'));
        const id = created.id as string;

        const nothing = await get(AGENT_1, `${BASE}/${NOWHERE}`).expect(404);
        expectError(nothing, 404, 'not_found');

        for (const [label, headers] of [
          ['USER_A_AGENT_1', AGENT_1],
          ['USER_A_AGENT_2', asUser(TENANT_A, USER_A_AGENT_2)],
          ['USER_A_NO_PROGRAMME', asUser(TENANT_A, USER_A_NO_PROGRAMME)],
          ['USER_B_AGENT_1', TENANT_B_USER],
        ] as const) {
          const detail = await get(headers, `${BASE}/${id}`).expect(404);
          expect(detail.body, `${label} getProgramme`).toEqual(nothing.body);

          const preview = await get(headers, previewPath(id)).expect(404);
          expect(preview.body, `${label} getProgrammeArchivePreview`).toEqual(nothing.body);

          const list = await get(headers, `${BASE}?pageSize=200`).expect(200);
          expect(
            idsOf(list.body.items as { id: string }[]),
            `${label} listProgrammes`,
          ).not.toContain(id);
        }
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('is 409 duplicate_name for a name taken in the tenant, naming no row, and allows the same name in another tenant', async () => {
      try {
        const before = await programmeRowsIn(TENANT_A);
        const takenName = seededName(PROGRAMME_A2);

        // USER_A_AGENT_1 cannot read A2; the conflict must still not name it.
        for (const headers of [SUPERVISOR, AGENT_1]) {
          const clash = await post(headers, BASE, { name: takenName, businessUnitId: BU_A });
          const body = expectError(clash, 409, 'duplicate_name');
          const raw = JSON.stringify(body);
          expect(raw).not.toContain(PROGRAMME_A2);
          expect(raw, 'never a database message').not.toMatch(/programme_tenant_id_name_key|23505/);
        }
        expect(await programmeRowsIn(TENANT_A), 'a refused create inserted a row').toBe(before);

        // Uniqueness is tenant-scoped: tenant B may use tenant A's name.
        const elsewhere = await post(TENANT_B_USER, BASE, {
          name: takenName,
          businessUnitId: BU_B,
        });
        expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(201);
        expect(expectProgramme(elsewhere.body).name).toBe(takenName);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('rejects a body the spec does not accept with validation_failed at the right path, and creates nothing', async () => {
      try {
        const before = await programmeRowsIn(TENANT_A);
        const marker = 'ZZ-MARKER-'.padEnd(201, 'x');

        const cases: { body: Json; path: string }[] = [
          { body: { businessUnitId: BU_A }, path: 'name' },
          { body: { name: '', businessUnitId: BU_A }, path: 'name' },
          { body: { name: marker, businessUnitId: BU_A }, path: 'name' },
          { body: { name: uniqueName('No BU') }, path: 'businessUnitId' },
          {
            body: { name: uniqueName('Bad BU'), businessUnitId: 'not-a-uuid' },
            path: 'businessUnitId',
          },
          {
            body: { name: uniqueName('Bad country'), businessUnitId: BU_A, countryCode: 'ng' },
            path: 'countryCode',
          },
          // Templates are undefined today: "Sending one is 400".
          {
            body: { name: uniqueName('Template'), businessUnitId: BU_A, templateId: 'collections' },
            path: 'templateId',
          },
          // additionalProperties: false — and these are scope arguments.
          {
            body: { name: uniqueName('Scope'), businessUnitId: BU_A, tenantId: TENANT_B },
            path: 'tenantId',
          },
          {
            body: { name: uniqueName('Scope'), businessUnitId: BU_A, programmeIds: [PROGRAMME_A1] },
            path: 'programmeIds',
          },
          // Lifecycle is not settable at birth through an undeclared field.
          {
            body: { name: uniqueName('Born archived'), businessUnitId: BU_A, status: 'archived' },
            path: 'status',
          },
        ];

        for (const { body, path } of cases) {
          const response = await post(SUPERVISOR, BASE, body);
          const error = expectError(response, 400, 'validation_failed');
          expect(detailPaths(error), `details for ${JSON.stringify(Object.keys(body))}`).toContain(
            path,
          );
          expect(JSON.stringify(response.body)).not.toContain('ZZ-MARKER');
        }

        expect(await programmeRowsIn(TENANT_A), 'a refused create inserted a row').toBe(before);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('treats another tenant’s business unit exactly like one that does not exist: the same 404, nothing created', async () => {
      try {
        const beforeA = await programmeRowsIn(TENANT_A);
        const beforeB = await programmeRowsIn(TENANT_B);

        const foreign = await post(SUPERVISOR, BASE, {
          name: uniqueName('Foreign BU'),
          businessUnitId: BU_B,
        });
        expectError(foreign, 404, 'not_found');

        const nothing = await post(SUPERVISOR, BASE, {
          name: uniqueName('Missing BU'),
          businessUnitId: NO_SUCH_BU,
        });
        expectError(nothing, 404, 'not_found');
        // Same body: a difference is an existence oracle for tenant B's BU.
        expect(foreign.body).toEqual(nothing.body);

        expect(await programmeRowsIn(TENANT_A)).toBe(beforeA);
        expect(await programmeRowsIn(TENANT_B)).toBe(beforeB);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });
  });

  // --- getProgrammeArchivePreview -------------------------------------------

  describe('getProgrammeArchivePreview', () => {
    it('returns the ArchivePreview shape with live counts for a reachable programme', async () => {
      const response = await get(SUPERVISOR, previewPath(PROGRAMME_A1)).expect(200);
      const preview = expectArchivePreview(response.body);

      // Everyone assigned to A1 loses access to A1 when it is archived.
      expect(preview.agentsLosingAccess).toBe(await membersOf(PROGRAMME_A1));
      // No portal-user model exists, so nobody can be signed out.
      expect(preview.portalUsersSignedOut).toBe(0);
      // "restorable for 30 days" — archiveProgramme description.
      expect(preview.restorableUntilDays).toBe(30);

      // Counts only: no names, no ids of people.
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain(USER_A_AGENT_1);
      expect(raw).not.toContain(USER_A_SUPERVISOR);
      expect(raw).not.toMatch(/@/u);
    });

    it('changes nothing: status, version and every row count are as they were', async () => {
      const rowsBefore = await tenantRowCounts();
      const detailBefore = await get(SUPERVISOR, `${BASE}/${PROGRAMME_A1}`).expect(200);

      const first = await get(SUPERVISOR, previewPath(PROGRAMME_A1)).expect(200);
      const second = await get(SUPERVISOR, previewPath(PROGRAMME_A1)).expect(200);
      expect(second.body).toEqual(first.body);

      const detailAfter = await get(SUPERVISOR, `${BASE}/${PROGRAMME_A1}`).expect(200);
      expect(detailAfter.body.status).toBe(detailBefore.body.status);
      expect(detailAfter.body.status).not.toBe('archived');
      expect(detailAfter.body.version).toBe(detailBefore.body.version);
      expect(await readStatus(PROGRAMME_A1)).toBe(detailBefore.body.status);
      expect(await tenantRowCounts()).toEqual(rowsBefore);
    });

    it('is one identical 404 for an unassigned sibling, another tenant’s programme and no programme', async () => {
      const sibling = await get(AGENT_1, previewPath(PROGRAMME_A2)).expect(404);
      const foreign = await get(TENANT_B_USER, previewPath(PROGRAMME_A1)).expect(404);
      const nothing = await get(AGENT_1, previewPath(NOWHERE)).expect(404);

      expectError(sibling, 404, 'not_found');
      expect(foreign.body).toEqual(sibling.body);
      expect(nothing.body).toEqual(sibling.body);
      expect(JSON.stringify(sibling.body)).not.toContain(seededName(PROGRAMME_A2));
    });
  });

  // --- archiveProgramme ------------------------------------------------------

  describe('archiveProgramme', () => {
    it('archives: 200 ProgrammeDetail with status archived, which getProgramme and listProgrammes then report', async () => {
      try {
        const before = await get(SUPERVISOR, `${BASE}/${PROGRAMME_A1}`).expect(200);

        const response = await post(SUPERVISOR, archivePath(PROGRAMME_A1), {
          confirmation: seededName(PROGRAMME_A1),
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const archived = expectProgrammeDetail(response.body, 'archiveProgramme response');
        expect(archived).toMatchObject({ id: PROGRAMME_A1, status: 'archived' });
        expect(archived.version, 'an archive is a write; the version moves on').not.toBe(
          before.body.version,
        );

        expect(await readStatus(PROGRAMME_A1)).toBe('archived');

        const detail = await get(SUPERVISOR, `${BASE}/${PROGRAMME_A1}`).expect(200);
        expect(detail.body.status).toBe('archived');
        expect(detail.body.version).toBe(archived.version);

        // The status filter now means something: T-0024's constant is gone.
        const onlyArchived = await get(SUPERVISOR, `${BASE}?status=archived`).expect(200);
        expect(idsOf(onlyArchived.body.items as { id: string }[])).toEqual([PROGRAMME_A1]);
        for (const item of onlyArchived.body.items as Json[]) {
          expect(expectProgramme(item).status).toBe('archived');
        }

        const onlyActive = await get(SUPERVISOR, `${BASE}?status=active`).expect(200);
        expect(idsOf(onlyActive.body.items as { id: string }[])).toEqual([PROGRAMME_A2]);

        expect(onlyArchived.body.statusCounts).toMatchObject({ active: 1, archived: 1 });

        // A2 was not touched.
        const sibling = await get(SUPERVISOR, `${BASE}/${PROGRAMME_A2}`).expect(200);
        expect(sibling.body.status).toBe('active');
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('deletes no rows anywhere — not memberships, not contacts, not the programme', async () => {
      try {
        const rowsBefore = await tenantRowCounts();
        const membersBefore = await membersOf(PROGRAMME_A1);
        const contactsBefore = await contactsOf(PROGRAMME_A1);
        expect(membersBefore, 'fixture drift: A1 has no members').toBeGreaterThan(0);
        expect(contactsBefore, 'fixture drift: A1 has no contacts').toBeGreaterThan(0);

        await post(SUPERVISOR, archivePath(PROGRAMME_A1), {
          confirmation: seededName(PROGRAMME_A1),
        }).expect(200);

        expect(await membersOf(PROGRAMME_A1), 'user_programme rows were deleted').toBe(
          membersBefore,
        );
        expect(await contactsOf(PROGRAMME_A1), 'contact rows were deleted').toBe(contactsBefore);

        const rowsAfter = await tenantRowCounts();
        // The data tables must be exactly as they were.
        for (const table of [
          'tenant',
          'business_unit',
          'programme',
          'user',
          'user_programme',
          'contact',
        ]) {
          for (const tenantId of [TENANT_A, TENANT_B]) {
            const key = `${table}/${tenantId}`;
            expect(rowsAfter.get(key), `${key} changed`).toBe(rowsBefore.get(key));
          }
        }
        // Nothing anywhere went down (auth tables may legitimately grow).
        for (const [key, beforeCount] of rowsBefore) {
          expect(rowsAfter.get(key) ?? -1, `${key} lost rows`).toBeGreaterThanOrEqual(beforeCount);
        }
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('refuses a confirmation that is not the programme’s exact name, or a body the spec does not accept, and archives nothing', async () => {
      try {
        const name = seededName(PROGRAMME_A1);
        const cases: { body: Json; path: string }[] = [
          { body: {}, path: 'confirmation' },
          { body: { confirmation: 'archive' }, path: 'confirmation' },
          { body: { confirmation: name.toUpperCase() }, path: 'confirmation' },
          { body: { confirmation: `${name} ` }, path: 'confirmation' },
          { body: { confirmation: seededName(PROGRAMME_A2) }, path: 'confirmation' },
          { body: { confirmation: name, programmeIds: [PROGRAMME_A2] }, path: 'programmeIds' },
        ];

        for (const { body, path } of cases) {
          const response = await post(SUPERVISOR, archivePath(PROGRAMME_A1), body);
          const error = expectError(response, 400, 'validation_failed');
          expect(detailPaths(error), `details for ${JSON.stringify(body)}`).toContain(path);
        }

        expect(await readStatus(PROGRAMME_A1)).not.toBe('archived');
        const detail = await get(SUPERVISOR, `${BASE}/${PROGRAMME_A1}`).expect(200);
        expect(detail.body.status).not.toBe('archived');
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('is one identical 404 for an unassigned sibling, another tenant’s programme and no programme — even with the right name — and archives nothing', async () => {
      try {
        const sibling = await post(AGENT_1, archivePath(PROGRAMME_A2), {
          confirmation: seededName(PROGRAMME_A2),
        });
        expectError(sibling, 404, 'not_found');

        const foreign = await post(TENANT_B_USER, archivePath(PROGRAMME_A1), {
          confirmation: seededName(PROGRAMME_A1),
        });
        const crossTenant = await post(SUPERVISOR, archivePath(PROGRAMME_B1), {
          confirmation: seededName(PROGRAMME_B1),
        });
        const nothing = await post(AGENT_1, archivePath(NOWHERE), { confirmation: 'anything' });

        expect(foreign.status).toBe(404);
        expect(crossTenant.status).toBe(404);
        expect(nothing.status).toBe(404);
        expect(foreign.body).toEqual(sibling.body);
        expect(crossTenant.body).toEqual(sibling.body);
        expect(nothing.body).toEqual(sibling.body);

        // An unreachable id is 404 whatever the body: a wrong confirmation on
        // a sibling must not turn into a 400 that confirms it exists.
        const wrongName = await post(AGENT_1, archivePath(PROGRAMME_A2), { confirmation: 'x' });
        expect(wrongName.status).toBe(404);
        expect(wrongName.body).toEqual(sibling.body);

        for (const id of [PROGRAMME_A1, PROGRAMME_A2, PROGRAMME_B1]) {
          expect(
            await readStatus(id),
            `${id} was archived by a caller who cannot reach it`,
          ).not.toBe('archived');
        }
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });
  });

  // --- authentication and scope transport, across all three operations -------

  describe('authentication and scope headers', () => {
    const operations: { name: string; send: (headers: Record<string, string>) => request.Test }[] =
      [
        {
          name: 'createProgramme',
          send: (headers) =>
            post(headers, BASE, { name: uniqueName('Auth'), businessUnitId: BU_A }),
        },
        {
          name: 'getProgrammeArchivePreview',
          send: (headers) => get(headers, previewPath(PROGRAMME_A1)),
        },
        {
          name: 'archiveProgramme',
          send: (headers) =>
            post(headers, archivePath(PROGRAMME_A1), { confirmation: seededName(PROGRAMME_A1) }),
        },
      ];

    it('is 401 not_authenticated without a usable session on every operation, and nothing is written', async () => {
      try {
        const before = await programmeRowsIn(TENANT_A);
        for (const operation of operations) {
          const none = await operation.send({});
          expect(none.status, `${operation.name} with no credentials`).toBe(401);

          const bogus = await operation.send({ authorization: 'Bearer ksw_s1_not-a-real-session' });
          expect(bogus.status, `${operation.name} with a forged bearer token`).toBe(401);
          expectError(bogus, 401, 'not_authenticated');

          const crossed = await operation.send(asUser(TENANT_B, USER_A_SUPERVISOR));
          expect(crossed.status, `${operation.name} as a user under the wrong tenant`).toBe(401);
        }
        expect(await programmeRowsIn(TENANT_A)).toBe(before);
        expect(await readStatus(PROGRAMME_A1)).not.toBe('archived');
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('is 400 for a request that supplies its own programme scope, on every operation, and nothing is written', async () => {
      try {
        const before = await programmeRowsIn(TENANT_A);
        for (const operation of operations) {
          for (const header of [
            'x-kasuwa-programme-ids',
            'x-kasuwa-programme-id',
            'x-kasuwa-scope',
          ]) {
            const response = await operation.send({ ...AGENT_1, [header]: PROGRAMME_A2 });
            expect(response.status, `${operation.name} with ${header}`).toBe(400);
            expect(JSON.stringify(response.body)).not.toContain(seededName(PROGRAMME_A2));
          }
        }
        expect(await programmeRowsIn(TENANT_A)).toBe(before);
        expect(await readStatus(PROGRAMME_A1)).not.toBe('archived');
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });
  });

  // --- schema and contract ---------------------------------------------------

  describe('schema and contract', () => {
    it('programme.status is a NOT NULL column with a CHECK constraint, and it is what the API reports', async () => {
      try {
        const column = await observer.query<{ nullable: string; data_type: string }>(
          `SELECT is_nullable AS nullable, data_type
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'programme' AND column_name = 'status'`,
        );
        expect(column.rows, 'programme.status does not exist').toHaveLength(1);
        expect(column.rows[0]?.nullable, 'programme.status must be NOT NULL').toBe('NO');

        // A CHECK constraint on programme that names status and every
        // published ProgrammeStatus value.
        const checks = await observer.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(c.oid) AS definition
             FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' AND t.relname = 'programme' AND c.contype = 'c'`,
        );
        const statusCheck = checks.rows.find((row) => /\bstatus\b/.test(row.definition));
        expect(statusCheck, 'no CHECK constraint on programme.status').toBeDefined();
        for (const value of PROGRAMME_STATUSES) {
          expect(statusCheck?.definition, `CHECK does not admit '${value}'`).toContain(
            `'${value}'`,
          );
        }

        // The constraint actually refuses a value outside the enum.
        const client = await observer.connect();
        try {
          await client.query('BEGIN');
          await expect(
            client.query(`UPDATE programme SET status = 'deleted' WHERE id = $1`, [PROGRAMME_A2]),
          ).rejects.toMatchObject({ code: '23514' });
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }

        // Seeded programmes predate the column; the expand migration keeps
        // them `active`, which is what T-0024 reported.
        expect(await readStatus(PROGRAMME_A1)).toBe('active');
        expect(await readStatus(PROGRAMME_A2)).toBe('active');

        // Not a constant: a status written to the column is the status read.
        await observer.query(`UPDATE programme SET status = 'paused' WHERE id = $1`, [
          PROGRAMME_A2,
        ]);
        const detail = await get(SUPERVISOR, `${BASE}/${PROGRAMME_A2}`).expect(200);
        expect(detail.body.status).toBe('paused');
        const list = await get(SUPERVISOR, BASE).expect(200);
        const a2 = (list.body.items as Json[]).find((item) => item.id === PROGRAMME_A2);
        expect(a2?.status).toBe('paused');
        expect(list.body.statusCounts).toMatchObject({ active: 1, paused: 1 });
        const paused = await get(SUPERVISOR, `${BASE}?status=paused`).expect(200);
        expect(idsOf(paused.body.items as { id: string }[])).toEqual([PROGRAMME_A2]);
      } finally {
        await reseed(inject('migrationUrl'));
      }
    });

    it('the spec marks every T-0029 operation x-kasuwa-implemented: true', () => {
      const spec = readFileSync(resolve(__dirname, '../../../docs/api/admin.openapi.yaml'), 'utf8');
      for (const operationId of [
        'createProgramme',
        'getProgrammeArchivePreview',
        'archiveProgramme',
      ]) {
        const match = new RegExp(
          `operationId:\\s*${operationId}\\s*\\n\\s*x-kasuwa-implemented:\\s*(\\S+)`,
        ).exec(spec);
        expect(match, `${operationId} not found in admin.openapi.yaml`).not.toBeNull();
        expect(match?.[1], `${operationId} is not marked implemented`).toBe('true');
      }
    });
  });
});
