import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { performance } from 'node:perf_hooks';
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
  SEED_PERMISSION_SETS,
  SEED_SCRIPTS,
  TENANT_A,
  TENANT_B,
  TENANT_SCOPED_TABLES,
  USER_A_AGENT_1,
  USER_A_AGENT_2,
  USER_A_SUPERVISOR,
  USER_B_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0095, duplicate sets, merge and undo, and contact soft
 * delete (migration). Agent 3 builds it. Written by QA (Agent 12) for the
 * lead BEFORE the build (D-L23, D-L25), from the merged T-0093 contract
 * (docs/api/records.openapi.yaml: listDuplicates, getContactMergePreview,
 * createContactMerge, undoContactMerge, listContactMerges), the task file and
 * D-P12, D-P14, D-P17, D-P23, D-P27, D-P28, D-P33, D-L146, D-L148, D-L151.
 * Not from an implementation: there is none.
 *
 * Companion: lead-edit cases in tests/acceptance/tenancy/adversarial
 * (database-level attacks on contact_merge). Helpers are restated, never
 * imported from another suite.
 *
 * ==========================================================================
 * PINNED INTERFACES (the builder honours these exactly)
 * ==========================================================================
 *
 * ROUTES are the contract's, nothing else:
 *   GET  /api/v1/programmes/{programmeId}/duplicates            DuplicatePage
 *   GET  /api/v1/contacts/{contactId}/merge-preview?with=       ContactMergePreview
 *   POST /api/v1/contact-merges                                 201 ContactMerge
 *   GET  /api/v1/contact-merges                                 ContactMergePage
 *   POST /api/v1/contact-merges/{mergeId}/undo                  ContactMerge
 * Every answer of these five is `Cache-Control: no-store` and validates
 * against the contract (a JSON-Schema checker below reads the YAML).
 *
 * THE MIGRATION (one file, the next free number on main at build time, so
 * this suite finds it by what it creates and never by number):
 *   - `contact.deleted_at timestamptz NULL`, no default; every seeded row NULL.
 *   - `contact_merge` with AT LEAST these columns, exactly these types:
 *       id uuid PK, tenant_id uuid NOT NULL, programme_id uuid NOT NULL,
 *       survivor_id uuid NOT NULL, merged_id uuid NOT NULL,
 *       merged_by_user_id uuid NOT NULL, created_at timestamptz NOT NULL,
 *       undo_until timestamptz NOT NULL, undone_at timestamptz NULL,
 *       undone_by_user_id uuid NULL, survivor_reverted boolean NULL,
 *       snapshot jsonb.
 *     Any further column is nullable or defaulted (the suite plants rows
 *     naming only these). `mergedAt` on the wire is `created_at`; `undoUntil`
 *     is `undo_until`.
 *   - ENABLED and FORCED RLS; a permissive FOR ALL policy whose WITH CHECK is
 *     identical to its USING and reads tenant and programme scope; in
 *     TENANT_SCOPED_TABLES.
 *   - Composite keys (0027 pattern): (tenant_id, programme_id, survivor_id)
 *     and (tenant_id, programme_id, merged_id) to contact, (tenant_id,
 *     programme_id) to programme, (tenant_id, merged_by_user_id) and
 *     (tenant_id, undone_by_user_id) to "user"; CHECK survivor_id <>
 *     merged_id. Proven by behaviour, never by constraint name.
 *   - kasuwa_app: SELECT and INSERT; UPDATE on undone_at, undone_by_user_id
 *     and survivor_reverted ONLY; no DELETE and no TRUNCATE, for it or any
 *     role it can enter.
 *   - audit_event_action_check: exactly the previous list plus `merged` and
 *     `restored`, NOT VALID (as 0030 did).
 *   - No SECURITY DEFINER (the census stays at two), no role, no extension,
 *     no new `app.*` setting, no VALIDATE CONSTRAINT.
 *
 * ==========================================================================
 * RULINGS where the contract or task is silent (this suite's; the lead may
 * reverse them). M-numbers are this file's, not decision ids.
 * ==========================================================================
 *
 * M1  `merged_by_user_id`, not the task file's `merged_by`: the house name
 *     for a user column (owner_user_id, created_by_user_id,
 *     requested_by_user_id). The undo right rests on it.
 * M2  A merge row's identity is fixed for the application role: tenant,
 *     programme, both contacts, the merger, `created_at`, `undo_until` and
 *     the `snapshot` are not UPDATE-able by kasuwa_app (column grants). An
 *     application bug must not be able to extend an undo window, re-point a
 *     merge or rewrite what undo will restore. The deferred purge (D-L146)
 *     brings its own identity.
 * M3  AUDIT. A merge writes exactly ONE audit_event row in total (any action,
 *     any object): action `merged`, object_type `contact`, object_id the
 *     survivor or the merged contact, the merge's programme, the session user
 *     as actor. Moving activities and deals adds no event. Every change has
 *     `before` and `after` null (field names only, D-L83); the changes name
 *     every compliance field the merge changed on the survivor (D-P28) and
 *     every field name is a MergeField, a compliance field or `custom.<key>`.
 *     No phone, email, name or company of either contact appears anywhere in
 *     the row. Undo writes exactly one `restored` row in total. A refused
 *     request writes none. The audit API lists both and its answer validates
 *     against admin.openapi.yaml, so `AuditAction` must admit `merged` and
 *     `restored` (a CONTRACT GAP: T-0093 did not add them; the builder adds
 *     them in admin.openapi.yaml).
 * M4  OWNER (D-L67, D-P23). The default never gives the survivor an owner who
 *     is not a member of the programme: it falls back to the other side's
 *     owner when that one is a member, else none. CHOOSING the side whose
 *     owner is not a member is `400 validation_failed`, detail
 *     `unknown_reference` at `choices.ownerUserId` (D-L67's body), and
 *     nothing is written. A CONTRACT GAP: the builder documents it in
 *     MergeInvalid.
 * M5  DUPLICATES CURSOR. D-L151 says the cursor carries only a contact id,
 *     the lowest in the last set. But the contract also says a pair may sit
 *     in a phone set AND an email set: two sets with the SAME lowest id. A
 *     page boundary between them makes an id-only "after this id" skip the
 *     second set for ever. This suite pins the walk (limit=1 to exhaustion
 *     returns every set exactly once, no page longer than `limit`) and lets
 *     the decoded cursor carry, besides that id, the literal `phone` or
 *     `email` and an integer 0..99 (a format version), as list-indexes I4
 *     lets a cursor carry a sort key's name. Never a phone, an email, a name
 *     or a time. TO THE LEAD: this widens D-L151's text, not its purpose.
 *     LEAD EDIT (T-0095, D-L162): the builder's cursor also carries an
 *     integer ordinal among sets sharing the lowest id and match kind (one
 *     contact sharing a different number with each of two others makes two
 *     phone sets with one lowest id: fixture T1-T3). Admitted as an integer
 *     0..99; a fractional, negative, string or boolean leaf is refused.
 * M6  "The ten most recently updated": with 12 matches the set is the ten
 *     newest. The fixture puts the lowest id among the ten, so "lowest id of
 *     the set" means the same whether read over the ten or the twelve.
 * M7  THROTTLE (LEAD EDIT, D-L163): listDuplicates admits exactly 20 per
 *     minute per user, and a tenant runs at most two scans at once (a third
 *     is 429 with Retry-After, while another tenant is still admitted). It
 *     was: admits 60..600 in a burst per user, then 429
 *     `too_many_requests` with an integer `Retry-After` >= 1; the throttle is
 *     decided before validation; another user is unaffected.
 * M8  LATENCY (D-L146: the T-0084 budget): at the 120k seed (60k per
 *     programme), a first page and a deep page of one programme's sets, best
 *     of three, each within 150 ms. If that fails, the builder escalates; a
 *     new table or index type is not the fix (D-P33).
 * M9  THE ONE 404. A merged-away contact answers every contact route with a
 *     body byte-identical to an invented id's on the same route. A write
 *     that NAMES it answers as one naming an invented id: createActivity
 *     `404`, createDeal and updateDeal `400 unknown_reference`,
 *     startScriptRun `404`. A listContacts cursor naming it answers exactly
 *     as a cursor naming a row out of scope.
 * M10 A SCRIPT RUN started before the merge: completing it afterwards never
 *     writes an activity on the merged-away contact (refused, or the call
 *     lands on the survivor: the builder's choice), and never 500.
 * M11 UNDO MOVES BACK exactly the children the merge moved that still point
 *     at the survivor. A deal re-pointed since stays where it is; an activity
 *     logged on the survivor since stays on the survivor.
 * M12 UNDO FIELD SECURITY (D-L151 "all-or-nothing"): the fields undo "would
 *     restore" are the survivor fields its revert would change. If one is not
 *     editable for the undoer: 403 field_not_editable naming it, and nothing
 *     changes (the contact stays merged away, the children stay).
 * M13 A REPEAT UNDO is 200 with the same body and writes no second event.
 * M14 The survivor's timeline still validates against the contract after a
 *     merge and after an undo (a `merged` or `restored` event must not
 *     surface as an item the contract does not define, nor as a 500).
 * M15 Precedence on createContactMerge is D-L53's: 404, then 403, then 400,
 *     then 409. So a caller without `contact.write` gets 403 whatever the
 *     body; a caller who cannot see a contact gets 404 whatever the rights.
 * M16 Preview `defaults`: asserted only on fields where the two sides differ
 *     (equal values may name either side). The merge without `choices`
 *     produces exactly what the preview said.
 *
 * NOT PINNED (the builder's or later): the form of D-P27's DATABASE layer
 * (the API behaviour is pinned; the task says escalate if it needs a GUC or
 * a definer); whether choosing `survivor` for a field one may not edit is
 * refused; script runs moving with the merge; the import duplicate check
 * (T-0094's suite); the merged contact's `version` after undo; the order of
 * contacts within a set; the order between a phone set and an email set with
 * the same lowest id.
 *
 * D-L23: on main there is no route (every new path answers Nest's 404), no
 * `contact_merge` and no `deleted_at`. Every test except those titled
 * "(self-check)" opens with a request that must succeed, or a read of a
 * migration artefact, and fails there. Negative assertions (404s, refusals)
 * always sit after a positive control in the same test, so none passes on a
 * server that merely has no route.
 *
 * Fixtures: packages/db/src/fixtures.ts plus rows planted by kasuwa_migrator
 * with ids in this suite's range (`11111111-0000-4000-8000-0095xxxxxxxx`).
 * Every value is synthetic. Writes: reseed before, after, and after every
 * test.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = resolve(REPO_ROOT, 'docs/api/records.openapi.yaml');
const ADMIN_SPEC_PATH = resolve(REPO_ROOT, 'docs/api/admin.openapi.yaml');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'packages/db/migrations');

const id95 = (tail: string) => `11111111-0000-4000-8000-0095${tail.padStart(8, '0')}`;
const NOWHERE = id95('ffffff01');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

type Json = Record<string, unknown>;
type Headers = Record<string, string>;
type Params = readonly (readonly [string, string])[];

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function permissionSet(tenantId: string, key: string): string {
  return must(
    SEED_PERMISSION_SETS.find((set) => set.tenantId === tenantId && set.key === key),
    `no seeded permission set '${key}'`,
  ).id;
}

const ACC1 = must(SEED_ACCOUNTS.find((a) => a.programmeId === PROGRAMME_A1), 'A1 account').id;
const SCRIPT_A2 = must(SEED_SCRIPTS.find((s) => s.programmeId === PROGRAMME_A2), 'A2 script').id;
const SEED_A1 = SEED_CONTACTS.filter((c) => c.programmeId === PROGRAMME_A1).map((c) => c.id);

// Users. Seeded: the supervisor (tenant admin, `admin` in A1 and A2), agent 1
// (`agent` in A1), agent 2 (`agent` in A2 only), tenant B's admin. Planted in
// beforeEach (reseed removes them):
const ADMIN1 = id95('e0000001'); //   admin set in A1, not a tenant admin: the usual merger
const ADMIN1B = id95('e0000002'); //  admin set in A1, not a tenant admin: another member
const ADMIN2 = id95('e0000003'); //   admin set in A2 only
const ADMIN12 = id95('e0000004'); //  admin set in A1 and A2, not a tenant admin
const TADMIN = id95('e0000005'); //   tenant admin; team_lead in A1, programme_manager in A2
const TEAMLEAD = id95('e0000006'); // team_lead in A1 (holds contact.claim_and_set_status)
const PM = id95('e0000007'); //       programme_manager in A1 (ditto)
const QA = id95('e0000008'); //       qa_analyst in A1 (read-only)
const PORTAL = id95('e0000009'); //   client_portal in A1 (read-only)

const PLANTED_USERS: readonly (readonly [string, boolean, readonly (readonly [string, string])[]])[] = [
  [ADMIN1, false, [[PROGRAMME_A1, 'admin']]],
  [ADMIN1B, false, [[PROGRAMME_A1, 'admin']]],
  [ADMIN2, false, [[PROGRAMME_A2, 'admin']]],
  [ADMIN12, false, [[PROGRAMME_A1, 'admin'], [PROGRAMME_A2, 'admin']]],
  [TADMIN, true, [[PROGRAMME_A1, 'team_lead'], [PROGRAMME_A2, 'programme_manager']]],
  [TEAMLEAD, false, [[PROGRAMME_A1, 'team_lead']]],
  [PM, false, [[PROGRAMME_A1, 'programme_manager']]],
  [QA, false, [[PROGRAMME_A1, 'qa_analyst']]],
  [PORTAL, false, [[PROGRAMME_A1, 'client_portal']]],
];

const H = {
  admin1: asUser(TENANT_A, ADMIN1),
  admin1b: asUser(TENANT_A, ADMIN1B),
  admin2: asUser(TENANT_A, ADMIN2),
  admin12: asUser(TENANT_A, ADMIN12),
  tadmin: asUser(TENANT_A, TADMIN),
  teamLead: asUser(TENANT_A, TEAMLEAD),
  pm: asUser(TENANT_A, PM),
  qa: asUser(TENANT_A, QA),
  portal: asUser(TENANT_A, PORTAL),
  supervisor: asUser(TENANT_A, USER_A_SUPERVISOR),
  agent1: asUser(TENANT_A, USER_A_AGENT_1),
  tenantB: asUser(TENANT_B, USER_B_AGENT_1),
};

// ---------------------------------------------------------------------------
// The planted contacts (all synthetic). A1 unless noted.
// ---------------------------------------------------------------------------

interface ContactPlant {
  id: string;
  programmeId: string;
  displayName: string;
  givenNames?: string | null;
  familyName?: string | null;
  companyName?: string | null;
  phones: readonly string[];
  emails: readonly string[];
  status?: string | null;
  source?: string | null;
  tags?: readonly string[];
  preferredLanguage?: string | null;
  state?: string | null;
  lga?: string | null;
  dnd?: boolean;
  whatsappOptIn?: boolean;
  consentState?: string;
  accountId?: string | null;
  ownerUserId?: string | null;
  updatedAt: string;
  custom?: Json;
}

/** The pair most tests merge: P2 (newer) into P1. They share a phone and an email (case differs). */
const P1: ContactPlant = {
  id: id95('c0000001'),
  programmeId: PROGRAMME_A1,
  displayName: 'Zqsurvivor Adaeze',
  givenNames: 'Zqsurvgiven',
  familyName: 'Okafor',
  companyName: null,
  phones: ['+2348039500001'],
  emails: ['zq.pair@example.test'],
  status: 'new',
  source: 'whatsapp',
  tags: ['zqsurvtag'],
  preferredLanguage: 'en',
  state: 'Lagos',
  lga: 'Ikeja',
  dnd: false,
  whatsappOptIn: true,
  consentState: 'opted_in',
  accountId: null,
  ownerUserId: USER_A_AGENT_1,
  updatedAt: '2026-03-01T09:00:00.000Z',
};
const P2: ContactPlant = {
  id: id95('c0000002'),
  programmeId: PROGRAMME_A1,
  displayName: 'Zqmergedname Adaeze',
  givenNames: 'Zqmergegiven',
  familyName: 'Okafor',
  companyName: 'Zqmergeco Fabrics',
  phones: ['+2348039500001', '+2348039500009'],
  emails: ['ZQ.Pair@Example.test', 'zq.only.p2@example.test'],
  status: 'qualified',
  source: null,
  tags: [],
  preferredLanguage: 'yo',
  state: 'Lagos',
  lga: null,
  dnd: true,
  whatsappOptIn: true,
  consentState: 'withdrawn',
  accountId: ACC1,
  ownerUserId: null,
  updatedAt: '2026-04-01T09:00:00.000Z',
};
/** An email-only pair (case differs). */
const E1: ContactPlant = { id: id95('c0000011'), programmeId: PROGRAMME_A1, displayName: 'Zqemail One', phones: ['+2348039500011'], emails: ['zq.email.pair@example.test'], updatedAt: '2026-02-01T00:00:00.000Z' };
const E2: ContactPlant = { id: id95('c0000012'), programmeId: PROGRAMME_A1, displayName: 'Zqemail Two', phones: ['+2348039500012'], emails: ['Zq.Email.Pair@example.test'], updatedAt: '2026-02-02T00:00:00.000Z' };
/** A pair that matches on a SECOND phone. */
const M1: ContactPlant = { id: id95('c0000021'), programmeId: PROGRAMME_A1, displayName: 'Zqmulti One', phones: ['+2348039500031', '+2348039500032'], emails: [], updatedAt: '2026-02-03T00:00:00.000Z' };
const M2: ContactPlant = { id: id95('c0000022'), programmeId: PROGRAMME_A1, displayName: 'Zqmulti Two', phones: ['+2348039500032'], emails: [], updatedAt: '2026-02-04T00:00:00.000Z' };
/** A near miss: one digit from the G group's number. In no set. */
const N1: ContactPlant = { id: id95('c0000031'), programmeId: PROGRAMME_A1, displayName: 'Zqnear Miss', phones: ['+2348039500101'], emails: [], updatedAt: '2026-02-05T00:00:00.000Z' };
/** The same number in A1 and A2: never a set (D-P12: within one programme). */
const X1: ContactPlant = { id: id95('c0000041'), programmeId: PROGRAMME_A1, displayName: 'Zqcross One', phones: ['+2348039500200'], emails: ['zq.cross@example.test'], updatedAt: '2026-02-06T00:00:00.000Z' };
const X2: ContactPlant = { id: id95('c0000042'), programmeId: PROGRAMME_A2, displayName: 'Zqcross Two', phones: ['+2348039500200'], emails: ['zq.cross@example.test'], updatedAt: '2026-02-07T00:00:00.000Z' };
/** A2's own pair. */
const Q1: ContactPlant = { id: id95('c0000051'), programmeId: PROGRAMME_A2, displayName: 'Zqtelco One', phones: ['+2348039500021'], emails: [], status: 'new', updatedAt: '2026-02-08T00:00:00.000Z' };
const Q2: ContactPlant = { id: id95('c0000052'), programmeId: PROGRAMME_A2, displayName: 'Zqtelco Two', phones: ['+2348039500021'], emails: [], status: 'new', updatedAt: '2026-02-09T00:00:00.000Z' };
/**
 * LEAD EDIT (T-0095, D-L162): one contact sharing a different number with each
 * of two others makes TWO phone sets with the same lowest id (T1) and the same
 * match kind. Only an ordinal in the cursor keeps the second at a page
 * boundary (M5).
 */
const T1: ContactPlant = { id: id95('c0000061'), programmeId: PROGRAMME_A1, displayName: 'Zqtwin One', phones: ['+2348039500401', '+2348039500402'], emails: [], updatedAt: '2026-02-10T00:00:00.000Z' };
const T2: ContactPlant = { id: id95('c0000062'), programmeId: PROGRAMME_A1, displayName: 'Zqtwin Two', phones: ['+2348039500401'], emails: [], updatedAt: '2026-02-11T00:00:00.000Z' };
const T3: ContactPlant = { id: id95('c0000063'), programmeId: PROGRAMME_A1, displayName: 'Zqtwin Three', phones: ['+2348039500402'], emails: [], updatedAt: '2026-02-12T00:00:00.000Z' };
/**
 * Twelve sharing one number (M6). G(k), k = 1 oldest .. 12 newest; the older,
 * the HIGHER the id, so the lowest id (G12) is among the ten newest.
 */
const G = (k: number): ContactPlant => ({
  id: id95(`d00000${String(100 - k).padStart(2, '0')}`),
  programmeId: PROGRAMME_A1,
  displayName: `Zqgroup Member${String(k).padStart(2, '0')}`,
  phones: ['+2348039500100'],
  emails: [`zq.group${k}@example.test`],
  updatedAt: new Date(Date.UTC(2026, 0, 10, 0, k)).toISOString(),
});
const GROUP = Array.from({ length: 12 }, (_, i) => G(i + 1));

const BASE_PLANTS: readonly ContactPlant[] = [P1, P2, E1, E2, M1, M2, N1, X1, X2, Q1, Q2, T1, T2, T3, ...GROUP];

/** Every phone and email this file plants, for the "never returned" checks. */
const ALL_IDENTIFIERS = [...new Set(BASE_PLANTS.flatMap((c) => [...c.phones, ...c.emails]))];

/** A1's sets, for a reader of every field (D-P12; M6). */
const A1_SETS = [
  `phone:${[P1.id, P2.id].sort().join(',')}`,
  `email:${[P1.id, P2.id].sort().join(',')}`,
  `email:${[E1.id, E2.id].sort().join(',')}`,
  `phone:${[M1.id, M2.id].sort().join(',')}`,
  `phone:${[T1.id, T2.id].sort().join(',')}`,
  `phone:${[T1.id, T3.id].sort().join(',')}`,
  `phone:${GROUP.slice(2).map((c) => c.id).sort().join(',')}`,
].sort();
const A2_SETS = [`phone:${[Q1.id, Q2.id].sort().join(',')}`];

// Children of P2 (planted; ids fixed).
const ACT_P2A = id95('a0000001');
const ACT_P2B = id95('a0000002');
const DEAL_P2 = id95('b0000001');
const DEAL_P2B = id95('b0000002');
const DISPOSITION_A2 = id95('f0000001');

const CONSENT_ORDER = ['withdrawn', 'unknown', 'pending', 'opted_in'] as const;
const COMPLIANCE_FIELDS = ['dnd', 'whatsappOptIn', 'consentState'] as const;
const MERGE_FIELDS = [
  'displayName', 'givenNames', 'familyName', 'companyName', 'phones', 'emails', 'accountId',
  'ownerUserId', 'status', 'source', 'tags', 'preferredLanguage', 'preferredChannel', 'state', 'lga',
];

/** The values a merge of P2 into P1 must produce by default (merged newer; M16). */
const EXPECT_MERGED_NEWER: Json = {
  display_name: P2.displayName,
  given_names: P2.givenNames,
  family_name: 'Okafor',
  company_name: P2.companyName,
  phones: P2.phones.map((e164) => ({ type: 'mobile', e164 })),
  emails: P2.emails,
  account_id: ACC1,
  owner_user_id: USER_A_AGENT_1,
  status: 'qualified',
  source: 'whatsapp',
  tags: ['zqsurvtag'],
  preferred_language: 'yo',
  state: 'Lagos',
  lga: 'Ikeja',
  dnd: true,
  whatsapp_opt_in: true,
  consent_state: 'withdrawn',
};
/** The same merge when P1 is the newer record. Compliance does not move (D-P28). */
const EXPECT_SURVIVOR_NEWER: Json = {
  display_name: P1.displayName,
  given_names: P1.givenNames,
  family_name: 'Okafor',
  company_name: P2.companyName,
  phones: P1.phones.map((e164) => ({ type: 'mobile', e164 })),
  emails: P1.emails,
  account_id: ACC1,
  owner_user_id: USER_A_AGENT_1,
  status: 'new',
  source: 'whatsapp',
  tags: ['zqsurvtag'],
  preferred_language: 'en',
  state: 'Lagos',
  lga: 'Ikeja',
  dnd: true,
  whatsapp_opt_in: true,
  consent_state: 'withdrawn',
};
/** Preview defaults on fields where the sides differ (M16), merged newer. */
const DEFAULTS_MERGED_NEWER: Json = {
  displayName: 'merged', givenNames: 'merged', companyName: 'merged', phones: 'merged', emails: 'merged',
  accountId: 'merged', ownerUserId: 'survivor', status: 'merged', source: 'survivor', tags: 'survivor',
  preferredLanguage: 'merged', lga: 'survivor',
};
const DEFAULTS_SURVIVOR_NEWER: Json = {
  displayName: 'survivor', givenNames: 'survivor', companyName: 'merged', phones: 'survivor', emails: 'survivor',
  accountId: 'merged', ownerUserId: 'survivor', status: 'survivor', source: 'survivor', tags: 'survivor',
  preferredLanguage: 'survivor', lga: 'survivor',
};

const CONTACT_COLUMNS = `id, programme_id, display_name, given_names, family_name, company_name, phones, emails,
  account_id, owner_user_id, status, source, tags, preferred_language, preferred_channel, state, lga,
  dnd, whatsapp_opt_in, consent_state, version, updated_at, deleted_at, custom`;

/** Database text an error body must never carry. */
const DATABASE_TEXT = ['violates', 'constraint', 'Failing row', '23503', '23505', '23514', 'contact_merge', 'snapshot'];

const DEFINERS_SQL = `
  SELECT n.nspname || '.' || p.proname AS name
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   ORDER BY 1`;

const AUDIT_ACTIONS_BEFORE = [
  'created', 'updated', 'deleted', 'exported', 'invited', 'viewed',
  'failed_sign_in', 'rejected', 'rotated', 'played_recording', 'published',
];

// ---------------------------------------------------------------------------
// The JSON-Schema checker over the contract (restated from the records suites,
// plus minItems, which DuplicateSet needs).
// ---------------------------------------------------------------------------

const FORMATS: Record<string, RegExp> = {
  uuid: UUID,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
};

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
    node = (node as Json | undefined)?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (node === undefined) throw new Error(`schema pointer #${fragment} resolves to nothing`);
  return node;
}

function deref(schema: Json, file: string): { schema: Json; file: string } {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return { schema, file };
  const [relativePath, fragment = ''] = ref.split('#');
  const target = relativePath === undefined || relativePath === '' ? file : resolve(dirname(file), relativePath);
  return deref(atPointer(loadDoc(target), fragment) as Json, target);
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function check(input: Json, file: string, value: unknown, path: string, errors: string[]): void {
  const { schema, file: at } = deref(input, file);
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf as Json[]) check(part, at, value, path, errors);
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as Json[]).filter((branch) => {
      const e: string[] = [];
      check(branch, at, value, path, e);
      return e.length === 0;
    });
    if (passing.length !== 1) errors.push(`${path}: matches ${passing.length} oneOf branches`);
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = (schema.anyOf as Json[]).some((branch) => {
      const e: string[] = [];
      check(branch, at, value, path, e);
      return e.length === 0;
    });
    if (!ok) errors.push(`${path}: matches no anyOf branch (${JSON.stringify(value)})`);
  }
  if ('const' in schema && schema.const !== value) errors.push(`${path}: not the const`);
  const actual = jsonType(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!(allowed.includes(actual) || (actual === 'integer' && allowed.includes('number')))) {
      errors.push(`${path}: type ${actual}, schema allows ${allowed.join('|')}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) errors.push(`${path}: too short`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) errors.push(`${path}: too long`);
    const format = typeof schema.format === 'string' ? FORMATS[schema.format] : undefined;
    if (format !== undefined && !format.test(value)) errors.push(`${path}: not a ${String(schema.format)}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${path}: does not match ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      errors.push(`${path}: items repeat`);
    }
    if (schema.items !== undefined && typeof schema.items === 'object') {
      value.forEach((item, index) => check(schema.items as Json, at, item, `${path}[${index}]`, errors));
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
      if (childSchema !== undefined) check(childSchema, at, child, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: property "${key}" is not allowed`);
      else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
        check(schema.additionalProperties as Json, at, child, `${path}.${key}`, errors);
      }
      if (typeof schema.propertyNames === 'object' && schema.propertyNames !== null) {
        check(schema.propertyNames as Json, at, key, `${path}[key ${key}]`, errors);
      }
    }
  }
}

function schemaErrors(schema: Json, value: unknown, where: string, file = SPEC_PATH): string[] {
  const errors: string[] = [];
  check(schema, file, value, where, errors);
  return errors;
}

const S = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const ERROR_SCHEMA: Json = { $ref: './admin.openapi.yaml#/components/schemas/Error' };

function requireOperation(operationId: string): Json {
  const paths = ((loadDoc(SPEC_PATH) as Json).paths ?? {}) as Record<string, Json>;
  for (const item of Object.values(paths)) {
    for (const op of Object.values(item)) {
      if (typeof op === 'object' && op !== null && (op as Json).operationId === operationId) return op as Json;
    }
  }
  throw new Error(`records.openapi.yaml has no operation ${operationId}`);
}

function responseSchemaOf(operationId: string, status: string): Json {
  const raw = ((requireOperation(operationId).responses ?? {}) as Json)[status] as Json | undefined;
  if (raw === undefined) throw new Error(`${operationId} documents no ${status}`);
  const response = deref(raw, SPEC_PATH).schema;
  return must(
    ((response.content as Json | undefined)?.['application/json'] as Json | undefined)?.schema as Json | undefined,
    `${operationId} ${status} schema`,
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (self-checked below).
// ---------------------------------------------------------------------------

/** D-P28 by x-kasuwa-compliance-order: the most restrictive of two. */
function strictest(a: Json, b: Json): { dnd: boolean; whatsappOptIn: boolean; consentState: string } {
  const ca = CONSENT_ORDER.indexOf(a.consentState as (typeof CONSENT_ORDER)[number]);
  const cb = CONSENT_ORDER.indexOf(b.consentState as (typeof CONSENT_ORDER)[number]);
  return {
    dnd: a.dnd === true || b.dnd === true,
    whatsappOptIn: a.whatsappOptIn === true && b.whatsappOptIn === true,
    consentState: CONSENT_ORDER[Math.min(ca, cb)] ?? 'withdrawn',
  };
}

/** The ids of a page's rows, in order. */
function ids(page: unknown): string[] {
  return (((page as Json | null)?.data ?? []) as Json[]).map((row) => String(row.id));
}

/** `matchOn:id,id,...` with the ids sorted: one string per set, order-free. */
function setKeys(page: Json): string[] {
  return ((page.data ?? []) as Json[]).map(
    (set) => `${String(set.matchOn)}:${((set.contacts ?? []) as Json[]).map((c) => String(c.id)).sort().join(',')}`,
  );
}

function lowestId(set: Json): string {
  return ((set.contacts ?? []) as Json[]).map((c) => String(c.id).toLowerCase()).sort()[0] ?? '';
}

/**
 * M5: what a duplicates cursor may carry. Base64url; decoded, either the bare
 * lowest id of the page's last set, or JSON whose every leaf is that id, the
 * literal `phone` or `email`, or an integer 0..99. Keys never look like an
 * identifier.
 */
function cursorProblems(cursor: string, lastSetLowestId: string): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return [`not base64url: ${cursor}`];
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (UUID.test(decoded)) {
    return decoded.toLowerCase() === lastSetLowestId ? [] : [`bare id ${decoded} is not the last set's lowest id`];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return [`neither a bare id nor JSON: ${decoded}`];
  }
  const problems: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (typeof node === 'string') {
      const ok = node.toLowerCase() === lastSetLowestId || node === 'phone' || node === 'email';
      if (!ok) problems.push(`${at}: string leaf "${node}"`);
    } else if (typeof node === 'number') {
      if (!(Number.isInteger(node) && node >= 0 && node <= 99)) problems.push(`${at}: number leaf ${node}`);
    } else if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${at}[${i}]`));
    } else if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Json)) {
        if (/@|\d{6,}/.test(key)) problems.push(`${at}: key "${key}" looks like an identifier`);
        walk(child, `${at}.${key}`);
      }
    } else {
      problems.push(`${at}: leaf ${JSON.stringify(node)}`);
    }
  };
  walk(parsed, '$');
  return problems;
}

/** The identifiers (phones in several spellings, emails in any case) a text carries. */
function identifiersIn(text: string, identifiers: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return identifiers.filter((value) => {
    if (value.includes('@')) return lower.includes(value.toLowerCase());
    const national = `0${value.slice(4)}`;
    return text.includes(value) || text.includes(value.slice(1)) || text.includes(national);
  });
}

// ---------------------------------------------------------------------------
// Log capture (the T-0036 approach, restated).
// ---------------------------------------------------------------------------

let captureLines: string[] | null = null;

function render(value: unknown): string {
  return typeof value === 'string' ? value : inspect(value, { depth: 12, breakLength: Number.POSITIVE_INFINITY });
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

async function captureEverything(work: () => Promise<void>): Promise<{ lines: string[]; spans: number }> {
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
  let telemetry: { spans: unknown[]; logs: unknown[] };
  try {
    telemetry = await collectTelemetry(work);
  } finally {
    for (const spy of spies) spy.mockRestore();
    captureLines = null;
  }
  return { lines: [...lines, ...telemetry.logs.map(render), ...telemetry.spans.map(render)], spans: telemetry.spans.length };
}

// ---------------------------------------------------------------------------
// Migration text.
// ---------------------------------------------------------------------------

const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const KNOWN_SETTINGS = new Set(['app.tenant_id', 'app.user_id', 'app.programme_ids', 'app.rate_limit_key']);

function mergeMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }))
    .filter(({ sql }) => /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?contact_merge"?\s*\(/i.test(stripComments(sql)));
}

/** Problems with the migration's text. Exported to a self-check so the scan is seen to fail. */
function migrationTextProblems(sql: string): string[] {
  const code = stripComments(sql);
  const problems: string[] = [];
  if (/\bSECURITY\s+DEFINER\b/i.test(code)) problems.push('adds a SECURITY DEFINER (CLAUDE.md 2.7)');
  if (/\bCREATE\s+(?:ROLE|USER)\b/i.test(code)) problems.push('creates a role');
  if (/\bCREATE\s+EXTENSION\b/i.test(code)) problems.push('creates an extension');
  if (/\bVALIDATE\s+CONSTRAINT\b/i.test(code)) problems.push('validates a constraint (D-L65: a later file)');
  if (/\bUSING\s+(?:gin|gist)\b/i.test(code)) problems.push('adds a GIN or GiST index (D-P33)');
  if (/\b(?:DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i.test(code)) problems.push('weakens row level security');
  for (const match of code.matchAll(/(?:current_setting|set_config)\s*\(\s*'([^']+)'/gi)) {
    const name = String(match[1]);
    if (!KNOWN_SETTINGS.has(name)) problems.push(`reads or sets a new setting ${name}`);
  }
  return problems;
}

// ===========================================================================

describe('acceptance: duplicate sets, merge and undo, contact soft delete (T-0095)', () => {
  let app: INestApplication;
  /** kasuwa_migrator — BYPASSRLS. Plants and observes; never serves. */
  let observer: Pool;
  /** kasuwa_app, for the RLS checks. */
  let appPool: Pool;
  /** Default pipeline and its first stage, per programme (regenerated by every reseed). */
  const pipelines: Record<string, { id: string; s0: string }> = {};

  beforeAll(async () => {
    await reseed(inject('migrationUrl'));
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(withAuthDatabase({ databaseUrl: inject('databaseUrl'), poolMax: 5 }))],
    }).compile();
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
    observer = createPool({ connectionString: inject('migrationUrl'), max: 3 });
    appPool = createPool({ connectionString: inject('databaseUrl'), max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await appPool?.end();
    await reseed(inject('migrationUrl'));
  });

  beforeEach(async () => {
    for (const programmeId of [PROGRAMME_A1, PROGRAMME_A2]) {
      const stages = await observer.query<{ pipeline_id: string; id: string }>(
        `SELECT s.pipeline_id, s.id FROM pipeline_stage s JOIN pipeline p ON p.id = s.pipeline_id
          WHERE p.programme_id = $1 ORDER BY p.created_at, p.id, s.position LIMIT 1`,
        [programmeId],
      );
      pipelines[programmeId] = {
        id: must(stages.rows[0]?.pipeline_id, `no default pipeline in ${programmeId}`),
        s0: must(stages.rows[0]?.id, 'stage 0'),
      };
    }
    for (const [id, tenantAdmin, memberships] of PLANTED_USERS) {
      await plantUser(id, tenantAdmin, memberships);
    }
    for (const plant of BASE_PLANTS) await plantContact(plant);
    await observer.query(
      `INSERT INTO activity (id, tenant_id, programme_id, type, subject, owner_user_id, contact_id, created_by_user_id, created_at)
       VALUES ($1, $3, $4, 'note', 'T-0095 planted note one', $5, $6, $5, '2026-04-02T00:00:00Z'),
              ($2, $3, $4, 'note', 'T-0095 planted note two', $5, $6, $5, '2026-04-03T00:00:00Z')`,
      [ACT_P2A, ACT_P2B, TENANT_A, PROGRAMME_A1, USER_A_AGENT_1, P2.id],
    );
    const p = must(pipelines[PROGRAMME_A1], 'A1 pipeline');
    await observer.query(
      `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name, owner_user_id, stage_entered_at, primary_contact_id)
       VALUES ($1, $3, $4, $5, $6, 'T-0095 planted deal one', $7, now(), $8),
              ($2, $3, $4, $5, $6, 'T-0095 planted deal two', $7, now(), $8)`,
      [DEAL_P2, DEAL_P2B, TENANT_A, PROGRAMME_A1, p.id, p.s0, USER_A_AGENT_1, P2.id],
    );
  }, 60_000);

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  // -------------------------------------------------------------------------
  // Plants
  // -------------------------------------------------------------------------

  async function plantUser(id: string, tenantAdmin: boolean, memberships: readonly (readonly [string, string])[], tenantId = TENANT_A) {
    await observer.query(
      `INSERT INTO "user" (id, tenant_id, email, display_name, is_tenant_admin) VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, `t0095.${id.slice(-8)}@example.test`, `T-0095 Fixture User ${id.slice(-4)}`, tenantAdmin],
    );
    for (const [programmeId, key] of memberships) {
      await observer.query(
        `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id) VALUES ($1, $2, $3, $4)`,
        [id, programmeId, tenantId, permissionSet(tenantId, key)],
      );
    }
  }

  async function assign(userId: string, programmeId: string, key: string) {
    await observer.query(
      `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, programme_id) DO UPDATE SET permission_set_id = EXCLUDED.permission_set_id`,
      [userId, programmeId, TENANT_A, permissionSet(TENANT_A, key)],
    );
  }

  /**
   * LEAD EDIT (T-0095, D-L163): listDuplicates allows 20 calls per minute per user, so every
   * test that scans gets users of its own (never the shared H.* users), and no user nears
   * the limit except the one the throttle test exhausts on purpose. Ids never repeat within a
   * run, because the throttle's windows outlive the reseed.
   */
  let readerSeq = 0;
  async function freshUser(memberships: readonly (readonly [string, string])[], tenantAdmin = false, tenantId = TENANT_A): Promise<Headers> {
    readerSeq += 1;
    const id = id95(`e2${readerSeq.toString(16).padStart(6, '0')}`);
    await plantUser(id, tenantAdmin, memberships, tenantId);
    return asUser(tenantId, id);
  }

  async function plantContact(c: ContactPlant) {
    await observer.query(
      `INSERT INTO contact (id, tenant_id, programme_id, display_name, given_names, family_name, company_name,
                            phones, emails, status, source, tags, preferred_language, state, lga, dnd,
                            whatsapp_opt_in, consent_state, account_id, owner_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
               '2026-01-05T00:00:00Z', $21)`,
      [
        c.id, TENANT_A, c.programmeId, c.displayName, c.givenNames ?? null, c.familyName ?? null, c.companyName ?? null,
        JSON.stringify(c.phones.map((e164) => ({ type: 'mobile', e164 }))), JSON.stringify(c.emails),
        c.status ?? null, c.source ?? null, c.tags ?? null, c.preferredLanguage ?? null, c.state ?? null, c.lga ?? null,
        c.dnd ?? false, c.whatsappOptIn ?? false, c.consentState ?? 'unknown', c.accountId ?? null,
        c.ownerUserId ?? null, c.updatedAt,
      ],
    );
    if (c.custom !== undefined) {
      await observer.query('UPDATE contact SET custom = $2::jsonb, updated_at = $3 WHERE id = $1', [c.id, JSON.stringify(c.custom), c.updatedAt]);
    }
  }

  /** One field-security cell on tenant A's contact object (T-0026 matrix; standard field_defs exist since T-0053). */
  async function lockField(field: string, setKey: string, level: 'none' | 'read' | 'edit') {
    const fieldRow = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f JOIN object_def o ON o.id = f.object_id
        WHERE f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = $2`,
      [TENANT_A, field],
    );
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, must(fieldRow.rows[0]?.id, `no contact field_def ${field}`), permissionSet(TENANT_A, setKey), level],
    );
  }

  /** A custom field on contact, with one grant (ADR-0016). */
  async function plantCustomField(tail: string, apiName: string, type: string, config: Json, grants: readonly (readonly [string, 'none' | 'read' | 'edit'])[]) {
    const objectRow = await observer.query<{ id: string }>(`SELECT id FROM object_def WHERE tenant_id = $1 AND api_name = 'contact'`, [TENANT_A]);
    const fieldId = id95(tail);
    await observer.query(
      `INSERT INTO field_def (id, tenant_id, object_id, api_name, label, type, classification, is_custom, config)
       VALUES ($1, $2, $3, $4, $5, $6, 'none', true, $7::jsonb)`,
      [fieldId, TENANT_A, must(objectRow.rows[0]?.id, 'contact object_def'), apiName, `T-0095 ${apiName}`, type, JSON.stringify(config)],
    );
    for (const [setKey, level] of grants) {
      await observer.query(
        `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level) VALUES ($1, $2, $3, $4)`,
        [TENANT_A, fieldId, permissionSet(TENANT_A, setKey), level],
      );
    }
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  async function contactRow(id: string): Promise<Json> {
    const rows = await observer.query<Json>(`SELECT ${CONTACT_COLUMNS} FROM contact WHERE id = $1`, [id]);
    return must(rows.rows[0], `contact ${id}`);
  }

  async function versionOf(id: string): Promise<number> {
    return Number((await contactRow(id)).version);
  }

  function pick(row: Json, keys: readonly string[]): Json {
    return Object.fromEntries(keys.map((key) => [key, row[key]]));
  }

  async function auditCount(): Promise<number> {
    const rows = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_event WHERE tenant_id = $1', [TENANT_A]);
    return Number(rows.rows[0]?.n ?? '-1');
  }

  async function auditRowsSince(count: number): Promise<Json[]> {
    const rows = await observer.query<Json>(
      `SELECT action, object_type, object_id, object_label, programme_id, actor_user_id, changes
         FROM audit_event WHERE tenant_id = $1 ORDER BY occurred_at, id OFFSET $2`,
      [TENANT_A, count],
    );
    return rows.rows;
  }

  async function mergeRows(): Promise<Json[]> {
    const rows = await observer.query<Json>(
      `SELECT id, tenant_id, programme_id, survivor_id, merged_id, merged_by_user_id, created_at, undo_until,
              undone_at, undone_by_user_id, survivor_reverted FROM contact_merge ORDER BY created_at, id`,
    );
    return rows.rows;
  }

  async function childPointers(): Promise<Json> {
    const acts = await observer.query<{ id: string; contact_id: string }>(
      'SELECT id, contact_id FROM activity WHERE id = ANY ($1::uuid[]) ORDER BY id', [[ACT_P2A, ACT_P2B]],
    );
    const deals = await observer.query<{ id: string; primary_contact_id: string }>(
      'SELECT id, primary_contact_id FROM deal WHERE id = ANY ($1::uuid[]) ORDER BY id', [[DEAL_P2, DEAL_P2B]],
    );
    return {
      activities: Object.fromEntries(acts.rows.map((r) => [r.id, r.contact_id])),
      deals: Object.fromEntries(deals.rows.map((r) => [r.id, r.primary_contact_id])),
    };
  }

  /** Everything a refused merge or undo must leave untouched. */
  async function worldState(ids: readonly string[] = [P1.id, P2.id]): Promise<Json> {
    const contacts = await Promise.all(ids.map((id) => contactRow(id)));
    return {
      contacts: contacts.map((row) => ({ ...row, updated_at: String(row.updated_at), deleted_at: String(row.deleted_at) })),
      merges: (await mergeRows()).map((row) => ({ ...row, created_at: String(row.created_at), undo_until: String(row.undo_until), undone_at: String(row.undone_at) })),
      audit: await auditCount(),
      children: await childPointers(),
    };
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  const server = () => app.getHttpServer();
  const enc = encodeURIComponent;
  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const get = (headers: Headers, path: string, params: Params = []) => request(server()).get(withQuery(path, params)).set(headers);
  const send = (method: 'post' | 'patch', path: string, headers: Headers, body?: unknown) => {
    const req = request(server())[method](path).set(headers);
    return body === undefined ? req : req.set('Content-Type', 'application/json').send(JSON.stringify(body));
  };

  const duplicates = (headers: Headers, programmeId: string, params: Params = []) =>
    get(headers, `/api/v1/programmes/${enc(programmeId)}/duplicates`, params);
  const preview = (headers: Headers, survivorId: string, withId: string) =>
    get(headers, `/api/v1/contacts/${enc(survivorId)}/merge-preview`, [['with', withId]]);
  const mergeRaw = (headers: Headers, body: unknown) => send('post', '/api/v1/contact-merges', headers, body);
  const undo = (headers: Headers, mergeId: string) => send('post', `/api/v1/contact-merges/${enc(mergeId)}/undo`, headers);
  const listMerges = (headers: Headers, params: Params = []) => get(headers, '/api/v1/contact-merges', params);

  /** createContactMerge with both current versions. */
  async function mergeBody(survivorId: string, mergedId: string, choices?: Json): Promise<Json> {
    return {
      survivorId,
      mergedId,
      survivorVersion: await versionOf(survivorId),
      mergedVersion: await versionOf(mergedId),
      ...(choices === undefined ? {} : { choices }),
    };
  }

  async function merge(headers: Headers, survivorId: string, mergedId: string, choices?: Json) {
    return mergeRaw(headers, await mergeBody(survivorId, mergedId, choices));
  }

  /** A merge that must succeed; returns the ContactMerge. */
  async function mergeOk(headers: Headers, survivorId: string, mergedId: string, choices?: Json): Promise<Json> {
    const response = await merge(headers, survivorId, mergedId, choices);
    return okBody(response, 201, 'createContactMerge', `merge ${mergedId} into ${survivorId}`);
  }

  function expectNoStore(response: request.Response, where: string) {
    expect(String(response.headers['cache-control'] ?? ''), `${where}: Cache-Control`).toContain('no-store');
  }

  function okBody(response: request.Response, status: number, operationId: string, where: string): Json {
    expect(response.status, `${where}: ${response.text}`).toBe(status);
    expectNoStore(response, where);
    expect(schemaErrors(responseSchemaOf(operationId, String(status)), response.body, where)).toEqual([]);
    return response.body as Json;
  }

  function detailsOf(body: Json): { path: string; code: string }[] {
    return Array.isArray(body.details) ? (body.details as { path: string; code: string }[]) : [];
  }

  function expectError(response: request.Response, status: number, code: string, where: string): Json {
    expect(response.status, `${where}: ${response.text}`).toBe(status);
    const body = response.body as Json;
    expect(schemaErrors(ERROR_SCHEMA, body, where)).toEqual([]);
    expect(body.code, where).toBe(code);
    for (const text of DATABASE_TEXT) expect(response.text, `${where}: the body carries "${text}"`).not.toContain(text);
    expect(identifiersIn(response.text, ALL_IDENTIFIERS), `${where}: the body carries an identifier`).toEqual([]);
    return body;
  }

  function expectDetail(response: request.Response, status: number, code: string, detail: string, path: string, where: string): Json {
    const body = expectError(response, status, code, where);
    expect(
      detailsOf(body).some((d) => d.code === detail && d.path === path),
      `${where}: details ${JSON.stringify(body.details)} lack ${detail} at ${path}`,
    ).toBe(true);
    return body;
  }

  /** The same route with an invented id answers byte-identically (M9). */
  function expectSameBody(actual: request.Response, control: request.Response, where: string) {
    expect(actual.status, `${where}: ${actual.text}`).toBe(control.status);
    expect(actual.text, `${where}: not the invented id's body`).toBe(control.text);
  }

  // =========================================================================
  // 0. This file's helpers
  // =========================================================================

  describe('helpers', () => {
    it('(self-check) the schema checker accepts the contract’s own examples and rejects broken copies', () => {
      const merged = {
        id: id95('99000001'), programmeId: PROGRAMME_A1,
        survivor: { id: P1.id, displayName: 'A' }, merged: { id: P2.id, displayName: 'B' },
        mergedByUserId: ADMIN1, mergedAt: '2026-10-18T09:00:00Z', undoUntil: '2026-11-17T09:00:00Z',
        undoneAt: null, undoneByUserId: null, survivorReverted: null,
      };
      expect(schemaErrors(S('ContactMerge'), merged, 'ok')).toEqual([]);
      expect(schemaErrors(S('ContactMerge'), { ...merged, snapshot: {} }, 'extra')).not.toEqual([]);
      expect(schemaErrors(S('ContactMerge'), { ...merged, survivorReverted: 'yes' }, 'type')).not.toEqual([]);
      const set = { matchOn: 'phone', contacts: [{ id: P1.id, displayName: null, updatedAt: '2026-10-18T09:00:00Z' }] };
      expect(schemaErrors(S('DuplicateSet'), set, 'one contact'), 'minItems is checked').not.toEqual([]);
      expect(schemaErrors(S('DuplicateSet'), { ...set, contacts: [...set.contacts, ...set.contacts] }, 'two')).toEqual([]);
      expect(schemaErrors(S('DuplicateContact'), { id: P1.id, displayName: 'x', updatedAt: '2026-10-18T09:00:00Z', phone: '+234' }, 'phone')).not.toEqual([]);
      expect(schemaErrors(S('MergeChoices'), { dnd: 'merged' }, 'compliance key')).not.toEqual([]);
      expect(schemaErrors(S('MergeChoices'), { status: 'merged', 'custom.tier__c': 'survivor' }, 'ok')).toEqual([]);
      const error = { statusCode: 409, error: 'Conflict', code: 'already_merged', message: 'm' };
      expect(schemaErrors(ERROR_SCHEMA, error, 'error')).toEqual([]);
      expect(schemaErrors(ERROR_SCHEMA, { ...error, code: 'nope' }, 'bad code')).not.toEqual([]);
    });

    it('(self-check) strictest() follows x-kasuwa-compliance-order, and the order is the contract’s', () => {
      expect(requireOperation('createContactMerge')['x-kasuwa-compliance-order']).toEqual({
        dnd: [true, false], whatsappOptIn: [false, true], consentState: [...CONSENT_ORDER],
      });
      expect(strictest({ dnd: false, whatsappOptIn: true, consentState: 'opted_in' }, { dnd: true, whatsappOptIn: false, consentState: 'pending' }))
        .toEqual({ dnd: true, whatsappOptIn: false, consentState: 'pending' });
      expect(strictest({ dnd: false, whatsappOptIn: true, consentState: 'unknown' }, { dnd: false, whatsappOptIn: true, consentState: 'opted_in' }))
        .toEqual({ dnd: false, whatsappOptIn: true, consentState: 'unknown' });
    });

    it('(self-check) cursorProblems admits an id-only or id-and-matchOn cursor and refuses anything carrying a value', () => {
      const id = P1.id;
      const b64 = (text: string) => Buffer.from(text).toString('base64url');
      expect(cursorProblems(b64(id), id)).toEqual([]);
      expect(cursorProblems(b64(JSON.stringify({ v: 1, id, m: 'email' })), id)).toEqual([]);
      expect(cursorProblems(b64(JSON.stringify([id, 'phone'])), id)).toEqual([]);
      // LEAD EDIT (T-0095, D-L162): the builder's form, a version and an integer ordinal among
      // sets sharing the lowest id and match kind. Admitted; the ordinal must be an integer.
      expect(cursorProblems(b64(JSON.stringify({ v: 1, id, m: 'phone', n: 0 })), id)).toEqual([]);
      expect(cursorProblems(b64(JSON.stringify({ v: 1, id, m: 'phone', n: 3 })), id)).toEqual([]);
      for (const bad of [
        b64(P2.id),
        b64(JSON.stringify({ id, value: '+2348039500001' })),
        b64(JSON.stringify({ id, value: 'zq.pair@example.test' })),
        b64(JSON.stringify({ id, at: '2026-03-01T09:00:00.000Z' })),
        b64(JSON.stringify({ id, n: 1712345678 })),
        b64(JSON.stringify({ id, '+2348039500001': 1 })),
        b64(JSON.stringify({ v: 1, id, m: 'phone', n: 1.5 })),
        b64(JSON.stringify({ v: 1, id, m: 'phone', n: '1' })),
        b64(JSON.stringify({ v: 1, id, m: 'phone', n: 100 })),
        b64(JSON.stringify({ v: 1, id, m: 'phone', n: -1 })),
        b64(JSON.stringify({ v: 1, id, m: 'phone', n: true })),
        'not base64!',
      ]) {
        expect(cursorProblems(bad, id), bad).not.toEqual([]);
      }
    });

    it('(self-check) identifiersIn finds a phone in three spellings and an email in any case', () => {
      expect(identifiersIn('x +2348039500001 y', ['+2348039500001'])).toEqual(['+2348039500001']);
      expect(identifiersIn('x 2348039500001 y', ['+2348039500001'])).toEqual(['+2348039500001']);
      expect(identifiersIn('x 08039500001 y', ['+2348039500001'])).toEqual(['+2348039500001']);
      expect(identifiersIn('ZQ.PAIR@EXAMPLE.TEST', ['zq.pair@example.test'])).toEqual(['zq.pair@example.test']);
      expect(identifiersIn('nothing here', ALL_IDENTIFIERS)).toEqual([]);
    });

    it('(self-check) the migration scan names each forbidden construct and passes a clean file', () => {
      expect(migrationTextProblems('CREATE TABLE contact_merge (id uuid); -- SECURITY DEFINER in a comment')).toEqual([]);
      expect(migrationTextProblems("SELECT current_setting('app.tenant_id', true);")).toEqual([]);
      for (const [label, sql] of [
        ['definer', 'CREATE FUNCTION f() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ $$;'],
        ['role', 'CREATE ROLE kasuwa_merger;'],
        ['validate', 'ALTER TABLE audit_event VALIDATE CONSTRAINT audit_event_action_check;'],
        ['gin', 'CREATE INDEX i ON contact USING gin (phones);'],
        ['setting', "SELECT current_setting('app.include_deleted', true);"],
        ['no force', 'ALTER TABLE contact_merge NO FORCE ROW LEVEL SECURITY;'],
      ] as const) {
        expect(migrationTextProblems(sql), label).not.toEqual([]);
      }
    });
  });

  // =========================================================================
  // 1. The migration and the schema
  // =========================================================================

  describe('the migration', () => {
    it('is exactly one new file, numbered after 0039 with a prefix of its own, applied by the runner, with no forbidden construct', async () => {
      const files = mergeMigrations();
      expect(files.map((f) => f.name), 'exactly one migration creates contact_merge').toHaveLength(1);
      const file = must(files[0], 'the merge migration');
      const prefix = file.name.slice(0, 4);
      expect(prefix > '0039', `${file.name} is numbered after 0039`).toBe(true);
      expect(readdirSync(MIGRATIONS_DIR).filter((name) => name.startsWith(`${prefix}_`)), 'its number is its own').toEqual([file.name]);
      const ledger = await observer.query<{ id: string }>('SELECT id FROM _kasuwa_migration WHERE id = $1', [file.name.replace(/\.sql$/, '')]);
      expect(ledger.rows, 'the runner applied it').toHaveLength(1);
      expect(migrationTextProblems(file.sql)).toEqual([]);
      const definers = await observer.query<{ name: string }>(DEFINERS_SQL);
      expect(definers.rows.map((row) => row.name), 'the SECURITY DEFINER census (CLAUDE.md 2.7)').toEqual(['app.resolve_session', 'app.resolve_tenant_by_slug']);
    });

    it('adds contact.deleted_at: a nullable timestamptz with no default, NULL on every existing row', async () => {
      const column = await observer.query<{ type: string; notnull: boolean; default: string | null }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS default
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = to_regclass('public.contact') AND a.attname = 'deleted_at' AND NOT a.attisdropped`,
      );
      expect(column.rows, 'contact has no deleted_at column').toEqual([{ type: 'timestamp with time zone', notnull: false, default: null }]);
      const live = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM contact WHERE deleted_at IS NOT NULL');
      expect(live.rows[0]?.n).toBe('0');
    });

    it('creates contact_merge with the pinned columns and types; any other column is nullable or defaulted', async () => {
      const columns = await observer.query<{ name: string; type: string; notnull: boolean; has_default: boolean }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, a.atthasdef AS has_default
           FROM pg_attribute a WHERE a.attrelid = to_regclass('public.contact_merge') AND a.attnum > 0 AND NOT a.attisdropped`,
      );
      const byName = new Map(columns.rows.map((row) => [row.name, row]));
      expect(byName.size, 'contact_merge does not exist').toBeGreaterThan(0);
      const pinned: Record<string, [string, boolean | null]> = {
        id: ['uuid', true],
        tenant_id: ['uuid', true],
        programme_id: ['uuid', true],
        survivor_id: ['uuid', true],
        merged_id: ['uuid', true],
        merged_by_user_id: ['uuid', true],
        created_at: ['timestamp with time zone', true],
        undo_until: ['timestamp with time zone', true],
        undone_at: ['timestamp with time zone', false],
        undone_by_user_id: ['uuid', false],
        survivor_reverted: ['boolean', false],
        snapshot: ['jsonb', null],
      };
      for (const [name, [type, notnull]] of Object.entries(pinned)) {
        const column = byName.get(name);
        expect(column, `contact_merge.${name} is missing`).toBeDefined();
        expect(column?.type, `contact_merge.${name} type`).toBe(type);
        if (notnull !== null) expect(column?.notnull, `contact_merge.${name} NOT NULL`).toBe(notnull);
      }
      const pk = await observer.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = to_regclass('public.contact_merge') AND contype = 'p'`,
      );
      expect(pk.rows.map((r) => r.def)).toEqual(['PRIMARY KEY (id)']);
      for (const row of columns.rows) {
        if (row.name in pinned) continue;
        expect(!row.notnull || row.has_default, `extra column ${row.name} is NOT NULL with no default`).toBe(true);
      }
    });

    it('is RLS ENABLED and FORCED, with a permissive FOR ALL policy whose WITH CHECK equals its USING on tenant and programme, and is in TENANT_SCOPED_TABLES', async () => {
      const table = await observer.query<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = to_regclass('public.contact_merge')`,
      );
      expect(table.rows).toEqual([{ enabled: true, forced: true }]);
      const policies = await observer.query<{ cmd: string; permissive: boolean; qual: string | null; check: string | null }>(
        `SELECT polcmd AS cmd, polpermissive AS permissive, pg_get_expr(polqual, polrelid) AS qual,
                pg_get_expr(polwithcheck, polrelid) AS check
           FROM pg_policy WHERE polrelid = to_regclass('public.contact_merge')`,
      );
      const scoped = policies.rows.filter(
        (p) => p.cmd === '*' && p.permissive && p.qual !== null && p.qual === p.check &&
          p.qual.includes('current_tenant_id') && p.qual.includes('current_programme_ids'),
      );
      expect(scoped, `policies: ${JSON.stringify(policies.rows)}`).toHaveLength(1);
      expect((TENANT_SCOPED_TABLES as readonly string[]).includes('contact_merge'), 'TENANT_SCOPED_TABLES').toBe(true);
    });

    it('holds both contacts in the merge’s programme and every user in its tenant, by composite keys, against even BYPASSRLS', async () => {
      const client: PoolClient = await observer.connect();
      const attempt = async (values: Json): Promise<string> => {
        const row = {
          id: id95('99000010'), tenant_id: TENANT_A, programme_id: PROGRAMME_A1, survivor_id: P1.id, merged_id: P2.id,
          merged_by_user_id: ADMIN1, ...values,
        };
        await client.query('SAVEPOINT t0095_fk');
        try {
          await client.query(
            `INSERT INTO contact_merge (id, tenant_id, programme_id, survivor_id, merged_id, merged_by_user_id, created_at, undo_until, snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, now(), now() + interval '30 days', '{}'::jsonb)`,
            [row.id, row.tenant_id, row.programme_id, row.survivor_id, row.merged_id, row.merged_by_user_id],
          );
          return 'accepted';
        } catch (error) {
          return String((error as { code?: unknown }).code ?? error);
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT t0095_fk');
        }
      };
      try {
        await client.query('BEGIN');
        expect(await attempt({}), 'control: a well-formed row').toBe('accepted');
        expect(await attempt({ merged_id: X2.id }), 'merged contact in A2, merge in A1').toBe('23503');
        expect(await attempt({ survivor_id: X2.id }), 'survivor in A2, merge in A1').toBe('23503');
        expect(await attempt({ programme_id: PROGRAMME_A2 }), 'both contacts in A1, merge in A2').toBe('23503');
        expect(await attempt({ merged_by_user_id: USER_B_AGENT_1 }), 'merger in tenant B').toBe('23503');
        expect(await attempt({ tenant_id: TENANT_B }), 'tenant B row over tenant A contacts').toBe('23503');
        expect(await attempt({ merged_id: P1.id }), 'a contact merged into itself').toBe('23514');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('gives kasuwa_app SELECT and INSERT, UPDATE only on the undo columns, and no DELETE or TRUNCATE to it or any role it can enter (M2)', async () => {
      const table = await observer.query<{ s: boolean; i: boolean }>(
        `SELECT has_table_privilege('kasuwa_app', 'public.contact_merge', 'SELECT') AS s,
                has_table_privilege('kasuwa_app', 'public.contact_merge', 'INSERT') AS i`,
      );
      expect(table.rows).toEqual([{ s: true, i: true }]);
      const roles = await observer.query<{ role: string; del: boolean; trunc: boolean }>(
        `SELECT r.rolname AS role, has_table_privilege(r.oid, 'public.contact_merge', 'DELETE') AS del,
                has_table_privilege(r.oid, 'public.contact_merge', 'TRUNCATE') AS trunc
           FROM pg_roles r WHERE pg_has_role('kasuwa_app', r.oid, 'MEMBER')`,
      );
      expect(roles.rows.map((r) => r.role)).toContain('kasuwa_app');
      for (const row of roles.rows) {
        expect(row.del, `${row.role} may DELETE from contact_merge`).toBe(false);
        expect(row.trunc, `${row.role} may TRUNCATE contact_merge`).toBe(false);
      }
      const updatable = ['undone_at', 'undone_by_user_id', 'survivor_reverted'];
      const fixed = ['id', 'tenant_id', 'programme_id', 'survivor_id', 'merged_id', 'merged_by_user_id', 'created_at', 'undo_until', 'snapshot'];
      for (const column of [...updatable, ...fixed]) {
        const row = await observer.query<{ u: boolean }>(
          `SELECT has_column_privilege('kasuwa_app', 'public.contact_merge', $1, 'UPDATE') AS u`, [column],
        );
        expect(row.rows[0]?.u, `kasuwa_app UPDATE on contact_merge.${column}`).toBe(updatable.includes(column));
      }
    });

    it('extends audit_event_action_check to exactly the previous actions plus merged and restored, NOT VALID', async () => {
      const rows = await observer.query<{ def: string; validated: boolean }>(
        `SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated FROM pg_constraint
          WHERE conname = 'audit_event_action_check' AND conrelid = to_regclass('public.audit_event')`,
      );
      const row = must(rows.rows[0], 'audit_event_action_check');
      const actions = [...row.def.matchAll(/'([a-z_]+)'/g)].map((m) => String(m[1])).sort();
      expect(actions).toEqual([...AUDIT_ACTIONS_BEFORE, 'merged', 'restored'].sort());
      expect(row.validated, 'NOT VALID (a strict superset needs no scan)').toBe(false);
    });

    it('keeps the RLS boundary: an A2-only session reads no A1 merge, an A1 session reads it', async () => {
      await mergeOk(H.admin1, P1.id, P2.id);
      const count = (userId: string) =>
        withTenantTransaction(appPool, { tenantId: TENANT_A, userId }, async (tx) => {
          const rows = await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM contact_merge');
          return Number(rows[0]?.n ?? '-1');
        });
      expect(await count(ADMIN1), 'control').toBe(1);
      expect(await count(ADMIN2)).toBe(0);
      expect(await count(USER_A_AGENT_2)).toBe(0);
    });

    // LEAD EDIT (T-0095, D-L162): this test merged through the API, which writes an audit
    // event carrying the programme, and audit_event's programme FK (0008) has no ON DELETE,
    // which predates T-0095. So the DELETE failed on audit_event_programme_same_tenant_fk, not
    // on contact_merge. The merge row is now planted directly by kasuwa_migrator (no audit
    // event), and the assertion is unchanged: contact_merge cascades with its programme.
    it('does not stop offboarding: deleting a programme that holds merges still succeeds (rolled back)', async () => {
      await observer.query(
        `INSERT INTO contact_merge (id, tenant_id, programme_id, survivor_id, merged_id, merged_by_user_id, created_at, undo_until, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now() + interval '30 days', '{}'::jsonb)`,
        [id95('99000020'), TENANT_A, PROGRAMME_A1, P1.id, P2.id, ADMIN1],
      );
      const audit = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_event WHERE programme_id = $1', [PROGRAMME_A1]);
      expect(audit.rows[0]?.n, 'the fixture writes no audit event in A1 (else the 0008 FK, not contact_merge, decides)').toBe('0');
      const client = await observer.connect();
      try {
        await client.query('BEGIN');
        const before = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM contact_merge WHERE programme_id = $1', [PROGRAMME_A1]);
        expect(before.rows[0]?.n, 'control: the merge row is there').toBe('1');
        await client.query('DELETE FROM programme WHERE id = $1', [PROGRAMME_A1]);
        const left = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM contact_merge WHERE programme_id = $1', [PROGRAMME_A1]);
        expect(left.rows[0]?.n).toBe('0');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });
  });

  // =========================================================================
  // 2. Duplicate sets
  // =========================================================================

  describe('listDuplicates', () => {
    /** Fresh per test (D-L163): an A1 admin, a tenant admin with admin in both, and TADMIN's shape. */
    const D: Record<'admin1' | 'supervisor' | 'tadmin', Headers> = { admin1: {}, supervisor: {}, tadmin: {} };
    beforeEach(async () => {
      D.admin1 = await freshUser([[PROGRAMME_A1, 'admin']]);
      D.supervisor = await freshUser([[PROGRAMME_A1, 'admin'], [PROGRAMME_A2, 'admin']], true);
      D.tadmin = await freshUser([[PROGRAMME_A1, 'team_lead'], [PROGRAMME_A2, 'programme_manager']], true);
    });

    it('returns exactly A1’s sets: exact E.164 phone (any of a contact’s numbers) or lower-cased email, within the programme, ten newest of twelve', async () => {
      const page = okBody(await duplicates(D.admin1, PROGRAMME_A1, [['limit', '100']]), 200, 'listDuplicates', 'A1');
      expect(setKeys(page).sort()).toEqual(A1_SETS);
      expect(page.nextCursor).toBeNull();
      for (const set of page.data as Json[]) {
        for (const contact of set.contacts as Json[]) {
          expect(Object.keys(contact).sort()).toEqual(['displayName', 'id', 'updatedAt']);
          expect(typeof contact.displayName, 'a name for a reader of names').toBe('string');
        }
      }
      // Seeded contacts, the near miss and the cross-programme number are in no set.
      const inSets = new Set((page.data as Json[]).flatMap((s) => (s.contacts as Json[]).map((c) => String(c.id))));
      for (const id of [...SEED_A1, N1.id, X1.id, G(1).id, G(2).id]) expect(inSets.has(id), id).toBe(false);
    });

    it('never returns a matched value: no phone or email in any spelling, anywhere in the answer', async () => {
      const response = await duplicates(D.admin1, PROGRAMME_A1, [['limit', '100']]);
      okBody(response, 200, 'listDuplicates', 'A1');
      expect(identifiersIn(response.text, ALL_IDENTIFIERS)).toEqual([]);
    });

    it('orders sets by lowest contact id ascending', async () => {
      const page = okBody(await duplicates(D.admin1, PROGRAMME_A1, [['limit', '100']]), 200, 'listDuplicates', 'A1');
      const lows = (page.data as Json[]).map(lowestId);
      expect(lows.length).toBe(A1_SETS.length);
      expect(lows).toEqual([...lows].sort());
    });

    it('walks to exhaustion at limit=1, every set exactly once, no page over its limit, every cursor carrying no value (M5)', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 20; guard += 1) {
        const params: [string, string][] = [['limit', '1']];
        if (cursor !== null) params.push(['cursor', cursor]);
        const page = okBody(await duplicates(D.admin1, PROGRAMME_A1, params), 200, 'listDuplicates', `page ${guard}`);
        const data = page.data as Json[];
        expect(data.length, 'no page longer than limit').toBeLessThanOrEqual(1);
        seen.push(...setKeys(page));
        cursor = page.nextCursor as string | null;
        if (cursor === null) break;
        const last = must(data[data.length - 1], 'a page with a cursor has a set');
        expect(cursorProblems(cursor, lowestId(last)), `cursor ${cursor}`).toEqual([]);
        expect(identifiersIn(Buffer.from(cursor, 'base64url').toString('utf8'), ALL_IDENTIFIERS)).toEqual([]);
      }
      expect(cursor, 'the walk ended').toBeNull();
      expect(seen.sort(), 'sets sharing a lowest id (a pair’s phone and email sets; T1’s two phone sets) are never skipped').toEqual(A1_SETS);
    });

    it('never crosses programmes: A2’s path holds only A2’s set, and the shared number makes no set in either', async () => {
      const a2 = okBody(await duplicates(D.supervisor, PROGRAMME_A2, [['limit', '100']]), 200, 'listDuplicates', 'A2');
      expect(setKeys(a2)).toEqual(A2_SETS);
      const a1 = okBody(await duplicates(D.supervisor, PROGRAMME_A1, [['limit', '100']]), 200, 'listDuplicates', 'A1 supervisor');
      expect(setKeys(a1).sort()).toEqual(A1_SETS);
    });

    it('answers a programme out of reach exactly as one that does not exist: 404, one body; another tenant’s too; a malformed id is 400', async () => {
      okBody(await duplicates(D.admin1, PROGRAMME_A1), 200, 'listDuplicates', 'control');
      const missing = await duplicates(D.admin1, NOWHERE);
      expectError(missing, 404, 'not_found', 'invented programme');
      expectSameBody(await duplicates(D.admin1, PROGRAMME_A2), missing, 'A2 for an A1 admin');
      expectSameBody(await duplicates(D.admin1, PROGRAMME_B1), missing, 'tenant B programme');
      expectSameBody(await duplicates(H.tenantB, PROGRAMME_A1), missing, 'A1 for tenant B');
      expectError(await duplicates(D.admin1, 'not-a-uuid'), 400, 'validation_failed', 'malformed');
    });

    it('a match on a field withheld from the caller yields no sets for that matchOn; the readable field still matches; another programme is unaffected', async () => {
      // TADMIN: team_lead in A1, programme_manager in A2 (field security is judged on the set, never the flag).
      await lockField('phones', 'team_lead', 'none');
      const noPhones = okBody(await duplicates(D.tadmin, PROGRAMME_A1, [['limit', '100']]), 200, 'listDuplicates', 'phones withheld');
      expect(setKeys(noPhones).sort()).toEqual(A1_SETS.filter((k) => k.startsWith('email:')));
      const a2 = okBody(await duplicates(D.tadmin, PROGRAMME_A2, [['limit', '100']]), 200, 'listDuplicates', 'A2 readable');
      expect(setKeys(a2)).toEqual(A2_SETS);
      await lockField('phones', 'team_lead', 'edit');
      await lockField('emails', 'team_lead', 'none');
      const noEmails = okBody(await duplicates(D.tadmin, PROGRAMME_A1, [['limit', '100']]), 200, 'listDuplicates', 'emails withheld');
      expect(setKeys(noEmails).sort()).toEqual(A1_SETS.filter((k) => k.startsWith('phone:')));
    });

    it('never puts a merged-away contact in a set', async () => {
      const before = okBody(await duplicates(D.admin1, PROGRAMME_A1, [['limit', '100']]), 200, 'listDuplicates', 'before');
      expect(setKeys(before).sort()).toEqual(A1_SETS);
      await mergeOk(H.admin1, P1.id, P2.id);
      await mergeOk(H.admin1, G(12).id, G(11).id);
      const after = okBody(await duplicates(D.admin1, PROGRAMME_A1, [['limit', '100']]), 200, 'listDuplicates', 'after');
      const live = new Set((after.data as Json[]).flatMap((s) => (s.contacts as Json[]).map((c) => String(c.id))));
      expect(live.has(P2.id)).toBe(false);
      expect(live.has(G(11).id)).toBe(false);
      // The pair is gone; the group of twelve (now eleven live) still shows its ten newest.
      const group = (after.data as Json[]).find((s) => (s.contacts as Json[]).some((c) => c.id === G(12).id));
      expect(((group?.contacts ?? []) as Json[]).map((c) => String(c.id)).sort()).toEqual(
        [G(12), G(10), G(9), G(8), G(7), G(6), G(5), G(4), G(3), G(2)].map((c) => c.id).sort(),
      );
      expect(setKeys(after).some((k) => k.includes(P1.id))).toBe(false);
    });

    it('refuses a malformed cursor and an out-of-range limit with 400', async () => {
      okBody(await duplicates(D.admin1, PROGRAMME_A1), 200, 'listDuplicates', 'control');
      expectError(await duplicates(D.admin1, PROGRAMME_A1, [['cursor', '!!!']]), 400, 'validation_failed', 'cursor');
      expectError(await duplicates(D.admin1, PROGRAMME_A1, [['limit', '0']]), 400, 'validation_failed', 'limit 0');
      expectError(await duplicates(D.admin1, PROGRAMME_A1, [['limit', '101']]), 400, 'validation_failed', 'limit 101');
    });
  });

  // =========================================================================
  // 3. Merge preview
  // =========================================================================

  describe('getContactMergePreview', () => {
    it('defaults each field to the more recently updated non-empty side (merged newer), names no compliance field, and gives the strictest compliance; nothing is written', async () => {
      const before = await worldState();
      const body = okBody(await preview(H.admin1, P1.id, P2.id), 200, 'getContactMergePreview', 'merged newer');
      expect((body.survivor as Json).id).toBe(P1.id);
      expect((body.merged as Json).id).toBe(P2.id);
      const defaults = body.defaults as Json;
      expect(pick(defaults, Object.keys(DEFAULTS_MERGED_NEWER))).toEqual(DEFAULTS_MERGED_NEWER);
      for (const field of COMPLIANCE_FIELDS) expect(defaults, `defaults names ${field}`).not.toHaveProperty(field);
      for (const key of Object.keys(defaults)) {
        expect(MERGE_FIELDS.includes(key) || /^custom\.[a-z][a-z0-9_]*__c$/.test(key), `defaults key ${key}`).toBe(true);
      }
      expect(body.compliance).toEqual({ dnd: true, whatsappOptIn: true, consentState: 'withdrawn', withheldFields: [] });
      expect(await worldState(), 'a preview writes nothing').toEqual(before);
    });

    it('flips the defaults when the survivor is the newer, and the compliance outcome does not move', async () => {
      await observer.query('UPDATE contact SET updated_at = $2 WHERE id = $1', [P1.id, '2026-05-01T09:00:00Z']);
      const body = okBody(await preview(H.admin1, P1.id, P2.id), 200, 'getContactMergePreview', 'survivor newer');
      expect(pick(body.defaults as Json, Object.keys(DEFAULTS_SURVIVOR_NEWER))).toEqual(DEFAULTS_SURVIVOR_NEWER);
      expect(body.compliance).toEqual({ dnd: true, whatsappOptIn: true, consentState: 'withdrawn', withheldFields: [] });
      // The other direction: P1 merged into P2. Most restrictive whatever the survivor (D-P28).
      const reverse = okBody(await preview(H.admin1, P2.id, P1.id), 200, 'getContactMergePreview', 'reverse');
      expect(reverse.compliance).toEqual(body.compliance);
    });

    it('withholds what field security withholds: no default for a withheld or read-only field, no withheld value anywhere, a withheld compliance outcome omitted and named', async () => {
      await lockField('emails', 'team_lead', 'none');
      await lockField('lga', 'team_lead', 'read');
      await lockField('dnd', 'team_lead', 'none');
      const response = await preview(H.tadmin, P1.id, P2.id);
      const body = okBody(response, 200, 'getContactMergePreview', 'withheld');
      for (const side of ['survivor', 'merged'] as const) {
        const contact = body[side] as Json;
        expect(contact, `${side}.emails`).not.toHaveProperty('emails');
        expect(contact.withheldFields as string[]).toEqual(expect.arrayContaining(['emails', 'dnd']));
      }
      const defaults = body.defaults as Json;
      expect(defaults).not.toHaveProperty('emails');
      expect(defaults).not.toHaveProperty('lga');
      expect(defaults.status, 'an editable field still has a default').toBe('merged');
      const compliance = body.compliance as Json;
      expect(compliance).not.toHaveProperty('dnd');
      expect(compliance.withheldFields).toEqual(['dnd']);
      expect(compliance.consentState).toBe('withdrawn');
      const emails = [...P1.emails, ...P2.emails];
      expect(identifiersIn(response.text, emails), 'a withheld email in the preview').toEqual([]);
    });

    it('scope: another programme the caller sees is 400 cross_programme at `with`; out of reach is 404 like an invented id; the same id twice is same_contact', async () => {
      okBody(await preview(H.admin12, P1.id, P2.id), 200, 'getContactMergePreview', 'control');
      expectDetail(await preview(H.admin12, P1.id, X2.id), 400, 'validation_failed', 'cross_programme', 'with', 'A1 + A2');
      const invented = await preview(H.admin1, P1.id, NOWHERE);
      expectError(invented, 404, 'not_found', 'invented with');
      expectSameBody(await preview(H.admin1, P1.id, X2.id), invented, 'with in A2 for an A1 admin');
      expectSameBody(await preview(H.admin1, P1.id, SEED_CONTACTS.find((c) => c.tenantId === TENANT_B)?.id ?? NOWHERE), invented, 'with in tenant B');
      const inventedSurvivor = await preview(H.admin1, NOWHERE, P1.id);
      expectError(inventedSurvivor, 404, 'not_found', 'invented survivor');
      expectSameBody(await preview(H.admin1, X2.id, P1.id), inventedSurvivor, 'survivor in A2');
      expectDetail(await preview(H.admin1, P1.id, P1.id), 400, 'validation_failed', 'same_contact', 'with', 'same id');
      expectError(await preview(H.admin1, P1.id, 'nope'), 400, 'validation_failed', 'malformed with');
    });
  });

  // =========================================================================
  // 4. Merge
  // =========================================================================

  describe('createContactMerge', () => {
    it('merges by the defaults (merged newer): the survivor takes the preview’s choices and the strictest compliance; the merged contact is soft-deleted; its activities and deals move', async () => {
      const t0 = Date.now();
      const v1 = await versionOf(P1.id);
      const body = await mergeOk(H.admin1, P1.id, P2.id);
      expect(body.programmeId).toBe(PROGRAMME_A1);
      expect((body.survivor as Json).id).toBe(P1.id);
      expect((body.merged as Json).id).toBe(P2.id);
      expect((body.merged as Json).displayName).toBe(P2.displayName);
      expect(UUID.test(String((body.survivor as Json).displayName)), 'never a UUID printed as a name').toBe(false);
      expect(body.mergedByUserId).toBe(ADMIN1);
      expect([body.undoneAt, body.undoneByUserId, body.survivorReverted]).toEqual([null, null, null]);
      const mergedAt = Date.parse(String(body.mergedAt));
      expect(mergedAt).toBeGreaterThanOrEqual(t0 - 5_000);
      expect(Date.parse(String(body.undoUntil)) - mergedAt, 'undoUntil is mergedAt plus exactly 30 days').toBe(THIRTY_DAYS_MS);

      const survivor = await contactRow(P1.id);
      expect(pick(survivor, Object.keys(EXPECT_MERGED_NEWER))).toEqual(EXPECT_MERGED_NEWER);
      expect(survivor.deleted_at).toBeNull();
      expect(Number(survivor.version), 'the survivor’s version moved').toBeGreaterThan(v1);
      expect((await contactRow(P2.id)).deleted_at, 'the merged contact is soft-deleted').not.toBeNull();
      expect(await childPointers()).toEqual({
        activities: { [ACT_P2A]: P1.id, [ACT_P2B]: P1.id },
        deals: { [DEAL_P2]: P1.id, [DEAL_P2B]: P1.id },
      });
      const rows = await mergeRows();
      expect(rows).toHaveLength(1);
      expect(pick(must(rows[0], 'row'), ['id', 'tenant_id', 'programme_id', 'survivor_id', 'merged_id', 'merged_by_user_id'])).toEqual({
        id: body.id, tenant_id: TENANT_A, programme_id: PROGRAMME_A1, survivor_id: P1.id, merged_id: P2.id, merged_by_user_id: ADMIN1,
      });
    });

    it('merges by the defaults when the survivor is newer: its own non-empty values stay, empties are filled, compliance is still the strictest', async () => {
      await observer.query('UPDATE contact SET updated_at = $2 WHERE id = $1', [P1.id, '2026-05-01T09:00:00Z']);
      await mergeOk(H.admin1, P1.id, P2.id);
      expect(pick(await contactRow(P1.id), Object.keys(EXPECT_SURVIVOR_NEWER))).toEqual(EXPECT_SURVIVOR_NEWER);
    });

    it('honours explicit choices field by field', async () => {
      await mergeOk(H.admin1, P1.id, P2.id, {
        displayName: 'survivor', phones: 'survivor', emails: 'survivor', status: 'survivor', tags: 'merged', lga: 'merged', ownerUserId: 'merged',
      });
      const row = await contactRow(P1.id);
      expect(pick(row, ['display_name', 'phones', 'emails', 'status', 'tags', 'lga', 'owner_user_id', 'company_name'])).toEqual({
        display_name: P1.displayName,
        phones: P1.phones.map((e164) => ({ type: 'mobile', e164 })),
        emails: P1.emails,
        status: 'new',
        tags: [],
        lga: null,
        owner_user_id: null,
        company_name: P2.companyName,
      });
    });

    it('takes the most restrictive compliance value for every combination, whichever record survives and whichever is newer (D-P28)', async () => {
      let n = 0;
      for (const sc of CONSENT_ORDER) {
        for (const mc of CONSENT_ORDER) {
          n += 1;
          const s: ContactPlant = {
            id: id95(`c10000${String(n).padStart(2, '0')}`), programmeId: PROGRAMME_A1, displayName: `Zqmatrix S${n}`,
            phones: [], emails: [], dnd: (n & 1) === 1, whatsappOptIn: (n & 4) === 4, consentState: sc,
            updatedAt: n % 2 === 0 ? '2026-06-01T00:00:00.000Z' : '2026-05-01T00:00:00.000Z',
          };
          const m: ContactPlant = {
            id: id95(`c20000${String(n).padStart(2, '0')}`), programmeId: PROGRAMME_A1, displayName: `Zqmatrix M${n}`,
            phones: [], emails: [], dnd: (n & 2) === 2, whatsappOptIn: (n & 8) === 8, consentState: mc,
            updatedAt: n % 2 === 0 ? '2026-05-01T00:00:00.000Z' : '2026-06-01T00:00:00.000Z',
          };
          await plantContact(s);
          await plantContact(m);
          const expected = strictest(
            { dnd: s.dnd, whatsappOptIn: s.whatsappOptIn, consentState: sc },
            { dnd: m.dnd, whatsappOptIn: m.whatsappOptIn, consentState: mc },
          );
          const shown = okBody(await preview(H.admin1, s.id, m.id), 200, 'getContactMergePreview', `preview ${n}`);
          expect(shown.compliance, `preview ${sc}+${mc}`).toEqual({ ...expected, withheldFields: [] });
          await mergeOk(H.admin1, s.id, m.id);
          const row = await contactRow(s.id);
          expect({ dnd: row.dnd, whatsappOptIn: row.whatsapp_opt_in, consentState: row.consent_state }, `merge ${n}: ${sc}+${mc}`).toEqual(expected);
        }
      }
    }, 120_000);

    it('refuses a compliance field in choices: 400 compliance_not_choosable at choices.<field>, nothing written', async () => {
      const before = await worldState();
      for (const field of COMPLIANCE_FIELDS) {
        for (const side of ['survivor', 'merged']) {
          const response = await merge(H.admin1, P1.id, P2.id, { [field]: side });
          expectDetail(response, 400, 'validation_failed', 'compliance_not_choosable', `choices.${field}`, `${field}: ${side}`);
        }
      }
      expect(await worldState()).toEqual(before);
      okBody(await merge(H.admin1, P1.id, P2.id), 201, 'createContactMerge', 'control: the same merge without them');
    });

    it('keeps the survivor’s value for a withheld or read-only field, and choosing one is 403 field_not_editable; nothing echoed, nothing written', async () => {
      await lockField('emails', 'team_lead', 'none');
      await lockField('lga', 'team_lead', 'read');
      // Make P2's lga non-empty, so the default would otherwise take it (P2 is newer).
      await observer.query(`UPDATE contact SET lga = 'Zqmergedlga', updated_at = $2 WHERE id = $1`, [P2.id, P2.updatedAt]);
      const before = await worldState();
      for (const [field, choices] of [['emails', { emails: 'merged' }], ['lga', { lga: 'merged' }]] as const) {
        const response = await merge(H.tadmin, P1.id, P2.id, choices);
        expectDetail(response, 403, 'not_permitted', 'field_not_editable', `choices.${field}`, field);
        expect(response.text).not.toContain('Zqmergedlga');
      }
      expect(await worldState()).toEqual(before);
      const response = await merge(H.tadmin, P1.id, P2.id);
      okBody(response, 201, 'createContactMerge', 'tenant admin, defaults');
      expect(identifiersIn(response.text, [...P1.emails, ...P2.emails])).toEqual([]);
      const row = await contactRow(P1.id);
      expect(row.emails, 'withheld: the survivor keeps its own').toEqual(P1.emails);
      expect(row.lga, 'read-only: the survivor keeps its own').toBe(P1.lga);
      expect(row.status, 'an editable field still follows the default').toBe('qualified');
      expect(row.dnd, 'compliance is the strictest even for a reader of nothing').toBe(true);
    });

    it('keeps a withheld custom key’s survivor value, takes a visible key by default, refuses choosing the withheld key, and never echoes either value', async () => {
      await plantCustomField('f0000101', 'secret__c', 'text', {}, [['team_lead', 'none']]);
      await plantCustomField('f0000102', 'tier__c', 'picklist', { values: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }] }, []);
      await observer.query('UPDATE contact SET custom = $2::jsonb, updated_at = $3 WHERE id = $1', [P1.id, JSON.stringify({ secret__c: 'zqsurvsecret', tier__c: 'gold' }), P1.updatedAt]);
      await observer.query('UPDATE contact SET custom = $2::jsonb, updated_at = $3 WHERE id = $1', [P2.id, JSON.stringify({ secret__c: 'zqmergedsecret', tier__c: 'silver' }), P2.updatedAt]);
      const shown = await preview(H.tadmin, P1.id, P2.id);
      const body = okBody(shown, 200, 'getContactMergePreview', 'custom');
      expect(shown.text).not.toContain('zqsurvsecret');
      expect(shown.text).not.toContain('zqmergedsecret');
      expect(Object.keys(body.defaults as Json)).not.toContain('custom.secret__c');
      const refused = await merge(H.tadmin, P1.id, P2.id, { 'custom.secret__c': 'merged' });
      expectDetail(refused, 403, 'not_permitted', 'field_not_editable', 'choices.custom.secret__c', 'withheld custom key');
      expect(refused.text).not.toContain('zqsurvsecret');
      expect(refused.text).not.toContain('zqmergedsecret');
      const done = await merge(H.tadmin, P1.id, P2.id);
      okBody(done, 201, 'createContactMerge', 'custom defaults');
      expect(done.text).not.toContain('zqsurvsecret');
      expect(done.text).not.toContain('zqmergedsecret');
      expect((await contactRow(P1.id)).custom).toEqual({ secret__c: 'zqsurvsecret', tier__c: 'silver' });
    });

    it('never gives the survivor an owner who has left the programme: the default falls back, and choosing that side is 400 unknown_reference (M4)', async () => {
      // Agent 2 is a member of A2 only: a "former owner" of an A1 contact (D-P23).
      await observer.query('UPDATE contact SET owner_user_id = $2, updated_at = $3 WHERE id = $1', [P2.id, USER_A_AGENT_2, P2.updatedAt]);
      const shown = okBody(await preview(H.admin1, P1.id, P2.id), 200, 'getContactMergePreview', 'owner');
      expect((shown.defaults as Json).ownerUserId).not.toBe('merged');
      const before = await worldState();
      const refused = await merge(H.admin1, P1.id, P2.id, { ownerUserId: 'merged' });
      expectDetail(refused, 400, 'validation_failed', 'unknown_reference', 'choices.ownerUserId', 'non-member owner');
      expect(await worldState()).toEqual(before);
      await mergeOk(H.admin1, P1.id, P2.id);
      expect((await contactRow(P1.id)).owner_user_id).toBe(USER_A_AGENT_1);
    });

    it('checks both versions: a stale survivor or merged version is 409 stale_write and nothing is written', async () => {
      const before = await worldState();
      const body = await mergeBody(P1.id, P2.id);
      expectError(await mergeRaw(H.admin1, { ...body, survivorVersion: Number(body.survivorVersion) + 1 }), 409, 'stale_write', 'survivor ahead');
      expectError(await mergeRaw(H.admin1, { ...body, mergedVersion: Number(body.mergedVersion) + 1 }), 409, 'stale_write', 'merged ahead');
      await observer.query(`UPDATE contact SET tags = ARRAY['zqbump'] WHERE id = $1`, [P2.id]);
      const afterBump = await worldState();
      expectError(await mergeRaw(H.admin1, body), 409, 'stale_write', 'merged edited since the read');
      expect(await worldState()).toEqual(afterBump);
      expect(afterBump.merges).toEqual(before.merges);
      okBody(await merge(H.admin1, P1.id, P2.id), 201, 'createContactMerge', 'control: current versions');
    });

    it('scope: out of reach is 404 like an invented id (either side, any tenant); another visible programme is 400 cross_programme; the same id twice is same_contact', async () => {
      const before = await worldState([P1.id, P2.id, X2.id]);
      const invented = await mergeRaw(H.admin1, { survivorId: P1.id, mergedId: NOWHERE, survivorVersion: 1, mergedVersion: 1 });
      expectError(invented, 404, 'not_found', 'invented merged');
      expectSameBody(await merge(H.admin1, P1.id, X2.id), invented, 'merged in A2 for an A1 admin');
      const inventedSurvivor = await mergeRaw(H.admin1, { survivorId: NOWHERE, mergedId: P1.id, survivorVersion: 1, mergedVersion: 1 });
      expectError(inventedSurvivor, 404, 'not_found', 'invented survivor');
      expectSameBody(await merge(H.admin1, X2.id, P1.id), inventedSurvivor, 'survivor in A2');
      expectError(await merge(H.tenantB, P1.id, P2.id), 404, 'not_found', 'tenant B');
      expectDetail(await merge(H.admin12, P1.id, X2.id), 400, 'validation_failed', 'cross_programme', 'mergedId', 'A1 + A2');
      expectDetail(await merge(H.admin1, P1.id, P1.id), 400, 'validation_failed', 'same_contact', 'mergedId', 'same id');
      expect(await worldState([P1.id, P2.id, X2.id])).toEqual(before);
      okBody(await merge(H.admin12, P1.id, P2.id), 201, 'createContactMerge', 'control');
    });

    it('needs contact.write: the agent, team_lead, programme_manager, qa_analyst and client_portal sets are 403, whatever the body; claim rights never permit a merge (D-P14, D-L151)', async () => {
      const before = await worldState();
      for (const [label, headers] of [['agent', H.agent1], ['team_lead', H.teamLead], ['programme_manager', H.pm], ['qa_analyst', H.qa], ['client_portal', H.portal]] as const) {
        expectError(await merge(headers, P1.id, P2.id), 403, 'not_permitted', label);
        // M15: 403 before 400.
        expectError(await merge(headers, P1.id, P2.id, { dnd: 'merged' }), 403, 'not_permitted', `${label}, compliance in choices`);
        // M15: 404 before 403.
        expectError(await merge(headers, P1.id, X2.id), 404, 'not_found', `${label}, out of reach`);
      }
      expect(await worldState()).toEqual(before);
      okBody(await merge(H.tadmin, P1.id, P2.id), 201, 'createContactMerge', 'the tenant-admin flag grants contact.write');
    });

    it('answers 409 already_merged for a merged-away contact on either side to a caller who could read it, and 404 to one who could not', async () => {
      await mergeOk(H.admin1, P1.id, P2.id);
      const asMerged = await mergeRaw(H.admin1, { survivorId: E1.id, mergedId: P2.id, survivorVersion: await versionOf(E1.id), mergedVersion: await versionOf(P2.id) });
      expectError(asMerged, 409, 'already_merged', 'merged side');
      const asSurvivor = await mergeRaw(H.admin1, { survivorId: P2.id, mergedId: E1.id, survivorVersion: await versionOf(P2.id), mergedVersion: await versionOf(E1.id) });
      expectError(asSurvivor, 409, 'already_merged', 'survivor side');
      const outsider = await mergeRaw(H.admin2, { survivorId: Q1.id, mergedId: P2.id, survivorVersion: 1, mergedVersion: 1 });
      const invented = await mergeRaw(H.admin2, { survivorId: Q1.id, mergedId: NOWHERE, survivorVersion: 1, mergedVersion: 1 });
      expectError(invented, 404, 'not_found', 'invented');
      expectSameBody(outsider, invented, 'A2 admin naming an A1 merged-away contact');
    });

    it('writes exactly one audit event per merge, `merged`, field names only, no value; refused requests write none (M3)', async () => {
      const start = await auditCount();
      await merge(H.admin1, P1.id, P2.id, { dnd: 'merged' });
      await merge(H.agent1, P1.id, P2.id);
      await mergeRaw(H.admin1, { ...(await mergeBody(P1.id, P2.id)), survivorVersion: 999 });
      expect(await auditCount(), 'refused requests write no audit').toBe(start);
      await mergeOk(H.admin1, P1.id, P2.id);
      const rows = await auditRowsSince(start);
      expect(rows.map((r) => r.action), 'exactly one event, any object').toEqual(['merged']);
      const event = must(rows[0], 'the event');
      expect(event.object_type).toBe('contact');
      expect([P1.id, P2.id]).toContain(event.object_id);
      expect(event.programme_id).toBe(PROGRAMME_A1);
      expect(event.actor_user_id).toBe(ADMIN1);
      const changes = event.changes as Json[];
      const fields = changes.map((c) => String(c.field));
      for (const change of changes) {
        expect([change.before ?? null, change.after ?? null], `change ${String(change.field)} carries a value`).toEqual([null, null]);
        expect(MERGE_FIELDS.includes(String(change.field)) || (COMPLIANCE_FIELDS as readonly string[]).includes(String(change.field)) || String(change.field).startsWith('custom.'), String(change.field)).toBe(true);
      }
      // P1's dnd went false -> true and its consent opted_in -> withdrawn (D-P28: audited by field name).
      expect(fields).toEqual(expect.arrayContaining(['dnd', 'consentState']));
      const text = JSON.stringify(event);
      expect(identifiersIn(text, [...P1.phones, ...P2.phones, ...P1.emails, ...P2.emails])).toEqual([]);
      for (const value of [P1.displayName, P2.displayName, String(P2.companyName), 'Zqsurvgiven', 'Zqmergegiven']) {
        expect(text, `the audit row carries "${value}"`).not.toContain(value);
      }
    });

    it('lists the merge event through the audit API, valid against admin.openapi.yaml (AuditAction admits merged)', async () => {
      await mergeOk(H.admin1, P1.id, P2.id);
      const response = await get(H.supervisor, '/api/v1/admin/audit/events', [['action', 'merged']]);
      expect(response.status, response.text).toBe(200);
      const raw = must(((loadDoc(ADMIN_SPEC_PATH) as Json).paths as Json)['/api/v1/admin/audit/events'] as Json, 'audit path');
      const ok = deref(((((raw.get as Json).responses as Json)['200'] as Json)), ADMIN_SPEC_PATH).schema;
      const schema = must(((ok.content as Json)['application/json'] as Json).schema as Json, 'audit schema');
      expect(schemaErrors(schema, response.body, 'listAuditEvents', ADMIN_SPEC_PATH)).toEqual([]);
      expect(response.text).toContain('merged');
      expect(identifiersIn(response.text, [...P1.phones, ...P2.phones, ...P1.emails, ...P2.emails])).toEqual([]);
    });

    it('lets one of two racing opposite merges win, never both and never a 500', async () => {
      const [a, b] = await Promise.all([
        mergeRaw(H.admin1, await mergeBody(P1.id, P2.id)),
        mergeRaw(H.admin1b, await mergeBody(P2.id, P1.id)),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses[0], `${a.text} / ${b.text}`).toBe(201);
      expect([404, 409]).toContain(statuses[1]);
      const deleted = [(await contactRow(P1.id)).deleted_at, (await contactRow(P2.id)).deleted_at].filter((d) => d !== null);
      expect(deleted, 'exactly one of the two is merged away').toHaveLength(1);
      expect(await mergeRows()).toHaveLength(1);
    });

    it('keeps every identifier and name out of logs and spans across duplicates, preview, merge, list and undo', async () => {
      const scanner = await freshUser([[PROGRAMME_A1, 'admin']]);
      const { lines, spans } = await captureEverything(async () => {
        await duplicates(scanner, PROGRAMME_A1, [['limit', '100']]);
        await preview(H.admin1, P1.id, P2.id);
        await merge(H.admin1, P1.id, P2.id, { dnd: 'merged' });
        const done = await merge(H.admin1, P1.id, P2.id);
        await listMerges(H.admin1);
        await undo(H.admin1, String((done.body as Json).id));
      });
      expect(spans, 'not vacuous: the work produced spans').toBeGreaterThan(0);
      const haystack = lines.join('\n');
      expect(identifiersIn(haystack, ALL_IDENTIFIERS)).toEqual([]);
      for (const value of [P2.displayName, 'Zqsurvgiven', 'Zqmergegiven', String(P2.companyName)]) {
        expect(haystack, `a log or span carries "${value}"`).not.toContain(value);
      }
    });
  });

  // =========================================================================
  // 5. Soft delete hides the merged-away contact (D-P27)
  // =========================================================================

  describe('a merged-away contact is gone from every read and every write', () => {
    /** Merge keeping P2's identifiers OFF the survivor, so every trace of them is P2's own. */
    const KEEP_SURVIVOR = { displayName: 'survivor', givenNames: 'survivor', companyName: 'survivor', phones: 'survivor', emails: 'survivor', accountId: 'survivor' };

    const searchText = async (headers: Headers, q: string) => {
      const response = await get(headers, '/api/v1/search', [['q', q]]);
      expect(response.status, response.text).toBe(200);
      return response.text;
    };
    const lookupText = async (headers: Headers, body: Json) => {
      const response = await send('post', '/api/v1/search/lookup', headers, body);
      expect(response.status, response.text).toBe(200);
      return response.text;
    };

    it('is absent from lists, leads, search, lookup and account children (each seen before the merge as the control)', async () => {
      const probes = async () => ({
        listName: ids((await get(H.admin1, '/api/v1/contacts', [['q', 'Zqmergegiven']])).body),
        listPhone: ids((await get(H.admin1, '/api/v1/contacts', [['q', '+2348039500009']])).body),
        leads: ids((await get(H.admin1, '/api/v1/leads', [['limit', '100']])).body),
        accountChildren: ids((await get(H.admin1, `/api/v1/accounts/${ACC1}/contacts`, [['limit', '100']])).body),
        searchName: (await searchText(H.admin1, 'Zqmergegiven')).includes(P2.id),
        searchCompany: (await searchText(H.admin1, 'Zqmergeco')).includes(P2.id),
        lookupEmail: (await lookupText(H.admin1, { email: 'zq.only.p2@example.test' })).includes(P2.id),
        lookupPhone: (await lookupText(H.admin1, { phone: '+2348039500009' })).includes(P2.id),
      });
      const before = await probes();
      expect(before, 'control: every path finds P2 before the merge').toEqual({
        listName: [P2.id], listPhone: [P2.id], leads: expect.arrayContaining([P2.id]) as unknown, accountChildren: [P2.id],
        searchName: true, searchCompany: true, lookupEmail: true, lookupPhone: true,
      });
      await mergeOk(H.admin1, P1.id, P2.id, KEEP_SURVIVOR);
      const after = await probes();
      expect(after).toEqual({
        listName: [], listPhone: [], leads: expect.not.arrayContaining([P2.id]) as unknown, accountChildren: [],
        searchName: false, searchCompany: false, lookupEmail: false, lookupPhone: false,
      });
      // The tenant admin across both programmes sees no more than the merger.
      expect(ids((await get(H.supervisor, '/api/v1/contacts', [['q', 'Zqmergegiven']])).body)).toEqual([]);
    });

    it('answers every contact route with the invented id’s 404 body: record, timeline, scripts, preview either side (M9)', async () => {
      const routes = (id: string) => [
        ['getContact', () => get(H.admin1, `/api/v1/contacts/${id}`)],
        ['timeline', () => get(H.admin1, `/api/v1/contacts/${id}/timeline`)],
        ['scripts', () => get(H.admin1, `/api/v1/contacts/${id}/scripts`)],
        ['preview as survivor', () => preview(H.admin1, id, E1.id)],
        ['preview as merged', () => preview(H.admin1, E1.id, id)],
      ] as const;
      for (const [label, call] of routes(P2.id)) {
        expect((await call()).status, `control: ${label} before the merge`).toBe(200);
      }
      await mergeOk(H.admin1, P1.id, P2.id, KEEP_SURVIVOR);
      const controls = routes(NOWHERE);
      for (const [index, [label, call]] of routes(P2.id).entries()) {
        const control = await must(controls[index], label)[1]();
        expectError(control, 404, 'not_found', `${label}: invented`);
        expectSameBody(await call(), control, label);
      }
      for (const headers of [H.supervisor, H.agent1]) {
        expectSameBody(await get(headers, `/api/v1/contacts/${P2.id}`), await get(headers, `/api/v1/contacts/${NOWHERE}`), 'every reader');
      }
    });

    it('refuses every write that names it, exactly as an invented id: update, convert, activity, deal create and update (M9)', async () => {
      await mergeOk(H.admin1, P1.id, P2.id, KEEP_SURVIVOR);
      const version = await versionOf(P2.id);
      const pair = async (label: string, call: (id: string) => Promise<request.Response>, status: number, code: string) => {
        const control = await call(NOWHERE);
        expectError(control, status, code, `${label}: invented`);
        expectSameBody(await call(P2.id), control, label);
      };
      await pair('updateContact', (id) => send('patch', `/api/v1/contacts/${id}`, H.admin1, { version, status: 'contacted' }), 404, 'not_found');
      await pair('convertContact', (id) => send('post', `/api/v1/contacts/${id}/convert`, H.admin1, { version, accountId: ACC1 }), 404, 'not_found');
      await pair('createActivity', (id) => send('post', '/api/v1/activities', H.admin1, { type: 'note', subject: 'T-0095 note', contactId: id }), 404, 'not_found');
      const pipeline = must(pipelines[PROGRAMME_A1], 'pipeline').id;
      await pair('createDeal', (id) => send('post', `/api/v1/pipelines/${pipeline}/deals`, H.admin1, { name: 'T-0095 deal', primaryContactId: id }), 400, 'validation_failed');
      const dealVersion = Number((await observer.query<{ version: number }>('SELECT version FROM deal WHERE id = $1', [DEAL_P2])).rows[0]?.version);
      await pair('updateDeal', (id) => send('patch', `/api/v1/deals/${DEAL_P2}`, H.admin1, { version: dealVersion, primaryContactId: id }), 400, 'validation_failed');
      const row = await contactRow(P2.id);
      expect(row.version, 'the merged-away row was not written').toBe(version);
      expect(row.status).toBe(P2.status);
      const acts = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM activity WHERE contact_id = $1', [P2.id]);
      expect(acts.rows[0]?.n, 'no activity points at it').toBe('0');
    });

    it('moves deals and activities: the deal and the board name the survivor, and the survivor’s timeline holds the moved activities and still validates (M14)', async () => {
      await mergeOk(H.admin1, P1.id, P2.id, KEEP_SURVIVOR);
      const deal = await get(H.admin1, `/api/v1/deals/${DEAL_P2}`);
      expect(deal.status, deal.text).toBe(200);
      expect((deal.body as Json).primaryContactId).toBe(P1.id);
      const board = await get(H.admin1, `/api/v1/pipelines/${must(pipelines[PROGRAMME_A1], 'pipeline').id}/board`);
      expect(board.status, board.text).toBe(200);
      expect(board.text).toContain(P1.id);
      expect(board.text).not.toContain(P2.id);
      const timeline = await get(H.admin1, `/api/v1/contacts/${P1.id}/timeline`);
      okBodyLoose(timeline, 'listContactTimeline', 'survivor timeline');
      expect(timeline.text).toContain(ACT_P2A);
      expect(timeline.text).toContain(ACT_P2B);
      expect(timeline.text).not.toContain(P2.id);
    });

    it('answers a listContacts cursor naming it exactly as a cursor naming a row out of scope (M9)', async () => {
      // A cursor for P2: page the A1 contacts by name until P2 is the last row.
      const cursorAfter = async (headers: Headers, target: string): Promise<string> => {
        let cursor: string | undefined;
        for (let guard = 0; guard < 40; guard += 1) {
          const params: [string, string][] = [['limit', '1'], ['sort', 'displayName']];
          if (cursor !== undefined) params.push(['cursor', cursor]);
          const page = (await get(headers, '/api/v1/contacts', params)).body as Json;
          const next = page.nextCursor as string | null;
          if (ids(page)[0] === target && next !== null) return next;
          if (next === null) break;
          cursor = next;
        }
        throw new Error(`no cursor ending at ${target}`);
      };
      const deadCursor = await cursorAfter(H.supervisor, P2.id);
      const outOfScope = await cursorAfter(H.supervisor, X2.id);
      await mergeOk(H.admin1, P1.id, P2.id, KEEP_SURVIVOR);
      const control = await get(H.admin1, '/api/v1/contacts', [['limit', '1'], ['sort', 'displayName'], ['cursor', outOfScope]]);
      const probe = await get(H.admin1, '/api/v1/contacts', [['limit', '1'], ['sort', 'displayName'], ['cursor', deadCursor]]);
      expect(probe.status, probe.text).toBe(control.status);
      expect(probe.text).toBe(control.text);
    });

    it('never lets a script run started before the merge log its call on the merged-away contact (M10)', async () => {
      await observer.query(
        `INSERT INTO disposition (id, tenant_id, programme_id, code, label, category, note_required, follow_up_required, active, position)
         VALUES ($1, $2, $3, 'ZQ95', 'T-0095 not reached', 'not_reached', false, false, true, 95)`,
        [DISPOSITION_A2, TENANT_A, PROGRAMME_A2],
      );
      const started = await send('post', '/api/v1/script-runs', H.admin2, { scriptId: SCRIPT_A2, contactId: Q2.id });
      expect(started.status, started.text).toBe(201);
      const run = started.body as Json;
      await mergeOk(H.admin2, Q1.id, Q2.id);
      const completed = await send('post', `/api/v1/script-runs/${String(run.id)}/complete`, H.admin2, {
        revision: run.revision, outcome: 'interrupted', dispositionId: DISPOSITION_A2,
      });
      expect(completed.status, `never a 500: ${completed.text}`).toBeLessThan(500);
      const onMerged = await observer.query<{ n: string }>('SELECT count(*)::text AS n FROM activity WHERE contact_id = $1', [Q2.id]);
      expect(onMerged.rows[0]?.n, 'an activity was written on the merged-away contact').toBe('0');
      expect((await contactRow(Q2.id)).deleted_at, 'still merged away').not.toBeNull();
      // A new run on it is refused like an invented contact.
      const control = await send('post', '/api/v1/script-runs', H.admin2, { scriptId: SCRIPT_A2, contactId: NOWHERE });
      expectError(control, 404, 'not_found', 'invented contact');
      expectSameBody(await send('post', '/api/v1/script-runs', H.admin2, { scriptId: SCRIPT_A2, contactId: Q2.id }), control, 'startScriptRun');
    });
  });

  /** 200 and valid against the operation's schema, without the no-store rule (older routes). */
  function okBodyLoose(response: request.Response, operationId: string, where: string): Json {
    expect(response.status, `${where}: ${response.text}`).toBe(200);
    expect(schemaErrors(responseSchemaOf(operationId, '200'), response.body, where)).toEqual([]);
    return response.body as Json;
  }

  // =========================================================================
  // 6. Undo
  // =========================================================================

  describe('undoContactMerge', () => {
    it('restores the merged contact and its children, reverts the unedited survivor except compliance, writes one `restored` event; a repeat is 200 unchanged (M13)', async () => {
      const p2Before = okBodyLoose(await get(H.admin1, `/api/v1/contacts/${P2.id}`), 'getContact', 'P2 before');
      const merged = await mergeOk(H.admin1, P1.id, P2.id);
      const start = await auditCount();
      const response = await undo(H.admin1, String(merged.id));
      const body = okBody(response, 200, 'undoContactMerge', 'undo');
      expect(body.id).toBe(merged.id);
      expect(body.undoneByUserId).toBe(ADMIN1);
      expect(body.survivorReverted).toBe(true);
      expect(Date.parse(String(body.undoneAt))).toBeGreaterThan(0);
      // The merged contact is back, as it was (compliance aside: it was already the strictest).
      const p2After = okBodyLoose(await get(H.admin1, `/api/v1/contacts/${P2.id}`), 'getContact', 'P2 after');
      const keys = ['displayName', 'givenNames', 'familyName', 'companyName', 'phones', 'emails', 'accountId', 'ownerUserId', 'status', 'source', 'tags', 'preferredLanguage', 'state', 'lga', 'dnd', 'whatsappOptIn', 'consentState'];
      expect(pick(p2After, keys)).toEqual(pick(p2Before, keys));
      expect((await contactRow(P2.id)).deleted_at).toBeNull();
      expect(await childPointers()).toEqual({
        activities: { [ACT_P2A]: P2.id, [ACT_P2B]: P2.id },
        deals: { [DEAL_P2]: P2.id, [DEAL_P2B]: P2.id },
      });
      // The survivor is put back, but never loosened: dnd and consent keep the merge's strictness (D-P28).
      const p1 = await contactRow(P1.id);
      expect(pick(p1, ['display_name', 'given_names', 'company_name', 'phones', 'emails', 'account_id', 'status', 'preferred_language'])).toEqual({
        display_name: P1.displayName, given_names: P1.givenNames, company_name: null,
        phones: P1.phones.map((e164) => ({ type: 'mobile', e164 })), emails: P1.emails, account_id: null, status: 'new', preferred_language: 'en',
      });
      expect({ dnd: p1.dnd, consent: p1.consent_state, wa: p1.whatsapp_opt_in }).toEqual({ dnd: true, consent: 'withdrawn', wa: true });
      // One event.
      const rows = await auditRowsSince(start);
      expect(rows.map((r) => r.action)).toEqual(['restored']);
      expect(pick(must(rows[0], 'restored'), ['object_type', 'programme_id', 'actor_user_id'])).toEqual({ object_type: 'contact', programme_id: PROGRAMME_A1, actor_user_id: ADMIN1 });
      expect([P1.id, P2.id]).toContain(must(rows[0], 'restored').object_id);
      // Visible again on the lists and search.
      expect(ids((await get(H.admin1, '/api/v1/contacts', [['q', 'Zqmergegiven']])).body)).toEqual([P2.id]);
      // A repeat: 200, the same merge, no second event.
      const again = await undo(H.admin1, String(merged.id));
      expect(okBody(again, 200, 'undoContactMerge', 'repeat')).toEqual(body);
      expect(await auditCount()).toBe(start + 1);
    });

    it('leaves an edited survivor’s values alone (survivorReverted false)', async () => {
      const merged = await mergeOk(H.admin1, P1.id, P2.id);
      const edit = await send('patch', `/api/v1/contacts/${P1.id}`, H.admin1, { version: await versionOf(P1.id), tags: ['zqedited'] });
      expect(edit.status, edit.text).toBe(200);
      const body = okBody(await undo(H.admin1, String(merged.id)), 200, 'undoContactMerge', 'undo');
      expect(body.survivorReverted).toBe(false);
      const p1 = await contactRow(P1.id);
      expect(p1.tags).toEqual(['zqedited']);
      expect(p1.display_name, 'the merge’s values stay on an edited survivor').toBe(P2.displayName);
      expect((await contactRow(P2.id)).deleted_at).toBeNull();
    });

    it('never loosens compliance on either contact: the restored one takes the stricter of its snapshot and the survivor’s current value (D-L151)', async () => {
      // Both loose before the merge.
      await observer.query(`UPDATE contact SET dnd = false, whatsapp_opt_in = true, consent_state = 'opted_in', updated_at = $2 WHERE id = $1`, [P2.id, P2.updatedAt]);
      const merged = await mergeOk(H.admin1, P1.id, P2.id);
      // The customer opts out on the survivor after the merge.
      const edit = await send('patch', `/api/v1/contacts/${P1.id}`, H.admin1, { version: await versionOf(P1.id), whatsappOptIn: false, consentState: 'withdrawn' });
      expect(edit.status, edit.text).toBe(200);
      await observer.query('UPDATE contact SET dnd = true WHERE id = $1', [P1.id]);
      okBody(await undo(H.admin1, String(merged.id)), 200, 'undoContactMerge', 'undo');
      const p2 = await contactRow(P2.id);
      expect({ dnd: p2.dnd, wa: p2.whatsapp_opt_in, consent: p2.consent_state }, 'the restored contact').toEqual({ dnd: true, wa: false, consent: 'withdrawn' });
      const p1 = await contactRow(P1.id);
      expect({ dnd: p1.dnd, wa: p1.whatsapp_opt_in, consent: p1.consent_state }, 'the survivor').toEqual({ dnd: true, wa: false, consent: 'withdrawn' });
    });

    it('moves back only the children the merge moved that still point at the survivor (M11)', async () => {
      const merged = await mergeOk(H.admin1, P1.id, P2.id);
      const dealVersion = Number((await observer.query<{ version: number }>('SELECT version FROM deal WHERE id = $1', [DEAL_P2B])).rows[0]?.version);
      const repoint = await send('patch', `/api/v1/deals/${DEAL_P2B}`, H.admin1, { version: dealVersion, primaryContactId: E1.id });
      expect(repoint.status, repoint.text).toBe(200);
      const logged = await send('post', '/api/v1/activities', H.admin1, { type: 'note', subject: 'T-0095 after the merge', contactId: P1.id });
      expect(logged.status, logged.text).toBe(201);
      const newActivity = String((logged.body as Json).id);
      okBody(await undo(H.admin1, String(merged.id)), 200, 'undoContactMerge', 'undo');
      expect(await childPointers()).toEqual({
        activities: { [ACT_P2A]: P2.id, [ACT_P2B]: P2.id },
        deals: { [DEAL_P2]: P2.id, [DEAL_P2B]: E1.id },
      });
      const fresh = await observer.query<{ contact_id: string }>('SELECT contact_id FROM activity WHERE id = $1', [newActivity]);
      expect(fresh.rows[0]?.contact_id).toBe(P1.id);
    });

    it('who: the merging user with contact.write now, or a tenant admin; another contact.write holder is 403; without contact.write or out of scope 404 (D-L151, D-L163)', async () => {
      const m1 = await mergeOk(H.admin1, P1.id, P2.id);
      const before = await worldState();
      expectError(await undo(H.admin1b, String(m1.id)), 403, 'not_permitted', 'another admin-set member');
      const invented = await undo(H.admin2, NOWHERE);
      expectError(invented, 404, 'not_found', 'invented merge');
      expectSameBody(await undo(H.admin2, String(m1.id)), invented, 'A2-only admin');
      expectSameBody(await undo(H.tenantB, String(m1.id)), await undo(H.tenantB, NOWHERE), 'tenant B');
      expectError(await undo(H.admin1, 'not-a-uuid'), 400, 'validation_failed', 'malformed');
      // The merger loses contact.write.
      await assign(ADMIN1, PROGRAMME_A1, 'agent');
      // LEAD EDIT (T-0095, D-L163): an undo by a caller without contact.write is 404, the
      // invented merge's body, not 403.
      const inventedForAgent = await undo(H.admin1, NOWHERE);
      expectError(inventedForAgent, 404, 'not_found', 'invented merge, the merger now an agent');
      expectSameBody(await undo(H.admin1, String(m1.id)), inventedForAgent, 'the merger, now an agent');
      expect(await worldState()).toEqual(before);
      // A tenant admin who did not merge may.
      const done = okBody(await undo(H.supervisor, String(m1.id)), 200, 'undoContactMerge', 'tenant admin');
      expect(done.undoneByUserId).toBe(USER_A_SUPERVISOR);
    });

    it('is open for 30 days: after undoUntil it is 410 undo_expired and nothing changes; just inside, it succeeds', async () => {
      const merged = await mergeOk(H.admin1, P1.id, P2.id);
      await observer.query(
        `UPDATE contact_merge SET created_at = now() - interval '31 days', undo_until = now() - interval '1 day' WHERE id = $1`, [merged.id],
      );
      const before = await worldState();
      expectError(await undo(H.admin1, String(merged.id)), 410, 'undo_expired', 'expired, merger');
      expectError(await undo(H.supervisor, String(merged.id)), 410, 'undo_expired', 'expired, tenant admin');
      expect(await worldState()).toEqual(before);
      await observer.query(
        `UPDATE contact_merge SET created_at = now() - interval '29 days 23 hours', undo_until = now() + interval '1 hour' WHERE id = $1`, [merged.id],
      );
      okBody(await undo(H.admin1, String(merged.id)), 200, 'undoContactMerge', 'inside the window');
    });

    it('refuses to undo a merge whose survivor was merged away since: 409 already_merged, until the later merge is undone', async () => {
      const first = await mergeOk(H.admin1, P1.id, P2.id);
      const second = await mergeOk(H.admin1, E1.id, P1.id);
      const before = await worldState([P1.id, P2.id, E1.id]);
      expectError(await undo(H.admin1, String(first.id)), 409, 'already_merged', 'survivor merged away');
      expect(await worldState([P1.id, P2.id, E1.id])).toEqual(before);
      okBody(await undo(H.admin1, String(second.id)), 200, 'undoContactMerge', 'the later merge');
      okBody(await undo(H.admin1, String(first.id)), 200, 'undoContactMerge', 'then the first');
      expect((await contactRow(P2.id)).deleted_at).toBeNull();
      expect((await contactRow(P1.id)).deleted_at).toBeNull();
    });

    it('is all-or-nothing under the undoer’s current field security: a field it would restore that is not editable is 403 field_not_editable, and nothing changes (M12)', async () => {
      const merged = await mergeOk(H.tadmin, P1.id, P2.id, { emails: 'merged' });
      await lockField('emails', 'team_lead', 'read');
      const before = await worldState();
      const refused = await undo(H.tadmin, String(merged.id));
      expectDetail(refused, 403, 'not_permitted', 'field_not_editable', 'emails', 'emails read-only now');
      expect(identifiersIn(refused.text, [...P1.emails, ...P2.emails])).toEqual([]);
      expect(await worldState()).toEqual(before);
      await lockField('emails', 'team_lead', 'edit');
      okBody(await undo(H.tadmin, String(merged.id)), 200, 'undoContactMerge', 'editable again');
      expect((await contactRow(P1.id)).emails).toEqual(P1.emails);
    });

    it('keeps the survivor’s timeline valid after the undo (M14)', async () => {
      const merged = await mergeOk(H.admin1, P1.id, P2.id);
      okBody(await undo(H.admin1, String(merged.id)), 200, 'undoContactMerge', 'undo');
      for (const id of [P1.id, P2.id]) {
        const timeline = await get(H.admin1, `/api/v1/contacts/${id}/timeline`);
        okBodyLoose(timeline, 'listContactTimeline', `timeline ${id}`);
      }
      expect((await get(H.admin1, `/api/v1/contacts/${P2.id}/timeline`)).text).toContain(ACT_P2A);
    });
  });

  // =========================================================================
  // 7. The merges list (the Phase 2 recycle bin)
  // =========================================================================

  describe('listContactMerges', () => {
    it('lists merges newest first, keyset, each exactly once, an undone one with its undo; never a snapshot or an identifier', async () => {
      const first = await mergeOk(H.admin1, P1.id, P2.id);
      const second = await mergeOk(H.admin1, E1.id, E2.id);
      const third = await mergeOk(H.admin1, M1.id, M2.id);
      okBody(await undo(H.admin1, String(second.id)), 200, 'undoContactMerge', 'undo the second');
      const response = await listMerges(H.admin1, [['limit', '100']]);
      const page = okBody(response, 200, 'listContactMerges', 'all');
      expect(ids(page)).toEqual([third.id, second.id, first.id]);
      const undone = must((page.data as Json[]).find((m) => m.id === second.id), 'the undone merge');
      expect(undone.undoneByUserId).toBe(ADMIN1);
      expect(typeof undone.survivorReverted).toBe('boolean');
      expect(identifiersIn(response.text, ALL_IDENTIFIERS)).toEqual([]);
      expect(response.text).not.toContain('snapshot');
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const params: [string, string][] = [['limit', '1']];
        if (cursor !== null) params.push(['cursor', cursor]);
        const one = okBody(await listMerges(H.admin1, params), 200, 'listContactMerges', `page ${guard}`);
        walked.push(...ids(one));
        cursor = one.nextCursor as string | null;
        if (cursor === null) break;
      }
      expect(walked).toEqual([third.id, second.id, first.id]);
    });

    it('is gated on contact.write or tenant admin, inside scope: agents and read-only sets see none, an A2 admin sees no A1 merge, tenant B none', async () => {
      const merged = await mergeOk(H.admin1, P1.id, P2.id);
      const a2 = await mergeOk(H.admin2, Q1.id, Q2.id);
      expect(ids(okBody(await listMerges(H.admin1), 200, 'listContactMerges', 'A1 admin'))).toEqual([merged.id]);
      expect(ids(okBody(await listMerges(H.tadmin), 200, 'listContactMerges', 'tenant admin, team_lead set')).sort()).toEqual([merged.id, a2.id].sort());
      expect(ids(okBody(await listMerges(H.supervisor), 200, 'listContactMerges', 'supervisor')).sort()).toEqual([merged.id, a2.id].sort());
      expect(ids(okBody(await listMerges(H.admin2), 200, 'listContactMerges', 'A2 admin'))).toEqual([a2.id]);
      for (const [label, headers] of [['agent', H.agent1], ['team_lead', H.teamLead], ['qa_analyst', H.qa], ['client_portal', H.portal], ['tenant B', H.tenantB]] as const) {
        expect(ids(okBody(await listMerges(headers), 200, 'listContactMerges', label)), label).toEqual([]);
      }
    });
  });

  // =========================================================================
  // 8. The throttle (D-L151; M7)
  // =========================================================================

  describe('the listDuplicates throttle', () => {
    // LEAD EDIT (T-0095, D-L163): 20 per minute per user (it was 60..600), and at most two
    // scans in flight per tenant.
    it('admits exactly 20 per user per minute, then 429 too_many_requests with Retry-After, before validation; another user is unaffected', async () => {
      const headers = await freshUser([[PROGRAMME_A1, 'admin']]);
      const other = await freshUser([[PROGRAMME_A1, 'admin']]);
      let admitted = 0;
      let refusal: request.Response | null = null;
      for (let n = 0; n < 30; n += 1) {
        const response = await duplicates(headers, PROGRAMME_A1, [['limit', '1']]);
        if (response.status === 429) {
          refusal = response;
          break;
        }
        expect(response.status, `request ${n + 1}: ${response.text.slice(0, 200)}`).toBe(200);
        admitted += 1;
      }
      expect(refusal, 'never throttled').not.toBeNull();
      expect(admitted, 'exactly 20 admitted in the window').toBe(20);
      const throttled = must(refusal, 'refusal');
      const body = expectError(throttled, 429, 'too_many_requests', 'throttled');
      expect(body.error).toBe('Too Many Requests');
      expectNoStore(throttled, '429');
      const retryAfter = Number(throttled.headers['retry-after']);
      expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After ${String(throttled.headers['retry-after'])}`).toBe(true);
      expectError(await duplicates(headers, PROGRAMME_A1, [['cursor', '!!!']]), 429, 'too_many_requests', 'malformed while throttled');
      expectError(await duplicates(headers, NOWHERE), 429, 'too_many_requests', 'invented programme while throttled');
      okBody(await duplicates(other, PROGRAMME_A1), 200, 'listDuplicates', 'another user');
    }, 120_000);

    it('runs at most two scans per tenant at once: a third is 429 with Retry-After at once, while another tenant is still admitted (D-L163)', async () => {
      const [u1, u2, u3] = [
        await freshUser([[PROGRAMME_A1, 'admin']]),
        await freshUser([[PROGRAMME_A1, 'admin']]),
        await freshUser([[PROGRAMME_A1, 'admin']]),
      ];
      const tenantB = await freshUser([[PROGRAMME_B1, 'admin']], false, TENANT_B);
      okBody(await duplicates(u3, PROGRAMME_A1), 200, 'listDuplicates', 'control: one scan alone');
      /**
       * Lock requests waiting on contact: the scans held behind the migrator's lock. pg_locks,
       * not pg_stat_activity, whose wait columns are hidden from kasuwa_migrator for other roles.
       */
      const lockWaiters = async () => {
        const rows = await observer.query<{ n: string }>(
          `SELECT count(DISTINCT pid)::text AS n FROM pg_locks
            WHERE NOT granted AND relation = to_regclass('public.contact') AND pid <> pg_backend_pid()`,
        );
        return Number(rows.rows[0]?.n ?? '0');
      };
      /** Waits on state, never on a clock: polls until the check holds, or fails after the deadline. */
      const waitFor = async (check: () => Promise<boolean>, what: string) => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (await check()) return;
          await new Promise((done) => setImmediate(done));
        }
        throw new Error(`waited 20 s for: ${what}`);
      };
      const box: { third: request.Response | null; b: request.Response | null } = { third: null, b: null };
      const pending: Promise<request.Response>[] = [];
      const locker = await observer.connect();
      try {
        await locker.query('BEGIN');
        // The pool's 15 s idle-in-transaction timeout would end the lock while the test waits on state.
        await locker.query('SET LOCAL idle_in_transaction_session_timeout = 0');
        await locker.query('LOCK TABLE contact IN ACCESS EXCLUSIVE MODE');
        pending.push(duplicates(u1, PROGRAMME_A1).then((r) => r));
        pending.push(duplicates(u2, PROGRAMME_A1).then((r) => r));
        await waitFor(async () => (await lockWaiters()) >= 2, 'two tenant-A scans in flight');
        pending.push(duplicates(u3, PROGRAMME_A1).then((r) => {
          box.third = r;
          return r;
        }));
        await waitFor(async () => box.third !== null || (await lockWaiters()) >= 3, 'the third answered, or joined the scans');
        expect(box.third, 'the third scan was admitted and queued behind the two, not refused').not.toBeNull();
        const third = must(box.third, 'third');
        expectError(third, 429, 'too_many_requests', 'the third concurrent scan');
        const retryAfter = Number(third.headers['retry-after']);
        expect(Number.isInteger(retryAfter) && retryAfter >= 1, `Retry-After ${String(third.headers['retry-after'])}`).toBe(true);
        // Another tenant is not capped by tenant A's scans: it is admitted, and queues on the lock.
        pending.push(duplicates(tenantB, PROGRAMME_B1).then((r) => {
          box.b = r;
          return r;
        }));
        await waitFor(async () => box.b !== null || (await lockWaiters()) >= 3, 'tenant B answered, or joined the scans');
        expect(box.b, `tenant B was refused: ${box.b?.text ?? ''}`).toBeNull();
      } finally {
        await locker.query('ROLLBACK').catch(() => undefined);
        locker.release();
      }
      const [r1, r2, , rB] = await Promise.all(pending);
      for (const [label, response] of [['first', r1], ['second', r2], ['tenant B', rB]] as const) {
        okBody(must(response, label), 200, 'listDuplicates', `${label}, once the lock is gone`);
      }
      okBody(await duplicates(await freshUser([[PROGRAMME_A1, 'admin']]), PROGRAMME_A1), 200, 'listDuplicates', 'the slots are released');
    }, 120_000);
  });

  // =========================================================================
  // 9. Latency at the 120k seed (D-L146; M8)
  // =========================================================================

  describe('latency at 120,000 contacts', () => {
    const COUNT = 120_000;
    const CHUNK = 10_000;
    const BUDGET_MS = 150;
    /** Every 100th contact shares a number with its neighbour; every 250th an email. */
    const SEED_SQL = `
      INSERT INTO contact (id, tenant_id, programme_id, display_name, phones, emails, created_at, updated_at)
      SELECT ('11111111-0095-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
             $1::uuid,
             CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
             substr(md5('n' || i), 1, 10),
             jsonb_build_array(jsonb_build_object('type', 'mobile', 'e164',
               '+23481' || lpad((CASE WHEN i % 100 IN (1, 3) THEN i - (i % 100) ELSE i END)::text, 9, '0'))),
             jsonb_build_array(CASE WHEN i % 250 IN (2, 4) THEN 'zq.dup' || (i - (i % 250)) || '@example.test'
                                    ELSE 'zq.' || i || '@example.test' END),
             timestamptz '2025-01-01 00:00:00+00' + make_interval(secs => i),
             timestamptz '2025-06-01 00:00:00+00' + make_interval(secs => i)
        FROM generate_series($4::int, $5::int) AS i`;

    it(`a first page and a deep page of one programme’s sets each answer within ${BUDGET_MS} ms (best of three), and the walk finds every planted set`, async () => {
      const t0 = performance.now();
      for (let from = 1; from <= COUNT; from += CHUNK) {
        await observer.query(SEED_SQL, [TENANT_A, PROGRAMME_A2, PROGRAMME_A1, from, Math.min(from + CHUNK - 1, COUNT)]);
      }
      await observer.query('ANALYZE contact');
      process.stdout.write(`contact-merge latency: seeded in ${Math.round(performance.now() - t0)} ms\n`);
      // i % 100 in (1, 3): odd i, so A1; one phone pair per hundred -> 1,200 pairs in A1.
      // i % 250 in (2, 4): even i, so A2; one email pair per 250 -> 480 pairs in A2.
      // LEAD EDIT (T-0095, D-L163): the walks and the timing each get a user of their own, so no
      // timed call is a 1.8 ms 429; every timed call must be a 200 before its time counts.
      const walkerA1 = await freshUser([[PROGRAMME_A1, 'admin']]);
      const walkerA2 = await freshUser([[PROGRAMME_A2, 'admin']]);
      const timer = await freshUser([[PROGRAMME_A1, 'admin']]);
      const walk = async (programmeId: string, headers: Headers) => {
        const keys: string[] = [];
        let cursor: string | null = null;
        let deep: string | null = null;
        for (let guard = 0; guard < 40; guard += 1) {
          const params: [string, string][] = [['limit', '100']];
          if (cursor !== null) params.push(['cursor', cursor]);
          const page = okBody(await duplicates(headers, programmeId, params), 200, 'listDuplicates', `walk ${guard}`);
          keys.push(...setKeys(page));
          cursor = page.nextCursor as string | null;
          if (guard === 5) deep = cursor;
          if (cursor === null) break;
        }
        return { keys, deep };
      };
      const a1 = await walk(PROGRAMME_A1, walkerA1);
      const plantedA1 = (A1_SETS.length) + 1_200;
      expect(new Set(a1.keys).size, 'each set once').toBe(a1.keys.length);
      expect(a1.keys.length, 'every planted A1 set').toBe(plantedA1);
      const a2 = await walk(PROGRAMME_A2, walkerA2);
      expect(a2.keys.length, 'every planted A2 set').toBe(A2_SETS.length + 480);
      const deep = must(a1.deep, 'a deep cursor');
      const timedOk = async (call: () => Promise<request.Response>, label: string): Promise<number> => {
        let best = Number.POSITIVE_INFINITY;
        for (let i = 0; i < 3; i += 1) {
          const t1 = performance.now();
          const response = await call();
          const ms = performance.now() - t1;
          expect(response.status, `${label} round ${i + 1}: ${response.text.slice(0, 200)}`).toBe(200);
          best = Math.min(best, ms);
        }
        return best;
      };
      okBody(await duplicates(timer, PROGRAMME_A1, [['limit', '25']]), 200, 'listDuplicates', 'warm-up');
      const first = await timedOk(() => duplicates(timer, PROGRAMME_A1, [['limit', '25']]), 'first page');
      const deepMs = await timedOk(() => duplicates(timer, PROGRAMME_A1, [['limit', '25'], ['cursor', deep]]), 'deep page');
      process.stdout.write(`contact-merge latency: first ${first.toFixed(1)} ms, deep ${deepMs.toFixed(1)} ms\n`);
      expect(first, 'first page ms').toBeLessThanOrEqual(BUDGET_MS);
      expect(deepMs, 'deep page ms').toBeLessThanOrEqual(BUDGET_MS);
    }, 240_000);
  });
});
