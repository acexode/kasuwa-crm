import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack, type StackUrls } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  ACCOUNT_EXAMPLE,
  ACCOUNT_OTHER_PROGRAMME,
  ACCOUNT_SAME_PROGRAMME,
  CONTACT_PROPERTIES,
  CUSTOMER,
  FILTER_PARAMETERS,
  HOSTILE_COMPANY,
  HOSTILE_NAME,
  LEAD_EXAMPLE,
  LEAD_HOSTILE,
  LEAD_LINKED,
  LEAD_LOCKED,
  LEAD_NEW,
  LEAD_NULLS,
  LEAD_OWNER_LOCKED,
  LEAD_PAGE_TWO,
  LEAD_STATUSES,
  NEW_ACCOUNT_IDS,
  PROGRAMME_ONE,
  PROGRAMME_TWO,
  SORTABLE_FIELDS,
  SORT_VALUES,
  allAccounts,
  installLeadsMock,
  isConvert,
  isListAccounts,
  isListLeads,
  isUpdateContact,
  parameterEnum,
  scenarioRows,
  type ContactRow,
  type LeadsMock,
  type LeadsMockOptions,
} from './support/leads-mock';

/**
 * T-0058 — the P04 Leads screen (frames 01, 04, 05, 06), behind `crm_leads`,
 * in the CRM shell T-0042 built. Written by the lead's QA agent BEFORE the
 * screen exists; `tests/acceptance/records-ui/leads-screen.acceptance.test.ts`
 * runs this file with `--grep @leads-p04` and reads every outcome by tag.
 * Decisions: D-P13, D-P14, D-P17, D-P18, D-P21, D-L64, D-L69, D-L75, D-L80,
 * D-L82, D-L84.
 *
 * THE TAG. `@leads-p04`, not `@p04-leads`: Playwright's --grep is a regular
 * expression, and a tag that starts with another screen's parent tag is run by
 * that screen's suite too (D-L84). Neither `--grep @p04` (T-0042) nor
 * `--grep @p04-accounts` (T-0057) selects anything in this file, and nothing in
 * it may carry their tags; the acceptance suite checks both.
 *
 * ---------------------------------------------------------------------------
 * THE WEB PROCESS
 *
 *   webUrl       — the default server, every flag at its default. `/leads`
 *                  must be a real 404 there.
 *   webLeadsUrl  — NEW, published in the stack file by the builder's change to
 *                  `scripts/run-e2e.mjs`: apps/web from the SAME production
 *                  build (`next start`, NODE_ENV=test as D-L64 ruled) with
 *                  `crm_leads` in KASUWA_FEATURE_FLAGS_ON. Every journey and
 *                  the byte budget run here; the budget checks the build id.
 *                  BUILDER'S CHOICE: a new process, or `crm_leads` added to an
 *                  existing one (`webRecordsUrl`, or T-0057's accounts process
 *                  if it has landed), with `webLeadsUrl` naming the same URL.
 *                  Either way EVERY link on the page must resolve there: if the
 *                  process does not serve `/contacts` or `/accounts`, its nav
 *                  must not link to them, and a process that does not serve
 *                  `/leads` must not link to it (T-0042's shell test).
 *
 * THE LEADS ARE READ FROM THE BROWSER, AND MOCKED THERE
 *
 * Every journey installs `support/leads-mock.ts`, which serves listLeads,
 * getContact, updateContact, convertContact, the picker's listAccounts,
 * listMyProgrammes and getCurrentUser from the contracts. `afterEach` fails any
 * test in which the screen sent the API something the contract does not
 * declare, read listContacts, created an account itself, or left the origin
 * (see the mock's header for the full list).
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                       the CRM shell; its <nav> links
 *                                            `/leads`, aria-current="page"
 *   [data-screen="P04/01"]                   the Leads screen root, both views,
 *     data-list-state="loading|ready|empty|no-results|error"
 *   [data-view-option="table"|"kanban"]      the view switch (P04/01 and 04)
 *   [data-row-id="<contact id>"]             a table row OR a Kanban card
 *   [role="columnheader"][data-column="<Contact property>"]
 *                                            `aria-sort` only on a sortable key
 *   [data-field="<Contact property>"]        a cell (or a card's field) inside
 *                                            its row; the owner is `owner` OR
 *                                            `ownerUserId`. Cards carry
 *                                            `displayName` and `companyName`.
 *     data-locked="true"                     when the field is WITHHELD
 *   [data-record-text]                       record data, not UI copy (en-XA)
 *   input[type="search"]                     search: name, number or company
 *   [data-filter="<listLeads param>"]        a filter chip; opens
 *   [data-filter-menu="<param>"]             with [data-filter-option="<wire
 *                                            value>"] options
 *   [data-testid="filter-apply"]             optional "Done" in a filter menu
 *   [data-testid="sort-control"]             optional; opens
 *     [data-sort-option="<sort enum value>"] — or sortable column headers
 *                                            containing a <button>
 *   [data-testid="load-more"] or [data-testid="next-page"]
 *                                            in the table, and inside a Kanban
 *                                            column whose read has a nextCursor
 *   [data-testid="skeleton-row"], [data-testid="empty-state"],
 *   [data-testid="no-results-message"], [data-testid="list-error"]
 *   [data-action="clear-search-filters"]
 *   [data-kanban-column="<lead status>"]     one per lead status: a drop target
 *     [data-row-id] cards, draggable
 *     [data-action="move-lead"]              in each card: a <button> opening
 *       [data-move-to="<lead status>"]       options — the single-pointer and
 *                                            keyboard alternative to dragging
 *                                            (WCAG 2.2 SC 2.5.7, 2.1.1)
 *   [role="alert"]                           a refused move, inside the screen
 *   [data-action="convert-lead"]             the row action, inside the row
 *   [data-testid="convert-sheet"]            role=dialog
 *     [data-convert-mode="existing"|"new"]   chooses the form (radio or button)
 *     [data-testid="account-picker"]         input[type="search"] (or
 *                                            input[role="combobox"]) and
 *       [data-account-option="<account id>"] options, labelled by NAME
 *     [data-field-input="newAccount.name"]   the new account's name
 *     [data-action="confirm-convert"]        submit
 *     [role="alert"]                         a refused convert, said plainly
 *   [data-requires-connection]               disabled while offline
 *   [data-testid="offline-banner"]           with the last-synced time
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS
 *
 *   - Rows are Contacts (D-P17): columns are Contact properties, Company is
 *     `companyName`. P04/01's Lead score and Last activity have no field.
 *   - Filters are `listLeads` parameters: owner, status, source. P04's State,
 *     Language, Consent and DND chips are listContacts' and are not drawn.
 *   - Status offers the four lead stages only; `customer` is never a chip, a
 *     column or a move target. Leaving the lead stages is convert's job.
 *   - Sort only by `sort`'s enum (createdAt, updatedAt; T-0124 removed
 *     displayName, D-L180 I5): never by name, company, status, owner or source.
 *   - No totals, no live chip counts and no Kanban column counts (D-P13).
 *   - The Kanban move writes `{ version, status }` and nothing else (D-P14,
 *     D-P18: an agent may change status). P04/01's inline Owner edit is not
 *     part of T-0058, and the mock refuses any other contact write.
 *   - Convert (D-P17, D-L75): one `convertContact`, to an account in the
 *     lead's own programme picked by name, or to a new account by name. Never
 *     createAccount then link. A converted lead stays on the list as Qualified.
 *   - Hidden (D-L69, D-P13): Merge, Lead score, the Map view, bulk selection
 *     and bulk WhatsApp, Health, and live counts.
 *   - Offline (D-P21, D-L64): the list stays in memory only; every edit,
 *     convert and drag is disabled. Nothing queues.
 *   - Write controls show to every caller (D-L84): the 403 is the gate, and
 *     it is shown as a translated alert. The mock's default caller is an
 *     agent, who may move a lead but not convert it.
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P04/01"]';

/**
 * The /leads transferred-byte budget. The acceptance suite holds it at or
 * under 255,000 bytes and within 5% of what this run measures, so re-pin it to
 * the measurement once the screen exists. Why 255,000: see the budget test.
 */
const LEADS_BUDGET_BYTES = 283_000;

const NAME_WITH_NO_MATCH = 'Okorafor';
const NEW_ACCOUNT_NAME = 'Bakare Logistics';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

let active: LeadsMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.violations, 'the screen sent the API something the contract does not declare').toEqual([]);
    if (mock.requests.length > 0) {
      const origin = new URL(leadsUrl()).origin;
      for (const url of [...mock.requests, ...mock.accountRequests]) {
        expect(url.origin, 'the records API must be a same-origin relative path').toBe(origin);
      }
    }
  }
});

function leadsUrl(): string {
  const urls = stack() as StackUrls & { webLeadsUrl?: string };
  if (typeof urls.webLeadsUrl !== 'string' || urls.webLeadsUrl === '') {
    throw new Error(
      'the stack file has no webLeadsUrl: scripts/run-e2e.mjs starts no web process with ' +
        'crm_leads on (see the header of p04-leads.spec.ts)',
    );
  }
  return urls.webLeadsUrl;
}

function screen(page: Page): Locator {
  return page.locator(SCREEN);
}

/** Visible elements only: a screen may render a table and a card list and switch them with CSS. */
function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

function row(page: Page, id: string): Locator {
  return shown(screen(page).locator(`[data-row-id="${id}"]`));
}

function cell(page: Page, id: string, field: string): Locator {
  return row(page, id).locator(`[data-field="${field}"]`);
}

function ownerCell(page: Page, id: string): Locator {
  return row(page, id).locator('[data-field="owner"], [data-field="ownerUserId"]');
}

function lockIcon(scope: Locator): Locator {
  // `<Icon name="lock" />` is an aria-hidden ligature span whose text is its name.
  return scope.locator('[aria-hidden="true"]', { hasText: /^\s*lock\s*$/ });
}

function pager(scope: Locator): Locator {
  return shown(scope.locator('[data-testid="load-more"], [data-testid="next-page"]'));
}

function column(page: Page, status: string): Locator {
  return shown(screen(page).locator(`[data-kanban-column="${status}"]`)).first();
}

function card(page: Page, status: string, id: string): Locator {
  return shown(screen(page).locator(`[data-kanban-column="${status}"] [data-row-id="${id}"]`));
}

function convertSheet(page: Page): Locator {
  return page.getByTestId('convert-sheet');
}

/** Text a person can see or hear: aria-hidden subtrees (icon ligatures) removed. */
async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

async function openLeads(page: Page, options: LeadsMockOptions & { path?: string | undefined; state?: string } = {}): Promise<LeadsMock> {
  const mock = await installLeadsMock(page, options);
  active = mock;
  const response = await page.goto(`${leadsUrl()}${options.path ?? '/leads'}`);
  expect(response?.status(), '/leads with crm_leads on').toBe(200);
  await expect(screen(page)).toBeVisible();
  if (options.state !== undefined) {
    await expect(screen(page)).toHaveAttribute('data-list-state', options.state);
  }
  return mock;
}

async function showKanban(page: Page): Promise<void> {
  await shown(screen(page).locator('[data-view-option="kanban"]')).first().click();
  for (const status of LEAD_STATUSES) {
    await expect(column(page, status), `no Kanban column for ${status}`).toBeVisible();
  }
}

/**
 * Drags with real pointer events, in steps, so both an HTML5 drag-and-drop
 * implementation and a pointer-sensor one see a drag start, a move over the
 * target and a drop. Never a sleep: the caller waits on the request or the DOM.
 */
async function drag(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  expect(from, 'the card has no box to drag').not.toBeNull();
  expect(to, 'the column has no box to drop on').not.toBeNull();
  if (from === null || to === null) return;
  const startX = from.x + from.width / 2;
  const startY = from.y + Math.min(from.height / 2, 20);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 160), { steps: 16 });
  await page.mouse.move(to.x + to.width / 2 + 4, to.y + Math.min(to.height / 2, 160) + 4, { steps: 2 });
  await page.mouse.up();
}

async function expectNoTotals(page: Page): Promise<void> {
  const text = await visibleText(screen(page));
  // D-P13: keyset paging, no total, no page count.
  expect(text, 'a "Page X of Y" or "N of TOTAL" was drawn').not.toMatch(/\b\d+\s+of\s+[\d,]+\b/i);
  expect(text, 'a "1–25 of N" range was drawn').not.toMatch(/\d+\s*[–-]\s*\d+\s+of\s+[\d,]+/i);
  const heading = screen(page).getByRole('heading', { level: 1 });
  if ((await heading.count()) > 0) {
    expect(await visibleText(heading.first()), 'a count was drawn in the title').not.toMatch(/\d/);
  }
}

/** A Kanban column's own chrome — its heading and controls, cards removed — carries no number (D-P13). */
async function columnChrome(page: Page, status: string): Promise<string> {
  return column(page, status).evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[data-row-id], [aria-hidden="true"]').forEach((node) => node.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/**
 * No UUID a person can see or hear: visible text, the accessible-name
 * attributes, form values a person reads and the document title. Ids in
 * `data-*` and `href` are not printed.
 */
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
      if (element instanceof HTMLInputElement && !['hidden', 'checkbox', 'radio'].includes(element.type)) {
        out.push(element.value);
      }
      if (element instanceof HTMLSelectElement) {
        out.push(element.selectedOptions[0]?.textContent ?? '');
      }
      if (element instanceof HTMLOptionElement) {
        out.push(element.textContent ?? '');
      }
    }
    return out.join('\n');
  });
  expect(printed.match(UUID)?.[0], `an id was printed (${where})`).toBeUndefined();
}

async function expectNoSeriousAxe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help}`),
    `serious or critical accessibility violations on ${label}`,
  ).toEqual([]);
  expect(results.passes.length, 'axe checked nothing').toBeGreaterThan(0);
}

/** Opens a filter and picks a value. */
async function pickFilter(page: Page, filter: string, value: string): Promise<void> {
  const option = () => shown(page.locator(`[data-filter-menu="${filter}"] [data-filter-option="${value}"]`));
  if ((await option().count()) === 0) {
    await shown(screen(page).locator(`[data-filter="${filter}"]`)).first().click();
  }
  await expect(option().first(), `the ${filter} menu does not offer "${value}"`).toBeVisible();
  await option().first().click();
  const apply = shown(page.getByTestId('filter-apply'));
  if ((await apply.count()) > 0) {
    await apply.first().click();
  }
}

async function applyFilter(page: Page, filter: string, value: string): Promise<URLSearchParams> {
  const sent = page.waitForRequest(
    (request) => isListLeads(request) && new URL(request.url()).searchParams.getAll(filter).includes(value),
  );
  await pickFilter(page, filter, value);
  return new URL((await sent).url()).searchParams;
}

async function search(page: Page, text: string): Promise<URLSearchParams> {
  const sent = page.waitForRequest(
    (request) => isListLeads(request) && new URL(request.url()).searchParams.get('q') === text,
  );
  await shown(screen(page).locator('input[type="search"]')).first().fill(text);
  return new URL((await sent).url()).searchParams;
}

/** The row's own convert action. */
function convertControl(page: Page, id: string): Locator {
  return row(page, id).locator('[data-action="convert-lead"]');
}

async function openConvert(page: Page, id: string): Promise<Locator> {
  const control = convertControl(page, id).first();
  await expect(control, `no convert action in the row of ${id}`).toBeVisible();
  await control.click();
  const sheet = convertSheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('role', 'dialog');
  return sheet;
}

function picker(sheet: Locator): Locator {
  return sheet.getByTestId('account-picker');
}

/** Chooses the convert form: a radio input is checked (through its label if it is visually hidden), anything else clicked. */
async function chooseMode(sheet: Locator, mode: 'existing' | 'new'): Promise<void> {
  const control = sheet.locator(`[data-convert-mode="${mode}"]`).first();
  await expect(control, `the convert sheet offers no "${mode}" account form`).toBeAttached();
  const radio = await control.evaluate((element) => element instanceof HTMLInputElement && element.type === 'radio');
  if (radio) {
    await control.check();
  } else {
    await control.click();
  }
}

/** Chooses "an existing account" and searches the picker. Waits for listAccounts to answer. */
async function searchPicker(page: Page, sheet: Locator, term: string): Promise<void> {
  await chooseMode(sheet, 'existing');
  const box = picker(sheet).locator('input[type="search"], input[role="combobox"]').first();
  await expect(box, 'the account picker has no search box').toBeVisible();
  const answered = page.waitForResponse(
    (response) => isListAccounts(response.request()) && new URL(response.url()).searchParams.get('q') === term,
  );
  await box.fill(term);
  expect((await answered).status()).toBe(200);
}

async function chooseNewAccount(sheet: Locator, name: string): Promise<void> {
  await chooseMode(sheet, 'new');
  const input = sheet.locator('[data-field-input="newAccount.name"]').first();
  await expect(input, 'the new-account form has no name input').toBeVisible();
  await input.fill(name);
}

function confirm(sheet: Locator): Locator {
  return sheet.locator('[data-action="confirm-convert"]').first();
}

function json(body: unknown): Record<string, unknown> {
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the write body is not an object').toBe(
    true,
  );
  return body as Record<string, unknown>;
}

async function isDisabled(locator: Locator): Promise<boolean> {
  return locator.evaluate(
    (element) => (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true',
  );
}

/** Everything a served row could put on the device, for the storage check. */
function needles(rows: readonly ContactRow[]): string[] {
  const out = new Set<string>();
  for (const contact of rows) {
    out.add(contact.id);
    out.add(contact.displayName);
    if (typeof contact.companyName === 'string') out.add(contact.companyName);
    for (const phone of (Array.isArray(contact.phones) ? contact.phones : []) as { e164: string }[]) {
      out.add(phone.e164);
    }
    const owner = contact.owner as { displayName?: string } | null | undefined;
    if (typeof owner?.displayName === 'string') out.add(owner.displayName);
  }
  for (const account of allAccounts()) {
    out.add(account.id);
    out.add(account.name);
  }
  return [...out];
}

/** Every value the page has written to the device: web storage, cookies, IndexedDB and Cache Storage. */
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

/** Strings drawn outside `[data-record-text]` that did not come through i18n, under en-XA. */
async function pseudoReport(page: Page): Promise<{ english: string[]; forged: string[]; pseudoCount: number }> {
  const served = JSON.stringify({
    rows: scenarioRows('default'),
    programmes: [PROGRAMME_ONE, PROGRAMME_TWO],
    accounts: allAccounts(),
  });
  return page.locator('[data-shell="crm"]').evaluate((root, servedJson) => {
    const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
    const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
    const digits = (text: string) => text.replace(/\D/g, '');
    const recordish = (text: string) =>
      servedJson.includes(text) || (digits(text).length >= 7 && digits(servedJson).includes(digits(text)));
    const skipped = (element: Element | null) =>
      element === null ||
      element.closest('[aria-hidden="true"], [data-testid^="language-"], script, style, noscript') !== null;

    const english: string[] = [];
    const forged: string[] = [];
    let pseudoCount = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim();
      const parent = node.parentElement;
      if (!letters(text) || skipped(parent)) continue;
      if (parent?.closest('[data-record-text]')) {
        if (!recordish(text)) forged.push(text);
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
  }, served);
}

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract refuses, and records it as the screen’s fault @leads-p04 @leads-p04-mock', async ({
  page,
}) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (sign-in on the default server) and
  // watch every malformed request land in `violations`.
  const { webUrl } = stack();
  let mock = await installLeadsMock(page, { role: 'writer' });
  await page.goto(`${webUrl}/`);
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    page.evaluate(
      async ([target, verb, payload, extra]) => {
        const response = await fetch(target, {
          method: verb,
          headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
          body: payload === undefined ? null : JSON.stringify(payload),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      },
      [path, method, body, headers] as const,
    );
  const expectViolation = async (
    path: string,
    method: string,
    body: unknown,
    status: number,
    what: RegExp,
    headers: Record<string, string> = {},
  ) => {
    const before = mock.violations.length;
    expect((await call(path, method, body, headers)).status, `${method} ${path}`).toBe(status);
    expect(mock.violations.slice(before).join('\n'), `${method} ${path} was not recorded`).toMatch(what);
  };
  const contact = (id: string) => `/api/v1/contacts/${id}`;

  // Served as the contract says: four leads a page, never the customer, a withheld field absent.
  const first = await call('/api/v1/leads');
  expect(first.status).toBe(200);
  const data = first.body.data as ContactRow[];
  expect(data.map((lead) => lead.id)).toEqual([LEAD_NEW.id, LEAD_NULLS.id, LEAD_LOCKED.id, LEAD_EXAMPLE.id]);
  expect(typeof first.body.nextCursor).toBe('string');
  expect('companyName' in (data[2] ?? {}), 'a withheld field was sent').toBe(false);
  const second = await call(`/api/v1/leads?cursor=${String(first.body.nextCursor)}`);
  expect((second.body.data as ContactRow[]).map((lead) => lead.id)).toEqual([LEAD_LINKED.id, LEAD_PAGE_TWO.id]);
  expect(second.body.nextCursor).toBeNull();
  expect(JSON.stringify([first.body, second.body]), 'listLeads served a customer').not.toContain(CUSTOMER.id);
  const picked = await call('/api/v1/accounts?q=Ltd');
  expect((picked.body.data as { id: string }[]).map((account) => account.id).sort()).toEqual(
    [ACCOUNT_EXAMPLE.id, ACCOUNT_SAME_PROGRAMME.id, ACCOUNT_OTHER_PROGRAMME.id].sort(),
  );
  expect(mock.violations, 'a well-formed request was recorded as a violation').toEqual([]);

  // Refused, and blamed on the screen: reads.
  await expectViolation('/api/v1/leads?status=customer', 'GET', undefined, 400, /status=customer/);
  await expectViolation('/api/v1/leads?programmeId=x', 'GET', undefined, 400, /no "programmeId"/);
  await expectViolation('/api/v1/leads?sort=companyName', 'GET', undefined, 400, /sort=companyName/);
  await expectViolation(`/api/v1/leads?q=${'a'.repeat(101)}`, 'GET', undefined, 400, /longer than 100/);
  await expectViolation('/api/v1/leads?cursor=forged', 'GET', undefined, 400, /never served/);
  await expectViolation(
    `/api/v1/leads?status=new&cursor=${String(first.body.nextCursor)}`,
    'GET',
    undefined,
    400,
    /different query/,
  );
  await expectViolation('/api/v1/contacts?status=new', 'GET', undefined, 404, /listContacts/);
  await expectViolation('/api/v1/leads/map', 'GET', undefined, 404, /not an operation/);
  await expectViolation('/api/v1/leads', 'GET', undefined, 200, /header/, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id });
  await expectViolation('/api/v1/accounts?programmeId=x', 'GET', undefined, 400, /no "programmeId"/);

  // Refused: the move.
  await expectViolation(contact(LEAD_NEW.id), 'PATCH', { version: 2, status: 'contacted', companyName: 'X' }, 400, /exactly/);
  await expectViolation(contact(LEAD_NEW.id), 'PATCH', { version: 1, status: 'contacted' }, 409, /last served 2/);
  await expectViolation(contact(LEAD_NEW.id), 'PATCH', { version: 2, status: 'customer' }, 400, /lead status/);
  await expectViolation(contact(LEAD_NEW.id), 'PATCH', { version: 2, status: 'new' }, 400, /already in/);
  await expectViolation(contact(CUSTOMER.id), 'PATCH', { version: 7, status: 'new' }, 404, /never served/);

  // Refused: convert.
  await expectViolation(`${contact(LEAD_EXAMPLE.id)}/convert`, 'POST', { version: 3, accountId: ACCOUNT_EXAMPLE.id }, 403, /withholds/);
  await expectViolation(
    `${contact(LEAD_NEW.id)}/convert`,
    'POST',
    { version: 2, accountId: ACCOUNT_SAME_PROGRAMME.id, newAccount: { name: 'X' } },
    400,
    /oneOf/,
  );
  await expectViolation(`${contact(LEAD_NEW.id)}/convert`, 'POST', { version: 2, newAccount: { name: 'X' }, status: 'qualified' }, 400, /closed body/);
  await expectViolation(`${contact(LEAD_NEW.id)}/convert`, 'POST', { version: 2, newAccount: { name: '' } }, 400, /too short/);
  await expectViolation(`${contact(LEAD_NEW.id)}/convert`, 'POST', { version: 2, accountId: ACCOUNT_OTHER_PROGRAMME.id }, 404, /another programme/);
  await expectViolation(`${contact(LEAD_NEW.id)}/convert`, 'POST', { version: 2, accountId: NEW_ACCOUNT_IDS[9] }, 404, /never served/);
  await expectViolation('/api/v1/accounts', 'POST', { name: 'X', programmeId: PROGRAMME_ONE.id }, 404, /createAccount/);
  expect(mock.violations.length, 'the refusals above were not all recorded').toBe(22);

  // And well-formed writes are applied: a move, a convert, its exact repeat, a new account.
  const moved = await call(contact(LEAD_NEW.id), 'PATCH', { version: 2, status: 'contacted' });
  expect(moved.status).toBe(200);
  expect(moved.body.version).toBe(3);
  const converted = await call(`${contact(LEAD_NEW.id)}/convert`, 'POST', { version: 3, accountId: ACCOUNT_SAME_PROGRAMME.id });
  expect(converted.status).toBe(200);
  expect(Object.keys(converted.body).sort()).toEqual(['account', 'contact']);
  expect((converted.body.contact as ContactRow).status).toBe('qualified');
  expect((converted.body.contact as ContactRow).version).toBe(4);
  const repeated = await call(`${contact(LEAD_NEW.id)}/convert`, 'POST', { version: 3, accountId: ACCOUNT_SAME_PROGRAMME.id });
  expect(repeated.status, 'an exact repeat on the version it made stale is 200').toBe(200);
  expect((repeated.body.contact as ContactRow).version, 'a repeat advanced the version').toBe(4);
  expect(mock.repeats()).toBe(1);
  const created = await call(`${contact(LEAD_NULLS.id)}/convert`, 'POST', { version: 1, newAccount: { name: 'Danladi Farms' } });
  expect(created.status).toBe(200);
  expect((created.body.account as { id: string; name: string }).name).toBe('Danladi Farms');
  expect(mock.createdAccounts.map((account) => account.id)).toEqual([NEW_ACCOUNT_IDS[0]]);
  const linkedElsewhere = await call(`${contact(LEAD_LINKED.id)}/convert`, 'POST', { version: 3, newAccount: { name: 'Nwosu Ventures' } });
  expect(linkedElsewhere.status).toBe(400);
  expect(JSON.stringify(linkedElsewhere.body.details)).toContain('already_linked');
  expect(mock.violations.length, 'a well-formed write was recorded as a violation').toBe(22);

  // An agent (the default caller) may move a lead and may not convert one: 403, and not the screen's fault.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  mock = await installLeadsMock(page);
  await call('/api/v1/leads');
  expect((await call(`${contact(LEAD_NEW.id)}/convert`, 'POST', { version: 2, newAccount: { name: 'X' } })).status).toBe(403);
  expect((await call(contact(LEAD_NEW.id), 'PATCH', { version: 2, status: 'contacted' })).status).toBe(200);
  expect(mock.violations).toEqual([]);
  // The empty scenario holds a customer and no leads.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  mock = await installLeadsMock(page, { scenario: 'empty' });
  expect((await call('/api/v1/leads')).body.data).toEqual([]);
  // status withheld anywhere: every listLeads is 400 at status.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  mock = await installLeadsMock(page, { scenario: 'statusWithheld' });
  const refused = await call('/api/v1/leads');
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body.details)).toContain('"path":"status"');
  expect(mock.violations).toEqual([]);
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_leads gates /leads', () => {
  // The two flag-off tests PASS BEFORE THE WORK STARTS: with no /leads route
  // every path is already a 404. A negative invariant, legitimately vacuous
  // until the route exists; the flag-on test is what gives the pair meaning,
  // and it fails until then.
  test('/leads is a real 404 with crm_leads at its default, and nothing reaches the records API @leads-p04 @leads-p04-flag-off', async ({
    page,
  }) => {
    const { webUrl } = stack();
    const mock = await installLeadsMock(page);
    const response = await page.goto(`${webUrl}/leads`);
    expect(response?.status(), '/leads is reachable with crm_leads off').toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    expect(mock.requests, 'a flag-off page still read the leads').toEqual([]);
    expect([...mock.updates, ...mock.converts]).toEqual([]);
  });

  test('/leads cannot be switched on by anything the browser sends @leads-p04 @leads-p04-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-kasuwa-feature-flags': 'crm_leads',
        'x-crm-leads': '1',
        'x-kasuwa-tenant-id': TENANT_A,
      },
    });
    await context.addCookies([
      { name: 'crm_leads', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_leads,crm_records', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of ['/leads?crm_leads=on&flags=crm_leads', '/leads/', '/leads?view=kanban', '/leads?locale=en-XA']) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/leads renders with crm_leads on @leads-p04 @leads-p04-flag-on', async ({ page }) => {
    await openLeads(page, { state: 'ready' });
    await expect(row(page, LEAD_NEW.id)).toBeVisible();
  });
});

// ===========================================================================
// The shell
// ===========================================================================

test('/leads sits in the CRM shell, its nav marks Leads current, and no link on it is a 404 @leads-p04 @leads-p04-shell', async ({
  page,
}) => {
  await openLeads(page, { state: 'ready' });
  const shell = page.locator('[data-shell="crm"]');
  await expect(shell).toBeVisible();
  await expect(shell.locator(SCREEN)).toBeVisible();
  await expect(page.getByTestId('settings-menu')).toHaveCount(0);

  const nav = shown(shell.locator('nav')).first();
  await expect(nav.locator('a[href="/leads"]')).toHaveAttribute('aria-current', 'page');

  // Every same-origin link on the page, nav and rows alike. A row that links
  // to a page this process does not serve is a broken link.
  const hrefs = await page
    .locator('a[href^="/"]')
    .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute('href') ?? ''))]);
  expect(hrefs).toContain('/leads');
  for (const href of hrefs) {
    const response = await page.request.get(`${leadsUrl()}${href}`);
    expect(response.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }
});

// ===========================================================================
// P04/01 — the table
// ===========================================================================

test.describe('P04/01 — the leads table', () => {
  test('draws the P04/01 columns, only Contact properties, names and labels not ids or codes, and passes axe @leads-p04 @leads-p04-columns', async ({
    page,
  }) => {
    const mock = await openLeads(page, { state: 'ready' });
    expect(mock.requests.length, 'the table was not read from listLeads').toBeGreaterThan(0);

    const columns = await screen(page)
      .locator('[role="columnheader"][data-column]')
      .evaluateAll((headers) => headers.map((header) => header.getAttribute('data-column') ?? ''));
    for (const required of ['displayName', 'companyName', 'phones', 'status']) {
      expect(columns, `no ${required} column`).toContain(required);
    }
    expect(
      columns.filter((name) => name === 'owner' || name === 'ownerUserId').length,
      'no owner column (data-column="owner" or "ownerUserId")',
    ).toBeGreaterThan(0);
    // Lead score, Last activity and counts have no Contact property behind them.
    const invented = columns.filter((name) => !CONTACT_PROPERTIES.includes(name));
    expect(invented, 'columns with no Contact property behind them').toEqual([]);

    await expect(cell(page, LEAD_EXAMPLE.id, 'displayName')).toContainText(LEAD_EXAMPLE.displayName);
    await expect(cell(page, LEAD_EXAMPLE.id, 'companyName')).toContainText(String(LEAD_EXAMPLE.companyName));
    // The owner's name is embedded on the row (T-0043); the id is not a name.
    await expect(ownerCell(page, LEAD_EXAMPLE.id)).toContainText('Kemi Balogun');
    const phone = await visibleText(cell(page, LEAD_EXAMPLE.id, 'phones'));
    expect(phone.replace(/\D/g, ''), 'the phone is not drawn').toContain('8030000001');

    // The status is a code on the wire and a translated label on screen.
    for (const lead of [LEAD_NEW, LEAD_EXAMPLE, LEAD_NULLS]) {
      const status = await visibleText(cell(page, lead.id, 'status'));
      expect(status, `the status of ${lead.displayName} is empty`).not.toBe('');
      expect(status, `the status code was drawn instead of its label`).not.toBe(String(lead.status));
    }
    // The customer listContacts would have put first is not a lead.
    await expect(row(page, CUSTOMER.id)).toHaveCount(0);

    await expectNoIdsAnywhere(page, 'the table');
    await expectNoTotals(page);
    await expectNoSeriousAxe(page, 'P04/01');
  });

  test('record data with markup in it is drawn as text, never parsed @leads-p04 @leads-p04-columns', async ({ page }) => {
    await openLeads(page, { scenario: 'hostile', state: 'ready' });
    const parsed = '[onerror], script, b:text-is("Ltd"), b:text-is("Adé"), i:text-is("VIP")';
    await expect(cell(page, LEAD_HOSTILE.id, 'displayName')).toContainText('<b>Adé</b>');
    await expect(cell(page, LEAD_HOSTILE.id, 'companyName')).toContainText('<b>Ltd</b>');
    await expect(row(page, LEAD_HOSTILE.id).locator(parsed)).toHaveCount(0);

    // A search that highlights the match must not do it by building HTML.
    await search(page, 'Àdìsá');
    await expect(row(page, LEAD_HOSTILE.id)).toBeVisible();
    await expect(row(page, LEAD_HOSTILE.id).locator(parsed)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss)).toBeUndefined();
    expect(HOSTILE_NAME).toContain('<img');
    expect(HOSTILE_COMPANY).toContain('<script>');
  });

  test('search sends q for a name, a company or a number, never longer than the contract allows, and stays out of the address bar @leads-p04 @leads-p04-search', async ({
    page,
  }) => {
    await openLeads(page, { state: 'ready' });

    // q matches the company too, on the server: "Fabrics" finds Adaeze Okonkwo's lead.
    expect((await search(page, 'Fabrics')).get('q')).toBe('Fabrics');
    await expect(row(page, LEAD_EXAMPLE.id)).toBeVisible();
    await expect(row(page, LEAD_NEW.id)).toHaveCount(0);

    // A family name as a person types it. A number never goes in a list's q
    // since T-0124 (identifier_in_url, D-L180 I9; lead re-pin), so the journey
    // searches by name.
    const byName = page.waitForRequest(
      (request) => isListLeads(request) && (new URL(request.url()).searchParams.get('q') ?? '').trim() === 'Bakare',
    );
    await shown(screen(page).locator('input[type="search"]')).first().fill('Bakare');
    await byName;
    await expect(row(page, LEAD_NEW.id)).toBeVisible();
    await expect(row(page, LEAD_EXAMPLE.id)).toHaveCount(0);

    // Names are personal data: in the address bar they land in history,
    // bookmarks and every Referer (D-L64).
    expect(page.url(), 'the search term was written into the page URL').not.toMatch(/fabrics|bakare|[?&]q=/i);
    expect(await page.title(), 'the search term was written into the document title').not.toMatch(/fabrics|bakare/i);

    // q is at most 100 characters (the mock records anything longer).
    const long = 'Bakare Logistics '.repeat(8);
    const sent = page.waitForRequest(
      (request) => isListLeads(request) && (new URL(request.url()).searchParams.get('q') ?? '').length >= 90,
    );
    await shown(screen(page).locator('input[type="search"]')).first().fill(long);
    expect((new URL((await sent).url()).searchParams.get('q') ?? '').length).toBeLessThanOrEqual(100);
  });

  test('filter chips are exactly listLeads’ filters, status offers the four lead stages only, and no chip shows a count @leads-p04 @leads-p04-filters', async ({
    page,
  }) => {
    await openLeads(page, { state: 'ready' });

    const chips = await screen(page)
      .locator('[data-filter]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-filter') ?? ''));
    expect(chips.filter((chip) => !FILTER_PARAMETERS.includes(chip)), 'chips for filters listLeads does not declare').toEqual(
      [],
    );
    for (const expected of FILTER_PARAMETERS) {
      expect(chips, `no ${expected} chip`).toContain(expected);
    }
    // D-P13: no live count on any chip.
    for (const chip of await shown(screen(page).locator('[data-filter]')).all()) {
      expect(await visibleText(chip), 'a filter chip shows a count').not.toMatch(/\d/);
    }

    // The status menu offers the lead stages, every one, and never `customer`.
    await shown(screen(page).locator('[data-filter="status"]')).first().click();
    const offered = await page
      .locator('[data-filter-menu="status"] [data-filter-option]')
      .evaluateAll((options) => options.map((option) => option.getAttribute('data-filter-option') ?? ''));
    expect([...offered].sort(), 'the status menu does not offer exactly the four lead stages').toEqual(
      [...LEAD_STATUSES].sort(),
    );
    for (const option of await shown(page.locator('[data-filter-menu="status"] [data-filter-option]')).all()) {
      expect(await visibleText(option), 'a status option shows a count').not.toMatch(/\d/);
    }
    await page.keyboard.press('Escape');

    const status = await applyFilter(page, 'status', 'contacted');
    expect(status.getAll('status')).toEqual(['contacted']);
    await expect(row(page, LEAD_EXAMPLE.id)).toBeVisible();
    await expect(row(page, LEAD_NEW.id)).toHaveCount(0);

    const owner = await applyFilter(page, 'owner', 'me');
    expect(owner.getAll('owner')).toContain('me');
    expect(owner.getAll('status'), 'a second filter dropped the first').toEqual(['contacted']);

    const source = await applyFilter(page, 'source', 'whatsapp');
    expect(source.getAll('source')).toEqual(['whatsapp']);
    expect(parameterEnum('source')).toContain('whatsapp');
    await expect(row(page, LEAD_EXAMPLE.id)).toBeVisible();
    await expect(row(page, LEAD_PAGE_TWO.id)).toBeVisible();
  });

  test('a filter the API refuses as field_withheld is an error, never "no results" @leads-p04 @leads-p04-filters', async ({
    page,
  }) => {
    // LEAD_OWNER_LOCKED's programme withholds the owner, so listLeads answers
    // any owner filter 400 field_withheld. Disabling the chip is fine; showing
    // a filtered-looking empty list is not.
    await openLeads(page, { scenario: 'mixedWithheld', state: 'ready' });
    const chip = shown(screen(page).locator('[data-filter="owner"]')).first();
    await expect(chip).toBeVisible();
    if (await isDisabled(chip)) {
      await expect(lockIcon(chip), 'a disabled owner chip does not say it is locked').toHaveCount(1);
      return;
    }
    const answered = page.waitForResponse(
      (response) => isListLeads(response.request()) && new URL(response.url()).searchParams.has('owner'),
    );
    await pickFilter(page, 'owner', 'me');
    expect((await answered).status()).toBe(400);
    await expect(screen(page)).toHaveAttribute('data-list-state', 'error');
    await expect(shown(screen(page).getByTestId('list-error'))).toBeVisible();
    expect(await visibleText(screen(page).getByTestId('list-error'))).not.toBe('');
    await expect(screen(page).getByTestId('no-results-message')).toHaveCount(0);
  });

  test('a caller whose role withholds status anywhere gets an error, never an empty list of leads @leads-p04 @leads-p04-filters', async ({
    page,
  }) => {
    // listLeads IS a filter on status: withheld in any programme, the answer is 400 at `status`.
    await openLeads(page, { scenario: 'statusWithheld', state: 'error' });
    await expect(shown(screen(page).getByTestId('list-error'))).toBeVisible();
    expect(await visibleText(screen(page).getByTestId('list-error'))).not.toBe('');
    await expect(screen(page).getByTestId('empty-state')).toHaveCount(0);
    await expect(screen(page).getByTestId('no-results-message')).toHaveCount(0);
    await expect(screen(page).locator('[data-row-id]')).toHaveCount(0);
  });

  test('sorts only by never-withheld keys, and a new sort starts from the first page @leads-p04 @leads-p04-sort', async ({
    page,
  }) => {
    await openLeads(page, { state: 'ready' });

    const sortable = await screen(page)
      .locator('[role="columnheader"][aria-sort]')
      .evaluateAll((headers) => headers.map((header) => header.getAttribute('data-column') ?? ''));
    expect(
      sortable.filter((name) => !SORTABLE_FIELDS.includes(name)),
      'a column field security can withhold is offered as a sort',
    ).toEqual([]);
    for (const name of ['companyName', 'status', 'owner', 'ownerUserId', 'source', 'phones', 'tags']) {
      await expect(screen(page).locator(`[role="columnheader"][data-column="${name}"] button`)).toHaveCount(0);
    }

    // Go to page two, then change the sort: the old cursor must not travel with it.
    const paged = page.waitForRequest(
      (request) => isListLeads(request) && new URL(request.url()).searchParams.has('cursor'),
    );
    await pager(screen(page)).first().click();
    await paged;
    await expect(row(page, LEAD_PAGE_TWO.id)).toBeVisible();

    let sent: URLSearchParams;
    const control = shown(screen(page).getByTestId('sort-control'));
    if ((await control.count()) > 0) {
      const sorted = page.waitForRequest(isListLeads);
      await control.first().click();
      await shown(page.locator('[data-sort-option="createdAt"]')).first().click();
      sent = new URL((await sorted).url()).searchParams;
    } else {
      // A sortable created header: one or two presses reach createdAt (oldest
      // first). T-0124 removed the displayName sort (D-L180 I5; lead re-pin).
      const header = screen(page).locator('[role="columnheader"][data-column="createdAt"] button');
      await expect(header, 'no sort control and no sortable created header').toBeVisible();
      const first = page.waitForRequest(isListLeads);
      await header.click();
      sent = new URL((await first).url()).searchParams;
      if (sent.get('sort') !== 'createdAt') {
        const second = page.waitForRequest(isListLeads);
        await header.click();
        sent = new URL((await second).url()).searchParams;
      }
    }
    expect(sent.get('sort'), 'the sort did not reach createdAt').toBe('createdAt');
    expect(SORT_VALUES).toContain(sent.get('sort'));
    expect(sent.has('cursor'), 'a new sort was sent with the old cursor').toBe(false);
    // Under createdAt, the oldest lead (page two's) leads the first page and the
    // newest, Tunde Bakare, is on the next.
    await expect(row(page, LEAD_PAGE_TWO.id)).toBeVisible();
    await expect(row(page, LEAD_NEW.id)).toHaveCount(0);
  });

  test('a withheld field shows a lock, per row, never an empty cell, and a null field is never a lock @leads-p04 @leads-p04-locked', async ({
    page,
  }) => {
    await openLeads(page, { state: 'ready' });

    for (const field of ['companyName', 'phones']) {
      expect(LEAD_LOCKED.withheldFields).toContain(field);
      const locked = cell(page, LEAD_LOCKED.id, field);
      await expect(locked).toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(locked)).toHaveCount(1);
      const said = await visibleText(locked);
      expect(said, `${field} is withheld and drawn as empty`).not.toBe('');
      expect(said, `${field} is withheld and drawn as a missing value`).not.toMatch(/^(null|undefined|—|-|–|0)$/i);
      // The same column is readable on another row, in the other programme.
      await expect(cell(page, LEAD_NEW.id, field)).not.toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(cell(page, LEAD_NEW.id, field))).toHaveCount(0);
    }

    // LEAD_NULLS has no company, owner, phone or source: "no value", not a lock.
    for (const target of [ownerCell(page, LEAD_NULLS.id), cell(page, LEAD_NULLS.id, 'companyName'), cell(page, LEAD_NULLS.id, 'phones')]) {
      await expect(target).toBeVisible();
      await expect(target).not.toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(target)).toHaveCount(0);
      expect(await visibleText(target), 'a null is drawn as text').not.toMatch(/null|undefined/i);
    }
  });

  test('a withheld owner is locked per row, beside rows whose owner is readable @leads-p04 @leads-p04-locked', async ({
    page,
  }) => {
    await openLeads(page, { scenario: 'mixedWithheld', state: 'ready' });
    expect(LEAD_OWNER_LOCKED.withheldFields).toEqual(expect.arrayContaining(['ownerUserId', 'owner']));
    const locked = ownerCell(page, LEAD_OWNER_LOCKED.id);
    await expect(locked).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(locked)).toHaveCount(1);
    expect(await visibleText(locked)).not.toBe('');
    await expect(ownerCell(page, LEAD_EXAMPLE.id)).toContainText('Kemi Balogun');
    await expect(ownerCell(page, LEAD_EXAMPLE.id)).not.toHaveAttribute('data-locked', 'true');
    await expect(ownerCell(page, LEAD_NEW.id)).toContainText('Tunde Adeyemi');
  });

  test('pages forward with nextCursor, echoed exactly, never into the address bar, with no total @leads-p04 @leads-p04-paging', async ({
    page,
  }) => {
    const mock = await openLeads(page, { state: 'ready' });
    for (const id of [LEAD_NEW.id, LEAD_NULLS.id, LEAD_LOCKED.id, LEAD_EXAMPLE.id]) {
      await expect(row(page, id)).toBeVisible();
    }
    await expect(row(page, LEAD_PAGE_TWO.id)).toHaveCount(0);
    await expectNoTotals(page);

    // Four rows against a limit of 25, and a nextCursor: more exists.
    await expect(pager(screen(page)).first()).toBeEnabled();
    const sent = page.waitForRequest(
      (request) => isListLeads(request) && new URL(request.url()).searchParams.has('cursor'),
    );
    await pager(screen(page)).first().click();
    const cursor = new URL((await sent).url()).searchParams.get('cursor') ?? '';
    expect(mock.issuedCursors(), 'the cursor was not one the API served').toContain(cursor);
    await expect(row(page, LEAD_PAGE_TWO.id)).toBeVisible();
    await expect(row(page, LEAD_LINKED.id)).toBeVisible();
    await expectNoTotals(page);

    // A real cursor carries the last row's name (D-L80): never in the page URL.
    expect(page.url(), 'the cursor was written into the page URL').not.toContain(cursor);
    expect(page.url()).not.toMatch(/[?&]cursor=/);
    const more = pager(screen(page));
    if ((await more.count()) > 0) {
      await expect(more.first()).toBeDisabled();
    }
    await expectNoIdsAnywhere(page, 'after paging');
  });

  test('the next page keeps the search and the filters that produced the cursor @leads-p04 @leads-p04-paging', async ({
    page,
  }) => {
    await openLeads(page, { state: 'ready', pageSize: 1 });
    await applyFilter(page, 'status', 'contacted');
    const q = (await search(page, 'a')).get('q');
    await expect(row(page, LEAD_EXAMPLE.id)).toBeVisible();
    await expect(pager(screen(page)).first()).toBeEnabled();
    const next = page.waitForRequest(
      (request) => isListLeads(request) && new URL(request.url()).searchParams.has('cursor'),
    );
    await pager(screen(page)).first().click();
    const params = new URL((await next).url()).searchParams;
    expect(params.get('q'), 'the cursor was sent without its search').toBe(q);
    expect(params.getAll('status'), 'the cursor was sent without its filter').toEqual(['contacted']);
    await expect(row(page, LEAD_PAGE_TWO.id)).toBeVisible();
  });
});

// ===========================================================================
// P04/04 — the Kanban
// ===========================================================================

test.describe('P04/04 — the Kanban by status', () => {
  test('one column per lead stage, each read with its own status, cards where their status says, no counts @leads-p04 @leads-p04-kanban', async ({
    page,
  }) => {
    const mock = await openLeads(page, { state: 'ready' });
    await showKanban(page);

    const columns = await screen(page)
      .locator('[data-kanban-column]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-kanban-column') ?? ''));
    expect([...new Set(columns)].sort(), 'the Kanban columns are not exactly the four lead stages').toEqual(
      [...LEAD_STATUSES].sort(),
    );

    // "One Kanban column is one value" (listLeads): each column pages on its own
    // cursor, so a busy stage cannot push a quiet one off the board.
    for (const status of LEAD_STATUSES) {
      await expect
        .poll(
          () =>
            mock.requests.some((url) => {
              const sent = url.searchParams.getAll('status');
              return sent.length === 1 && sent[0] === status;
            }),
          { message: `no listLeads read for the ${status} column alone` },
        )
        .toBe(true);
    }

    await expect(card(page, 'new', LEAD_NEW.id)).toBeVisible();
    await expect(card(page, 'new', LEAD_LOCKED.id)).toBeVisible();
    await expect(card(page, 'contacted', LEAD_EXAMPLE.id)).toBeVisible();
    await expect(card(page, 'contacted', LEAD_PAGE_TWO.id)).toBeVisible();
    await expect(card(page, 'qualified', LEAD_LINKED.id)).toBeVisible();
    await expect(card(page, 'unqualified', LEAD_NULLS.id)).toBeVisible();
    await expect(screen(page).locator(`[data-row-id="${CUSTOMER.id}"]`)).toHaveCount(0);
    await expect(screen(page).locator('[data-kanban-column="customer"]')).toHaveCount(0);

    // A card names the lead and its company; a withheld company is a lock, never blank.
    await expect(card(page, 'new', LEAD_NEW.id).locator('[data-field="displayName"]')).toContainText(LEAD_NEW.displayName);
    await expect(card(page, 'new', LEAD_NEW.id).locator('[data-field="companyName"]')).toContainText(String(LEAD_NEW.companyName));
    const lockedCompany = card(page, 'new', LEAD_LOCKED.id).locator('[data-field="companyName"]');
    await expect(lockedCompany).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(lockedCompany)).toHaveCount(1);
    expect(await visibleText(lockedCompany)).not.toBe('');

    for (const status of LEAD_STATUSES) {
      const chrome = await columnChrome(page, status);
      expect(chrome, `the ${status} column has no label`).not.toBe('');
      expect(chrome, `the ${status} column shows a count (D-P13)`).not.toMatch(/\d/);
      expect(chrome, `the ${status} column is labelled with its code`).not.toBe(status);
    }
    await expectNoIdsAnywhere(page, 'the Kanban');
    await expectNoSeriousAxe(page, 'P04/04');
  });

  test('a busy column pages on its own cursor, inside the column @leads-p04 @leads-p04-kanban', async ({ page }) => {
    const mock = await openLeads(page, { state: 'ready', pageSize: 1 });
    await showKanban(page);
    await expect(card(page, 'contacted', LEAD_EXAMPLE.id)).toBeVisible();
    await expect(card(page, 'contacted', LEAD_PAGE_TWO.id)).toHaveCount(0);

    const more = pager(column(page, 'contacted')).first();
    await expect(more, 'the contacted column offers no way to its next page').toBeVisible();
    const sent = page.waitForRequest((request) => {
      if (!isListLeads(request)) return false;
      const params = new URL(request.url()).searchParams;
      return params.has('cursor') && params.getAll('status').join() === 'contacted';
    });
    await more.click();
    const cursor = new URL((await sent).url()).searchParams.get('cursor') ?? '';
    expect(mock.issuedCursors()).toContain(cursor);
    await expect(card(page, 'contacted', LEAD_PAGE_TWO.id)).toBeVisible();
    // The other columns are untouched by it.
    await expect(card(page, 'new', LEAD_NEW.id)).toBeVisible();
    expect(page.url()).not.toMatch(/[?&]cursor=/);
  });

  test('dragging a card sends exactly { version, status }, moves it, and the next move sends the version that move was served @leads-p04 @leads-p04-drag', async ({
    page,
  }) => {
    // The default caller is an agent (D-P14, D-P18): a status change is theirs to make.
    const mock = await openLeads(page, { state: 'ready' });
    await showKanban(page);
    const source = card(page, 'new', LEAD_NEW.id).first();
    await expect(source).toBeVisible();

    // Dropped back on its own column: nothing to write. Proved below, without
    // a sleep, by the next write being the FIRST the mock saw.
    await drag(page, source, column(page, 'new'));
    await expect(card(page, 'new', LEAD_NEW.id)).toBeVisible();

    const patched = page.waitForRequest((request) => isUpdateContact(request, LEAD_NEW.id));
    await drag(page, card(page, 'new', LEAD_NEW.id).first(), column(page, 'contacted'));
    const body = json((await patched).postDataJSON());
    expect(Object.keys(body).sort(), 'a move sent more than { version, status }').toEqual(['status', 'version']);
    expect(body).toEqual({ version: LEAD_NEW.version, status: 'contacted' });
    await expect(card(page, 'contacted', LEAD_NEW.id)).toBeVisible();
    await expect(card(page, 'new', LEAD_NEW.id)).toHaveCount(0);
    expect(mock.updates, 'the drop on its own column sent a write').toHaveLength(1);

    const again = page.waitForRequest((request) => isUpdateContact(request, LEAD_NEW.id));
    await drag(page, card(page, 'contacted', LEAD_NEW.id).first(), column(page, 'qualified'));
    expect(json((await again).postDataJSON()), 'the second move did not send the version the first move was served').toEqual({
      version: LEAD_NEW.version + 1,
      status: 'qualified',
    });
    await expect(card(page, 'qualified', LEAD_NEW.id)).toBeVisible();
    expect(mock.rows.find((lead) => lead.id === LEAD_NEW.id)?.status).toBe('qualified');
    await expectNoIdsAnywhere(page, 'after a move');
  });

  test('a refused move puts the card back and says why, in translated copy @leads-p04 @leads-p04-drag-refusals', async ({
    page,
  }) => {
    const cases: { name: string; options: LeadsMockOptions; path?: string; status: number }[] = [
      // en-XA proves the alert is the screen's own copy, not the server's English `message`.
      { name: 'a reader (403 not_permitted)', options: { role: 'reader' }, path: '/leads?locale=en-XA', status: 403 },
      { name: 'another desk saved first (409 stale_write)', options: { refuseUpdate: 'stale_write' }, status: 409 },
    ];
    for (const refusal of cases) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      const mock = await openLeads(page, { state: 'ready', path: refusal.path, ...refusal.options });
      await showKanban(page);
      const answered = page.waitForResponse((response) => isUpdateContact(response.request(), LEAD_NEW.id));
      await drag(page, card(page, 'new', LEAD_NEW.id).first(), column(page, 'contacted'));
      expect((await answered).status(), refusal.name).toBe(refusal.status);

      // Back where the server says it is; nothing optimistic left behind.
      await expect(card(page, 'new', LEAD_NEW.id), `${refusal.name}: the card did not go back`).toBeVisible();
      await expect(card(page, 'contacted', LEAD_NEW.id)).toHaveCount(0);
      const alert = shown(screen(page).getByRole('alert')).first();
      await expect(alert, `${refusal.name}: no alert`).toBeVisible();
      const said = await visibleText(alert);
      expect(said, `${refusal.name}: the alert says nothing`).not.toBe('');
      if (refusal.path !== undefined) {
        expect(said, 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
      }
      expect(mock.rows.find((lead) => lead.id === LEAD_NEW.id)?.status).toBe('new');
      expect(mock.violations).toEqual([]);
    }
  });

  test('every card can be moved without dragging, by pointer or keyboard, through the same write @leads-p04 @leads-p04-move-menu', async ({
    page,
  }) => {
    // WCAG 2.2 SC 2.5.7 (dragging movements) and 2.1.1 (keyboard): a drag is a
    // shortcut, never the only way.
    const mock = await openLeads(page, { state: 'ready' });
    await showKanban(page);
    const move = card(page, 'contacted', LEAD_EXAMPLE.id).locator('[data-action="move-lead"]').first();
    await expect(move, 'the card has no move control').toBeVisible();
    expect(
      await move.evaluate((element) => element.tagName === 'BUTTON' || element.getAttribute('role') === 'button'),
      'the move control is not a button',
    ).toBe(true);
    await move.click();
    const options = await shown(page.locator('[data-move-to]')).evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-move-to') ?? ''),
    );
    expect(options.length, 'the move control offers nowhere to go').toBeGreaterThan(0);
    expect(options.filter((status) => !LEAD_STATUSES.includes(status)), 'a move target that is not a lead stage').toEqual([]);
    expect(options, 'the move control offers the column the card is already in').not.toContain('contacted');

    const patched = page.waitForRequest((request) => isUpdateContact(request, LEAD_EXAMPLE.id));
    await shown(page.locator('[data-move-to="qualified"]')).first().click();
    expect(json((await patched).postDataJSON())).toEqual({ version: LEAD_EXAMPLE.version, status: 'qualified' });
    await expect(card(page, 'qualified', LEAD_EXAMPLE.id)).toBeVisible();

    // Again from the keyboard alone.
    const keyboard = card(page, 'qualified', LEAD_EXAMPLE.id).locator('[data-action="move-lead"]').first();
    await keyboard.focus();
    await page.keyboard.press('Enter');
    const target = shown(page.locator('[data-move-to="unqualified"]')).first();
    await expect(target).toBeVisible();
    await target.focus();
    const second = page.waitForRequest((request) => isUpdateContact(request, LEAD_EXAMPLE.id));
    await page.keyboard.press('Enter');
    expect(json((await second).postDataJSON())).toEqual({ version: LEAD_EXAMPLE.version + 1, status: 'unqualified' });
    await expect(card(page, 'unqualified', LEAD_EXAMPLE.id)).toBeVisible();
    expect(mock.updates).toHaveLength(2);
  });
});

// ===========================================================================
// Convert (D-P17, D-L75)
// ===========================================================================

test('a caller without contact.write is offered no convert control, and the lead still reads @leads-p04 @leads-p04-writers', async ({ page }) => {
  // T-0158: getMyCapabilities says `contact.write` is held in no programme.
  const mock = await openLeads(page, { state: 'ready', role: 'writer', capabilities: 'reader' });
  await expect(row(page, LEAD_NEW.id).first()).toBeVisible();
  await expect(page.locator('[data-action="convert-lead"]')).toHaveCount(0);
  expect(mock.violations).toEqual([]);
});

test.describe('P04/01 — convert a lead', () => {
  test('to an existing account picked by name, from the lead’s own programme only, sent once as { version, accountId } @leads-p04 @leads-p04-convert-existing', async ({
    page,
  }) => {
    const mock = await openLeads(page, { state: 'ready', role: 'writer', holdWrites: true });
    const control = convertControl(page, LEAD_NEW.id).first();
    await expect(control).toHaveAttribute('data-requires-connection', /.*/);
    const sheet = await openConvert(page, LEAD_NEW.id);
    await expectNoSeriousAxe(page, 'the convert sheet');

    // "Ltd" matches an account in each programme; a PROGRAMME_ONE lead can only
    // be linked to a PROGRAMME_ONE account (convert answers 404 otherwise).
    await searchPicker(page, sheet, 'Ltd');
    await expect(picker(sheet).locator(`[data-account-option="${ACCOUNT_SAME_PROGRAMME.id}"]`)).toBeVisible();
    await expect(picker(sheet).locator(`[data-account-option="${ACCOUNT_EXAMPLE.id}"]`)).toBeVisible();
    await expect(
      picker(sheet).locator(`[data-account-option="${ACCOUNT_OTHER_PROGRAMME.id}"]`),
      'the picker offers an account from another programme',
    ).toHaveCount(0);
    await expect(picker(sheet).locator(`[data-account-option="${ACCOUNT_SAME_PROGRAMME.id}"]`)).toContainText(
      ACCOUNT_SAME_PROGRAMME.name,
    );
    expect(page.url(), 'the picker search was written into the page URL').not.toMatch(/ltd/i);
    await expectNoIdsAnywhere(page, 'the account picker');

    await picker(sheet).locator(`[data-account-option="${ACCOUNT_SAME_PROGRAMME.id}"]`).click();
    const posted = page.waitForRequest((request) => isConvert(request, LEAD_NEW.id));
    await confirm(sheet).click();
    expect(json((await posted).postDataJSON())).toEqual({ version: LEAD_NEW.version, accountId: ACCOUNT_SAME_PROGRAMME.id });

    // In flight: a second press must not convert twice.
    await expect(confirm(sheet)).toBeDisabled();
    mock.releaseWrites();
    await expect(sheet).toBeHidden();

    // Qualified, and still a lead (D-L75).
    await expect(row(page, LEAD_NEW.id)).toBeVisible();
    const status = await visibleText(cell(page, LEAD_NEW.id, 'status'));
    expect(status, 'the converted lead does not show Qualified').toMatch(/qualified/i);
    expect(status).not.toMatch(/unqualified/i);
    expect(mock.converts, 'the lead was converted more than once').toHaveLength(1);
    expect(mock.createdAccounts, 'an account was created for an existing-account convert').toEqual([]);
    await expectNoIdsAnywhere(page, 'after convert');

    // The filter is the LEAD's programme, not the caller's first one: a
    // PROGRAMME_TWO lead is offered PROGRAMME_TWO's account and nothing else.
    const other = await openConvert(page, LEAD_LOCKED.id);
    await searchPicker(page, other, 'Ltd');
    await expect(picker(other).locator(`[data-account-option="${ACCOUNT_OTHER_PROGRAMME.id}"]`)).toBeVisible();
    for (const account of [ACCOUNT_EXAMPLE, ACCOUNT_SAME_PROGRAMME]) {
      await expect(
        picker(other).locator(`[data-account-option="${account.id}"]`),
        `a PROGRAMME_TWO lead is offered ${account.name}`,
      ).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    await expect(other).toBeHidden();
    expect(mock.converts).toHaveLength(1);
  });

  test('to a new account by name, sent once as { version, newAccount: { name } }, never createAccount then link @leads-p04 @leads-p04-convert-new', async ({
    page,
  }) => {
    const mock = await openLeads(page, { state: 'ready', role: 'writer' });
    const sheet = await openConvert(page, LEAD_NEW.id);
    await chooseNewAccount(sheet, NEW_ACCOUNT_NAME);
    await expectNoIdsAnywhere(page, 'the new-account form');
    const posted = page.waitForRequest((request) => isConvert(request, LEAD_NEW.id));
    await confirm(sheet).click();
    expect(json((await posted).postDataJSON())).toEqual({ version: LEAD_NEW.version, newAccount: { name: NEW_ACCOUNT_NAME } });
    await expect(sheet).toBeHidden();
    expect(await visibleText(cell(page, LEAD_NEW.id, 'status'))).toMatch(/qualified/i);
    expect(mock.createdAccounts.map((account) => [account.name, account.programmeId])).toEqual([
      [NEW_ACCOUNT_NAME, LEAD_NEW.programmeId],
    ]);
    expect(mock.converts).toHaveLength(1);
  });

  test('a retry after a lost answer re-sends the same request and is taken as done, with one account created @leads-p04 @leads-p04-convert-repeat', async ({
    page,
  }) => {
    // The server commits, the response is lost. The retry carries the version
    // the first call made stale, and the contract answers it 200 (the exact
    // repeat rule), never 409, and never a second account.
    const mock = await openLeads(page, { state: 'ready', role: 'writer', loseConvertResponse: true });
    const sheet = await openConvert(page, LEAD_NEW.id);
    await chooseNewAccount(sheet, NEW_ACCOUNT_NAME);
    const first = page.waitForRequest((request) => isConvert(request, LEAD_NEW.id));
    await confirm(sheet).click();
    await first;
    const lost = shown(sheet.getByRole('alert')).first();
    await expect(lost, 'a lost answer is not said').toBeVisible();
    expect(await visibleText(lost)).not.toBe('');
    await expect(sheet, 'the sheet closed on a lost answer').toBeVisible();
    expect(mock.createdAccounts).toHaveLength(1);

    await expect(confirm(sheet)).toBeEnabled();
    const answered = page.waitForResponse((response) => isConvert(response.request(), LEAD_NEW.id));
    await confirm(sheet).click();
    const response = await answered;
    expect(response.status(), 'the retry was not the exact repeat').toBe(200);
    expect(json(response.request().postDataJSON())).toEqual({ version: LEAD_NEW.version, newAccount: { name: NEW_ACCOUNT_NAME } });
    await expect(sheet).toBeHidden();
    expect(await visibleText(cell(page, LEAD_NEW.id, 'status'))).toMatch(/qualified/i);
    expect(mock.repeats()).toBe(1);
    expect(mock.createdAccounts, 'a second account was created').toHaveLength(1);
    expect(mock.converts).toHaveLength(2);
  });

  test('403, 409, 404 and 400 already_linked are translated alerts, the sheet and the typing kept, the lead unchanged @leads-p04 @leads-p04-convert-refusals', async ({
    page,
  }) => {
    const generic = EN['records.error.validation_failed'] ?? '';
    expect(generic).not.toBe('');
    const cases: { name: string; options: LeadsMockOptions; path?: string; existing: boolean; status: number }[] = [
      // An agent: write controls show to every caller (D-L84); the 403 is the gate.
      { name: '403 not_permitted', options: { role: 'claimer' }, path: '/leads?locale=en-XA', existing: false, status: 403 },
      { name: '409 stale_write', options: { role: 'writer', refuseConvert: 'stale_write' }, existing: false, status: 409 },
      { name: '404 account', options: { role: 'writer', refuseConvert: 'account_not_found' }, existing: true, status: 404 },
      { name: '400 already_linked', options: { role: 'writer', refuseConvert: 'already_linked' }, existing: false, status: 400 },
    ];
    for (const refusal of cases) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      const mock = await openLeads(page, { state: 'ready', path: refusal.path, ...refusal.options });
      const sheet = await openConvert(page, LEAD_NEW.id);
      if (refusal.existing) {
        await searchPicker(page, sheet, 'Bakare');
        await picker(sheet).locator(`[data-account-option="${ACCOUNT_SAME_PROGRAMME.id}"]`).click();
      } else {
        await chooseNewAccount(sheet, NEW_ACCOUNT_NAME);
      }
      const answered = page.waitForResponse((response) => isConvert(response.request(), LEAD_NEW.id));
      await confirm(sheet).click();
      expect((await answered).status(), refusal.name).toBe(refusal.status);

      const alert = shown(sheet.getByRole('alert')).first();
      await expect(alert, `${refusal.name}: no alert`).toBeVisible();
      const said = await visibleText(alert);
      expect(said, `${refusal.name}: the alert says nothing`).not.toBe('');
      if (refusal.path !== undefined) {
        expect(said, `${refusal.name}: the server message, not translated copy`).toMatch(PSEUDO);
      }
      if (refusal.status === 400) {
        // already_linked is a reason a person can act on, not "something was not accepted".
        expect(said, 'already_linked is shown as the generic validation error').not.toContain(generic);
      }
      await expect(sheet, `${refusal.name}: the sheet closed`).toBeVisible();
      if (!refusal.existing) {
        await expect(sheet.locator('[data-field-input="newAccount.name"]').first()).toHaveValue(NEW_ACCOUNT_NAME);
      }
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      expect(await visibleText(cell(page, LEAD_NEW.id, 'status')), `${refusal.name}: the lead looks converted`).not.toMatch(
        /^qualified$/i,
      );
      expect(mock.rows.find((lead) => lead.id === LEAD_NEW.id)?.status).toBe('new');
      expect(mock.createdAccounts).toEqual([]);
      expect(mock.violations).toEqual([]);
    }
  });

  test('a lead whose account link the caller cannot see or edit offers no convert @leads-p04 @leads-p04-convert-locked', async ({
    page,
  }) => {
    // LEAD_EXAMPLE withholds `accountId`: convert writes it, so the API would
    // answer 403 field_not_editable. The row says so up front (absent or
    // disabled); the mock records any convert sent for it.
    const mock = await openLeads(page, { state: 'ready', role: 'writer' });
    expect(LEAD_EXAMPLE.withheldFields).toContain('accountId');
    const locked = convertControl(page, LEAD_EXAMPLE.id);
    if ((await locked.count()) > 0) {
      expect(await isDisabled(locked.first()), 'convert is offered on a lead whose account link is withheld').toBe(true);
    }
    // And the readable one beside it is offered.
    await expect(convertControl(page, LEAD_NEW.id).first()).toBeEnabled();
    expect(mock.converts).toEqual([]);
  });
});

// ===========================================================================
// P04/05 and P04/06 — the states
// ===========================================================================

test.describe('P04/05 and P04/06 — empty, no results, loading, offline', () => {
  test('P04/05 empty: no leads yet — even with a customer on file — and no rows or no-results copy @leads-p04 @leads-p04-empty', async ({
    page,
  }) => {
    await openLeads(page, { scenario: 'empty', state: 'empty' });
    const empty = shown(screen(page).getByTestId('empty-state'));
    await expect(empty).toBeVisible();
    expect(await visibleText(empty)).not.toBe('');
    await expect(screen(page).getByTestId('no-results-message')).toHaveCount(0);
    await expect(screen(page).locator('[data-row-id]')).toHaveCount(0);
  });

  test('P04/05 no results names the search and the filter, and clears both @leads-p04 @leads-p04-no-results', async ({
    page,
  }) => {
    await openLeads(page, { state: 'ready' });
    const statusLabel = await visibleText(shown(screen(page).locator('[data-filter="status"]')).first());
    expect(statusLabel, 'the status chip has no label').not.toBe('');
    await applyFilter(page, 'status', 'qualified');
    await search(page, NAME_WITH_NO_MATCH);

    await expect(screen(page)).toHaveAttribute('data-list-state', 'no-results');
    const message = screen(page).getByTestId('no-results-message');
    await expect(message).toContainText(NAME_WITH_NO_MATCH);
    await expect(message).toContainText(statusLabel);
    await expect(screen(page).getByTestId('empty-state')).toHaveCount(0);

    const cleared = page.waitForRequest((request) => {
      if (!isListLeads(request)) return false;
      const params = new URL(request.url()).searchParams;
      return !params.has('q') && !params.has('status');
    });
    await screen(page).locator('[data-action="clear-search-filters"]').click();
    await cleared;
    await expect(screen(page)).toHaveAttribute('data-list-state', 'ready');
    await expect(row(page, LEAD_NEW.id)).toBeVisible();
  });

  test('P04/06 loading draws skeleton rows, never the empty state, until the leads arrive @leads-p04 @leads-p04-loading', async ({
    page,
  }) => {
    const mock = await openLeads(page, { hold: true, state: 'loading' });
    try {
      expect(await screen(page).getByTestId('skeleton-row').count(), 'fewer than three skeleton rows').toBeGreaterThanOrEqual(3);
      await expect(screen(page).getByTestId('empty-state')).toHaveCount(0);
      await expect(screen(page).getByTestId('no-results-message')).toHaveCount(0);
      await expect(screen(page).locator('[data-row-id]')).toHaveCount(0);
    } finally {
      mock.release();
    }
    await expect(screen(page)).toHaveAttribute('data-list-state', 'ready');
    await expect(screen(page).getByTestId('skeleton-row')).toHaveCount(0);
    await expect(row(page, LEAD_NEW.id)).toBeVisible();
  });

  test('a failed read is an error, not "no leads" and not "no results" @leads-p04 @leads-p04-loading', async ({ page }) => {
    await openLeads(page, { networkFailure: true, state: 'error' });
    await expect(shown(screen(page).getByTestId('list-error'))).toBeVisible();
    await expect(screen(page).getByTestId('empty-state')).toHaveCount(0);
    await expect(screen(page).getByTestId('no-results-message')).toHaveCount(0);
    await expect(screen(page).locator('[data-row-id]')).toHaveCount(0);
  });

  test('P04/06 offline keeps the table in memory only, says when it synced, and disables every edit and convert @leads-p04 @leads-p04-offline', async ({
    page,
  }) => {
    const mock = await openLeads(page, { state: 'ready', role: 'writer' });
    for (const control of await shown(page.locator('[data-action="convert-lead"]')).all()) {
      await expect(control).toHaveAttribute('data-requires-connection', /.*/);
    }
    // A convert open when the connection drops cannot be sent (D-P21: no offline queue).
    const sheet = await openConvert(page, LEAD_NEW.id);
    await chooseNewAccount(sheet, NEW_ACCOUNT_NAME);

    await page.context().setOffline(true);
    try {
      await expect(confirm(sheet)).toBeDisabled();
      await page.keyboard.press('Escape');

      const banner = shown(page.getByTestId('offline-banner')).first();
      await expect(banner).toBeVisible();
      expect(await visibleText(banner), 'the banner does not say when the list last synced').toMatch(/\d{1,2}[:.]\d{2}/);
      await expect(row(page, LEAD_NEW.id)).toBeVisible();

      const needsConnection = page.locator('[data-requires-connection]');
      const count = await needsConnection.count();
      expect(count, 'nothing is marked as needing a connection').toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        expect(await isDisabled(needsConnection.nth(index)), `a control that needs a connection is enabled offline (#${index})`).toBe(
          true,
        );
      }
      if ((await pager(screen(page)).count()) > 0) {
        await expect(pager(screen(page)).first()).toBeDisabled();
      }

      // D-L64: memory only. Nothing lead-like on the device, by any route.
      const stored = await deviceStorage(page);
      expect(stored.cachedApi, 'an API response was put in Cache Storage').toEqual([]);
      for (const needle of needles(scenarioRows('default'))) {
        expect(stored.dump.includes(needle), `"${needle}" was written to device storage`).toBe(false);
      }
    } finally {
      await page.context().setOffline(false);
    }
    await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);
    expect(mock.converts, 'a convert was sent while offline').toEqual([]);
  });

  test('P04/06 offline on the Kanban: no drag, no move, nothing queued for the reconnect @leads-p04 @leads-p04-offline', async ({
    page,
  }) => {
    const mock = await openLeads(page, { state: 'ready' });
    await showKanban(page);
    await page.context().setOffline(true);
    try {
      await expect(shown(page.getByTestId('offline-banner')).first()).toBeVisible();
      for (const move of await shown(screen(page).locator('[data-action="move-lead"]')).all()) {
        expect(await isDisabled(move), 'a move control is enabled offline').toBe(true);
      }
      await drag(page, card(page, 'new', LEAD_NEW.id).first(), column(page, 'contacted'));
      await expect(card(page, 'new', LEAD_NEW.id), 'an offline drag moved the card').toBeVisible();
      await expect(card(page, 'contacted', LEAD_NEW.id)).toHaveCount(0);
      const stored = await deviceStorage(page);
      for (const needle of needles(scenarioRows('default'))) {
        expect(stored.dump.includes(needle), `"${needle}" was written to device storage`).toBe(false);
      }
    } finally {
      await page.context().setOffline(false);
    }
    await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);

    // Back online, a real move. If the offline drag had been queued and
    // replayed on reconnect, it would be in the mock before this one.
    const move = card(page, 'contacted', LEAD_EXAMPLE.id).locator('[data-action="move-lead"]').first();
    await expect(move).toBeEnabled();
    await move.click();
    const patched = page.waitForRequest((request) => isUpdateContact(request, LEAD_EXAMPLE.id));
    await shown(page.locator('[data-move-to="qualified"]')).first().click();
    await patched;
    expect(mock.updates.map((write) => write.id), 'an offline move was queued and sent on reconnect').toEqual([LEAD_EXAMPLE.id]);
  });
});

// ===========================================================================
// Hidden until their modules exist (D-L69, D-P13)
// ===========================================================================

test('no Merge, Lead score, Map view, bulk selection or bulk WhatsApp, Health, or live counts, in either view @leads-p04 @leads-p04-hidden', async ({
  page,
}) => {
  await openLeads(page, { state: 'ready' });
  for (const view of ['table', 'kanban'] as const) {
    if (view === 'kanban') {
      await showKanban(page);
    }
    const root = screen(page);
    await expect(root.locator('[data-view-option="map"], [data-view="map"], [data-action="view-map"], [href*="map"]')).toHaveCount(0);
    await expect(root.locator('[data-view-option="split"]')).toHaveCount(0);
    await expect(root.locator('[data-column*="score" i], [data-field*="score" i], [data-column*="health" i], [data-field*="health" i]')).toHaveCount(0);
    await expect(root.locator('[data-row-id] input[type="checkbox"], [data-row-id] [role="checkbox"]')).toHaveCount(0);
    await expect(root.locator('[data-action^="bulk"], [data-testid^="bulk"], [data-action*="merge" i], [data-action*="whatsapp" i]')).toHaveCount(0);

    const text = await visibleText(root);
    expect(text, `${view}: Merge is offered`).not.toMatch(/\bMerge\b/i);
    expect(text, `${view}: a lead score is drawn`).not.toMatch(/\bscore\b/i);
    expect(text, `${view}: a Map view is offered`).not.toMatch(/\bMap\b/);
    expect(text, `${view}: Health is drawn`).not.toMatch(/\bHealth\b/i);
    expect(text, `${view}: a bulk action is offered`).not.toMatch(/\bbulk\b|send (a )?whatsapp/i);
    await expectNoTotals(page);
  }
});

// ===========================================================================
// Mobile
// ===========================================================================

test('at 360px the table and the Kanban fit without sideways page scroll and pass axe @leads-p04 @leads-p04-mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openLeads(page, { state: 'ready' });
  await expect(row(page, LEAD_NEW.id)).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow(), 'the table scrolls the page sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoIdsAnywhere(page, 'the 360px table');
  await expectNoSeriousAxe(page, 'P04/01 at 360px');

  // Columns may scroll inside their own container; the page itself may not.
  // T-0150 (T-0133): the P04 phone frames draw no view switcher, so the Kanban
  // is opened at 1024 (where the switcher is) and the viewport narrowed back.
  await page.setViewportSize({ width: 1024, height: 740 });
  await shown(screen(page).locator('[data-view-option="kanban"]')).first().click();
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(screen(page).locator('[data-kanban-column="new"]').first()).toBeAttached();
  await expect(screen(page).locator(`[data-kanban-column="new"] [data-row-id="${LEAD_NEW.id}"]`).first()).toBeAttached();
  expect(await overflow(), 'the Kanban scrolls the page sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P04/04 at 360px');
});

// ===========================================================================
// i18n
// ===========================================================================

test('locale=en-XA renders every string as pseudo text in the table and the Kanban, record data excepted @leads-p04 @leads-p04-pseudo', async ({
  page,
}) => {
  await openLeads(page, { path: '/leads?locale=en-XA', state: 'ready' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');

  const table = await pseudoReport(page);
  expect(table.english, 'strings in the table that did not come through i18n').toEqual([]);
  expect(table.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
  expect(table.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(10);
  // A status is a code; its label is copy.
  expect(await visibleText(cell(page, LEAD_NEW.id, 'status'))).toMatch(/·/);

  await showKanban(page);
  const kanban = await pseudoReport(page);
  expect(kanban.english, 'strings on the Kanban that did not come through i18n').toEqual([]);
  expect(kanban.forged).toEqual([]);
  for (const status of LEAD_STATUSES) {
    expect(await columnChrome(page, status), `the ${status} column label is not translated`).toMatch(PSEUDO);
  }
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/leads on the wire', () => {
  /**
   * WHY 255,000 BYTES, BEFORE THE SCREEN EXISTS
   *
   * Pinned near its closest measured neighbour, not at the 300 KB PRD 2.13
   * ceiling:
   *
   *   /contacts   216,100 B measured, 226,000 budget (T-0042, D-P15): the same
   *               shell, table, chips, paging and offline banner.
   *   /accounts   245,000 provisional (T-0057): that list plus a sheet.
   *
   * /leads is the list, plus a convert sheet with an account picker (about
   * the accounts sheet), plus a Kanban with a drag and a move menu. 255,000
   * leaves about 10 KB for the Kanban over /accounts, and nothing more: a
   * drag-and-drop library in the initial load will not fit, so the Kanban
   * either uses the platform's drag events or loads when it is opened. The
   * acceptance suite requires the literal re-pinned within 5% of the
   * measurement.
   */
  test('/leads stays inside its transferred-byte budget on the production build @leads-p04 @leads-p04-budget', async ({
    page,
  }) => {
    active = await installLeadsMock(page);
    const metrics = await measurePageLoad(page, `${leadsUrl()}/leads`, 'default');

    const record = resolve(__dirname, '.artifacts', 'leads-p04-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(
      record,
      `${JSON.stringify({ path: '/leads', transferredBytes: metrics.transferredBytes, budget: LEADS_BUDGET_BYTES }, null, 2)}\n`,
      'utf8',
    );

    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webLeadsUrl is not serving the production build').toBe(built);

    expect(LEADS_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P04/01 the leads list', metrics.transferredBytes, LEADS_BUDGET_BYTES);
  });

  test('/leads paints within 5 s at 256 kbps and 300 ms @leads-p04 @leads-p04-budget', async ({ page }) => {
    active = await installLeadsMock(page);
    const metrics = await measurePageLoad(page, `${leadsUrl()}/leads`, 'low-bandwidth');
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
