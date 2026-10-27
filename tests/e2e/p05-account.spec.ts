import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  ACCOUNT_BRANCH,
  ACCOUNT_FULL,
  ACCOUNT_GROUP,
  ACCOUNT_HOSTILE,
  ACCOUNT_LOCKED,
  ACCOUNT_LONG,
  ACCOUNT_NULLS,
  ACCOUNT_DEEP,
  ACCOUNT_REGION,
  ACCOUNT_TIMELINE_FIELDS,
  ACTIVITY_TYPES,
  CONTACT_PAGE_CAP,
  DEEP_CHAIN,
  DEFAULT_TIMELINE_MAX,
  FORMER_MEMBER,
  HOSTILE_BODY,
  HOSTILE_CONTACT_NAME,
  HOSTILE_NAME,
  HOSTILE_SUBJECT,
  HOSTILE_TAG,
  ITEM_CALL,
  ITEM_CREATED_NAME,
  ITEM_DONE_TASK,
  ITEM_NOTE,
  ITEM_OWNER,
  ITEM_PARENT,
  ITEM_PHONES,
  ITEM_TASK,
  ITEM_TIER,
  LONG_OLDEST_SUBJECT,
  LONG_TIMELINE_LENGTH,
  MAX_ANCESTORS,
  ME,
  NEW_ACTIVITY_IDS,
  NO_SUCH_ID,
  OTHER_OWNER,
  OUT_OF_SCOPE_ID,
  PROGRAMME_ONE,
  PROGRAMME_TWO,
  answerProblems,
  contactsOf,
  installAccountRecordMock,
  isAccountContacts,
  isAccountTimeline,
  isCreateActivity,
  isUpdateAccount,
  isUpdateActivity,
  servedData,
  timelineOf,
  type AccountRecordMock,
  type AccountRecordMockOptions,
  type AccountRow,
} from './support/account-record-mock';

/**
 * T-0063 — the P05 account record (frame 04), behind `crm_record_view` AND
 * `crm_accounts`, in the CRM shell T-0042 built. Written by the lead's QA
 * agent BEFORE the screen exists;
 * `tests/acceptance/records-ui/account-record.acceptance.test.ts` runs this
 * file with `--grep @p05-account` and reads every outcome by tag.
 * Decisions: D-L63, D-L64, D-L69, D-L74, D-L78, D-L84, D-L85, D-L90, D-P13,
 * D-P18, D-P21.
 *
 * TAG RULE (D-L84). `@p05-account` is the parent tag. Playwright's --grep is a
 * regular expression, so no other screen's tag may contain it and it contains
 * no other screen's parent tag (`@p04`, `@p04-accounts`, `@p05-contact` and
 * `@leads-p04` are all clear of it, both ways). Every sub-tag here is
 * `@p05-account-<name>`.
 *
 * ---------------------------------------------------------------------------
 * THE WEB PROCESS
 *
 *   webUrl            — the default server, every flag at its default.
 *                       `/accounts/<id>` must be a real 404 there.
 *   webRecordViewUrl  — the process T-0062 added, which already carries
 *                       `crm_records`, `crm_accounts` and `crm_record_view`
 *                       (run-e2e.mjs). Every journey and the byte budget run
 *                       here. The page needs BOTH `crm_record_view` (the P05
 *                       record flag) and `crm_accounts` (the accounts flag):
 *                       the acceptance suite holds the route file to both, and
 *                       the shell's Accounts link must resolve wherever the
 *                       record is served.
 *
 * THE RECORD IS READ FROM THE BROWSER, AND MOCKED THERE
 *
 * Every journey installs `support/account-record-mock.ts`, which serves
 * getAccount, updateAccount, listAccountContacts, listAccountTimeline,
 * createActivity, updateActivity, listMyProgrammes and getCurrentUser from the
 * contracts, and checks every answer it gives against them. `afterEach` fails
 * a test in which the screen sent the API anything the contract does not
 * declare (the mock's header lists what), left the origin, or in which the
 * mock answered something its own contract rejects.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                      the CRM shell (T-0042)
 *   [data-screen="P05/04"]                  the account record root, carrying
 *     data-record-state="loading|ready"
 *   h1                                      the account's name
 *   [data-testid="record-skeleton"]         loading placeholders (P05/06)
 *   [data-testid="record-not-found"]        the GENERIC not-found (D-L69)
 *   [data-testid="record-unavailable"]      a failed read, never "not found"
 *   [data-testid="record-details"]          the details panel, containing
 *     [data-field="<Account property>"]     one field; the owner is `owner` OR
 *                                           `ownerUserId`
 *       data-locked="true"                  when the field is WITHHELD
 *   [data-testid="account-hierarchy"]       the breadcrumb (data-locked="true"
 *                                           when parentAccountId is withheld),
 *     [data-hierarchy-entry="<account id>"] one level, ROOT FIRST, the record
 *                                           last with aria-current="page"; an
 *                                           ancestor holds a link to
 *                                           /accounts/<its id>
 *   [data-testid="account-contacts"]        the contacts grid, containing
 *     [data-contact-row="<contact id>"]     one row, in served order, with
 *       [data-field="displayName"], [data-field="phones"] (data-locked as
 *       above; any other Contact property the builder draws likewise)
 *   [data-testid="account-contacts-more"]   keyset "more contacts"
 *   [data-testid="account-contacts-empty"]  the account has no contacts
 *   [data-testid="account-contacts-withheld"] the 400 field_withheld message
 *   [data-testid="account-contacts-error"]  the contacts read failed
 *   [data-testid="timeline"]                the account timeline, containing
 *     [data-timeline-item="<item id>"]      one item, in served order, carrying
 *       data-item-type="<item type>"
 *       data-activity-id="<activity id>"    on activity items
 *       data-completed="true|false"         on task items
 *       [data-actor]                        who acted ("System" for null)
 *       <time datetime="<ISO>">             every date or time drawn
 *       [data-action="complete-task"]       on an open task
 *   [data-testid="timeline-load-older"], [data-testid="timeline-empty"],
 *   [data-testid="timeline-error"]
 *   [data-action="edit-account"]            opens
 *   [data-testid="account-sheet"]           the edit, role=dialog (the T-0057
 *     [data-field-input="<UpdateAccountRequest property>"],        hooks)
 *     [data-action="save-account"], [role="alert"] for a refusal
 *   [data-action="log-activity"][data-activity-type="note|task|call"]
 *                                           (a bare [data-action="log-activity"]
 *                                           may reveal the three) opens
 *   [data-testid="activity-form"]           with [data-field-input="subject"],
 *     [data-field-input="body"], [data-field-input="dueAt"] (an
 *     input[type="datetime-local"], tasks only), [data-action="save-activity"],
 *     [role="alert"] for a refusal
 *   [role="alert"] on the screen            a refused or stale complete
 *   [data-requires-connection]              on every write control
 *   [data-testid="offline-banner"]          with the last-synced time
 *   [data-record-text]                      record data, not UI copy (en-XA)
 *
 * PINNED INTERFACES BEYOND THE HOOKS
 *
 *   - The first timeline page holds at least DEFAULT_TIMELINE_MAX (20) items.
 *   - Times are shown in the BROWSER's zone. This file runs in Africa/Lagos.
 *   - Every write sends `version` plus ONLY what changed; nothing optimistic.
 *   - The document title never carries the account's name (D-L63: titles land
 *     in browser history on shared BPO desks, and a sole trader's account is
 *     a person's name).
 *   - The hierarchy is read by walking `parentAccountId` with getAccount, at
 *     most four steps (D-L74): never more, whatever the data claims.
 *   - A task on the account timeline is completed with the `version` its item
 *     carries (T-0080, D-L85). A 409 is a translated alert, and the screen
 *     re-reads the timeline by itself; it never retries blind.
 *   - An activity logged here names `accountId` and no contact.
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS
 *
 *   - Hidden (D-L69, D-P13): pipeline rollups and every money figure, Health,
 *     the Map, related deals, tickets, quotes, invoices and campaigns, buying
 *     roles and "last contact" (no field), contact or child counts, DND on
 *     account phones (the contract says a screen must not infer one), RC
 *     number, TIN, billing, and the access-request flow.
 *   - The design's tree shows child and sister accounts. NOTHING SERVES
 *     CHILDREN: `Account` carries the one `parentAccountId` link and
 *     listAccounts has no parent filter ("unknown query parameters are
 *     ignored"). Scanning every account in reach to find them is refused by
 *     the mock. The children journey is a `fixme`
 *     (`@p05-account-children`), not required: a contract gap for the lead.
 *   - "The timeline gathers activity from every contact": not on this
 *     contract. listAccountTimeline carries the account's own activities and
 *     field changes only (T-0080); rollups are the pipeline slice's.
 *   - Write controls are shown to every caller (D-L84). The API's 403 is the
 *     gate, shown as a translated role=alert.
 *   - Offline (D-P21): the record stays in memory only; every write control is
 *     disabled. P05/05's queued edits are not built.
 *   - Ids are not names: the owner, actors and ancestors come with names;
 *     programme names from listMyProgrammes. No UUID is printed.
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P05/04"]';

/**
 * The /accounts/[id] transferred-byte budget. The acceptance suite holds it at
 * or under its ceiling (ACCOUNT_RECORD_BUDGET_CEILING there) and within 5% of
 * what this run measures, so re-pin it to the measurement when the weight
 * changes. The first, provisional figure was 245,000: see the budget test.
 */
const ACCOUNT_RECORD_BUDGET_BYTES = 289_000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const RENAMED = 'Ọjà Foods Nigeria Ltd';

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

// Kasuwa's users are in WAT/EAT/SAST; every time on this screen is converted in the browser.
test.use({ timezoneId: 'Africa/Lagos' });

let active: AccountRecordMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults, 'the MOCK answered something its contract rejects (a mock bug, not the screen’s)').toEqual([]);
    expect(mock.violations, 'the screen sent the records API something the contract does not declare').toEqual([]);
    if (mock.requests.length > 0) {
      const origin = new URL(recordViewUrl()).origin;
      for (const url of mock.requests) {
        expect(url.origin, 'the record must be read same-origin, by a relative path').toBe(origin);
      }
    }
  }
});

function recordViewUrl(): string {
  const urls = stack();
  if (typeof urls.webRecordViewUrl !== 'string' || urls.webRecordViewUrl === '') {
    throw new Error('the stack file has no webRecordViewUrl: scripts/run-e2e.mjs starts no web process with crm_record_view on');
  }
  return urls.webRecordViewUrl;
}

function screen(page: Page): Locator {
  return page.locator(SCREEN);
}

/** Visible elements only: a screen may render desktop and mobile layouts and switch them with CSS. */
function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

function field(page: Page, name: string): Locator {
  return shown(screen(page).locator(`[data-testid="record-details"] [data-field="${name}"]`)).first();
}

function ownerField(page: Page): Locator {
  return shown(
    screen(page).locator('[data-testid="record-details"] [data-field="owner"], [data-testid="record-details"] [data-field="ownerUserId"]'),
  ).first();
}

function hierarchy(page: Page): Locator {
  return shown(screen(page).getByTestId('account-hierarchy')).first();
}

function contactsGrid(page: Page): Locator {
  return shown(screen(page).getByTestId('account-contacts')).first();
}

function contactRow(page: Page, id: string): Locator {
  return shown(screen(page).locator(`[data-contact-row="${id}"]`)).first();
}

function item(page: Page, id: string): Locator {
  return shown(screen(page).locator(`[data-timeline-item="${id}"]`));
}

function activityEntry(page: Page, activityId: string): Locator {
  return shown(screen(page).locator(`[data-timeline-item][data-activity-id="${activityId}"]`));
}

function heading(page: Page): Locator {
  return shown(screen(page).getByRole('heading', { level: 1 })).first();
}

function lockIcon(scope: Locator): Locator {
  // `<Icon name="lock" />` is an aria-hidden ligature span whose text is its name.
  return scope.locator('[aria-hidden="true"]', { hasText: /^\s*lock\s*$/ });
}

/** Text a person can see or hear: aria-hidden subtrees (icon ligatures) removed. */
async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** Every en.json message whose id ends with `suffix` — the builder chooses the namespace. */
function labelsEndingWith(suffix: string): string[] {
  return Object.entries(EN)
    .filter(([id]) => id.endsWith(suffix))
    .map(([, text]) => text);
}

function fieldLabels(name: string): string[] {
  return [...labelsEndingWith(`.field.${name}`), ...labelsEndingWith(`.col.${name}`)];
}

function activityTypeLabels(type: string): string[] {
  return Object.entries(EN)
    .filter(([id]) => /activit/i.test(id) && id.endsWith(`.type.${type}`))
    .map(([, text]) => text);
}

async function expectSaysOneOf(locator: Locator, labels: readonly string[], what: string): Promise<void> {
  expect(labels.length, `en.json has no label for ${what}`).toBeGreaterThan(0);
  const said = await visibleText(locator);
  expect(
    labels.some((label) => said.includes(label)),
    `${what}: "${said}" says none of ${labels.map((label) => `"${label}"`).join(', ')}`,
  ).toBe(true);
}

/**
 * No UUID a person can see or hear: visible text, the accessible-name
 * attributes, form values a person reads and the document title. Ids in
 * `data-*`, `href` and `<time datetime>` are not printed.
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
      if (element instanceof HTMLTextAreaElement) out.push(element.value);
      if (element instanceof HTMLSelectElement) out.push(element.selectedOptions[0]?.textContent ?? '');
      if (element instanceof HTMLOptionElement) out.push(element.textContent ?? '');
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

async function openRecord(
  page: Page,
  id: string,
  options: AccountRecordMockOptions & { query?: string; state?: 'loading' | 'ready' } = {},
): Promise<AccountRecordMock> {
  const mock = await installAccountRecordMock(page, { recordId: id, ...options });
  active = mock;
  const response = await page.goto(`${recordViewUrl()}/accounts/${id}${options.query ?? ''}`);
  expect(response?.status(), '/accounts/<id> with crm_record_view and crm_accounts on').toBe(200);
  await expect(screen(page)).toBeVisible();
  await expect(screen(page)).toHaveAttribute('data-record-state', options.state ?? 'ready');
  return mock;
}

/** Leave the current record and its mock behind before opening another. */
async function closeRecord(page: Page): Promise<void> {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults).toEqual([]);
    expect(mock.violations).toEqual([]);
  }
}

function json(body: unknown): Record<string, unknown> {
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the write body is not an object').toBe(true);
  return body as Record<string, unknown>;
}

function keysOf(body: Record<string, unknown>): string[] {
  return Object.keys(body).sort();
}

async function isDisabled(locator: Locator): Promise<boolean> {
  return locator.evaluate(
    (element) =>
      (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true',
  );
}

/** Every matching control is absent, disabled or aria-disabled. */
async function expectNoUsable(locator: Locator, what: string): Promise<void> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    expect(await isDisabled(locator.nth(index)), `${what} is offered and enabled (#${index})`).toBe(true);
  }
}

function sheet(page: Page): Locator {
  return page.getByTestId('account-sheet');
}

async function openEdit(page: Page): Promise<Locator> {
  await shown(screen(page).locator('[data-action="edit-account"]')).first().click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toHaveAttribute('role', 'dialog');
  return sheet(page);
}

async function openLog(page: Page, type: string): Promise<Locator> {
  const typed = () => shown(page.locator(`[data-action="log-activity"][data-activity-type="${type}"]`));
  if ((await typed().count()) === 0) {
    await shown(screen(page).locator('[data-action="log-activity"]:not([data-activity-type])')).first().click();
  }
  await typed().first().click();
  const form = shown(page.getByTestId('activity-form')).first();
  await expect(form, `logging a ${type} opens no activity form`).toBeVisible();
  return form;
}

const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

/** Everything of an account, its ancestors, contacts and timeline that could land on the device. */
function needles(rows: readonly AccountRow[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    // Not the account id: it is in the address bar because the user put it there.
    out.add(row.name);
    if (typeof row.industry === 'string') out.add(row.industry);
    for (const tag of (Array.isArray(row.tags) ? row.tags : []) as string[]) out.add(tag);
    for (const phone of (Array.isArray(row.phones) ? row.phones : []) as { e164: string }[]) out.add(phone.e164);
    for (const contact of contactsOf(row.id)) {
      out.add(contact.displayName);
      for (const phone of (Array.isArray(contact.phones) ? contact.phones : []) as { e164: string }[]) out.add(phone.e164);
    }
    for (const entry of timelineOf(row.id)) {
      for (const value of [entry.subject, entry.body, entry.activityId]) {
        if (typeof value === 'string') out.add(value);
      }
    }
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

/** The ids of the timeline items on screen, in DOM order. */
async function renderedItemIds(page: Page): Promise<string[]> {
  return shown(screen(page).locator('[data-timeline-item]')).evaluateAll((items) =>
    items.map((element) => element.getAttribute('data-timeline-item') ?? ''),
  );
}

/** The ids of the contact rows on screen, in DOM order. */
async function renderedContactIds(page: Page): Promise<string[]> {
  return shown(screen(page).locator('[data-contact-row]')).evaluateAll((rows) =>
    rows.map((element) => element.getAttribute('data-contact-row') ?? ''),
  );
}

/** The hierarchy entries on screen, root first. */
async function hierarchyIds(page: Page): Promise<string[]> {
  return shown(screen(page).locator('[data-testid="account-hierarchy"] [data-hierarchy-entry]')).evaluateAll((entries) =>
    entries.map((element) => element.getAttribute('data-hierarchy-entry') ?? ''),
  );
}

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract refuses, and checks its own answers @p05-account @p05-account-mock', async ({
  page,
}) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (sign-in on the default server) and
  // watch every malformed request land in `violations`. No `active` mock here:
  // the violations are deliberate, and each mock's are counted explicitly.
  const { webUrl } = stack();
  const mock = await installAccountRecordMock(page);
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
  const account = (id: string) => `/api/v1/accounts/${id}`;
  const timeline = (id: string, query = '') => `/api/v1/accounts/${id}/timeline${query}`;
  const contacts = (id: string, query = '') => `/api/v1/accounts/${id}/contacts${query}`;
  const firstContact = contactsOf(ACCOUNT_FULL.id)[0]?.id ?? 'missing';

  // Served as the contract says.
  const deep = await call(account(ACCOUNT_DEEP.id));
  expect(deep.status).toBe(200);
  expect(deep.body.parentAccountId).toBe(ACCOUNT_BRANCH.id);
  expect((await call(account(ACCOUNT_FULL.id))).body.parentAccountId).toBe(ACCOUNT_GROUP.id);
  const locked = await call(account(ACCOUNT_LOCKED.id));
  expect('phones' in locked.body || 'parentAccountId' in locked.body || 'owner' in locked.body, 'a withheld field was sent').toBe(false);
  const outside = await call(account(OUT_OF_SCOPE_ID));
  const missing = await call(account(NO_SUCH_ID));
  expect(outside.status).toBe(404);
  expect(JSON.stringify(outside.body), 'out of scope and missing answer differently').toBe(JSON.stringify(missing.body));
  expect((await call(account('not-a-uuid'))).status).toBe(400);
  // The account timeline answers a malformed id 404, like an unreachable one (T-0080).
  expect((await call(timeline('not-a-uuid'))).status).toBe(404);

  const page1 = await call(timeline(ACCOUNT_FULL.id));
  expect((page1.body.data as { id: string }[]).map((entry) => entry.id)).toEqual(timelineOf(ACCOUNT_FULL.id).map((entry) => entry.id));
  expect(page1.body.nextCursor).toBeNull();
  const long1 = await call(timeline(ACCOUNT_LONG.id));
  const longCursor = String(long1.body.nextCursor);
  expect((long1.body.data as unknown[]).length, 'a timeline page short of its limit').toBe(25);
  const long2 = await call(timeline(ACCOUNT_LONG.id, `?cursor=${encodeURIComponent(longCursor)}`));
  expect((long2.body.data as { id: string }[])[0]?.id).toBe(timelineOf(ACCOUNT_LONG.id)[25]?.id);
  const grid1 = await call(contacts(ACCOUNT_FULL.id, '?limit=50'));
  expect((grid1.body.data as unknown[]).length, 'the contacts page is not capped').toBe(CONTACT_PAGE_CAP);
  const gridCursor = String(grid1.body.nextCursor);
  const grid2 = await call(contacts(ACCOUNT_FULL.id, `?limit=50&cursor=${encodeURIComponent(gridCursor)}`));
  expect((grid2.body.data as { id: string }[]).map((row) => row.id)).toEqual(contactsOf(ACCOUNT_FULL.id).slice(CONTACT_PAGE_CAP).map((row) => row.id));
  expect(grid2.body.nextCursor).toBeNull();
  const withheld = await call(contacts(ACCOUNT_LOCKED.id));
  expect(withheld.status).toBe(400);
  expect(withheld.body.details).toEqual([{ path: 'accountId', code: 'field_withheld' }]);
  expect(mock.violations, 'a well-formed request was recorded as a violation').toEqual([]);

  // Refused, and blamed on the screen.
  await expectViolation(timeline(ACCOUNT_FULL.id, '?limit=0'), 'GET', undefined, 400, /outside 1\.\.100/);
  await expectViolation(timeline(ACCOUNT_FULL.id, '?sort=-occurredAt'), 'GET', undefined, 400, /no "sort"/);
  await expectViolation(timeline(ACCOUNT_FULL.id, '?cursor=forged'), 'GET', undefined, 400, /never served/);
  await expectViolation(timeline(ACCOUNT_FULL.id, `?cursor=${encodeURIComponent(longCursor)}`), 'GET', undefined, 400, /another account/);
  await expectViolation(contacts(ACCOUNT_FULL.id, '?sort=status'), 'GET', undefined, 400, /not in the contract's enum/);
  await expectViolation(contacts(ACCOUNT_FULL.id, '?programmeId=x'), 'GET', undefined, 400, /no "programmeId"/);
  // A cursor served under the default sort, replayed under another the enum offers (T-0124: displayName is no sort key).
  await expectViolation(contacts(ACCOUNT_FULL.id, `?sort=createdAt&cursor=${encodeURIComponent(gridCursor)}`), 'GET', undefined, 400, /echoed, not built/);
  await expectViolation(account(ACCOUNT_FULL.id), 'GET', undefined, 200, /scope is never supplied/, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id });
  // Not operations the account record uses: the list (where children would be scanned for), the Map, a contact.
  await expectViolation(`/api/v1/accounts?parentAccountId=${ACCOUNT_FULL.id}`, 'GET', undefined, 404, /not an operation the account record uses/);
  await expectViolation('/api/v1/accounts/map', 'GET', undefined, 404, /not an operation/);
  await expectViolation(`/api/v1/contacts/${firstContact}`, 'GET', undefined, 404, /not an operation/);
  await expectViolation(account(ACCOUNT_FULL.id), 'PATCH', { version: ACCOUNT_FULL.version, programmeId: PROGRAMME_TWO.id }, 403, /closed body/);
  await expectViolation(account(ACCOUNT_FULL.id), 'PATCH', { version: ACCOUNT_FULL.version }, 403, /fewer than 2/);
  await expectViolation(account(ACCOUNT_LOCKED.id), 'PATCH', { version: ACCOUNT_LOCKED.version, phones: [] }, 403, /withholds/);
  await expectViolation(account(ACCOUNT_FULL.id), 'PATCH', { version: 99, name: 'X' }, 403, /version 99/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: 'x', accountId: ACCOUNT_FULL.id, contactId: firstContact }, 400, /names a contactId/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: 'x' }, 400, /names no accountId/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: 'x', accountId: ACCOUNT_FULL.id, dueAt: '2026-10-09T14:00:00.000Z' }, 400, /task_only/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'task', subject: 'x', accountId: ACCOUNT_FULL.id, dueAt: '2026-10-09T15:00' }, 400, /UTC date-time/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: '', accountId: ACCOUNT_FULL.id }, 400, /too short/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: 'x', accountId: OUT_OF_SCOPE_ID }, 404, /never served/);
  // A version nobody served for that activity is forged (and only a task completes).
  await expectViolation(`/api/v1/activities/${String(ITEM_CALL.activityId)}`, 'PATCH', { version: 7, completed: true }, 400, /task_only[\s\S]*never served/);
  expect(mock.violations.length, 'the refusals above were not all recorded, or one was recorded twice').toBe(23);
  expect(mock.mockFaults, 'an answer the mock gave was rejected by its own contract').toEqual([]);

  // The walk: the record, then served parents only, four at most.
  const walk = await installAccountRecordMock(page, { recordId: ACCOUNT_DEEP.id });
  for (const row of [...DEEP_CHAIN].reverse()) {
    expect((await call(account(row.id))).status).toBe(200);
  }
  expect(walk.violations, 'walking the chain from the record was recorded as a violation').toEqual([]);
  await call(account(ACCOUNT_NULLS.id));
  expect(walk.violations.join('\n'), 'a read of an account nobody linked was not recorded').toMatch(/neither the record nor a parent/);
  const cycle = await installAccountRecordMock(page, { recordId: ACCOUNT_DEEP.id, hierarchyCycle: true });
  for (const row of [...DEEP_CHAIN].reverse()) {
    await call(account(row.id));
  }
  expect(cycle.violations).toEqual([]);
  await call(account(ACCOUNT_DEEP.id));
  expect(cycle.violations.join('\n'), 'a fifth ancestor read was not recorded').toMatch(/walked 5 ancestors/);

  // The mock checks its own answers: a planted body the contract rejects is caught.
  expect(answerProblems('getAccount', 200, { ...ACCOUNT_FULL, health: 92 }).join('\n'), 'an Account with a Health score passed').toMatch(/health/);
  expect(answerProblems('getAccount', 200, { ...ACCOUNT_FULL, children: [ACCOUNT_REGION.id] }).join('\n')).toMatch(/children/);
  expect(answerProblems('listAccountTimeline', 200, { data: [{ ...ITEM_TIER, before: 'sme', after: 'enterprise' }], nextCursor: null })).not.toEqual([]);
  expect(answerProblems('listAccountTimeline', 200, { data: [{ ...ITEM_TIER, field: 'displayName' }], nextCursor: null })).not.toEqual([]);
  expect(answerProblems('listAccountTimeline', 200, { data: [{ id: 'ti_x', type: 'consent_changed', occurredAt: ITEM_TIER.occurredAt, actor: null }], nextCursor: null })).not.toEqual([]);
  const versionless = Object.fromEntries(Object.entries(ITEM_TASK).filter(([key]) => key !== 'version'));
  expect(answerProblems('listAccountTimeline', 200, { data: [versionless], nextCursor: null }), 'an activity item without its version passed').not.toEqual([]);
  expect(answerProblems('listAccountContacts', 200, { data: [], nextCursor: null, total: 6 }).join('\n'), 'a page with a total passed').toMatch(/total/);
  expect(answerProblems('listAccountContacts', 403, { statusCode: 403 }).join('\n')).toMatch(/declares no 403/);
  expect(answerProblems('getAccount', 404, { statusCode: 404, error: 'Not Found', code: 'no_such_code', message: 'x' })).not.toEqual([]);
  // And the honest answers pass.
  expect(answerProblems('getAccount', 200, ACCOUNT_FULL)).toEqual([]);
  expect(answerProblems('listAccountTimeline', 200, { data: timelineOf(ACCOUNT_FULL.id), nextCursor: null })).toEqual([]);
  expect(answerProblems('listAccountContacts', 200, { data: contactsOf(ACCOUNT_FULL.id), nextCursor: null })).toEqual([]);

  // Well-formed writes are applied, or refused for the caller's permission set, which is not the screen's fault.
  const writer = await installAccountRecordMock(page, { role: 'admin' });
  await call(account(ACCOUNT_FULL.id));
  const renamed = await call(account(ACCOUNT_FULL.id), 'PATCH', { version: ACCOUNT_FULL.version, name: RENAMED });
  expect(renamed.status).toBe(200);
  expect(renamed.body.version).toBe(ACCOUNT_FULL.version + 1);
  const tier = await call(account(ACCOUNT_FULL.id), 'PATCH', { version: renamed.body.version, tier: 'enterprise' });
  expect(tier.status, 'a read-only field was written').toBe(403);
  expect(tier.body.details).toEqual([{ path: 'tier', code: 'field_not_editable' }]);
  const served = await call(timeline(ACCOUNT_FULL.id));
  expect((served.body.data as unknown[])[0], 'the rename added no item, or one with a value').toMatchObject({ type: 'field_changed', field: 'name', redacted: true });
  const note = await call('/api/v1/activities', 'POST', { type: 'note', body: 'Called the depot.', accountId: ACCOUNT_FULL.id });
  expect(note.status).toBe(201);
  expect(note.body).toMatchObject({ id: NEW_ACTIVITY_IDS[0], accountId: ACCOUNT_FULL.id, contactId: null });
  // ITEM_TASK's version was served on the timeline just now: completing with it is honest (T-0080).
  const done = await call(`/api/v1/activities/${String(ITEM_TASK.activityId)}`, 'PATCH', { version: ITEM_TASK.version, completed: true });
  expect(done.status).toBe(200);
  expect(done.body.version).toBe(Number(ITEM_TASK.version) + 1);
  const agentEdit = await installAccountRecordMock(page);
  await call(account(ACCOUNT_FULL.id));
  expect((await call(account(ACCOUNT_FULL.id), 'PATCH', { version: ACCOUNT_FULL.version, name: RENAMED })).status, 'an agent edited an account').toBe(403);
  for (const clean of [writer, agentEdit]) {
    expect(clean.violations, 'a well-formed write was recorded as a violation').toEqual([]);
    expect(clean.mockFaults).toEqual([]);
  }

  // staleTask: the first write to ITEM_TASK is beaten by somebody else; a re-read serves the new version.
  const stale = await installAccountRecordMock(page, { staleTask: true });
  await call(account(ACCOUNT_FULL.id));
  await call(timeline(ACCOUNT_FULL.id));
  const lost = await call(`/api/v1/activities/${String(ITEM_TASK.activityId)}`, 'PATCH', { version: ITEM_TASK.version, completed: true });
  expect(lost.status).toBe(409);
  const reread = await call(timeline(ACCOUNT_FULL.id));
  const fresh = (reread.body.data as { id: string; version?: number }[]).find((entry) => entry.id === ITEM_TASK.id);
  expect(fresh?.version).toBe(Number(ITEM_TASK.version) + 1);
  const won = await call(`/api/v1/activities/${String(ITEM_TASK.activityId)}`, 'PATCH', { version: fresh?.version, completed: true });
  expect(won.status).toBe(200);
  expect(stale.violations).toEqual([]);
  expect(stale.mockFaults).toEqual([]);
  for (const other of [mock, walk, cycle]) {
    expect(other.mockFaults).toEqual([]);
  }
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_record_view and crm_accounts gate /accounts/[id]', () => {
  // The flag-off tests PASS BEFORE THE WORK STARTS: there is no route, so
  // `/accounts/<id>` is a 404 everywhere. A negative invariant, legitimately
  // vacuous until the screen exists; the flag-on test gives the pair meaning.
  test('/accounts/<id> is a real 404 with every flag at its default, and nothing reaches the records API @p05-account @p05-account-flag-off', async ({
    page,
  }) => {
    const { webUrl } = stack();
    const mock = await installAccountRecordMock(page);
    const response = await page.goto(`${webUrl}/accounts/${ACCOUNT_FULL.id}`);
    expect(response?.status(), '/accounts/<id> is reachable with its flags off').toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    expect(mock.requests.filter((url) => url.pathname.startsWith('/api/v1/accounts')), 'a flag-off page still read the account').toEqual([]);
  });

  test('/accounts/<id> cannot be switched on by anything the browser sends @p05-account @p05-account-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-kasuwa-feature-flags': 'crm_record_view,crm_accounts,crm_records',
        'x-crm-record-view': '1',
        'x-kasuwa-tenant-id': TENANT_A,
      },
    });
    await context.addCookies([
      { name: 'crm_record_view', value: 'on', url: webUrl },
      { name: 'crm_accounts', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_record_view,crm_accounts,crm_records', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of [
      `/accounts/${ACCOUNT_FULL.id}?crm_record_view=on&crm_accounts=on&flags=crm_record_view,crm_accounts`,
      `/accounts/${ACCOUNT_FULL.id}/`,
      `/accounts/${ACCOUNT_FULL.id}?locale=en-XA`,
    ]) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/accounts/<id> renders the account record with both flags on @p05-account @p05-account-flag-on', async ({ page }) => {
    await openRecord(page, ACCOUNT_FULL.id);
    await expect(heading(page)).toContainText(ACCOUNT_FULL.name);
  });
});

// ===========================================================================
// The shell
// ===========================================================================

test('the record sits in the CRM shell, and no link on it is a 404 @p05-account @p05-account-shell', async ({ page }) => {
  await openRecord(page, ACCOUNT_DEEP.id);
  await expect(shown(screen(page).locator('[data-hierarchy-entry]')).first()).toBeVisible();
  const shell = page.locator('[data-shell="crm"]');
  await expect(shell).toBeVisible();
  await expect(shell.locator(SCREEN)).toBeVisible();
  await expect(page.getByTestId('settings-menu')).toHaveCount(0);

  // Every same-origin link: the nav, the ancestors, the contact rows.
  const deepLinks = await page.locator('a[href^="/"]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  await closeRecord(page);
  await openRecord(page, ACCOUNT_FULL.id);
  await expect(contactRow(page, contactsOf(ACCOUNT_FULL.id)[0]?.id ?? 'missing')).toBeVisible();
  const fullLinks = await page.locator('a[href^="/"]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  const hrefs = [...new Set([...deepLinks, ...fullLinks])];
  expect(hrefs.length, 'the page links nowhere — not even the CRM nav').toBeGreaterThan(0);
  for (const href of hrefs) {
    expect(href, 'a link leads to the Map, which is a 501').not.toMatch(/\/accounts\/map\b/);
    const response = await page.request.get(`${recordViewUrl()}${href}`);
    expect(response.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }
});

// ===========================================================================
// P05/04 — details, driven by account field security
// ===========================================================================

test.describe('P05/04 — details and field security', () => {
  test('draws the account’s fields as values and labels, never codes or ids, and passes axe @p05-account @p05-account-details', async ({
    page,
  }) => {
    await openRecord(page, ACCOUNT_FULL.id);
    await expect(heading(page)).toContainText(ACCOUNT_FULL.name);
    await expect(field(page, 'industry')).toContainText(String(ACCOUNT_FULL.industry));
    await expect(field(page, 'tags')).toContainText('Distributor');
    expect((await visibleText(field(page, 'phones'))).replace(/\D/g, ''), 'the phone is not drawn').toContain('8030000101');
    await expect(field(page, 'state')).toContainText('Lagos');
    await expect(field(page, 'lga')).toContainText('Ikeja');
    await expect(ownerField(page)).toContainText(ME.displayName);
    // A code on the wire, a label on screen.
    await expectSaysOneOf(field(page, 'tier'), labelsEndingWith('.tier.mid_market'), 'tier mid_market');
    const details = await visibleText(shown(screen(page).getByTestId('record-details')).first());
    expect(details, 'a code was drawn instead of its label').not.toMatch(/mid_market|\bnull\b|\bundefined\b/);
    // The contract says a screen must not infer DND for an account's numbers.
    expect(details, 'a DND marker was inferred for an account phone').not.toMatch(/\bDND\b|do not disturb/i);

    expect(await page.title(), 'the account’s name is in the document title').not.toContain(ACCOUNT_FULL.name);
    expect(await page.title()).not.toContain('Ọjà');

    await expectNoIdsAnywhere(page, 'the record');
    await expectNoSeriousAxe(page, 'P05/04');
  });

  test('record data with markup in it is drawn as text, never parsed @p05-account @p05-account-details', async ({ page }) => {
    await openRecord(page, ACCOUNT_HOSTILE.id);
    await expect(heading(page)).toContainText('<b>Stores</b>');
    await expect(field(page, 'tags')).toContainText(HOSTILE_TAG);
    const note = item(page, timelineOf(ACCOUNT_HOSTILE.id)[0]?.id ?? 'missing');
    await expect(note).toContainText('<b>Friday</b>');
    await expect(note).toContainText('Promise to pay');
    await expect(contactRow(page, contactsOf(ACCOUNT_HOSTILE.id)[0]?.id ?? 'missing')).toContainText('<b>Obi</b>');
    const parsed = '[onerror], script, b:text-is("Stores"), i:text-is("VIP"), b:text-is("Friday"), b:text-is("Obi")';
    await expect(screen(page).locator(parsed)).toHaveCount(0);
    expect(await page.title()).not.toContain('Bùkọ́lá');
    expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss)).toBeUndefined();
    expect(HOSTILE_NAME + HOSTILE_SUBJECT + HOSTILE_BODY + HOSTILE_CONTACT_NAME).toContain('onerror');
  });

  test('a withheld field keeps its place with a lock, never blank and never an input @p05-account @p05-account-locked', async ({
    page,
  }) => {
    await openRecord(page, ACCOUNT_LOCKED.id, { role: 'admin' });
    for (const name of ['phones', 'tier']) {
      expect(ACCOUNT_LOCKED.withheldFields).toContain(name);
      const locked = field(page, name);
      await expect(locked, `the withheld ${name} is not drawn at all`).toBeVisible();
      await expect(locked).toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(locked)).toHaveCount(1);
      const said = await visibleText(locked);
      expect(said, `${name} is withheld and drawn as empty`).not.toBe('');
      expect(said, `${name} is withheld and drawn as a missing value`).not.toMatch(/^(null|undefined|—|-|–|0)$/i);
      await expect(locked.locator('input, select, textarea, [contenteditable="true"]'), `the withheld ${name} is an input`).toHaveCount(0);
    }
    await expect(ownerField(page)).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(ownerField(page))).toHaveCount(1);
    // What the caller can read in the same programme is not locked.
    for (const [name, value] of [['industry', 'Utilities'], ['tags', 'Water arrears'], ['state', 'Lagos'], ['lga', 'Surulere']] as const) {
      await expect(field(page, name)).toContainText(value);
      await expect(field(page, name)).not.toHaveAttribute('data-locked', 'true');
    }
    // An activity whose subject and body are withheld still says what it was and who logged it.
    const call = item(page, 'ti_b2Wc8dLeH1');
    await expect(call).toBeVisible();
    await expectSaysOneOf(call, activityTypeLabels('call'), 'the call item');
    await expect(call.locator('[data-actor]').first()).toContainText(OTHER_OWNER.displayName);
    expect(await visibleText(call)).not.toMatch(/\bnull\b|\bundefined\b/);
    await expectNoIdsAnywhere(page, 'the locked record');
  });

  test('a null field says "not set", never a lock @p05-account @p05-account-locked', async ({ page }) => {
    await openRecord(page, ACCOUNT_NULLS.id);
    for (const name of ['industry', 'tier', 'tags', 'phones', 'state', 'lga']) {
      const target = field(page, name);
      await expect(target, `the empty ${name} is not drawn`).toBeVisible();
      await expect(target).not.toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(target)).toHaveCount(0);
      expect(await visibleText(target), `${name}: a null is drawn as code`).not.toMatch(/\bnull\b|\bundefined\b|\[\]/);
    }
    await expect(ownerField(page)).not.toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(ownerField(page))).toHaveCount(0);
  });
});

// ===========================================================================
// P05/04 — the hierarchy (D-L74)
// ===========================================================================

test.describe('P05/04 — the hierarchy breadcrumb', () => {
  test('draws every ancestor root first by name, linked, at most four reads, the record last @p05-account @p05-account-hierarchy', async ({
    page,
  }) => {
    const mock = await openRecord(page, ACCOUNT_DEEP.id);
    const crumb = hierarchy(page);
    await expect(crumb).toBeVisible();
    await expect.poll(() => hierarchyIds(page), { message: 'the breadcrumb is not the chain, root first' }).toEqual(DEEP_CHAIN.map((row) => row.id));
    for (const ancestor of DEEP_CHAIN.slice(0, -1)) {
      const entry = shown(crumb.locator(`[data-hierarchy-entry="${ancestor.id}"]`)).first();
      await expect(entry).toContainText(ancestor.name);
      await expect(entry.locator(`a[href="/accounts/${ancestor.id}"]`), `${ancestor.name} is not a link to its record`).toHaveCount(1);
    }
    const current = shown(crumb.locator(`[data-hierarchy-entry="${ACCOUNT_DEEP.id}"]`)).first();
    await expect(current).toContainText(ACCOUNT_DEEP.name);
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current.locator('a'), 'the record links to itself').toHaveCount(0);
    // One read of the record, one per ancestor: the walk is bounded and never repeated.
    expect([...mock.accountReads].sort(), 'the hierarchy was not read once per level').toEqual(DEEP_CHAIN.map((row) => row.id).sort());
    expect(await visibleText(crumb), 'a rollup or money figure is drawn on the hierarchy').not.toMatch(/₦|NGN|\bpipeline\b|roll(s|ed)? up/i);
    await expectNoIdsAnywhere(page, 'the breadcrumb');

    // A level-2 account: its parent, then itself.
    await closeRecord(page);
    const full = await openRecord(page, ACCOUNT_FULL.id);
    await expect.poll(() => hierarchyIds(page)).toEqual([ACCOUNT_GROUP.id, ACCOUNT_FULL.id]);
    await expect(hierarchy(page)).toContainText(ACCOUNT_GROUP.name);
    expect([...full.accountReads].sort()).toEqual([ACCOUNT_FULL.id, ACCOUNT_GROUP.id].sort());
  });

  test('stops at four ancestors even when the data claims a longer chain @p05-account @p05-account-hierarchy', async ({ page }) => {
    // The database refuses a cycle or a sixth level (D-L74), but a screen that
    // trusts that and walks until `null` loops forever on the day it is wrong.
    const mock = await openRecord(page, ACCOUNT_DEEP.id, { hierarchyCycle: true });
    await expect(heading(page)).toContainText(ACCOUNT_DEEP.name);
    await expect(shown(screen(page).locator('[data-hierarchy-entry]')).first()).toBeVisible();
    const ids = await hierarchyIds(page);
    expect(new Set(ids).size, 'an account is drawn twice in the breadcrumb').toBe(ids.length);
    expect(ids.length, 'more than five levels drawn').toBeLessThanOrEqual(MAX_ANCESTORS + 1);
    expect(mock.accountReads.length, 'the walk did not stop').toBeLessThanOrEqual(MAX_ANCESTORS + 1);
  });

  test('a top-level account reads no parent; a withheld parent link is a lock, read nowhere @p05-account @p05-account-hierarchy', async ({
    page,
  }) => {
    const top = await openRecord(page, ACCOUNT_NULLS.id);
    await expect(heading(page)).toContainText(ACCOUNT_NULLS.name);
    expect(top.accountReads, 'a top-level account read something besides itself').toEqual([ACCOUNT_NULLS.id]);
    const crumbs = shown(screen(page).getByTestId('account-hierarchy'));
    if ((await crumbs.count()) > 0) {
      // Drawn or not is the builder's; drawn, it holds the record alone and no lock.
      await expect(crumbs.first()).not.toHaveAttribute('data-locked', 'true');
      expect(await hierarchyIds(page)).toEqual([ACCOUNT_NULLS.id]);
    }

    await closeRecord(page);
    const locked = await openRecord(page, ACCOUNT_LOCKED.id);
    const crumb = hierarchy(page);
    await expect(crumb, 'a withheld parent link is not drawn at all').toBeVisible();
    await expect(crumb).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(crumb)).toHaveCount(1);
    expect(await visibleText(crumb)).not.toBe('');
    await expect(crumb.locator('a')).toHaveCount(0);
    expect(locked.accountReads, 'an ancestor was read for a record whose parent link is withheld').toEqual([ACCOUNT_LOCKED.id]);
  });
});

test.fixme('the account’s children are drawn under it @p05-account-children', async () => {
  // BLOCKED ON THE CONTRACT. Nothing serves an account's children: `Account`
  // has the one parentAccountId link, listAccounts has no parent filter and
  // ignores unknown parameters, and scanning every account in reach is
  // unbounded on a 256 kbps link (the mock refuses listAccounts). When the
  // contract serves them (a `parent` filter, judged like any filter on a
  // withheld field, or an account-children read), this journey opens
  // ACCOUNT_FULL, expects ACCOUNT_REGION under it by name and linked, keyset
  // paged, with no count, and nothing for a withheld parentAccountId.
});

// ===========================================================================
// P05/04 — the contacts grid (listAccountContacts)
// ===========================================================================

test.describe('P05/04 — the contacts grid', () => {
  test('draws the served contacts in served order, keyset "more", locks per row, no count @p05-account @p05-account-contacts', async ({
    page,
  }) => {
    const mock = await installAccountRecordMock(page, { recordId: ACCOUNT_FULL.id });
    active = mock;
    const all = contactsOf(ACCOUNT_FULL.id);
    const firstPage = page.waitForResponse((response) => isAccountContacts(response.request(), ACCOUNT_FULL.id) && !new URL(response.url()).searchParams.has('cursor'));
    expect((await page.goto(`${recordViewUrl()}/accounts/${ACCOUNT_FULL.id}`))?.status()).toBe(200);
    await expect(screen(page)).toHaveAttribute('data-record-state', 'ready');
    const next = ((await (await firstPage).json()) as { nextCursor: string | null }).nextCursor;
    expect(next, 'the mock served one page').not.toBeNull();
    await expect(contactRow(page, all[0]?.id ?? 'missing')).toBeVisible();
    await expect.poll(() => renderedContactIds(page), { message: 'the grid is not the served page' }).toEqual(all.slice(0, CONTACT_PAGE_CAP).map((row) => row.id));

    for (const row of all.slice(0, CONTACT_PAGE_CAP)) {
      const drawn = contactRow(page, row.id);
      await expect(drawn.locator('[data-field="displayName"]').first()).toContainText(row.displayName);
      const phone = (row.phones as { e164: string }[])[0]?.e164 ?? '';
      expect((await visibleText(drawn.locator('[data-field="phones"]').first())).replace(/\D/g, ''), `${row.displayName}: no phone`).toContain(phone.replace(/\D/g, '').slice(-10));
      // `emails` is withheld on every row here. Drawn, it is a lock; not drawn
      // is also honest (a legitimately vacuous branch: the column is optional).
      const emails = drawn.locator('[data-field="emails"]');
      if ((await emails.count()) > 0) {
        await expect(emails.first()).toHaveAttribute('data-locked', 'true');
      }
      const links = drawn.locator('a[href]');
      if ((await links.count()) > 0) {
        await expect(links.first(), 'a contact row links somewhere other than its record').toHaveAttribute('href', `/contacts/${row.id}`);
      }
    }

    // Keyset: the cursor echoed, never in the address bar; a short page is not the last page.
    const more = shown(screen(page).getByTestId('account-contacts-more')).first();
    await expect(more, 'a page short of its limit was taken as the last').toBeEnabled();
    const answered = page.waitForResponse((response) => isAccountContacts(response.request(), ACCOUNT_FULL.id) && new URL(response.url()).searchParams.has('cursor'));
    await more.click();
    const reply = await answered;
    expect(new URL(reply.url()).searchParams.get('cursor'), 'the cursor was not echoed verbatim').toBe(next);
    await expect.poll(() => renderedContactIds(page), { message: '"more" dropped, repeated or reordered contacts' }).toEqual(all.map((row) => row.id));
    await expectNoUsable(shown(screen(page).getByTestId('account-contacts-more')), '"more" on the last page');
    expect(page.url()).not.toMatch(/[?&]cursor=/);
    expect(mock.contactsReads, 'the grid re-read the first page').toHaveLength(2);
    // No count of related records (D-P13): not "6 contacts", not "Contacts (4)".
    const grid = await visibleText(contactsGrid(page));
    expect(grid, 'the grid draws a count').not.toMatch(new RegExp(`\\b(${all.length}|${CONTACT_PAGE_CAP})\\b(?!\\d)`));
    await expect(screen(page).getByTestId('account-contacts-empty')).toHaveCount(0);
    await expectNoIdsAnywhere(page, 'the contacts grid');
  });

  test('a withheld account link is its own message, never "no contacts"; empty and failed are distinct @p05-account @p05-account-contacts-withheld', async ({
    page,
  }) => {
    const locked = await installAccountRecordMock(page, { recordId: ACCOUNT_LOCKED.id });
    active = locked;
    const refused = page.waitForResponse((response) => isAccountContacts(response.request(), ACCOUNT_LOCKED.id));
    expect((await page.goto(`${recordViewUrl()}/accounts/${ACCOUNT_LOCKED.id}`))?.status()).toBe(200);
    expect((await refused).status(), 'the mock did not refuse the withheld filter').toBe(400);
    const message = shown(screen(page).getByTestId('account-contacts-withheld')).first();
    await expect(message).toBeVisible();
    expect(await visibleText(message)).not.toBe('');
    await expect(screen(page).getByTestId('account-contacts-empty'), '"no contacts" for a list the caller may not see').toHaveCount(0);
    await expect(screen(page).getByTestId('account-contacts-error')).toHaveCount(0);
    await expect(screen(page).locator('[data-contact-row]')).toHaveCount(0);
    // A 400 is an answer, not a blip: read once, never retried in a loop.
    expect(locked.contactsReads).toHaveLength(1);

    await closeRecord(page);
    await openRecord(page, ACCOUNT_NULLS.id);
    await expect(shown(screen(page).getByTestId('account-contacts-empty')).first()).toBeVisible();
    await expect(screen(page).getByTestId('account-contacts-withheld')).toHaveCount(0);
    await expect(screen(page).getByTestId('account-contacts-error')).toHaveCount(0);

    await closeRecord(page);
    await openRecord(page, ACCOUNT_FULL.id, { contactsFailure: true });
    await expect(shown(screen(page).getByTestId('account-contacts-error')).first()).toBeVisible();
    await expect(screen(page).getByTestId('account-contacts-empty')).toHaveCount(0);
    await expect(screen(page).getByTestId('account-contacts-withheld')).toHaveCount(0);
    await expect(heading(page)).toContainText(ACCOUNT_FULL.name);
  });
});

// ===========================================================================
// P05/04 — the account timeline (T-0080)
// ===========================================================================

test.describe('P05/04 — the account timeline', () => {
  test('draws every item once, in served order; field changes by name only; actors by name @p05-account @p05-account-timeline', async ({
    page,
  }) => {
    const mock = await openRecord(page, ACCOUNT_FULL.id);
    const served = timelineOf(ACCOUNT_FULL.id);
    await expect(item(page, served[0]?.id ?? 'missing')).toBeVisible();
    const first = mock.timelineReads[0];
    expect(first, 'the screen never read the account timeline').toBeDefined();
    const limit = first?.searchParams.get('limit');
    if (limit !== null && limit !== undefined) {
      expect(Number(limit), 'the first timeline page is too small for the journeys').toBeGreaterThanOrEqual(DEFAULT_TIMELINE_MAX);
    }
    expect(await renderedItemIds(page), 'the timeline is not the served items, once each, newest first').toEqual(served.map((entry) => entry.id));

    for (const entry of served) {
      const row = item(page, entry.id);
      await expect(row).toHaveAttribute('data-item-type', entry.type);
      const instants = await row
        .locator('time[datetime]')
        .evaluateAll((times) => times.map((time) => Date.parse(time.getAttribute('datetime') ?? '')));
      expect(instants, `${entry.id} draws no <time datetime> for when it happened`).toContain(Date.parse(entry.occurredAt));
      // By name only: an account change never has a before or an after.
      await expect(row.locator('[data-change]'), `${entry.id}: a value was invented for a name-only change`).toHaveCount(0);
      if (entry.type === 'field_changed') {
        await expectSaysOneOf(row, fieldLabels(String(entry.field)), `the ${String(entry.field)} item`);
      }
      const actor = row.locator('[data-actor]').first();
      await expect(actor, `${entry.id} names no actor`).toBeVisible();
      if (entry.actor !== null) {
        await expect(actor).toContainText(entry.actor.displayName);
      }
    }
    expect(ACCOUNT_TIMELINE_FIELDS.length).toBeGreaterThan(5);

    // null is the system: one label, the same everywhere, never a person.
    const systemItems = served.filter((entry) => entry.actor === null);
    expect(systemItems.length).toBeGreaterThan(1);
    const systemLabels = new Set<string>();
    for (const entry of systemItems) {
      systemLabels.add(await visibleText(item(page, entry.id).locator('[data-actor]').first()));
    }
    expect(systemLabels.size, 'the system is drawn more than one way').toBe(1);
    const system = [...systemLabels][0] ?? '';
    expect(system).toMatch(/system/i);
    for (const who of [ME, OTHER_OWNER, FORMER_MEMBER]) {
      expect(system).not.toContain(who.displayName);
    }
    await expect(item(page, ITEM_NOTE.id).locator('[data-actor]').first()).toContainText(FORMER_MEMBER.displayName);

    // The current value is not the change: never drawn on a name-only item as if it were.
    expect(await visibleText(item(page, ITEM_TIER.id)), 'the tier item shows a tier').not.toMatch(new RegExp(labelsEndingWith('.tier.mid_market').join('|') || '$^'));
    expect((await visibleText(item(page, ITEM_PHONES.id))).replace(/\D/g, ''), 'the phones item shows a number').not.toContain('8030000101');
    expect(await visibleText(item(page, ITEM_OWNER.id)), 'an owner change names an owner').not.toContain(ME.displayName);
    expect(await visibleText(item(page, ITEM_PARENT.id)), 'a parent change names the parent').not.toContain(ACCOUNT_GROUP.name);
    expect(await visibleText(item(page, ITEM_CREATED_NAME.id)), 'a name change shows the name').not.toContain(ACCOUNT_FULL.name);

    // Activities: type, subject, body, due time in the browser's zone, completion.
    await expectSaysOneOf(item(page, ITEM_TASK.id), activityTypeLabels('task'), 'the task item');
    await expectSaysOneOf(item(page, ITEM_NOTE.id), activityTypeLabels('note'), 'the note item');
    await expectSaysOneOf(item(page, ITEM_CALL.id), activityTypeLabels('call'), 'the call item');
    await expect(item(page, ITEM_TASK.id)).toContainText(String(ITEM_TASK.subject));
    await expect(item(page, ITEM_TASK.id)).toContainText(String(ITEM_TASK.body));
    await expect(item(page, ITEM_NOTE.id)).toContainText(String(ITEM_NOTE.body));
    const due = await visibleText(item(page, ITEM_TASK.id));
    // Due 2026-10-02T15:00Z is 16:00 in Lagos (WAT, UTC+1).
    expect(due, 'the due time is not shown in the browser’s zone').toMatch(/\b16[:.]00\b|\b4[:.]00\s?[Pp]\.?[Mm]/);
    expect(due, 'the due time is shown in UTC').not.toMatch(/\b15[:.]00\b|\b3[:.]00\s?[Pp]\.?[Mm]/);
    await expect(item(page, ITEM_TASK.id)).toHaveAttribute('data-completed', 'false');
    await expect(item(page, ITEM_DONE_TASK.id)).toHaveAttribute('data-completed', 'true');
    await expectNoUsable(item(page, ITEM_DONE_TASK.id).locator('[data-action="complete-task"]'), 'complete on a completed task');

    const all = await visibleText(shown(screen(page).getByTestId('timeline')).first());
    expect(all, 'raw values leaked into the timeline').not.toMatch(/\bnull\b|\bundefined\b|\[object Object\]|\btrue\b|\bfalse\b|\bredacted\b|\bti_\w+|parentAccountId|ownerUserId/);
    expect(all, 'a raw timestamp was printed').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await expect(shown(screen(page).getByTestId('timeline-load-older')), 'a single page offers "load older"').toHaveCount(0);
    await expectNoIdsAnywhere(page, 'the timeline');
  });

  test('"load older" pages by keyset, echoes the cursor exactly, keeps it out of the address bar, and shows no total @p05-account @p05-account-paging', async ({
    page,
  }) => {
    const mock = await installAccountRecordMock(page, { recordId: ACCOUNT_LONG.id });
    active = mock;
    const served = timelineOf(ACCOUNT_LONG.id);
    const target = `${recordViewUrl()}/accounts/${ACCOUNT_LONG.id}`;
    const firstPage = page.waitForResponse((response) => isAccountTimeline(response.request(), ACCOUNT_LONG.id) && !new URL(response.url()).searchParams.has('cursor'));
    expect((await page.goto(target))?.status()).toBe(200);
    await expect(screen(page)).toHaveAttribute('data-record-state', 'ready');
    let next = ((await (await firstPage).json()) as { nextCursor: string | null }).nextCursor;
    expect(next, 'the long timeline has no second page').not.toBeNull();
    await expect(item(page, served[0]?.id ?? 'missing')).toBeVisible();
    await expect(shown(screen(page).getByText(LONG_OLDEST_SUBJECT))).toHaveCount(0);

    let pages = 1;
    while (next !== null && pages <= LONG_TIMELINE_LENGTH) {
      const more = shown(screen(page).getByTestId('timeline-load-older')).first();
      await expect(more, 'there is more history and no "load older"').toBeEnabled();
      const cursor: string = next;
      const answered = page.waitForResponse((candidate) => isAccountTimeline(candidate.request(), ACCOUNT_LONG.id) && new URL(candidate.url()).searchParams.has('cursor'));
      await more.click();
      const reply = await answered;
      expect(new URL(reply.url()).searchParams.get('cursor'), 'the cursor was not echoed verbatim').toBe(cursor);
      next = ((await reply.json()) as { nextCursor: string | null }).nextCursor;
      pages += 1;
      expect(page.url(), 'the cursor was written into the page URL').not.toContain(cursor);
    }
    await expect(shown(screen(page).getByText(LONG_OLDEST_SUBJECT))).toBeVisible();
    expect(await renderedItemIds(page), 'paging dropped, repeated or reordered items at a page edge').toEqual(served.map((entry) => entry.id));
    expect(mock.timelineReads.filter((url) => !url.searchParams.has('cursor')), '"load older" re-read the first page').toHaveLength(1);
    expect(mock.timelineReads).toHaveLength(pages);
    await expectNoUsable(shown(screen(page).getByTestId('timeline-load-older')), '"load older" on the last page');
    expect(page.url()).not.toMatch(/[?&]cursor=/);
    const text = await visibleText(screen(page));
    expect(text, 'a total was drawn').not.toMatch(new RegExp(`\\b${LONG_TIMELINE_LENGTH}\\b`));
    expect(text).not.toMatch(/\b\d+\s+of\s+\d+\b/i);
  });

  test('a task served on the timeline is completed with the version its item carries @p05-account @p05-account-complete', async ({
    page,
  }) => {
    const mock = await openRecord(page, ACCOUNT_FULL.id);
    const task = item(page, ITEM_TASK.id);
    await expect(task).toHaveAttribute('data-completed', 'false');
    const complete = task.locator('[data-action="complete-task"]').first();
    await expect(complete).toBeEnabled();
    await expect(complete).toHaveAttribute('data-requires-connection', /.*/);
    const patched = page.waitForRequest((request) => isUpdateActivity(request, String(ITEM_TASK.activityId)));
    await complete.click();
    const body = json((await patched).postDataJSON());
    expect(keysOf(body), 'completing sent more than version and completed').toEqual(['completed', 'version']);
    // 3, from the timeline: not 1, not a guess.
    expect(body.version, 'completing did not send the version the timeline served').toBe(ITEM_TASK.version);
    expect(body.completed).toBe(true);
    await expect(task).toHaveAttribute('data-completed', 'true');
    await expectNoUsable(task.locator('[data-action="complete-task"]'), 'complete on the task just completed');
    expect(mock.writes.filter((write) => write.method === 'PATCH')).toHaveLength(1);
    expect(await renderedItemIds(page), 'completing added or dropped an item').toHaveLength(timelineOf(ACCOUNT_FULL.id).length);
  });

  test('a stale complete is a 409 alert; the screen re-reads, never retries blind, and the fresh version works @p05-account @p05-account-stale', async ({
    page,
  }) => {
    const mock = await openRecord(page, ACCOUNT_FULL.id, { staleTask: true, query: '?locale=en-XA' });
    const task = item(page, ITEM_TASK.id);
    const readsBefore = mock.timelineReads.length;
    const answered = page.waitForResponse((response) => isUpdateActivity(response.request(), String(ITEM_TASK.activityId)));
    const reread = page.waitForResponse((response) => isAccountTimeline(response.request(), ACCOUNT_FULL.id) && !new URL(response.url()).searchParams.has('cursor') && mock.timelineReads.length > readsBefore);
    await task.locator('[data-action="complete-task"]').first().click();
    expect((await answered).status()).toBe(409);
    const alert = shown(screen(page).getByRole('alert')).first();
    await expect(alert, 'no alert for a 409').toBeVisible();
    expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    // The screen re-reads by itself, and nothing optimistic is left behind.
    await reread;
    await expect(item(page, ITEM_TASK.id)).toHaveAttribute('data-completed', 'false');
    expect(mock.writes.filter((write) => write.method === 'PATCH'), 'the stale write was retried blind').toHaveLength(1);

    const second = page.waitForRequest((request) => isUpdateActivity(request, String(ITEM_TASK.activityId)));
    await item(page, ITEM_TASK.id).locator('[data-action="complete-task"]').first().click();
    const body = json((await second).postDataJSON());
    expect(body.version, 'the second try did not send the re-read version').toBe(Number(ITEM_TASK.version) + 1);
    await expect(item(page, ITEM_TASK.id)).toHaveAttribute('data-completed', 'true');
    expect(mock.writes.map((write) => write.status)).toEqual([409, 200]);
  });
});

// ===========================================================================
// P05/04 — logging a note, a task and a call on the account (D-P18)
// ===========================================================================

test.describe('P05/04 — activities on the account', () => {
  test('a note and a call are logged once against the account, no contact, and appear on its timeline @p05-account @p05-account-log', async ({
    page,
  }) => {
    const mock = await openRecord(page, ACCOUNT_FULL.id, { holdWrites: true });
    const note = await openLog(page, 'note');
    await expectNoUsable(note.locator('[data-field-input="dueAt"]'), 'a due time on a note');
    await note.locator('[data-field-input="body"]').first().fill('Depot gate B is closed on Sundays.');
    const save = note.locator('[data-action="save-activity"]').first();
    await expect(save).toHaveAttribute('data-requires-connection', /.*/);
    const posted = page.waitForRequest(isCreateActivity);
    await save.click();
    const body = json((await posted).postDataJSON());
    expect(body.type).toBe('note');
    expect(body.accountId, 'the note was not logged against the account on screen').toBe(ACCOUNT_FULL.id);
    expect(body.contactId === undefined || body.contactId === null, 'an account note named a contact').toBe(true);
    expect(body.body).toBe('Depot gate B is closed on Sundays.');
    expect(body.subject === undefined || body.subject === null, 'an empty subject was sent as text').toBe(true);
    await expect(save).toBeDisabled();
    mock.releaseWrites();
    const logged = activityEntry(page, NEW_ACTIVITY_IDS[0] ?? 'missing');
    await expect(logged, 'the new note is not on the account timeline').toBeVisible();
    await expect(logged).toContainText('Depot gate B is closed on Sundays.');
    await expect(logged.locator('[data-actor]').first()).toContainText(ME.displayName);
    expect(mock.writes.filter((write) => write.method === 'POST'), 'the note was logged more than once').toHaveLength(1);

    const call = await openLog(page, 'call');
    await expectNoUsable(call.locator('[data-field-input="dueAt"]'), 'a due time on a call');
    await call.locator('[data-field-input="subject"]').first().fill('Called the procurement desk');
    const second = page.waitForRequest(isCreateActivity);
    await call.locator('[data-action="save-activity"]').first().click();
    const callBody = json((await second).postDataJSON());
    expect(callBody.type).toBe('call');
    expect(callBody.accountId).toBe(ACCOUNT_FULL.id);
    expect(callBody.contactId === undefined || callBody.contactId === null).toBe(true);
    await expect(activityEntry(page, NEW_ACTIVITY_IDS[1] ?? 'missing')).toContainText('Called the procurement desk');
    const newest = await shown(screen(page).locator('[data-timeline-item]')).evaluateAll((items) =>
      items.slice(0, 2).map((element) => element.getAttribute('data-activity-id') ?? ''),
    );
    expect(newest, 'what was just logged is not at the top of the timeline').toEqual([NEW_ACTIVITY_IDS[1], NEW_ACTIVITY_IDS[0]]);
    expect(await renderedItemIds(page), 'logging dropped or repeated an item').toHaveLength(timelineOf(ACCOUNT_FULL.id).length + 2);
    await expectNoIdsAnywhere(page, 'after logging');
  });

  test('a task carries its due time in UTC from the browser’s zone, and is completed with the version it was served @p05-account @p05-account-log', async ({
    page,
  }) => {
    const mock = await openRecord(page, ACCOUNT_FULL.id);
    const task = await openLog(page, 'task');
    await task.locator('[data-field-input="subject"]').first().fill('Send the revised quote');
    const due = task.locator('[data-field-input="dueAt"]').first();
    await expect(due).toHaveAttribute('type', 'datetime-local');
    // 15:00 on a Lagos desk is 14:00 UTC.
    await due.fill('2026-10-09T15:00');
    const posted = page.waitForRequest(isCreateActivity);
    await task.locator('[data-action="save-activity"]').first().click();
    const body = json((await posted).postDataJSON());
    expect(body.type).toBe('task');
    expect(body.accountId).toBe(ACCOUNT_FULL.id);
    expect(String(body.dueAt), 'the due time is not UTC with a Z').toMatch(/Z$/);
    expect(Date.parse(String(body.dueAt)), 'the due time was not converted from the browser’s zone').toBe(Date.parse('2026-10-09T14:00:00.000Z'));

    const logged = activityEntry(page, NEW_ACTIVITY_IDS[0] ?? 'missing');
    await expect(logged).toHaveAttribute('data-completed', 'false');
    const patched = page.waitForRequest((request) => isUpdateActivity(request, NEW_ACTIVITY_IDS[0]));
    await logged.locator('[data-action="complete-task"]').first().click();
    const update = json((await patched).postDataJSON());
    expect(keysOf(update)).toEqual(['completed', 'version']);
    expect(update.version, 'completing did not send the version the create returned').toBe(1);
    await expect(logged).toHaveAttribute('data-completed', 'true');
    expect(mock.writes.map((write) => `${write.method} ${String(write.status)}`)).toEqual(['POST 201', 'PATCH 200']);
  });

  test('a refused activity is a translated alert; the form and the typing are kept, and nothing is added @p05-account @p05-account-activity-refusals', async ({
    page,
  }) => {
    // qa_analyst may not log activities (D-P18); D-L84 still shows the control.
    const mock = await openRecord(page, ACCOUNT_FULL.id, { role: 'reader', query: '?locale=en-XA' });
    const before = await renderedItemIds(page);
    const note = await openLog(page, 'note');
    await note.locator('[data-field-input="body"]').first().fill('Asked for a statement of account.');
    const answered = page.waitForResponse((response) => isCreateActivity(response.request()));
    await note.locator('[data-action="save-activity"]').first().click();
    expect((await answered).status()).toBe(403);
    const alert = shown(note.getByRole('alert')).first();
    await expect(alert).toBeVisible();
    expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect(note).toBeVisible();
    await expect(note.locator('[data-field-input="body"]').first()).toHaveValue('Asked for a statement of account.');
    expect(await renderedItemIds(page), 'a refused note was drawn on the timeline').toEqual(before);
    expect(mock.timelines.get(ACCOUNT_FULL.id)).toHaveLength(timelineOf(ACCOUNT_FULL.id).length);
  });
});

// ===========================================================================
// P05/04 — editing the account (D-L69: admin-only, D-L84: the 403 is the gate)
// ===========================================================================

test.describe('P05/04 — the account edit', () => {
  test('the edit sends version and only what changed, offers no withheld field as an input, and shows the change @p05-account @p05-account-edit', async ({
    page,
  }) => {
    const mock = await openRecord(page, ACCOUNT_FULL.id, { role: 'admin' });
    const form = await openEdit(page);
    await expect(form.locator('[data-field-input="name"]').first()).toHaveValue(ACCOUNT_FULL.name);
    await expectNoUsable(form.locator('[data-field-input="programmeId"]'), 'the programmeId input');
    await expectNoIdsAnywhere(page, 'the edit sheet');
    await expectNoSeriousAxe(page, 'the edit sheet');

    await form.locator('[data-field-input="name"]').first().fill(RENAMED);
    const sent = page.waitForRequest((request) => isUpdateAccount(request, ACCOUNT_FULL.id));
    await form.locator('[data-action="save-account"]').first().click();
    const body = json((await sent).postDataJSON());
    // tier and tags are read-only for this caller: sent unchanged, the API refuses the whole edit.
    expect(keysOf(body), 'the edit sent fields the user did not change').toEqual(['name', 'version']);
    expect(body.version).toBe(ACCOUNT_FULL.version);
    await expect(form).toBeHidden();
    await expect(heading(page)).toContainText(RENAMED);
    expect(mock.accounts.get(ACCOUNT_FULL.id)?.name).toBe(RENAMED);
    expect(await page.title(), 'the new name went into the title').not.toContain(RENAMED);

    await closeRecord(page);
    const lockedMock = await openRecord(page, ACCOUNT_LOCKED.id, { role: 'admin' });
    const locked = await openEdit(page);
    for (const name of ACCOUNT_LOCKED.withheldFields) {
      await expectNoUsable(locked.locator(`[data-field-input="${name}"]`), `the withheld ${name} input`);
    }
    await locked.locator('[data-field-input="name"]').first().fill('Surulere Water Kiosks Ltd');
    const second = page.waitForRequest((request) => isUpdateAccount(request, ACCOUNT_LOCKED.id));
    await locked.locator('[data-action="save-account"]').first().click();
    const lockedBody = json((await second).postDataJSON());
    for (const name of ACCOUNT_LOCKED.withheldFields) {
      expect(name in lockedBody, `the edit sent ${name}, which the caller cannot read`).toBe(false);
    }
    await expect(locked).toBeHidden();
    expect(lockedMock.writes).toHaveLength(1);
  });

  test('a refused or stale edit is a translated alert; the sheet, the typing and the served values are kept @p05-account @p05-account-refusals', async ({
    page,
  }) => {
    for (const [options, status] of [
      [{ role: 'agent' }, 403],
      [{ role: 'admin', refuse: 'stale_write' }, 409],
    ] as const) {
      await closeRecord(page);
      // en-XA proves the alert is the screen's own copy (records.error.<code>).
      const mock = await openRecord(page, ACCOUNT_FULL.id, { ...options, query: '?locale=en-XA' });
      // D-L84: no capability read, so the control is there for everyone.
      await expect(shown(screen(page).locator('[data-action="edit-account"]')).first(), 'the edit is hidden from this caller').toBeEnabled();
      const form = await openEdit(page);
      await form.locator('[data-field-input="name"]').first().fill(RENAMED);
      const answered = page.waitForResponse((response) => isUpdateAccount(response.request(), ACCOUNT_FULL.id));
      await form.locator('[data-action="save-account"]').first().click();
      expect((await answered).status()).toBe(status);
      const alert = shown(form.getByRole('alert')).first();
      await expect(alert, `no alert for a ${status}`).toBeVisible();
      expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
      await expect(form).toBeVisible();
      await expect(form.locator('[data-field-input="name"]').first()).toHaveValue(RENAMED);
      await expect(heading(page)).toContainText(ACCOUNT_FULL.name);
      expect(mock.accounts.get(ACCOUNT_FULL.id)?.name).toBe(ACCOUNT_FULL.name);
    }
  });
});

test.fixme('non-writers see no write controls @p05-account-writers', async () => {
  // BLOCKED ON T-0079 (D-L84). No read tells the screen whether the caller
  // holds `account.write` or `activity.write`. When one does, this opens
  // ACCOUNT_FULL as `reader` and expects no edit, log or complete control.
});

// ===========================================================================
// Out of scope (D-L69)
// ===========================================================================

test('an id out of scope or missing is the generic not-found; a non-uuid is a real 404 that reads nothing @p05-account @p05-account-not-found', async ({
  page,
}) => {
  const mock = await installAccountRecordMock(page);
  active = mock;
  const title = EN['notFound.title'] ?? '<notFound.title>';
  const explanation = EN['notFound.body'] ?? '<notFound.body>';
  const headings: string[] = [];
  // `map` is a concrete API path (getAccountMap, 501): an id that is not a uuid
  // must never be turned into an API call, least of all that one.
  for (const id of [OUT_OF_SCOPE_ID, NO_SUCH_ID, 'not-a-uuid', 'map']) {
    const readsBefore = mock.requests.length;
    const response = await page.goto(`${recordViewUrl()}/accounts/${id}`);
    const status = response?.status() ?? 0;
    if (UUID.test(id)) {
      expect([200, 404], `/accounts/${id} answered neither 200 nor 404`).toContain(status);
      if (status === 200) {
        await expect(shown(page.getByTestId('record-not-found')).first(), `/accounts/${id} is not the not-found state`).toBeVisible();
      }
      // Only the API can say a well-formed id is out of scope: the screen must
      // have asked. (Without this the test passes on a missing route.)
      await expect.poll(() => mock.accountReads.includes(id), { message: `/accounts/${id} never asked the API` }).toBe(true);
    } else {
      expect(status, `/accounts/${id}: a malformed id is not a real 404`).toBe(404);
      const accountCalls = mock.requests.slice(readsBefore).filter((url) => url.pathname.startsWith('/api/v1/accounts'));
      expect(accountCalls.map((url) => url.pathname), `/accounts/${id} reached the accounts API`).toEqual([]);
    }
    const h1 = shown(page.getByRole('heading', { level: 1 })).first();
    await expect(h1).toHaveText(title);
    const whole = await visibleText(page.locator('body'));
    expect(whole).toContain(explanation);
    expect(whole, 'the access-denied frame was drawn').not.toMatch(/request access|access denied|programme owner|can.t open this record|belongs to/i);
    for (const programme of [PROGRAMME_ONE, PROGRAMME_TWO]) {
      expect(whole, 'a programme was named on the not-found page').not.toContain(programme.name);
    }
    await expect(lockIcon(page.locator('main, body').first())).toHaveCount(0);
    await expect(page.locator('[data-testid="record-details"], [data-timeline-item], [data-contact-row], [data-action="edit-account"], [data-action="log-activity"]')).toHaveCount(0);
    await expect(page.getByTestId('record-unavailable')).toHaveCount(0);
    await expectNoIdsAnywhere(page, `the not-found page for ${id}`);
    headings.push(await visibleText(h1));
  }
  expect(new Set(headings).size, 'the not-found page differs between out of scope, missing and malformed').toBe(1);
  expect(mock.writes).toEqual([]);
});

// ===========================================================================
// P05/06 — loading, and a failed read
// ===========================================================================

test.describe('P05/06 — loading, a failed read, an empty or failed timeline', () => {
  test('loading draws the skeleton, never not-found or an empty record, until the record arrives @p05-account @p05-account-loading', async ({
    page,
  }) => {
    const mock = await openRecord(page, ACCOUNT_FULL.id, { hold: true, state: 'loading' });
    try {
      expect(await shown(screen(page).getByTestId('record-skeleton')).count(), 'no skeleton').toBeGreaterThan(0);
      await expect(page.getByTestId('record-not-found')).toHaveCount(0);
      await expect(screen(page).locator('[data-timeline-item], [data-contact-row]')).toHaveCount(0);
      await expect(screen(page).getByTestId('timeline-empty')).toHaveCount(0);
      await expect(screen(page).getByTestId('account-contacts-empty')).toHaveCount(0);
      expect(await visibleText(screen(page))).not.toContain(ACCOUNT_FULL.name);
    } finally {
      mock.release();
    }
    await expect(screen(page)).toHaveAttribute('data-record-state', 'ready');
    await expect(shown(screen(page).getByTestId('record-skeleton'))).toHaveCount(0);
    await expect(heading(page)).toContainText(ACCOUNT_FULL.name);
  });

  test('a failed read says the server could not be reached, never "not found" @p05-account @p05-account-loading', async ({ page }) => {
    const mock = await installAccountRecordMock(page, { recordId: ACCOUNT_FULL.id, networkFailure: true });
    active = mock;
    await page.goto(`${recordViewUrl()}/accounts/${ACCOUNT_FULL.id}`);
    const unavailable = shown(page.getByTestId('record-unavailable')).first();
    await expect(unavailable).toBeVisible();
    expect(await visibleText(unavailable)).not.toBe('');
    await expect(page.getByTestId('record-not-found')).toHaveCount(0);
  });

  test('a failed timeline read is an error, not "no history", and the details still show @p05-account @p05-account-loading', async ({
    page,
  }) => {
    await openRecord(page, ACCOUNT_FULL.id, { timelineFailure: true });
    await expect(heading(page)).toContainText(ACCOUNT_FULL.name);
    await expect(field(page, 'tags')).toContainText('Distributor');
    await expect(shown(screen(page).getByTestId('timeline-error')).first()).toBeVisible();
    await expect(screen(page).getByTestId('timeline-empty')).toHaveCount(0);
    await expect(screen(page).locator('[data-timeline-item]')).toHaveCount(0);

    await closeRecord(page);
    await openRecord(page, ACCOUNT_NULLS.id);
    await expect(shown(screen(page).getByTestId('timeline-empty')).first()).toBeVisible();
    await expect(screen(page).getByTestId('timeline-error')).toHaveCount(0);
  });
});

// ===========================================================================
// P05/05 — offline (D-P21, D-L64)
// ===========================================================================

test('offline keeps the record in memory only, says when it synced, and disables every write @p05-account @p05-account-offline', async ({
  page,
}) => {
  const mock = await openRecord(page, ACCOUNT_FULL.id, { role: 'admin' });
  await expect(item(page, ITEM_TASK.id)).toBeVisible();
  await expect(contactRow(page, contactsOf(ACCOUNT_FULL.id)[0]?.id ?? 'missing')).toBeVisible();
  await expect.poll(() => hierarchyIds(page)).toEqual([ACCOUNT_GROUP.id, ACCOUNT_FULL.id]);
  const writeControls = shown(
    screen(page).locator('[data-action="edit-account"], [data-action="log-activity"], [data-action="complete-task"]'),
  );
  expect(await writeControls.count(), 'the record offers no write control at all').toBeGreaterThan(0);
  for (const control of await writeControls.all()) {
    await expect(control).toHaveAttribute('data-requires-connection', /.*/);
  }
  // A note being typed when the connection drops cannot be saved (D-P21: no queue).
  const note = await openLog(page, 'note');
  await note.locator('[data-field-input="body"]').first().fill('Line dropped mid-call.');

  await page.context().setOffline(true);
  try {
    await expect(note.locator('[data-action="save-activity"]').first()).toBeDisabled();
    const banner = shown(page.getByTestId('offline-banner')).first();
    await expect(banner).toBeVisible();
    expect(await visibleText(banner), 'the banner does not say when the record last synced').toMatch(/\d{1,2}[:.]\d{2}/);
    await expect(heading(page)).toContainText(ACCOUNT_FULL.name);
    await expect(item(page, ITEM_TASK.id)).toBeVisible();

    const needsConnection = page.locator('[data-requires-connection]');
    const count = await needsConnection.count();
    expect(count, 'nothing is marked as needing a connection').toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      expect(await isDisabled(needsConnection.nth(index)), `a control that needs a connection is enabled offline (#${index})`).toBe(true);
    }

    // D-L64: memory only. Nothing of the record on the device, by any route.
    const stored = await deviceStorage(page);
    expect(stored.cachedApi, 'an API response was put in Cache Storage').toEqual([]);
    for (const needle of needles([ACCOUNT_FULL, ACCOUNT_GROUP])) {
      expect(stored.dump.includes(needle), `"${needle}" was written to device storage`).toBe(false);
    }
  } finally {
    await page.context().setOffline(false);
  }
  await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);
  expect(mock.writes, 'a write was sent while offline').toEqual([]);
});

// ===========================================================================
// Hidden until their modules exist (D-L69, D-P13)
// ===========================================================================

test('no rollups, money, Health, Map, related deals or tickets, buying roles, counts or access request @p05-account @p05-account-hidden', async ({
  page,
}) => {
  await openRecord(page, ACCOUNT_FULL.id);
  await expect(item(page, ITEM_TASK.id)).toBeVisible();
  await expect(contactRow(page, contactsOf(ACCOUNT_FULL.id)[0]?.id ?? 'missing')).toBeVisible();
  const root = screen(page);
  const text = await visibleText(root);
  expect(text, 'a pipeline rollup is drawn').not.toMatch(/pipeline|roll(s|ed)? up|open deals?|annual value|weighted/i);
  expect(text, 'money is drawn').not.toMatch(/₦|\bNGN\b|US\$|\bGHS\b|\bKES\b|\bZAR\b/);
  expect(text, 'a Health score is drawn').not.toMatch(/\bhealth\b/i);
  expect(text, 'the Map is offered').not.toMatch(/\bmap\b/i);
  expect(text, 'a related deal, ticket, quote, invoice or campaign is drawn').not.toMatch(/\bdeals?\b|\btickets?\b|\bquotes?\b|\binvoices?\b|\bcampaigns?\b|payment link/i);
  expect(text, 'a buying role is drawn (no field carries one)').not.toMatch(/decision maker|\bchampion\b|\binfluencer\b|buying role/i);
  expect(text, 'a billing, RC or TIN field is drawn (no field carries one)').not.toMatch(/\bbilling\b|credit limit|payment terms|\bRC number\b|\bTIN\b/i);
  expect(text, 'a count of related records is drawn (D-P13)').not.toMatch(/\b\d+\s+(contacts?|accounts?|branches|subsidiaries|children)\b|\(\s*\d+\s*\)/i);
  expect(text, 'a WhatsApp composer is drawn').not.toMatch(/24[- ]hour|approved template/i);
  expect(text, 'the access-request flow is drawn').not.toMatch(/request access/i);
  await expect(root.locator('a[href*="/map"], [data-field="health"], [data-field="addresses"], audio, video')).toHaveCount(0);
  await expect(root.locator('[aria-hidden="true"]', { hasText: /^\s*(auto_awesome|map|monitor_heart)\s*$/ })).toHaveCount(0);
});

// ===========================================================================
// Mobile
// ===========================================================================

test('at 360px the record fits without sideways page scroll and passes axe @p05-account @p05-account-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openRecord(page, ACCOUNT_FULL.id);
  await expect(heading(page)).toContainText(ACCOUNT_FULL.name);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'the page scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoIdsAnywhere(page, 'the 360px record');
  await expectNoSeriousAxe(page, 'P05/04 at 360px');
});

// ===========================================================================
// i18n
// ===========================================================================

test('locale=en-XA renders every string as pseudo text, record data and times excepted @p05-account @p05-account-pseudo', async ({
  page,
}) => {
  await openRecord(page, ACCOUNT_FULL.id, { query: '?locale=en-XA' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await expect(item(page, ITEM_TASK.id)).toBeVisible();
  await expect(contactRow(page, contactsOf(ACCOUNT_FULL.id)[0]?.id ?? 'missing')).toBeVisible();

  const report = await page.locator('[data-shell="crm"]').evaluate((root, servedJson) => {
    const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
    const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
    const digits = (text: string) => text.replace(/\D/g, '');
    const recordish = (text: string) =>
      servedJson.includes(text) || (digits(text).length >= 7 && digits(servedJson).includes(digits(text)));
    const skipped = (element: Element | null) =>
      element === null ||
      element.closest('[aria-hidden="true"], [data-testid^="language-"], script, style, noscript, time') !== null;

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
  }, servedData());

  expect(report.english, 'strings on the record that did not come through i18n').toEqual([]);
  expect(report.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
  expect(report.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(10);
  // Codes are copy: the tier is a pseudo label, not "mid_market".
  expect(await visibleText(field(page, 'tier'))).toMatch(PSEUDO);
  expect(ACTIVITY_TYPES).toContain(String(ITEM_TASK.activityType));
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/accounts/[id] on the wire', () => {
  /**
   * WHY 245,000 BYTES, BEFORE THE SCREEN EXISTS (HISTORICAL)
   *
   * This was the FIRST pin. It has since moved: raised for the browser
   * session's required cost (D-L190), then re-pinned from measured weights
   * (D-L203, T-0145). The live figure is ACCOUNT_RECORD_BUDGET_BYTES above.
   *
   * The lead's provisional figure, the same ceiling T-0062 gave
   * /contacts/[id] on the same reasoning: the same shell, fonts and records
   * client as its measured neighbours (/contacts 216,100 B measured, T-0042),
   * plus a details panel, a timeline, an activity form and an edit sheet. The
   * account record adds a breadcrumb and a contacts grid and drops the
   * contact's inline status and claim controls. The acceptance suite requires
   * it re-pinned within 5% of the first measurement.
   */
  test('/accounts/[id] stays inside its transferred-byte budget on the production build @p05-account @p05-account-budget', async ({
    page,
  }) => {
    active = await installAccountRecordMock(page, { recordId: ACCOUNT_FULL.id });
    const metrics = await measurePageLoad(page, `${recordViewUrl()}/accounts/${ACCOUNT_FULL.id}`, 'default');

    const record = resolve(__dirname, '.artifacts', 'p05-account-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(
      record,
      `${JSON.stringify({ path: '/accounts/[id]', transferredBytes: metrics.transferredBytes, budget: ACCOUNT_RECORD_BUDGET_BYTES }, null, 2)}\n`,
      'utf8',
    );

    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webRecordViewUrl is not serving the production build').toBe(built);
    // A 404 page is small: a budget met by the not-found page measures nothing.
    await expect(screen(page)).toBeVisible();

    expect(ACCOUNT_RECORD_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P05/04 the account record', metrics.transferredBytes, ACCOUNT_RECORD_BUDGET_BYTES);
  });

  test('/accounts/[id] paints within 5 s at 256 kbps and 300 ms @p05-account @p05-account-budget', async ({ page }) => {
    active = await installAccountRecordMock(page, { recordId: ACCOUNT_FULL.id });
    const metrics = await measurePageLoad(page, `${recordViewUrl()}/accounts/${ACCOUNT_FULL.id}`, 'low-bandwidth');
    await expect(screen(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
