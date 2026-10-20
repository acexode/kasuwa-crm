import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack, type StackUrls } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  ACCOUNT_SUMMARY,
  ACTIVITY_TYPES,
  CONTACT_CLAIMABLE,
  CONTACT_FULL,
  CONTACT_HOSTILE,
  CONTACT_LOCKED,
  CONTACT_LONG,
  CONTACT_NULLS,
  CONTACT_STATUSES,
  DEFAULT_TIMELINE_MAX,
  FORMER_MEMBER,
  HOSTILE_BODY,
  HOSTILE_NAME,
  HOSTILE_SUBJECT,
  HOSTILE_TAG,
  ITEM_ACCOUNT,
  ITEM_CALL,
  ITEM_CONSENT,
  ITEM_CREATED_NAME,
  ITEM_CREATED_SOURCE,
  ITEM_DONE_TASK,
  ITEM_LANGUAGE,
  ITEM_LEGACY_CONSENT,
  ITEM_LEGACY_STATUS,
  ITEM_NOTE,
  ITEM_OWNER,
  ITEM_PHONES,
  ITEM_STATUS,
  ITEM_TAGS,
  ITEM_TASK,
  ITEM_WHATSAPP,
  LONG_OLDEST_SUBJECT,
  LONG_TIMELINE_LENGTH,
  ME,
  NEW_ACTIVITY_IDS,
  NO_SUCH_ID,
  OTHER_OWNER,
  OUT_OF_SCOPE_ID,
  PROGRAMME_ONE,
  PROGRAMME_TWO,
  installContactRecordMock,
  isCreateActivity,
  isTimeline,
  isUpdateActivity,
  isUpdateContact,
  servedData,
  timelineOf,
  type ContactRecordMock,
  type ContactRecordMockOptions,
  type ContactRow,
  type TimelineItem,
} from './support/contact-record-mock';

/**
 * T-0062 — the P05 contact record, the 360° view (frames 01, 02, 05, 06),
 * behind `crm_record_view`, in the CRM shell T-0042 built. Written by the
 * lead's QA agent BEFORE the screen exists;
 * `tests/acceptance/records-ui/contact-record.acceptance.test.ts` runs this
 * file with `--grep @p05-contact` and reads every outcome by tag.
 * Decisions: D-L64, D-L69, D-L72, D-L73, D-L81, D-L84, D-P1, D-P14, D-P18,
 * D-P21, D-P23.
 *
 * TAG RULE (D-L84). `@p05-contact` is the parent tag. Playwright's --grep is a
 * regular expression, so no other screen's parent tag may start with it and it
 * starts with no other screen's (`@p04`, `@p05-account` are both clear). Every
 * sub-tag here is `@p05-contact-<name>`.
 *
 * ---------------------------------------------------------------------------
 * THE WEB PROCESS
 *
 *   webUrl            — the default server, every flag at its default.
 *                       `/contacts/<id>` must be a real 404 there.
 *   webRecordViewUrl  — NEW, published in the stack file by the builder's
 *                       change to `scripts/run-e2e.mjs`: apps/web from the SAME
 *                       production build (`next start`, NODE_ENV=test because
 *                       the flag is not production-ready, as D-L64 ruled for
 *                       `crm_records`) with `crm_record_view` in
 *                       KASUWA_FEATURE_FLAGS_ON. Every journey and the byte
 *                       budget run here; the budget checks the served build id.
 *                       BUILDER'S CHOICE: a new process, or an existing one
 *                       carrying the extra flag (and webRecordViewUrl naming
 *                       the same URL, as webLiveUrl names webSelfServeUrl).
 *                       Whatever process serves it, every same-origin link on
 *                       the page must resolve there (`@p05-contact-shell`), so
 *                       the CRM nav's `/contacts` needs `crm_records` on it too.
 *
 *   tests/e2e/tenancy.spec.ts (`@harness`, not this file) drives
 *   `/contacts/<id>` on webRecordsUrl against the REAL API and waits for
 *   `[data-testid="record"]`, `record-not-found` or `record-unavailable`. That
 *   test must keep passing: either webRecordsUrl keeps `crm_record_view` off
 *   and the route keeps today's behaviour there, or the P05 root also carries
 *   `data-testid="record"`. The not-found and unavailable hooks below are the
 *   scaffolding's own, on purpose.
 *
 * THE RECORD IS READ FROM THE BROWSER, AND MOCKED THERE
 *
 * Every journey installs `support/contact-record-mock.ts`, which serves
 * getContact, updateContact, listContactTimeline, createActivity,
 * updateActivity, listMyProgrammes and getCurrentUser from the contracts.
 * `afterEach` fails a test in which the screen sent the API anything the
 * contract does not declare (see the mock's header) or left the origin. A
 * server-component read could not show the loading or offline frames and could
 * not be mocked, so the reads are the browser's, as on `/contacts`.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                      the CRM shell (T-0042)
 *   [data-screen="P05/01"]                  the record screen root, carrying
 *     data-record-state="loading|ready"
 *   h1                                      the contact's displayName
 *   [data-testid="record-skeleton"]         P05/06 loading placeholders
 *   [data-testid="record-not-found"]        the GENERIC not-found (D-L69)
 *   [data-testid="record-unavailable"]      a failed read, never "not found"
 *   [data-testid="record-details"]          the details panel, containing
 *     [data-field="<Contact property>"]     one field; the owner is `owner` OR
 *                                           `ownerUserId`
 *       data-locked="true"                  when the field is WITHHELD
 *   [data-testid="account-summary"]         the related account (a link only
 *     data-locked="true"                    if it resolves); locked if withheld
 *   [data-testid="timeline"]                the timeline, containing
 *     [data-timeline-item="<item id>"]      one item, in served order, carrying
 *       data-item-type="<item type>"
 *       data-activity-id="<activity id>"    on activity items
 *       data-completed="true|false"         on task items
 *       [data-actor]                        who acted ("System" for null)
 *       [data-change="before"|"after"]      ONLY where the API gave values
 *       <time datetime="<ISO>">             every date or time drawn
 *       [data-action="complete-task"]       on an open task the screen can
 *                                           complete (see CONTRACT GAP)
 *   [data-testid="timeline-load-older"]     keyset "load older"
 *   [data-testid="timeline-empty"]          no history yet
 *   [data-testid="timeline-error"]          the timeline read failed
 *   [data-action="edit-status"] + [data-status-option="<code>"]
 *     or select[data-field-input="status"]  the inline status edit
 *   [data-action="assign-to-me"]            owner to self (D-P14)
 *   [data-action="edit-contact"]            opens
 *   [data-testid="contact-sheet"]           the full edit, role=dialog, with
 *     [data-field-input="<UpdateContactRequest property>"],
 *     [data-action="save-contact"], [role="alert"] for a refusal
 *   [data-action="log-activity"][data-activity-type="note|task|call"]
 *                                           (a bare [data-action="log-activity"]
 *                                           may reveal the three) opens
 *   [data-testid="activity-form"]           with [data-field-input="subject"],
 *     [data-field-input="body"], [data-field-input="dueAt"] (an
 *     input[type="datetime-local"], tasks only), [data-action="save-activity"],
 *     [role="alert"] for a refusal
 *   [data-requires-connection]              on every write control
 *   [data-testid="offline-banner"]          with the last-synced time
 *   [data-record-text]                      record data, not UI copy (en-XA)
 *
 * PINNED INTERFACES BEYOND THE HOOKS
 *
 *   - The first timeline page holds at least DEFAULT_TIMELINE_MAX (20) items:
 *     send no `limit`, or one of 20 or more. The default journeys expect every
 *     item of CONTACT_FULL's timeline on the first page.
 *   - Times are shown in the BROWSER's zone (the contract: "display
 *     conversion is the browser's"). This file runs in Africa/Lagos.
 *   - A write sends `version` plus ONLY what the user changed. Field security
 *     has a read-only level the wire cannot show; a readable read-only field
 *     sent unchanged is `403 field_not_editable` (the contract), so a form that
 *     round-trips every field fails here exactly as it would live.
 *   - The document title does not carry the contact's name (a person's name
 *     is PII, D-L63; titles land in browser history on shared BPO desks).
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS
 *
 *   - P05/06 "access denied" (record id, programme owner, Request access) is
 *     NOT drawn: an out-of-scope record is the generic not-found (D-L69).
 *   - Hidden until their modules exist (D-L69): the WhatsApp composer and its
 *     24-hour window, the AI summary and next-best action, recording playback,
 *     NIN last-4, addresses and Follow. Payments, invoices, tickets and
 *     messages are not timeline item types (D-L72).
 *   - Write controls are shown to every caller (D-L84: no capability read).
 *     The API's 403 is the gate, shown as a translated role=alert.
 *   - Offline (D-P21): the record stays in memory only; every write control is
 *     disabled. P05/05's queued edits are not built.
 *   - Ids are not names: the owner, the actors and the account come with
 *     names; programme names come from listMyProgrammes. No UUID is printed.
 *
 * CONTRACT GAP — completing a task the screen only saw on the timeline.
 * `updateActivity` requires `version`, and nothing serves it: `ActivityItem`
 * carries no `version` and there is no getActivity. So the screen can only
 * complete a task whose version it was served (one it logged in this session,
 * from the 201). The journey for the rest is a `fixme`
 * (`@p05-contact-complete-served`), not required; the mock records any
 * invented version as a violation.
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P05/01"]';

/**
 * The /contacts/[id] transferred-byte budget. The acceptance suite holds it at
 * or under 245,000 bytes and within 5% of what this run measures, so re-pin it
 * to the measurement once the screen exists. Why 245,000: see the budget test.
 */
const CONTACT_RECORD_BUDGET_BYTES = 278_500;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const RENAMED = 'Adaeze Okonkwo-Bello';

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

// Kasuwa's users are in WAT/EAT/SAST; every time on this screen is converted in the browser.
test.use({ timezoneId: 'Africa/Lagos' });

let active: ContactRecordMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
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
  const urls = stack() as StackUrls & { webRecordViewUrl?: string };
  if (typeof urls.webRecordViewUrl !== 'string' || urls.webRecordViewUrl === '') {
    throw new Error(
      'the stack file has no webRecordViewUrl: scripts/run-e2e.mjs starts no web process with ' +
        'crm_record_view on (see the header of p05-contact.spec.ts)',
    );
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

function accountSummary(page: Page): Locator {
  return shown(screen(page).getByTestId('account-summary')).first();
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
  options: ContactRecordMockOptions & { query?: string; state?: 'loading' | 'ready' } = {},
): Promise<ContactRecordMock> {
  const mock = await installContactRecordMock(page, options);
  active = mock;
  const response = await page.goto(`${recordViewUrl()}/contacts/${id}${options.query ?? ''}`);
  expect(response?.status(), '/contacts/<id> with crm_record_view on').toBe(200);
  await expect(screen(page)).toBeVisible();
  await expect(screen(page)).toHaveAttribute('data-record-state', options.state ?? 'ready');
  return mock;
}

function json(body: unknown): Record<string, unknown> {
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the write body is not an object').toBe(true);
  return body as Record<string, unknown>;
}

function keysOf(body: Record<string, unknown>): string[] {
  return Object.keys(body).sort();
}

/** The status codes the inline edit offers, with what it says for each. */
async function statusOptions(page: Page): Promise<{ code: string; label: string }[]> {
  const select = shown(screen(page).locator('select[data-field-input="status"]'));
  if ((await select.count()) > 0) {
    return select.first().evaluate((element) =>
      Array.from((element as HTMLSelectElement).options)
        .filter((option) => option.value !== '')
        .map((option) => ({ code: option.value, label: (option.textContent ?? '').trim() })),
    );
  }
  const options = shown(page.locator('[data-status-option]'));
  if ((await options.count()) === 0) {
    await shown(screen(page).locator('[data-action="edit-status"]')).first().click();
  }
  await expect(options.first(), 'the status edit offers no [data-status-option]').toBeVisible();
  return options.evaluateAll((elements) =>
    elements.map((element) => {
      const copy = element.cloneNode(true) as Element;
      copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
      return { code: element.getAttribute('data-status-option') ?? '', label: (copy.textContent ?? '').replace(/\s+/g, ' ').trim() };
    }),
  );
}

async function chooseStatus(page: Page, code: string): Promise<void> {
  const select = shown(screen(page).locator('select[data-field-input="status"]'));
  if ((await select.count()) > 0) {
    await select.first().selectOption(code);
    return;
  }
  const option = () => shown(page.locator(`[data-status-option="${code}"]`));
  if ((await option().count()) === 0) {
    await shown(screen(page).locator('[data-action="edit-status"]')).first().click();
  }
  await option().first().click();
}

/** Every visible status edit control: the menu button or the select. */
function statusControls(page: Page): Locator {
  return shown(screen(page).locator('[data-action="edit-status"], select[data-field-input="status"]'));
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
  return page.getByTestId('contact-sheet');
}

async function openEdit(page: Page): Promise<Locator> {
  await shown(screen(page).locator('[data-action="edit-contact"]')).first().click();
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

/** Everything of a contact and its timeline that could land on the device. */
function needles(rows: readonly ContactRow[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    // Not the contact id: it is in the address bar because the user put it there.
    out.add(row.displayName);
    for (const value of [row.givenNames, row.familyName]) {
      if (typeof value === 'string') out.add(value);
    }
    for (const phone of (Array.isArray(row.phones) ? row.phones : []) as { e164: string }[]) out.add(phone.e164);
    for (const email of (Array.isArray(row.emails) ? row.emails : []) as string[]) out.add(email);
    const account = row.account as { name?: string } | null | undefined;
    if (typeof account?.name === 'string') out.add(account.name);
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

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract refuses, and records it as the screen’s fault @p05-contact @p05-contact-mock', async ({
  page,
}) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (sign-in on the default server) and
  // watch every malformed request land in `violations`.
  const { webUrl } = stack();
  const mock = await installContactRecordMock(page);
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
  const contact = (id: string) => `/api/v1/contacts/${id}`;
  const timeline = (id: string, query = '') => `/api/v1/contacts/${id}/timeline${query}`;

  // Served as the contract says.
  const full = await call(contact(CONTACT_FULL.id));
  expect(full.status).toBe(200);
  expect((full.body.account as { name?: string }).name).toBe(ACCOUNT_SUMMARY.name);
  const locked = await call(contact(CONTACT_LOCKED.id));
  expect('phones' in locked.body || 'account' in locked.body, 'a withheld field was sent').toBe(false);
  const outside = await call(contact(OUT_OF_SCOPE_ID));
  const missing = await call(contact(NO_SUCH_ID));
  expect(outside.status).toBe(404);
  expect(JSON.stringify(outside.body), 'out of scope and missing answer differently').toBe(JSON.stringify(missing.body));
  expect((await call(contact('not-a-uuid'))).status).toBe(400);

  const page1 = await call(timeline(CONTACT_FULL.id));
  expect((page1.body.data as TimelineItem[]).map((entry) => entry.id)).toEqual(timelineOf(CONTACT_FULL.id).map((entry) => entry.id));
  expect(page1.body.nextCursor).toBeNull();
  const long1 = await call(timeline(CONTACT_LONG.id));
  const longCursor = String(long1.body.nextCursor);
  expect((long1.body.data as TimelineItem[]).length, 'a page short of its limit').toBe(25);
  const long2 = await call(timeline(CONTACT_LONG.id, `?cursor=${encodeURIComponent(longCursor)}`));
  expect((long2.body.data as TimelineItem[])[0]?.id).toBe(timelineOf(CONTACT_LONG.id)[25]?.id);
  expect(mock.violations, 'a well-formed request was recorded as a violation').toEqual([]);

  // Refused, and blamed on the screen.
  await expectViolation(timeline(CONTACT_FULL.id, '?limit=0'), 'GET', undefined, 400, /outside 1\.\.100/);
  await expectViolation(timeline(CONTACT_FULL.id, '?sort=-occurredAt'), 'GET', undefined, 400, /no "sort"/);
  await expectViolation(timeline(CONTACT_FULL.id, '?cursor=forged'), 'GET', undefined, 400, /never served/);
  await expectViolation(timeline(CONTACT_FULL.id, `?cursor=${encodeURIComponent(longCursor)}`), 'GET', undefined, 400, /another contact/);
  await expectViolation(contact(CONTACT_FULL.id), 'GET', undefined, 200, /scope is never supplied/, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id });
  await expectViolation('/api/v1/contacts', 'GET', undefined, 404, /not an operation the contact record uses/);
  await expectViolation(`/api/v1/accounts/${ACCOUNT_SUMMARY.id}`, 'GET', undefined, 404, /not an operation/);
  await expectViolation(contact(CONTACT_FULL.id), 'PATCH', { version: CONTACT_FULL.version, programmeId: PROGRAMME_TWO.id }, 403, /closed body/);
  await expectViolation(contact(CONTACT_FULL.id), 'PATCH', { version: CONTACT_FULL.version }, 400, /fewer than 2/);
  await expectViolation(contact(CONTACT_CLAIMABLE.id), 'PATCH', { version: 99, status: 'qualified' }, 404, /never served/);
  await call(contact(CONTACT_CLAIMABLE.id));
  await expectViolation(contact(CONTACT_CLAIMABLE.id), 'PATCH', { version: 99, status: 'qualified' }, 409, /version 99/);
  await expectViolation(contact(CONTACT_LOCKED.id), 'PATCH', { version: CONTACT_LOCKED.version, phones: [] }, 403, /withholds/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: 'x', contactId: CONTACT_FULL.id, id: NEW_ACTIVITY_IDS[0] }, 400, /closed body/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: 'x', contactId: CONTACT_FULL.id, dueAt: '2026-10-09T14:00:00.000Z' }, 400, /task_only/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', subject: '', body: 'x', contactId: CONTACT_FULL.id }, 400, /too short/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'task', subject: 'x', contactId: CONTACT_FULL.id, dueAt: '2026-10-09T15:00' }, 400, /UTC date-time/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: 'x', accountId: ACCOUNT_SUMMARY.id }, 400, /names no contactId/);
  await expectViolation('/api/v1/activities', 'POST', { type: 'note', body: 'x', contactId: OUT_OF_SCOPE_ID }, 404, /never served/);
  // The contract gap: a task seen on the timeline only has no version to send.
  await expectViolation(`/api/v1/activities/${String(ITEM_TASK.activityId)}`, 'PATCH', { version: 1, completed: true }, 200, /never served \(a timeline item carries none\)/);
  expect(mock.violations.length, 'the refusals above were not all recorded, or one was recorded twice').toBe(19);
  const recorded = mock.violations.length;

  // And well-formed writes are applied, or refused for the caller's permission set, which is not the screen's fault.
  const note = await call('/api/v1/activities', 'POST', { type: 'note', body: 'Called back.', contactId: CONTACT_FULL.id });
  expect(note.status).toBe(201);
  expect(note.body.id).toBe(NEW_ACTIVITY_IDS[0]);
  const task = await call('/api/v1/activities', 'POST', { type: 'task', subject: 'Call on Friday', dueAt: '2026-10-09T14:00:00.000Z', contactId: CONTACT_FULL.id });
  expect(task.status).toBe(201);
  const done = await call(`/api/v1/activities/${String(task.body.id)}`, 'PATCH', { version: 1, completed: true });
  expect(done.status).toBe(200);
  expect(done.body.version).toBe(2);
  expect(typeof done.body.completedAt).toBe('string');
  const served = await call(contact(CONTACT_CLAIMABLE.id));
  const claimed = await call(contact(CONTACT_CLAIMABLE.id), 'PATCH', { version: served.body.version, ownerUserId: ME.id });
  expect(claimed.status).toBe(200);
  expect((claimed.body.owner as { displayName?: string }).displayName).toBe(ME.displayName);
  const renamed = await call(contact(CONTACT_CLAIMABLE.id), 'PATCH', { version: claimed.body.version, displayName: 'X' });
  expect(renamed.status, 'the claimer set renamed a contact').toBe(403);
  const both = await call(contact(CONTACT_CLAIMABLE.id), 'PATCH', { version: claimed.body.version, status: 'qualified', tags: ['x'] });
  expect(both.status, 'a claim body carrying another field was partly applied').toBe(403);
  const afterWrites = await call(timeline(CONTACT_FULL.id));
  expect((afterWrites.body.data as TimelineItem[])[0]?.id, 'a logged activity is not newest on the timeline').toBe('ti_new02');
  expect((afterWrites.body.data as TimelineItem[])[0]?.completedAt, 'completing did not change the item in place').toBe(done.body.completedAt);
  expect(mock.violations.length, 'a well-formed write was recorded as a violation').toBe(recorded);
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_record_view gates /contacts/[id]', () => {
  // The two flag-off tests PASS BEFORE THE WORK STARTS: on the default server
  // `/contacts/<id>` is already a 404 (it sits behind crm_records). A negative
  // invariant, legitimately vacuous until the screen exists; the flag-on test
  // is what gives the pair meaning, and it fails until then.
  test('/contacts/<id> is a real 404 with every flag at its default, and nothing reaches the records API @p05-contact @p05-contact-flag-off', async ({
    page,
  }) => {
    const { webUrl } = stack();
    const mock = await installContactRecordMock(page);
    const response = await page.goto(`${webUrl}/contacts/${CONTACT_FULL.id}`);
    expect(response?.status(), '/contacts/<id> is reachable with crm_record_view off').toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    expect(mock.requests, 'a flag-off page still read the record').toEqual([]);
  });

  test('/contacts/<id> cannot be switched on by anything the browser sends @p05-contact @p05-contact-flag-off', async ({
    browser,
  }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-kasuwa-feature-flags': 'crm_record_view,crm_records',
        'x-crm-record-view': '1',
        'x-kasuwa-tenant-id': TENANT_A,
      },
    });
    await context.addCookies([
      { name: 'crm_record_view', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_record_view,crm_records', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of [
      `/contacts/${CONTACT_FULL.id}?crm_record_view=on&flags=crm_record_view`,
      `/contacts/${CONTACT_FULL.id}/`,
      `/contacts/${CONTACT_FULL.id}?locale=en-XA`,
    ]) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/contacts/<id> renders the record with crm_record_view on @p05-contact @p05-contact-flag-on', async ({ page }) => {
    await openRecord(page, CONTACT_FULL.id);
    await expect(heading(page)).toContainText(CONTACT_FULL.displayName);
  });
});

// ===========================================================================
// The shell
// ===========================================================================

test('the record sits in the CRM shell, and no link on it is a 404 @p05-contact @p05-contact-shell', async ({ page }) => {
  await openRecord(page, CONTACT_FULL.id);
  const shell = page.locator('[data-shell="crm"]');
  await expect(shell).toBeVisible();
  await expect(shell.locator(SCREEN)).toBeVisible();
  await expect(page.getByTestId('settings-menu')).toHaveCount(0);

  // Every same-origin link, nav and record alike. An account link to a record
  // page nobody has built yet (T-0063), or that this process does not serve,
  // is a broken link: no link is better.
  const hrefs = await page
    .locator('a[href^="/"]')
    .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute('href') ?? ''))]);
  expect(hrefs.length, 'the page links nowhere — not even the CRM nav').toBeGreaterThan(0);
  for (const href of hrefs) {
    const response = await page.request.get(`${recordViewUrl()}${href}`);
    expect(response.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }
});

// ===========================================================================
// P05/01 — the details panel, driven by field security
// ===========================================================================

test.describe('P05/01 — details, field security and the account', () => {
  test('draws the contact’s fields as values and labels, never codes or ids, and passes axe @p05-contact @p05-contact-details', async ({
    page,
  }) => {
    await openRecord(page, CONTACT_FULL.id);
    await expect(heading(page)).toContainText(CONTACT_FULL.displayName);

    await expect(field(page, 'givenNames')).toContainText(String(CONTACT_FULL.givenNames));
    await expect(field(page, 'familyName')).toContainText(String(CONTACT_FULL.familyName));
    expect((await visibleText(field(page, 'phones'))).replace(/\D/g, ''), 'the phone is not drawn').toContain('8030000001');
    await expect(field(page, 'emails')).toContainText('adaeze.okonkwo@example.ng');
    await expect(field(page, 'tags')).toContainText('Callback set');
    await expect(field(page, 'state')).toContainText('Lagos');
    await expect(field(page, 'lga')).toContainText('Ikeja');
    await expect(ownerField(page)).toContainText(ME.displayName);
    expect(await visibleText(field(page, 'preferredLanguage')), 'the language is not drawn').not.toBe('');

    // Codes on the wire, labels on screen.
    await expectSaysOneOf(field(page, 'status'), labelsEndingWith('.status.contacted'), 'status contacted');
    await expectSaysOneOf(field(page, 'source'), labelsEndingWith('.source.whatsapp'), 'source whatsapp');
    await expectSaysOneOf(field(page, 'preferredChannel'), labelsEndingWith('.channel.whatsapp'), 'channel whatsapp');
    await expectSaysOneOf(field(page, 'consentState'), labelsEndingWith('.consent.opted_in'), 'consent opted_in');
    const optIn = await visibleText(field(page, 'whatsappOptIn'));
    expect(optIn, 'WhatsApp opt-in is empty').not.toBe('');
    expect(optIn, 'a boolean was drawn as a word of code').not.toMatch(/\b(true|false)\b/);

    const details = await visibleText(shown(screen(page).getByTestId('record-details')).first());
    // Case-sensitive on purpose: the labels are capitalised, the codes are not.
    expect(details, 'a code was drawn instead of its label').not.toMatch(/opted_in|\bcontacted\b|\bwhatsapp\b|\bnull\b|\bundefined\b/);

    // A person's name in the title lands in browser history on a shared desk.
    expect(await page.title(), 'the contact’s name is in the document title').not.toContain(CONTACT_FULL.displayName);
    expect(await page.title()).not.toContain(String(CONTACT_FULL.familyName));

    await expectNoIdsAnywhere(page, 'the record');
    await expectNoSeriousAxe(page, 'P05/01');
  });

  test('record data with markup in it is drawn as text, never parsed @p05-contact @p05-contact-details', async ({ page }) => {
    await openRecord(page, CONTACT_HOSTILE.id);
    await expect(heading(page)).toContainText('<b>Adé</b>');
    await expect(field(page, 'tags')).toContainText(HOSTILE_TAG);
    const note = item(page, timelineOf(CONTACT_HOSTILE.id)[0]?.id ?? 'missing');
    await expect(note).toContainText('<b>Friday</b>');
    await expect(note).toContainText('Promise to pay');
    const parsed = '[onerror], script, b:text-is("Adé"), i:text-is("VIP"), b:text-is("Friday")';
    await expect(screen(page).locator(parsed)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss)).toBeUndefined();
    expect(HOSTILE_NAME + HOSTILE_SUBJECT + HOSTILE_BODY).toContain('onerror');
  });

  test('a withheld field keeps its place with a lock, never blank, and is not editable @p05-contact @p05-contact-locked', async ({
    page,
  }) => {
    await openRecord(page, CONTACT_LOCKED.id);
    for (const name of ['phones', 'emails', 'status', 'consentState']) {
      expect(CONTACT_LOCKED.withheldFields).toContain(name);
      const locked = field(page, name);
      await expect(locked, `the withheld ${name} is not drawn at all`).toBeVisible();
      await expect(locked).toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(locked)).toHaveCount(1);
      const said = await visibleText(locked);
      expect(said, `${name} is withheld and drawn as empty`).not.toBe('');
      expect(said, `${name} is withheld and drawn as a missing value`).not.toMatch(/^(null|undefined|—|-|–|0)$/i);
    }
    await expect(ownerField(page)).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(ownerField(page))).toHaveCount(1);
    // What the caller can read in the same programme is not locked.
    for (const [name, value] of [['tags', 'Water arrears'], ['state', 'Lagos'], ['lga', 'Surulere']] as const) {
      await expect(field(page, name)).toContainText(value);
      await expect(field(page, name)).not.toHaveAttribute('data-locked', 'true');
    }
    // A caller cannot edit what they cannot read: no status edit, no claim.
    await expectNoUsable(statusControls(page), 'a status edit on a withheld status');
    await expectNoUsable(shown(screen(page).locator('[data-action="assign-to-me"]')), 'assign-to-me on a withheld owner');

    // An activity whose subject and body are withheld still says what it was and who logged it.
    const call = item(page, 'ti_p2Wc8dLeH1');
    await expect(call).toBeVisible();
    await expectSaysOneOf(call, activityTypeLabels('call'), 'the call item');
    await expect(call.locator('[data-actor]').first()).toContainText(OTHER_OWNER.displayName);
    expect(await visibleText(call)).not.toMatch(/\bnull\b|\bundefined\b/);
    await expectNoIdsAnywhere(page, 'the locked record');
  });

  test('a null field says "not set", never a lock @p05-contact @p05-contact-locked', async ({ page }) => {
    await openRecord(page, CONTACT_NULLS.id);
    for (const name of ['givenNames', 'familyName', 'phones', 'emails', 'status', 'source', 'tags', 'preferredLanguage', 'preferredChannel', 'state', 'lga']) {
      const target = field(page, name);
      await expect(target, `the empty ${name} is not drawn`).toBeVisible();
      await expect(target).not.toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(target)).toHaveCount(0);
      expect(await visibleText(target), `${name}: a null is drawn as code`).not.toMatch(/\bnull\b|\bundefined\b|\[\]/);
    }
    await expect(ownerField(page)).not.toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(ownerField(page))).toHaveCount(0);
  });

  test('the account summary names the account, links only where a link resolves, and locks with accountId @p05-contact @p05-contact-account', async ({
    page,
  }) => {
    const full = await openRecord(page, CONTACT_FULL.id);
    const summary = accountSummary(page);
    await expect(summary).toContainText(ACCOUNT_SUMMARY.name);
    await expect(summary).not.toHaveAttribute('data-locked', 'true');
    const links = summary.locator('a');
    if ((await links.count()) > 0) {
      await expect(links.first(), 'the account link names another record').toHaveAttribute('href', `/accounts/${ACCOUNT_SUMMARY.id}`);
      const response = await page.request.get(`${recordViewUrl()}/accounts/${ACCOUNT_SUMMARY.id}`);
      expect(response.status(), 'the account summary links to a page that is a 404 (T-0063 builds it)').not.toBe(404);
    }
    expect(full.violations).toEqual([]);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const nulls = await openRecord(page, CONTACT_NULLS.id);
    const none = accountSummary(page);
    await expect(none, 'a contact with no account draws no account summary at all').toBeVisible();
    await expect(none).not.toHaveAttribute('data-locked', 'true');
    expect(await visibleText(none), 'no account is drawn as nothing').not.toBe('');
    expect(await visibleText(none)).not.toMatch(/\bnull\b|\bundefined\b/);
    await expect(none.locator('a')).toHaveCount(0);
    expect(nulls.violations).toEqual([]);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await openRecord(page, CONTACT_LOCKED.id);
    const locked = accountSummary(page);
    await expect(locked).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(locked)).toHaveCount(1);
    expect(await visibleText(locked)).not.toBe('');
    await expect(locked.locator('a')).toHaveCount(0);
    expect(await visibleText(screen(page))).not.toContain(ACCOUNT_SUMMARY.name);
  });
});

// ===========================================================================
// P05/01 — the timeline
// ===========================================================================

test.describe('P05/01 — the timeline', () => {
  test('draws every item once, in served order, with its actor, its time, and values only where the API gave them @p05-contact @p05-contact-timeline', async ({
    page,
  }) => {
    const mock = await openRecord(page, CONTACT_FULL.id);
    const served = timelineOf(CONTACT_FULL.id);
    await expect(item(page, served[0]?.id ?? 'missing')).toBeVisible();
    const first = mock.timelineReads[0];
    expect(first, 'the screen never read the timeline').toBeDefined();
    const limit = first?.searchParams.get('limit');
    if (limit !== null && limit !== undefined) {
      expect(Number(limit), 'the first timeline page is too small for the journeys').toBeGreaterThanOrEqual(DEFAULT_TIMELINE_MAX);
    }
    expect(await renderedItemIds(page), 'the timeline is not the served items, once each, newest first').toEqual(served.map((entry) => entry.id));

    for (const entry of served) {
      const row = item(page, entry.id);
      await expect(row).toHaveAttribute('data-item-type', entry.type);
      // Every time is a <time> carrying the instant it shows; one of them is when it happened.
      const instants = await row
        .locator('time[datetime]')
        .evaluateAll((times) => times.map((time) => Date.parse(time.getAttribute('datetime') ?? '')));
      expect(instants, `${entry.id} draws no <time datetime> for when it happened`).toContain(Date.parse(entry.occurredAt));
      // Values appear exactly where the API sent them.
      const hasValues = 'before' in entry || 'after' in entry;
      await expect(row.locator('[data-change="before"]'), `${entry.id}: a before value was invented or dropped`).toHaveCount(hasValues ? 1 : 0);
      await expect(row.locator('[data-change="after"]'), `${entry.id}: an after value was invented or dropped`).toHaveCount(hasValues ? 1 : 0);
      if (entry.type === 'field_changed') {
        await expectSaysOneOf(row, fieldLabels(String(entry.field)), `the ${String(entry.field)} item`);
      }
      // Actors by name; the system as one label.
      const actor = row.locator('[data-actor]').first();
      await expect(actor, `${entry.id} names no actor`).toBeVisible();
      if (entry.actor !== null) {
        await expect(actor).toContainText(entry.actor.displayName);
      }
    }

    // null is the system: one label, the same everywhere, never a person.
    const systemItems = served.filter((entry) => entry.actor === null);
    expect(systemItems.length).toBeGreaterThan(1);
    const systemLabels = new Set<string>();
    for (const entry of systemItems) {
      systemLabels.add(await visibleText(item(page, entry.id).locator('[data-actor]').first()));
    }
    expect(systemLabels.size, 'the system is drawn more than one way').toBe(1);
    const system = [...systemLabels][0] ?? '';
    expect(system, 'the system actor is drawn as nothing').not.toBe('');
    expect(system).toMatch(/system/i);
    for (const person of [ME, OTHER_OWNER, FORMER_MEMBER]) {
      expect(system).not.toContain(person.displayName);
    }
    // Somebody who has left the programme is still named on what they did (D-L81).
    await expect(item(page, ITEM_NOTE.id).locator('[data-actor]').first()).toContainText(FORMER_MEMBER.displayName);

    // Before and after, as labels.
    await expectSaysOneOf(item(page, ITEM_STATUS.id).locator('[data-change="before"]'), labelsEndingWith('.status.new'), 'status before');
    await expectSaysOneOf(item(page, ITEM_STATUS.id).locator('[data-change="after"]'), labelsEndingWith('.status.contacted'), 'status after');
    await expectSaysOneOf(item(page, ITEM_CONSENT.id).locator('[data-change="before"]'), labelsEndingWith('.consent.unknown'), 'consent before');
    await expectSaysOneOf(item(page, ITEM_CONSENT.id).locator('[data-change="after"]'), labelsEndingWith('.consent.opted_in'), 'consent after');
    await expectSaysOneOf(item(page, ITEM_CREATED_SOURCE.id).locator('[data-change="after"]'), labelsEndingWith('.source.whatsapp'), 'source after');
    await expect(item(page, ITEM_TAGS.id).locator('[data-change="after"]')).toContainText('Callback set');
    for (const entry of [ITEM_WHATSAPP, ITEM_TAGS, ITEM_CREATED_SOURCE, ITEM_LANGUAGE]) {
      for (const side of ['before', 'after']) {
        const said = await visibleText(item(page, entry.id).locator(`[data-change="${side}"]`));
        expect(said, `${entry.id} ${side} is drawn as nothing`).not.toBe('');
        expect(said, `${entry.id} ${side} is drawn as code`).not.toMatch(/^\[\]$|\bnull\b|\bundefined\b|\btrue\b|\bfalse\b/);
      }
    }
    expect(await visibleText(item(page, ITEM_LANGUAGE.id).locator('[data-change="before"]'))).not.toBe(
      await visibleText(item(page, ITEM_LANGUAGE.id).locator('[data-change="after"]')),
    );

    // By name only: no number, no id, no past or present owner, no account name.
    // Digits only, so "+234 803 000 0001" and "0803 000 0001" are both caught; the time's digits cannot reach 8030000001.
    expect((await visibleText(item(page, ITEM_PHONES.id))).replace(/\D/g, ''), 'a redacted phone change shows the number').not.toContain('8030000001');
    expect(await visibleText(item(page, ITEM_OWNER.id)), 'an owner change names an owner').not.toContain(ME.displayName);
    expect(await visibleText(item(page, ITEM_ACCOUNT.id)), 'an account change names the account').not.toContain(ACCOUNT_SUMMARY.name);
    expect(await visibleText(item(page, ITEM_CREATED_NAME.id)), 'a name change shows the name').not.toContain(CONTACT_FULL.displayName);
    for (const entry of [ITEM_LEGACY_STATUS, ITEM_LEGACY_CONSENT]) {
      expect(await visibleText(item(page, entry.id)), `${entry.id} (no values) draws a value`).not.toMatch(/\bnull\b|\bundefined\b/);
    }

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
    expect(all, 'raw values leaked into the timeline').not.toMatch(/\bnull\b|\bundefined\b|\[object Object\]|\btrue\b|\bfalse\b|opted_in|\bti_\w+/);
    expect(all, 'a raw timestamp was printed').not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    await expect(shown(screen(page).getByTestId('timeline-load-older')), 'a single page offers "load older"').toHaveCount(0);
    await expectNoIdsAnywhere(page, 'the timeline');
  });

  test('"load older" pages by keyset, echoes the cursor exactly, keeps it out of the address bar, and shows no total @p05-contact @p05-contact-paging', async ({
    page,
  }) => {
    const mock = await installContactRecordMock(page);
    active = mock;
    const served = timelineOf(CONTACT_LONG.id);
    // Resolved before the waiter exists, so a missing stack key fails alone.
    const target = `${recordViewUrl()}/contacts/${CONTACT_LONG.id}`;
    const firstPage = page.waitForResponse((response) => isTimeline(response.request(), CONTACT_LONG.id) && !new URL(response.url()).searchParams.has('cursor'));
    const response = await page.goto(target);
    expect(response?.status()).toBe(200);
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
      const answered = page.waitForResponse((candidate) => isTimeline(candidate.request(), CONTACT_LONG.id) && new URL(candidate.url()).searchParams.has('cursor'));
      await more.click();
      const reply = await answered;
      expect(new URL(reply.url()).searchParams.get('cursor'), 'the cursor was not echoed verbatim').toBe(cursor);
      next = ((await reply.json()) as { nextCursor: string | null }).nextCursor;
      pages += 1;
      // A real cursor is a position in someone's history: never in the page URL.
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
});

// ===========================================================================
// P05/01 — inline edits, full edit, refusals (D-P14, D-P18, D-L84)
// ===========================================================================

test.describe('P05/01 — inline edits for the claim sets, full edit for writers', () => {
  test('the inline status edit sends version and status and nothing else, and shows the change @p05-contact @p05-contact-inline-status', async ({
    page,
  }) => {
    const mock = await openRecord(page, CONTACT_CLAIMABLE.id, { role: 'claimer' });
    await expectSaysOneOf(field(page, 'status'), labelsEndingWith('.status.new'), 'status new');

    const offered = await statusOptions(page);
    expect(offered.map((option) => option.code).sort(), 'the status edit does not offer exactly the contract statuses').toEqual([...CONTACT_STATUSES].sort());
    for (const option of offered) {
      const labels = labelsEndingWith(`.status.${option.code}`);
      expect(
        labels.some((label) => option.label.includes(label)),
        `the ${option.code} option says "${option.label}", not its label`,
      ).toBe(true);
    }

    const first = page.waitForRequest((request) => isUpdateContact(request, CONTACT_CLAIMABLE.id));
    await chooseStatus(page, 'qualified');
    const body = json((await first).postDataJSON());
    // D-P14: anything else in the body makes the agent's whole edit a 403.
    expect(keysOf(body), 'an inline status edit sent more than version and status').toEqual(['status', 'version']);
    expect(body.version).toBe(CONTACT_CLAIMABLE.version);
    expect(body.status).toBe('qualified');
    await expectSaysOneOf(field(page, 'status'), labelsEndingWith('.status.qualified'), 'status after the edit');

    const second = page.waitForRequest((request) => isUpdateContact(request, CONTACT_CLAIMABLE.id));
    await chooseStatus(page, 'contacted');
    const again = json((await second).postDataJSON());
    expect(again.version, 'the second edit did not send the version the first one returned').toBe(CONTACT_CLAIMABLE.version + 1);
    await expectSaysOneOf(field(page, 'status'), labelsEndingWith('.status.contacted'), 'status after the second edit');
    expect(mock.contacts.get(CONTACT_CLAIMABLE.id)?.status).toBe('contacted');
    await expectNoIdsAnywhere(page, 'after a status edit');
  });

  test('assign to me sends version and the caller’s own id, read from the session, and names the caller @p05-contact @p05-contact-assign-me', async ({
    page,
  }) => {
    const mock = await openRecord(page, CONTACT_CLAIMABLE.id, { role: 'claimer' });
    await expect(ownerField(page)).toContainText(OTHER_OWNER.displayName);
    const control = shown(screen(page).locator('[data-action="assign-to-me"]')).first();
    await expect(control).toBeEnabled();
    const sent = page.waitForRequest((request) => isUpdateContact(request, CONTACT_CLAIMABLE.id));
    await control.click();
    const body = json((await sent).postDataJSON());
    expect(keysOf(body), 'assign-to-me sent more than version and ownerUserId').toEqual(['ownerUserId', 'version']);
    expect(body.ownerUserId, 'assign-to-me sent somebody other than the caller').toBe(ME.id);
    expect(body.version).toBe(CONTACT_CLAIMABLE.version);
    await expect(ownerField(page)).toContainText(ME.displayName);
    expect(mock.contacts.get(CONTACT_CLAIMABLE.id)?.ownerUserId).toBe(ME.id);
    await expectNoIdsAnywhere(page, 'after assign-to-me');
  });

  test('the full edit sends version and only what changed, offers no withheld field, and shows the change @p05-contact @p05-contact-edit', async ({
    page,
  }) => {
    const mock = await openRecord(page, CONTACT_FULL.id, { role: 'writer' });
    const form = await openEdit(page);
    await expect(form.locator('[data-field-input="displayName"]').first()).toHaveValue(CONTACT_FULL.displayName);
    // Server-owned, or never a field edit: not offered, or not editable.
    for (const name of ['programmeId', 'source', 'dnd', 'phoneNetwork']) {
      await expectNoUsable(form.locator(`[data-field-input="${name}"]`), `the ${name} input`);
    }
    await expectNoIdsAnywhere(page, 'the edit sheet');
    await expectNoSeriousAxe(page, 'the edit sheet');

    await form.locator('[data-field-input="displayName"]').first().fill(RENAMED);
    const sent = page.waitForRequest((request) => isUpdateContact(request, CONTACT_FULL.id));
    await form.locator('[data-action="save-contact"]').first().click();
    const body = json((await sent).postDataJSON());
    // consentState, whatsappOptIn and tags are read-only for this caller: sent
    // unchanged, the API refuses the whole edit.
    expect(keysOf(body), 'the edit sent fields the user did not change').toEqual(['displayName', 'version']);
    expect(body.version).toBe(CONTACT_FULL.version);
    await expect(form).toBeHidden();
    await expect(heading(page)).toContainText(RENAMED);
    expect(mock.contacts.get(CONTACT_FULL.id)?.displayName).toBe(RENAMED);
    expect(mock.violations).toEqual([]);

    // A record whose matrix withholds fields: not offered, never sent.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const lockedMock = await openRecord(page, CONTACT_LOCKED.id, { role: 'writer' });
    const locked = await openEdit(page);
    for (const name of CONTACT_LOCKED.withheldFields) {
      await expectNoUsable(locked.locator(`[data-field-input="${name}"]`), `the withheld ${name} input`);
    }
    await locked.locator('[data-field-input="displayName"]').first().fill('Chidi Eze-Okafor');
    const second = page.waitForRequest((request) => isUpdateContact(request, CONTACT_LOCKED.id));
    await locked.locator('[data-action="save-contact"]').first().click();
    const lockedBody = json((await second).postDataJSON());
    for (const name of CONTACT_LOCKED.withheldFields) {
      expect(name in lockedBody, `the edit sent ${name}, which the caller cannot read`).toBe(false);
    }
    await expect(locked).toBeHidden();
    expect(lockedMock.writes).toHaveLength(1);
  });

  test('a refused full edit is a translated alert; the sheet and the typing are kept @p05-contact @p05-contact-refusals', async ({
    page,
  }) => {
    // en-XA proves the alert is the screen's own copy (records.error.<code>),
    // not the server's English `message`. A claimer may not rename (D-P14).
    const mock = await openRecord(page, CONTACT_FULL.id, { role: 'claimer', query: '?locale=en-XA' });
    const form = await openEdit(page);
    await form.locator('[data-field-input="displayName"]').first().fill(RENAMED);
    const answered = page.waitForResponse((response) => isUpdateContact(response.request(), CONTACT_FULL.id));
    await form.locator('[data-action="save-contact"]').first().click();
    expect((await answered).status()).toBe(403);
    const alert = shown(form.getByRole('alert')).first();
    await expect(alert).toBeVisible();
    const said = await visibleText(alert);
    expect(said, 'the refusal says nothing').not.toBe('');
    expect(said, 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect(form).toBeVisible();
    await expect(form.locator('[data-field-input="displayName"]').first()).toHaveValue(RENAMED);
    await expect(heading(page)).toContainText(CONTACT_FULL.displayName);
    expect(mock.contacts.get(CONTACT_FULL.id)?.displayName).toBe(CONTACT_FULL.displayName);
  });

  test('a refused or stale inline edit is an alert, and the old value stays on screen @p05-contact @p05-contact-refusals', async ({
    page,
  }) => {
    for (const [options, status] of [
      [{ role: 'reader' }, 403],
      [{ role: 'claimer', refuse: 'stale_write' }, 409],
    ] as const) {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      const mock = await openRecord(page, CONTACT_CLAIMABLE.id, options);
      // D-L84: no capability read, so the control is there for everyone.
      await expect(statusControls(page).first(), 'the status edit is hidden from this caller').toBeVisible();
      const answered = page.waitForResponse((response) => isUpdateContact(response.request(), CONTACT_CLAIMABLE.id));
      await chooseStatus(page, 'qualified');
      expect((await answered).status()).toBe(status);
      const alert = shown(screen(page).getByRole('alert')).first();
      await expect(alert, `no alert for a ${status}`).toBeVisible();
      expect(await visibleText(alert)).not.toBe('');
      // An optimistic edit that is never rolled back shows a status nobody saved.
      await expectSaysOneOf(field(page, 'status'), labelsEndingWith('.status.new'), `status after a ${status}`);
      expect(mock.contacts.get(CONTACT_CLAIMABLE.id)?.status).toBe('new');
      expect(mock.violations).toEqual([]);
    }
  });
});

// ===========================================================================
// P05/01 — activities (D-P18)
// ===========================================================================

test.describe('P05/01 — logging a note, a task and a call, and completing a task', () => {
  test('a note and a call are logged once, with a contract body, and appear on the timeline @p05-contact @p05-contact-log', async ({
    page,
  }) => {
    const mock = await openRecord(page, CONTACT_FULL.id, { role: 'claimer', holdWrites: true });
    const note = await openLog(page, 'note');
    // A due time is for tasks: offered on a note, it would be a 400 task_only.
    await expectNoUsable(note.locator('[data-field-input="dueAt"]'), 'a due time on a note');
    await note.locator('[data-field-input="body"]').first().fill('Promised to pay on Friday.');
    await expect(note.locator('[data-action="save-activity"]').first()).toHaveAttribute('data-requires-connection', /.*/);
    const posted = page.waitForRequest(isCreateActivity);
    const save = note.locator('[data-action="save-activity"]').first();
    await save.click();
    const body = json((await posted).postDataJSON());
    expect(body.type).toBe('note');
    expect(body.contactId, 'the note was not logged against the record on screen').toBe(CONTACT_FULL.id);
    expect(body.body).toBe('Promised to pay on Friday.');
    // An empty subject is null or absent, never "" (minLength 1).
    expect(body.subject === undefined || body.subject === null, 'an empty subject was sent as text').toBe(true);
    // In flight: a second press must not log a second note.
    await expect(save).toBeDisabled();
    mock.releaseWrites();
    const logged = activityEntry(page, NEW_ACTIVITY_IDS[0] ?? 'missing');
    await expect(logged, 'the new note is not on the timeline').toBeVisible();
    await expect(logged).toContainText('Promised to pay on Friday.');
    await expect(logged.locator('[data-actor]').first()).toContainText(ME.displayName);
    expect(mock.writes.filter((write) => write.method === 'POST'), 'the note was logged more than once').toHaveLength(1);

    const call = await openLog(page, 'call');
    await expectNoUsable(call.locator('[data-field-input="dueAt"]'), 'a due time on a call');
    await call.locator('[data-field-input="subject"]').first().fill('Called about the arrears');
    const second = page.waitForRequest(isCreateActivity);
    await call.locator('[data-action="save-activity"]').first().click();
    const callBody = json((await second).postDataJSON());
    expect(callBody.type).toBe('call');
    expect(callBody.contactId).toBe(CONTACT_FULL.id);
    await expect(activityEntry(page, NEW_ACTIVITY_IDS[1] ?? 'missing')).toContainText('Called about the arrears');
    // Newest first, whether the screen re-reads the timeline or inserts what it logged.
    const newest = await shown(screen(page).locator('[data-timeline-item]')).evaluateAll((items) =>
      items.slice(0, 2).map((element) => element.getAttribute('data-activity-id') ?? ''),
    );
    expect(newest, 'what was just logged is not at the top of the timeline, newest first').toEqual([
      NEW_ACTIVITY_IDS[1],
      NEW_ACTIVITY_IDS[0],
    ]);
    expect(await renderedItemIds(page), 'logging dropped or repeated an item').toHaveLength(timelineOf(CONTACT_FULL.id).length + 2);
    await expectNoIdsAnywhere(page, 'after logging');
  });

  test('a task carries its due time in UTC from the browser’s zone, and completing it sends the served version @p05-contact @p05-contact-log @p05-contact-complete', async ({
    page,
  }) => {
    const mock = await openRecord(page, CONTACT_FULL.id, { role: 'claimer' });
    const task = await openLog(page, 'task');
    await task.locator('[data-field-input="subject"]').first().fill('Call back on Friday');
    const due = task.locator('[data-field-input="dueAt"]').first();
    await expect(due).toHaveAttribute('type', 'datetime-local');
    // 15:00 on a Lagos desk is 14:00 UTC.
    await due.fill('2026-10-09T15:00');
    const posted = page.waitForRequest(isCreateActivity);
    await task.locator('[data-action="save-activity"]').first().click();
    const body = json((await posted).postDataJSON());
    expect(body.type).toBe('task');
    expect(String(body.dueAt), 'the due time is not UTC with a Z').toMatch(/Z$/);
    expect(Date.parse(String(body.dueAt)), 'the due time was not converted from the browser’s zone').toBe(Date.parse('2026-10-09T14:00:00.000Z'));

    const logged = activityEntry(page, NEW_ACTIVITY_IDS[0] ?? 'missing');
    await expect(logged).toBeVisible();
    await expect(logged).toHaveAttribute('data-completed', 'false');
    const complete = logged.locator('[data-action="complete-task"]').first();
    await expect(complete).toBeEnabled();
    const patched = page.waitForRequest((request) => isUpdateActivity(request, NEW_ACTIVITY_IDS[0]));
    await complete.click();
    const update = json((await patched).postDataJSON());
    expect(keysOf(update), 'completing sent more than version and completed').toEqual(['completed', 'version']);
    expect(update.version, 'completing did not send the version the create returned').toBe(1);
    expect(update.completed).toBe(true);
    await expect(logged).toHaveAttribute('data-completed', 'true');
    await expectNoUsable(logged.locator('[data-action="complete-task"]'), 'complete on the task just completed');
    expect(mock.writes.filter((write) => write.method === 'PATCH')).toHaveLength(1);
    // Completing changes the item in place; it adds none.
    expect(await renderedItemIds(page)).toHaveLength(timelineOf(CONTACT_FULL.id).length + 1);
  });

  test('a refused activity is a translated alert; the form and the typing are kept, and nothing is added @p05-contact @p05-contact-activity-refusals', async ({
    page,
  }) => {
    // qa_analyst may not log activities (D-P18); D-L84 still shows the control.
    const mock = await openRecord(page, CONTACT_FULL.id, { role: 'reader', query: '?locale=en-XA' });
    const before = await renderedItemIds(page);
    const note = await openLog(page, 'note');
    await note.locator('[data-field-input="body"]').first().fill('Customer asked for a statement.');
    const answered = page.waitForResponse((response) => isCreateActivity(response.request()));
    await note.locator('[data-action="save-activity"]').first().click();
    expect((await answered).status()).toBe(403);
    const alert = shown(note.getByRole('alert')).first();
    await expect(alert).toBeVisible();
    expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect(note).toBeVisible();
    await expect(note.locator('[data-field-input="body"]').first()).toHaveValue('Customer asked for a statement.');
    expect(await renderedItemIds(page), 'a refused note was drawn on the timeline').toEqual(before);
    expect(mock.timelines.get(CONTACT_FULL.id)).toHaveLength(timelineOf(CONTACT_FULL.id).length);
  });
});

test.fixme('a task served only on the timeline can be completed @p05-contact-complete-served', async () => {
  // BLOCKED ON THE CONTRACT. updateActivity requires `version`; ActivityItem
  // carries none and there is no getActivity, so the screen has no honest
  // version for ITEM_TASK. When the contract serves one (on the item, or a
  // read), this journey opens CONTACT_FULL as a claimer, completes ITEM_TASK
  // through [data-action="complete-task"], and asserts the PATCH carries the
  // served version and `completed: true` and nothing else.
});

// ===========================================================================
// Out of scope (D-L69)
// ===========================================================================

test('an id out of scope, missing or malformed is the generic not-found, never "access denied" @p05-contact @p05-contact-not-found', async ({
  page,
}) => {
  const mock = await installContactRecordMock(page);
  active = mock;
  const title = EN['notFound.title'] ?? '<notFound.title>';
  const explanation = EN['notFound.body'] ?? '<notFound.body>';
  const headings: string[] = [];
  for (const id of [OUT_OF_SCOPE_ID, NO_SUCH_ID, 'not-a-uuid']) {
    const response = await page.goto(`${recordViewUrl()}/contacts/${id}`);
    const status = response?.status() ?? 0;
    expect([200, 404], `/contacts/${id} answered neither 200 nor 404`).toContain(status);
    // Decided in the browser (a 200 document) it is the record's not-found
    // state; decided on the server (a 404, say for a malformed id) it may be
    // the app's own not-found page. Either way, the same generic words.
    if (status === 200) {
      await expect(shown(page.getByTestId('record-not-found')).first(), `/contacts/${id} is not the not-found state`).toBeVisible();
    }
    const h1 = shown(page.getByRole('heading', { level: 1 })).first();
    await expect(h1).toHaveText(title);
    const whole = await visibleText(page.locator('body'));
    expect(whole).toContain(explanation);
    // P05/06's access-denied frame is an existence oracle (CLAUDE.md 6.4).
    expect(whole, 'the access-denied frame was drawn').not.toMatch(/request access|access denied|programme owner|can.t open this record|belongs to/i);
    for (const programme of [PROGRAMME_ONE, PROGRAMME_TWO]) {
      expect(whole, 'a programme was named on the not-found page').not.toContain(programme.name);
    }
    await expect(lockIcon(page.locator('main, body').first())).toHaveCount(0);
    await expect(page.locator('[data-testid="record-details"], [data-timeline-item], [data-action="edit-contact"], [data-action="log-activity"]')).toHaveCount(0);
    await expect(page.getByTestId('record-unavailable')).toHaveCount(0);
    await expectNoIdsAnywhere(page, `the not-found page for ${id}`);
    headings.push(await visibleText(h1));
  }
  // Out of scope and missing are one 404 body at the API, so these can only
  // differ if the screen echoes the id; the id check above is the real test.
  expect(new Set(headings).size, 'the not-found page differs between out of scope, missing and malformed').toBe(1);
  expect(mock.writes).toEqual([]);
});

// ===========================================================================
// P05/06 — loading, and a failed read
// ===========================================================================

test.describe('P05/06 — loading, a failed read, an empty or failed timeline', () => {
  test('loading draws the skeleton, never not-found or an empty record, until the record arrives @p05-contact @p05-contact-loading', async ({
    page,
  }) => {
    const mock = await openRecord(page, CONTACT_FULL.id, { hold: true, state: 'loading' });
    try {
      expect(await shown(screen(page).getByTestId('record-skeleton')).count(), 'no skeleton').toBeGreaterThan(0);
      await expect(page.getByTestId('record-not-found')).toHaveCount(0);
      await expect(screen(page).locator('[data-timeline-item]')).toHaveCount(0);
      await expect(screen(page).getByTestId('timeline-empty')).toHaveCount(0);
      expect(await visibleText(screen(page))).not.toContain(CONTACT_FULL.displayName);
    } finally {
      mock.release();
    }
    await expect(screen(page)).toHaveAttribute('data-record-state', 'ready');
    await expect(shown(screen(page).getByTestId('record-skeleton'))).toHaveCount(0);
    await expect(heading(page)).toContainText(CONTACT_FULL.displayName);
  });

  test('a failed read says the server could not be reached, never "not found" @p05-contact @p05-contact-loading', async ({ page }) => {
    const mock = await installContactRecordMock(page, { networkFailure: true });
    active = mock;
    await page.goto(`${recordViewUrl()}/contacts/${CONTACT_FULL.id}`);
    const unavailable = shown(page.getByTestId('record-unavailable')).first();
    await expect(unavailable).toBeVisible();
    expect(await visibleText(unavailable)).not.toBe('');
    await expect(page.getByTestId('record-not-found')).toHaveCount(0);
  });

  test('a failed timeline read is an error, not "no history", and the details still show @p05-contact @p05-contact-loading', async ({
    page,
  }) => {
    const failing = await openRecord(page, CONTACT_FULL.id, { timelineFailure: true });
    await expect(heading(page)).toContainText(CONTACT_FULL.displayName);
    await expect(field(page, 'tags')).toContainText('Callback set');
    await expect(shown(screen(page).getByTestId('timeline-error')).first()).toBeVisible();
    await expect(screen(page).getByTestId('timeline-empty')).toHaveCount(0);
    await expect(screen(page).locator('[data-timeline-item]')).toHaveCount(0);
    expect(failing.violations).toEqual([]);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await openRecord(page, CONTACT_NULLS.id);
    await expect(shown(screen(page).getByTestId('timeline-empty')).first()).toBeVisible();
    await expect(screen(page).getByTestId('timeline-error')).toHaveCount(0);
  });
});

// ===========================================================================
// P05/05 — offline (D-P21, D-L64)
// ===========================================================================

test('offline keeps the record in memory only, says when it synced, and disables every write @p05-contact @p05-contact-offline', async ({
  page,
}) => {
  const mock = await openRecord(page, CONTACT_FULL.id, { role: 'claimer' });
  await expect(item(page, ITEM_TASK.id)).toBeVisible();
  const writeControls = shown(
    screen(page).locator(
      '[data-action="edit-status"], select[data-field-input="status"], [data-action="assign-to-me"], [data-action="edit-contact"], [data-action="log-activity"], [data-action="complete-task"]',
    ),
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
    await expect(heading(page)).toContainText(CONTACT_FULL.displayName);
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
    for (const needle of needles([CONTACT_FULL])) {
      expect(stored.dump.includes(needle), `"${needle}" was written to device storage`).toBe(false);
    }
  } finally {
    await page.context().setOffline(false);
  }
  await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);
  expect(mock.writes, 'a write was sent while offline').toEqual([]);
});

// ===========================================================================
// Hidden until their modules exist (D-L69)
// ===========================================================================

test('no WhatsApp composer, AI summary, recording, NIN, addresses, Follow or access request @p05-contact @p05-contact-hidden', async ({
  page,
}) => {
  await openRecord(page, CONTACT_FULL.id);
  await expect(item(page, ITEM_TASK.id)).toBeVisible();
  const root = screen(page);
  const text = await visibleText(root);
  expect(text, 'a WhatsApp composer or its 24-hour window is drawn').not.toMatch(/24[- ]hour|window (is )?(open|closed)|approved template/i);
  expect(text, 'an AI summary or next-best action is drawn').not.toMatch(/AI summary|next best action|sentiment/i);
  expect(text, 'recording playback is drawn').not.toMatch(/\brecording\b|\btranscript\b/i);
  expect(text, 'a NIN or BVN is drawn').not.toMatch(/\bNIN\b|\bBVN\b/);
  expect(text, 'addresses are drawn').not.toMatch(/\baddresses\b|\blandmark\b|\bhome address\b/i);
  expect(text, 'money, a payment or an invoice is drawn').not.toMatch(/₦|\bNGN\b|US\$|\binvoice\b|\bpayment received\b/i);
  expect(text, 'the access-request flow is drawn').not.toMatch(/request access/i);
  await expect(root.locator('audio, video, [data-field="addresses"], [data-field="nin"], [data-action="follow"]')).toHaveCount(0);
  await expect(root.getByRole('button', { name: /^\s*(un)?follow(ing)?\s*$/i })).toHaveCount(0);
  await expect(root.locator('[aria-hidden="true"]', { hasText: /^\s*auto_awesome\s*$/ })).toHaveCount(0);
});

// ===========================================================================
// Mobile
// ===========================================================================

test('at 360px the record fits without sideways page scroll and passes axe @p05-contact @p05-contact-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openRecord(page, CONTACT_FULL.id);
  await expect(heading(page)).toContainText(CONTACT_FULL.displayName);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'the page scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoIdsAnywhere(page, 'the 360px record');
  await expectNoSeriousAxe(page, 'P05/02 at 360px');
});

// ===========================================================================
// i18n
// ===========================================================================

test('locale=en-XA renders every string as pseudo text, record data and times excepted @p05-contact @p05-contact-pseudo', async ({
  page,
}) => {
  await openRecord(page, CONTACT_FULL.id, { query: '?locale=en-XA' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await expect(item(page, ITEM_TASK.id)).toBeVisible();

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
  // Codes are copy: a status value on the timeline is a pseudo label, not "contacted".
  expect(await visibleText(item(page, ITEM_STATUS.id).locator('[data-change="after"]'))).toMatch(PSEUDO);
  expect(ACTIVITY_TYPES).toContain(String(ITEM_TASK.activityType));
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/contacts/[id] on the wire', () => {
  /**
   * WHY 245,000 BYTES, BEFORE THE SCREEN EXISTS
   *
   * Pinned near its closest measured neighbour, not at the 300 KB PRD 2.13
   * ceiling:
   *
   *   /contacts   216,100 B measured, 226,000 budget (T-0042, D-P15): the same
   *               shell, fonts and records client.
   *
   * The record view drops the list's chips, chooser and paging and adds a
   * details panel, a timeline, an activity form and an edit sheet: roughly
   * 15–25 KB of island over the list. 245,000 leaves that and nothing more
   * (T-0057 provisionally pinned /accounts at the same figure on the same
   * reasoning). The acceptance suite requires it re-pinned within 5% of the
   * measurement.
   */
  test('/contacts/[id] stays inside its transferred-byte budget on the production build @p05-contact @p05-contact-budget', async ({
    page,
  }) => {
    active = await installContactRecordMock(page);
    const metrics = await measurePageLoad(page, `${recordViewUrl()}/contacts/${CONTACT_FULL.id}`, 'default');

    const record = resolve(__dirname, '.artifacts', 'p05-contact-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(
      record,
      `${JSON.stringify({ path: '/contacts/[id]', transferredBytes: metrics.transferredBytes, budget: CONTACT_RECORD_BUDGET_BYTES }, null, 2)}\n`,
      'utf8',
    );

    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webRecordViewUrl is not serving the production build').toBe(built);

    expect(CONTACT_RECORD_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P05/01 the contact record', metrics.transferredBytes, CONTACT_RECORD_BUDGET_BYTES);
  });

  test('/contacts/[id] paints within 5 s at 256 kbps and 300 ms @p05-contact @p05-contact-budget', async ({ page }) => {
    active = await installContactRecordMock(page);
    const metrics = await measurePageLoad(page, `${recordViewUrl()}/contacts/${CONTACT_FULL.id}`, 'low-bandwidth');
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
