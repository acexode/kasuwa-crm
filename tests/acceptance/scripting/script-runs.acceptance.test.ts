import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  PROGRAMME_B1,
  SEED_CONTACTS,
  SEED_PERMISSION_SETS,
  SEED_TENANTS,
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
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0114, script runs: the `script_run` table and the nine run
 * operations of `docs/api/scripting.openapi.yaml` (Agent 6; P10, manual mode).
 *
 * Written before the build (D-L23), from the contract and the decisions, not
 * from an implementation (D-L25). Sources: team/tasks/T-0114-script-runs.md;
 * D-L88 (the table is approved, the 0027 pattern; script.run for agent, team
 * lead, programme manager and admin; completion logs a `call` activity whose
 * subject is the disposition's label), D-L91 (idempotent start, interrupted,
 * one 409 for a dead disposition, exact repeat), D-L93 (own-agent-only,
 * completed only at an end or a stopped run, audit names, supersede, bounds,
 * NUL, 256 KiB, answers `sensitive`, details never logged), D-L96 (the
 * authoring this suite publishes through), D-L76 (the allow-list key guard),
 * D-L102 (send only what changed; stale is 409), D-P31 and D-P32 (open; a run
 * writes no contact field). The contract is fixed and pinned by
 * tests/acceptance/platform/scripting-contract.acceptance.test.ts (T-0112).
 * Where this file and the YAML disagree, the YAML is right and this file is
 * the defect: say so in the report, do not edit it.
 *
 * Every response body is validated against the YAML with the small JSON-schema
 * checker the T-0113 suite uses (restated here, never shared). Its self-check
 * runs on main by design.
 *
 * ---------------------------------------------------------------------------
 * PINNED (the builder must honour these exactly)
 * ---------------------------------------------------------------------------
 *
 * TABLE
 *  T1. One migration creates `script_run` (found by `CREATE TABLE`, comments
 *      stripped, not by number), and it is applied. No SECURITY DEFINER
 *      function is added (CLAUDE.md 2.7).
 *  T2. `id uuid` primary key, `tenant_id uuid NOT NULL`, `programme_id uuid
 *      NOT NULL`.
 *  T3. Composite FKs to `script_version` and to `contact`, each through
 *      tenant_id -> tenant_id, programme_id -> programme_id and a column ->
 *      id: a run lives in its version's and its contact's programme. Every FK
 *      to a tenant-scoped table carries tenant_id, and every FK is ON UPDATE
 *      RESTRICT (D-L76). The contact FK is never ON DELETE CASCADE or SET
 *      NULL: the D-P27 sweeper deletes a contact's runs before the contact.
 *  T4. RLS ENABLED and FORCED; every permissive policy names
 *      app.current_tenant_id() and app.current_programme_ids(); one has WITH
 *      CHECK identical to USING; `script_run` is in TENANT_SCOPED_TABLES;
 *      owned by kasuwa_migrator; nothing kasuwa_app can enter holds TRUNCATE
 *      or BYPASSRLS.
 *  T5. A valid, UNIQUE, PARTIAL index exists, and behaves as the in-progress
 *      key: a second in-progress row for the same agent, contact and script
 *      is refused (23505), while the same row for another contact is not.
 *  T6. Under RLS, as kasuwa_app in withTenantTransaction: each session sees
 *      exactly its programmes' runs; an A1 session cannot change, delete or
 *      create runs in A2 or tenant B; a run cannot name a contact or a version
 *      of another programme, even for a supervisor who sees both; a real but
 *      unreachable contact id fails exactly as an invented one.
 *  T7. KEYS (D-L76 allow-list). `id` cannot be changed by kasuwa_app or
 *      kasuwa_test_admin (refused or silently kept; the end state is what is
 *      asserted); kasuwa_migrator can (the control). A one-statement rotation
 *      of contact ids is refused while a run references one of them, and a
 *      contact with a run cannot be moved to another programme (RESTRICT).
 *      Offboarding still works: kasuwa_migrator deletes a programme, then a
 *      tenant, holding runs.
 *
 * API
 *  A1. `script.run` is held by `agent`, `team_lead`, `programme_manager` and
 *      `admin` in the contact's programme; `qa_analyst` and `client_portal`
 *      hold none of it (403 on start, an empty listContactScripts).
 *  A2. EVERY RUN OPERATION IS THE RUN'S OWN AGENT'S. Every other caller (an
 *      agent, a team lead, a programme manager and an admin of the same
 *      programme, the tenant admin, another tenant, a user who reaches
 *      nothing), and the own agent once they lack `script.run` in the RUN'S
 *      programme or leave it, gets one 404 body, byte for byte the 404 for a
 *      run that does not exist, on all seven run-id operations. Nothing is
 *      written and nothing is audited. The only run 403 is completion
 *      without `activity.write` (see NOT TESTABLE below).
 *  A3. START pins the script's latest published version (never the draft,
 *      never a body field). Idempotent: the caller's own in-progress run for
 *      the same contact and script is 200 with that run, on the version it
 *      pinned, even after a republish; nothing is created or audited.
 *      A run of the caller's stopped by `field_withheld` (field still
 *      withheld) or `sensitive_field`, on the version a new run would pin, is
 *      replayed the same way. A `field_withheld` stop whose field is now
 *      readable is SUPERSEDED: closed as `status: completed`, `outcome:
 *      superseded`, no disposition, no activity, no task, `endedAtNodeId` the
 *      branch, its `stopReason` kept, audited; and a new run is 201. A
 *      different agent, contact or script, a completed run, or a stopped run
 *      on an older version start a new run (201). Errors in the published
 *      order: 400 (body), 404 (contact), 403, 404 (script), 409
 *      script_not_published (a draft-only script).
 *  A4. ADVANCE: the server picks the next node; a branch is evaluated on the
 *      server on entry and never becomes current; a question's choice is
 *      recorded in the answers. A branch on a field withheld from the RUN'S
 *      agent stops the run (200, `stopped`, `field_withheld`, current node
 *      the branch, the step's `branchOutcome` null), whatever the value; a
 *      branch on a field classified `sensitive` since publish stops it with
 *      `sensitive_field`; a VARIABLE on either never stops the run and the
 *      run reveals no contact value. Compliance unacknowledged, required
 *      answers missing, the end, a stopped run and a completed run are each
 *      their own 409, in the published order.
 *  A5. ACKNOWLEDGE: the server's timestamp (the body carries none); the
 *      locale the client reports, or the source locale when the pinned
 *      translation has no `text` for that node; `profileLocale` from the
 *      agent's profile at that moment; a node that is not a compliance node
 *      on the path is 400; acknowledging again keeps the first time. A
 *      stopped or completed run refuses.
 *  A6. ANSWERS merge per form node (`null` clears), are validated against the
 *      field's rules naming `values.<key>` and never the value, refuse NUL,
 *      and are capped at 262144 UTF-8 BYTES per run (400 `too_big`, nothing
 *      written). D-L102: a save sends only the keys it changes, so a second
 *      save after a 409 never overwrites another save's keys.
 *  A7. COMPLETE: `completed` only at an `end` node or on a `stopped` run,
 *      otherwise 409 compliance_unacknowledged with {path: outcome, code:
 *      not_at_end}. `interrupted` excuses the current node and later ones,
 *      never one already passed, acknowledges nothing, and the server records
 *      `unacknowledgedComplianceNodeIds` and `endedAtNodeId` (the body cannot
 *      send them). A live disposition is required: unknown, another
 *      programme's, another tenant's, inactive and deleted are ONE 409
 *      disposition_not_live body. `note` / `followUp` requirements are 409
 *      disposition_requirements_unmet naming the path. In one transaction:
 *      the run, a `call` activity on the contact (subject = the disposition's
 *      label, body = the note, owned by the caller) and, when `followUp` is
 *      sent, a `task` due at `followUp.dueAt`, owned by the caller. An exact
 *      repeat is 200 and writes nothing, whatever revision it carries; any
 *      other write to a completed run is 409 run_completed.
 *  A8. AUDIT: start (`created`), supersede (`updated`) and completion
 *      (`updated`) only, on the run, naming in `changes[].field` only
 *      outcome, stopReason, dispositionId, activityId, followUpTaskId and
 *      versionId. No event carries a node id, a choice or field key, an
 *      answer, a note or wording. Advance, acknowledgement and answer saves
 *      write no event, so two runs that took different sides of a branch
 *      have the same events.
 *  A9. LEAKS: `Cache-Control: no-store` exactly on every response, errors
 *      included; keyset pages with no total; a cursor is resolved inside its
 *      own list (another run's programme, another list, garbage: one 400
 *      invalid_cursor body) and carries no name; run error details, answers
 *      and notes reach no log line, span or audit row.
 *  A10. The nine run operations are `x-kasuwa-implemented: true`.
 *
 * ---------------------------------------------------------------------------
 * READINGS BEYOND THE TASK FILE (suite-writer rulings; the lead may rule out)
 * ---------------------------------------------------------------------------
 *  R1. Run audit events have `object_type 'script_run'`, `object_id` the run,
 *      `programme_id` the run's programme and the caller as actor (the
 *      `object_type 'script'` precedent, D-L96). `object_label` names no
 *      contact (no display name, no phone).
 *  R2. Acknowledging a node again returns the run exactly as it was,
 *      revision included ("changes nothing").
 *  R3. The run's agent column has a composite FK to "user" on tenant, and a
 *      run can never name a version of another script than its own script
 *      column (whatever the mechanism: FK, CHECK or trigger).
 *  R4. kasuwa_app cannot re-point a run at another version or another contact
 *      (a run pins its version, D-L88; answers about one person must never
 *      move to another). Asserted as end state; the control is a
 *      trigger-free copy of the table.
 *  R5. The exact-repeat completion is decided at `run_completed`, before
 *      disposition liveness (the published order), so a repeat after the
 *      disposition was deactivated is still 200 and writes nothing.
 *  R6. Concurrency: parallel starts make ONE run (only 200 and 201, exactly
 *      one 201); parallel identical completions write ONE call activity, ONE
 *      task and ONE completion event, never a 5xx; parallel advances on one
 *      revision move the run one step.
 *  R7. A `field_withheld` stop is the same run shape whatever the withheld
 *      value is (status `customer` and null give the same path and stop).
 *  R8. A dispositions cursor naming a disposition deactivated since it was
 *      issued is the garbage cursor's 400 (resolved inside the LIVE list).
 *  R9. `profileLocale`: a "user".locale that is exactly one of the seven is
 *      recorded as is; one outside them (`de-DE`) is null. Regional variants
 *      such as the default `en-NG` are not pinned.
 *  R10. A start whose start node is a branch that stops is 201 (a new run,
 *      already stopped), audited `created` naming the stopReason.
 *  R11. A stopped run on an older version stays exactly as it was when a new
 *      run starts on the new version (D-L93 tracked: it stays until
 *      retention).
 *  R12. Completion atomicity is shown with a planted fault: a trigger the
 *      migrator plants refuses the task insert; the run stays as it was, no
 *      call activity is written, and the error body carries no database text.
 *
 * ---------------------------------------------------------------------------
 * NOT TESTABLE HERE (said so rather than faked)
 * ---------------------------------------------------------------------------
 *  - The completion 403 (script.run without activity.write) cannot be reached
 *    through data: the policy is code (packages/permissions), and every set
 *    holding script.run holds activity.write today (D-P18). This suite pins
 *    that each of the four sets completes its own run (never 403) and that
 *    everyone else gets 404. The builder's unit tests own the 403 branch.
 *  - "Answers classified sensitive" has no catalogue representation for a
 *    table outside the metadata engine; it is pinned behaviourally (never in
 *    an audit row, a log, a span or an error body).
 *  - The SCRIPT_RUN_SET_KEYS pin in apps/api/src/scripts/script-run-sets.test.ts
 *    flips when script.run lands; that is a unit test and the builder's.
 *
 * ---------------------------------------------------------------------------
 * THE BUILDER'S (not pinned)
 * ---------------------------------------------------------------------------
 * Every other column and its name (the suite finds the contact, version,
 * script and agent columns through the FK catalogue); constraint, trigger and
 * index names; how path, acknowledgements and answers are stored; whether
 * kasuwa_app may DELETE a run; the exact value of `revision` (it must change
 * on every write, and the old one must then be stale); the task's subject;
 * detail codes other than those named above; what a cleared answer looks like
 * (`null` or absent).
 *
 * VACUOUS-PASS GUARDS. Before the build every run route is an unknown route
 * (a Nest 404 whose body is not the shared Error), and `script_run` does not
 * exist, so no "one 404" or "nothing written" assertion can pass by accident:
 * each is preceded by a positive control in the same test (the run's own agent
 * reaching the same run), and every 404 is checked against the shared Error
 * schema and `code: not_found`. The self-checks that pass on main are marked.
 *
 * WRITES. The suite reseeds before and after, and after every test in the
 * blocks that change grants, flags, classifications, locales or dispositions.
 * Every test publishes its own scripts. Rows planted by kasuwa_migrator use
 * this suite's id range (`01140000-...`). Wording, notes and answers carry a
 * per-run marker, and node, choice and field keys a per-run suffix, so their
 * absence from an audit row, a log line or a span is checkable.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = resolve(REPO_ROOT, 'docs/api/scripting.openapi.yaml');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');

const SCRIPTS = '/api/v1/scripts';
const RUNS = '/api/v1/script-runs';
const runPath = (id: string) => `${RUNS}/${id}`;
const contactScriptsPath = (contactId: string) => `/api/v1/contacts/${contactId}/scripts`;

const RUN = Date.now().toString(36);
/** In every piece of wording, so its absence from an audit row is checkable. */
const MARK = `qz${RUN}mark`;
/** In every free-text answer and note: customer data that must never leak. */
const SECRET = `zx${RUN}secret`;
/** Node, choice and form-field keys carry it, so a leak of one is findable. */
const RID = `q${RUN}`;
const N = (name: string): string => `${name}_${RID}`;
const C = (name: string): string => `c${name}_${RID}`;
const K = (name: string): string => `k${name}_${RID}`;

/** Fixed ids for this suite: `0114` marks T-0114. Nothing seeds them. */
const id14 = (tail: string): string => `01140000-0000-4000-8000-${tail.padStart(12, '0')}`;
const NOWHERE = id14('00000000ffff');
const NOWHERE_RUN = id14('00000000fffe');

const D_PTP = id14('0000000d0001');
const D_CB = id14('0000000d0002');
const D_PLAIN = id14('0000000d0003');
const D_OFF = id14('0000000d0004');
const D_GONE = id14('0000000d0005');
const D_A2 = id14('0000000d0006');
const D_A2_SECOND = id14('0000000d0007');
const D_B1 = id14('0000000d0008');

const LABEL_PTP = 'T0114 Promise to pay';
const LABEL_CB = 'T0114 Call back';
const LABEL_PLAIN = 'T0114 Resolved';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const contactsIn = (programmeId: string): string[] =>
  SEED_CONTACTS.filter((contact) => contact.programmeId === programmeId).map(
    (contact) => contact.id,
  );
const [C1 = '', C2 = '', C3 = ''] = contactsIn(PROGRAMME_A1);
const [CA2 = ''] = contactsIn(PROGRAMME_A2);
const [CB1 = ''] = contactsIn(PROGRAMME_B1);

const seededContact = (id: string) => {
  const contact = SEED_CONTACTS.find((candidate) => candidate.id === id);
  if (contact === undefined) throw new Error(`Fixture drift: no seeded contact ${id}`);
  return contact;
};

function displayNameOf(userId: string): string {
  for (const tenant of SEED_TENANTS) {
    const user = tenant.users.find((candidate) => candidate.id === userId);
    if (user !== undefined) return user.displayName;
  }
  throw new Error(`Fixture drift: no seeded user ${userId}`);
}

const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const NO_PROGRAMME = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const TENANT_B_ADMIN = asUser(TENANT_B, USER_B_AGENT_1);

/** D-L88: the sets that hold script.run, and the two that do not. */
const RUN_SET_KEYS = ['agent', 'team_lead', 'programme_manager', 'admin'] as const;
const NON_RUN_SET_KEYS = ['qa_analyst', 'client_portal'] as const;

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

/** `YYYY-MM-DD`, `days` from today in UTC (a date field counts in the tenant's zone). */
function dayAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A UTC instant with a `Z` and no fraction, `hours` from now. */
function instantAhead(hours: number): string {
  const at = new Date(Date.now() + hours * 3_600_000);
  at.setUTCSeconds(0, 0);
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
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
 * The run fixture. greet (say) -> rec (compliance) -> idq (question: yes ->
 * cust, no -> idfail) ; cust (branch on contact status: customer -> payq,
 * else intro) ; intro (say) -> payq (question: ptp -> ptp, refuse ->
 * refused) ; ptp (form) -> readback (compliance) -> close (end).
 */
function runGraph(): Graph {
  return {
    startNodeId: N('greet'),
    nodes: [
      {
        id: N('greet'),
        type: 'say',
        title: 'Greeting',
        text: `Good afternoon, {contact.displayName}. My name is {agent.displayName}. ${MARK}`,
        next: N('rec'),
      },
      {
        id: N('rec'),
        type: 'compliance',
        title: 'Recording notice',
        text: `This call is recorded for quality and training. ${MARK}`,
        next: N('idq'),
      },
      {
        id: N('idq'),
        type: 'question',
        title: 'Account holder?',
        text: `Am I speaking with the account holder? ${MARK}`,
        choices: [
          { key: C('yes'), label: 'Yes, confirmed', next: N('cust') },
          { key: C('no'), label: 'Not the account holder', next: N('idfail') },
        ],
      },
      { id: N('idfail'), type: 'end', title: 'Not the account holder' },
      {
        id: N('cust'),
        type: 'branch',
        title: 'Existing customer?',
        condition: {
          source: 'contact_field',
          field: 'status',
          operator: 'one_of',
          value: ['customer'],
        },
        whenTrue: N('payq'),
        whenFalse: N('intro'),
      },
      {
        id: N('intro'),
        type: 'say',
        title: 'Introduce the offer',
        text: `Thank you. I am calling about your application. ${MARK}`,
        next: N('payq'),
      },
      {
        id: N('payq'),
        type: 'question',
        title: 'Can pay today?',
        text: `Can you make a payment today? ${MARK}`,
        choices: [
          { key: C('ptp'), label: 'Agrees to pay', next: N('ptp') },
          { key: C('refuse'), label: 'Refuses to pay', next: N('refused') },
        ],
      },
      {
        id: N('ptp'),
        type: 'form',
        title: 'Promise to pay',
        text: `Let us agree the date and amount. ${MARK}`,
        fields: [
          {
            key: K('date'),
            label: 'Promise date',
            type: 'date',
            required: true,
            minDaysAhead: 0,
            maxDaysAhead: 14,
          },
          {
            key: K('amount'),
            label: 'Amount',
            type: 'money',
            required: true,
            currency: 'NGN',
            minimumMinor: '500000',
            maximumMinor: '100000000',
          },
          {
            key: K('reason'),
            label: 'Reason for delay',
            type: 'choice',
            required: true,
            options: [
              { key: 'salary_delayed', label: 'Salary delayed' },
              { key: 'business_slow', label: 'Business slow' },
            ],
          },
          {
            key: K('count'),
            label: 'Instalments',
            type: 'number',
            required: false,
            minimum: 0,
            maximum: 10,
          },
          { key: K('memo'), label: 'Memo', type: 'text', required: false, maxLength: 2000 },
        ],
        next: N('readback'),
      },
      { id: N('refused'), type: 'end', title: 'Refused' },
      {
        id: N('readback'),
        type: 'compliance',
        title: 'Read-back',
        text: `You will pay {answer.${N('ptp')}.${K('amount')}}. We never ask for your PIN. ${MARK}`,
        next: N('close'),
      },
      {
        id: N('close'),
        type: 'end',
        title: 'Close',
        text: `Thank you for your time, {contact.displayName}. ${MARK}`,
      },
    ],
  };
}

/** Every key the run fixture uses: none may reach an audit row, log or span. */
const RUN_KEYS = [
  ...[
    'greet',
    'rec',
    'idq',
    'idfail',
    'cust',
    'intro',
    'payq',
    'ptp',
    'refused',
    'readback',
    'close',
  ].map(N),
  ...['yes', 'no', 'ptp', 'refuse'].map(C),
  ...['date', 'amount', 'reason', 'count', 'memo'].map(K),
];

/** The graph with one node replaced. */
function withNode(graph: Graph, id: string, change: (node: GraphNode) => GraphNode): Graph {
  const next = copy(graph);
  const index = next.nodes.findIndex((node) => node.id === id);
  if (index < 0) throw new Error(`fixture: no node ${id}`);
  next.nodes[index] = change(next.nodes[index] as GraphNode);
  return next;
}

/** The graph's greeting with something appended (a new version's content). */
const greetSays = (graph: Graph, extra: string): Graph =>
  withNode(graph, N('greet'), (node) => ({ ...node, text: `${String(node.text)} ${extra}` }));

/** A script that opens on the status branch (R10): stopped at start when withheld. */
function branchFirstGraph(): Graph {
  return {
    startNodeId: N('open'),
    nodes: [
      {
        id: N('open'),
        type: 'branch',
        title: 'Customer?',
        condition: { source: 'contact_field', field: 'status', operator: 'is_set' },
        whenTrue: N('endyes'),
        whenFalse: N('endno'),
      },
      { id: N('endyes'), type: 'end', title: 'Known' },
      { id: N('endno'), type: 'end', title: 'Unknown' },
    ],
  };
}

/** The pcm translation the locale tests need: `rec` has text, `readback` has none. */
const PCM_TRANSLATION: Json = {
  [N('rec')]: { text: `Make you know say we dey record this call. ${MARK}` },
  [N('readback')]: { title: 'Read-back (pcm)' },
};

/** Valid answers for the ptp form. */
function goodAnswers(): Json {
  return {
    [K('date')]: dayAhead(3),
    [K('amount')]: { amountMinor: '2500000', currency: 'NGN' },
    [K('reason')]: 'salary_delayed',
  };
}

/** The 256 KiB fixture: three forms of twenty 2000-character text fields. */
const CAP_FIELDS = 20;
const capKey = (form: number, field: number): string => `t${form}_${field}_${RID}`;
function capGraph(): Graph {
  const form = (index: number, next: string): GraphNode => ({
    id: N(`f${index}`),
    type: 'form',
    title: `Form ${index}`,
    text: `Long answers. ${MARK}`,
    fields: Array.from({ length: CAP_FIELDS }, (_, field) => ({
      key: capKey(index, field),
      label: `Field ${field}`,
      type: 'text',
      required: false,
      maxLength: 2000,
    })),
    next,
  });
  return {
    startNodeId: N('f1'),
    nodes: [
      form(1, N('f2')),
      form(2, N('f3')),
      form(3, N('fin')),
      { id: N('fin'), type: 'end', title: 'End' },
    ],
  };
}
/** `count` values of 2000 naira signs: 6000 UTF-8 bytes, 2000 UTF-16 units each. */
function capValues(form: number, count: number): Json {
  return Object.fromEntries(
    Array.from({ length: count }, (_, field) => [capKey(form, field), '₦'.repeat(2000)]),
  );
}
const ANSWERS_CAP = 262_144;

const serialisedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

// ---------------------------------------------------------------------------
// A small JSON-schema checker over the published YAML (no new dependency).
// The T-0113 checker: allOf, oneOf, propertyNames, min/maxProperties and
// additionalProperties as a schema.
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
  revision: number;
  latestVersion: VersionSummary | null;
}

interface Version {
  id: string;
  scriptId: string;
  number: number;
  graph: Graph;
}

interface RunStep {
  nodeId: string;
  enteredAt: string;
  branchOutcome?: boolean | null;
}

interface Acknowledgement {
  nodeId: string;
  locale: string;
  profileLocale: string | null;
  acknowledgedAt: string;
}

interface ScriptRun {
  id: string;
  programmeId: string;
  contactId: string;
  scriptId: string;
  versionId: string;
  versionNumber: number;
  latestVersion: VersionSummary;
  status: 'in_progress' | 'stopped' | 'completed';
  outcome: 'completed' | 'interrupted' | 'superseded' | null;
  unacknowledgedComplianceNodeIds: string[];
  endedAtNodeId: string | null;
  stopReason: 'field_withheld' | 'sensitive_field' | null;
  currentNodeId: string | null;
  path: RunStep[];
  acknowledgements: Acknowledgement[];
  answers: Record<string, Json>;
  startedBy: { id: string; displayName: string };
  startedAt: string;
  completedAt: string | null;
  dispositionId: string | null;
  activityId: string | null;
  followUpTaskId: string | null;
  revision: number;
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

/** A `status code` error with a detail of `detailCode` (any when undefined) whose path passes `path`. */
function expectDetail(
  response: request.Response,
  status: number,
  code: string,
  path: RegExp,
  detailCode?: string,
): Json {
  const body = expectError(response, status, code);
  const details = detailsOf(body);
  const matching = details.filter(
    (detail) => path.test(detail.path) && (detailCode === undefined || detail.code === detailCode),
  );
  expect(
    matching.length,
    `no detail ${detailCode ?? '(any code)'} at ${String(path)}: ${JSON.stringify(details)}`,
  ).toBeGreaterThan(0);
  return body;
}

const expect400 = (response: request.Response, path: RegExp, detailCode?: string): Json =>
  expectDetail(response, 400, 'validation_failed', path, detailCode);

function expectRun(value: unknown, where: string): ScriptRun {
  expectSchema(value, 'ScriptRun', where);
  return value as ScriptRun;
}

const exactly = (text: string): RegExp =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

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

/** Every form a phone number can take on its way into text. */
function phoneForms(e164: string): string[] {
  const digits = e164.replace(/^\+/, '');
  const national = digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
  return [...new Set([e164, encodeURIComponent(e164), digits, national])];
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

// ---------------------------------------------------------------------------
// Database probing (the T-0060 / T-0113 helpers, restated, never shared).
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
  await query('SAVEPOINT t0114_probe');
  let outcome: Outcome;
  try {
    await query(sql, values);
    await query('SET CONSTRAINTS ALL IMMEDIATE');
    outcome = { accepted: true };
  } catch (error) {
    outcome = outcomeOf(error);
  }
  if (keep && outcome.accepted) await query('RELEASE SAVEPOINT t0114_probe');
  else await query('ROLLBACK TO SAVEPOINT t0114_probe');
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
        AND a.attgenerated = ''
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

/** `CREATE TABLE script_run (`, comments stripped. */
const CREATES_SCRIPT_RUN =
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?script_run"?\s*\(/i;
const stripLineComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');

function migrationsCreatingScriptRun(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) =>
      CREATES_SCRIPT_RUN.test(stripLineComments(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))),
    )
    .sort();
}

const DEFINERS_SQL = `
  SELECT n.nspname || '.' || p.proname AS name
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`;

/** One-statement id rotation (D-L76): X takes a fresh id, Y takes X's old one. */
const rotationSql = (table: string) => `
  UPDATE ${table}
     SET id = CASE id WHEN $1::uuid THEN $3::uuid ELSE $1::uuid END
   WHERE tenant_id = $4 AND id IN ($1::uuid, $2::uuid)`;

/** The six names a run's audit event may carry in `changes[].field` (x-kasuwa-audit-names). */
const RUN_AUDIT_NAMES = [
  'outcome',
  'stopReason',
  'dispositionId',
  'activityId',
  'followUpTaskId',
  'versionId',
] as const;

// ===========================================================================

describe('acceptance: script runs (T-0114)', () => {
  let app: INestApplication;
  /** kasuwa_app, NOBYPASSRLS: every assertion about what a session may do. */
  let appPool: Pool;
  /** kasuwa_migrator: owns the schema; plants and observes; never serves. */
  let observer: Pool;
  /** kasuwa_test_admin: BYPASSRLS, DML on the new table by default. */
  let testAdmin: Pool;

  async function resetWorld(): Promise<void> {
    await reseed(inject('migrationUrl'));
    await plantDispositions();
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 })),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 3 });
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    testAdmin = createPool({ connectionString: inject('testAdminUrl'), max: 2 });
    await resetWorld();
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

  // Authoring (T-0113, served on main): how this suite gets published versions.
  const createScriptRaw = (headers: Headers, body: unknown) =>
    request(server())
      .post(SCRIPTS)
      .set(headers)
      .send(body as object);
  const getScriptRaw = (headers: Headers, id: string) =>
    request(server()).get(`${SCRIPTS}/${id}`).set(headers);
  const updateScriptRaw = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(`${SCRIPTS}/${id}`)
      .set(headers)
      .send(body as object);
  const publishRaw = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .post(`${SCRIPTS}/${id}/versions`)
      .set(headers)
      .send(body as object);
  const versionRaw = (headers: Headers, id: string, versionId: string) =>
    request(server()).get(`${SCRIPTS}/${id}/versions/${versionId}`).set(headers);
  const translateRaw = (headers: Headers, id: string, locale: string, body: unknown) =>
    request(server())
      .put(`${SCRIPTS}/${id}/translations/${locale}`)
      .set(headers)
      .send(body as object);

  // The nine run operations.
  const contactScriptsRaw = (headers: Headers, contactId: string, params: Params = []) =>
    request(server())
      .get(withQuery(contactScriptsPath(contactId), params))
      .set(headers);
  const startRaw = (headers: Headers, body: unknown) =>
    request(server())
      .post(RUNS)
      .set(headers)
      .send(body as object);
  const getRunRaw = (headers: Headers, id: string) =>
    request(server()).get(runPath(id)).set(headers);
  const runScriptRaw = (headers: Headers, id: string) =>
    request(server())
      .get(`${runPath(id)}/script`)
      .set(headers);
  const advanceRaw = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .post(`${runPath(id)}/advance`)
      .set(headers)
      .send(body as object);
  const ackRaw = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .post(`${runPath(id)}/acknowledgements`)
      .set(headers)
      .send(body as object);
  const answersRaw = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(`${runPath(id)}/answers`)
      .set(headers)
      .send(body as object);
  const dispositionsRaw = (headers: Headers, id: string, params: Params = []) =>
    request(server())
      .get(withQuery(`${runPath(id)}/dispositions`, params))
      .set(headers);
  const completeRaw = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .post(`${runPath(id)}/complete`)
      .set(headers)
      .send(body as object);

  let sequence = 0;
  const unique = (label: string) => `${label} ${RUN}-${(sequence += 1)}`;

  // --- authoring helpers ------------------------------------------------------

  async function readScript(id: string, headers: Headers = SUPERVISOR): Promise<Script> {
    const response = await getScriptRaw(headers, id);
    expectStatus(response, 200, 'getScript (the author)');
    return response.body as Script;
  }

  async function saveGraph(id: string, graph: Graph, headers: Headers = SUPERVISOR) {
    const { revision } = await readScript(id, headers);
    expectStatus(await updateScriptRaw(headers, id, { revision, graph }), 200, 'updateScript');
  }

  async function translate(id: string, locale: string, texts: Json, headers: Headers = SUPERVISOR) {
    const { revision } = await readScript(id, headers);
    expectStatus(
      await translateRaw(headers, id, locale, { revision, texts }),
      200,
      `putScriptTranslation ${locale}`,
    );
  }

  async function publish(id: string, headers: Headers = SUPERVISOR): Promise<Version> {
    const { revision } = await readScript(id, headers);
    const response = await publishRaw(headers, id, { revision });
    expectStatus(response, 201, 'publishScript');
    return response.body as Version;
  }

  interface Published {
    scriptId: string;
    versionId: string;
    name: string;
  }

  interface ScriptOptions {
    headers?: Headers;
    programmeId?: string;
    graph?: Graph;
    sourceLocale?: string;
    translations?: Record<string, Json>;
    name?: string;
    publish?: boolean;
  }

  /** A script, created and (unless told otherwise) published, by an author. */
  async function makeScript(options: ScriptOptions = {}): Promise<Published> {
    const headers = options.headers ?? SUPERVISOR;
    const name = options.name ?? unique('T0114 script');
    const created = await createScriptRaw(headers, {
      programmeId: options.programmeId ?? PROGRAMME_A1,
      name,
      sourceLocale: options.sourceLocale ?? 'en',
      graph: options.graph ?? runGraph(),
    });
    expectStatus(created, 201, 'createScript (fixture)');
    const scriptId = (created.body as Script).id;
    for (const [locale, texts] of Object.entries(options.translations ?? {})) {
      await translate(scriptId, locale, texts, headers);
    }
    if (options.publish === false) return { scriptId, versionId: '', name };
    const version = await publish(scriptId, headers);
    return { scriptId, versionId: version.id, name };
  }

  /** Publishes a new version whose greeting differs (`unchanged` refuses a copy). */
  async function republish(script: Published, extra: string, headers: Headers = SUPERVISOR) {
    const version = await versionRaw(headers, script.scriptId, script.versionId);
    expectStatus(version, 200, 'getScriptVersion (fixture)');
    await saveGraph(script.scriptId, greetSays((version.body as Version).graph, extra), headers);
    return publish(script.scriptId, headers);
  }

  // --- run helpers ------------------------------------------------------------

  async function start(
    headers: Headers,
    script: Published | string,
    contactId: string,
    status = 201,
  ): Promise<ScriptRun> {
    const scriptId = typeof script === 'string' ? script : script.scriptId;
    const response = await startRaw(headers, { scriptId, contactId });
    expectStatus(response, status, `startScriptRun (expected ${status})`);
    expectNoStore(response, `startScriptRun ${status}`);
    return expectRun(response.body, 'startScriptRun');
  }

  async function readRun(headers: Headers, id: string): Promise<ScriptRun> {
    const response = await getRunRaw(headers, id);
    expectStatus(response, 200, 'getScriptRun (the run’s own agent)');
    expectNoStore(response, 'getScriptRun 200');
    return expectRun(response.body, 'getScriptRun');
  }

  async function advance(headers: Headers, run: ScriptRun, extra: Json = {}): Promise<ScriptRun> {
    const response = await advanceRaw(headers, run.id, { revision: run.revision, ...extra });
    expectStatus(response, 200, `advanceScriptRun from ${String(run.currentNodeId)}`);
    expectNoStore(response, 'advanceScriptRun 200');
    return expectRun(response.body, 'advanceScriptRun');
  }

  async function ack(
    headers: Headers,
    run: ScriptRun,
    nodeId: string,
    locale = 'en',
  ): Promise<ScriptRun> {
    const response = await ackRaw(headers, run.id, { revision: run.revision, nodeId, locale });
    expectStatus(response, 200, `acknowledgeScriptRunNode ${nodeId}`);
    expectNoStore(response, 'acknowledgeScriptRunNode 200');
    return expectRun(response.body, 'acknowledgeScriptRunNode');
  }

  async function answer(
    headers: Headers,
    run: ScriptRun,
    nodeId: string,
    values: Json,
  ): Promise<ScriptRun> {
    const response = await answersRaw(headers, run.id, { revision: run.revision, nodeId, values });
    expectStatus(response, 200, `recordScriptRunAnswers ${nodeId}`);
    expectNoStore(response, 'recordScriptRunAnswers 200');
    return expectRun(response.body, 'recordScriptRunAnswers');
  }

  async function complete(headers: Headers, run: ScriptRun, body: Json): Promise<ScriptRun> {
    const response = await completeRaw(headers, run.id, { revision: run.revision, ...body });
    expectStatus(response, 200, 'completeScriptRun');
    expectNoStore(response, 'completeScriptRun 200');
    return expectRun(response.body, 'completeScriptRun');
  }

  const at = (run: ScriptRun, nodeId: string, where: string) =>
    expect(run.currentNodeId, `${where}: the run is not at ${nodeId}`).toBe(nodeId);

  /** greet -> rec (acknowledged) -> idq (yes) -> [cust] -> intro? -> payq. */
  async function toPayq(headers: Headers, run: ScriptRun): Promise<ScriptRun> {
    at(run, N('greet'), 'toPayq');
    let r = await advance(headers, run);
    at(r, N('rec'), 'after greet');
    r = await ack(headers, r, N('rec'));
    r = await advance(headers, r);
    at(r, N('idq'), 'after rec');
    r = await advance(headers, r, { choiceKey: C('yes') });
    if (r.currentNodeId === N('intro')) r = await advance(headers, r);
    at(r, N('payq'), 'after the branch');
    return r;
  }

  /** ... payq (ptp) -> ptp (answered) -> readback. */
  async function toReadback(headers: Headers, run: ScriptRun): Promise<ScriptRun> {
    let r = await toPayq(headers, run);
    r = await advance(headers, r, { choiceKey: C('ptp') });
    at(r, N('ptp'), 'after payq');
    r = await answer(headers, r, N('ptp'), goodAnswers());
    r = await advance(headers, r);
    at(r, N('readback'), 'after the form');
    return r;
  }

  /** ... readback (acknowledged) -> close (the end). */
  async function toClose(headers: Headers, run: ScriptRun): Promise<ScriptRun> {
    let r = await toReadback(headers, run);
    r = await ack(headers, r, N('readback'));
    r = await advance(headers, r);
    at(r, N('close'), 'after readback');
    return r;
  }

  // --- the observer -----------------------------------------------------------

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

  const fieldsOf = (row: AuditRow | undefined): string[] =>
    (row?.changes ?? []).map((change) => change.field).sort();

  async function assign(tenantId: string, userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id)
       DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, tenantId, permissionSet(tenantId, key)],
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

  async function setUserLocale(userId: string, locale: string) {
    await observer.query('UPDATE "user" SET locale = $1 WHERE id = $2', [locale, userId]);
  }

  async function setContactStatus(contactId: string, status: string | null) {
    await observer.query('UPDATE contact SET status = $1 WHERE id = $2', [status, contactId]);
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
         (id, tenant_id, programme_id, code, label, category, note_required,
          follow_up_required, active, position, deleted_at)
       VALUES ($1, $9, $11, 'T0114_PTP', $14, 'promise_to_pay', true, false, true, 1, NULL),
              ($2, $9, $11, 'T0114_CB', $15, 'callback', false, true, true, 2, NULL),
              ($3, $9, $11, 'T0114_PLAIN', $16, 'resolved', false, false, true, 3, NULL),
              ($4, $9, $11, 'T0114_OFF', 'T0114 Paused', 'resolved', false, false, false, 4, NULL),
              ($5, $9, $11, 'T0114_GONE', 'T0114 Removed', 'resolved', false, false, true, NULL, now()),
              ($6, $9, $12, 'T0114_A2', $16, 'resolved', false, false, true, 1, NULL),
              ($7, $9, $12, 'T0114_A2B', 'T0114 Second', 'resolved', false, false, true, 2, NULL),
              ($8, $10, $13, 'T0114_B1', $16, 'resolved', false, false, true, 1, NULL)`,
      [
        D_PTP,
        D_CB,
        D_PLAIN,
        D_OFF,
        D_GONE,
        D_A2,
        D_A2_SECOND,
        D_B1,
        TENANT_A,
        TENANT_B,
        PROGRAMME_A1,
        PROGRAMME_A2,
        PROGRAMME_B1,
        LABEL_PTP,
        LABEL_CB,
        LABEL_PLAIN,
      ],
    );
  }

  async function requireTable(): Promise<void> {
    const found = await observer.query<{ exists: boolean }>(
      `SELECT to_regclass('public.script_run') IS NOT NULL AS exists`,
    );
    expect(found.rows[0]?.exists, 'the script_run table does not exist').toBe(true);
  }

  /** The run's row as the migrator sees it (column-agnostic). */
  async function runRow(id: string): Promise<string> {
    const result = await observer.query<{ row: unknown }>(
      'SELECT to_jsonb(r) AS row FROM script_run r WHERE r.id = $1',
      [id],
    );
    return JSON.stringify(result.rows[0]?.row ?? null);
  }

  async function runCount(tenantId: string = TENANT_A): Promise<number> {
    const result = await observer.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM script_run WHERE tenant_id = $1',
      [tenantId],
    );
    return result.rows[0]?.n ?? -1;
  }

  interface ActivityRow {
    id: string;
    programme_id: string;
    type: string;
    subject: string | null;
    body: string | null;
    due_at: Date | null;
    completed_at: Date | null;
    owner_user_id: string | null;
    created_by_user_id: string | null;
    contact_id: string | null;
    account_id: string | null;
  }

  async function activitiesOf(contactId: string): Promise<ActivityRow[]> {
    const result = await observer.query<ActivityRow>(
      `SELECT id, programme_id, type, subject, body, due_at, completed_at, owner_user_id,
              created_by_user_id, contact_id, account_id
         FROM activity WHERE contact_id = $1 ORDER BY created_at, id`,
      [contactId],
    );
    return result.rows;
  }

  /**
   * The local column of a script_run foreign key that maps to `foreign` on
   * `refTable`, found in the catalogue (the column names are the builder's).
   */
  async function runColumn(refTable: string, foreign: string): Promise<string | undefined> {
    const result = await observer.query<{ local: string }>(
      `SELECT la.attname AS local
         FROM pg_constraint con
         JOIN pg_class ref ON ref.oid = con.confrelid
         CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(local_att, foreign_att)
         JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.local_att
         JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.foreign_att
        WHERE con.contype = 'f' AND con.conrelid = to_regclass('public.script_run')
          AND ref.relname = $1 AND fa.attname = $2
          AND la.attname NOT IN ('tenant_id', 'programme_id')
        ORDER BY 1 LIMIT 1`,
      [refTable, foreign],
    );
    return result.rows[0]?.local;
  }

  interface RunColumns {
    contact: string;
    version: string;
    script: string;
    agent: string;
  }

  async function runColumns(): Promise<RunColumns> {
    const contact = await runColumn('contact', 'id');
    const version = await runColumn('script_version', 'id');
    const script =
      (await runColumn('script_version', 'script_id')) ?? (await runColumn('script', 'id'));
    const agent = await runColumn('user', 'id');
    const found = { contact, version, script, agent };
    expect(
      found,
      'script_run must name its contact, version, script and agent through foreign keys',
    ).toEqual({
      contact: expect.any(String),
      version: expect.any(String),
      script: expect.any(String),
      agent: expect.any(String),
    });
    return found as RunColumns;
  }

  // =========================================================================
  // 1. The contract file.
  // =========================================================================

  describe('the contract file', () => {
    it('(self-check) the checker accepts the contract’s five ScriptRun examples and rejects broken copies', () => {
      // Passes on main by design: it tests this file's checker, not the API.
      const examples = (loadDoc(SPEC_PATH) as { components: { examples: Record<string, Json> } })
        .components.examples;
      const names = [
        'ScriptRunInProgress',
        'ScriptRunStopped',
        'ScriptRunCompleted',
        'ScriptRunInterrupted',
        'ScriptRunSuperseded',
      ];
      for (const name of names) {
        expect(schemaErrors(examples[name]?.value, '#/components/schemas/ScriptRun'), name).toEqual(
          [],
        );
      }
      const run = copy(examples.ScriptRunInProgress?.value) as Json;
      const mutants: [string, Json][] = [
        ['a status that does not exist', { ...run, status: 'paused' }],
        ['an outcome that does not exist', { ...run, outcome: 'abandoned' }],
        ['a stop reason that does not exist', { ...run, stopReason: 'timeout' }],
        ['revision 0', { ...run, revision: 0 }],
        ['a tenantId', { ...run, tenantId: TENANT_A }],
        [
          'no endedAtNodeId',
          Object.fromEntries(Object.entries(run).filter(([k]) => k !== 'endedAtNodeId')),
        ],
        [
          'an acknowledgement without profileLocale',
          {
            ...run,
            acknowledgements: [
              { nodeId: 'rec', locale: 'pcm', acknowledgedAt: '2026-10-07T13:20:38Z' },
            ],
          },
        ],
        [
          'an answer of an unknown kind',
          { ...run, answers: { idq: { type: 'free', value: 'x' } } },
        ],
      ];
      for (const [label, mutant] of mutants) {
        expect(
          schemaErrors(mutant, '#/components/schemas/ScriptRun').length,
          `the checker accepted a ScriptRun with ${label}`,
        ).toBeGreaterThan(0);
      }
    });

    it('(self-check) the fixtures are valid graphs, and the 256 KiB fixture sits where the cap test needs it', () => {
      // Passes on main by design. Without it, a 400 below could be about a
      // fixture this file got wrong, and an "accepted" could be undersized.
      for (const graph of [runGraph(), branchFirstGraph(), capGraph()]) {
        expect(schemaErrors(graph, '#/components/schemas/ScriptGraph')).toEqual([]);
      }
      for (const key of RUN_KEYS) expect(key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      const answers = (forms: Json[]) =>
        Object.fromEntries(
          forms.map((values, index) => [
            N(`f${index + 1}`),
            { type: 'form', values, updatedAt: '2026-10-08T10:00:00Z' },
          ]),
        );
      const two = answers([capValues(1, CAP_FIELDS), capValues(2, CAP_FIELDS)]);
      const underCap = answers([
        capValues(1, CAP_FIELDS),
        capValues(2, CAP_FIELDS),
        capValues(3, 1),
      ]);
      const overCap = answers([
        capValues(1, CAP_FIELDS),
        capValues(2, CAP_FIELDS),
        capValues(3, 5),
      ]);
      expect(serialisedBytes(two)).toBeGreaterThan(200_000);
      expect(serialisedBytes(underCap)).toBeLessThan(ANSWERS_CAP - 8_000);
      expect(serialisedBytes(overCap)).toBeGreaterThan(ANSWERS_CAP + 4_000);
      // Over the cap in UTF-8 bytes, far under it in UTF-16 code units: a cap
      // that counts characters accepts it.
      expect(JSON.stringify(overCap).length).toBeLessThan(ANSWERS_CAP / 2);
      // Each save is one form: under any sane body limit the API sets.
      expect(
        serialisedBytes({ revision: 1, nodeId: N('f1'), values: capValues(1, CAP_FIELDS) }),
      ).toBeLessThan(130_000);
    });

    it('the nine run operations are x-kasuwa-implemented: true once served', () => {
      const spec = loadDoc(SPEC_PATH) as { paths: Record<string, Record<string, Json>> };
      const flag = (path: string, method: string) =>
        spec.paths[path]?.[method]?.['x-kasuwa-implemented'];
      expect({
        listContactScripts: flag('/api/v1/contacts/{contactId}/scripts', 'get'),
        startScriptRun: flag(RUNS, 'post'),
        getScriptRun: flag(`${RUNS}/{runId}`, 'get'),
        getScriptRunScript: flag(`${RUNS}/{runId}/script`, 'get'),
        advanceScriptRun: flag(`${RUNS}/{runId}/advance`, 'post'),
        acknowledgeScriptRunNode: flag(`${RUNS}/{runId}/acknowledgements`, 'post'),
        recordScriptRunAnswers: flag(`${RUNS}/{runId}/answers`, 'patch'),
        listScriptRunDispositions: flag(`${RUNS}/{runId}/dispositions`, 'get'),
        completeScriptRun: flag(`${RUNS}/{runId}/complete`, 'post'),
      }).toEqual({
        listContactScripts: true,
        startScriptRun: true,
        getScriptRun: true,
        getScriptRunScript: true,
        advanceScriptRun: true,
        acknowledgeScriptRunNode: true,
        recordScriptRunAnswers: true,
        listScriptRunDispositions: true,
        completeScriptRun: true,
      });
    });
  });

  // =========================================================================
  // 2. The table: catalogue.
  // =========================================================================

  describe('the table: migration, columns, keys and tenancy', () => {
    it('one migration creates script_run, and the runner applied it', async () => {
      const files = migrationsCreatingScriptRun();
      expect(files, 'migrations creating `script_run`').toHaveLength(1);
      const ids = files.map((name) => name.replace(/\.sql$/, ''));
      const applied = await observer.query<{ id: string }>(
        'SELECT id FROM _kasuwa_migration WHERE id = ANY ($1::text[])',
        [ids],
      );
      expect(applied.rows.map((row) => row.id)).toEqual(ids);
    });

    it('(self-check) the migration scan finds script_run and nothing near it, and ignores comments', () => {
      // Passes on main by design: guards the scan against a vacuous miss.
      expect(CREATES_SCRIPT_RUN.test('CREATE TABLE script_run (\n id uuid')).toBe(true);
      expect(CREATES_SCRIPT_RUN.test('create table if not exists public.script_run(')).toBe(true);
      expect(CREATES_SCRIPT_RUN.test('CREATE TABLE script_run_step (')).toBe(false);
      expect(CREATES_SCRIPT_RUN.test('CREATE TABLE script (')).toBe(false);
      expect(
        CREATES_SCRIPT_RUN.test(stripLineComments('-- CREATE TABLE script_run (\nSELECT 1;')),
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

    it('has the pinned key columns, and id is the primary key', async () => {
      const rows = await observer.query<{ column: string; type: string; notnull: boolean }>(
        `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS notnull
           FROM pg_attribute a
          WHERE a.attrelid = to_regclass('public.script_run') AND a.attnum > 0 AND NOT a.attisdropped`,
      );
      const found = Object.fromEntries(
        rows.rows.map((row) => [row.column, `${row.type} ${row.notnull}`]),
      );
      expect(Object.keys(found).length, 'table script_run not found').toBeGreaterThan(0);
      expect(found).toMatchObject({
        id: 'uuid true',
        tenant_id: 'uuid true',
        programme_id: 'uuid true',
      });
      const pk = await observer.query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY a.attname) AS columns
           FROM pg_constraint con
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
          WHERE con.contype = 'p' AND con.conrelid = to_regclass('public.script_run')
          GROUP BY con.oid`,
      );
      expect(pk.rows.map((row) => row.columns)).toEqual([['id']]);
    });

    async function foreignKeys() {
      const result = await observer.query<{
        ref_table: string;
        pairs: string[];
        on_update: string;
        on_delete: string;
      }>(
        `SELECT ref.relname AS ref_table, con.confupdtype::text AS on_update,
                con.confdeltype::text AS on_delete,
                array_agg(la.attname || '->' || fa.attname ORDER BY la.attname) AS pairs
           FROM pg_constraint con
           JOIN pg_class ref ON ref.oid = con.confrelid
           CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(local_att, foreign_att)
           JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.local_att
           JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.foreign_att
          WHERE con.contype = 'f' AND con.conrelid = to_regclass('public.script_run')
          GROUP BY con.oid, ref.relname, con.confupdtype, con.confdeltype`,
      );
      return result.rows.map((row) => ({
        refTable: row.ref_table,
        pairs: [...row.pairs].sort(),
        onUpdate: row.on_update,
        onDelete: row.on_delete,
      }));
    }

    it.each(['script_version', 'contact'])(
      'has a composite foreign key to %s through tenant_id, programme_id and its id',
      async (target) => {
        const fks = (await foreignKeys()).filter((fk) => fk.refTable === target);
        const composite = fks.filter(
          (fk) =>
            fk.pairs.includes('tenant_id->tenant_id') &&
            fk.pairs.includes('programme_id->programme_id') &&
            fk.pairs.some((pair) => pair.endsWith('->id')),
        );
        expect(
          composite.length,
          `script_run FKs to ${target}: ${JSON.stringify(fks)}`,
        ).toBeGreaterThan(0);
      },
    );

    it('every foreign key carries tenant_id and is ON UPDATE RESTRICT; the contact FK never cascades a delete (D-L76, D-P27)', async () => {
      const fks = await foreignKeys();
      expect(fks.length, 'script_run has no foreign keys').toBeGreaterThan(0);
      const unscoped = fks.filter(
        (fk) => fk.refTable !== 'tenant' && !fk.pairs.includes('tenant_id->tenant_id'),
      );
      expect(unscoped, 'a FK that would accept another tenant’s row').toEqual([]);
      // confupdtype: r = RESTRICT. NO ACTION ('a') accepts a one-statement
      // key rotation; CASCADE ('c') would carry a run across programmes.
      expect(
        fks.filter((fk) => fk.onUpdate !== 'r'),
        'FKs that are not ON UPDATE RESTRICT',
      ).toEqual([]);
      // confdeltype: c = CASCADE, n = SET NULL, d = SET DEFAULT. A run is
      // erased deliberately with its contact (the sweeper), never silently.
      const contact = fks.filter((fk) => fk.refTable === 'contact');
      expect(contact.length).toBeGreaterThan(0);
      expect(
        contact.filter((fk) => !['r', 'a'].includes(fk.onDelete)),
        'a contact FK that deletes or orphans runs',
      ).toEqual([]);
    });

    it('(R3) the run’s agent has a composite foreign key to "user" on tenant', async () => {
      const fks = (await foreignKeys()).filter((fk) => fk.refTable === 'user');
      expect(
        fks.filter(
          (fk) =>
            fk.pairs.includes('tenant_id->tenant_id') && fk.pairs.some((p) => p.endsWith('->id')),
        ).length,
        `script_run FKs to "user": ${JSON.stringify(fks)}`,
      ).toBeGreaterThan(0);
    });

    it('RLS ENABLED and FORCED; tenant AND programme on every permissive policy; WITH CHECK = USING', async () => {
      const security = (await readTableSecurity(appPool)).find((row) => row.table === 'script_run');
      expect(security?.rlsEnabled, 'script_run: RLS is not enabled').toBe(true);
      expect(security?.rlsForced, 'script_run: RLS is not FORCED').toBe(true);
      const policies = await observer.query<{
        name: string;
        permissive: boolean;
        using: string | null;
        check: string | null;
      }>(
        `SELECT p.polname AS name, p.polpermissive AS permissive,
                pg_get_expr(p.polqual, p.polrelid) AS using,
                pg_get_expr(p.polwithcheck, p.polrelid) AS check
           FROM pg_policy p WHERE p.polrelid = to_regclass('public.script_run')`,
      );
      expect(policies.rows.length, 'script_run has no policy').toBeGreaterThan(0);
      for (const policy of policies.rows.filter((row) => row.permissive)) {
        for (const expression of [policy.using, policy.check]) {
          if (expression === null) continue;
          expect(expression, policy.name).toContain('current_tenant_id()');
          expect(expression, policy.name).toContain('current_programme_ids()');
        }
      }
      expect(
        policies.rows.some((row) => row.check !== null && row.check === row.using),
        'no policy with WITH CHECK identical to USING',
      ).toBe(true);
    });

    it('is in TENANT_SCOPED_TABLES', () => {
      expect([...TENANT_SCOPED_TABLES]).toContain('script_run');
    });

    it('kasuwa_migrator owns it, and nothing kasuwa_app can enter may TRUNCATE it or bypass RLS', async () => {
      const owner = await observer.query<{ owner: string | null }>(
        `SELECT (SELECT pg_get_userbyid(relowner) FROM pg_class
                  WHERE oid = to_regclass('public.script_run')) AS owner`,
      );
      expect(owner.rows[0]?.owner, 'script_run not found, or not the migrator’s').toBe(
        'kasuwa_migrator',
      );
      const held = await observer.query<{ held: string }>(
        `SELECT r.rolname || ':' || x.what AS held
           FROM pg_roles r
          CROSS JOIN LATERAL (
            SELECT 'TRUNCATE' AS what WHERE has_table_privilege(r.oid, 'public.script_run', 'TRUNCATE')
            UNION ALL SELECT 'BYPASSRLS' WHERE r.rolbypassrls
          ) AS x
          WHERE pg_has_role('kasuwa_app', r.oid, 'MEMBER')
          ORDER BY 1`,
      );
      expect(held.rows.map((row) => row.held)).toEqual([]);
    });

    it('has a valid, unique, partial index: the in-progress key', async () => {
      const indexes = await observer.query<{
        unique: boolean;
        valid: boolean;
        partial: boolean;
        def: string;
      }>(
        `SELECT x.indisunique AS unique, x.indisvalid AS valid, x.indpred IS NOT NULL AS partial,
                pg_get_indexdef(x.indexrelid) AS def
           FROM pg_index x WHERE x.indrelid = to_regclass('public.script_run')`,
      );
      expect(
        indexes.rows.filter((index) => index.unique && index.valid && index.partial).length,
        `script_run indexes: ${JSON.stringify(indexes.rows.map((row) => row.def))}`,
      ).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. The table under RLS, its keys and offboarding. Rows come from the API
  //    (the column set is the builder's), then are probed in SQL.
  // =========================================================================

  interface SharedRuns {
    a1Script: Published;
    a1Other: Published;
    a1: ScriptRun;
    a2: ScriptRun;
    b1: ScriptRun;
  }
  let sharedRuns: Promise<SharedRuns> | undefined;
  /** Built once, by the API, and never written to by the tests that read them. */
  const shared = (): Promise<SharedRuns> =>
    (sharedRuns ??= (async () => {
      const a1Script = await makeScript();
      const a1Other = await makeScript({ graph: greetSays(runGraph(), 'Another script.') });
      const a2Script = await makeScript({ programmeId: PROGRAMME_A2 });
      const b1Script = await makeScript({ headers: TENANT_B_ADMIN, programmeId: PROGRAMME_B1 });
      return {
        a1Script,
        a1Other,
        a1: await start(AGENT_1, a1Script, C1),
        a2: await start(AGENT_2, a2Script, CA2),
        b1: await start(TENANT_B_ADMIN, b1Script, CB1),
      };
    })());

  describe('the table under RLS', () => {
    it('each session sees exactly its own programmes’ runs', async () => {
      await requireTable();
      const rows = await shared();
      const ids = [rows.a1.id, rows.a2.id, rows.b1.id];
      const all = await observer.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM script_run WHERE id = ANY ($1::uuid[])',
        [ids],
      );
      expect(all.rows[0]?.n, 'the three runs exist, committed').toBe(3);

      const visible = (tenantId: string, userId: string) =>
        withTenantTransaction(appPool, { tenantId, userId }, async (tx) =>
          (
            await tx.query<{ id: string }>(
              'SELECT id FROM script_run WHERE id = ANY ($1::uuid[]) ORDER BY id',
              [ids],
            )
          ).map((row) => row.id),
        );
      expect(await visible(TENANT_A, USER_A_AGENT_1)).toEqual([rows.a1.id]);
      expect(await visible(TENANT_A, USER_A_AGENT_2)).toEqual([rows.a2.id]);
      expect(await visible(TENANT_A, USER_A_SUPERVISOR)).toEqual([rows.a1.id, rows.a2.id].sort());
      expect(await visible(TENANT_A, USER_A_NO_PROGRAMME)).toEqual([]);
      expect(await visible(TENANT_B, USER_B_AGENT_1)).toEqual([rows.b1.id]);
    });

    it('an A1 session can neither change, delete nor create runs in A2 or tenant B', async () => {
      await requireTable();
      const rows = await shared();
      const foreign = [rows.a2.id, rows.b1.id];
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => {
          const writable = await query<{ quoted: string }>(
            `SELECT quote_ident(a.attname) AS quoted FROM pg_attribute a
            WHERE a.attrelid = 'public.script_run'::regclass AND a.attnum > 0 AND NOT a.attisdropped
              AND a.attname NOT IN ('id', 'tenant_id', 'programme_id')
              AND has_column_privilege(current_user, a.attrelid, a.attnum, 'UPDATE')
            ORDER BY a.attnum LIMIT 1`,
          );
          const column = writable[0]?.quoted;
          return {
            updated:
              column === undefined
                ? []
                : (
                    await query<{ id: string }>(
                      `UPDATE script_run SET ${column} = ${column} WHERE id = ANY ($1::uuid[]) RETURNING id`,
                      [foreign],
                    )
                  ).map((row) => row.id),
            // A1's own run copied into A2 and into tenant B: the WITH CHECK.
            insertA2: verdict(
              await probe(query, await cloneSql(query, 'script_run'), [
                rows.a1.id,
                JSON.stringify({ id: randomUUID(), programme_id: PROGRAMME_A2 }),
              ]),
            ),
            insertB1: verdict(
              await probe(query, await cloneSql(query, 'script_run'), [
                rows.a1.id,
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
      expect(outcomes.updated, 'an A1 session updated another programme’s run').toEqual([]);
      expect(REFUSALS).toContain(outcomes.insertA2);
      expect(REFUSALS).toContain(outcomes.insertB1);
      // Deletes are COMMITTED (an error just rolls its own transaction back),
      // so the observer below sees what really happened.
      await withTenantTransaction(appPool, { tenantId: TENANT_A, userId: USER_A_AGENT_1 }, (tx) =>
        tx.query('DELETE FROM script_run WHERE id = ANY ($1::uuid[])', [foreign]),
      ).catch(() => undefined);
      const left = await observer.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM script_run WHERE id = ANY ($1::uuid[])',
        [foreign],
      );
      expect(left.rows[0]?.n).toBe(2);
    });

    it('a run cannot name a contact or a version of another programme, even for a supervisor who sees both', async () => {
      await requireTable();
      const rows = await shared();
      const columns = await runColumns();
      const a2Version = await observer.query<{ id: string; script_id: string }>(
        'SELECT id, script_id FROM script_version WHERE tenant_id = $1 AND programme_id = $2 LIMIT 1',
        [TENANT_A, PROGRAMME_A2],
      );
      const other = a2Version.rows[0];
      expect(other, 'an A2 version exists').toBeDefined();
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_SUPERVISOR,
        async (query) => {
          const clone = (overrides: Json) =>
            cloneSql(query, 'script_run').then((sql) =>
              probe(query, sql, [rows.a1.id, JSON.stringify({ id: randomUUID(), ...overrides })]),
            );
          return {
            // The control: the same copy, kept in its programme on another
            // contact, is accepted, so the refusals are about the keys.
            control: verdict(await clone({ [columns.contact]: C2 })),
            runInA2: verdict(await clone({ [columns.contact]: C3, programme_id: PROGRAMME_A2 })),
            contactInA2: verdict(await clone({ [columns.contact]: CA2 })),
            versionInA2: verdict(
              await clone({
                [columns.contact]: C3,
                [columns.version]: other?.id,
                [columns.script]: other?.script_id,
              }),
            ),
          };
        },
      );
      expect(outcomes).toEqual({
        control: 'accepted',
        runInA2: 'foreign_key_violation',
        contactInA2: 'foreign_key_violation',
        versionInA2: 'foreign_key_violation',
      });
    });

    it('a real A2 contact id fails exactly as an invented one (no existence oracle across the BPO boundary)', async () => {
      await requireTable();
      const rows = await shared();
      const columns = await runColumns();
      const invented = randomUUID();
      const fixedId = id14('00000000a001');
      const [real, fake] = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => {
          const sql = await cloneSql(query, 'script_run');
          const attempt = (contactId: string) =>
            probe(query, sql, [
              rows.a1.id,
              JSON.stringify({ id: fixedId, [columns.contact]: contactId }),
            ]);
          return [await attempt(CA2), await attempt(invented)] as const;
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
      expect(normalise(real, CA2)).toEqual(normalise(fake, invented));
    });

    it('the in-progress key: a second in-progress run for the same agent, contact and script is refused, another contact is not', async () => {
      await requireTable();
      const rows = await shared();
      const columns = await runColumns();
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => {
          const sql = await cloneSql(query, 'script_run');
          return {
            sameKey: verdict(
              await probe(query, sql, [rows.a1.id, JSON.stringify({ id: randomUUID() })]),
            ),
            otherContact: verdict(
              await probe(query, sql, [
                rows.a1.id,
                JSON.stringify({ id: randomUUID(), [columns.contact]: C3 }),
              ]),
            ),
          };
        },
      );
      expect(outcomes).toEqual({ sameKey: 'unique_violation', otherContact: 'accepted' });
    });

    it('(R3) a run can never name a version of another script than its own', async () => {
      await requireTable();
      const rows = await shared();
      const columns = await runColumns();
      const outcomes = await rolledBackTenantTx(
        appPool,
        TENANT_A,
        USER_A_AGENT_1,
        async (query) => {
          const sql = await cloneSql(query, 'script_run');
          const clone = (overrides: Json) =>
            probe(query, sql, [
              rows.a1.id,
              JSON.stringify({ id: randomUUID(), [columns.contact]: C2, ...overrides }),
            ]);
          return {
            // The control: script and version both the other script's.
            control: verdict(
              await clone({
                [columns.script]: rows.a1Other.scriptId,
                [columns.version]: rows.a1Other.versionId,
              }),
            ),
            mismatch: verdict(await clone({ [columns.version]: rows.a1Other.versionId })),
          };
        },
      );
      expect(outcomes.control).toBe('accepted');
      expect(REFUSALS, `a run naming another script’s version was ${outcomes.mismatch}`).toContain(
        outcomes.mismatch,
      );
    });
  });

  describe('keys: the allow-list guard, rotation, moves and offboarding', () => {
    it('id is fixed for kasuwa_app and kasuwa_test_admin (D-L76); (R4) kasuwa_app cannot re-point the version or the contact', async () => {
      await requireTable();
      const script = await makeScript();
      const run = await start(AGENT_1, script, C1);
      const v2 = await republish(script, 'Version two.');
      const columns = await runColumns();
      const before = await runRow(run.id);
      expect(JSON.parse(before), 'the API-created run is not in the table').not.toBeNull();

      const attempts: [string, string, unknown[]][] = [
        ['id', 'UPDATE script_run SET id = gen_random_uuid() WHERE id = $1', [run.id]],
        [
          columns.version,
          `UPDATE script_run SET ${columns.version} = $2 WHERE id = $1`,
          [run.id, v2.id],
        ],
        [
          columns.contact,
          `UPDATE script_run SET ${columns.contact} = $2 WHERE id = $1`,
          [run.id, C2],
        ],
      ];

      // The control: on a trigger-free, FK-free copy of the table every
      // statement really changes the row, so "unchanged" below means refused.
      const onCopy = await rolledBackTx(observer, async (query) => {
        await query('CREATE TABLE t0114_run_copy (LIKE script_run INCLUDING DEFAULTS)');
        await query('INSERT INTO t0114_run_copy SELECT * FROM script_run WHERE id = $1', [run.id]);
        const result: Record<string, string> = {};
        for (const [column, sql, values] of attempts) {
          const copySql = sql.replace('UPDATE script_run', 'UPDATE t0114_run_copy');
          const outcome = verdict(await probe(query, `${copySql} RETURNING 1`, values));
          result[column] = outcome;
        }
        return result;
      });
      expect(Object.values(onCopy), `the probes on a copy: ${JSON.stringify(onCopy)}`).toEqual(
        attempts.map(() => 'accepted'),
      );

      const rowOf = async (query: Query) =>
        JSON.stringify(
          (
            await query<{ row: unknown }>(
              'SELECT to_jsonb(r) AS row FROM script_run r WHERE r.id = $1',
              [run.id],
            )
          )[0]?.row ?? null,
        );
      for (const [column, sql, values] of attempts) {
        const attempt = async (query: Query) => {
          const outcome = verdict(await probe(query, sql, values, true));
          return { outcome, changed: (await rowOf(query)) !== before };
        };
        const asApp = await rolledBackTenantTx(appPool, TENANT_A, USER_A_AGENT_1, attempt);
        expect(
          ['accepted', ...REFUSALS, 'unique_violation'],
          `kasuwa_app changing ${column}`,
        ).toContain(asApp.outcome);
        expect(asApp.changed, `kasuwa_app changed script_run.${column} (${asApp.outcome})`).toBe(
          false,
        );
        if (column === 'id') {
          const asTestAdmin = await rolledBackTx(testAdmin, attempt);
          expect(
            asTestAdmin.changed,
            `kasuwa_test_admin changed script_run.id (${asTestAdmin.outcome})`,
          ).toBe(false);
          // The allow-list's one exception: kasuwa_migrator may.
          const asMigrator = await rolledBackTx(observer, attempt);
          expect(asMigrator, 'kasuwa_migrator changing script_run.id').toEqual({
            outcome: 'accepted',
            changed: true,
          });
        }
      }
    });

    it('a one-statement rotation of contact ids is refused while a run references one, and a contact with a run cannot move programme', async () => {
      await requireTable();
      const script = await makeScript();
      const run = await start(AGENT_1, script, C1);
      const columns = await runColumns();
      const result = await rolledBackTx(observer, async (query) => {
        // The control, on throwaway NO ACTION tables: the rotation statement
        // really rotates and re-points, so "refused" below is the RESTRICT.
        await query(`CREATE TABLE t0114_parent (
                       id uuid PRIMARY KEY, tenant_id uuid NOT NULL, label text NOT NULL,
                       UNIQUE (tenant_id, id))`);
        await query(`CREATE TABLE t0114_child (
                       id uuid PRIMARY KEY, tenant_id uuid NOT NULL, parent_id uuid,
                       FOREIGN KEY (tenant_id, parent_id) REFERENCES t0114_parent (tenant_id, id))`);
        const [x, y] = [id14('00000000c0a1'), id14('00000000c0a2')];
        await query(
          `INSERT INTO t0114_parent (id, tenant_id, label) VALUES ($1, $3, 'X'), ($2, $3, 'Y')`,
          [x, y, TENANT_A],
        );
        await query('INSERT INTO t0114_child (id, tenant_id, parent_id) VALUES ($1, $2, $3)', [
          randomUUID(),
          TENANT_A,
          x,
        ]);
        const controlOutcome = verdict(
          await probe(
            query,
            rotationSql('t0114_parent'),
            [x, y, id14('00000000c0af'), TENANT_A],
            true,
          ),
        );
        const childPointsAt = await query<{ label: string }>(
          `SELECT p.label FROM t0114_child c JOIN t0114_parent p
             ON p.tenant_id = c.tenant_id AND p.id = c.parent_id`,
        );
        const control = `${controlOutcome}:${String(childPointsAt[0]?.label)}`;
        const contactBefore = await query<{ row: unknown }>(
          `SELECT to_jsonb(c) - 'id' - 'version' - 'updated_at' AS row FROM contact c WHERE c.id = $1`,
          [C1],
        );
        const rotation = verdict(
          await probe(
            query,
            rotationSql('contact'),
            [C1, C2, id14('00000000c0ae'), TENANT_A],
            true,
          ),
        );
        const pointsAt = await query<{ row: unknown }>(
          `SELECT to_jsonb(c) - 'id' - 'version' - 'updated_at' AS row
             FROM script_run r JOIN contact c ON c.tenant_id = r.tenant_id AND c.id = r.${columns.contact}
            WHERE r.id = $1`,
          [run.id],
        );
        const moved = verdict(
          await probe(query, 'UPDATE contact SET programme_id = $2 WHERE id = $1', [
            C1,
            PROGRAMME_A2,
          ]),
        );
        return {
          control,
          rotation,
          repointed: JSON.stringify(pointsAt[0]?.row) !== JSON.stringify(contactBefore[0]?.row),
          moved,
        };
      });
      expect(result.control, 'the rotation on NO ACTION tables rotates and re-points').toBe(
        'accepted:Y',
      );
      expect(REFUSALS, `the rotation was ${result.rotation}`).toContain(result.rotation);
      expect(result.repointed, 'the run was re-pointed to another contact').toBe(false);
      expect(REFUSALS, `moving a contact with a run to A2 was ${result.moved}`).toContain(
        result.moved,
      );
    });

    it('offboarding still works: kasuwa_migrator deletes a programme, then a tenant, holding runs', async () => {
      await requireTable();
      const rows = await shared();
      const result = await rolledBackTx(observer, async (query) => {
        const tenantId = randomUUID();
        const bu = randomUUID();
        const [p1, p2] = [randomUUID(), randomUUID()];
        const user = randomUUID();
        await query(`INSERT INTO tenant (id, name, slug) VALUES ($1, 'T-0114 Leaving Ltd', $2)`, [
          tenantId,
          `t0114-leaving-${RUN}`,
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
          `INSERT INTO "user" (id, tenant_id, email, display_name) VALUES ($1, $2, $3, 'T-0114 Admin')`,
          [user, tenantId, `admin.${RUN}@t0114.test`],
        );
        // Every reference a cloned row makes is re-aimed: `<x>.id` at the new
        // row of table x, `<x>.script_id` at the new script, anything else null.
        const references = async (table: string, targets: Record<string, string>) => {
          const pairs = await query<{ ref: string; local: string; foreign: string }>(
            `SELECT ref.relname AS ref, la.attname AS local, fa.attname AS foreign
               FROM pg_constraint con
               JOIN pg_class ref ON ref.oid = con.confrelid
               CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(local_att, foreign_att)
               JOIN pg_attribute la ON la.attrelid = con.conrelid AND la.attnum = k.local_att
               JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.foreign_att
              WHERE con.contype = 'f' AND con.conrelid = to_regclass($1)`,
            [`public.${table}`],
          );
          const overrides: Json = {};
          for (const pair of pairs) {
            if (pair.local === 'tenant_id' || pair.local === 'programme_id') continue;
            const target = pair.foreign === 'id' ? pair.ref : pair.foreign.replace(/_id$/, '');
            overrides[pair.local] = targets[target] ?? null;
          }
          return overrides;
        };
        for (const programmeId of [p1, p2]) {
          const scriptId = randomUUID();
          const versionId = randomUUID();
          const contactId = randomUUID();
          await cloneRow(query, 'script', rows.a1Script.scriptId, {
            ...(await references('script', { user })),
            id: scriptId,
            tenant_id: tenantId,
            programme_id: programmeId,
          });
          await cloneRow(query, 'script_version', rows.a1Script.versionId, {
            ...(await references('script_version', { user, script: scriptId })),
            id: versionId,
            tenant_id: tenantId,
            programme_id: programmeId,
            script_id: scriptId,
          });
          await cloneRow(query, 'contact', C1, {
            ...(await references('contact', { user })),
            id: contactId,
            tenant_id: tenantId,
            programme_id: programmeId,
          });
          await cloneRow(query, 'script_run', rows.a1.id, {
            ...(await references('script_run', {
              user,
              script: scriptId,
              script_version: versionId,
              version: versionId,
              contact: contactId,
            })),
            id: randomUUID(),
            tenant_id: tenantId,
            programme_id: programmeId,
          });
        }
        const count = async (column: string, id: string) =>
          (
            await query<{ n: number }>(
              `SELECT count(*)::int AS n FROM script_run WHERE ${column} = $1`,
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
        before: 2,
        programme: 'accepted',
        afterProgramme: 0,
        tenant: 'accepted',
        afterTenant: 0,
      });
    });
  });

  // =========================================================================
  // 4. listContactScripts: the "Start script" menu.
  // =========================================================================

  describe('listContactScripts', () => {
    afterEach(async () => {
      await resetWorld();
    });

    interface Runnable {
      id: string;
      name: string;
      sourceLocale: string;
      translatedLocales: string[];
      latestVersion: VersionSummary;
    }

    function expectRunnablePage(response: request.Response, where: string): Page<Runnable> {
      expectStatus(response, 200, where);
      expectSchema(response.body, 'RunnableScriptPage', where);
      const page = response.body as Page<Runnable>;
      expect(
        Object.keys(page).sort(),
        `${where}: a keyset page is data and nextCursor only`,
      ).toEqual(['data', 'nextCursor']);
      expectNoStore(response, where);
      expectNoTotals(response, where);
      return page;
    }

    async function walk(headers: Headers, contactId: string) {
      const rows: Runnable[] = [];
      const cursors: { cursor: string; lastName: string }[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 200; guard += 1) {
        const page = expectRunnablePage(
          await contactScriptsRaw(headers, contactId, [
            ['limit', '1'],
            ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
          ]),
          'listContactScripts',
        );
        rows.push(...page.data);
        cursor = page.nextCursor;
        if (cursor === null) return { rows, cursors };
        cursors.push({ cursor, lastName: String(page.data[page.data.length - 1]?.name) });
      }
      throw new Error('listContactScripts never returned a null nextCursor');
    }

    it('lists the contact’s programme’s published scripts by name then id: no draft, no other programme, the latest version', async () => {
      const prefix = `T0114 Menu ${RUN}`;
      const bravo = await makeScript({ name: `${prefix} Bravo Cursorprobe` });
      const alpha = await makeScript({
        name: `${prefix} Alpha`,
        translations: { pcm: PCM_TRANSLATION },
      });
      const alphaTwin = await makeScript({ name: `${prefix} Alpha` });
      const draft = await makeScript({ name: `${prefix} Aardvark draft`, publish: false });
      const elsewhere = await makeScript({ name: `${prefix} Aaa A2`, programmeId: PROGRAMME_A2 });
      const v2 = await republish(bravo, 'Bravo two.');

      const { rows, cursors } = await walk(AGENT_1, C1);
      expect(new Set(rows.map((row) => row.id)).size, 'a row appeared on two pages').toBe(
        rows.length,
      );
      for (const row of rows) expectSchema(row, 'RunnableScript', 'listContactScripts row');
      const ids = rows.map((row) => row.id);
      expect(ids).not.toContain(draft.scriptId);
      expect(ids).not.toContain(elsewhere.scriptId);
      const twins = [alpha, alphaTwin].map((script) => script.scriptId).sort();
      expect(
        ids.filter((id) => [alpha.scriptId, alphaTwin.scriptId, bravo.scriptId].includes(id)),
        'name, then id',
      ).toEqual([...twins, bravo.scriptId]);
      expect(rows.find((row) => row.id === bravo.scriptId)?.latestVersion).toMatchObject({
        id: v2.id,
        number: 2,
      });
      expect(rows.find((row) => row.id === alpha.scriptId)).toMatchObject({
        name: `${prefix} Alpha`,
        sourceLocale: 'en',
        translatedLocales: ['pcm'],
      });
      expect(cursors.length).toBeGreaterThan(0);
      for (const { cursor, lastName } of cursors) {
        for (const form of cursorForms(cursor)) {
          expect(form, 'a cursor carries the last row’s name (D-L80)').not.toContain(lastName);
          expect(form).not.toContain('Cursorprobe');
        }
      }
    });

    it.each(NON_RUN_SET_KEYS)(
      'a caller who reads the contact with the %s set (no script.run) gets an empty page, never 403',
      async (key) => {
        await makeScript();
        // The control: with a script.run set the same caller sees it.
        await assign(TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1, 'agent');
        expect(
          expectRunnablePage(await contactScriptsRaw(NO_PROGRAMME, C1), 'agent set').data.length,
        ).toBeGreaterThan(0);
        await assign(TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1, key);
        expect(expectRunnablePage(await contactScriptsRaw(NO_PROGRAMME, C1), key)).toEqual({
          data: [],
          nextCursor: null,
        });
      },
    );

    it('a contact the caller cannot read is one 404; a bad id or limit is 400, decided after the 404', async () => {
      await makeScript();
      expectRunnablePage(await contactScriptsRaw(AGENT_1, C1), 'the control: agent 1 on C1');
      const reference = await contactScriptsRaw(AGENT_1, NOWHERE);
      expectError(reference, 404, 'not_found');
      for (const [who, headers, contactId] of [
        ['agent 1 on an A2 contact', AGENT_1, CA2],
        ['agent 1 on a tenant B contact', AGENT_1, CB1],
        ['a user with no programme', NO_PROGRAMME, C1],
        ['tenant B on an A1 contact', TENANT_B_ADMIN, C1],
      ] as const) {
        const response = await contactScriptsRaw(headers, contactId);
        expectError(response, 404, 'not_found');
        expect(response.text, who).toBe(reference.text);
      }
      expectError(await contactScriptsRaw(AGENT_1, 'not-a-uuid'), 400, 'validation_failed');
      for (const limit of ['0', '101', 'ten', '1.5']) {
        expect400(await contactScriptsRaw(AGENT_1, C1, [['limit', limit]]), /^limit$/);
      }
      expectError(await contactScriptsRaw(AGENT_1, CA2, [['limit', '0']]), 404, 'not_found');
    });
  });

  // =========================================================================
  // 5. startScriptRun.
  // =========================================================================

  describe('startScriptRun: the pinned version and idempotency', () => {
    afterEach(async () => {
      await resetWorld();
    });

    it('starts at the start node on the latest PUBLISHED version, never the draft, and keeps it through a republish', async () => {
      const script = await makeScript();
      const v2 = await republish(script, 'Version two.');
      await saveGraph(script.scriptId, greetSays(runGraph(), `Unpublished draft ${MARK}`));
      const startedFrom = Date.now();
      const run = await start(AGENT_1, script, C1);
      expect(run).toMatchObject({
        programmeId: PROGRAMME_A1,
        contactId: C1,
        scriptId: script.scriptId,
        versionId: v2.id,
        versionNumber: 2,
        status: 'in_progress',
        outcome: null,
        stopReason: null,
        currentNodeId: N('greet'),
        unacknowledgedComplianceNodeIds: [],
        endedAtNodeId: null,
        acknowledgements: [],
        answers: {},
        completedAt: null,
        dispositionId: null,
        activityId: null,
        followUpTaskId: null,
        startedBy: { id: USER_A_AGENT_1, displayName: displayNameOf(USER_A_AGENT_1) },
      });
      expect(run.id).toMatch(UUID);
      expect(run.path.map((step) => step.nodeId)).toEqual([N('greet')]);
      expect(run.latestVersion).toMatchObject({ id: v2.id, number: 2 });
      expect(Date.parse(run.startedAt)).toBeGreaterThan(startedFrom - 5_000);

      // The agent's copy is the pinned version exactly, as the author reads it.
      const authored = await versionRaw(SUPERVISOR, script.scriptId, v2.id);
      expectStatus(authored, 200, 'getScriptVersion');
      const pinned = await runScriptRaw(AGENT_1, run.id);
      expectStatus(pinned, 200, 'getScriptRunScript');
      expectNoStore(pinned, 'getScriptRunScript 200');
      expectSchema(pinned.body, 'ScriptVersion', 'getScriptRunScript');
      expect(pinned.body).toEqual(authored.body);
      expect(pinned.text).not.toContain('Unpublished draft');

      // A republish changes the banner, never the run.
      const v3 = await publish(script.scriptId);
      const read = await readRun(AGENT_1, run.id);
      expect(read).toMatchObject({ versionId: v2.id, versionNumber: 2 });
      expect(read.latestVersion).toMatchObject({ id: v3.id, number: 3 });
      expect(((await runScriptRaw(AGENT_1, run.id)).body as Version).id).toBe(v2.id);
      // And starting again returns this run, on v2.
      const again = await start(AGENT_1, script, C1, 200);
      expect(again).toEqual(read);
    });

    it('is idempotent for the caller’s own run in progress: 200, that run as it is, nothing created and nothing audited', async () => {
      const script = await makeScript();
      const run = await start(AGENT_1, script, C1);
      const moved = await advance(AGENT_1, run);
      const before = await auditIds();
      const count = await runCount();
      const again = await start(AGENT_1, script, C1, 200);
      expect(again).toEqual(await readRun(AGENT_1, run.id));
      expect(again.currentNodeId).toBe(moved.currentNodeId);
      expect(await runCount(), 'a replay created a run').toBe(count);
      expect(await auditSince(before), 'a replay wrote an audit event').toEqual([]);

      // A different contact, a different script, a different agent: new runs.
      const otherContact = await start(AGENT_1, script, C2);
      expect(otherContact.id).not.toBe(run.id);
      const otherScript = await start(AGENT_1, await makeScript(), C1);
      expect(otherScript.id).not.toBe(run.id);
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      const rowBefore = await runRow(run.id);
      const theirs = await start(AGENT_2, script, C1);
      expect(theirs.id, 'another agent was handed agent 1’s run').not.toBe(run.id);
      expect(theirs.startedBy.id).toBe(USER_A_AGENT_2);
      expect(theirs.currentNodeId).toBe(N('greet'));
      expect(await runRow(run.id), 'agent 1’s run changed').toBe(rowBefore);
    });

    it('(R6) parallel starts for one agent, contact and script make one run: only 200 and 201, exactly one 201', async () => {
      const script = await makeScript();
      const count = await runCount();
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          startRaw(AGENT_1, { scriptId: script.scriptId, contactId: C1 }),
        ),
      );
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses, responses.map((response) => response.text.slice(0, 200)).join('\n')).toEqual(
        [200, 200, 200, 201],
      );
      expect(new Set(responses.map((response) => (response.body as ScriptRun).id)).size).toBe(1);
      expect(await runCount()).toBe(count + 1);
    });

    it('a completed run does not block a new one: the next start is 201', async () => {
      const script = await makeScript();
      const run = await start(AGENT_1, script, C1);
      await complete(AGENT_1, run, { outcome: 'interrupted', dispositionId: D_PLAIN });
      const next = await start(AGENT_1, script, C1);
      expect(next.id).not.toBe(run.id);
      expect(next.status).toBe('in_progress');
    });
  });

  describe('startScriptRun: the body, and the published error order', () => {
    afterEach(async () => {
      await resetWorld();
    });

    it('a body that is not the closed { scriptId, contactId } of uuids is 400 before anything else, and starts nothing', async () => {
      const script = await makeScript();
      const v = script.versionId;
      const bodies: [string, unknown][] = [
        ['an empty body', {}],
        ['a non-uuid scriptId', { scriptId: 'not-a-uuid', contactId: CB1 }],
        ['a non-uuid contactId', { scriptId: script.scriptId, contactId: 'x' }],
        ['no contactId', { scriptId: script.scriptId }],
        [
          'a versionId (the server pins it)',
          { scriptId: script.scriptId, contactId: CB1, versionId: v },
        ],
        [
          'a programmeId (the contact’s)',
          { scriptId: script.scriptId, contactId: CB1, programmeId: PROGRAMME_A1 },
        ],
        [
          'an id (the server mints it)',
          { scriptId: script.scriptId, contactId: CB1, id: randomUUID() },
        ],
        ['a status', { scriptId: script.scriptId, contactId: CB1, status: 'completed' }],
        ['a call id (M09)', { scriptId: script.scriptId, contactId: CB1, callId: randomUUID() }],
        ['an array', [{ scriptId: script.scriptId, contactId: C1 }]],
      ];
      const count = await runCount();
      for (const [label, body] of bodies) {
        const response = await startRaw(AGENT_1, body);
        expect(response.status, label).toBe(400);
        expectError(response, 400, 'validation_failed');
      }
      expect(await runCount(), 'a refused start created a run').toBe(count);
    });

    it('404 (contact), then 403 (script.run in the CONTACT’s programme, before the script), then 404 (script), then 409 script_not_published', async () => {
      const published = await makeScript();
      const draft = await makeScript({ publish: false });
      const inA2 = await makeScript({ programmeId: PROGRAMME_A2 });
      const inB1 = await makeScript({ headers: TENANT_B_ADMIN, programmeId: PROGRAMME_B1 });
      const body = (script: Published | string, contactId: string) => ({
        scriptId: typeof script === 'string' ? script : script.scriptId,
        contactId,
      });
      const count = await runCount();

      // 1. The contact. A caller who reaches nothing gets 404, not 403.
      const nothing = await startRaw(AGENT_1, body(published, NOWHERE));
      expectError(nothing, 404, 'not_found');
      for (const [who, headers, script, contactId] of [
        ['agent 1, an A2 contact', AGENT_1, published, CA2],
        ['agent 1, a tenant B contact', AGENT_1, published, CB1],
        ['no programme, an A1 contact', NO_PROGRAMME, published, C1],
        ['no programme, an unpublished script', NO_PROGRAMME, draft, C1],
        ['tenant B, an A1 contact', TENANT_B_ADMIN, inB1, C1],
      ] as const) {
        const response = await startRaw(headers, body(script, contactId));
        expectError(response, 404, 'not_found');
        expect(response.text, who).toBe(nothing.text);
      }

      // 2. script.run, decided on the contact's programme before the script
      //    is looked up: a real, an invented, an unpublished and another
      //    programme's script all get the same 403.
      await assign(TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1, 'qa_analyst');
      const refused = await startRaw(NO_PROGRAMME, body(published, C1));
      expectError(refused, 403, 'not_permitted');
      for (const [label, script] of [
        ['an invented script', NOWHERE],
        ['an unpublished script', draft],
        ['an A2 script', inA2],
        ['a tenant B script', inB1],
      ] as const) {
        const response = await startRaw(NO_PROGRAMME, body(script, C1));
        expectError(response, 403, 'not_permitted');
        expect(response.text, label).toBe(refused.text);
      }

      // 3. The script: one 404 for nothing and for any other programme's,
      //    even for an author who reaches that programme.
      for (const [who, headers, script] of [
        ['the supervisor, an invented script', SUPERVISOR, NOWHERE],
        ['the supervisor, an A2 script on an A1 contact', SUPERVISOR, inA2],
        ['the supervisor, a tenant B script', SUPERVISOR, inB1],
        ['agent 1, an A2 script', AGENT_1, inA2],
      ] as const) {
        const response = await startRaw(headers, body(script, C1));
        expectError(response, 404, 'not_found');
        expect(response.text, who).toBe(nothing.text);
      }

      // 4. A script with no published version.
      expectError(await startRaw(AGENT_1, body(draft, C1)), 409, 'script_not_published');
      expectError(await startRaw(SUPERVISOR, body(draft, C1)), 409, 'script_not_published');
      expect(await runCount(), 'a refused start created a run').toBe(count);
      // The control: the same caller, contact and published script start.
      await start(AGENT_1, published, C1);
    });

    it.each([...RUN_SET_KEYS, ...NON_RUN_SET_KEYS])(
      'script.run (A1): the %s set in the contact’s programme',
      async (key) => {
        const script = await makeScript();
        await assign(TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1, key);
        const response = await startRaw(NO_PROGRAMME, { scriptId: script.scriptId, contactId: C1 });
        if ((NON_RUN_SET_KEYS as readonly string[]).includes(key)) {
          expectError(response, 403, 'not_permitted');
          return;
        }
        expectStatus(response, 201, `the ${key} set starts a run`);
        const run = expectRun(response.body, 'startScriptRun');
        expect(run.startedBy.id).toBe(USER_A_NO_PROGRAMME);
        // Every script.run set holds activity.write (D-P18), so its own
        // completion is never the run 403.
        const done = await complete(NO_PROGRAMME, run, {
          outcome: 'interrupted',
          dispositionId: D_PLAIN,
        });
        expect(done.status).toBe('completed');
        const activity = (await activitiesOf(C1)).find((row) => row.id === done.activityId);
        expect(activity?.owner_user_id, 'the call activity is owned by the caller').toBe(
          USER_A_NO_PROGRAMME,
        );
      },
    );
  });

  describe('startScriptRun: stopped runs, replay and supersede', () => {
    afterEach(async () => {
      await resetWorld();
    });

    /** greet -> rec -> idq (yes) -> the status branch, which stops when status is withheld. */
    async function toStop(
      headers: Headers,
      script: Published,
      contactId: string,
    ): Promise<ScriptRun> {
      let run = await start(headers, script, contactId);
      run = await advance(headers, run);
      run = await ack(headers, run, N('rec'));
      run = await advance(headers, run);
      return advance(headers, run, { choiceKey: C('yes') });
    }

    it('a field_withheld stop on the same version is replayed while the field is still withheld: 200, nothing new', async () => {
      const script = await makeScript();
      await lockContactField('status', 'agent', 'none');
      const stopped = await toStop(AGENT_1, script, C1);
      expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'field_withheld' });
      const before = await auditIds();
      const count = await runCount();
      const again = await start(AGENT_1, script, C1, 200);
      expect(again).toEqual(await readRun(AGENT_1, stopped.id));
      expect(await runCount()).toBe(count);
      expect(await auditSince(before)).toEqual([]);
    });

    it('once the field is readable, a start SUPERSEDES the stopped run: closed, no disposition, no activity, audited; a new run is 201', async () => {
      const script = await makeScript();
      await lockContactField('status', 'agent', 'none');
      const stopped = await toStop(AGENT_1, script, C1);
      expect(stopped.stopReason).toBe('field_withheld');
      await lockContactField('status', 'agent', 'read');
      const activities = await activitiesOf(C1);
      const before = await auditIds();

      const fresh = await start(AGENT_1, script, C1);
      expect(fresh.id).not.toBe(stopped.id);
      expect(fresh).toMatchObject({
        status: 'in_progress',
        currentNodeId: N('greet'),
        versionId: stopped.versionId,
      });

      const old = await readRun(AGENT_1, stopped.id);
      expect(old).toMatchObject({
        status: 'completed',
        outcome: 'superseded',
        stopReason: 'field_withheld',
        endedAtNodeId: N('cust'),
        currentNodeId: null,
        dispositionId: null,
        activityId: null,
        followUpTaskId: null,
        unacknowledgedComplianceNodeIds: [],
      });
      expect(old.completedAt).not.toBeNull();
      expect(old.acknowledgements).toEqual(stopped.acknowledgements);
      expect(old.answers).toEqual(stopped.answers);
      expect(await activitiesOf(C1), 'a supersede logged an activity or a task').toEqual(
        activities,
      );

      const onOld = await auditSince(before, stopped.id);
      expect(
        onOld.map((row) => row.action),
        'the superseded run’s events',
      ).toEqual(['updated']);
      expect(fieldsOf(onOld[0])).toEqual(expect.arrayContaining(['outcome', 'stopReason']));
      for (const field of fieldsOf(onOld[0])) expect(RUN_AUDIT_NAMES).toContain(field);
      expect(JSON.stringify(onOld[0])).toContain('superseded');
      expect((await auditSince(before, fresh.id)).map((row) => row.action)).toEqual(['created']);
    });

    it('a sensitive_field stop is replayed, never superseded', async () => {
      const script = await makeScript();
      await makeSensitive('status');
      const stopped = await toStop(AGENT_1, script, C1);
      expect(stopped).toMatchObject({
        status: 'stopped',
        stopReason: 'sensitive_field',
        currentNodeId: N('cust'),
      });
      expect((await start(AGENT_1, script, C1, 200)).id).toBe(stopped.id);
      // Readability is not what stopped it: an explicit read grant changes nothing.
      await lockContactField('status', 'agent', 'read');
      const again = await start(AGENT_1, script, C1, 200);
      expect(again).toEqual(await readRun(AGENT_1, stopped.id));
      expect(again.status).toBe('stopped');
    });

    it('(R11) a stopped run on an older version stays as it was; the start on the new version is 201', async () => {
      const script = await makeScript();
      await lockContactField('status', 'agent', 'none');
      const stopped = await toStop(AGENT_1, script, C1);
      const rowBefore = await runRow(stopped.id);
      // v2 branches on an answer, so it publishes while status is withheld.
      await saveGraph(
        script.scriptId,
        withNode(runGraph(), N('cust'), (node) => ({
          ...node,
          condition: { source: 'answer', nodeId: N('idq'), operator: 'equals', value: C('yes') },
        })),
      );
      const v2 = await publish(script.scriptId);
      const fresh = await start(AGENT_1, script, C1);
      expect(fresh.id).not.toBe(stopped.id);
      expect(fresh.versionId).toBe(v2.id);
      expect(await runRow(stopped.id), 'the older stopped run changed').toBe(rowBefore);
    });

    it('another agent’s stopped run is never replayed, superseded or revealed', async () => {
      const script = await makeScript();
      await lockContactField('status', 'agent', 'none');
      const stopped = await toStop(AGENT_1, script, C1);
      const rowBefore = await runRow(stopped.id);
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      const theirs = await start(AGENT_2, script, C1);
      expect(theirs.id).not.toBe(stopped.id);
      expect(theirs.startedBy.id).toBe(USER_A_AGENT_2);
      await lockContactField('status', 'agent', 'read');
      const theirsAgain = await start(AGENT_2, script, C1, 200);
      expect(theirsAgain.id).toBe(theirs.id);
      expect(await runRow(stopped.id), 'agent 1’s stopped run changed').toBe(rowBefore);
    });

    it('(R10) a script that opens on a branch can start already stopped: 201, audited with the stop reason, then replayed', async () => {
      const script = await makeScript({ graph: branchFirstGraph() });
      // The control: the supervisor (admin set) reads status and goes through.
      const through = await start(SUPERVISOR, script, C1);
      expect(through).toMatchObject({ status: 'in_progress', currentNodeId: N('endno') });
      expect(through.path.map((step) => [step.nodeId, step.branchOutcome ?? null])).toEqual([
        [N('open'), false],
        [N('endno'), null],
      ]);

      await lockContactField('status', 'agent', 'none');
      const before = await auditIds();
      const stopped = await start(AGENT_1, script, C1);
      expect(stopped).toMatchObject({
        status: 'stopped',
        stopReason: 'field_withheld',
        currentNodeId: N('open'),
      });
      expect(stopped.path.map((step) => [step.nodeId, step.branchOutcome ?? null])).toEqual([
        [N('open'), null],
      ]);
      const events = await auditSince(before, stopped.id);
      expect(events.map((row) => row.action)).toEqual(['created']);
      expect(fieldsOf(events[0])).toEqual(expect.arrayContaining(['versionId', 'stopReason']));
      expect(JSON.stringify(events[0])).toContain('field_withheld');
      expect(JSON.stringify(events[0]), 'the start event names the branch').not.toContain(
        N('open'),
      );
      expect((await start(AGENT_1, script, C1, 200)).id).toBe(stopped.id);
    });
  });

  // =========================================================================
  // 6. A run is its own agent's (D-L93).
  // =========================================================================

  describe('run visibility: the run’s own agent, and the same 404 for everyone else', () => {
    afterEach(async () => {
      await resetWorld();
    });

    type Op = [string, (headers: Headers) => request.Test];

    const runOps = (runId: string, revision: number): Op[] => [
      ['getScriptRun', (h) => getRunRaw(h, runId)],
      ['getScriptRunScript', (h) => runScriptRaw(h, runId)],
      ['advanceScriptRun', (h) => advanceRaw(h, runId, { revision })],
      [
        'acknowledgeScriptRunNode',
        (h) => ackRaw(h, runId, { revision, nodeId: N('rec'), locale: 'en' }),
      ],
      [
        'recordScriptRunAnswers',
        (h) =>
          answersRaw(h, runId, { revision, nodeId: N('ptp'), values: { [K('memo')]: SECRET } }),
      ],
      ['listScriptRunDispositions', (h) => dispositionsRaw(h, runId)],
      [
        'completeScriptRun',
        (h) =>
          completeRaw(h, runId, {
            revision,
            outcome: 'interrupted',
            dispositionId: D_PLAIN,
            note: SECRET,
          }),
      ],
    ];

    /**
     * Every run operation answers `caller` exactly as for a run that does not
     * exist, and nothing changes. The owner's own read is the positive control.
     */
    async function expectUnreachable(caller: Headers, run: ScriptRun, who: string) {
      const before = await auditIds();
      const rowBefore = await runRow(run.id);
      const activities = await activitiesOf(run.contactId);
      const reference = await getRunRaw(caller, NOWHERE_RUN);
      expectError(reference, 404, 'not_found');
      for (const [name, build] of [
        ...runOps(run.id, run.revision),
        ...runOps(NOWHERE_RUN, run.revision),
      ]) {
        const response = await build(caller);
        expectError(response, 404, 'not_found');
        expect(response.text, `${who}: ${name} differs from the 404 for nothing`).toBe(
          reference.text,
        );
      }
      expect(await runRow(run.id), `${who}: the run changed`).toBe(rowBefore);
      expect(await activitiesOf(run.contactId), `${who}: an activity was written`).toEqual(
        activities,
      );
      expect(await auditSince(before), `${who}: something was audited`).toEqual([]);
    }

    async function agentOnesRun(): Promise<ScriptRun> {
      const script = await makeScript();
      const run = await advance(AGENT_1, await start(AGENT_1, script, C1));
      // The positive control: the owner reaches it.
      expect((await readRun(AGENT_1, run.id)).id).toBe(run.id);
      expectStatus(await runScriptRaw(AGENT_1, run.id), 200, 'the owner reads the pinned script');
      expectStatus(await dispositionsRaw(AGENT_1, run.id), 200, 'the owner lists dispositions');
      return run;
    }

    it.each(RUN_SET_KEYS)(
      'a holder of the %s set in the run’s programme, who is not its agent, gets the 404 for nothing',
      async (key) => {
        const run = await agentOnesRun();
        await assign(TENANT_A, USER_A_NO_PROGRAMME, PROGRAMME_A1, key);
        await expectUnreachable(NO_PROGRAMME, run, `the ${key} set`);
      },
    );

    it('another agent, the tenant admin, tenant B and a user who reaches nothing get the 404 for nothing', async () => {
      const run = await agentOnesRun();
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      await expectUnreachable(AGENT_2, run, 'another agent of A1');
      await expectUnreachable(SUPERVISOR, run, 'the tenant admin (admin set, flag on)');
      await expectUnreachable(TENANT_B_ADMIN, run, 'tenant B’s admin');
      await expectUnreachable(NO_PROGRAMME, run, 'a user with no programme');
    });

    it('the run’s own agent without script.run in its programme, or outside it, gets the same 404', async () => {
      const run = await agentOnesRun();
      for (const key of NON_RUN_SET_KEYS) {
        await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, key);
        await expectUnreachable(AGENT_1, run, `its own agent with the ${key} set`);
      }
      // Restored: the same run is theirs again (decided on every request).
      await assign(TENANT_A, USER_A_AGENT_1, PROGRAMME_A1, 'agent');
      expect((await readRun(AGENT_1, run.id)).id).toBe(run.id);
      await unassign(USER_A_AGENT_1, PROGRAMME_A1);
      await expectUnreachable(AGENT_1, run, 'its own agent, removed from the programme');
    });

    it('script.run is judged in the RUN’s programme: an owner who holds it only elsewhere gets the 404', async () => {
      const script = await makeScript();
      const run = await start(SUPERVISOR, script, C1);
      await assign(TENANT_A, USER_A_SUPERVISOR, PROGRAMME_A1, 'qa_analyst');
      await setTenantAdmin(USER_A_SUPERVISOR, false);
      // The control: still admin in A2, so still a script.run holder there.
      const inA2 = await makeScript({ programmeId: PROGRAMME_A2 });
      await start(SUPERVISOR, inA2, CA2);
      await expectUnreachable(SUPERVISOR, run, 'the owner with script.run only in A2');
    });

    it('a run id that is not a uuid is 400 on every run operation', async () => {
      await agentOnesRun();
      for (const [name, build] of runOps('not-a-uuid', 1)) {
        const response = await build(AGENT_1);
        expect(response.status, name).toBe(400);
        expectError(response, 400, 'validation_failed');
      }
    });
  });

  // =========================================================================
  // 7. advanceScriptRun: the server picks the next node.
  // =========================================================================

  /** A form before a status branch: a stopped run whose path holds a form. */
  function formThenBranchGraph(): Graph {
    return {
      startNodeId: N('pre'),
      nodes: [
        {
          id: N('pre'),
          type: 'form',
          title: 'Notes',
          text: `A note first. ${MARK}`,
          fields: [
            { key: K('memo'), label: 'Memo', type: 'text', required: false, maxLength: 2000 },
          ],
          next: N('cust'),
        },
        {
          id: N('cust'),
          type: 'branch',
          title: 'Customer?',
          condition: { source: 'contact_field', field: 'status', operator: 'is_set' },
          whenTrue: N('endyes'),
          whenFalse: N('endno'),
        },
        { id: N('endyes'), type: 'end', title: 'Known' },
        { id: N('endno'), type: 'end', title: 'Unknown' },
      ],
    };
  }

  /** The parts of a run that do not depend on ids or clocks. */
  const shapeOf = (run: ScriptRun) => ({
    status: run.status,
    stopReason: run.stopReason,
    currentNodeId: run.currentNodeId,
    path: run.path.map((step) => [step.nodeId, step.branchOutcome ?? null]),
    acknowledgements: run.acknowledgements.map((entry) => entry.nodeId),
    answers: Object.keys(run.answers).sort(),
    keys: Object.keys(run).sort(),
  });

  describe('advanceScriptRun', () => {
    afterEach(async () => {
      await resetWorld();
    });

    it('the server takes each step and evaluates the branch on entry, both sides; a question’s choice is recorded', async () => {
      const script = await makeScript();
      await setContactStatus(C1, null);
      await setContactStatus(C2, 'customer');

      let r1 = await start(AGENT_1, script, C1);
      const first = await advance(AGENT_1, r1);
      expect(first.path.map((step) => step.nodeId)).toEqual([N('greet'), N('rec')]);
      expect(first.revision, 'a write must change the revision').not.toBe(r1.revision);
      // The old revision is now stale, and nothing moves.
      expectError(await advanceRaw(AGENT_1, r1.id, { revision: r1.revision }), 409, 'stale_write');
      expect((await readRun(AGENT_1, r1.id)).currentNodeId).toBe(N('rec'));
      r1 = await ack(AGENT_1, first, N('rec'));
      r1 = await advance(AGENT_1, r1);
      r1 = await advance(AGENT_1, r1, { choiceKey: C('yes') });
      expect(r1.currentNodeId, 'status null: whenFalse').toBe(N('intro'));
      expect(r1.path.map((step) => [step.nodeId, step.branchOutcome ?? null])).toEqual([
        [N('greet'), null],
        [N('rec'), null],
        [N('idq'), null],
        [N('cust'), false],
        [N('intro'), null],
      ]);
      expect(r1.answers[N('idq')]).toMatchObject({ type: 'question', choiceKey: C('yes') });

      let r2 = await start(AGENT_1, script, C2);
      r2 = await advance(AGENT_1, r2);
      r2 = await ack(AGENT_1, r2, N('rec'));
      r2 = await advance(AGENT_1, r2);
      r2 = await advance(AGENT_1, r2, { choiceKey: C('yes') });
      expect(r2.currentNodeId, 'status customer: whenTrue').toBe(N('payq'));
      expect(r2.path.find((step) => step.nodeId === N('cust'))?.branchOutcome).toBe(true);
      for (const run of [r1, r2]) expect(run.currentNodeId).not.toBe(N('cust'));
    });

    it('the body is closed: the client cannot name the next node or the branch side; a question needs one of its own choices', async () => {
      const script = await makeScript();
      let run = await start(AGENT_1, script, C1);
      run = await advance(AGENT_1, run);
      run = await ack(AGENT_1, run, N('rec'));
      run = await advance(AGENT_1, run);
      at(run, N('idq'), 'fixture');
      const cases: [string, Json, RegExp][] = [
        ['no choiceKey on a question', {}, /^choiceKey$/],
        ['a choice of another node', { choiceKey: C('ptp') }, /^choiceKey$/],
        ['a next node', { choiceKey: C('yes'), nextNodeId: N('idfail') }, /./],
        ['a branch side', { choiceKey: C('yes'), branchOutcome: true }, /./],
        ['a current node', { choiceKey: C('yes'), currentNodeId: N('close') }, /./],
        ['revision 0', { revision: 0, choiceKey: C('yes') }, /^revision$/],
        ['revision 2^31', { revision: 2_147_483_648, choiceKey: C('yes') }, /^revision$/],
        ['a fractional revision', { revision: 1.5, choiceKey: C('yes') }, /^revision$/],
        [
          'a string revision',
          { revision: String(run.revision), choiceKey: C('yes') },
          /^revision$/,
        ],
      ];
      for (const [label, extra, path] of cases) {
        const response = await advanceRaw(AGENT_1, run.id, { revision: run.revision, ...extra });
        expect(response.status, label).toBe(400);
        expect400(response, path);
        expect(await readRun(AGENT_1, run.id), `${label}: the run moved`).toEqual(run);
      }
      expect((await advance(AGENT_1, run, { choiceKey: C('yes') })).path.length).toBeGreaterThan(
        run.path.length,
      );
    });

    it('409s: an unacknowledged compliance node, missing required answers, the end', async () => {
      const script = await makeScript();
      let run = await advance(AGENT_1, await start(AGENT_1, script, C1));
      at(run, N('rec'), 'fixture');
      expectDetail(
        await advanceRaw(AGENT_1, run.id, { revision: run.revision }),
        409,
        'compliance_unacknowledged',
        new RegExp(N('rec')),
      );
      expect(await readRun(AGENT_1, run.id)).toEqual(run);

      run = await ack(AGENT_1, run, N('rec'));
      run = await advance(AGENT_1, run);
      run = await advance(AGENT_1, run, { choiceKey: C('yes') });
      if (run.currentNodeId === N('intro')) run = await advance(AGENT_1, run);
      run = await advance(AGENT_1, run, { choiceKey: C('ptp') });
      at(run, N('ptp'), 'fixture');
      run = await answer(AGENT_1, run, N('ptp'), {
        [K('amount')]: { amountMinor: '2500000', currency: 'NGN' },
      });
      const incomplete = expectError(
        await advanceRaw(AGENT_1, run.id, { revision: run.revision }),
        409,
        'answers_incomplete',
      );
      const paths = detailsOf(incomplete)
        .map((detail) => detail.path)
        .sort();
      expect(paths).toEqual([`values.${K('date')}`, `values.${K('reason')}`].sort());
      expect(await readRun(AGENT_1, run.id)).toEqual(run);

      run = await answer(AGENT_1, run, N('ptp'), goodAnswers());
      run = await advance(AGENT_1, run);
      run = await ack(AGENT_1, run, N('readback'));
      run = await advance(AGENT_1, run);
      at(run, N('close'), 'fixture');
      expectError(await advanceRaw(AGENT_1, run.id, { revision: run.revision }), 409, 'run_at_end');
      expect(await readRun(AGENT_1, run.id)).toEqual(run);
    });

    it('a branch on a field withheld from the RUN’S agent stops the run, whatever the value (R7), and reveals nothing', async () => {
      const script = await makeScript();
      await lockContactField('status', 'agent', 'none');
      await setContactStatus(C1, 'customer');
      await setContactStatus(C2, null);
      const stopAt = async (contactId: string) => {
        let run = await start(AGENT_1, script, contactId);
        run = await advance(AGENT_1, run);
        run = await ack(AGENT_1, run, N('rec'));
        run = await advance(AGENT_1, run);
        return advance(AGENT_1, run, { choiceKey: C('yes') });
      };
      const customer = await stopAt(C1);
      const unset = await stopAt(C2);
      expect(customer).toMatchObject({
        status: 'stopped',
        stopReason: 'field_withheld',
        currentNodeId: N('cust'),
      });
      expect(customer.path[customer.path.length - 1]).toMatchObject({
        nodeId: N('cust'),
        branchOutcome: null,
      });
      expect(customer.answers[N('idq')]).toMatchObject({ choiceKey: C('yes') });
      expect(shapeOf(customer), 'the stop depends on the withheld value').toEqual(shapeOf(unset));
      expect(JSON.stringify(customer)).not.toContain('customer"');

      // Judged against the run's agent: the admin set reads status and goes on.
      let theirs = await start(SUPERVISOR, script, C1);
      theirs = await advance(SUPERVISOR, theirs);
      theirs = await ack(SUPERVISOR, theirs, N('rec'));
      theirs = await advance(SUPERVISOR, theirs);
      theirs = await advance(SUPERVISOR, theirs, { choiceKey: C('yes') });
      expect(theirs).toMatchObject({ status: 'in_progress', currentNodeId: N('payq') });

      // A stopped run can only be completed.
      expectError(
        await advanceRaw(AGENT_1, customer.id, { revision: customer.revision }),
        409,
        'run_stopped',
      );
      expectError(
        await ackRaw(AGENT_1, customer.id, {
          revision: customer.revision,
          nodeId: N('rec'),
          locale: 'en',
        }),
        409,
        'run_stopped',
      );
      expect(await readRun(AGENT_1, customer.id)).toEqual(customer);
    });

    it('a stopped run refuses answers on a form already on its path: 409 run_stopped', async () => {
      const script = await makeScript({ graph: formThenBranchGraph() });
      await lockContactField('status', 'agent', 'none');
      const stopped = await advance(AGENT_1, await start(AGENT_1, script, C1));
      expect(stopped).toMatchObject({
        status: 'stopped',
        stopReason: 'field_withheld',
        currentNodeId: N('cust'),
      });
      expectError(
        await answersRaw(AGENT_1, stopped.id, {
          revision: stopped.revision,
          nodeId: N('pre'),
          values: { [K('memo')]: SECRET },
        }),
        409,
        'run_stopped',
      );
      expect(await readRun(AGENT_1, stopped.id)).toEqual(stopped);
    });

    it('a branch on a field classified sensitive since publish stops the run with sensitive_field, for every set', async () => {
      const script = await makeScript();
      await makeSensitive('status');
      for (const headers of [AGENT_1, SUPERVISOR]) {
        let run = await start(headers, script, C1);
        run = await advance(headers, run);
        run = await ack(headers, run, N('rec'));
        run = await advance(headers, run);
        run = await advance(headers, run, { choiceKey: C('yes') });
        expect(run).toMatchObject({
          status: 'stopped',
          stopReason: 'sensitive_field',
          currentNodeId: N('cust'),
        });
      }
    });

    it('a VARIABLE on a withheld or now-sensitive field never stops the run, and no run response carries the value', async () => {
      const stateValue = `Zuru${RUN}`;
      const script = await makeScript({
        graph: greetSays(runGraph(), '{contact.state} {contact.givenNames}'),
      });
      await observer.query('UPDATE contact SET state = $1 WHERE id = $2', [stateValue, C1]);
      await makeSensitive('state');
      await lockContactField('given_names', 'agent', 'none');
      const responses: string[] = [];
      let run = await start(AGENT_1, script, C1);
      expect(run.status).toBe('in_progress');
      run = await advance(AGENT_1, run);
      expect(run).toMatchObject({ status: 'in_progress', currentNodeId: N('rec') });
      responses.push(JSON.stringify(run));
      const pinned = await runScriptRaw(AGENT_1, run.id);
      expectStatus(pinned, 200, 'getScriptRunScript');
      const greet = (pinned.body as Version).graph.nodes.find((node) => node.id === N('greet'));
      expect(String(greet?.text)).toContain('{contact.state}');
      expect(String(greet?.text)).toContain('{contact.givenNames}');
      responses.push(pinned.text, (await getRunRaw(AGENT_1, run.id)).text);
      for (const text of responses) {
        expect(text).not.toContain(stateValue);
        expect(text).not.toContain(seededContact(C1).givenNames);
      }
    });

    it('(R6) parallel advances on one revision move the run one step: one 200, the rest 409 stale_write', async () => {
      const script = await makeScript();
      const run = await start(AGENT_1, script, C1);
      const responses = await Promise.all(
        Array.from({ length: 3 }, () => advanceRaw(AGENT_1, run.id, { revision: run.revision })),
      );
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses, responses.map((response) => response.text.slice(0, 200)).join('\n')).toEqual(
        [200, 409, 409],
      );
      for (const response of responses.filter((candidate) => candidate.status === 409)) {
        expectError(response, 409, 'stale_write');
      }
      expect((await readRun(AGENT_1, run.id)).path.map((step) => step.nodeId)).toEqual([
        N('greet'),
        N('rec'),
      ]);
    });

    it('errors in the published order: 404, 400, run_completed, run_stopped, stale_write, run_at_end', async () => {
      const script = await makeScript();
      const mine = await start(AGENT_1, script, C1);
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      expectError(await advanceRaw(AGENT_2, mine.id, { revision: 0 }), 404, 'not_found');

      await lockContactField('status', 'agent', 'none');
      let stopped = await advance(AGENT_1, mine);
      stopped = await ack(AGENT_1, stopped, N('rec'));
      stopped = await advance(AGENT_1, stopped);
      stopped = await advance(AGENT_1, stopped, { choiceKey: C('yes') });
      expect(stopped.status).toBe('stopped');
      expectError(await advanceRaw(AGENT_1, stopped.id, { revision: 0 }), 400, 'validation_failed');
      expectError(
        await advanceRaw(AGENT_1, stopped.id, { revision: stopped.revision + 7 }),
        409,
        'run_stopped',
      );

      await lockContactField('status', 'agent', 'read');
      const other = await makeScript();
      const done = await complete(AGENT_1, await start(AGENT_1, other, C2), {
        outcome: 'interrupted',
        dispositionId: D_PLAIN,
      });
      expectError(await advanceRaw(AGENT_1, done.id, { revision: 0 }), 400, 'validation_failed');
      expectError(
        await advanceRaw(AGENT_1, done.id, { revision: done.revision + 7 }),
        409,
        'run_completed',
      );

      const atEnd = await toClose(AGENT_1, await start(AGENT_1, other, C3));
      expectError(
        await advanceRaw(AGENT_1, atEnd.id, { revision: atEnd.revision + 7 }),
        409,
        'stale_write',
      );
      expectError(
        await advanceRaw(AGENT_1, atEnd.id, { revision: atEnd.revision }),
        409,
        'run_at_end',
      );
    });
  });

  // =========================================================================
  // 8. acknowledgeScriptRunNode.
  // =========================================================================

  describe('acknowledgeScriptRunNode', () => {
    afterEach(async () => {
      await resetWorld();
    });

    it('records the server’s time, the reported locale (or the source when the translation lacks text) and the profile locale at that moment', async () => {
      const script = await makeScript({ translations: { pcm: PCM_TRANSLATION } });
      await setUserLocale(USER_A_AGENT_1, 'pcm');
      let run = await advance(AGENT_1, await start(AGENT_1, script, C1));
      const from = Date.now();
      run = await ack(AGENT_1, run, N('rec'), 'pcm');
      const to = Date.now();
      expect(run.acknowledgements).toHaveLength(1);
      const [first] = run.acknowledgements;
      expect(first).toMatchObject({ nodeId: N('rec'), locale: 'pcm', profileLocale: 'pcm' });
      const stamped = Date.parse(String(first?.acknowledgedAt));
      expect(stamped, 'acknowledgedAt is the server’s clock now').toBeGreaterThanOrEqual(
        from - 5_000,
      );
      expect(stamped).toBeLessThanOrEqual(to + 5_000);

      run = await advance(AGENT_1, run);
      run = await advance(AGENT_1, run, { choiceKey: C('yes') });
      if (run.currentNodeId === N('intro')) run = await advance(AGENT_1, run);
      run = await advance(AGENT_1, run, { choiceKey: C('ptp') });
      run = await answer(AGENT_1, run, N('ptp'), goodAnswers());
      run = await advance(AGENT_1, run);
      at(run, N('readback'), 'fixture');
      await setUserLocale(USER_A_AGENT_1, 'de-DE');
      run = await ack(AGENT_1, run, N('readback'), 'pcm');
      expect(
        run.acknowledgements.map((entry) => [entry.nodeId, entry.locale, entry.profileLocale]),
      ).toEqual([
        [N('rec'), 'pcm', 'pcm'],
        // pcm has no `text` for readback: the screen showed the source (R9: de-DE is no script locale).
        [N('readback'), 'en', null],
      ]);
    });

    it('a locale with no translation records the source locale, for an English and a French script', async () => {
      const english = await makeScript();
      let run = await advance(AGENT_1, await start(AGENT_1, english, C1));
      run = await ack(AGENT_1, run, N('rec'), 'ha');
      expect(run.acknowledgements[0]?.locale).toBe('en');

      const french = await makeScript({ sourceLocale: 'fr' });
      let fr = await advance(AGENT_1, await start(AGENT_1, french, C2));
      fr = await ack(AGENT_1, fr, N('rec'), 'en');
      expect(fr.acknowledgements[0]?.locale).toBe('fr');
    });

    it('the body carries no time; acknowledging again keeps the first time and changes nothing (R2)', async () => {
      const script = await makeScript();
      const run = await advance(AGENT_1, await start(AGENT_1, script, C1));
      for (const extra of [{ acknowledgedAt: '2020-01-01T00:00:00Z' }, { profileLocale: 'en' }]) {
        expectError(
          await ackRaw(AGENT_1, run.id, {
            revision: run.revision,
            nodeId: N('rec'),
            locale: 'en',
            ...extra,
          }),
          400,
          'validation_failed',
        );
      }
      expect(await readRun(AGENT_1, run.id)).toEqual(run);
      const acked = await ack(AGENT_1, run, N('rec'));
      const again = await ack(AGENT_1, acked, N('rec'), 'pcm');
      expect(again).toEqual(acked);
      const moved = await advance(AGENT_1, again);
      const later = await ack(AGENT_1, moved, N('rec'));
      expect(later.acknowledgements).toEqual(acked.acknowledgements);
    });

    it('only a compliance node on the path: a say node, a node not yet entered and an unknown node are 400; a pre-acknowledgement never counts', async () => {
      const script = await makeScript();
      let run = await advance(AGENT_1, await start(AGENT_1, script, C1));
      const body = (nodeId: string, locale = 'en') => ({ revision: run.revision, nodeId, locale });
      expect400(await ackRaw(AGENT_1, run.id, body(N('greet'))), /^nodeId$/);
      expect400(await ackRaw(AGENT_1, run.id, body(N('readback'))), /^nodeId$/, 'not_on_path');
      expect400(await ackRaw(AGENT_1, run.id, body(`ghost_${RID}`)), /^nodeId$/);
      expect400(await ackRaw(AGENT_1, run.id, body(N('rec'), 'de')), /^locale$/);
      expect(await readRun(AGENT_1, run.id)).toEqual(run);
      // Walk to readback: the refused early acknowledgement counted for nothing.
      run = await ack(AGENT_1, run, N('rec'));
      run = await advance(AGENT_1, run);
      run = await advance(AGENT_1, run, { choiceKey: C('yes') });
      if (run.currentNodeId === N('intro')) run = await advance(AGENT_1, run);
      run = await advance(AGENT_1, run, { choiceKey: C('ptp') });
      run = await answer(AGENT_1, run, N('ptp'), goodAnswers());
      run = await advance(AGENT_1, run);
      at(run, N('readback'), 'fixture');
      expect(run.acknowledgements.map((entry) => entry.nodeId)).toEqual([N('rec')]);
      expectError(
        await advanceRaw(AGENT_1, run.id, { revision: run.revision }),
        409,
        'compliance_unacknowledged',
      );
    });

    it('errors in the published order: 404, 400, run_completed, run_stopped, stale_write', async () => {
      const script = await makeScript();
      const run = await advance(AGENT_1, await start(AGENT_1, script, C1));
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      expectError(
        await ackRaw(AGENT_1, run.id, {
          revision: run.revision + 7,
          nodeId: N('rec'),
          locale: 'en',
        }),
        409,
        'stale_write',
      );
      expectError(
        await ackRaw(AGENT_2, run.id, { revision: 0, nodeId: 'X', locale: 'xx' }),
        404,
        'not_found',
      );

      const done = await complete(AGENT_1, run, { outcome: 'interrupted', dispositionId: D_PLAIN });
      expectError(
        await ackRaw(AGENT_1, done.id, { revision: 0, nodeId: N('rec'), locale: 'en' }),
        400,
        'validation_failed',
      );
      expectError(
        await ackRaw(AGENT_1, done.id, {
          revision: done.revision + 7,
          nodeId: N('rec'),
          locale: 'en',
        }),
        409,
        'run_completed',
      );

      await lockContactField('status', 'agent', 'none');
      let stopped = await advance(AGENT_1, await start(AGENT_1, script, C2));
      stopped = await ack(AGENT_1, stopped, N('rec'));
      stopped = await advance(AGENT_1, stopped);
      stopped = await advance(AGENT_1, stopped, { choiceKey: C('yes') });
      expect(stopped.status).toBe('stopped');
      expectError(
        await ackRaw(AGENT_1, stopped.id, {
          revision: stopped.revision + 7,
          nodeId: N('rec'),
          locale: 'en',
        }),
        409,
        'run_stopped',
      );
    });
  });

  // =========================================================================
  // 9. recordScriptRunAnswers.
  // =========================================================================

  describe('recordScriptRunAnswers', () => {
    afterEach(async () => {
      await resetWorld();
    });

    async function atForm(contactId = C1): Promise<ScriptRun> {
      const script = await makeScript();
      let run = await toPayq(AGENT_1, await start(AGENT_1, script, contactId));
      run = await advance(AGENT_1, run, { choiceKey: C('ptp') });
      at(run, N('ptp'), 'fixture');
      return run;
    }

    const valuesOf = (run: ScriptRun): Json => (run.answers[N('ptp')]?.values ?? {}) as Json;

    it('merges per node: a save sends only its keys, and null clears one', async () => {
      let run = await atForm();
      run = await answer(AGENT_1, run, N('ptp'), { [K('date')]: dayAhead(2) });
      run = await answer(AGENT_1, run, N('ptp'), {
        [K('amount')]: { amountMinor: '2500000', currency: 'NGN' },
      });
      expect(run.answers[N('ptp')]).toMatchObject({ type: 'form' });
      expect(valuesOf(run)).toMatchObject({
        [K('date')]: dayAhead(2),
        [K('amount')]: { amountMinor: '2500000', currency: 'NGN' },
      });
      run = await answer(AGENT_1, run, N('ptp'), { [K('date')]: null });
      expect(valuesOf(run)[K('date')] ?? null, 'null clears the value').toBeNull();
      expect(valuesOf(run)[K('amount')]).toEqual({ amountMinor: '2500000', currency: 'NGN' });
    });

    it('D-L102: a second save after a 409 sends only what it changed and keeps the other save', async () => {
      const opened = await atForm();
      // Tab A saves the memo.
      const afterA = await answer(AGENT_1, opened, N('ptp'), { [K('memo')]: `A ${SECRET}` });
      // Tab B, opened on the same revision, saves the count: stale.
      expectError(
        await answersRaw(AGENT_1, opened.id, {
          revision: opened.revision,
          nodeId: N('ptp'),
          values: { [K('count')]: 3 },
        }),
        409,
        'stale_write',
      );
      expect(await readRun(AGENT_1, opened.id)).toEqual(afterA);
      // B re-reads and re-sends only its own change.
      const fresh = await readRun(AGENT_1, opened.id);
      const afterB = await answer(AGENT_1, fresh, N('ptp'), { [K('count')]: 3 });
      expect(valuesOf(afterB)).toMatchObject({ [K('memo')]: `A ${SECRET}`, [K('count')]: 3 });
    });

    it('a value that breaks its field’s rules is 400 naming values.<key>, never echoing the value, and writes nothing', async () => {
      const run = await atForm();
      const cases: [string, string, unknown, string?][] = [
        ['a date that is not a date', K('date'), `next tuesday ${SECRET}`],
        ['an impossible date', K('date'), '2026-02-30'],
        ['a date in the past', K('date'), dayAhead(-1)],
        ['a date past maxDaysAhead', K('date'), dayAhead(30)],
        [
          'money below the minimum',
          K('amount'),
          { amountMinor: '100', currency: 'NGN' },
          'too_small',
        ],
        ['money above the maximum', K('amount'), { amountMinor: '100000001', currency: 'NGN' }],
        ['money in another currency', K('amount'), { amountMinor: '2500000', currency: 'USD' }],
        ['money as a decimal', K('amount'), { amountMinor: '25000.50', currency: 'NGN' }],
        ['money as a bare number', K('amount'), 2_500_000],
        ['a choice that is not an option', K('reason'), `${SECRET}`],
        ['a number above maximum', K('count'), 11],
        ['a number past 2^31-1', K('count'), 2_147_483_648],
        ['a fractional number', K('count'), 1.5],
        ['a number as a string', K('count'), '3'],
        ['text over maxLength', K('memo'), `${SECRET}${'x'.repeat(2001)}`],
        ['a key the node does not have', K('ghost'), SECRET],
      ];
      for (const [label, key, value, code] of cases) {
        const response = await answersRaw(AGENT_1, run.id, {
          revision: run.revision,
          nodeId: N('ptp'),
          values: { [key]: value },
        });
        expect(response.status, label).toBe(400);
        expect400(response, exactly(`values.${key}`), code);
        expect(response.text, `${label}: the error echoes the value`).not.toContain(SECRET);
      }
      expect400(
        await answersRaw(AGENT_1, run.id, { revision: run.revision, nodeId: N('ptp'), values: {} }),
        /^values/,
      );
      expect(await readRun(AGENT_1, run.id), 'a refused save wrote something').toEqual(run);
    });

    it('NUL is 400 nul_character; a node that is not a form on the path is 400', async () => {
      const script = await makeScript();
      let run = await toPayq(AGENT_1, await start(AGENT_1, script, C1));
      // At payq: the form is not yet on the path; idq is a question.
      expect400(
        await answersRaw(AGENT_1, run.id, {
          revision: run.revision,
          nodeId: N('ptp'),
          values: { [K('memo')]: 'x' },
        }),
        /^nodeId$/,
        'not_on_path',
      );
      expect400(
        await answersRaw(AGENT_1, run.id, {
          revision: run.revision,
          nodeId: N('idq'),
          values: { [K('memo')]: 'x' },
        }),
        /^nodeId$/,
      );
      run = await advance(AGENT_1, run, { choiceKey: C('ptp') });
      expect400(
        await answersRaw(AGENT_1, run.id, {
          revision: run.revision,
          nodeId: N('ptp'),
          values: { [K('memo')]: `bad \u0000 ${SECRET}` },
        }),
        exactly(`values.${K('memo')}`),
        'nul_character',
      );
      expect(await readRun(AGENT_1, run.id)).toEqual(run);
    });

    it('the run’s answers are capped at 262144 UTF-8 bytes: over is 400 too_big and writes nothing; under is accepted', async () => {
      const script = await makeScript({ graph: capGraph() });
      let run = await start(AGENT_1, script, C1);
      run = await answer(AGENT_1, run, N('f1'), capValues(1, CAP_FIELDS));
      run = await advance(AGENT_1, run);
      run = await answer(AGENT_1, run, N('f2'), capValues(2, CAP_FIELDS));
      run = await advance(AGENT_1, run);
      at(run, N('f3'), 'fixture');
      const over = await answersRaw(AGENT_1, run.id, {
        revision: run.revision,
        nodeId: N('f3'),
        values: capValues(3, 5),
      });
      expect(over.status, 'over the cap in bytes (not in characters)').toBe(400);
      expect400(over, /./, 'too_big');
      expect(await readRun(AGENT_1, run.id), 'an over-cap save wrote something').toEqual(run);
      const under = await answer(AGENT_1, run, N('f3'), capValues(3, 1));
      expect(Object.keys((under.answers[N('f3')]?.values ?? {}) as Json)).toHaveLength(1);
    });

    it('errors in the published order: 404, 400, run_completed, stale_write', async () => {
      const run = await atForm();
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      expectError(
        await answersRaw(AGENT_2, run.id, { revision: 0, nodeId: 'X', values: {} }),
        404,
        'not_found',
      );
      expectError(
        await answersRaw(AGENT_1, run.id, {
          revision: run.revision + 7,
          nodeId: N('ptp'),
          values: { [K('count')]: 1 },
        }),
        409,
        'stale_write',
      );
      const done = await complete(AGENT_1, run, { outcome: 'interrupted', dispositionId: D_PLAIN });
      expectError(
        await answersRaw(AGENT_1, done.id, {
          revision: 0,
          nodeId: N('ptp'),
          values: { [K('count')]: 1 },
        }),
        400,
        'validation_failed',
      );
      expectError(
        await answersRaw(AGENT_1, done.id, {
          revision: done.revision + 7,
          nodeId: N('ptp'),
          values: { [K('count')]: 1 },
        }),
        409,
        'run_completed',
      );
    });
  });

  // =========================================================================
  // 10. listScriptRunDispositions and cursors.
  // =========================================================================

  describe('listScriptRunDispositions, and cursors resolved inside their own list', () => {
    afterEach(async () => {
      await resetWorld();
    });

    function expectDispositionPage(response: request.Response, where: string): Page<Json> {
      expectStatus(response, 200, where);
      expectSchema(response.body, 'RunDispositionPage', where);
      const page = response.body as Page<Json>;
      expect(Object.keys(page).sort()).toEqual(['data', 'nextCursor']);
      expectNoStore(response, where);
      expectNoTotals(response, where);
      return page;
    }

    it('lists only the run’s programme’s LIVE dispositions, by position, one page at a time', async () => {
      const run = await start(AGENT_1, await makeScript(), C1);
      const rows: Json[] = [];
      const cursors: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = expectDispositionPage(
          await dispositionsRaw(AGENT_1, run.id, [
            ['limit', '1'],
            ...(cursor === null ? [] : ([['cursor', cursor]] as const)),
          ]),
          'listScriptRunDispositions',
        );
        rows.push(...page.data);
        cursor = page.nextCursor;
        if (cursor === null) break;
        cursors.push(cursor);
      }
      expect(rows).toEqual([
        {
          id: D_PTP,
          code: 'T0114_PTP',
          label: LABEL_PTP,
          category: 'promise_to_pay',
          noteRequired: true,
          followUpRequired: false,
          position: 1,
        },
        {
          id: D_CB,
          code: 'T0114_CB',
          label: LABEL_CB,
          category: 'callback',
          noteRequired: false,
          followUpRequired: true,
          position: 2,
        },
        {
          id: D_PLAIN,
          code: 'T0114_PLAIN',
          label: LABEL_PLAIN,
          category: 'resolved',
          noteRequired: false,
          followUpRequired: false,
          position: 3,
        },
      ]);
      for (const value of cursors) {
        for (const form of cursorForms(value)) {
          for (const name of [LABEL_PTP, LABEL_CB, 'T0114_PTP', 'T0114_CB'])
            expect(form).not.toContain(name);
        }
      }
      for (const limit of ['0', '101', 'ten']) {
        expect400(await dispositionsRaw(AGENT_1, run.id, [['limit', limit]]), /^limit$/);
      }
    });

    it('another run’s programme’s cursor, another list’s cursor and a deactivated row’s cursor (R8) are the garbage cursor’s 400', async () => {
      const a1Script = await makeScript();
      await makeScript();
      const a2Script = await makeScript({ programmeId: PROGRAMME_A2 });
      const inA1 = await start(SUPERVISOR, a1Script, C1);
      const inA2 = await start(SUPERVISOR, a2Script, CA2);
      const firstCursor = async (runId: string) =>
        expectDispositionPage(
          await dispositionsRaw(SUPERVISOR, runId, [['limit', '1']]),
          'first page',
        ).nextCursor;
      const a1Cursor = await firstCursor(inA1.id);
      const a2Cursor = await firstCursor(inA2.id);
      const menuPage = await contactScriptsRaw(SUPERVISOR, C1, [['limit', '1']]);
      expectStatus(menuPage, 200, 'listContactScripts');
      const menuCursor = (menuPage.body as Page<Json>).nextCursor;
      expect([a1Cursor, a2Cursor, menuCursor], 'each list gives a next page').not.toContain(null);
      // The control: a cursor works where it was issued.
      expectStatus(
        await dispositionsRaw(SUPERVISOR, inA1.id, [['cursor', String(a1Cursor)]]),
        200,
        'own cursor',
      );

      const garbage = await dispositionsRaw(SUPERVISOR, inA1.id, [['cursor', 'not-a-cursor']]);
      expect400(garbage, /^cursor$/, 'invalid_cursor');
      for (const [label, response] of [
        [
          'an A2 run’s cursor on an A1 run',
          await dispositionsRaw(SUPERVISOR, inA1.id, [['cursor', String(a2Cursor)]]),
        ],
        [
          'a menu cursor on dispositions',
          await dispositionsRaw(SUPERVISOR, inA1.id, [['cursor', String(menuCursor)]]),
        ],
      ] as const) {
        expect400(response, /^cursor$/, 'invalid_cursor');
        expect(response.text, label).toBe(garbage.text);
      }
      const menuGarbage = await contactScriptsRaw(SUPERVISOR, C1, [['cursor', 'not-a-cursor']]);
      expect400(menuGarbage, /^cursor$/, 'invalid_cursor');
      for (const [label, response] of [
        [
          'a dispositions cursor on the menu',
          await contactScriptsRaw(SUPERVISOR, C1, [['cursor', String(a1Cursor)]]),
        ],
        [
          'an A1 contact’s menu cursor on an A2 contact',
          await contactScriptsRaw(SUPERVISOR, CA2, [['cursor', String(menuCursor)]]),
        ],
      ] as const) {
        expect400(response, /^cursor$/, 'invalid_cursor');
        expect(response.text, label).toBe(menuGarbage.text);
      }
      // R8: the first page's cursor names D_PTP; deactivated, it is garbage.
      await observer.query('UPDATE disposition SET active = false WHERE id = $1', [D_PTP]);
      const stale = await dispositionsRaw(SUPERVISOR, inA1.id, [['cursor', String(a1Cursor)]]);
      expect400(stale, /^cursor$/, 'invalid_cursor');
      expect(stale.text).toBe(garbage.text);
    });
  });

  // =========================================================================
  // 11. completeScriptRun.
  // =========================================================================

  describe('completeScriptRun', () => {
    afterEach(async () => {
      await resetWorld();
    });

    it('at the end: completed, with a call activity (subject = the label, body = the note) owned by the caller', async () => {
      const run = await toClose(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      const note = `Promised to pay on Friday. ${SECRET}`;
      const before = Date.now();
      const done = await complete(AGENT_1, run, {
        outcome: 'completed',
        dispositionId: D_PTP,
        note,
      });
      expect(done).toMatchObject({
        status: 'completed',
        outcome: 'completed',
        endedAtNodeId: N('close'),
        currentNodeId: null,
        stopReason: null,
        unacknowledgedComplianceNodeIds: [],
        dispositionId: D_PTP,
        followUpTaskId: null,
      });
      expect(done.activityId).toMatch(UUID);
      expect(Date.parse(String(done.completedAt))).toBeGreaterThan(before - 5_000);
      expect(done.acknowledgements).toEqual(run.acknowledgements);
      const activities = await activitiesOf(C1);
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        id: done.activityId,
        type: 'call',
        subject: LABEL_PTP,
        body: note,
        owner_user_id: USER_A_AGENT_1,
        created_by_user_id: USER_A_AGENT_1,
        contact_id: C1,
        programme_id: PROGRAMME_A1,
      });
    });

    it('a followUp books the callback task in the same completion; allowed with any disposition', async () => {
      const dueAt = instantAhead(26);
      const run = await toClose(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      const done = await complete(AGENT_1, run, {
        outcome: 'completed',
        dispositionId: D_CB,
        followUp: { dueAt },
      });
      expect(done.followUpTaskId).toMatch(UUID);
      const rows = await activitiesOf(C1);
      expect(rows.map((row) => row.type).sort()).toEqual(['call', 'task']);
      const task = rows.find((row) => row.id === done.followUpTaskId);
      expect(task).toMatchObject({
        type: 'task',
        owner_user_id: USER_A_AGENT_1,
        contact_id: C1,
        completed_at: null,
      });
      expect(task?.due_at?.toISOString().replace(/\.\d{3}Z$/, 'Z')).toBe(dueAt);
      expect(rows.find((row) => row.id === done.activityId)?.subject).toBe(LABEL_CB);

      const plain = await start(AGENT_1, await makeScript(), C2);
      const booked = await complete(AGENT_1, plain, {
        outcome: 'interrupted',
        dispositionId: D_PLAIN,
        followUp: { dueAt },
      });
      expect(booked.followUpTaskId, 'a followUp with a plain disposition books it too').toMatch(
        UUID,
      );
    });

    it('completed away from an end is 409 compliance_unacknowledged {outcome, not_at_end}, and writes nothing', async () => {
      const run = await toPayq(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      const rowBefore = await runRow(run.id);
      expectDetail(
        await completeRaw(AGENT_1, run.id, {
          revision: run.revision,
          outcome: 'completed',
          dispositionId: D_PLAIN,
        }),
        409,
        'compliance_unacknowledged',
        /^outcome$/,
        'not_at_end',
      );
      expect(await runRow(run.id)).toBe(rowBefore);
      expect(await activitiesOf(C1)).toEqual([]);
    });

    it('interrupted excuses the current node and later ones, never an earlier one, and acknowledges nothing', async () => {
      const script = await makeScript();
      // At rec, unacknowledged.
      const atRec = await advance(AGENT_1, await start(AGENT_1, script, C1));
      const a = await complete(AGENT_1, atRec, { outcome: 'interrupted', dispositionId: D_PLAIN });
      expect(a).toMatchObject({
        status: 'completed',
        outcome: 'interrupted',
        unacknowledgedComplianceNodeIds: [N('rec')],
        endedAtNodeId: N('rec'),
        currentNodeId: null,
        acknowledgements: [],
      });
      // At rec, acknowledged but not advanced.
      const acked = await ack(
        AGENT_1,
        await advance(AGENT_1, await start(AGENT_1, script, C2)),
        N('rec'),
      );
      const b = await complete(AGENT_1, acked, { outcome: 'interrupted', dispositionId: D_PLAIN });
      expect(b.unacknowledgedComplianceNodeIds).toEqual([]);
      expect(b.acknowledgements.map((entry) => entry.nodeId)).toEqual([N('rec')]);
      // At readback, rec passed: only readback is listed.
      const atReadback = await toReadback(AGENT_1, await start(AGENT_1, script, C3));
      const c = await complete(AGENT_1, atReadback, {
        outcome: 'interrupted',
        dispositionId: D_PLAIN,
      });
      expect(c.unacknowledgedComplianceNodeIds).toEqual([N('readback')]);
      expect(c.endedAtNodeId).toBe(N('readback'));
      expect(c.acknowledgements).toEqual(atReadback.acknowledgements);
    });

    it('the body cannot carry server-set fields or a superseded outcome', async () => {
      const run = await advance(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      const base = { revision: run.revision, outcome: 'interrupted', dispositionId: D_PLAIN };
      for (const [label, body] of [
        ['unacknowledgedComplianceNodeIds', { ...base, unacknowledgedComplianceNodeIds: [] }],
        ['endedAtNodeId', { ...base, endedAtNodeId: N('close') }],
        ['outcome superseded', { ...base, outcome: 'superseded' }],
        ['an acknowledgement', { ...base, acknowledgedAt: '2026-10-08T10:00:00Z' }],
        ['a subject', { ...base, subject: 'x' }],
        ['an owner', { ...base, ownerUserId: USER_A_SUPERVISOR }],
        ['no dispositionId', { revision: run.revision, outcome: 'interrupted' }],
        ['a NUL in the note', { ...base, note: `a \u0000 ${SECRET}` }],
        ['an empty note', { ...base, note: '' }],
        ['a 10001-character note', { ...base, note: 'x'.repeat(10_001) }],
        ['a past dueAt', { ...base, followUp: { dueAt: instantAhead(-1) } }],
        ['a dueAt over 366 days ahead', { ...base, followUp: { dueAt: instantAhead(24 * 367) } }],
        ['a dueAt with an offset', { ...base, followUp: { dueAt: '2027-01-05T14:00:00+01:00' } }],
        ['a dueAt that is a date', { ...base, followUp: { dueAt: dayAhead(3) } }],
      ] as const) {
        const response = await completeRaw(AGENT_1, run.id, body);
        expect(response.status, label).toBe(400);
        expectError(response, 400, 'validation_failed');
        expect(response.text, `${label}: echoes the note`).not.toContain(SECRET);
      }
      expect400(
        await completeRaw(AGENT_1, run.id, { ...base, note: `a \u0000 b` }),
        /^note$/,
        'nul_character',
      );
      expect(await readRun(AGENT_1, run.id)).toEqual(run);
      expect(await activitiesOf(C1)).toEqual([]);
    });

    it('a stopped run completes as completed: endedAtNodeId is the branch, the stop reason kept', async () => {
      const script = await makeScript();
      await lockContactField('status', 'agent', 'none');
      let run = await advance(AGENT_1, await start(AGENT_1, script, C1));
      run = await ack(AGENT_1, run, N('rec'));
      run = await advance(AGENT_1, run);
      run = await advance(AGENT_1, run, { choiceKey: C('yes') });
      expect(run.status).toBe('stopped');
      const done = await complete(AGENT_1, run, { outcome: 'completed', dispositionId: D_PLAIN });
      expect(done).toMatchObject({
        status: 'completed',
        outcome: 'completed',
        stopReason: 'field_withheld',
        endedAtNodeId: N('cust'),
        unacknowledgedComplianceNodeIds: [],
      });
    });

    it('unknown, another programme’s, another tenant’s, inactive and deleted dispositions are ONE 409 disposition_not_live', async () => {
      const run = await advance(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      const bodies: string[] = [];
      for (const dispositionId of [NOWHERE, D_A2, D_B1, D_OFF, D_GONE]) {
        const response = await completeRaw(AGENT_1, run.id, {
          revision: run.revision,
          outcome: 'interrupted',
          dispositionId,
        });
        expectError(response, 409, 'disposition_not_live');
        bodies.push(response.text);
      }
      expect(new Set(bodies).size, 'the bodies tell the five apart').toBe(1);
      expect(await readRun(AGENT_1, run.id)).toEqual(run);
      expect(await activitiesOf(C1)).toEqual([]);
    });

    it('a missing note or followUp is 409 disposition_requirements_unmet naming the path', async () => {
      const run = await advance(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      const base = { revision: run.revision, outcome: 'interrupted' };
      expectDetail(
        await completeRaw(AGENT_1, run.id, { ...base, dispositionId: D_PTP }),
        409,
        'disposition_requirements_unmet',
        /^note$/,
      );
      expectDetail(
        await completeRaw(AGENT_1, run.id, { ...base, dispositionId: D_CB, note: 'x' }),
        409,
        'disposition_requirements_unmet',
        /^followUp$/,
      );
      expect(await readRun(AGENT_1, run.id)).toEqual(run);
    });

    it('an exact repeat is 200 and writes nothing, whatever its revision, even after the disposition is deactivated (R5); anything else is run_completed', async () => {
      const run = await toClose(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      const body = {
        revision: run.revision,
        outcome: 'completed',
        dispositionId: D_PTP,
        note: `Paid. ${SECRET}`,
      };
      const done = await complete(AGENT_1, run, body);
      const activities = await activitiesOf(C1);
      const before = await auditIds();
      for (const revision of [run.revision, done.revision, done.revision + 7]) {
        const again = await completeRaw(AGENT_1, run.id, { ...body, revision });
        expectStatus(again, 200, `the exact repeat with revision ${revision}`);
        expect(expectRun(again.body, 'repeat')).toEqual(done);
      }
      await observer.query('UPDATE disposition SET active = false WHERE id = $1', [D_PTP]);
      expectStatus(await completeRaw(AGENT_1, run.id, body), 200, 'the repeat after deactivation');
      expect(await activitiesOf(C1)).toEqual(activities);
      expect(await auditSince(before)).toEqual([]);

      for (const [label, changed] of [
        ['another note', { ...body, note: 'Different.' }],
        ['another outcome', { ...body, outcome: 'interrupted' }],
        ['another disposition', { ...body, dispositionId: D_PLAIN }],
        ['a followUp added', { ...body, followUp: { dueAt: instantAhead(5) } }],
      ] as const) {
        const response = await completeRaw(AGENT_1, run.id, changed);
        expect(response.status, label).toBe(409);
        expectError(response, 409, 'run_completed');
      }
      for (const response of [
        await advanceRaw(AGENT_1, run.id, { revision: done.revision }),
        await ackRaw(AGENT_1, run.id, { revision: done.revision, nodeId: N('rec'), locale: 'en' }),
        await answersRaw(AGENT_1, run.id, {
          revision: done.revision,
          nodeId: N('ptp'),
          values: { [K('count')]: 1 },
        }),
      ]) {
        expectError(response, 409, 'run_completed');
      }
      expect(await readRun(AGENT_1, run.id)).toEqual(done);
      expect(await activitiesOf(C1)).toEqual(activities);
    });

    it('(R12) all or nothing: a refused task insert leaves the run as it was and writes no call activity', async () => {
      const run = await toClose(AGENT_1, await start(AGENT_1, await makeScript(), C3));
      const rowBefore = await runRow(run.id);
      await observer.query(`CREATE FUNCTION t0114_refuse_task() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 't0114 planted fault'; END $$`);
      await observer.query(`CREATE TRIGGER t0114_refuse_task BEFORE INSERT ON activity FOR EACH ROW
        WHEN (NEW.type = 'task' AND NEW.contact_id = '${C3}'::uuid) EXECUTE FUNCTION t0114_refuse_task()`);
      let response: request.Response;
      try {
        response = await completeRaw(AGENT_1, run.id, {
          revision: run.revision,
          outcome: 'completed',
          dispositionId: D_CB,
          followUp: { dueAt: instantAhead(26) },
        });
      } finally {
        await observer.query('DROP TRIGGER IF EXISTS t0114_refuse_task ON activity');
        await observer.query('DROP FUNCTION IF EXISTS t0114_refuse_task()');
      }
      expect(
        response.status,
        'the completion must fail when its task cannot be written',
      ).toBeGreaterThanOrEqual(500);
      expect(response.text).not.toContain('t0114 planted fault');
      expect(await runRow(run.id), 'the run was completed without its task').toBe(rowBefore);
      expect(await activitiesOf(C3), 'a call activity outlived its failed completion').toEqual([]);
      // And with the fault gone, the same completion succeeds.
      const done = await complete(AGENT_1, run, {
        outcome: 'completed',
        dispositionId: D_CB,
        followUp: { dueAt: instantAhead(26) },
      });
      expect(done.followUpTaskId).toMatch(UUID);
    });

    it('(R6) parallel identical completions write one call activity, one task and one event, never a 5xx', async () => {
      const run = await toClose(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      const before = await auditIds();
      const body = {
        revision: run.revision,
        outcome: 'completed',
        dispositionId: D_CB,
        followUp: { dueAt: instantAhead(30) },
      };
      const responses = await Promise.all(
        Array.from({ length: 3 }, () => completeRaw(AGENT_1, run.id, body)),
      );
      for (const response of responses) {
        expect([200, 409], response.text.slice(0, 200)).toContain(response.status);
      }
      expect(responses.some((response) => response.status === 200)).toBe(true);
      expect((await activitiesOf(C1)).map((row) => row.type).sort()).toEqual(['call', 'task']);
      expect((await auditSince(before, run.id)).map((row) => row.action)).toEqual(['updated']);
    });

    it('errors in the published order: 404, 400, run_completed, stale_write, compliance_unacknowledged, disposition_not_live, requirements_unmet', async () => {
      const script = await makeScript();
      const run = await toPayq(AGENT_1, await start(AGENT_1, script, C1));
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      expectError(await completeRaw(AGENT_2, run.id, {}), 404, 'not_found');
      expectError(
        await completeRaw(AGENT_1, run.id, {
          revision: run.revision + 7,
          outcome: 'completed',
          dispositionId: NOWHERE,
        }),
        409,
        'stale_write',
      );
      expectError(
        await completeRaw(AGENT_1, run.id, {
          revision: run.revision,
          outcome: 'completed',
          dispositionId: NOWHERE,
        }),
        409,
        'compliance_unacknowledged',
      );
      expectError(
        await completeRaw(AGENT_1, run.id, {
          revision: run.revision,
          outcome: 'interrupted',
          dispositionId: NOWHERE,
        }),
        409,
        'disposition_not_live',
      );
      expectError(
        await completeRaw(AGENT_1, run.id, {
          revision: run.revision,
          outcome: 'interrupted',
          dispositionId: D_PTP,
        }),
        409,
        'disposition_requirements_unmet',
      );
      const done = await complete(AGENT_1, run, { outcome: 'interrupted', dispositionId: D_PLAIN });
      expectError(await completeRaw(AGENT_1, done.id, { revision: 0 }), 400, 'validation_failed');
      expectError(
        await completeRaw(AGENT_1, done.id, {
          revision: done.revision + 7,
          outcome: 'completed',
          dispositionId: NOWHERE,
        }),
        409,
        'run_completed',
      );
    });
  });

  // =========================================================================
  // 12. Audit: start, supersede and completion only, by name.
  // =========================================================================

  describe('audit', () => {
    afterEach(async () => {
      await resetWorld();
    });

    /** Nothing a run event may carry: keys, wording, answers, notes, the customer. */
    function expectClean(row: AuditRow) {
      const text = JSON.stringify(row);
      for (const key of RUN_KEYS) expect(text, `an event names ${key}`).not.toContain(key);
      for (const marker of [MARK, SECRET, 'salary_delayed', '2500000']) {
        expect(text, `an event carries ${marker}`).not.toContain(marker);
      }
      const contact = seededContact(C1);
      for (const form of [
        contact.displayName,
        contact.givenNames,
        contact.familyName,
        ...phoneForms(contact.phoneE164),
      ]) {
        expect(text, 'an event names the customer').not.toContain(form);
      }
      for (const field of fieldsOf(row))
        expect(RUN_AUDIT_NAMES as readonly string[]).toContain(field);
    }

    it('a full run writes exactly two events (R1): created naming the version, updated naming the outcome and ids; advance, acknowledge and answers write none', async () => {
      // The fixture script is made first: its own created/published events
      // (object_type script) are not the run's and must not be counted.
      const script = await makeScript();
      const before = await auditIds();
      const run = await start(AGENT_1, script, C1);
      const afterStart = await auditIds();
      await toClose(AGENT_1, run);
      expect(
        await auditSince(afterStart),
        'advance, acknowledge or answers wrote an event',
      ).toEqual([]);
      const fresh = await readRun(AGENT_1, run.id);
      const done = await complete(AGENT_1, fresh, {
        outcome: 'completed',
        dispositionId: D_CB,
        note: `Note ${SECRET}`,
        followUp: { dueAt: instantAhead(26) },
      });
      const events = await auditSince(before);
      expect(events.map((row) => [row.action, row.object_id])).toEqual([
        ['created', run.id],
        ['updated', run.id],
      ]);
      for (const row of events) {
        expect(row).toMatchObject({
          object_type: 'script_run',
          programme_id: PROGRAMME_A1,
          actor_kind: 'user',
          actor_user_id: USER_A_AGENT_1,
        });
        expectClean(row);
      }
      const [created, updated] = events;
      expect(fieldsOf(created)).toContain('versionId');
      expect(JSON.stringify(created)).toContain(run.versionId);
      expect(fieldsOf(updated)).toEqual(
        expect.arrayContaining(['outcome', 'dispositionId', 'activityId', 'followUpTaskId']),
      );
      for (const id of [D_CB, String(done.activityId), String(done.followUpTaskId)]) {
        expect(JSON.stringify(updated)).toContain(id);
      }
    });

    it('an interrupted completion names its outcome, never the node it ended on or the statements left unread', async () => {
      const run = await toReadback(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      const before = await auditIds();
      await complete(AGENT_1, run, { outcome: 'interrupted', dispositionId: D_PLAIN });
      const events = await auditSince(before, run.id);
      expect(events.map((row) => row.action)).toEqual(['updated']);
      const [event] = events;
      if (event === undefined) throw new Error('no completion event');
      expectClean(event);
      expect(JSON.stringify(event)).toContain('interrupted');
    });

    it('two runs that took different sides of the branch have the same events', async () => {
      const script = await makeScript();
      await setContactStatus(C1, 'customer');
      await setContactStatus(C2, null);
      const eventsOf = async (contactId: string) => {
        const before = await auditIds();
        const run = await toPayq(AGENT_1, await start(AGENT_1, script, contactId));
        await complete(AGENT_1, run, { outcome: 'interrupted', dispositionId: D_PLAIN });
        return (await auditSince(before)).map((row) => [row.action, fieldsOf(row)]);
      };
      const whenTrue = await eventsOf(C1);
      const whenFalse = await eventsOf(C2);
      expect(whenTrue).toHaveLength(2);
      expect(whenTrue).toEqual(whenFalse);
    });

    it('refused run writes write no event', async () => {
      const run = await advance(AGENT_1, await start(AGENT_1, await makeScript(), C1));
      await assign(TENANT_A, USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      const before = await auditIds();
      expectError(
        await completeRaw(AGENT_2, run.id, {
          revision: run.revision,
          outcome: 'interrupted',
          dispositionId: D_PLAIN,
        }),
        404,
        'not_found',
      );
      expectError(
        await completeRaw(AGENT_1, run.id, {
          revision: 0,
          outcome: 'interrupted',
          dispositionId: D_PLAIN,
        }),
        400,
        'validation_failed',
      );
      expectError(
        await completeRaw(AGENT_1, run.id, {
          revision: run.revision + 7,
          outcome: 'interrupted',
          dispositionId: D_PLAIN,
        }),
        409,
        'stale_write',
      );
      expectError(
        await completeRaw(AGENT_1, run.id, {
          revision: run.revision,
          outcome: 'completed',
          dispositionId: D_PLAIN,
        }),
        409,
        'compliance_unacknowledged',
      );
      expectError(
        await completeRaw(AGENT_1, run.id, {
          revision: run.revision,
          outcome: 'interrupted',
          dispositionId: D_OFF,
        }),
        409,
        'disposition_not_live',
      );
      expectError(await startRaw(AGENT_1, { scriptId: NOWHERE, contactId: C1 }), 404, 'not_found');
      expect(await auditSince(before)).toEqual([]);
    });
  });

  // =========================================================================
  // 13. Leaks: run error details, answers and notes in logs and spans.
  // =========================================================================

  describe('logs and spans', () => {
    afterEach(async () => {
      await resetWorld();
    });

    it('run error details, answers and notes reach no log line and no span', async () => {
      const script = await makeScript();
      const statuses: [string, number, number][] = [];
      const record = (label: string, expected: number, response: request.Response) => {
        statuses.push([label, expected, response.status]);
        return response;
      };
      const { telemetry, lines } = await captureEverything(async () => {
        let run = expectRun(
          record(
            'start',
            201,
            await startRaw(AGENT_1, { scriptId: script.scriptId, contactId: C1 }),
          ).body,
          'start',
        );
        run = expectRun(
          record('advance', 200, await advanceRaw(AGENT_1, run.id, { revision: run.revision }))
            .body,
          'advance',
        );
        record(
          'unacknowledged',
          409,
          await advanceRaw(AGENT_1, run.id, { revision: run.revision }),
        );
        record(
          'not on path',
          400,
          await ackRaw(AGENT_1, run.id, {
            revision: run.revision,
            nodeId: N('readback'),
            locale: 'en',
          }),
        );
        run = expectRun(
          record(
            'ack',
            200,
            await ackRaw(AGENT_1, run.id, {
              revision: run.revision,
              nodeId: N('rec'),
              locale: 'en',
            }),
          ).body,
          'ack',
        );
        run = expectRun(
          record('advance', 200, await advanceRaw(AGENT_1, run.id, { revision: run.revision }))
            .body,
          'advance',
        );
        run = expectRun(
          record(
            'choose',
            200,
            await advanceRaw(AGENT_1, run.id, { revision: run.revision, choiceKey: C('yes') }),
          ).body,
          'choose',
        );
        if (run.currentNodeId === N('intro')) {
          run = expectRun(
            record('intro', 200, await advanceRaw(AGENT_1, run.id, { revision: run.revision }))
              .body,
            'intro',
          );
        }
        run = expectRun(
          record(
            'ptp',
            200,
            await advanceRaw(AGENT_1, run.id, { revision: run.revision, choiceKey: C('ptp') }),
          ).body,
          'ptp',
        );
        run = expectRun(
          record(
            'memo',
            200,
            await answersRaw(AGENT_1, run.id, {
              revision: run.revision,
              nodeId: N('ptp'),
              values: { [K('memo')]: `Hardship ${SECRET}` },
            }),
          ).body,
          'memo',
        );
        record(
          'bad answer',
          400,
          await answersRaw(AGENT_1, run.id, {
            revision: run.revision,
            nodeId: N('ptp'),
            values: { [K('reason')]: SECRET },
          }),
        );
        record('incomplete', 409, await advanceRaw(AGENT_1, run.id, { revision: run.revision }));
        record(
          'not live',
          409,
          await completeRaw(AGENT_1, run.id, {
            revision: run.revision,
            outcome: 'interrupted',
            dispositionId: D_OFF,
            note: `N ${SECRET}`,
          }),
        );
        record(
          'unmet',
          409,
          await completeRaw(AGENT_1, run.id, {
            revision: run.revision,
            outcome: 'interrupted',
            dispositionId: D_CB,
            note: `N ${SECRET}`,
          }),
        );
        record(
          'complete',
          200,
          await completeRaw(AGENT_1, run.id, {
            revision: run.revision,
            outcome: 'interrupted',
            dispositionId: D_PTP,
            note: `Note ${SECRET}`,
          }),
        );
      });
      // The controls: every request did what it should.
      expect(statuses.map(([label, , got]) => [label, got])).toEqual(
        statuses.map(([label, want]) => [label, want]),
      );
      expect(
        telemetry.spans.length,
        'no spans were recorded at all — is telemetry wired?',
      ).toBeGreaterThan(0);
      for (const [haystack, what] of [
        [JSON.stringify(telemetry.spans), 'spans (attributes and events)'],
        [lines.join('\n'), 'logs (Nest logger, stdout, stderr, console, OTel log records)'],
      ] as const) {
        expect(haystack, `${what} carry an answer or a note`).not.toContain(SECRET);
        for (const key of RUN_KEYS) expect(haystack, `${what} carry ${key}`).not.toContain(key);
      }
    });
  });

  // =========================================================================
  // 14. Authentication and scope transport.
  // =========================================================================

  describe('authentication and scope transport', () => {
    const every = (
      contactId: string,
      scriptId: string,
      runId: string,
    ): [string, () => request.Test][] => [
      ['listContactScripts', () => request(server()).get(contactScriptsPath(contactId))],
      ['startScriptRun', () => request(server()).post(RUNS).send({ scriptId, contactId })],
      ['getScriptRun', () => request(server()).get(runPath(runId))],
      ['getScriptRunScript', () => request(server()).get(`${runPath(runId)}/script`)],
      [
        'advanceScriptRun',
        () =>
          request(server())
            .post(`${runPath(runId)}/advance`)
            .send({ revision: 1 }),
      ],
      [
        'acknowledgeScriptRunNode',
        () =>
          request(server())
            .post(`${runPath(runId)}/acknowledgements`)
            .send({ revision: 1, nodeId: N('rec'), locale: 'en' }),
      ],
      [
        'recordScriptRunAnswers',
        () =>
          request(server())
            .patch(`${runPath(runId)}/answers`)
            .send({ revision: 1, nodeId: N('ptp'), values: { [K('count')]: 1 } }),
      ],
      ['listScriptRunDispositions', () => request(server()).get(`${runPath(runId)}/dispositions`)],
      [
        'completeScriptRun',
        () =>
          request(server())
            .post(`${runPath(runId)}/complete`)
            .send({ revision: 1, outcome: 'interrupted', dispositionId: D_PLAIN }),
      ],
    ];

    it('every run operation is 401 not_authenticated, with no-store, without a usable session', async () => {
      const script = await makeScript();
      const run = await start(AGENT_1, script, C1);
      for (const [name, build] of every(C1, script.scriptId, run.id)) {
        const none = await build();
        expectError(none, 401, 'not_authenticated');
        const forged = await build().set('authorization', 'Bearer ksw_s1_not-a-real-session');
        expectError(forged, 401, 'not_authenticated');
        expect(forged.text, name).toBe(none.text);
      }
    });

    it('a scope header is 400 on every run operation, the same body in reach or out', async () => {
      const script = await makeScript();
      const mine = await start(AGENT_1, script, C1);
      const theirs = await start(SUPERVISOR, script, C2);
      const inReach = every(C1, script.scriptId, mine.id);
      const outOfReach = every(CA2, script.scriptId, theirs.id);
      for (const [header, value] of SCOPE_HEADERS) {
        for (const [index, [name, build]] of inReach.entries()) {
          const reachable = await build().set(AGENT_1).set(header, value);
          expectError(reachable, 400, 'validation_failed');
          const other = outOfReach[index];
          if (other === undefined) continue;
          const unreachable = await other[1]().set(AGENT_1).set(header, value);
          expectError(unreachable, 400, 'validation_failed');
          expect(unreachable.text, `${name} with ${header}`).toBe(reachable.text);
        }
      }
      expect(await readRun(AGENT_1, mine.id)).toEqual(mine);
    });
  });
});
