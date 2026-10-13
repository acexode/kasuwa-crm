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
  SEED_CONTACTS,
  SEED_DEALS,
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0108, the deals API and the gated move (P06; Agent 3).
 * Written by QA for the lead before the build (D-L23, D-L25), from the
 * contract and the decisions, not from an implementation.
 *
 * Sources: team/tasks/T-0108-deals-api.md; docs/api/records.openapi.yaml
 * (listDeals, createDeal, getDeal, updateDeal, moveDeal and their schemas,
 * committed by T-0105); D-L88 (the plan and rights), D-L113 (T-0105 rulings),
 * D-L115 (review rulings: no portal reads, own-as-none, the four currencies,
 * reassignment audit, literal wildcards, non-uuid ids are the 404), D-L117 and
 * D-L120 (T-0106: what the schema leaves to the API), D-L121 (money is bigint,
 * 0 to 18 nines, a fraction refused), D-L67 (owner membership), D-L72 (audit
 * names, not values), D-L102 (changed fields only), D-P18 (agent rights).
 * The T-0082 (activities-api) and T-0056 (leads-api) suites are the prior art
 * for the harness, and pipeline-tables (T-0106) for planting pipelines; their
 * helpers are copied here, never imported (importing a test file registers its
 * tests).
 *
 * Fixtures: packages/db/src/fixtures.ts only, plus rows planted here by
 * `kasuwa_migrator` (BYPASSRLS, never serves) with ids in this suite's own
 * range (`11111111-0000-4000-8000-0108xxxxxxxx`). Every planted text is
 * synthetic. If the contract and this file disagree on something the contract
 * states, the contract wins and this file is the defect: say so in the
 * report, do not edit it.
 *
 * ==========================================================================
 * PINNED INTERFACES (from the contract; the builder honours these exactly)
 * ==========================================================================
 *
 * ROUTES.
 *   listDeals   GET   /api/v1/pipelines/{pipelineId}/deals
 *   createDeal  POST  /api/v1/pipelines/{pipelineId}/deals   -> 201 Deal
 *   getDeal     GET   /api/v1/deals/{dealId}                 -> 200 Deal
 *   updateDeal  PATCH /api/v1/deals/{dealId}                 -> 200 Deal
 *   moveDeal    POST  /api/v1/deals/{dealId}/move            -> 200 Deal
 *   Every answer, errors included, carries `Cache-Control: no-store`. Each
 *   200/201 body matches the operation's own response schema; Deal is
 *   closed, withheld fields are OMITTED and named in `withheldFields`, and a
 *   withheld `amount`, `ownerUserId`, `primaryContactId` or `accountId` also
 *   omits `weightedAmount`, `owner`, `contact` or `account`.
 *
 * BODIES (closed; anything else is 400 validation_failed).
 *   CreateDealRequest  name (required), amount, expectedCloseDate,
 *                      ownerUserId, primaryContactId, accountId, nextStep.
 *   UpdateDealRequest  version (required) plus at least one of the same
 *                      seven. Never stageId, pipelineId, programmeId, a
 *                      timestamp, checks or any server-owned key.
 *   MoveDealRequest    version, toStageId (required), fields (the target
 *                      stage's field requirements: amount, expectedCloseDate,
 *                      nextStep, primaryContactId, accountId; values, never
 *                      null), checks (ids of the target stage's check
 *                      requirements). Never checkedBy, checkedAt or a stage
 *                      timestamp.
 *   DealMoney          { amountMinor: '^(0|[1-9][0-9]{0,17})$' as a STRING,
 *                      currency: NGN | GHS | KES | ZAR }. Both or neither.
 *
 * ERRORS (shared admin `Error` envelope; `code` is what clients switch on).
 *   404 not_found             ONE body, byte for byte, for every pipeline and
 *                             deal operation: no such id, another tenant's,
 *                             another programme's, a non-uuid id (D-L115).
 *   403 not_permitted         action; details owner_not_self at ownerUserId;
 *                             details field_not_editable.
 *   400 validation_failed     details unknown_reference, unknown_currency,
 *                             not_a_requirement, field_withheld,
 *                             invalid_cursor, invalid_window, window_too_long.
 *   409 stale_write, 409 transition_not_allowed.
 *   422 requirements_unmet    details `{ path: requirements.<id>, code:
 *                             requirement_unmet }`, ids only.
 *   Order: create 404, 403, 400; update 404, 403, 400, 409; move 404, 403
 *   (action, then field_not_editable on the keys sent), 400, 403
 *   field_not_editable (a required field), 409 stale_write, 409
 *   transition_not_allowed, 422.
 *
 * RIGHTS (x-kasuwa-rights; the set held in the DEAL'S programme decides).
 *   read: every staff set. create: agent (owning it), team_lead,
 *   programme_manager, admin, the tenant-admin flag. edit and move: agent own
 *   deals only, the others any; a won or lost deal is edited or moved OUT
 *   only with write-any. reassign: team_lead, programme_manager, admin.
 *   Owner, contact and account must be in the deal's programme (D-L67).
 *
 * MONEY ON THE WIRE: always a JSON string, exact to 18 digits, both ways.
 * AUDIT: audit_event, object_type `deal`, one event per successful write.
 * FLAGS: the five operations are `x-kasuwa-implemented: true`.
 *
 * ==========================================================================
 * RULINGS where the contract is silent or ambiguous (accepted by the lead)
 * ==========================================================================
 *
 * R1  client_portal gets the one 404 on all five operations, writes
 *     included: it reads no pipeline or deal (D-L115), and 403 is never a
 *     substitute for 404. (createDeal's older "client_portal 403" sentence is
 *     outranked.) qa_analyst reads (200) and writes nothing (403).
 * R2  The caller's own id in any letter case is "self"; owners are stored and
 *     served in canonical lower case.
 * R3  Detail paths: a malformed amountMinor is at `amount.amountMinor`
 *     (create, update) or `fields.amount.amountMinor` (move); an unknown
 *     currency is `unknown_currency` at `amount.currency` /
 *     `fields.amount.currency`; an unknown reference is at the body key. The
 *     detail CODE for a malformed amountMinor is the builder's.
 * R4  A non-uuid `toStageId` is the same `unknown_reference` body as any
 *     other id that is not a stage of the deal's pipeline.
 * R5  `not_a_requirement` in `checks` is at a path beginning `checks`; a
 *     check of another stage, pipeline, programme or tenant, a field
 *     requirement's id and an invented id give one byte-identical body.
 * R6  Re-sending a check already recorded on the deal is accepted and never
 *     re-attributes it: who and when stay those of the first tick.
 * R7  A required field's `field_not_editable` is at the field's wire name or
 *     at `fields.<name>`; for a field the mover cannot READ, the bodies for a
 *     filled and an empty field are byte-identical.
 * R8  The audit `object_label` is the deal id, never its name. A create is
 *     action `created`; an update and a move are `updated` (the audit action
 *     check has no `moved`, and T-0108 has no migration).
 * R9  A move's audit `changes` hold exactly one
 *     `{ field: 'stageId', before: <from>, after: <to>, redacted: false }`,
 *     each filled field by name, `checks` by name when a check was newly
 *     ticked, and optionally `stageEnteredAt` and `closedAt` by name. Nothing
 *     else, and no value. "By name" is `{ before: null, after: null,
 *     redacted: true }`.
 * R10 A create's audit names every body key sent with a non-null value, by
 *     name; `ownerUserId` may instead carry `{ before: null, after: <owner
 *     id>, redacted: false }`. Only the seven writable field names appear.
 * R11 An update's audit names exactly the fields whose stored value changed;
 *     a field sent with its current value is not named. A reassignment
 *     records the before and after owner ids (lower case, `null` for none).
 * R12 A refused write writes nothing: no row change, no check, no audit. A
 *     successful move advances `version`, and the returned version is the
 *     stored one.
 * R13 `name` is never withheld, even under a `none` grant.
 * R14 Of several concurrent writes carrying one version, exactly one
 *     succeeds; the rest are `409 stale_write`.
 * R15 A body that is not a JSON object, or carries `__proto__` or
 *     `constructor`, is 400, never 500.
 * R16 A team lead creating without `ownerUserId` owns the deal, as an agent
 *     does; `ownerUserId: null` (with reassign) creates it unowned.
 * R17 Leaving won or lost without write-any is 403, decided before the body.
 * R18 listDeals ignores an unknown `programmeId` query parameter.
 * R19 An amount is a JSON string in every response, judged on the raw text.
 * R20 On a move, the required-field 403 comes before both 409s, even when
 *     the pair is not on the allow-list (the published order).
 * R21 An agent creating while `ownerUserId` is withheld from them: omitting
 *     it makes the agent the owner; sending it, even as their own id, is
 *     `403 field_not_editable` at `ownerUserId`.
 * R22 A listDeals cursor naming a deal outside the caller's scope (another
 *     pipeline, programme or tenant, or no longer selected by the filters) is
 *     `400 invalid_cursor`, one body (DealCursor), unlike the general
 *     `Cursor`'s empty page.
 *
 * ==========================================================================
 * THE BUILDER'S (not asserted)
 * ==========================================================================
 * Cursor encoding beyond "opaque, id only"; detail paths for `limit`, `sort`,
 * `version` and malformed dates (status and envelope only); whether a no-op
 * update bumps `version`; whether the server reads its clock from Node or
 * Postgres (five minutes of skew tolerated); how rights are named in
 * @kasuwa/permissions.
 *
 * ==========================================================================
 * OTHER SUITES. The contract suites, pipeline-tables, the audit suites and
 * tests/acceptance/tenancy must still pass. records-contract-pipeline's
 * flag assertion was edited by the lead for T-0108 on this branch (the five
 * deal operations true; the three pipeline reads unchanged).
 *
 * D-L23: on main the five routes do not exist and the flags are false. The
 * pipeline tables do exist (T-0106), so plants succeed on main. Every test
 * except the ones titled "(self-check)" begins with a request that must
 * succeed (a control), or reads a flag, and so fails on main for that reason.
 * Self-checks test this file's own helpers and pass at commit time.
 *
 * Writes: the suite reseeds before and after, and after every test.
 */

// ---------------------------------------------------------------------------
// Constants and fixtures (packages/db/src/fixtures.ts, never a second set).
// ---------------------------------------------------------------------------

const PIPELINES = '/api/v1/pipelines';
const DEALS = '/api/v1/deals';

/** This suite's id range: `0108` marks T-0108. Tails are hex. */
const id108 = (tail: string) => `11111111-0000-4000-8000-0108${tail.padStart(8, '0')}`;
/** Never a real row. */
const NOWHERE = id108('0ffffff0');
/** A deal id in this suite's range. */
const D = (tail: string) => id108(`e${tail.padStart(7, '0')}`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The server may read its clock from Postgres in a container. */
const SKEW = 5 * MINUTE;

const EIGHTEEN_NINES = '999999999999999999';

const AGENT_1 = asUser(TENANT_A, USER_A_AGENT_1);
const AGENT_2 = asUser(TENANT_A, USER_A_AGENT_2);
/** A non-tenant-admin user given whatever set a test needs in A1. */
const ACTOR = asUser(TENANT_A, USER_A_NO_PROGRAMME);
const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);
const TENANT_B_ADMIN = asUser(TENANT_B, USER_B_AGENT_1);

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

/** Unique per run so a probe never matches an earlier run's text. */
const RUN = Date.now().toString(36);

const iso = (ms: number) => new Date(ms).toISOString();

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function displayNameOf(userId: string): string {
  for (const tenant of SEED_TENANTS) {
    const user = tenant.users.find((candidate) => candidate.id === userId);
    if (user !== undefined) return user.displayName;
  }
  throw new Error(`Fixture drift: no seeded user ${userId}`);
}

function contactsIn(programmeId: string) {
  return SEED_CONTACTS.filter((contact) => contact.programmeId === programmeId);
}

function accountIn(programmeId: string) {
  return must(
    SEED_ACCOUNTS.find((account) => account.programmeId === programmeId),
    `no seeded account in ${programmeId}`,
  );
}

function permissionSet(tenantId: string, key: string): string {
  return must(
    SEED_PERMISSION_SETS.find((set) => set.tenantId === tenantId && set.key === key),
    `no seeded permission set '${key}'`,
  ).id;
}

const SEEDED_DEAL = must(SEED_DEALS[0], 'no seeded deal');

// ---------------------------------------------------------------------------
// The planted pipelines: the contract's getPipeline example, with synthetic
// labels, fixed ids, and two extra field requirements on Contract (nextStep
// and accountId) so every requirement field is exercised.
// ---------------------------------------------------------------------------

type StageKind = 'open' | 'won' | 'lost';

interface TemplateStage {
  name: string;
  kind: StageKind;
  probabilityBp: number;
  rottingAfterDays: number | null;
}

/** The contract's getPipeline example, stage by stage (self-checked against the YAML). */
const TEMPLATE: readonly TemplateStage[] = [
  { name: 'Qualified', kind: 'open', probabilityBp: 1000, rottingAfterDays: 14 },
  { name: 'Discovery', kind: 'open', probabilityBp: 2500, rottingAfterDays: 14 },
  { name: 'Proposal', kind: 'open', probabilityBp: 5000, rottingAfterDays: 14 },
  { name: 'Negotiation', kind: 'open', probabilityBp: 7000, rottingAfterDays: 14 },
  { name: 'Contract', kind: 'open', probabilityBp: 9000, rottingAfterDays: 21 },
  { name: 'Won', kind: 'won', probabilityBp: 10000, rottingAfterDays: null },
  { name: 'Lost', kind: 'lost', probabilityBp: 0, rottingAfterDays: null },
];

/** A marker in every requirement label, so a body that leaks one is caught. */
const LABEL_MARK = 'zqvlabel';

interface Requirement {
  id: string;
  stageId: string;
  kind: 'field' | 'check';
  position: number;
  /** api_name (snake_case), as 0036 stores it (T-0106 R2). */
  field: string | null;
  label: string | null;
}

interface PipelineFixture {
  tenantId: string;
  programmeId: string;
  member: string;
  currency: string;
  contact: string;
  contactName: string;
  account: string;
  accountName: string;
  P: string;
  S0: string;
  S1: string;
  S2: string;
  S3: string;
  S4: string;
  SW: string;
  SL: string;
  stageIds: string[];
  /** Proposal: check. */
  RC_PROP: string;
  /** Negotiation: amount, expectedCloseDate, check. */
  RF_AMT: string;
  RF_ECD: string;
  RC_QUOTE: string;
  /** Contract: primaryContactId, nextStep, accountId, check. */
  RF_PC: string;
  RF_NS: string;
  RF_ACC: string;
  RC_PO: string;
  requirements: Requirement[];
  transitions: (readonly [string, string])[];
}

/** The contract's seed rule, over stages listed by position. */
function seedPairs(
  stages: readonly { id: string; kind: StageKind }[],
): (readonly [string, string])[] {
  const opens = stages.filter((stage) => stage.kind === 'open');
  const won = must(
    stages.find((stage) => stage.kind === 'won'),
    'no won stage',
  );
  const lost = must(
    stages.find((stage) => stage.kind === 'lost'),
    'no lost stage',
  );
  const pairs: (readonly [string, string])[] = [];
  opens.forEach((open, index) => {
    const next = opens[index + 1];
    if (next !== undefined) pairs.push([open.id, next.id]);
    for (const earlier of opens.slice(0, index)) pairs.push([open.id, earlier.id]);
    if (index === opens.length - 1) pairs.push([open.id, won.id]);
    pairs.push([open.id, lost.id]);
  });
  for (const open of opens) pairs.push([won.id, open.id]);
  for (const open of opens) pairs.push([lost.id, open.id]);
  return pairs;
}

function pipelineFixture(
  n: string,
  tenantId: string,
  programmeId: string,
  member: string,
  currency: string,
): PipelineFixture {
  const stageIds = TEMPLATE.map((_stage, index) => id108(`${n}b00000${index}`));
  const at = (index: number) => must(stageIds[index], `stage ${index}`);
  const req = (k: number) => id108(`${n}d00000${k}`);
  const requirements: Requirement[] = [
    { id: req(1), stageId: at(2), kind: 'check', position: 0, field: null, label: `T-0108 ${LABEL_MARK} budget range agreed` },
    { id: req(2), stageId: at(3), kind: 'field', position: 0, field: 'amount', label: null },
    { id: req(3), stageId: at(3), kind: 'field', position: 1, field: 'expected_close_date', label: null },
    { id: req(4), stageId: at(3), kind: 'check', position: 2, field: null, label: `T-0108 ${LABEL_MARK} quote sent` },
    { id: req(5), stageId: at(4), kind: 'field', position: 0, field: 'primary_contact_id', label: null },
    { id: req(6), stageId: at(4), kind: 'field', position: 1, field: 'next_step', label: null },
    { id: req(7), stageId: at(4), kind: 'field', position: 2, field: 'account_id', label: null },
    { id: req(8), stageId: at(4), kind: 'check', position: 3, field: null, label: `T-0108 ${LABEL_MARK} order received` },
  ];
  const contact = must(contactsIn(programmeId)[0], `no contact in ${programmeId}`);
  const account = accountIn(programmeId);
  return {
    tenantId,
    programmeId,
    member,
    currency,
    contact: contact.id,
    contactName: contact.displayName,
    account: account.id,
    accountName: account.name,
    P: id108(`${n}a000001`),
    S0: at(0),
    S1: at(1),
    S2: at(2),
    S3: at(3),
    S4: at(4),
    SW: at(5),
    SL: at(6),
    stageIds,
    RC_PROP: req(1),
    RF_AMT: req(2),
    RF_ECD: req(3),
    RC_QUOTE: req(4),
    RF_PC: req(5),
    RF_NS: req(6),
    RF_ACC: req(7),
    RC_PO: req(8),
    requirements,
    transitions: seedPairs(
      TEMPLATE.map((stage, index) => ({ id: at(index), kind: stage.kind })),
    ),
  };
}

/** The main pipeline, in A1. */
const FA1 = pipelineFixture('1', TENANT_A, PROGRAMME_A1, USER_A_AGENT_1, 'NGN');
/** A second pipeline in the SAME programme. */
const FA1B = pipelineFixture('4', TENANT_A, PROGRAMME_A1, USER_A_AGENT_1, 'NGN');
/** A2: outside agent 1's reach. */
const FA2 = pipelineFixture('2', TENANT_A, PROGRAMME_A2, USER_A_AGENT_2, 'GHS');
/** Tenant B. */
const FB1 = pipelineFixture('3', TENANT_B, PROGRAMME_B1, USER_B_AGENT_1, 'KES');
const FIXTURES = [FA1, FA1B, FA2, FB1] as const;

/** A1's second and third seeded contacts (the first is FA1.contact). */
const A1_CONTACT_2 = must(contactsIn(PROGRAMME_A1)[1], 'second A1 contact');
const A2_CONTACT = must(contactsIn(PROGRAMME_A2)[0], 'A2 contact');
const B1_CONTACT = must(contactsIn(PROGRAMME_B1)[0], 'B1 contact');

// ---------------------------------------------------------------------------
// Money: an independent half-even computation in BigInt (never a float).
// ---------------------------------------------------------------------------

function halfEvenWeighted(amountMinor: string, probabilityBp: number): string {
  const product = BigInt(amountMinor) * BigInt(probabilityBp);
  const quotient = product / 10000n;
  const twice = (product % 10000n) * 2n;
  if (twice > 10000n) return (quotient + 1n).toString();
  if (twice < 10000n) return quotient.toString();
  return (quotient % 2n === 0n ? quotient : quotient + 1n).toString();
}

// ---------------------------------------------------------------------------
// A small JSON-Schema checker over the published YAML (no new dependency).
// Copied from the T-0082 suite, plus `pattern`, `maxItems`, `uniqueItems`
// and the `date` format.
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
  'date-time': DATE_TIME,
  date: DATE,
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
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format !== undefined && !format.test(value)) {
      errors.push(`${path}: not a valid ${String(schema.format)}`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
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
    if (schema.uniqueItems === true) {
      const seen = value.map((item) => JSON.stringify(item));
      if (new Set(seen).size !== seen.length) errors.push(`${path}: items repeat`);
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

function schemaErrors(schema: Json, value: unknown, where: string): string[] {
  const errors: string[] = [];
  check(schema, SPEC_PATH, value, where, errors);
  return errors;
}

interface SpecOperation {
  path: string;
  method: string;
  op: Json;
}

function requireOperation(operationId: string): SpecOperation {
  const paths = ((loadDoc(SPEC_PATH) as Json).paths ?? {}) as Record<string, Json>;
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (typeof op === 'object' && op !== null && (op as Json).operationId === operationId) {
        return { path, method, op: op as Json };
      }
    }
  }
  throw new Error(`records.openapi.yaml has no operation ${operationId}`);
}

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

// ---------------------------------------------------------------------------
// Response checks.
// ---------------------------------------------------------------------------

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

interface Detail {
  path: string;
  code: string;
}

function detailsOf(body: unknown): Detail[] {
  const details = (body as Json | null)?.details;
  return Array.isArray(details) ? (details as Detail[]) : [];
}

/** A 400 whose details carry `code` at `path`. */
function expectDetail(response: request.Response, path: string, code: string, where: string) {
  const body = expectError(response, 400, 'validation_failed');
  expect(
    detailsOf(body).map((detail) => `${detail.path}:${detail.code}`),
    `${where}: details`,
  ).toContain(`${path}:${code}`);
  return body;
}

/** A 403 whose details carry `code` at one of `paths`. */
function expectForbidden(
  response: request.Response,
  code: string,
  paths: readonly string[],
  where: string,
): Json {
  const body = expectError(response, 403, 'not_permitted');
  const found = detailsOf(body).some(
    (detail) => detail.code === code && paths.includes(detail.path),
  );
  expect(found, `${where}: 403 details ${JSON.stringify(body.details)} lack ${code} at ${paths.join(' or ')}`).toBe(true);
  return body;
}

function expectStatus(response: request.Response, status: number, where: string): void {
  expect(response.status, `${where}: ${JSON.stringify(response.body)}`).toBe(status);
}

function expectNoStore(response: request.Response, where: string): void {
  expect(
    String(response.headers['cache-control'] ?? ''),
    `${where}: Cache-Control must be no-store`,
  ).toMatch(/(^|[\s,])no-store($|[\s,])/);
}

function expectNoTotals(response: request.Response, where: string): void {
  const headers = Object.keys(response.headers).filter((name) => /total|count/i.test(name));
  expect(headers, `${where}: a response header carries a total`).toEqual([]);
}

/** Deal fields field security may withhold. */
const WITHHOLDABLE = [
  'amount',
  'expectedCloseDate',
  'ownerUserId',
  'primaryContactId',
  'accountId',
  'nextStep',
] as const;
/** [derived, base]: the derived key is present exactly when the base is. */
const DERIVED: readonly (readonly [string, string])[] = [
  ['weightedAmount', 'amount'],
  ['owner', 'ownerUserId'],
  ['contact', 'primaryContactId'],
  ['account', 'accountId'],
];
const WRITABLE = new Set([
  'name',
  'amount',
  'expectedCloseDate',
  'ownerUserId',
  'primaryContactId',
  'accountId',
  'nextStep',
]);

/** One Deal, against the Deal schema and the contract's prose rules. */
function dealProblems(value: unknown, where: string): string[] {
  const problems = schemaErrors({ $ref: '#/components/schemas/Deal' }, value, where);
  if (jsonType(value) !== 'object') return [...problems, `${where}: not an object`];
  const deal = value as Json;
  const withheld = (Array.isArray(deal.withheldFields) ? deal.withheldFields : []) as string[];
  for (const key of WITHHOLDABLE) {
    if (key in deal === withheld.includes(key)) {
      problems.push(`${where}: ${key} must be present or listed in withheldFields, exactly one`);
    }
  }
  for (const [derived, base] of DERIVED) {
    if (derived in deal !== base in deal) {
      problems.push(`${where}: ${derived} is present exactly when ${base} is`);
    } else if (derived in deal && (deal[derived] === null) !== (deal[base] === null)) {
      problems.push(`${where}: ${derived} is null exactly when ${base} is`);
    }
  }
  const idOf = (key: string) => (deal[key] as Json | null | undefined)?.id;
  if (deal.owner && idOf('owner') !== deal.ownerUserId) problems.push(`${where}: owner.id`);
  if (deal.contact && idOf('contact') !== deal.primaryContactId) problems.push(`${where}: contact.id`);
  if (deal.account && idOf('account') !== deal.accountId) problems.push(`${where}: account.id`);
  const amount = deal.amount as Json | null | undefined;
  const weighted = deal.weightedAmount as Json | null | undefined;
  if (amount && weighted && amount.currency !== weighted.currency) {
    problems.push(`${where}: weightedAmount is in another currency`);
  }
  if ((deal.closedAt === null) !== (deal.rotting !== null)) {
    problems.push(`${where}: rotting is null exactly when the deal is closed`);
  }
  if ('name' in deal && withheld.includes('name' as never)) problems.push(`${where}: name withheld`);
  return problems;
}

/** A Deal response, through the operation's own schema and the prose rules. */
function expectDeal(
  response: request.Response,
  operationId: 'createDeal' | 'getDeal' | 'updateDeal' | 'moveDeal',
  status: number,
  where: string,
): Json {
  expectStatus(response, status, where);
  expectNoStore(response, where);
  expect(
    schemaErrors(responseSchemaOf(operationId, String(status)), response.body, where),
    `${where} does not match the ${operationId} ${status} schema`,
  ).toEqual([]);
  expect(dealProblems(response.body, where), `${where}: Deal`).toEqual([]);
  return response.body as Json;
}

interface Page {
  data: Json[];
  nextCursor: string | null;
}

function pageOf(value: unknown): Page {
  const page = (value ?? {}) as { data?: unknown; nextCursor?: unknown };
  return {
    data: Array.isArray(page.data) ? (page.data as Json[]) : [],
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
  };
}

function pageProblems(value: unknown, where: string): string[] {
  const problems = schemaErrors(responseSchemaOf('listDeals', '200'), value, where);
  const keys = Object.keys((value ?? {}) as Json).sort();
  if (keys.join() !== 'data,nextCursor') problems.push(`${where}: page keys ${keys.join()}`);
  pageOf(value).data.forEach((deal, index) =>
    problems.push(...dealProblems(deal, `${where}.data[${index}]`)),
  );
  return problems;
}

/** A deal's checks as [requirementId, checker id, checker name, checkedAt ms], order-free. */
function checksSummary(value: unknown): [string, string, unknown, number][] {
  const checks = Array.isArray(value) ? (value as Json[]) : [];
  return checks
    .map((item): [string, string, unknown, number] => [
      String(item.requirementId),
      String((item.checkedBy as Json | undefined)?.id),
      (item.checkedBy as Json | undefined)?.displayName,
      Date.parse(String(item.checkedAt)),
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Wire text of a response, for "never in the body" checks. */
const textOf = (response: request.Response) => response.text;

// ---------------------------------------------------------------------------
// Reading a cursor every way this suite can, to look inside it (D-L80).
// ---------------------------------------------------------------------------

function decodeOnce(text: string): string[] {
  const out: string[] = [];
  try {
    out.push(decodeURIComponent(text));
  } catch {
    // not URI-encoded
  }
  for (const encoding of ['base64url', 'base64'] as const) {
    out.push(Buffer.from(text, encoding).toString('utf8'));
    out.push(Buffer.from(text, encoding).toString('latin1'));
  }
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    out.push(Buffer.from(text, 'hex').toString('utf8'));
  }
  return out;
}

function cursorReadings(cursor: string): string[] {
  const first = [cursor, ...decodeOnce(cursor)];
  const second = first.flatMap((text) =>
    /^[A-Za-z0-9_\-+/=%]+$/.test(text) ? decodeOnce(text) : [],
  );
  return [...first, ...second].map((text) => text.toLowerCase());
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

/** Database text an error BODY must never carry. */
const DATABASE_TEXT_IN_BODIES = [
  'Failing row contains',
  'violates',
  'constraint',
  '23505',
  '23514',
  '22P02',
  '22003',
  'bigint',
  'BigInt',
];

// ---------------------------------------------------------------------------

describe('acceptance: the deals API and the gated move (T-0108)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants rows and observes them; never serves. */
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

  beforeEach(async () => {
    for (const fixture of FIXTURES) await plantPipeline(fixture);
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
  const enc = (id: string) => encodeURIComponent(id);
  const listDeals = (headers: Headers, pipelineId: string, params: Params = []) =>
    request(server()).get(withQuery(`${PIPELINES}/${enc(pipelineId)}/deals`, params)).set(headers);
  const createDeal = (headers: Headers, pipelineId: string, body: unknown) =>
    request(server())
      .post(`${PIPELINES}/${enc(pipelineId)}/deals`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  const getDeal = (headers: Headers, id: string) =>
    request(server()).get(`${DEALS}/${enc(id)}`).set(headers);
  const updateDeal = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .patch(`${DEALS}/${enc(id)}`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  const moveDeal = (headers: Headers, id: string, body: unknown) =>
    request(server())
      .post(`${DEALS}/${enc(id)}/move`)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  /** A raw body, for text JSON.stringify cannot produce (a `__proto__` key). */
  const sendRaw = (method: 'post' | 'patch', path: string, headers: Headers, raw: string) =>
    request(server())[method](path).set(headers).set('Content-Type', 'application/json').send(raw);

  /**
   * The control most tests open with: getDeal serves the seeded deal to its
   * owner. On main the route does not exist and this is a 404.
   */
  async function control(): Promise<void> {
    const response = await getDeal(AGENT_1, SEEDED_DEAL.id);
    expectStatus(response, 200, 'control: getDeal serves the seeded deal');
  }

  // --- observer helpers ----------------------------------------------------

  async function plantPipeline(f: PipelineFixture): Promise<void> {
    const client = await observer.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO pipeline (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)',
        [f.P, f.tenantId, f.programmeId, `T-0108 fixture pipeline ${f.P.slice(-9)}`],
      );
      for (const [index, stage] of TEMPLATE.entries()) {
        await client.query(
          `INSERT INTO pipeline_stage (id, tenant_id, programme_id, pipeline_id, name, kind, position,
                                       probability_bp, rotting_after_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            f.stageIds[index],
            f.tenantId,
            f.programmeId,
            f.P,
            `T-0108 ${stage.name}`,
            stage.kind,
            index,
            stage.probabilityBp,
            stage.rottingAfterDays,
          ],
        );
      }
      for (const [index, [from, to]] of f.transitions.entries()) {
        await client.query(
          `INSERT INTO pipeline_stage_transition
             (id, tenant_id, programme_id, pipeline_id, from_stage_id, to_stage_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id108(`${f.P.slice(28, 29)}c0000${index.toString(16).padStart(2, '0')}`),
            f.tenantId,
            f.programmeId,
            f.P,
            from,
            to,
          ],
        );
      }
      for (const requirement of f.requirements) {
        await client.query(
          `INSERT INTO pipeline_stage_requirement
             (id, tenant_id, programme_id, pipeline_id, stage_id, kind, position, field, label)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            requirement.id,
            f.tenantId,
            f.programmeId,
            f.P,
            requirement.stageId,
            requirement.kind,
            requirement.position,
            requirement.field,
            requirement.label,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  interface DealPlant {
    id: string;
    f?: PipelineFixture;
    /** Stage position in TEMPLATE (0..6). Default 0. */
    at?: number;
    name?: string;
    amountMinor?: string | null;
    currency?: string | null;
    expectedCloseDate?: string | null;
    owner?: string | null;
    contact?: string | null;
    account?: string | null;
    nextStep?: string | null;
    enteredAt?: number;
    closedAt?: number | null;
    updatedAt?: number;
    createdAt?: number;
  }

  async function plantDeal(row: DealPlant): Promise<string> {
    const f = row.f ?? FA1;
    const at = row.at ?? 0;
    const stage = must(TEMPLATE[at], `stage ${at}`);
    const enteredAt = row.enteredAt ?? Date.now() - HOUR;
    const closedAt =
      row.closedAt !== undefined ? row.closedAt : stage.kind === 'open' ? null : enteredAt;
    const amountMinor = row.amountMinor !== undefined ? row.amountMinor : '250000';
    const currency =
      row.currency !== undefined ? row.currency : amountMinor === null ? null : f.currency;
    const updatedAt = row.updatedAt ?? enteredAt;
    await observer.query(
      `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name, amount_minor,
                         currency, expected_close_date, owner_user_id, primary_contact_id,
                         account_id, next_step, stage_entered_at, closed_at, created_at,
                         updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9::date, $10, $11, $12, $13,
               $14::timestamptz, $15::timestamptz, $16::timestamptz, $17::timestamptz)`,
      [
        row.id,
        f.tenantId,
        f.programmeId,
        f.P,
        f.stageIds[at],
        row.name ?? `T-0108 planted ${row.id.slice(-7)}`,
        amountMinor,
        currency,
        row.expectedCloseDate !== undefined ? row.expectedCloseDate : '2031-03-01',
        row.owner !== undefined ? row.owner : f.member,
        row.contact ?? null,
        row.account ?? null,
        row.nextStep ?? null,
        iso(enteredAt),
        closedAt === null ? null : iso(closedAt),
        iso(row.createdAt ?? enteredAt),
        iso(updatedAt),
      ],
    );
    return row.id;
  }

  async function plantCheck(
    dealId: string,
    requirementId: string,
    by: string,
    at: number,
    f: PipelineFixture = FA1,
  ): Promise<void> {
    await observer.query(
      `INSERT INTO deal_requirement_check
         (id, tenant_id, programme_id, pipeline_id, deal_id, requirement_id, checked_by_user_id,
          checked_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [f.tenantId, f.programmeId, f.P, dealId, requirementId, by, iso(at)],
    );
  }

  async function dealRow(id: string): Promise<Json | null> {
    const result = await observer.query<Json>(
      `SELECT d.*, d.amount_minor::text AS amount_text, d.expected_close_date::text AS ecd_text
         FROM deal d WHERE d.id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async function versionOf(id: string): Promise<number> {
    return Number((await dealRow(id))?.version);
  }

  async function checksOf(dealId: string): Promise<Json[]> {
    const result = await observer.query<Json>(
      'SELECT * FROM deal_requirement_check WHERE deal_id = $1 ORDER BY requirement_id',
      [dealId],
    );
    return result.rows;
  }

  async function dealCount(): Promise<number> {
    const result = await observer.query<{ n: string }>('SELECT count(*) AS n FROM deal');
    return Number(result.rows[0]?.n);
  }

  async function checkCount(): Promise<number> {
    const result = await observer.query<{ n: string }>(
      'SELECT count(*) AS n FROM deal_requirement_check',
    );
    return Number(result.rows[0]?.n);
  }

  const msOf = (value: unknown): number | null =>
    value === null || value === undefined ? null : new Date(value as string | Date).getTime();

  async function assign(userId: string, programmeId: string, key: string, tenantId = TENANT_A) {
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

  /** One deal field-security decision in tenant A, against its standard field_def. */
  async function lockField(field: string, setKey: string, level: 'none' | 'read' | 'edit') {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = 'deal' AND f.api_name = $2 AND NOT f.is_custom`,
      [TENANT_A, field],
    );
    const fieldId = must(found.rows[0]?.id, `tenant A has no standard field_def deal.${field}`);
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
    );
  }

  interface Change {
    field: string;
    before: unknown;
    after: unknown;
    redacted: unknown;
  }
  interface AuditRow {
    id: string;
    tenant_id: string;
    actor_kind: string;
    action: string;
    actor_user_id: string | null;
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

  const named = (field: string): Change => ({ field, before: null, after: null, redacted: true });
  const byField = (changes: Change[]) =>
    [...changes].sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

  /** A move or update body's current version, read as the migrator. */
  const v = (id: string) => versionOf(id);

  /** A body that satisfies every requirement of Negotiation (S3) in FA1. */
  const toNegotiation = async (id: string, extra: Json = {}): Promise<Json> => ({
    version: await v(id),
    toStageId: FA1.S3,
    fields: { amount: { amountMinor: '500000', currency: 'NGN' }, expectedCloseDate: '2031-04-30' },
    checks: [FA1.RC_QUOTE],
    ...extra,
  });

  // =========================================================================
  // 0. Self-checks: this file's own helpers. They pass at commit time, by
  //    design; a checker only ever seen passing proves nothing.
  // =========================================================================

  describe('(self-check) the helpers this suite judges the server with', () => {
    it('(self-check) the planted template is the contract’s getPipeline example: kinds, positions, probabilities, rotting, and its 30 transitions by position', () => {
      const example = (
        (
          (requireOperation('getPipeline').op.responses as Json)['200'] as Json
        ).content as Json
      )['application/json'] as Json;
      const pipeline = example.example as Json;
      const stages = pipeline.stages as Json[];
      expect(
        stages.map((stage) => [stage.kind, stage.position, stage.probabilityBp, stage.rottingAfterDays]),
      ).toEqual(TEMPLATE.map((stage, index) => [stage.kind, index, stage.probabilityBp, stage.rottingAfterDays]));
      const position = new Map(stages.map((stage) => [String(stage.id), Number(stage.position)]));
      const fromExample = (pipeline.transitions as Json[])
        .map((pair) => `${position.get(String(pair.fromStageId))}>${position.get(String(pair.toStageId))}`)
        .sort();
      const byPosition = new Map(FA1.stageIds.map((id, index) => [id, index]));
      const fromRule = FA1.transitions
        .map(([from, to]) => `${byPosition.get(from)}>${byPosition.get(to)}`)
        .sort();
      expect(fromRule).toHaveLength(30);
      expect(fromRule).toEqual(fromExample);
      // The example's first open stage has no requirements; neither does ours.
      expect(FA1.requirements.filter((r) => r.stageId === FA1.S0 || r.stageId === FA1.S1)).toEqual([]);
      // A planted defect: a rule that also allows skipping a stage is caught.
      expect([...fromRule, '0>2'].sort()).not.toEqual(fromExample);
    });

    it('(self-check) the Deal checker rejects a present withheld field, an unlisted omission, a number amount, 19 digits, an orphan owner and an extra key', () => {
      const good: Json = {
        id: D('1'),
        programmeId: PROGRAMME_A1,
        pipelineId: FA1.P,
        stageId: FA1.S0,
        version: 1,
        name: 'x',
        amount: { amountMinor: EIGHTEEN_NINES, currency: 'NGN' },
        weightedAmount: { amountMinor: '100000000000000000', currency: 'NGN' },
        expectedCloseDate: '2031-01-01',
        ownerUserId: USER_A_AGENT_1,
        owner: { id: USER_A_AGENT_1, displayName: 'x' },
        primaryContactId: null,
        contact: null,
        accountId: null,
        account: null,
        nextStep: null,
        stageEnteredAt: iso(Date.UTC(2031, 0, 1)),
        closedAt: null,
        rotting: 'fresh',
        checks: [],
        createdAt: iso(Date.UTC(2031, 0, 1)),
        updatedAt: iso(Date.UTC(2031, 0, 1)),
        withheldFields: [],
      };
      expect(dealProblems(good, 'good')).toEqual([]);
      const without = (key: string) =>
        Object.fromEntries(Object.entries(good).filter(([k]) => k !== key));
      const broken: unknown[] = [
        { ...good, withheldFields: ['amount'] },
        without('nextStep'),
        { ...good, amount: { amountMinor: 5, currency: 'NGN' } },
        { ...good, amount: { amountMinor: `${EIGHTEEN_NINES}9`, currency: 'NGN' } },
        { ...good, amount: { amountMinor: '1.5', currency: 'NGN' } },
        { ...good, ownerUserId: null },
        { ...good, total: 1 },
        { ...without('amount'), withheldFields: ['amount'] },
        { ...good, closedAt: iso(Date.UTC(2031, 0, 2)) },
        { ...good, weightedAmount: { amountMinor: '1', currency: 'GHS' } },
      ];
      for (const [index, deal] of broken.entries()) {
        expect(dealProblems(deal, `broken ${index}`), `broken ${index}`).not.toEqual([]);
      }
      const page = { data: [good], nextCursor: null };
      expect(pageProblems(page, 'page')).toEqual([]);
      expect(pageProblems({ ...page, total: 1 }, 'page with total')).not.toEqual([]);
    });

    it('(self-check) half-even weighting in BigInt, exact at 18 digits; cursor readings see an id', () => {
      expect(halfEvenWeighted('5', 2500)).toBe('1');
      expect(halfEvenWeighted('6', 2500)).toBe('2');
      expect(halfEvenWeighted('10', 2500)).toBe('2');
      expect(halfEvenWeighted('14', 2500)).toBe('4');
      expect(halfEvenWeighted('0', 7000)).toBe('0');
      expect(halfEvenWeighted(EIGHTEEN_NINES, 1000)).toBe('100000000000000000');
      expect(halfEvenWeighted(EIGHTEEN_NINES, 2500)).toBe('250000000000000000');
      expect(halfEvenWeighted(EIGHTEEN_NINES, 7000)).toBe('699999999999999999');
      expect(halfEvenWeighted(EIGHTEEN_NINES, 10000)).toBe(EIGHTEEN_NINES);
      // A float cannot do this: the planted defect.
      expect(String(Math.round(Number(EIGHTEEN_NINES) * 0.7))).not.toBe('699999999999999999');
      expect(cursorReadings(Buffer.from(`{"id":"${NOWHERE}"}`).toString('base64url'))).toEqual(
        expect.arrayContaining([expect.stringContaining(NOWHERE)]),
      );
    });

    it('(self-check) every fixture id is in this suite’s range and unique; the contract names the five routes pinned above', () => {
      const ids = FIXTURES.flatMap((f) => [
        f.P,
        ...f.stageIds,
        ...f.requirements.map((r) => r.id),
      ]);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of [...ids, NOWHERE, D('abc')]) {
        expect(id).toMatch(/^11111111-0000-4000-8000-0108[0-9a-f]{8}$/);
      }
      const routes = ['listDeals', 'createDeal', 'getDeal', 'updateDeal', 'moveDeal'].map((id) => {
        const op = requireOperation(id);
        return `${op.method.toUpperCase()} ${op.path}`;
      });
      expect(routes).toEqual([
        'GET /api/v1/pipelines/{pipelineId}/deals',
        'POST /api/v1/pipelines/{pipelineId}/deals',
        'GET /api/v1/deals/{dealId}',
        'PATCH /api/v1/deals/{dealId}',
        'POST /api/v1/deals/{dealId}/move',
      ]);
    });
  });

  // =========================================================================
  // 1. The flags.
  // =========================================================================

  describe('the contract records the slice as served', () => {
    it('listDeals, createDeal, getDeal, updateDeal and moveDeal are x-kasuwa-implemented: true', () => {
      const problems = ['listDeals', 'createDeal', 'getDeal', 'updateDeal', 'moveDeal']
        .filter((id) => requireOperation(id).op['x-kasuwa-implemented'] !== true)
        .map((id) => `${id} is not x-kasuwa-implemented: true`);
      expect(problems).toEqual([]);
    });
  });

  // =========================================================================
  // 2. createDeal (D-L88, D-L67, R1, R2, R15, R16, R21).
  // =========================================================================

  describe('createDeal: who creates, where it starts, who owns it', () => {
    it('agent, team lead, programme manager, admin and the tenant-admin flag create; the deal starts in the first open stage and, without ownerUserId, is the caller’s', async () => {
      await control();
      const cases: [string, Headers, string, () => Promise<void>][] = [
        ['agent', ACTOR, USER_A_NO_PROGRAMME, () => assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'agent')],
        ['team_lead', ACTOR, USER_A_NO_PROGRAMME, () => assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead')],
        ['programme_manager', ACTOR, USER_A_NO_PROGRAMME, () => assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'programme_manager')],
        ['admin', ACTOR, USER_A_NO_PROGRAMME, () => assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'admin')],
        // The flag acts as admin even over a read-only set.
        ['tenant-admin flag over qa_analyst', SUPERVISOR, USER_A_SUPERVISOR, () => assign(USER_A_SUPERVISOR, PROGRAMME_A1, 'qa_analyst')],
        ['the seeded agent', AGENT_1, USER_A_AGENT_1, async () => undefined],
      ];
      for (const [label, headers, userId, setUp] of cases) {
        await setUp();
        const before = Date.now();
        const response = await createDeal(headers, FA1.P, { name: `T-0108 create ${label} ${RUN}` });
        const after = Date.now();
        const deal = expectDeal(response, 'createDeal', 201, label);
        expect(deal, label).toMatchObject({
          programmeId: PROGRAMME_A1,
          pipelineId: FA1.P,
          stageId: FA1.S0,
          version: 1,
          name: `T-0108 create ${label} ${RUN}`,
          amount: null,
          weightedAmount: null,
          expectedCloseDate: null,
          ownerUserId: userId,
          owner: { id: userId, displayName: displayNameOf(userId) },
          primaryContactId: null,
          accountId: null,
          nextStep: null,
          closedAt: null,
          rotting: 'fresh',
          checks: [],
          withheldFields: [],
        });
        const entered = Date.parse(String(deal.stageEnteredAt));
        expect(entered, `${label}: stageEnteredAt is the server's now`).toBeGreaterThanOrEqual(before - SKEW);
        expect(entered).toBeLessThanOrEqual(after + SKEW);
        const row = await dealRow(String(deal.id));
        expect(row, `${label}: stored`).toMatchObject({
          tenant_id: TENANT_A,
          programme_id: PROGRAMME_A1,
          pipeline_id: FA1.P,
          stage_id: FA1.S0,
          owner_user_id: userId,
          closed_at: null,
        });
      }
    });

    it('qa_analyst is 403 before the body is read; client_portal, a user with no programme, and an unreachable pipeline are the one 404 (R1)', async () => {
      await control();
      const count = await dealCount();
      const quiet = await auditIds();
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'qa_analyst');
      for (const body of [{ name: 'T-0108 qa' }, { name: '' }, { bogus: true }, []]) {
        const response = await createDeal(ACTOR, FA1.P, body);
        expectError(response, 403, 'not_permitted');
        expectNoStore(response, 'qa 403');
      }
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'client_portal');
      const portal = await createDeal(ACTOR, FA1.P, { name: 'T-0108 portal' });
      expectError(portal, 404, 'not_found');
      await unassign(USER_A_NO_PROGRAMME, PROGRAMME_A1);
      const nobody = await createDeal(ACTOR, FA1.P, { name: 'T-0108 nobody' });
      const unreachable = [
        await createDeal(AGENT_1, FA2.P, { name: 'T-0108 A2' }),
        await createDeal(AGENT_1, FB1.P, { name: 'T-0108 B1' }),
        await createDeal(AGENT_1, NOWHERE, { name: 'T-0108 nowhere' }),
        await createDeal(AGENT_1, 'not-a-uuid', { name: 'T-0108 bad id' }),
        await createDeal(AGENT_1, FA2.P, { name: '' }),
      ];
      const bodies = [portal, nobody, ...unreachable].map((response) => {
        expectError(response, 404, 'not_found');
        expectNoStore(response, '404');
        return textOf(response);
      });
      expect(new Set(bodies).size, 'one 404 body').toBe(1);
      expect(await dealCount(), 'nothing created').toBe(count);
      // Deal events only: the unassign above writes its own programme membership event (0031/0033), D-L126.
      expect(
        (await auditSince(quiet)).filter((row) => row.object_type === 'deal'),
        'nothing audited',
      ).toEqual([]);
    });

    it('owners: an agent may own it only themselves (any letter case, R2); null or anyone else is owner_not_self; reassign holders may name a member or nobody (R16)', async () => {
      await control();
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      for (const owner of [USER_A_AGENT_2, null, USER_A_SUPERVISOR]) {
        expectForbidden(
          await createDeal(AGENT_1, FA1.P, { name: 'T-0108 owner', ownerUserId: owner }),
          'owner_not_self',
          ['ownerUserId'],
          `agent gives it to ${String(owner)}`,
        );
      }
      const upper = expectDeal(
        await createDeal(AGENT_1, FA1.P, { name: 'T-0108 upper', ownerUserId: USER_A_AGENT_1.toUpperCase() }),
        'createDeal',
        201,
        'own id upper case',
      );
      expect(upper.ownerUserId, 'canonical lower case').toBe(USER_A_AGENT_1);
      expect((await dealRow(String(upper.id)))?.owner_user_id).toBe(USER_A_AGENT_1);
      for (const key of ['team_lead', 'programme_manager', 'admin']) {
        await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, key);
        const given = expectDeal(
          await createDeal(ACTOR, FA1.P, { name: `T-0108 given ${key}`, ownerUserId: USER_A_AGENT_2 }),
          'createDeal',
          201,
          `${key} gives it to agent 2`,
        );
        expect(given).toMatchObject({
          ownerUserId: USER_A_AGENT_2,
          owner: { id: USER_A_AGENT_2, displayName: displayNameOf(USER_A_AGENT_2) },
        });
        const unowned = expectDeal(
          await createDeal(ACTOR, FA1.P, { name: `T-0108 unowned ${key}`, ownerUserId: null }),
          'createDeal',
          201,
          `${key} creates it unowned`,
        );
        expect(unowned).toMatchObject({ ownerUserId: null, owner: null });
        const own = expectDeal(
          await createDeal(ACTOR, FA1.P, { name: `T-0108 own ${key}` }),
          'createDeal',
          201,
          `${key} without ownerUserId`,
        );
        expect(own.ownerUserId, 'R16: the caller').toBe(USER_A_NO_PROGRAMME);
      }
    });

    it('references live in the pipeline’s programme (D-L67): another programme’s or tenant’s owner, contact or account is the same unknown_reference body as an invented id', async () => {
      await control();
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      const references: [string, string[]][] = [
        // Agent 2 is a real tenant-A user who belongs to A2 only.
        ['ownerUserId', [USER_A_AGENT_2, USER_B_AGENT_1, NOWHERE]],
        ['primaryContactId', [A2_CONTACT.id, B1_CONTACT.id, NOWHERE]],
        ['accountId', [accountIn(PROGRAMME_A2).id, accountIn(PROGRAMME_B1).id, NOWHERE]],
      ];
      const count = await dealCount();
      for (const [key, ids] of references) {
        const bodies = [];
        for (const id of ids) {
          const response = await createDeal(ACTOR, FA1.P, { name: 'T-0108 ref', [key]: id });
          expectDetail(response, key, 'unknown_reference', `${key} ${id}`);
          bodies.push(textOf(response));
        }
        expect(new Set(bodies).size, `${key}: one body, real-elsewhere or invented`).toBe(1);
      }
      // The supervisor reaches A2 and still may not use A2's contact on an A1 deal.
      const supervisor = await createDeal(SUPERVISOR, FA1.P, { name: 'T-0108 ref', primaryContactId: A2_CONTACT.id });
      expectDetail(supervisor, 'primaryContactId', 'unknown_reference', 'supervisor, A2 contact');
      expect(await dealCount(), 'nothing created').toBe(count);
      const ok = expectDeal(
        await createDeal(ACTOR, FA1.P, {
          name: 'T-0108 ref ok',
          primaryContactId: FA1.contact,
          accountId: FA1.account,
          expectedCloseDate: '2031-06-30',
          nextStep: 'T-0108 synthetic next step',
        }),
        'createDeal',
        201,
        'in-programme references',
      );
      expect(ok).toMatchObject({
        primaryContactId: FA1.contact,
        contact: { id: FA1.contact, displayName: FA1.contactName },
        accountId: FA1.account,
        account: { id: FA1.account, name: FA1.accountName },
        expectedCloseDate: '2031-06-30',
        nextStep: 'T-0108 synthetic next step',
      });
    });

    it('the body is closed: no stage, pipeline, programme, version, timestamp, check or server-owned key; malformed fields and non-object bodies are 400, never 500 (R15)', async () => {
      await control();
      const count = await dealCount();
      const forbidden: Json = {
        id: D('201'),
        stageId: FA1.S3,
        pipelineId: FA1B.P,
        programmeId: PROGRAMME_A2,
        version: 7,
        weightedAmount: { amountMinor: '1', currency: 'NGN' },
        owner: { id: USER_A_AGENT_1, displayName: 'x' },
        contact: { id: FA1.contact, displayName: 'x' },
        account: { id: FA1.account, name: 'x' },
        checks: [FA1.RC_QUOTE],
        createdAt: iso(Date.UTC(2020, 0, 1)),
        updatedAt: iso(Date.UTC(2020, 0, 1)),
        stageEnteredAt: iso(Date.UTC(2020, 0, 1)),
        closedAt: iso(Date.UTC(2020, 0, 1)),
        withheldFields: [],
        probabilityBp: 9000,
        currency: 'NGN',
        amountMinor: '5',
      };
      for (const [key, value] of Object.entries(forbidden)) {
        const response = await createDeal(AGENT_1, FA1.P, { name: 'T-0108 closed', [key]: value });
        expectError(response, 400, 'validation_failed');
        expectNoStore(response, key);
      }
      const malformed: unknown[] = [
        {},
        { name: '' },
        { name: 'x'.repeat(201) },
        { name: null },
        { name: 5 },
        { name: 'T-0108', nextStep: '' },
        { name: 'T-0108', nextStep: 'x'.repeat(201) },
        { name: 'T-0108', expectedCloseDate: '2031-02-30' },
        { name: 'T-0108', expectedCloseDate: '2031-03-01T00:00:00Z' },
        { name: 'T-0108', ownerUserId: 'not-a-uuid' },
        [],
        'T-0108',
        null,
        42,
      ];
      for (const body of malformed) {
        expectError(await createDeal(AGENT_1, FA1.P, body), 400, 'validation_failed');
      }
      for (const raw of [
        '{"name":"T-0108 proto","__proto__":{"stageId":"x"}}',
        '{"name":"T-0108 ctor","constructor":{"prototype":{"x":1}}}',
        '{"name":',
      ]) {
        const response = await sendRaw('post', `${PIPELINES}/${FA1.P}/deals`, AGENT_1, raw);
        expectError(response, 400, 'validation_failed');
      }
      expect(await dealCount(), 'nothing created').toBe(count);
      const ok = expectDeal(await createDeal(AGENT_1, FA1.P, { name: 'T-0108 closed ok' }), 'createDeal', 201, 'control');
      expect(ok.stageId, 'never the stage a body asked for').toBe(FA1.S0);
    });

    it('error order on create: 404, then 403 (action, owner_not_self, field_not_editable on the raw body), then 400', async () => {
      await control();
      const bad = { name: '', amount: { amountMinor: '1.5', currency: 'USD' }, stageId: FA1.S3 };
      // 404 first, whatever else is wrong.
      expectError(await createDeal(AGENT_1, FA2.P, bad), 404, 'not_found');
      // 403 action before 400.
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'qa_analyst');
      expectError(await createDeal(ACTOR, FA1.P, bad), 403, 'not_permitted');
      // owner_not_self before 400.
      expectForbidden(
        await createDeal(AGENT_1, FA1.P, { ...bad, ownerUserId: USER_A_SUPERVISOR }),
        'owner_not_self',
        ['ownerUserId'],
        'owner_not_self before 400',
      );
      // field_not_editable before 400.
      await lockField('next_step', 'agent', 'read');
      expectForbidden(
        await createDeal(AGENT_1, FA1.P, { ...bad, nextStep: 'T-0108 step' }),
        'field_not_editable',
        ['nextStep'],
        'field_not_editable before 400',
      );
      // Then 400.
      expectError(await createDeal(AGENT_1, FA1.P, bad), 400, 'validation_failed');
    });
  });

  // =========================================================================
  // 3. Money (D-L121, D-L115, R3, R19).
  // =========================================================================

  describe('money: digits only, at most 18, exact both ways, one of four currencies', () => {
    const REFUSED_AMOUNTS: unknown[] = [
      '1.5',
      '-1',
      '1e3',
      ' 5',
      '5 ',
      '',
      `1${EIGHTEEN_NINES}`,
      '05',
      '+5',
      '0x10',
      '1_000',
      '1,000',
      '٥',
      '5\u0000',
      'NaN',
      'Infinity',
      5,
      1.5,
      null,
      true,
    ];

    it('a fraction, sign, exponent, space, empty, 19 digits, leading zero or a JSON number is 400 at amount.amountMinor on create, update and move, and nothing is written', async () => {
      await control();
      const id = await plantDeal({ id: D('301'), at: 2, amountMinor: '700', expectedCloseDate: null });
      const before = await dealRow(id);
      const count = await dealCount();
      const checks = await checkCount();
      const quiet = await auditIds();
      for (const amountMinor of REFUSED_AMOUNTS) {
        const where = `amountMinor ${JSON.stringify(amountMinor)}`;
        const created = await createDeal(AGENT_1, FA1.P, {
          name: 'T-0108 money',
          amount: { amountMinor, currency: 'NGN' },
        });
        expect(created.status, `create ${where}`).toBe(400);
        expect(detailsOf(created.body).map((d) => d.path), `create ${where}`).toContain('amount.amountMinor');
        const updated = await updateDeal(AGENT_1, id, {
          version: await v(id),
          amount: { amountMinor, currency: 'NGN' },
        });
        expect(updated.status, `update ${where}`).toBe(400);
        expect(detailsOf(updated.body).map((d) => d.path), `update ${where}`).toContain('amount.amountMinor');
        const moved = await moveDeal(AGENT_1, id, {
          version: await v(id),
          toStageId: FA1.S3,
          fields: { amount: { amountMinor, currency: 'NGN' }, expectedCloseDate: '2031-04-30' },
          checks: [FA1.RC_QUOTE],
        });
        expect(moved.status, `move ${where}`).toBe(400);
        expect(detailsOf(moved.body).map((d) => d.path), `move ${where}`).toContain('fields.amount.amountMinor');
        for (const response of [created, updated, moved]) {
          expectError(response, 400, 'validation_failed');
          for (const text of DATABASE_TEXT_IN_BODIES) {
            expect(textOf(response), `${where}: no database text`).not.toContain(text);
          }
        }
      }
      expect(await dealRow(id), 'the deal is untouched').toEqual(before);
      expect(await dealCount()).toBe(count);
      expect(await checkCount(), 'no check recorded by a refused move').toBe(checks);
      expect(await auditSince(quiet), 'nothing audited').toEqual([]);
    });

    it('18 nines round-trips exactly, as a JSON string, through create, get, list, update and move; 0 too (R19)', async () => {
      await control();
      const created = expectDeal(
        await createDeal(AGENT_1, FA1.P, {
          name: 'T-0108 eighteen nines',
          amount: { amountMinor: EIGHTEEN_NINES, currency: 'NGN' },
        }),
        'createDeal',
        201,
        'create 18 nines',
      );
      const id = String(created.id);
      const raw = `"amountMinor":"${EIGHTEEN_NINES}"`;
      expect(created.amount).toEqual({ amountMinor: EIGHTEEN_NINES, currency: 'NGN' });
      expect(created.weightedAmount).toEqual({ amountMinor: halfEvenWeighted(EIGHTEEN_NINES, 1000), currency: 'NGN' });
      expect((await dealRow(id))?.amount_text, 'stored exactly').toBe(EIGHTEEN_NINES);
      const got = await getDeal(AGENT_1, id);
      expectDeal(got, 'getDeal', 200, 'get');
      expect(textOf(got), 'a string on the wire, not a number').toContain(raw);
      const listed = await listDeals(AGENT_1, FA1.P);
      expectStatus(listed, 200, 'list');
      expect(textOf(listed)).toContain(raw);
      const updated = expectDeal(
        await updateDeal(AGENT_1, id, {
          version: await v(id),
          amount: { amountMinor: '999999999999999998', currency: 'ZAR' },
        }),
        'updateDeal',
        200,
        'update',
      );
      expect(updated.amount).toEqual({ amountMinor: '999999999999999998', currency: 'ZAR' });
      expect((await dealRow(id))?.amount_text).toBe('999999999999999998');
      expect((await dealRow(id))?.currency).toBe('ZAR');
      await moveDeal(AGENT_1, id, { version: await v(id), toStageId: FA1.S1 });
      // Proposal's own entry check first: requirements are the target stage's (D-P20), D-L126.
      await plantCheck(id, FA1.RC_PROP, USER_A_AGENT_1, Date.now() - HOUR);
      await moveDeal(AGENT_1, id, { version: await v(id), toStageId: FA1.S2 });
      const moved = await moveDeal(AGENT_1, id, {
        version: await v(id),
        toStageId: FA1.S3,
        fields: { amount: { amountMinor: EIGHTEEN_NINES, currency: 'NGN' }, expectedCloseDate: '2031-04-30' },
        checks: [FA1.RC_QUOTE],
      });
      const deal = expectDeal(moved, 'moveDeal', 200, 'move with 18 nines');
      expect(textOf(moved)).toContain(raw);
      expect(deal.weightedAmount).toEqual({ amountMinor: halfEvenWeighted(EIGHTEEN_NINES, 7000), currency: 'NGN' });
      const zero = expectDeal(
        await createDeal(AGENT_1, FA1.P, { name: 'T-0108 zero', amount: { amountMinor: '0', currency: 'KES' } }),
        'createDeal',
        201,
        'zero',
      );
      expect(zero.amount).toEqual({ amountMinor: '0', currency: 'KES' });
      expect(zero.weightedAmount).toEqual({ amountMinor: '0', currency: 'KES' });
    });

    it('amount and currency come together, in NGN, GHS, KES or ZAR; any other code is unknown_currency at amount.currency; null clears both', async () => {
      await control();
      for (const currency of ['NGN', 'GHS', 'KES', 'ZAR']) {
        const deal = expectDeal(
          await createDeal(AGENT_1, FA1.P, { name: `T-0108 ${currency}`, amount: { amountMinor: '123', currency } }),
          'createDeal',
          201,
          currency,
        );
        expect(deal.amount).toEqual({ amountMinor: '123', currency });
      }
      for (const currency of ['USD', 'EUR', 'XOF', 'NAI']) {
        expectDetail(
          await createDeal(AGENT_1, FA1.P, { name: 'T-0108 fx', amount: { amountMinor: '123', currency } }),
          'amount.currency',
          'unknown_currency',
          currency,
        );
      }
      for (const currency of ['ngn', 'naira', '', 'N G', 566]) {
        expectError(
          await createDeal(AGENT_1, FA1.P, { name: 'T-0108 fx', amount: { amountMinor: '123', currency } }),
          400,
          'validation_failed',
        );
      }
      for (const amount of [{ amountMinor: '123' }, { currency: 'NGN' }, {}, { amountMinor: '1', currency: 'NGN', rate: 1 }, '123', 123]) {
        expectError(
          await createDeal(AGENT_1, FA1.P, { name: 'T-0108 half', amount }),
          400,
          'validation_failed',
        );
      }
      const id = await plantDeal({ id: D('302'), amountMinor: '4000', currency: 'GHS' });
      const cleared = expectDeal(
        await updateDeal(AGENT_1, id, { version: await v(id), amount: null }),
        'updateDeal',
        200,
        'amount null',
      );
      expect(cleared).toMatchObject({ amount: null, weightedAmount: null });
      const row = await dealRow(id);
      expect([row?.amount_minor, row?.currency], 'both columns cleared').toEqual([null, null]);
      expectDetail(
        await updateDeal(AGENT_1, id, { version: await v(id), amount: { amountMinor: '5', currency: 'USD' } }),
        'amount.currency',
        'unknown_currency',
        'update USD',
      );
      expectDetail(
        await moveDeal(AGENT_1, await plantDeal({ id: D('303'), at: 2, amountMinor: null }), {
          version: 1,
          toStageId: FA1.S3,
          fields: { amount: { amountMinor: '5', currency: 'USD' }, expectedCloseDate: '2031-04-30' },
          checks: [FA1.RC_QUOTE],
        }),
        'fields.amount.currency',
        'unknown_currency',
        'move USD',
      );
    });

    it('weightedAmount is the stage’s probability, half-even per deal, in the deal’s currency, exact at 18 digits', async () => {
      await control();
      const cases: [string, number, string][] = [
        [D('311'), 1, '5'],
        [D('312'), 1, '6'],
        [D('313'), 1, '10'],
        [D('314'), 1, '14'],
        [D('315'), 1, EIGHTEEN_NINES],
        [D('316'), 3, EIGHTEEN_NINES],
        [D('317'), 3, '15'],
        [D('318'), 5, EIGHTEEN_NINES],
        [D('319'), 6, EIGHTEEN_NINES],
      ];
      for (const [id, at, amountMinor] of cases) {
        await plantDeal({ id, at, amountMinor, currency: 'GHS' });
        const deal = expectDeal(await getDeal(AGENT_1, id), 'getDeal', 200, `${amountMinor} at ${at}`);
        const bp = must(TEMPLATE[at], 'stage').probabilityBp;
        expect(deal.weightedAmount, `${amountMinor} x ${bp}bp`).toEqual({
          amountMinor: halfEvenWeighted(amountMinor, bp),
          currency: 'GHS',
        });
      }
    });
  });

  // =========================================================================
  // 4. getDeal and the one 404 (D-L115, R1).
  // =========================================================================

  describe('reads: the deal as Deal, and one 404 for everything out of reach', () => {
    it('getDeal returns the stored deal: summaries, owner, a former owner without a name, checks with who ticked them, rotting, closedAt', async () => {
      await control();
      const now = Date.now();
      const id = await plantDeal({
        id: D('401'),
        at: 3,
        name: 'T-0108 Ọjà supply',
        amountMinor: '1500000015',
        currency: 'NGN',
        expectedCloseDate: '2031-10-31',
        contact: FA1.contact,
        account: FA1.account,
        nextStep: 'T-0108 send the revised quote',
        enteredAt: now - 8 * DAY - HOUR,
      });
      await plantCheck(id, FA1.RC_PROP, USER_A_SUPERVISOR, now - 9 * DAY);
      const response = await getDeal(AGENT_1, id);
      const deal = expectDeal(response, 'getDeal', 200, 'getDeal');
      expect(deal).toMatchObject({
        id,
        programmeId: PROGRAMME_A1,
        pipelineId: FA1.P,
        stageId: FA1.S3,
        version: await versionOf(id),
        name: 'T-0108 Ọjà supply',
        amount: { amountMinor: '1500000015', currency: 'NGN' },
        weightedAmount: { amountMinor: halfEvenWeighted('1500000015', 7000), currency: 'NGN' },
        expectedCloseDate: '2031-10-31',
        ownerUserId: USER_A_AGENT_1,
        owner: { id: USER_A_AGENT_1, displayName: displayNameOf(USER_A_AGENT_1) },
        primaryContactId: FA1.contact,
        contact: { id: FA1.contact, displayName: FA1.contactName },
        accountId: FA1.account,
        account: { id: FA1.account, name: FA1.accountName },
        nextStep: 'T-0108 send the revised quote',
        closedAt: null,
        rotting: 'stale',
        withheldFields: [],
      });
      expect(checksSummary(deal.checks)).toEqual([
        [FA1.RC_PROP, USER_A_SUPERVISOR, displayNameOf(USER_A_SUPERVISOR), now - 9 * DAY],
      ]);
      expect(Date.parse(String(deal.stageEnteredAt))).toBe(now - 8 * DAY - HOUR);
      // A former owner (agent 2 belongs to A2 only): an id and no name.
      const former = await plantDeal({ id: D('402'), owner: USER_A_AGENT_2 });
      const formerDeal = expectDeal(await getDeal(AGENT_1, former), 'getDeal', 200, 'former owner');
      expect(formerDeal.owner).toEqual({ id: USER_A_AGENT_2, displayName: null });
      expect(textOf(await getDeal(AGENT_1, former))).not.toContain(displayNameOf(USER_A_AGENT_2));
      // Won: closedAt set, rotting null.
      const won = await plantDeal({ id: D('403'), at: 5, enteredAt: now - 2 * DAY });
      const wonDeal = expectDeal(await getDeal(AGENT_1, won), 'getDeal', 200, 'won');
      expect(wonDeal.rotting).toBeNull();
      expect(Date.parse(String(wonDeal.closedAt))).toBe(now - 2 * DAY);
    });

    it('rotting is whole days since stageEnteredAt: stale from half rottingAfterDays rounded down, rotting from rottingAfterDays', async () => {
      await control();
      const now = Date.now();
      const cases: [string, number, number, string][] = [
        [D('411'), 0, 7 * DAY - HOUR, 'fresh'],
        [D('412'), 0, 7 * DAY + HOUR, 'stale'],
        [D('413'), 0, 14 * DAY - HOUR, 'stale'],
        [D('414'), 0, 14 * DAY + HOUR, 'rotting'],
        // Contract rots at 21: stale from 10 (21 / 2 rounded down), not 10.5 or 11.
        [D('415'), 4, 10 * DAY - HOUR, 'fresh'],
        [D('416'), 4, 10 * DAY + HOUR, 'stale'],
        [D('417'), 4, 21 * DAY + HOUR, 'rotting'],
      ];
      for (const [id, at, age, expected] of cases) {
        await plantDeal({ id, at, enteredAt: now - age });
        const deal = expectDeal(await getDeal(AGENT_1, id), 'getDeal', 200, id);
        expect(deal.rotting, `stage ${at}, ${age / HOUR} hours in`).toBe(expected);
      }
    });

    it('one 404 body, byte for byte, on all five operations: another programme, another tenant, nowhere, a non-uuid, client_portal, no programme, and a scope the flag does not widen', async () => {
      await control();
      const a2 = await plantDeal({ id: D('421'), f: FA2 });
      const b1 = await plantDeal({ id: D('422'), f: FB1 });
      const mine = await plantDeal({ id: D('423') });
      const badIds = ['not-a-uuid', '123', `${mine}0`, mine.slice(0, -1), ' ', '%00'];
      const responses: [string, request.Response][] = [];
      const write = { version: 1, nextStep: 'T-0108 x' };
      const move = { version: 1, toStageId: FA1.S1 };
      for (const id of [a2, b1, NOWHERE, ...badIds]) {
        responses.push([`get ${id}`, await getDeal(AGENT_1, id)]);
        responses.push([`patch ${id}`, await updateDeal(AGENT_1, id, write)]);
        responses.push([`patch garbage ${id}`, await updateDeal(AGENT_1, id, { stageId: 'x' })]);
        responses.push([`move ${id}`, await moveDeal(AGENT_1, id, move)]);
      }
      for (const pipelineId of [FA2.P, FB1.P, NOWHERE, 'not-a-uuid', FA1.S0]) {
        responses.push([`list ${pipelineId}`, await listDeals(AGENT_1, pipelineId)]);
        responses.push([`list bad param ${pipelineId}`, await listDeals(AGENT_1, pipelineId, [['limit', '0']])]);
        responses.push([`create ${pipelineId}`, await createDeal(AGENT_1, pipelineId, { name: 'T-0108' })]);
      }
      // client_portal reads nothing and writes nothing (R1), even its own deal.
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'client_portal');
      const portalOwn = await plantDeal({ id: D('424'), owner: USER_A_NO_PROGRAMME });
      responses.push(['portal get', await getDeal(ACTOR, portalOwn)]);
      responses.push(['portal patch', await updateDeal(ACTOR, portalOwn, write)]);
      responses.push(['portal move', await moveDeal(ACTOR, portalOwn, move)]);
      responses.push(['portal list', await listDeals(ACTOR, FA1.P)]);
      await unassign(USER_A_NO_PROGRAMME, PROGRAMME_A1);
      responses.push(['no programme get', await getDeal(ACTOR, mine)]);
      responses.push(['no programme list', await listDeals(ACTOR, FA1.P)]);
      // The supervisor (tenant admin) loses A2 with the membership.
      expectStatus(await getDeal(SUPERVISOR, a2), 200, 'control: the supervisor reads A2');
      await unassign(USER_A_SUPERVISOR, PROGRAMME_A2);
      responses.push(['supervisor after leaving A2', await getDeal(SUPERVISOR, a2)]);
      responses.push(['tenant B on A1', await getDeal(TENANT_B_ADMIN, mine)]);
      const bodies = new Set<string>();
      for (const [label, response] of responses) {
        expectError(response, 404, 'not_found');
        expectNoStore(response, label);
        bodies.add(textOf(response));
      }
      expect([...bodies], 'one body for every reason').toHaveLength(1);
      // qa_analyst reads.
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'qa_analyst');
      expectDeal(await getDeal(ACTOR, mine), 'getDeal', 200, 'qa_analyst reads');
      expect(await dealRow(a2), 'nothing written to A2').toMatchObject({ version: 1, next_step: null });
    });

    it('scope comes from the session: a scope header is 400, no session is 401, both no-store', async () => {
      await control();
      const mine = await plantDeal({ id: D('431') });
      for (const [header, value] of [
        ['x-kasuwa-programme-ids', `{${PROGRAMME_A2}}`],
        ['x-kasuwa-programme-id', PROGRAMME_A2],
        ['x-kasuwa-scope', 'all'],
      ] as const) {
        for (const response of [
          await getDeal(AGENT_1, mine).set(header, value),
          await listDeals(AGENT_1, FA1.P).set(header, value),
          await updateDeal(AGENT_1, mine, { version: 1, nextStep: 'x' }).set(header, value),
        ]) {
          expectError(response, 400, 'validation_failed');
          expectNoStore(response, header);
        }
      }
      for (const response of [
        await getDeal({}, mine),
        await listDeals({}, FA1.P),
        await createDeal({}, FA1.P, { name: 'x' }),
        await updateDeal({}, mine, { version: 1, nextStep: 'x' }),
        await moveDeal({}, mine, { version: 1, toStageId: FA1.S1 }),
      ]) {
        expectError(response, 401, 'not_authenticated');
        expectNoStore(response, '401');
      }
      expect(await versionOf(mine)).toBe(1);
    });
  });

  // =========================================================================
  // 5. updateDeal (D-L88, D-L102, D-L120, R2, R11, R12, R14).
  // =========================================================================

  describe('updateDeal: rights, owners, the closed body, versions', () => {
    it('the rights matrix: agents edit their own deals, team lead, programme manager and admin any, qa_analyst none, client_portal 404; judged in the deal’s programme', async () => {
      await control();
      const expected: [string, number, number][] = [
        ['agent', 200, 403],
        ['team_lead', 200, 200],
        ['programme_manager', 200, 200],
        ['admin', 200, 200],
        ['qa_analyst', 403, 403],
        ['client_portal', 404, 404],
      ];
      let tail = 0;
      for (const [key, own, other] of expected) {
        await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, key);
        const ownId = await plantDeal({ id: D(`5${(tail += 1).toString(16)}`), owner: USER_A_NO_PROGRAMME });
        const otherId = await plantDeal({ id: D(`5${(tail += 1).toString(16)}`), owner: USER_A_AGENT_1 });
        for (const [id, status, whose] of [
          [ownId, own, 'own'],
          [otherId, other, 'another’s'],
        ] as const) {
          const response = await updateDeal(ACTOR, id, { version: 1, nextStep: `T-0108 ${key}` });
          const where = `${key} edits ${whose} deal`;
          expectStatus(response, status, where);
          expectNoStore(response, where);
          if (status === 200) expectDeal(response, 'updateDeal', 200, where);
          if (status === 403) expectError(response, 403, 'not_permitted');
          expect((await dealRow(id))?.next_step, where).toBe(status === 200 ? `T-0108 ${key}` : null);
        }
      }
      // The tenant-admin flag acts as admin over a read-only set.
      await assign(USER_A_SUPERVISOR, PROGRAMME_A1, 'qa_analyst');
      const flagged = await plantDeal({ id: D('5f1') });
      expectDeal(await updateDeal(SUPERVISOR, flagged, { version: 1, nextStep: 'T-0108 flag' }), 'updateDeal', 200, 'flag');
      // Agent 1 is team_lead in A2 but still only an agent in A1.
      await assign(USER_A_AGENT_1, PROGRAMME_A2, 'team_lead');
      const a2 = await plantDeal({ id: D('5f2'), f: FA2 });
      const a1 = await plantDeal({ id: D('5f3'), owner: USER_A_SUPERVISOR });
      expectDeal(await updateDeal(AGENT_1, a2, { version: 1, nextStep: 'T-0108 lead' }), 'updateDeal', 200, 'team_lead in A2');
      expectError(await updateDeal(AGENT_1, a1, { version: 1, nextStep: 'T-0108 lead' }), 403, 'not_permitted');
    });

    it('reassigning: an agent may not give their deal away or clear it, nor claim another’s; reassign holders name members only (D-L67), and the old owner loses the deal', async () => {
      await control();
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      const mine = await plantDeal({ id: D('521') });
      const theirs = await plantDeal({ id: D('522'), owner: USER_A_AGENT_2 });
      const unowned = await plantDeal({ id: D('523'), owner: null });
      for (const owner of [USER_A_AGENT_2, null, USER_A_SUPERVISOR]) {
        expectForbidden(
          await updateDeal(AGENT_1, mine, { version: 1, ownerUserId: owner }),
          'owner_not_self',
          ['ownerUserId'],
          `agent gives it to ${String(owner)}`,
        );
      }
      // Another agent of the same programme may neither edit nor claim it.
      expectError(await updateDeal(AGENT_2, mine, { version: 1, nextStep: 'x' }), 403, 'not_permitted');
      expectError(await updateDeal(AGENT_2, mine, { version: 1, ownerUserId: USER_A_AGENT_2 }), 403, 'not_permitted');
      expectDeal(
        await updateDeal(AGENT_1, mine, { version: 1, ownerUserId: USER_A_AGENT_1.toUpperCase(), nextStep: 'T-0108 same owner' }),
        'updateDeal',
        200,
        'own id, upper case (R2)',
      );
      // Claiming someone else's (or nobody's) deal: not own, so 403 before the body.
      for (const id of [theirs, unowned]) {
        expectError(await updateDeal(AGENT_1, id, { version: 1, ownerUserId: USER_A_AGENT_1 }), 403, 'not_permitted');
        expect((await dealRow(id))?.version, 'untouched').toBe(1);
      }
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      const bodies: string[] = [];
      for (const owner of [USER_B_AGENT_1, NOWHERE]) {
        const response = await updateDeal(ACTOR, theirs, { version: 1, ownerUserId: owner });
        expectDetail(response, 'ownerUserId', 'unknown_reference', String(owner));
        bodies.push(textOf(response));
      }
      // Agent 2 left A1: a real tenant-A user who is no longer a member.
      await unassign(USER_A_AGENT_2, PROGRAMME_A1);
      const left = await updateDeal(ACTOR, mine, { version: await v(mine), ownerUserId: USER_A_AGENT_2 });
      expectDetail(left, 'ownerUserId', 'unknown_reference', 'a former member');
      bodies.push(textOf(left));
      expect(new Set(bodies).size, 'one body, real-elsewhere or invented').toBe(1);
      const given = expectDeal(
        await updateDeal(ACTOR, mine, { version: await v(mine), ownerUserId: USER_A_SUPERVISOR }),
        'updateDeal',
        200,
        'team lead reassigns',
      );
      expect(given).toMatchObject({
        ownerUserId: USER_A_SUPERVISOR,
        owner: { id: USER_A_SUPERVISOR, displayName: displayNameOf(USER_A_SUPERVISOR) },
      });
      // Agent 1 no longer owns it: no edit, no move.
      expectError(await updateDeal(AGENT_1, mine, { version: await v(mine), nextStep: 'x' }), 403, 'not_permitted');
      expectError(await moveDeal(AGENT_1, mine, { version: await v(mine), toStageId: FA1.S1 }), 403, 'not_permitted');
      const cleared = expectDeal(
        await updateDeal(ACTOR, mine, { version: await v(mine), ownerUserId: null }),
        'updateDeal',
        200,
        'team lead clears the owner',
      );
      expect(cleared).toMatchObject({ ownerUserId: null, owner: null });
    });

    it('the body is closed (D-L120): stageId, pipelineId, programmeId, timestamps, checks, checkedBy and server-owned keys are 400 and nothing is written, even for an admin', async () => {
      await control();
      const id = await plantDeal({ id: D('531') });
      await plantCheck(id, FA1.RC_PROP, USER_A_AGENT_1, Date.now() - DAY);
      const before = await dealRow(id);
      const checksBefore = await checksOf(id);
      const quiet = await auditIds();
      const forbidden: Json = {
        // S0 -> S1 IS a transition; still never through updateDeal.
        stageId: FA1.S1,
        pipelineId: FA1B.P,
        programmeId: PROGRAMME_A2,
        updatedAt: iso(Date.UTC(2020, 0, 1)),
        createdAt: iso(Date.UTC(2020, 0, 1)),
        stageEnteredAt: iso(Date.UTC(2020, 0, 1)),
        closedAt: iso(Date.UTC(2020, 0, 1)),
        checks: [{ requirementId: FA1.RC_PROP, checkedBy: { id: USER_A_SUPERVISOR } }],
        checkedBy: USER_A_SUPERVISOR,
        checkedAt: iso(Date.UTC(2020, 0, 1)),
        weightedAmount: { amountMinor: '1', currency: 'NGN' },
        owner: { id: USER_A_SUPERVISOR, displayName: 'x' },
        contact: { id: FA1.contact, displayName: 'x' },
        account: { id: FA1.account, name: 'x' },
        id: D('532'),
        withheldFields: ['amount'],
        rotting: 'fresh',
        currency: 'GHS',
      };
      for (const headers of [AGENT_1, SUPERVISOR]) {
        for (const [key, value] of Object.entries(forbidden)) {
          const response = await updateDeal(headers, id, { version: 1, nextStep: 'T-0108 smuggled', [key]: value });
          expectError(response, 400, 'validation_failed');
          expectNoStore(response, key);
        }
        for (const raw of [
          '{"version":1,"nextStep":"T-0108 proto","__proto__":{"stageId":"x"}}',
          '{"version":1,"nextStep":"T-0108 ctor","constructor":{"prototype":{"stageId":"x"}}}',
        ]) {
          expectError(await sendRaw('patch', `${DEALS}/${id}`, headers, raw), 400, 'validation_failed');
        }
        for (const body of [{ version: 1 }, {}, [], 'x', null, { version: 1, name: null }, { version: 1, name: '' }, { version: 1, nextStep: '' }]) {
          expectError(await updateDeal(headers, id, body), 400, 'validation_failed');
        }
      }
      expect(await dealRow(id), 'not one column changed').toEqual(before);
      expect(await checksOf(id), 'checks untouched').toEqual(checksBefore);
      expect(await auditSince(quiet)).toEqual([]);
      expectDeal(await updateDeal(AGENT_1, id, { version: 1, nextStep: 'T-0108 control' }), 'updateDeal', 200, 'control');
      expect((await dealRow(id))?.stage_id).toBe(FA1.S0);
    });

    it('version: a stale one is 409 and changes nothing; malformed or missing is 400; order 404, 403, 400, 409', async () => {
      await control();
      const mine = await plantDeal({ id: D('541') });
      const theirs = await plantDeal({ id: D('542'), owner: USER_A_SUPERVISOR });
      const a2 = await plantDeal({ id: D('543'), f: FA2 });
      expectDeal(await updateDeal(AGENT_1, mine, { version: 1, nextStep: 'T-0108 one' }), 'updateDeal', 200, 'control: 1 -> 2');
      const before = await dealRow(mine);
      const stale = await updateDeal(AGENT_1, mine, { version: 1, nextStep: 'T-0108 stale' });
      expectError(stale, 409, 'stale_write');
      expectNoStore(stale, '409');
      expect(await dealRow(mine), 'a 409 changes nothing').toEqual(before);
      expectError(await updateDeal(AGENT_1, mine, { version: 99, nextStep: 'x' }), 409, 'stale_write');
      for (const version of [0, -1, 2 ** 31, 1.5, '2', null]) {
        expectError(await updateDeal(AGENT_1, mine, { version, nextStep: 'x' }), 400, 'validation_failed');
      }
      expectError(await updateDeal(AGENT_1, mine, { nextStep: 'x' }), 400, 'validation_failed');
      // 400 before 409.
      expectError(await updateDeal(AGENT_1, mine, { version: 99, name: '' }), 400, 'validation_failed');
      // 403 before 400 and 409.
      expectError(await updateDeal(AGENT_1, theirs, { version: 99, name: '' }), 403, 'not_permitted');
      expectForbidden(
        await updateDeal(AGENT_1, mine, { version: 99, ownerUserId: null, name: '' }),
        'owner_not_self',
        ['ownerUserId'],
        'owner_not_self before 400/409',
      );
      await lockField('next_step', 'agent', 'read');
      expectForbidden(
        await updateDeal(AGENT_1, mine, { version: 99, nextStep: 'x', name: '' }),
        'field_not_editable',
        ['nextStep'],
        'field_not_editable before 400/409',
      );
      // 404 first.
      expectError(await updateDeal(AGENT_1, a2, { version: 99, name: '' }), 404, 'not_found');
      expect(await dealRow(mine)).toEqual(before);
    });

    it('D-L102: absent fields are untouched, null clears, and a second save after a 409 keeps the other person’s change', async () => {
      await control();
      const id = await plantDeal({
        id: D('551'),
        contact: FA1.contact,
        account: FA1.account,
        nextStep: 'T-0108 original step',
        expectedCloseDate: '2031-05-05',
      });
      const opened = await v(id);
      // The supervisor changes the close date; agent 1 then saves the next step on the old version.
      expectDeal(await updateDeal(SUPERVISOR, id, { version: opened, expectedCloseDate: '2031-07-07' }), 'updateDeal', 200, 'supervisor');
      expectError(await updateDeal(AGENT_1, id, { version: opened, nextStep: 'T-0108 mine' }), 409, 'stale_write');
      const second = expectDeal(
        await updateDeal(AGENT_1, id, { version: await v(id), nextStep: 'T-0108 mine' }),
        'updateDeal',
        200,
        'second save sends only nextStep',
      );
      expect(second).toMatchObject({
        nextStep: 'T-0108 mine',
        expectedCloseDate: '2031-07-07',
        primaryContactId: FA1.contact,
        accountId: FA1.account,
        amount: { amountMinor: '250000', currency: 'NGN' },
      });
      const cleared = expectDeal(
        await updateDeal(AGENT_1, id, { version: await v(id), nextStep: null, primaryContactId: null, expectedCloseDate: null }),
        'updateDeal',
        200,
        'null clears',
      );
      expect(cleared).toMatchObject({ nextStep: null, primaryContactId: null, contact: null, expectedCloseDate: null, accountId: FA1.account });
      const row = await dealRow(id);
      expect([row?.next_step, row?.primary_contact_id, row?.expected_close_date, row?.account_id]).toEqual([null, null, null, FA1.account]);
      expect(second.version, 'version advanced').toBeGreaterThan(opened);
      expect(cleared.version).toBe(await v(id));
    });

    it('a won or lost deal is edited only with write-any: the agent who owns it is 403, a team lead is 200', async () => {
      await control();
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      for (const [id, at] of [
        [D('561'), 5],
        [D('562'), 6],
      ] as const) {
        await plantDeal({ id, at });
        expectError(await updateDeal(AGENT_1, id, { version: 1, nextStep: 'x' }), 403, 'not_permitted');
        expectError(await updateDeal(AGENT_1, id, { version: 1, name: '' }), 403, 'not_permitted');
        expect(await versionOf(id)).toBe(1);
        expectDeal(await updateDeal(ACTOR, id, { version: 1, nextStep: 'T-0108 lead' }), 'updateDeal', 200, `team lead edits stage ${at}`);
      }
    });

    it('concurrent writes on one version: exactly one wins, the rest are 409, one audit event (R14)', async () => {
      await control();
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      const id = await plantDeal({ id: D('571') });
      const quiet = await auditIds();
      const responses = await Promise.all([
        moveDeal(ACTOR, id, { version: 1, toStageId: FA1.S1 }),
        moveDeal(ACTOR, id, { version: 1, toStageId: FA1.SL }),
        updateDeal(ACTOR, id, { version: 1, nextStep: 'T-0108 race a' }),
        updateDeal(AGENT_1, id, { version: 1, nextStep: 'T-0108 race b' }),
      ]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses, JSON.stringify(responses.map((r) => r.body))).toEqual([200, 409, 409, 409]);
      for (const response of responses) {
        if (response.status === 409) expectError(response, 409, 'stale_write');
      }
      expect(await versionOf(id), 'one write applied').toBe(2);
      expect(await auditSince(quiet), 'one event').toHaveLength(1);
    });
  });

  // =========================================================================
  // 6. moveDeal (D-L88, D-P20, R4–R7, R12, R17, R20).
  // =========================================================================

  describe('moveDeal: transitions, requirements, effects, rights, order', () => {
    it('moves only along a transition; anything else, the current stage included, is 409 transition_not_allowed and changes nothing', async () => {
      await control();
      const id = await plantDeal({ id: D('601'), enteredAt: Date.now() - 3 * DAY });
      const before = Date.now();
      const moved = expectDeal(await moveDeal(AGENT_1, id, { version: 1, toStageId: FA1.S1 }), 'moveDeal', 200, 'S0 -> S1');
      const after = Date.now();
      expect(moved).toMatchObject({ stageId: FA1.S1, closedAt: null, rotting: 'fresh' });
      const entered = Date.parse(String(moved.stageEnteredAt));
      expect(entered).toBeGreaterThanOrEqual(before - SKEW);
      expect(entered).toBeLessThanOrEqual(after + SKEW);
      expect(Number(moved.version)).toBeGreaterThan(1);
      expect(moved.version, 'the returned version is the stored one').toBe(await v(id));
      expect((await dealRow(id))?.stage_id).toBe(FA1.S1);
      const row = await dealRow(id);
      for (const [target, why] of [
        [FA1.S3, 'skips a stage'],
        [FA1.SW, 'won only from the last open stage'],
        [FA1.S1, 'the current stage'],
      ] as const) {
        const response = await moveDeal(AGENT_1, id, { version: await v(id), toStageId: target });
        expectError(response, 409, 'transition_not_allowed');
        expectNoStore(response, why);
        expect(await dealRow(id), `${why}: nothing changed`).toEqual(row);
      }
      // Back to any earlier open stage is allowed.
      expectDeal(await moveDeal(AGENT_1, id, { version: await v(id), toStageId: FA1.S0 }), 'moveDeal', 200, 'back');
    });

    it('closedAt follows the stage kind: set on won or lost, cleared on reopening; leaving won or lost needs write-any (R17); won to lost is not a transition', async () => {
      await control();
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      // Lost from any open stage, by the owning agent.
      const lostId = await plantDeal({ id: D('611'), at: 1 });
      const lost = expectDeal(await moveDeal(AGENT_1, lostId, { version: 1, toStageId: FA1.SL }), 'moveDeal', 200, 'mark lost');
      expect(lost).toMatchObject({ stageId: FA1.SL, rotting: null, weightedAmount: { amountMinor: '0', currency: 'NGN' } });
      expect(lost.closedAt, 'closedAt is the stage entry time').toBe(lost.stageEnteredAt);
      expect(msOf((await dealRow(lostId))?.closed_at)).toBe(Date.parse(String(lost.closedAt)));
      // The agent may not leave lost, even with a broken body.
      for (const body of [{ version: await v(lostId), toStageId: FA1.S0 }, { version: 'x' }, {}]) {
        expectError(await moveDeal(AGENT_1, lostId, body), 403, 'not_permitted');
      }
      const reopened = expectDeal(await moveDeal(ACTOR, lostId, { version: await v(lostId), toStageId: FA1.S1 }), 'moveDeal', 200, 'team lead reopens');
      expect(reopened).toMatchObject({ closedAt: null, rotting: 'fresh' });
      expect((await dealRow(lostId))?.closed_at).toBeNull();
      // Won only from Contract, requirements met.
      const wonId = await plantDeal({ id: D('612'), at: 4, contact: FA1.contact, account: FA1.account, nextStep: 'T-0108 sign' });
      await plantCheck(wonId, FA1.RC_PO, USER_A_AGENT_1, Date.now() - HOUR);
      const won = expectDeal(await moveDeal(AGENT_1, wonId, { version: 1, toStageId: FA1.SW }), 'moveDeal', 200, 'won');
      expect(won).toMatchObject({ stageId: FA1.SW, rotting: null, weightedAmount: { amountMinor: '250000', currency: 'NGN' } });
      expect(won.closedAt).toBe(won.stageEnteredAt);
      expectError(await moveDeal(AGENT_1, wonId, { version: await v(wonId), toStageId: FA1.S0 }), 403, 'not_permitted');
      const wonToLost = await moveDeal(ACTOR, wonId, { version: await v(wonId), toStageId: FA1.SL });
      expectError(wonToLost, 409, 'transition_not_allowed');
      const back = expectDeal(await moveDeal(ACTOR, wonId, { version: await v(wonId), toStageId: FA1.S0 }), 'moveDeal', 200, 'leave won');
      expect(back.closedAt).toBeNull();
      // Open to open keeps closedAt null.
      const step = expectDeal(await moveDeal(ACTOR, wonId, { version: await v(wonId), toStageId: FA1.S1 }), 'moveDeal', 200, 'open to open');
      expect(step.closedAt).toBeNull();
    });

    it('a toStageId that is not a stage of the deal’s pipeline is one unknown_reference body, whatever the reason (R4)', async () => {
      await control();
      const id = await plantDeal({ id: D('621') });
      const bodies: string[] = [];
      for (const target of [FA1B.S1, FA2.S1, FB1.S1, NOWHERE, FA1.P, FA1.RC_PROP, 'not-a-uuid', '']) {
        const response = await moveDeal(AGENT_1, id, { version: 1, toStageId: target });
        expectDetail(response, 'toStageId', 'unknown_reference', String(target));
        bodies.push(textOf(response));
      }
      expect(new Set(bodies).size, 'one body').toBe(1);
      expectError(await moveDeal(AGENT_1, id, { version: 1 }), 400, 'validation_failed');
      expect(await versionOf(id)).toBe(1);
      expectDeal(await moveDeal(AGENT_1, id, { version: 1, toStageId: FA1.S1 }), 'moveDeal', 200, 'control');
    });

    it('422 requirements_unmet names requirement ids only, and a refused move writes nothing: no field, no check, no stage, no audit (R12)', async () => {
      await control();
      const id = await plantDeal({ id: D('631'), at: 2, amountMinor: null, expectedCloseDate: null, nextStep: 'T-0108 secret step zqvvalue' });
      const before = await dealRow(id);
      const quiet = await auditIds();
      const bare = await moveDeal(AGENT_1, id, { version: 1, toStageId: FA1.S3 });
      const body = expectError(bare, 422, 'requirements_unmet');
      expectNoStore(bare, '422');
      expect(detailsOf(body).map((d) => `${d.path}:${d.code}`).sort()).toEqual(
        [FA1.RF_AMT, FA1.RF_ECD, FA1.RC_QUOTE].map((r) => `requirements.${r}:requirement_unmet`).sort(),
      );
      for (const leak of [LABEL_MARK, 'zqvvalue', 'quote sent', 'expectedCloseDate', 'expected_close_date', 'amount']) {
        expect(textOf(bare), `422 body carries "${leak}"`).not.toContain(leak);
      }
      // Two of three supplied; amount still missing: nothing of it is applied.
      const partial = await moveDeal(AGENT_1, id, {
        version: 1,
        toStageId: FA1.S3,
        fields: { expectedCloseDate: '2031-04-30' },
        checks: [FA1.RC_QUOTE],
      });
      expect(detailsOf(expectError(partial, 422, 'requirements_unmet'))).toEqual([
        { path: `requirements.${FA1.RF_AMT}`, code: 'requirement_unmet' },
      ]);
      expect(await dealRow(id), 'the date was not written').toEqual(before);
      expect(await checksOf(id), 'the check was not recorded').toEqual([]);
      expect(await auditSince(quiet)).toEqual([]);
      // All three: applied together with the stage.
      const t0 = Date.now();
      const moved = expectDeal(await moveDeal(AGENT_1, id, await toNegotiation(id)), 'moveDeal', 200, 'all met');
      const t1 = Date.now();
      expect(moved).toMatchObject({
        stageId: FA1.S3,
        amount: { amountMinor: '500000', currency: 'NGN' },
        expectedCloseDate: '2031-04-30',
      });
      const row = await dealRow(id);
      expect([row?.stage_id, row?.amount_text, row?.ecd_text]).toEqual([FA1.S3, '500000', '2031-04-30']);
      const checks = await checksOf(id);
      expect(checks.map((c) => [c.requirement_id, c.checked_by_user_id])).toEqual([[FA1.RC_QUOTE, USER_A_AGENT_1]]);
      const checkedAt = msOf(checks[0]?.checked_at) ?? 0;
      expect(checkedAt).toBeGreaterThanOrEqual(t0 - SKEW);
      expect(checkedAt).toBeLessThanOrEqual(t1 + SKEW);
      expect(checksSummary(moved.checks)).toEqual([
        [FA1.RC_QUOTE, USER_A_AGENT_1, displayNameOf(USER_A_AGENT_1), checkedAt],
      ]);
    });

    it('checks are attributed to the SESSION user and the server’s time, never to anything in the body; a recorded check stays recorded and is never re-attributed (R6)', async () => {
      await control();
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      const id = await plantDeal({ id: D('641'), at: 2 });
      const count = await checkCount();
      for (const smuggled of [
        { checks: [{ requirementId: FA1.RC_QUOTE, checkedBy: USER_A_SUPERVISOR }] },
        { checks: [FA1.RC_QUOTE], checkedBy: USER_A_SUPERVISOR },
        { checks: [FA1.RC_QUOTE], checkedAt: iso(Date.UTC(2020, 0, 1)) },
        { checks: [FA1.RC_QUOTE], fields: { amount: { amountMinor: '5', currency: 'NGN' }, expectedCloseDate: '2031-04-30', checkedBy: USER_A_SUPERVISOR } },
        { checks: [FA1.RC_QUOTE], stageEnteredAt: iso(Date.UTC(2020, 0, 1)) },
        { checks: [FA1.RC_QUOTE], closedAt: null },
        { checks: [FA1.RC_QUOTE], ownerUserId: USER_A_NO_PROGRAMME },
        { checks: [FA1.RC_QUOTE], fields: { ownerUserId: USER_A_NO_PROGRAMME } },
        { checks: [FA1.RC_QUOTE, FA1.RC_QUOTE] },
      ]) {
        const response = await moveDeal(ACTOR, id, {
          version: 1,
          toStageId: FA1.S3,
          fields: { amount: { amountMinor: '5', currency: 'NGN' }, expectedCloseDate: '2031-04-30' },
          ...smuggled,
        });
        expectError(response, 400, 'validation_failed');
      }
      expect(await checkCount(), 'nothing recorded').toBe(count);
      // The team lead moves agent 1's deal: the tick is the team lead's, not the owner's.
      const moved = expectDeal(await moveDeal(ACTOR, id, await toNegotiation(id)), 'moveDeal', 200, 'team lead ticks');
      const first = await checksOf(id);
      expect(first.map((c) => c.checked_by_user_id)).toEqual([USER_A_NO_PROGRAMME]);
      expect((moved.checks as Json[]).map((c) => (c.checkedBy as Json).id)).toEqual([USER_A_NO_PROGRAMME]);
      // Back to Proposal and forward again: the recorded check satisfies the gate. A backward move
      // is gated too (D-P20: the target stage's requirements), so Proposal's own check is planted first (D-L126).
      await plantCheck(id, FA1.RC_PROP, USER_A_SUPERVISOR, Date.now() - HOUR);
      expectDeal(await moveDeal(SUPERVISOR, id, { version: await v(id), toStageId: FA1.S2 }), 'moveDeal', 200, 'back');
      expectDeal(await moveDeal(SUPERVISOR, id, { version: await v(id), toStageId: FA1.S3 }), 'moveDeal', 200, 'forward on the old tick');
      // Ticked again by someone else: accepted, never re-attributed.
      await moveDeal(SUPERVISOR, id, { version: await v(id), toStageId: FA1.S2 });
      const again = expectDeal(
        await moveDeal(SUPERVISOR, id, { version: await v(id), toStageId: FA1.S3, checks: [FA1.RC_QUOTE] }),
        'moveDeal',
        200,
        'resend a recorded check',
      );
      expect(
        (await checksOf(id)).filter((c) => c.requirement_id === FA1.RC_QUOTE),
        'the first tick stands',
      ).toEqual(first);
      expect(checksSummary(again.checks).filter(([requirementId]) => requirementId === FA1.RC_QUOTE)).toEqual([
        [FA1.RC_QUOTE, USER_A_NO_PROGRAMME, displayNameOf(USER_A_NO_PROGRAMME), msOf(first[0]?.checked_at)],
      ]);
    });

    it('fields and checks name only the target stage’s own requirements: anything else is not_a_requirement, one body for checks whatever the id (R5)', async () => {
      await control();
      const id = await plantDeal({ id: D('651'), at: 2 });
      const base = { version: 1, toStageId: FA1.S3, fields: { expectedCloseDate: '2031-04-30' } };
      expectDetail(
        await moveDeal(AGENT_1, id, { ...base, fields: { expectedCloseDate: '2031-04-30', nextStep: 'T-0108 x' }, checks: [FA1.RC_QUOTE] }),
        'fields.nextStep',
        'not_a_requirement',
        'nextStep is not a Negotiation requirement',
      );
      expectDetail(
        await moveDeal(AGENT_1, id, { ...base, fields: { expectedCloseDate: '2031-04-30', accountId: FA1.account }, checks: [FA1.RC_QUOTE] }),
        'fields.accountId',
        'not_a_requirement',
        'accountId',
      );
      const bodies: string[] = [];
      for (const check of [FA1.RC_PROP, FA1.RC_PO, FA1.RF_AMT, FA1B.RC_QUOTE, FA2.RC_QUOTE, FB1.RC_QUOTE, NOWHERE]) {
        const response = await moveDeal(AGENT_1, id, { ...base, checks: [check] });
        const body = expectError(response, 400, 'validation_failed');
        expect(
          detailsOf(body).some((d) => d.code === 'not_a_requirement' && d.path.startsWith('checks')),
          `${check}: ${JSON.stringify(body.details)}`,
        ).toBe(true);
        bodies.push(textOf(response));
      }
      expect(new Set(bodies).size, 'one body, whatever the id').toBe(1);
      for (const fields of [{}, { amount: null }, { expectedCloseDate: null }, { stageId: FA1.S3 }]) {
        expectError(await moveDeal(AGENT_1, id, { ...base, fields }), 400, 'validation_failed');
      }
      expectError(await moveDeal(AGENT_1, id, { ...base, checks: ['not-a-uuid'] }), 400, 'validation_failed');
      // To Lost, which has no requirements, nothing may be filled.
      expectDetail(
        await moveDeal(AGENT_1, id, { version: 1, toStageId: FA1.SL, fields: { expectedCloseDate: '2031-04-30' } }),
        'fields.expectedCloseDate',
        'not_a_requirement',
        'lost',
      );
      expect(await versionOf(id)).toBe(1);
      expect(await checksOf(id)).toEqual([]);
      expectDeal(await moveDeal(AGENT_1, id, await toNegotiation(id)), 'moveDeal', 200, 'control');
    });

    it('a required field the mover cannot read refuses the move whatever its value, with identical bodies; one they read but cannot edit refuses only when unmet (R7)', async () => {
      await control();
      const filled = await plantDeal({ id: D('661'), at: 2, amountMinor: '900' });
      const empty = await plantDeal({ id: D('662'), at: 2, amountMinor: null });
      const body = async (id: string) => ({
        version: await v(id),
        toStageId: FA1.S3,
        fields: { expectedCloseDate: '2031-04-30' },
        checks: [FA1.RC_QUOTE],
      });
      await lockField('amount', 'agent', 'none');
      const texts: string[] = [];
      for (const id of [filled, empty]) {
        const response = await moveDeal(AGENT_1, id, await body(id));
        expectForbidden(response, 'field_not_editable', ['amount', 'fields.amount'], `withheld amount, ${id}`);
        texts.push(textOf(response));
      }
      expect(texts[0], 'a withheld field never says whether it is empty').toBe(texts[1]);
      expect(texts.join()).not.toContain('900');
      await lockField('amount', 'agent', 'read');
      expectDeal(await moveDeal(AGENT_1, filled, await body(filled)), 'moveDeal', 200, 'read-only and met');
      expectForbidden(
        await moveDeal(AGENT_1, empty, await body(empty)),
        'field_not_editable',
        ['amount', 'fields.amount'],
        'read-only and unmet: 403, not 422',
      );
      // Sending a read-only field in `fields` is refused on the key.
      expectForbidden(
        await moveDeal(AGENT_1, empty, { ...(await body(empty)), fields: { amount: { amountMinor: '5', currency: 'NGN' }, expectedCloseDate: '2031-04-30' } }),
        'field_not_editable',
        ['fields.amount', 'amount'],
        'a read-only key sent',
      );
      expect((await dealRow(empty))?.amount_minor).toBeNull();
      expect(await checksOf(empty)).toEqual([]);
    });

    it('the rights matrix for moves: agents their own, the others any, qa_analyst none, client_portal 404; own acts as none when ownerUserId is withheld', async () => {
      await control();
      const expected: [string, number, number][] = [
        ['agent', 200, 403],
        ['team_lead', 200, 200],
        ['programme_manager', 200, 200],
        ['admin', 200, 200],
        ['qa_analyst', 403, 403],
        ['client_portal', 404, 404],
      ];
      let tail = 0;
      for (const [key, own, other] of expected) {
        await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, key);
        const ownId = await plantDeal({ id: D(`67${(tail += 1).toString(16)}`), owner: USER_A_NO_PROGRAMME });
        const otherId = await plantDeal({ id: D(`67${(tail += 1).toString(16)}`), owner: USER_A_AGENT_1 });
        for (const [id, status, whose] of [
          [ownId, own, 'own'],
          [otherId, other, 'another’s'],
        ] as const) {
          const response = await moveDeal(ACTOR, id, { version: 1, toStageId: FA1.S1 });
          expectStatus(response, status, `${key} moves ${whose} deal`);
          expect((await dealRow(id))?.stage_id).toBe(status === 200 ? FA1.S1 : FA1.S0);
        }
      }
      // ownerUserId withheld from the agent set: every deal is the same 403 (D-L115).
      await lockField('owner_user_id', 'agent', 'none');
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      const mine = await plantDeal({ id: D('681') });
      const theirs = await plantDeal({ id: D('682'), owner: USER_A_AGENT_2 });
      const texts: string[] = [];
      for (const id of [mine, theirs]) {
        const moved = await moveDeal(AGENT_1, id, { version: 1, toStageId: FA1.S1 });
        const updated = await updateDeal(AGENT_1, id, { version: 1, nextStep: 'x' });
        expectError(moved, 403, 'not_permitted');
        expectError(updated, 403, 'not_permitted');
        texts.push(textOf(moved), textOf(updated));
      }
      expect(new Set(texts).size, 'no ownership oracle').toBe(1);
      const read = expectDeal(await getDeal(AGENT_1, mine), 'getDeal', 200, 'owner withheld');
      expect(read.withheldFields).toEqual(['ownerUserId']);
      // A team lead (write-any) still edits and moves, but cannot reassign a field it cannot edit.
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      await lockField('owner_user_id', 'team_lead', 'none');
      expectDeal(await moveDeal(ACTOR, mine, { version: 1, toStageId: FA1.S1 }), 'moveDeal', 200, 'team lead, owner withheld');
      expectForbidden(
        await updateDeal(ACTOR, theirs, { version: 1, ownerUserId: USER_A_NO_PROGRAMME }),
        'field_not_editable',
        ['ownerUserId'],
        'team lead reassigns a withheld owner',
      );
    });

    it('error order on a move: 404, 403, 403 on keys sent, 400, 403 on a required field, 409 stale, 409 transition, 422 (R20)', async () => {
      await control();
      const id = await plantDeal({ id: D('691'), at: 2, amountMinor: '900', expectedCloseDate: null });
      const a2 = await plantDeal({ id: D('692'), f: FA2, at: 2 });
      const v1 = await v(id);
      // 404 first.
      expectError(await moveDeal(AGENT_1, a2, {}), 404, 'not_found');
      // 403 action before anything in the body.
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'qa_analyst');
      expectError(await moveDeal(ACTOR, id, {}), 403, 'not_permitted');
      // 403 on a key sent, before 400.
      await lockField('amount', 'agent', 'read');
      expectForbidden(
        await moveDeal(AGENT_1, id, { version: 99, toStageId: NOWHERE, fields: { amount: { amountMinor: '1.5', currency: 'USD' } } }),
        'field_not_editable',
        ['fields.amount', 'amount'],
        'key before 400',
      );
      await lockField('amount', 'agent', 'edit');
      // 400 before the required-field 403 and before 409.
      expectDetail(await moveDeal(AGENT_1, id, { version: 99, toStageId: NOWHERE }), 'toStageId', 'unknown_reference', '400 before 409');
      await lockField('amount', 'agent', 'none');
      expectError(await moveDeal(AGENT_1, id, { version: 99, toStageId: FA1.S3, checks: [FA1.RC_PO] }), 400, 'validation_failed');
      // Required-field 403 before 409 stale and before 409 transition.
      expectForbidden(await moveDeal(AGENT_1, id, { version: 99, toStageId: FA1.S3 }), 'field_not_editable', ['amount', 'fields.amount'], 'before stale');
      const s0 = await plantDeal({ id: D('693'), at: 0 });
      expectForbidden(await moveDeal(AGENT_1, s0, { version: 1, toStageId: FA1.S3 }), 'field_not_editable', ['amount', 'fields.amount'], 'before transition');
      await lockField('amount', 'agent', 'edit');
      // 409 stale before 409 transition and 422.
      expectError(await moveDeal(AGENT_1, id, { version: 99, toStageId: FA1.SW }), 409, 'stale_write');
      expectError(await moveDeal(AGENT_1, id, { version: 99, toStageId: FA1.S3 }), 409, 'stale_write');
      // 409 transition before 422 (Negotiation is not reachable from Qualified, and its gates are unmet).
      expectError(await moveDeal(AGENT_1, s0, { version: 1, toStageId: FA1.S3 }), 409, 'transition_not_allowed');
      // Then 422.
      expectError(await moveDeal(AGENT_1, id, { version: v1, toStageId: FA1.S3 }), 422, 'requirements_unmet');
      expect(await versionOf(id)).toBe(v1);
      expect(await checksOf(id)).toEqual([]);
    });

    it('stageId changes only through moveDeal: create and update refuse it, and only a move changes the stored stage', async () => {
      await control();
      const count = await dealCount();
      expectError(await createDeal(SUPERVISOR, FA1.P, { name: 'T-0108 skip', stageId: FA1.S4 }), 400, 'validation_failed');
      expect(await dealCount()).toBe(count);
      const id = await plantDeal({ id: D('6a1') });
      for (const target of [FA1.S1, FA1.SW, FA1.SL]) {
        expectError(await updateDeal(SUPERVISOR, id, { version: 1, stageId: target }), 400, 'validation_failed');
      }
      expectDeal(await updateDeal(SUPERVISOR, id, { version: 1, name: 'T-0108 renamed', expectedCloseDate: '2031-09-09' }), 'updateDeal', 200, 'an edit');
      expect((await dealRow(id))?.stage_id, 'an edit never moves').toBe(FA1.S0);
      expectDeal(await moveDeal(SUPERVISOR, id, { version: await v(id), toStageId: FA1.S1 }), 'moveDeal', 200, 'the move');
      expect((await dealRow(id))?.stage_id).toBe(FA1.S1);
    });
  });

  // =========================================================================
  // 7. Field security (R13, R21).
  // =========================================================================

  describe('field security: withheld is omitted on reads and refused on writes', () => {
    it('withheld fields are omitted and named, derived summaries with them; read-only ones are present; name never; the admin set sees all; the tenant-admin flag lifts nothing', async () => {
      await control();
      const id = await plantDeal({
        id: D('701'),
        amountMinor: '777000111',
        expectedCloseDate: '2031-08-18',
        contact: A1_CONTACT_2.id,
        account: FA1.account,
        nextStep: 'T-0108 withheld step zqvstep',
      });
      await lockField('amount', 'agent', 'none');
      await lockField('next_step', 'agent', 'none');
      await lockField('primary_contact_id', 'agent', 'none');
      await lockField('account_id', 'agent', 'read');
      await lockField('expected_close_date', 'agent', 'read');
      await lockField('name', 'agent', 'none');
      const response = await getDeal(AGENT_1, id);
      const deal = expectDeal(response, 'getDeal', 200, 'agent');
      expect([...(deal.withheldFields as string[])].sort()).toEqual(['amount', 'nextStep', 'primaryContactId']);
      for (const key of ['amount', 'weightedAmount', 'nextStep', 'primaryContactId', 'contact']) {
        expect(key in deal, `${key} omitted, never nulled`).toBe(false);
      }
      expect(deal).toMatchObject({ accountId: FA1.account, expectedCloseDate: '2031-08-18', name: `T-0108 planted ${id.slice(-7)}` });
      for (const leak of ['777000111', halfEvenWeighted('777000111', 1000), 'zqvstep', A1_CONTACT_2.displayName, A1_CONTACT_2.id]) {
        expect(textOf(response), `the body carries ${leak}`).not.toContain(leak);
      }
      const listed = await listDeals(AGENT_1, FA1.P);
      expectStatus(listed, 200, 'list');
      expect(pageProblems(listed.body, 'list')).toEqual([]);
      const row = pageOf(listed.body).data.find((candidate) => candidate.id === id);
      expect([...((row?.withheldFields ?? []) as string[])].sort()).toEqual(['amount', 'nextStep', 'primaryContactId']);
      expect(textOf(listed)).not.toContain('777000111');
      // The admin set always edits: grants against it are ignored.
      await lockField('amount', 'admin', 'none');
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'admin');
      expect(expectDeal(await getDeal(ACTOR, id), 'getDeal', 200, 'admin set').withheldFields).toEqual([]);
      // The tenant-admin flag over team_lead obeys team_lead's grants.
      await assign(USER_A_SUPERVISOR, PROGRAMME_A1, 'team_lead');
      await lockField('amount', 'team_lead', 'none');
      const flagged = expectDeal(await getDeal(SUPERVISOR, id), 'getDeal', 200, 'flag over team_lead');
      expect(flagged.withheldFields).toEqual(['amount']);
      expectForbidden(
        await updateDeal(SUPERVISOR, id, { version: await v(id), amount: { amountMinor: '1', currency: 'NGN' } }),
        'field_not_editable',
        ['amount'],
        'the flag never lifts field security',
      );
      // Judged in the deal's own programme: agent 1 is team_lead in A2.
      await assign(USER_A_AGENT_1, PROGRAMME_A2, 'team_lead');
      await lockField('amount', 'team_lead', 'edit');
      const a2 = await plantDeal({ id: D('702'), f: FA2, amountMinor: '424242' });
      expect(expectDeal(await getDeal(AGENT_1, a2), 'getDeal', 200, 'A2 as team lead').amount).toEqual({ amountMinor: '424242', currency: 'GHS' });
    });

    it('writes to a withheld or read-only field are 403 field_not_editable on create and update, and a withheld field cannot be cleared', async () => {
      await control();
      const id = await plantDeal({ id: D('711'), nextStep: 'T-0108 hidden', account: FA1.account });
      await lockField('next_step', 'agent', 'none');
      await lockField('account_id', 'agent', 'read');
      await lockField('amount', 'agent', 'read');
      const before = await dealRow(id);
      for (const [body, path] of [
        [{ nextStep: 'T-0108 new' }, 'nextStep'],
        [{ nextStep: null }, 'nextStep'],
        [{ accountId: null }, 'accountId'],
        [{ accountId: FA1.account }, 'accountId'],
        [{ amount: { amountMinor: '250000', currency: 'NGN' } }, 'amount'],
      ] as const) {
        expectForbidden(await updateDeal(AGENT_1, id, { version: 1, ...body }), 'field_not_editable', [path], `update ${path}`);
        expectForbidden(await createDeal(AGENT_1, FA1.P, { name: 'T-0108 fls', ...body }), 'field_not_editable', [path], `create ${path}`);
      }
      expect(await dealRow(id)).toEqual(before);
      expectDeal(await updateDeal(AGENT_1, id, { version: 1, expectedCloseDate: '2031-12-12' }), 'updateDeal', 200, 'an editable field');
    });

    it('R21: an agent with ownerUserId withheld may create, owning the deal, but may not send ownerUserId, even as their own id', async () => {
      await control();
      await lockField('owner_user_id', 'agent', 'none');
      for (const owner of [USER_A_AGENT_1, USER_A_AGENT_1.toUpperCase(), null, USER_A_SUPERVISOR]) {
        expectForbidden(
          await createDeal(AGENT_1, FA1.P, { name: 'T-0108 r21', ownerUserId: owner }),
          'field_not_editable',
          ['ownerUserId'],
          `ownerUserId ${String(owner)}`,
        );
      }
      const created = expectDeal(await createDeal(AGENT_1, FA1.P, { name: 'T-0108 r21 ok' }), 'createDeal', 201, 'omitted');
      expect(created.withheldFields).toEqual(['ownerUserId']);
      expect('ownerUserId' in created || 'owner' in created).toBe(false);
      expect((await dealRow(String(created.id)))?.owner_user_id).toBe(USER_A_AGENT_1);
    });

    it('filters on a withheld field are 400 field_withheld at the parameter', async () => {
      await control();
      await plantDeal({ id: D('721') });
      expectStatus(await listDeals(AGENT_1, FA1.P, [['owner', 'me']]), 200, 'control: owner filter');
      await lockField('owner_user_id', 'agent', 'none');
      await lockField('amount', 'agent', 'none');
      await lockField('expected_close_date', 'agent', 'none');
      for (const [param, value] of [
        ['owner', 'me'],
        ['owner', 'unassigned'],
        ['currency', 'NGN'],
        ['closeFrom', '2031-01-01'],
        ['closeTo', '2031-12-31'],
      ] as const) {
        expectDetail(await listDeals(AGENT_1, FA1.P, [[param, value]]), param, 'field_withheld', `${param} withheld`);
      }
      for (const sort of ['name', '-updatedAt']) {
        expectStatus(await listDeals(AGENT_1, FA1.P, [['sort', sort]]), 200, `sort ${sort} never needs a withheld field`);
      }
    });
  });

  // =========================================================================
  // 8. Audit (D-L72, D-L71, D-L115, R8–R11) and leaks.
  // =========================================================================

  describe('audit: names, never values; a move records the stage ids', () => {
    const NAME = `T-0108 audited name ${RUN}`;
    const STEP = `T-0108 audited step ${RUN}`;
    const AMOUNT = '31415926535';

    const noValues = (event: AuditRow | undefined, extra: string[] = []) => {
      const raw = JSON.stringify(event?.changes ?? []) + String(event?.object_label);
      for (const value of [NAME, STEP, AMOUNT, '2031-11-11', ...extra]) {
        expect(raw, `the audit row carries "${value}"`).not.toContain(value);
      }
    };

    it('a create is one `created` event labelled by the id, naming the fields sent, by name (R8, R10)', async () => {
      await control();
      const before = await auditIds();
      const created = expectDeal(
        await createDeal(AGENT_1, FA1.P, {
          name: NAME,
          nextStep: STEP,
          amount: { amountMinor: AMOUNT, currency: 'NGN' },
          expectedCloseDate: '2031-11-11',
          primaryContactId: FA1.contact,
        }),
        'createDeal',
        201,
        'create',
      );
      const events = await auditSince(before);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        tenant_id: TENANT_A,
        actor_kind: 'user',
        actor_user_id: USER_A_AGENT_1,
        action: 'created',
        object_type: 'deal',
        object_id: created.id,
        object_label: created.id,
        programme_id: PROGRAMME_A1,
      });
      const changes = event?.changes ?? [];
      const fields = changes.map((change) => change.field);
      for (const field of ['name', 'nextStep', 'amount', 'expectedCloseDate', 'primaryContactId']) {
        expect(fields, `the create names ${field}`).toContain(field);
      }
      for (const change of changes) {
        expect(WRITABLE.has(change.field), `${change.field} is a writable field`).toBe(true);
        if (change.field === 'ownerUserId') {
          expect([named('ownerUserId'), { field: 'ownerUserId', before: null, after: USER_A_AGENT_1, redacted: false }]).toContainEqual(change);
        } else {
          expect(change, change.field).toEqual(named(change.field));
        }
      }
      noValues(event);
    });

    it('an update is one `updated` event naming exactly the changed fields; a reassignment records both owner ids; unchanged fields are not named (R11)', async () => {
      await control();
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'team_lead');
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      const id = await plantDeal({ id: D('801'), name: NAME, nextStep: 'T-0108 old step', expectedCloseDate: '2031-01-01' });
      const step = async (body: Json, expected: Change[], where: string) => {
        const before = await auditIds();
        expectDeal(await updateDeal(ACTOR, id, { version: await v(id), ...body }), 'updateDeal', 200, where);
        const events = await auditSince(before);
        expect(events, `${where}: one event`).toHaveLength(1);
        expect(events[0], where).toMatchObject({
          action: 'updated',
          object_type: 'deal',
          object_id: id,
          object_label: id,
          actor_user_id: USER_A_NO_PROGRAMME,
          programme_id: PROGRAMME_A1,
        });
        expect(byField(events[0]?.changes ?? []), `${where}: changes`).toEqual(byField(expected));
        noValues(events[0], ['T-0108 old step']);
      };
      await step({ nextStep: STEP }, [named('nextStep')], 'nextStep');
      await step({ amount: { amountMinor: AMOUNT, currency: 'NGN' }, expectedCloseDate: '2031-11-11' }, [named('amount'), named('expectedCloseDate')], 'two fields');
      await step({ nextStep: STEP, expectedCloseDate: '2031-12-12' }, [named('expectedCloseDate')], 'an unchanged field is not named');
      await step(
        { ownerUserId: USER_A_AGENT_2.toUpperCase() },
        [{ field: 'ownerUserId', before: USER_A_AGENT_1, after: USER_A_AGENT_2, redacted: false }],
        'reassign',
      );
      await step({ ownerUserId: null }, [{ field: 'ownerUserId', before: USER_A_AGENT_2, after: null, redacted: false }], 'clear the owner');
      await step({ name: `${NAME} two` }, [named('name')], 'rename');
    });

    it('a move is one `updated` event: the from and to stage ids, the filled fields and checks by name; refusals write none (R9, R12)', async () => {
      await control();
      const id = await plantDeal({ id: D('811'), at: 2, name: NAME, amountMinor: null, expectedCloseDate: null });
      const before = await auditIds();
      expectDeal(
        await moveDeal(AGENT_1, id, {
          version: await v(id),
          toStageId: FA1.S3,
          fields: { amount: { amountMinor: AMOUNT, currency: 'NGN' }, expectedCloseDate: '2031-11-11' },
          checks: [FA1.RC_QUOTE],
        }),
        'moveDeal',
        200,
        'move with fills',
      );
      const events = await auditSince(before);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({ action: 'updated', object_type: 'deal', object_id: id, object_label: id, actor_user_id: USER_A_AGENT_1, programme_id: PROGRAMME_A1 });
      const changes = event?.changes ?? [];
      const optional = new Set(['stageEnteredAt', 'closedAt']);
      const core = changes.filter((change) => !optional.has(change.field));
      expect(byField(core)).toEqual(
        byField([
          { field: 'stageId', before: FA1.S2, after: FA1.S3, redacted: false },
          named('amount'),
          named('expectedCloseDate'),
          named('checks'),
        ]),
      );
      for (const change of changes.filter((c) => optional.has(c.field))) expect(change).toEqual(named(change.field));
      noValues(event, [LABEL_MARK, USER_A_AGENT_1]);
      // A plain move: the stage ids only.
      const plain = await plantDeal({ id: D('812') });
      const quiet = await auditIds();
      expectDeal(await moveDeal(AGENT_1, plain, { version: 1, toStageId: FA1.SL }), 'moveDeal', 200, 'mark lost');
      const lost = await auditSince(quiet);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.changes.filter((c) => !optional.has(c.field))).toEqual([
        { field: 'stageId', before: FA1.S0, after: FA1.SL, redacted: false },
      ]);
      // Refusals: 403, 400, 409 stale, 409 transition, 422 — none audited.
      const refused = await plantDeal({ id: D('813'), at: 2, amountMinor: null });
      const silent = await auditIds();
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'qa_analyst');
      const statuses = [
        (await moveDeal(ACTOR, refused, { version: 1, toStageId: FA1.S3 })).status,
        (await moveDeal(AGENT_1, refused, { version: 1, toStageId: NOWHERE })).status,
        (await moveDeal(AGENT_1, refused, { version: 9, toStageId: FA1.S1 })).status,
        (await moveDeal(AGENT_1, refused, { version: 1, toStageId: FA1.SW })).status,
        (await moveDeal(AGENT_1, refused, { version: 1, toStageId: FA1.S3 })).status,
        (await updateDeal(AGENT_1, refused, { version: 9, nextStep: 'x' })).status,
      ];
      expect(statuses).toEqual([403, 400, 409, 409, 422, 409]);
      expect(await auditSince(silent), 'refusals are not audited').toEqual([]);
    });

    it('logs and spans never carry a deal name or next step, from reads, writes, moves or errors; error bodies carry no database text', async () => {
      await control();
      const SECRET_NAME = `T-0108 leak name zqvn${RUN}`;
      const SECRET_STEP = `T-0108 leak step zqvs${RUN}`;
      const id = await plantDeal({ id: D('821'), at: 3, name: SECRET_NAME, nextStep: SECRET_STEP, contact: FA1.contact });
      await plantCheck(id, FA1.RC_QUOTE, USER_A_AGENT_1, Date.now() - HOUR);
      const outcomes: [string, number, request.Response][] = [];
      const { telemetry, lines } = await captureEverything(async () => {
        outcomes.push(['get', 200, await getDeal(AGENT_1, id)]);
        outcomes.push(['list', 200, await listDeals(AGENT_1, FA1.P, [['q', 'leak name']])]);
        outcomes.push(['create', 201, await createDeal(AGENT_1, FA1.P, { name: SECRET_NAME, nextStep: SECRET_STEP })]);
        outcomes.push(['create too long', 400, await createDeal(AGENT_1, FA1.P, { name: `${SECRET_NAME}${'x'.repeat(200)}` })]);
        outcomes.push(['create fraction', 400, await createDeal(AGENT_1, FA1.P, { name: SECRET_NAME, amount: { amountMinor: '1.5', currency: 'NGN' } })]);
        outcomes.push(['update', 200, await updateDeal(AGENT_1, id, { version: await v(id), nextStep: `${SECRET_STEP} two` })]);
        outcomes.push(['update stale', 409, await updateDeal(AGENT_1, id, { version: 1, nextStep: SECRET_STEP })]);
        outcomes.push(['move unmet', 422, await moveDeal(AGENT_1, id, { version: await v(id), toStageId: FA1.S4 })]);
        outcomes.push([
          'move',
          200,
          await moveDeal(AGENT_1, id, {
            version: await v(id),
            toStageId: FA1.S4,
            fields: { nextStep: SECRET_STEP, accountId: FA1.account },
            checks: [FA1.RC_PO],
          }),
        ]);
        outcomes.push(['move bad stage', 400, await moveDeal(AGENT_1, id, { version: await v(id), toStageId: 'nope', fields: { nextStep: SECRET_STEP } })]);
      });
      expect(outcomes.map(([label, , response]) => [label, response.status])).toEqual(
        outcomes.map(([label, status]) => [label, status]),
      );
      const served = outcomes.map(([, , response]) => textOf(response)).join('\n');
      expect(served, 'control: the reads served the name').toContain(SECRET_NAME);
      expect(telemetry.spans.length, 'no spans were recorded — is telemetry wired?').toBeGreaterThan(0);
      for (const [haystack, what] of [
        [JSON.stringify(telemetry.spans), 'spans'],
        [lines.join('\n'), 'logs'],
      ] as const) {
        for (const secret of [`zqvn${RUN}`, `zqvs${RUN}`, FA1.contactName]) {
          expect(haystack, `${what} carry "${secret}"`).not.toContain(secret);
        }
      }
      for (const [label, status, response] of outcomes) {
        if (status < 400) continue;
        for (const secret of [`zqvn${RUN}`, `zqvs${RUN}`, LABEL_MARK, ...DATABASE_TEXT_IN_BODIES]) {
          expect(textOf(response), `the ${label} error body carries "${secret}"`).not.toContain(secret);
        }
      }
    });
  });

  // =========================================================================
  // 9. listDeals (D-P13, D-L80, D-L115, R18, R22).
  // =========================================================================

  describe('listDeals: scope, filters, sorting and id-only paging', () => {
    const t = Date.UTC(2031, 0, 1);

    async function ids(headers: Headers, pipelineId: string, params: Params = []): Promise<string[]> {
      const response = await listDeals(headers, pipelineId, [['limit', '100'], ...params]);
      const where = `list ${JSON.stringify(params)}`;
      expectStatus(response, 200, where);
      expectNoStore(response, where);
      expectNoTotals(response, where);
      expect(pageProblems(response.body, where)).toEqual([]);
      const page = pageOf(response.body);
      expect(page.nextCursor, `${where}: more than 100 rows; never planted here`).toBeNull();
      return page.data.map((deal) => String(deal.id));
    }

    it('lists this pipeline’s deals in reach, every stage, newest update first: never another pipeline’s, programme’s or tenant’s; qa reads, the portal is 404', async () => {
      await control();
      const now = Date.now();
      const planted = [
        await plantDeal({ id: D('901'), at: 0, updatedAt: now - 3 * HOUR }),
        await plantDeal({ id: D('902'), at: 2, owner: USER_A_SUPERVISOR, updatedAt: now - 1 * HOUR }),
        await plantDeal({ id: D('903'), at: 6, closedAt: now - DAY, updatedAt: now - 2 * HOUR }),
        await plantDeal({ id: D('904'), at: 5, closedAt: now - DAY, updatedAt: now - 2 * HOUR }),
      ];
      await plantDeal({ id: D('905'), f: FA1B });
      await plantDeal({ id: D('906'), f: FA2 });
      await plantDeal({ id: D('907'), f: FB1 });
      const expected = [D('902'), D('904'), D('903'), D('901')];
      expect(await ids(AGENT_1, FA1.P), 'every stage, lost included, -updatedAt then -id').toEqual(expected);
      expect(planted.sort()).toEqual([...expected].sort());
      expect(await ids(AGENT_1, FA1B.P)).toEqual([D('905')]);
      expect(await ids(SUPERVISOR, FA2.P)).toEqual([D('906')]);
      expect(await ids(TENANT_B_ADMIN, FB1.P)).toEqual([D('907')]);
      expect(await ids(AGENT_1, FA1.P), 'never the seeded deal of the default pipeline').not.toContain(SEEDED_DEAL.id);
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'qa_analyst');
      expect(await ids(ACTOR, FA1.P)).toEqual(expected);
      // R18: an unknown programmeId parameter neither narrows nor widens.
      expect(await ids(AGENT_1, FA1.P, [['programmeId', PROGRAMME_A2], ['pipelineId', FA2.P], ['tenantId', TENANT_B]])).toEqual(expected);
      await assign(USER_A_NO_PROGRAMME, PROGRAMME_A1, 'client_portal');
      expectError(await listDeals(ACTOR, FA1.P), 404, 'not_found');
    });

    it('closedSince: closed deals from the last 90 days by default, open deals regardless; at most 366 days back, never in the future, never clamped', async () => {
      await control();
      const now = Date.now();
      await plantDeal({ id: D('911'), at: 5, closedAt: now - 89 * DAY });
      await plantDeal({ id: D('912'), at: 5, closedAt: now - 91 * DAY });
      await plantDeal({ id: D('913'), at: 6, closedAt: now - 89 * DAY });
      await plantDeal({ id: D('914'), at: 6, closedAt: now - 91 * DAY });
      await plantDeal({ id: D('915'), at: 0, enteredAt: now - 400 * DAY });
      expect((await ids(AGENT_1, FA1.P)).sort()).toEqual([D('911'), D('913'), D('915')].sort());
      expect((await ids(AGENT_1, FA1.P, [['closedSince', iso(now - 100 * DAY)]])).sort()).toEqual(
        [D('911'), D('912'), D('913'), D('914'), D('915')].sort(),
      );
      expect((await ids(AGENT_1, FA1.P, [['closedSince', iso(now - 30 * DAY)]])).sort()).toEqual([D('915')]);
      expectDetail(await listDeals(AGENT_1, FA1.P, [['closedSince', iso(now - 367 * DAY)]]), 'closedSince', 'window_too_long', 'too far back');
      expectDetail(await listDeals(AGENT_1, FA1.P, [['closedSince', iso(now + DAY)]]), 'closedSince', 'invalid_window', 'future');
      for (const value of ['2031-01-01', 'yesterday', iso(now - DAY).replace('Z', '+01:00')]) {
        expectError(await listDeals(AGENT_1, FA1.P, [['closedSince', value]]), 400, 'validation_failed');
      }
    });

    it('filters: stageId (repeatable, this pipeline only), q (literal % and _, case- and diacritic-insensitive), owner, currency, closeFrom and closeTo', async () => {
      await control();
      await assign(USER_A_AGENT_2, PROGRAMME_A1, 'agent');
      await plantDeal({ id: D('921'), at: 0, name: 'T-0108 50% off pumps', owner: USER_A_AGENT_1, currency: 'NGN', expectedCloseDate: '2031-02-01' });
      await plantDeal({ id: D('922'), at: 1, name: 'T-0108 500 units', owner: USER_A_AGENT_2, currency: 'GHS', expectedCloseDate: '2031-03-01' });
      await plantDeal({ id: D('923'), at: 2, name: 'T-0108 a_b fittings', owner: null, currency: 'KES', expectedCloseDate: null });
      await plantDeal({ id: D('924'), at: 2, name: 'T-0108 axb Ọjà supply', owner: USER_A_AGENT_1, amountMinor: null, expectedCloseDate: '2031-04-01' });
      const sorted = async (params: Params) => (await ids(AGENT_1, FA1.P, params)).sort();
      expect(await sorted([['stageId', FA1.S0], ['stageId', FA1.S2]])).toEqual([D('921'), D('923'), D('924')]);
      for (const stageId of [FA1B.S0, FA2.S0, NOWHERE, 'not-a-uuid']) {
        expectDetail(await listDeals(AGENT_1, FA1.P, [['stageId', stageId]]), 'stageId', 'unknown_reference', stageId);
      }
      expect(await sorted([['q', '50%']])).toEqual([D('921')]);
      expect(await sorted([['q', '_']])).toEqual([D('923')]);
      expect(await sorted([['q', 'a_b']])).toEqual([D('923')]);
      expect(await sorted([['q', 'oja']])).toEqual([D('924')]);
      expect(await sorted([['q', 'ỌJÀ']])).toEqual([D('924')]);
      expect(await sorted([['q', 'PUMPS']])).toEqual([D('921')]);
      expectError(await listDeals(AGENT_1, FA1.P, [['q', 'a\u0000b']]), 400, 'validation_failed');
      expect(await sorted([['owner', 'me']])).toEqual([D('921'), D('924')]);
      expect(await sorted([['owner', 'unassigned']])).toEqual([D('923')]);
      expect(await sorted([['owner', USER_A_AGENT_2]])).toEqual([D('922')]);
      expect(await sorted([['owner', 'me'], ['owner', 'unassigned']])).toEqual([D('921'), D('923'), D('924')]);
      expectError(await listDeals(AGENT_1, FA1.P, [['owner', 'everyone']]), 400, 'validation_failed');
      expect(await sorted([['currency', 'GHS'], ['currency', 'KES']])).toEqual([D('922'), D('923')]);
      for (const currency of ['USD', 'XOF']) {
        expectDetail(await listDeals(AGENT_1, FA1.P, [['currency', currency]]), 'currency', 'unknown_currency', currency);
      }
      expect(await sorted([['closeFrom', '2031-02-15']])).toEqual([D('922'), D('924')]);
      expect(await sorted([['closeTo', '2031-03-01']])).toEqual([D('921'), D('922')]);
      expect(await sorted([['closeFrom', '2031-02-01'], ['closeTo', '2031-02-01']])).toEqual([D('921')]);
      expectDetail(await listDeals(AGENT_1, FA1.P, [['closeFrom', '2031-03-01'], ['closeTo', '2031-02-01']]), 'closeTo', 'invalid_window', 'reversed');
    });

    it('sort keys never withheld, ties by id in the same direction; amount, close date and owner are not sort keys; limit 1..100, default 25', async () => {
      await control();
      const names = ['T-0108 Bravo', 'T-0108 Alpha', 'T-0108 Bravo', 'T-0108 Charlie'];
      for (const [index, name] of names.entries()) {
        await plantDeal({ id: D(`93${index}`), name, createdAt: t + index * HOUR, enteredAt: t + (3 - index) * HOUR, updatedAt: t + index * HOUR });
      }
      expect(await ids(AGENT_1, FA1.P, [['sort', 'name']])).toEqual([D('931'), D('930'), D('932'), D('933')]);
      expect(await ids(AGENT_1, FA1.P, [['sort', '-name']])).toEqual([D('933'), D('932'), D('930'), D('931')]);
      expect(await ids(AGENT_1, FA1.P, [['sort', 'createdAt']])).toEqual([D('930'), D('931'), D('932'), D('933')]);
      expect(await ids(AGENT_1, FA1.P, [['sort', 'stageEnteredAt']])).toEqual([D('933'), D('932'), D('931'), D('930')]);
      expect(await ids(AGENT_1, FA1.P, [['sort', '-updatedAt']])).toEqual([D('933'), D('932'), D('931'), D('930')]);
      for (const sort of ['amount', '-amount', 'expectedCloseDate', '-expectedCloseDate', 'owner', 'ownerUserId', 'probability', 'weightedAmount']) {
        expectError(await listDeals(AGENT_1, FA1.P, [['sort', sort]]), 400, 'validation_failed');
      }
      for (let index = 0; index < 23; index += 1) {
        await plantDeal({ id: D(`94${index.toString(16).padStart(2, '0')}`), name: `T-0108 bulk ${index}` });
      }
      const byDefault = await listDeals(AGENT_1, FA1.P);
      expectStatus(byDefault, 200, 'default');
      expect(pageOf(byDefault.body).data).toHaveLength(25);
      expect(pageOf(byDefault.body).nextCursor).not.toBeNull();
      for (const limit of ['0', '101', 'x', '1.5', '-1']) {
        expectError(await listDeals(AGENT_1, FA1.P, [['limit', limit]]), 400, 'validation_failed');
      }
    });

    it('keyset paging: every limit walks the same deals in the same order; cursors carry an id only; a cursor out of scope is one invalid_cursor body (R22)', async () => {
      await control();
      const planted: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        planted.push(
          await plantDeal({
            id: D(`95${index}`),
            name: index < 4 ? `T-0108 alpha ${index}` : `T-0108 beta ${index}`,
            amountMinor: `86420${index}`,
            nextStep: `T-0108 step zqvc${index}`,
            updatedAt: t + (index % 3) * HOUR,
          }),
        );
      }
      await plantDeal({ id: D('958'), f: FA1B, name: 'T-0108 alpha other pipeline' });
      await plantDeal({ id: D('959'), f: FB1, name: 'T-0108 alpha tenant b' });
      const full = await ids(AGENT_1, FA1.P);
      expect([...full].sort()).toEqual([...planted].sort());
      const walk = async (headers: Headers, pipelineId: string, limit: number, params: Params = []) => {
        const seen: string[] = [];
        const cursors: string[] = [];
        let cursor: string | null = null;
        for (let pages = 0; pages < 20; pages += 1) {
          const query: [string, string][] = [['limit', String(limit)], ...params.map(([k, val]): [string, string] => [k, val])];
          if (cursor !== null) query.push(['cursor', cursor]);
          const response = await listDeals(headers, pipelineId, query);
          expectStatus(response, 200, `page ${pages + 1}`);
          expect(pageProblems(response.body, `page ${pages + 1}`)).toEqual([]);
          const page = pageOf(response.body);
          if (page.nextCursor !== null) {
            expect(page.data, 'a page with a cursor is full').toHaveLength(limit);
            cursors.push(page.nextCursor);
          }
          seen.push(...page.data.map((deal) => String(deal.id)));
          cursor = page.nextCursor;
          if (cursor === null) return { seen, cursors };
        }
        throw new Error('paging did not terminate');
      };
      for (const limit of [1, 2, 3, 6, 7]) {
        const { seen, cursors } = await walk(AGENT_1, FA1.P, limit);
        expect(seen, `limit ${limit}`).toEqual(full);
        for (const cursor of cursors) {
          const readings = cursorReadings(cursor).join('\n');
          for (const leak of ['alpha', 'beta', '86420', 'zqvc', '2031', String(t), String(t / SECOND)]) {
            expect(readings, `a cursor carries "${leak}"`).not.toContain(leak);
          }
        }
      }
      const { cursors: other } = await walk(AGENT_1, FA1B.P, 1, [['q', 'alpha']]);
      // FA1B has one deal: no cursor. Build cross-scope cursors from real walks instead.
      expect(other).toEqual([]);
      await plantDeal({ id: D('95a'), f: FA1B, name: 'T-0108 alpha other two' });
      const otherPipeline = must((await walk(AGENT_1, FA1B.P, 1)).cursors[0], 'a cursor from the other pipeline');
      await plantDeal({ id: D('95b'), f: FB1, name: 'T-0108 alpha tenant b two' });
      const tenantB = must((await walk(TENANT_B_ADMIN, FB1.P, 1)).cursors[0], 'a cursor from tenant B');
      await plantDeal({ id: D('95c'), f: FA2 });
      await plantDeal({ id: D('95d'), f: FA2 });
      const programmeA2 = must((await walk(SUPERVISOR, FA2.P, 1)).cursors[0], 'a cursor from A2');
      const alpha = must((await walk(AGENT_1, FA1.P, 1, [['q', 'alpha']])).cursors[0], 'an alpha cursor');
      const bodies: string[] = [];
      for (const [label, cursor, params] of [
        ['malformed', 'zz', []],
        ['garbage', '!!!!', []],
        ['built', Buffer.from(`{"id":"${NOWHERE}"}`).toString('base64url'), []],
        ['another pipeline', otherPipeline, []],
        ['another tenant', tenantB, []],
        ['another programme', programmeA2, []],
        ['no longer selected by the filters', alpha, [['q', 'beta']]],
      ] as const) {
        const response = await listDeals(AGENT_1, FA1.P, [['cursor', cursor], ...params]);
        expectDetail(response, 'cursor', 'invalid_cursor', label);
        bodies.push(textOf(response));
      }
      expect(new Set(bodies).size, 'one invalid_cursor body whatever the reason').toBe(1);
    });
  });
});
