import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0026, admin API: the field-security matrix (Agent 2, M15).
 *
 * The contract is `docs/api/admin.openapi.yaml`, operations
 * `getFieldSecurityMatrix` and `updateFieldSecurityMatrix`, and D-P9
 * (DECISION-LOG, 2026-10-02): the matrix has TWO axes — field and permission
 * set — it is tenant-level, and there is no `programmeId` anywhere in it.
 * Programme scoping comes from `user_programme` carrying a permission set per
 * assignment, so each decision is stored once.
 *
 * The shape checks are hand-transcribed from the spec's `FieldSecurityMatrix`,
 * `FieldSecurityWrite`, `FieldAccessLevel`, `FieldClassification` and `Error`
 * schemas. If the spec and these checks ever disagree, the spec is right and
 * this file is the defect: say so in the report, do not edit it.
 *
 * WHAT THIS SUITE IS REALLY ABOUT
 *
 *   1. The matrix describes who may see a field; it never contains the field's
 *      data, and it never grows a programme axis.
 *   2. The Admin column is padlocked server-side. The disabled button is a
 *      courtesy, not the control.
 *   3. Another tenant's object, field or permission set is indistinguishable
 *      from one that does not exist — `404 not_found`, the same body.
 *   4. A stale `version` is `409 stale_write`, never a silent overwrite.
 *
 * Fixtures. Metadata rows are created inline, through the ordinary RLS-bound
 * path, exactly as the T-0023 metadata suite does: the seed has no
 * `object_def` rows. Permission sets are the seeded defaults (agent, team_lead,
 * qa_analyst, programme_manager, client_portal, admin — admin locked), plus one
 * extra set created inline in tenant A so a cross-tenant column is
 * unambiguous (the default keys are identical in both tenants).
 *
 * Callers. No permissions engine exists, so tenant A is driven as
 * USER_A_SUPERVISOR and tenant B as USER_B_AGENT_1, as in the roles suite. The
 * spec's `403` for "you may not administer field security" is not exercised;
 * the one `403` asserted is the locked column, which the spec's NotPermitted
 * description fits exactly ("you can already read this record, and you may not
 * perform this action on it").
 *
 * Writes. The suite reseeds before and after.
 */

const MATRIX = '/api/v1/admin/field-security/matrix';

// Tenant A: one object with three fields. Tenant B: one object whose name and
// fields exist nowhere in tenant A, so a leak is unambiguous.
const OBJ_A_VISIT = '11111111-0000-4000-8000-0000002600a1';
const OBJ_B_INTEL = '22222222-0000-4000-8000-0000002600b1';
/** A permission set only tenant A has. */
const PS_A_AUDITOR = '11111111-0000-4000-8000-0000002610a1';
const A_ONLY_SET = 'external_auditor';

const A_FIELDS = ['priority', 'visit_notes', 'visited_on'] as const;
const B_FIELDS = ['rival_name', 'threat_level'] as const;

/** The seeded default columns, in both tenants. Admin is the locked one. */
const DEFAULT_SETS = [
  'agent',
  'team_lead',
  'qa_analyst',
  'programme_manager',
  'client_portal',
  'admin',
] as const;

const LEVELS = ['none', 'read', 'edit'] as const;
const CLASSIFICATIONS = ['none', 'pii', 'sensitive'] as const;

const A = asUser(TENANT_A, USER_A_SUPERVISOR);
const B = asUser(TENANT_B, USER_B_AGENT_1);

// --- shape checks transcribed from docs/api/admin.openapi.yaml -------------

type Json = Record<string, unknown>;
type Level = (typeof LEVELS)[number];

interface Cell {
  permissionSetId: string;
  level: Level;
  locked: boolean;
}

interface Row {
  fieldApiName: string;
  label: string;
  classification: string;
  cells: Cell[];
}

interface Matrix {
  objectApiName: string;
  version: number;
  totalFieldCount?: number;
  rows: Row[];
}

/** `#/components/schemas/FieldSecurityMatrix`. */
function expectMatrix(value: unknown): Matrix {
  expect(value, 'FieldSecurityMatrix: not an object').toEqual(expect.any(Object));
  const matrix = value as Json;

  // Exactly the spec's properties. "It never contains a field's data — no
  // sample value, no record count, no example." And no programme axis (D-P9).
  const allowed = ['objectApiName', 'version', 'totalFieldCount', 'rows'];
  for (const key of Object.keys(matrix)) {
    expect(allowed, `FieldSecurityMatrix carries an unspecified property "${key}"`).toContain(key);
  }
  expect(matrix.objectApiName, 'FieldSecurityMatrix.objectApiName').toEqual(expect.any(String));
  expect(Number.isInteger(matrix.version), 'FieldSecurityMatrix.version must be an integer').toBe(
    true,
  );
  if (matrix.totalFieldCount !== undefined) {
    expect(Number.isInteger(matrix.totalFieldCount), 'totalFieldCount must be an integer').toBe(
      true,
    );
  }
  expect(Array.isArray(matrix.rows), 'FieldSecurityMatrix.rows must be an array').toBe(true);

  (matrix.rows as unknown[]).forEach((value, index) => {
    const where = `rows[${index}]`;
    const row = value as Json;
    expect(Object.keys(row).sort(), `${where}: exactly the spec's row properties`).toEqual([
      'cells',
      'classification',
      'fieldApiName',
      'label',
    ]);
    expect(row.fieldApiName, `${where}.fieldApiName`).toEqual(expect.any(String));
    expect(row.label, `${where}.label`).toEqual(expect.any(String));
    expect(CLASSIFICATIONS, `${where}.classification`).toContain(row.classification);
    expect(Array.isArray(row.cells), `${where}.cells`).toBe(true);
    (row.cells as unknown[]).forEach((value, cellIndex) => {
      const cell = value as Json;
      const at = `${where}.cells[${cellIndex}]`;
      expect(Object.keys(cell).sort(), `${at}: exactly the spec's cell properties`).toEqual([
        'level',
        'locked',
        'permissionSetId',
      ]);
      expect(cell.permissionSetId, `${at}.permissionSetId`).toEqual(expect.any(String));
      expect(LEVELS, `${at}.level is a FieldAccessLevel`).toContain(cell.level);
      expect(typeof cell.locked, `${at}.locked is a boolean`).toBe('boolean');
    });
  });

  return matrix as unknown as Matrix;
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
  return body;
}

const levelOf = (matrix: Matrix, field: string, set: string): Level | undefined =>
  matrix.rows
    .find((row) => row.fieldApiName === field)
    ?.cells.find((cell) => cell.permissionSetId === set)?.level;

const columnsOf = (matrix: Matrix): string[][] =>
  matrix.rows.map((row) => row.cells.map((cell) => cell.permissionSetId).sort());

// ---------------------------------------------------------------------------

describe('acceptance: T-0026 field-security matrix', () => {
  let app: INestApplication;
  let pool: Pool;

  const server = () => app.getHttpServer();

  const getMatrix = async (
    headers: Record<string, string>,
    query: Record<string, string> = {},
  ): Promise<Matrix> => {
    const response = await request(server()).get(MATRIX).query(query).set(headers);
    expect(response.status, `getFieldSecurityMatrix: ${JSON.stringify(response.body)}`).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    return expectMatrix(response.body);
  };

  const put = (headers: Record<string, string>, body: unknown) =>
    request(server())
      .put(MATRIX)
      .set(headers)
      .send(body as object);

  /** The A matrix's current version, read fresh — never reused across tests. */
  const versionOf = async (headers: Record<string, string>, object: string) =>
    (await getMatrix(headers, { object })).version;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    pool = createPool({ connectionString: inject('databaseUrl'), max: 3 });

    const catalogue = [
      {
        id: OBJ_A_VISIT,
        tenantId: TENANT_A,
        userId: USER_A_AGENT_1,
        api: 'site_visit',
        label: 'Site visit',
        fields: A_FIELDS,
      },
      {
        id: OBJ_B_INTEL,
        tenantId: TENANT_B,
        userId: USER_B_AGENT_1,
        api: 'competitor_intel',
        label: 'Competitor intel',
        fields: B_FIELDS,
      },
    ] as const;
    for (const object of catalogue) {
      await withTenantTransaction(
        pool,
        { tenantId: object.tenantId, userId: object.userId },
        async (tx) => {
          await tx.query(
            `INSERT INTO object_def (id, tenant_id, api_name, label, is_custom)
             VALUES ($1, $2, $3, $4, true)`,
            [object.id, object.tenantId, object.api, object.label],
          );
          for (const field of object.fields) {
            await tx.query(
              `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type)
               VALUES (gen_random_uuid(), $1, $2, $3, $3, 'text')`,
              [object.tenantId, object.id, field],
            );
          }
        },
      );
    }

    await withTenantTransaction(pool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, (tx) =>
      tx.query(
        `INSERT INTO permission_set (id, tenant_id, key, label, locked, sort_order)
         VALUES ($1, $2, $3, 'External auditor', false, 70)`,
        [PS_A_AUDITOR, TENANT_A, A_ONLY_SET],
      ),
    );

    app = await createApi(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await reseed(inject('migrationUrl'));
  });

  // --- getFieldSecurityMatrix ----------------------------------------------

  it('getFieldSecurityMatrix is field x permission set: one row per field, one cell per set, Admin locked at edit', async () => {
    const matrix = await getMatrix(A, { object: 'site_visit' });

    expect(matrix.objectApiName).toBe('site_visit');
    expect(matrix.rows.map((row) => row.fieldApiName).sort()).toEqual([...A_FIELDS].sort());
    if (matrix.totalFieldCount !== undefined) {
      expect(matrix.totalFieldCount).toBe(A_FIELDS.length);
    }

    // Two axes and only two: every row has exactly the tenant's permission
    // sets as columns, each once — including the one created inline, so the
    // columns come from permission_set, not from a hard-coded list.
    const expected = [...DEFAULT_SETS, A_ONLY_SET].sort();
    for (const columns of columnsOf(matrix)) {
      expect(columns).toEqual(expected);
    }

    // The padlock follows permission_set.locked; "Admins always have full access".
    for (const row of matrix.rows) {
      for (const cell of row.cells) {
        expect(cell.locked, `${row.fieldApiName}/${cell.permissionSetId} locked`).toBe(
          cell.permissionSetId === 'admin',
        );
      }
      expect(levelOf(matrix, row.fieldApiName, 'admin')).toBe('edit');
    }
  });

  it('getFieldSecurityMatrix filters by q and sensitiveOnly without changing totalFieldCount', async () => {
    const filtered = await getMatrix(A, { object: 'site_visit', q: 'visit' });
    expect(filtered.rows.map((row) => row.fieldApiName).sort()).toEqual([
      'visit_notes',
      'visited_on',
    ]);
    if (filtered.totalFieldCount !== undefined) {
      // "Before q and sensitiveOnly. The footer's '14 of 14 fields'."
      expect(filtered.totalFieldCount).toBe(A_FIELDS.length);
    }

    const sensitive = await getMatrix(A, { object: 'site_visit', sensitiveOnly: 'true' });
    for (const row of sensitive.rows) {
      expect(row.classification, `${row.fieldApiName} is not pii or sensitive`).not.toBe('none');
    }
  });

  it('getFieldSecurityMatrix rejects a missing object and any programmeId with 400, and an unknown object with 404', async () => {
    expectError(await request(server()).get(MATRIX).set(A), 400, 'validation_failed');
    expectError(
      await request(server())
        .get(MATRIX)
        .query({ object: 'x'.repeat(65) })
        .set(A),
      400,
      'validation_failed',
    );
    // D-P9: there is no programme axis. Supplying one is an attempt to supply
    // scope (CLAUDE.md 2.2) and is refused, not ignored.
    expectError(
      await request(server())
        .get(MATRIX)
        .query({ object: 'site_visit', programmeId: TENANT_A })
        .set(A),
      400,
      'validation_failed',
    );
    expectError(
      await request(server()).get(MATRIX).query({ object: 'no_such_object' }).set(A),
      404,
      'not_found',
    );
  });

  // --- updateFieldSecurityMatrix -------------------------------------------

  it('updateFieldSecurityMatrix round-trips: the 200 body and the next GET carry the new levels and a new version', async () => {
    const before = await getMatrix(A, { object: 'site_visit' });

    const response = await put(A, {
      objectApiName: 'site_visit',
      version: before.version,
      changes: [
        { fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' },
        { fieldApiName: 'visit_notes', permissionSetId: 'qa_analyst', level: 'none' },
        { fieldApiName: 'visited_on', permissionSetId: A_ONLY_SET, level: 'edit' },
      ],
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    const saved = expectMatrix(response.body);
    expect(saved.objectApiName).toBe('site_visit');
    expect(saved.version, 'the matrix version must move on a write').not.toBe(before.version);
    expect(levelOf(saved, 'priority', 'agent')).toBe('read');
    expect(levelOf(saved, 'visit_notes', 'qa_analyst')).toBe('none');
    expect(levelOf(saved, 'visited_on', A_ONLY_SET)).toBe('edit');

    const reread = await getMatrix(A, { object: 'site_visit' });
    expect(reread.version).toBe(saved.version);
    expect(levelOf(reread, 'priority', 'agent')).toBe('read');
    expect(levelOf(reread, 'visit_notes', 'qa_analyst')).toBe('none');
    expect(levelOf(reread, 'visited_on', A_ONLY_SET)).toBe('edit');
    // Cells nobody touched are unchanged.
    expect(levelOf(reread, 'priority', 'team_lead')).toBe(levelOf(before, 'priority', 'team_lead'));

    // And back again, so a level can be lowered as well as raised.
    const lowered = await put(A, {
      objectApiName: 'site_visit',
      version: reread.version,
      changes: [{ fieldApiName: 'priority', permissionSetId: 'agent', level: 'none' }],
    });
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
    expect(levelOf(expectMatrix(lowered.body), 'priority', 'agent')).toBe('none');
  });

  it('the matrix is stored once per tenant: users on different programmes read the same decision (D-P9)', async () => {
    const version = await versionOf(A, 'site_visit');
    await put(A, {
      objectApiName: 'site_visit',
      version,
      changes: [{ fieldApiName: 'visit_notes', permissionSetId: 'team_lead', level: 'read' }],
    }).expect(200);

    // USER_A_AGENT_1 is in programme A1 only, USER_A_AGENT_2 in A2 only.
    const one = await getMatrix(asUser(TENANT_A, USER_A_AGENT_1), { object: 'site_visit' });
    const two = await getMatrix(asUser(TENANT_A, USER_A_AGENT_2), { object: 'site_visit' });
    expect(levelOf(one, 'visit_notes', 'team_lead')).toBe('read');
    expect(two).toEqual(one);
  });

  it('updateFieldSecurityMatrix rejects a malformed body, and any programmeId, with 400', async () => {
    const version = await versionOf(A, 'site_visit');
    const change = { fieldApiName: 'priority', permissionSetId: 'agent', level: 'read' };

    // D-P9: no programmeId, at the top or on a change. additionalProperties
    // is false on both, and supplying scope is refused, not ignored.
    expectError(
      await put(A, {
        objectApiName: 'site_visit',
        version,
        programmeId: TENANT_A,
        changes: [change],
      }),
      400,
      'validation_failed',
    );
    expectError(
      await put(A, {
        objectApiName: 'site_visit',
        version,
        changes: [{ ...change, programmeId: TENANT_A }],
      }),
      400,
      'validation_failed',
    );
    // FieldSecurityWrite: required properties, minItems 1, the level enum.
    expectError(
      await put(A, { objectApiName: 'site_visit', changes: [change] }),
      400,
      'validation_failed',
    );
    expectError(
      await put(A, { objectApiName: 'site_visit', version, changes: [] }),
      400,
      'validation_failed',
    );
    expectError(
      await put(A, {
        objectApiName: 'site_visit',
        version,
        changes: [{ ...change, level: 'write' }],
      }),
      400,
      'validation_failed',
    );

    // None of those touched anything.
    expect(await versionOf(A, 'site_visit')).toBe(version);
  });

  it('a locked permission set cannot be changed: 403 not_permitted, and nothing in the request is applied', async () => {
    const before = await getMatrix(A, { object: 'site_visit' });
    const agentBefore = levelOf(before, 'visited_on', 'agent');
    const target: Level = agentBefore === 'read' ? 'edit' : 'read';

    const response = await put(A, {
      objectApiName: 'site_visit',
      version: before.version,
      changes: [
        // Valid on its own.
        { fieldApiName: 'visited_on', permissionSetId: 'agent', level: target },
        // The padlocked Admin column.
        { fieldApiName: 'visited_on', permissionSetId: 'admin', level: 'none' },
      ],
    });
    expectError(response, 403, 'not_permitted');

    const after = await getMatrix(A, { object: 'site_visit' });
    expect(levelOf(after, 'visited_on', 'admin')).toBe('edit');
    expect(
      levelOf(after, 'visited_on', 'agent'),
      'the valid change in a refused write was applied',
    ).toBe(agentBefore);
    expect(after.version).toBe(before.version);
  });

  it('a stale version is 409 stale_write and is not applied', async () => {
    const first = await getMatrix(A, { object: 'site_visit' });
    await put(A, {
      objectApiName: 'site_visit',
      version: first.version,
      changes: [{ fieldApiName: 'priority', permissionSetId: 'client_portal', level: 'none' }],
    }).expect(200);

    // A second desk still holding the first version.
    expectError(
      await put(A, {
        objectApiName: 'site_visit',
        version: first.version,
        changes: [{ fieldApiName: 'priority', permissionSetId: 'client_portal', level: 'edit' }],
      }),
      409,
      'stale_write',
    );
    expect(levelOf(await getMatrix(A, { object: 'site_visit' }), 'priority', 'client_portal')).toBe(
      'none',
    );
  });

  // --- tenant isolation ----------------------------------------------------

  it("tenant B never sees tenant A's object, fields or permission sets: 404 with the no-such-object body, absent from B's matrix", async () => {
    // Reading A's object from B is identical to reading an object that does
    // not exist. A 403, or any difference in the body, is an enumeration oracle.
    const crossTenant = await request(server()).get(MATRIX).query({ object: 'site_visit' }).set(B);
    const missing = await request(server()).get(MATRIX).query({ object: 'no_such_object' }).set(B);
    expectError(crossTenant, 404, 'not_found');
    expectError(missing, 404, 'not_found');
    expect(crossTenant.body).toEqual(missing.body);

    // B's own matrix: B's fields and B's columns, nothing of A's.
    const own = await getMatrix(B, { object: 'competitor_intel' });
    expect(own.rows.map((row) => row.fieldApiName).sort()).toEqual([...B_FIELDS].sort());
    for (const columns of columnsOf(own)) {
      expect(columns).toEqual([...DEFAULT_SETS].sort());
      expect(columns).not.toContain(A_ONLY_SET);
    }
    expect(JSON.stringify(own)).not.toMatch(/site_visit|visit_notes|visited_on|priority/);

    // And the other direction.
    expectError(
      await request(server()).get(MATRIX).query({ object: 'competitor_intel' }).set(A),
      404,
      'not_found',
    );
  });

  it("tenant B cannot edit tenant A's matrix, and its own writes never reach tenant A", async () => {
    const aBefore = await getMatrix(A, { object: 'site_visit' });
    const bVersion = await versionOf(B, 'competitor_intel');

    // A's object, from B: 404, the same as an object that does not exist.
    const crossObject = await put(B, {
      objectApiName: 'site_visit',
      version: aBefore.version,
      changes: [{ fieldApiName: 'priority', permissionSetId: 'agent', level: 'edit' }],
    });
    const noObject = await put(B, {
      objectApiName: 'no_such_object',
      version: aBefore.version,
      changes: [{ fieldApiName: 'priority', permissionSetId: 'agent', level: 'edit' }],
    });
    expectError(crossObject, 404, 'not_found');
    expectError(noObject, 404, 'not_found');
    expect(crossObject.body).toEqual(noObject.body);

    // B's own object, but a field or a permission set that only A has: 404,
    // and the valid change alongside is not applied.
    for (const foreign of [
      { fieldApiName: 'priority', permissionSetId: 'agent', level: 'edit' },
      { fieldApiName: 'rival_name', permissionSetId: A_ONLY_SET, level: 'edit' },
    ]) {
      expectError(
        await put(B, {
          objectApiName: 'competitor_intel',
          version: bVersion,
          changes: [
            { fieldApiName: 'threat_level', permissionSetId: 'agent', level: 'read' },
            foreign,
          ],
        }),
        404,
        'not_found',
      );
    }
    expect(await versionOf(B, 'competitor_intel')).toBe(bVersion);

    // A legitimate write in B leaves A's matrix exactly as it was.
    const bWrite = await put(B, {
      objectApiName: 'competitor_intel',
      version: bVersion,
      changes: [{ fieldApiName: 'rival_name', permissionSetId: 'agent', level: 'none' }],
    });
    expect(bWrite.status, JSON.stringify(bWrite.body)).toBe(200);
    expect(await getMatrix(A, { object: 'site_visit' })).toEqual(aBefore);
  });

  // --- authentication and scope headers ------------------------------------

  const EVERY_OPERATION = [
    [
      'getFieldSecurityMatrix',
      () => request(app.getHttpServer()).get(MATRIX).query({ object: 'site_visit' }),
    ],
    [
      'updateFieldSecurityMatrix',
      () =>
        request(app.getHttpServer())
          .put(MATRIX)
          .send({
            objectApiName: 'site_visit',
            version: 1,
            changes: [{ fieldApiName: 'priority', permissionSetId: 'agent', level: 'edit' }],
          }),
    ],
  ] as const;

  it('both operations are 401 not_authenticated without a session, and 400 with a scope header', async () => {
    for (const [operation, build] of EVERY_OPERATION) {
      const anonymous = await build();
      expect(anonymous.status, `${operation} without a session`).toBe(401);
      expectError(anonymous, 401, 'not_authenticated');
    }

    // Scope is resolved, never supplied (CLAUDE.md 2.2).
    const scopeHeaders: [string, string][] = [
      ['x-kasuwa-programme-ids', `{${TENANT_B}}`],
      ['x-kasuwa-programme-id', TENANT_B],
      ['x-kasuwa-scope', 'all'],
    ];
    for (const [operation, build] of EVERY_OPERATION) {
      for (const [header, value] of scopeHeaders) {
        const response = await build().set(A).set(header, value);
        expect(response.status, `${operation} with ${header}`).toBe(400);
      }
    }
  });

  // --- schema and contract -------------------------------------------------

  it('the table holding matrix decisions is tenant-scoped, RLS ENABLED and FORCED, WITH CHECK = USING, in TENANT_SCOPED_TABLES', async () => {
    // "Store each decision once": some table must reference both a field
    // definition and a permission set. Found by its foreign keys rather than
    // by name, because the name is the builder's choice.
    const found = await pool.query<{ table: string }>(
      `SELECT c.relname AS table
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_constraint k
                       WHERE k.conrelid = c.oid AND k.contype = 'f'
                         AND k.confrelid = 'public.field_def'::regclass)
          AND EXISTS (SELECT 1 FROM pg_constraint k
                       WHERE k.conrelid = c.oid AND k.contype = 'f'
                         AND k.confrelid = 'public.permission_set'::regclass)`,
    );
    const tables = found.rows.map((row) => row.table);
    expect(
      tables.length,
      'no table references both field_def and permission_set — where are matrix decisions stored?',
    ).toBeGreaterThan(0);

    const scoped: readonly string[] = TENANT_SCOPED_TABLES;
    const state = await readTableSecurity(pool);
    for (const table of tables) {
      expect(scoped, `${table} is missing from TENANT_SCOPED_TABLES`).toContain(table);
      const row = state.find((entry) => entry.table === table);
      expect(row, `${table}: not reported by readTableSecurity`).toBeDefined();
      expect(row?.rlsEnabled, `${table}: RLS is not enabled`).toBe(true);
      expect(row?.rlsForced, `${table}: RLS is not FORCED`).toBe(true);
      expect(row?.policyCount, `${table}: has no policy`).toBeGreaterThan(0);
    }

    const columns = await pool.query<{ table: string; nullable: string }>(
      `SELECT table_name AS table, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY ($1::text[]) AND column_name = 'tenant_id'`,
      [tables],
    );
    expect(columns.rows.map((row) => row.table).sort()).toEqual([...tables].sort());
    for (const row of columns.rows) {
      expect(row.nullable, `${row.table}.tenant_id must be NOT NULL`).toBe('NO');
    }

    const policies = await pool.query<{ table: string; matching: number }>(
      `SELECT c.relname AS table,
              count(*) FILTER (
                WHERE p.polwithcheck IS NOT NULL
                  AND pg_get_expr(p.polwithcheck, p.polrelid) = pg_get_expr(p.polqual, p.polrelid)
              )::int AS matching
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY ($1::text[])
        GROUP BY c.relname`,
      [tables],
    );
    const matching = new Map(policies.rows.map((row) => [row.table, row.matching]));
    for (const table of tables) {
      expect(
        matching.get(table) ?? 0,
        `${table}: no policy with WITH CHECK = USING`,
      ).toBeGreaterThan(0);
    }

    // D-P9: two axes. A programme column on the decision table is the third
    // axis the decision rejected.
    const programmeColumns = await pool.query<{ table: string }>(
      `SELECT table_name AS table
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY ($1::text[]) AND column_name = 'programme_id'`,
      [tables],
    );
    expect(programmeColumns.rows, 'the matrix must not carry programme_id (D-P9)').toEqual([]);
  });

  it('the spec marks both T-0026 operations x-kasuwa-implemented: true', () => {
    const spec = readFileSync(resolve(__dirname, '../../../docs/api/admin.openapi.yaml'), 'utf8');
    for (const operationId of ['getFieldSecurityMatrix', 'updateFieldSecurityMatrix']) {
      const match = new RegExp(
        `operationId:\\s*${operationId}\\s*\\n\\s*x-kasuwa-implemented:\\s*(\\S+)`,
      ).exec(spec);
      expect(match, `${operationId} not found in admin.openapi.yaml`).not.toBeNull();
      expect(match?.[1], `${operationId} is not marked implemented`).toBe('true');
    }
  });
});
