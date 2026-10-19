import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  USER_A_NO_PROGRAMME,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { readTableSecurity, reseed } from '@kasuwa/testing';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { parse } from 'yaml';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0113, script authoring: the `script` and `script_version`
 * tables (migration 0030) and the eight authoring operations of
 * `docs/api/scripting.openapi.yaml` (Agent 6; P10, manual mode).
 *
 * Written before the build (D-L23), from the contract and the decisions, not
 * from an implementation (D-L25). Sources: team/tasks/T-0113-script-authoring.md;
 * D-L88 (new tables approved, the 0027 pattern), D-L91 (who sees authoring,
 * `revision`, shape on save and completeness on publish, the seven locales),
 * D-L93 (publish refuses withheld and sensitive fields, bounds, NUL, 256 KiB,
 * id-only cursors), D-L76 (the allow-list key guard), D-L80 (no names in
 * cursors), D-L89 (the classification scale), D-L13 (sensitive fields wait);
 * CLAUDE.md 2.3, 2.4, 2.7 and 6.4. The contract is fixed and pinned by
 * tests/acceptance/platform/scripting-contract.acceptance.test.ts (T-0112).
 * Where this file and the YAML disagree, the YAML is right and this file is
 * the defect: say so in the report, do not edit it.
 *
 * Every response body is validated against the YAML with a small JSON-schema
 * checker (the T-0041 / T-0055 one, extended with allOf, propertyNames and
 * map-valued additionalProperties). Its self-check runs on main by design.
 *
 * ---------------------------------------------------------------------------
 * PINNED (the builder must honour these exactly)
 * ---------------------------------------------------------------------------
 *
 * TABLES
 *  T1. One migration file creates both `script` and `script_version` (found by
 *      `CREATE TABLE`, comments stripped, not by number), and it is applied.
 *      No SECURITY DEFINER function is added (CLAUDE.md 2.7).
 *  T2. Both tables: `id uuid` primary key, `tenant_id uuid NOT NULL`,
 *      `programme_id uuid NOT NULL`. `script_version` also has
 *      `script_id uuid NOT NULL` and `number integer NOT NULL`, and a valid,
 *      non-partial UNIQUE index over (script_id, number), optionally with
 *      tenant_id and programme_id: two publishes can never mint one number.
 *  T3. FKs: script -> programme on (tenant_id, programme_id); script_version
 *      -> script on (tenant_id, programme_id, script_id), so a version always
 *      lives in its script's programme. Every FK to a tenant-scoped table
 *      carries tenant_id. Every FK on either table is ON UPDATE RESTRICT.
 *  T4. RLS ENABLED and FORCED; every permissive policy names
 *      app.current_tenant_id() and app.current_programme_ids(); one has WITH
 *      CHECK identical to USING; both tables in TENANT_SCOPED_TABLES; owned by
 *      kasuwa_migrator; nothing kasuwa_app can enter holds TRUNCATE or
 *      BYPASSRLS.
 *  T5. Behaviour, as kasuwa_app inside withTenantTransaction: each session
 *      sees exactly its programmes' scripts and versions; an A1 session
 *      cannot change, delete or create rows in A2 or tenant B; a version
 *      cannot be attached to a script in another programme, even by a
 *      supervisor who sees both, and a real-but-unreachable script id fails
 *      exactly as an invented one (no existence oracle).
 *  T6. KEYS (D-L76 allow-list). script.id and script.programme_id cannot be
 *      changed by kasuwa_app or kasuwa_test_admin ("refused" or silently kept;
 *      the end state is what is asserted). A one-statement rotation of script
 *      ids is refused even for kasuwa_migrator while a version references
 *      one of them, and a script with versions cannot be moved to another
 *      programme by anyone (RESTRICT, not NO ACTION). The control:
 *      kasuwa_migrator, the one role D-L76's allow-list lets through, CAN
 *      move a script that has no versions.
 *  T7. A PUBLISHED VERSION IS IMMUTABLE FOR EVERY ROLE, kasuwa_migrator
 *      included: every column the probe can change on a trigger-free copy of
 *      the table (id, script_id, number and the jsonb content at least) stays
 *      unchanged on the real one for kasuwa_app, kasuwa_test_admin and
 *      kasuwa_migrator. kasuwa_app and kasuwa_test_admin cannot delete a
 *      version, and kasuwa_app cannot delete a script that has one.
 *      Offboarding still works: kasuwa_migrator deletes a programme, then a
 *      tenant, holding scripts with versions.
 *
 * API
 *  A1. `script.write` is the `admin` set in the script's programme, or the
 *      tenant-admin flag inside programmes the session reaches (the flag never
 *      widens scope). `agent`, `team_lead`, `programme_manager`,
 *      `qa_analyst` and `client_portal` hold none of it.
 *  A2. A caller without `script.write` in the script's programme, a caller in
 *      another tenant and a caller who reaches nothing get ONE 404 body,
 *      byte for byte, on getScript, updateScript, listScriptVersions,
 *      publishScript, getScriptVersion and putScriptTranslation: the same as
 *      for an id that names nothing. Nothing is written and nothing audited.
 *      listScripts leaves such scripts out (an empty page, never 403).
 *      createScript: a target programme the caller does not reach is 404; one
 *      it reaches without `script.write` is 403 not_permitted (the contract's
 *      only authoring 403).
 *  A3. Shape is checked on save: a graph that is not the closed six-kind
 *      union is 400 validation_failed naming the path (`graph`,
 *      `graph.nodes`, or the node by index or id). A NUL anywhere is 400
 *      `nul_character`. The bounds are 400. The draft, graph and translations
 *      together, is capped at 262144 BYTES serialised (UTF-8): over is 400
 *      `too_big` and nothing is written. A body under the cap is accepted
 *      even when it is larger than a framework's default body limit, and an
 *      over-cap body up to ~300 KB is 400 `too_big`, never 413.
 *  A4. Publish: 409 script_invalid with details naming node paths and codes:
 *      `missing_start`; `unknown_target` at the contract example's id-based
 *      paths (`nodes.<id>.next`, `nodes.<id>.choices.<key>.next`,
 *      `nodes.<id>.whenFalse`); `cycle`; `unreachable_end` (a loop with no
 *      way out); a node unreachable from the start is refused (code left to
 *      the builder); `unknown_field`; `unknown_variable`;
 *      `disposition_not_live` (one body for unknown, cross-programme,
 *      cross-tenant, deactivated and deleted); `branch_on_withheld_field`;
 *      `sensitive_field`; `unchanged`. Nothing is published on a 409.
 *      Reachability is linear: a 79-node graph with 2^26 paths publishes in
 *      under ten seconds.
 *  A5. Versions are 1, 2, 3 per script; republishing never changes an
 *      existing version; a version is the draft as it was at publish.
 *  A6. Audit: one event per successful write, `object_type 'script'`,
 *      `object_id` the script id, `programme_id` the script's programme,
 *      the session user as actor, and never any wording or publish note.
 *      Create is `created`; update and translation are `updated`; update
 *      names only `name`, `sourceLocale` and `graph` in `changes[].field`;
 *      a translation names its locale. Publish puts the ids of the compliance
 *      nodes added, removed and changed in `changes[]` entries whose `field`
 *      is `complianceNodesAdded`, `complianceNodesRemoved` and
 *      `complianceNodesChanged` (the `x-kasuwa-audit-names` spelling), each
 *      entry naming only its own bucket's ids; an unchanged compliance node
 *      is named nowhere. Refused writes write no event.
 *      A publish is exactly one event with action `published` (lead ruling on
 *      the T-0113 suite: migration 0030 extends audit_event's action CHECK,
 *      0008, with `published` and nothing else, and the API's AuditAction
 *      with it, so the admin audit API filters on it and returns the event
 *      as an AuditEntry; admin.openapi.yaml's AuditAction enum lists it).
 *  A7. Paging: `{ data, nextCursor }` only, no total in a body or a header;
 *      cursors never carry a name; a cursor is resolved inside its own list,
 *      so another list's, another script's, another tenant's and an
 *      out-of-scope row's cursor are each the same 400 invalid_cursor as
 *      garbage. `Cache-Control: no-store` exactly, on every response.
 *  A8. listProgrammeScripts (admin) is backed by the new tables and gated on
 *      `script.write`: real rows, `draft` before the first publish and
 *      `published` at the latest version number after; everyone else gets
 *      the unreachable programme's 404; `no-store`.
 *  A9. The eight authoring operations are `x-kasuwa-implemented: true`.
 *  A10. Error order as published in `x-kasuwa-error-order`.
 *  A11. A versionId that is not a uuid is 404, the same body as a version
 *      that does not exist (lead ruling; VersionId says "any other id is
 *      404").
 *
 *  The lead accepted R1-R9 below and the readings in the T-0113 suite report
 *  (createScript's 403 stands: the contract wins). The empty draft (201,
 *  never publishable) and unreachable_end (tested as a loop with no way out)
 *  stand as written.
 *
 * ---------------------------------------------------------------------------
 * READINGS BEYOND THE TASK FILE (suite-writer rulings; the lead may rule out)
 * ---------------------------------------------------------------------------
 *  R1. `branch_on_withheld_field` is judged against every set that holds
 *      `script.run` (agent, team_lead, programme_manager; admin), whether or
 *      not anyone in the programme holds that set today: assignments change
 *      after publish, and a grant is tenant-wide. A field withheld only from
 *      qa_analyst or client_portal does not block publishing.
 *  R2. Variables and branches inside TRANSLATIONS and choice labels are
 *      checked at publish exactly like the source wording. Otherwise a Hausa
 *      compliance line could carry a sensitive field the source refuses.
 *  R3. A compliance node whose TRANSLATED wording changed counts as
 *      `complianceNodesChanged` (D-P32: compliance wording in translation
 *      follows the same rule as the source).
 *  R4. Publishing an identical draft (even after re-saving it) is `unchanged`:
 *      content is compared, not the revision.
 *  R5. Duplicate node ids are refused on save (400) or at publish (409); a
 *      graph with two nodes of one id is never published.
 *  R6. A lone UTF-16 surrogate in wording is never a 5xx.
 *  R7. `money` without its currency and bounds, and `choice` without
 *      options, are shape errors (400) on save (FormField: "all three
 *      required", "required").
 *  R8. Concurrent publishes of one revision mint exactly one version; the
 *      other is 409 (stale_write or script_invalid), never a 5xx.
 *  R9. A cursor's raw and base64url-decoded forms never contain a script's
 *      name (D-L80 applied to scripts; names are not unique, D-L40).
 *
 * ---------------------------------------------------------------------------
 * THE BUILDER'S (not pinned)
 * ---------------------------------------------------------------------------
 * Every other column (the draft's jsonb, `revision`, names, locales,
 * timestamps, the publisher); constraint, trigger and index names; how the
 * immutability is enforced (a trigger is the task's instruction; this file
 * reads the end state); ON DELETE of script_version -> script; whether
 * kasuwa_migrator may delete a single version; how `versionNumber` is
 * recorded; detail paths other than the A4 ones; the order of details;
 * whether `hasUnpublishedChanges` is part of listProgrammeScripts; what an
 * empty draft (createScript without `graph`) looks like on the wire.
 *
 * ---------------------------------------------------------------------------
 * CROSS-SUITE EDITS IN THIS PR (lead-authorised; none loosens anything)
 * ---------------------------------------------------------------------------
 *  - scripting-contract (T-0112): the eight authoring operations are
 *    `x-kasuwa-implemented: true`, the nine run operations still false.
 *  - admin/dispositions-scripts (T-0027): agent 1 on listProgrammeScripts for
 *    A1 is the unreachable programme's 404; a script.write holder gets 200.
 *  - tenancy/schema-hygiene: a `script` plant for its updated_at probe;
 *    `script_version` carries no `updated_at`, and that probe's UPDATE is
 *    refused on a published version (the seed must carry one).
 *
 * VACUOUS-PASS GUARDS. Before the build every route is an unknown route (a
 * Nest 404 whose body is not the shared Error), so no "one 404" assertion
 * can pass by accident: each is preceded by a positive control in the same
 * test (the author reaching the same record), and every 404 is checked
 * against the shared Error schema and `code: not_found`. The self-checks
 * that pass on main are marked.
 *
 * WRITES. The suite reseeds before and after, and after every test in the
 * blocks that change grants, flags, classifications or dispositions. Rows
 * planted by kasuwa_migrator use this suite's id range (`01130000-...`).
 * Wording carries a per-run marker so the audit checks can prove it absent.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = resolve(REPO_ROOT, 'docs/api/scripting.openapi.yaml');
const ADMIN_SPEC_PATH = resolve(REPO_ROOT, 'docs/api/admin.openapi.yaml');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');

const SCRIPTS = '/api/v1/scripts';
const scriptPath = (id: string) => `${SCRIPTS}/${id}`;
const versionsPath = (id: string) => `${SCRIPTS}/${id}/versions`;
const versionPath = (id: string, versionId: string) => `${SCRIPTS}/${id}/versions/${versionId}`;
const translationPath = (id: string, locale: string) => `${SCRIPTS}/${id}/translations/${locale}`;
const programmeScriptsPath = (programmeId: string) =>
  `/api/v1/admin/programmes/${programmeId}/scripts`;

const RUN = Date.now().toString(36);
/** In every piece of wording, so its absence from an audit row is checkable. */
const MARK = `qz${RUN}mark`;

/** Fixed ids for this suite: `0113` marks T-0113. Nothing seeds them. */
const id13 = (tail: string): string => `01130000-0000-4000-8000-${tail.padStart(12, '0')}`;
const NOWHERE = id13('00000000ffff');
const NOWHERE_VERSION = id13('00000000fffe');

const DISPOSITION_LIVE = id13('0000000d0001');
const DISPOSITION_INACTIVE = id13('0000000d0002');
const DISPOSITION_DELETED = id13('0000000d0003');
const DISPOSITION_A2 = id13('0000000d0004');
const DISPOSITION_B1 = id13('0000000d0005');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALES = ['en', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw'] as const;

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_ADMIN = asUser(TENANT_B, USER_B_AGENT_1);

/** Every seeded set but `admin` (D-L88: script.write is the admin set's). */
const NON_WRITER_KEYS = [
  'agent',
  'team_lead',
  'programme_manager',
  'qa_analyst',
  'client_portal',
] as const;

/** The live scope headers the stub guard refuses (D-L63). */
const SCOPE_HEADERS = [
  ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
  ['x-kasuwa-programme-id', PROGRAMME_A2],
  ['x-kasuwa-scope', 'all'],
] as const;

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

function permissionSet(tenantId: string, key: string): string {
  const set = SEED_PERMISSION_SETS.find(
    (candidate) => candidate.tenantId === tenantId && candidate.key === key,
  );
  if (set === undefined) throw new Error(`Fixture drift: no seeded permission set '${key}'`);
  return set.id;
}

// ---------------------------------------------------------------------------
// The script graph fixtures.
// ---------------------------------------------------------------------------

type GraphNode = Json & { id: string; type: string };
interface Graph {
  startNodeId: string;
  nodes: GraphNode[];
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * A complete script with all six node kinds, a branch on a contact field,
 * variables of all three kinds and two compliance nodes. It publishes as is.
 */
function goodGraph(): Graph {
  return {
    startNodeId: 'greet',
    nodes: [
      {
        id: 'greet',
        type: 'say',
        title: 'Greeting',
        text: `Good afternoon, {contact.displayName}. My name is {agent.displayName}. ${MARK}`,
        next: 'rec',
        position: { x: 40, y: 30 },
      },
      {
        id: 'rec',
        type: 'compliance',
        title: 'Recording notice',
        text: `This call is recorded for quality and training. ${MARK}`,
        next: 'idq',
      },
      {
        id: 'idq',
        type: 'question',
        title: 'Account holder?',
        text: `Am I speaking with {contact.displayName}? ${MARK}`,
        hint: 'Confirm the name first.',
        choices: [
          { key: 'yes', label: 'Yes, confirmed', next: 'cust' },
          { key: 'no', label: 'Not the account holder', next: 'idfail' },
        ],
      },
      {
        id: 'idfail',
        type: 'end',
        title: 'Not the account holder',
        text: `I can only discuss this with the account holder. ${MARK}`,
      },
      {
        id: 'cust',
        type: 'branch',
        title: 'Existing customer?',
        condition: {
          source: 'contact_field',
          field: 'status',
          operator: 'one_of',
          value: ['customer'],
        },
        whenTrue: 'payq',
        whenFalse: 'intro',
      },
      {
        id: 'intro',
        type: 'say',
        title: 'Introduce the offer',
        text: `Thank you. I am calling about your application. ${MARK}`,
        next: 'payq',
      },
      {
        id: 'payq',
        type: 'question',
        title: 'Can pay today?',
        text: `Can you make a payment today? ${MARK}`,
        choices: [
          { key: 'ptp', label: 'Agrees to pay', next: 'ptp' },
          { key: 'refuse', label: 'Refuses to pay', next: 'refused' },
        ],
      },
      {
        id: 'ptp',
        type: 'form',
        title: 'Promise to pay',
        text: `Let us agree the date and amount. ${MARK}`,
        fields: [
          {
            key: 'date',
            label: 'Promise date',
            type: 'date',
            required: true,
            minDaysAhead: 0,
            maxDaysAhead: 14,
          },
          {
            key: 'amount',
            label: 'Amount',
            type: 'money',
            required: true,
            currency: 'NGN',
            minimumMinor: '500000',
            maximumMinor: '100000000',
          },
        ],
        next: 'readback',
      },
      { id: 'refused', type: 'end', title: 'Refused' },
      {
        id: 'readback',
        type: 'compliance',
        title: 'Read-back',
        text: `You will pay {answer.ptp.amount} on {answer.ptp.date}. We never ask for your PIN. ${MARK}`,
        next: 'close',
      },
      {
        id: 'close',
        type: 'end',
        title: 'Close',
        text: `Thank you for your time, {contact.displayName}. ${MARK}`,
      },
    ],
  };
}

/** The graph with one node replaced (or removed, when `change` returns null). */
function withNode(graph: Graph, id: string, change: (node: GraphNode) => GraphNode | null): Graph {
  const next = copy(graph);
  const index = next.nodes.findIndex((node) => node.id === id);
  if (index < 0) throw new Error(`fixture: no node ${id}`);
  const current = next.nodes[index] as GraphNode;
  const replaced = change(current);
  if (replaced === null) next.nodes.splice(index, 1);
  else next.nodes[index] = replaced;
  return next;
}

function addNodes(graph: Graph, ...nodes: GraphNode[]): Graph {
  const next = copy(graph);
  next.nodes.push(...nodes);
  return next;
}

/** The graph's `greet` text with something appended. */
const greetSays = (graph: Graph, extra: string): Graph =>
  withNode(graph, 'greet', (node) => ({ ...node, text: `${String(node.text)} ${extra}` }));

/** A chain of `count` say nodes, each with `text`, ending at `fin`. */
function chainOfSays(count: number, text: string): Graph {
  const nodes: GraphNode[] = [];
  for (let index = 0; index < count; index += 1) {
    nodes.push({
      id: `s${index}`,
      type: 'say',
      title: `Line ${index}`,
      text,
      next: index + 1 < count ? `s${index + 1}` : 'fin',
    });
  }
  nodes.push({ id: 'fin', type: 'end', title: 'End' });
  return { startNodeId: 's0', nodes };
}

/**
 * `count` diamonds in a row: question q<i> forks to l<i> and r<i>, both of
 * which join at q<i+1>. 3 * count + 1 nodes, 2^count distinct paths.
 */
function diamonds(count: number): Graph {
  const nodes: GraphNode[] = [];
  for (let index = 0; index < count; index += 1) {
    const join = index + 1 < count ? `q${index + 1}` : 'fin';
    nodes.push({
      id: `q${index}`,
      type: 'question',
      title: `Fork ${index}`,
      text: `Left or right? ${MARK}`,
      choices: [
        { key: 'left', label: 'Left', next: `l${index}` },
        { key: 'right', label: 'Right', next: `r${index}` },
      ],
    });
    nodes.push({ id: `l${index}`, type: 'say', title: 'Left', text: 'Left.', next: join });
    nodes.push({ id: `r${index}`, type: 'say', title: 'Right', text: 'Right.', next: join });
  }
  nodes.push({ id: 'fin', type: 'end', title: 'End' });
  return { startNodeId: 'q0', nodes };
}

const serialisedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

// ---------------------------------------------------------------------------
// A small JSON-schema checker over the published YAML (no new dependency).
// The T-0041 / T-0055 checker, plus allOf, propertyNames, min/maxProperties
// and additionalProperties as a schema (Translations and TranslationTexts are
// maps).
// ---------------------------------------------------------------------------

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
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
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
      errors.push(`${path}: matches ${passing.length} oneOf branches`);
    }
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
    const keys = Object.keys(object);
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) errors.push(`${path}: required property "${key}" is missing`);
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      errors.push(`${path}: more than ${schema.maxProperties} properties`);
    }
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      errors.push(`${path}: fewer than ${schema.minProperties} properties`);
    }
    if (typeof schema.propertyNames === 'object' && schema.propertyNames !== null) {
      for (const key of keys) {
        check(schema.propertyNames as Json, at, key, `${path}{${key}}`, errors);
      }
    }
    for (const [key, child] of Object.entries(object)) {
      const childSchema = properties[key];
      if (childSchema !== undefined) {
        check(childSchema, at, child, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: property "${key}" is not allowed`);
      } else if (
        typeof schema.additionalProperties === 'object' &&
        schema.additionalProperties !== null
      ) {
        check(schema.additionalProperties as Json, at, child, `${path}.${key}`, errors);
      }
    }
  }
}

function schemaErrors(value: unknown, ref: string, file = SPEC_PATH): string[] {
  const errors: string[] = [];
  check({ $ref: ref }, file, value, '$', errors);
  return errors;
}

function expectSchema(value: unknown, name: string, where: string, file = SPEC_PATH): void {
  expect(
    schemaErrors(value, `#/components/schemas/${name}`, file),
    `${where} does not match #/components/schemas/${name}`,
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Wire types and response checks.
// ---------------------------------------------------------------------------

interface VersionSummary {
  id: string;
  number: number;
  publishedAt: string;
  publishedBy: { id: string; displayName: string } | null;
}

interface Script {
  id: string;
  programmeId: string;
  name: string;
  sourceLocale: string;
  translatedLocales: string[];
  hasUnpublishedChanges: boolean;
  latestVersion: VersionSummary | null;
  draft: { graph: Graph; translations: Record<string, Json> };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface Version {
  id: string;
  scriptId: string;
  number: number;
  name: string;
  sourceLocale: string;
  graph: Graph;
  translations: Record<string, Json>;
  changes: string[];
  publishedAt: string;
  publishedBy: { id: string; displayName: string } | null;
}

interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

interface Detail {
  path: string;
  code: string;
}

function expectNoStore(response: request.Response, where: string): void {
  expect(
    response.headers['cache-control'],
    `${where}: Cache-Control must be exactly no-store (contract header NoStore)`,
  ).toBe('no-store');
}

/** D-P13: a count in a header is a total by another name. */
function expectNoTotals(response: request.Response, where: string): void {
  const headers = Object.keys(response.headers).filter((name) => /total|count/i.test(name));
  expect(headers, `${where}: a response header carries a total`).toEqual([]);
}

function expectStatus(response: request.Response, status: number, what: string): void {
  expect(
    response.status,
    `${what}: expected ${status}, got ${response.status} ${response.text.slice(0, 400)}`,
  ).toBe(status);
}

/** admin.openapi.yaml `Error`, with the status and `code`, and no-store. */
function expectError(response: request.Response, status: number, code: string): Json {
  expect(
    response.status,
    `expected ${status} ${code}, got ${response.status} ${response.text.slice(0, 400)}`,
  ).toBe(status);
  expect(
    schemaErrors(response.body, './admin.openapi.yaml#/components/schemas/Error'),
    'the body does not match the shared Error schema',
  ).toEqual([]);
  const body = response.body as Json;
  expect(body.statusCode, 'Error.statusCode').toBe(status);
  expect(body.code, 'Error.code (clients switch on this, never on message)').toBe(code);
  expectNoStore(response, `${status} ${code}`);
  return body;
}

function detailsOf(body: Json): Detail[] {
  return Array.isArray(body.details) ? (body.details as Detail[]) : [];
}

/** A 400 with a detail of `code` (any code when undefined) whose path passes `path`. */
function expect400(response: request.Response, path: RegExp, code?: string): Json {
  const body = expectError(response, 400, 'validation_failed');
  const details = detailsOf(body);
  const matching = details.filter(
    (detail) => path.test(detail.path) && (code === undefined || detail.code === code),
  );
  expect(
    matching.length,
    `no detail ${code ?? '(any code)'} at ${String(path)}: ${JSON.stringify(details)}`,
  ).toBeGreaterThan(0);
  return body;
}

/** `graph.nodes.<index>` or `graph.nodes.<id>`, optionally followed by more. */
function nodePath(graph: Graph, id: string, rest = ''): RegExp {
  const index = graph.nodes.findIndex((node) => node.id === id);
  return new RegExp(`^graph\\.nodes\\.(${index}|${id})${rest}(\\.|\\[|$)`);
}

function expectScript(value: unknown, where: string): Script {
  expectSchema(value, 'Script', where);
  return value as Script;
}

function expectVersion(value: unknown, where: string): Version {
  expectSchema(value, 'ScriptVersion', where);
  return value as Version;
}

function expectScriptPage(response: request.Response, where: string): Page<Json> {
  expectStatus(response, 200, where);
  expectSchema(response.body, 'ScriptPage', where);
  const page = response.body as Page<Json>;
  expect(Object.keys(page).sort(), `${where}: a keyset page is data and nextCursor only`).toEqual([
    'data',
    'nextCursor',
  ]);
  expectNoStore(response, where);
  expectNoTotals(response, where);
  return page;
}

function expectVersionPage(response: request.Response, where: string): Page<VersionSummary> {
  expectStatus(response, 200, where);
  expectSchema(response.body, 'ScriptVersionPage', where);
  const page = response.body as Page<VersionSummary>;
  expect(Object.keys(page).sort(), `${where}: a keyset page is data and nextCursor only`).toEqual([
    'data',
    'nextCursor',
  ]);
  expectNoStore(response, where);
  expectNoTotals(response, where);
  return page;
}

/** Word-boundary match for a node id inside serialised text. */
const namesId = (text: string, id: string): boolean =>
  new RegExp(`(^|[^a-z0-9_])${id}([^a-z0-9_]|$)`).test(text);

/** Every way a cursor could be read back into text (D-L80). */
function cursorForms(cursor: string): string[] {
  const forms = [cursor];
  try {
    forms.push(decodeURIComponent(cursor));
  } catch {
    // not URI-encoded; the raw form is enough
  }
  for (const encoding of ['base64url', 'base64'] as const) {
    forms.push(Buffer.from(cursor, encoding).toString('utf8'));
  }
  return forms;
}

// ---------------------------------------------------------------------------
// Database probing (the T-0060 suite's helpers, restated, never shared).
// ---------------------------------------------------------------------------

type Query = <R extends QueryResultRow>(sql: string, values?: unknown[]) => Promise<R[]>;

type Outcome =
  { accepted: true } | { accepted: false; code: string; message: string; detail: string };

function outcomeOf(error: unknown): Outcome {
  const { code, message, detail } = error as {
    code?: unknown;
    message?: unknown;
    detail?: unknown;
  };
  return {
    accepted: false,
    code: typeof code === 'string' ? code : '?',
    message: typeof message === 'string' ? message : String(error),
    detail: typeof detail === 'string' ? detail : '',
  };
}

async function probe(
  query: Query,
  sql: string,
  values: unknown[] = [],
  keep = false,
): Promise<Outcome> {
  await query('SAVEPOINT t0113_probe');
  let outcome: Outcome;
  try {
    await query(sql, values);
    await query('SET CONSTRAINTS ALL IMMEDIATE');
    outcome = { accepted: true };
  } catch (error) {
    outcome = outcomeOf(error);
  }
  if (keep && outcome.accepted) await query('RELEASE SAVEPOINT t0113_probe');
  else await query('ROLLBACK TO SAVEPOINT t0113_probe');
  return outcome;
}

function verdict(outcome: Outcome): string {
  if (outcome.accepted) return 'accepted';
  const { code, message } = outcome;
  if (code === '23503') return 'foreign_key_violation';
  if (code === '23502') return 'not_null_violation';
  if (code === '23505') return 'unique_violation';
  if (code === '42501') return 'insufficient_privilege';
  if (code === 'P0001' || code.startsWith('23') || code.startsWith('22')) return 'refused';
  // 42P01 (no such table) and 42703 (no such column) land here verbatim.
  return `error ${code}: ${message}`;
}

const REFUSALS = ['foreign_key_violation', 'refused', 'insufficient_privilege'];

class Rollback<T> {
  constructor(readonly value: T) {}
}

async function rolledBackTenantTx<T>(
  pool: Pool,
  tenantId: string,
  userId: string,
  fn: (query: Query) => Promise<T>,
): Promise<T> {
  try {
    await withTenantTransaction(pool, { tenantId, userId }, async (tx) => {
      const query: Query = (text, params) => tx.query(text, params);
      throw new Rollback(await fn(query));
    });
  } catch (signal) {
    if (signal instanceof Rollback) return signal.value as T;
    throw signal;
  }
  throw new Error('unreachable: the callback always throws');
}

async function rolledBackTx<T>(pool: Pool, fn: (query: Query) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const query: Query = async (text, params) => (await client.query(text, params)).rows;
    return await fn(query);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * INSERT a copy of one row with some columns overridden, naming only the
 * columns the current role may insert. Column-agnostic: the builder's column
 * set is the builder's.
 */
async function cloneSql(query: Query, table: string): Promise<string> {
  const columns = await query<{ quoted: string }>(
    `SELECT quote_ident(a.attname) AS quoted
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege(current_user, a.attrelid, a.attnum, 'INSERT')
      ORDER BY a.attnum`,
    [`public.${table}`],
  );
  const list = columns.map((column) => column.quoted);
  return `INSERT INTO ${table} (${list.join(', ')})
          SELECT ${list.map((column) => `r.${column}`).join(', ')}
            FROM ${table} s,
                 LATERAL jsonb_populate_record(NULL::${table}, to_jsonb(s) || $2::jsonb) AS r
           WHERE s.id = $1`;
}

async function cloneRow(query: Query, table: string, sourceId: string, overrides: Json) {
  await query(await cloneSql(query, table), [sourceId, JSON.stringify(overrides)]);
}

interface ColumnInfo {
  name: string;
  quoted: string;
  type: string;
}

async function columnsOf(query: Query, table: string): Promise<ColumnInfo[]> {
  return query<ColumnInfo>(
    `SELECT a.attname AS name, quote_ident(a.attname) AS quoted,
            format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [`public.${table}`],
  );
}

/**
 * One UPDATE per column that would change row $1 if nothing stopped it: the
 * other row's value when the two differ, else a type-specific change.
 * Returns null for a column it cannot change without guessing (an equal uuid).
 */
function mutationFor(
  table: string,
  column: ColumnInfo,
  differs: boolean,
): { sql: string; withOther: boolean } | null {
  const c = column.quoted;
  const set = (expression: string, withOther = false) => ({
    sql: `UPDATE ${table} SET ${c} = ${expression} WHERE id = $1`,
    withOther,
  });
  if (column.name === 'id') return set('gen_random_uuid()');
  if (/^(smallint|integer|bigint)$/.test(column.type)) return set(`${c} + 1000`);
  if (differs) return set(`(SELECT o.${c} FROM ${table} o WHERE o.id = $2)`, true);
  if (column.type === 'text' || column.type.startsWith('character varying')) {
    return set(`${c} || ' t0113'`);
  }
  if (column.type.startsWith('timestamp')) return set(`${c} - interval '1 day'`);
  if (column.type === 'boolean') return set(`NOT ${c}`);
  if (column.type === 'text[]') return set(`${c} || ARRAY['t0113']`);
  if (column.type === 'jsonb') {
    return set(
      `CASE jsonb_typeof(${c}) WHEN 'object' THEN ${c} || '{"t0113": true}'::jsonb
                               WHEN 'array' THEN ${c} || '["t0113"]'::jsonb
                               ELSE jsonb_build_array(${c}) END`,
    );
  }
  return null;
}

type Mutation = 'changed' | 'unchanged' | 'refused';

/** Tries every column's mutation on row `id`, each undone afterwards. */
async function mutationOutcomes(
  query: Query,
  table: string,
  id: string,
  otherId: string,
  snapshot: () => Promise<string>,
): Promise<Record<string, Mutation>> {
  const result: Record<string, Mutation> = {};
  for (const column of await columnsOf(query, table)) {
    const differs = (
      await query<{ differs: boolean }>(
        `SELECT (a.${column.quoted} IS DISTINCT FROM b.${column.quoted}) AS differs
           FROM ${table} a, ${table} b WHERE a.id = $1 AND b.id = $2`,
        [id, otherId],
      )
    )[0]?.differs;
    const mutation = mutationFor(table, column, differs === true);
    if (mutation === null) continue;
    await query('SAVEPOINT t0113_column');
    const before = await snapshot();
    const outcome = await probe(
      query,
      mutation.sql,
      mutation.withOther ? [id, otherId] : [id],
      true,
    );
    result[column.name] = !outcome.accepted
      ? 'refused'
      : (await snapshot()) === before
        ? 'unchanged'
        : 'changed';
    await query('ROLLBACK TO SAVEPOINT t0113_column');
  }
  return result;
}

const snapshotOf = (query: Query, table: string, tenantId: string) => async (): Promise<string> =>
  (
    await query<{ h: string }>(
      `SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) AS h
         FROM ${table} t WHERE t.tenant_id = $1`,
      [tenantId],
    )
  )[0]?.h ?? '';

/** `CREATE TABLE <name> (`, comments stripped; `script` never matches `script_version`. */
const createsTable = (table: string): RegExp =>
  new RegExp(
    `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"?public"?\\.)?"?${table}"?\\s*\\(`,
    'i',
  );
const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');

function migrationsCreating(table: string): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) =>
      createsTable(table).test(stripLineComments(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))),
    )
    .sort();
}

const DEFINERS_SQL = `
  SELECT n.nspname || '.' || p.proname AS name
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`;

/** audit_event_action_check as 0008 wrote it. 0030 adds `published` and nothing else. */
const AUDIT_ACTIONS_0008 = [
  'created',
  'updated',
  'deleted',
  'exported',
  'invited',
  'viewed',
  'failed_sign_in',
  'rejected',
  'rotated',
  'played_recording',
] as const;

/** The quoted literals of a CHECK definition, sorted. */
const checkValues = (definition: string): string[] =>
  [...definition.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '').sort();

/** One-statement id rotation (D-L76): X takes a fresh id, Y takes X's old one. */
const rotationSql = (table: string) => `
  UPDATE ${table}
     SET id = CASE id WHEN $1::uuid THEN $3::uuid ELSE $1::uuid END
   WHERE tenant_id = $4 AND id IN ($1::uuid, $2::uuid)`;

const ROTATE_X = id13('00000000c0a1');
const ROTATE_Y = id13('00000000c0a2');
const ROTATE_FRESH = id13('00000000c0af');

// ===========================================================================

describe('acceptance: script authoring (T-0113)', () => {
  let app: INestApplication;
  /** kasuwa_app, NOBYPASSRLS: every assertion about what a session may do. */
  let appPool: Pool;
  /** kasuwa_migrator: owns the schema; plants and observes; never serves. */
  let observer: Pool;
  /** kasuwa_test_admin: BYPASSRLS, DML on the new tables by default. */
  let testAdmin: Pool;

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    app = await createApi(inject('databaseUrl'));
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    testAdmin = createPool({ connectionString: inject('testAdminUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await observer?.end();
    await testAdmin?.end();
    await reseed(inject('migrationUrl'));
  });

  const server = () => app.getHttpServer();

  // --- HTTP -----------------------------------------------------------------

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const listRaw = (headers: Headers, params: Params = []) =>
    request(server()).get(withQuery(SCRIPTS, params)).set(headers);
  const createRaw = (headers: Headers, body: unknown) =>
    request(server())
      .post(SCRIPTS)
      .set(headers)
      .send(body as object);
  const getRaw = (headers: Headers, id: string) =>
    request(server()).get(scriptPath(id)).set(headers);
  const updateRaw = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(scriptPath(id))
      .set(headers)
      .send(body as object);
  const versionsRaw = (headers: Headers, id: string, params: Params = []) =>
    request(server())
      .get(withQuery(versionsPath(id), params))
      .set(headers);
  const publishRaw = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .post(versionsPath(id))
      .set(headers)
      .send(body as object);
  const versionRaw = (headers: Headers, id: string, versionId: string) =>
    request(server()).get(versionPath(id, versionId)).set(headers);
  const translateRaw = (headers: Headers, id: string, locale: string, body: unknown) =>
    request(server())
      .put(translationPath(id, locale))
      .set(headers)
      .send(body as object);
  const programmeScriptsRaw = (headers: Headers, programmeId: string, params: Params = []) =>
    request(server())
      .get(withQuery(programmeScriptsPath(programmeId), params))
      .set(headers);

  let sequence = 0;
  const unique = (label: string) => `${label} ${RUN}-${(sequence += 1)}`;

  async function createScript(
    headers: Headers = SUPERVISOR,
    extra: Record<string, unknown> = {},
  ): Promise<Script> {
    const body = Object.fromEntries(
      Object.entries({
        programmeId: PROGRAMME_A1,
        name: unique('T0113 script'),
        sourceLocale: 'en',
        graph: goodGraph(),
        ...extra,
      }).filter(([, value]) => value !== undefined),
    );
    const response = await createRaw(headers, body);
    expectStatus(response, 201, 'createScript (an author creating a draft)');
    expectNoStore(response, 'createScript 201');
    return expectScript(response.body, 'createScript');
  }

  async function readScript(id: string, headers: Headers = SUPERVISOR): Promise<Script> {
    const response = await getRaw(headers, id);
    expectStatus(response, 200, 'getScript (the author)');
    expectNoStore(response, 'getScript 200');
    return expectScript(response.body, 'getScript');
  }

  async function saveGraph(id: string, graph: Graph, headers: Headers = SUPERVISOR) {
    const { revision } = await readScript(id, headers);
    const response = await updateRaw(headers, id, { revision, graph });
    expectStatus(response, 200, 'updateScript (save a draft graph)');
    return expectScript(response.body, 'updateScript');
  }

  async function translate(id: string, locale: string, texts: Json, headers: Headers = SUPERVISOR) {
    const { revision } = await readScript(id, headers);
    const response = await translateRaw(headers, id, locale, { revision, texts });
    expectStatus(response, 200, `putScriptTranslation ${locale}`);
    return expectScript(response.body, 'putScriptTranslation');
  }

  async function publishNow(id: string, headers: Headers = SUPERVISOR, extra: Json = {}) {
    const { revision } = await readScript(id, headers);
    return publishRaw(headers, id, { revision, ...extra });
  }

  async function publish(id: string, headers: Headers = SUPERVISOR, extra: Json = {}) {
    const response = await publishNow(id, headers, extra);
    expectStatus(response, 201, 'publishScript');
    expectNoStore(response, 'publishScript 201');
    return expectVersion(response.body, 'publishScript');
  }

  interface Published {
    script: Script;
    version: Version;
  }

  async function publishedScript(
    headers: Headers = SUPERVISOR,
    programmeId: string = PROGRAMME_A1,
    graph: Graph = goodGraph(),
  ): Promise<Published> {
    const created = await createScript(headers, { programmeId, graph });
    const version = await publish(created.id, headers);
    return { script: await readScript(created.id, headers), version };
  }

  async function versionsOf(id: string): Promise<VersionSummary[]> {
    return expectVersionPage(await versionsRaw(SUPERVISOR, id, [['limit', '100']]), 'versions')
      .data;
  }

  // --- the observer ---------------------------------------------------------

  interface AuditRow {
    id: string;
    actor_kind: string;
    actor_user_id: string | null;
    action: string;
    object_type: string;
    object_id: string | null;
    object_label: string;
    programme_id: string | null;
    changes: { field: string; before?: unknown; after?: unknown; redacted?: unknown }[];
  }

  async function auditIds(): Promise<Set<string>> {
    const result = await observer.query<{ id: string }>('SELECT id FROM audit_event');
    return new Set(result.rows.map((row) => row.id));
  }

  async function auditSince(before: Set<string>, objectId?: string): Promise<AuditRow[]> {
    const result = await observer.query<AuditRow>('SELECT * FROM audit_event ORDER BY occurred_at');
    return result.rows.filter(
      (row) => !before.has(row.id) && (objectId === undefined || row.object_id === objectId),
    );
  }

  async function assign(tenantId: string, userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, tenantId, permissionSet(tenantId, key)],
    );
  }

  async function setTenantAdmin(userId: string, value: boolean) {
    await observer.query('UPDATE "user" SET is_tenant_admin = $1 WHERE id = $2', [value, userId]);
  }

  /** One field-security decision on a STANDARD contact field_def the seed holds. */
  async function lockContactField(
    field: string,
    setKey: string,
    level: 'none' | 'read' | 'edit',
    tenantId: string = TENANT_A,
  ) {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = $2`,
      [tenantId, field],
    );
    const fieldId = found.rows[0]?.id;
    if (fieldId === undefined) throw new Error(`Fixture drift: no standard contact.${field}`);
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [tenantId, fieldId, permissionSet(tenantId, setKey), level],
    );
  }

  /** Raise a standard contact field to `sensitive` (0029 allows raising, D-L89). */
  async function makeSensitive(field: string) {
    const result = await observer.query(
      `UPDATE field_def f SET classification = 'sensitive'
         FROM object_def o
        WHERE o.id = f.object_id AND o.tenant_id = f.tenant_id
          AND f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = $2
       RETURNING f.id`,
      [TENANT_A, field],
    );
    expect(result.rowCount, `Fixture drift: no standard contact.${field}`).toBe(1);
  }

  async function plantDispositions() {
    await observer.query(
      `INSERT INTO disposition
         (id, tenant_id, programme_id, code, label, category, active, position, deleted_at)
       VALUES ($1, $6, $8, 'T0113_LIVE', 'Promise to pay', 'promise_to_pay', true, 901, NULL),
              ($2, $6, $8, 'T0113_OFF', 'Paused outcome', 'resolved', false, 902, NULL),
              ($3, $6, $8, 'T0113_GONE', 'Removed outcome', 'resolved', true, NULL, now()),
              ($4, $6, $9, 'T0113_A2', 'Promise to pay', 'promise_to_pay', true, 901, NULL),
              ($5, $7, $10, 'T0113_B1', 'Promise to pay', 'promise_to_pay', true, 901, NULL)`,
      [
        DISPOSITION_LIVE,
        DISPOSITION_INACTIVE,
        DISPOSITION_DELETED,
        DISPOSITION_A2,
        DISPOSITION_B1,
        TENANT_A,
        TENANT_B,
        PROGRAMME_A1,
        PROGRAMME_A2,
        PROGRAMME_B1,
      ],
    );
  }

  async function requireTables(): Promise<void> {
    const found = await observer.query<{ script: boolean; script_version: boolean }>(
      `SELECT to_regclass('public.script') IS NOT NULL AS script,
              to_regclass('public.script_version') IS NOT NULL AS script_version`,
    );
    expect(found.rows[0], 'the script and script_version tables do not exist').toEqual({
      script: true,
      script_version: true,
    });
  }

  // =========================================================================
  // 1. The contract file.
  // =========================================================================

  describe('the contract file', () => {
    it('(self-check) the checker accepts the contract’s Script and ScriptVersion examples and rejects broken copies', () => {
      // Passes on main by design: it tests this file's checker, not the API.
      const examples = (loadDoc(SPEC_PATH) as { components: { examples: Record<string, Json> } })
        .components.examples;
      const script = copy(examples.Script?.value) as Json;
      const version = copy(examples.ScriptVersion?.value) as Json;
      expect(schemaErrors(script, '#/components/schemas/Script')).toEqual([]);
      expect(schemaErrors(version, '#/components/schemas/ScriptVersion')).toEqual([]);

      const draft = script.draft as { graph: Graph; translations: Json };
      const mutants: [string, Json][] = [
        [
          'a disposition node',
          {
            ...script,
            draft: {
              ...draft,
              graph: withNode(draft.graph, 'close', (n) => ({ ...n, type: 'disposition' })),
            },
          },
        ],
        [
          'a say node that writes to the record',
          {
            ...script,
            draft: {
              ...draft,
              graph: withNode(draft.graph, 'greet', (n) => ({ ...n, writesTo: 'status' })),
            },
          },
        ],
        [
          'a free-form graph key',
          { ...script, draft: { ...draft, graph: { ...draft.graph, edges: [] } } },
        ],
        [
          'a translation in an unsupported locale',
          { ...script, draft: { ...draft, translations: { de: {} } } },
        ],
        [
          'a translation keyed by a non-node id',
          { ...script, draft: { ...draft, translations: { pcm: { 'Not An Id': { text: 'x' } } } } },
        ],
        ['revision 0', { ...script, revision: 0 }],
        ['a tenantId', { ...script, tenantId: TENANT_A }],
        ['no draft', Object.fromEntries(Object.entries(script).filter(([key]) => key !== 'draft'))],
      ];
      for (const [label, mutant] of mutants) {
        expect(
          schemaErrors(mutant, '#/components/schemas/Script').length,
          `the checker accepted a Script with ${label}`,
        ).toBeGreaterThan(0);
      }
      expect(
        schemaErrors({ ...version, number: 0 }, '#/components/schemas/ScriptVersion').length,
      ).toBeGreaterThan(0);
    });

    it('(self-check) the fixture graph is a valid ScriptGraph, and the size fixtures sit where the tests need them', () => {
      // Passes on main by design. Without it, a "400" below could be about a
      // fixture this file got wrong, and an "accepted" could be undersized.
      expect(schemaErrors(goodGraph(), '#/components/schemas/ScriptGraph')).toEqual([]);
      expect(schemaErrors(diamonds(26), '#/components/schemas/ScriptGraph')).toEqual([]);
      const under = chainOfSays(45, 'a'.repeat(4000));
      const overInBytes = chainOfSays(24, '₦'.repeat(4000));
      expect(schemaErrors(under, '#/components/schemas/ScriptGraph')).toEqual([]);
      expect(schemaErrors(overInBytes, '#/components/schemas/ScriptGraph')).toEqual([]);
      // Under the cap, but over a framework's default 100 KB JSON body limit.
      expect(serialisedBytes({ graph: under, translations: {} })).toBeGreaterThan(102_400);
      expect(serialisedBytes({ graph: under, translations: {} })).toBeLessThan(200_000);
      // Over the cap in UTF-8 bytes, under it in UTF-16 code units.
      expect(serialisedBytes({ graph: overInBytes, translations: {} })).toBeGreaterThan(262_144);
      expect(JSON.stringify({ graph: overInBytes, translations: {} }).length).toBeLessThan(262_144);
      expect(serialisedBytes({ graph: overInBytes, translations: {} })).toBeLessThan(300_000);
    });

    it('the eight authoring operations are x-kasuwa-implemented: true once served', () => {
      const spec = loadDoc(SPEC_PATH) as { paths: Record<string, Record<string, Json>> };
      const flag = (path: string, method: string) =>
        spec.paths[path]?.[method]?.['x-kasuwa-implemented'];
      expect({
        listScripts: flag(SCRIPTS, 'get'),
        createScript: flag(SCRIPTS, 'post'),
        getScript: flag(`${SCRIPTS}/{scriptId}`, 'get'),
        updateScript: flag(`${SCRIPTS}/{scriptId}`, 'patch'),
        listScriptVersions: flag(`${SCRIPTS}/{scriptId}/versions`, 'get'),
        publishScript: flag(`${SCRIPTS}/{scriptId}/versions`, 'post'),
        getScriptVersion: flag(`${SCRIPTS}/{scriptId}/versions/{versionId}`, 'get'),
        putScriptTranslation: flag(`${SCRIPTS}/{scriptId}/translations/{locale}`, 'put'),
      }).toEqual({
        listScripts: true,
        createScript: true,
        getScript: true,
        updateScript: true,
        listScriptVersions: true,
        publishScript: true,
        getScriptVersion: true,
        putScriptTranslation: true,
      });
    });
  });

  // =========================================================================
  // 2. The tables: catalogue.
  // =========================================================================

  describe('the tables: migration, columns, keys and tenancy', () => {
    it('one migration creates both tables, and the runner applied it', async () => {
      const scriptFiles = migrationsCreating('script');
      const versionFiles = migrationsCreating('script_version');
      expect(scriptFiles, 'migrations creating `script`').toHaveLength(1);
      expect(versionFiles, 'migrations creating `script_version`').toEqual(scriptFiles);
      const ids = scriptFiles.map((name) => name.replace(/\.sql$/, ''));
      const applied = await observer.query<{ id: string }>(
        'SELECT id FROM _kasuwa_migration WHERE id = ANY ($1::text[])',
        [ids],
      );
      expect(applied.rows.map((row) => row.id)).toEqual(ids);
    });

    it('(self-check) the migration scan tells script from script_version and ignores comments', () => {
      // Passes on main by design: guards the scan against a vacuous miss.
      expect(createsTable('script').test('CREATE TABLE script (\n id uuid')).toBe(true);
      expect(createsTable('script').test('create table if not exists public.script(')).toBe(true);
      expect(createsTable('script').test('CREATE TABLE script_version (')).toBe(false);
      expect(createsTable('script').test('CREATE TABLE script_run (')).toBe(false);
      expect(createsTable('script_version').test('CREATE TABLE script_version (')).toBe(true);
      expect(
        createsTable('script').test(stripLineComments('-- CREATE TABLE script (\nSELECT 1;')),
      ).toBe(false);
    });

    it('adds no SECURITY DEFINER function: the census is still the two CLAUDE.md 2.7 names', async () => {
      // A regression guard; passes on main.
      const definers = await observer.query<{ name: string }>(DEFINERS_SQL);
      expect(definers.rows.map((row) => row.name)).toEqual([
        'app.resolve_session',
        'app.resolve_tenant_by_slug',
      ]);
    });

    async function columns(table: string) {
      const rows = await observer.query<{ column: string; type: string; notnull: boolean }>(
        `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS notnull
           FROM pg_attribute a
          WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
        [`public.${table}`],
      );
      return Object.fromEntries(rows.rows.map((row) => [row.column, `${row.type} ${row.notnull}`]));
    }

    it.each([
      ['script', { id: 'uuid true', tenant_id: 'uuid true', programme_id: 'uuid true' }],
      [
        'script_version',
        {
          id: 'uuid true',
          tenant_id: 'uuid true',
          programme_id: 'uuid true',
          script_id: 'uuid true',
          number: 'integer true',
        },
      ],
    ] as const)('%s has the pinned key columns', async (table, expected) => {
      const found = await columns(table);
      expect(Object.keys(found).length, `table ${table} not found`).toBeGreaterThan(0);
      expect(found).toMatchObject(expected);
    });

    it.each(['script', 'script_version'])('%s: id is the primary key', async (table) => {
      const pk = await observer.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS columns
           FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
          WHERE con.contype = 'p' AND con.conrelid = to_regclass($1)
          GROUP BY con.oid`,
        [`public.${table}`],
      );
      expect(pk.rows.map((row) => row.columns)).toEqual([['id']]);
    });

    async function foreignKeys(table: string) {
      const result = await observer.query<{
        ref_table: string;
        pairs: string[];
        on_update: string;
      }>(
        `SELECT ref.relname AS ref_table, con.confupdtype::text AS on_update,
                array_agg(la.attname || '->' || fa.attname ORDER BY la.attname) AS pairs
           FROM pg_constraint con
           JOIN pg_class ref ON ref.oid = con.confrelid
           CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(local_att, foreign_att)
           JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.local_att
           JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.foreign_att
          WHERE con.contype = 'f' AND con.conrelid = to_regclass($1)
          GROUP BY con.oid, ref.relname, con.confupdtype`,
        [`public.${table}`],
      );
      return result.rows.map((row) => ({
        refTable: row.ref_table,
        pairs: [...row.pairs].sort(),
        onUpdate: row.on_update,
      }));
    }

    it.each([
      ['script', 'programme', ['programme_id->id', 'tenant_id->tenant_id']],
      [
        'script_version',
        'script',
        ['programme_id->programme_id', 'script_id->id', 'tenant_id->tenant_id'],
      ],
    ] as const)('%s has a composite foreign key to %s through %j', async (table, target, pairs) => {
      const fks = await foreignKeys(table);
      expect(
        fks.filter((fk) => fk.refTable === target).map((fk) => fk.pairs),
        `${table} FKs: ${JSON.stringify(fks)}`,
      ).toContainEqual([...pairs]);
    });

    it.each(['script', 'script_version'])(
      '%s: every foreign key carries tenant_id and is ON UPDATE RESTRICT (D-L76)',
      async (table) => {
        const fks = await foreignKeys(table);
        expect(fks.length, `${table} has no foreign keys`).toBeGreaterThan(0);
        const unscoped = fks.filter(
          (fk) => fk.refTable !== 'tenant' && !fk.pairs.includes('tenant_id->tenant_id'),
        );
        expect(unscoped, 'a FK that would accept another tenant’s row').toEqual([]);
        // confupdtype: r = RESTRICT. NO ACTION ('a') accepts a one-statement
        // key rotation; CASCADE ('c') would carry a version across programmes.
        const notRestrict = fks.filter((fk) => fk.onUpdate !== 'r');
        expect(notRestrict, 'FKs that are not ON UPDATE RESTRICT').toEqual([]);
      },
    );

    it('a version number is unique per script, so two publishes can never mint one number', async () => {
      const indexes = await observer.query<{
        columns: string[];
        unique: boolean;
        valid: boolean;
        partial: boolean;
      }>(
        `SELECT ARRAY(SELECT a.attname::text FROM unnest(x.indkey) AS k(attnum)
                        JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
                       ORDER BY 1) AS columns,
                x.indisunique AS unique, x.indisvalid AS valid, x.indpred IS NOT NULL AS partial
           FROM pg_index x WHERE x.indrelid = to_regclass('public.script_version')`,
      );
      const allowed = ['number', 'programme_id', 'script_id', 'tenant_id'];
      const serving = indexes.rows.filter(
        (index) =>
          index.unique &&
          index.valid &&
          !index.partial &&
          index.columns.includes('script_id') &&
          index.columns.includes('number') &&
          index.columns.every((column) => allowed.includes(column)),
      );
      expect(
        serving.length,
        `script_version indexes: ${JSON.stringify(indexes.rows)}`,
      ).toBeGreaterThan(0);
    });

    it.each(['script', 'script_version'])(
      '%s: RLS ENABLED and FORCED; tenant AND programme on every permissive policy; WITH CHECK = USING',
      async (table) => {
        const security = (await readTableSecurity(appPool)).find((row) => row.table === table);
        expect(security?.rlsEnabled, `${table}: RLS is not enabled`).toBe(true);
        expect(security?.rlsForced, `${table}: RLS is not FORCED`).toBe(true);
        const policies = await observer.query<{
          name: string;
          permissive: boolean;
          using: string | null;
          check: string | null;
        }>(
          `SELECT p.polname AS name, p.polpermissive AS permissive,
                  pg_get_expr(p.polqual, p.polrelid) AS using,
                  pg_get_expr(p.polwithcheck, p.polrelid) AS check
             FROM pg_policy p WHERE p.polrelid = to_regclass($1)`,
          [`public.${table}`],
        );
        expect(policies.rows.length, `${table}: has no policy`).toBeGreaterThan(0);
        for (const policy of policies.rows.filter((row) => row.permissive)) {
          for (const expression of [policy.using, policy.check]) {
            if (expression === null) continue;
            expect(expression, `${table}.${policy.name}`).toContain('current_tenant_id()');
            expect(expression, `${table}.${policy.name}`).toContain('current_programme_ids()');
          }
        }
        expect(
          policies.rows.some((row) => row.check !== null && row.check === row.using),
          `${table}: no policy with WITH CHECK identical to USING`,
        ).toBe(true);
      },
    );

    it('both tables are in TENANT_SCOPED_TABLES', () => {
      expect([...TENANT_SCOPED_TABLES]).toEqual(
        expect.arrayContaining(['script', 'script_version']),
      );
    });

    it.each(['script', 'script_version'])(
      '%s: kasuwa_migrator owns it, and nothing kasuwa_app can enter may TRUNCATE it or bypass RLS',
      async (table) => {
        const owner = await observer.query<{ owner: string | null }>(
          `SELECT (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = to_regclass($1)) AS owner`,
          [`public.${table}`],
        );
        expect(owner.rows[0]?.owner, `${table} not found, or not the migrator's`).toBe(
          'kasuwa_migrator',
        );
        const held = await observer.query<{ held: string }>(
          `SELECT r.rolname || ':' || x.what AS held
             FROM pg_roles r
            CROSS JOIN LATERAL (
              SELECT 'TRUNCATE' AS what WHERE has_table_privilege(r.oid, $1, 'TRUNCATE')
              UNION ALL SELECT 'BYPASSRLS' WHERE r.rolbypassrls
            ) AS x
            WHERE pg_has_role('kasuwa_app', r.oid, 'MEMBER')
            ORDER BY 1`,
          [`public.${table}`],
        );
        expect(held.rows.map((row) => row.held)).toEqual([]);
      },
    );
  });

  // =========================================================================
  // 3. The tables: behaviour under RLS, keys and immutability. Rows come from
  //    the API (the column set is the builder's), then are probed in SQL.
  // =========================================================================

  interface Shared {
    a1: Published;
    a1Second: Published;
    a2: Published;
    b1: Published;
  }
  let shared: Promise<Shared> | undefined;
  const sharedRows = (): Promise<Shared> =>
    (shared ??= (async () => ({
      a1: await publishedScript(SUPERVISOR, PROGRAMME_A1),
      a1Second: await publishedScript(
        SUPERVISOR,
        PROGRAMME_A1,
        greetSays(goodGraph(), 'A second script.'),
      ),
      a2: await publishedScript(SUPERVISOR, PROGRAMME_A2, greetSays(goodGraph(), 'In A2.')),
      b1: await publishedScript(TENANT_B_ADMIN, PROGRAMME_B1),
    }))());

  describe('the tables under RLS', () => {
    it('each session sees exactly its own programmes’ scripts and versions', async () => {
      await requireTables();
      const rows = await sharedRows();
      const scripts = [rows.a1, rows.a2, rows.b1].map((row) => row.script.id);
      const versions = [rows.a1, rows.a2, rows.b1].map((row) => row.version.id);
      // Not vacuous: all three of each exist, committed.
      const all = await observer.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM script WHERE id = ANY ($1::uuid[]))::int
              + (SELECT count(*) FROM script_version WHERE id = ANY ($2::uuid[]))::int AS n`,
        [scripts, versions],
      );
      expect(all.rows[0]?.n).toBe(6);

      const visible = (tenantId: string, userId: string) =>
        withTenantTransaction(appPool, { tenantId, userId }, async (tx) => ({
          scripts: (
            await tx.query<{ id: string }>(
              'SELECT id FROM script WHERE id = ANY ($1::uuid[]) ORDER BY id',
              [scripts],
            )
          ).map((row) => row.id),
          versions: (
            await tx.query<{ id: string }>(
              'SELECT id FROM script_version WHERE id = ANY ($1::uuid[]) ORDER BY id',
              [versions],
            )
          ).map((row) => row.id),
        }));
      const sorted = (ids: string[]) => [...ids].sort();
      expect(await visible(TENANT_A, USER_A_AGENT_1)).toEqual({
        scripts: [rows.a1.script.id],
        versions: [rows.a1.version.id],
      });
      expect(await visible(TENANT_A, USER_A_AGENT_2)).toEqual({
        scripts: [rows.a2.script.id],
        versions: [rows.a2.version.id],
      });
      expect(await visible(TENANT_A, USER_A_SUPERVISOR)).toEqual({
        scripts: sorted([rows.a1.script.id, rows.a2.script.id]),
        versions: sorted([rows.a1.version.id, rows.a2.version.id]),
      });
      expect(await visible(TENANT_A, USER_A_NO_PROGRAMME)).toEqual({ scripts: [], versions: [] });
      expect(await visible(TENANT_B, USER_B_AGENT_1)).toEqual({
        scripts: [rows.b1.script.id],
        versions: [rows.b1.version.id],
      });
    });

    it('an A1 session can neither change, delete nor create scripts or versions in A2 or tenant B', async () => {
      await requireTables();
      const rows = await sharedRows();
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => {
          const writable = await query<{ quoted: string }>(
            `SELECT quote_ident(a.attname) AS quoted FROM pg_attribute a
            WHERE a.attrelid = 'public.script'::regclass AND a.attnum > 0 AND NOT a.attisdropped
              AND a.attname NOT IN ('id', 'tenant_id', 'programme_id')
              AND has_column_privilege(current_user, a.attrelid, a.attnum, 'UPDATE')
            ORDER BY a.attnum LIMIT 1`,
          );
          const column = writable[0]?.quoted;
          const foreign = [rows.a2.script.id, rows.b1.script.id];
          return {
            updated:
              column === undefined
                ? []
                : (
                    await query<{ id: string }>(
                      `UPDATE script SET ${column} = ${column} WHERE id = ANY ($1::uuid[]) RETURNING id`,
                      [foreign],
                    )
                  ).map((row) => row.id),
            // A1's own script copied into A2: the policy's WITH CHECK.
            insertA2: verdict(
              await probe(query, await cloneSql(query, 'script'), [
                rows.a1.script.id,
                JSON.stringify({ id: randomUUID(), programme_id: PROGRAMME_A2 }),
              ]),
            ),
            insertB1: verdict(
              await probe(query, await cloneSql(query, 'script'), [
                rows.a1.script.id,
                JSON.stringify({
                  id: randomUUID(),
                  tenant_id: TENANT_B,
                  programme_id: PROGRAMME_B1,
                }),
              ]),
            ),
          };
        },
      );
      expect(outcomes.updated, 'an A1 session updated another programme’s script').toEqual([]);
      expect(REFUSALS).toContain(outcomes.insertA2);
      expect(REFUSALS).toContain(outcomes.insertB1);
      // Deletes are COMMITTED (an error just rolls its own transaction back),
      // so the observer below sees what really happened.
      for (const [table, ids] of [
        ['script_version', [rows.a2.version.id, rows.b1.version.id]],
        ['script', [rows.a2.script.id, rows.b1.script.id]],
      ] as const) {
        await withTenantTransaction(appPool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, (tx) =>
          tx.query(`DELETE FROM ${table} WHERE id = ANY ($1::uuid[])`, [[...ids]]),
        ).catch(() => undefined);
      }
      const left = await observer.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM script WHERE id = ANY ($1::uuid[]))::int
              + (SELECT count(*) FROM script_version WHERE id = ANY ($2::uuid[]))::int AS n`,
        [
          [rows.a2.script.id, rows.b1.script.id],
          [rows.a2.version.id, rows.b1.version.id],
        ],
      );
      expect(left.rows[0]?.n).toBe(4);
    });

    it('a version cannot belong to a script of another programme, even for a supervisor who sees both', async () => {
      await requireTables();
      const rows = await sharedRows();
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_SUPERVISOR,
        async (query) => {
          const clone = (overrides: Json) =>
            cloneSql(query, 'script_version').then((sql) =>
              probe(query, sql, [
                rows.a1.version.id,
                JSON.stringify({ id: randomUUID(), ...overrides }),
              ]),
            );
          return {
            // The control: the same copy, kept in its programme, is accepted,
            // so the refusals below are about the key, not the probe.
            control: verdict(await clone({ number: 501 })),
            versionInA2ScriptInA1: verdict(
              await clone({ number: 502, programme_id: PROGRAMME_A2 }),
            ),
            versionInA1ScriptInA2: verdict(
              await clone({ number: 503, script_id: rows.a2.script.id }),
            ),
            otherTenantScript: verdict(await clone({ number: 504, script_id: rows.b1.script.id })),
          };
        },
      );
      expect(outcomes).toEqual({
        control: 'accepted',
        versionInA2ScriptInA1: 'foreign_key_violation',
        versionInA1ScriptInA2: 'foreign_key_violation',
        otherTenantScript: 'foreign_key_violation',
      });
    });

    it('a real A2 script id fails exactly as an invented one (no existence oracle across the BPO boundary)', async () => {
      await requireTables();
      const rows = await sharedRows();
      const invented = randomUUID();
      const fixedId = id13('00000000a001');
      const [real, fake] = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => {
          const sql = await cloneSql(query, 'script_version');
          const attempt = (scriptId: string) =>
            probe(query, sql, [
              rows.a1.version.id,
              JSON.stringify({ id: fixedId, number: 601, script_id: scriptId }),
            ]);
          return [await attempt(rows.a2.script.id), await attempt(invented)] as const;
        },
      );
      const normalise = (outcome: Outcome, id: string) =>
        outcome.accepted
          ? 'accepted'
          : {
              code: outcome.code,
              message: outcome.message.split(id).join('<id>'),
              detail: outcome.detail.split(id).join('<id>'),
            };
      expect(REFUSALS).toContain(verdict(real));
      expect(normalise(real, rows.a2.script.id)).toEqual(normalise(fake, invented));
    });
  });

  describe('keys and the immutability of a published version', () => {
    it('(self-check) on NO ACTION tables the rotation statement really rotates and re-points', async () => {
      // Throwaway tables, rolled back. Without this, "refused" below could
      // mean the statement never rotated anything. Passes on main by design.
      const result = await rolledBackTx(observer, async (query) => {
        await query(`CREATE TABLE t0113_parent (
                       id uuid PRIMARY KEY, tenant_id uuid NOT NULL, label text NOT NULL,
                       UNIQUE (tenant_id, id))`);
        await query(`CREATE TABLE t0113_child (
                       id uuid PRIMARY KEY, tenant_id uuid NOT NULL, parent_id uuid,
                       FOREIGN KEY (tenant_id, parent_id) REFERENCES t0113_parent (tenant_id, id))`);
        for (const [id, label] of [
          [ROTATE_X, 'X'],
          [ROTATE_Y, 'Y'],
        ] as const) {
          await query('INSERT INTO t0113_parent (id, tenant_id, label) VALUES ($1, $2, $3)', [
            id,
            TENANT_A,
            label,
          ]);
        }
        await query('INSERT INTO t0113_child (id, tenant_id, parent_id) VALUES ($1, $2, $3)', [
          randomUUID(),
          TENANT_A,
          ROTATE_X,
        ]);
        const noAction = verdict(
          await probe(
            query,
            rotationSql('t0113_parent'),
            [ROTATE_X, ROTATE_Y, ROTATE_FRESH, TENANT_A],
            true,
          ),
        );
        const pointsAt = await query<{ label: string }>(
          `SELECT p.label FROM t0113_child c JOIN t0113_parent p
             ON p.tenant_id = c.tenant_id AND p.id = c.parent_id`,
        );
        return { noAction, nowPointsAt: pointsAt[0]?.label };
      });
      expect(result).toEqual({ noAction: 'accepted', nowPointsAt: 'Y' });
    });

    it('script.id and programme_id are fixed for kasuwa_app and kasuwa_test_admin (the allow-list guard)', async () => {
      await requireTables();
      const fresh = await createScript(SUPERVISOR, { graph: goodGraph() }); // no versions
      const attempts: [string, string, unknown[]][] = [
        ['id', 'UPDATE script SET id = gen_random_uuid() WHERE id = $1', [fresh.id]],
        [
          'programme_id',
          'UPDATE script SET programme_id = $2 WHERE id = $1',
          [fresh.id, PROGRAMME_A2],
        ],
      ];
      const rowOf = async (query: Query) =>
        JSON.stringify(
          await query('SELECT to_jsonb(s) AS row FROM script s WHERE s.id = $1', [fresh.id]),
        );
      const before = await rowOf(async (text, params) => (await observer.query(text, params)).rows);
      expect(JSON.parse(before), 'the API-created script is not in the table').toHaveLength(1);

      // The control: kasuwa_migrator, the one role D-L76's allow-list lets
      // through, can move a script that has no versions. So each statement
      // below really would change the row if nothing refused it.
      const control = await rolledBackTx(observer, async (query) => {
        const outcome = verdict(await probe(query, attempts[1]?.[1] ?? '', attempts[1]?.[2], true));
        return { outcome, changed: (await rowOf(query)) !== before };
      });
      expect(control, 'kasuwa_migrator moving a script with no versions').toEqual({
        outcome: 'accepted',
        changed: true,
      });

      for (const [column, sql, values] of attempts) {
        const attempt = async (query: Query) => {
          const outcome = verdict(await probe(query, sql, values, true));
          return { outcome, changed: (await rowOf(query)) !== before };
        };
        const asApp = await rolledBackTenantTx(appPool, TENANT_A, USER_A_SUPERVISOR, attempt);
        const asTestAdmin = await rolledBackTx(testAdmin, attempt);
        for (const [role, result] of [
          ['kasuwa_app', asApp],
          ['kasuwa_test_admin', asTestAdmin],
        ] as const) {
          expect(['accepted', ...REFUSALS], `${role} changing script.${column}`).toContain(
            result.outcome,
          );
          expect(result.changed, `${role} changed script.${column} (${result.outcome})`).toBe(
            false,
          );
        }
      }
    });

    it('a one-statement rotation of script ids is refused even for the migrator while a version points at one', async () => {
      await requireTables();
      const rows = await sharedRows();
      const result = await rolledBackTx(observer, async (query) => {
        // X and Y are copies of two different scripts, X inserted first and
        // X < Y, so the rotation reaches X before Y (no 23505 misfire).
        await cloneRow(query, 'script', rows.a1.script.id, { id: ROTATE_X });
        await cloneRow(query, 'script', rows.a1Second.script.id, { id: ROTATE_Y });
        const versionId = randomUUID();
        await cloneRow(query, 'script_version', rows.a1.version.id, {
          id: versionId,
          script_id: ROTATE_X,
          number: 701,
        });
        const content = async (id: string) =>
          JSON.stringify(
            (
              await query<{ row: unknown }>(
                `SELECT to_jsonb(s) - 'id' AS row FROM script s WHERE id = $1`,
                [id],
              )
            )[0]?.row,
          );
        const xBefore = await content(ROTATE_X);
        const outcome = verdict(
          await probe(
            query,
            rotationSql('script'),
            [ROTATE_X, ROTATE_Y, ROTATE_FRESH, TENANT_A],
            true,
          ),
        );
        const pointsAt = await query<{ row: unknown }>(
          `SELECT to_jsonb(s) - 'id' AS row FROM script_version v
             JOIN script s ON s.tenant_id = v.tenant_id AND s.id = v.script_id
            WHERE v.id = $1`,
          [versionId],
        );
        const moved = verdict(
          await probe(query, 'UPDATE script SET programme_id = $2 WHERE id = $1', [
            ROTATE_X,
            PROGRAMME_A2,
          ]),
        );
        return { outcome, repointed: JSON.stringify(pointsAt[0]?.row) !== xBefore, moved };
      });
      expect(REFUSALS, `the rotation was ${result.outcome}`).toContain(result.outcome);
      expect(result.repointed, 'the version was re-pointed to another script').toBe(false);
      expect(REFUSALS, `moving a script with versions to A2 was ${result.moved}`).toContain(
        result.moved,
      );
    });

    it('a published version is immutable for kasuwa_app, kasuwa_test_admin and kasuwa_migrator, column by column', async () => {
      await requireTables();
      const rows = await sharedRows();
      const target = rows.a1.version.id;
      // A version of ANOTHER script in ANOTHER programme: its values are valid
      // for every column, so a copy-from-it mutation proves something.
      const other = rows.a2.version.id;

      // The self-check: on a trigger-free copy (LIKE ... INCLUDING DEFAULTS
      // INCLUDING CONSTRAINTS keeps the CHECKs, drops the triggers and FKs)
      // every probe below really changes the row.
      const onCopy = await rolledBackTx(observer, async (query) => {
        await query(
          'CREATE TABLE t0113_version_copy (LIKE script_version INCLUDING DEFAULTS INCLUDING CONSTRAINTS)',
        );
        await query(
          'INSERT INTO t0113_version_copy SELECT * FROM script_version WHERE id = ANY ($1::uuid[])',
          [[target, other]],
        );
        return mutationOutcomes(
          query,
          't0113_version_copy',
          target,
          other,
          snapshotOf(query, 't0113_version_copy', TENANT_A),
        );
      });
      const mutable = Object.entries(onCopy)
        .filter(([, outcome]) => outcome === 'changed')
        .map(([column]) => column);
      expect(mutable, `the probe's reach on a copy: ${JSON.stringify(onCopy)}`).toEqual(
        expect.arrayContaining(['id', 'script_id', 'number']),
      );
      const jsonbColumns = (
        await observer.query<{ name: string }>(
          `SELECT attname AS name FROM pg_attribute
            WHERE attrelid = 'public.script_version'::regclass AND atttypid = 'jsonb'::regtype
              AND NOT attisdropped`,
        )
      ).rows.map((row) => row.name);
      expect(
        jsonbColumns.length,
        'script_version keeps its graph in no jsonb column',
      ).toBeGreaterThan(0);
      expect(
        jsonbColumns.filter((column) => mutable.includes(column)).length,
        'the probe changes no jsonb column on the copy, so the content would go untested',
      ).toBeGreaterThan(0);

      const roles: [string, () => Promise<Record<string, Mutation>>][] = [
        [
          'kasuwa_migrator',
          () =>
            rolledBackTx(observer, (query) =>
              mutationOutcomes(
                query,
                'script_version',
                target,
                other,
                snapshotOf(query, 'script_version', TENANT_A),
              ),
            ),
        ],
        [
          'kasuwa_test_admin',
          () =>
            rolledBackTx(testAdmin, (query) =>
              mutationOutcomes(
                query,
                'script_version',
                target,
                other,
                snapshotOf(query, 'script_version', TENANT_A),
              ),
            ),
        ],
        [
          'kasuwa_app',
          () =>
            rolledBackTenantTx(appPool, TENANT_A, USER_A_SUPERVISOR, (query) =>
              mutationOutcomes(
                query,
                'script_version',
                target,
                other,
                snapshotOf(query, 'script_version', TENANT_A),
              ),
            ),
        ],
      ];
      for (const [role, run] of roles) {
        const outcomes = await run();
        const changed = mutable.filter((column) => outcomes[column] === 'changed');
        expect(changed, `${role} changed a published version’s ${changed.join(', ')}`).toEqual([]);
      }
    });

    it('kasuwa_app and kasuwa_test_admin cannot delete a version, and kasuwa_app cannot delete a script that has one', async () => {
      await requireTables();
      const rows = await sharedRows();
      const target = rows.a1.version.id;
      const asApp = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_SUPERVISOR,
        async (query) => {
          const version = verdict(
            await probe(query, 'DELETE FROM script_version WHERE id = $1', [target], true),
          );
          const script = verdict(
            await probe(query, 'DELETE FROM script WHERE id = $1', [rows.a1.script.id], true),
          );
          const left = await query<{ n: number }>(
            `SELECT (SELECT count(*) FROM script_version WHERE id = $1)::int
                + (SELECT count(*) FROM script WHERE id = $2)::int AS n`,
            [target, rows.a1.script.id],
          );
          return { version, script, left: left[0]?.n };
        },
      );
      const asTestAdmin = await rolledBackTx(testAdmin, async (query) => {
        await probe(query, 'DELETE FROM script_version WHERE id = $1', [target], true);
        return (
          await query<{ n: number }>(
            'SELECT count(*)::int AS n FROM script_version WHERE id = $1',
            [target],
          )
        )[0]?.n;
      });
      expect(asApp.left, `kasuwa_app: version ${asApp.version}, script ${asApp.script}`).toBe(2);
      expect(asTestAdmin, 'kasuwa_test_admin deleted a published version').toBe(1);
    });

    it('offboarding still works: kasuwa_migrator deletes a programme, then a tenant, holding scripts with versions', async () => {
      await requireTables();
      const rows = await sharedRows();
      const result = await rolledBackTx(observer, async (query) => {
        const tenantId = randomUUID();
        const bu = randomUUID();
        const [p1, p2] = [randomUUID(), randomUUID()];
        const user = randomUUID();
        await query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'T-0113 Leaving Ltd', $2)`, [
          tenantId,
          `t0113-leaving-${RUN}`,
        ]);
        await query(
          `INSERT INTO business_unit (id, tenant_id, name) VALUES ($1, $2, 'Head office')`,
          [bu, tenantId],
        );
        await query(
          `INSERT INTO programme (id, tenant_id, business_unit_id, name, is_default)
           VALUES ($1, $3, $4, 'Default', true), ($2, $3, $4, 'Client Two', false)`,
          [p1, p2, tenantId, bu],
        );
        await query(
          `INSERT INTO "user" (id, tenant_id, email, display_name) VALUES ($1, $2, $3, 'T-0113 Admin')`,
          [user, tenantId, `admin.${RUN}@t0113.test`],
        );
        // Every other reference the builder's columns make: a user becomes
        // the new tenant's user, the script the new script, anything else null.
        const references = async (table: string, targets: Record<string, string>) => {
          const fks = await query<{ ref: string; columns: string[] }>(
            `SELECT ref.relname AS ref, array_agg(a.attname::text) AS columns
               FROM pg_constraint c
               JOIN pg_class ref ON ref.oid = c.confrelid
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
              WHERE c.contype = 'f' AND c.conrelid = to_regclass($1)
              GROUP BY c.oid, ref.relname`,
            [`public.${table}`],
          );
          const overrides: Json = {};
          for (const fk of fks) {
            for (const column of fk.columns) {
              if (column === 'tenant_id' || column === 'programme_id') continue;
              overrides[column] = targets[fk.ref] ?? null;
            }
          }
          return overrides;
        };
        for (const programmeId of [p1, p2]) {
          const scriptId = randomUUID();
          await cloneRow(query, 'script', rows.a1.script.id, {
            ...(await references('script', { user })),
            id: scriptId,
            tenant_id: tenantId,
            programme_id: programmeId,
          });
          await cloneRow(query, 'script_version', rows.a1.version.id, {
            ...(await references('script_version', { user, script: scriptId })),
            id: randomUUID(),
            tenant_id: tenantId,
            programme_id: programmeId,
            script_id: scriptId,
          });
        }
        const count = async (column: string, id: string) =>
          (
            await query<{ n: number }>(
              `SELECT (SELECT count(*) FROM script WHERE ${column} = $1)::int
                    + (SELECT count(*) FROM script_version WHERE ${column} = $1)::int AS n`,
              [id],
            )
          )[0]?.n;
        const before = await count('tenant_id', tenantId);
        const programme = verdict(
          await probe(query, 'DELETE FROM programme WHERE id = $1', [p2], true),
        );
        const afterProgramme = await count('programme_id', p2);
        const tenant = verdict(
          await probe(query, 'DELETE FROM tenant WHERE id = $1', [tenantId], true),
        );
        const afterTenant = await count('tenant_id', tenantId);
        return { before, programme, afterProgramme, tenant, afterTenant };
      });
      expect(result).toEqual({
        before: 4,
        programme: 'accepted',
        afterProgramme: 0,
        tenant: 'accepted',
        afterTenant: 0,
      });
    });
  });

  // =========================================================================
  // 4. The wire: create, read, edit, revision.
  // =========================================================================

  describe('createScript, getScript and updateScript', () => {
    it('createScript answers 201 with a Script: the draft as sent, no version, ids minted by the server', async () => {
      const graph = goodGraph();
      const name = unique('T0113 create');
      const response = await createRaw(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        name,
        sourceLocale: 'en',
        graph,
      });
      expectStatus(response, 201, 'createScript');
      expectNoStore(response, 'createScript');
      const script = expectScript(response.body, 'createScript');
      expect(script.id).toMatch(UUID);
      expect(script).toMatchObject({
        programmeId: PROGRAMME_A1,
        name,
        sourceLocale: 'en',
        translatedLocales: [],
        latestVersion: null,
        hasUnpublishedChanges: true,
      });
      expect(script.draft.graph, 'the draft graph round-trips exactly').toEqual(graph);
      expect(script.draft.translations).toEqual({});
      const read = await readScript(script.id);
      expect(read).toEqual(script);
    });

    it('script names are not unique: the same name twice is two scripts', async () => {
      const name = unique('T0113 twin');
      const first = await createScript(SUPERVISOR, { name });
      const second = await createScript(SUPERVISOR, { name });
      expect(first.id).not.toBe(second.id);
    });

    it('createScript is closed: an id, a tenant, a revision, a version or a draft in the body is 400 and creates nothing', async () => {
      const name = unique('T0113 closed');
      for (const extra of [
        { id: NOWHERE },
        { tenantId: TENANT_A },
        { revision: 5 },
        { latestVersion: null },
        { draft: { graph: goodGraph(), translations: {} } },
        { translations: {} },
        { programmeIds: [PROGRAMME_A1] },
      ]) {
        const response = await createRaw(SUPERVISOR, {
          programmeId: PROGRAMME_A1,
          name,
          sourceLocale: 'en',
          ...extra,
        });
        expectError(response, 400, 'validation_failed');
      }
      // The control: the same body without the extra property is created.
      const control = await createRaw(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        name: `${name} control`,
        sourceLocale: 'en',
      });
      expectStatus(control, 201, 'the same create, closed');
      const named = await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM script s WHERE to_jsonb(s)::text LIKE $1`,
        [`%${name}%`],
      );
      expect(named.rows[0]?.n, 'a refused create wrote a row').toBe(1);
    });

    it('updateScript replaces the draft, advances revision, and never touches the published version', async () => {
      const { script, version } = await publishedScript();
      expect(script.hasUnpublishedChanges, 'right after publish').toBe(false);
      const edited = greetSays(goodGraph(), 'Edited after publish.');
      const name = unique('T0113 renamed');
      const response = await updateRaw(SUPERVISOR, script.id, {
        revision: script.revision,
        name,
        sourceLocale: 'fr',
        graph: edited,
      });
      expectStatus(response, 200, 'updateScript');
      expectNoStore(response, 'updateScript');
      const updated = expectScript(response.body, 'updateScript');
      expect(updated.revision).toBeGreaterThan(script.revision);
      expect(updated).toMatchObject({ name, sourceLocale: 'fr', hasUnpublishedChanges: true });
      expect(updated.draft.graph).toEqual(edited);
      expect(updated.latestVersion?.id).toBe(version.id);
      const stillV1 = expectVersion(
        (await versionRaw(SUPERVISOR, script.id, version.id)).body,
        'v1',
      );
      expect(stillV1).toEqual(version);
    });

    it('a stale revision is 409 stale_write and applies nothing', async () => {
      const script = await createScript();
      const first = await updateRaw(SUPERVISOR, script.id, {
        revision: script.revision,
        name: unique('T0113 first'),
      });
      expectStatus(first, 200, 'the first edit');
      const stale = await updateRaw(SUPERVISOR, script.id, {
        revision: script.revision,
        name: unique('T0113 stale'),
        graph: greetSays(goodGraph(), 'Stale.'),
      });
      expectError(stale, 409, 'stale_write');
      expect(await readScript(script.id)).toEqual(expectScript(first.body, 'first'));
    });

    it('two concurrent edits of one revision: exactly one wins, the other is 409 stale_write', async () => {
      const script = await createScript();
      const names = [unique('T0113 race A'), unique('T0113 race B')];
      const responses = await Promise.all(
        names.map((name) => updateRaw(SUPERVISOR, script.id, { revision: script.revision, name })),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = responses.findIndex((response) => response.status === 200);
      const loser = responses[1 - winner];
      if (loser !== undefined) expectError(loser, 409, 'stale_write');
      expect((await readScript(script.id)).name).toBe(names[winner]);
    });

    it('updateScript is closed: programmeId (a script never moves), translations, draft or an id is 400', async () => {
      const script = await createScript();
      for (const extra of [
        { programmeId: PROGRAMME_A2 },
        { translations: {} },
        { draft: { graph: goodGraph(), translations: {} } },
        { id: NOWHERE },
        { latestVersion: null },
      ]) {
        expectError(
          await updateRaw(SUPERVISOR, script.id, { revision: script.revision, ...extra }),
          400,
          'validation_failed',
        );
      }
      expect(await readScript(script.id)).toEqual(script);
    });

    it('a source-locale change never leaves the source locale as a translation key', async () => {
      const script = await createScript();
      const translated = await translate(script.id, 'pcm', { greet: { text: `Pidgin ${MARK}` } });
      const response = await updateRaw(SUPERVISOR, script.id, {
        revision: translated.revision,
        sourceLocale: 'pcm',
      });
      // 400, or accepted with the clash resolved: never both.
      expect([200, 400], response.text).toContain(response.status);
      const after = await readScript(script.id);
      expect(Object.keys(after.draft.translations)).not.toContain(after.sourceLocale);
      expect(after.translatedLocales).not.toContain(after.sourceLocale);
    });
  });

  // =========================================================================
  // 5. Authoring rights: script.write, or one 404.
  // =========================================================================

  describe('authoring rights: script.write, or the same 404 as nothing at all', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    type Op = [string, (headers: Headers) => request.Test];

    const operations = (scriptId: string, versionId: string, revision: number): Op[] => [
      ['getScript', (h) => getRaw(h, scriptId)],
      ['updateScript', (h) => updateRaw(h, scriptId, { revision, name: `T0113 hijack ${MARK}` })],
      ['listScriptVersions', (h) => versionsRaw(h, scriptId)],
      ['publishScript', (h) => publishRaw(h, scriptId, { revision })],
      ['getScriptVersion', (h) => versionRaw(h, scriptId, versionId)],
      [
        'putScriptTranslation',
        (h) =>
          translateRaw(h, scriptId, 'pcm', { revision, texts: { greet: { text: `x ${MARK}` } } }),
      ],
    ];

    /** The script's row and its versions' rows, as the migrator sees them. */
    async function rowsOf(fixture: Published): Promise<string> {
      const result = await observer.query<{ rows: unknown }>(
        `SELECT jsonb_build_object(
                  'script', (SELECT to_jsonb(s) FROM script s WHERE s.id = $1),
                  'versions', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id)
                                 FROM script_version v WHERE v.script_id = $1)) AS rows`,
        [fixture.script.id],
      );
      return JSON.stringify(result.rows[0]?.rows);
    }

    /**
     * Every authoring operation on a real script answers `caller` exactly as
     * on an id that names nothing, and nothing changes. The author's own
     * reads (the fixture) are the positive control.
     */
    async function expectUnreachable(caller: Headers, fixture: Published, who: string) {
      const before = await auditIds();
      const rowsBefore = await rowsOf(fixture);
      const reference = await getRaw(caller, NOWHERE);
      expectError(reference, 404, 'not_found');
      const real = operations(fixture.script.id, fixture.version.id, fixture.script.revision);
      const invented = operations(NOWHERE, NOWHERE_VERSION, fixture.script.revision);
      const mixed = [
        operations(fixture.script.id, NOWHERE_VERSION, fixture.script.revision)[4],
        operations(NOWHERE, fixture.version.id, fixture.script.revision)[4],
      ];
      for (const [name, build] of [...real, ...invented, ...mixed].filter(
        (op): op is Op => op !== undefined,
      )) {
        const response = await build(caller);
        expectError(response, 404, 'not_found');
        expect(response.text, `${who}: ${name} differs from the 404 for nothing`).toBe(
          reference.text,
        );
      }
      // Nothing changed and nothing was audited.
      expect(await rowsOf(fixture), `${who}: the script or its versions changed`).toBe(rowsBefore);
      expect(await auditSince(before)).toEqual([]);
    }

    async function expectEmptyList(caller: Headers, who: string) {
      const page = expectScriptPage(await listRaw(caller), `${who}: listScripts`);
      expect(page, `${who}: listScripts must leave every script out`).toEqual({
        data: [],
        nextCursor: null,
      });
    }

    it.each(NON_WRITER_KEYS)(
      'the %s set in the script’s programme gets one 404 on every read and write, an empty list, and 403 on create',
      async (key) => {
        const fixture = await publishedScript();
        await assign(TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1, key);
        // The control: the assignment took (the caller reaches A1).
        const mine = await request(server()).get('/api/v1/me/programmes').set(NO_PROGRAMME);
        expectStatus(mine, 200, 'listMyProgrammes');
        expect((mine.body as { data: { id: string }[] }).data.map((row) => row.id)).toEqual([
          PROGRAMME_A1,
        ]);

        await expectUnreachable(NO_PROGRAMME, fixture, key);
        await expectEmptyList(NO_PROGRAMME, key);

        const before = await auditIds();
        const created = await createRaw(NO_PROGRAMME, {
          programmeId: PROGRAMME_A1,
          name: unique(`T0113 by ${key}`),
          sourceLocale: 'en',
          graph: goodGraph(),
        });
        expectError(created, 403, 'not_permitted');
        expect(await auditSince(before)).toEqual([]);
      },
    );

    it('a user in another tenant, and a user who reaches nothing, get the same 404 everywhere', async () => {
      const fixture = await publishedScript();
      await expectUnreachable(TENANT_B_ADMIN, fixture, 'tenant B’s admin');
      await expectUnreachable(NO_PROGRAMME, fixture, 'a user with no programme');
      // And the other way round: tenant A's admin on tenant B's script.
      const theirs = await publishedScript(TENANT_B_ADMIN, PROGRAMME_B1);
      const reference = await getRaw(SUPERVISOR, NOWHERE);
      for (const [name, build] of operations(
        theirs.script.id,
        theirs.version.id,
        theirs.script.revision,
      )) {
        const response = await build(SUPERVISOR);
        expectError(response, 404, 'not_found');
        expect(response.text, `tenant A on tenant B: ${name}`).toBe(reference.text);
      }
      const ids = expectScriptPage(
        await listRaw(TENANT_B_ADMIN, [['limit', '100']]),
        'B lists',
      ).data.map((row) => row.id);
      expect(ids).not.toContain(fixture.script.id);
      expect(ids).toContain(theirs.script.id);
    });

    it('createScript into a programme the caller does not reach is the same 404 as one that does not exist', async () => {
      const body = (programmeId: string) => ({
        programmeId,
        name: unique('T0113 target'),
        sourceLocale: 'en',
        graph: goodGraph(),
      });
      const nothing = await createRaw(AGENT_1, body(NOWHERE));
      expectError(nothing, 404, 'not_found');
      for (const [who, headers, programmeId] of [
        ['agent 1 into A2', AGENT_1, PROGRAMME_A2],
        ['agent 1 into B1', AGENT_1, PROGRAMME_B1],
        ['tenant B’s admin into A1', TENANT_B_ADMIN, PROGRAMME_A1],
        ['no programme into A1', NO_PROGRAMME, PROGRAMME_A1],
      ] as const) {
        const response = await createRaw(headers, body(programmeId));
        expectError(response, 404, 'not_found');
        expect(response.text, who).toBe(nothing.text);
      }
      // The control: the same body into A1 by its admin is created.
      expectStatus(await createRaw(SUPERVISOR, body(PROGRAMME_A1)), 201, 'the admin creates');
    });

    it('script.write is per programme: an admin of A1 who is an agent in A2 authors A1 only', async () => {
      const inA1 = await publishedScript(SUPERVISOR, PROGRAMME_A1);
      const inA2 = await publishedScript(SUPERVISOR, PROGRAMME_A2);
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A2, 'agent');
      await setTenantAdmin(USER_A_SUPERVISOR, false);

      expect((await readScript(inA1.script.id)).id).toBe(inA1.script.id);
      await expectUnreachable(SUPERVISOR, inA2, 'the A1 admin in A2');
      const listed = expectScriptPage(
        await listRaw(SUPERVISOR, [['limit', '100']]),
        'listScripts',
      ).data.map((row) => row.programmeId);
      expect(listed.length).toBeGreaterThan(0);
      expect(new Set(listed), 'listScripts leaves the A2 scripts out').toEqual(
        new Set([PROGRAMME_A1]),
      );
      expectError(
        await createRaw(SUPERVISOR, {
          programmeId: PROGRAMME_A2,
          name: unique('T0113 A2'),
          sourceLocale: 'en',
        }),
        403,
        'not_permitted',
      );
    });

    it('the tenant-admin flag grants script.write in the programmes the user reaches, and never widens scope', async () => {
      const inA1 = await publishedScript(SUPERVISOR, PROGRAMME_A1);
      const inA2 = await publishedScript(SUPERVISOR, PROGRAMME_A2);
      await setTenantAdmin(USER_A_AGENT_1, true);
      expect((await readScript(inA1.script.id, AGENT_1)).id).toBe(inA1.script.id);
      const created = await createScript(AGENT_1, { programmeId: PROGRAMME_A1 });
      expect(created.programmeId).toBe(PROGRAMME_A1);
      await expectUnreachable(AGENT_1, inA2, 'a tenant admin outside A2');
      expectError(
        await createRaw(AGENT_1, {
          programmeId: PROGRAMME_A2,
          name: unique('T0113 flag'),
          sourceLocale: 'en',
        }),
        404,
        'not_found',
      );
    });

    it('decided on every request: losing the admin set takes effect on the next call', async () => {
      const fixture = await publishedScript();
      await readScript(fixture.script.id);
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, 'team_lead');
      await setTenantAdmin(USER_A_SUPERVISOR, false);
      expectError(await getRaw(SUPERVISOR, fixture.script.id), 404, 'not_found');
    });
  });

  // =========================================================================
  // 6. Shape and size, on save.
  // =========================================================================

  describe('shape and size are checked on save', () => {
    const g = goodGraph();
    const longId = `a${'b'.repeat(40)}`;
    const SHAPE_CASES: [string, unknown, RegExp][] = [
      [
        'an unknown node type (there is no disposition node)',
        withNode(g, 'close', (n) => ({ ...n, type: 'disposition' })),
        nodePath(g, 'close'),
      ],
      [
        'a say node that writes to the record (D-P31)',
        withNode(g, 'greet', (n) => ({ ...n, writesTo: 'status' })),
        nodePath(g, 'greet'),
      ],
      [
        'a form field bound to a contact field (D-P31)',
        withNode(g, 'ptp', (n) => ({
          ...n,
          fields: [
            { key: 'st', label: 'Status', type: 'text', required: false, contactField: 'status' },
          ],
        })),
        nodePath(g, 'ptp'),
      ],
      [
        'a say node without text',
        withNode(
          g,
          'intro',
          (n) => Object.fromEntries(Object.entries(n).filter(([k]) => k !== 'text')) as GraphNode,
        ),
        nodePath(g, 'intro'),
      ],
      // The offending id may name its node in the path, so any node path will do.
      [
        'a node id with capitals',
        withNode(g, 'intro', (n) => ({ ...n, id: 'Intro' })),
        /^graph\.nodes\.[^.]+/,
      ],
      [
        'a 41-character node id',
        withNode(g, 'intro', (n) => ({ ...n, id: longId })),
        /^graph\.nodes\.[^.]+/,
      ],
      [
        'a 121-character title',
        withNode(g, 'intro', (n) => ({ ...n, title: 't'.repeat(121) })),
        nodePath(g, 'intro'),
      ],
      [
        'a 4001-character text',
        withNode(g, 'intro', (n) => ({ ...n, text: 't'.repeat(4001) })),
        nodePath(g, 'intro'),
      ],
      [
        'a question with one choice',
        withNode(g, 'payq', (n) => ({
          ...n,
          choices: [{ key: 'ptp', label: 'Pay', next: 'ptp' }],
        })),
        nodePath(g, 'payq'),
      ],
      [
        'a question with 13 choices',
        withNode(g, 'payq', (n) => ({
          ...n,
          choices: Array.from({ length: 13 }, (_, i) => ({
            key: `c${i}`,
            label: `C${i}`,
            next: 'ptp',
          })),
        })),
        nodePath(g, 'payq'),
      ],
      ['201 nodes', { startNodeId: 's0', nodes: chainOfSays(200, 'x').nodes }, /^graph\.nodes$/],
      ['no nodes', { startNodeId: 'greet', nodes: [] }, /^graph\.nodes$/],
      ['a graph that is an array', [goodGraph()], /^graph$/],
      ['a free-form graph key', { ...goodGraph(), edges: [] }, /^graph(\.edges)?$/],
      [
        'an unknown condition source',
        withNode(g, 'cust', (n) => ({
          ...n,
          condition: { source: 'contact', field: 'status', operator: 'is_set' },
        })),
        nodePath(g, 'cust'),
      ],
      [
        'a snake_case contact field',
        withNode(g, 'cust', (n) => ({
          ...n,
          condition: { source: 'contact_field', field: 'given_names', operator: 'is_set' },
        })),
        nodePath(g, 'cust'),
      ],
      [
        'an unknown operator',
        withNode(g, 'cust', (n) => ({
          ...n,
          condition: { source: 'contact_field', field: 'status', operator: 'matches', value: 'x' },
        })),
        nodePath(g, 'cust'),
      ],
      [
        'a 201-character branch value',
        withNode(g, 'cust', (n) => ({
          ...n,
          condition: {
            source: 'contact_field',
            field: 'status',
            operator: 'equals',
            value: 'v'.repeat(201),
          },
        })),
        nodePath(g, 'cust'),
      ],
      [
        'a 21-item branch list',
        withNode(g, 'cust', (n) => ({
          ...n,
          condition: {
            source: 'contact_field',
            field: 'status',
            operator: 'one_of',
            value: Array.from({ length: 21 }, (_, i) => `v${i}`),
          },
        })),
        nodePath(g, 'cust'),
      ],
      [
        'a branch integer above 2^31-1',
        withNode(g, 'cust', (n) => ({
          ...n,
          condition: {
            source: 'contact_field',
            field: 'status',
            operator: 'greater_than',
            value: 2147483648,
          },
        })),
        nodePath(g, 'cust'),
      ],
      [
        'a form minimum below -2^31',
        withNode(g, 'ptp', (n) => ({
          ...n,
          fields: [
            { key: 'count', label: 'Count', type: 'number', required: true, minimum: -2147483649 },
          ],
        })),
        nodePath(g, 'ptp'),
      ],
      [
        'a canvas x above 100000',
        withNode(g, 'greet', (n) => ({ ...n, position: { x: 100001, y: 0 } })),
        nodePath(g, 'greet'),
      ],
      [
        'a negative canvas y',
        withNode(g, 'greet', (n) => ({ ...n, position: { x: 0, y: -1 } })),
        nodePath(g, 'greet'),
      ],
      [
        'a fractional canvas x',
        withNode(g, 'greet', (n) => ({ ...n, position: { x: 1.5, y: 0 } })),
        nodePath(g, 'greet'),
      ],
      [
        'a date field 367 days ahead',
        withNode(g, 'ptp', (n) => ({
          ...n,
          fields: [{ key: 'date', label: 'Date', type: 'date', required: true, maxDaysAhead: 367 }],
        })),
        nodePath(g, 'ptp'),
      ],
      [
        'a money field without currency or bounds',
        withNode(g, 'ptp', (n) => ({
          ...n,
          fields: [{ key: 'amount', label: 'Amount', type: 'money', required: true }],
        })),
        nodePath(g, 'ptp'),
      ],
      [
        'a choice field without options',
        withNode(g, 'ptp', (n) => ({
          ...n,
          fields: [{ key: 'reason', label: 'Reason', type: 'choice', required: true }],
        })),
        nodePath(g, 'ptp'),
      ],
      [
        'a float amount bound',
        withNode(g, 'ptp', (n) => ({
          ...n,
          fields: [
            {
              key: 'amount',
              label: 'Amount',
              type: 'money',
              required: true,
              currency: 'NGN',
              minimumMinor: 5000.5,
              maximumMinor: '9000',
            },
          ],
        })),
        nodePath(g, 'ptp'),
      ],
      [
        'a suggested disposition that is not a uuid',
        withNode(g, 'close', (n) => ({ ...n, suggestedDispositionId: 'PTP' })),
        nodePath(g, 'close'),
      ],
    ];

    it.each(SHAPE_CASES)(
      'updateScript refuses %s with 400 naming the path, and saves nothing',
      async (_label, graph, path) => {
        const script = await createScript();
        expect400(
          await updateRaw(SUPERVISOR, script.id, { revision: script.revision, graph }),
          path,
        );
        expect(await readScript(script.id)).toEqual(script);
      },
    );

    it('createScript checks the same shape: a disposition node is 400 and nothing is created', async () => {
      const before = await auditIds();
      const graph = withNode(g, 'close', (n) => ({ ...n, type: 'disposition' }));
      expect400(
        await createRaw(SUPERVISOR, {
          programmeId: PROGRAMME_A1,
          name: unique('T0113 bad shape'),
          sourceLocale: 'en',
          graph,
        }),
        nodePath(graph, 'close'),
      );
      expect(await auditSince(before)).toEqual([]);
    });

    it('a draft may be incomplete: unknown targets, a cycle and a missing start all save (completeness is publish’s)', async () => {
      const script = await createScript();
      for (const graph of [
        withNode(g, 'intro', (n) => ({ ...n, next: 'ghost' })),
        { ...goodGraph(), startNodeId: 'nowhere' },
        withNode(g, 'readback', (n) => ({ ...n, next: 'greet' })),
      ]) {
        const saved = await saveGraph(script.id, graph);
        expect(saved.draft.graph).toEqual(graph);
      }
    });

    it('duplicate node ids are never published: refused on save, or at publish (R5)', async () => {
      const script = await createScript();
      const graph = addNodes(goodGraph(), {
        id: 'rec',
        type: 'compliance',
        title: 'Twin',
        text: `Twin ${MARK}`,
        next: 'idq',
      });
      const saved = await updateRaw(SUPERVISOR, script.id, { revision: script.revision, graph });
      if (saved.status === 400) {
        expectError(saved, 400, 'validation_failed');
      } else {
        expectStatus(saved, 200, 'a draft with a duplicate id');
        expectError(await publishNow(script.id), 409, 'script_invalid');
      }
      expect(await versionsOf(script.id)).toEqual([]);
    });

    it.each([
      ['name', (graph: Graph) => ({ name: `Bad \u0000 name ${MARK}`, graph }), /^name$/],
      [
        'node text',
        (graph: Graph) => ({ graph: greetSays(graph, '\u0000') }),
        nodePath(g, 'greet', '\\.text'),
      ],
      [
        'a choice label',
        (graph: Graph) => ({
          graph: withNode(graph, 'payq', (n) => ({
            ...n,
            choices: [
              { key: 'ptp', label: 'Pay\u0000', next: 'ptp' },
              { key: 'refuse', label: 'No', next: 'refused' },
            ],
          })),
        }),
        nodePath(g, 'payq'),
      ],
    ] as const)(
      'a NUL in the %s is 400 nul_character, never stripped, never echoed',
      async (_what, body, path) => {
        const script = await createScript();
        const response = await updateRaw(SUPERVISOR, script.id, {
          revision: script.revision,
          ...body(goodGraph()),
        });
        expect400(response, path, 'nul_character');
        expect(response.text).not.toContain(MARK);
        expect(await readScript(script.id)).toEqual(script);
      },
    );

    it('a NUL in a new script’s name is 400 nul_character', async () => {
      expect400(
        await createRaw(SUPERVISOR, {
          programmeId: PROGRAMME_A1,
          name: 'Bad \u0000',
          sourceLocale: 'en',
        }),
        /^name$/,
        'nul_character',
      );
    });

    it('a lone UTF-16 surrogate in wording is never a 5xx (R6)', async () => {
      const script = await createScript();
      const response = await updateRaw(SUPERVISOR, script.id, {
        revision: script.revision,
        graph: greetSays(goodGraph(), 'half \ud800 a pair'),
      });
      expect(response.status, response.text).toBeLessThan(500);
      if (response.status === 400) expectError(response, 400, 'validation_failed');
      expectStatus(await getRaw(SUPERVISOR, script.id), 200, 'the script still reads');
    });

    it.each([
      ['an empty name', { name: '' }, /^name$/],
      ['a 121-character name', { name: 'n'.repeat(121) }, /^name$/],
      ['an unsupported source locale', { sourceLocale: 'de' }, /^sourceLocale$/],
      ['a locale in the wrong case', { sourceLocale: 'EN' }, /^sourceLocale$/],
    ] as const)('updateScript refuses %s with 400', async (_label, body, path) => {
      const script = await createScript();
      expect400(
        await updateRaw(SUPERVISOR, script.id, { revision: script.revision, ...body }),
        path,
      );
    });

    it.each([0, -1, 2147483648, 1.5, '1', null])(
      'revision %j is out of bounds: 400 on update, publish and translation',
      async (revision) => {
        const script = await createScript();
        expect400(await updateRaw(SUPERVISOR, script.id, { revision, name: 'x' }), /^revision$/);
        expect400(await publishRaw(SUPERVISOR, script.id, { revision }), /^revision$/);
        expect400(
          await translateRaw(SUPERVISOR, script.id, 'pcm', { revision, texts: {} }),
          /^revision$/,
        );
      },
    );

    it('a draft under 256 KiB is accepted even when its body is larger than a default 100 KB JSON limit', async () => {
      const graph = chainOfSays(45, 'a'.repeat(4000));
      const created = await createScript(SUPERVISOR, { graph });
      expect(created.draft.graph).toEqual(graph);
      const saved = await saveGraph(created.id, chainOfSays(44, 'b'.repeat(4000)));
      expect(saved.draft.graph.nodes).toHaveLength(45);
    });

    it('the cap counts UTF-8 bytes: a draft over 262144 bytes but under it in characters is 400 too_big, never 413', async () => {
      const script = await createScript();
      const graph = chainOfSays(24, '₦'.repeat(4000));
      const response = await updateRaw(SUPERVISOR, script.id, { revision: script.revision, graph });
      expect400(response, /.*/, 'too_big');
      expect(await readScript(script.id)).toEqual(script);
      const created = await createRaw(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        name: unique('T0113 too big'),
        sourceLocale: 'en',
        graph,
      });
      expect400(created, /.*/, 'too_big');
    });

    it('the cap covers graph and translations together: the translation that crosses it is 400 too_big', async () => {
      const graph = chainOfSays(30, 'a'.repeat(4000));
      const script = await createScript(SUPERVISOR, { graph });
      const texts = Object.fromEntries(
        graph.nodes
          .filter((node) => node.type === 'say')
          .map((node) => [node.id, { text: 'p'.repeat(4000) }]),
      );
      // Graph and one translation together: about 245 KB, under the cap.
      const withPcm = await translate(script.id, 'pcm', texts);
      expect(withPcm.translatedLocales).toEqual(['pcm']);
      const response = await translateRaw(SUPERVISOR, script.id, 'ha', {
        revision: withPcm.revision,
        texts,
      });
      expect400(response, /.*/, 'too_big');
      expect(await readScript(script.id)).toEqual(withPcm);
    });
  });

  // =========================================================================
  // 7. Publish: completeness, field rules, versions, audit.
  // =========================================================================

  describe('publish refuses an incomplete script: 409 script_invalid', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    async function publishGraph(
      graph: Graph,
      translations: Record<string, Json> = {},
    ): Promise<{ response: request.Response; script: Script }> {
      const script = await createScript(SUPERVISOR, { graph });
      for (const [locale, texts] of Object.entries(translations)) {
        await translate(script.id, locale, texts);
      }
      return { response: await publishNow(script.id), script };
    }

    async function expectInvalid(
      outcome: { response: request.Response; script: Script },
      code: string,
      path: (path: string) => boolean = () => true,
    ): Promise<Detail[]> {
      const body = expectError(outcome.response, 409, 'script_invalid');
      const details = detailsOf(body);
      expect(
        details.filter((detail) => detail.code === code && path(detail.path)),
        `no ${code} detail where expected: ${JSON.stringify(details)}`,
      ).not.toHaveLength(0);
      expect(
        outcome.response.text,
        'publish details name paths and codes, never wording',
      ).not.toContain(MARK);
      expect(await versionsOf(outcome.script.id), 'a refused publish published something').toEqual(
        [],
      );
      return details;
    }

    const g = goodGraph();
    const at = (id: string) => (path: string) => namesId(path, id);

    it('the control: the fixture graph publishes as version 1', async () => {
      const { response } = await publishGraph(goodGraph());
      expectStatus(response, 201, 'publish the good graph');
      expect(expectVersion(response.body, 'v1').number).toBe(1);
    });

    it('missing_start: a start node that names no node', async () => {
      await expectInvalid(
        await publishGraph({ ...goodGraph(), startNodeId: 'nowhere' }),
        'missing_start',
      );
    });

    it.each([
      [
        'a say node’s next',
        withNode(g, 'intro', (n) => ({ ...n, next: 'ghost' })),
        'nodes.intro.next',
      ],
      [
        'a choice’s next',
        withNode(g, 'payq', (n) => ({
          ...n,
          choices: [
            { key: 'ptp', label: 'Pay', next: 'ptp' },
            { key: 'refuse', label: 'No', next: 'ghost' },
          ],
        })),
        'nodes.payq.choices.refuse.next',
      ],
      [
        'a branch’s whenFalse',
        withNode(g, 'cust', (n) => ({ ...n, whenFalse: 'ghost' })),
        'nodes.cust.whenFalse',
      ],
    ] as const)(
      'unknown_target: %s, at the contract’s id-based path',
      async (_label, graph, path) => {
        await expectInvalid(
          await publishGraph(graph),
          'unknown_target',
          (detail) => detail === path,
        );
      },
    );

    it('cycle: a loop back to the start, even one with a way out', async () => {
      // readback -> greet: every node can still reach an end through idq.
      await expectInvalid(
        await publishGraph(withNode(g, 'readback', (n) => ({ ...n, next: 'greet' }))),
        'cycle',
      );
    });

    it('unreachable_end: a loop with no way out never reaches an end', async () => {
      const graph = addNodes(
        withNode(g, 'intro', (n) => ({ ...n, next: 'loopa' })),
        { id: 'loopa', type: 'say', title: 'Loop A', text: `A ${MARK}`, next: 'loopb' },
        { id: 'loopb', type: 'say', title: 'Loop B', text: `B ${MARK}`, next: 'loopa' },
      );
      await expectInvalid(
        await publishGraph(graph),
        'unreachable_end',
        (path) => namesId(path, 'loopa') || namesId(path, 'loopb') || namesId(path, 'intro'),
      );
    });

    it('a node no path from the start reaches is refused (the code is the builder’s)', async () => {
      const graph = addNodes(goodGraph(), {
        id: 'orphan',
        type: 'compliance',
        title: 'An orphaned statement',
        text: `Never read ${MARK}`,
        next: 'close',
      });
      const outcome = await publishGraph(graph);
      const body = expectError(outcome.response, 409, 'script_invalid');
      expect(detailsOf(body).some((detail) => namesId(detail.path, 'orphan'))).toBe(true);
    });

    it.each(['favouriteColour', 'constructor', 'toString', 'tenantId'])(
      'unknown_field: a branch on %s, which is not a contact field',
      async (field) => {
        const graph = withNode(g, 'cust', (n) => ({
          ...n,
          condition: { source: 'contact_field', field, operator: 'is_set' },
        }));
        await expectInvalid(await publishGraph(graph), 'unknown_field', at('cust'));
      },
    );

    it.each([
      '{loan.balance}',
      '{agent.email}',
      '{contact.favouriteColour}',
      '{contact.constructor}',
      '{answer.ghost.amount}',
      '{answer.ptp.ghost}',
    ])('unknown_variable: %s in wording', async (variable) => {
      await expectInvalid(
        await publishGraph(greetSays(g, variable)),
        'unknown_variable',
        at('greet'),
      );
    });

    it('unknown_variable in a choice label and in a translation, not only in source text (R2)', async () => {
      const label = withNode(g, 'idq', (n) => ({
        ...n,
        choices: [
          { key: 'yes', label: 'Yes {loan.balance}', next: 'cust' },
          { key: 'no', label: 'No', next: 'idfail' },
        ],
      }));
      await expectInvalid(await publishGraph(label), 'unknown_variable', at('idq'));
      await expectInvalid(
        await publishGraph(goodGraph(), {
          pcm: { greet: { text: `Abeg {loan.balance} ${MARK}` } },
        }),
        'unknown_variable',
        at('greet'),
      );
    });

    it('disposition_not_live: unknown, another programme’s, another tenant’s, deactivated and deleted are one body', async () => {
      await plantDispositions();
      const suggesting = (id: string) =>
        withNode(goodGraph(), 'close', (n) => ({ ...n, suggestedDispositionId: id }));
      const live = await publishGraph(suggesting(DISPOSITION_LIVE));
      expectStatus(live.response, 201, 'a live A1 disposition');
      const bodies: string[] = [];
      for (const id of [
        NOWHERE,
        DISPOSITION_A2,
        DISPOSITION_B1,
        DISPOSITION_INACTIVE,
        DISPOSITION_DELETED,
      ]) {
        const outcome = await publishGraph(suggesting(id));
        await expectInvalid(outcome, 'disposition_not_live', at('close'));
        bodies.push(outcome.response.text);
      }
      expect(new Set(bodies).size, 'the bodies tell the five apart').toBe(1);
    });

    it.each(['agent', 'team_lead', 'programme_manager'])(
      'branch_on_withheld_field: a branch on a field the %s set (script.run) cannot read (R1)',
      async (key) => {
        await lockContactField('status', key, 'none');
        await expectInvalid(
          await publishGraph(goodGraph()),
          'branch_on_withheld_field',
          at('cust'),
        );
      },
    );

    it('a field withheld only from sets without script.run, or merely read-only, does not block publishing', async () => {
      await lockContactField('status', 'qa_analyst', 'none');
      await lockContactField('status', 'client_portal', 'none');
      await lockContactField('status', 'agent', 'read');
      // Another tenant's decision binds only that tenant.
      await lockContactField('status', 'agent', 'none', TENANT_B);
      expectStatus((await publishGraph(goodGraph())).response, 201, 'publish');
    });

    it('branch_on_withheld_field: a variable on a withheld field, in source wording or in a translation', async () => {
      await lockContactField('given_names', 'agent', 'none');
      await expectInvalid(
        await publishGraph(greetSays(g, '{contact.givenNames}')),
        'branch_on_withheld_field',
        at('greet'),
      );
      await expectInvalid(
        await publishGraph(goodGraph(), {
          ha: { greet: { text: `Sannu {contact.givenNames} ${MARK}` } },
        }),
        'branch_on_withheld_field',
        at('greet'),
      );
    });

    it('sensitive_field: a branch, a variable, or a translated variable on a sensitive contact field (until D-L13)', async () => {
      await makeSensitive('state');
      await makeSensitive('lga');
      await expectInvalid(
        await publishGraph(
          withNode(g, 'cust', (n) => ({
            ...n,
            condition: { source: 'contact_field', field: 'state', operator: 'is_set' },
          })),
        ),
        'sensitive_field',
        at('cust'),
      );
      await expectInvalid(
        await publishGraph(greetSays(g, '{contact.lga}')),
        'sensitive_field',
        at('greet'),
      );
      await expectInvalid(
        await publishGraph(goodGraph(), {
          yo: { greet: { text: `E kaasan {contact.lga} ${MARK}` } },
        }),
        'sensitive_field',
        at('greet'),
      );
    });

    it('unchanged: publishing the same content again, even after re-saving it, is refused (R4)', async () => {
      const script = await createScript();
      await publish(script.id);
      const again = await publishNow(script.id);
      const body = expectError(again, 409, 'script_invalid');
      expect(detailsOf(body).map((detail) => detail.code)).toContain('unchanged');
      await saveGraph(script.id, goodGraph());
      const resaved = await publishNow(script.id);
      expect(detailsOf(expectError(resaved, 409, 'script_invalid')).map((d) => d.code)).toContain(
        'unchanged',
      );
      // A translation is a change.
      await translate(script.id, 'pcm', { greet: { text: `Pidgin ${MARK}` } });
      expect((await publish(script.id)).number).toBe(2);
    });

    it('an empty draft (createScript without a graph) is created, and is never publishable', async () => {
      const script = await createRaw(SUPERVISOR, {
        programmeId: PROGRAMME_A1,
        name: unique('T0113 empty'),
        sourceLocale: 'en',
      });
      expectStatus(script, 201, 'createScript without a graph');
      const id = (script.body as { id: string }).id;
      const response = await publishRaw(SUPERVISOR, id, {
        revision: (script.body as { revision: number }).revision,
      });
      expectError(response, 409, 'script_invalid');
    });

    it('reachability is linear: 79 nodes and 2^26 paths publish in under ten seconds', async () => {
      // A validator that walks paths takes minutes here (and blocks this
      // process while it does); one pass over nodes and edges takes
      // milliseconds.
      const script = await createScript(SUPERVISOR, { graph: diamonds(26) });
      const started = Date.now();
      const response = await publishNow(script.id);
      const elapsed = Date.now() - started;
      expectStatus(response, 201, 'publish 2^26 paths');
      expect(elapsed, 'publish took too long for a linear check').toBeLessThan(10_000);
    });
  });

  describe('versions: numbered, immutable, and the draft as it was', () => {
    it('versions are 1, 2, 3; republishing never changes an earlier one; the list is newest first', async () => {
      const script = await createScript();
      const v1 = await publish(script.id, SUPERVISOR, { changes: [`First ${MARK}`] });
      const v1Read = expectVersion((await versionRaw(SUPERVISOR, script.id, v1.id)).body, 'v1');
      expect(v1Read).toEqual(v1);
      expect(v1).toMatchObject({ scriptId: script.id, number: 1, changes: [`First ${MARK}`] });
      expect(v1.graph).toEqual(goodGraph());
      expect(v1.publishedBy?.id).toBe(USER_A_SUPERVISOR);

      const second = greetSays(goodGraph(), 'Second.');
      await saveGraph(script.id, second);
      await translate(script.id, 'pcm', { greet: { text: `Pidgin two ${MARK}` } });
      const v2 = await publish(script.id);
      expect(v2.number).toBe(2);
      expect(v2.graph).toEqual(second);
      expect(Object.keys(v2.translations)).toEqual(['pcm']);

      await saveGraph(script.id, greetSays(goodGraph(), 'Third.'));
      const v3 = await publish(script.id);
      expect(v3.number).toBe(3);

      // Later edits never reach an earlier version.
      await saveGraph(script.id, greetSays(goodGraph(), 'A draft nobody published.'));
      await translate(script.id, 'pcm', { greet: { text: `Pidgin draft ${MARK}` } });
      for (const version of [v1, v2, v3]) {
        const read = await versionRaw(SUPERVISOR, script.id, version.id);
        expectStatus(read, 200, `getScriptVersion v${version.number}`);
        expectNoStore(read, 'getScriptVersion');
        expect(expectVersion(read.body, `v${version.number}`)).toEqual(version);
      }
      const list = await versionsOf(script.id);
      expect(list.map((row) => row.number)).toEqual([3, 2, 1]);
      expect(list.map((row) => row.id)).toEqual([v3.id, v2.id, v1.id]);
      const latest = await readScript(script.id);
      expect(latest.latestVersion).toEqual(list[0]);
      expect(latest.hasUnpublishedChanges).toBe(true);
    });

    it('a version of another script is the same 404 as no version at all', async () => {
      const one = await publishedScript();
      const two = await publishedScript();
      const nothing = await versionRaw(SUPERVISOR, one.script.id, NOWHERE_VERSION);
      expectError(nothing, 404, 'not_found');
      const crossed = await versionRaw(SUPERVISOR, one.script.id, two.version.id);
      expectError(crossed, 404, 'not_found');
      expect(crossed.text).toBe(nothing.text);
    });

    it.each(['not-a-uuid', '1', `${NOWHERE_VERSION}x`, 'v1'])(
      'a versionId that is not a uuid (%s) is 404, the same body as a version that does not exist (A11)',
      async (versionId) => {
        const one = await publishedScript();
        // The control: the real version reads.
        expectStatus(await versionRaw(SUPERVISOR, one.script.id, one.version.id), 200, 'v1');
        const nothing = await versionRaw(SUPERVISOR, one.script.id, NOWHERE_VERSION);
        expectError(nothing, 404, 'not_found');
        const malformed = await versionRaw(SUPERVISOR, one.script.id, versionId);
        expectError(malformed, 404, 'not_found');
        expect(malformed.text).toBe(nothing.text);
      },
    );

    it('publish is closed: a number, a version id or a graph in the body is 400 and publishes nothing', async () => {
      const script = await createScript();
      for (const extra of [
        { number: 7 },
        { versionId: NOWHERE },
        { graph: goodGraph() },
        { changes: Array.from({ length: 11 }, (_, i) => `c${i}`) },
        { changes: [''] },
      ]) {
        expectError(
          await publishRaw(SUPERVISOR, script.id, { revision: script.revision, ...extra }),
          400,
          'validation_failed',
        );
      }
      expect400(
        await publishRaw(SUPERVISOR, script.id, {
          revision: script.revision,
          changes: ['bad \u0000'],
        }),
        /^changes/,
        'nul_character',
      );
      expect(await versionsOf(script.id)).toEqual([]);
    });

    it('two concurrent publishes of one revision mint exactly one version (R8)', async () => {
      const script = await createScript();
      const responses = await Promise.all([
        publishRaw(SUPERVISOR, script.id, { revision: script.revision }),
        publishRaw(SUPERVISOR, script.id, { revision: script.revision }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const loser = responses.find((response) => response.status === 409);
      expect(['stale_write', 'script_invalid']).toContain((loser?.body as Json | undefined)?.code);
      expect((await versionsOf(script.id)).map((row) => row.number)).toEqual([1]);
    });
  });

  describe('audit: one event per write, by name, never wording', () => {
    it('create, update and translate write one event each, naming parts and the locale, never wording', async () => {
      let before = await auditIds();
      const script = await createScript();
      const created = await auditSince(before, script.id);
      expect(created, 'createScript events').toHaveLength(1);
      expect(created[0]).toMatchObject({
        action: 'created',
        object_type: 'script',
        object_id: script.id,
        programme_id: PROGRAMME_A1,
        actor_kind: 'user',
        actor_user_id: USER_A_SUPERVISOR,
      });

      before = await auditIds();
      await saveGraph(script.id, greetSays(goodGraph(), `Changed ${MARK}`));
      const updated = await auditSince(before, script.id);
      expect(updated, 'updateScript events').toHaveLength(1);
      expect(updated[0]?.action).toBe('updated');
      const fields = (updated[0]?.changes ?? []).map((change) => change.field);
      expect(fields).toContain('graph');
      expect(
        fields.every((field) => ['name', 'sourceLocale', 'graph'].includes(field)),
        JSON.stringify(fields),
      ).toBe(true);

      before = await auditIds();
      await translate(script.id, 'pcm', { greet: { text: `Pidgin ${MARK}` } });
      const translated = await auditSince(before, script.id);
      expect(translated, 'putScriptTranslation events').toHaveLength(1);
      expect(translated[0]?.action).toBe('updated');
      expect(namesId(JSON.stringify(translated[0]), 'pcm'), 'the event names the locale').toBe(
        true,
      );

      for (const event of [...created, ...updated, ...translated]) {
        expect(JSON.stringify(event), 'an authoring event carries wording').not.toContain(MARK);
      }
    });

    it('the publish event names the compliance nodes added, removed and changed, each in its own entry, and nothing else (R3)', async () => {
      const compliance = (id: string, text: string, next: string): GraphNode => ({
        id,
        type: 'compliance',
        title: `Statement ${id}`,
        text: `${text} ${MARK}`,
        next,
      });
      const v1Graph: Graph = {
        startNodeId: 'opener',
        nodes: [
          { id: 'opener', type: 'say', title: 'Opener', text: `Hello ${MARK}`, next: 'c_keep' },
          compliance('c_keep', 'Recorded.', 'c_edit'),
          compliance('c_edit', 'Fees apply.', 'c_drop'),
          compliance('c_drop', 'Old notice.', 'done'),
          { id: 'done', type: 'end', title: 'Done' },
        ],
      };
      const script = await createScript(SUPERVISOR, { graph: v1Graph });
      const bucket = (event: AuditRow | undefined, field: string) =>
        JSON.stringify((event?.changes ?? []).filter((change) => change.field === field));

      let before = await auditIds();
      await publish(script.id, SUPERVISOR, { changes: [`Launch note ${MARK}`] });
      const first = await auditSince(before, script.id);
      expect(
        first.map((row) => [row.action, row.object_type]),
        'a publish is exactly one `published` event on the script',
      ).toEqual([['published', 'script']]);
      for (const id of ['c_keep', 'c_edit', 'c_drop']) {
        expect(namesId(bucket(first[0], 'complianceNodesAdded'), id), `v1 adds ${id}`).toBe(true);
      }

      const v2Graph: Graph = {
        startNodeId: 'opener',
        nodes: [
          {
            id: 'opener',
            type: 'say',
            title: 'Opener',
            text: `Hello again ${MARK}`,
            next: 'c_keep',
          },
          compliance('c_keep', 'Recorded.', 'c_edit'),
          compliance('c_edit', 'Fees of five percent apply.', 'c_new'),
          compliance('c_new', 'New notice.', 'done'),
          { id: 'done', type: 'end', title: 'Done' },
        ],
      };
      await saveGraph(script.id, v2Graph);
      before = await auditIds();
      await publish(script.id, SUPERVISOR, { changes: [`Second note ${MARK}`] });
      const second = await auditSince(before, script.id);
      expect(second, 'publish events').toHaveLength(1);
      const event = second[0];
      expect(event).toMatchObject({
        action: 'published',
        actor_kind: 'user',
        object_type: 'script',
        object_id: script.id,
        programme_id: PROGRAMME_A1,
        actor_user_id: USER_A_SUPERVISOR,
      });
      const added = bucket(event, 'complianceNodesAdded');
      const removed = bucket(event, 'complianceNodesRemoved');
      const changed = bucket(event, 'complianceNodesChanged');
      expect({
        added: ['c_new', 'c_drop', 'c_edit', 'c_keep'].filter((id) => namesId(added, id)),
        removed: ['c_new', 'c_drop', 'c_edit', 'c_keep'].filter((id) => namesId(removed, id)),
        changed: ['c_new', 'c_drop', 'c_edit', 'c_keep'].filter((id) => namesId(changed, id)),
      }).toEqual({ added: ['c_new'], removed: ['c_drop'], changed: ['c_edit'] });
      expect(
        namesId(JSON.stringify(event), 'c_keep'),
        'an unchanged compliance node is named',
      ).toBe(false);
      expect(
        JSON.stringify(event),
        'the publish event carries wording or a publish note',
      ).not.toContain(MARK);
      expect(JSON.stringify(event)).not.toContain('Fees');

      // R3: only the Hausa wording of c_keep changes. That is a change.
      await translate(script.id, 'ha', { c_keep: { text: `An nadi ${MARK}` } });
      before = await auditIds();
      await publish(script.id);
      const third = await auditSince(before, script.id);
      expect(third.map((row) => row.action)).toEqual(['published']);
      expect(
        namesId(bucket(third[0], 'complianceNodesChanged'), 'c_keep'),
        'a translated compliance change',
      ).toBe(true);
      expect(JSON.stringify(third[0])).not.toContain(MARK);
    });

    it('audit_event’s action CHECK admits 0008’s ten actions plus `published` (and T-0095’s `merged` and `restored`, D-L173), and nothing else', async () => {
      const definition = await observer.query<{ definition: string | null }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'public.audit_event'::regclass AND conname = 'audit_event_action_check'`,
      );
      const def = definition.rows[0]?.definition ?? '';
      expect(def, 'audit_event_action_check is missing').not.toBe('');
      // D-L173: 0043 (T-0095) legitimately adds `merged` and `restored`.
      expect(checkValues(def)).toEqual([...AUDIT_ACTIONS_0008, 'published', 'merged', 'restored'].sort());
      // Behaviour, not only the text: a `published` row is accepted, and a
      // near miss is still refused (rolled back).
      const outcomes = await rolledBackTx(observer, async (query) => {
        const insert = (action: string) =>
          probe(
            query,
            `INSERT INTO audit_event (id, tenant_id, actor_kind, action, object_type, object_label)
             VALUES (gen_random_uuid(), $1, 'system', $2, 'script', 'T-0113 probe')`,
            [TENANT_A, action],
          );
        return {
          published: verdict(await insert('published')),
          publish: verdict(await insert('publish')),
          unpublished: verdict(await insert('unpublished')),
        };
      });
      expect(outcomes).toEqual({
        published: 'accepted',
        publish: 'refused',
        unpublished: 'refused',
      });
    });

    it('(self-check) the CHECK reader returns the ten actions 0008 wrote', () => {
      // Passes on main by design: pg_get_constraintdef's own rendering of 0008.
      const rendered =
        "CHECK ((action = ANY (ARRAY['created'::text, 'updated'::text, 'deleted'::text, " +
        "'exported'::text, 'invited'::text, 'viewed'::text, 'failed_sign_in'::text, " +
        "'rejected'::text, 'rotated'::text, 'played_recording'::text])))";
      expect(checkValues(rendered)).toEqual([...AUDIT_ACTIONS_0008].sort());
    });

    it('the admin audit API filters on `published` and returns the event as an AuditEntry', async () => {
      const script = await createScript();
      await publish(script.id);
      const response = await request(server())
        .get(
          withQuery('/api/v1/admin/audit/events', [
            ['action', 'published'],
            ['pageSize', '200'],
          ]),
        )
        .set(SUPERVISOR);
      expectStatus(response, 200, 'listAuditEvents?action=published');
      expectSchema(response.body, 'AuditEventList', 'listAuditEvents', ADMIN_SPEC_PATH);
      const items = (response.body as { items: Json[] }).items;
      expect(items.length).toBeGreaterThan(0);
      expect(new Set(items.map((item) => item.action))).toEqual(new Set(['published']));
      expect(items.find((item) => item.objectId === script.id)).toMatchObject({
        action: 'published',
        objectType: 'script',
        programmeId: PROGRAMME_A1,
      });
    });

    it('refused writes write no event: 404, 400, stale 409 and script_invalid 409', async () => {
      const script = await createScript();
      const before = await auditIds();
      expectError(
        await updateRaw(AGENT_1, script.id, { revision: script.revision, name: 'x' }),
        404,
        'not_found',
      );
      expectError(
        await updateRaw(SUPERVISOR, script.id, { revision: script.revision, name: '' }),
        400,
        'validation_failed',
      );
      expectError(
        await updateRaw(SUPERVISOR, script.id, { revision: script.revision + 7, name: 'x' }),
        409,
        'stale_write',
      );
      // The one successful write in this test: exactly one event follows.
      await saveGraph(script.id, { ...goodGraph(), startNodeId: 'nowhere' });
      expectError(await publishNow(script.id), 409, 'script_invalid');
      expectError(
        await translateRaw(SUPERVISOR, script.id, 'en', { revision: 1, texts: {} }),
        400,
        'validation_failed',
      );
      const events = await auditSince(before, script.id);
      expect(
        events.map((event) => event.action),
        'only the successful save wrote an event',
      ).toEqual(['updated']);
    });
  });

  // =========================================================================
  // 8. Translations.
  // =========================================================================

  describe('putScriptTranslation', () => {
    it('accepts the six non-source design locales on an en script, and en on an fr script', async () => {
      const script = await createScript();
      const others = LOCALES.filter((locale) => locale !== 'en');
      let last: Script = script;
      for (const locale of others) {
        last = await translate(script.id, locale, { greet: { text: `${locale} ${MARK}` } });
      }
      expect([...last.translatedLocales].sort()).toEqual([...others].sort());
      expect(last.hasUnpublishedChanges).toBe(true);
      const read = await readScript(script.id);
      for (const locale of others) {
        expect(read.draft.translations[locale]).toEqual({ greet: { text: `${locale} ${MARK}` } });
      }
      const french = await createScript(SUPERVISOR, { sourceLocale: 'fr' });
      const english = await translate(french.id, 'en', { greet: { text: `English ${MARK}` } });
      expect(english.translatedLocales).toEqual(['en']);
    });

    it.each(['en', 'de', 'EN', 'en-NG', 'xx', 'pcm%20', 'english'])(
      'locale %s is 400: the source locale, or not one of the seven',
      async (locale) => {
        const script = await createScript();
        const response = await translateRaw(SUPERVISOR, script.id, locale, {
          revision: script.revision,
          texts: { greet: { text: 'x' } },
        });
        expectError(response, 400, 'validation_failed');
        expect(await readScript(script.id)).toEqual(script);
      },
    );

    it.each([
      ['a key that names no node', { ghost: { text: 'x' } }],
      ['a choice key the node does not have', { payq: { choices: { ghost: 'x' } } }],
      ['a field key the node does not have', { ptp: { fields: { ghost: 'x' } } }],
      ['a free-form property', { greet: { text: 'x', audio: 'x' } }],
      ['an empty text', { greet: { text: '' } }],
    ] as const)('texts with %s is 400 and writes nothing', async (_label, texts) => {
      const script = await createScript();
      expect400(
        await translateRaw(SUPERVISOR, script.id, 'pcm', { revision: script.revision, texts }),
        /^texts/,
      );
      expect(await readScript(script.id)).toEqual(script);
    });

    it('a NUL in a translation is 400 nul_character; empty texts remove a translation; a stale revision is 409', async () => {
      const script = await createScript();
      expect400(
        await translateRaw(SUPERVISOR, script.id, 'pcm', {
          revision: script.revision,
          texts: { greet: { text: 'bad \u0000' } },
        }),
        /^texts/,
        'nul_character',
      );
      const added = await translate(script.id, 'pcm', {
        greet: { text: `Pidgin ${MARK}` },
        payq: { choices: { ptp: 'I go pay' }, text: `You fit pay? ${MARK}` },
        ptp: { fields: { amount: 'Money' } },
      });
      expect(added.revision).toBeGreaterThan(script.revision);
      expectError(
        await translateRaw(SUPERVISOR, script.id, 'pcm', { revision: script.revision, texts: {} }),
        409,
        'stale_write',
      );
      const removed = await translate(script.id, 'pcm', {});
      expect(removed.translatedLocales).toEqual([]);
      expect(removed.draft.translations).toEqual({});
    });
  });

  // =========================================================================
  // 9. Paging and caching.
  // =========================================================================

  describe('paging: keyset, id-only cursors resolved inside their own list, no totals', () => {
    // A clean slate, so the one-row-per-page walks stay short.
    beforeAll(async () => {
      await reseed(inject('migrationUrl'));
    });
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    async function walk(
      headers: Headers,
      limit: number,
    ): Promise<{
      ids: string[];
      names: Map<string, string>;
      cursors: { cursor: string; lastName: string }[];
    }> {
      const ids: string[] = [];
      const names = new Map<string, string>();
      const cursors: { cursor: string; lastName: string }[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 200; guard += 1) {
        const page = expectScriptPage(
          await listRaw(headers, [
            ['limit', String(limit)],
            ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
          ]),
          'listScripts',
        );
        for (const row of page.data) {
          expectSchema(row, 'ScriptSummary', 'listScripts row');
          ids.push(row.id as string);
          names.set(row.id as string, row.name as string);
        }
        cursor = page.nextCursor;
        if (cursor === null) return { ids, names, cursors };
        cursors.push({ cursor, lastName: String(page.data[page.data.length - 1]?.name) });
      }
      throw new Error('listScripts never returned a null nextCursor');
    }

    it('listScripts pages by name then id with no repeats or gaps, and a cursor never carries a name (R9)', async () => {
      const prefix = `T0113 Paging ${RUN}`;
      const made = [
        await createScript(SUPERVISOR, { name: `${prefix} Zainab Cursorprobe` }),
        await createScript(SUPERVISOR, { name: `${prefix} Bravo` }),
        await createScript(SUPERVISOR, { name: `${prefix} Bravo` }),
        await createScript(SUPERVISOR, { name: `${prefix} Alpha` }),
        await createScript(SUPERVISOR, { name: `${prefix} Charlie`, programmeId: PROGRAMME_A2 }),
      ];
      const { ids, names, cursors } = await walk(SUPERVISOR, 1);
      expect(new Set(ids).size, 'a row appeared on two pages').toBe(ids.length);
      const mine = ids.filter((id) => made.some((script) => script.id === id));
      const expected = [...made]
        .sort((left, right) =>
          left.name === right.name
            ? left.id < right.id
              ? -1
              : 1
            : left.name < right.name
              ? -1
              : 1,
        )
        .map((script) => script.id);
      expect(mine, 'name, then id').toEqual(expected);
      expect(names.size).toBe(ids.length);
      for (const { cursor, lastName } of cursors) {
        for (const form of cursorForms(cursor)) {
          expect(form, 'a cursor carries the last row’s name (D-L80)').not.toContain(lastName);
          expect(form).not.toContain('Cursorprobe');
        }
      }
      expect(cursors.length).toBeGreaterThan(0);
    });

    it('listScriptVersions pages newest first, one at a time', async () => {
      const script = await createScript();
      await publish(script.id);
      for (const extra of ['Two.', 'Three.']) {
        await saveGraph(script.id, greetSays(goodGraph(), extra));
        await publish(script.id);
      }
      const numbers: number[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = expectVersionPage(
          await versionsRaw(SUPERVISOR, script.id, [
            ['limit', '1'],
            ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
          ]),
          'listScriptVersions',
        );
        numbers.push(...page.data.map((row) => row.number));
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(numbers).toEqual([3, 2, 1]);
    });

    it('a cursor is resolved inside its own list: another list’s, another script’s or another tenant’s is the garbage cursor’s 400', async () => {
      const one = await publishedScript();
      const two = await publishedScript();
      for (const fixture of [one, two]) {
        await saveGraph(fixture.script.id, greetSays(goodGraph(), 'Again.'));
        await publish(fixture.script.id);
      }
      const garbage = await versionsRaw(SUPERVISOR, one.script.id, [['cursor', 'not-a-cursor']]);
      expect400(garbage, /^cursor$/, 'invalid_cursor');
      const versionCursor = expectVersionPage(
        await versionsRaw(SUPERVISOR, two.script.id, [['limit', '1']]),
        'versions of two',
      ).nextCursor;
      const scriptsCursor = expectScriptPage(
        await listRaw(SUPERVISOR, [['limit', '1']]),
        'scripts',
      ).nextCursor;
      expect(versionCursor, 'two versions give a next page').not.toBeNull();
      expect(scriptsCursor, 'several scripts give a next page').not.toBeNull();

      const attempts: [string, request.Response][] = [
        [
          'another script’s version cursor',
          await versionsRaw(SUPERVISOR, one.script.id, [['cursor', String(versionCursor)]]),
        ],
        [
          'a listScripts cursor on versions',
          await versionsRaw(SUPERVISOR, one.script.id, [['cursor', String(scriptsCursor)]]),
        ],
      ];
      for (const [label, response] of attempts) {
        expect400(response, /^cursor$/, 'invalid_cursor');
        expect(response.text, label).toBe(garbage.text);
      }
      const garbageList = await listRaw(SUPERVISOR, [['cursor', 'not-a-cursor']]);
      expect400(garbageList, /^cursor$/, 'invalid_cursor');
      for (const [label, response] of [
        [
          'a version cursor on listScripts',
          await listRaw(SUPERVISOR, [['cursor', String(versionCursor)]]),
        ],
        [
          'tenant A’s cursor in tenant B',
          await listRaw(TENANT_B_ADMIN, [['cursor', String(scriptsCursor)]]),
        ],
        ['a 513-character cursor', await listRaw(SUPERVISOR, [['cursor', 'a'.repeat(513)]])],
      ] as const) {
        expectError(response, 400, 'validation_failed');
        if (label !== 'a 513-character cursor') expect(response.text, label).toBe(garbageList.text);
      }
    });

    it('a cursor on a row the caller can no longer author is the garbage cursor’s 400', async () => {
      // Named so the A2 row sorts before the A1 row: it is never the last.
      const inA2 = await createScript(SUPERVISOR, {
        programmeId: PROGRAMME_A2,
        name: unique('T0113 Aa row'),
      });
      await createScript(SUPERVISOR, { name: unique('T0113 Zz row') });
      // Walk one row per page until the A2 script is the last row of a page.
      let cursor: string | null = null;
      let found: string | null = null;
      for (let guard = 0; guard < 200 && found === null; guard += 1) {
        const page = expectScriptPage(
          await listRaw(SUPERVISOR, [
            ['limit', '1'],
            ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
          ]),
          'listScripts',
        );
        if (page.data[0]?.id === inA2.id) found = page.nextCursor ?? 'last-page';
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(found, 'the A2 script never ended a page').not.toBeNull();
      expect(found, 'the A2 script must not be the last row overall').not.toBe('last-page');
      // The control: the cursor works for the caller it was issued to.
      expectStatus(await listRaw(SUPERVISOR, [['cursor', String(found)]]), 200, 'own cursor');
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A2, 'agent');
      await setTenantAdmin(USER_A_SUPERVISOR, false);
      const garbage = await listRaw(SUPERVISOR, [['cursor', 'not-a-cursor']]);
      const outOfScope = await listRaw(SUPERVISOR, [['cursor', String(found)]]);
      expect400(outOfScope, /^cursor$/, 'invalid_cursor');
      expect(outOfScope.text).toBe(garbage.text);
    });

    it.each(['0', '101', 'ten', '1.5', '-1'])(
      'limit=%s is 400 on both lists, never clamped',
      async (limit) => {
        const script = await createScript();
        expect400(await listRaw(SUPERVISOR, [['limit', limit]]), /^limit$/);
        expect400(await versionsRaw(SUPERVISOR, script.id, [['limit', limit]]), /^limit$/);
      },
    );
  });

  // =========================================================================
  // 10. listProgrammeScripts (admin), now backed.
  // =========================================================================

  describe('listProgrammeScripts (admin) is backed by the script tables and gated on script.write', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    function expectScriptList(response: request.Response, where: string) {
      expectStatus(response, 200, where);
      expectSchema(response.body, 'ScriptList', where, ADMIN_SPEC_PATH);
      expectNoStore(response, where);
      return response.body as {
        items: { id: string; name: string; status: string; version: number }[];
        page: { nextCursor: string | null; hasMore: boolean };
      };
    }

    it('lists the programme’s real scripts: draft before the first publish, published at the latest number after', async () => {
      const draft = await createScript(SUPERVISOR, { name: unique('T0113 admin draft') });
      const published = await publishedScript();
      await saveGraph(published.script.id, greetSays(goodGraph(), 'Two.'));
      await publish(published.script.id);
      const elsewhere = await createScript(SUPERVISOR, { programmeId: PROGRAMME_A2 });

      const items: { id: string; name: string; status: string; version: number }[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard += 1) {
        const list = expectScriptList(
          await programmeScriptsRaw(SUPERVISOR, PROGRAMME_A1, [
            ['pageSize', '1'],
            ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
          ]),
          'listProgrammeScripts',
        );
        items.push(...list.items);
        cursor = list.page.nextCursor;
        if (!list.page.hasMore || cursor === null) break;
      }
      const ids = items.map((item) => item.id);
      expect(new Set(ids).size, 'a script appeared on two pages').toBe(ids.length);
      expect(ids).toEqual(expect.arrayContaining([draft.id, published.script.id]));
      expect(ids).not.toContain(elsewhere.id);
      expect(items.find((item) => item.id === draft.id)).toMatchObject({
        name: draft.name,
        status: 'draft',
      });
      expect(items.find((item) => item.id === published.script.id)).toMatchObject({
        status: 'published',
        version: 2,
      });
      for (const item of items) expect(['draft', 'published']).toContain(item.status);
    });

    it('anyone without script.write in the programme gets the unreachable programme’s 404, with no-store', async () => {
      await createScript();
      const reference = await programmeScriptsRaw(AGENT_1, PROGRAMME_A2);
      expectError(reference, 404, 'not_found');
      for (const [who, response] of [
        ['agent 1 in A1', await programmeScriptsRaw(AGENT_1, PROGRAMME_A1)],
        ['agent 1, no such programme', await programmeScriptsRaw(AGENT_1, NOWHERE)],
        ['tenant B on A1', await programmeScriptsRaw(TENANT_B_ADMIN, PROGRAMME_A1)],
      ] as const) {
        expectError(response, 404, 'not_found');
        expect(response.text, who).toBe(reference.text);
      }
      for (const key of NON_WRITER_KEYS) {
        await assign(TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1, key);
        const response = await programmeScriptsRaw(NO_PROGRAMME, PROGRAMME_A1);
        expectError(response, 404, 'not_found');
        expect(response.text, key).toBe(reference.text);
      }
      // The flag is script.write in a programme the user reaches.
      await setTenantAdmin(USER_A_AGENT_1, true);
      expectScriptList(await programmeScriptsRaw(AGENT_1, PROGRAMME_A1), 'the tenant-admin flag');
    });
  });

  // =========================================================================
  // 11. Error order, authentication and scope transport.
  // =========================================================================

  describe('errors are decided in the published order', () => {
    it('createScript: 404 (target) before 403 before 400', async () => {
      const bad = (programmeId: string) => ({ programmeId, name: '', sourceLocale: 'xx' });
      expectError(await createRaw(AGENT_1, bad(PROGRAMME_A2)), 404, 'not_found');
      expectError(await createRaw(AGENT_1, bad(PROGRAMME_A1)), 403, 'not_permitted');
      expectError(await createRaw(SUPERVISOR, bad(PROGRAMME_A1)), 400, 'validation_failed');
    });

    it('getScript, listScriptVersions and getScriptVersion: 404 before 400', async () => {
      const fixture = await publishedScript();
      expectError(
        await versionsRaw(AGENT_1, fixture.script.id, [['limit', '0']]),
        404,
        'not_found',
      );
      expectError(
        await versionsRaw(AGENT_1, NOWHERE, [['cursor', 'x'.repeat(600)]]),
        404,
        'not_found',
      );
      expectError(
        await versionsRaw(SUPERVISOR, fixture.script.id, [['limit', '0']]),
        400,
        'validation_failed',
      );
      expectError(await getRaw(SUPERVISOR, 'not-a-uuid'), 400, 'validation_failed');
    });

    it('updateScript and putScriptTranslation: 404 before 400 before 409 stale_write', async () => {
      const script = await createScript();
      const stale = script.revision + 5;
      expectError(
        await updateRaw(AGENT_1, script.id, { revision: stale, name: '' }),
        404,
        'not_found',
      );
      expectError(
        await updateRaw(SUPERVISOR, script.id, { revision: stale, name: '' }),
        400,
        'validation_failed',
      );
      expectError(
        await updateRaw(SUPERVISOR, script.id, { revision: stale, name: 'ok' }),
        409,
        'stale_write',
      );
      expectError(
        await translateRaw(AGENT_1, script.id, 'xx', { revision: stale, texts: {} }),
        404,
        'not_found',
      );
      expectError(
        await translateRaw(SUPERVISOR, script.id, 'xx', { revision: stale, texts: {} }),
        400,
        'validation_failed',
      );
      expectError(
        await translateRaw(SUPERVISOR, script.id, 'en', { revision: stale, texts: {} }),
        400,
        'validation_failed',
      );
      expectError(
        await translateRaw(SUPERVISOR, script.id, 'pcm', { revision: stale, texts: {} }),
        409,
        'stale_write',
      );
    });

    it('publishScript: 404, then 400, then 409 stale_write, then 409 script_invalid', async () => {
      const script = await createScript(SUPERVISOR, {
        graph: { ...goodGraph(), startNodeId: 'nowhere' },
      });
      const stale = script.revision + 5;
      expectError(await publishRaw(AGENT_1, script.id, { revision: 0 }), 404, 'not_found');
      expectError(
        await publishRaw(SUPERVISOR, script.id, { revision: 0 }),
        400,
        'validation_failed',
      );
      expectError(await publishRaw(SUPERVISOR, script.id, { revision: stale }), 409, 'stale_write');
      expectError(
        await publishRaw(SUPERVISOR, script.id, { revision: script.revision }),
        409,
        'script_invalid',
      );
    });

    it('listScripts answers 400 for a bad query and never 403 or 404', async () => {
      expectError(await listRaw(AGENT_1, [['limit', '0']]), 400, 'validation_failed');
      expectScriptPage(await listRaw(NO_PROGRAMME), 'listScripts with no programme');
    });
  });

  describe('authentication and scope transport', () => {
    const every = (scriptId: string, versionId: string): [string, () => request.Test][] => [
      ['listScripts', () => request(server()).get(SCRIPTS)],
      [
        'createScript',
        () =>
          request(server())
            .post(SCRIPTS)
            .send({ programmeId: PROGRAMME_A1, name: 'x', sourceLocale: 'en' }),
      ],
      ['getScript', () => request(server()).get(scriptPath(scriptId))],
      [
        'updateScript',
        () => request(server()).patch(scriptPath(scriptId)).send({ revision: 1, name: 'x' }),
      ],
      ['listScriptVersions', () => request(server()).get(versionsPath(scriptId))],
      ['publishScript', () => request(server()).post(versionsPath(scriptId)).send({ revision: 1 })],
      ['getScriptVersion', () => request(server()).get(versionPath(scriptId, versionId))],
      [
        'putScriptTranslation',
        () =>
          request(server()).put(translationPath(scriptId, 'pcm')).send({ revision: 1, texts: {} }),
      ],
    ];

    it('every authoring operation is 401 not_authenticated, with no-store, without a usable session', async () => {
      const fixture = await publishedScript();
      for (const [name, build] of every(fixture.script.id, fixture.version.id)) {
        const none = await build();
        expectError(none, 401, 'not_authenticated');
        const forged = await build().set('authorization', 'Bearer ksw_s1_not-a-real-session');
        expectError(forged, 401, 'not_authenticated');
        expect(forged.text, name).toBe(none.text);
      }
    });

    it('a scope header is 400 on every authoring operation, the same body in reach or out', async () => {
      const mine = await publishedScript();
      const theirs = await publishedScript(SUPERVISOR, PROGRAMME_A2);
      const inReach = every(mine.script.id, mine.version.id);
      const outOfReach = every(theirs.script.id, theirs.version.id);
      for (const [header, value] of SCOPE_HEADERS) {
        for (const [index, [name, build]] of inReach.entries()) {
          const reachable = await build().set(SUPERVISOR).set(header, value);
          expectError(reachable, 400, 'validation_failed');
          const other = outOfReach[index];
          if (other === undefined) continue;
          const unreachable = await other[1]().set(AGENT_1).set(header, value);
          expectError(unreachable, 400, 'validation_failed');
          expect(unreachable.text, `${name} with ${header}`).toBe(reachable.text);
        }
      }
      expect(await readScript(mine.script.id)).toEqual(mine.script);
    });
  });
});
