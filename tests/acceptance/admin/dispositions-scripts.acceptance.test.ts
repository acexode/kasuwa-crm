import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_PERMISSION_SETS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
} from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0027, admin API: dispositions and programme scripts.
 *
 * Source: docs/api/admin.openapi.yaml, operations `listDispositions`,
 * `createDisposition`, `reorderDispositions`, `updateDisposition`,
 * `deleteDisposition` and `listProgrammeScripts`, and the `Disposition`,
 * `DispositionList`, `DispositionWrite`, `DispositionPatch`,
 * `DispositionOrderRequest`, `ScriptList` and `Error` schemas. The shape checks
 * below are hand-transcribed from those schemas. If the spec and this file
 * disagree, the spec is right and this file is the defect: say so in your
 * report, do not edit it.
 *
 * Every operation here is programme-scoped through the `{programmeId}` path
 * segment, which is a RECORD IDENTIFIER and not scope (spec header, point 1).
 * Scope comes from `user_programme`, read by the session. An unassigned
 * sibling programme, a programme in another tenant and no programme at all
 * are one `404 not_found`, byte for byte (point 2) — and a write that 404s
 * changes nothing.
 *
 * Fixture shape relied on (packages/db/src/fixtures.ts, seed.ts):
 *   USER_A_AGENT_1    -> A1        USER_A_AGENT_2 -> A2
 *   USER_A_SUPERVISOR -> A1, A2    USER_B_AGENT_1 -> B1
 *
 * The seed is not assumed to contain any disposition or script. Every
 * disposition this suite reasons about is created through the API, with a
 * per-run code, and every test that writes reseeds in `finally`.
 *
 * Assumptions, stated so they can be argued with:
 *   - The new table is called `disposition` and carries `tenant_id` and
 *     `programme_id`, both NOT NULL.
 *   - A deleted disposition (soft delete at the data layer) is no longer in
 *     `listDispositions`: the list is "the order agents see", and agents can
 *     no longer choose it. A deactivated one (`active: false`) IS still listed.
 *   - A reorder list that names a disposition from another programme is the
 *     same failure as a subset: `400 validation_failed`, because the body is
 *     not "the complete ordered list for this programme".
 *
 * Deliberately NOT asserted: `usageCount90d` beyond integer-or-null (no
 * interactions table backs it), `403 not_permitted` (no permissions engine),
 * the audit rows `x-kasuwa-audited` demands (no audit table), where a newly
 * created disposition lands in the order, and whether a deleted code may be
 * reused.
 */

const PROGRAMMES = '/api/v1/admin/programmes';
const dispositionsOf = (programmeId: string) => `${PROGRAMMES}/${programmeId}/dispositions`;
const orderOf = (programmeId: string) => `${dispositionsOf(programmeId)}/order`;
const dispositionPath = (programmeId: string, dispositionId: string) =>
  `${dispositionsOf(programmeId)}/${dispositionId}`;
const scriptsOf = (programmeId: string) => `${PROGRAMMES}/${programmeId}/scripts`;

/** Never a real row: same shape as the seed ids, nothing seeds it. */
const NOWHERE = '11111111-0000-4000-8000-0000000c9999';
const NO_SUCH_DISPOSITION = '11111111-0000-4000-8000-0000000e9999';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = ['promise_to_pay', 'resolved', 'callback', 'escalated', 'not_reached'];
const SCRIPT_STATUSES = ['draft', 'in_review', 'published', 'rejected_by_provider'];
const CHANNELS = ['whatsapp', 'voice', 'sms', 'email', 'ussd'];

/** Unique per run; `^[A-Z0-9_]+$`, at most 16 characters. */
const RUN = Date.now().toString(36).toUpperCase().slice(-6);
let sequence = 0;
const uniqueCode = (prefix: string) => `${prefix}_${RUN}${(sequence += 1)}`.slice(0, 16);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;

interface Disposition {
  id: string;
  code: string;
  label: string;
  category: string;
  noteRequired: boolean;
  followUpRequired: boolean;
  active: boolean;
  position: number;
  usageCount90d?: number | null;
}

interface DispositionList {
  items: Disposition[];
  usageWindowDays: number;
}

// --- shape checks transcribed from docs/api/admin.openapi.yaml -------------

/** `#/components/schemas/Disposition`. */
function expectDisposition(value: unknown, where = 'Disposition'): Disposition {
  expect(value, `${where}: not an object`).toEqual(expect.any(Object));
  const item = value as Json;
  expect(item.id, `${where}.id`).toMatch(UUID);
  expect(item.code, `${where}.code`).toEqual(expect.any(String));
  expect((item.code as string).length, `${where}.code maxLength`).toBeLessThanOrEqual(16);
  expect(item.label, `${where}.label`).toEqual(expect.any(String));
  expect((item.label as string).length, `${where}.label maxLength`).toBeLessThanOrEqual(120);
  expect(CATEGORIES, `${where}.category`).toContain(item.category);
  expect(item.noteRequired, `${where}.noteRequired`).toBeTypeOf('boolean');
  expect(item.followUpRequired, `${where}.followUpRequired`).toBeTypeOf('boolean');
  expect(item.active, `${where}.active`).toBeTypeOf('boolean');
  expect(Number.isInteger(item.position), `${where}.position must be an integer`).toBe(true);
  expect(item.position as number, `${where}.position minimum`).toBeGreaterThanOrEqual(1);
  if (item.usageCount90d !== undefined && item.usageCount90d !== null) {
    expect(Number.isInteger(item.usageCount90d), `${where}.usageCount90d`).toBe(true);
  }
  // A scope field on a record is the spec being quietly widened.
  expect(item, `${where} must not carry tenantId`).not.toHaveProperty('tenantId');
  return item as unknown as Disposition;
}

/** `#/components/schemas/DispositionList`, in agent order. */
function expectDispositionList(value: unknown): DispositionList {
  const list = value as Json;
  expect(Array.isArray(list.items), 'DispositionList.items must be an array').toBe(true);
  expect(
    Number.isInteger(list.usageWindowDays),
    'DispositionList.usageWindowDays must be an integer',
  ).toBe(true);
  const items = (list.items as unknown[]).map((item, index) =>
    expectDisposition(item, `DispositionList.items[${index}]`),
  );
  // "Order is `position`, ascending, and it is the order agents see."
  const positions = items.map((item) => item.position);
  expect(positions, 'DispositionList must be in ascending position order').toEqual(
    [...positions].sort((left, right) => left - right),
  );
  expect(new Set(positions).size, 'DispositionList positions must be distinct').toBe(
    positions.length,
  );
  return list as unknown as DispositionList;
}

/** `#/components/schemas/ScriptList`. */
function expectScriptList(value: unknown): void {
  const list = value as Json;
  expect(Array.isArray(list.items), 'ScriptList.items must be an array').toBe(true);
  const page = list.page as Json | undefined;
  expect(page, 'ScriptList.page is required').toBeDefined();
  expect(page?.nextCursor === null || typeof page?.nextCursor === 'string').toBe(true);
  expect(page?.hasMore, 'Page.hasMore').toBeTypeOf('boolean');

  (list.items as Json[]).forEach((item, index) => {
    const where = `ScriptList.items[${index}]`;
    expect(item.id, `${where}.id`).toMatch(UUID);
    expect(item.name, `${where}.name`).toEqual(expect.any(String));
    expect(SCRIPT_STATUSES, `${where}.status`).toContain(item.status);
    expect(Number.isInteger(item.version), `${where}.version`).toBe(true);
    expect(item.updatedAt, `${where}.updatedAt`).toEqual(expect.any(String));
    // Every timestamp is UTC with a Z (spec info, "Times").
    expect(item.updatedAt as string, `${where}.updatedAt must be UTC`).toMatch(/Z$/u);
    if (item.channels !== undefined) {
      expect(Array.isArray(item.channels), `${where}.channels`).toBe(true);
      for (const channel of item.channels as unknown[]) {
        expect(CHANNELS, `${where}.channels[]`).toContain(channel);
      }
    }
    if (item.providerName !== undefined) {
      expect(item.providerName === null || typeof item.providerName === 'string').toBe(true);
    }
  });
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
  if (body.details !== undefined) {
    for (const detail of body.details as Json[]) {
      // Field paths and reason codes only — never the value, never a DB message.
      expect(Object.keys(detail).sort()).toEqual(['code', 'path']);
    }
  }
  return body;
}

const detailPaths = (body: Json) =>
  ((body.details as { path: string }[] | undefined) ?? []).map((detail) => detail.path);

// ---------------------------------------------------------------------------

describe('acceptance: admin dispositions and programme scripts (T-0027)', () => {
  let app: INestApplication;
  let appPool: Pool;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();
  const supervisor = () => asUser(TENANT_A, USER_A_SUPERVISOR);
  const agentOne = () => asUser(TENANT_A, USER_A_AGENT_1);
  const agentTwo = () => asUser(TENANT_A, USER_A_AGENT_2);
  const tenantB = () => asUser(TENANT_B, USER_B_AGENT_1);

  const listRaw = (headers: Headers, programmeId: string) =>
    request(server()).get(dispositionsOf(programmeId)).set(headers);
  const createRaw = (headers: Headers, programmeId: string, body: unknown) =>
    request(server())
      .post(dispositionsOf(programmeId))
      .set(headers)
      .send(body as object);
  const reorderRaw = (headers: Headers, programmeId: string, body: unknown) =>
    request(server())
      .put(orderOf(programmeId))
      .set(headers)
      .send(body as object);
  const updateRaw = (headers: Headers, programmeId: string, id: string, body: unknown) =>
    request(server())
      .patch(dispositionPath(programmeId, id))
      .set(headers)
      .send(body as object);
  const deleteRaw = (headers: Headers, programmeId: string, id: string) =>
    request(server()).delete(dispositionPath(programmeId, id)).set(headers);
  const scriptsRaw = (headers: Headers, programmeId: string, query = '') =>
    request(server())
      .get(`${scriptsOf(programmeId)}${query}`)
      .set(headers);

  async function list(programmeId: string, headers: Headers = supervisor()) {
    const response = await listRaw(headers, programmeId);
    expect(response.status, `listDispositions: ${JSON.stringify(response.body)}`).toBe(200);
    return expectDispositionList(response.body);
  }

  async function create(
    programmeId: string,
    overrides: Partial<{
      code: string;
      label: string;
      category: string;
      noteRequired: boolean;
      followUpRequired: boolean;
    }> = {},
    headers: Headers = supervisor(),
  ): Promise<Disposition> {
    const body = {
      code: uniqueCode('D'),
      label: 'Promise to pay',
      category: 'promise_to_pay',
      ...overrides,
    };
    const response = await createRaw(headers, programmeId, body);
    expect(response.status, `createDisposition: ${JSON.stringify(response.body)}`).toBe(201);
    return expectDisposition(response.body, 'createDisposition response');
  }

  /** The A1 list a 404'd write must leave untouched, as comparable data. */
  async function snapshot(programmeId: string) {
    const current = await list(programmeId);
    // usageCount90d is an aggregate over interactions and may move on its own.
    return current.items.map((item) => ({
      id: item.id,
      code: item.code,
      label: item.label,
      category: item.category,
      noteRequired: item.noteRequired,
      followUpRequired: item.followUpRequired,
      active: item.active,
      position: item.position,
    }));
  }

  // --- listDispositions ------------------------------------------------------

  it('listDispositions returns the DispositionList shape for each reachable programme', async () => {
    for (const programmeId of [PROGRAMME_A1, PROGRAMME_A2]) {
      await list(programmeId, supervisor());
    }
    await list(PROGRAMME_A1, agentOne());
    await list(PROGRAMME_A2, agentTwo());
    await list(PROGRAMME_B1, tenantB());
  });

  it('listDispositions answers an unassigned sibling, a foreign programme and no programme with one identical 404', async () => {
    const sibling = await listRaw(agentOne(), PROGRAMME_A2);
    expectError(sibling, 404, 'not_found');
    const foreign = await listRaw(tenantB(), PROGRAMME_A1);
    expect(foreign.status).toBe(404);
    const crossTenant = await listRaw(agentOne(), PROGRAMME_B1);
    expect(crossTenant.status).toBe(404);
    const nothing = await listRaw(agentOne(), NOWHERE);
    expect(nothing.status).toBe(404);

    // Same body, byte for byte: a difference is an existence oracle.
    expect(foreign.body).toEqual(sibling.body);
    expect(crossTenant.body).toEqual(sibling.body);
    expect(nothing.body).toEqual(sibling.body);
  });

  // --- createDisposition -----------------------------------------------------

  it('createDisposition returns 201 Disposition, applies defaults, and lists it in its programme only', async () => {
    try {
      const code = uniqueCode('PTP');
      const created = await create(PROGRAMME_A1, {
        code,
        label: 'Promise to pay',
        category: 'promise_to_pay',
      });

      expect(created).toMatchObject({
        code,
        label: 'Promise to pay',
        category: 'promise_to_pay',
        // DispositionWrite defaults.
        noteRequired: false,
        followUpRequired: false,
        active: true,
      });

      const explicit = await create(PROGRAMME_A1, {
        label: 'Call back later',
        category: 'callback',
        noteRequired: true,
        followUpRequired: true,
      });
      expect(explicit).toMatchObject({ noteRequired: true, followUpRequired: true });

      const a1 = await list(PROGRAMME_A1);
      const a1Ids = a1.items.map((item) => item.id);
      expect(a1Ids).toContain(created.id);
      expect(a1Ids).toContain(explicit.id);
      expect(a1.items.find((item) => item.id === created.id)).toMatchObject({
        code,
        position: created.position,
      });

      // Agent 1 sees it in A1; nobody sees it through A2 or tenant B.
      const viaAgent = await list(PROGRAMME_A1, agentOne());
      expect(viaAgent.items.map((item) => item.id)).toContain(created.id);
      const a2 = await list(PROGRAMME_A2);
      expect(a2.items.map((item) => item.id)).not.toContain(created.id);
      const b1 = await list(PROGRAMME_B1, tenantB());
      expect(b1.items.map((item) => item.id)).not.toContain(created.id);
      expect(JSON.stringify(b1)).not.toContain(code);
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  it('createDisposition rejects a body the spec does not accept with validation_failed, naming the path, creating nothing', async () => {
    const before = await snapshot(PROGRAMME_A1);
    const valid = { code: uniqueCode('V'), label: 'Valid', category: 'resolved' };

    const cases: { body: unknown; path: string }[] = [
      { body: { label: 'No code', category: 'resolved' }, path: 'code' },
      { body: { ...valid, code: 'lower_case' }, path: 'code' },
      { body: { ...valid, code: 'HAS SPACE' }, path: 'code' },
      { body: { ...valid, code: 'A'.repeat(17) }, path: 'code' },
      { body: { ...valid, code: '' }, path: 'code' },
      { body: { ...valid, label: '' }, path: 'label' },
      { body: { ...valid, label: 'ZZ-MARKER-'.padEnd(121, 'x') }, path: 'label' },
      { body: { code: valid.code, label: 'No category' }, path: 'category' },
      { body: { ...valid, category: 'sold' }, path: 'category' },
      { body: { ...valid, noteRequired: 'yes' }, path: 'noteRequired' },
      // additionalProperties: false — and these are scope or server-owned fields.
      { body: { ...valid, programmeId: PROGRAMME_A2 }, path: 'programmeId' },
      { body: { ...valid, position: 1 }, path: 'position' },
    ];

    for (const { body, path } of cases) {
      const response = await createRaw(supervisor(), PROGRAMME_A1, body);
      const error = expectError(response, 400, 'validation_failed');
      expect(detailPaths(error), `details for ${JSON.stringify(body)}`).toContain(path);
      expect(JSON.stringify(response.body)).not.toContain('ZZ-MARKER');
    }

    expect(await snapshot(PROGRAMME_A1)).toEqual(before);
  });

  it('createDisposition treats code as unique per programme: 409 duplicate_code there, allowed in another programme and tenant', async () => {
    try {
      const code = uniqueCode('DUP');
      const original = await create(PROGRAMME_A1, { code, label: 'Original' });
      const before = await snapshot(PROGRAMME_A1);

      const clash = await createRaw(supervisor(), PROGRAMME_A1, {
        code,
        label: 'Second with same code',
        category: 'resolved',
      });
      const error = expectError(clash, 409, 'duplicate_code');
      expect(detailPaths(error)).toContain('code');
      // The field and nothing else — never the conflicting row.
      expect(JSON.stringify(error)).not.toContain(original.id);
      expect(JSON.stringify(error)).not.toContain('Original');
      expect(await snapshot(PROGRAMME_A1)).toEqual(before);

      // The same code in a sibling programme and in another tenant is fine.
      const inA2 = await create(PROGRAMME_A2, { code });
      expect(inA2.code).toBe(code);
      const inB1 = await create(PROGRAMME_B1, { code }, tenantB());
      expect(inB1.code).toBe(code);

      // Labels are not unique (the spec defines no such rule).
      await create(PROGRAMME_A1, { label: 'Original' });
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  it('createDisposition is the same 404 for an unassigned, foreign or missing programme, and creates nothing', async () => {
    try {
      const a2Before = await snapshot(PROGRAMME_A2);
      const code = uniqueCode('HJ');
      const body = { code, label: 'Hijack', category: 'resolved' };

      const sibling = await createRaw(agentOne(), PROGRAMME_A2, body);
      expectError(sibling, 404, 'not_found');
      const foreign = await createRaw(tenantB(), PROGRAMME_A2, body);
      const nothing = await createRaw(agentOne(), NOWHERE, body);
      expect(foreign.status).toBe(404);
      expect(nothing.status).toBe(404);
      expect(foreign.body).toEqual(sibling.body);
      expect(nothing.body).toEqual(sibling.body);

      expect(await snapshot(PROGRAMME_A2)).toEqual(a2Before);
      const b1 = await list(PROGRAMME_B1, tenantB());
      expect(JSON.stringify(b1)).not.toContain(code);
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  // --- updateDisposition -----------------------------------------------------

  it('updateDisposition edits fields, deactivates and reactivates, and the list reflects it', async () => {
    try {
      const target = await create(PROGRAMME_A1, { label: 'Before', category: 'callback' });

      const edited = await updateRaw(supervisor(), PROGRAMME_A1, target.id, {
        label: 'After',
        category: 'escalated',
        noteRequired: true,
        followUpRequired: true,
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(expectDisposition(edited.body)).toMatchObject({
        id: target.id,
        code: target.code,
        label: 'After',
        category: 'escalated',
        noteRequired: true,
        followUpRequired: true,
        active: true,
      });

      // "Deactivate instead": still listed, flagged inactive, recoverable.
      const deactivated = await updateRaw(supervisor(), PROGRAMME_A1, target.id, {
        active: false,
      });
      expect(deactivated.status).toBe(200);
      expect(deactivated.body).toMatchObject({ id: target.id, active: false, label: 'After' });
      const listed = (await list(PROGRAMME_A1)).items.find((item) => item.id === target.id);
      expect(listed, 'a deactivated disposition stays in the list').toBeDefined();
      expect(listed).toMatchObject({ active: false, label: 'After', category: 'escalated' });

      const reactivated = await updateRaw(supervisor(), PROGRAMME_A1, target.id, {
        active: true,
      });
      expect(reactivated.status).toBe(200);
      expect(reactivated.body).toMatchObject({ active: true });

      // DispositionPatch has no `code`, no `position`, no scope.
      for (const [body, path] of [
        [{ code: 'RENAMED' }, 'code'],
        [{ position: 1 }, 'position'],
        [{ programmeId: PROGRAMME_A2 }, 'programmeId'],
        [{ label: '' }, 'label'],
        [{ category: 'sold' }, 'category'],
      ] as const) {
        const rejected = await updateRaw(supervisor(), PROGRAMME_A1, target.id, body);
        const error = expectError(rejected, 400, 'validation_failed');
        expect(detailPaths(error), `details for ${JSON.stringify(body)}`).toContain(path);
      }
      const unchanged = (await list(PROGRAMME_A1)).items.find((item) => item.id === target.id);
      expect(unchanged).toMatchObject({ code: target.code, label: 'After', active: true });
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  it('updateDisposition is one 404 for a sibling, foreign, mismatched or missing record, and changes nothing', async () => {
    try {
      const inA2 = await create(PROGRAMME_A2, { label: 'A2 only' });
      const inA1 = await create(PROGRAMME_A1, { label: 'A1 only' });
      const a1Before = await snapshot(PROGRAMME_A1);
      const a2Before = await snapshot(PROGRAMME_A2);
      const hijack = { label: 'Hijacked', active: false };

      // Agent 1 is not in A2.
      const sibling = await updateRaw(agentOne(), PROGRAMME_A2, inA2.id, hijack);
      expectError(sibling, 404, 'not_found');
      // Tenant B reaching into tenant A.
      const foreign = await updateRaw(tenantB(), PROGRAMME_A1, inA1.id, hijack);
      // A reachable programme in the path, another programme's record in the id.
      const smuggled = await updateRaw(agentOne(), PROGRAMME_A1, inA2.id, hijack);
      const smuggledBySupervisor = await updateRaw(supervisor(), PROGRAMME_A1, inA2.id, hijack);
      // Nothing at all.
      const missing = await updateRaw(agentOne(), PROGRAMME_A1, NO_SUCH_DISPOSITION, hijack);
      const noProgramme = await updateRaw(agentOne(), NOWHERE, inA1.id, hijack);

      for (const [name, response] of Object.entries({
        foreign,
        smuggled,
        smuggledBySupervisor,
        missing,
        noProgramme,
      })) {
        expect(response.status, name).toBe(404);
        expect(response.body, name).toEqual(sibling.body);
      }

      expect(await snapshot(PROGRAMME_A1)).toEqual(a1Before);
      expect(await snapshot(PROGRAMME_A2)).toEqual(a2Before);
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  // --- reorderDispositions ---------------------------------------------------

  it('reorderDispositions applies the complete ordered list and returns it as a DispositionList', async () => {
    try {
      await create(PROGRAMME_A1, { label: 'First' });
      await create(PROGRAMME_A1, { label: 'Second' });
      await create(PROGRAMME_A1, { label: 'Third' });

      const current = await list(PROGRAMME_A1);
      const reversed = current.items.map((item) => item.id).reverse();
      expect(reversed.length).toBeGreaterThanOrEqual(3);

      const response = await reorderRaw(supervisor(), PROGRAMME_A1, {
        dispositionIds: reversed,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const returned = expectDispositionList(response.body);
      expect(returned.items.map((item) => item.id)).toEqual(reversed);

      const reread = await list(PROGRAMME_A1);
      expect(reread.items.map((item) => item.id)).toEqual(reversed);
      // Agents see the same order.
      const viaAgent = await list(PROGRAMME_A1, agentOne());
      expect(viaAgent.items.map((item) => item.id)).toEqual(reversed);

      // Reordering one programme leaves another alone.
      const a2Ids = (await list(PROGRAMME_A2)).items.map((item) => item.id);
      for (const id of reversed) {
        expect(a2Ids).not.toContain(id);
      }
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  it('reorderDispositions rejects a subset, a foreign id, a duplicate or a missing body with 400, and changes nothing', async () => {
    try {
      await create(PROGRAMME_A1, { label: 'One' });
      await create(PROGRAMME_A1, { label: 'Two' });
      await create(PROGRAMME_A1, { label: 'Three' });
      const foreignDisposition = await create(PROGRAMME_A2, { label: 'Elsewhere' });

      const before = await snapshot(PROGRAMME_A1);
      const ids = before.map((item) => item.id);
      const reversed = [...ids].reverse();

      const cases: { name: string; body: unknown }[] = [
        { name: 'a subset', body: { dispositionIds: reversed.slice(1) } },
        { name: 'empty', body: { dispositionIds: [] } },
        {
          name: 'the complete list plus a disposition from another programme',
          body: { dispositionIds: [...reversed, foreignDisposition.id] },
        },
        {
          name: 'a subset padded with a disposition from another programme',
          body: { dispositionIds: [...reversed.slice(1), foreignDisposition.id] },
        },
        {
          name: 'a duplicate standing in for an omitted id',
          body: { dispositionIds: [reversed[0], ...reversed.slice(0, -1)] },
        },
        { name: 'an unknown id', body: { dispositionIds: [...reversed, NO_SUCH_DISPOSITION] } },
        { name: 'not uuids', body: { dispositionIds: ['one', 'two'] } },
        { name: 'no dispositionIds', body: {} },
        {
          name: 'a scope argument',
          body: { dispositionIds: reversed, programmeId: PROGRAMME_A2 },
        },
      ];

      for (const { name, body } of cases) {
        const response = await reorderRaw(supervisor(), PROGRAMME_A1, body);
        expect(response.status, `${name}: ${JSON.stringify(response.body)}`).toBe(400);
        expectError(response, 400, 'validation_failed');
        // Never echoes a row from the other programme.
        expect(JSON.stringify(response.body), name).not.toContain('Elsewhere');
      }

      expect(await snapshot(PROGRAMME_A1)).toEqual(before);
      const a2 = await list(PROGRAMME_A2);
      expect(a2.items.find((item) => item.id === foreignDisposition.id)).toMatchObject({
        label: 'Elsewhere',
      });
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  it('reorderDispositions is the same 404 for an unassigned, foreign or missing programme, and changes nothing', async () => {
    try {
      await create(PROGRAMME_A2, { label: 'A' });
      await create(PROGRAMME_A2, { label: 'B' });
      const before = await snapshot(PROGRAMME_A2);
      const reversed = before.map((item) => item.id).reverse();
      const body = { dispositionIds: reversed };

      const sibling = await reorderRaw(agentOne(), PROGRAMME_A2, body);
      expectError(sibling, 404, 'not_found');
      const foreign = await reorderRaw(tenantB(), PROGRAMME_A2, body);
      const nothing = await reorderRaw(agentOne(), NOWHERE, body);
      expect(foreign.status).toBe(404);
      expect(nothing.status).toBe(404);
      expect(foreign.body).toEqual(sibling.body);
      expect(nothing.body).toEqual(sibling.body);

      expect(await snapshot(PROGRAMME_A2)).toEqual(before);
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  // --- deleteDisposition -----------------------------------------------------

  it('deleteDisposition is 204, removes it from the list, and is idempotent', async () => {
    try {
      const keep = await create(PROGRAMME_A1, { label: 'Keep' });
      const doomed = await create(PROGRAMME_A1, { label: 'Doomed' });

      const first = await deleteRaw(supervisor(), PROGRAMME_A1, doomed.id);
      expect(first.status, JSON.stringify(first.body)).toBe(204);
      expect(first.text ?? '').toBe('');

      const after = await list(PROGRAMME_A1);
      const ids = after.items.map((item) => item.id);
      expect(ids, 'a deleted disposition is no longer offered').not.toContain(doomed.id);
      expect(ids).toContain(keep.id);
      const viaAgent = await list(PROGRAMME_A1, agentOne());
      expect(viaAgent.items.map((item) => item.id)).not.toContain(doomed.id);

      // "Idempotent: deleting an already-deleted disposition is 204."
      const again = await deleteRaw(supervisor(), PROGRAMME_A1, doomed.id);
      expect(again.status).toBe(204);

      // Gone from the agent's choices, but it cannot be edited back to life
      // through the list either: the surviving list is unchanged by a re-delete.
      const reread = await list(PROGRAMME_A1);
      expect(reread.items.map((item) => item.id)).toEqual(ids);
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  it('deleteDisposition is one 404 for a sibling, foreign, mismatched or missing record, and deletes nothing', async () => {
    try {
      const inA2 = await create(PROGRAMME_A2, { label: 'A2 survivor' });
      const inA1 = await create(PROGRAMME_A1, { label: 'A1 survivor' });
      const a1Before = await snapshot(PROGRAMME_A1);
      const a2Before = await snapshot(PROGRAMME_A2);

      const sibling = await deleteRaw(agentOne(), PROGRAMME_A2, inA2.id);
      expectError(sibling, 404, 'not_found');
      const responses = {
        foreign: await deleteRaw(tenantB(), PROGRAMME_A1, inA1.id),
        smuggled: await deleteRaw(agentOne(), PROGRAMME_A1, inA2.id),
        smuggledBySupervisor: await deleteRaw(supervisor(), PROGRAMME_A1, inA2.id),
        missing: await deleteRaw(agentOne(), PROGRAMME_A1, NO_SUCH_DISPOSITION),
        noProgramme: await deleteRaw(agentOne(), NOWHERE, inA1.id),
      };
      for (const [name, response] of Object.entries(responses)) {
        expect(response.status, name).toBe(404);
        expect(response.body, name).toEqual(sibling.body);
      }

      expect(await snapshot(PROGRAMME_A1)).toEqual(a1Before);
      expect(await snapshot(PROGRAMME_A2)).toEqual(a2Before);
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  // --- listProgrammeScripts --------------------------------------------------

  it('listProgrammeScripts returns the ScriptList shape for each reachable programme, and validates pageSize', async () => {
    for (const programmeId of [PROGRAMME_A1, PROGRAMME_A2]) {
      const response = await scriptsRaw(supervisor(), programmeId);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expectScriptList(response.body);
    }
    // T-0113 (D-L93, lead edit): once backed by the script tables, the list
    // needs script.write in the programme. Agent 1 reaches A1 without it, so
    // it gets the unreachable programme's 404, body for body.
    const agent = await scriptsRaw(agentOne(), PROGRAMME_A1);
    expectError(agent, 404, 'not_found');
    const unreachable = await scriptsRaw(agentOne(), PROGRAMME_A2);
    expect(agent.body).toEqual(unreachable.body);
    const b = await scriptsRaw(tenantB(), PROGRAMME_B1);
    expect(b.status).toBe(200);
    expectScriptList(b.body);

    for (const pageSize of ['0', '201', 'ten']) {
      const response = await scriptsRaw(supervisor(), PROGRAMME_A1, `?pageSize=${pageSize}`);
      const error = expectError(response, 400, 'validation_failed');
      expect(detailPaths(error)).toContain('pageSize');
    }
  });

  it('listProgrammeScripts answers 200 to a script.write holder: the admin set in the programme, no tenant-admin flag (T-0113)', async () => {
    // Lead edit with T-0113. Agent 1 is given the `admin` set in A1 and keeps
    // is_tenant_admin false, so the set alone is what grants script.write.
    const migrator = createPool({ connectionString: inject('migrationUrl'), max: 1 });
    try {
      const adminSet = SEED_PERMISSION_SETS.find(
        (set) => set.tenantId === TENANT_A && set.key === 'admin',
      );
      if (adminSet === undefined) throw new Error('Fixture drift: no seeded admin set in tenant A');
      await migrator.query(
        `UPDATE user_programme SET permission_set_id = $3 WHERE user_id = $1 AND programme_id = $2`,
        [USER_A_AGENT_1, PROGRAMME_A1, adminSet.id],
      );
      const flag = await migrator.query<{ is_tenant_admin: boolean }>(
        'SELECT is_tenant_admin FROM "user" WHERE id = $1',
        [USER_A_AGENT_1],
      );
      expect(flag.rows[0]?.is_tenant_admin, 'agent 1 must not hold the flag').toBe(false);
      const response = await scriptsRaw(agentOne(), PROGRAMME_A1);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expectScriptList(response.body);
      // Still scoped: the set in A1 grants nothing in A2.
      expectError(await scriptsRaw(agentOne(), PROGRAMME_A2), 404, 'not_found');
    } finally {
      await migrator.end();
      await reseed(inject('migrationUrl'));
    }
  });

  it('listProgrammeScripts is the same 404 for an unassigned, foreign or missing programme', async () => {
    const sibling = await scriptsRaw(agentOne(), PROGRAMME_A2);
    expectError(sibling, 404, 'not_found');
    const foreign = await scriptsRaw(tenantB(), PROGRAMME_A1);
    const crossTenant = await scriptsRaw(agentTwo(), PROGRAMME_B1);
    const nothing = await scriptsRaw(agentOne(), NOWHERE);
    for (const [name, response] of Object.entries({ foreign, crossTenant, nothing })) {
      expect(response.status, name).toBe(404);
      expect(response.body, name).toEqual(sibling.body);
    }
  });

  // --- authentication and scope transport, across all six operations --------

  const EVERY_OPERATION: [string, () => request.Test][] = [
    ['listDispositions', () => request(server()).get(dispositionsOf(PROGRAMME_A1))],
    [
      'createDisposition',
      () =>
        request(server())
          .post(dispositionsOf(PROGRAMME_A1))
          .send({ code: 'ANON', label: 'Anonymous', category: 'resolved' }),
    ],
    [
      'reorderDispositions',
      () =>
        request(server())
          .put(orderOf(PROGRAMME_A1))
          .send({ dispositionIds: [NO_SUCH_DISPOSITION] }),
    ],
    [
      'updateDisposition',
      () =>
        request(server())
          .patch(dispositionPath(PROGRAMME_A1, NO_SUCH_DISPOSITION))
          .send({ active: false }),
    ],
    [
      'deleteDisposition',
      () => request(server()).delete(dispositionPath(PROGRAMME_A1, NO_SUCH_DISPOSITION)),
    ],
    ['listProgrammeScripts', () => request(server()).get(scriptsOf(PROGRAMME_A1))],
  ];

  it('every operation is 401 not_authenticated without a usable session', async () => {
    for (const [operation, build] of EVERY_OPERATION) {
      const none = await build();
      expect(none.status, `${operation} with no credentials`).toBe(401);
      expectError(none, 401, 'not_authenticated');

      const bogus = await build().set('authorization', 'Bearer ksw_s1_not-a-real-session');
      expect(bogus.status, `${operation} with a forged bearer token`).toBe(401);
      expectError(bogus, 401, 'not_authenticated');

      // A real user paired with the wrong tenant is not a user at all.
      const crossed = await build().set(asUser(TENANT_B, USER_A_SUPERVISOR));
      expect(crossed.status, `${operation} as a user under the wrong tenant`).toBe(401);
    }
  });

  it('every operation rejects a request that tries to supply its own programme scope', async () => {
    try {
      for (const [operation, build] of EVERY_OPERATION) {
        for (const header of [
          'x-kasuwa-programme-ids',
          'x-kasuwa-programme-id',
          'x-kasuwa-scope',
        ]) {
          const response = await build().set(agentOne()).set(header, PROGRAMME_A2);
          expect(response.status, `${operation} with ${header}`).toBe(400);
        }
      }
      // The rejected create did not land.
      const a1 = await list(PROGRAMME_A1);
      expect(a1.items.map((item) => item.code)).not.toContain('ANON');
    } finally {
      await reseed(inject('migrationUrl'));
    }
  });

  // --- schema and contract ---------------------------------------------------

  it('disposition is tenant- and programme-scoped, RLS enabled and FORCED, with WITH CHECK = USING', async () => {
    const scoped: readonly string[] = TENANT_SCOPED_TABLES;
    expect(scoped, 'disposition is missing from TENANT_SCOPED_TABLES').toContain('disposition');

    const state = await readTableSecurity(appPool);
    const row = state.find((entry) => entry.table === 'disposition');
    expect(row, 'table disposition does not exist').toBeDefined();
    expect(row?.rlsEnabled, 'disposition: RLS is not enabled').toBe(true);
    expect(row?.rlsForced, 'disposition: RLS is not FORCED').toBe(true);
    expect(row?.policyCount, 'disposition: has no policy').toBeGreaterThan(0);

    const columns = await appPool.query<{ column: string; nullable: string }>(
      `SELECT column_name AS column, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'disposition'
          AND column_name IN ('tenant_id', 'programme_id')
        ORDER BY column_name`,
    );
    expect(columns.rows.map((column) => column.column)).toEqual(['programme_id', 'tenant_id']);
    for (const column of columns.rows) {
      expect(column.nullable, `disposition.${column.column} must be NOT NULL`).toBe('NO');
    }

    // CLAUDE.md 2.4: a policy whose WITH CHECK is identical to its USING — and,
    // since this is programme data, one that filters on the programme as well
    // as the tenant (the `contact` pattern).
    const policies = await appPool.query<{ using: string | null; check: string | null }>(
      `SELECT pg_get_expr(p.polqual, p.polrelid)      AS using,
              pg_get_expr(p.polwithcheck, p.polrelid) AS check
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'disposition'`,
    );
    const matching = policies.rows.filter(
      (policy) => policy.check !== null && policy.check === policy.using,
    );
    expect(matching.length, 'disposition: no policy with WITH CHECK = USING').toBeGreaterThan(0);
    expect(
      matching.some(
        (policy) =>
          (policy.using ?? '').includes('tenant_id') &&
          (policy.using ?? '').includes('programme_id'),
      ),
      'disposition: no policy filters on both tenant_id and programme_id',
    ).toBe(true);
  });

  it('the spec marks every T-0027 operation x-kasuwa-implemented: true', () => {
    const spec = readFileSync(resolve(__dirname, '../../../docs/api/admin.openapi.yaml'), 'utf8');
    for (const operationId of [
      'listDispositions',
      'createDisposition',
      'reorderDispositions',
      'updateDisposition',
      'deleteDisposition',
      'listProgrammeScripts',
    ]) {
      const match = new RegExp(
        `operationId:\\s*${operationId}\\s*\\n\\s*x-kasuwa-implemented:\\s*(\\S+)`,
      ).exec(spec);
      expect(match, `${operationId} not found in admin.openapi.yaml`).not.toBeNull();
      expect(match?.[1], `${operationId} is not marked implemented`).toBe('true');
    }
  });
});
