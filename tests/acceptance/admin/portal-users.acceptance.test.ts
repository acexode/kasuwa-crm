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
  PROGRAMME_B1,
  PROGRAMME_B2,
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
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0030, admin API: client-portal users (Agent 5).
 *
 * The contract is `docs/api/admin.openapi.yaml`, operations `listPortalUsers`
 * and `invitePortalUser`, with the `PortalUser`, `PortalUserList`,
 * `InvitePortalUserRequest` and `Error` schemas. The shape checks below are
 * hand-transcribed from the spec (the acceptance package has no OpenAPI
 * validator). If the spec and this file disagree, the spec is right and this
 * file is the defect: say so in the report, do not edit it.
 *
 * WHAT THIS SUITE IS REALLY ABOUT
 *
 * A portal user is an OUTSIDER — a BPO client's staff member — granted sight
 * of exactly one programme. So the properties that matter are:
 *
 *   1. an invitation lands in one programme and is invisible from every other
 *      programme and tenant, and a programme the caller cannot reach is the
 *      same `404 not_found` as one that does not exist (CLAUDE.md 6.4);
 *   2. inviting an address never reveals whether that address is already
 *      known somewhere else — another programme, another tenant;
 *   3. the invite token is a credential: stored hashed, never in plaintext,
 *      and neither it nor the invited address reaches a log, a span or stdout
 *      (CLAUDE.md 6.1).
 *
 * ------------------------------------------------------------------------
 * SEAMS THE BUILDER MUST PROVIDE. Internals are yours; these are not.
 *
 *   S1. `AppModuleOptions.channelProvider?: ChannelProvider` (apps/api,
 *       re-exported type from `@kasuwa/channel-adapter`). When given, the API
 *       sends invitations through `createChannelAdapter({ provider:
 *       channelProvider, ... })` — the compliance wrapper, never the provider
 *       directly. When omitted it defaults to a `FakeChannelProvider`, exactly
 *       as `keyProvider` defaults to the development provider. This suite
 *       passes its own `FakeChannelProvider` and reads `fake.sent`.
 *
 *   S2. An `email` channel in `@kasuwa/channel-adapter`. Today `ChannelKind`
 *       is `sms | whatsapp` and `to` must be E.164, so the adapter would
 *       refuse an email send. The invitation reaches the provider as one
 *       `SendRequest` with `channel: 'email'`, `to` equal to the invited
 *       address exactly as submitted, `purpose: 'transactional'`, and `scope`
 *       equal to the session's tenant and the invited programme. Keep
 *       `sms | whatsapp` requiring E.164 (a discriminated union): the T-0017
 *       suite asserts it and must stay green. This is an adapter-contract
 *       change; it is the lead's call and is made by this file.
 *
 *   S3. The invitation body carries the token as a query parameter named
 *       `token` (an acceptance link, `...?token=<value>`), URL-safe, at least
 *       32 characters. There is no accept endpoint yet (M18), so this is how
 *       the suite learns the plaintext token in order to prove it is stored
 *       nowhere and logged nowhere.
 *
 *   S4. The send has reached the provider by the time the `202` is returned,
 *       or within a few seconds of it (the suite polls for up to 5s). There is
 *       no outbox yet (CLAUDE.md 2.6); do not invent one.
 *
 *   S5. Every table the migration (`0013`) creates is named `portal_*`. The
 *       suite finds them by that prefix and holds each to CLAUDE.md 2.4.
 *
 * ------------------------------------------------------------------------
 * Callers. There is no permissions engine yet and no "tenant admin" in the
 * seed, so tenant A is driven as USER_A_SUPERVISOR (A1, A2), the sibling-scope
 * caller is USER_A_AGENT_1 (A1 only) and tenant B is USER_B_AGENT_1 (B1 only).
 * `403 not_permitted` is not exercised; who may invite is the permissions
 * engine's question. If T-0030 introduces an admin check, these callers must
 * pass it — raise it rather than widening anything.
 *
 * NOT asserted, because nothing defines it yet: single-use (there is no accept
 * endpoint), token expiry, the audit row (`x-kasuwa-audited`; D-L38 — there is
 * no audit table), and whether a re-invite rotates the token.
 *
 * Writes. Every invitation uses an address unique to this run, and the suite
 * reseeds afterwards (`TRUNCATE tenant CASCADE` clears anything keyed to a
 * tenant).
 */

const ADMIN = '/api/v1/admin/programmes';
const listPath = (programmeId: string) => `${ADMIN}/${programmeId}/portal-users`;
const invitePath = (programmeId: string) => `${ADMIN}/${programmeId}/portal-users/invitations`;

/** Never a real row: same shape as the seed ids, nothing seeds it. */
const NOWHERE = '11111111-0000-4000-8000-0000000c9999';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Unique per run, so an address never collides with an earlier, unreseeded run. */
const RUN = Date.now().toString(36);
let sequence = 0;
const uniqueAddress = (label: string) =>
  `portal.${label}-probe-${RUN}-${(sequence += 1)}@client.example`;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_A1 = asUser(TENANT_A, USER_A_AGENT_1);
const TENANT_B_USER = asUser(TENANT_B, USER_B_AGENT_1);

type Json = Record<string, unknown>;

interface PortalUser {
  id: string;
  displayName: string;
  emailMasked: string;
  access: 'viewer' | 'reports_only';
  status: 'invited' | 'active' | 'suspended';
  invitedAt?: string;
}

// --- shape checks transcribed from docs/api/admin.openapi.yaml -------------

/** `#/components/schemas/PortalUser`. */
function expectPortalUser(value: unknown, where = 'PortalUser'): PortalUser {
  expect(value, `${where}: not an object`).toEqual(expect.any(Object));
  const user = value as Json;
  expect(user.id, `${where}.id`).toMatch(UUID);
  expect(user.displayName, `${where}.displayName`).toEqual(expect.any(String));
  expect(user.emailMasked, `${where}.emailMasked`).toEqual(expect.any(String));
  expect(['viewer', 'reports_only'], `${where}.access`).toContain(user.access);
  expect(['invited', 'active', 'suspended'], `${where}.status`).toContain(user.status);
  if (user.invitedAt !== undefined) {
    expect(user.invitedAt, `${where}.invitedAt must be UTC ISO 8601 with Z`).toMatch(ISO_UTC);
  }
  // Scope is resolved, never echoed as a field a client could start sending back.
  expect(user, `${where} must not carry tenantId`).not.toHaveProperty('tenantId');
  // A credential, or anything derived from one, never leaves in a response.
  for (const key of Object.keys(user)) {
    expect(key.toLowerCase(), `${where}.${key} looks like a token field`).not.toMatch(/token|hash/);
  }
  return user as unknown as PortalUser;
}

/** `#/components/schemas/PortalUserList`. */
function expectPortalUserList(value: unknown): PortalUser[] {
  const list = value as Json;
  expect(Array.isArray(list.items), 'PortalUserList.items must be an array').toBe(true);
  return (list.items as unknown[]).map((item, index) =>
    expectPortalUser(item, `PortalUserList.items[${index}]`),
  );
}

/** `#/components/schemas/Error`, with the `code` the operation names. */
function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, body: ${JSON.stringify(response.body)}`,
  ).toBe(status);
  const body = response.body as Json;
  expect(body.statusCode, 'Error.statusCode').toBe(status);
  expect(body.error, 'Error.error').toEqual(expect.any(String));
  expect(body.code, 'Error.code').toBe(code);
  expect(body.message, 'Error.message').toEqual(expect.any(String));
  return body;
}

/** The emailMasked rule: what the row renders, never the address. */
function expectMasked(user: PortalUser, address: string): void {
  const local = address.slice(0, address.indexOf('@'));
  expect(user.emailMasked, 'emailMasked is the full address').not.toBe(address);
  expect(user.emailMasked, 'emailMasked carries the full local part').not.toContain(local);
}

/** Every form a value can take once it has passed through a URL or a case fold. */
function formsOf(value: string): string[] {
  return [...new Set([value, value.toLowerCase(), encodeURIComponent(value)])];
}

/** Captures console output and raw stdout/stderr writes for the duration of a test. */
function captureStray(): unknown[][] {
  const stray: unknown[][] = [];
  const record = (...args: unknown[]) => {
    stray.push(args);
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation(record);
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    vi.spyOn(stream, 'write').mockImplementation((...args: unknown[]) => {
      stray.push(args.map((arg) => (Buffer.isBuffer(arg) ? arg.toString('utf8') : arg)));
      return original(...args);
    });
  }
  return stray;
}

/** Seam S3: the plaintext token, read from the message the provider received. */
function tokenIn(message: SendRequest): string {
  const match =
    /#token=([A-Za-z0-9._~%-]+)/.exec(message.body) ??
    /[?&]token=([A-Za-z0-9._~%-]+)/.exec(message.body);
  expect(match, 'S3: the invitation body carries no invite token').not.toBeNull();
  const token = decodeURIComponent(match?.[1] ?? '');
  expect(token.length, 'S3: the invite token is shorter than 32 characters').toBeGreaterThanOrEqual(
    32,
  );
  return token;
}

/**
 * Seam S1: the real API, with the channel provider this suite observes. The
 * options object is built first so the suite typechecks before
 * `channelProvider` exists on `AppModuleOptions`, and fails at runtime instead.
 */
async function createPortalApi(
  databaseUrl: string,
  channelProvider: FakeChannelProvider,
): Promise<INestApplication> {
  const options = withAuthDatabase({ databaseUrl, poolMax: 5, channelProvider });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(options)],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

// ---------------------------------------------------------------------------

describe('acceptance: admin client-portal users API (T-0030)', () => {
  let app: INestApplication;
  let fake: FakeChannelProvider;
  let adminPool: Pool;

  beforeAll(async () => {
    fake = new FakeChannelProvider();
    app = await createPortalApi(inject('databaseUrl'), fake);
    adminPool = createPool({ connectionString: inject('testAdminUrl'), max: 2 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await adminPool?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  const invite = (headers: Record<string, string>, programmeId: string, body: unknown) =>
    request(server())
      .post(invitePath(programmeId))
      .set(headers)
      .send(body as object);

  const list = async (headers: Record<string, string>, programmeId: string) => {
    const response = await request(server()).get(listPath(programmeId)).set(headers);
    expect(response.status, `listPortalUsers: ${JSON.stringify(response.body)}`).toBe(200);
    return { users: expectPortalUserList(response.body), raw: JSON.stringify(response.body) };
  };

  /** Messages the provider received for one address. */
  const sentTo = (address: string) => fake.sent.filter((message) => message.to === address);

  /** Seam S4: wait for the invitation to reach the provider. */
  async function awaitSend(address: string, count = 1): Promise<SendRequest[]> {
    const deadline = Date.now() + 5_000;
    while (sentTo(address).length < count && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 50));
    }
    const messages = sentTo(address);
    expect(messages.length, `expected ${count} send(s) to the invited address`).toBe(count);
    return messages;
  }

  async function inviteOk(
    headers: Record<string, string>,
    programmeId: string,
    address: string,
    access: PortalUser['access'] = 'viewer',
  ): Promise<PortalUser> {
    const response = await invite(headers, programmeId, {
      email: address,
      displayName: 'Invited Client User',
      access,
    });
    expect(response.status, `invitePortalUser: ${JSON.stringify(response.body)}`).toBe(202);
    return expectPortalUser(response.body, 'invitePortalUser response');
  }

  /** Every `portal_*` table (seam S5). */
  async function portalTables(): Promise<string[]> {
    const result = await adminPool.query<{ table: string }>(
      `SELECT c.relname AS table
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'portal\\_%'
        ORDER BY c.relname`,
    );
    return result.rows.map((row) => row.table);
  }

  // --- invitePortalUser / listPortalUsers ----------------------------------

  it('invitePortalUser is 202 with a PortalUser, and sends one transactional email through the channel adapter', async () => {
    const address = uniqueAddress('first');
    const user = await inviteOk(SUPERVISOR, PROGRAMME_A1, address, 'reports_only');

    expect(user.status, 'a new invitation is pending').toBe('invited');
    expect(user.access).toBe('reports_only');
    expect(user.displayName).toBe('Invited Client User');
    expectMasked(user, address);

    const [message] = await awaitSend(address);
    expect(String(message?.channel), 'S2: invitations go out on the email channel').toBe('email');
    expect(message?.purpose).toBe('transactional');
    // The scope is the session's tenant and the invited programme — derived,
    // never taken from the request (DECISIONS.md, T-0017 security review).
    expect(message?.scope).toEqual({ tenantId: TENANT_A, programmeId: PROGRAMME_A1 });
  });

  it('an invitation is listed in its one programme and absent from the sibling programme and every other tenant', async () => {
    const address = uniqueAddress('scoped');
    const user = await inviteOk(SUPERVISOR, PROGRAMME_A1, address);

    const a1 = await list(SUPERVISOR, PROGRAMME_A1);
    const listed = a1.users.find((item) => item.id === user.id);
    expect(listed, 'the invitation is missing from its own programme').toBeDefined();
    expect(listed?.status).toBe('invited');
    expect(listed?.emailMasked).toBe(user.emailMasked);
    // "The full address is not returned by the list."
    expect(a1.raw, 'listPortalUsers returned the full invited address').not.toContain(address);

    // The same caller reaches A2; the invitation is not there.
    const a2 = await list(SUPERVISOR, PROGRAMME_A2);
    expect(a2.users.map((item) => item.id)).not.toContain(user.id);

    // Nor anywhere in tenant B.
    const b1 = await list(TENANT_B_USER, PROGRAMME_B1);
    expect(b1.users.map((item) => item.id)).not.toContain(user.id);
    expect(b1.raw).not.toContain(address);
  });

  it('inviting an address already invited elsewhere looks exactly like a fresh invitation (no existence oracle)', async () => {
    const known = uniqueAddress('known');
    const fresh = uniqueAddress('fresh');

    const original = await inviteOk(SUPERVISOR, PROGRAMME_A1, known);
    await awaitSend(known, 1);

    // Baseline: an address nobody has seen.
    const baseline = await invite(SUPERVISOR, PROGRAMME_A2, {
      email: fresh,
      displayName: 'Invited Client User',
      access: 'viewer',
    });
    expect(baseline.status).toBe(202);

    // The known address, into the sibling programme and into another tenant.
    const sibling = await invite(SUPERVISOR, PROGRAMME_A2, {
      email: known,
      displayName: 'Invited Client User',
      access: 'viewer',
    });
    const foreign = await invite(TENANT_B_USER, PROGRAMME_B1, {
      email: known,
      displayName: 'Invited Client User',
      access: 'viewer',
    });

    for (const [label, response] of [
      ['sibling programme', sibling],
      ['other tenant', foreign],
    ] as const) {
      expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(baseline.status);
      const user = expectPortalUser(response.body, label);
      expect(
        Object.keys(user).sort(),
        `${label}: response shape differs from a fresh invite`,
      ).toEqual(Object.keys(baseline.body as Json).sort());
      expect(user.status, `${label}: a fresh invitation is pending`).toBe('invited');
      // A portal user is scoped to exactly one programme: a new row, not the old one.
      expect(user.id, `${label}: reused the portal user from another scope`).not.toBe(original.id);
    }

    // One email per invitation, each scoped to where it was issued.
    const messages = await awaitSend(known, 3);
    expect(messages.map((message) => message.scope)).toEqual([
      { tenantId: TENANT_A, programmeId: PROGRAMME_A1 },
      { tenantId: TENANT_A, programmeId: PROGRAMME_A2 },
      { tenantId: TENANT_B, programmeId: PROGRAMME_B1 },
    ]);

    // Each row lives only where it was issued.
    const siblingId = (sibling.body as Json).id as string;
    const foreignId = (foreign.body as Json).id as string;
    expect((await list(SUPERVISOR, PROGRAMME_A1)).users.map((u) => u.id)).not.toContain(siblingId);
    expect((await list(TENANT_B_USER, PROGRAMME_B1)).users.map((u) => u.id)).toContain(foreignId);
    expect((await list(TENANT_B_USER, PROGRAMME_B1)).users.map((u) => u.id)).not.toContain(
      original.id,
    );
  });

  it('re-inviting the same address into the same programme follows the spec and creates no duplicate', async () => {
    const address = uniqueAddress('again');
    const first = await inviteOk(SUPERVISOR, PROGRAMME_A1, address);
    await awaitSend(address, 1);

    const again = await invite(SUPERVISOR, PROGRAMME_A1, {
      email: address,
      displayName: 'Invited Client User',
      access: 'viewer',
    });

    // The spec lists 202 and 409 for this operation and names no conflict code
    // for a duplicate invitation. Either is accepted; what is not accepted is a
    // second pending portal user for one address in one programme.
    expect([202, 409], `re-invite: ${JSON.stringify(again.body)}`).toContain(again.status);
    if (again.status === 202) {
      const user = expectPortalUser(again.body, 're-invite response');
      expect(user.id, 'a 202 re-invite must be the same portal user (a resend)').toBe(first.id);
      expect(user.status).toBe('invited');
    } else {
      const body = expectError(again, 409, (again.body as Json).code as string);
      expect(body.code).toEqual(expect.any(String));
      // A conflict never names the conflicting row (Conflict description).
      expect(JSON.stringify(body)).not.toContain(first.id);
      expect(JSON.stringify(body)).not.toContain(address);
    }

    const a1 = await list(SUPERVISOR, PROGRAMME_A1);
    const matching = a1.users.filter((item) => item.id === first.id || item.id === again.body?.id);
    expect(matching, 'a re-invite produced a second portal user row').toHaveLength(1);
  });

  it('stores the invite token hashed: the plaintext appears in no portal table', async () => {
    const address = uniqueAddress('token');
    const user = await inviteOk(SUPERVISOR, PROGRAMME_A1, address);
    const [message] = await awaitSend(address);
    if (message === undefined) throw new Error('unreachable: awaitSend asserted one message');
    const token = tokenIn(message);

    const tables = await portalTables();
    expect(tables.length, 'S5: no portal_* table exists').toBeGreaterThan(0);

    let rowsSeen = 0;
    let invitationFound = false;
    for (const table of tables) {
      // As kasuwa_test_admin (BYPASSRLS): every row, every column.
      const result = await adminPool.query<{ row: string }>(
        `SELECT row_to_json(t)::text AS row FROM "${table}" t`,
      );
      for (const { row } of result.rows) {
        rowsSeen += 1;
        if (row.includes(user.id)) invitationFound = true;
        for (const form of formsOf(token)) {
          expect(row, `${table} stores the invite token in plaintext`).not.toContain(form);
        }
      }
    }
    // Without these the assertion above passes on a table that stores nothing.
    expect(rowsSeen, 'the invitation wrote no row to any portal_* table').toBeGreaterThan(0);
    expect(invitationFound, `no portal_* row carries the returned id ${user.id}`).toBe(true);
  });

  it('never writes the invited address or the token to a log, a span, the console or stdout', async () => {
    const address = uniqueAddress('leak');
    const stray = captureStray();

    const telemetry = await collectTelemetry(async () => {
      await inviteOk(SUPERVISOR, PROGRAMME_A1, address);
      await awaitSend(address);
      await list(SUPERVISOR, PROGRAMME_A1);
      // A rejected invitation is the 3am path: the error handler that attaches the body.
      await invite(SUPERVISOR, PROGRAMME_A1, { email: address, access: 'owner' });
      await invite(AGENT_A1, PROGRAMME_A2, { email: address, access: 'viewer' });
    });

    const [message] = sentTo(address);
    if (message === undefined) throw new Error('unreachable: awaitSend asserted one message');
    const token = tokenIn(message);

    expect(telemetry.spans.length, 'no spans were recorded — is telemetry wired?').toBeGreaterThan(
      0,
    );

    const haystack = JSON.stringify({ telemetry, stray });
    const probes: Record<string, string> = {
      'invited address': address,
      'local part of the address': address.slice(0, address.indexOf('@')),
      'invite token': token,
    };
    for (const [label, value] of Object.entries(probes)) {
      for (const form of formsOf(value)) {
        expect(haystack, `telemetry or output leaked the ${label} (as "${form}")`).not.toContain(
          form,
        );
      }
    }
  });

  it('rejects an invitation body the spec does not accept, sends nothing and never echoes the address', async () => {
    const address = uniqueAddress('invalid');
    const cases: { label: string; body: unknown }[] = [
      { label: 'missing email', body: { access: 'viewer' } },
      { label: 'missing access', body: { email: address } },
      { label: 'not an email', body: { email: 'not-an-address', access: 'viewer' } },
      { label: 'unknown access', body: { email: address, access: 'owner' } },
      {
        label: 'email over 320 characters',
        body: { email: `${'x'.repeat(320)}@client.example`, access: 'viewer' },
      },
      {
        label: 'displayName over 200 characters',
        body: { email: address, displayName: 'x'.repeat(201), access: 'viewer' },
      },
      // additionalProperties: false — and these are scope arguments (CLAUDE.md 2.2).
      {
        label: 'programmeId',
        body: { email: address, access: 'viewer', programmeId: PROGRAMME_A2 },
      },
      { label: 'tenantId', body: { email: address, access: 'viewer', tenantId: TENANT_B } },
    ];

    const before = (await list(SUPERVISOR, PROGRAMME_A1)).users.length;
    for (const { label, body } of cases) {
      const response = await invite(SUPERVISOR, PROGRAMME_A1, body);
      expectError(response, 400, 'validation_failed');
      expect(JSON.stringify(response.body), `${label}: echoed the address`).not.toContain(address);
    }

    expect(sentTo(address), 'an invalid invitation reached the provider').toHaveLength(0);
    expect((await list(SUPERVISOR, PROGRAMME_A1)).users).toHaveLength(before);
  });

  // --- programme scope -----------------------------------------------------

  it('listPortalUsers is the same 404 for an unassigned, foreign or non-existent programme', async () => {
    const sibling = await request(server()).get(listPath(PROGRAMME_A2)).set(AGENT_A1);
    const foreign = await request(server()).get(listPath(PROGRAMME_A1)).set(TENANT_B_USER);
    const unassignedInB = await request(server()).get(listPath(PROGRAMME_B2)).set(TENANT_B_USER);
    const nothing = await request(server()).get(listPath(NOWHERE)).set(AGENT_A1);

    expectError(sibling, 404, 'not_found');
    // Same body, byte for byte: a difference is an existence oracle.
    expect(foreign.body).toEqual(sibling.body);
    expect(unassignedInB.body).toEqual(sibling.body);
    expect(nothing.body).toEqual(sibling.body);
  });

  it('invitePortalUser is the same 404 out of scope, and sends and creates nothing', async () => {
    const address = uniqueAddress('outside');
    const body = { email: address, displayName: 'Invited Client User', access: 'viewer' };
    const a2Before = (await list(SUPERVISOR, PROGRAMME_A2)).users.map((u) => u.id);
    const a1Before = (await list(SUPERVISOR, PROGRAMME_A1)).users.map((u) => u.id);

    const sibling = await invite(AGENT_A1, PROGRAMME_A2, body);
    const foreign = await invite(TENANT_B_USER, PROGRAMME_A1, body);
    const nothing = await invite(AGENT_A1, NOWHERE, body);

    expectError(sibling, 404, 'not_found');
    expect(foreign.body).toEqual(sibling.body);
    expect(nothing.body).toEqual(sibling.body);

    expect(sentTo(address), 'an out-of-scope invitation was sent').toHaveLength(0);
    expect((await list(SUPERVISOR, PROGRAMME_A2)).users.map((u) => u.id)).toEqual(a2Before);
    expect((await list(SUPERVISOR, PROGRAMME_A1)).users.map((u) => u.id)).toEqual(a1Before);
  });

  // --- authentication and scope transport ----------------------------------

  const EVERY_OPERATION = [
    ['listPortalUsers', () => request(app.getHttpServer()).get(listPath(PROGRAMME_A1))],
    [
      'invitePortalUser',
      () =>
        request(app.getHttpServer())
          .post(invitePath(PROGRAMME_A1))
          .send({ email: uniqueAddress('anon'), access: 'viewer' }),
    ],
  ] as const;

  it('every operation is 401 not_authenticated without a usable session, and sends nothing', async () => {
    const sentBefore = fake.sent.length;
    for (const [operation, build] of EVERY_OPERATION) {
      expectError(await build(), 401, 'not_authenticated');
      expectError(
        await build().set('authorization', 'Bearer ksw_s1_not-a-real-session'),
        401,
        'not_authenticated',
      );
      // A real user paired with the wrong tenant is not a user at all.
      const crossed = await build().set(asUser(TENANT_B, USER_A_SUPERVISOR));
      expect(crossed.status, `${operation} as a user under the wrong tenant`).toBe(401);
    }
    expect(fake.sent.length, 'an unauthenticated request sent an invitation').toBe(sentBefore);
  });

  it('every operation rejects a request that tries to supply its own scope', async () => {
    const sentBefore = fake.sent.length;
    const scopeHeaders: [string, string][] = [
      ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
      ['x-kasuwa-programme-id', PROGRAMME_A2],
      ['x-kasuwa-scope', 'all'],
    ];
    for (const [operation, build] of EVERY_OPERATION) {
      for (const [header, value] of scopeHeaders) {
        const response = await build().set(SUPERVISOR).set(header, value);
        expect(response.status, `${operation} with ${header}`).toBe(400);
      }
    }
    expect(fake.sent.length, 'a scope-header request sent an invitation').toBe(sentBefore);
  });

  // --- schema and contract -------------------------------------------------

  it('every portal_* table is tenant-scoped, RLS enabled and FORCED, with WITH CHECK = USING', async () => {
    const tables = await portalTables();
    expect(tables.length, 'S5: no portal_* table exists').toBeGreaterThan(0);

    const scoped: readonly string[] = TENANT_SCOPED_TABLES;
    const state = await readTableSecurity(adminPool);
    for (const table of tables) {
      expect(scoped, `${table} is missing from TENANT_SCOPED_TABLES`).toContain(table);
      const row = state.find((entry) => entry.table === table);
      expect(row, `${table}: not covered by the catalogue check`).toBeDefined();
      expect(row?.rlsEnabled, `${table}: RLS is not enabled`).toBe(true);
      expect(row?.rlsForced, `${table}: RLS is not FORCED`).toBe(true);
      expect(row?.policyCount, `${table}: has no policy`).toBeGreaterThan(0);
    }

    // tenant_id NOT NULL everywhere; programme_id NOT NULL too — a portal user
    // belongs to exactly one programme, so a programme-less row is a defect.
    const columns = await adminPool.query<{ table: string; column: string; nullable: string }>(
      `SELECT table_name AS table, column_name AS column, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND column_name IN ('tenant_id', 'programme_id')`,
      [tables],
    );
    for (const table of tables) {
      for (const column of ['tenant_id', 'programme_id']) {
        const found = columns.rows.find((row) => row.table === table && row.column === column);
        expect(found, `${table}.${column} does not exist`).toBeDefined();
        expect(found?.nullable, `${table}.${column} must be NOT NULL`).toBe('NO');
      }
    }

    // CLAUDE.md 2.4: at least one policy whose WITH CHECK is identical to its USING.
    const policies = await adminPool.query<{ table: string; matching: number }>(
      `SELECT c.relname AS table,
              count(*) FILTER (
                WHERE p.polwithcheck IS NOT NULL
                  AND pg_get_expr(p.polwithcheck, p.polrelid) = pg_get_expr(p.polqual, p.polrelid)
              )::int AS matching
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1)
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
  });

  it('the spec marks listPortalUsers and invitePortalUser x-kasuwa-implemented: true', () => {
    const spec = readFileSync(resolve(__dirname, '../../../docs/api/admin.openapi.yaml'), 'utf8');
    for (const operationId of ['listPortalUsers', 'invitePortalUser']) {
      const match = new RegExp(
        `operationId:\\s*${operationId}\\s*\\n\\s*x-kasuwa-implemented:\\s*(\\S+)`,
      ).exec(spec);
      expect(match, `${operationId} not found in admin.openapi.yaml`).not.toBeNull();
      expect(match?.[1], `${operationId} is not marked implemented`).toBe('true');
    }
  });
});
