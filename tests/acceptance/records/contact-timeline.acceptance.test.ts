import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_ACCOUNTS,
  SEED_ACTIVITIES,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
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
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0061, the contact timeline, the account summary on Contact,
 * and activity writes (Agent 3, M3/M6). Written by QA for the lead before the
 * build (D-L23), from the contract and the decisions, not from an
 * implementation (D-L25).
 *
 * Sources: team/tasks/T-0061-contact-timeline-api.md; the T-0059 contract
 * (`listContactTimeline`, `TimelineItem`, `Contact.account` in
 * docs/api/records.openapi.yaml) and its suite
 * (platform/records-contract-record-view); D-L53 (404 -> 403 -> 400 -> 409),
 * D-L54 and D-L63 (no PII in audit; the label is the record id), D-L64 (no raw
 * ids printed), D-L67 (owner membership), D-L72 (timeline rulings), D-L73
 * (Contact.account moves into `properties`; creation and actors are this
 * suite's to pin), D-L74 (no Postgres `detail` anywhere), D-L77 (activity
 * ordering is `created_at`), D-L78 (NUL is 400), D-L79 (server-minted ids,
 * creator from the session, owner in the programme), D-P13 (no totals), D-P18
 * (who may write activities). Schema: 0008 (audit_event), 0027 (activity).
 *
 * Fixtures are packages/db/src/fixtures.ts only, plus rows planted here by
 * `kasuwa_migrator` (BYPASSRLS, never serves) with ids in this suite's own
 * range (`...-0061xxxxxxxx`). Helpers are copied from the T-0041 and T-0055
 * suites, never imported: importing a test file registers its tests. If the
 * spec and this file disagree on something the spec states, the spec wins and
 * this file is the defect: say so in the report, do not edit it.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder must honour these exactly)
 * ==========================================================================
 *
 * T1. THE TIMELINE. `GET /api/v1/contacts/{id}/timeline`, `limit` 1..100
 *     (default 25, out of range 400, never clamped), opaque `cursor`.
 *     200 is `TimelinePage` exactly: `{ data, nextCursor }` and nothing else,
 *     no total header. `Cache-Control` carries `no-store` or `private`.
 *     `listContactTimeline` is flipped to `x-kasuwa-implemented: true`.
 *
 * T2. WHERE ITEMS COME FROM (the seam).
 *     - Audit items: every `audit_event` row with `object_type = 'contact'`
 *       and `object_id` = the contact, `created` and `updated` alike. One
 *       item per entry in `changes`. `consentState` becomes a
 *       `consent_changed` item; every other field a `field_changed` item named
 *       by its wire name.
 *     - Activity items: every `activity` row whose `contact_id` is the
 *       contact (an account may also be set). An activity on the contact's
 *       ACCOUNT only is not on the contact's timeline. One item per activity,
 *       showing its CURRENT state; completing it changes that item, never adds
 *       one, and the activity's own audit events (`object_type = 'activity'`)
 *       are never contact items.
 *     The suite plants audit rows through the migrator in exactly the shape
 *     T-0041 writes them (LEGACY, below), so history that exists on every
 *     database today is what is tested.
 *
 * T3. ITEM IDS. A string, unique per item, never the audit event id (one PATCH
 *     of three fields is three ids), the same on every read, and the same for
 *     every caller. An item's id is a function of its event and its field
 *     ONLY: adding, removing or withholding OTHER changes in the same event,
 *     or other events, never changes it. (A positional id such as "change #1
 *     of event E" tells a caller who sees #1 but not #0 that #0 exists and is
 *     hidden from them. This suite pins that.)
 *
 * T4. ORDER. `occurredAt` descending; items sharing an `occurredAt` exactly
 *     (one event; or two planted at the same instant) are ordered by `id`
 *     descending in plain code-unit order (JavaScript `>` on the strings,
 *     `COLLATE "C"` in Postgres), whatever the database's default collation.
 *     Items that differ below the millisecond (audit `occurred_at` is
 *     microseconds) render with the same `occurredAt`; for those the suite
 *     asserts only that paging neither drops nor repeats one, not their order.
 *     `occurredAt` of an activity item is the activity's `created_at` (D-L77).
 *
 * T5. FIELD SECURITY OMITS, BEFORE PAGING. Judged today, in the contact's
 *     programme, by the set the caller holds there (the T-0026 matrix, field
 *     names snake_case: `emails`, `consent_state`, `owner_user_id`,
 *     `account_id`). A withheld field's items are absent: no name, no value,
 *     no marker. `consent_changed` follows `consent_state`. A page with a
 *     non-null `nextCursor` holds exactly `limit` items, and a non-null
 *     `nextCursor` always leads to a non-empty page (a cursor computed from
 *     raw rows would say "hidden items follow").
 *     Activity items follow the ACTIVITY object's field security: a withheld
 *     `subject`, `body`, `due_at` or `completed_at` is omitted from the item.
 *
 * T6. VALUES (D-L72). `before`/`after`, in the wire type of the Contact
 *     property, for status, source, preferredChannel, preferredLanguage,
 *     whatsappOptIn (booleans), state, lga, tags (arrays) and consentState
 *     (on `consent_changed`), for events written from T-0061 on. `null` is
 *     "had none". Phones, emails, displayName, givenNames, familyName,
 *     ownerUserId and accountId are `redacted: true` with no values, and the
 *     page carries none of their values, nor the owner's or account's id or
 *     name.
 *
 * T7. LEGACY (D-L63). T-0041 records every change as
 *     `{ field, before: null, after: null, redacted: true }`, status included.
 *     Such an item renders WITHOUT `before`/`after` and, for a value field,
 *     without `redacted` (the contract's FieldChangeWithValues is closed and
 *     its `field` enum excludes the PII fields; FieldChangeRedacted's enum
 *     excludes the value fields).
 *
 * T8. CREATION (ruled here; D-L73 left it to this suite). A `created` event is
 *     rendered exactly like an update: one item per field the create SET, by
 *     the creator, at the event's time. `before` is `null` for a value field,
 *     and `unknown` for consent (the contract: a contact's consent starts at
 *     `unknown`). A field the create did not send yields no item (no
 *     "whatsappOptIn: null -> false" noise). `displayName` is always sent and
 *     never withheld, so every reader sees that, when and by whom the contact
 *     was created. No new item type: the union is closed (D-L72) and the
 *     T-0059 suite admits only field_changed, consent_changed and activity.
 *
 * T9. ACTORS (ruled here; D-L73 left it to this suite). `{ id, displayName }`
 *     for a person, `null` for the system (`actor_kind = 'system'`, or an
 *     activity with no `created_by_user_id`). The actor is the person who
 *     acted, rendered from the event, whatever their membership is NOW:
 *       - a FORMER MEMBER of the programme: shown, by name;
 *       - a TENANT ADMIN no longer in the programme: shown, by name (the flag
 *         neither hides nor widens anything);
 *       - a DISABLED user: shown, by name. A user who appears in the audit log
 *         cannot be hard-deleted (0008's actor FK is NO ACTION: "anonymised,
 *         never hard-deleted"), so "deleted" in practice is disabled or
 *         anonymised;
 *       - the name is read at READ time, never copied into the event: a rename
 *         (or anonymisation) shows on every past item at once.
 *     Never `null` for a person (that would attribute their change to the
 *     system and falsify the trail), and the item is never dropped. Why names
 *     are acceptable here when D-P23 recommends a neutral label for a former
 *     OWNER: the actor of an event in programme P was by construction a member
 *     of P when it acted (audit_event_actor_is_session plus RLS), the reader
 *     is a member of P now, and every member can already SELECT every "user"
 *     row of the tenant; this is the admin audit API's precedent too. If the
 *     lead rules otherwise for D-P23, the three actor tests are the ones that
 *     change.
 *
 * T10. AUDIT VALUES. From T-0061, an update's `audit_event.changes` record
 *     `{ field, before, after, redacted: false }` for the T6 value fields
 *     (string codes as the strings themselves: status 'new' -> 'contacted'),
 *     and `{ field, before: null, after: null, redacted: true }` for the
 *     redacted fields. No phone, email, name or account id appears anywhere
 *     in `changes`. T-0104 (D-L71): `ownerUserId` is recorded with its before
 *     and after owner ids as values; the timeline still never shows them
 *     (T6). (How tags and whatsappOptIn are encoded in the
 *     audit row is the builder's; only `redacted: false` and a non-null
 *     `after` are asserted for them.)
 *
 * T11. Contact.account. `{ id, name } | null` on get, list, create and update;
 *     `null` exactly when `accountId` is; `account.id === accountId`;
 *     withheld TOGETHER with `accountId` (both omitted, both listed). In the
 *     spec it moves from `ContactPendingProperties` into `Contact.properties`
 *     and the listContacts example rows carry it (D-L73).
 *
 * T12. ACTIVITY WRITES.
 *     createActivity  POST  /api/v1/activities                 201 Activity
 *     updateActivity  PATCH /api/v1/activities/{activityId}    200 Activity
 *     Both in records.openapi.yaml under those operationIds, implemented.
 *     - CREATE body, closed: `type` (note|task|call, required), `subject`,
 *       `body`, `dueAt` (tasks only), `ownerUserId`, `contactId`,
 *       `accountId`; at least one target. NO `programmeId`: the activity's
 *       programme is its target's (the contact's when both are given). `id`,
 *       `programmeId`, `tenantId`, `createdByUserId`, `createdAt`,
 *       `updatedAt`, `completedAt`, `version` and `withheldFields` are 400.
 *     - UPDATE body, closed: `version` (required) plus `completed: true`
 *       (complete; the server sets `completedAt`) and/or `ownerUserId`
 *       (reassign). Retargeting (`contactId`, `accountId`), `programmeId`,
 *       `createdByUserId`, `createdAt`, `completedAt`, `id` and `tenantId`
 *       are 400. A stale version is 409 `stale_write`.
 *     - Activity response: `id`, `programmeId`, `type`, `version`,
 *       `createdAt`, `updatedAt`, `withheldFields` always; `subject`, `body`,
 *       `dueAt`, `completedAt`, `ownerUserId`, `contactId`, `accountId`
 *       present or listed in `withheldFields`, never both; no `tenantId`; a
 *       `createdByUserId`, if the builder sends one, is the session user.
 *     - TARGETS: an unreachable `contactId` (or `accountId` when it is the
 *       only target) is 404 `not_found`, one body for another programme,
 *       another tenant and nowhere (it decides the programme, like
 *       createContact's `programmeId`). A second target outside the first
 *       one's programme is 400 `unknown_reference` at its path, one body
 *       whether real elsewhere or invented, even for a caller who can read
 *       both programmes.
 *     - OWNER (D-L67, D-L79): a member of the activity's programme, else 400
 *       `unknown_reference` at `ownerUserId`, one body for a member of another
 *       programme, a user of another tenant, a tenant user with no programme,
 *       and an invented id. Create and reassign alike.
 *     - IDS (D-L79): minted by the server; a client `id` is 400, the same
 *       body whether or not it names a real activity. `created_by_user_id` is
 *       the session user.
 *     - PERMISSION (D-P18): `activity.write` (name the builder's) held by the
 *       `agent`, `team_lead`, `programme_manager` and `admin` sets IN THE
 *       ACTIVITY'S PROGRAMME, or the tenant-admin flag, never beyond the
 *       session's programmes. `qa_analyst` and `client_portal` get 403
 *       `not_permitted`. Order 404, 403, 400, 409 (D-L53).
 *     - FIELD SECURITY on the activity object, as for contacts (D-L63):
 *       writing a field withheld from you is 403 with `field_not_editable`.
 *     - Completing a note or a call, or a `dueAt` on one, is 400, never a
 *       500 from 0027's CHECK. A NUL character in `subject` or `body` is 400.
 *     - AUDIT: one event per successful write, `object_type 'activity'`,
 *       `object_id` and `object_label` the activity id, `programme_id` the
 *       activity's, the session user as actor; no subject or body text
 *       anywhere in it; refused writes write none; no contact event.
 *
 * T13. EVERYWHERE. Scope headers are 400 `validation_failed`. Out of scope is
 *     404, one body, never 403 on a read. No phone, email, contact name,
 *     subject, body or Postgres `detail` in logs, spans or error bodies.
 *
 * ==========================================================================
 * THE BUILDER'S (not asserted)
 * ==========================================================================
 * Item id and cursor encodings (beyond T3); how tags/whatsappOptIn are encoded
 * in the audit row; the order of items that differ only below the
 * millisecond; whether `completed: false` reopens a task; whether the `agent`
 * set may reassign to someone else (the task gives one action; D-P18 names
 * "log and complete"); the owner when a create sends none; subject and body
 * length limits; whether a GET /activities/{id} exists; what the item does
 * when the activity's `type` or `contact_id` is withheld; whether a value
 * field sent unchanged (T-0041 records tags/state/lga "whenever sent") yields
 * an item with equal before and after.
 *
 * ==========================================================================
 * D-L23: on main no timeline or activity route exists and Contact has no
 * `account`. Every test then fails on a 404 for the route, on the missing
 * operation in the spec, or on the absent `account` property — never on a
 * harness crash. Each test that asserts a 404 also asserts a 200 control on a
 * reachable record first, so "no route" cannot pass for "out of scope". The
 * schema-checker self-test passes on main by design (it tests the checker).
 *
 * Writes: the suite reseeds before and after, and after every test.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures (packages/db/src/fixtures.ts, never a second set).
// ---------------------------------------------------------------------------

const CONTACTS = '/api/v1/contacts';
const ACTIVITIES = '/api/v1/activities';
const contactPath = (id: string) => `${CONTACTS}/${id}`;
const timelinePath = (id: string) => `${CONTACTS}/${id}/timeline`;
const activityPath = (id: string) => `${ACTIVITIES}/${id}`;

/** This suite's id range: `0061` marks T-0061. */
const id61 = (tail: string) => `11111111-0000-4000-8000-0061${tail.padStart(8, '0')}`;
/** Never a real row. */
const NOWHERE = id61('ffff');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

function seededContact(givenNames: string) {
  const contact = SEED_CONTACTS.find((candidate) => candidate.givenNames === givenNames);
  if (contact === undefined) throw new Error(`Fixture drift: no seeded contact '${givenNames}'`);
  return contact;
}

/** Tenant A, A1. */
const AMAKA = seededContact('Amaka');
const BASHIR = seededContact('Bashir');
/** Tenant A, A2. */
const DAMILOLA = seededContact('Damilola');
/** Tenant B, B1. */
const GRACE = seededContact('Grace');

function seededAccount(programmeId: string) {
  const account = SEED_ACCOUNTS.find((candidate) => candidate.programmeId === programmeId);
  if (account === undefined) throw new Error(`Fixture drift: no seeded account in ${programmeId}`);
  return account;
}

/** "Ikoyi Traders", A1. */
const IKOYI = seededAccount(PROGRAMME_A1);
/** "Sabon Gari Mart", A2. */
const SABON = seededAccount(PROGRAMME_A2);
/** "Westlands Supplies", tenant B. */
const WESTLANDS = seededAccount(PROGRAMME_B1);

/** The seeded tenant-B activity (D-L77 fixture). */
const SEEDED_B_ACTIVITY = (() => {
  const found = SEED_ACTIVITIES.find((activity) => activity.tenantId === TENANT_B);
  if (found === undefined) throw new Error('Fixture drift: no seeded tenant-B activity');
  return found;
})();

function displayNameOf(userId: string): string {
  for (const tenant of SEED_TENANTS) {
    const user = tenant.users.find((candidate) => candidate.id === userId);
    if (user !== undefined) return user.displayName;
  }
  throw new Error(`Fixture drift: no seeded user ${userId}`);
}

function permissionSet(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) throw new Error(`Fixture drift: no seeded permission set '${key}'`);
  return set.id;
}

/** D-P18: these sets hold activity.write in their programme. */
const ACTIVITY_WRITERS = ['agent', 'team_lead', 'programme_manager', 'admin'] as const;
/** D-P18: these do not. */
const ACTIVITY_READERS = ['qa_analyst', 'client_portal'] as const;

/** D-L72: the fields whose values the timeline carries (consentState via consent_changed). */
const VALUE_FIELDS = [
  'status',
  'source',
  'preferredChannel',
  'preferredLanguage',
  'whatsappOptIn',
  'state',
  'lga',
  'tags',
] as const;
/** D-L72 and the contract's FieldChangeRedacted: never a value. */
const REDACTED_FIELDS = [
  'displayName',
  'givenNames',
  'familyName',
  'phones',
  'emails',
  'ownerUserId',
  'accountId',
] as const;

/** Unique per run so a probe never matches an earlier, unreseeded run. */
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency).
// The T-0041 checker, plus `allOf` and `const`, which the timeline schemas use
// (ConsentChangedItem's `before` is an allOf of ConsentState; every item's
// `type` is a const). `discriminator` is ignored: `oneOf` decides.
// ---------------------------------------------------------------------------

const SPEC_PATH = resolve(__dirname, '../../../docs/api/records.openapi.yaml');
const docCache = new Map<string, unknown>();

function loadDoc(file: string): unknown {
  let doc = docCache.get(file);
  if (doc === undefined) {
    doc = parse(readFileSync(file, 'utf8')) as unknown;
    docCache.set(file, doc);
  }
  return doc;
}

function atPointer(doc: unknown, fragment: string): unknown {
  let node = doc;
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    if (raw === '') continue;
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = (node as Json | undefined)?.[key];
  }
  if (node === undefined) throw new Error(`schema pointer #${fragment} resolves to nothing`);
  return node;
}

interface Located {
  schema: Json;
  file: string;
}

function deref(schema: Json, file: string): Located {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return { schema, file };
  const [relative, fragment = ''] = ref.split('#');
  const target =
    relative === undefined || relative === '' ? file : resolve(dirname(file), relative);
  return deref(atPointer(loadDoc(target), fragment) as Json, target);
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

const FORMATS: Record<string, RegExp> = {
  uuid: UUID,
  // The contract: "Times are UTC, ISO 8601, with a Z".
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
};

function check(input: Json, file: string, value: unknown, path: string, errors: string[]): void {
  const { schema, file: at } = deref(input, file);

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf as Json[]) check(part, at, value, path, errors);
  }

  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Json[]).filter((branch) => {
      const branchErrors: string[] = [];
      check(branch, at, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (passing.length !== 1) {
      errors.push(
        `${path}: matches ${passing.length} oneOf branches (value ${JSON.stringify(value)})`,
      );
    }
  }

  if ('const' in schema && schema.const !== value) {
    errors.push(
      `${path}: ${JSON.stringify(value)} is not the const ${JSON.stringify(schema.const)}`,
    );
  }

  const actual = jsonType(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type)
      ? (schema.type as string[])
      : [schema.type as string];
    const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!ok) {
      errors.push(`${path}: type ${actual}, schema allows ${allowed.join('|')}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format !== undefined && !format.test(value)) {
      errors.push(`${path}: not a valid ${String(schema.format)}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.items !== undefined && typeof schema.items === 'object') {
      value.forEach((item, index) =>
        check(schema.items as Json, at, item, `${path}[${index}]`, errors),
      );
    }
  }

  if (actual === 'object') {
    const object = value as Json;
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) errors.push(`${path}: required property "${key}" is missing`);
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) {
        check(childSchema, at, child, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: property "${key}" is not allowed`);
      }
    }
  }
}

function schemaAt(name: string): Json {
  return { $ref: `#/components/schemas/${name}` };
}

function schemaErrors(schema: Json, value: unknown, where: string): string[] {
  const errors: string[] = [];
  check(schema, SPEC_PATH, value, where, errors);
  return errors;
}

/** Validates against a schema in records.openapi.yaml and fails with every error at once. */
function expectSchema(value: unknown, schemaName: string, where: string): void {
  expect(
    schemaErrors(schemaAt(schemaName), value, where),
    `${where} does not match #/components/schemas/${schemaName}`,
  ).toEqual([]);
}

interface SpecOperation {
  path: string;
  method: string;
  op: Json;
}

function specPaths(): Record<string, Record<string, unknown>> {
  return ((loadDoc(SPEC_PATH) as Json).paths ?? {}) as Record<string, Record<string, unknown>>;
}

function findOperation(operationId: string): SpecOperation | undefined {
  for (const [path, item] of Object.entries(specPaths())) {
    for (const [method, op] of Object.entries(item)) {
      if (typeof op === 'object' && op !== null && (op as Json).operationId === operationId) {
        return { path, method, op: op as Json };
      }
    }
  }
  return undefined;
}

function requireOperation(operationId: string): SpecOperation {
  const found = findOperation(operationId);
  if (found === undefined) {
    throw new Error(`records.openapi.yaml has no operation ${operationId} (T12)`);
  }
  return found;
}

/** The JSON schema of one documented response of an operation. */
function responseSchemaOf(operationId: string, status: string): Json {
  const { op } = requireOperation(operationId);
  const raw = ((op.responses ?? {}) as Json)[status] as Json | undefined;
  if (raw === undefined) throw new Error(`${operationId} documents no ${status} response`);
  const response = deref(raw, SPEC_PATH).schema;
  const schema = ((response.content as Json | undefined)?.['application/json'] as Json | undefined)
    ?.schema as Json | undefined;
  if (schema === undefined) throw new Error(`${operationId} ${status} has no JSON schema`);
  return schema;
}

/** Every property `Contact` names — read from the spec, not restated. */
function contactProperties(): string[] {
  const { schema } = deref(schemaAt('Contact'), SPEC_PATH);
  return Object.keys((schema.properties ?? {}) as Json);
}

/**
 * T-0089 / D-L143 (lead edit): the properties of Contact's pending allOf part
 * (`ContactPendingProperties`: `custom`, placed there by the T-0088 pin).
 * Admitted on a served record, never required.
 */
function contactPendingProperties(): string[] {
  // Read through Contact's own allOf, so the helper keeps working once the part is gone.
  const { schema, file } = deref(schemaAt('Contact'), SPEC_PATH);
  const parts = Array.isArray(schema.allOf) ? (schema.allOf as Json[]) : [];
  return parts.flatMap((part) => Object.keys((deref(part, file).schema.properties ?? {}) as Json));
}

/** Never withheld, per the Contact schema's description. */
const NEVER_WITHHELD = [
  'id',
  'programmeId',
  'version',
  'displayName',
  'createdAt',
  'updatedAt',
  'withheldFields',
];

/**
 * `Contact` plus the T-0041 readings: no unnamed property, and every property
 * either present or listed in `withheldFields`, exactly one of the two.
 */
function expectContact(value: unknown, where: string): Json {
  expectSchema(value, 'Contact', where);
  const contact = value as Json;
  const named = contactProperties();
  const pending = contactPendingProperties();
  const extra = Object.keys(contact).filter((key) => !named.includes(key) && !pending.includes(key));
  expect(extra, `${where} carries properties Contact.properties does not name`).toEqual([]);
  const withheld = Array.isArray(contact.withheldFields)
    ? (contact.withheldFields as string[])
    : [];
  const problems: string[] = [];
  for (const name of withheld) {
    if (NEVER_WITHHELD.includes(name)) problems.push(`${name} is never withheld`);
    if (name in contact) problems.push(`${name} is withheld but present`);
    if (!named.includes(name)) problems.push(`${name} is not a Contact property`);
  }
  for (const name of named) {
    if (!(name in contact) && !withheld.includes(name)) {
      problems.push(`${name} is neither present nor listed in withheldFields`);
    }
  }
  expect(problems, `${where}: field-security omission rule`).toEqual([]);
  return contact;
}

/** T11: the account summary, explicitly (Contact's own check cannot see it on main). */
function expectAccountSummary(contact: Json, where: string): void {
  const withheld = (contact.withheldFields ?? []) as string[];
  if (withheld.includes('accountId')) {
    expect(withheld, `${where}: account is withheld together with accountId`).toContain('account');
    expect('account' in contact, `${where}: a withheld account is omitted`).toBe(false);
    return;
  }
  expect('account' in contact, `${where}: Contact.account is not served (T11)`).toBe(true);
  expect(withheld, `${where}: account withheld while accountId is not`).not.toContain('account');
  if (contact.accountId === null) {
    expect(contact.account, `${where}: account is null exactly when accountId is`).toBeNull();
  } else {
    const account = contact.account as Json | null;
    expect(account, `${where}: account is null while accountId is set`).not.toBeNull();
    expect(Object.keys(account ?? {}).sort(), `${where}: the summary is closed`).toEqual([
      'id',
      'name',
    ]);
    expect(account?.id, `${where}: account.id equals accountId`).toBe(contact.accountId);
  }
}

/** admin.openapi.yaml `Error`, with the status and `code` the operation names. */
function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, got ${response.status} ${JSON.stringify(response.body)}`,
  ).toBe(status);
  expect(
    schemaErrors(
      { $ref: './admin.openapi.yaml#/components/schemas/Error' },
      response.body,
      'Error',
    ),
    'response body does not match the shared Error schema',
  ).toEqual([]);
  const body = response.body as Json;
  expect(body.statusCode, 'Error.statusCode').toBe(status);
  expect(body.code, 'Error.code — clients switch on this, never on message').toBe(code);
  return body;
}

function detailsOf(body: Json): { path: string; code: string }[] {
  return Array.isArray(body.details) ? (body.details as { path: string; code: string }[]) : [];
}

function expectStatus(response: request.Response, status: number, where: string): void {
  expect(response.status, `${where}: ${JSON.stringify(response.body)}`).toBe(status);
}

/** The URL is identical for every user of every tenant; a shared cache must not keep it. */
function expectNotShared(response: request.Response, where: string): void {
  expect(
    String(response.headers['cache-control'] ?? ''),
    `${where}: Cache-Control must keep per-user rows out of shared caches`,
  ).toMatch(/no-store|private/);
}

/** D-P13: a count in a header is a total by another name. */
function expectNoTotals(response: request.Response, where: string): void {
  const headers = Object.keys(response.headers).filter((name) => /total|count/i.test(name));
  expect(headers, `${where}: a response header carries a total`).toEqual([]);
}

// ---------------------------------------------------------------------------
// Timeline shapes (T1, T4, T9).
// ---------------------------------------------------------------------------

const ITEM_TYPES = ['field_changed', 'consent_changed', 'activity'];
/** T9: the activity item, exactly these keys (`type` is the discriminator). */
const ACTIVITY_ITEM_KEYS = [
  'id',
  'type',
  'occurredAt',
  'actor',
  'activityId',
  'activityType',
  'subject',
  'body',
  'dueAt',
  'completedAt',
  // T-0082: a meeting's times, on every activity item (null off a meeting).
  'startsAt',
  'endsAt',
  // T-0080 (D-L85): the row's version, so a served task can be completed. Never withheld.
  'version',
];
/** T5: activity-object fields an item omits when withheld. */
// T-0082 (D-L107): a withheld meeting time is omitted, the item stays.
const ACTIVITY_ITEM_WITHHOLDABLE = [
  'subject',
  'body',
  'dueAt',
  'completedAt',
  'startsAt',
  'endsAt',
];
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function activityItemProblems(item: Json, where: string): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(item)) {
    if (!ACTIVITY_ITEM_KEYS.includes(key)) problems.push(`${where}: unexpected key ${key}`);
  }
  for (const key of ACTIVITY_ITEM_KEYS) {
    if (!ACTIVITY_ITEM_WITHHOLDABLE.includes(key) && !(key in item)) {
      problems.push(`${where}: ${key} missing`);
    }
  }
  if (typeof item.activityId !== 'string' || !UUID.test(item.activityId)) {
    problems.push(`${where}: activityId is not a uuid`);
  }
  if (!['note', 'task', 'call', 'meeting'].includes(item.activityType as string)) {
    problems.push(`${where}: activityType ${JSON.stringify(item.activityType)}`);
  }
  for (const key of ['subject', 'body']) {
    if (key in item && item[key] !== null && typeof item[key] !== 'string') {
      problems.push(`${where}: ${key} is not a string or null`);
    }
  }
  for (const key of ['dueAt', 'completedAt', 'startsAt', 'endsAt']) {
    if (key in item && item[key] !== null && !DATE_TIME.test(String(item[key]))) {
      problems.push(`${where}: ${key} is not a date-time or null`);
    }
  }
  return problems;
}

function actorProblems(item: Json, where: string): string[] {
  if (!('actor' in item)) return [`${where}: actor missing`];
  const actor = item.actor;
  if (actor === null) return [];
  if (typeof actor !== 'object') return [`${where}: actor is not an object or null`];
  const keys = Object.keys(actor as Json).sort();
  const problems: string[] = [];
  if (keys.join() !== 'displayName,id') problems.push(`${where}: actor keys ${keys.join()}`);
  if (!UUID.test(String((actor as Json).id))) problems.push(`${where}: actor.id not a uuid`);
  if (typeof (actor as Json).displayName !== 'string') {
    problems.push(`${where}: actor.displayName not a string`);
  }
  return problems;
}

/** T4: newest first; exact ties broken by id descending (code units). */
function orderProblems(items: Json[], strictTies: boolean): string[] {
  const problems: string[] = [];
  for (let index = 1; index < items.length; index += 1) {
    const newer = items[index - 1] ?? {};
    const older = items[index] ?? {};
    const a = Date.parse(String(newer.occurredAt));
    const b = Date.parse(String(older.occurredAt));
    if (a < b) problems.push(`[${index}] is newer than [${index - 1}]`);
    if (strictTies && a === b && !(String(newer.id) > String(older.id))) {
      problems.push(`[${index - 1}] and [${index}] share occurredAt and ids are not descending`);
    }
  }
  return problems;
}

function timelinePageProblems(
  value: unknown,
  where: string,
): { problems: string[]; page: { data: Json[]; nextCursor: string | null } } {
  const problems = schemaErrors(schemaAt('TimelinePage'), value, where);
  const page = (value ?? {}) as { data: Json[]; nextCursor: string | null };
  if (Object.keys(page).sort().join() !== 'data,nextCursor') {
    problems.push(
      `${where}: the page carries ${Object.keys(page).join()}, not data and nextCursor`,
    );
  }
  const data = Array.isArray(page.data) ? page.data : [];
  data.forEach((item, index) => {
    const at = `${where}.data[${index}]`;
    if (typeof item.id !== 'string' || item.id === '') problems.push(`${at}: id`);
    if (!ITEM_TYPES.includes(item.type as string))
      problems.push(`${at}: type ${String(item.type)}`);
    problems.push(...actorProblems(item, at));
    if (item.type === 'activity') problems.push(...activityItemProblems(item, at));
  });
  return { problems, page: { data, nextCursor: page.nextCursor ?? null } };
}

function expectTimelinePage(
  value: unknown,
  where: string,
  strictTies = true,
): { data: Json[]; nextCursor: string | null } {
  const { problems, page } = timelinePageProblems(value, where);
  expect(problems, `${where} is not a TimelinePage`).toEqual([]);
  expect(orderProblems(page.data, strictTies), `${where}: order (T4)`).toEqual([]);
  return page;
}

const fieldItems = (items: Json[], field: string) =>
  items.filter((item) => item.type === 'field_changed' && item.field === field);
const consentItems = (items: Json[]) => items.filter((item) => item.type === 'consent_changed');
const activityItems = (items: Json[]) => items.filter((item) => item.type === 'activity');

/** A comparable signature of one item: type, field, values, actor. */
function signature(item: Json): string {
  const actor = item.actor as Json | null;
  return JSON.stringify({
    type: item.type,
    field: item.field ?? null,
    before: 'before' in item ? item.before : '(absent)',
    after: 'after' in item ? item.after : '(absent)',
    redacted: 'redacted' in item ? item.redacted : '(absent)',
    actor: actor === null ? null : actor.id,
  });
}

// ---------------------------------------------------------------------------
// Log capture: every channel the process can write to (the T-0036 approach).
// ---------------------------------------------------------------------------

let captureLines: string[] | null = null;

function render(value: unknown): string {
  return typeof value === 'string'
    ? value
    : inspect(value, { depth: 12, breakLength: Number.POSITIVE_INFINITY });
}

/** The application logger: records raw arguments while a capture is open, prints nothing. */
class RecordingLogger extends ConsoleLogger {
  private record(args: unknown[]): void {
    captureLines?.push(args.map(render).join(' '));
  }
  override log(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override error(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override warn(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override debug(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override verbose(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
  override fatal(message: unknown, ...rest: unknown[]): void {
    this.record([message, ...rest]);
  }
}

async function captureEverything(
  work: () => Promise<void>,
): Promise<{ telemetry: Telemetry; lines: string[] }> {
  const lines: string[] = [];
  captureLines = lines;
  const toLines = (chunk: unknown) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
    for (const line of text.split('\n')) if (line !== '') lines.push(line);
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      toLines(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      toLines(chunk);
      return true;
    }),
    ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(render).join(' '));
      }),
    ),
  ];
  let telemetry: Telemetry;
  try {
    telemetry = await collectTelemetry(work);
  } finally {
    for (const spy of spies) spy.mockRestore();
    captureLines = null;
  }
  return { telemetry, lines: [...lines, ...telemetry.logs.map((record) => render(record))] };
}

/** Every form a phone number can take on its way into a log line. */
function phoneForms(e164: string): string[] {
  const digits = e164.replace(/^\+/, '');
  const national = digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
  return [...new Set([e164, encodeURIComponent(e164), digits, national])];
}

/** A Postgres `detail` carries the row (D-L74), body text included. */
const ROW_DETAIL = 'Failing row contains';
/** Database text an error BODY must never carry (admin's Error.details). */
const DATABASE_TEXT_IN_BODIES = [ROW_DETAIL, 'violates', 'constraint', '23514', '23503', '22021'];

// ---------------------------------------------------------------------------

describe('acceptance: contact timeline, account summary and activity writes (T-0061)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants values and observes rows; never serves. */
  let observer: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 })),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
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

  // --- HTTP helpers -------------------------------------------------------

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const timeline = (headers: Headers, contactId: string, params: Params = []) =>
    request(server())
      .get(withQuery(timelinePath(contactId), params))
      .set(headers);
  const listContacts = (headers: Headers, params: Params = []) =>
    request(server()).get(withQuery(CONTACTS, params)).set(headers);
  const getContact = (headers: Headers, id: string) =>
    request(server()).get(contactPath(id)).set(headers);
  const createContact = (headers: Headers, body: unknown) =>
    request(server())
      .post(CONTACTS)
      .set(headers)
      .send(body as object);
  const updateContact = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(contactPath(id))
      .set(headers)
      .send(body as object);
  const createActivity = (headers: Headers, body: unknown) =>
    request(server())
      .post(ACTIVITIES)
      .set(headers)
      .send(body as object);
  const updateActivity = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(activityPath(id))
      .set(headers)
      .send(body as object);

  /** One read of the whole timeline (limit 100), validated. */
  async function readTimeline(headers: Headers, contactId: string, where: string): Promise<Json[]> {
    const response = await timeline(headers, contactId, [['limit', '100']]);
    expectStatus(response, 200, where);
    const page = expectTimelinePage(response.body, where);
    expect(
      page.nextCursor,
      `${where}: more than 100 items; this suite never plants that many`,
    ).toBeNull();
    return page.data;
  }

  /**
   * Walks every page (T5): a page with a cursor is full, a cursor never leads
   * to an empty page, no item repeats, and the whole walk is in order.
   */
  async function walk(
    headers: Headers,
    contactId: string,
    limit: number,
    strictTies = true,
  ): Promise<{ items: Json[]; sizes: number[] }> {
    const items: Json[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const params: [string, string][] = [['limit', String(limit)]];
      if (cursor !== null) params.push(['cursor', cursor]);
      const response = await timeline(headers, contactId, params);
      expectStatus(response, 200, `page ${pages + 1} at limit ${limit}`);
      expectNotShared(response, 'timeline');
      expectNoTotals(response, 'timeline');
      const page = expectTimelinePage(response.body, `page ${pages + 1}`, strictTies);
      sizes.push(page.data.length);
      if (page.nextCursor !== null) {
        expect(
          page.data.length,
          `page ${pages + 1} has a nextCursor but ${page.data.length} of ${limit} items: ` +
            'withheld items were omitted after the page was cut (T5)',
        ).toBe(limit);
      }
      if (pages > 0) {
        expect(
          page.data.length,
          'a nextCursor led to an empty page: the cursor said more items exist (T5)',
        ).toBeGreaterThan(0);
      }
      items.push(...page.data);
      cursor = page.nextCursor;
      pages += 1;
      if (pages > 120) throw new Error('timeline paging did not terminate');
    } while (cursor !== null);
    const ids = items.map((item) => String(item.id));
    expect(new Set(ids).size, 'an item was repeated across pages').toBe(ids.length);
    expect(orderProblems(items, strictTies), 'the walk as a whole is newest first (T4)').toEqual(
      [],
    );
    return { items, sizes };
  }

  // --- observer helpers ----------------------------------------------------

  async function contactRow(id: string): Promise<Json | null> {
    const result = await observer.query<Json>('SELECT * FROM contact WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async function versionOf(id: string): Promise<number> {
    return Number((await contactRow(id))?.version);
  }

  async function plantContact(id: string, values: Record<string, unknown>) {
    const columns = Object.keys(values);
    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
    await observer.query(`UPDATE contact SET ${assignments} WHERE id = $1`, [
      id,
      ...columns.map((column) => values[column]),
    ]);
  }

  async function activityRow(id: string): Promise<Json | null> {
    const result = await observer.query<Json>('SELECT * FROM activity WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }

  async function activityCount(): Promise<number> {
    const result = await observer.query<{ n: number }>('SELECT count(*)::int AS n FROM activity');
    return result.rows[0]?.n ?? -1;
  }

  interface PlantedActivity {
    id: string;
    programmeId?: string;
    tenantId?: string;
    type: 'note' | 'task' | 'call';
    subject?: string | null;
    body?: string | null;
    contactId?: string | null;
    accountId?: string | null;
    ownerUserId?: string | null;
    createdByUserId?: string | null;
    dueAt?: string | null;
    createdAt?: string | null;
  }

  async function plantActivity(activity: PlantedActivity) {
    await observer.query(
      `INSERT INTO activity (id, tenant_id, programme_id, type, subject, body, owner_user_id,
                             contact_id, account_id, created_by_user_id, due_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12::timestamptz, now()))`,
      [
        activity.id,
        activity.tenantId ?? TENANT_A,
        activity.programmeId ?? PROGRAMME_A1,
        activity.type,
        activity.subject ?? null,
        activity.body ?? null,
        activity.ownerUserId ?? null,
        activity.contactId ?? null,
        activity.accountId ?? null,
        activity.createdByUserId ?? null,
        activity.dueAt ?? null,
        activity.createdAt ?? null,
      ],
    );
  }

  interface Change {
    field: string;
    before: string | null;
    after: string | null;
    redacted: boolean;
  }

  /** T7: the shape T-0041 writes for every contact change. */
  const legacy = (field: string): Change => ({ field, before: null, after: null, redacted: true });

  interface PlantedEvent {
    id?: string;
    contactId: string;
    programmeId?: string;
    occurredAt: string;
    /** null is the system. */
    actorUserId: string | null;
    action?: 'created' | 'updated';
    changes: Change[];
  }

  /** Plants one contact audit event, as T-0041 (or a system writer) would have. */
  async function plantEvent(event: PlantedEvent): Promise<string> {
    const id = event.id ?? randomUUID();
    await observer.query(
      `INSERT INTO audit_event (id, tenant_id, occurred_at, actor_kind, actor_user_id, action,
                                object_type, object_id, object_label, programme_id, changes)
       VALUES ($1, $2, $3, $4, $5, $6, 'contact', $7, $8, $9, $10::jsonb)`,
      [
        id,
        TENANT_A,
        event.occurredAt,
        event.actorUserId === null ? 'system' : 'user',
        event.actorUserId,
        event.action ?? 'updated',
        event.contactId,
        event.contactId,
        event.programmeId ?? PROGRAMME_A1,
        JSON.stringify(event.changes),
      ],
    );
    return id;
  }

  interface AuditRow {
    id: string;
    tenant_id: string;
    actor_kind: string;
    actor_user_id: string | null;
    action: string;
    object_type: string;
    object_id: string | null;
    object_label: string;
    programme_id: string | null;
    changes: Change[];
  }

  async function auditIds(): Promise<Set<string>> {
    const result = await observer.query<{ id: string }>('SELECT id FROM audit_event');
    return new Set(result.rows.map((row) => row.id));
  }

  async function auditSince(before: Set<string>): Promise<AuditRow[]> {
    const result = await observer.query<AuditRow>('SELECT * FROM audit_event ORDER BY occurred_at');
    return result.rows.filter((row) => !before.has(row.id));
  }

  async function assign(userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSet(TENANT_A, key)],
    );
  }

  async function unassign(userId: string, programmeId: string) {
    await observer.query('DELETE FROM user_programme WHERE user_id = $1 AND programme_id = $2', [
      userId,
      programmeId,
    ]);
  }

  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  /** One field-security decision in tenant A, against the standard field_def the seed holds. */
  async function lockField(
    objectApiName: 'contact' | 'activity',
    field: string,
    setKey: string,
    level: 'none' | 'read' | 'edit',
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
          '(T-0053 / T-0060 seed them). This suite plants grants, never field definitions.',
      );
    }
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
    );
  }

  /** A task in A1 on Amaka, owned by agent 1, logged by the supervisor. */
  async function plantTask(id: string, extra: Partial<PlantedActivity> = {}) {
    await plantActivity({
      id,
      type: 'task',
      subject: 'T0061 planted task',
      body: 'Invented text that names no one.',
      contactId: AMAKA.id,
      ownerUserId: USER_A_AGENT_1,
      createdByUserId: USER_A_SUPERVISOR,
      dueAt: '2026-12-01T09:00:00.000Z',
      ...extra,
    });
  }

  /** A minimal valid activity create on Amaka (A1). */
  const noteBody = (extra: Json = {}): Json => ({
    type: 'note',
    subject: `T0061 note ${RUN}`,
    body: 'Invented text that names no one.',
    contactId: AMAKA.id,
    ...extra,
  });

  // =========================================================================
  // 0. The contract records the slice.
  // =========================================================================

  describe('the contract records the slice (records.openapi.yaml)', () => {
    it('(self-check) the checkers accept the contract’s timeline example and reject broken copies of it', () => {
      // Passes on main by design: it tests this file's checkers, not the API.
      // A checker only ever seen passing proves nothing.
      const op = requireOperation('listContactTimeline');
      const ok = (((op.op.responses as Json)['200'] as Json).content as Json)[
        'application/json'
      ] as Json;
      const example = ok.example as { data: Json[]; nextCursor: string | null };
      expectTimelinePage(example, 'contract example');

      const [status, phones, consent] = example.data;
      const mutants: [string, unknown][] = [
        ['a page with a total', { ...example, total: 3 }],
        ['a status item marked redacted', { ...example, data: [{ ...status, redacted: true }] }],
        [
          'a phones item with values',
          { ...example, data: [{ ...phones, before: 'x', after: 'y' }] },
        ],
        [
          'an actor with an email',
          {
            ...example,
            data: [{ ...status, actor: { ...(status?.actor as Json), email: 'a@b.c' } }],
          },
        ],
        ['a consent label as a value', { ...example, data: [{ ...consent, after: 'Opted in' }] }],
        [
          'an item without an id',
          {
            ...example,
            data: [Object.fromEntries(Object.entries(status ?? {}).filter(([k]) => k !== 'id'))],
          },
        ],
        ['a tie in ascending id order', { ...example, data: [phones, status] }],
        ['an unknown item type', { ...example, data: [{ ...status, type: 'whatsapp_message' }] }],
      ];
      for (const [label, mutant] of mutants) {
        const { problems, page } = timelinePageProblems(mutant, label);
        const all = [...problems, ...orderProblems(page.data, true)];
        expect(all.length, `the checker accepted a page with ${label}`).toBeGreaterThan(0);
      }
    });

    it('marks the timeline implemented and documents createActivity and updateActivity at the pinned paths (T12)', () => {
      expect(
        requireOperation('listContactTimeline').op['x-kasuwa-implemented'],
        'listContactTimeline',
      ).toBe(true);
      const create = requireOperation('createActivity');
      expect([create.method, create.path]).toEqual(['post', ACTIVITIES]);
      expect(create.op['x-kasuwa-implemented'], 'createActivity').toBe(true);
      const update = requireOperation('updateActivity');
      expect(update.method).toBe('patch');
      expect(update.path).toMatch(/^\/api\/v1\/activities\/\{[A-Za-z]+\}$/);
      expect(update.op['x-kasuwa-implemented'], 'updateActivity').toBe(true);
    });

    it('the timeline union has an activity branch', () => {
      /** The `type` values a schema admits, looking through nested oneOf (FieldChangedItem). */
      const typesOf = (node: Json): unknown[] => {
        const { schema } = deref(node, SPEC_PATH);
        if (Array.isArray(schema.oneOf)) return (schema.oneOf as Json[]).flatMap(typesOf);
        const type = ((schema.properties ?? {}) as Json).type as Json | undefined;
        if (type === undefined) return [];
        return 'const' in type ? [type.const] : Array.isArray(type.enum) ? type.enum : [];
      };
      const types = [...new Set(typesOf(schemaAt('TimelineItem')))];
      expect(types, 'TimelineItem branches').toEqual(
        expect.arrayContaining(['field_changed', 'consent_changed', 'activity']),
      );
    });

    it('Contact.account is in Contact.properties, no longer pending, and in the listContacts example (D-L73)', () => {
      const { schema } = deref(schemaAt('Contact'), SPEC_PATH);
      const properties = (schema.properties ?? {}) as Record<string, Json>;
      expect(Object.keys(properties), 'Contact.properties').toContain('account');
      expect(properties.account?.['x-kasuwa-implemented'], 'account still marked pending').not.toBe(
        false,
      );
      const schemas = ((loadDoc(SPEC_PATH) as Json).components as Json).schemas as Record<
        string,
        Json
      >;
      const pending = schemas.ContactPendingProperties;
      if (pending !== undefined) {
        expect(
          Object.keys((pending.properties ?? {}) as Json),
          'ContactPendingProperties still lists account',
        ).not.toContain('account');
      }
      const list = requireOperation('listContacts');
      const ok = (((list.op.responses as Json)['200'] as Json).content as Json)[
        'application/json'
      ] as Json;
      const rows = ((ok.example as Json).data ?? []) as Json[];
      expect(rows.length, 'the listContacts example has no rows').toBeGreaterThan(0);
      rows.forEach((row, index) => {
        expectContact(row, `listContacts example row ${index}`);
        expectAccountSummary(row, `listContacts example row ${index}`);
      });
    });
  });

  // =========================================================================
  // 1. Timeline: shape, ids and order.
  // =========================================================================

  describe('timeline: shape, item ids and order', () => {
    it('a contact with no history is an empty page, no-store, no totals', async () => {
      // Seeded contacts have no audit events and no activities.
      const response = await timeline(AGENT_1, AMAKA.id);
      expectStatus(response, 200, 'empty timeline');
      expectNotShared(response, 'timeline');
      expectNoTotals(response, 'timeline');
      const page = expectTimelinePage(response.body, 'empty timeline');
      expect(page).toEqual({ data: [], nextCursor: null });
    });

    it('one PATCH of three fields is three items: distinct ids, none the audit event id, one occurredAt, ids descending, stable', async () => {
      await plantContact(AMAKA.id, { status: 'new' });
      const before = await auditIds();
      const response = await updateContact(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        status: 'contacted',
        preferredChannel: 'whatsapp',
        lga: 'Ikeja',
      });
      expectStatus(response, 200, 'PATCH');
      const events = await auditSince(before);
      expect(events, 'one PATCH, one audit event').toHaveLength(1);
      const eventId = events[0]?.id ?? '';

      const first = await readTimeline(AGENT_1, AMAKA.id, 'first read');
      expect(first.map((item) => item.field).sort()).toEqual(['lga', 'preferredChannel', 'status']);
      const ids = first.map((item) => String(item.id));
      expect(new Set(ids).size, 'item ids are per item').toBe(3);
      for (const id of ids) {
        expect(id.toLowerCase(), 'an item id is never the audit event id').not.toBe(eventId);
      }
      expect(new Set(first.map((item) => item.occurredAt)).size, 'one event, one instant').toBe(1);
      expect(first.map((item) => item.actor)).toEqual(
        Array(3).fill({ id: USER_A_SUPERVISOR, displayName: displayNameOf(USER_A_SUPERVISOR) }),
      );

      const second = await readTimeline(AGENT_1, AMAKA.id, 'second read');
      expect(
        second.map((item) => item.id),
        'ids are stable across reads',
      ).toEqual(ids);
      const supervisor = await readTimeline(SUPERVISOR, AMAKA.id, 'supervisor read');
      expect(
        supervisor.map((item) => item.id),
        'ids do not depend on the caller',
      ).toEqual(ids);
    });

    it('an item id depends only on its event and field, never on what else the event or timeline holds (T3)', async () => {
      // A positional id ("change #1 of event E") would tell an agent who sees
      // #1 but not #0 that a hidden change exists.
      const EVENT = id61('e0001');
      const AT = '2026-05-02T10:00:00.000Z';
      await lockField('contact', 'emails', 'agent', 'none');
      await lockField('contact', 'consent_state', 'agent', 'none');
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: '2026-05-01T10:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [legacy('emails')],
      });
      await plantEvent({
        id: EVENT,
        contactId: AMAKA.id,
        occurredAt: AT,
        actorUserId: USER_A_SUPERVISOR,
        changes: [legacy('emails'), legacy('status'), legacy('consentState')],
      });
      const crowded = await readTimeline(AGENT_1, AMAKA.id, 'with hidden neighbours');
      expect(
        crowded.map((item) => item.field),
        'the agent sees the status change only',
      ).toEqual(['status']);
      const crowdedId = crowded[0]?.id;
      const supervisor = await readTimeline(SUPERVISOR, AMAKA.id, 'supervisor');
      expect(supervisor, 'control: the supervisor sees all four').toHaveLength(4);
      expect(fieldItems(supervisor, 'status')[0]?.id).toBe(crowdedId);

      // The same event with nothing else in it, and no other event.
      await reseed(inject('migrationUrl'));
      await plantEvent({
        id: EVENT,
        contactId: AMAKA.id,
        occurredAt: AT,
        actorUserId: USER_A_SUPERVISOR,
        changes: [legacy('status')],
      });
      const alone = await readTimeline(AGENT_1, AMAKA.id, 'alone');
      expect(
        alone.map((item) => item.id),
        'the id moved with the hidden changes',
      ).toEqual([crowdedId]);
    });

    it('newest first across events and activities, by occurredAt (activities by created_at)', async () => {
      await plantContact(AMAKA.id, { status: 'new' });
      const first = await updateContact(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        status: 'contacted',
      });
      expectStatus(first, 200, 'first PATCH');
      const logged = await createActivity(SUPERVISOR, noteBody());
      expectStatus(logged, 201, 'activity');
      const activityId = String((logged.body as Json).id);
      const second = await updateContact(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        status: 'qualified',
        lga: 'Ikeja',
      });
      expectStatus(second, 200, 'second PATCH');

      const items = await readTimeline(AGENT_1, AMAKA.id, 'mixed');
      // The second PATCH's two items, then the activity, then the first PATCH's item.
      expect(items).toHaveLength(4);
      expect(
        items
          .slice(0, 2)
          .map((item) => item.field)
          .sort(),
      ).toEqual(['lga', 'status']);
      expect(items[2]?.type).toBe('activity');
      expect(items[2]?.activityId).toBe(activityId);
      expect(items[3]?.field).toBe('status');
      expect(items[3]?.after).toBe('contacted');

      const row = await activityRow(activityId);
      const created = (row?.created_at as Date).getTime();
      expect(
        Math.abs(Date.parse(String(items[2]?.occurredAt)) - created),
        'an activity item occurs at the activity’s created_at (D-L77)',
      ).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // 2. Values, redaction, legacy events, creation (T6-T8, T10).
  // =========================================================================

  describe('values (D-L72), redaction, legacy events and creation', () => {
    it('a change to each value field carries before and after in the wire type; consent is consent_changed', async () => {
      await plantContact(AMAKA.id, { status: 'new', tags: ['Late payer'] });
      const response = await updateContact(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        status: 'contacted',
        preferredChannel: 'whatsapp',
        preferredLanguage: 'yo',
        whatsappOptIn: true,
        state: 'Lagos',
        lga: 'Ikeja',
        tags: ['Late payer', 'VIP'],
        consentState: 'opted_in',
      });
      expectStatus(response, 200, 'PATCH');
      const items = await readTimeline(AGENT_1, AMAKA.id, 'values');
      const expected: Record<string, [unknown, unknown]> = {
        status: ['new', 'contacted'],
        preferredChannel: [null, 'whatsapp'],
        preferredLanguage: [null, 'yo'],
        whatsappOptIn: [false, true],
        state: [null, 'Lagos'],
        lga: [null, 'Ikeja'],
        tags: [['Late payer'], ['Late payer', 'VIP']],
      };
      for (const [field, [before, after]] of Object.entries(expected)) {
        const found = fieldItems(items, field);
        expect(found, `${field}: one item`).toHaveLength(1);
        expect(found[0]?.before, `${field}.before`).toEqual(before);
        expect(found[0]?.after, `${field}.after`).toEqual(after);
        expect('redacted' in (found[0] ?? {}), `${field} is a value field, never redacted`).toBe(
          false,
        );
      }
      const consent = consentItems(items);
      expect(consent, 'one consent_changed item').toHaveLength(1);
      expect(consent[0]).toMatchObject({ before: 'unknown', after: 'opted_in' });
      expect('field' in (consent[0] ?? {}), 'consent_changed names no field').toBe(false);
      expect(fieldItems(items, 'consentState'), 'consentState is never a field_changed').toEqual(
        [],
      );
      expect(items).toHaveLength(8);
    });

    it('phones, emails, the name parts, the owner and the account are redacted, and their values appear nowhere on the page', async () => {
      const OLD_PHONE = '+2348069061001';
      const NEW_PHONE = '+2348069061002';
      const OLD_EMAIL = `old.t0061.${RUN}@example.test`;
      const NEW_EMAIL = `new.t0061.${RUN}@example.test`;
      const NEW_GIVEN = `Zuberu${RUN}`;
      const NEW_FAMILY = `Okonkwo${RUN}`;
      await plantContact(AMAKA.id, {
        phones: JSON.stringify([{ type: 'mobile', e164: OLD_PHONE }]),
        emails: JSON.stringify([OLD_EMAIL]),
      });
      const response = await updateContact(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        displayName: `${NEW_GIVEN} ${NEW_FAMILY}`,
        givenNames: NEW_GIVEN,
        familyName: NEW_FAMILY,
        phones: [{ type: 'mobile', e164: NEW_PHONE }],
        emails: [NEW_EMAIL],
        ownerUserId: USER_A_AGENT_1,
        accountId: IKOYI.id,
      });
      expectStatus(response, 200, 'PATCH');

      const read = await timeline(AGENT_1, AMAKA.id);
      expectStatus(read, 200, 'timeline');
      const items = expectTimelinePage(read.body, 'redacted').data;
      for (const field of REDACTED_FIELDS) {
        const found = fieldItems(items, field);
        expect(found, `${field}: one item`).toHaveLength(1);
        expect(found[0]?.redacted, `${field} is redacted`).toBe(true);
        expect('before' in (found[0] ?? {}) || 'after' in (found[0] ?? {}), `${field} values`).toBe(
          false,
        );
      }
      expect(items).toHaveLength(REDACTED_FIELDS.length);
      const raw = JSON.stringify(read.body);
      for (const secret of [
        ...phoneForms(OLD_PHONE),
        ...phoneForms(NEW_PHONE),
        OLD_EMAIL,
        NEW_EMAIL,
        NEW_GIVEN,
        NEW_FAMILY,
        AMAKA.givenNames,
        // Not her three-letter family name: an opaque id may hold it by chance.
        USER_A_AGENT_1,
        displayNameOf(USER_A_AGENT_1),
        IKOYI.id,
        IKOYI.name,
      ]) {
        expect(raw, `the timeline carries "${secret}"`).not.toContain(secret);
      }
    });

    it('the update’s audit event records before/after for value fields and nothing for the redacted ones (T10)', async () => {
      await plantContact(AMAKA.id, { status: 'new', owner_user_id: null });
      const before = await auditIds();
      const response = await updateContact(SUPERVISOR, AMAKA.id, {
        version: await versionOf(AMAKA.id),
        status: 'contacted',
        preferredChannel: 'sms',
        whatsappOptIn: true,
        tags: ['VIP'],
        consentState: 'opted_in',
        phones: [{ type: 'mobile', e164: '+2348069061003' }],
        givenNames: `Probe${RUN}`,
        ownerUserId: USER_A_AGENT_1,
        accountId: IKOYI.id,
      });
      expectStatus(response, 200, 'PATCH');
      const events = await auditSince(before);
      expect(events).toHaveLength(1);
      const changes = events[0]?.changes ?? [];
      const change = (field: string) => changes.find((candidate) => candidate.field === field);
      expect(change('status')).toEqual({
        field: 'status',
        before: 'new',
        after: 'contacted',
        redacted: false,
      });
      expect(change('preferredChannel')).toEqual({
        field: 'preferredChannel',
        before: null,
        after: 'sms',
        redacted: false,
      });
      expect(change('consentState')).toEqual({
        field: 'consentState',
        before: 'unknown',
        after: 'opted_in',
        redacted: false,
      });
      for (const field of ['whatsappOptIn', 'tags']) {
        expect(change(field)?.redacted, `${field} is a value field`).toBe(false);
        expect(change(field)?.after ?? null, `${field} records its new value`).not.toBeNull();
      }
      // T-0104 (D-L71): "an `ownerUserId` change on a contact records the
      // before and after owner ids as values." Before T-0104 `ownerUserId` was
      // in the redacted list below and USER_A_AGENT_1 in the secrets. The
      // TIMELINE still shows owner changes by name only, never the id: T6 and
      // the redacted-fields test above are unchanged.
      expect(change('ownerUserId')).toEqual({
        field: 'ownerUserId',
        before: null,
        after: USER_A_AGENT_1,
        redacted: false,
      });
      for (const field of ['phones', 'givenNames', 'accountId']) {
        expect(change(field), `${field}: redacted, no values`).toEqual({
          field,
          before: null,
          after: null,
          redacted: true,
        });
      }
      const raw = JSON.stringify(changes);
      for (const secret of [...phoneForms('+2348069061003'), `Probe${RUN}`, IKOYI.id, IKOYI.name]) {
        expect(raw, `audit changes carry "${secret}"`).not.toContain(secret);
      }
    });

    it('legacy T-0041 events (every change redacted, no values) still render: value fields without before/after, consent without values', async () => {
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: '2026-04-01T09:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        action: 'created',
        changes: [
          legacy('displayName'),
          legacy('phones'),
          legacy('status'),
          legacy('source'),
          legacy('consentState'),
        ],
      });
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: '2026-04-02T09:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [
          legacy('status'),
          legacy('tags'),
          legacy('whatsappOptIn'),
          legacy('emails'),
          legacy('ownerUserId'),
          legacy('consentState'),
        ],
      });
      const items = await readTimeline(AGENT_1, AMAKA.id, 'legacy');
      expect(items).toHaveLength(11);
      for (const item of items) {
        if (item.type === 'consent_changed') {
          expect('before' in item || 'after' in item, 'legacy consent has no values').toBe(false);
          continue;
        }
        const field = String(item.field);
        expect('before' in item || 'after' in item, `legacy ${field} has no values`).toBe(false);
        if ((VALUE_FIELDS as readonly string[]).includes(field)) {
          expect('redacted' in item, `${field} is a value field, not a redacted one`).toBe(false);
        } else {
          expect(item.redacted, `${field} is redacted`).toBe(true);
        }
      }
      expect(consentItems(items)).toHaveLength(2);
    });

    it('creation appears as one item per field the create set, by the creator, and nothing for fields it did not send (T8)', async () => {
      const PHONE = '+2348069061004';
      const created = await createContact(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        displayName: `T0061 Created ${RUN}`,
        phones: [{ type: 'mobile', e164: PHONE }],
        status: 'new',
        source: 'manual',
        consentState: 'opted_in',
      });
      expectStatus(created, 201, 'create');
      const id = String((created.body as Json).id);
      const items = await readTimeline(AGENT_1, id, 'creation');
      const by = { id: USER_A_SUPERVISOR, displayName: displayNameOf(USER_A_SUPERVISOR) };
      const expected: Json[] = [
        { type: 'field_changed', field: 'displayName', redacted: true, actor: by },
        { type: 'field_changed', field: 'phones', redacted: true, actor: by },
        { type: 'field_changed', field: 'status', before: null, after: 'new', actor: by },
        { type: 'field_changed', field: 'source', before: null, after: 'manual', actor: by },
        { type: 'consent_changed', before: 'unknown', after: 'opted_in', actor: by },
      ];
      expect(items.map(signature).sort(), 'exactly the fields the create set').toEqual(
        expected.map(signature).sort(),
      );
      expect(new Set(items.map((item) => item.occurredAt)).size, 'one event, one instant').toBe(1);
      expect(JSON.stringify(items)).not.toContain(PHONE);
    });
  });

  // =========================================================================
  // 3. Actors (T9).
  // =========================================================================

  describe('actors', () => {
    it('the system is null', async () => {
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: '2026-04-03T09:00:00.000Z',
        actorUserId: null,
        changes: [legacy('status')],
      });
      await plantActivity({
        id: id61('a0001'),
        type: 'note',
        subject: 'Imported note',
        contactId: AMAKA.id,
        createdByUserId: null,
      });
      const items = await readTimeline(AGENT_1, AMAKA.id, 'system');
      expect(items).toHaveLength(2);
      for (const item of items) expect(item.actor, `${String(item.type)} by the system`).toBeNull();
    });

    it('a former member of the programme is still shown, by name, and so is a tenant admin no longer in it', async () => {
      // Agent 2 joins A1 as admin and edits; the supervisor (tenant admin) edits.
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'admin');
      await plantContact(AMAKA.id, { status: 'new' });
      expectStatus(
        await updateContact(AGENT_2, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          status: 'contacted',
        }),
        200,
        'agent 2 edits',
      );
      expectStatus(
        await updateContact(SUPERVISOR, AMAKA.id, {
          version: await versionOf(AMAKA.id),
          lga: 'Ikeja',
        }),
        200,
        'supervisor edits',
      );
      // Both leave A1. The supervisor keeps the tenant-admin flag and A2.
      await unassign(USER_A_AGENT_2, PROGRAMME_A1);
      await unassign(USER_A_SUPERVISOR, PROGRAMME_A1);

      const items = await readTimeline(AGENT_1, AMAKA.id, 'after they left');
      expect(items).toHaveLength(2);
      expect(fieldItems(items, 'status')[0]?.actor).toEqual({
        id: USER_A_AGENT_2,
        displayName: displayNameOf(USER_A_AGENT_2),
      });
      expect(fieldItems(items, 'lga')[0]?.actor).toEqual({
        id: USER_A_SUPERVISOR,
        displayName: displayNameOf(USER_A_SUPERVISOR),
      });
    });

    it('a disabled user is still shown, and a rename shows on every past item (names are read at read time)', async () => {
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: '2026-04-04T09:00:00.000Z',
        actorUserId: USER_A_AGENT_2,
        changes: [legacy('status')],
      });
      await plantActivity({
        id: id61('a0002'),
        type: 'call',
        subject: 'Logged call',
        contactId: AMAKA.id,
        createdByUserId: USER_A_AGENT_2,
        programmeId: PROGRAMME_A1,
      });
      await observer.query(`UPDATE "user" SET status = 'disabled' WHERE id = $1`, [USER_A_AGENT_2]);
      const disabled = await readTimeline(AGENT_1, AMAKA.id, 'disabled');
      expect(disabled.map((item) => item.actor)).toEqual(
        Array(2).fill({ id: USER_A_AGENT_2, displayName: displayNameOf(USER_A_AGENT_2) }),
      );

      const renamed = `Former Agent ${RUN}`;
      await observer.query('UPDATE "user" SET display_name = $1 WHERE id = $2', [
        renamed,
        USER_A_AGENT_2,
      ]);
      const after = await readTimeline(AGENT_1, AMAKA.id, 'renamed');
      expect(after.map((item) => item.actor)).toEqual(
        Array(2).fill({ id: USER_A_AGENT_2, displayName: renamed }),
      );
    });
  });

  // =========================================================================
  // 4. Field security: omitted, before paging (T5).
  // =========================================================================

  describe('field security: withheld items are omitted, before paging', () => {
    it('a withheld field’s items are gone, name and value; consent follows consent_state; owner and account follow theirs; judged today', async () => {
      const at = (minute: number) => `2026-04-10T09:${String(minute).padStart(2, '0')}:00.000Z`;
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: at(1),
        actorUserId: USER_A_SUPERVISOR,
        changes: [legacy('status'), legacy('emails')],
      });
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: at(2),
        actorUserId: USER_A_SUPERVISOR,
        changes: [legacy('consentState')],
      });
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: at(3),
        actorUserId: USER_A_SUPERVISOR,
        changes: [legacy('ownerUserId'), legacy('accountId'), legacy('lga')],
      });
      // Before any lock: the agent sees all six (the control).
      expect(await readTimeline(AGENT_1, AMAKA.id, 'unlocked')).toHaveLength(6);

      // Locked AFTER the changes were made: judged today, not then.
      for (const field of ['emails', 'consent_state', 'owner_user_id', 'account_id']) {
        await lockField('contact', field, 'agent', 'none');
      }
      const read = await timeline(AGENT_1, AMAKA.id, [['limit', '100']]);
      expectStatus(read, 200, 'locked');
      const items = expectTimelinePage(read.body, 'locked').data;
      expect(items.map((item) => item.field).sort()).toEqual(['lga', 'status']);
      const raw = JSON.stringify(read.body);
      for (const name of ['emails', 'consent_changed', 'ownerUserId', 'accountId']) {
        expect(raw, `the withheld ${name} is named on the page`).not.toContain(name);
      }
      // The admin set is never withheld: the supervisor still sees all six.
      expect(await readTimeline(SUPERVISOR, AMAKA.id, 'admin')).toHaveLength(6);
    });

    it('a short page with a cursor never happens: withheld items interleaved, before and after, at every limit', async () => {
      // Newest first: 5 withheld, then 10 x (visible, withheld, withheld),
      // then 5 withheld. Half the visible events also carry a withheld change.
      const WITHHELD = ['emails', 'consentState', 'ownerUserId', 'accountId'];
      for (const field of ['emails', 'consent_state', 'owner_user_id', 'account_id']) {
        await lockField('contact', field, 'agent', 'none');
      }
      const kinds: ('V' | 'W')[] = [
        ...Array<'W'>(5).fill('W'),
        ...Array.from({ length: 10 }, () => ['V', 'W', 'W'] as const).flat(),
        ...Array<'W'>(5).fill('W'),
      ];
      const base = Date.parse('2026-04-20T00:00:00.000Z');
      let withheldIndex = 0;
      let visibleIndex = 0;
      for (const [position, kind] of kinds.entries()) {
        // position 0 is the newest.
        const occurredAt = new Date(base + (kinds.length - position) * 60_000).toISOString();
        const changes: Change[] = [];
        if (kind === 'V') {
          changes.push(legacy('status'));
          if (visibleIndex % 2 === 0) changes.push(legacy('emails'));
          visibleIndex += 1;
        } else {
          changes.push(legacy(WITHHELD[withheldIndex % WITHHELD.length] ?? 'emails'));
          withheldIndex += 1;
        }
        await plantEvent({
          contactId: AMAKA.id,
          occurredAt,
          actorUserId: USER_A_SUPERVISOR,
          changes,
        });
      }

      // The control: the withheld items exist and would be served.
      const all = await walk(SUPERVISOR, AMAKA.id, 7);
      expect(all.items, '10 visible + 5 riders + 30 withheld').toHaveLength(45);

      for (const [limit, sizes] of [
        [5, [5, 5]],
        [3, [3, 3, 3, 1]],
        [10, [10]],
        [1, Array<number>(10).fill(1)],
      ] as const) {
        const agent = await walk(AGENT_1, AMAKA.id, limit);
        expect(agent.sizes, `page sizes at limit ${limit}`).toEqual(sizes);
        expect(agent.items.map((item) => item.field)).toEqual(Array(10).fill('status'));
        // The agent's ten are exactly the supervisor's status items, same ids, same order.
        expect(agent.items.map((item) => item.id)).toEqual(
          fieldItems(all.items, 'status').map((item) => item.id),
        );
      }
    });

    it('an activity item omits a withheld subject or body, and the admin set still sees them', async () => {
      const SUBJECT = `T0061 subject ${RUN}`;
      const BODY = `T0061 body ${RUN}`;
      await plantTask(id61('a0003'), { subject: SUBJECT, body: BODY });
      await lockField('activity', 'body', 'agent', 'none');
      const read = await timeline(AGENT_1, AMAKA.id);
      expectStatus(read, 200, 'agent');
      const [item] = activityItems(expectTimelinePage(read.body, 'agent').data);
      expect(item, 'the activity is on the timeline').toBeDefined();
      expect('body' in (item ?? {}), 'a withheld body is omitted, never nulled').toBe(false);
      expect(item?.subject).toBe(SUBJECT);
      expect(JSON.stringify(read.body)).not.toContain(BODY);

      await lockField('activity', 'subject', 'agent', 'none');
      const both = activityItems(await readTimeline(AGENT_1, AMAKA.id, 'both locked'));
      expect('subject' in (both[0] ?? {})).toBe(false);

      const admin = activityItems(await readTimeline(SUPERVISOR, AMAKA.id, 'admin'));
      expect(admin[0]).toMatchObject({ subject: SUBJECT, body: BODY });
    });
  });

  // =========================================================================
  // 5. Paging edges, ties and cursors.
  // =========================================================================

  describe('paging: ties at a page edge, sub-millisecond events, cursors', () => {
    it('a page edge inside one event neither drops nor repeats an item', async () => {
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: '2026-04-21T10:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: ['status', 'preferredChannel', 'preferredLanguage', 'state', 'lga'].map(legacy),
      });
      const whole = await readTimeline(AGENT_1, AMAKA.id, 'whole');
      expect(whole).toHaveLength(5);
      for (const limit of [1, 2, 3, 4]) {
        const paged = await walk(AGENT_1, AMAKA.id, limit);
        expect(
          paged.items.map((item) => item.id),
          `limit ${limit}`,
        ).toEqual(whole.map((item) => item.id));
      }
    });

    it('two events at the same instant are one tie broken by id; events a few microseconds apart are each served once', async () => {
      const at = '2026-04-22T10:00:01.000Z';
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: at,
        actorUserId: USER_A_SUPERVISOR,
        changes: [legacy('status')],
      });
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: at,
        actorUserId: USER_A_SUPERVISOR,
        changes: [legacy('lga')],
      });
      // Same millisecond on the wire, different microseconds in the row: a
      // cursor that keeps only milliseconds drops one of these at a page edge.
      for (const micros of ['123100', '123400', '123700']) {
        await plantEvent({
          contactId: AMAKA.id,
          occurredAt: `2026-04-22T10:00:00.${micros}Z`,
          actorUserId: USER_A_SUPERVISOR,
          changes: [legacy('state')],
        });
      }
      for (const limit of [1, 2, 4]) {
        const { items } = await walk(AGENT_1, AMAKA.id, limit, false);
        expect(items, `limit ${limit}: every item exactly once`).toHaveLength(5);
        const tie = items.filter((item) => item.occurredAt === at);
        expect(tie).toHaveLength(2);
        expect(String(tie[0]?.id) > String(tie[1]?.id), 'the tie is broken by id descending').toBe(
          true,
        );
      }
    });

    it('a malformed cursor, or one issued for another contact, is 400 invalid_cursor; limit is 1..100', async () => {
      for (const contact of [AMAKA.id, BASHIR.id]) {
        for (const field of ['status', 'lga']) {
          await plantEvent({
            contactId: contact,
            occurredAt:
              field === 'status' ? '2026-04-23T10:00:00.000Z' : '2026-04-23T11:00:00.000Z',
            actorUserId: USER_A_SUPERVISOR,
            changes: [legacy(field)],
          });
        }
      }
      const first = await timeline(AGENT_1, AMAKA.id, [['limit', '1']]);
      expectStatus(first, 200, 'page 1');
      const cursor = expectTimelinePage(first.body, 'page 1').nextCursor;
      expect(cursor, 'control: Amaka has a second page').toEqual(expect.any(String));

      const foreign = expectError(
        await timeline(AGENT_1, BASHIR.id, [
          ['limit', '1'],
          ['cursor', cursor ?? ''],
        ]),
        400,
        'validation_failed',
      );
      expect(detailsOf(foreign)).toContainEqual({ path: 'cursor', code: 'invalid_cursor' });
      const malformed = expectError(
        await timeline(AGENT_1, AMAKA.id, [['cursor', 'not-a-cursor']]),
        400,
        'validation_failed',
      );
      expect(detailsOf(malformed)).toContainEqual({ path: 'cursor', code: 'invalid_cursor' });
      for (const limit of ['0', '101', 'ten', '1.5']) {
        expectError(
          await timeline(AGENT_1, AMAKA.id, [['limit', limit]]),
          400,
          'validation_failed',
        );
      }
      expectStatus(await timeline(AGENT_1, AMAKA.id, [['limit', '100']]), 200, 'limit 100');
    });
  });

  // =========================================================================
  // 6. Activity items (T2, T9).
  // =========================================================================

  describe('activity items', () => {
    it('one item per activity on the contact: its current state, completing it changes the item and adds none', async () => {
      const DUE = '2026-11-01T09:00:00.000Z';
      const created = await createActivity(SUPERVISOR, {
        type: 'task',
        subject: 'Call back about the arrears plan',
        body: 'Invented text that names no one.',
        dueAt: DUE,
        contactId: AMAKA.id,
        accountId: IKOYI.id,
        ownerUserId: USER_A_AGENT_1,
      });
      expectStatus(created, 201, 'create');
      const activityId = String((created.body as Json).id);

      const before = await readTimeline(AGENT_1, AMAKA.id, 'logged');
      expect(
        before,
        'one item, the activity; the activity’s own audit event is not one',
      ).toHaveLength(1);
      expect(before[0]).toEqual({
        id: expect.any(String),
        type: 'activity',
        occurredAt: expect.any(String),
        actor: { id: USER_A_SUPERVISOR, displayName: displayNameOf(USER_A_SUPERVISOR) },
        activityId,
        activityType: 'task',
        subject: 'Call back about the arrears plan',
        body: 'Invented text that names no one.',
        dueAt: DUE,
        completedAt: null,
        startsAt: null,
        endsAt: null,
        version: (created.body as Json).version,
      });

      const completed = await updateActivity(SUPERVISOR, activityId, {
        version: (created.body as Json).version,
        completed: true,
      });
      expectStatus(completed, 200, 'complete');
      const after = await readTimeline(AGENT_1, AMAKA.id, 'completed');
      expect(after, 'completing adds no item').toHaveLength(1);
      expect(after[0]?.id, 'the same item').toBe(before[0]?.id);
      expect(after[0]?.occurredAt, 'completion does not move the item (D-L77)').toBe(
        before[0]?.occurredAt,
      );
      expect(after[0]?.completedAt).toEqual(expect.stringMatching(DATE_TIME));
    });

    it('only this contact’s activities: not an account-only activity, not another contact’s', async () => {
      await plantContact(AMAKA.id, { account_id: IKOYI.id });
      await plantActivity({
        id: id61('a0004'),
        type: 'note',
        subject: 'On the account',
        accountId: IKOYI.id,
      });
      await plantActivity({
        id: id61('a0005'),
        type: 'note',
        subject: 'On Bashir',
        contactId: BASHIR.id,
      });
      await plantActivity({
        id: id61('a0006'),
        type: 'note',
        subject: 'On Amaka and her account',
        contactId: AMAKA.id,
        accountId: IKOYI.id,
        createdByUserId: USER_A_SUPERVISOR,
      });
      const items = await readTimeline(AGENT_1, AMAKA.id, 'Amaka');
      expect(items.map((item) => item.activityId)).toEqual([id61('a0006')]);
      // The control: Bashir's is on Bashir's.
      expect(
        (await readTimeline(AGENT_1, BASHIR.id, 'Bashir')).map((item) => item.activityId),
      ).toEqual([id61('a0005')]);
    });
  });

  // =========================================================================
  // 7. Timeline scope (T13).
  // =========================================================================

  describe('timeline scope', () => {
    it('another programme, another tenant and nowhere are one 404 body; a user with no programme gets it too', async () => {
      expectStatus(await timeline(AGENT_1, AMAKA.id), 200, 'control: a reachable contact');
      const nowhere = expectError(await timeline(AGENT_1, NOWHERE), 404, 'not_found');
      const sibling = expectError(await timeline(AGENT_1, DAMILOLA.id), 404, 'not_found');
      const otherTenant = expectError(await timeline(AGENT_1, GRACE.id), 404, 'not_found');
      expect(sibling).toEqual(nowhere);
      expect(otherTenant).toEqual(nowhere);
      expect(expectError(await timeline(NO_PROGRAMME, AMAKA.id), 404, 'not_found')).toEqual(
        nowhere,
      );
    });

    it('a cursor never opens a contact the caller cannot reach (scope is checked first)', async () => {
      for (const field of ['status', 'lga']) {
        await plantEvent({
          contactId: DAMILOLA.id,
          programmeId: PROGRAMME_A2,
          occurredAt: field === 'status' ? '2026-04-24T10:00:00.000Z' : '2026-04-24T11:00:00.000Z',
          actorUserId: USER_A_SUPERVISOR,
          changes: [legacy(field)],
        });
      }
      const first = await timeline(SUPERVISOR, DAMILOLA.id, [['limit', '1']]);
      expectStatus(first, 200, 'supervisor reaches A2');
      const cursor = expectTimelinePage(first.body, 'supervisor').nextCursor ?? '';
      expect(cursor).not.toBe('');
      expectError(
        await timeline(AGENT_1, DAMILOLA.id, [
          ['limit', '1'],
          ['cursor', cursor],
        ]),
        404,
        'not_found',
      );
    });

    it('no read set is refused: qa_analyst and client_portal read the timeline (never 403)', async () => {
      await plantEvent({
        contactId: AMAKA.id,
        occurredAt: '2026-04-25T10:00:00.000Z',
        actorUserId: USER_A_SUPERVISOR,
        changes: [legacy('status')],
      });
      for (const key of ACTIVITY_READERS) {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        expect(await readTimeline(AGENT_1, AMAKA.id, key), key).toHaveLength(1);
      }
    });

    it('a non-uuid id is 400; no session is 401', async () => {
      expectStatus(await timeline(AGENT_1, AMAKA.id), 200, 'control');
      expectError(await timeline(AGENT_1, 'not-a-uuid'), 400, 'validation_failed');
      expectError(await timeline({}, AMAKA.id), 401, 'not_authenticated');
    });
  });

  // =========================================================================
  // 8. Contact.account (T11).
  // =========================================================================

  describe('Contact.account', () => {
    it('get and list serve { id, name } for a linked contact and null for the rest', async () => {
      await plantContact(AMAKA.id, { account_id: IKOYI.id });
      const one = await getContact(AGENT_1, AMAKA.id);
      expectStatus(one, 200, 'get');
      const contact = expectContact(one.body, 'get');
      expectAccountSummary(contact, 'get');
      expect(contact.account).toEqual({ id: IKOYI.id, name: IKOYI.name });

      const page = await listContacts(AGENT_1, [['limit', '100']]);
      expectStatus(page, 200, 'list');
      const rows = ((page.body as Json).data ?? []) as Json[];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expectContact(row, `row ${String(row.id)}`);
        expectAccountSummary(row, `row ${String(row.id)}`);
        expect(row.account).toEqual(
          row.id === AMAKA.id ? { id: IKOYI.id, name: IKOYI.name } : null,
        );
      }
    });

    it('create and update serve it too: set, then cleared', async () => {
      const created = await createContact(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        displayName: `T0061 Account ${RUN}`,
        accountId: IKOYI.id,
      });
      expectStatus(created, 201, 'create');
      const body = expectContact(created.body, 'create');
      expectAccountSummary(body, 'create');
      expect(body.account).toEqual({ id: IKOYI.id, name: IKOYI.name });

      const linked = await updateContact(SUPERVISOR, BASHIR.id, {
        version: await versionOf(BASHIR.id),
        accountId: IKOYI.id,
      });
      expectStatus(linked, 200, 'link');
      expect(expectContact(linked.body, 'link').account).toEqual({
        id: IKOYI.id,
        name: IKOYI.name,
      });

      const cleared = await updateContact(SUPERVISOR, BASHIR.id, {
        version: await versionOf(BASHIR.id),
        accountId: null,
      });
      expectStatus(cleared, 200, 'clear');
      const after = expectContact(cleared.body, 'clear');
      expectAccountSummary(after, 'clear');
      expect(after.account).toBeNull();
    });

    it('is withheld together with accountId: both omitted, both listed, the name nowhere', async () => {
      await plantContact(AMAKA.id, { account_id: IKOYI.id });
      await lockField('contact', 'account_id', 'agent', 'none');
      const one = await getContact(AGENT_1, AMAKA.id);
      expectStatus(one, 200, 'agent get');
      const contact = expectContact(one.body, 'agent get');
      expect(contact.withheldFields).toEqual(expect.arrayContaining(['accountId', 'account']));
      expect('account' in contact || 'accountId' in contact).toBe(false);
      const page = await listContacts(AGENT_1);
      expectStatus(page, 200, 'agent list');
      for (const raw of [JSON.stringify(one.body), JSON.stringify(page.body)]) {
        expect(raw).not.toContain(IKOYI.name);
        expect(raw).not.toContain(IKOYI.id);
      }
      for (const row of ((page.body as Json).data ?? []) as Json[]) {
        expect(row.withheldFields).toEqual(expect.arrayContaining(['accountId', 'account']));
      }
      // The control: the admin set sees both.
      const admin = expectContact((await getContact(SUPERVISOR, AMAKA.id)).body, 'admin');
      expect(admin.account).toEqual({ id: IKOYI.id, name: IKOYI.name });
    });
  });

  // =========================================================================
  // 9. Activity writes (T12).
  // =========================================================================

  /** T12: the Activity response shape, beyond the contract's own schema. */
  function expectActivity(
    response: request.Response,
    operationId: 'createActivity' | 'updateActivity',
    status: number,
    where: string,
  ): Json {
    expectStatus(response, status, where);
    expect(
      schemaErrors(responseSchemaOf(operationId, String(status)), response.body, where),
      `${where} does not match the ${operationId} ${status} schema`,
    ).toEqual([]);
    const activity = response.body as Json;
    const withheld = (
      Array.isArray(activity.withheldFields) ? activity.withheldFields : []
    ) as string[];
    const problems: string[] = [];
    for (const key of [
      'id',
      'programmeId',
      'type',
      'version',
      'createdAt',
      'updatedAt',
      'withheldFields',
    ]) {
      if (!(key in activity)) problems.push(`${key} missing`);
    }
    for (const key of [
      'subject',
      'body',
      'dueAt',
      'completedAt',
      'startsAt',
      'endsAt',
      'ownerUserId',
      'contactId',
      'accountId',
    ]) {
      if (key in activity === withheld.includes(key)) {
        problems.push(`${key} must be present or listed in withheldFields, exactly one`);
      }
    }
    if ('tenantId' in activity) problems.push('tenantId is never on the wire');
    if (!UUID.test(String(activity.id))) problems.push('id is not a uuid');
    if (!['note', 'task', 'call', 'meeting'].includes(String(activity.type))) problems.push('type');
    if (!Number.isInteger(activity.version) || Number(activity.version) < 1)
      problems.push('version');
    expect(problems, `${where}: Activity (T12)`).toEqual([]);
    return activity;
  }

  describe('activity writes: create', () => {
    it('201 with an Activity whose id the server minted, in the target’s programme, logged by the session user', async () => {
      const count = await activityCount();
      const response = await createActivity(AGENT_1, noteBody());
      const activity = expectActivity(response, 'createActivity', 201, 'create');
      expect(activity.programmeId).toBe(PROGRAMME_A1);
      expect(activity.contactId).toBe(AMAKA.id);
      if ('createdByUserId' in activity) expect(activity.createdByUserId).toBe(USER_A_AGENT_1);
      expect(await activityCount()).toBe(count + 1);
      const row = await activityRow(String(activity.id));
      expect(row).toMatchObject({
        tenant_id: TENANT_A,
        programme_id: PROGRAMME_A1,
        type: 'note',
        contact_id: AMAKA.id,
        created_by_user_id: USER_A_AGENT_1,
      });

      // The programme follows the target: an A2 contact gives an A2 activity.
      const a2 = expectActivity(
        await createActivity(SUPERVISOR, noteBody({ contactId: DAMILOLA.id })),
        'createActivity',
        201,
        'A2 create',
      );
      expect(a2.programmeId).toBe(PROGRAMME_A2);
    });

    it('a client-supplied id is 400 — the same body for a fresh uuid and a real activity’s — and nothing is written', async () => {
      const count = await activityCount();
      const fresh = id61('a00ff');
      const freshBody = expectError(
        await createActivity(SUPERVISOR, noteBody({ id: fresh })),
        400,
        'validation_failed',
      );
      const realBody = expectError(
        await createActivity(SUPERVISOR, noteBody({ id: SEEDED_B_ACTIVITY.id })),
        400,
        'validation_failed',
      );
      expect(realBody).toEqual(freshBody);
      expect(await activityRow(fresh)).toBeNull();
      expect(await activityCount()).toBe(count);
      expectActivity(
        await createActivity(SUPERVISOR, noteBody()),
        'createActivity',
        201,
        'control',
      );
    });

    it.each([
      ['createdByUserId', { createdByUserId: USER_A_SUPERVISOR }],
      ['programmeId', { programmeId: PROGRAMME_A1 }],
      ['tenantId', { tenantId: TENANT_B }],
      ['createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }],
      ['updatedAt', { updatedAt: '2020-01-01T00:00:00.000Z' }],
      ['completedAt', { type: 'task', completedAt: '2020-01-01T00:00:00.000Z' }],
      ['version', { version: 7 }],
      ['withheldFields', { withheldFields: [] }],
      ['an unknown property', { priority: 'high' }],
    ])('a body carrying %s is 400 and writes nothing', async (_label, extra) => {
      const count = await activityCount();
      expectError(await createActivity(AGENT_1, noteBody(extra)), 400, 'validation_failed');
      expect(await activityCount()).toBe(count);
    });

    it('an unreachable target is 404, one body for another programme, another tenant and nowhere', async () => {
      const count = await activityCount();
      expectActivity(
        await createActivity(AGENT_1, noteBody({ contactId: undefined, accountId: IKOYI.id })),
        'createActivity',
        201,
        'control: an account-only target in reach',
      );
      const bodies = [
        await createActivity(AGENT_1, noteBody({ contactId: NOWHERE })),
        await createActivity(AGENT_1, noteBody({ contactId: DAMILOLA.id })),
        await createActivity(AGENT_1, noteBody({ contactId: GRACE.id })),
        await createActivity(AGENT_1, noteBody({ contactId: undefined, accountId: SABON.id })),
        await createActivity(AGENT_1, noteBody({ contactId: undefined, accountId: WESTLANDS.id })),
        await createActivity(AGENT_1, noteBody({ contactId: undefined, accountId: NOWHERE })),
      ].map((response) => expectError(response, 404, 'not_found'));
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      expect(await activityCount()).toBe(count + 1);
    });

    it('a second target outside the first one’s programme is 400 unknown_reference, the same body real or invented, even for a caller who reads both', async () => {
      const count = await activityCount();
      // The supervisor reaches A1 and A2: only the rule stops this link.
      const real = expectError(
        await createActivity(SUPERVISOR, noteBody({ accountId: SABON.id })),
        400,
        'validation_failed',
      );
      const invented = expectError(
        await createActivity(SUPERVISOR, noteBody({ accountId: NOWHERE })),
        400,
        'validation_failed',
      );
      expect(detailsOf(real)).toContainEqual({ path: 'accountId', code: 'unknown_reference' });
      expect(real).toEqual(invented);
      expect(await activityCount()).toBe(count);
      expectActivity(
        await createActivity(SUPERVISOR, noteBody({ accountId: IKOYI.id })),
        'createActivity',
        201,
        'control: same-programme account',
      );
    });

    it('no target at all is 400', async () => {
      const count = await activityCount();
      expectError(
        await createActivity(SUPERVISOR, noteBody({ contactId: undefined })),
        400,
        'validation_failed',
      );
      expect(await activityCount()).toBe(count);
    });

    it('the owner must be a member of the activity’s programme: one 400 for another programme’s member, another tenant’s user, a user with no programme, and nobody', async () => {
      const count = await activityCount();
      const resolved: Json[] = [];
      for (const ownerUserId of [USER_A_AGENT_2, USER_B_AGENT_1, USER_A_NO_PROGRAMME, NOWHERE]) {
        resolved.push(
          expectError(
            await createActivity(SUPERVISOR, noteBody({ type: 'task', ownerUserId })),
            400,
            'validation_failed',
          ),
        );
      }
      expect(detailsOf(resolved[0] ?? {})).toContainEqual({
        path: 'ownerUserId',
        code: 'unknown_reference',
      });
      for (const body of resolved) expect(body).toEqual(resolved[0]);
      expect(await activityCount()).toBe(count);
      const control = expectActivity(
        await createActivity(SUPERVISOR, noteBody({ type: 'task', ownerUserId: USER_A_AGENT_1 })),
        'createActivity',
        201,
        'control: an A1 member',
      );
      expect(control.ownerUserId).toBe(USER_A_AGENT_1);
    });

    it('validation: dueAt on a note, an unknown type, a missing type and a NUL character are 400, never 500', async () => {
      const count = await activityCount();
      for (const body of [
        noteBody({ dueAt: '2026-12-01T09:00:00.000Z' }),
        noteBody({ type: 'call', dueAt: '2026-12-01T09:00:00.000Z' }),
        noteBody({ type: 'meeting' }),
        noteBody({ type: undefined }),
        noteBody({ subject: 'Call\u0000back' }),
        noteBody({ body: 'Invented\u0000text' }),
        noteBody({ dueAt: 'tomorrow', type: 'task' }),
      ]) {
        expectError(await createActivity(SUPERVISOR, body), 400, 'validation_failed');
      }
      expect(await activityCount()).toBe(count);
    });
  });

  describe('activity writes: permission (D-P18)', () => {
    it.each(ACTIVITY_WRITERS)('the %s set may log and complete in its programme', async (key) => {
      await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
      expectActivity(
        await createActivity(AGENT_1, noteBody()),
        'createActivity',
        201,
        `${key} logs`,
      );
      await plantTask(id61('a0010'));
      expectActivity(
        await updateActivity(AGENT_1, id61('a0010'), { version: 1, completed: true }),
        'updateActivity',
        200,
        `${key} completes`,
      );
    });

    it.each(ACTIVITY_READERS)(
      'the %s set may not: 403 not_permitted, nothing written or changed',
      async (key) => {
        await assign(USER_A_AGENT_1, PROGRAMME_A1, key);
        await plantTask(id61('a0011'));
        const count = await activityCount();
        const before = await activityRow(id61('a0011'));
        expectError(await createActivity(AGENT_1, noteBody()), 403, 'not_permitted');
        expectError(
          await updateActivity(AGENT_1, id61('a0011'), { version: 1, completed: true }),
          403,
          'not_permitted',
        );
        expect(await activityCount()).toBe(count);
        expect(await activityRow(id61('a0011'))).toEqual(before);
      },
    );

    it('the tenant-admin flag permits, but only inside programmes the session reaches', async () => {
      await assign(USER_A_AGENT_1, PROGRAMME_A1, 'qa_analyst');
      await setTenantAdmin(USER_A_AGENT_1, true);
      expectActivity(await createActivity(AGENT_1, noteBody()), 'createActivity', 201, 'flag');
      // The supervisor (flag) leaves A1: the flag does not reach back in.
      await unassign(USER_A_SUPERVISOR, PROGRAMME_A1);
      const count = await activityCount();
      expect(expectError(await createActivity(SUPERVISOR, noteBody()), 404, 'not_found')).toEqual(
        expectError(
          await createActivity(SUPERVISOR, noteBody({ contactId: NOWHERE })),
          404,
          'not_found',
        ),
      );
      expect(await activityCount()).toBe(count);
    });

    it('the permission is per programme: a writer in A2 is a reader in A1', async () => {
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'qa_analyst');
      expectError(await createActivity(AGENT_2, noteBody()), 403, 'not_permitted');
      expectActivity(
        await createActivity(AGENT_2, noteBody({ contactId: DAMILOLA.id })),
        'createActivity',
        201,
        'A2',
      );
    });

    it('order: unreachable is 404 even for a reader set; a reader with a bad body is 403, not 400 (D-L53)', async () => {
      // The control, without which "no route" would pass for "out of scope".
      expectActivity(await createActivity(AGENT_1, noteBody()), 'createActivity', 201, 'control');
      await assign(USER_A_AGENT_1, PROGRAMME_A1, 'qa_analyst');
      expect(
        expectError(
          await createActivity(AGENT_1, noteBody({ contactId: DAMILOLA.id })),
          404,
          'not_found',
        ),
      ).toEqual(
        expectError(
          await createActivity(AGENT_1, noteBody({ contactId: NOWHERE })),
          404,
          'not_found',
        ),
      );
      expectError(
        await createActivity(AGENT_1, noteBody({ type: 'meeting', dueAt: 'never' })),
        403,
        'not_permitted',
      );
    });

    it('a withheld activity field cannot be written (403 field_not_editable) and is omitted from the response', async () => {
      await lockField('activity', 'body', 'agent', 'none');
      const count = await activityCount();
      const refused = expectError(await createActivity(AGENT_1, noteBody()), 403, 'not_permitted');
      expect(detailsOf(refused)).toContainEqual({ path: 'body', code: 'field_not_editable' });
      expect(await activityCount()).toBe(count);
      const ok = expectActivity(
        await createActivity(AGENT_1, noteBody({ body: undefined })),
        'createActivity',
        201,
        'without body',
      );
      expect('body' in ok).toBe(false);
      expect(ok.withheldFields).toContain('body');
    });
  });

  describe('activity writes: update (complete, reassign)', () => {
    it('complete: 200, completedAt set by the server, version + 1; a stale version is 409; version is required', async () => {
      await plantTask(id61('a0020'));
      const startedAt = Date.now();
      const done = expectActivity(
        await updateActivity(SUPERVISOR, id61('a0020'), { version: 1, completed: true }),
        'updateActivity',
        200,
        'complete',
      );
      const finishedAt = Date.now();
      expect(done.version).toBe(2);
      const completedAt = Date.parse(String(done.completedAt));
      expect(completedAt).toBeGreaterThanOrEqual(startedAt - 2_000);
      expect(completedAt).toBeLessThanOrEqual(finishedAt + 2_000);
      const row = await activityRow(id61('a0020'));
      expect(row?.completed_at).not.toBeNull();
      expect(Number(row?.version)).toBe(2);

      expectError(
        await updateActivity(SUPERVISOR, id61('a0020'), {
          version: 1,
          ownerUserId: USER_A_SUPERVISOR,
        }),
        409,
        'stale_write',
      );
      expectError(
        await updateActivity(SUPERVISOR, id61('a0020'), { completed: true }),
        400,
        'validation_failed',
      );
      expect(await activityRow(id61('a0020'))).toEqual(row);
    });

    it('completing a note or a call is 400, never a 500 from the CHECK, and changes nothing', async () => {
      for (const [tail, type] of [
        ['a0021', 'note'],
        ['a0022', 'call'],
      ] as const) {
        await plantActivity({ id: id61(tail), type, subject: 'x', contactId: AMAKA.id });
        const before = await activityRow(id61(tail));
        expectError(
          await updateActivity(SUPERVISOR, id61(tail), { version: 1, completed: true }),
          400,
          'validation_failed',
        );
        expect(await activityRow(id61(tail))).toEqual(before);
      }
    });

    it('reassign: an A1 member is 200; another programme’s member, another tenant’s user and nobody are one 400', async () => {
      await plantTask(id61('a0023'));
      const before = await activityRow(id61('a0023'));
      const bodies: Json[] = [];
      for (const ownerUserId of [USER_A_AGENT_2, USER_B_AGENT_1, USER_A_NO_PROGRAMME, NOWHERE]) {
        bodies.push(
          expectError(
            await updateActivity(SUPERVISOR, id61('a0023'), { version: 1, ownerUserId }),
            400,
            'validation_failed',
          ),
        );
      }
      expect(detailsOf(bodies[0] ?? {})).toContainEqual({
        path: 'ownerUserId',
        code: 'unknown_reference',
      });
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      expect(await activityRow(id61('a0023'))).toEqual(before);

      const moved = expectActivity(
        await updateActivity(SUPERVISOR, id61('a0023'), {
          version: 1,
          ownerUserId: USER_A_SUPERVISOR,
        }),
        'updateActivity',
        200,
        'reassign',
      );
      expect(moved.ownerUserId).toBe(USER_A_SUPERVISOR);
      expect((await activityRow(id61('a0023')))?.owner_user_id).toBe(USER_A_SUPERVISOR);
    });

    it.each([
      ['contactId', { contactId: BASHIR.id }],
      ['accountId', { accountId: IKOYI.id }],
      ['programmeId', { programmeId: PROGRAMME_A2 }],
      ['createdByUserId', { createdByUserId: USER_A_AGENT_1 }],
      ['createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }],
      ['completedAt', { completedAt: '2020-01-01T00:00:00.000Z' }],
      ['id', { id: id61('a00fe') }],
      ['tenantId', { tenantId: TENANT_B }],
    ])('a body carrying %s is 400 and changes nothing', async (_label, extra) => {
      await plantTask(id61('a0024'));
      const before = await activityRow(id61('a0024'));
      expectError(
        await updateActivity(SUPERVISOR, id61('a0024'), { version: 1, ...extra }),
        400,
        'validation_failed',
      );
      expect(await activityRow(id61('a0024'))).toEqual(before);
    });

    it('an activity out of reach is one 404 body: another programme, another tenant, nowhere', async () => {
      await plantTask(id61('a0025'));
      await plantActivity({
        id: id61('a0026'),
        type: 'task',
        subject: 'A2 task',
        programmeId: PROGRAMME_A2,
        contactId: DAMILOLA.id,
      });
      expectActivity(
        await updateActivity(AGENT_1, id61('a0025'), { version: 1, completed: true }),
        'updateActivity',
        200,
        'control: in reach',
      );
      const before = await activityRow(id61('a0026'));
      const bodies = [
        await updateActivity(AGENT_1, NOWHERE, { version: 1, completed: true }),
        await updateActivity(AGENT_1, id61('a0026'), { version: 1, completed: true }),
        await updateActivity(AGENT_1, SEEDED_B_ACTIVITY.id, { version: 1, completed: true }),
      ].map((response) => expectError(response, 404, 'not_found'));
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      expect(await activityRow(id61('a0026'))).toEqual(before);
    });
  });

  describe('activity writes: audit', () => {
    it('one event per write, labelled by the activity id, with no subject or body anywhere; refusals write none; no contact event', async () => {
      const SUBJECT = `T0061 audit subject ${RUN}`;
      const BODY = `T0061 audit body ${RUN}`;
      const before = await auditIds();
      const created = expectActivity(
        await createActivity(AGENT_1, noteBody({ type: 'task', subject: SUBJECT, body: BODY })),
        'createActivity',
        201,
        'create',
      );
      const id = String(created.id);
      const afterCreate = await auditSince(before);
      expect(afterCreate).toHaveLength(1);
      expect(afterCreate[0]).toMatchObject({
        tenant_id: TENANT_A,
        actor_kind: 'user',
        actor_user_id: USER_A_AGENT_1,
        action: 'created',
        object_type: 'activity',
        object_id: id,
        object_label: id,
        programme_id: PROGRAMME_A1,
      });

      const middle = await auditIds();
      expectActivity(
        await updateActivity(AGENT_1, id, { version: created.version, completed: true }),
        'updateActivity',
        200,
        'complete',
      );
      const afterUpdate = await auditSince(middle);
      expect(afterUpdate).toHaveLength(1);
      expect(afterUpdate[0]).toMatchObject({
        action: 'updated',
        object_type: 'activity',
        object_id: id,
      });
      for (const event of [...afterCreate, ...afterUpdate]) {
        const raw = JSON.stringify(event);
        expect(raw).not.toContain(SUBJECT);
        expect(raw).not.toContain(BODY);
      }

      // Refusals: 400, 403, 404 and 409 write nothing.
      const quiet = await auditIds();
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'qa_analyst');
      const refusals = [
        await createActivity(AGENT_1, noteBody({ type: 'meeting' })),
        await createActivity(AGENT_2, noteBody()),
        await createActivity(AGENT_1, noteBody({ contactId: GRACE.id })),
        await updateActivity(AGENT_1, id, { version: created.version, completed: true }),
      ];
      expect(refusals.map((response) => response.status)).toEqual([400, 403, 404, 409]);
      expect(await auditSince(quiet), 'a refused write is not audited').toEqual([]);
    });
  });

  // =========================================================================
  // 10. Scope headers and PII in logs, spans and bodies (T13).
  // =========================================================================

  describe('scope headers and PII', () => {
    it('scope headers are 400 validation_failed on the timeline and both activity routes, and nothing is written', async () => {
      await plantTask(id61('a0030'));
      expectStatus(await timeline(AGENT_1, AMAKA.id), 200, 'control');
      const count = await activityCount();
      const before = await activityRow(id61('a0030'));
      for (const [header, value] of [
        ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
        ['x-kasuwa-programme-id', PROGRAMME_A2],
        ['x-kasuwa-scope', 'all'],
      ] as const) {
        expectError(
          await timeline(AGENT_1, DAMILOLA.id).set(header, value),
          400,
          'validation_failed',
        );
        expectError(
          await createActivity(SUPERVISOR, noteBody()).set(header, value),
          400,
          'validation_failed',
        );
        expectError(
          await updateActivity(SUPERVISOR, id61('a0030'), { version: 1, completed: true }).set(
            header,
            value,
          ),
          400,
          'validation_failed',
        );
      }
      expect(await activityCount()).toBe(count);
      expect(await activityRow(id61('a0030'))).toEqual(before);
    });

    it('no session is 401 on both activity routes', async () => {
      expectError(await createActivity({}, noteBody()), 401, 'not_authenticated');
      expectError(
        await updateActivity({}, NOWHERE, { version: 1, completed: true }),
        401,
        'not_authenticated',
      );
    });

    it('no phone, contact name, subject, body or Postgres detail reaches a log, a span or an error body', async () => {
      const PHONE = '+2348069061077';
      const GIVEN = `Ifeoma${RUN}`;
      const SUBJECT = `Probe subject ${RUN}`;
      const BODY = `Probe body ${RUN} owes 40000`;
      await plantActivity({
        id: id61('a0040'),
        type: 'note',
        subject: SUBJECT,
        body: BODY,
        contactId: AMAKA.id,
        createdByUserId: USER_A_SUPERVISOR,
      });
      // Agent 2 reads A1 as a qa_analyst: the 403 path, on a reachable target.
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'qa_analyst');
      const outcomes: [string, number, request.Response][] = [];
      const { telemetry, lines } = await captureEverything(async () => {
        outcomes.push([
          'contact PATCH with a phone and a name',
          200,
          await updateContact(SUPERVISOR, AMAKA.id, {
            version: await versionOf(AMAKA.id),
            givenNames: GIVEN,
            phones: [{ type: 'mobile', e164: PHONE }],
            status: 'contacted',
          }),
        ]);
        outcomes.push(['timeline read', 200, await timeline(AGENT_1, AMAKA.id)]);
        outcomes.push([
          'activity create',
          201,
          await createActivity(
            SUPERVISOR,
            noteBody({ type: 'task', subject: SUBJECT, body: BODY }),
          ),
        ]);
        // Each refusal carries the probes: the error path is where text leaks.
        outcomes.push([
          'complete a note (the CHECK path)',
          400,
          await updateActivity(SUPERVISOR, id61('a0040'), { version: 1, completed: true }),
        ]);
        outcomes.push([
          'NUL in the body',
          400,
          await createActivity(SUPERVISOR, noteBody({ subject: SUBJECT, body: `${BODY}\u0000` })),
        ]);
        outcomes.push([
          'dueAt on a note',
          400,
          await createActivity(
            SUPERVISOR,
            noteBody({ subject: SUBJECT, body: BODY, dueAt: '2026-12-01T09:00:00.000Z' }),
          ),
        ]);
        outcomes.push([
          'cross-programme account',
          400,
          await createActivity(
            SUPERVISOR,
            noteBody({ subject: SUBJECT, body: BODY, accountId: SABON.id }),
          ),
        ]);
        outcomes.push([
          'unreachable target',
          404,
          await createActivity(
            SUPERVISOR,
            noteBody({ subject: SUBJECT, body: BODY, contactId: GRACE.id }),
          ),
        ]);
        outcomes.push([
          'unpermitted (qa_analyst)',
          403,
          await createActivity(AGENT_2, noteBody({ subject: SUBJECT, body: BODY })),
        ]);
      });

      // The controls: every request did what it should, so a clean capture is
      // not the cleanliness of a server that answered everything with 404.
      expect(outcomes.map(([label, , response]) => [label, response.status])).toEqual(
        outcomes.map(([label, status]) => [label, status]),
      );
      const read = outcomes.find(([label]) => label === 'timeline read')?.[2];
      expect(JSON.stringify(read?.body), 'control: the timeline served the body').toContain(BODY);
      expect(
        telemetry.spans.length,
        'no spans were recorded — is telemetry wired?',
      ).toBeGreaterThan(0);

      const secrets = [...phoneForms(PHONE), GIVEN, SUBJECT, BODY, ROW_DETAIL];
      const haystacks: [string, string][] = [
        [JSON.stringify(telemetry.spans), 'spans (attributes and events)'],
        [lines.join('\n'), 'logs (Nest logger, stdout, stderr, console, OTel log records)'],
      ];
      for (const [haystack, what] of haystacks) {
        for (const secret of secrets) {
          expect(haystack, `${what} carry "${secret}"`).not.toContain(secret);
        }
      }
      for (const [label, status, response] of outcomes) {
        if (status < 400) continue;
        const raw = JSON.stringify(response.body);
        for (const secret of [...secrets, ...DATABASE_TEXT_IN_BODIES]) {
          expect(raw, `the ${label} error body carries "${secret}"`).not.toContain(secret);
        }
      }
    });
  });
});
