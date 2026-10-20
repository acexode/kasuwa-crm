import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  ADMIN,
  ALL_SCRIPTS,
  CONDITION_OPERATORS,
  CONDITION_SOURCES,
  CONTACT_FIELDS,
  CRB_TITLE,
  DEFAULT_GRAPH,
  D_PTP,
  FORM_FIELD_TYPES,
  HOSTILE_NAME,
  HOSTILE_TEXT,
  HOSTILE_TITLE,
  MAIN_VERSIONS,
  NEW_SCRIPT_ID,
  NODE_TYPES,
  NO_SUCH_ID,
  OTHER_GREET_TEXT,
  OTHER_NAME,
  OTHER_PAYQ_TITLE,
  OUT_OF_SCOPE_SCRIPT_ID,
  PROGRAMME_ONE,
  PROGRAMME_TWO,
  SCRIPT_LOCALES,
  SCRIPT_PAGE_CAP,
  S_HARDSHIP,
  S_SURVEY,
  S_HOSTILE,
  S_KYC,
  S_MAIN,
  S_WELCOME,
  VARIABLE_PATTERN,
  VERSION_12,
  VERSION_PAGE_CAP,
  V12_READBACK_TEXT,
  answerProblems,
  installScriptingMock,
  isOperation,
  servedData,
  type Graph,
  type GraphNode,
  type ScriptingMock,
  type ScriptingMockOptions,
} from './support/scripting-mock';

/**
 * T-0115 — the P10 script builder (frame P10/05), behind `crm_scripts`, for
 * the admin set (`script.write`, which also edits compliance wording, D-P32).
 * Written by the lead's QA agent BEFORE the screen exists;
 * `tests/acceptance/scripting-ui/script-builder.acceptance.test.ts` runs this
 * file with `--grep @p10-builder` and reads every outcome by tag.
 * Decisions: D-L88, D-L91, D-L93, D-L96, D-P32, D-L97, D-L102.
 *
 * TAG RULE (D-L84). `@p10-builder` is the parent tag. No other screen's tag
 * contains it, and it contains no other screen's parent tag (`@p10-agent`
 * included, both ways). Every sub-tag here is `@p10-builder-<name>`.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTES AND THE WEB PROCESS
 *
 *   /scripts               the caller's scripts (P10/05, list)
 *   /scripts/<scriptId>    the editor for one script's draft (P10/05)
 *
 *   webUrl         — the default server, every flag at its default. Both
 *                    routes must be a real 404 there.
 *   webScriptsUrl  — a web process with `crm_scripts` ON (the builder adds it
 *                    to run-e2e.mjs, as T-0062 added `webRecordViewUrl`; it
 *                    may be the records process under another name). Every
 *                    journey and the byte budget run there, on the
 *                    production build.
 *
 * EVERY READ AND WRITE GOES THROUGH THE CONTRACT MOCK
 *
 * Every journey installs `support/scripting-mock.ts` (world `builder`), which
 * serves the eight authoring operations, listMyProgrammes, getCurrentUser and
 * admin's listProgrammeDispositions from the contracts, and checks every
 * answer it gives against them. `afterEach` fails a test in which the screen
 * sent anything the contract does not declare (the mock's header lists what),
 * left the origin, or in which the mock answered something its own contract
 * rejects.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                       the CRM shell (T-0042)
 *   [data-screen="P10/05"]                   the builder root, carrying
 *     data-builder-view="list|editor|version"
 *     data-builder-state="loading|ready"
 *     data-unpublished="true|false"          (editor) the script's
 *                                            `hasUnpublishedChanges`
 *     data-read-only="true"                  while a version is shown
 *   h1                                       the screen's title (the script's
 *                                            name in the editor)
 *   [data-testid="builder-skeleton"], [data-testid="record-not-found"],
 *   [data-testid="record-unavailable"]
 *   LIST
 *   [data-testid="script-list"]
 *     [data-script-row="<script id>"]        one row, in served order, holding
 *       a[href="/scripts/<id>"]              a link to its editor,
 *       [data-script-state="draft|published"] and data-unpublished="true|false"
 *   [data-testid="script-list-more"], [data-testid="script-list-empty"]
 *   [data-action="new-script"]               opens
 *   [data-testid="script-create"]            role=dialog, with
 *     [data-field-input="name|programmeId|sourceLocale"] (programme and
 *     locale are <select>s), [data-action="create-script"], [role="alert"]
 *   EDITOR
 *   [data-field-input="script-name"]         the draft's name
 *   [data-testid="script-canvas"]
 *     [data-node="<node id>"]                one node, carrying
 *       data-node-type="<type>", data-invalid="true" after a refused publish
 *   [data-action="add-node"][data-node-type="<type>"]  the palette
 *   [data-testid="node-inspector"]           the selected node, carrying
 *     data-inspecting="<node id>", holding [data-field-input="…"]:
 *       title, text, hint, next                (say, question, form, compliance)
 *       choice-label, choice-next in each [data-choice-row]; [data-action="add-choice"]
 *       condition-source, condition-field, condition-operator, condition-value,
 *       condition-node, whenTrue, whenFalse    (branch; all but value are <select>s)
 *       form-field-label, form-field-type, form-field-required in each
 *       [data-form-field-row]; [data-action="add-form-field"]
 *       suggestedDispositionId                 (end; a <select> of live dispositions)
 *       translation-text                       (while a locale tab is selected)
 *     [data-action="insert-variable"][data-variable="<variable>"]
 *     [data-testid="changed-elsewhere"]      the D-L102 "changed by someone else"
 *   [data-action="save-draft"], [data-action="publish"]
 *   [data-testid="publish-dialog"]           role=dialog, with
 *     [data-field-input="publish-change"], [data-action="confirm-publish"]
 *   [data-locale-tab="<locale>"]             a translation tab
 *   [data-testid="compliance-diff"]          the draft against the latest
 *     [data-compliance-diff="added|changed|removed"]   version, by node title
 *   [data-action="versions"]                 opens the version list,
 *     [data-version-row="<version id>"]      newest first, and
 *     [data-testid="version-list-more"]
 *   [data-action="back-to-draft"]
 *   [role="alert"] on the screen             a refused save or publish
 *   [data-requires-connection]               on every write control
 *   [data-testid="offline-banner"]
 *   [data-script-text]                       script wording (author content)
 *   [data-record-text]                       served data that is not wording
 *                                            (programme and people's names)
 *
 * PINNED INTERFACES BEYOND THE HOOKS (the rulings in the acceptance header)
 *
 *   - Saves are explicit (the save control), never automatic, and send
 *     `revision` plus ONLY the top-level fields that changed (D-L102). After
 *     a 409 the screen re-reads and re-applies the person's edits node by
 *     node; an untouched field is never sent, and a field both people changed
 *     keeps the typed value with a "changed by someone else" note.
 *   - A node added from the palette is shape-valid as soon as it is added
 *     (a question has two choices, a form one field, a branch a condition),
 *     so a save right away sends a graph the API accepts.
 *   - Publish is offered only with no unsaved edit and `hasUnpublishedChanges`.
 *   - A branch condition's field is chosen from a list of Contact wire names,
 *     each shown by a label; the operator from the contract's operators.
 *   - Times are shown in the browser's zone. This file runs in Africa/Lagos.
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS
 *
 *   - One programme per script (D-L91): no "Assigned to", no "Publish to 2
 *     programmes".
 *   - Form fields write nothing to the record (D-P31): no "writes ptp_date",
 *     no field binding, and the design's form description ("Fields that write
 *     to the record") is not used.
 *   - No compliance approver (D-P32 is the admin set): no "Lock text – Only
 *     Compliance role can edit", no "Legal-approved".
 *   - Not in Phase 2 (D-L88): AI next-line suggestions, QA flags, "Open
 *     disposition on hang-up", `loan.*` and the design's other variables,
 *     and the "Preview as agent" sample record.
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P10/05"]';

/**
 * The /scripts/[scriptId] transferred-byte budget. The acceptance suite holds
 * it at or under 260,000 bytes and within 5% of what this run measures, so
 * re-pin it to the measurement once the screen exists. Why 260,000: see the
 * budget test.
 */
const SCRIPT_BUILDER_BUDGET_BYTES = 292_500;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

test.use({ timezoneId: 'Africa/Lagos' });

let active: ScriptingMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults, 'the MOCK answered something its contract rejects (a mock bug, not the screen’s)').toEqual([]);
    expect(mock.violations, 'the screen sent the scripting API something the contract does not declare').toEqual([]);
    if (mock.requests.length > 0) {
      const origin = new URL(scriptsUrl()).origin;
      for (const url of mock.requests) {
        expect(url.origin, 'the builder must call the API same-origin, by a relative path').toBe(origin);
      }
    }
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

function canvasNode(page: Page, id: string): Locator {
  return shown(screen(page).locator(`[data-testid="script-canvas"] [data-node="${id}"]`)).first();
}

function inspector(page: Page): Locator {
  return shown(screen(page).getByTestId('node-inspector')).first();
}

function input(scope: Locator, name: string): Locator {
  return shown(scope.locator(`[data-field-input="${name}"]`)).first();
}

function control(page: Page, action: string): Locator {
  return shown(screen(page).locator(`[data-action="${action}"]`)).first();
}

/** The builder's own alerts (the screen or its dialogs), never Next's route announcer. */
function alerts(page: Page): Locator {
  return shown(page.locator(`${SCREEN} [role="alert"], [data-testid="publish-dialog"] [role="alert"], [data-testid="script-create"] [role="alert"]`));
}

function heading(page: Page): Locator {
  return shown(screen(page).getByRole('heading', { level: 1 })).first();
}

async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** UI copy only: script wording and served data removed. */
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

/** No UUID a person can see or hear (ids in data-*, href and values of <option> are not printed). */
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

type BuilderOptions = Omit<ScriptingMockOptions, 'world'> & { query?: string; state?: 'loading' | 'ready'; status?: number };

async function install(page: Page, options: Omit<ScriptingMockOptions, 'world'> = {}): Promise<ScriptingMock> {
  const mock = await installScriptingMock(page, { world: 'builder', ...options });
  active = mock;
  return mock;
}

async function openList(page: Page, options: BuilderOptions = {}): Promise<ScriptingMock> {
  const mock = await install(page, options);
  const response = await page.goto(`${scriptsUrl()}/scripts${options.query ?? ''}`);
  expect(response?.status(), '/scripts with crm_scripts on').toBe(200);
  await expect(screen(page)).toBeVisible();
  await expect(screen(page)).toHaveAttribute('data-builder-view', 'list');
  await expect(screen(page)).toHaveAttribute('data-builder-state', options.state ?? 'ready');
  return mock;
}

async function openEditor(page: Page, id: string, options: BuilderOptions = {}): Promise<ScriptingMock> {
  const mock = await install(page, options);
  const response = await page.goto(`${scriptsUrl()}/scripts/${id}${options.query ?? ''}`);
  expect(response?.status(), `/scripts/${id} with crm_scripts on`).toBe(options.status ?? 200);
  await expect(screen(page)).toBeVisible();
  await expect(screen(page)).toHaveAttribute('data-builder-state', options.state ?? 'ready');
  if ((options.state ?? 'ready') === 'ready') {
    await expect(screen(page)).toHaveAttribute('data-builder-view', 'editor');
  }
  return mock;
}

async function closeScreen(page: Page): Promise<void> {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults).toEqual([]);
    expect(mock.violations).toEqual([]);
  }
}

async function selectNode(page: Page, id: string): Promise<Locator> {
  await canvasNode(page, id).click();
  const panel = inspector(page);
  await expect(panel, `selecting ${id} shows no inspector`).toBeVisible();
  await expect(panel).toHaveAttribute('data-inspecting', id);
  return panel;
}

function json(body: unknown): Record<string, unknown> {
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the write body is not an object').toBe(true);
  return body as Record<string, unknown>;
}

function keysOf(body: Record<string, unknown>): string[] {
  return Object.keys(body).sort();
}

function graphOf(body: Record<string, unknown>): Graph {
  expect(typeof body.graph === 'object' && body.graph !== null, 'no graph was sent').toBe(true);
  return body.graph as Graph;
}

function nodeIn(graph: Graph, id: string): GraphNode {
  const found = graph.nodes.find((entry) => entry.id === id);
  expect(found, `the sent graph has no ${id} node`).toBeDefined();
  return found ?? { id, type: 'end', title: '' };
}

/** Click save and return the updateScript request and its answer. */
async function save(page: Page, scriptId: string): Promise<{ body: Record<string, unknown>; status: number }> {
  const answered = page.waitForResponse((response) => isOperation(response.request(), 'updateScript', scriptId));
  await control(page, 'save-draft').click();
  const response = await answered;
  return { body: json(response.request().postDataJSON()), status: response.status() };
}

async function optionValues(select: Locator): Promise<string[]> {
  return select.evaluate((element) => Array.from((element as HTMLSelectElement).options).map((option) => option.value).filter((value) => value !== ''));
}

async function optionTexts(select: Locator): Promise<string[]> {
  return select.evaluate((element) => Array.from((element as HTMLSelectElement).options).map((option) => (option.textContent ?? '').trim()));
}

async function tagName(locator: Locator): Promise<string> {
  return locator.evaluate((element) => element.tagName.toLowerCase());
}

/** Everything a draft could leave on the device. */
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

async function renderedRowIds(page: Page): Promise<string[]> {
  return shown(screen(page).locator('[data-script-row]')).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-script-row') ?? ''));
}

async function canvasIds(page: Page): Promise<string[]> {
  return shown(screen(page).locator('[data-testid="script-canvas"] [data-node]')).evaluateAll((nodes) =>
    nodes.map((entry) => entry.getAttribute('data-node') ?? ''),
  );
}

function draftNode(id: string): GraphNode {
  const found = S_MAIN.draft.graph.nodes.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`S_MAIN's draft has no ${id}`);
  return found;
}

const NEW_TITLE = 'Able to pay today?';

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract refuses, and checks its own answers @p10-builder @p10-builder-mock', async ({ page }) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (sign-in on the default server) and
  // watch every malformed request land in `violations`. No `active` mock:
  // the violations here are deliberate and counted explicitly.
  const { webUrl } = stack();
  const mock = await installScriptingMock(page, { world: 'builder' });
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
  const script = (id: string, tail = '') => `/api/v1/scripts/${id}${tail}`;

  // Served as the contract says.
  await call('/api/v1/me/programmes');
  const first = await call('/api/v1/scripts');
  expect((first.body.data as { id: string }[]).map((row) => row.id)).toEqual(ALL_SCRIPTS.slice(0, SCRIPT_PAGE_CAP).map((row) => row.id));
  const cursor = String(first.body.nextCursor);
  const second = await call(`/api/v1/scripts?cursor=${encodeURIComponent(cursor)}&limit=50`);
  expect((second.body.data as { id: string }[]).map((row) => row.id)).toEqual(ALL_SCRIPTS.slice(SCRIPT_PAGE_CAP).map((row) => row.id));
  expect(second.body.nextCursor).toBeNull();
  const main = await call(script(S_MAIN.id));
  expect(main.status).toBe(200);
  expect(main.body.revision).toBe(S_MAIN.revision);
  const outside = await call(script(OUT_OF_SCOPE_SCRIPT_ID));
  const missing = await call(script(NO_SUCH_ID));
  expect(outside.status).toBe(404);
  expect(JSON.stringify(outside.body), 'out of scope and missing answer differently').toBe(JSON.stringify(missing.body));
  expect((await call(script('not-a-uuid'))).status).toBe(400);
  const versions = await call(script(S_MAIN.id, '/versions'));
  expect((versions.body.data as { number: number }[]).map((row) => row.number)).toEqual(MAIN_VERSIONS.slice(0, VERSION_PAGE_CAP).map((row) => row.number));
  expect((await call(script(S_MAIN.id, `/versions/${VERSION_12.id}`))).status).toBe(200);
  const dispositions = await call(`/api/v1/admin/programmes/${PROGRAMME_ONE.id}/dispositions`);
  expect((dispositions.body.items as { id: string }[]).map((row) => row.id)).toContain(D_PTP.id);
  expect(mock.violations, 'a well-formed request was recorded as a violation').toEqual([]);

  // Refused, and blamed on the screen.
  await expectViolation('/api/v1/scripts?cursor=forged', 'GET', undefined, 400, /echoed, not built/);
  await expectViolation('/api/v1/scripts?programmeId=x', 'GET', undefined, 400, /no "programmeId"/);
  await expectViolation('/api/v1/scripts?limit=0', 'GET', undefined, 400, /outside 1\.\.100/);
  await expectViolation(script(S_MAIN.id), 'GET', undefined, 200, /scope is never supplied/, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id });
  await expectViolation(script(S_MAIN.id), 'PATCH', { revision: S_MAIN.revision }, 200, /nothing that changed/);
  // That 200 moved the revision on (the mock applies what the API would); re-read it.
  const revision = Number((await call(script(S_MAIN.id))).body.revision);
  await expectViolation(script(S_MAIN.id), 'PATCH', { revision, name: S_MAIN.name }, 200, /unchanged from what the screen was last served/);
  const revision2 = Number((await call(script(S_MAIN.id))).body.revision);
  await expectViolation(script(S_MAIN.id), 'PATCH', { revision: 7, name: 'X' }, 409, /revision 7/);
  await expectViolation(script(S_MAIN.id), 'PATCH', { revision: revision2, name: 'Y', programmeId: PROGRAMME_TWO.id }, 400, /closed body/);
  const bound: Graph = {
    startNodeId: 'f',
    nodes: [
      { id: 'f', type: 'form', title: 'F', text: 'T', next: 'e', fields: [{ key: 'k', label: 'K', type: 'text', required: true, writesTo: 'status' }] },
      { id: 'e', type: 'end', title: 'E' },
    ],
  };
  await expectViolation(script(S_MAIN.id), 'PATCH', { revision: revision2, graph: bound }, 400, /writesTo is not a property of this closed body/);
  await expectViolation(script(S_MAIN.id), 'PATCH', { revision: revision2, graph: { startNodeId: 'a', nodes: [{ id: 'a', type: 'disposition', title: 'A' }] } }, 400, /not one of say, question/);
  await expectViolation(script(S_MAIN.id), 'PATCH', { revision: revision2, graph: { startNodeId: 'a', nodes: [{ id: 'a', type: 'end', title: 'A' }, { id: 'a', type: 'end', title: 'B' }] } }, 400, /repeats node ids/);
  await expectViolation(script(S_MAIN.id, '/translations/en'), 'PUT', { revision: revision2, texts: {} }, 400, /source locale/);
  await expectViolation(script(S_MAIN.id, '/translations/pcm'), 'PUT', { revision: revision2, texts: { nowhere: { text: 'x' } } }, 400, /names no node/);
  await expectViolation(script(S_MAIN.id, `/versions/${String(MAIN_VERSIONS[9]?.id)}`), 'GET', undefined, 200, /never served/);
  await expectViolation('/api/v1/script-runs', 'POST', { scriptId: S_MAIN.id, contactId: NO_SUCH_ID }, 404, /not an operation the script builder uses/);
  await expectViolation('/api/v1/contacts/3f0c9a52-6d1e-4b8a-9f2e-1a2b3c4d5e01', 'PATCH', { version: 3, status: 'customer' }, 404, /not an operation/);
  await expectViolation('/api/v1/scripts', 'POST', { programmeId: PROGRAMME_ONE.id, name: 'N', sourceLocale: 'xx' }, 400, /sourceLocale is not one of/);
  expect(mock.violations.length, 'the refusals above were not all recorded, or one was recorded twice').toBe(17);
  expect(mock.mockFaults, 'an answer the mock gave was rejected by its own contract').toEqual([]);

  // The mock checks its own answers: a planted body the contract rejects is caught.
  const served = (await call(script(S_MAIN.id))).body;
  expect(answerProblems('getScript', 200, { ...served, approvedBy: ADMIN }).join('\n'), 'a Script with an approver passed').toMatch(/approvedBy/);
  expect(answerProblems('listScripts', 200, { data: [], nextCursor: null, total: 6 }).join('\n')).toMatch(/total/);
  const formWithBinding = { ...served, draft: { graph: bound, translations: {} } };
  expect(answerProblems('getScript', 200, formWithBinding).join('\n'), 'a form field bound to a CRM field passed').toMatch(/writesTo/);
  const versionless = Object.fromEntries(Object.entries(VERSION_12).filter(([key]) => key !== 'changes'));
  expect(answerProblems('getScriptVersion', 200, versionless).join('\n')).toMatch(/changes is required/);
  expect(answerProblems('getScript', 403, { statusCode: 403 }).join('\n')).toMatch(/declares no 403/);
  expect(answerProblems('getScript', 200, S_MAIN)).toEqual([]);
  expect(answerProblems('getScriptVersion', 200, VERSION_12)).toEqual([]);

  // Well-formed writes apply.
  const writes = await installScriptingMock(page, { world: 'builder' });
  await call('/api/v1/me/programmes');
  const fresh = await call(script(S_MAIN.id));
  const renamed = await call(script(S_MAIN.id), 'PATCH', { revision: fresh.body.revision, name: 'Collections – PTP' });
  expect(renamed.status).toBe(200);
  expect(renamed.body.revision).toBe(Number(fresh.body.revision) + 1);
  const translated = await call(script(S_MAIN.id, '/translations/ha'), 'PUT', { revision: renamed.body.revision, texts: { greet: { text: 'Barka da rana.' } } });
  expect(translated.status).toBe(200);
  expect(translated.body.translatedLocales).toEqual(expect.arrayContaining(['pcm', 'ha']));
  const published = await call(script(S_MAIN.id, '/versions'), 'POST', { revision: translated.body.revision, changes: ['Hausa greeting'] });
  expect(published.status).toBe(201);
  expect(published.body.number).toBe(VERSION_12.number + 1);
  const after = await call(script(S_MAIN.id));
  expect(after.body.revision, 'publishing moved the revision').toBe(translated.body.revision);
  expect(after.body.hasUnpublishedChanges).toBe(false);
  const again = await call(script(S_MAIN.id, '/versions'), 'POST', { revision: after.body.revision });
  expect(again.status).toBe(409);
  expect(again.body.details).toEqual([{ path: 'draft', code: 'unchanged' }]);
  const created = await call('/api/v1/scripts', 'POST', { programmeId: PROGRAMME_TWO.id, name: 'Debt advice', sourceLocale: 'en' });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ id: NEW_SCRIPT_ID, programmeId: PROGRAMME_TWO.id, draft: { graph: DEFAULT_GRAPH } });
  expect(writes.violations, 'a well-formed write was recorded as a violation').toEqual([]);

  // A caller without script.write: an empty list, 404 for every script, 403 to create.
  const reader = await installScriptingMock(page, { world: 'builder', role: 'agent' });
  await call('/api/v1/me/programmes');
  expect((await call('/api/v1/scripts')).body).toEqual({ data: [], nextCursor: null });
  expect((await call(script(S_MAIN.id))).status).toBe(404);
  expect((await call('/api/v1/scripts', 'POST', { programmeId: PROGRAMME_ONE.id, name: 'N', sourceLocale: 'en' })).status).toBe(403);
  expect(reader.violations).toEqual([]);

  // staleDraft: somebody else saves just before the first write lands; a re-read serves their change.
  const stale = await installScriptingMock(page, { world: 'builder', staleDraft: 'other-node' });
  const before = await call(script(S_MAIN.id));
  const lost = await call(script(S_MAIN.id), 'PATCH', { revision: before.body.revision, name: 'Mine' });
  expect(lost.status).toBe(409);
  const reread = await call(script(S_MAIN.id));
  expect(reread.body.name).toBe(OTHER_NAME);
  expect((reread.body.draft as { graph: Graph }).graph.nodes.find((entry) => entry.id === 'greet')?.text).toBe(OTHER_GREET_TEXT);
  const won = await call(script(S_MAIN.id), 'PATCH', { revision: reread.body.revision, name: 'Mine' });
  expect(won.status).toBe(200);
  for (const other of [mock, writes, reader, stale]) {
    expect(other.mockFaults).toEqual([]);
  }
  expect(stale.violations).toEqual([]);
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_scripts gates the builder', () => {
  // The flag-off tests PASS BEFORE THE WORK STARTS: there is no route, so
  // both paths are 404 everywhere. A negative invariant, legitimately
  // vacuous until the screen exists; @p10-builder-flag-on gives it meaning.
  test('/scripts and /scripts/<id> are real 404s with every flag at its default, and read nothing @p10-builder @p10-builder-flag-off', async ({ page }) => {
    const { webUrl } = stack();
    const mock = await installScriptingMock(page, { world: 'builder' });
    for (const path of ['/scripts', `/scripts/${S_MAIN.id}`]) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} is reachable with crm_scripts off`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    expect(mock.requests.filter((url) => url.pathname.startsWith('/api/v1/scripts')), 'a flag-off page still read scripts').toEqual([]);
  });

  test('the builder cannot be switched on by anything the browser sends @p10-builder @p10-builder-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-kasuwa-feature-flags': 'crm_scripts', 'x-crm-scripts': '1', 'x-kasuwa-tenant-id': TENANT_A },
    });
    await context.addCookies([
      { name: 'crm_scripts', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_scripts', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of ['/scripts?crm_scripts=on&flags=crm_scripts', `/scripts/${S_MAIN.id}?crm_scripts=1`, '/scripts/?locale=en-XA']) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/scripts renders the builder with crm_scripts on @p10-builder @p10-builder-flag-on', async ({ page }) => {
    await openList(page);
    await expect(heading(page)).toBeVisible();
    await expect(shown(screen(page).locator(`[data-script-row="${S_MAIN.id}"]`)).first()).toContainText(S_MAIN.name);
  });
});

// ===========================================================================
// The shell
// ===========================================================================

test('the builder sits in the CRM shell; no link on it is a 404, and the shell links nobody to it @p10-builder @p10-builder-shell', async ({ page }) => {
  await openList(page);
  const shell = page.locator('[data-shell="crm"]');
  await expect(shell).toBeVisible();
  await expect(shell.locator(SCREEN)).toBeVisible();
  const listLinks = await page.locator('a[href^="/"]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  await closeScreen(page);
  await openEditor(page, S_MAIN.id);
  const editorLinks = await page.locator('a[href^="/"]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  const hrefs = [...new Set([...listLinks, ...editorLinks])];
  expect(hrefs.length, 'the page links nowhere — not even the CRM nav').toBeGreaterThan(0);
  for (const href of hrefs) {
    const response = await page.request.get(`${scriptsUrl()}${href}`);
    expect(response.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }
  // Ruling (acceptance header, R3): no read tells the shell who holds
  // script.write until T-0079, so the shell's navigation carries no entry to
  // the builder for anyone — an agent must never be offered it.
  // T-0150 (T-0139): the editor's own "Studio / Scripts" breadcrumb is a <nav>
  // inside the screen, and its "Scripts" crumb links back to the list it was
  // opened from; only the shell's navigation outside the screen is held to this.
  const nav = await page
    .locator('[data-shell="crm"] nav a[href^="/scripts"]')
    .evaluateAll((links, screen) => links.filter((link) => link.closest(screen) === null).length, SCREEN);
  expect(nav, 'the CRM navigation links to the builder, which only the admin set may use').toBe(0);
});

// ===========================================================================
// P10/05 — the list
// ===========================================================================

test('the list draws the caller’s scripts in served order with their state, keyset "more", no count and no id @p10-builder @p10-builder-list', async ({ page }) => {
  const mock = await install(page);
  const firstPage = page.waitForResponse((response) => isOperation(response.request(), 'listScripts') && !new URL(response.url()).searchParams.has('cursor'));
  expect((await page.goto(`${scriptsUrl()}/scripts`))?.status()).toBe(200);
  await expect(screen(page)).toHaveAttribute('data-builder-state', 'ready');
  const next = ((await (await firstPage).json()) as { nextCursor: string | null }).nextCursor;
  expect(next, 'the mock served one page').not.toBeNull();
  await expect.poll(() => renderedRowIds(page), { message: 'the list is not the served page' }).toEqual(ALL_SCRIPTS.slice(0, SCRIPT_PAGE_CAP).map((row) => row.id));

  const row = (id: string) => shown(screen(page).locator(`[data-script-row="${id}"]`)).first();
  // Published with unpublished changes: the version number, and the draft is said to differ.
  await expect(row(S_MAIN.id)).toContainText(S_MAIN.name);
  await expect(row(S_MAIN.id).locator('[data-script-state]').first()).toHaveAttribute('data-script-state', 'published');
  await expect(row(S_MAIN.id).locator('[data-script-state]').first()).toHaveAttribute('data-unpublished', 'true');
  await expect(row(S_MAIN.id)).toContainText(`${VERSION_12.number}`);
  await expect(row(S_MAIN.id).locator(`a[href="/scripts/${S_MAIN.id}"]`)).toHaveCount(1);
  // Never published (a page-1 draft; Hardship sorts onto page 2 and is checked after "more", D-L119).
  await expect(row(S_SURVEY.id).locator('[data-script-state]').first()).toHaveAttribute('data-script-state', 'draft');
  // Markup in a name is text.
  await expect(row(S_HOSTILE.id)).toContainText('<b>Arrears</b>');
  await expect(screen(page).locator('[onerror], b:text-is("Arrears")')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss)).toBeUndefined();

  const more = shown(screen(page).getByTestId('script-list-more')).first();
  await expect(more, 'a page short of its limit was taken as the last').toBeEnabled();
  const answered = page.waitForResponse((response) => isOperation(response.request(), 'listScripts') && new URL(response.url()).searchParams.has('cursor'));
  await more.click();
  expect(new URL((await answered).url()).searchParams.get('cursor'), 'the cursor was not echoed verbatim').toBe(next);
  await expect.poll(() => renderedRowIds(page), { message: '"more" dropped, repeated or reordered scripts' }).toEqual(ALL_SCRIPTS.map((entry) => entry.id));
  await expect(row(S_HARDSHIP.id).locator('[data-script-state]').first()).toHaveAttribute('data-script-state', 'draft');
  await expect(row(S_WELCOME.id).locator('[data-script-state]').first()).toHaveAttribute('data-unpublished', 'false');
  await expect(row(S_KYC.id)).toContainText(S_KYC.name);
  await expectNoUsable(shown(screen(page).getByTestId('script-list-more')), '"more" on the last page');
  expect(page.url()).not.toMatch(/[?&]cursor=/);
  expect(mock.calledTimes('listScripts'), 'the list re-read its first page').toBe(2);
  const text = await visibleText(shown(screen(page).getByTestId('script-list')).first());
  expect(text, 'the list draws a count (D-P13)').not.toMatch(new RegExp(`\\b(${ALL_SCRIPTS.length}|${SCRIPT_PAGE_CAP})\\s+(scripts?|results?)\\b|\\(\\s*\\d+\\s*\\)`, 'i'));
  await expectNoIdsAnywhere(page, 'the script list');
  await expectNoSeriousAxe(page, 'P10/05 list');
});

test('a new script is created in a programme chosen by name, and opens in the editor @p10-builder @p10-builder-create', async ({ page }) => {
  const mock = await openList(page);
  await control(page, 'new-script').click();
  const dialog = page.getByTestId('script-create');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  const programme = input(dialog, 'programmeId');
  expect(await tagName(programme)).toBe('select');
  expect(await optionTexts(programme)).toEqual(expect.arrayContaining([PROGRAMME_ONE.name, PROGRAMME_TWO.name]));
  const locale = input(dialog, 'sourceLocale');
  expect(await tagName(locale)).toBe('select');
  const locales = await optionValues(locale);
  expect(locales.length).toBeGreaterThan(1);
  expect(locales.filter((value) => !SCRIPT_LOCALES.includes(value)), 'a source locale the contract does not have').toEqual([]);
  await expectNoIdsAnywhere(page, 'the create dialog');
  await expectNoSeriousAxe(page, 'the create dialog');

  await input(dialog, 'name').fill('Debt advice');
  await programme.selectOption({ label: PROGRAMME_TWO.name });
  await locale.selectOption('en');
  const sent = page.waitForRequest((request) => isOperation(request, 'createScript'));
  await shown(dialog.locator('[data-action="create-script"]')).first().click();
  const body = json((await sent).postDataJSON());
  expect(keysOf(body).filter((key) => !['graph', 'name', 'programmeId', 'sourceLocale'].includes(key))).toEqual([]);
  expect(body).toMatchObject({ programmeId: PROGRAMME_TWO.id, name: 'Debt advice', sourceLocale: 'en' });
  await expect(page).toHaveURL(new RegExp(`/scripts/${NEW_SCRIPT_ID}$`));
  await expect(screen(page)).toHaveAttribute('data-builder-view', 'editor');
  await expect(heading(page)).toContainText('Debt advice');
  await expect.poll(() => canvasIds(page)).toEqual(DEFAULT_GRAPH.nodes.map((entry) => entry.id));
  expect(mock.writes.map((write) => write.operation)).toEqual(['createScript']);
});

// ===========================================================================
// Access: the admin set only (D-L88, D-L96, D-P32)
// ===========================================================================

test('a caller without script.write sees no script, a generic not-found for every editor, and a translated refusal to create @p10-builder @p10-builder-access', async ({ page }) => {
  const mock = await openList(page, { role: 'agent', query: '?locale=en-XA' });
  await expect(shown(screen(page).getByTestId('script-list-empty')).first()).toBeVisible();
  await expect(screen(page).locator('[data-script-row]')).toHaveCount(0);
  // D-L84: no read tells the screen who holds script.write, so the control is
  // there for everyone and the API's 403 is the create gate.
  await control(page, 'new-script').click();
  const dialog = page.getByTestId('script-create');
  await input(dialog, 'name').fill('Not mine');
  await input(dialog, 'programmeId').selectOption({ label: PROGRAMME_ONE.name });
  const answered = page.waitForResponse((response) => isOperation(response.request(), 'createScript'));
  await shown(dialog.locator('[data-action="create-script"]')).first().click();
  expect((await answered).status()).toBe(403);
  const alert = shown(dialog.getByRole('alert')).first();
  await expect(alert).toBeVisible();
  expect(await visibleText(alert), 'the refusal is not the screen’s translated copy').toMatch(PSEUDO);
  await expect(input(dialog, 'name')).toHaveValue('Not mine');
  await closeScreen(page);

  const reader = await install(page, { role: 'agent' });
  const title = EN['notFound.title'] ?? '<notFound.title>';
  const headings: string[] = [];
  for (const id of [S_MAIN.id, OUT_OF_SCOPE_SCRIPT_ID, NO_SUCH_ID, 'not-a-uuid']) {
    const before = reader.requests.length;
    const response = await page.goto(`${scriptsUrl()}/scripts/${id}`);
    const status = response?.status() ?? 0;
    if (UUID.test(id)) {
      expect([200, 404], `/scripts/${id} answered neither 200 nor 404`).toContain(status);
      if (status === 200) {
        await expect(shown(page.getByTestId('record-not-found')).first(), `/scripts/${id} is not the not-found state`).toBeVisible();
      }
      // Only the API knows: the screen must have asked (otherwise this passes on a missing route).
      await expect.poll(() => reader.requests.slice(before).some((url) => url.pathname === `/api/v1/scripts/${id}`), { message: `/scripts/${id} never asked the API` }).toBe(true);
    } else {
      expect(status, 'a malformed id is not a real 404').toBe(404);
      expect(reader.requests.slice(before).filter((url) => url.pathname.startsWith('/api/v1/scripts')), 'a malformed id reached the API').toEqual([]);
    }
    const h1 = shown(page.getByRole('heading', { level: 1 })).first();
    await expect(h1).toHaveText(title);
    const whole = await visibleText(page.locator('body'));
    expect(whole, 'the not-found page says why').not.toMatch(/permission|not allowed|admin|request access/i);
    await expect(page.locator('[data-testid="script-canvas"], [data-action="save-draft"], [data-action="publish"]')).toHaveCount(0);
    await expectNoIdsAnywhere(page, `the not-found page for ${id}`);
    headings.push(await visibleText(h1));
  }
  expect(new Set(headings).size, 'the not-found page tells a non-writer, another programme and a missing script apart').toBe(1);
  expect(reader.writes).toEqual([]);
  expect(mock.violations).toEqual([]);
});

test.fixme('a caller without script.write gets a real 404 for /scripts @p10-builder-access-404', async () => {
  // BLOCKED ON T-0079 (D-L84). listScripts answers a non-writer with an empty
  // page, exactly as it answers an admin who has no scripts yet, and nothing
  // else tells the web process who holds script.write. When a capability read
  // exists, this opens /scripts as `role: 'agent'` and expects HTTP 404 and
  // no nav entry anywhere.
});

// ===========================================================================
// P10/05 — the node editor
// ===========================================================================

test.describe('P10/05 — the node editor', () => {
  test('draws every node of the draft by title and kind; the palette offers the six kinds and nothing else @p10-builder @p10-builder-editor', async ({ page }) => {
    await openEditor(page, S_MAIN.id);
    await expect(heading(page)).toContainText(S_MAIN.name);
    await expect(screen(page)).toHaveAttribute('data-unpublished', 'true');
    await expect.poll(async () => (await canvasIds(page)).sort()).toEqual(S_MAIN.draft.graph.nodes.map((entry) => entry.id).sort());
    for (const entry of S_MAIN.draft.graph.nodes) {
      const drawn = canvasNode(page, entry.id);
      await expect(drawn).toHaveAttribute('data-node-type', entry.type);
      await expect(drawn).toContainText(entry.title);
      await expectSaysOneOf(drawn, labelsEndingWith(`.nodeType.${entry.type}`), `the ${entry.type} kind`);
    }
    const palette = await shown(screen(page).locator('[data-action="add-node"]')).evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-node-type') ?? ''));
    expect([...palette].sort(), 'the palette is not the contract’s six kinds (there is no disposition node, D-L91)').toEqual([...NODE_TYPES].sort());

    // The inspector edits wording; the canvas follows.
    const panel = await selectNode(page, 'payq');
    await expect(input(panel, 'title')).toHaveValue(draftNode('payq').title);
    await expect(input(panel, 'text')).toHaveValue(String(draftNode('payq').text));
    await input(panel, 'title').fill(NEW_TITLE);
    await expect(canvasNode(page, 'payq')).toContainText(NEW_TITLE);
    // A question's choices route by node, chosen from the graph, never typed.
    const choices = shown(panel.locator('[data-choice-row]'));
    expect(await choices.count()).toBe((draftNode('payq').choices as unknown[]).length);
    const target = shown(choices.first().locator('[data-field-input="choice-next"]')).first();
    expect(await tagName(target)).toBe('select');
    expect((await optionValues(target)).filter((value) => !S_MAIN.draft.graph.nodes.some((entry) => entry.id === value))).toEqual([]);

    // An end node suggests a live disposition, by label.
    const end = await selectNode(page, 'close');
    const suggested = input(end, 'suggestedDispositionId');
    expect(await tagName(suggested)).toBe('select');
    expect(await suggested.evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? '')).toBe(D_PTP.label);
    await expectNoIdsAnywhere(page, 'the editor');
    await expectNoSeriousAxe(page, 'P10/05 editor');
  });

  test('a node of each kind added from the palette saves as a graph the contract accepts @p10-builder @p10-builder-editor', async ({ page }) => {
    const mock = await openEditor(page, S_MAIN.id);
    const before = S_MAIN.draft.graph.nodes.length;
    for (const type of NODE_TYPES) {
      await control(page, `add-node"][data-node-type="${type}`).click();
      await expect.poll(async () => (await canvasIds(page)).length, { message: `adding a ${type} drew nothing` }).toBe(before + NODE_TYPES.indexOf(type) + 1);
    }
    const { body, status } = await save(page, S_MAIN.id);
    expect(status, 'the save was refused').toBe(200);
    expect(keysOf(body)).toEqual(['graph', 'revision']);
    const graph = graphOf(body);
    expect(graph.nodes.length).toBe(before + NODE_TYPES.length);
    const added = graph.nodes.filter((entry) => !S_MAIN.draft.graph.nodes.some((old) => old.id === entry.id));
    expect(added.map((entry) => entry.type).sort()).toEqual([...NODE_TYPES].sort());
    // The mock judged the shape (closed node schemas): any problem is already a violation.
    expect(mock.violations).toEqual([]);
  });

  test('wording with markup in it is drawn as text, never parsed @p10-builder @p10-builder-editor', async ({ page }) => {
    await openEditor(page, S_HOSTILE.id);
    await expect(heading(page)).toContainText('<b>Arrears</b>');
    await expect(canvasNode(page, 'hello')).toContainText(HOSTILE_TITLE);
    const panel = await selectNode(page, 'hello');
    await expect(input(panel, 'text')).toHaveValue(HOSTILE_TEXT);
    await expect(screen(page).locator('[onerror], b:text-is("Bold"), i:text-is("welcome"), b:text-is("Arrears")')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss)).toBeUndefined();
    expect(HOSTILE_NAME + HOSTILE_TEXT).toContain('onerror');
  });
});

test('a branch condition is chosen from Contact field references and the contract’s operators, never typed @p10-builder @p10-builder-branch', async ({ page }) => {
  await openEditor(page, S_MAIN.id);
  const panel = await selectNode(page, 'cust');
  const source = input(panel, 'condition-source');
  expect(await tagName(source)).toBe('select');
  expect((await optionValues(source)).filter((value) => !CONDITION_SOURCES.includes(value))).toEqual([]);
  const field = input(panel, 'condition-field');
  expect(await tagName(field), 'the branch field is not a list to choose from').toBe('select');
  const fields = await optionValues(field);
  expect(fields.length, 'no Contact field is offered').toBeGreaterThan(1);
  expect(fields.filter((name) => !CONTACT_FIELDS.includes(name)), 'a branch field that is not a Contact wire name').toEqual([]);
  expect(fields.filter((name) => ['withheldFields', 'id', 'programmeId', 'version'].includes(name)), 'an envelope field is offered as data').toEqual([]);
  await expect(field).toHaveValue('status');
  // Each offered field by its label (an id ending `.field.<name>`), never its wire name.
  const labelled = await field.evaluate((element) =>
    Array.from((element as HTMLSelectElement).options).filter((option) => option.value !== '').map((option) => [option.value, (option.textContent ?? '').trim()]),
  );
  for (const [name, text] of labelled) {
    expect(labelsEndingWith(`.field.${name ?? ''}`), `the ${name} field has no label`).toContain(text);
  }
  await expect(panel.locator('input[data-field-input="condition-field"], textarea[data-field-input="condition-field"]')).toHaveCount(0);
  const operator = input(panel, 'condition-operator');
  expect(await tagName(operator)).toBe('select');
  const operators = await optionValues(operator);
  expect(operators.filter((value) => !CONDITION_OPERATORS.includes(value)), 'an operator the contract does not have').toEqual([]);
  for (const target of ['whenTrue', 'whenFalse']) {
    const select = input(panel, target);
    expect(await tagName(select)).toBe('select');
    expect((await optionValues(select)).filter((value) => !S_MAIN.draft.graph.nodes.some((entry) => entry.id === value))).toEqual([]);
  }

  await field.selectOption('preferredLanguage');
  await operator.selectOption('equals');
  const value = input(panel, 'condition-value');
  if ((await tagName(value)) === 'select') await value.selectOption('pcm');
  else await value.fill('pcm');
  const { body } = await save(page, S_MAIN.id);
  expect(nodeIn(graphOf(body), 'cust').condition).toEqual({ source: 'contact_field', field: 'preferredLanguage', operator: 'equals', value: 'pcm' });

  // An answer condition names a question or form already in the graph.
  await source.selectOption('answer');
  const question = input(panel, 'condition-node');
  expect(await tagName(question)).toBe('select');
  const askable = S_MAIN.draft.graph.nodes.filter((entry) => entry.type === 'question' || entry.type === 'form').map((entry) => entry.id);
  const offered = await optionValues(question);
  expect(offered.length).toBeGreaterThan(0);
  expect(offered.filter((id) => !askable.includes(id)), 'an answer condition on a node that asks nothing').toEqual([]);
  await expect(panel.locator('[data-field-input="condition-field"]').filter({ visible: true })).toHaveCount(0);
});

test('variables are offered from the contract’s three families only; inserting one writes it into the wording @p10-builder @p10-builder-variables', async ({ page }) => {
  await openEditor(page, S_MAIN.id);
  const panel = await selectNode(page, 'greet');
  const chips = await shown(panel.locator('[data-action="insert-variable"]')).evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-variable') ?? ''));
  expect(chips).toEqual(expect.arrayContaining(['contact.displayName', 'agent.displayName']));
  expect(chips.filter((variable) => !VARIABLE_PATTERN.test(variable)), 'a variable outside contact.*, agent.displayName and answer.* (loan.* waits, D-L88)').toEqual([]);
  for (const variable of chips.filter((entry) => entry.startsWith('contact.'))) {
    expect(CONTACT_FIELDS, `${variable} names no Contact field`).toContain(variable.slice('contact.'.length));
  }
  for (const variable of chips.filter((entry) => entry.startsWith('answer.'))) {
    const [, nodeId, key] = variable.split('.');
    const form = S_MAIN.draft.graph.nodes.find((entry) => entry.id === nodeId);
    expect(form?.type, `${variable} is not a form answer`).toBe('form');
    expect(((form?.fields ?? []) as { key: string }[]).map((entry) => entry.key)).toContain(key);
  }
  const text = input(panel, 'text');
  await text.fill('Hello');
  await shown(panel.locator('[data-action="insert-variable"][data-variable="contact.displayName"]')).first().click();
  await expect(text).toHaveValue(/Hello\s*\{contact\.displayName\}/);
});

test('a form’s fields collect answers on the run only: no field binds to the record (D-P31) @p10-builder @p10-builder-form', async ({ page }) => {
  await openEditor(page, S_MAIN.id);
  const panel = await selectNode(page, 'ptp');
  const fields = draftNode('ptp').fields as { key: string; label: string; type: string }[];
  const rows = shown(panel.locator('[data-form-field-row]'));
  await expect(rows).toHaveCount(fields.length);
  for (let index = 0; index < fields.length; index += 1) {
    const row = rows.nth(index);
    await expect(shown(row.locator('[data-field-input="form-field-label"]')).first()).toHaveValue(fields[index]?.label ?? '');
    const type = shown(row.locator('[data-field-input="form-field-type"]')).first();
    expect(await tagName(type)).toBe('select');
    expect((await optionValues(type)).filter((value) => !FORM_FIELD_TYPES.includes(value))).toEqual([]);
    await expect(type).toHaveValue(fields[index]?.type ?? '');
  }
  // Nothing in the form editor offers to write a CRM field.
  const said = await copyText(panel);
  expect(said, 'the form editor offers a record binding').not.toMatch(/writes? to|record field|crm field|contact field|save to (the )?record|ptp_/i);
  for (const select of await shown(panel.locator('select')).all()) {
    const values = await optionValues(select);
    expect(values.filter((value) => ['status', 'ownerUserId', 'phones', 'emails', 'tags'].includes(value)), 'a form field can be bound to a Contact field').toEqual([]);
  }
  await shown(panel.locator('[data-action="add-form-field"]')).first().click();
  await expect(rows).toHaveCount(fields.length + 1);
  const { body } = await save(page, S_MAIN.id);
  const sent = nodeIn(graphOf(body), 'ptp').fields as Record<string, unknown>[];
  expect(sent.length).toBe(fields.length + 1);
  for (const field of sent) {
    expect(Object.keys(field).filter((key) => !['key', 'label', 'type', 'required', 'maxLength', 'minimum', 'maximum', 'currency', 'minimumMinor', 'maximumMinor', 'minDaysAhead', 'maxDaysAhead', 'options'].includes(key))).toEqual([]);
  }
});

// ===========================================================================
// Saves (D-L102)
// ===========================================================================

test.describe('P10/05 — saving the draft (D-L102)', () => {
  test('a save sends the revision and only the fields that changed, and the next one the revision it got back @p10-builder @p10-builder-save', async ({ page }) => {
    const mock = await openEditor(page, S_MAIN.id);
    await expectNoUsable(shown(screen(page).locator('[data-action="save-draft"]')), 'save with nothing changed');
    await input(screen(page), 'script-name').fill('Collections – PTP');
    const first = await save(page, S_MAIN.id);
    expect(first.status).toBe(200);
    expect(keysOf(first.body), 'a rename sent more than the name').toEqual(['name', 'revision']);
    expect(first.body.revision).toBe(S_MAIN.revision);
    await expect(heading(page)).toContainText('Collections – PTP');

    const panel = await selectNode(page, 'payq');
    await input(panel, 'title').fill(NEW_TITLE);
    const second = await save(page, S_MAIN.id);
    expect(second.status).toBe(200);
    expect(keysOf(second.body), 'a node edit sent the name again').toEqual(['graph', 'revision']);
    expect(second.body.revision, 'the second save did not carry the revision the first one returned').toBe(S_MAIN.revision + 1);
    expect(nodeIn(graphOf(second.body), 'payq').title).toBe(NEW_TITLE);
    const others = graphOf(second.body).nodes.filter((entry) => entry.id !== 'payq');
    expect(others, 'a node the person never touched changed').toEqual(S_MAIN.draft.graph.nodes.filter((entry) => entry.id !== 'payq'));
    expect(mock.writes.map((write) => write.operation)).toEqual(['updateScript', 'updateScript']);
    // Nothing is saved behind the person's back.
    await input(panel, 'title').fill(`${NEW_TITLE}!`);
    await expect(control(page, 'save-draft')).toBeEnabled();
    expect(mock.writes, 'the builder saved without being asked').toHaveLength(2);
  });

  test('after a 409 the screen re-reads, keeps the other person’s change and re-applies only this person’s @p10-builder @p10-builder-rebase', async ({ page }) => {
    const mock = await openEditor(page, S_MAIN.id, { staleDraft: 'other-node', query: '?locale=en-XA' });
    const panel = await selectNode(page, 'payq');
    await input(panel, 'title').fill(NEW_TITLE);
    const lost = await save(page, S_MAIN.id);
    expect(lost.status).toBe(409);
    const alert = alerts(page).first();
    await expect(alert, 'no alert for the 409').toBeVisible();
    expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect.poll(() => mock.calledTimes('getScript'), { message: 'the screen did not re-read the script after the 409' }).toBeGreaterThanOrEqual(2);
    await expect(heading(page)).toContainText(OTHER_NAME);
    await expect(input(await selectNode(page, 'payq'), 'title'), 'the re-read lost this person’s edit').toHaveValue(NEW_TITLE);
    const greet = await selectNode(page, 'greet');
    await expect(input(greet, 'text'), 'the other person’s edit was not loaded').toHaveValue(OTHER_GREET_TEXT);

    const won = await save(page, S_MAIN.id);
    expect(won.status).toBe(200);
    expect(keysOf(won.body), 'the retry sent a field this person never touched (the name)').toEqual(['graph', 'revision']);
    expect(won.body.revision).toBe(S_MAIN.revision + 1);
    expect(nodeIn(graphOf(won.body), 'greet').text, 'the retry overwrote the other person’s edit').toBe(OTHER_GREET_TEXT);
    expect(nodeIn(graphOf(won.body), 'payq').title).toBe(NEW_TITLE);
    expect(mock.scripts.get(S_MAIN.id)?.name).toBe(OTHER_NAME);
  });

  test('a field both people changed keeps the typed value and says it was changed by someone else @p10-builder @p10-builder-rebase', async ({ page }) => {
    await openEditor(page, S_MAIN.id, { staleDraft: 'same-field' });
    const panel = await selectNode(page, 'payq');
    await input(panel, 'title').fill(NEW_TITLE);
    expect((await save(page, S_MAIN.id)).status).toBe(409);
    await expect(screen(page)).toHaveAttribute('data-builder-state', 'ready');
    const note = shown((await selectNode(page, 'payq')).getByTestId('changed-elsewhere')).first();
    await expect(note, 'no "changed by someone else" note on the field both changed').toBeVisible();
    expect(await visibleText(note)).not.toBe('');
    await expect(input(inspector(page), 'title')).toHaveValue(NEW_TITLE);
    const won = await save(page, S_MAIN.id);
    expect(won.status).toBe(200);
    expect(nodeIn(graphOf(won.body), 'payq').title).toBe(NEW_TITLE);
    expect(OTHER_PAYQ_TITLE).not.toBe(NEW_TITLE);
  });
});

// ===========================================================================
// Publishing and versions
// ===========================================================================

test.describe('P10/05 — publish, versions and the compliance diff', () => {
  test('publish is offered only for saved changes, and creates an immutable version @p10-builder @p10-builder-publish', async ({ page }) => {
    const mock = await openEditor(page, S_MAIN.id);
    await expect(control(page, 'publish')).toBeEnabled();
    const panel = await selectNode(page, 'greet');
    await input(panel, 'title').fill('Greeting (short)');
    await expectNoUsable(shown(screen(page).locator('[data-action="publish"]')), 'publish with an unsaved edit');
    expect((await save(page, S_MAIN.id)).status).toBe(200);

    await control(page, 'publish').click();
    const dialog = page.getByTestId('publish-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    expect(await copyText(dialog), 'the dialog publishes to several programmes (D-L91)').not.toMatch(/\d+\s+programmes|assign/i);
    const change = shown(dialog.locator('[data-field-input="publish-change"]')).first();
    if ((await change.count()) > 0) await change.fill('Read-back adds the PIN warning');
    const sent = page.waitForResponse((response) => isOperation(response.request(), 'publishScript', S_MAIN.id));
    await shown(dialog.locator('[data-action="confirm-publish"]')).first().click();
    const response = await sent;
    expect(response.status()).toBe(201);
    const body = json(response.request().postDataJSON());
    expect(keysOf(body).filter((key) => !['changes', 'revision'].includes(key))).toEqual([]);
    expect(body.revision).toBe(S_MAIN.revision + 1);
    await expect(screen(page)).toHaveAttribute('data-unpublished', 'false');
    await expectNoUsable(shown(screen(page).locator('[data-action="publish"]')), 'publish with nothing new to publish');
    const minted = mock.versions.get(S_MAIN.id)?.[0];
    expect(minted?.number).toBe(VERSION_12.number + 1);
    await expect(screen(page)).toContainText(`${VERSION_12.number + 1}`);

    // Immutable: a later edit changes the draft, never the version.
    const snapshot = JSON.stringify(minted?.graph);
    await input(await selectNode(page, 'greet'), 'title').fill('Greeting (edited after publish)');
    expect((await save(page, S_MAIN.id)).status).toBe(200);
    await expect(screen(page)).toHaveAttribute('data-unpublished', 'true');
    expect(JSON.stringify(mock.versions.get(S_MAIN.id)?.[0]?.graph), 'a published version changed').toBe(snapshot);
    expect(mock.writes.filter((write) => write.operation === 'publishScript')).toHaveLength(1);
  });

  test('a refused publish names the reasons in words and marks the nodes by title, never a raw code @p10-builder @p10-builder-invalid', async ({ page }) => {
    const mock = await openEditor(page, S_MAIN.id, { publishInvalid: true });
    await control(page, 'publish').click();
    const answered = page.waitForResponse((response) => isOperation(response.request(), 'publishScript', S_MAIN.id));
    await shown(page.getByTestId('publish-dialog').locator('[data-action="confirm-publish"]')).first().click();
    expect((await answered).status()).toBe(409);
    const alert = alerts(page).first();
    await expect(alert).toBeVisible();
    const said = await visibleText(alert);
    for (const reason of ['unknown_target', 'unreachable_end']) {
      const labels = labelsEndingWith(`.reason.${reason}`);
      expect(labels.length, `en.json has no label for the ${reason} reason`).toBeGreaterThan(0);
      expect(labels.some((label) => said.includes(label)), `the ${reason} reason is not said: "${said}"`).toBe(true);
      expect(said, 'a raw reason code was printed').not.toContain(reason);
    }
    expect(said).not.toMatch(/nodes\.\w+|script_invalid/);
    for (const id of ['payq', 'ptp']) {
      await expect(canvasNode(page, id)).toHaveAttribute('data-invalid', 'true');
      expect(said, `the alert does not name ${id} by its title`).toContain(draftNode(id).title);
    }
    await expect(canvasNode(page, 'greet')).not.toHaveAttribute('data-invalid', 'true');
    expect(mock.versions.get(S_MAIN.id)?.[0]?.number, 'something was published').toBe(VERSION_12.number);
    await expect(screen(page)).toHaveAttribute('data-unpublished', 'true');
  });

  test('the version list is newest first and keyset paged; a version opens read-only and writes nothing @p10-builder @p10-builder-versions', async ({ page }) => {
    const mock = await openEditor(page, S_MAIN.id);
    await control(page, 'versions').click();
    const rows = () =>
      shown(page.locator('[data-version-row]')).evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-version-row') ?? ''));
    await expect.poll(rows, { message: 'the version list is not the served page, newest first' }).toEqual(MAIN_VERSIONS.slice(0, VERSION_PAGE_CAP).map((row) => row.id));
    const v12 = shown(page.locator(`[data-version-row="${VERSION_12.id}"]`)).first();
    await expect(v12).toContainText(`${VERSION_12.number}`);
    await expect(v12).toContainText(ADMIN.displayName);
    await expect(v12.locator('time[datetime]')).toHaveCount(1);
    const more = shown(page.getByTestId('version-list-more')).first();
    await expect(more).toBeEnabled();
    await more.click();
    await expect.poll(rows).toEqual(MAIN_VERSIONS.slice(0, 2 * VERSION_PAGE_CAP).map((row) => row.id));
    await expectNoIdsAnywhere(page, 'the version list');

    const writes = mock.writes.length;
    await v12.click();
    await expect(screen(page)).toHaveAttribute('data-builder-view', 'version');
    await expect(screen(page)).toHaveAttribute('data-read-only', 'true');
    await expect.poll(async () => (await canvasIds(page)).sort()).toEqual(VERSION_12.graph.nodes.map((entry) => entry.id).sort());
    await expect(canvasNode(page, 'crb'), 'the draft’s node is drawn on v12').toHaveCount(0);
    const readback = await selectNode(page, 'readback');
    await expect(input(readback, 'text')).toHaveValue(V12_READBACK_TEXT);
    await expectNoUsable(screen(page).locator('input:visible, textarea:visible, select:visible'), 'an input on a published version');
    await expectNoUsable(screen(page).locator('[data-action="save-draft"]:visible, [data-action="publish"]:visible, [data-action="add-node"]:visible, [data-action="insert-variable"]:visible'), 'a write control on a published version');
    expect(mock.writes.length, 'viewing a version wrote something').toBe(writes);
    await control(page, 'back-to-draft').click();
    await expect(screen(page)).toHaveAttribute('data-builder-view', 'editor');
    await expect(canvasNode(page, 'crb')).toBeVisible();
  });

  test('the draft shows how its compliance nodes differ from the latest version, by name @p10-builder @p10-builder-diff', async ({ page }) => {
    const mock = await openEditor(page, S_MAIN.id);
    const diff = shown(screen(page).getByTestId('compliance-diff')).first();
    await expect(diff).toBeVisible();
    const entries = async (kind: string) =>
      shown(diff.locator(`[data-compliance-diff="${kind}"]`)).evaluateAll((items) => items.map((item) => (item.textContent ?? '').replace(/\s+/g, ' ').trim()));
    await expect.poll(async () => (await entries('changed')).join(' | ')).toContain(draftNode('readback').title);
    expect((await entries('added')).join(' | ')).toContain(CRB_TITLE);
    expect(await entries('removed')).toEqual([]);
    expect(await visibleText(diff), 'an unchanged compliance node is listed').not.toContain(draftNode('rec').title);
    expect(mock.calls.get('getScriptVersion')?.some((url) => url.pathname.endsWith(VERSION_12.id)), 'the diff was not judged against the latest version').toBe(true);
    // A never-published script has nothing to differ from.
    await closeScreen(page);
    await openEditor(page, S_HARDSHIP.id);
    await expect(shown(screen(page).locator('[data-compliance-diff]'))).toHaveCount(0);
  });
});

// ===========================================================================
// Translations
// ===========================================================================

test('a translation is edited per locale against the source wording and saved whole, keeping what was there @p10-builder @p10-builder-translations', async ({ page }) => {
  const mock = await openEditor(page, S_MAIN.id);
  const tabs = await shown(screen(page).locator('[data-locale-tab]')).evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-locale-tab') ?? ''));
  expect(tabs, 'a design locale has no translation tab').toEqual(expect.arrayContaining(['ha', 'yo', 'ig', 'pcm', 'fr']));
  expect(tabs.filter((locale) => !SCRIPT_LOCALES.includes(locale)), 'a tab for a locale the contract does not have').toEqual([]);

  await shown(screen(page).locator('[data-locale-tab="pcm"]')).first().click();
  const panel = await selectNode(page, 'idq');
  await expect(panel, 'the source wording is not shown beside the translation').toContainText(String(draftNode('idq').text).slice(0, 18));
  const translation = input(panel, 'translation-text');
  await expect(translation).toHaveValue('');
  await translation.fill('Na {contact.displayName} I dey talk to?');
  const answered = page.waitForResponse((response) => isOperation(response.request(), 'putScriptTranslation', S_MAIN.id));
  await control(page, 'save-draft').click();
  const response = await answered;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).pathname).toBe(`/api/v1/scripts/${S_MAIN.id}/translations/pcm`);
  const body = json(response.request().postDataJSON());
  expect(keysOf(body)).toEqual(['revision', 'texts']);
  const texts = body.texts as Record<string, Record<string, unknown>>;
  expect(texts.idq?.text).toBe('Na {contact.displayName} I dey talk to?');
  for (const [nodeId, served] of Object.entries(S_MAIN.draft.translations.pcm ?? {})) {
    expect(texts[nodeId], `saving pcm dropped the ${nodeId} translation it was served`).toEqual(served);
  }
  expect(mock.writes.map((write) => write.operation), 'the graph was resent for a translation edit').toEqual(['putScriptTranslation']);
  expect(mock.writes.every((write) => !write.path.endsWith('/translations/en')), 'the source locale was "translated"').toBe(true);
});

// ===========================================================================
// Hidden until their module exists (D-L88, D-L91, D-P31, D-P32)
// ===========================================================================

test('no multi-programme publishing, approver, AI, QA flag, hang-up, record binding, loan variable or sample preview @p10-builder @p10-builder-hidden', async ({ page }) => {
  await openEditor(page, S_MAIN.id);
  const said: string[] = [await copyText(screen(page))];
  for (const id of ['rec', 'greet', 'ptp', 'close', 'cust']) {
    await selectNode(page, id);
    said.push(await copyText(screen(page)));
  }
  const text = said.join(' ');
  expect(text, 'multi-programme publishing is drawn (D-L91)').not.toMatch(/assigned to|assign to programme|\d+\s+programmes/i);
  expect(text, 'a compliance approver is drawn (D-P32: the admin set)').not.toMatch(/compliance role|legal[- ]approved|approved by|lock text/i);
  expect(text, 'AI is drawn (M17)').not.toMatch(/\bAI\b/);
  expect(text, 'AI suggestions are drawn (M17)').not.toMatch(/next-line|\bsuggestions\b/i);
  expect(text, 'a QA toggle is drawn').not.toMatch(/\bQA\b/);
  expect(text, 'a call-bound control is drawn (M09)').not.toMatch(/hang[- ]up|wrap[- ]up|screen[- ]pop/i);
  expect(text, 'a record binding is drawn (D-P31)').not.toMatch(/writes? to (the )?record|ptp_\w+|loan record/i);
  expect(text, 'the sample-record preview is drawn').not.toMatch(/sample record|preview as agent|Emeka|Okafor/i);
  await expect(screen(page).locator('[data-variable^="loan."], [data-variable^="cust."], [data-variable="org"]')).toHaveCount(0);
  await expect(screen(page).locator('[aria-hidden="true"]', { hasText: /^\s*auto_awesome\s*$/ })).toHaveCount(0);
});

// ===========================================================================
// Loading, a failed read, offline
// ===========================================================================

test.describe('P10/05 — loading, a failed read, offline', () => {
  test('loading draws the skeleton, never not-found, until the script arrives @p10-builder @p10-builder-loading', async ({ page }) => {
    const mock = await openEditor(page, S_MAIN.id, { hold: true, state: 'loading' });
    try {
      expect(await shown(screen(page).getByTestId('builder-skeleton')).count(), 'no skeleton').toBeGreaterThan(0);
      await expect(page.getByTestId('record-not-found')).toHaveCount(0);
      await expect(screen(page).locator('[data-node]')).toHaveCount(0);
    } finally {
      mock.release();
    }
    await expect(screen(page)).toHaveAttribute('data-builder-state', 'ready');
    await expect(heading(page)).toContainText(S_MAIN.name);
  });

  test('a failed read says the server could not be reached, never "not found" @p10-builder @p10-builder-loading', async ({ page }) => {
    await install(page, { networkFailure: true });
    await page.goto(`${scriptsUrl()}/scripts/${S_MAIN.id}`);
    const unavailable = shown(page.getByTestId('record-unavailable')).first();
    await expect(unavailable).toBeVisible();
    expect(await visibleText(unavailable)).not.toBe('');
    await expect(page.getByTestId('record-not-found')).toHaveCount(0);
  });

  test('offline keeps the draft in memory only and disables every write; nothing queues @p10-builder @p10-builder-offline', async ({ page }) => {
    const mock = await openEditor(page, S_MAIN.id);
    const typed = 'Offline title that must not reach the device';
    await input(await selectNode(page, 'payq'), 'title').fill(typed);
    const writeControls = shown(screen(page).locator('[data-action="save-draft"], [data-action="publish"], [data-action="add-node"]'));
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
      const stored = await deviceStorage(page);
      expect(stored.cachedApi, 'an API response was put in Cache Storage').toEqual([]);
      for (const needle of [typed, String(draftNode('rec').text), String(draftNode('readback').text), S_MAIN.name]) {
        expect(stored.dump.includes(needle), `"${needle.slice(0, 40)}" was written to device storage`).toBe(false);
      }
    } finally {
      await page.context().setOffline(false);
    }
    await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);
    await expect(input(inspector(page), 'title')).toHaveValue(typed);
    expect(mock.writes, 'a write was sent while offline, or queued and sent on reconnecting').toEqual([]);
  });
});

// ===========================================================================
// Mobile, i18n, budget
// ===========================================================================

test('at 360px the list and the editor fit without sideways page scroll and pass axe @p10-builder @p10-builder-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openList(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 'the list scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P10/05 list at 360px');
  await closeScreen(page);
  await openEditor(page, S_MAIN.id);
  // The canvas may scroll inside itself; the page may not.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 'the editor scrolls the page sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P10/05 editor at 360px');
});

test('locale=en-XA renders every builder string as pseudo text, script wording and served names excepted @p10-builder @p10-builder-pseudo', async ({ page }) => {
  await openEditor(page, S_MAIN.id, { query: '?locale=en-XA' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await selectNode(page, 'cust');
  const report = await page.locator('[data-shell="crm"]').evaluate((root, servedJson) => {
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
    for (const option of Array.from(root.querySelectorAll('[data-field-input="condition-field"] option, [data-field-input="condition-operator"] option'))) {
      const text = (option.textContent ?? '').trim();
      if (letters(text) && !pseudo(text)) english.push(`option "${text}"`);
    }
    return { english, forged, pseudoCount };
  }, servedData());
  expect(report.english, 'strings on the builder that did not come through i18n').toEqual([]);
  expect(report.forged, 'UI copy marked data-record-text that is not served data').toEqual([]);
  expect(report.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(10);
});

test.describe('/scripts/[scriptId] on the wire', () => {
  /**
   * WHY 260,000 BYTES, BEFORE THE SCREEN EXISTS
   *
   * The lead's provisional figure. The record screens on the same shell,
   * fonts and API client sit at 236,000 (/contacts/[id]) and 245,000
   * (/accounts/[id], ceiling). The editor adds a canvas, an inspector with
   * six node kinds and a version list; it has no timeline. 260,000 leaves
   * room for that and stays well under PRD 2.13's 300 KB. The acceptance
   * suite requires it re-pinned within 5% of the first measurement.
   */
  test('/scripts/[scriptId] stays inside its transferred-byte budget on the production build @p10-builder @p10-builder-budget', async ({ page }) => {
    active = await installScriptingMock(page, { world: 'builder' });
    const metrics = await measurePageLoad(page, `${scriptsUrl()}/scripts/${S_MAIN.id}`, 'default');
    const record = resolve(__dirname, '.artifacts', 'p10-builder-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(
      record,
      `${JSON.stringify({ path: '/scripts/[scriptId]', transferredBytes: metrics.transferredBytes, budget: SCRIPT_BUILDER_BUDGET_BYTES }, null, 2)}\n`,
      'utf8',
    );
    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webScriptsUrl is not serving the production build').toBe(built);
    // A 404 page is small: a budget met by the not-found page measures nothing.
    await expect(screen(page)).toBeVisible();
    expect(SCRIPT_BUILDER_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P10/05 the script builder', metrics.transferredBytes, SCRIPT_BUILDER_BUDGET_BYTES);
  });

  test('/scripts/[scriptId] paints within 5 s at 256 kbps and 300 ms @p10-builder @p10-builder-budget', async ({ page }) => {
    active = await installScriptingMock(page, { world: 'builder' });
    const metrics = await measurePageLoad(page, `${scriptsUrl()}/scripts/${S_MAIN.id}`, 'low-bandwidth');
    await expect(screen(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
