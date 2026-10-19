import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  PROGRAMME_A2,
  SEED_PERMISSION_SETS,
  TENANT_A,
  USER_A_SUPERVISOR,
} from '@kasuwa/db';
import { reseed } from '@kasuwa/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { parse } from 'yaml';
import { asUser, withAuthDatabase } from '../support/api';
import { collectTelemetry, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0124, `displayName` follows its name parts everywhere
 * (D-L68), the contacts list `q`, and R21 on the contact and lead lists.
 * Owner: Agent 3 (API), the lead (contract, a breaking edit). Written by QA
 * (Agent 12) for the lead before the build (D-L23, D-L25), from the task
 * file, D-L68, D-L133 (T-0085 R8, R21 and its open item), D-L135, D-L175 C9,
 * D-L176 and the published contract. The endpoint list comes from the
 * contract and from grepping the API for displayName; the assertions come
 * from the rule, not from the code. Contract half:
 * tests/acceptance/platform/records-contract-display-name.acceptance.test.ts.
 *
 * Fixtures: packages/db/src/fixtures.ts (tenant A, its two programmes, the
 * seeded permission sets and the supervisor, who is `admin` and tenant admin)
 * plus rows planted here by `kasuwa_migrator` (BYPASSRLS, never serves), ids
 * in this suite's range `11111111-0000-4000-8000-0124xxxxxxxx`. Every user a
 * behaviour test acts as is planted fresh, so no throttle window or grant is
 * shared; the suite reseeds after each behaviour test. Every planted name is
 * synthetic (a `Zq…` marker, Sample, Fixture, Example). Every phone number is
 * a PLACEHOLDER: Nigeria has no fictional range.
 *
 * ==========================================================================
 * RULINGS (I1–I17; the lead's to accept, reversible)
 * ==========================================================================
 * I1  THE RULE. A contact's (and a lead's) `displayName` is readable by a
 *     caller exactly when BOTH `givenNames` and `familyName` are readable
 *     (`read` or `edit`) for that caller in THAT record's programme. Either
 *     part at `none` withholds it, whatever the part's value: a NULL part
 *     that is withheld still withholds it. It is never composed from the
 *     readable part. `displayName` has no field_def and no grant of its own.
 *     The tenant-admin flag never lifts it (D-L63); a membership with no set
 *     gets the least any unlocked set gets, so a part withheld from an
 *     unlocked set withholds the name from a set-less member too.
 * I2  RECORD SHAPES. Wherever a whole Contact is answered (listContacts,
 *     getContact, listLeads, listAccountContacts, updateContact,
 *     convertContact's `contact`, getContactMergePreview's `survivor` and
 *     `merged`) and on search hits, a withheld `displayName` is OMITTED and
 *     listed in `withheldFields`, never `null`.
 * I3  SUMMARY SHAPES. Where a closed `{ id, displayName }` names a contact
 *     inside another answer, a withheld `displayName` is `null`, the id still
 *     served, judged by CONTACT field security in the contact's programme:
 *     `contact` on every Deal answer (getDeal, listDeals, getPipelineBoard,
 *     createDeal, updateDeal, moveDeal), `contact` on MyActivity
 *     (listMyActivities, listCalendar), DuplicateContact (listDuplicates),
 *     ContactMergeParty (createContactMerge, listContactMerges) and
 *     Notification.objectDisplayName. SILENT in the task file (it names the
 *     Contact and lead shapes only); ruled so because a closed summary has
 *     no `withheldFields`, and D-L175 C9 already settled two summaries this
 *     way.
 * I4  CONFLICT, ruled per the task file: D-L175 C9 says `Contact.displayName`
 *     is "never withheld". The task makes it withholdable, so that half of C9
 *     is superseded; its other half (the two nullable summaries) stands and
 *     becomes I3. Flagged for the lead.
 * I5  SORT. `displayName` and `-displayName` leave the sort enums of
 *     listContacts, listLeads and listAccountContacts; `sort=displayName` is
 *     `400 validation_failed` for EVERY caller, one who reads every name
 *     included (the detail code is the builder's). listAccountContacts'
 *     default is `displayName` today; it moves to a key in the enum, and its
 *     default order must not depend on any contact's `displayName` (which
 *     key it moves to is the lead's; not pinned).
 * I6  CURSORS (D-L80). No `nextCursor` those three lists issue carries a
 *     `displayName`, under any sort the contract offers, for any caller.
 *     T-0084 already made these cursors id-only, so this is a guard; it is
 *     here because removing the sort is when someone re-plumbs the keyset.
 * I7  `q` (listContacts, listLeads) matches `displayName` only where it is
 *     readable, row by row in the row's own programme. A row reachable only
 *     through a withheld `displayName` is absent: no oracle by filtering. A
 *     readable part still matches (`givenNames` when only `familyName` is
 *     withheld), and that row carries no `displayName`. listLeads keeps its
 *     `companyName` matching under its own field security (unchanged; not
 *     re-pinned here).
 * I8  `q` LIMITS stay 1 to 100 characters. SILENT; conservative is no
 *     widening. NO THROTTLE: the task sets none, and once `q` matches only
 *     readable fields it is no oracle needing one. Not pinned; flagged.
 * I9  R21 (D-L133's open item, folded into T-0124; the rule D-L135 states):
 *     after NFKC, a `q` holding `@`, or a run of 6 or more `\p{Nd}` digits
 *     once everything that is neither a letter nor a digit is removed, is
 *     `400 validation_failed` with `details[].code: identifier_in_url` at
 *     `q`, on listContacts and listLeads. So `q` never matches a phone or an
 *     email; clients send those to lookupRecords. The refused value is never
 *     echoed and reaches no log line or span, in any form.
 * I10 listAccounts' and listDeals' `q` (name only) are NOT brought under
 *     R21 here. SILENT: D-L133 names only the contact and lead lists.
 * I11 WRITES. A withheld `displayName` is not editable (the contract: "each
 *     field sent needs edit under field security"; "a caller cannot clear a
 *     field they cannot read"). updateContact sending `displayName` from a
 *     caller it is withheld from is `403 not_permitted`, `field_not_editable`
 *     at `displayName`, and writes nothing. getContactMergePreview's
 *     `defaults` never name it for that caller, and createContactMerge
 *     choosing it is `403 field_not_editable` at `choices.displayName`.
 *     NOT pinned (SILENT, flagged): createContact and imports (displayName
 *     is required on create, so a ruling would bar such a caller from
 *     creating contacts at all, a product call); whether a `read` part makes
 *     `displayName` read-only.
 * I12 TIMELINE. A `field_changed` item naming `displayName` follows
 *     `displayName`: omitted when withheld, as an item naming `ownerUserId`
 *     follows `ownerUserId`. SILENT; ruled from listContactTimeline's own
 *     omission rule.
 * I13 SCRIPTING (not in the task file; found by grepping the API: scripts
 *     treat `contact.displayName` as never withheld). AMENDED BY D-L180:
 *     - DISPLAY stays allowed. Publishing `{contact.displayName}` is never
 *       blocked by this rule. When the name is withheld from the running
 *       agent, no run answer carries it; the wording keeps the token, the
 *       agent's getContact omits and lists `displayName`, and the client
 *       draws a neutral translated stand-in whose message id the scripting
 *       contract names (`x-kasuwa-withheld-name-message-id`, pinned in the
 *       contract half). The drawn DOM belongs to a p10-agent journey.
 *     - BRANCHING stays refused. Publishing a branch on `displayName` is
 *       `409 script_invalid` `branch_on_withheld_field` when any set holding
 *       `script.run` cannot read a name part; a run whose branch reads a
 *       withheld `displayName` stops with `field_withheld` at the branch and
 *       never takes either side. A `read` part blocks nothing.
 * I14 AUDIT (D-L176). No audit event about a contact carries its
 *     `displayName` or a name part in `object_label` or `changes`. Guard.
 * I15 OUT OF SCOPE, by the contract: user names (owner, actor, checker,
 *     NotificationActor) follow D-P23 and D-L81, not contact field security;
 *     account and deal `name` are never withheld; an activity's `subject` is
 *     withheld by its own field; import reports carry no cell value (D-L128
 *     Q6); createActivity and updateActivity answer `contactId` only.
 * I16 GUARDS. Search (T-0085/T-0086 R8) and notifications (T-0100) already
 *     follow the rule. Their rows stay in the table as guards that pass on
 *     main, so a regression is caught.
 * I17 THE TABLE. One row per operation that answers a contact's
 *     `displayName`. A future operation that names a contact is added as a
 *     row; the contract half's classification sweep fails on any new schema
 *     with a `displayName` until it is ruled on.
 *
 * Existing pins that contradict these rulings and must be re-pinned as lead
 * edits when the contract lands (the task file says so): sort=displayName
 * and number-in-q cases in contacts-api, leads-api, accounts-api,
 * list-indexes and contact-merge; contact-merge's "typeof displayName is
 * string" for DuplicateContact; e2e p04-leads. This file edits none of them.
 *
 * D-L23: on main, `displayName` is served to everyone who reads the row, it
 * is matched by `q`, it sorts, `q` takes a phone, and scripts read it as
 * never withheld. Every test fails on main for that reason except those
 * titled "(guard, passes on main)" and "(self-check)".
 */

// ---------------------------------------------------------------------------
// Paths, ids, markers.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../../..');
const SPEC_PATH = resolve(REPO_ROOT, 'docs/api/records.openapi.yaml');

const CONTACTS = '/api/v1/contacts';
const LEADS = '/api/v1/leads';
const MERGES = '/api/v1/contact-merges';
const SCRIPTS = '/api/v1/scripts';
const RUNS = '/api/v1/script-runs';

const id124 = (tail: string) => `11111111-0000-4000-8000-0124${tail.padStart(8, '0')}`;
let plantCounter = 0;
/** c contact, a account, d deal, e user, b activity. Never reset during the run. */
const nextId = (kind: 'c' | 'a' | 'd' | 'e' | 'b') =>
  id124(`${kind}${(plantCounter += 1).toString(16).padStart(7, '0')}`);

let tagCounter = 0;
/** Four lower-case letters, unique in the run: no digit ever reaches a `q` (R21). */
function nextTag(): string {
  let n = (tagCounter += 1) + 26 ** 3;
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

let phoneCounter = 0;
/** A placeholder E.164 number in this suite's own block. */
const nextPhone = () => `+234803124${String((phoneCounter += 1)).padStart(4, '0')}`;

type Headers = Record<string, string>;
type Json = Record<string, unknown>;
type Params = readonly (readonly [string, string])[];

const SUPERVISOR = asUser(TENANT_A, USER_A_SUPERVISOR);

function must<T>(value: T | null | undefined, what: string): T {
  if (value === undefined || value === null) throw new Error(`Fixture drift: ${what}`);
  return value;
}

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function permissionSet(key: string): string {
  return must(
    SEED_PERMISSION_SETS.find((set) => set.tenantId === TENANT_A && set.key === key),
    `no seeded permission set '${key}' in tenant A`,
  ).id;
}

// ---------------------------------------------------------------------------
// R21's identifier rule, as records-contract-search pins it (D-L135).
// ---------------------------------------------------------------------------

function looksLikeIdentifier(q: string): boolean {
  const text = q.normalize('NFKC');
  return text.includes('@') || /\p{Nd}{6,}/u.test(text.replace(/[^\p{L}\p{Nd}]/gu, ''));
}

const IDENTIFIER_QS = [
  '08031234567',
  '+2348031234567',
  '+234 803 123 4567',
  '0803 123 4567',
  '(0803) 123-4567',
  '0803.123.4567',
  '234-803-123-4567',
  '123456',
  'Sample 080312',
  'sample@example.test',
  'a@b',
  '@sample',
  '0803/123/4567',
  '0803_123_4567',
  '0803,123,4567',
  '0803–123–4567',
  '٠٨٠٣١٢٣٤٥٦٧',
  'Sample\t080 312 45',
  // Full-width forms, and digits only the server's NFKC step maps to ASCII.
  '０８０３１２３４５６７',
  'sample＠example.test',
  'Sample ¹²³⁴⁵⁶',
  '①②③④⑤⑥',
];
const NAME_QS = [
  'Sample',
  'Sámple Fixture',
  'Sample 2026',
  'Unit 12 Block 3456',
  'Sample 12345',
  '50% Sample',
  'Sample (Lagos) Ltd',
  'Fixture-12.34',
];

// ---------------------------------------------------------------------------
// The contract's sort enums, read from the YAML (I5, I6): the suite judges
// every sort the contract offers, whatever it offers when the suite runs.
// ---------------------------------------------------------------------------

let specCache: Json | undefined;
function spec(): Json {
  specCache ??= parse(readFileSync(SPEC_PATH, 'utf8')) as Json;
  return specCache;
}

function sortValuesOf(path: string): string[] {
  const item = (spec().paths as Json)[path] as Json | undefined;
  const params = ((item?.get as Json | undefined)?.parameters ?? []) as Json[];
  const sort = params.find((p) => p.name === 'sort');
  const values = ((sort?.schema as Json | undefined)?.enum ?? []) as unknown[];
  return values.filter((value): value is string => typeof value === 'string');
}

// ---------------------------------------------------------------------------
// The judge: what the rule says about one answer, for one caller.
// ---------------------------------------------------------------------------

/** A contact this suite planted, with the markers that must never leak. */
interface Named {
  id: string;
  displayName: string;
  givenNames: string | null;
  familyName: string | null;
  /** Lower-case: the displayName's own marker and the familyName marker. */
  secrets: string[];
  /** Lower-case: the displayName marker, which a reader of names must see. */
  shown: string;
}

type Shape = 'record' | 'summary' | 'notification';
type Mode = 'readable' | 'withheld';

/** Every `nextCursor` and `cursor` string in an answer, base64url-decoded. */
function decodedCursors(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => decodedCursors(item, out));
  else if (isJson(value)) {
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'nextCursor' || key === 'cursor') && typeof item === 'string') {
        out.push(Buffer.from(item, 'base64url').toString('utf8'));
      } else decodedCursors(item, out);
    }
  }
  return out;
}

/** Every object in an answer that names the contact `id` (by `objectId` for a notification). */
function holdersOf(value: unknown, id: string, shape: Shape, out: Json[] = []): Json[] {
  if (Array.isArray(value)) value.forEach((item) => holdersOf(item, id, shape, out));
  else if (isJson(value)) {
    if (shape === 'notification' ? value.objectId === id : value.id === id) out.push(value);
    for (const item of Object.values(value)) holdersOf(item, id, shape, out);
  }
  return out;
}

/** The text of an answer plus its decoded cursors, lower-cased: where a secret must not be. */
function haystackOf(text: string, body: unknown): string {
  return [text, ...decodedCursors(body)].join('\n').toLowerCase();
}

/** Everything wrong with one answer under I1–I3; empty when right. */
function judge(
  shape: Shape,
  mode: Mode,
  status: number,
  text: string,
  body: unknown,
  named: readonly Named[],
): string[] {
  const problems: string[] = [];
  if (status < 200 || status > 299)
    return [`expected a 2xx answer, got ${status} ${text.slice(0, 300)}`];
  const hay = haystackOf(text, body);
  for (const contact of named) {
    const holders = holdersOf(body, contact.id, shape);
    if (holders.length === 0)
      problems.push(`${contact.id} is not in the answer at all, so nothing was judged`);
    for (const holder of holders) {
      if (shape === 'record') {
        const withheld = Array.isArray(holder.withheldFields)
          ? (holder.withheldFields as unknown[])
          : null;
        if (withheld === null) {
          problems.push(`${contact.id}: a record without withheldFields`);
          continue;
        }
        if (mode === 'readable') {
          if (typeof holder.displayName !== 'string' || holder.displayName === '')
            problems.push(`${contact.id}: no displayName for a reader of both parts`);
          if (withheld.includes('displayName'))
            problems.push(
              `${contact.id}: displayName listed as withheld for a reader of both parts`,
            );
        } else {
          if ('displayName' in holder)
            problems.push(
              `${contact.id}: displayName ${JSON.stringify(holder.displayName)} sent to a caller a name part is withheld from (I2: omit it)`,
            );
          if (!withheld.includes('displayName'))
            problems.push(`${contact.id}: displayName not listed in withheldFields (I2)`);
        }
      } else {
        const key = shape === 'notification' ? 'objectDisplayName' : 'displayName';
        if (!(key in holder))
          problems.push(`${contact.id}: the summary has no ${key} (I3: always present)`);
        else if (mode === 'readable') {
          if (typeof holder[key] !== 'string' || holder[key] === '')
            problems.push(
              `${contact.id}: ${key} is ${JSON.stringify(holder[key])} for a reader of both parts`,
            );
        } else if (holder[key] !== null) {
          problems.push(
            `${contact.id}: ${key} ${JSON.stringify(holder[key])} sent to a caller a name part is withheld from (I3: null)`,
          );
        }
      }
    }
    if (mode === 'readable' && !hay.includes(contact.shown)) {
      problems.push(
        `${contact.id}: the name marker is nowhere in a reader's answer, so the withheld check would be vacuous`,
      );
    }
    if (mode === 'withheld') {
      for (const secret of contact.secrets) {
        if (hay.includes(secret))
          problems.push(`${contact.id}: "${secret}" appears in the answer or a decoded cursor`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Log capture (the search-api approach: every channel the process writes to).
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

/** Every form a value takes once it has passed through a URL. */
function formsOf(value: string): string[] {
  return [
    ...new Set([
      value,
      value.toLowerCase(),
      encodeURIComponent(value),
      new URLSearchParams([['x', value]]).toString().slice(2),
    ]),
  ];
}

// ===========================================================================

describe('acceptance: displayName follows its name parts everywhere, list q and R21 (T-0124)', () => {
  let app: INestApplication;
  /** kasuwa_migrator: BYPASSRLS. Plants rows and observes them; never serves. */
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await observer?.end();
    await reseed(inject('migrationUrl'));
  }, 120_000);

  const server = () => app.getHttpServer();

  // --- HTTP ----------------------------------------------------------------

  const withQuery = (path: string, params: Params) => {
    const query = new URLSearchParams(params.map(([k, v]): [string, string] => [k, v])).toString();
    return query === '' ? path : `${path}?${query}`;
  };
  const get = (headers: Headers, path: string, params: Params = []) =>
    request(server()).get(withQuery(path, params)).set(headers);
  const post = (headers: Headers, path: string, body: unknown) =>
    request(server())
      .post(path)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
  const patch = (headers: Headers, path: string, body: unknown) =>
    request(server())
      .patch(path)
      .set(headers)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));

  function expectStatus(response: request.Response, status: number, where: string): void {
    expect(
      response.status,
      `${where}: expected ${status}, got ${response.status} ${response.text.slice(0, 400)}`,
    ).toBe(status);
  }

  function details(response: request.Response): { path: string; code: string }[] {
    const body = response.body as Json;
    return (Array.isArray(body.details) ? (body.details as Json[]) : []).map((d) => ({
      path: String(d.path),
      code: String(d.code),
    }));
  }

  // --- planting (kasuwa_migrator) -------------------------------------------

  interface UserPlant {
    id: string;
    headers: Headers;
  }

  /** A user nobody else uses: `[programme, set key | null]` memberships (null is a membership with no set). */
  async function freshUser(
    memberships: readonly (readonly [string, string | null])[],
    tenantAdmin = false,
  ): Promise<UserPlant> {
    const id = nextId('e');
    await observer.query(
      `INSERT INTO "user" (id, tenant_id, email, display_name, is_tenant_admin) VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        TENANT_A,
        `t0124.${id.slice(-8)}@example.test`,
        `T-0124 Fixture User ${id.slice(-4)}`,
        tenantAdmin,
      ],
    );
    for (const [programmeId, set] of memberships) {
      await observer.query(
        `INSERT INTO user_programme (user_id, programme_id, tenant_id, permission_set_id) VALUES ($1, $2, $3, $4)`,
        [id, programmeId, TENANT_A, set === null ? null : permissionSet(set)],
      );
    }
    return { id, headers: asUser(TENANT_A, id) };
  }

  /** The callers every table row compares: identical but for the set, and only `team_lead` is locked. */
  const openCaller = (tenantAdmin = false) =>
    freshUser([[PROGRAMME_A1, 'programme_manager']], tenantAdmin);
  const hiddenCaller = (tenantAdmin = false) =>
    freshUser([[PROGRAMME_A1, 'team_lead']], tenantAdmin);

  /** One field-security decision on a STANDARD contact field in tenant A (the leads-api helper). */
  async function lockField(
    field: string,
    setKey: string,
    level: 'none' | 'read' | 'edit',
  ): Promise<void> {
    const found = await observer.query<{ id: string }>(
      `SELECT f.id FROM field_def f
         JOIN object_def o ON o.id = f.object_id AND o.tenant_id = f.tenant_id
        WHERE f.tenant_id = $1 AND o.api_name = 'contact' AND f.api_name = $2
          AND NOT o.is_custom AND NOT f.is_custom`,
      [TENANT_A, field],
    );
    const fieldId = must(found.rows[0]?.id, `tenant A has no standard field_def contact.${field}`);
    await observer.query(
      `INSERT INTO field_security_grant (tenant_id, field_id, permission_set_id, level) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, field_id, permission_set_id) DO UPDATE SET level = EXCLUDED.level`,
      [TENANT_A, fieldId, permissionSet(setKey), level],
    );
  }

  /** The lock every table row runs under: familyName withheld from `team_lead` only. */
  const lockFamilyFromTeamLead = () => lockField('family_name', 'team_lead', 'none');

  interface NamedOptions {
    programme?: string;
    status?: string | null;
    accountId?: string | null;
    phones?: readonly string[];
    emails?: readonly string[];
    familyName?: string | null;
    /** A displayName marker shared by several rows (q tests); otherwise each gets its own. */
    displayMarker?: string;
  }

  /**
   * A contact whose displayName shares nothing with its parts: `Zqdn<tag>
   * Sample`, given `Zqgn<tag>`, family `Zqfn<tag>`. So the displayName marker
   * and the familyName marker are secrets for a caller missing a part, while
   * the givenNames marker may be shown.
   */
  async function plantNamed(options: NamedOptions = {}): Promise<Named> {
    const tag = nextTag();
    const id = nextId('c');
    const dn = options.displayMarker ?? `Zqdn${tag}`;
    const displayName = `${dn} Sample`;
    const givenNames = `Zqgn${tag}`;
    const familyName = options.familyName === undefined ? `Zqfn${tag}` : options.familyName;
    await observer.query(
      `INSERT INTO contact (id, tenant_id, programme_id, display_name, given_names, family_name,
                            status, account_id, phones, emails)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
      [
        id,
        TENANT_A,
        options.programme ?? PROGRAMME_A1,
        displayName,
        givenNames,
        familyName,
        options.status ?? null,
        options.accountId ?? null,
        JSON.stringify((options.phones ?? []).map((e164) => ({ type: 'mobile', e164 }))),
        JSON.stringify(options.emails ?? []),
      ],
    );
    const secrets = [dn.toLowerCase(), ...(familyName === null ? [] : [familyName.toLowerCase()])];
    return { id, displayName, givenNames, familyName, secrets, shown: dn.toLowerCase() };
  }

  /**
   * Two contacts in one programme sharing a phone: a duplicate set, and a
   * mergeable pair. They share one displayName, because a merge's default
   * gives the survivor the newer side's name: either way the survivor's name
   * carries the marker a reader must see and a withheld caller must not.
   */
  async function plantPair(programme = PROGRAMME_A1): Promise<[Named, Named]> {
    const phone = nextPhone();
    const displayMarker = `Zqdn${nextTag()}`;
    return [
      await plantNamed({ programme, phones: [phone], displayMarker }),
      await plantNamed({ programme, phones: [phone], displayMarker }),
    ];
  }

  async function plantAccount(programme: string, name: string): Promise<string> {
    const id = nextId('a');
    await observer.query(
      'INSERT INTO account (id, tenant_id, programme_id, name) VALUES ($1, $2, $3, $4)',
      [id, TENANT_A, programme, name],
    );
    return id;
  }

  async function versionOf(table: 'contact' | 'deal', id: string): Promise<number> {
    const result = await observer.query<{ version: number }>(
      `SELECT version FROM ${table} WHERE id = $1`,
      [id],
    );
    return must(result.rows[0]?.version, `${table} ${id} has no version`);
  }

  /** The first open stage of A1's first pipeline, and an open stage it may move to with no requirement. */
  async function pipelineA1(): Promise<{ pipeline: string; stage: string; target: string }> {
    const first = await observer.query<{ pipeline: string; stage: string }>(
      `SELECT p.id AS pipeline, s.id AS stage
         FROM pipeline p
         JOIN pipeline_stage s ON s.tenant_id = p.tenant_id AND s.programme_id = p.programme_id AND s.pipeline_id = p.id
        WHERE p.tenant_id = $1 AND p.programme_id = $2 AND s.kind = 'open'
        ORDER BY p.created_at, p.id, s.position
        LIMIT 1`,
      [TENANT_A, PROGRAMME_A1],
    );
    const { pipeline, stage } = must(first.rows[0], 'no pipeline with an open stage in A1');
    const next = await observer.query<{ target: string }>(
      `SELECT t.to_stage_id AS target
         FROM pipeline_stage_transition t
         JOIN pipeline_stage s ON s.id = t.to_stage_id AND s.tenant_id = t.tenant_id
        WHERE t.tenant_id = $1 AND t.pipeline_id = $2 AND t.from_stage_id = $3 AND s.kind = 'open'
          AND NOT EXISTS (SELECT 1 FROM pipeline_stage_requirement r WHERE r.tenant_id = t.tenant_id AND r.stage_id = t.to_stage_id)
        ORDER BY s.position
        LIMIT 1`,
      [TENANT_A, pipeline, stage],
    );
    return {
      pipeline,
      stage,
      target: must(next.rows[0]?.target, 'no requirement-free open move from the first stage'),
    };
  }

  async function plantDeal(
    primaryContactId: string,
  ): Promise<{ deal: string; pipeline: string; target: string }> {
    const id = nextId('d');
    const { pipeline, stage, target } = await pipelineA1();
    await observer.query(
      `INSERT INTO deal (id, tenant_id, programme_id, pipeline_id, stage_id, name, primary_contact_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, TENANT_A, PROGRAMME_A1, pipeline, stage, 'Zqdeal Fixture renewal', primaryContactId],
    );
    return { deal: id, pipeline, target };
  }

  async function plantTask(
    owner: string,
    contactId: string,
    dueAt: string | null,
  ): Promise<string> {
    const id = nextId('b');
    await observer.query(
      `INSERT INTO activity (id, tenant_id, programme_id, type, subject, due_at, owner_user_id, created_by_user_id, contact_id)
       VALUES ($1, $2, $3, 'task', 'Fixture follow-up', $4, $5, $5, $6)`,
      [id, TENANT_A, PROGRAMME_A1, dueAt, owner, contactId],
    );
    return id;
  }

  async function plantNotification(recipient: string, contactId: string): Promise<void> {
    await observer.query(
      `INSERT INTO notification (id, tenant_id, programme_id, recipient_user_id, kind, object_type, object_id, actor_user_id, source_event_id)
       VALUES ($1, $2, $3, $4, 'record_assigned', 'contact', $5, $6, $7)`,
      [randomUUID(), TENANT_A, PROGRAMME_A1, recipient, contactId, USER_A_SUPERVISOR, randomUUID()],
    );
  }

  async function mergeBySupervisor(survivor: Named, merged: Named): Promise<request.Response> {
    return post(SUPERVISOR, MERGES, {
      survivorId: survivor.id,
      mergedId: merged.id,
      survivorVersion: await versionOf('contact', survivor.id),
      mergedVersion: await versionOf('contact', merged.id),
    });
  }

  // =========================================================================
  // 0. Self-checks: this file's own judge, shown refusing planted defects.
  // =========================================================================

  describe('(self-check) the judge', () => {
    const named: Named = {
      id: id124('c0000fff'),
      displayName: 'Zqdnself Sample',
      givenNames: 'Zqgnself',
      familyName: 'Zqfnself',
      secrets: ['zqdnself', 'zqfnself'],
      shown: 'zqdnself',
    };
    const judgeBody = (shape: Shape, mode: Mode, body: unknown) =>
      judge(shape, mode, 200, JSON.stringify(body), body, [named]);

    it('(self-check) passes a right record and refuses a sent, a nulled and an unlisted displayName, a leaked secret and a missing row', () => {
      const withheld = {
        id: named.id,
        givenNames: 'Zqgnself',
        withheldFields: ['displayName', 'familyName'],
      };
      expect(judgeBody('record', 'withheld', { data: [withheld] })).toEqual([]);
      expect(
        judgeBody('record', 'readable', {
          data: [{ id: named.id, displayName: named.displayName, withheldFields: [] }],
        }),
      ).toEqual([]);
      const defects: [string, unknown][] = [
        ['sent', { data: [{ ...withheld, displayName: named.displayName }] }],
        ['nulled', { data: [{ ...withheld, displayName: null }] }],
        ['unlisted', { data: [{ id: named.id, withheldFields: ['familyName'] }] }],
        ['composed into another key', { data: [{ ...withheld, label: 'Zqdnself Sample' }] }],
        [
          'a family name in a cursor',
          { data: [withheld], nextCursor: Buffer.from('{"n":"Zqfnself"}').toString('base64url') },
        ],
        ['missing row', { data: [] }],
      ];
      for (const [label, body] of defects)
        expect(judgeBody('record', 'withheld', body).length, label).toBeGreaterThan(0);
      expect(
        judgeBody('record', 'readable', {
          data: [{ id: named.id, displayName: 'Other', withheldFields: [] }],
        }).length,
        'a reader whose answer lacks the marker',
      ).toBeGreaterThan(0);
    });

    it('(self-check) a summary must carry null when withheld, and a notification its objectDisplayName', () => {
      expect(
        judgeBody('summary', 'withheld', { contact: { id: named.id, displayName: null } }),
      ).toEqual([]);
      expect(
        judgeBody('summary', 'withheld', {
          contact: { id: named.id, displayName: 'Zqdnself Sample' },
        }).length,
      ).toBeGreaterThan(0);
      expect(
        judgeBody('summary', 'withheld', { contact: { id: named.id } }).length,
        'omitted from a summary',
      ).toBeGreaterThan(0);
      expect(
        judgeBody('notification', 'withheld', {
          data: [{ id: 'n', objectId: named.id, objectDisplayName: null }],
        }),
      ).toEqual([]);
      expect(
        judgeBody('notification', 'withheld', {
          data: [{ id: 'n', objectId: named.id, objectDisplayName: 'Zqdnself Sample' }],
        }).length,
      ).toBeGreaterThan(0);
      expect(
        judge('summary', 'withheld', 500, 'boom', {}, [named]).length,
        'a 500 is never a pass',
      ).toBeGreaterThan(0);
    });

    it('(self-check) tags never carry a digit, so no planted q is an identifier', () => {
      const tags = Array.from({ length: 50 }, () => nextTag());
      for (const tag of tags) {
        expect(tag).toMatch(/^[a-z]{4}$/);
        expect(looksLikeIdentifier(`Zqdn${tag}`)).toBe(false);
      }
      expect(new Set(tags).size).toBe(tags.length);
      for (const q of IDENTIFIER_QS) expect(looksLikeIdentifier(q), q).toBe(true);
      for (const q of NAME_QS) expect(looksLikeIdentifier(q), q).toBe(false);
    });
  });

  // =========================================================================
  // 1. The table: every operation that answers a contact's displayName
  //    (I2, I3, I16, I17). Add a row for the next one.
  // =========================================================================

  interface Outcome {
    response: request.Response;
    named: Named[];
  }

  interface Row {
    op: string;
    shape: Shape;
    status: 200 | 201;
    /** Callers need the tenant-admin flag for this action (contact.write, merges). */
    tenantAdmin?: true;
    /** Why this row passes on main (I16). */
    guard?: string;
    run: (caller: UserPlant) => Promise<Outcome>;
  }

  const ROWS: Row[] = [
    {
      op: 'listContacts',
      shape: 'record',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed();
        return { response: await get(caller.headers, CONTACTS, [['limit', '100']]), named: [c] };
      },
    },
    {
      op: 'getContact',
      shape: 'record',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed();
        return { response: await get(caller.headers, `${CONTACTS}/${c.id}`), named: [c] };
      },
    },
    {
      op: 'listLeads',
      shape: 'record',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed({ status: 'new' });
        return { response: await get(caller.headers, LEADS, [['limit', '100']]), named: [c] };
      },
    },
    {
      op: 'listAccountContacts',
      shape: 'record',
      status: 200,
      run: async (caller) => {
        const account = await plantAccount(PROGRAMME_A1, 'Zqaccount Holdings');
        const c = await plantNamed({ accountId: account });
        return {
          response: await get(caller.headers, `/api/v1/accounts/${account}/contacts`, [
            ['limit', '100'],
          ]),
          named: [c],
        };
      },
    },
    {
      op: 'updateContact',
      shape: 'record',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed({ status: 'new' });
        const body = { version: await versionOf('contact', c.id), status: 'contacted' };
        return { response: await patch(caller.headers, `${CONTACTS}/${c.id}`, body), named: [c] };
      },
    },
    {
      op: 'convertContact',
      shape: 'record',
      status: 200,
      tenantAdmin: true,
      run: async (caller) => {
        const c = await plantNamed({ status: 'new' });
        const body = {
          version: await versionOf('contact', c.id),
          newAccount: { name: 'Zqconvert Holdings' },
        };
        return {
          response: await post(caller.headers, `${CONTACTS}/${c.id}/convert`, body),
          named: [c],
        };
      },
    },
    {
      op: 'getContactMergePreview',
      shape: 'record',
      status: 200,
      tenantAdmin: true,
      run: async (caller) => {
        const [s, m] = await plantPair();
        return {
          response: await get(caller.headers, `${CONTACTS}/${s.id}/merge-preview`, [
            ['with', m.id],
          ]),
          named: [s, m],
        };
      },
    },
    {
      op: 'createContactMerge',
      shape: 'summary',
      status: 201,
      tenantAdmin: true,
      run: async (caller) => {
        const [s, m] = await plantPair();
        const body = {
          survivorId: s.id,
          mergedId: m.id,
          survivorVersion: await versionOf('contact', s.id),
          mergedVersion: await versionOf('contact', m.id),
        };
        return { response: await post(caller.headers, MERGES, body), named: [s, m] };
      },
    },
    {
      op: 'listContactMerges',
      shape: 'summary',
      status: 200,
      tenantAdmin: true,
      run: async (caller) => {
        const [s, m] = await plantPair();
        expectStatus(
          await mergeBySupervisor(s, m),
          201,
          'createContactMerge (fixture, by the supervisor)',
        );
        return { response: await get(caller.headers, MERGES, [['limit', '100']]), named: [s, m] };
      },
    },
    {
      op: 'listDuplicates',
      shape: 'summary',
      status: 200,
      tenantAdmin: true,
      run: async (caller) => {
        const [s, m] = await plantPair();
        return {
          response: await get(caller.headers, `/api/v1/programmes/${PROGRAMME_A1}/duplicates`, [
            ['limit', '100'],
          ]),
          named: [s, m],
        };
      },
    },
    {
      op: 'getDeal',
      shape: 'summary',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed();
        const { deal } = await plantDeal(c.id);
        return { response: await get(caller.headers, `/api/v1/deals/${deal}`), named: [c] };
      },
    },
    {
      op: 'listDeals',
      shape: 'summary',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed();
        const { pipeline } = await plantDeal(c.id);
        return {
          response: await get(caller.headers, `/api/v1/pipelines/${pipeline}/deals`, [
            ['limit', '100'],
          ]),
          named: [c],
        };
      },
    },
    {
      op: 'getPipelineBoard',
      shape: 'summary',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed();
        const { pipeline } = await plantDeal(c.id);
        return {
          response: await get(caller.headers, `/api/v1/pipelines/${pipeline}/board`),
          named: [c],
        };
      },
    },
    {
      op: 'createDeal',
      shape: 'summary',
      status: 201,
      run: async (caller) => {
        const c = await plantNamed();
        const { pipeline } = await pipelineA1();
        const body = { name: 'Zqdeal Fixture new', primaryContactId: c.id };
        return {
          response: await post(caller.headers, `/api/v1/pipelines/${pipeline}/deals`, body),
          named: [c],
        };
      },
    },
    {
      op: 'updateDeal',
      shape: 'summary',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed();
        const { deal } = await plantDeal(c.id);
        const body = { version: await versionOf('deal', deal), nextStep: 'Fixture follow-up call' };
        return { response: await patch(caller.headers, `/api/v1/deals/${deal}`, body), named: [c] };
      },
    },
    {
      op: 'moveDeal',
      shape: 'summary',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed();
        const { deal, target } = await plantDeal(c.id);
        const body = { version: await versionOf('deal', deal), toStageId: target };
        return {
          response: await post(caller.headers, `/api/v1/deals/${deal}/move`, body),
          named: [c],
        };
      },
    },
    {
      op: 'listMyActivities',
      shape: 'summary',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed();
        await plantTask(caller.id, c.id, null);
        const params: Params = [
          ['timeZone', 'Africa/Lagos'],
          ['bucket', 'upcoming'],
          ['limit', '100'],
        ];
        return { response: await get(caller.headers, '/api/v1/me/activities', params), named: [c] };
      },
    },
    {
      op: 'listCalendar',
      shape: 'summary',
      status: 200,
      run: async (caller) => {
        const c = await plantNamed();
        const now = Date.now();
        await plantTask(caller.id, c.id, new Date(now + 86_400_000).toISOString());
        const params: Params = [
          ['from', new Date(now - 86_400_000).toISOString()],
          ['to', new Date(now + 7 * 86_400_000).toISOString()],
          ['limit', '100'],
        ];
        return { response: await get(caller.headers, '/api/v1/me/calendar', params), named: [c] };
      },
    },
    {
      op: 'listNotifications',
      shape: 'notification',
      status: 200,
      guard: 'T-0100 resolves objectDisplayName under the D-L68 rule',
      run: async (caller) => {
        const c = await plantNamed();
        await plantNotification(caller.id, c.id);
        return {
          response: await get(caller.headers, '/api/v1/notifications', [['limit', '50']]),
          named: [c],
        };
      },
    },
    {
      op: 'searchRecords',
      shape: 'record',
      status: 200,
      guard: 'T-0086 serves T-0085 R8',
      run: async (caller) => {
        const c = await plantNamed();
        const q = must(c.givenNames, 'givenNames').toLowerCase();
        return {
          response: await get(caller.headers, '/api/v1/search', [
            ['q', q],
            ['types', 'contact'],
          ]),
          named: [c],
        };
      },
    },
    {
      op: 'lookupRecords',
      shape: 'record',
      status: 200,
      guard: 'T-0086 serves T-0085 R8',
      run: async (caller) => {
        const email = `zq.${nextTag()}@example.test`;
        const c = await plantNamed({ emails: [email] });
        return {
          response: await post(caller.headers, '/api/v1/search/lookup', {
            email,
            types: ['contact'],
          }),
          named: [c],
        };
      },
    },
  ];

  describe('the table: every answer naming a contact follows the rule (I1, I2, I3, I16, I17)', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    it.each(
      ROWS.map(
        (row) =>
          [row.guard === undefined ? row.op : `(guard, passes on main) ${row.op}`, row] as const,
      ),
    )(
      '%s: a reader of both parts sees the name; with familyName withheld it is withheld everywhere in the answer',
      async (_label, row) => {
        await lockFamilyFromTeamLead();
        const open = await openCaller(row.tenantAdmin === true);
        const readable = await row.run(open);
        expectStatus(readable.response, row.status, `${row.op} (the open caller)`);
        expect(
          judge(
            row.shape,
            'readable',
            readable.response.status,
            readable.response.text,
            readable.response.body,
            readable.named,
          ),
          `${row.op} readable`,
        ).toEqual([]);

        const hidden = await hiddenCaller(row.tenantAdmin === true);
        const withheld = await row.run(hidden);
        expectStatus(withheld.response, row.status, `${row.op} (the caller missing familyName)`);
        expect(
          judge(
            row.shape,
            'withheld',
            withheld.response.status,
            withheld.response.text,
            withheld.response.body,
            withheld.named,
          ),
          `${row.op} withheld`,
        ).toEqual([]);
      },
    );

    it('(guard, passes on main) the table covers every operation the contract answers a contact name on', () => {
      // A row per operation whose answer schema reaches Contact, a contact
      // summary or a contact notification; I15 lists what is out of scope.
      expect(ROWS.map((row) => row.op).sort()).toEqual(
        [
          'createContactMerge',
          'createDeal',
          'convertContact',
          'getContact',
          'getContactMergePreview',
          'getDeal',
          'getPipelineBoard',
          'listAccountContacts',
          'listCalendar',
          'listContactMerges',
          'listContacts',
          'listDeals',
          'listDuplicates',
          'listLeads',
          'listMyActivities',
          'listNotifications',
          'lookupRecords',
          'moveDeal',
          'searchRecords',
          'updateContact',
          'updateDeal',
        ].sort(),
      );
    });
  });

  // =========================================================================
  // 2. The rule's edges (I1).
  // =========================================================================

  describe('the rule, at its edges (I1)', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    const getOne = (caller: UserPlant, c: Named) => get(caller.headers, `${CONTACTS}/${c.id}`);
    const judged = (mode: Mode, response: request.Response, c: Named) =>
      judge('record', mode, response.status, response.text, response.body, [c]);

    it('givenNames withheld withholds displayName too, and familyName stays readable', async () => {
      await lockField('given_names', 'qa_analyst', 'none');
      const caller = await freshUser([[PROGRAMME_A1, 'qa_analyst']]);
      const c = await plantNamed();
      const response = await getOne(caller, c);
      expectStatus(response, 200, 'getContact');
      const body = response.body as Json;
      expect('displayName' in body || 'givenNames' in body, JSON.stringify(body)).toBe(false);
      expect(body.familyName).toBe(c.familyName);
      expect([...(body.withheldFields as string[])].sort()).toEqual(
        expect.arrayContaining(['displayName', 'givenNames']),
      );
      expect(response.text.toLowerCase()).not.toContain(c.shown);
    });

    it('a withheld part that is NULL on the record still withholds displayName', async () => {
      await lockFamilyFromTeamLead();
      const c = await plantNamed({ familyName: null });
      expect(judged('readable', await getOne(await openCaller(), c), c)).toEqual([]);
      expect(judged('withheld', await getOne(await hiddenCaller(), c), c)).toEqual([]);
    });

    it('(guard, passes on main) a read-only part leaves displayName readable', async () => {
      await lockField('family_name', 'team_lead', 'read');
      const c = await plantNamed();
      expect(judged('readable', await getOne(await hiddenCaller(), c), c)).toEqual([]);
    });

    it('is judged per record, in each record’s own programme', async () => {
      await lockFamilyFromTeamLead();
      const caller = await freshUser([
        [PROGRAMME_A1, 'team_lead'],
        [PROGRAMME_A2, 'agent'],
      ]);
      const inA1 = await plantNamed({ programme: PROGRAMME_A1 });
      const inA2 = await plantNamed({ programme: PROGRAMME_A2 });
      const response = await get(caller.headers, CONTACTS, [['limit', '100']]);
      expectStatus(response, 200, 'listContacts');
      expect(judge('record', 'withheld', 200, '', response.body, [inA1])).toEqual([]);
      expect(judge('record', 'readable', 200, response.text, response.body, [inA2])).toEqual([]);
      expect(response.text.toLowerCase()).not.toContain(inA1.shown);
    });

    it('the tenant-admin flag never lifts it (D-L63)', async () => {
      await lockFamilyFromTeamLead();
      const c = await plantNamed();
      expect(judged('withheld', await getOne(await hiddenCaller(true), c), c)).toEqual([]);
    });

    it('a membership with no set gets the least an unlocked set gets: a part withheld from team_lead withholds the name from a set-less member', async () => {
      await lockFamilyFromTeamLead();
      const caller = await freshUser([[PROGRAMME_A1, null]]);
      const c = await plantNamed();
      expect(judged('withheld', await getOne(caller, c), c)).toEqual([]);
    });
  });

  // =========================================================================
  // 3. q on the contact and lead lists (I7, I8).
  // =========================================================================

  const Q_LISTS = [
    { op: 'listContacts', path: CONTACTS, status: null },
    { op: 'listLeads', path: LEADS, status: 'new' },
  ] as const;

  describe('q never matches what the caller cannot read (I7, I8)', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    const idsOf = (response: request.Response) =>
      ((response.body as Json).data as Json[]).map((row) => String(row.id));

    async function listQ(caller: UserPlant, path: string, q: string): Promise<request.Response> {
      const response = await get(caller.headers, path, [
        ['q', q],
        ['limit', '100'],
      ]);
      expectStatus(response, 200, `${path}?q=${q}`);
      return response;
    }

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '%s: a row reachable only through a withheld displayName is absent; a reader of both parts finds it (no oracle by filtering)',
      async (_op, list) => {
        await lockFamilyFromTeamLead();
        const c = await plantNamed({ status: list.status });
        expect(
          idsOf(await listQ(await openCaller(), list.path, c.shown)),
          'control: the reader of both parts',
        ).toEqual([c.id]);
        expect(idsOf(await listQ(await hiddenCaller(), list.path, c.shown))).toEqual([]);
      },
    );

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '%s: a readable givenNames still matches, and that row carries no displayName',
      async (_op, list) => {
        await lockFamilyFromTeamLead();
        const c = await plantNamed({ status: list.status });
        const response = await listQ(
          await hiddenCaller(),
          list.path,
          must(c.givenNames, 'givenNames').toLowerCase(),
        );
        expect(idsOf(response)).toEqual([c.id]);
        expect(judge('record', 'withheld', 200, response.text, response.body, [c])).toEqual([]);
      },
    );

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '(guard, passes on main) %s: a withheld familyName never matches',
      async (_op, list) => {
        await lockFamilyFromTeamLead();
        const c = await plantNamed({ status: list.status });
        const fn = must(c.familyName, 'familyName').toLowerCase();
        expect(idsOf(await listQ(await openCaller(), list.path, fn)), 'control').toEqual([c.id]);
        expect(idsOf(await listQ(await hiddenCaller(), list.path, fn))).toEqual([]);
      },
    );

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '%s: judged per row in its own programme: the same displayName matches where it is readable and not where it is withheld',
      async (_op, list) => {
        await lockFamilyFromTeamLead();
        const marker = `Zqdn${nextTag()}`;
        await plantNamed({ programme: PROGRAMME_A1, status: list.status, displayMarker: marker });
        const inA2 = await plantNamed({
          programme: PROGRAMME_A2,
          status: list.status,
          displayMarker: marker,
        });
        const caller = await freshUser([
          [PROGRAMME_A1, 'team_lead'],
          [PROGRAMME_A2, 'agent'],
        ]);
        expect(idsOf(await listQ(caller, list.path, marker.toLowerCase()))).toEqual([inA2.id]);
      },
    );

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '%s: the tenant-admin flag never lifts it (D-L63)',
      async (_op, list) => {
        await lockFamilyFromTeamLead();
        const c = await plantNamed({ status: list.status });
        expect(idsOf(await listQ(await hiddenCaller(true), list.path, c.shown))).toEqual([]);
      },
    );

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '(guard, passes on main) %s: q is 1 to 100 characters; 101 is 400 validation_failed (I8)',
      async (_op, list) => {
        expectStatus(
          await get(SUPERVISOR, list.path, [['q', 'S'.repeat(100)]]),
          200,
          '100 characters',
        );
        const long = await get(SUPERVISOR, list.path, [['q', 'S'.repeat(101)]]);
        expectStatus(long, 400, '101 characters');
        expect((long.body as Json).code).toBe('validation_failed');
      },
    );
  });

  // =========================================================================
  // 4. R21: the URL never carries a phone number or an email address (I9).
  // =========================================================================

  describe('R21 on the contact and lead lists: an identifier in q is refused (I9)', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '%s: every pasted phone or email in q is 400 validation_failed, identifier_in_url at q, never echoed',
      async (_op, list) => {
        const wrong: string[] = [];
        for (const q of IDENTIFIER_QS) {
          const response = await get(SUPERVISOR, list.path, [['q', q]]);
          const found = details(response).some(
            (d) => d.path === 'q' && d.code === 'identifier_in_url',
          );
          if (
            response.status !== 400 ||
            (response.body as Json).code !== 'validation_failed' ||
            !found
          ) {
            wrong.push(`${JSON.stringify(q)}: ${response.status} ${response.text.slice(0, 160)}`);
          } else if (response.text.includes(q) || response.text.includes(encodeURIComponent(q))) {
            wrong.push(`${JSON.stringify(q)}: echoed in the error body`);
          }
        }
        expect(wrong).toEqual([]);
      },
    );

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '(guard, passes on main) %s: every name-shaped q is still answered 200',
      async (_op, list) => {
        for (const q of NAME_QS)
          expectStatus(await get(SUPERVISOR, list.path, [['q', q]]), 200, `q=${q}`);
      },
    );

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '%s: a number the caller can read is no longer found through q (lookupRecords finds it)',
      async (_op, list) => {
        const phone = nextPhone();
        const c = await plantNamed({ status: list.status, phones: [phone] });
        const listed = await get(SUPERVISOR, list.path, [['q', phone]]);
        expectStatus(listed, 400, `${list.op} q=<phone>`);
        expect(details(listed)).toContainEqual({ path: 'q', code: 'identifier_in_url' });
        const looked = await post(SUPERVISOR, '/api/v1/search/lookup', {
          phone,
          types: ['contact'],
        });
        expectStatus(looked, 200, 'lookupRecords (control: the number is findable the right way)');
        expect(holdersOf(looked.body, c.id, 'record')).not.toHaveLength(0);
      },
    );

    it.each(Q_LISTS.map((list) => [list.op, list] as const))(
      '%s: a refused identifier reaches no log line or span, in any form',
      async (_op, list) => {
        const phone = nextPhone();
        const email = `zq.${nextTag()}@example.test`;
        const statuses: number[] = [];
        const { telemetry, lines } = await captureEverything(async () => {
          for (const q of [phone, email])
            statuses.push((await get(SUPERVISOR, list.path, [['q', q]])).status);
        });
        expect(statuses, 'both refused').toEqual([400, 400]);
        const spanText = telemetry.spans
          .map((span) => JSON.stringify([span.attributes, span.events]))
          .join('\n');
        const leaks = [phone, email]
          .flatMap(formsOf)
          .filter((form) => lines.some((line) => line.includes(form)) || spanText.includes(form));
        expect(leaks).toEqual([]);
      },
    );
  });

  // =========================================================================
  // 5. Sort and cursors (I5, I6).
  // =========================================================================

  describe('sort keys are never-withheld fields, and no cursor carries a name (I5, I6)', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    it('sort=displayName and -displayName are 400 validation_failed on all three lists, even for a caller who reads every name', async () => {
      const account = await plantAccount(PROGRAMME_A1, 'Zqsort Holdings');
      await plantNamed({ accountId: account, status: 'new' });
      const wrong: string[] = [];
      for (const path of [CONTACTS, LEADS, `/api/v1/accounts/${account}/contacts`]) {
        for (const sort of ['displayName', '-displayName']) {
          const response = await get(SUPERVISOR, path, [['sort', sort]]);
          if (response.status !== 400 || (response.body as Json).code !== 'validation_failed') {
            wrong.push(`${path}?sort=${sort}: ${response.status}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it('listAccountContacts: the default order never depends on a contact’s displayName', async () => {
      // Two accounts, contacts planted interleaved (x1 y1 x2 y2 x3 y3), so every
      // key that is not a name orders both accounts' contacts the same way.
      // Names ascend in X and descend in Y: only a name order tells them apart.
      const x = await plantAccount(PROGRAMME_A1, 'Zqorderx Holdings');
      const y = await plantAccount(PROGRAMME_A1, 'Zqordery Holdings');
      const letters = ['Zqaa', 'Zqbb', 'Zqcc'];
      const xs: string[] = [];
      const ys: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        xs.push((await plantNamed({ accountId: x, displayMarker: must(letters[i], 'letter') })).id);
        ys.push(
          (await plantNamed({ accountId: y, displayMarker: must(letters[2 - i], 'letter') })).id,
        );
      }
      const order = async (account: string, ids: string[]) => {
        const response = await get(SUPERVISOR, `/api/v1/accounts/${account}/contacts`, [
          ['limit', '100'],
        ]);
        expectStatus(response, 200, 'listAccountContacts');
        return ((response.body as Json).data as Json[]).map((row) => ids.indexOf(String(row.id)));
      };
      const xOrder = await order(x, xs);
      expect(xOrder.slice().sort(), 'all three of X listed').toEqual([0, 1, 2]);
      expect(await order(y, ys)).toEqual(xOrder);
    });

    // A guard: T-0084 made these cursors id-only (D-L80), so it passes on main.
    // It fails the day a name returns to a cursor, under any sort offered then.
    it('(guard, passes on main) no nextCursor from the three lists carries a displayName, under every sort the contract offers, for a reader or a caller missing a part', async () => {
      await lockFamilyFromTeamLead();
      const account = await plantAccount(PROGRAMME_A1, 'Zqcursor Holdings');
      const planted: Named[] = [];
      for (let i = 0; i < 3; i += 1)
        planted.push(await plantNamed({ accountId: account, status: 'new' }));
      const secrets = planted.flatMap((c) => c.secrets);
      const lists: [string, string][] = [
        [CONTACTS, '/api/v1/contacts'],
        [LEADS, '/api/v1/leads'],
        [`/api/v1/accounts/${account}/contacts`, '/api/v1/accounts/{accountId}/contacts'],
      ];
      const leaks: string[] = [];
      let cursors = 0;
      for (const caller of [await openCaller(), await hiddenCaller()]) {
        for (const [path, template] of lists) {
          const sorts = sortValuesOf(template);
          expect(sorts.length, `${template}: the contract offers no sort`).toBeGreaterThan(0);
          for (const sort of [null, ...sorts]) {
            const params: [string, string][] = [['limit', '1']];
            if (sort !== null) params.push(['sort', sort]);
            const response = await get(caller.headers, path, params);
            expectStatus(response, 200, `${path} sort=${String(sort)}`);
            for (const decoded of decodedCursors(response.body)) {
              cursors += 1;
              const lower = decoded.toLowerCase();
              for (const secret of secrets)
                if (lower.includes(secret)) leaks.push(`${path} sort=${String(sort)}: "${secret}"`);
            }
          }
        }
      }
      expect(cursors, 'no cursor was issued, so nothing was judged').toBeGreaterThan(0);
      expect(leaks).toEqual([]);
    });
  });

  // =========================================================================
  // 6. Writes (I11).
  // =========================================================================

  describe('a withheld displayName is not editable (I11)', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    it('updateContact sending displayName from a caller it is withheld from is 403 field_not_editable at displayName, and writes nothing', async () => {
      await lockFamilyFromTeamLead();
      const control = await plantNamed();
      const allowed = await patch((await openCaller(true)).headers, `${CONTACTS}/${control.id}`, {
        version: await versionOf('contact', control.id),
        displayName: 'Zqrenamed Sample',
      });
      expectStatus(allowed, 200, 'control: a caller who reads both parts renames');

      const c = await plantNamed();
      const refused = await patch((await hiddenCaller(true)).headers, `${CONTACTS}/${c.id}`, {
        version: await versionOf('contact', c.id),
        displayName: 'Zqrenamed Sample',
      });
      expectStatus(refused, 403, 'updateContact displayName (withheld)');
      expect((refused.body as Json).code).toBe('not_permitted');
      expect(details(refused)).toContainEqual({ path: 'displayName', code: 'field_not_editable' });
      const row = await observer.query<{ display_name: string; version: number }>(
        'SELECT display_name, version FROM contact WHERE id = $1',
        [c.id],
      );
      expect(row.rows[0]).toEqual({ display_name: c.displayName, version: 1 });
    });

    it('getContactMergePreview never defaults displayName for a caller it is withheld from, and choosing it is 403 field_not_editable at choices.displayName', async () => {
      await lockFamilyFromTeamLead();
      const [cs, cm] = await plantPair();
      const openPreview = await get(
        (await openCaller(true)).headers,
        `${CONTACTS}/${cs.id}/merge-preview`,
        [['with', cm.id]],
      );
      expectStatus(openPreview, 200, 'control preview');
      expect(
        Object.keys((openPreview.body as Json).defaults as Json),
        'control: displayName is choosable for a reader',
      ).toContain('displayName');

      const hidden = await hiddenCaller(true);
      const [s, m] = await plantPair();
      const preview = await get(hidden.headers, `${CONTACTS}/${s.id}/merge-preview`, [
        ['with', m.id],
      ]);
      expectStatus(preview, 200, 'preview (withheld)');
      expect(Object.keys((preview.body as Json).defaults as Json)).not.toContain('displayName');

      const refused = await post(hidden.headers, MERGES, {
        survivorId: s.id,
        mergedId: m.id,
        survivorVersion: await versionOf('contact', s.id),
        mergedVersion: await versionOf('contact', m.id),
        choices: { displayName: 'merged' },
      });
      expectStatus(refused, 403, 'createContactMerge choosing displayName (withheld)');
      expect(details(refused)).toContainEqual({
        path: 'choices.displayName',
        code: 'field_not_editable',
      });
      const merges = await observer.query<{ n: string }>(
        'SELECT count(*) AS n FROM contact_merge WHERE survivor_id = $1',
        [s.id],
      );
      expect(Number(merges.rows[0]?.n), 'nothing merged').toBe(0);
    });
  });

  // =========================================================================
  // 7. The contact timeline (I12).
  // =========================================================================

  describe('the contact timeline: an item naming displayName follows displayName (I12)', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    it('a displayName change is shown to a reader of both parts and omitted, name and all, for a caller missing one', async () => {
      await lockFamilyFromTeamLead();
      const c = await plantNamed();
      const renamed = await patch(SUPERVISOR, `${CONTACTS}/${c.id}`, {
        version: await versionOf('contact', c.id),
        displayName: `Zqre${nextTag()} Sample`,
      });
      expectStatus(renamed, 200, 'updateContact displayName (fixture, by the supervisor)');
      const namingDisplayName = async (caller: UserPlant) => {
        const response = await get(caller.headers, `${CONTACTS}/${c.id}/timeline`, [
          ['limit', '100'],
        ]);
        expectStatus(response, 200, 'listContactTimeline');
        return ((response.body as Json).data as Json[]).filter(
          (item) => item.type === 'field_changed' && item.field === 'displayName',
        );
      };
      expect(
        await namingDisplayName(await openCaller()),
        'control: the change is on the timeline',
      ).toHaveLength(1);
      expect(await namingDisplayName(await hiddenCaller())).toEqual([]);
    });
  });

  // =========================================================================
  // 8. Scripting (I13).
  // =========================================================================

  describe('scripts read contact.displayName under the same rule (I13)', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    const MARK = 'ZqT0124 script wording';

    function graph(kind: 'variable' | 'branch'): Json {
      return {
        startNodeId: 'greet',
        nodes: [
          {
            id: 'greet',
            type: 'say',
            title: 'Greeting',
            text:
              kind === 'variable'
                ? `Good afternoon, {contact.displayName}. ${MARK}`
                : `Good afternoon. ${MARK}`,
            next: 'named',
          },
          {
            id: 'named',
            type: 'branch',
            title: 'Named?',
            condition:
              kind === 'branch'
                ? { source: 'contact_field', field: 'displayName', operator: 'is_set' }
                : { source: 'contact_field', field: 'status', operator: 'is_set' },
            whenTrue: 'yes',
            whenFalse: 'no',
          },
          { id: 'yes', type: 'end', title: 'Yes' },
          { id: 'no', type: 'end', title: 'No' },
        ],
      };
    }

    async function publishGraph(
      kind: 'variable' | 'branch',
    ): Promise<{ scriptId: string; response: request.Response }> {
      const created = await post(SUPERVISOR, SCRIPTS, {
        programmeId: PROGRAMME_A1,
        name: `T-0124 script ${nextTag()}`,
        sourceLocale: 'en',
        graph: graph(kind),
      });
      expectStatus(created, 201, 'createScript (fixture)');
      const script = created.body as Json;
      const response = await post(SUPERVISOR, `${SCRIPTS}/${String(script.id)}/versions`, {
        revision: script.revision,
      });
      return { scriptId: String(script.id), response };
    }

    function expectWithheldRefusal(response: request.Response, where: string): void {
      expectStatus(response, 409, where);
      expect((response.body as Json).code).toBe('script_invalid');
      expect(
        details(response).map((d) => d.code),
        where,
      ).toContain('branch_on_withheld_field');
      expect(response.text, 'publish details never carry wording').not.toContain(MARK);
    }

    it('publishScript: a branch on contact.displayName is branch_on_withheld_field when a script.run set cannot read a name part', async () => {
      expectStatus(
        (await publishGraph('branch')).response,
        201,
        'control: publishes while nothing is withheld',
      );
      await lockFamilyFromTeamLead();
      expectWithheldRefusal(
        (await publishGraph('branch')).response,
        'publish branch on displayName',
      );
    });

    it('(guard, passes on main) a read-only name part does not block a branch on displayName', async () => {
      await lockField('family_name', 'team_lead', 'read');
      expectStatus((await publishGraph('branch')).response, 201, 'publish with a read-only part');
    });

    // D-L180, I13 amended: DISPLAYING the name stays allowed. Substitution is the
    // client's (scripting contract: variables are filled from the contact as
    // getContact returned it), so on the wire the rule is: publishing is not
    // blocked; no run answer ever carries the name; the wording carries the
    // token for the client to replace; and the agent's getContact omits and
    // lists displayName, which is what makes the client draw the stand-in. The
    // stand-in's message id is pinned in the contract half
    // (x-kasuwa-withheld-name-message-id); the drawn DOM is a p10-agent journey.
    it('a variable on contact.displayName still publishes when a set cannot read a name part, and a withheld agent’s run never carries the name, only the token for the stand-in', async () => {
      await lockFamilyFromTeamLead();
      const { scriptId, response } = await publishGraph('variable');
      expectStatus(response, 201, 'publish {contact.displayName} while team_lead lacks familyName');

      const runAs = async (caller: UserPlant, c: Named) => {
        const started = await post(caller.headers, RUNS, { scriptId, contactId: c.id });
        expectStatus(started, 201, 'startScriptRun');
        const run = started.body as Json;
        const advanced = await post(caller.headers, `${RUNS}/${String(run.id)}/advance`, {
          revision: run.revision,
        });
        expectStatus(advanced, 200, 'advanceScriptRun');
        const read = await get(caller.headers, `${RUNS}/${String(run.id)}`);
        expectStatus(read, 200, 'getScriptRun');
        const wording = await get(caller.headers, `${RUNS}/${String(run.id)}/script`);
        expectStatus(wording, 200, 'getScriptRunScript');
        const contact = await get(caller.headers, `${CONTACTS}/${c.id}`);
        expectStatus(contact, 200, 'getContact (what the client substitutes from)');
        return { answers: [started, advanced, read, wording], wording, contact };
      };

      const openContact = await plantNamed();
      const open = await runAs(await openCaller(), openContact);
      expect(
        judge('record', 'readable', 200, open.contact.text, open.contact.body, [openContact]),
        'control: a reader of both parts gets the name to substitute',
      ).toEqual([]);

      const c = await plantNamed();
      const hidden = await runAs(await hiddenCaller(), c);
      const leaked = hidden.answers.flatMap((answer) =>
        c.secrets.filter((secret) => answer.text.toLowerCase().includes(secret)),
      );
      expect(leaked, 'a run answer carried the withheld name').toEqual([]);
      expect(
        hidden.wording.text,
        'the wording keeps the token for the client to replace',
      ).toContain('{contact.displayName}');
      expect(
        judge('record', 'withheld', 200, hidden.contact.text, hidden.contact.body, [c]),
        'the agent’s contact omits and lists displayName, so the client draws the stand-in',
      ).toEqual([]);
    });

    it('a run’s branch on displayName stops with field_withheld once a name part is withheld from its agent; a reader goes on', async () => {
      const { scriptId, response } = await publishGraph('branch');
      expectStatus(response, 201, 'publish (fixture)');
      await lockFamilyFromTeamLead();
      const runTo = async (caller: UserPlant) => {
        const c = await plantNamed();
        const started = await post(caller.headers, RUNS, { scriptId, contactId: c.id });
        expectStatus(started, 201, 'startScriptRun');
        const run = started.body as Json;
        const advanced = await post(caller.headers, `${RUNS}/${String(run.id)}/advance`, {
          revision: run.revision,
        });
        expectStatus(advanced, 200, 'advanceScriptRun into the branch');
        return advanced.body as Json;
      };
      const open = await runTo(await openCaller());
      expect(open.stopReason ?? null, 'control: a reader of both parts is not stopped').toBeNull();
      expect(open.currentNodeId, 'control: displayName is set, so the branch goes to yes').toBe(
        'yes',
      );
      const hidden = await runTo(await hiddenCaller());
      expect(hidden).toMatchObject({
        status: 'stopped',
        stopReason: 'field_withheld',
        currentNodeId: 'named',
      });
    });
  });

  // =========================================================================
  // 9. Audit (I14, D-L176).
  // =========================================================================

  describe('audit never labels a contact with its name (I14, D-L176)', () => {
    afterEach(async () => {
      await reseed(inject('migrationUrl'));
    });

    it('(guard, passes on main) no audit event about a contact carries its displayName or a name part, after a rename, a convert and a merge', async () => {
      const c = await plantNamed({ status: 'new' });
      const [s, m] = await plantPair();
      expectStatus(
        await patch(SUPERVISOR, `${CONTACTS}/${c.id}`, {
          version: await versionOf('contact', c.id),
          displayName: `Zqre${nextTag()} Sample`,
        }),
        200,
        'rename',
      );
      expectStatus(
        await post(SUPERVISOR, `${CONTACTS}/${c.id}/convert`, {
          version: await versionOf('contact', c.id),
          newAccount: { name: 'Zqaudit Holdings' },
        }),
        200,
        'convert',
      );
      expectStatus(await mergeBySupervisor(s, m), 201, 'merge');
      const rows = await observer.query<{ label: string; changes: string | null }>(
        `SELECT object_label AS label, changes::text AS changes FROM audit_event
          WHERE object_type = 'contact' AND object_id::text = ANY ($1::text[])`,
        [[c.id, s.id, m.id]],
      );
      expect(rows.rows.length, 'the three writes were audited').toBeGreaterThanOrEqual(3);
      const secrets = [c, s, m].flatMap((n) => [
        ...n.secrets,
        must(n.givenNames, 'givenNames').toLowerCase(),
      ]);
      const leaks = rows.rows.flatMap((row) =>
        secrets.filter((secret) =>
          `${row.label}\n${row.changes ?? ''}`.toLowerCase().includes(secret),
        ),
      );
      expect(leaks).toEqual([]);
    });
  });
});
