import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_ACCOUNTS,
  SEED_PERMISSION_SETS,
  TENANT_A,
  USER_A_AGENT_1,
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0078, the admin audit API applies field security to change
 * values (Agent 1, M2). A HARD RELEASE GATE (D-L83): no cell may be populated
 * until this passes. Written by QA for the lead before the build (D-L23), from
 * the task, the contract and the decisions, not from an implementation
 * (D-L25).
 *
 * Sources: team/tasks/T-0078-audit-values-field-security.md; D-L48 (audit
 * visibility), D-L53 (the tenant-admin flag), D-L54 (change values are
 * strings), D-L63 (the tenant-admin flag does NOT lift field security), D-L72
 * (the value fields), D-L78 (account audit is names only), D-L81 (T-0061
 * writes values; booleans and arrays encoded as strings; follow-up T-0078),
 * D-L83 (the gate). Contract: docs/api/admin.openapi.yaml `listAuditEvents`,
 * `getAuditFilterOptions`, `createAuditExport`, `getAuditExport`, and the
 * `AuditChange` schema ("When the changed value is or could contain personal
 * data, the server sends `redacted: true` with both values null").
 *
 * THE LEAK (D-L83). Since T-0061 a contact write records `before`/`after` for
 * D-L72's value fields: status, source, preferredChannel, preferredLanguage,
 * consentState, whatsappOptIn, state, lga and tags. `/admin/audit/events`
 * returns them as stored, so a reader whose field-security matrix withholds
 * `lga` in a programme reads every LGA value written there through the audit
 * log. Who reads the audit log today: every user of the tenant, for the
 * events D-L48 makes visible to them (programme members for a programme's
 * events). There is no audit-read permission yet (audit.controller.ts:
 * "KNOWN GAP"), so "an admin-API reader" here is any of them, the seeded
 * agent included, and the tenant admin with them.
 *
 * Fixtures are packages/db/src/fixtures.ts only. Rows are written through the
 * real API where the API can write them, and planted through `kasuwa_migrator`
 * (BYPASSRLS, never serves) only for history the API cannot produce on demand
 * (a fixed event id and instant; a programme-less contact event; a value
 * change on an account or activity, which no writer records today). Helpers
 * are copied from the T-0041 / T-0061 suites, never imported: importing a test
 * file registers its tests. If the spec and this file disagree on something
 * the spec states, the spec wins and this file is the defect: say so in the
 * report, do not edit it.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder must honour these exactly)
 * ==========================================================================
 *
 * F1. THE RULE. For an event of objectType `contact`, a change whose `field`
 *     is a contact field the READER's matrix makes `none` in the EVENT's
 *     programme is returned as `{ field, redacted: true }`: `before` and
 *     `after` absent or null, no other key, the `field` unchanged. The change
 *     is NOT dropped and the event is NOT dropped. `read` and `edit` both see
 *     the values. "The matrix" is the T-0026 / T-0053 field access the
 *     records API already applies (`loadFieldAccess(tx, 'contact')`,
 *     `field_def.api_name` = the snake_case of the wire name, so
 *     `preferredChannel` is judged by `preferred_channel`):
 *       - the set held in the event's programme counts (D-P9);
 *       - the locked `admin` set is always `edit`, whatever is stored;
 *       - a membership with NO set gets the weakest unlocked level;
 *       - the TENANT-ADMIN FLAG IS NOT A PERMISSION SET (D-L63). A tenant
 *         admin whose set in a programme withholds a field sees it redacted.
 * F2. PER PROGRAMME. Judged per event, by the event's `programmeId`, never
 *     "withheld anywhere" and never "readable anywhere".
 * F3. AT READ TIME. The matrix of now decides, not the matrix when the event
 *     was written. Values stay recoverable for whoever may read them later
 *     (redacting on write would destroy them for everyone, D-L72's timeline
 *     included).
 * F4. NO PROGRAMME, NO VALUES (a ruling this suite makes; see the report).
 *     A contact event carrying values but no `programmeId` is visible
 *     tenant-wide (D-L48) and has no programme in which to judge the matrix.
 *     Fail closed: every value change in it is redacted for every reader,
 *     the tenant admin holding the locked `admin` set included.
 * F5. EVERY VALUE FIELD, every encoding. Each of D-L72's nine fields,
 *     including `whatsappOptIn` (a boolean recorded as a string) and `tags`
 *     (an array recorded as a string), and `source`, which only a CREATE
 *     records (UpdateContactRequest has no `source`). A `created` event
 *     follows the same rule as an `updated` one.
 * F6. ALREADY REDACTED STAYS REDACTED for everyone: the name parts, phones,
 *     emails, owner and account (contact-audit.ts), a value field recorded
 *     by name only, and any stored change marked `redacted: true` whatever
 *     its stored before/after hold.
 * F7. ACCOUNT AND ACTIVITY. Today their events record field names only
 *     (D-L78, activity-audit.ts). Pinned: no value of either appears through
 *     the audit API, for any reader. And the task's "the rule applies to
 *     every audited object whose fields are field-secured": a value-carrying
 *     change on an `account` or `activity` event (planted, as a later writer
 *     would record it) is redacted for a reader whose matrix withholds that
 *     field of THAT object in the event's programme. Whether a reader who may
 *     read the field sees such a planted value is left open.
 * F8. NO SIDE CHANNEL. For one reader, flipping a field between `read` and
 *     `none` changes NOTHING in the list but the redacted values: the same
 *     events, in the same order, on the same pages, with the same cursors,
 *     the same `changes[].field` sequence, under every filter. Two logs that
 *     differ only in a withheld value answer that reader byte-identically,
 *     headers included (except `Date`). A filter naming a withheld value
 *     answers exactly as one naming a value that never occurred, on the list
 *     and in an export request. `filter-options` does not depend on the
 *     matrix and carries no value.
 * F9. DETAIL AND EXPORT. Neither carries event content today: the list IS
 *     the detail (P02's expandable before/after rows are `changes` on the
 *     list item; there is no `GET /admin/audit/events/{id}`), and an export
 *     is request-only (no worker builds the file; `AuditExport` has no rows
 *     and no link). The two F9 tests are TRIPWIRES and are vacuous today:
 *     whatever a detail route or an export answers must not carry a withheld
 *     value. The export FILE, when a worker builds it, needs its own
 *     acceptance test before it ships (it must re-resolve the requester's
 *     scope AND matrix at build time).
 *
 * LEFT TO THE BUILDER: where the redaction happens (service, a shared helper,
 * SQL), whether a redacted change sends `before`/`after` as null or omits
 * them, and how unknown field names in a contact event are judged (an unknown
 * field is `none` in `fieldLevel`, so failing closed is the natural answer).
 *
 * NOT PINNED HERE (reported instead): `/admin/audit/events` sends no
 * `Cache-Control: no-store`, unlike the records reads, though its body now
 * carries a person's state, LGA and tags. And the timeline OMITS a withheld
 * field's items (T-0061 T5) while this API shows the field NAME redacted, as
 * the task says; the two readers of one event therefore differ by design.
 *
 * Writes. Every test reseeds afterwards; the suite reseeds before and after.
 */

const EVENTS = '/api/v1/admin/audit/events';
const FILTER_OPTIONS = '/api/v1/admin/audit/filter-options';
const EXPORTS = '/api/v1/admin/audit/exports';
const CONTACTS = '/api/v1/contacts';
const ACCOUNTS = '/api/v1/accounts';
const ACTIVITIES = '/api/v1/activities';

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT = asUser(TENANT_A, USER_A_AGENT_1);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);

const RUN = Date.now().toString(36);
let sequence = 0;
const unique = (label: string) => `${label} ${RUN}-${(sequence += 1)}`;

type Json = Record<string, unknown>;
type Headers = Record<string, string>;
type Params = readonly (readonly [string, string])[];
type Level = 'none' | 'read' | 'edit';

interface Change {
  field: string;
  before?: string | null;
  after?: string | null;
  redacted: boolean;
}

interface Entry {
  id: string;
  action: string;
  objectType: string;
  objectId?: string | null;
  programmeId?: string | null;
  changes?: Change[];
}

/** `AuditChange`'s four keys; a withheld change carries no fifth. */
const CHANGE_KEYS = ['field', 'before', 'after', 'redacted'];
const EXPORT_KEYS = [
  'exportId',
  'status',
  'format',
  'estimatedRowCount',
  'deliveryEmailHint',
  'linkExpiresAfterHours',
  'requestedAt',
  'completedAt',
];

/** The seeded A1 account ("Ikoyi Traders"). */
const IKOYI = (() => {
  const found = SEED_ACCOUNTS.find((account) => account.programmeId === PROGRAMME_A1);
  if (found === undefined) throw new Error('Fixture drift: no seeded A1 account');
  return found;
})();

function permissionSet(key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === TENANT_A && candidate.key === key,
  );
  if (set === undefined) throw new Error(`Fixture drift: no seeded permission set '${key}'`);
  return set.id;
}

/**
 * D-L72's value fields: wire name, the matrix's `field_def.api_name`, what a
 * create sets, what an update then sets (null: only a create records it),
 * and the strings that must never reach a reader the field is withheld from
 * (only for free text; an enum code such as `customer` is checked
 * structurally, because the word could occur innocently).
 */
interface ValueCase {
  field: string;
  apiName: string;
  create: Json;
  update: Json | null;
  sentinels: string[];
}

const VALUE_CASES: readonly ValueCase[] = [
  {
    field: 'status',
    apiName: 'status',
    create: { status: 'contacted' },
    update: { status: 'customer' },
    sentinels: [],
  },
  {
    field: 'source',
    apiName: 'source',
    create: { source: 'referral' },
    update: null,
    sentinels: [],
  },
  {
    field: 'preferredChannel',
    apiName: 'preferred_channel',
    create: { preferredChannel: 'voice' },
    update: { preferredChannel: 'sms' },
    sentinels: [],
  },
  {
    field: 'preferredLanguage',
    apiName: 'preferred_language',
    create: { preferredLanguage: 'x-t78alpha' },
    update: { preferredLanguage: 'x-t78beta' },
    sentinels: ['t78alpha', 't78beta'],
  },
  {
    field: 'consentState',
    apiName: 'consent_state',
    create: { consentState: 'opted_in' },
    update: { consentState: 'withdrawn' },
    sentinels: ['opted_in', 'withdrawn'],
  },
  {
    field: 'whatsappOptIn',
    apiName: 'whatsapp_opt_in',
    create: { whatsappOptIn: true },
    update: { whatsappOptIn: false },
    sentinels: [],
  },
  {
    field: 'state',
    apiName: 'state',
    create: { state: 'T0078 State Alpha' },
    update: { state: 'T0078 State Beta' },
    sentinels: ['T0078 State Alpha', 'T0078 State Beta'],
  },
  {
    field: 'lga',
    apiName: 'lga',
    create: { lga: 'T0078 Lga Alpha' },
    update: { lga: 'T0078 Lga Beta' },
    sentinels: ['T0078 Lga Alpha', 'T0078 Lga Beta'],
  },
  {
    field: 'tags',
    apiName: 'tags',
    create: { tags: ['t0078-tag-alpha'] },
    update: { tags: ['t0078-tag-beta', 't0078-tag-gamma'] },
    sentinels: ['t0078-tag-alpha', 't0078-tag-beta', 't0078-tag-gamma'],
  },
];

// --- checkers ---------------------------------------------------------------

function expectStatus(response: request.Response, status: number, where: string): void {
  expect(response.status, `${where}: ${response.text}`).toBe(status);
}

/** F1: a withheld (or by-design redacted) change. */
function expectRedacted(change: Change, where: string): void {
  for (const key of Object.keys(change)) {
    expect(CHANGE_KEYS, `${where}: a redacted change carries "${key}"`).toContain(key);
  }
  expect(change.redacted, `${where}: ${JSON.stringify(change)} must be redacted`).toBe(true);
  expect(
    change.before ?? null,
    `${where}: ${JSON.stringify(change)} carries a before value`,
  ).toBeNull();
  expect(change.after ?? null, `${where}: ${JSON.stringify(change)} carries an after value`).toBe(
    null,
  );
}

/** A change whose values the reader may see. At least one side holds a value. */
function expectValues(change: Change, where: string): void {
  expect(change.redacted, `${where}: ${JSON.stringify(change)} must carry its values`).toBe(false);
  const sides = [change.before ?? null, change.after ?? null].filter((side) => side !== null);
  expect(
    sides.length,
    `${where}: ${JSON.stringify(change)} carries no value at all`,
  ).toBeGreaterThan(0);
}

function tryBase64url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{8,}={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  return decoded === '' ? null : decoded;
}

/** Every string a body carries, keys included, plus each one decoded as base64url (cursors). */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    const decoded = tryBase64url(value);
    if (decoded !== null) out.push(decoded);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringsIn(item, out);
    }
  }
  return out;
}

/** The sentinels a response carries anywhere: raw text, headers, any decoded string. */
function leaked(response: request.Response, sentinels: readonly string[]): string[] {
  const haystack = [
    response.text ?? '',
    JSON.stringify(response.headers),
    ...stringsIn(response.body),
  ]
    .join('\n')
    .toLowerCase();
  return sentinels.filter((sentinel) => haystack.includes(sentinel.toLowerCase()));
}

/** Changes of one field across a set of entries. */
function changesOf(entries: readonly Entry[], field: string): Change[] {
  return entries.flatMap((entry) => (entry.changes ?? []).filter((c) => c.field === field));
}

/** Redacted changes in one canonical shape, so two views compare on substance. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Json;
  if (typeof object.field === 'string' && object.redacted === true) {
    return { field: object.field, before: null, after: null, redacted: true };
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, canonical(item)]));
}

/** Redacts `field` wherever it appears in a change: what a withheld reader should see. */
function redactField(value: unknown, field: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactField(item, field));
  if (value === null || typeof value !== 'object') return value;
  const object = value as Json;
  if (object.field === field && typeof object.redacted === 'boolean') {
    return { field, before: null, after: null, redacted: true };
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, redactField(item, field)]),
  );
}

// ---------------------------------------------------------------------------

describe('acceptance: the admin audit API applies field security to change values (T-0078)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants rows and grants; never serves. */
  let observer: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    app = await createApi(inject('databaseUrl'));
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };

  // --- HTTP helpers -------------------------------------------------------

  const listEvents = (headers: Headers, params: Params = []) =>
    request(server()).get(withQuery(EVENTS, params)).set(headers);

  /** Every page of the log the reader can see, newest first. */
  async function readAll(
    headers: Headers,
    params: Params = [],
    pageSize = 200,
  ): Promise<{ entries: Entry[]; pages: Json[]; responses: request.Response[] }> {
    const entries: Entry[] = [];
    const pages: Json[] = [];
    const responses: request.Response[] = [];
    let cursor: string | null = null;
    do {
      const query: [string, string][] = [...params.map(([k, v]): [string, string] => [k, v])];
      query.push(['pageSize', String(pageSize)]);
      if (cursor !== null) query.push(['cursor', cursor]);
      const response = await listEvents(headers, query);
      expectStatus(response, 200, `listAuditEvents ${JSON.stringify(query)}`);
      const body = response.body as { items: Entry[]; page: { nextCursor: string | null } };
      entries.push(...body.items);
      pages.push(response.body as Json);
      responses.push(response);
      cursor = body.page.nextCursor;
      if (pages.length > 200) throw new Error('audit paging did not terminate');
    } while (cursor !== null);
    return { entries, pages, responses };
  }

  /** The reader's view of one object's events. */
  async function eventsFor(headers: Headers, objectId: string): Promise<Entry[]> {
    const { entries } = await readAll(headers);
    return entries.filter((entry) => entry.objectId === objectId);
  }

  async function createContact(
    programmeId: string,
    extra: Json = {},
  ): Promise<{ id: string; version: number }> {
    const response = await request(server())
      .post(CONTACTS)
      .set(SUPERVISOR)
      .send({ programmeId, displayName: unique('T0078 Contact'), ...extra });
    expectStatus(response, 201, 'createContact (supervisor)');
    const body = response.body as { id: string; version: number };
    return { id: body.id, version: body.version };
  }

  async function updateContact(
    contact: { id: string; version: number },
    body: Json,
    headers: Headers = SUPERVISOR,
  ): Promise<void> {
    const response = await request(server())
      .patch(`${CONTACTS}/${contact.id}`)
      .set(headers)
      .send({ version: contact.version, ...body });
    expectStatus(response, 200, `updateContact ${JSON.stringify(body)}`);
    contact.version = (response.body as { version: number }).version;
  }

  // --- observer helpers ----------------------------------------------------

  async function assign(userId: string, programmeId: string, key: string | null) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, key === null ? null : permissionSet(key)],
    );
  }

  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  /** One field-security decision in tenant A, against the standard field_def the seed holds. */
  async function lockField(
    objectApiName: 'contact' | 'account' | 'activity',
    field: string,
    setKey: string,
    level: Level,
  ) {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = $2 AND f.api_name = $3`,
      [TENANT_A, objectApiName, field],
    );
    const fieldId = found.rows[0]?.id;
    if (fieldId === undefined) {
      throw new Error(
        `Fixture drift: tenant A has no standard field_def ${objectApiName}.${field} ` +
          '(T-0053, T-0054 and T-0060 seed them). This suite plants grants, never definitions.',
      );
    }
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(setKey), level],
    );
  }

  interface PlantedEvent {
    id?: string;
    objectType: 'contact' | 'account' | 'activity';
    objectId: string;
    /** null: no programme (visible tenant-wide, D-L48). */
    programmeId: string | null;
    occurredAt?: string;
    action?: 'created' | 'updated';
    changes: Change[];
  }

  /** One audit event in exactly the shape the writers store (actor: the supervisor). */
  async function plantEvent(event: PlantedEvent): Promise<string> {
    const id = event.id ?? randomUUID();
    await observer.query(
      `INSERT INTO audit_event (id, tenant_id, occurred_at, actor_kind, actor_user_id, action,
                                object_type, object_id, object_label, programme_id, changes)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), 'user', $4, $5, $6, $7::uuid, $7::text, $8, $9::jsonb)`,
      [
        id,
        TENANT_A,
        event.occurredAt ?? null,
        USER_A_SUPERVISOR,
        event.action ?? 'updated',
        event.objectType,
        event.objectId,
        event.programmeId,
        JSON.stringify(event.changes),
      ],
    );
    return id;
  }

  /** A contact in A1 with status and lga history: create, a status-only update, a mixed update. */
  async function contactWithHistory(programmeId: string = PROGRAMME_A1) {
    const contact = await createContact(programmeId, { status: 'new', lga: 'T0078 Lga Alpha' });
    await updateContact(contact, { status: 'contacted' });
    await updateContact(contact, {
      status: 'qualified',
      lga: 'T0078 Lga Beta',
      phones: [{ type: 'mobile', e164: '+2348030000781' }],
    });
    return contact;
  }

  // =========================================================================
  // 0. The checkers can fail.
  // =========================================================================

  describe('(self-check) the checkers can fail', () => {
    it('expectRedacted rejects values, a false flag and an extra key; the scanner finds a sentinel in text and inside a cursor', () => {
      expect(() =>
        expectRedacted({ field: 'lga', before: null, after: null, redacted: true }, 'ok'),
      ).not.toThrow();
      expect(() => expectRedacted({ field: 'lga', redacted: true }, 'ok, omitted')).not.toThrow();
      expect(() =>
        expectRedacted({ field: 'lga', before: 'Ikeja', after: null, redacted: true }, 'mutant'),
      ).toThrow();
      expect(() =>
        expectRedacted({ field: 'lga', before: null, after: 'Ikeja', redacted: true }, 'mutant'),
      ).toThrow();
      expect(() =>
        expectRedacted({ field: 'lga', before: null, after: null, redacted: false }, 'mutant'),
      ).toThrow();
      expect(() =>
        expectRedacted(
          { field: 'lga', before: null, after: null, redacted: true, withheld: true } as Change,
          'mutant',
        ),
      ).toThrow();
      expect(() =>
        expectValues({ field: 'lga', before: null, after: null, redacted: false }, 'mutant'),
      ).toThrow();

      const fake = (body: unknown) =>
        ({ text: JSON.stringify(body), body, headers: {} }) as unknown as request.Response;
      expect(
        leaked(fake({ items: [{ after: 'x T0078 Lga Beta y' }] }), ['T0078 Lga Beta']),
      ).toEqual(['T0078 Lga Beta']);
      const cursor = Buffer.from(JSON.stringify({ v: 't0078-tag-beta' })).toString('base64url');
      expect(leaked(fake({ page: { nextCursor: cursor } }), ['t0078-tag-beta'])).toEqual([
        't0078-tag-beta',
      ]);
      expect(leaked(fake({ items: [] }), ['t0078-tag-beta'])).toEqual([]);
    });
  });

  // =========================================================================
  // 1. The rule (F1).
  // =========================================================================

  describe('a withheld field is redacted in the list; a readable one is not (F1)', () => {
    it('an agent whose matrix withholds lga in A1 sees every lga change as { field, redacted: true }, and the rest of the event intact', async () => {
      const contact = await contactWithHistory();
      await lockField('contact', 'lga', 'agent', 'none');

      const { entries, responses } = await readAll(AGENT);
      const mine = entries.filter((entry) => entry.objectId === contact.id);
      expect(mine.length, 'the agent sees the contact’s three events').toBe(3);

      const lga = changesOf(mine, 'lga');
      expect(lga.length, 'create and the mixed update both record lga').toBe(2);
      lga.forEach((change, index) => expectRedacted(change, `lga change ${index}`));

      // Per change, not per event: status shares an event with lga and stays readable.
      const status = changesOf(mine, 'status');
      expect(status.length, 'create and both updates record status').toBe(3);
      status.forEach((change, index) => expectValues(change, `status change ${index}`));

      for (const response of responses) {
        expect(leaked(response, ['T0078 Lga Alpha', 'T0078 Lga Beta']), 'lga values').toEqual([]);
      }
    });

    it('a reader who may read the field sees its values: `read`, `edit`, and the locked admin set', async () => {
      const contact = await contactWithHistory();

      // Non-vacuous: the events do carry values (T-0061), seen by the admin set.
      for (const change of changesOf(await eventsFor(SUPERVISOR, contact.id), 'lga')) {
        expectValues(change, 'supervisor (admin set)');
      }

      await lockField('contact', 'lga', 'agent', 'read');
      const asRead = changesOf(await eventsFor(AGENT, contact.id), 'lga');
      expect(asRead.length).toBe(2);
      asRead.forEach((change, index) => expectValues(change, `agent at read, ${index}`));

      await lockField('contact', 'lga', 'agent', 'edit');
      const asEdit = changesOf(await eventsFor(AGENT, contact.id), 'lga');
      expect(asEdit.length).toBe(2);
      asEdit.forEach((change, index) => expectValues(change, `agent at edit, ${index}`));

      // A stored `none` for the locked admin set is ignored, as the matrix says.
      await lockField('contact', 'lga', 'admin', 'none');
      const locked = changesOf(await eventsFor(SUPERVISOR, contact.id), 'lga');
      expect(locked.length).toBe(2);
      locked.forEach((change, index) => expectValues(change, `admin set, stored none, ${index}`));
    });

    it('the tenant-admin flag does not lift field security (D-L63): the seeded tenant admin holding team_lead in A1', async () => {
      const contact = await contactWithHistory(PROGRAMME_A1);
      const other = await contactWithHistory(PROGRAMME_A2);
      await assign(USER_A_SUPERVISOR, PROGRAMME_A1, 'team_lead');
      await lockField('contact', 'lga', 'team_lead', 'none');

      const { entries, responses } = await readAll(SUPERVISOR);
      const inA1 = changesOf(
        entries.filter((entry) => entry.objectId === contact.id),
        'lga',
      );
      expect(inA1.length).toBe(2);
      inA1.forEach((change, index) => expectRedacted(change, `tenant admin, A1 lga ${index}`));

      // Still the admin set in A2: values there.
      const inA2 = changesOf(
        entries.filter((entry) => entry.objectId === other.id),
        'lga',
      );
      expect(inA2.length).toBe(2);
      inA2.forEach((change, index) => expectValues(change, `tenant admin, A2 lga ${index}`));

      // The A1 values are nowhere, though the same strings are legitimately in A2's events.
      const a1Only = responses.flatMap((response) =>
        (response.body as { items: Entry[] }).items.filter(
          (entry) => entry.objectId === contact.id,
        ),
      );
      expect(JSON.stringify(a1Only)).not.toMatch(/T0078 Lga/);
    });

    it('the tenant-admin flag does not lift field security (D-L63): an agent made tenant admin', async () => {
      const contact = await contactWithHistory();
      await setTenantAdmin(USER_A_AGENT_1, true);
      await lockField('contact', 'lga', 'agent', 'none');

      const lga = changesOf(await eventsFor(AGENT, contact.id), 'lga');
      expect(lga.length).toBe(2);
      lga.forEach((change, index) => expectRedacted(change, `agent with the flag, ${index}`));
    });
  });

  // =========================================================================
  // 2. Whose matrix, where, and when (F2, F3, F4).
  // =========================================================================

  describe('the matrix is judged in the EVENT’s programme, at read time (F2, F3, F4)', () => {
    it('withheld in A1, readable in A2: only the A1 events are redacted, for the same reader on the same page', async () => {
      const inA1 = await contactWithHistory(PROGRAMME_A1);
      const inA2 = await contactWithHistory(PROGRAMME_A2);
      await assign(USER_A_AGENT_1, PROGRAMME_A2, 'team_lead');
      await lockField('contact', 'lga', 'agent', 'none');

      const { entries } = await readAll(AGENT);
      const a1 = changesOf(
        entries.filter((entry) => entry.objectId === inA1.id),
        'lga',
      );
      const a2 = changesOf(
        entries.filter((entry) => entry.objectId === inA2.id),
        'lga',
      );
      expect([a1.length, a2.length], 'both contacts’ lga changes are visible').toEqual([2, 2]);
      a1.forEach((change, index) => expectRedacted(change, `A1 (agent) lga ${index}`));
      a2.forEach((change, index) => expectValues(change, `A2 (team_lead) lga ${index}`));
    });

    it('withheld in A2, readable in A1: only the A2 events are redacted (never "withheld anywhere", never "first programme")', async () => {
      const inA1 = await contactWithHistory(PROGRAMME_A1);
      const inA2 = await contactWithHistory(PROGRAMME_A2);
      await assign(USER_A_AGENT_1, PROGRAMME_A2, 'qa_analyst');
      await lockField('contact', 'lga', 'qa_analyst', 'none');

      const { entries } = await readAll(AGENT);
      const a1 = changesOf(
        entries.filter((entry) => entry.objectId === inA1.id),
        'lga',
      );
      const a2 = changesOf(
        entries.filter((entry) => entry.objectId === inA2.id),
        'lga',
      );
      expect([a1.length, a2.length]).toEqual([2, 2]);
      a1.forEach((change, index) => expectValues(change, `A1 (agent) lga ${index}`));
      a2.forEach((change, index) => expectRedacted(change, `A2 (qa_analyst) lga ${index}`));
    });

    it('a membership with no permission set gets the weakest unlocked level: withheld from qa_analyst means withheld from it', async () => {
      const contact = await contactWithHistory();
      await assign(USER_A_AGENT_1, PROGRAMME_A1, null);
      await lockField('contact', 'lga', 'qa_analyst', 'none');

      const lga = changesOf(await eventsFor(AGENT, contact.id), 'lga');
      expect(lga.length, 'a member with no set still sees the programme’s events').toBe(2);
      lga.forEach((change, index) => expectRedacted(change, `no set, ${index}`));
    });

    it('read time, both ways: withheld when the event was written but readable now shows values; readable then and withheld now does not', async () => {
      await lockField('contact', 'lga', 'agent', 'none');
      const contact = await contactWithHistory();

      const before = changesOf(await eventsFor(AGENT, contact.id), 'lga');
      expect(before.length).toBe(2);
      before.forEach((change, index) => expectRedacted(change, `withheld now, ${index}`));

      // The values were kept: whoever may read them now, sees them.
      await lockField('contact', 'lga', 'agent', 'edit');
      const after = changesOf(await eventsFor(AGENT, contact.id), 'lga');
      expect(after.length).toBe(2);
      after.forEach((change, index) => expectValues(change, `readable now, ${index}`));

      await lockField('contact', 'lga', 'agent', 'none');
      const again = changesOf(await eventsFor(AGENT, contact.id), 'lga');
      again.forEach((change, index) => expectRedacted(change, `withheld again, ${index}`));
    });

    it('F4: a value-carrying contact event with no programme is redacted for every reader, the admin set and tenant admin included', async () => {
      // Visible tenant-wide (D-L48), with no programme to judge a matrix in.
      const contactId = randomUUID();
      await plantEvent({
        objectType: 'contact',
        objectId: contactId,
        programmeId: null,
        changes: [
          { field: 'status', before: 'new', after: 'contacted', redacted: false },
          { field: 'lga', before: null, after: 'T0078 Lga Nowhere', redacted: false },
          { field: 'tags', before: null, after: '["t0078-tag-nowhere"]', redacted: false },
        ],
      });

      for (const [who, headers] of [
        ['supervisor (admin set, tenant admin)', SUPERVISOR],
        ['agent', AGENT],
        ['a user in no programme', NO_PROGRAMME],
      ] as const) {
        const { entries, responses } = await readAll(headers);
        const event = entries.find((entry) => entry.objectId === contactId);
        expect(event, `${who} sees the tenant-wide event`).toBeDefined();
        const changes = event?.changes ?? [];
        expect(changes.map((change) => change.field)).toEqual(['status', 'lga', 'tags']);
        changes.forEach((change) => expectRedacted(change, `${who}, ${change.field}`));
        for (const response of responses) {
          expect(leaked(response, ['T0078 Lga Nowhere', 't0078-tag-nowhere']), who).toEqual([]);
        }
      }
    });
  });

  // =========================================================================
  // 3. Every value field, every encoding (F5).
  // =========================================================================

  describe('every D-L72 value field follows the matrix, in created and updated events (F5)', () => {
    it.each(VALUE_CASES.map((valueCase) => [valueCase.field, valueCase] as const))(
      '%s: withheld is redacted, read shows values',
      async (_field, valueCase) => {
        const contact = await createContact(PROGRAMME_A1, valueCase.create);
        if (valueCase.update !== null) await updateContact(contact, valueCase.update);
        const expected = valueCase.update === null ? 1 : 2;

        // Non-vacuous: the writer recorded values for this field.
        const seen = changesOf(await eventsFor(SUPERVISOR, contact.id), valueCase.field);
        expect(seen.length, `${valueCase.field}: changes recorded`).toBe(expected);
        seen.forEach((change, index) => expectValues(change, `admin set, ${index}`));

        await lockField('contact', valueCase.apiName, 'agent', 'none');
        const { entries, responses } = await readAll(AGENT);
        const mine = entries.filter((entry) => entry.objectId === contact.id);
        const withheld = changesOf(mine, valueCase.field);
        expect(withheld.length, `${valueCase.field}: the change is kept, not dropped`).toBe(
          expected,
        );
        withheld.forEach((change, index) => expectRedacted(change, `agent at none, ${index}`));
        for (const response of responses) {
          expect(leaked(response, valueCase.sentinels), `${valueCase.field} values`).toEqual([]);
        }

        // `read` is enough. This also catches a wire-name / api_name mix-up
        // (preferredChannel vs preferred_channel), which fails closed.
        await lockField('contact', valueCase.apiName, 'agent', 'read');
        const readable = changesOf(await eventsFor(AGENT, contact.id), valueCase.field);
        expect(readable.length).toBe(expected);
        readable.forEach((change, index) => expectValues(change, `agent at read, ${index}`));
      },
    );
  });

  // =========================================================================
  // 4. Already redacted stays redacted (F6).
  // =========================================================================

  describe('what is redacted by design stays redacted for everyone (F6)', () => {
    it('name parts, phones, emails, owner and account: never a value, for the admin set and tenant admin', async () => {
      const contact = await createContact(PROGRAMME_A1);
      await updateContact(contact, {
        displayName: 'T0078 Renamed Person',
        givenNames: 'T0078Given',
        familyName: 'T0078Family',
        phones: [{ type: 'mobile', e164: '+2348030000782' }],
        emails: ['t0078.person@example.test'],
        ownerUserId: USER_A_AGENT_1,
        accountId: IKOYI.id,
      });

      for (const [who, headers] of [
        ['supervisor', SUPERVISOR],
        ['agent', AGENT],
      ] as const) {
        const { entries, responses } = await readAll(headers);
        const update = entries.find(
          (entry) => entry.objectId === contact.id && entry.action === 'updated',
        );
        const fields = (update?.changes ?? []).map((change) => change.field).sort();
        expect(fields, `${who}: the update names each field`).toEqual(
          [
            'accountId',
            'displayName',
            'emails',
            'familyName',
            'givenNames',
            'ownerUserId',
            'phones',
          ].sort(),
        );
        (update?.changes ?? []).forEach((change) =>
          expectRedacted(change, `${who}, ${change.field}`),
        );
        for (const response of responses) {
          expect(
            leaked(response, [
              'T0078 Renamed Person',
              'T0078Given',
              'T0078Family',
              '2348030000782',
              't0078.person@example.test',
              IKOYI.name,
            ]),
            who,
          ).toEqual([]);
        }
      }
    });

    it('a stored change marked redacted shows no value even when its stored before/after hold one, to a reader who may read the field', async () => {
      const contactId = randomUUID();
      await plantEvent({
        objectType: 'contact',
        objectId: contactId,
        programmeId: PROGRAMME_A1,
        changes: [
          {
            field: 'lga',
            before: 'T0078 Stored Before',
            after: 'T0078 Stored After',
            redacted: true,
          },
          { field: 'status', before: null, after: null, redacted: true },
        ],
      });

      const { entries, responses } = await readAll(SUPERVISOR);
      const event = entries.find((entry) => entry.objectId === contactId);
      expect(event, 'the planted event is visible to an A1 member').toBeDefined();
      expect((event?.changes ?? []).length).toBe(2);
      (event?.changes ?? []).forEach((change) => expectRedacted(change, change.field));
      for (const response of responses) {
        expect(leaked(response, ['T0078 Stored Before', 'T0078 Stored After'])).toEqual([]);
      }
    });
  });

  // =========================================================================
  // 5. Account and activity (F7).
  // =========================================================================

  describe('account and activity events (F7)', () => {
    it('account writes reach the audit API as field names only, for every reader', async () => {
      const created = await request(server())
        .post(ACCOUNTS)
        .set(SUPERVISOR)
        .send({
          programmeId: PROGRAMME_A1,
          name: 'T0078 Account Name',
          industry: 'T0078 Industry',
          tier: 'sme',
          tags: ['t0078-account-tag'],
          state: 'T0078 Account State',
          lga: 'T0078 Account Lga',
        });
      expectStatus(created, 201, 'createAccount');
      const account = created.body as { id: string; version: number };
      const updated = await request(server())
        .patch(`${ACCOUNTS}/${account.id}`)
        .set(SUPERVISOR)
        .send({ version: account.version, tier: 'enterprise', name: 'T0078 Account Renamed' });
      expectStatus(updated, 200, 'updateAccount');

      for (const [who, headers] of [
        ['supervisor', SUPERVISOR],
        ['agent', AGENT],
      ] as const) {
        const { entries, responses } = await readAll(headers);
        const events = entries.filter((entry) => entry.objectId === account.id);
        expect(events.length, `${who}: create and update`).toBe(2);
        const changes = events.flatMap((entry) => entry.changes ?? []);
        expect(changes.map((change) => change.field)).toEqual(
          expect.arrayContaining(['name', 'industry', 'tier', 'tags', 'state', 'lga']),
        );
        changes.forEach((change) => expectRedacted(change, `${who}, account ${change.field}`));
        for (const response of responses) {
          expect(
            leaked(response, [
              'T0078 Account Name',
              'T0078 Account Renamed',
              'T0078 Industry',
              't0078-account-tag',
              'T0078 Account State',
              'T0078 Account Lga',
              'enterprise',
            ]),
            who,
          ).toEqual([]);
        }
      }
    });

    it('activity writes reach the audit API as field names only, for every reader', async () => {
      const contact = await createContact(PROGRAMME_A1);
      const created = await request(server()).post(ACTIVITIES).set(SUPERVISOR).send({
        type: 'task',
        subject: 'T0078 Activity Subject',
        body: 'T0078 activity body, invented text that names no one.',
        dueAt: '2026-12-01T09:00:00.000Z',
        ownerUserId: USER_A_AGENT_1,
        contactId: contact.id,
      });
      expectStatus(created, 201, 'createActivity');
      const activity = created.body as { id: string; version: number };
      const completed = await request(server())
        .patch(`${ACTIVITIES}/${activity.id}`)
        .set(SUPERVISOR)
        .send({ version: activity.version, completed: true });
      expectStatus(completed, 200, 'updateActivity');

      for (const [who, headers] of [
        ['supervisor', SUPERVISOR],
        ['agent', AGENT],
      ] as const) {
        const { entries, responses } = await readAll(headers);
        const events = entries.filter((entry) => entry.objectId === activity.id);
        expect(events.length, `${who}: create and complete`).toBe(2);
        const changes = events.flatMap((entry) => entry.changes ?? []);
        expect(changes.map((change) => change.field)).toEqual(
          expect.arrayContaining(['type', 'subject', 'body', 'dueAt', 'completedAt']),
        );
        changes.forEach((change) => expectRedacted(change, `${who}, activity ${change.field}`));
        for (const response of responses) {
          expect(
            leaked(response, ['T0078 Activity Subject', 'T0078 activity body', '2026-12-01T09']),
            who,
          ).toEqual([]);
        }
      }
    });

    it('a value on an account or activity event (as a later writer would record it) is redacted where the matrix withholds that object’s field', async () => {
      const accountEvent = await plantEvent({
        objectType: 'account',
        objectId: IKOYI.id,
        programmeId: PROGRAMME_A1,
        changes: [
          { field: 'industry', before: null, after: 'T0078 Planted Industry', redacted: false },
          { field: 'tier', before: 'sme', after: 'enterprise', redacted: false },
        ],
      });
      const activityEvent = await plantEvent({
        objectType: 'activity',
        objectId: randomUUID(),
        programmeId: PROGRAMME_A1,
        changes: [
          { field: 'subject', before: null, after: 'T0078 Planted Subject', redacted: false },
        ],
      });
      await lockField('account', 'industry', 'agent', 'none');
      await lockField('account', 'tier', 'agent', 'none');
      await lockField('activity', 'subject', 'agent', 'none');

      const { entries, responses } = await readAll(AGENT);
      const account = entries.find((entry) => entry.id === accountEvent);
      const activity = entries.find((entry) => entry.id === activityEvent);
      expect(account?.changes?.map((change) => change.field)).toEqual(['industry', 'tier']);
      expect(activity?.changes?.map((change) => change.field)).toEqual(['subject']);
      for (const change of [...(account?.changes ?? []), ...(activity?.changes ?? [])]) {
        expectRedacted(change, `planted ${change.field}`);
      }
      for (const response of responses) {
        expect(leaked(response, ['T0078 Planted Industry', 'T0078 Planted Subject'])).toEqual([]);
      }
    });
  });

  // =========================================================================
  // 6. No side channel (F8).
  // =========================================================================

  describe('nothing but the values changes when a field is withheld (F8)', () => {
    it('same events, order, pages, cursors and field sequence at every page size and under every filter', async () => {
      await contactWithHistory(PROGRAMME_A1);
      const lgaOnly = await createContact(PROGRAMME_A1);
      // An event whose ONLY change is the withheld field: it must not vanish.
      await updateContact(lgaOnly, { lga: 'T0078 Lga Solo' });
      await updateContact(lgaOnly, { tags: ['t0078-tag-side'] });

      const views: Params[] = [
        [],
        [['objectType', 'contact']],
        [['action', 'updated']],
        [['actorId', USER_A_SUPERVISOR]],
        [
          ['objectType', 'contact'],
          ['action', 'created'],
        ],
      ];
      const sizes = [1, 2, 3, 200];

      const read = async () => {
        const out: unknown[] = [];
        for (const params of views) {
          for (const size of sizes) {
            out.push((await readAll(AGENT, params, size)).pages);
          }
        }
        return out;
      };

      await lockField('contact', 'lga', 'agent', 'read');
      const readable = await read();
      await lockField('contact', 'lga', 'agent', 'none');
      const withheld = await read();

      // Non-vacuous: the readable view has lga values to hide.
      expect(JSON.stringify(readable)).toContain('T0078 Lga Solo');
      expect(canonical(withheld)).toEqual(canonical(redactField(readable, 'lga')));
    });

    it('two logs that differ only in a withheld value answer the reader byte-identically, headers included', async () => {
      const eventId = randomUUID();
      const contactId = randomUUID();
      const capture = async (lga: string) => {
        await lockField('contact', 'lga', 'agent', 'none');
        await plantEvent({
          id: eventId,
          objectType: 'contact',
          objectId: contactId,
          programmeId: PROGRAMME_A1,
          occurredAt: '2026-06-01T10:00:00.000Z',
          changes: [
            { field: 'lga', before: 'T0078 Lga Same', after: lga, redacted: false },
            { field: 'status', before: 'new', after: 'contacted', redacted: false },
          ],
        });
        const response = await listEvents(AGENT, [['pageSize', '200']]);
        expectStatus(response, 200, `list with lga ${lga}`);
        const headers = Object.fromEntries(
          Object.entries(response.headers).filter(([name]) => name.toLowerCase() !== 'date'),
        );
        return { text: response.text, headers };
      };

      const first = await capture('T0078 Lga One');
      await reseed(inject('migrationUrl'));
      const second = await capture('T0078 Lga Two');

      expect(first.text, 'the event is there').toContain(eventId);
      expect(second.text).toEqual(first.text);
      expect(second.headers).toEqual(first.headers);
    });

    it('a filter naming a withheld value answers exactly as one naming a value that never occurred (list and export request)', async () => {
      const contact = await contactWithHistory();
      await updateContact(contact, { lga: 'T0078 Lga Gamma' });
      await setTenantAdmin(USER_A_AGENT_1, true);
      await lockField('contact', 'lga', 'agent', 'none');

      const occurred = 'T0078 Lga Gamma';
      const never = 'T0078 Lga Zzzzz';
      const names = ['field', 'value', 'before', 'after', 'q', 'search', 'lga', 'changes'];

      const normaliseExport = (response: request.Response) => {
        const body =
          response.body !== null && typeof response.body === 'object'
            ? { ...(response.body as Json) }
            : response.body;
        if (response.status === 202 && body !== null && typeof body === 'object') {
          delete (body as Json).exportId;
          delete (body as Json).requestedAt;
        }
        return { status: response.status, body };
      };

      for (const name of names) {
        const hit = await listEvents(AGENT, [
          ['objectType', 'contact'],
          [name, occurred],
        ]);
        const miss = await listEvents(AGENT, [
          ['objectType', 'contact'],
          [name, never],
        ]);
        expect(
          { status: hit.status, body: canonical(hit.body) },
          `list ?${name}=<withheld value> vs ?${name}=<never occurred>`,
        ).toEqual({ status: miss.status, body: canonical(miss.body) });
        expect(leaked(hit, [occurred]).length, `?${name}: the value is not echoed`).toBe(0);

        const exportHit = await request(server())
          .post(EXPORTS)
          .set(AGENT)
          .send({ format: 'csv', scope: 'filtered', filters: { [name]: occurred } });
        const exportMiss = await request(server())
          .post(EXPORTS)
          .set(AGENT)
          .send({ format: 'csv', scope: 'filtered', filters: { [name]: never } });
        expect(normaliseExport(exportHit), `export filters.${name}`).toEqual(
          normaliseExport(exportMiss),
        );
      }
    });

    it('filter-options does not depend on the matrix and carries no value', async () => {
      await contactWithHistory();
      await lockField('contact', 'lga', 'agent', 'read');
      const readable = await request(server()).get(FILTER_OPTIONS).set(AGENT);
      expectStatus(readable, 200, 'filter-options at read');
      await lockField('contact', 'lga', 'agent', 'none');
      const withheld = await request(server()).get(FILTER_OPTIONS).set(AGENT);
      expectStatus(withheld, 200, 'filter-options at none');
      expect(withheld.body).toEqual(readable.body);
      expect(leaked(withheld, ['T0078 Lga Alpha', 'T0078 Lga Beta'])).toEqual([]);
    });
  });

  // =========================================================================
  // 7. Detail and export (F9). TRIPWIRES: vacuous today, see F9.
  // =========================================================================

  describe('detail and export carry no withheld value (F9, tripwires)', () => {
    it('whatever GET /admin/audit/events/{id} answers, it reveals no withheld value and does not tell the event from an invented id', async () => {
      // VACUOUS TODAY: no detail route exists, so both answers are the same
      // 404. It is here so that adding one cannot skip field security.
      const contact = await contactWithHistory();
      await lockField('contact', 'lga', 'agent', 'none');
      const { entries } = await readAll(AGENT);
      const event = entries.find(
        (entry) =>
          entry.objectId === contact.id && (entry.changes ?? []).some((c) => c.field === 'lga'),
      );
      expect(event, 'an lga-bearing event exists').toBeDefined();
      const eventId = event?.id ?? '';
      const invented = randomUUID();

      const real = await request(server()).get(`${EVENTS}/${eventId}`).set(AGENT);
      expect(leaked(real, ['T0078 Lga Alpha', 'T0078 Lga Beta'])).toEqual([]);
      if (real.status === 200) {
        changesOf([real.body as Entry], 'lga').forEach((change) =>
          expectRedacted(change, 'detail lga'),
        );
      } else {
        const fake = await request(server()).get(`${EVENTS}/${invented}`).set(AGENT);
        expect(real.status).toBe(fake.status);
        expect(real.text.split(eventId).join('<id>')).toEqual(
          fake.text.split(invented).join('<id>'),
        );
      }
    });

    it('an export request by a tenant admin whose matrix withholds a field: the request, the poll and the export’s own event carry no event content', async () => {
      // A TRIPWIRE: the export is request-only today. When a worker builds
      // the file, that file needs its own acceptance test (F9).
      await contactWithHistory();
      await assign(USER_A_SUPERVISOR, PROGRAMME_A1, 'team_lead');
      await lockField('contact', 'lga', 'team_lead', 'none');

      const requested = await request(server())
        .post(EXPORTS)
        .set(SUPERVISOR)
        .send({ format: 'json', scope: 'filtered', filters: { objectType: 'contact' } });
      expectStatus(requested, 202, 'createAuditExport');
      const exportId = (requested.body as { exportId: string }).exportId;
      const polled = await request(server()).get(`${EXPORTS}/${exportId}`).set(SUPERVISOR);
      expectStatus(polled, 200, 'getAuditExport');

      for (const [where, response] of [
        ['202', requested],
        ['poll', polled],
      ] as const) {
        for (const key of Object.keys(response.body as Json)) {
          expect(EXPORT_KEYS, `${where} carries "${key}": event content or a link?`).toContain(key);
        }
        expect(leaked(response, ['T0078 Lga Alpha', 'T0078 Lga Beta']), where).toEqual([]);
      }

      const { entries, responses } = await readAll(AGENT);
      const own = entries.find((entry) => entry.objectId === exportId);
      expect(own?.objectType, 'the export is audited, readable tenant-wide').toBe('audit_export');
      for (const response of responses) {
        const exportEvents = (response.body as { items: Entry[] }).items.filter(
          (entry) => entry.objectType === 'audit_export',
        );
        expect(JSON.stringify(exportEvents)).not.toMatch(/T0078 Lga/);
      }
    });
  });
});
