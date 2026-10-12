import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  CONTACT_FULL as RECORD_CONTACT,
  CONTACT_LOCKED as RECORD_LOCKED,
  CONTACT_NULLS as RECORD_FRESH,
  installContactRecordMock,
  type ContactRecordMock,
} from './support/contact-record-mock';
import {
  AGENT,
  CONTACT,
  CONTACT_AT_GREET,
  CONTACT_FRESH,
  CONTACT_LOCKED,
  DETAIL_FIELD,
  DISPOSITIONS,
  DISPOSITION_PAGE_CAP,
  D_CALLBACK,
  D_ESCALATE,
  D_PTP,
  D_REFUSED,
  NEW_RUN_IDS,
  NO_SUCH_ID,
  RUN_AT_CALLBACK,
  RUN_AT_END,
  RUN_AT_FORM,
  RUN_AT_IDQ,
  RUN_AT_INTRO,
  RUN_AT_READBACK,
  RUN_AT_REC,
  RUN_COMPLETED,
  RUN_FRESH,
  RUN_OTHER_AGENT,
  RUN_RESUME,
  RUN_STOPPED,
  RUNNABLE_PAGE_CAP,
  S_MAIN,
  S_STATUS_CHECK_ID,
  VERSION_12,
  VERSION_13,
  answerProblems,
  contactById,
  installScriptingMock,
  isOperation,
  runnableFor,
  servedData,
  type ScriptRunRow,
  type ScriptingMock,
  type ScriptingMockOptions,
} from './support/scripting-mock';

/**
 * T-0116 — the P10 agent script screen, manual mode (frames P10/01 to P10/04),
 * behind `crm_scripts`. Written by the lead's QA agent BEFORE the screen
 * exists; `tests/acceptance/scripting-ui/script-agent.acceptance.test.ts` runs
 * this file with `--grep @p10-agent` and reads every outcome by tag.
 * Decisions: D-L88, D-L93, D-L104, D-L107, D-P31, D-L97, D-L102.
 *
 * TAG RULE (D-L84). `@p10-agent` is the parent tag; every sub-tag is
 * `@p10-agent-<name>`. No other screen's tag contains it (`@p10-builder`
 * included), and it contains no other screen's parent tag.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTES AND THE WEB PROCESS
 *
 *   /contacts/<id>         the P05 contact record (T-0062): the run starts here
 *   /script-runs/<runId>   one run, from start to completion
 *
 *   webUrl         — every flag at its default: /script-runs/<id> is a 404.
 *   webScriptsUrl  — `crm_scripts` ON, and the contact record's flags too
 *                    (`crm_records`, `crm_record_view`), because the run
 *                    starts on the record and links back to it.
 *
 * EVERY READ AND WRITE GOES THROUGH THE CONTRACT MOCK
 *
 * Every journey installs `support/scripting-mock.ts` (world `agent`), which
 * serves the nine run operations, getContact, listMyProgrammes and
 * getCurrentUser from the contracts and checks every answer against them. The
 * journeys that start on the contact record install T-0062's
 * `support/contact-record-mock.ts` first, and the scripting mock in front of
 * it (`fallbackOthers`): the record is served by its own mock, unchanged.
 * `afterEach` fails a test in which either mock saw a request its contract
 * does not declare, or the scripting mock answered something its contract
 * rejects.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   on the contact record ([data-screen="P05/01"])
 *   [data-action="start-script"]             opens the runnable scripts,
 *   [data-testid="script-menu"]              holding
 *     [data-runnable-script="<script id>"]   one script, in served order
 *     [data-testid="script-menu-more"], [data-testid="script-menu-empty"]
 *
 *   on /script-runs/<runId>
 *   [data-shell="crm"]
 *   [data-screen="P10/01"]                   the run root, carrying
 *     data-run-state="loading|ready"
 *     data-run-status="in_progress|stopped|completed"   the server's status
 *   [data-testid="run-skeleton"], [data-testid="record-not-found"],
 *   [data-testid="record-unavailable"]
 *   [data-testid="run-contact"]              who the call is with (by name)
 *   [data-testid="version-banner"]           the run's version is not the latest
 *   [data-script-locale="<locale>"]          the language the wording is shown in
 *   [data-testid="run-steps"]
 *     [data-step="<node id>"]                one node the run entered, in path
 *       data-step-state="done|current"       order (a branch is never current
 *       data-node-type="<type>"              unless it stopped the run)
 *       [data-variable-placeholder]          a variable with no value to show
 *       [data-testid="translation-fallback"] "No Pidgin text – showing English"
 *       [data-action="acknowledge"]          the compliance tick (checked =
 *                                            the server has the acknowledgement)
 *       [data-choice="<choice key>"]         a question's answers
 *       [data-field-input="<field key>"]     a form field (choice fields are
 *                                            <select>s, dates <input type=date>,
 *                                            money in major units)
 *       [data-field-error="<field key>"]     its translated error
 *       [data-action="advance"]              next
 *   [data-testid="run-stopped"]              the stop message, carrying
 *     data-stop-reason="field_withheld|sensitive_field"
 *   [data-action="complete-run"]             finish at an end node or a stop
 *   [data-action="end-early"]                the call dropped (interrupted)
 *   [data-testid="disposition-sheet"]        role=dialog, carrying
 *     data-outcome="completed|interrupted"
 *     [data-disposition="<id>"]              one live disposition, aria-checked
 *       data-suggested="true"                the end node's suggestion
 *     [data-testid="disposition-more"]
 *     [data-field-input="note"], [data-field-input="followUpAt"]
 *                                            (input type=datetime-local)
 *     [data-action="save-disposition"], [role="alert"]
 *   [data-testid="run-complete"]             the completed run's summary:
 *     the outcome, the disposition's label, <time datetime> for a callback,
 *     [data-unacknowledged="<node id>"] for each compliance node left unread
 *   [role="alert"] on the screen             a refused or lost write
 *   [data-requires-connection]               on every write control
 *   [data-testid="offline-banner"]
 *   [data-script-text]                       script wording (author content)
 *   [data-record-text]                       served data (names, labels)
 *
 * PINNED INTERFACES BEYOND THE HOOKS (the rulings in the acceptance header)
 *
 *   - The screen draws what the server says: the steps are the run's `path`,
 *     the current node is `currentNodeId`, and every move is advanceScriptRun.
 *     It never evaluates a branch and never draws a node the run has not
 *     entered. Nothing is optimistic.
 *   - The run starts lazily: the contact record reads nothing of scripting
 *     until the agent opens the start control.
 *   - Form answers are recorded with recordScriptRunAnswers, and only there;
 *     nothing writes a contact field (D-P31).
 *   - Completion: at an `end` node or a stopped run the outcome is
 *     `completed`; anywhere else the only completion offered is `interrupted`.
 *     The disposition is mandatory. A 409 re-reads; nothing is retried blind,
 *     except that a completion whose answer was lost is sent again exactly as
 *     it was, and its `200` is a success.
 *   - Times are shown in the browser's zone. This file runs in Africa/Lagos.
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS (D-L88)
 *
 *   - No call bar, timer, mute, hold, recording, screen-pop, wrap-up timer,
 *     overtime or agent state ("Ready", "Save & ready"): M09.
 *   - No AI suggestions or summaries (M17), SMS reminders, calling hours or
 *     team-queue callbacks.
 *   - No "Writes to record" panel and no "saved to the loan record" (D-P31).
 *   - No loan panel and no `loan.*` variables.
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P10/01"]';
const RECORD = '[data-screen="P05/01"]';

/**
 * The /script-runs/[runId] transferred-byte budget. The acceptance suite holds
 * it at or under 245,000 bytes and within 5% of what this run measures, so
 * re-pin it to the measurement once the screen exists. Why 245,000: see the
 * budget test.
 */
const SCRIPT_RUN_BUDGET_BYTES = 245_000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

/** What an agent might hear and type: sensitive, so never on the device or in a log. */
const NEEDLE = 'Lost job after surgery, will pay from savings 7731';

test.use({ timezoneId: 'Africa/Lagos' });

let active: ScriptingMock | undefined;
let record: ContactRecordMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  const records = record;
  active = undefined;
  record = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults, 'the MOCK answered something its contract rejects (a mock bug, not the screen’s)').toEqual([]);
    expect(mock.violations, 'the screen sent the run API something the contract does not declare').toEqual([]);
    const origin = new URL(scriptsUrl()).origin;
    for (const url of mock.requests) {
      expect(url.origin, 'the run must be read same-origin, by a relative path').toBe(origin);
    }
  }
  if (records !== undefined) {
    expect(records.violations, 'the contact record sent the records API something the contract does not declare').toEqual([]);
  }
});

function scriptsUrl(): string {
  const urls = stack() as unknown as Readonly<Record<string, unknown>>;
  const url = urls.webScriptsUrl;
  if (typeof url !== 'string' || url === '') {
    throw new Error('the stack file has no webScriptsUrl: scripts/run-e2e.mjs starts no web process with crm_scripts on');
  }
  return url;
}

function screen(page: Page): Locator {
  return page.locator(SCREEN);
}

function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

function stepOf(page: Page, nodeId: string): Locator {
  return shown(screen(page).locator(`[data-testid="run-steps"] [data-step="${nodeId}"]`)).first();
}

function current(page: Page): Locator {
  return shown(screen(page).locator('[data-testid="run-steps"] [data-step][data-step-state="current"]')).first();
}

function control(scope: Locator, action: string): Locator {
  return shown(scope.locator(`[data-action="${action}"]`)).first();
}

function sheet(page: Page): Locator {
  return page.getByTestId('disposition-sheet');
}

/** The screen's own alerts (the run or its sheet), never Next's route announcer. */
function alerts(page: Page): Locator {
  return shown(page.locator(`${SCREEN} [role="alert"], [data-testid="disposition-sheet"] [role="alert"]`));
}

async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

async function copyText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"], [data-script-text], [data-record-text]').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

function labelsEndingWith(suffix: string): string[] {
  return Object.entries(EN)
    .filter(([id]) => id.endsWith(suffix))
    .map(([, text]) => text);
}

async function expectSaysOneOf(locator: Locator, labels: readonly string[], what: string): Promise<void> {
  expect(labels.length, `en.json has no label for ${what}`).toBeGreaterThan(0);
  const said = await visibleText(locator);
  expect(labels.some((label) => said.includes(label)), `${what}: "${said}" says none of ${labels.join(' | ')}`).toBe(true);
}

async function expectNoIdsAnywhere(page: Page, where: string): Promise<void> {
  const printed = await page.evaluate(() => {
    const out: string[] = [document.title];
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[aria-hidden="true"], script, style, template, noscript').forEach((node) => node.remove());
    out.push(copy.textContent ?? '');
    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      for (const name of ['aria-label', 'aria-description', 'aria-valuetext', 'title', 'placeholder', 'alt']) {
        const value = element.getAttribute(name);
        if (value !== null) out.push(value);
      }
      if (element instanceof HTMLInputElement && !['hidden', 'checkbox', 'radio'].includes(element.type)) out.push(element.value);
      if (element instanceof HTMLTextAreaElement) out.push(element.value);
      if (element instanceof HTMLSelectElement) out.push(element.selectedOptions[0]?.textContent ?? '');
      if (element instanceof HTMLOptionElement) out.push(element.textContent ?? '');
    }
    return out.join('\n');
  });
  expect(printed.match(UUID)?.[0], `an id was printed (${where})`).toBeUndefined();
}

async function expectNoSeriousAxe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`), `serious or critical accessibility violations on ${label}`).toEqual([]);
  expect(results.passes.length, 'axe checked nothing').toBeGreaterThan(0);
}

async function isDisabled(locator: Locator): Promise<boolean> {
  return locator.evaluate(
    (element) =>
      (element as HTMLButtonElement).disabled === true ||
      element.getAttribute('aria-disabled') === 'true' ||
      (element as HTMLInputElement).readOnly === true,
  );
}

async function expectNoUsable(locator: Locator, what: string): Promise<void> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    expect(await isDisabled(locator.nth(index)), `${what} is offered and enabled (#${index})`).toBe(true);
  }
}

type RunOptions = Omit<ScriptingMockOptions, 'world'> & { query?: string; state?: 'loading' | 'ready' };

async function install(page: Page, options: Omit<ScriptingMockOptions, 'world'> = {}): Promise<ScriptingMock> {
  const mock = await installScriptingMock(page, { world: 'agent', ...options });
  active = mock;
  return mock;
}

async function openRun(page: Page, run: ScriptRunRow, options: RunOptions = {}): Promise<ScriptingMock> {
  const mock = await install(page, options);
  const response = await page.goto(`${scriptsUrl()}/script-runs/${run.id}${options.query ?? ''}`);
  expect(response?.status(), '/script-runs/<id> with crm_scripts on').toBe(200);
  await expect(screen(page)).toBeVisible();
  await expect(screen(page)).toHaveAttribute('data-run-state', options.state ?? 'ready');
  return mock;
}

async function closeRun(page: Page): Promise<void> {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults).toEqual([]);
    expect(mock.violations).toEqual([]);
  }
}

/** The contact record with the start control, both mocks installed: the record's first, ours in front. */
async function openContact(page: Page, contactId: string, options: Omit<ScriptingMockOptions, 'world'> = {}): Promise<ScriptingMock> {
  record = await installContactRecordMock(page);
  const mock = await install(page, { fallbackOthers: true, ...options });
  const response = await page.goto(`${scriptsUrl()}/contacts/${contactId}`);
  expect(response?.status(), '/contacts/<id> on the crm_scripts process').toBe(200);
  await expect(page.locator(RECORD)).toHaveAttribute('data-record-state', 'ready');
  return mock;
}

function json(body: unknown): Record<string, unknown> {
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the write body is not an object').toBe(true);
  return body as Record<string, unknown>;
}

function keysOf(body: Record<string, unknown>): string[] {
  return Object.keys(body).sort();
}

async function stepIds(page: Page): Promise<string[]> {
  return shown(screen(page).locator('[data-testid="run-steps"] [data-step]')).evaluateAll((steps) => steps.map((entry) => entry.getAttribute('data-step') ?? ''));
}

/** The path's nodes as cards: a branch that did not stop the run is not a card. */
function cardsOf(run: ScriptRunRow, graph = VERSION_13.graph): string[] {
  return run.path.map((entry) => entry.nodeId).filter((id) => graph.nodes.find((entry) => entry.id === id)?.type !== 'branch');
}

/** Click a control and return the operation's request body and answer status. */
async function send(page: Page, target: Locator, operation: Parameters<typeof isOperation>[1], runId: string): Promise<{ body: Record<string, unknown>; status: number }> {
  const answered = page.waitForResponse((response) => isOperation(response.request(), operation, runId));
  await target.click();
  const response = await answered;
  return { body: json(response.request().postDataJSON()), status: response.status() };
}

async function dispositionIds(page: Page): Promise<string[]> {
  return shown(sheet(page).locator('[data-disposition]')).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-disposition') ?? ''));
}

function lagosDate(daysAhead: number): string {
  return new Date(Date.now() + 3_600_000 + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

async function deviceStorage(page: Page): Promise<{ dump: string; cachedApi: string[] }> {
  return page.evaluate(async () => {
    const parts: string[] = [document.cookie];
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index) ?? '';
        parts.push(key, store.getItem(key) ?? '');
      }
    }
    const idbRequest = <T,>(request: IDBRequest<T>): Promise<T> =>
      new Promise((done, fail) => {
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
    if (typeof indexedDB.databases === 'function') {
      for (const info of await indexedDB.databases()) {
        if (typeof info.name !== 'string') continue;
        parts.push(`indexeddb:${info.name}`);
        const db = await idbRequest(indexedDB.open(info.name));
        for (const name of Array.from(db.objectStoreNames)) {
          parts.push(JSON.stringify(await idbRequest(db.transaction(name, 'readonly').objectStore(name).getAll())));
        }
        db.close();
      }
    }
    const cachedApi: string[] = [];
    if ('caches' in window) {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          parts.push(request.url);
          if (new URL(request.url).pathname.startsWith('/api/')) cachedApi.push(request.url);
        }
      }
    }
    return { dump: parts.join('\n'), cachedApi };
  });
}

/** Fill the `ptp` form of RUN_AT_FORM. */
async function fillForm(step: Locator, values: { date?: string; amount?: string; reason?: string; detail?: string }): Promise<void> {
  if (values.date !== undefined) await shown(step.locator('[data-field-input="date"]')).first().fill(values.date);
  if (values.amount !== undefined) await shown(step.locator('[data-field-input="amount"]')).first().fill(values.amount);
  if (values.reason !== undefined) await shown(step.locator('[data-field-input="reason"]')).first().selectOption({ label: values.reason });
  if (values.detail !== undefined) await shown(step.locator(`[data-field-input="${DETAIL_FIELD.key}"]`)).first().fill(values.detail);
}

function v13Node(id: string): { title: string; text?: unknown } {
  const found = VERSION_13.graph.nodes.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`v13 has no ${id}`);
  return found;
}

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract refuses, runs the script on the server, and checks its own answers @p10-agent @p10-agent-mock', async ({ page }) => {
  const { webUrl } = stack();
  const mock = await installScriptingMock(page, { world: 'agent' });
  await page.goto(`${webUrl}/`);
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    page.evaluate(
      async ([target, verb, payload, extra]) => {
        const response = await fetch(target, {
          method: verb,
          headers: payload === undefined ? extra : { 'content-type': 'application/json', ...extra },
          body: payload === undefined ? null : JSON.stringify(payload),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      },
      [path, method, body, headers] as const,
    );
  const expectViolation = async (path: string, method: string, body: unknown, status: number, what: RegExp, headers?: Record<string, string>) => {
    const before = mock.violations.length;
    expect((await call(path, method, body, headers)).status, `${method} ${path}`).toBe(status);
    expect(mock.violations.slice(before).join('\n'), `${method} ${path} was not recorded`).toMatch(what);
  };
  const run = (id: string, tail = '') => `/api/v1/script-runs/${id}${tail}`;

  // Served as the contract says.
  const menu = await call(`/api/v1/contacts/${CONTACT.id}/scripts`);
  expect((menu.body.data as { id: string }[]).map((row) => row.id)).toEqual(runnableFor(CONTACT).slice(0, RUNNABLE_PAGE_CAP).map((row) => row.scriptId));
  const more = await call(`/api/v1/contacts/${CONTACT.id}/scripts?cursor=${encodeURIComponent(String(menu.body.nextCursor))}`);
  expect((more.body.data as { id: string }[]).map((row) => row.id)).toEqual([S_STATUS_CHECK_ID]);
  const resumed = await call(run(RUN_RESUME.id));
  expect(resumed.status).toBe(200);
  expect(resumed.body.latestVersion).toMatchObject({ number: VERSION_13.number });
  expect((await call(run(RUN_RESUME.id, '/script'))).body.number).toBe(VERSION_12.number);
  const other = await call(run(RUN_OTHER_AGENT.id));
  const missing = await call(run(NO_SUCH_ID));
  expect(other.status).toBe(404);
  expect(JSON.stringify(other.body), 'another agent’s run and no run answer differently').toBe(JSON.stringify(missing.body));
  expect((await call(run('not-a-uuid'))).status).toBe(400);
  // The idempotent start: the caller's run in progress comes back, with 200.
  const again = await call('/api/v1/script-runs', 'POST', { scriptId: S_MAIN.id, contactId: CONTACT.id });
  expect(again.status).toBe(200);
  expect(again.body.id).toBe(RUN_RESUME.id);
  const fresh = await call('/api/v1/script-runs', 'POST', { scriptId: S_MAIN.id, contactId: CONTACT_FRESH.id });
  expect(fresh.status).toBe(201);
  expect(fresh.body).toMatchObject({ id: NEW_RUN_IDS[0], versionId: VERSION_13.id, currentNodeId: VERSION_13.graph.startNodeId, revision: 1 });
  expect(mock.violations, 'a well-formed request was recorded as a violation').toEqual([]);

  // The engine, on the server: compliance needs its tick; a branch is evaluated, never shown.
  await call(run(RUN_FRESH.id));
  const atRec = await call(run(RUN_FRESH.id, '/advance'), 'POST', { revision: 1 });
  expect(atRec.body.currentNodeId).toBe('rec');
  const blocked = await call(run(RUN_FRESH.id, '/advance'), 'POST', { revision: atRec.body.revision });
  expect(blocked.status).toBe(409);
  expect(blocked.body.code).toBe('compliance_unacknowledged');
  const acked = await call(run(RUN_FRESH.id, '/acknowledgements'), 'POST', { revision: atRec.body.revision, nodeId: 'rec', locale: 'pcm' });
  expect(acked.status).toBe(200);
  expect((acked.body.acknowledgements as { locale: string }[])[0]?.locale).toBe('pcm');
  const twice = await call(run(RUN_FRESH.id, '/acknowledgements'), 'POST', { revision: acked.body.revision, nodeId: 'rec', locale: 'en' });
  expect(twice.body.revision, 'acknowledging again changed the run').toBe(acked.body.revision);
  const atIdq = await call(run(RUN_FRESH.id, '/advance'), 'POST', { revision: acked.body.revision });
  const past = await call(run(RUN_FRESH.id, '/advance'), 'POST', { revision: atIdq.body.revision, choiceKey: 'yes' });
  // CONTACT_AT_GREET's status is `contacted`: `cust` (status one_of [customer]) is false.
  expect(past.body.currentNodeId).toBe('intro');
  expect((past.body.path as { nodeId: string; branchOutcome?: boolean | null }[]).find((entry) => entry.nodeId === 'cust')?.branchOutcome).toBe(false);

  // Form answers: refused out of bounds, merged in bounds; required before advancing.
  await call(run(RUN_AT_FORM.id));
  const early = await call(run(RUN_AT_FORM.id, '/advance'), 'POST', { revision: RUN_AT_FORM.revision });
  expect(early.body.code).toBe('answers_incomplete');
  const small = await call(run(RUN_AT_FORM.id, '/answers'), 'PATCH', { revision: RUN_AT_FORM.revision, nodeId: 'ptp', values: { amount: { amountMinor: '300000', currency: 'NGN' } } });
  expect(small.status).toBe(400);
  expect(small.body.details).toEqual([{ path: 'values.amount', code: 'too_small' }]);
  const filled = await call(run(RUN_AT_FORM.id, '/answers'), 'PATCH', {
    revision: RUN_AT_FORM.revision,
    nodeId: 'ptp',
    values: { date: lagosDate(3), amount: { amountMinor: '2500000', currency: 'NGN' }, reason: 'salary_delayed', detail: 'x' },
  });
  expect(filled.status).toBe(200);
  expect((await call(run(RUN_AT_FORM.id, '/advance'), 'POST', { revision: filled.body.revision })).body.currentNodeId).toBe('readback');

  // Completion: requirements, then the exact repeat is a 200 that writes nothing.
  await call(run(RUN_AT_END.id));
  await call(run(RUN_AT_END.id, '/dispositions'));
  const unmet = await call(run(RUN_AT_END.id, '/complete'), 'POST', { revision: RUN_AT_END.revision, outcome: 'completed', dispositionId: D_PTP.id });
  expect(unmet.body).toMatchObject({ code: 'disposition_requirements_unmet', details: [{ path: 'note', code: 'required' }] });
  const done = await call(run(RUN_AT_END.id, '/complete'), 'POST', { revision: RUN_AT_END.revision, outcome: 'completed', dispositionId: D_PTP.id, note: 'Promised by Friday.' });
  expect(done.status).toBe(200);
  expect(done.body).toMatchObject({ status: 'completed', outcome: 'completed', endedAtNodeId: 'close', currentNodeId: null, dispositionId: D_PTP.id });
  const repeat = await call(run(RUN_AT_END.id, '/complete'), 'POST', { revision: RUN_AT_END.revision, outcome: 'completed', dispositionId: D_PTP.id, note: 'Promised by Friday.' });
  expect(repeat.status, 'an exact repeat was not a 200').toBe(200);
  expect(repeat.body.activityId).toBe(done.body.activityId);
  const changed = await call(run(RUN_AT_END.id, '/complete'), 'POST', { revision: done.body.revision, outcome: 'completed', dispositionId: D_PTP.id, note: 'Different.' });
  expect(changed.body.code).toBe('run_completed');
  // Interrupted mid-script: the unread compliance node is recorded, never acknowledged.
  await call(run(RUN_AT_READBACK.id));
  await call(run(RUN_AT_READBACK.id, '/dispositions'));
  const dropped = await call(run(RUN_AT_READBACK.id, '/complete'), 'POST', {
    revision: RUN_AT_READBACK.revision,
    outcome: 'interrupted',
    dispositionId: D_CALLBACK.id,
    followUp: { dueAt: new Date(Date.now() + 86_400_000).toISOString() },
  });
  expect(dropped.body).toMatchObject({ outcome: 'interrupted', unacknowledgedComplianceNodeIds: ['readback'] });
  expect((dropped.body.acknowledgements as { nodeId: string }[]).map((entry) => entry.nodeId)).toEqual(['rec']);
  // A run that opens on a branch on a withheld field starts already stopped; starting again replays it.
  const stopped = await call('/api/v1/script-runs', 'POST', { scriptId: S_STATUS_CHECK_ID, contactId: CONTACT_LOCKED.id });
  expect(stopped.status).toBe(201);
  expect(stopped.body).toMatchObject({ status: 'stopped', stopReason: 'field_withheld', currentNodeId: 'known' });
  expect((await call('/api/v1/script-runs', 'POST', { scriptId: S_STATUS_CHECK_ID, contactId: CONTACT_LOCKED.id })).status).toBe(200);
  expect(mock.violations, 'a well-formed run write was recorded as a violation').toEqual([]);

  // Refused, and blamed on the screen.
  await call(run(RUN_AT_REC.id));
  await call(run(RUN_AT_IDQ.id));
  await expectViolation(run(RUN_AT_REC.id, '/advance'), 'POST', { revision: RUN_AT_REC.revision, choiceKey: 'yes' }, 400, /choiceKey sent on a compliance node/);
  await expectViolation(run(RUN_AT_IDQ.id, '/advance'), 'POST', { revision: RUN_AT_IDQ.revision }, 400, /no choiceKey/);
  await expectViolation(run(RUN_AT_REC.id, '/advance'), 'POST', { revision: 99 }, 409, /revision 99/);
  await expectViolation(run(RUN_AT_REC.id, '/acknowledgements'), 'POST', { revision: RUN_AT_REC.revision, nodeId: 'rec', locale: 'sw' }, 400, /not one the pinned version can show/);
  await expectViolation(run(RUN_AT_REC.id, '/acknowledgements'), 'POST', { revision: RUN_AT_REC.revision, nodeId: 'greet', locale: 'en' }, 400, /not a compliance node/);
  await expectViolation(run(RUN_AT_REC.id, '/acknowledgements'), 'POST', { revision: RUN_AT_REC.revision, nodeId: 'rec', locale: 'en', acknowledgedAt: '2026-01-01T00:00:00Z' }, 400, /closed body/);
  await expectViolation(run(RUN_AT_IDQ.id, '/answers'), 'PATCH', { revision: RUN_AT_IDQ.revision, nodeId: 'idq', values: { x: 'y' } }, 400, /not a form node/);
  await expectViolation(run(RUN_AT_IDQ.id, '/complete'), 'POST', { revision: RUN_AT_IDQ.revision, outcome: 'completed', dispositionId: D_REFUSED.id }, 409, /never served for this run[\s\S]*not an end node/);
  await expectViolation(run(RUN_AT_IDQ.id, '/complete'), 'POST', { revision: RUN_AT_IDQ.revision, outcome: 'interrupted', dispositionId: D_CALLBACK.id, followUp: { dueAt: '2026-12-01T14:00' } }, 400, /UTC date-time/);
  await expectViolation(run(RUN_OTHER_AGENT.id, '/advance'), 'POST', { revision: 1 }, 404, /never served/);
  await expectViolation(run(RUN_AT_REC.id), 'GET', undefined, 200, /scope is never supplied/, { 'x-kasuwa-tenant-id': TENANT_A });
  await expectViolation('/api/v1/scripts', 'GET', undefined, 404, /not an operation the agent script screen uses/);
  await expectViolation(`/api/v1/contacts/${CONTACT.id}`, 'PATCH', { version: 3, status: 'customer' }, 404, /not an operation/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'call', subject: 'x', contactId: CONTACT.id }, 404, /not an operation/);
  await expectViolation('/api/v1/script-runs', 'POST', { scriptId: S_MAIN.id, contactId: CONTACT.id, versionId: VERSION_12.id }, 400, /closed body/);
  expect(mock.violations.length, 'the refusals above were not all recorded, or one was recorded twice').toBe(17);

  // The mock checks its own answers: a planted body the contract rejects is caught.
  expect(answerProblems('getScriptRun', 200, { ...RUN_RESUME, contactName: CONTACT.displayName }).join('\n')).toMatch(/contactName/);
  expect(answerProblems('listScriptRunDispositions', 200, { data: DISPOSITIONS, nextCursor: null, total: 6 }).join('\n')).toMatch(/total/);
  expect(answerProblems('listScriptRunDispositions', 200, { data: [{ ...D_PTP, usageCount90d: 4 }], nextCursor: null }).join('\n')).toMatch(/usageCount90d/);
  expect(answerProblems('getScriptRun', 200, { ...RUN_RESUME, status: 'expired' }).join('\n')).toMatch(/status/);
  expect(answerProblems('completeScriptRun', 201, RUN_COMPLETED).join('\n')).toMatch(/declares no 201/);
  expect(answerProblems('getScriptRun', 200, RUN_COMPLETED)).toEqual([]);
  expect(answerProblems('getScriptRunScript', 200, VERSION_13)).toEqual([]);

  // Without script.run: an empty menu and a 403 to start, decided before the script is looked up.
  const reader = await installScriptingMock(page, { world: 'agent', role: 'no-script-run' });
  expect((await call(`/api/v1/contacts/${CONTACT.id}/scripts`)).body).toEqual({ data: [], nextCursor: null });
  expect((await call('/api/v1/script-runs', 'POST', { scriptId: S_MAIN.id, contactId: CONTACT.id })).status).toBe(403);
  expect((await call('/api/v1/script-runs', 'POST', { scriptId: NO_SUCH_ID, contactId: CONTACT.id })).status).toBe(403);
  expect((await call(run(RUN_RESUME.id))).status, 'its own run is 404 once script.run is gone').toBe(404);
  expect(reader.violations).toEqual([]);

  // branch: 'true' takes a side the screen could not have worked out from the contact.
  const forced = await installScriptingMock(page, { world: 'agent', branch: 'true' });
  await call(run(RUN_AT_IDQ.id));
  expect((await call(run(RUN_AT_IDQ.id, '/advance'), 'POST', { revision: RUN_AT_IDQ.revision, choiceKey: 'yes' })).body.currentNodeId).toBe('payq');
  const sensitive = await installScriptingMock(page, { world: 'agent', branch: 'sensitive' });
  await call(run(RUN_AT_IDQ.id));
  expect((await call(run(RUN_AT_IDQ.id, '/advance'), 'POST', { revision: RUN_AT_IDQ.revision, choiceKey: 'yes' })).body).toMatchObject({ status: 'stopped', stopReason: 'sensitive_field', currentNodeId: 'cust' });
  for (const entry of [mock, reader, forced, sensitive]) {
    expect(entry.mockFaults).toEqual([]);
  }
  expect([...forced.violations, ...sensitive.violations]).toEqual([]);
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_scripts gates the run screen', () => {
  // PASSES BEFORE THE WORK STARTS: there is no route, so /script-runs/<id> is
  // a 404 everywhere. Legitimately vacuous until @p10-agent-flag-on passes.
  test('/script-runs/<id> is a real 404 with every flag at its default, and reads nothing @p10-agent @p10-agent-flag-off', async ({ page }) => {
    const { webUrl } = stack();
    const mock = await installScriptingMock(page, { world: 'agent' });
    const response = await page.goto(`${webUrl}/script-runs/${RUN_RESUME.id}`);
    expect(response?.status(), '/script-runs/<id> is reachable with crm_scripts off').toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    expect(mock.requests.filter((url) => url.pathname.startsWith('/api/v1/script-runs')), 'a flag-off page still read the run').toEqual([]);
  });

  test('/script-runs/<id> cannot be switched on by anything the browser sends @p10-agent @p10-agent-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-kasuwa-feature-flags': 'crm_scripts', 'x-kasuwa-tenant-id': TENANT_A } });
    await context.addCookies([{ name: 'crm_scripts', value: 'on', url: webUrl }]);
    const page = await context.newPage();
    for (const path of [`/script-runs/${RUN_RESUME.id}?crm_scripts=on`, `/script-runs/${RUN_RESUME.id}/`, `/script-runs/${RUN_RESUME.id}?locale=en-XA`]) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/script-runs/<id> renders the run with crm_scripts on @p10-agent @p10-agent-flag-on', async ({ page }) => {
    await openRun(page, RUN_FRESH);
    await expect(current(page)).toHaveAttribute('data-step', 'greet');
    await expect(page.locator('[data-shell="crm"]')).toBeVisible();
  });
});

// ===========================================================================
// P10/04 — starting from the contact record
// ===========================================================================

test.describe('P10/04 — start or resume from the contact record', () => {
  test('the record offers the contact’s runnable scripts lazily, keyset paged, and starts one with exactly the script and the contact @p10-agent @p10-agent-start', async ({ page }) => {
    const mock = await openContact(page, RECORD_FRESH.id);
    expect(RECORD_FRESH.id).toBe(CONTACT_FRESH.id);
    // Lazy: the record pays nothing for scripts until the agent asks (T-0062's mock refuses them anyway).
    expect(mock.calledTimes('listContactScripts'), 'the contact record read scripts before anyone asked').toBe(0);
    const start = shown(page.locator(`${RECORD} [data-action="start-script"]`)).first();
    await expect(start).toBeEnabled();
    await expect(start).toHaveAttribute('data-requires-connection', /.*/);
    await start.click();
    const menu = shown(page.getByTestId('script-menu')).first();
    await expect(menu).toBeVisible();
    const runnable = runnableFor(CONTACT_FRESH);
    const entry = (id: string) => shown(menu.locator(`[data-runnable-script="${id}"]`)).first();
    await expect(entry(runnable[0]?.scriptId ?? 'missing')).toContainText(runnable[0]?.name ?? 'missing');
    await expect(entry(runnable[0]?.scriptId ?? 'missing')).toContainText(`${runnable[0]?.versionNumber ?? 0}`);
    // One per page: a short page is not the last.
    const more = shown(menu.getByTestId('script-menu-more')).first();
    await expect(more).toBeEnabled();
    await more.click();
    await expect(entry(S_STATUS_CHECK_ID)).toBeVisible();
    await expectNoIdsAnywhere(page, 'the start menu');

    const sent = page.waitForResponse((response) => isOperation(response.request(), 'startScriptRun'));
    await entry(S_MAIN.id).click();
    const response = await sent;
    expect(response.status()).toBe(201);
    expect(json(response.request().postDataJSON()), 'the start chose a version, a programme or anything else').toEqual({ scriptId: S_MAIN.id, contactId: CONTACT_FRESH.id });
    await expect(page).toHaveURL(new RegExp(`/script-runs/${NEW_RUN_IDS[0] ?? 'missing'}$`));
    await expect(screen(page)).toHaveAttribute('data-run-state', 'ready');
    await expect(current(page)).toHaveAttribute('data-step', VERSION_13.graph.startNodeId);
    await expect(shown(screen(page).getByTestId('run-contact')).first()).toContainText(RECORD_FRESH.displayName);
  });

  test('starting again resumes the run in progress (the idempotent 200) at its current node, never from the start @p10-agent @p10-agent-resume', async ({ page }) => {
    const mock = await openContact(page, RECORD_CONTACT.id);
    expect(RECORD_CONTACT.id).toBe(CONTACT.id);
    await shown(page.locator(`${RECORD} [data-action="start-script"]`)).first().click();
    const sent = page.waitForResponse((response) => isOperation(response.request(), 'startScriptRun'));
    await shown(page.locator(`[data-testid="script-menu"] [data-runnable-script="${S_MAIN.id}"]`)).first().click();
    expect((await sent).status(), 'the mock did not replay the run in progress').toBe(200);
    await expect(page).toHaveURL(new RegExp(`/script-runs/${RUN_RESUME.id}$`));
    await expect(current(page)).toHaveAttribute('data-step', String(RUN_RESUME.currentNodeId));
    await expect.poll(() => stepIds(page)).toEqual(cardsOf(RUN_RESUME, VERSION_12.graph));
    await expect(alerts(page)).toHaveCount(0);
    expect(mock.writes.map((write) => write.operation)).toEqual(['startScriptRun']);
  });

  test('a caller with no runnable script is told so, and nothing is started @p10-agent @p10-agent-start', async ({ page }) => {
    const mock = await openContact(page, RECORD_FRESH.id, { role: 'no-script-run' });
    await shown(page.locator(`${RECORD} [data-action="start-script"]`)).first().click();
    await expect(shown(page.getByTestId('script-menu-empty')).first()).toBeVisible();
    await expect(page.locator('[data-runnable-script]')).toHaveCount(0);
    expect(mock.writes).toEqual([]);
  });
});

// ===========================================================================
// P10/01 — the run, as the server sends it
// ===========================================================================

test.describe('P10/01 — each node as the server sends it', () => {
  test('the steps are the run’s path, the current node its currentNodeId, wording with its variables filled in from what the screen holds @p10-agent @p10-agent-steps', async ({ page }) => {
    await openRun(page, RUN_RESUME);
    await expect.poll(() => stepIds(page), { message: 'the steps are not the run’s path (branches excepted)' }).toEqual(cardsOf(RUN_RESUME, VERSION_12.graph));
    await expect(current(page)).toHaveAttribute('data-step', 'payq');
    await expect(current(page)).toHaveAttribute('data-node-type', 'question');
    for (const id of ['greet', 'rec', 'idq']) {
      await expect(stepOf(page, id)).toHaveAttribute('data-step-state', 'done');
    }
    // Nothing the run has not entered is drawn, and a branch is never a step to act on.
    await expect(screen(page).locator('[data-step="ptp"], [data-step="intro"], [data-step="close"]')).toHaveCount(0);
    await expect(screen(page).locator('[data-step="cust"][data-step-state="current"]')).toHaveCount(0);
    for (const choice of (VERSION_12.graph.nodes.find((entry) => entry.id === 'payq')?.choices ?? []) as { key: string; label: string }[]) {
      await expect(shown(current(page).locator(`[data-choice="${choice.key}"]`)).first()).toContainText(choice.label);
    }
    await expect(shown(screen(page).getByTestId('run-contact')).first()).toContainText(CONTACT.displayName);
    expect(await page.title(), 'the contact’s name is in the document title (D-L63)').not.toContain(CONTACT.displayName);
    await expectNoIdsAnywhere(page, 'the run');
    await expectNoSeriousAxe(page, 'P10/01');
  });

  test('a variable is filled in from the contact and the agent; one on a withheld field is a placeholder, never a guess @p10-agent @p10-agent-variables', async ({ page }) => {
    await openRun(page, RUN_FRESH);
    const greet = await visibleText(current(page));
    expect(greet).toContain(CONTACT_AT_GREET.displayName);
    expect(greet).toContain(AGENT.displayName);
    expect(greet, 'a variable was printed raw').not.toMatch(/\{[a-z]+\.[A-Za-z.]+\}/);
    await closeRun(page);
    await openRun(page, RUN_AT_INTRO);
    const intro = current(page);
    await expect(intro).toHaveAttribute('data-step', 'intro');
    await expect(intro.locator('[data-variable-placeholder]'), '{contact.emails} is withheld and drew no placeholder').toHaveCount(1);
    const said = await visibleText(intro);
    expect(said, 'a variable was printed raw').not.toMatch(/\{contact\.emails\}/);
    expect(said, 'a withheld value was guessed or printed as code').not.toMatch(/\bundefined\b|\bnull\b|@/);
    expect(contactById(RUN_AT_INTRO.contactId).withheldFields).toContain('emails');
  });

  test('advancing sends the revision (and a question’s choice) and draws the node the SERVER moved to @p10-agent @p10-agent-advance', async ({ page }) => {
    // branch: 'true' sends the run down the side its contact's status says it should not:
    // a screen that works the branch out for itself draws `intro` here.
    const mock = await openRun(page, RUN_AT_IDQ, { branch: 'true' });
    const advanced = await send(page, shown(current(page).locator('[data-choice="yes"]')).first(), 'advanceScriptRun', RUN_AT_IDQ.id);
    expect(advanced.body, 'the advance sent more than the revision and the choice').toEqual({ revision: RUN_AT_IDQ.revision, choiceKey: 'yes' });
    await expect(current(page)).toHaveAttribute('data-step', 'payq');
    await expect(screen(page).locator('[data-step="intro"]'), 'the screen evaluated the branch itself').toHaveCount(0);
    expect(mock.writes.map((write) => write.operation)).toEqual(['advanceScriptRun']);
    await closeRun(page);

    // Nothing optimistic: while the advance is in flight the run has not moved.
    const held = await openRun(page, RUN_FRESH, { holdWrites: true });
    const answered = page.waitForResponse((response) => isOperation(response.request(), 'advanceScriptRun', RUN_FRESH.id));
    await control(current(page), 'advance').click();
    await expect.poll(() => held.writes.length).toBe(1);
    expect(held.writes[0]?.body, 'a say node was advanced with more than its revision').toEqual({ revision: RUN_FRESH.revision });
    await expect(current(page)).toHaveAttribute('data-step', 'greet');
    await expect(screen(page).locator('[data-step="rec"]')).toHaveCount(0);
    held.releaseWrites();
    await answered;
    await expect(current(page)).toHaveAttribute('data-step', 'rec');
  });

  test('a stale advance is a 409: the screen re-reads the run, and the next advance carries the fresh revision @p10-agent @p10-agent-advance', async ({ page }) => {
    const mock = await openRun(page, RUN_FRESH, { staleRun: 'advance', query: '?locale=en-XA' });
    const lost = await send(page, control(current(page), 'advance'), 'advanceScriptRun', RUN_FRESH.id);
    expect(lost.status).toBe(409);
    const alert = alerts(page).first();
    await expect(alert).toBeVisible();
    expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect.poll(() => mock.calledTimes('getScriptRun'), { message: 'the screen did not re-read the run after the 409' }).toBeGreaterThanOrEqual(2);
    expect(mock.writes, 'the advance was retried blind').toHaveLength(1);
    const won = await send(page, control(current(page), 'advance'), 'advanceScriptRun', RUN_FRESH.id);
    expect(won.status).toBe(200);
    expect(won.body.revision).toBe(RUN_FRESH.revision + 1);
    await expect(current(page)).toHaveAttribute('data-step', 'rec');
  });
});

test('a compliance node is acknowledged on the server, in the language it was shown, before the run can move on @p10-agent @p10-agent-compliance', async ({ page }) => {
  const mock = await openRun(page, RUN_AT_REC);
  const rec = current(page);
  await expect(rec).toHaveAttribute('data-node-type', 'compliance');
  await expectNoUsable(shown(rec.locator('[data-action="advance"]')), 'next before the acknowledgement');
  await shown(screen(page).locator('[data-script-locale="pcm"]')).first().click();
  const pcm = String((VERSION_13.translations.pcm?.rec as { text?: string } | undefined)?.text);
  await expect(rec).toContainText(pcm.slice(0, 30));
  const acked = await send(page, control(rec, 'acknowledge'), 'acknowledgeScriptRunNode', RUN_AT_REC.id);
  expect(acked.body, 'the acknowledgement carried a time or anything else').toEqual({ revision: RUN_AT_REC.revision, nodeId: 'rec', locale: 'pcm' });
  expect(acked.status).toBe(200);
  await expect(control(rec, 'acknowledge')).toBeChecked();
  await expect(control(rec, 'advance')).toBeEnabled();
  const moved = await send(page, control(rec, 'advance'), 'advanceScriptRun', RUN_AT_REC.id);
  expect(moved.body.revision).toBe(RUN_AT_REC.revision + 1);
  await expect(current(page)).toHaveAttribute('data-step', 'idq');
  await expect(stepOf(page, 'rec')).toHaveAttribute('data-step-state', 'done');
  expect(mock.runs.get(RUN_AT_REC.id)?.acknowledgements.map((entry) => entry.nodeId)).toEqual(['rec']);
});

test('the language switch uses the pinned version’s translations with no request, and says when it falls back @p10-agent @p10-agent-language', async ({ page }) => {
  const mock = await openRun(page, RUN_AT_REC);
  const locales = await shown(screen(page).locator('[data-script-locale]')).evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-script-locale') ?? ''));
  expect([...locales].sort(), 'the languages offered are not the pinned version’s').toEqual(['en', ...Object.keys(VERSION_13.translations)].sort());
  const before = mock.requests.length;
  await shown(screen(page).locator('[data-script-locale="pcm"]')).first().click();
  await expect(current(page)).toContainText(String((VERSION_13.translations.pcm?.rec as { text?: string } | undefined)?.text).slice(0, 30));
  expect(mock.requests.length, 'switching language asked the server').toBe(before);
  await send(page, control(current(page), 'acknowledge'), 'acknowledgeScriptRunNode', RUN_AT_REC.id);
  await send(page, control(current(page), 'advance'), 'advanceScriptRun', RUN_AT_REC.id);
  // idq has no Pidgin text: the source wording, and a translated note saying so.
  await expect(current(page)).toHaveAttribute('data-step', 'idq');
  await expect(current(page)).toContainText(String(v13Node('idq').text).slice(0, 18));
  const fallback = shown(current(page).getByTestId('translation-fallback')).first();
  await expect(fallback).toBeVisible();
  expect(await visibleText(fallback)).not.toBe('');
});

test.describe('P10/02 — a form records answers on the run only (D-P31)', () => {
  test('a missing or out-of-bounds answer is a translated error on its field; the answers go to the run and the run moves on @p10-agent @p10-agent-form', async ({ page }) => {
    const mock = await openRun(page, RUN_AT_FORM);
    const form = current(page);
    await expect(form).toHaveAttribute('data-node-type', 'form');
    expect(await shown(form.locator('[data-field-input="reason"]')).first().evaluate((element) => element.tagName.toLowerCase())).toBe('select');
    expect(await shown(form.locator('[data-field-input="date"]')).first().getAttribute('type')).toBe('date');

    // Required reason left out.
    await fillForm(form, { date: lagosDate(3), amount: '25000' });
    await control(form, 'advance').click();
    await expect(shown(form.locator('[data-field-error="reason"]')).first()).toBeVisible();
    await expect(current(page)).toHaveAttribute('data-step', 'ptp');
    await expect(shown(form.locator('[data-field-input="amount"]')).first()).toHaveValue('25000');
    // Below the field's minimum (₦5,000).
    await fillForm(form, { amount: '3000', reason: 'Salary delayed' });
    await control(form, 'advance').click();
    await expect(shown(form.locator('[data-field-error="amount"]')).first()).toBeVisible();
    await expect(current(page)).toHaveAttribute('data-step', 'ptp');
    expect(mock.runs.get(RUN_AT_FORM.id)?.currentNodeId).toBe('ptp');

    await fillForm(form, { amount: '25000', detail: NEEDLE });
    const advanced = page.waitForResponse((response) => isOperation(response.request(), 'advanceScriptRun', RUN_AT_FORM.id) && response.status() === 200);
    await control(form, 'advance').click();
    await advanced;
    await expect(current(page)).toHaveAttribute('data-step', 'readback');
    const saved = mock.writes.filter((write) => write.operation === 'recordScriptRunAnswers' && write.status === 200);
    expect(saved.length, 'the answers were never recorded on the run').toBeGreaterThan(0);
    for (const write of mock.writes.filter((entry) => entry.operation === 'recordScriptRunAnswers')) {
      expect(keysOf(json(write.body))).toEqual(['nodeId', 'revision', 'values']);
    }
    // Money in minor units as a string, a date as YYYY-MM-DD, a choice by its key (the contract's AnswerValue).
    expect(mock.runs.get(RUN_AT_FORM.id)?.answers.ptp).toMatchObject({
      type: 'form',
      values: { date: lagosDate(3), amount: { amountMinor: '2500000', currency: 'NGN' }, reason: 'salary_delayed', detail: NEEDLE },
    });
    // The read-back fills the answers in, formatted, never as minor units.
    const readback = await visibleText(current(page));
    // `\s` covers the no-break and narrow no-break spaces Intl uses as group separators.
    expect(readback).toMatch(/25[,.\s]?000/);
    expect(readback).not.toContain('2500000');
    // Nothing was written anywhere else: the mock refuses any contact or activity write.
    expect(mock.writes.map((write) => write.operation).filter((operation) => !['recordScriptRunAnswers', 'advanceScriptRun'].includes(operation))).toEqual([]);
    expect(await copyText(screen(page)), 'the screen says the form writes to the record (D-P31)').not.toMatch(/writes? to (the )?record|saved to (the )?(loan )?record|record field/i);
  });
});

test.describe('a stop is a message, never a guess', () => {
  test('a branch on a withheld field stops the run: it says so, offers no next step, and can only be completed @p10-agent @p10-agent-stopped', async ({ page }) => {
    await openRun(page, RUN_STOPPED);
    await expect(screen(page)).toHaveAttribute('data-run-status', 'stopped');
    const stopped = shown(screen(page).getByTestId('run-stopped')).first();
    await expect(stopped).toBeVisible();
    await expect(stopped).toHaveAttribute('data-stop-reason', 'field_withheld');
    await expectSaysOneOf(stopped, labelsEndingWith('.stopped.field_withheld'), 'the field_withheld stop');
    await expect(screen(page).locator('[data-step="intro"], [data-step="payq"]'), 'a side of the branch was guessed').toHaveCount(0);
    await expect(shown(screen(page).locator('[data-action="advance"], [data-choice]'))).toHaveCount(0);
    await expect(control(screen(page), 'complete-run')).toBeEnabled();
    await control(screen(page), 'complete-run').click();
    await expect(sheet(page)).toHaveAttribute('data-outcome', 'completed');
  });

  test('a branch on a field now sensitive stops the run with its own message @p10-agent @p10-agent-stopped', async ({ page }) => {
    await openRun(page, RUN_AT_IDQ, { branch: 'sensitive' });
    const advanced = await send(page, shown(current(page).locator('[data-choice="yes"]')).first(), 'advanceScriptRun', RUN_AT_IDQ.id);
    expect(advanced.status).toBe(200);
    await expect(screen(page)).toHaveAttribute('data-run-status', 'stopped');
    const stopped = shown(screen(page).getByTestId('run-stopped')).first();
    await expect(stopped).toHaveAttribute('data-stop-reason', 'sensitive_field');
    await expectSaysOneOf(stopped, labelsEndingWith('.stopped.sensitive_field'), 'the sensitive_field stop');
    expect(labelsEndingWith('.stopped.sensitive_field')[0], 'the two stops say the same thing').not.toBe(labelsEndingWith('.stopped.field_withheld')[0]);
    await expect(screen(page).locator('[data-step="intro"], [data-step="payq"]')).toHaveCount(0);
  });

  test('a script that opens on a withheld branch starts already stopped @p10-agent @p10-agent-stopped', async ({ page }) => {
    await openContact(page, RECORD_LOCKED.id);
    expect(RECORD_LOCKED.id).toBe(CONTACT_LOCKED.id);
    await shown(page.locator(`${RECORD} [data-action="start-script"]`)).first().click();
    const sent = page.waitForResponse((response) => isOperation(response.request(), 'startScriptRun'));
    await shown(page.locator(`[data-testid="script-menu"] [data-runnable-script="${S_STATUS_CHECK_ID}"]`)).first().click();
    expect((await sent).status()).toBe(201);
    await expect(page).toHaveURL(/\/script-runs\//);
    await expect(screen(page)).toHaveAttribute('data-run-status', 'stopped');
    await expect(shown(screen(page).getByTestId('run-stopped')).first()).toHaveAttribute('data-stop-reason', 'field_withheld');
  });
});

// ===========================================================================
// P10/03 — completion
// ===========================================================================

test.describe('P10/03 — completing the run', () => {
  test('at the end the disposition is chosen from the live list, the suggestion pre-chosen, its note required @p10-agent @p10-agent-disposition', async ({ page }) => {
    const mock = await openRun(page, RUN_AT_END);
    await control(screen(page), 'complete-run').click();
    const dialog = sheet(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    await expect(dialog).toHaveAttribute('data-outcome', 'completed');
    await expect.poll(() => dispositionIds(page), { message: 'the picker is not the served page, in order' }).toEqual(DISPOSITIONS.slice(0, DISPOSITION_PAGE_CAP).map((row) => row.id));
    const suggested = shown(dialog.locator(`[data-disposition="${D_PTP.id}"]`)).first();
    await expect(suggested).toHaveAttribute('data-suggested', 'true');
    await expect(suggested).toHaveAttribute('aria-checked', 'true');
    await expect(suggested).toContainText(D_PTP.label);
    const more = shown(dialog.getByTestId('disposition-more')).first();
    await expect(more, 'a short page was taken as the last').toBeEnabled();
    await more.click();
    await expect.poll(() => dispositionIds(page)).toEqual(DISPOSITIONS.map((row) => row.id));
    expect(await visibleText(dialog), 'a count of dispositions is drawn').not.toMatch(/\b\d+\s+outcomes?\b/i);
    // PTP needs a note: no completion goes out without one.
    const note = shown(dialog.locator('[data-field-input="note"]')).first();
    await expect(note).toBeVisible();
    const writes = mock.writes.length;
    const saveControl = control(dialog, 'save-disposition');
    if (!(await isDisabled(saveControl))) {
      await saveControl.click();
      await expect(shown(dialog.getByRole('alert')).first()).toBeVisible();
    }
    expect(mock.writes.filter((write) => write.operation === 'completeScriptRun' && write.status === 200), 'completed without the required note').toHaveLength(0);
    await note.fill('Promised ₦25,000 by Friday.');
    const done = await send(page, saveControl, 'completeScriptRun', RUN_AT_END.id);
    expect(done.status).toBe(200);
    expect(done.body, 'the completion sent anything but the contract’s fields').toEqual({ revision: RUN_AT_END.revision, outcome: 'completed', dispositionId: D_PTP.id, note: 'Promised ₦25,000 by Friday.' });
    expect(mock.writes.length).toBeGreaterThan(writes);
    await expect(screen(page)).toHaveAttribute('data-run-status', 'completed');
    const summary = shown(screen(page).getByTestId('run-complete')).first();
    await expect(summary).toContainText(D_PTP.label);
    await expectSaysOneOf(summary, labelsEndingWith('.outcome.completed'), 'the completed outcome');
    await expect(shown(screen(page).locator('[data-action="advance"], [data-action="complete-run"], [data-action="end-early"], [data-action="acknowledge"]'))).toHaveCount(0);
    await expectNoIdsAnywhere(page, 'the completed run');
    await expectNoSeriousAxe(page, 'P10/03');
  });

  test('a disposition that needs a callback books it as a time in the browser’s zone, sent in UTC @p10-agent @p10-agent-follow-up', async ({ page }) => {
    await openRun(page, RUN_AT_CALLBACK);
    await control(screen(page), 'complete-run').click();
    const dialog = sheet(page);
    await expect(shown(dialog.locator(`[data-disposition="${D_CALLBACK.id}"]`)).first()).toHaveAttribute('aria-checked', 'true');
    const when = shown(dialog.locator('[data-field-input="followUpAt"]')).first();
    await expect(when).toBeVisible();
    expect(await when.getAttribute('type')).toBe('datetime-local');
    const day = lagosDate(2);
    await when.fill(`${day}T14:30`);
    const done = await send(page, control(dialog, 'save-disposition'), 'completeScriptRun', RUN_AT_CALLBACK.id);
    expect(done.status).toBe(200);
    const followUp = done.body.followUp as { dueAt?: string } | undefined;
    // 14:30 in Lagos (UTC+1) is 13:30 UTC.
    expect(Date.parse(String(followUp?.dueAt)), 'the callback was not sent in UTC from the Lagos time typed').toBe(Date.parse(`${day}T13:30:00Z`));
    expect(String(followUp?.dueAt)).toMatch(/Z$/);
    expect(keysOf(done.body)).toEqual(['dispositionId', 'followUp', 'outcome', 'revision']);
    const summary = shown(screen(page).getByTestId('run-complete')).first();
    await expect(summary).toContainText(D_CALLBACK.label);
    await expect(summary.locator('time[datetime]').first()).toBeVisible();
    expect(await visibleText(summary)).toContain('14:30');
  });

  test('a call cut short completes as interrupted with a mandatory disposition, and the unread statement is said by name @p10-agent @p10-agent-interrupted', async ({ page }) => {
    const mock = await openRun(page, RUN_AT_READBACK);
    await expectNoUsable(shown(screen(page).locator('[data-action="complete-run"]')), '"completed" away from an end node (D-L93)');
    await control(screen(page), 'end-early').click();
    const dialog = sheet(page);
    await expect(dialog).toHaveAttribute('data-outcome', 'interrupted');
    await expect.poll(() => dispositionIds(page)).toEqual(DISPOSITIONS.slice(0, DISPOSITION_PAGE_CAP).map((row) => row.id));
    // No end node, no suggestion: nothing is pre-chosen, and nothing is sent without a choice.
    await expect(dialog.locator('[data-disposition][aria-checked="true"]')).toHaveCount(0);
    const saveControl = control(dialog, 'save-disposition');
    if (!(await isDisabled(saveControl))) {
      await saveControl.click();
      await expect(shown(dialog.getByRole('alert')).first()).toBeVisible();
    }
    expect(mock.writes, 'a completion went out with no disposition').toEqual([]);
    await shown(dialog.locator(`[data-disposition="${D_REFUSED.id}"]`)).first().click();
    const done = await send(page, saveControl, 'completeScriptRun', RUN_AT_READBACK.id);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ revision: RUN_AT_READBACK.revision, outcome: 'interrupted', dispositionId: D_REFUSED.id });
    const summary = shown(screen(page).getByTestId('run-complete')).first();
    await expectSaysOneOf(summary, labelsEndingWith('.outcome.interrupted'), 'the interrupted outcome');
    const unread = shown(summary.locator('[data-unacknowledged="readback"]')).first();
    await expect(unread).toContainText(v13Node('readback').title);
    expect(mock.runs.get(RUN_AT_READBACK.id)?.acknowledgements.map((entry) => entry.nodeId), 'an interrupted run acknowledged something').toEqual(['rec']);
  });

  test('refusals are translated alerts; a 409 re-reads before anything is sent again; 403 keeps the sheet @p10-agent @p10-agent-refusals', async ({ page }) => {
    // A disposition retired since the list was read.
    const retired = await openRun(page, RUN_AT_END, { retireOnComplete: D_PTP.id, query: '?locale=en-XA' });
    await control(screen(page), 'complete-run').click();
    await shown(sheet(page).locator('[data-field-input="note"]')).first().fill('Promised by Friday.');
    const lost = await send(page, control(sheet(page), 'save-disposition'), 'completeScriptRun', RUN_AT_END.id);
    expect(lost.status).toBe(409);
    const alert = shown(sheet(page).getByRole('alert')).first();
    await expect(alert).toBeVisible();
    expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect.poll(() => retired.calledTimes('listScriptRunDispositions'), { message: 'the picker was not re-read' }).toBeGreaterThanOrEqual(2);
    await expect(sheet(page).locator(`[data-disposition="${D_PTP.id}"]`), 'a retired disposition is still offered').toHaveCount(0);
    await shown(sheet(page).locator(`[data-disposition="${D_ESCALATE.id}"], [data-disposition="${D_REFUSED.id}"]`)).first().click();
    await closeRun(page);

    // Another tab moved the run on: re-read, then the agent saves again with the fresh revision.
    const stale = await openRun(page, RUN_AT_END, { staleRun: 'complete' });
    await control(screen(page), 'complete-run').click();
    await shown(sheet(page).locator('[data-field-input="note"]')).first().fill('Promised by Friday.');
    expect((await send(page, control(sheet(page), 'save-disposition'), 'completeScriptRun', RUN_AT_END.id)).status).toBe(409);
    await expect(shown(sheet(page).getByRole('alert')).first()).toBeVisible();
    await expect.poll(() => stale.calledTimes('getScriptRun'), { message: 'the run was not re-read after the 409' }).toBeGreaterThanOrEqual(2);
    expect(stale.writes.filter((write) => write.operation === 'completeScriptRun'), 'the completion was retried blind').toHaveLength(1);
    const won = await send(page, control(sheet(page), 'save-disposition'), 'completeScriptRun', RUN_AT_END.id);
    expect(won.status).toBe(200);
    expect(won.body.revision).toBe(RUN_AT_END.revision + 1);
    await closeRun(page);

    // No activity.write: the one run 403. The sheet and what was typed are kept.
    await openRun(page, RUN_AT_END, { noActivityWrite: true });
    await control(screen(page), 'complete-run').click();
    await shown(sheet(page).locator('[data-field-input="note"]')).first().fill('Promised by Friday.');
    expect((await send(page, control(sheet(page), 'save-disposition'), 'completeScriptRun', RUN_AT_END.id)).status).toBe(403);
    await expect(shown(sheet(page).getByRole('alert')).first()).toBeVisible();
    await expect(sheet(page)).toBeVisible();
    await expect(shown(sheet(page).locator('[data-field-input="note"]')).first()).toHaveValue('Promised by Friday.');
    await expect(screen(page)).toHaveAttribute('data-run-status', 'in_progress');
  });

  test('a completion whose answer was lost is sent again exactly as it was, and its 200 is a success, not an error @p10-agent @p10-agent-repeat', async ({ page }) => {
    const mock = await openRun(page, RUN_AT_END, { loseCompletionAnswer: true });
    await control(screen(page), 'complete-run').click();
    await shown(sheet(page).locator('[data-field-input="note"]')).first().fill('Promised by Friday.');
    const first = page.waitForRequest((request) => isOperation(request, 'completeScriptRun', RUN_AT_END.id));
    await control(sheet(page), 'save-disposition').click();
    const sentFirst = json((await first).postDataJSON());
    // The answer never arrived: the screen cannot know it worked, and says so.
    await expect(alerts(page).first()).toBeVisible();
    await expect(screen(page)).not.toHaveAttribute('data-run-status', 'completed');
    const retry = await send(page, control(sheet(page), 'save-disposition'), 'completeScriptRun', RUN_AT_END.id);
    expect(retry.body, 'the retry is not the exact repeat of the lost request').toEqual(sentFirst);
    expect(retry.status).toBe(200);
    await expect(screen(page)).toHaveAttribute('data-run-status', 'completed');
    await expect(shown(screen(page).getByTestId('run-complete')).first()).toContainText(D_PTP.label);
    await expect(alerts(page), 'the repeat’s 200 was shown as an error').toHaveCount(0);
    expect(mock.writes.filter((write) => write.operation === 'completeScriptRun')).toHaveLength(2);
  });

  test('a completed run opens as its summary, with nothing left to do @p10-agent @p10-agent-disposition', async ({ page }) => {
    const mock = await openRun(page, RUN_COMPLETED);
    await expect(screen(page)).toHaveAttribute('data-run-status', 'completed');
    await expect(shown(screen(page).getByTestId('run-complete')).first()).toContainText(D_PTP.label);
    await expect(shown(screen(page).locator('[data-action="advance"], [data-action="complete-run"], [data-action="end-early"], [data-action="acknowledge"], [data-choice]'))).toHaveCount(0);
    expect(mock.writes).toEqual([]);
  });
});

// ===========================================================================
// The version banner, not-found, loading
// ===========================================================================

test('a run on an older version says it finishes on its own version; one on the latest says nothing @p10-agent @p10-agent-banner', async ({ page }) => {
  await openRun(page, RUN_RESUME);
  const banner = shown(screen(page).getByTestId('version-banner')).first();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(`${RUN_RESUME.versionNumber}`);
  await expect(banner).toContainText(`${VERSION_13.number}`);
  await closeRun(page);
  await openRun(page, RUN_FRESH);
  await expect(shown(screen(page).getByTestId('version-banner'))).toHaveCount(0);
});

test('another agent’s run and no run are the same generic not-found; a non-uuid is a real 404 that reads nothing @p10-agent @p10-agent-not-found', async ({ page }) => {
  const mock = await install(page);
  const title = EN['notFound.title'] ?? '<notFound.title>';
  const headings: string[] = [];
  for (const id of [RUN_OTHER_AGENT.id, NO_SUCH_ID, 'not-a-uuid']) {
    const before = mock.requests.length;
    const response = await page.goto(`${scriptsUrl()}/script-runs/${id}`);
    const status = response?.status() ?? 0;
    if (UUID.test(id)) {
      expect([200, 404]).toContain(status);
      if (status === 200) await expect(shown(page.getByTestId('record-not-found')).first()).toBeVisible();
      await expect.poll(() => mock.requests.slice(before).some((url) => url.pathname === `/api/v1/script-runs/${id}`), { message: `/script-runs/${id} never asked the API` }).toBe(true);
    } else {
      expect(status, 'a malformed id is not a real 404').toBe(404);
      expect(mock.requests.slice(before).filter((url) => url.pathname.startsWith('/api/v1/script-runs')), 'a malformed id reached the API').toEqual([]);
    }
    const h1 = shown(page.getByRole('heading', { level: 1 })).first();
    await expect(h1).toHaveText(title);
    expect(await visibleText(page.locator('body')), 'the not-found page names whose run it is').not.toContain(RUN_OTHER_AGENT.startedBy.displayName);
    await expect(page.locator('[data-step], [data-action="advance"], [data-action="complete-run"]')).toHaveCount(0);
    await expectNoIdsAnywhere(page, `the not-found page for ${id}`);
    headings.push(await visibleText(h1));
  }
  expect(new Set(headings).size).toBe(1);
  expect(mock.writes).toEqual([]);
});

test.describe('loading and a failed read', () => {
  test('loading draws the skeleton, never not-found or a step, until the run arrives @p10-agent @p10-agent-loading', async ({ page }) => {
    const mock = await openRun(page, RUN_RESUME, { hold: true, state: 'loading' });
    try {
      expect(await shown(screen(page).getByTestId('run-skeleton')).count(), 'no skeleton').toBeGreaterThan(0);
      await expect(page.getByTestId('record-not-found')).toHaveCount(0);
      await expect(screen(page).locator('[data-step]')).toHaveCount(0);
    } finally {
      mock.release();
    }
    await expect(screen(page)).toHaveAttribute('data-run-state', 'ready');
    await expect(current(page)).toHaveAttribute('data-step', 'payq');
  });

  test('a failed read says the server could not be reached, never "not found" @p10-agent @p10-agent-loading', async ({ page }) => {
    await install(page, { networkFailure: true });
    await page.goto(`${scriptsUrl()}/script-runs/${RUN_RESUME.id}`);
    await expect(shown(page.getByTestId('record-unavailable')).first()).toBeVisible();
    await expect(page.getByTestId('record-not-found')).toHaveCount(0);
  });
});

// ===========================================================================
// Answers stay off the device and out of the logs; offline writes nothing
// ===========================================================================

test('answers never reach device storage, the address bar, the title or the console @p10-agent @p10-agent-device', async ({ page }) => {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(message.text()));
  page.on('pageerror', (error) => logged.push(`${error.message}\n${error.stack ?? ''}`));
  await openRun(page, RUN_AT_FORM);
  await fillForm(current(page), { date: lagosDate(3), amount: '25000', reason: 'Salary delayed', detail: NEEDLE });
  const advanced = page.waitForResponse((response) => isOperation(response.request(), 'advanceScriptRun', RUN_AT_FORM.id) && response.status() === 200);
  await control(current(page), 'advance').click();
  await advanced;
  await expect(current(page)).toHaveAttribute('data-step', 'readback');
  const stored = await deviceStorage(page);
  expect(stored.cachedApi, 'a run was put in Cache Storage').toEqual([]);
  for (const needle of [NEEDLE, '2500000', 'salary_delayed', String(v13Node('readback').text).slice(0, 30)]) {
    expect(stored.dump.includes(needle), `"${needle}" was written to device storage`).toBe(false);
    expect(logged.join('\n').includes(needle), `"${needle}" was written to the console`).toBe(false);
    expect(decodeURIComponent(page.url()).includes(needle), `"${needle}" is in the address bar`).toBe(false);
  }
  expect(await page.title()).not.toContain(NEEDLE);
});

test('offline keeps the run in memory, disables every write, and sends nothing on reconnecting @p10-agent @p10-agent-offline', async ({ page }) => {
  const mock = await openRun(page, RUN_AT_FORM);
  await fillForm(current(page), { date: lagosDate(3), amount: '25000', detail: NEEDLE });
  const writeControls = shown(screen(page).locator('[data-action="advance"], [data-action="end-early"], [data-action="acknowledge"], [data-choice]'));
  expect(await writeControls.count()).toBeGreaterThan(0);
  for (const entry of await writeControls.all()) {
    await expect(entry).toHaveAttribute('data-requires-connection', /.*/);
  }
  await page.context().setOffline(true);
  try {
    await expect(shown(page.getByTestId('offline-banner')).first()).toBeVisible();
    const needsConnection = page.locator('[data-requires-connection]');
    const count = await needsConnection.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      expect(await isDisabled(needsConnection.nth(index)), `a control that needs a connection is enabled offline (#${index})`).toBe(true);
    }
    await expect(current(page)).toHaveAttribute('data-step', 'ptp');
    const stored = await deviceStorage(page);
    expect(stored.dump.includes(NEEDLE), 'a typed answer was put on the device to send later').toBe(false);
  } finally {
    await page.context().setOffline(false);
  }
  await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);
  await expect(shown(current(page).locator(`[data-field-input="${DETAIL_FIELD.key}"]`)).first()).toHaveValue(NEEDLE);
  expect(mock.writes, 'a write was sent offline, or queued and sent on reconnecting').toEqual([]);
});

// ===========================================================================
// Hidden until M09, M17 and D-P31's later grant (D-L88)
// ===========================================================================

test('no call bar, wrap-up, agent state, AI, SMS, calling hours, team queue, record panel or loan data @p10-agent @p10-agent-hidden', async ({ page }) => {
  await openRun(page, RUN_AT_END);
  const said = [await copyText(screen(page))];
  await control(screen(page), 'complete-run').click();
  said.push(await copyText(sheet(page)));
  const text = said.join(' ');
  expect(text, 'a call bar is drawn (M09)').not.toMatch(/on call\b|\bmute\b|\bhold\b|\brecording\b|\btransfer\b/i);
  expect(text, 'a wrap-up timer or agent state is drawn (M09)').not.toMatch(/wrap[- ]up|overtime|extend|\bready\b|save & ready/i);
  expect(text, 'AI is drawn (M17)').not.toMatch(/\bAI\b|regenerate/);
  expect(text, 'an SMS reminder, calling hours or a team queue is drawn').not.toMatch(/\bSMS\b|calling hours|team queue|assign to/i);
  expect(text, 'the record panel is drawn (D-P31)').not.toMatch(/writes? to (the )?record|loan record|ptp_\w+/i);
  expect(text, 'loan data is drawn').not.toMatch(/\bloan\b|days past due|KD-\d+/i);
  await expect(page.locator('[aria-hidden="true"]', { hasText: /^\s*(auto_awesome|mic|pause|call_end|timer)\s*$/ })).toHaveCount(0);
});

// ===========================================================================
// Mobile, i18n, budget
// ===========================================================================

test('at 360px the run fits without sideways scroll and passes axe @p10-agent @p10-agent-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openRun(page, RUN_AT_FORM);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 'the run scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P10/02 at 360px');
});

test('locale=en-XA renders every run string as pseudo text, script wording and served data excepted @p10-agent @p10-agent-pseudo', async ({ page }) => {
  await openRun(page, RUN_AT_END, { query: '?locale=en-XA' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await control(screen(page), 'complete-run').click();
  await expect(sheet(page)).toBeVisible();
  const report = await page.locator('body').evaluate((root, servedJson) => {
    const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
    const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
    const skipped = (element: Element | null) =>
      element === null || element.closest('[aria-hidden="true"], [data-testid^="language-"], script, style, noscript, time, [data-script-text]') !== null;
    const english: string[] = [];
    const forged: string[] = [];
    let pseudoCount = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim();
      const parent = node.parentElement;
      if (!letters(text) || skipped(parent)) continue;
      if (parent?.closest('[data-record-text]')) {
        if (!servedJson.includes(text)) forged.push(text);
        continue;
      }
      if (pseudo(text)) pseudoCount += 1;
      else english.push(text);
    }
    for (const element of Array.from(root.querySelectorAll('[placeholder], [aria-label], [title]'))) {
      if (skipped(element)) continue;
      for (const name of ['placeholder', 'aria-label', 'title']) {
        const value = element.getAttribute(name);
        if (value !== null && letters(value) && !pseudo(value)) english.push(`${name}="${value}"`);
      }
    }
    return { english, forged, pseudoCount };
  }, servedData());
  expect(report.english, 'strings on the run that did not come through i18n').toEqual([]);
  expect(report.forged, 'UI copy marked data-record-text that is not served data').toEqual([]);
  expect(report.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(10);
});

test.describe('/script-runs/[runId] on the wire', () => {
  /**
   * WHY 245,000 BYTES, BEFORE THE SCREEN EXISTS
   *
   * The lead's provisional figure, the ceiling T-0062 and T-0063 were given
   * on the same reasoning: the same shell, fonts and API client as
   * /contacts/[id] (236,000 B budget). The run screen draws steps, a form and
   * a disposition sheet, and has no timeline or edit sheet. The acceptance
   * suite requires it re-pinned within 5% of the first measurement.
   */
  test('/script-runs/[runId] stays inside its transferred-byte budget on the production build @p10-agent @p10-agent-budget', async ({ page }) => {
    active = await installScriptingMock(page, { world: 'agent' });
    const metrics = await measurePageLoad(page, `${scriptsUrl()}/script-runs/${RUN_RESUME.id}`, 'default');
    const file = resolve(__dirname, '.artifacts', 'p10-agent-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ path: '/script-runs/[runId]', transferredBytes: metrics.transferredBytes, budget: SCRIPT_RUN_BUDGET_BYTES }, null, 2)}\n`, 'utf8');
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webScriptsUrl is not serving the production build').toBe(built);
    await expect(screen(page)).toBeVisible();
    expect(SCRIPT_RUN_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P10/01 the agent script screen', metrics.transferredBytes, SCRIPT_RUN_BUDGET_BYTES);
  });

  test('/script-runs/[runId] paints within 5 s at 256 kbps and 300 ms @p10-agent @p10-agent-budget', async ({ page }) => {
    active = await installScriptingMock(page, { world: 'agent' });
    const metrics = await measurePageLoad(page, `${scriptsUrl()}/script-runs/${RUN_RESUME.id}`, 'low-bandwidth');
    await expect(screen(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
