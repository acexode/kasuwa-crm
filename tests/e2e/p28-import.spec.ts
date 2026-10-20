import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack, type StackUrls } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  CALLER_ID,
  CELL_MARKER,
  CELL_MARKERS,
  COMPLIANCE_FIELDS,
  DEFAULT_COUNTRIES,
  FINISHED_EXAMPLE,
  HEADERS,
  HISTORY,
  HOSTILE_HEADER,
  H_CANCELLED,
  H_ERASED,
  H_ERASED_ERRORS,
  H_FAILED,
  H_FINISHED,
  H_TRUNCATED,
  IMPORT_FIELDS,
  IMPORT_STATUSES,
  LIMITS,
  NAME_FIELDS,
  NEVER_MAPPABLE,
  NO_NAME_HEADERS,
  PROGRAMME_ONE,
  PROGRAMME_TWO,
  REUSED_MAPPING,
  ROW_ERROR_CODES,
  STORAGE_ORIGIN,
  SUGGESTED,
  answerProblems,
  csvFile,
  installImportMock,
  partPlan,
  servedData,
  sha256,
  type ImportMock,
  type ImportMockOptions,
} from './support/import-mock';

/**
 * T-0096 — the P28 import wizard (`docs/design/P28/`, frames A–A6) at
 * `/contacts/import` in the CRM shell, behind `crm_import`, against T-0093's
 * contract (tag `imports`). Written by the lead's QA agent BEFORE the screen
 * exists; `tests/acceptance/records-ui/import-screen.acceptance.test.ts` runs
 * this file with `--grep @p28-import` and reads every outcome by tag.
 * Decisions: ADR-0017, D-L128 (Q4, Q6, Q7), D-L146, D-L148, D-L150, D-L151,
 * D-L159, D-L160, D-P12, D-P21, D-P28, D-L84, D-L64.
 *
 * TAG RULE (D-L84). `@p28-import` is the parent tag. Playwright's --grep is a
 * regular expression, so no other screen's tag may contain it, and it contains
 * no other screen's parent tag. Every sub-tag here is `@p28-import-<name>`.
 * (T-0097's duplicates screen is P28 too: it must not use a bare `@p28`.)
 *
 * ---------------------------------------------------------------------------
 * THE WEB PROCESS
 *
 *   webUrl        — the default server, every flag at its default.
 *                   `/contacts/import` must be a real 404 there.
 *   webImportUrl  — NEW, published in the stack file by the builder's change
 *                   to `scripts/run-e2e.mjs`. `crm_import` RIDES ON THE
 *                   RECORDS PROCESS (`webRecordsUrl`), so the Contacts list
 *                   that links the screen, and that the report links back to,
 *                   is served there. Every journey and the byte budget run here.
 *
 * EVERYTHING IS READ FROM THE BROWSER, AND MOCKED THERE
 *
 * Every journey installs `support/import-mock.ts`: the nine import operations,
 * an S3-like object store on STORAGE_ORIGIN for the part PUTs, and the reads
 * the screen and its report link land on. `afterEach` fails a test in which the
 * screen sent the API or the store anything the contract (or the rules in the
 * mock's header) does not allow, or in which the mock answered something its
 * own contract rejects.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                       the CRM shell
 *   [data-screen="P28"]                      the import screen root
 *   [data-testid="import-steps"]             the step list: an <ol> (or
 *                                            role="list") with an accessible
 *                                            name; its items carry
 *     [data-step="upload|mapping|phones|run"]  in this order; exactly one has
 *                                            aria-current="step"
 *   UPLOAD (A, A1)
 *     select[data-testid="import-programme"] native select, one option per
 *                                            session programme (value = id,
 *                                            text = name)
 *     input[type="file"][data-testid="import-file"]  choosing a file STARTS
 *                                            the upload (no second click)
 *     [data-testid="import-limit"]           states the 25 MiB limit
 *     [data-testid="import-too-large"]       A1: the refusal, the limit and
 *                                            advice
 *     [data-testid="upload-progress"]        role="progressbar", named,
 *                                            aria-valuenow 0..100, and
 *                                            data-upload-state = uploading |
 *                                            paused | done | failed (retrying
 *                                            may show as uploading)
 *     [data-testid="upload-pause"], [data-testid="upload-resume"],
 *     [data-testid="upload-cancel"]          (cancel aborts the upload).
 *                                            Pause shows `paused` AT ONCE:
 *                                            a part in flight may be aborted
 *                                            (and sent again on resume) or
 *                                            left to finish, but no new part
 *                                            starts until resume
 *   MAPPING (A2, A3)
 *     [data-map-column="<index>"]            one row per header, the header
 *                                            name inside [data-record-text]
 *     select[data-map-field="<index>"]       native select; option values are
 *                                            ImportField names, `""` is "do not
 *                                            import" (sent as null or omitted)
 *     select[data-testid="import-reuse"]     reuse a previous import's mapping
 *                                            (value = import id, `""` = none)
 *     [data-testid="import-required"]        the checklist; its one item is
 *       [data-required="displayName"][data-met="true|false"]
 *     [data-testid="import-compliance"]      the restrict-only note, drawn while
 *                                            a compliance field is mapped
 *   PHONES AND DUPLICATES (A4)
 *     select[data-testid="import-country"]   exactly NG, GH, KE, ZA
 *     [data-testid="import-duplicate-rule"]  the rule, in words
 *     [data-testid="import-start"]           saves the mapping and runs
 *   SHARED
 *     [data-testid="import-continue"]        upload → mapping → phones;
 *                                            disabled (or aria-disabled) while
 *                                            the upload is unfinished or the
 *                                            checklist unmet
 *     [data-testid="import-error"]           a translated refusal or failure
 *   RUN AND REPORT (A5, A6)
 *     [data-testid="import-job"]             the run or report, with
 *                                            data-import-status = the status
 *                                            last read
 *     [data-testid="import-progress"]        role="status" or aria-live, inside
 *                                            the job view, holding
 *       [data-count="created|skipped|failed"]  the counts, Intl-formatted (the
 *                                            only [data-count]s in the view)
 *     [data-testid="import-cancel"]          while queued or running
 *     [data-row-error]                       one per served row error, holding
 *       [data-error-row], [data-error-column] and [data-error-code="<code>"]
 *     [data-testid="import-errors-truncated"]  when errorsTruncated
 *     a[data-testid="import-contacts-link"]  href exactly
 *                                            /contacts?importId=<id>
 *     [data-testid="import-result-note"]     duplicates skipped, no restriction
 *                                            applied to existing contacts
 *   HISTORY
 *     [data-testid="import-history"]         on the landing
 *       [data-import-row="<id>"]             one per listed import, served
 *                                            order; data-erased="true" when
 *                                            its filename is gone
 *         [data-import-open]                 opens its run or report
 *   [data-record-text]                       record data (headers, filenames,
 *                                            programme names), not UI copy
 *   <time datetime>                          every date or time drawn
 *   A mapping the API refuses (400 duplicate_mapping, unknown_reference,
 *   403 field_not_editable) puts the screen back on the mapping step, with
 *   the translated reason in [data-testid="import-error"].
 *   The Contacts list's import action, [data-action^="import"], is the link
 *   a[href="/contacts/import"] where `crm_import` is live.
 *
 * DESIGN AGAINST DECISIONS — WHERE THEY DISAGREE THE DECISIONS WIN (D-L146)
 *
 *   Absent: 100 MB and 500,000 rows (25 MiB and 100,000), CSV-or-Excel (CSV
 *   only), "No programme (shared)", accounts, leads, tickets and custom
 *   objects (contacts only), "even if you close the tab" (nothing is kept on
 *   the device, D-P21), "split it for me", "zip it", "migrate instead", sample
 *   values and any preview of a cell, "save as template" (reuse a previous
 *   import instead), "create a new field", phone and email as required, the
 *   before-and-after phone table and "numbers we can't read", the
 *   name-and-date-of-birth rule and the on-match choices (exact phone or
 *   email in the programme is skipped, D-P12), "we keep the last one", the
 *   dry run and its values, "download error rows", "download log", "updated"
 *   counts, undo, and the email notification (T-0101 shows notifications).
 *   Compliance is most-restrictive-wins and restrict-only (D-P28), never
 *   "keeps the most recent choice".
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P28"]';

/**
 * The /contacts/import transferred-byte budget. PROVISIONAL: a 250,000-byte
 * placeholder under the 255,000 ceiling (the search screen's). The lead
 * re-pins it within 5% of the builder's first green measurement (D-L118), as
 * T-0109 did; until then the acceptance suite's budget check fails by design.
 */
const IMPORT_BUDGET_BYTES = 286_500;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const EN = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8')) as Record<string, string>;

const MIB = 1_048_576;
/** One part. */
const SMALL = 2_048;
/** Two parts: 5 MiB and 1 KiB. */
const TWO_PARTS = 5 * MIB + 1_024;
/** Four parts: 5, 5, 5 MiB and 4 KiB. */
const FOUR_PARTS = 15 * MIB + 4_096;
const FILENAME = 'sample-customers-oct.csv';

// ---------------------------------------------------------------------------
// The mock, the wire and the clean-up
// ---------------------------------------------------------------------------

let active: ImportMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults, 'the MOCK answered something its contract rejects (a mock bug, not the screen’s)').toEqual([]);
    expect(mock.violations, 'the screen sent the API or the store something the contract or this screen’s rules do not allow').toEqual([]);
    if (mock.requests.length > 0) {
      const origin = new URL(importUrl()).origin;
      for (const url of mock.requests) {
        expect(url.origin, 'the import API must be called same-origin, by a relative path').toBe(origin);
      }
    }
  }
});

function importUrl(): string {
  const urls = stack() as StackUrls & { webImportUrl?: string };
  if (typeof urls.webImportUrl !== 'string' || urls.webImportUrl === '') {
    throw new Error('the stack file has no webImportUrl: scripts/run-e2e.mjs starts no web process with crm_import on (see the header of p28-import.spec.ts)');
  }
  return urls.webImportUrl;
}

/** History writes, file reads by script and object URLs, recorded from the page's first script. */
async function tap(page: Page): Promise<string[]> {
  const consoleLines: string[] = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => consoleLines.push(String(error.message)));
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const history: string[] = [];
    w.__kasuwaHistory = history;
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = window.history[name].bind(window.history);
      window.history[name] = (state: unknown, unused: string, url?: string | URL | null) => {
        let written = '';
        try {
          written = JSON.stringify(state) ?? '';
        } catch {
          written = '[unserialisable state]';
        }
        history.push(`${String(url ?? '')}\n${written}`);
        original(state, unused, url);
      };
    }
    const reads: string[] = [];
    w.__kasuwaFileReads = reads;
    const blob = Blob.prototype as unknown as Record<string, unknown>;
    for (const name of ['text', 'arrayBuffer', 'stream', 'bytes']) {
      const original = blob[name];
      if (typeof original !== 'function') continue;
      blob[name] = function (this: Blob, ...args: unknown[]) {
        if (this.size > 512) reads.push(`Blob.${name}(${this.size})`);
        return (original as (...rest: unknown[]) => unknown).apply(this, args);
      };
    }
    const reader = FileReader.prototype as unknown as Record<string, unknown>;
    for (const name of ['readAsText', 'readAsArrayBuffer', 'readAsDataURL', 'readAsBinaryString']) {
      const original = reader[name];
      if (typeof original !== 'function') continue;
      reader[name] = function (this: FileReader, ...args: unknown[]) {
        reads.push(`FileReader.${name}`);
        return (original as (...rest: unknown[]) => unknown).apply(this, args);
      };
    }
    const objectUrls: string[] = [];
    w.__kasuwaObjectUrls = objectUrls;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      objectUrls.push(object instanceof Blob ? `blob(${object.size})` : 'media');
      return create(object);
    };
  });
  return consoleLines;
}

async function windowList(page: Page, name: '__kasuwaHistory' | '__kasuwaFileReads' | '__kasuwaObjectUrls'): Promise<string[]> {
  return page.evaluate((key) => ((window as unknown as Record<string, unknown>)[key] as string[] | undefined) ?? [], name);
}

// ---------------------------------------------------------------------------
// Locators and readers
// ---------------------------------------------------------------------------

function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

function screenOf(page: Page): Locator {
  return page.locator(SCREEN);
}

function byTestId(page: Page, id: string): Locator {
  return shown(page.getByTestId(id)).first();
}

function fileInput(page: Page): Locator {
  return page.locator('input[type="file"][data-testid="import-file"]').first();
}

function progress(page: Page): Locator {
  return byTestId(page, 'upload-progress');
}

function mapField(page: Page, index: number): Locator {
  return shown(page.locator(`select[data-map-field="${index}"]`)).first();
}

function jobView(page: Page): Locator {
  return byTestId(page, 'import-job');
}

async function currentStep(page: Page): Promise<string | null> {
  return page.locator('[data-testid="import-steps"] [aria-current="step"]').first().getAttribute('data-step');
}

async function expectStep(page: Page, step: string): Promise<void> {
  await expect.poll(() => currentStep(page), { message: `the step list does not mark ${step} as the current step` }).toBe(step);
  await expect(page.locator('[data-testid="import-steps"] [aria-current="step"]'), 'more than one step is current').toHaveCount(1);
}

async function isDisabled(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true');
}

async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** UI copy only: record data, icon ligatures and option lists removed. */
async function copyText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"], [data-record-text], option, time, script, style').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

function camel(code: string): string {
  return code.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** en.json values under ids containing every one of `parts` (case-insensitive) and ending with one of `suffixes`. */
function labels(parts: readonly string[], suffixes: readonly string[]): string[] {
  return Object.entries(EN)
    .filter(([id]) => parts.every((part) => id.toLowerCase().includes(part.toLowerCase())) && suffixes.some((suffix) => id.endsWith(suffix)))
    .map(([, text]) => text);
}

/** The label of an import refusal or row-error code: an id containing "import" and "error", ending `.<code>` (camel case accepted). */
function errorLabels(code: string): string[] {
  return labels(['import', 'error'], [`.${code}`, `.${camel(code)}`]);
}

function statusLabels(status: string): string[] {
  return labels(['import', 'status'], [`.${status}`, `.${camel(status)}`]);
}

function recordsError(code: string): string[] {
  const text = EN[`records.error.${code}`];
  return text === undefined ? [] : [text];
}

async function expectSaysOneOf(locator: Locator, texts: readonly string[], what: string): Promise<void> {
  expect(texts.length, `en.json has no label for ${what}`).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const said = await visibleText(locator);
      return texts.some((text) => said.includes(text)) ? 'says it' : said;
    }, { message: `${what}: says none of ${texts.map((text) => `"${text}"`).join(', ')}` })
    .toBe('says it');
}

/** A translated refusal: visible, one of `texts`, and never a raw code. */
async function expectRefusal(page: Page, texts: readonly string[], what: string): Promise<void> {
  const error = byTestId(page, 'import-error');
  await expect(error, `no translated message for ${what}`).toBeVisible();
  await expectSaysOneOf(error, texts, what);
  expect(await visibleText(error), `${what} prints a raw code`).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
}

function formatted(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

async function expectCounts(page: Page, counts: { created: number; skipped: number; failed: number }, where: string): Promise<void> {
  for (const [name, value] of Object.entries(counts)) {
    await expect
      .poll(async () => visibleText(shown(jobView(page).locator(`[data-count="${name}"]`)).first()), { message: `${where}: the ${name} count is not ${value}` })
      .toContain(formatted(value));
  }
}

/** No UUID a person can see or hear: visible text, accessible-name attributes, option text and the title. */
async function expectNoIdsPrinted(page: Page, where: string): Promise<void> {
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
    }
    return out.join('\n');
  });
  expect(printed.match(UUID)?.[0], `an id was printed (${where})`).toBeUndefined();
}

async function expectNoCellValue(page: Page, where: string): Promise<void> {
  const html = await page.content();
  for (const marker of [CELL_MARKER, ...CELL_MARKERS]) {
    expect(html.includes(marker), `a cell value from the file is in the page (${where}): there is no preview of file values`).toBe(false);
  }
}

async function expectNoSeriousAxe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious');
  expect(blocking.map((violation) => `${violation.id}: ${violation.help}`), `serious or critical accessibility violations on ${label}`).toEqual([]);
  expect(results.passes.length, 'axe checked nothing').toBeGreaterThan(0);
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

// ---------------------------------------------------------------------------
// Journeys' building blocks
// ---------------------------------------------------------------------------

async function openImport(page: Page, options: ImportMockOptions = {}, query = ''): Promise<ImportMock> {
  await tap(page);
  const mock = await installImportMock(page, options);
  active = mock;
  const response = await page.goto(`${importUrl()}/contacts/import${query}`);
  expect(response?.status(), '/contacts/import with crm_import on').toBe(200);
  await expect(screenOf(page)).toBeVisible();
  return mock;
}

interface Picked {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

function csv(sizeBytes: number, name = FILENAME): Picked {
  return { name, mimeType: 'text/csv', buffer: csvFile(sizeBytes) };
}

async function pick(page: Page, file: Picked, programmeId = PROGRAMME_ONE.id): Promise<void> {
  await byTestId(page, 'import-programme').selectOption(programmeId);
  await fileInput(page).setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
}

/** Picks a file and waits until it is uploaded and completed. Returns the import id. */
async function upload(page: Page, mock: ImportMock, file: Picked = csv(SMALL)): Promise<string> {
  const before = mock.callsOf('completeImportUpload').length;
  await pick(page, file);
  await expect.poll(() => mock.callsOf('completeImportUpload').length, { message: 'the upload was never completed', timeout: 90_000 }).toBeGreaterThan(before);
  await expect(progress(page)).toHaveAttribute('data-upload-state', 'done', { timeout: 30_000 });
  const id = mock.created().at(-1);
  expect(id, 'no import was created').toBeDefined();
  return id ?? '';
}

async function toMapping(page: Page): Promise<void> {
  const next = byTestId(page, 'import-continue');
  await expect.poll(() => isDisabled(next), { message: 'Continue stays disabled after the upload finished' }).toBe(false);
  await next.click();
  await expectStep(page, 'mapping');
  await expect(shown(page.locator('[data-map-column="0"]')).first(), 'the mapping rows never appeared').toBeVisible();
}

async function toPhones(page: Page): Promise<void> {
  await byTestId(page, 'import-continue').click();
  await expectStep(page, 'phones');
  await expect(byTestId(page, 'import-country')).toBeVisible();
}

/** Upload, mapping and the phones step, with the suggestion accepted. */
async function throughToPhones(page: Page, mock: ImportMock, file: Picked = csv(SMALL)): Promise<string> {
  const id = await upload(page, mock, file);
  await toMapping(page);
  await toPhones(page);
  return id;
}

async function start(page: Page): Promise<void> {
  await byTestId(page, 'import-start').click();
}

function lastMapping(mock: ImportMock): { columns?: { index: number; field: string | null }[]; fromImportId?: string; defaultCountry?: string; ownerUserId?: string | null } {
  const call = mock.callsOf('putImportMapping').at(-1);
  expect(call, 'no putImportMapping was sent').toBeDefined();
  return (call?.body ?? {}) as { columns?: { index: number; field: string | null }[]; fromImportId?: string; defaultCountry?: string };
}

/** The non-null field each column was sent with, by index. */
function sentFields(columns: readonly { index: number; field: string | null }[] | undefined): Record<number, string> {
  return Object.fromEntries((columns ?? []).filter((column) => column.field !== null).map((column) => [column.index, column.field as string]));
}

async function openFromHistory(page: Page, id: string): Promise<void> {
  const row = shown(page.locator(`[data-import-row="${id}"]`)).first();
  await expect(row, `the history does not list ${id}`).toBeVisible();
  await shown(row.locator('[data-import-open]')).first().click();
  await expect(jobView(page)).toBeVisible();
}

/** Everything the page has written to the device: web storage, cookies, IndexedDB, Cache Storage and the origin-private file system. */
async function deviceStorage(page: Page): Promise<{ dump: string; cachedApi: string[]; databases: string[]; opfs: string[] }> {
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
    const databases: string[] = [];
    if (typeof indexedDB.databases === 'function') {
      for (const info of await indexedDB.databases()) {
        if (typeof info.name !== 'string') continue;
        databases.push(info.name);
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
    const opfs: string[] = [];
    if (navigator.storage !== undefined && typeof navigator.storage.getDirectory === 'function') {
      const root = (await navigator.storage.getDirectory()) as unknown as { keys(): AsyncIterable<string> };
      for await (const name of root.keys()) opfs.push(name);
    }
    return { dump: parts.join('\n'), cachedApi, databases, opfs };
  });
}

const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers @p28-import @p28-import-mock', async ({ page }) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (the default server) and watch each
  // malformed request land in `violations`. No `active` mock here: the
  // violations are deliberate and counted explicitly.

  // D-L160's plan, and the contract example's own (12 MiB in 5, 5 and 2).
  expect(partPlan(12 * MIB)).toEqual([5 * MIB, 5 * MIB, 2 * MIB]);
  expect(partPlan(SMALL)).toEqual([SMALL]);
  expect(partPlan(LIMITS.maxFileBytes).length).toBe(LIMITS.maxParts);
  expect(partPlan(FOUR_PARTS)).toEqual([5 * MIB, 5 * MIB, 5 * MIB, 4_096]);
  expect(LIMITS.maxFileBytes, 'the published limit is no longer 25 MiB').toBe(25 * MIB);
  // The file never carries a marker in its header row: headers ARE shown.
  const file = csvFile(SMALL);
  expect(file.length).toBe(SMALL);
  expect(file.toString('utf8').split('\r\n')[0]).toBe(HEADERS.join(','));
  expect(HEADERS.join(',')).not.toContain(CELL_MARKER);
  expect(file.toString('utf8')).toContain(CELL_MARKER);
  // The mock serves no answer its contract rejects.
  expect(answerProblems('listImports', 200, { data: [{ ...H_FINISHED }], nextCursor: null }).length, 'an Import with headers passed as an ImportSummary').toBeGreaterThan(0);
  expect(answerProblems('getImport', 200, { ...H_FINISHED, sample: ['x'] }), 'a sample property passed the strict check').not.toEqual([]);

  const mock = await installImportMock(page);
  // The records process: the only one whose CSP admits the storage origin (D-L187); the
  // default production process keeps connect-src 'self' (I18), which blocks put() below.
  await page.goto(`${importUrl()}/`);
  const call = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
    page.evaluate(
      async ({ path: target, method: verb, body: payload, headers: extra }) => {
        const response = await fetch(target, {
          method: verb,
          headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
          ...(payload === undefined ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
        });
        return { status: response.status, body: (await response.json().catch(() => null)) as unknown, etag: response.headers.get('etag') };
      },
      { path, method, body, headers },
    );
  let expected = 0;
  const expectViolation = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    await run();
    expected += 1;
    expect(mock.violations.length, `the mock did not record: ${what}`).toBeGreaterThanOrEqual(expected);
    expected = mock.violations.length;
  };

  await expectViolation('a declaration over 25 MiB', () =>
    call('/api/v1/imports', 'POST', { programmeId: PROGRAMME_ONE.id, filename: 'a.csv', sizeBytes: LIMITS.maxFileBytes + 1, contentType: 'text/csv' }),
  );
  await expectViolation('a programme the session never listed', () =>
    call('/api/v1/imports', 'POST', { programmeId: '0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a99', filename: 'a.csv', sizeBytes: 10, contentType: 'text/csv' }),
  );
  await expectViolation('a closed body with an extra property', () =>
    call('/api/v1/imports', 'POST', { programmeId: PROGRAMME_ONE.id, filename: 'a.csv', sizeBytes: 10, contentType: 'text/csv', preview: true }),
  );
  await expectViolation('a scope header', () => call('/api/v1/imports', 'GET', undefined, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id }));
  await expectViolation('a programmeId query on listImports', () => call(`/api/v1/imports?programmeId=${PROGRAMME_ONE.id}`, 'GET'));
  await expectViolation('an operation the screen does not use', () => call('/api/v1/imports/export', 'GET'));

  // The API's own refusals are not violations.
  const before = mock.violations.length;
  const forbidden = await call('/api/v1/imports', 'POST', { programmeId: PROGRAMME_TWO.id, filename: 'a.csv', sizeBytes: 10, contentType: 'text/csv' });
  expect(forbidden.status).toBe(403);
  const xlsx = await call('/api/v1/imports', 'POST', { programmeId: PROGRAMME_ONE.id, filename: 'a.xlsx', sizeBytes: 10, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  expect(xlsx.status).toBe(400);
  const excelAsCsv = await call('/api/v1/imports', 'POST', { programmeId: PROGRAMME_ONE.id, filename: 'a.xls', sizeBytes: 10, contentType: 'application/vnd.ms-excel' });
  expect(excelAsCsv.status, 'an .xls slipped in as application/vnd.ms-excel').toBe(400);
  expect(mock.violations.length, 'an API refusal was blamed on the screen').toBe(before);

  // A real two-part upload, by hand, through the store.
  const created = await call('/api/v1/imports', 'POST', { programmeId: PROGRAMME_ONE.id, filename: FILENAME, sizeBytes: TWO_PARTS, contentType: 'text/csv' });
  expect(created.status).toBe(201);
  const upload = created.body as { importId: string; parts: { partNumber: number; url: string; sizeBytes: number }[] };
  expect(upload.parts.map((part) => part.sizeBytes)).toEqual([5 * MIB, 1_024]);
  for (const part of upload.parts) {
    expect(new URL(part.url).origin).toBe(STORAGE_ORIGIN);
    expect(part.url).not.toContain(FILENAME);
  }
  const put = (url: string, size: number, headers: Record<string, string> = {}) =>
    page.evaluate(
      async ({ url: target, size: bytes, headers: extra }) => {
        const response = await fetch(target, { method: 'PUT', body: new Blob([new Uint8Array(bytes).fill(97)]), headers: extra });
        return { status: response.status, etag: response.headers.get('etag') };
      },
      { url, size, headers },
    );
  const [first, second] = upload.parts;
  await expectViolation('a part of the wrong size', () => put(first?.url ?? '', 10));
  await expectViolation('a session header to the bucket', () => put(first?.url ?? '', first?.sizeBytes ?? 0, { authorization: 'Bearer ksw_s1_fixture' }));
  await expectViolation('an edited URL', () => put(`${second?.url ?? ''}&x=1`, second?.sizeBytes ?? 0));
  const good = await put(second?.url ?? '', second?.sizeBytes ?? 0);
  expect(good.status).toBe(200);
  expect(good.etag, 'the page cannot read the ETag: the store does not expose it').toMatch(/^"[0-9a-f]{32}"$/);
  await expectViolation('a part uploaded again after it succeeded', () => put(second?.url ?? '', second?.sizeBytes ?? 0));
  await expectViolation('a re-issue for a part that succeeded', () => call(`/api/v1/imports/${upload.importId}/upload-urls`, 'POST', { partNumbers: [2] }));
  await expectViolation('a complete missing a part and with a wrong ETag', () =>
    call(`/api/v1/imports/${upload.importId}/complete`, 'POST', { parts: [{ partNumber: 2, etag: '"0"' }] }),
  );

  // A one-part job taken to mapping by hand.
  const small = await call('/api/v1/imports', 'POST', { programmeId: PROGRAMME_ONE.id, filename: 'b.csv', sizeBytes: SMALL, contentType: 'text/csv' });
  const smallUpload = small.body as { importId: string; parts: { url: string; sizeBytes: number }[] };
  const etag = (await put(smallUpload.parts[0]?.url ?? '', SMALL)).etag ?? '';
  expect((await call(`/api/v1/imports/${smallUpload.importId}/complete`, 'POST', { parts: [{ partNumber: 1, etag }] })).status).toBe(202);
  await expect.poll(async () => ((await call(`/api/v1/imports/${smallUpload.importId}`, 'GET')).body as { status: string }).status).toBe('awaiting_mapping');
  const mapping = (columns: unknown, extra: Record<string, unknown> = {}) => call(`/api/v1/imports/${smallUpload.importId}/mapping`, 'PUT', { columns, defaultCountry: 'NG', ...extra });
  await expectViolation('a mapping with no name field', () => mapping([{ index: 2, field: 'phones' }]));
  await expectViolation('an owner other than the caller', () => mapping([{ index: 0, field: 'givenNames' }], { ownerUserId: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e99' }));
  await expectViolation('a column beyond the headers', () => mapping([{ index: 0, field: 'givenNames' }, { index: 9, field: 'tags' }]));
  await expectViolation('a custom key with no definition', () => mapping([{ index: 0, field: 'givenNames' }, { index: 6, field: 'custom.tier__c' }]));
  await expectViolation('reusing an erased import', () => call(`/api/v1/imports/${smallUpload.importId}/mapping`, 'PUT', { fromImportId: H_ERASED.id, defaultCountry: 'NG' }));
  const duplicate = await mapping([{ index: 0, field: 'status' }, { index: 1, field: 'givenNames' }, { index: 4, field: 'status' }]);
  expect(duplicate.status, 'a repeated non-repeatable field is the API’s 400').toBe(400);
  const reused = await call(`/api/v1/imports/${smallUpload.importId}/mapping`, 'PUT', { fromImportId: H_FINISHED.id, defaultCountry: 'GH' });
  expect(reused.status).toBe(200);
  const reusedColumns = ((reused.body as { mapping: { columns: { index: number; field: string | null }[] } }).mapping.columns);
  expect(reusedColumns.map((column) => column.field)).toEqual(HEADERS.map((name) => REUSED_MAPPING[name] ?? null));
  await expectViolation('a run with a body', () => call(`/api/v1/imports/${smallUpload.importId}/run`, 'POST', {}));
  await expectViolation('a second run', () => call(`/api/v1/imports/${smallUpload.importId}/run`, 'POST'));

  // The history is the contract's, and an erased import keeps no name.
  const history = await call('/api/v1/imports', 'GET');
  const rows = (history.body as { data: { id: string; filename: string | null }[] }).data;
  expect(rows.slice(-HISTORY.length).map((row) => row.id)).toEqual(HISTORY.map((entry) => String(entry.id)));
  expect(rows.find((row) => row.id === H_ERASED.id)?.filename).toBeNull();
  expect(mock.mockFaults, 'the mock answered something its contract rejects').toEqual([]);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_import gates /contacts/import', () => {
  // The flag-off tests PASS BEFORE THE WORK STARTS: there is no route. A
  // negative invariant, legitimately vacuous until the screen exists; the
  // flag-on test gives the pair meaning. That no nav link is drawn with the
  // flag off is held statically by the suite (no process serves the CRM shell
  // with crm_records on and crm_import off).
  test('/contacts/import is a real 404 with every flag at its default, and nothing reaches the API @p28-import @p28-import-flag-off', async ({ page }) => {
    const { webUrl } = stack();
    const mock = await installImportMock(page);
    const response = await page.goto(`${webUrl}/contacts/import`);
    expect(response?.status(), '/contacts/import is reachable with crm_import off').toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    expect(mock.requests.filter((url) => url.pathname.startsWith('/api/v1/imports')), 'a flag-off page read imports').toEqual([]);
    expect(mock.storageRequests, 'a flag-off page touched the store').toEqual([]);
  });

  test('/contacts/import cannot be switched on by anything the browser sends @p28-import @p28-import-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-kasuwa-feature-flags': 'crm_import,crm_records', 'x-crm-import': '1', 'x-kasuwa-tenant-id': TENANT_A },
    });
    await context.addCookies([
      { name: 'crm_import', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_import,crm_records', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of ['/contacts/import?crm_import=on&flags=crm_import', '/contacts/import/', '/contacts/import?locale=en-XA']) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/contacts/import renders P28 in the CRM shell with crm_import on: a labelled step list and the history @p28-import @p28-import-flag-on', async ({ page }) => {
    await openImport(page);
    await expect(page.locator('[data-shell="crm"]').locator(SCREEN)).toBeVisible();
    const steps = byTestId(page, 'import-steps');
    await expect(steps).toBeVisible();
    await expect(steps).toHaveAccessibleName(/\S/);
    expect(await steps.evaluate((element) => element.tagName === 'OL' || element.getAttribute('role') === 'list'), 'the step list is not a list').toBe(true);
    expect(await steps.locator('[data-step]').evaluateAll((items) => items.map((item) => item.getAttribute('data-step')))).toEqual(['upload', 'mapping', 'phones', 'run']);
    await expectStep(page, 'upload');
    await expect(byTestId(page, 'import-history')).toBeVisible();
    await expect(shown(page.locator('[data-import-row]')).first()).toBeVisible();
  });
});

// ===========================================================================
// The entry, the programme and the object
// ===========================================================================

test('the Contacts list links /contacts/import, it lands on the screen, and no link on the screen is a 404 @p28-import @p28-import-entry', async ({ page }) => {
  await tap(page);
  const mock = await installImportMock(page);
  active = mock;
  const response = await page.goto(`${importUrl()}/contacts`);
  expect(response?.status(), '/contacts on the records process').toBe(200);
  // T-0149 (T-0133): the Contacts list's import and duplicates links sit in its "Import / export" menu, as P04 draws it.
  await shown(page.getByTestId('import-export')).first().click();
  const entry = shown(page.locator('a[href="/contacts/import"]')).first();
  await expect(entry, 'the Contacts list does not link the import screen').toBeVisible();
  expect(await entry.getAttribute('data-action'), 'the import action is no longer [data-action^="import"] (P04 holds that hook)').toMatch(/^import/);
  await entry.click();
  await expect(page).toHaveURL(/\/contacts\/import$/);
  await expect(screenOf(page)).toBeVisible();
  const hrefs = [...new Set(await page.locator('a[href^="/"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? '')))];
  expect(hrefs.length, 'the page links nowhere — not even the CRM nav').toBeGreaterThan(2);
  for (const href of hrefs) {
    const answer = await page.request.get(`${importUrl()}${href}`);
    expect(answer.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }
});

test('the target programme is chosen from the session’s programmes, by name; one without the import right is a translated 403 and nothing uploads @p28-import @p28-import-programme', async ({ page }) => {
  const mock = await openImport(page);
  const select = byTestId(page, 'import-programme');
  const options = await select.locator('option').evaluateAll((items) => items.map((item) => ({ value: (item as HTMLOptionElement).value, text: (item.textContent ?? '').trim() })));
  const real = options.filter((option) => option.value !== '');
  expect(real.map((option) => option.value).sort(), 'the programme choices are not the session’s programmes').toEqual([PROGRAMME_ONE.id, PROGRAMME_TWO.id].sort());
  expect(real.find((option) => option.value === PROGRAMME_ONE.id)?.text).toBe(PROGRAMME_ONE.name);
  expect(real.find((option) => option.value === PROGRAMME_TWO.id)?.text).toBe(PROGRAMME_TWO.name);
  expect(options.map((option) => option.text).join(' '), '"No programme (shared)" is offered').not.toMatch(/shared|no programme/i);
  await expectNoIdsPrinted(page, 'the programme choice');

  await pick(page, csv(SMALL), PROGRAMME_TWO.id);
  await expectRefusal(page, recordsError('not_permitted'), 'createImport 403 not_permitted');
  expect(mock.partPuts, 'a part was uploaded after a 403').toEqual([]);

  await pick(page, csv(SMALL, 'sample-second-try.csv'), PROGRAMME_ONE.id);
  await expect.poll(() => mock.callsOf('completeImportUpload').length, { timeout: 60_000 }).toBe(1);
  const declared = mock.callsOf('createImport').map((call) => (call.body as { programmeId: string }).programmeId);
  expect(declared, 'each declaration carries the programme chosen at the time').toEqual([PROGRAMME_TWO.id, PROGRAMME_ONE.id]);
});

test('contacts only: no object chooser, and no accounts, tickets, deals or custom objects @p28-import @p28-import-contacts-only', async ({ page }) => {
  await openImport(page);
  const root = screenOf(page);
  await expect(root.locator('[data-testid="import-object"], input[type="radio"]'), 'an object chooser is drawn').toHaveCount(0);
  const copy = await copyText(root);
  expect(copy, 'the screen offers another object').not.toMatch(/\b(accounts?|tickets?|deals?|loan applications?|custom objects?|businesses and merchants|support cases)\b/i);
});

// ===========================================================================
// Upload (A, A1)
// ===========================================================================

test('the 25 MiB limit is stated, never 100 MB, 500,000 rows or Excel; the file input takes CSV only @p28-import @p28-import-limit', async ({ page }) => {
  await openImport(page);
  const limit = byTestId(page, 'import-limit');
  await expect(limit).toBeVisible();
  const said = await visibleText(limit);
  expect(said, 'the limit does not say 25').toMatch(/\b25\b/);
  expect(said, 'the overruled design limit is stated').not.toMatch(/\b100\b|500[,. ]?000|xlsx|\bxls\b|excel/i);
  expect(await copyText(screenOf(page)), 'the screen offers Excel or a 100 MB limit').not.toMatch(/\b100 ?MB\b|xlsx|\bxls\b|excel file/i);
  const accept = (await fileInput(page).getAttribute('accept')) ?? '';
  expect(accept, 'the file input does not ask for CSV').toMatch(/\.csv|text\/csv/i);
  expect(accept, 'the file input asks for Excel').not.toMatch(/xls|spreadsheetml|ms-excel(?!.*\.csv)/i);
});

test('A1: a file over 25 MiB is refused before anything is sent, with the limit and advice; exactly 25 MiB is declared @p28-import @p28-import-too-large', async ({ page }) => {
  const mock = await openImport(page, { holdCreate: true });
  await pick(page, csv(LIMITS.maxFileBytes + 1, 'sample-too-large.csv'));
  const refusal = byTestId(page, 'import-too-large');
  await expect(refusal, 'no A1 refusal for a file over 25 MiB').toBeVisible();
  const said = await visibleText(refusal);
  expect(said, 'the refusal does not state the limit').toMatch(/\b25\b/);
  await expectSaysOneOf(refusal, labels(['import', 'advice'], ['']), 'the A1 advice (an id containing "import" and "advice")');
  expect(await copyText(screenOf(page)), 'the overruled A1 offers are drawn').not.toMatch(/split it|split into|zip it|\bmigrat|zoho|salesforce/i);
  expect(mock.callsOf('createImport'), 'an oversized file was declared').toEqual([]);
  expect(mock.partPuts).toEqual([]);

  await pick(page, csv(LIMITS.maxFileBytes, 'sample-at-limit.csv'));
  await expect.poll(() => mock.callsOf('createImport').length, { message: 'a file of exactly 25 MiB was not declared' }).toBe(1);
  expect((mock.callsOf('createImport')[0]?.body as { sizeBytes: number }).sizeBytes).toBe(LIMITS.maxFileBytes);
});

test('the upload: one exact declaration, the parts PUT byte-exact to the issued URLs with no credentials, one complete with the store’s ETags @p28-import @p28-import-upload', async ({ page }) => {
  const mock = await openImport(page, { holdParts: true });
  const file = csv(TWO_PARTS);
  await pick(page, file);
  await expect.poll(() => mock.inFlight(), { message: 'no part was uploaded' }).toBeGreaterThan(0);
  const bar = progress(page);
  await expect(bar).toHaveAttribute('role', 'progressbar');
  await expect(bar).toHaveAccessibleName(/\S/);
  await expect(bar).toHaveAttribute('data-upload-state', 'uploading');
  expect(await isDisabled(byTestId(page, 'import-continue')), 'Continue is enabled before the upload finished').toBe(true);
  mock.releaseParts();
  await expect.poll(() => mock.callsOf('completeImportUpload').length, { timeout: 60_000 }).toBe(1);
  await expect(bar).toHaveAttribute('data-upload-state', 'done');
  await expect(bar).toHaveAttribute('aria-valuenow', '100');
  expect(await isDisabled(byTestId(page, 'import-continue')), 'Continue stays disabled after the upload').toBe(false);

  const declarations = mock.callsOf('createImport');
  expect(declarations.length, 'one file, one declaration').toBe(1);
  expect(declarations[0]?.body).toEqual({ programmeId: PROGRAMME_ONE.id, filename: file.name, sizeBytes: file.buffer.length, contentType: 'text/csv' });
  const id = mock.created()[0] ?? '';
  expect(mock.partPuts.map((put) => put.partNumber).sort(), 'each part once').toEqual([1, 2]);
  expect(mock.partPuts.every((put) => put.outcome === 'ok')).toBe(true);
  expect(sha256(mock.assembled(id)), 'the bytes in the bucket are not the file').toBe(sha256(file.buffer));
  const sentPartNumbers = ((mock.callsOf('completeImportUpload')[0]?.body as { parts: { partNumber: number }[] }).parts).map((part) => part.partNumber);
  expect(sentPartNumbers).toEqual([1, 2]);
  // That no API request carried the file's bytes, a cell or a part URL is the mock's rule, checked in afterEach.
  expect(mock.calls.every((call) => call.raw.length < 64 * 1024), 'an API request carried the file').toBe(true);
});

test('content types: Windows’ application/vnd.ms-excel and an empty type are declared validly for .csv; an .xlsx never uploads @p28-import @p28-import-content-type', async ({ page }) => {
  const mock = await openImport(page);
  const windows: Picked = { name: 'sample-windows.csv', mimeType: 'application/vnd.ms-excel', buffer: csvFile(SMALL) };
  await pick(page, windows);
  await expect.poll(() => mock.callsOf('completeImportUpload').length, { timeout: 60_000 }).toBe(1);
  const windowsType = (mock.callsOf('createImport')[0]?.body as { contentType: string }).contentType;
  expect(['text/csv', 'application/csv', 'application/vnd.ms-excel'], 'Windows’ CSV declared with an unknown type').toContain(windowsType);

  await page.goto(`${importUrl()}/contacts/import`);
  await pick(page, { name: 'sample-untyped.csv', mimeType: '', buffer: csvFile(SMALL) });
  await expect.poll(() => mock.callsOf('completeImportUpload').length, { timeout: 60_000 }).toBe(2);
  expect(['text/csv', 'application/csv'], 'a .csv with no browser type was not declared as CSV').toContain((mock.callsOf('createImport')[1]?.body as { contentType: string }).contentType);

  await page.goto(`${importUrl()}/contacts/import`);
  const puts = mock.partPuts.length;
  await pick(page, { name: 'sample-book.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK\u0003\u0004fixture') });
  await expectRefusal(page, errorLabels('unsupported_type'), 'an .xlsx (unsupported_type)');
  expect(mock.partPuts.length, 'an .xlsx was uploaded').toBe(puts);
});

test('pause stops new parts; resume carries on the same upload without re-sending a finished part @p28-import @p28-import-pause', async ({ page }) => {
  const mock = await openImport(page, { holdParts: true });
  const file = csv(FOUR_PARTS);
  await pick(page, file);
  await expect.poll(() => mock.inFlight(), { message: 'no part was uploaded' }).toBeGreaterThan(0);
  await byTestId(page, 'upload-pause').click();
  await expect(progress(page)).toHaveAttribute('data-upload-state', 'paused');
  const startedBeforePause = new Set(mock.partPuts.map((put) => put.partNumber));
  expect(startedBeforePause.size, 'every part had started before pause: pausing proves nothing (at most two in flight)').toBeLessThan(4);
  const pausedAt = Date.now();
  mock.releaseParts();
  await expect.poll(() => mock.inFlight(), { message: 'a part is still open while paused' }).toBe(0);
  await expect(progress(page)).toHaveAttribute('data-upload-state', 'paused');
  expect(Number(await progress(page).getAttribute('aria-valuenow')), 'a paused upload claims to be complete').toBeLessThan(100);
  await expect(byTestId(page, 'upload-resume')).toBeVisible();
  await expectNoSeriousAxe(page, 'the paused upload');
  const resumedAt = Date.now();
  expect(mock.partPuts.filter((put) => put.at > pausedAt && put.at < resumedAt).map((put) => put.partNumber), 'a part was uploaded while paused').toEqual([]);

  await byTestId(page, 'upload-resume').click();
  await expect.poll(() => mock.callsOf('completeImportUpload').length, { timeout: 90_000 }).toBe(1);
  expect(mock.callsOf('createImport').length, 'resume started a new upload').toBe(1);
  expect(mock.callsOf('abortImportUpload'), 'pause aborted the upload').toEqual([]);
  expect(sha256(mock.assembled(mock.created()[0] ?? '')), 'the resumed upload is not the file').toBe(sha256(file.buffer));
  expect(mock.maxInFlight()).toBeLessThanOrEqual(2);
});

test('a part that fails once is retried and the upload completes @p28-import @p28-import-retry', async ({ page }) => {
  const mock = await openImport(page, { failPartOnce: 2 });
  const file = csv(TWO_PARTS);
  await pick(page, file);
  await expect.poll(() => mock.callsOf('completeImportUpload').length, { timeout: 90_000 }).toBe(1);
  expect(mock.partPuts.filter((put) => put.partNumber === 2).map((put) => put.outcome)).toEqual(['failed', 'ok']);
  expect(mock.partPuts.filter((put) => put.partNumber === 1).length, 'part 1 was sent again').toBe(1);
  expect(sha256(mock.assembled(mock.created()[0] ?? ''))).toBe(sha256(file.buffer));
});

test('a part that keeps failing ends in a translated failure after a bounded number of tries, and nothing is completed @p28-import @p28-import-retry', async ({ page }) => {
  const mock = await openImport(page, { failPartAlways: 2 });
  await pick(page, csv(TWO_PARTS));
  await expect(progress(page)).toHaveAttribute('data-upload-state', 'failed', { timeout: 90_000 });
  await expect(byTestId(page, 'import-error')).toBeVisible();
  expect(await visibleText(byTestId(page, 'import-error')), 'the failure prints a raw code').not.toMatch(/\b[a-z]+_[a-z_]+\b|InternalError|<Error>/);
  const tries = mock.partPuts.filter((put) => put.partNumber === 2).length;
  expect(tries, 'the failing part was never retried').toBeGreaterThanOrEqual(2);
  expect(tries, 'the failing part was retried without bound').toBeLessThanOrEqual(5);
  expect(mock.callsOf('completeImportUpload'), 'an upload with a missing part was completed').toEqual([]);
});

test('an expired part URL is re-issued for the parts still to upload, and only the new URL is used @p28-import @p28-import-expiry', async ({ page }) => {
  const mock = await openImport(page, { expireFromPart: 2 });
  const file = csv(TWO_PARTS);
  await pick(page, file);
  await expect.poll(() => mock.callsOf('completeImportUpload').length, { timeout: 90_000 }).toBe(1);
  const reissues = mock.callsOf('issueImportUploadUrls').map((call) => (call.body as { partNumbers: number[] }).partNumbers);
  expect(reissues.length, 'the expired URL was never re-issued').toBeGreaterThan(0);
  expect(reissues.flat(), 'a re-issue asked for a part that had already landed').not.toContain(1);
  expect(reissues.flat()).toContain(2);
  expect(mock.partPuts.filter((put) => put.partNumber === 1).length).toBe(1);
  expect(mock.partPuts.filter((put) => put.partNumber === 2).map((put) => put.outcome).at(-1)).toBe('ok');
  expect(mock.callsOf('createImport').length, 'an expired URL started the upload over').toBe(1);
  expect(sha256(mock.assembled(mock.created()[0] ?? ''))).toBe(sha256(file.buffer));
});

test('cancelling an upload aborts it (no body), stops the parts and offers a new file @p28-import @p28-import-abort', async ({ page }) => {
  const mock = await openImport(page, { holdParts: true });
  await pick(page, csv(TWO_PARTS));
  await expect.poll(() => mock.inFlight()).toBeGreaterThan(0);
  await byTestId(page, 'upload-cancel').click();
  await expect.poll(() => mock.callsOf('abortImportUpload').length, { message: 'cancel did not abort the upload' }).toBe(1);
  mock.releaseParts();
  await expect.poll(() => mock.inFlight()).toBe(0);
  expect(mock.job(mock.created()[0] ?? '')?.status).toBe('cancelled');
  expect(mock.callsOf('completeImportUpload')).toEqual([]);
  await expect(fileInput(page)).toBeEnabled();
  await expectStep(page, 'upload');
});

test('422 upload_mismatch is a translated message; starting over is a new declaration @p28-import @p28-import-mismatch', async ({ page }) => {
  const mock = await openImport(page, { mismatch: true });
  await pick(page, csv(SMALL));
  await expectRefusal(page, recordsError('upload_mismatch'), 'completeImportUpload 422 upload_mismatch');
  await expectStep(page, 'upload');
  await pick(page, csv(SMALL, 'sample-again.csv'));
  await expect.poll(() => mock.callsOf('createImport').length, { message: 'starting over did not declare the file again' }).toBe(2);
  expect(new Set(mock.created()).size).toBe(2);
});

test('the file is never read by script, never kept on the device, and no cell of it reaches the page @p28-import @p28-import-device', async ({ page }) => {
  const mock = await openImport(page);
  await upload(page, mock, csv(TWO_PARTS));
  await toMapping(page);
  await expectNoCellValue(page, 'the mapping step');
  expect(await windowList(page, '__kasuwaFileReads'), 'the page read the file’s bytes (no client-side parse or preview, D-P21)').toEqual([]);
  const stored = await deviceStorage(page);
  expect(stored.cachedApi, 'an API response was put in Cache Storage').toEqual([]);
  expect(stored.databases, 'an IndexedDB database was opened').toEqual([]);
  expect(stored.opfs, 'something was written to the origin-private file system').toEqual([]);
  for (const needle of [CELL_MARKER, FILENAME, 'signature=']) {
    expect(stored.dump.toLowerCase().includes(needle.toLowerCase()), `"${needle}" was written to device storage`).toBe(false);
  }
  await toPhones(page);
  await expectNoCellValue(page, 'the phones step');
});

test('signed part URLs and the filename never reach the console, the address bar, history, a link, the title or the API URL @p28-import @p28-import-secrets', async ({ page }) => {
  const consoleLines = await tap(page);
  const mock = await installImportMock(page, { expireFromPart: 2 });
  active = mock;
  await page.goto(`${importUrl()}/contacts/import`);
  await upload(page, mock, csv(TWO_PARTS));
  await toMapping(page);
  const leaks = (text: string) => text.includes('signature=') || text.includes(STORAGE_ORIGIN) || text.includes('storage.example');
  expect(consoleLines.filter(leaks), 'a signed part URL was logged').toEqual([]);
  expect(consoleLines.filter((line) => line.includes(FILENAME)), 'the filename was logged').toEqual([]);
  expect(leaks(await page.content()), 'a signed part URL is in the DOM').toBe(false);
  expect(page.url()).not.toContain(FILENAME);
  expect(await page.title()).not.toContain(FILENAME);
  for (const entry of await windowList(page, '__kasuwaHistory')) {
    expect(entry.includes(FILENAME) || leaks(entry), 'a history entry carries the filename or a part URL').toBe(false);
  }
  const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
  expect(hrefs.filter((href) => leaks(href) || href.includes(FILENAME)), 'a link carries a part URL or the filename').toEqual([]);
});

test('a header and a filename holding markup are drawn as text, never parsed @p28-import @p28-import-markup', async ({ page }) => {
  // A header is file content, and a filename is the user's: both are drawn as text.
  const hostileName = 'Sample<img src=x onerror="window.__kasuwaXss=2">fixture.csv';
  const mock = await openImport(page, { hostileHeaders: true });
  await upload(page, mock, csv(SMALL, hostileName));
  await toMapping(page);
  const last = HEADERS.length - 1;
  await expect(shown(page.locator(`[data-map-column="${last}"]`)).first().locator('[data-record-text]').first()).toHaveText(HOSTILE_HEADER);
  expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss), 'markup from the file ran').toBeUndefined();
  await expect(screenOf(page).locator('img[src="x"], b:text-is("bold")'), 'markup from the file was parsed into elements').toHaveCount(0);
  await page.goto(`${importUrl()}/contacts/import`);
  const row = shown(page.locator(`[data-import-row="${mock.created()[0] ?? ''}"]`)).first();
  await expect(row.locator('[data-record-text]').filter({ hasText: hostileName }), 'the filename is not drawn as text in the history').toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss), 'markup in a filename ran').toBeUndefined();
});

// ===========================================================================
// Mapping (A2, A3)
// ===========================================================================

test('mapping: the server reads the header while the screen polls; every header is a row prefilled from the suggestion; only ImportField choices, translated @p28-import @p28-import-mapping', async ({ page }) => {
  const mock = await openImport(page, { headerPolls: 2 });
  const id = await upload(page, mock);
  await toMapping(page);
  expect(mock.polls.filter((poll) => poll.importId === id && poll.phase === 'header').length, 'the mapping was drawn before the header was read').toBeGreaterThanOrEqual(3);
  await expect(shown(page.locator('[data-map-column]'))).toHaveCount(HEADERS.length);
  for (const [index, header] of HEADERS.entries()) {
    const row = shown(page.locator(`[data-map-column="${index}"]`)).first();
    await expect(row.locator('[data-record-text]').first(), `column ${index} does not show its header`).toHaveText(header);
    await expect(mapField(page, index), `column ${index} is not prefilled from the suggestion`).toHaveValue(SUGGESTED[index] ?? '');
    const options = await mapField(page, index)
      .locator('option')
      .evaluateAll((items) => items.map((item) => ({ value: (item as HTMLOptionElement).value, text: (item.textContent ?? '').trim(), disabled: (item as HTMLOptionElement).disabled })));
    const values = options.map((option) => option.value);
    expect(values.filter((value) => value !== '' && !IMPORT_FIELDS.includes(value)), `column ${index} offers a field ImportField does not have`).toEqual([]);
    expect(values.filter((value) => NEVER_MAPPABLE.includes(value)), `column ${index} offers a field no column may set`).toEqual([]);
    expect(values, `column ${index} offers no "do not import"`).toContain('');
    expect([...IMPORT_FIELDS].filter((field) => !values.includes(field)), `column ${index} withholds a field the caller may edit`).toEqual([]);
    for (const option of options.filter((entry) => entry.value !== '')) {
      expect(option.text, `the ${option.value} choice is its api name, not a label`).not.toBe(option.value);
    }
  }
  expect(await copyText(screenOf(page)), 'the overruled mapping design is drawn').not.toMatch(/sample values|create a new field|save as template|new text field/i);
  await expectNoCellValue(page, 'the mapping');

  await mapField(page, 6).selectOption('tags');
  await mapField(page, 3).selectOption('');
  await toPhones(page);
  await start(page);
  await expect.poll(() => mock.callsOf('runImport').length, { timeout: 30_000 }).toBe(1);
  const sent = sentFields(lastMapping(mock).columns);
  const expected = Object.fromEntries(SUGGESTED.map((field, index) => [index, field] as const).filter((entry): entry is readonly [number, string] => entry[1] !== null));
  expected[6] = 'tags';
  delete expected[3];
  expect(sent, 'the saved mapping is not what the screen showed').toEqual(expected);
  expect([null, CALLER_ID], 'an owner other than the caller was chosen (there is no user directory, D-L64)').toContain(lastMapping(mock).ownerUserId ?? null);
});

test('the checklist requires a name only, and blocks Continue until displayName or a name part is mapped @p28-import @p28-import-required', async ({ page }) => {
  const mock = await openImport(page, { scenario: 'noName' });
  await upload(page, mock);
  await byTestId(page, 'import-continue').click();
  await expectStep(page, 'mapping');
  const checklist = byTestId(page, 'import-required');
  await expect(checklist).toBeVisible();
  const items = await checklist.locator('[data-required]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-required')));
  expect(items, 'the checklist requires something other than a name (phone, email and last name are not required)').toEqual(['displayName']);
  const item = checklist.locator('[data-required="displayName"]');
  await expect(item).toHaveAttribute('data-met', 'false');
  expect(await isDisabled(byTestId(page, 'import-continue')), 'Continue is enabled with no name mapped').toBe(true);
  expect(await copyText(screenOf(page)), 'the overruled requirements are drawn').not.toMatch(/last name is required|needed: last name|phone or email/i);

  await mapField(page, 1).selectOption('familyName');
  await expect(item).toHaveAttribute('data-met', 'true');
  expect(await isDisabled(byTestId(page, 'import-continue'))).toBe(false);
  await mapField(page, 1).selectOption('');
  await expect(item).toHaveAttribute('data-met', 'false');
  await mapField(page, 1).selectOption('givenNames');
  await expect(item).toHaveAttribute('data-met', 'true');
  await toPhones(page);
  await start(page);
  await expect.poll(() => mock.callsOf('runImport').length, { timeout: 30_000 }).toBe(1);
  expect(sentFields(lastMapping(mock).columns)).toEqual({ 0: 'phones', 1: 'givenNames' });
  expect(NAME_FIELDS).toContain('givenNames');
});

test('a non-repeatable field mapped twice never runs; phones, emails and tags may repeat @p28-import @p28-import-duplicate-mapping', async ({ page }) => {
  const mock = await openImport(page);
  await upload(page, mock);
  await toMapping(page);
  await mapField(page, 6).selectOption('status');
  const next = byTestId(page, 'import-continue');
  // Either the screen blocks it (Continue disabled), or the API refuses it and
  // the screen is back on the mapping step with the translated reason.
  if (!(await isDisabled(next))) {
    await next.click();
    if ((await currentStep(page)) === 'phones') await start(page);
    await expectRefusal(page, errorLabels('duplicate_mapping'), 'a repeated field (duplicate_mapping)');
  }
  expect(mock.callsOf('runImport'), 'an import ran with a field mapped twice').toEqual([]);
  await expectStep(page, 'mapping');
  await mapField(page, 6).selectOption('phones');
  await toPhones(page);
  await start(page);
  await expect.poll(() => mock.callsOf('runImport').length, { timeout: 30_000 }).toBe(1);
  const phones = (lastMapping(mock).columns ?? []).filter((column) => column.field === 'phones').map((column) => column.index);
  expect(phones.sort(), 'phones mapped from two columns were not both sent').toEqual([2, 6]);
});

test('reuse a previous import’s mapping: only imports whose headers still exist are offered; fromImportId is sent and its mapping shown @p28-import @p28-import-reuse', async ({ page }) => {
  const mock = await openImport(page);
  await upload(page, mock);
  await toMapping(page);
  const reuse = byTestId(page, 'import-reuse');
  await expect(reuse).toBeVisible();
  const offered = await reuse.locator('option').evaluateAll((items) => items.map((item) => ({ value: (item as HTMLOptionElement).value, text: (item.textContent ?? '').trim() })));
  const ids = offered.map((option) => option.value).filter((value) => value !== '');
  expect(ids, 'the import being mapped is offered as its own template').not.toContain(mock.created()[0]);
  expect(ids, 'the finished import is not offered').toContain(String(H_FINISHED.id));
  for (const erased of [H_ERASED, H_ERASED_ERRORS, H_FAILED]) {
    expect(ids, `an import whose headers are erased (${String(erased.status)}) is offered`).not.toContain(String(erased.id));
  }
  for (const option of offered) expect(option.text, 'a reuse choice prints an id').not.toMatch(UUID);
  expect(offered.find((option) => option.value === H_FINISHED.id)?.text, 'the reuse choice does not name its file').toContain(String(H_FINISHED.filename));

  await reuse.selectOption(String(H_FINISHED.id));
  await expect.poll(() => mock.callsOf('putImportMapping').length, { message: 'choosing a previous import sent nothing' }).toBe(1);
  const body = lastMapping(mock);
  expect(body.fromImportId).toBe(H_FINISHED.id);
  expect(body.columns, 'fromImportId and columns were both sent').toBeUndefined();
  for (const [index, header] of HEADERS.entries()) {
    await expect(mapField(page, index), `column ${index} does not show the reused mapping`).toHaveValue(REUSED_MAPPING[header] ?? '');
  }
});

test('a previous import that can no longer be reused is a translated unknown_reference, and the mapping is unchanged @p28-import @p28-import-reuse', async ({ page }) => {
  const mock = await openImport(page, { reuseRefused: true });
  await upload(page, mock);
  await toMapping(page);
  await byTestId(page, 'import-reuse').selectOption(String(H_FINISHED.id));
  await expectRefusal(page, errorLabels('unknown_reference'), 'fromImportId 400 unknown_reference');
  for (const index of HEADERS.keys()) await expect(mapField(page, index)).toHaveValue(SUGGESTED[index] ?? '');
});

test('403 field_not_editable: the field is translated, offered no more and never sent again @p28-import @p28-import-read-only', async ({ page }) => {
  const mock = await openImport(page, { notEditable: ['status'] });
  await throughToPhones(page, mock);
  await start(page);
  await expectRefusal(page, errorLabels('field_not_editable'), 'putImportMapping 403 field_not_editable');
  await expectStep(page, 'mapping');
  for (const index of HEADERS.keys()) {
    const open = await mapField(page, index)
      .locator('option[value="status"]')
      .evaluateAll((items) => items.filter((item) => !(item as HTMLOptionElement).disabled).length);
    expect(open, `column ${index} still offers status after the 403`).toBe(0);
    expect(await mapField(page, index).inputValue(), `column ${index} is still mapped to status`).not.toBe('status');
  }
  await toPhones(page);
  await start(page);
  await expect.poll(() => mock.callsOf('runImport').length, { timeout: 30_000 }).toBe(1);
  expect(Object.values(sentFields(lastMapping(mock).columns))).not.toContain('status');
});

test('compliance mapping is shown as restrict-only while a compliance field is mapped (D-P28) @p28-import @p28-import-compliance', async ({ page }) => {
  const mock = await openImport(page, { scenario: 'noName' });
  await upload(page, mock);
  await byTestId(page, 'import-continue').click();
  await expectStep(page, 'mapping');
  await expect(shown(page.getByTestId('import-compliance')), 'the compliance note shows with no compliance field mapped').toHaveCount(0);
  for (const field of COMPLIANCE_FIELDS) {
    await expect(mapField(page, 2).locator(`option[value="${field}"]`), `${field} is not offered`).toHaveCount(1);
  }
  await mapField(page, 2).selectOption('consentState');
  const note = byTestId(page, 'import-compliance');
  await expect(note).toBeVisible();
  await expectSaysOneOf(note, labels(['import'], ['.restrict_only', '.restrictOnly']), 'the restrict-only note');
  expect(await visibleText(note), 'the note promises the most recent choice (D-P28 is most restrictive)').not.toMatch(/most recent|latest|overwrite|opt(s|ed)? (them )?in\b/i);
});

// ===========================================================================
// Phones and duplicates (A4)
// ===========================================================================

test('A4: the default country is NG, GH, KE or ZA and is sent; the duplicate rule is in words; no preview and no overruled rule @p28-import @p28-import-phones', async ({ page }) => {
  const mock = await openImport(page);
  await throughToPhones(page, mock);
  const country = byTestId(page, 'import-country');
  const values = await country.locator('option').evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value));
  expect([...values].sort(), 'the countries are not exactly NG, GH, KE and ZA').toEqual([...DEFAULT_COUNTRIES].sort());
  expect(DEFAULT_COUNTRIES).toContain(await country.inputValue());
  const texts = await country.locator('option').evaluateAll((items) => items.map((item) => (item.textContent ?? '').trim()));
  for (const text of texts) expect(text, 'a country is shown as its bare code').not.toMatch(/^[A-Z]{2}$/);
  await country.selectOption('KE');

  const rule = byTestId(page, 'import-duplicate-rule');
  await expect(rule).toBeVisible();
  await expectSaysOneOf(rule, labels(['import'], ['.duplicate_rule', '.duplicateRule']), 'the duplicate rule');
  await expect(rule.locator('input, select, [role="switch"], [role="radio"], [role="checkbox"]'), 'the duplicate rule offers a choice').toHaveCount(0);
  const copy = await copyText(screenOf(page));
  expect(copy, 'the name-and-date-of-birth rule is drawn (D-P12)').not.toMatch(/date of birth|birthday|\bdob\b/i);
  expect(copy, 'the on-match choices are drawn').not.toMatch(/fill in empty|overwrite|create a new record anyway|keep the last/i);
  expect(copy, 'a before-and-after phone preview is drawn').not.toMatch(/in your file|saved as|can['’]t (be )?read|numbers we can/i);
  await expectNoCellValue(page, 'A4');

  await start(page);
  await expect.poll(() => mock.callsOf('runImport').length, { timeout: 30_000 }).toBe(1);
  expect(lastMapping(mock).defaultCountry, 'the chosen country was not sent').toBe('KE');
});

// ===========================================================================
// The run (A5)
// ===========================================================================

test('the run: sent once with no body, polled with backoff, live counts in a polite live region, then the report; polling stops @p28-import @p28-import-run', async ({ page }) => {
  const mock = await openImport(page, { holdPoll: 4 });
  const id = await throughToPhones(page, mock);
  await byTestId(page, 'import-start').dblclick();
  await expect.poll(() => mock.callsOf('runImport').length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expectStep(page, 'run');
  await expect.poll(() => mock.polls.filter((poll) => poll.importId === id && poll.phase === 'run').length, { timeout: 60_000 }).toBe(4);

  // Poll 4 is held: the screen shows poll 3's counts, live.
  const live = byTestId(page, 'import-progress');
  await expect(live).toBeVisible();
  expect(
    await live.evaluate((element) => element.getAttribute('role') === 'status' || ['polite', 'assertive'].includes(element.getAttribute('aria-live') ?? '')),
    'the progress is not a live region',
  ).toBe(true);
  await expectCounts(page, { created: 480, skipped: 1, failed: 2 }, 'while running');
  await expect(live.locator('[data-count="created"]')).toHaveCount(1);
  await expect(byTestId(page, 'import-cancel')).toBeVisible();
  mock.releasePoll();

  await expect(jobView(page)).toHaveAttribute('data-import-status', 'finished', { timeout: 60_000 });
  await expectCounts(page, FINISHED_EXAMPLE.counts as { created: number; skipped: number; failed: number }, 'the report');
  await expect(shown(page.getByTestId('import-cancel')), 'cancel is offered on a finished import').toHaveCount(0);
  await expectNoSeriousAxe(page, 'the report after a run');

  const times = mock.polls.filter((poll) => poll.importId === id && poll.phase === 'run').map((poll) => poll.at);
  const gaps = times.slice(1, 4).map((time, index) => time - (times[index] ?? time));
  expect(gaps.length).toBe(3);
  for (const gap of gaps) {
    expect(gap, 'a poll followed the last within 400 ms: that is a loop, not a backoff').toBeGreaterThanOrEqual(400);
    expect(gap, 'a poll waited over 20 s: the counts are not live').toBeLessThanOrEqual(20_000);
  }
  expect(gaps[2] ?? 0, `the interval does not grow (${gaps.join(', ')} ms)`).toBeGreaterThanOrEqual(1.4 * Math.min(gaps[0] ?? 0, gaps[1] ?? 0));
  expect(mock.callsOf('runImport').length, 'a double click ran the import twice').toBe(1);
  expect(times.length, 'the screen kept polling after the import ended').toBeLessThanOrEqual(6);
});

test('a failed poll is retried and the run still reaches its report @p28-import @p28-import-poll-failure', async ({ page }) => {
  const mock = await openImport(page, { failPolls: [2] });
  await throughToPhones(page, mock);
  await start(page);
  await expect(jobView(page)).toHaveAttribute('data-import-status', 'finished', { timeout: 90_000 });
  await expectCounts(page, FINISHED_EXAMPLE.counts as { created: number; skipped: number; failed: number }, 'the report after a dropped poll');
});

test('cancel: sent with no body while running; the import ends cancelled and the contacts already created are counted @p28-import @p28-import-cancel', async ({ page }) => {
  const mock = await openImport(page, { holdPoll: 3 });
  const id = await throughToPhones(page, mock);
  await start(page);
  await expect.poll(() => mock.polls.filter((poll) => poll.importId === id && poll.phase === 'run').length, { timeout: 60_000 }).toBe(3);
  await expectCounts(page, { created: 120, skipped: 0, failed: 1 }, 'running');
  await byTestId(page, 'import-cancel').click();
  await expect.poll(() => mock.callsOf('cancelImport').length, { message: 'cancel sent nothing' }).toBe(1);
  mock.releasePoll();
  await expect(jobView(page)).toHaveAttribute('data-import-status', 'cancelled', { timeout: 60_000 });
  await expectSaysOneOf(jobView(page), statusLabels('cancelled'), 'the cancelled status');
  await expectCounts(page, { created: 120, skipped: 0, failed: 1 }, 'the cancelled report');
  await expect(shown(page.getByTestId('import-cancel'))).toHaveCount(0);
});

test('409 import_status_conflict on run is translated and the job is read again @p28-import @p28-import-conflict', async ({ page }) => {
  const mock = await openImport(page, { runConflict: true });
  const id = await throughToPhones(page, mock);
  await start(page);
  await expectRefusal(page, recordsError('import_status_conflict'), 'runImport 409 import_status_conflict');
  const conflictAt = mock.callsOf('runImport')[0]?.at ?? 0;
  await expect.poll(() => mock.polls.filter((poll) => poll.importId === id && poll.at >= conflictAt).length, { message: 'the job was not read again after the 409' }).toBeGreaterThan(0);
});

// ===========================================================================
// The report (A6)
// ===========================================================================

test('the report: counts and { row, column, code } rows only, translated, with header names; the D-L151 note; the Contacts link by importId @p28-import @p28-import-report', async ({ page }) => {
  await openImport(page);
  await openFromHistory(page, String(H_FINISHED.id));
  await expect(jobView(page)).toHaveAttribute('data-import-status', 'finished');
  await expectCounts(page, H_FINISHED.counts as { created: number; skipped: number; failed: number }, 'the finished report');
  const errors = H_FINISHED.errors as { row: number; column: number | null; code: string }[];
  const headers = H_FINISHED.headers as string[];
  const rows = shown(page.locator('[data-row-error]'));
  await expect(rows).toHaveCount(errors.length);
  for (const [index, error] of errors.entries()) {
    const row = rows.nth(index);
    await expect(row.locator('[data-error-row]')).toHaveText(new RegExp(`\\b${error.row}\\b`));
    await expect(row.locator(`[data-error-code="${error.code}"]`), `row ${error.row} is not ${error.code}, in served order`).toHaveCount(1);
    await expectSaysOneOf(row.locator('[data-error-code]').first(), errorLabels(error.code), `the ${error.code} label`);
    const column = await visibleText(row.locator('[data-error-column]').first());
    if (error.column === null) {
      expect(column, 'a whole-row error names a column').not.toMatch(new RegExp(headers.join('|')));
      expect(column, 'a whole-row error prints null').not.toMatch(/null|undefined|NaN/);
      await expectSaysOneOf(row.locator('[data-error-column]').first(), labels(['import'], ['.whole_row', '.wholeRow']), 'the whole-row label');
    } else {
      expect(column, `row ${error.row}'s column is not its header`).toContain(headers[error.column] ?? '<none>');
    }
    expect(await visibleText(row), 'a row prints a raw code').not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  }
  const headings = await screenOf(page).locator('th, [role="columnheader"]').evaluateAll((cells) => cells.map((cell) => (cell.textContent ?? '').trim()));
  expect(headings.filter((text) => /^(value|sample|in (your|the) file)$/i.test(text)), 'the report has a value column').toEqual([]);
  await expect(shown(page.getByTestId('import-errors-truncated')), 'a complete list says it was truncated').toHaveCount(0);
  const note = byTestId(page, 'import-result-note');
  await expectSaysOneOf(note, labels(['import'], ['.duplicates_skipped', '.duplicatesSkipped']), 'duplicates were skipped (D-L151)');
  await expectSaysOneOf(note, labels(['import'], ['.no_restriction', '.noRestriction', '.no_restriction_applied', '.noRestrictionApplied']), 'no restriction was applied to existing contacts (D-L151)');
  await expect(byTestId(page, 'import-contacts-link')).toHaveAttribute('href', `/contacts?importId=${String(H_FINISHED.id)}`);
  await expectNoIdsPrinted(page, 'the report');

  await page.goto(`${importUrl()}/contacts/import`);
  await openFromHistory(page, String(H_TRUNCATED.id));
  await expect(byTestId(page, 'import-errors-truncated'), 'a truncated list does not say so').toBeVisible();
  await expectSaysOneOf(byTestId(page, 'import-errors-truncated'), labels(['import', 'truncated'], ['']), 'the truncation note');
});

test('the Contacts link lands on the list filtered by importId @p28-import @p28-import-contacts-filter', async ({ page }) => {
  const mock = await openImport(page);
  await openFromHistory(page, String(H_FINISHED.id));
  await byTestId(page, 'import-contacts-link').click();
  await expect(page).toHaveURL(/\/contacts\?importId=/);
  await expect
    .poll(() => mock.contactReads.some((url) => url.searchParams.get('importId') === H_FINISHED.id), { message: 'the Contacts list did not send importId: unfiltered rows would look filtered (D-L75)' })
    .toBe(true);
});

test('no download of bad rows, no log download, no undo, no retry of failed rows, no "updated" count @p28-import @p28-import-no-download', async ({ page }) => {
  await openImport(page);
  for (const id of [String(H_FINISHED.id), String(H_TRUNCATED.id)]) {
    await page.goto(`${importUrl()}/contacts/import`);
    await openFromHistory(page, id);
    const root = screenOf(page);
    await expect(root.locator('a[download], a[href^="blob:"], a[href^="data:"]'), 'a download link is drawn').toHaveCount(0);
    expect(await copyText(root), 'a download, undo or retry is offered (D-L128 Q6)').not.toMatch(/download|export|\bundo\b|roll ?back|retry failed|error rows|bad rows/i);
    await expect(root.locator('[aria-hidden="true"]', { hasText: /^\s*(download|undo|replay)\s*$/ }), 'a download or undo icon is drawn').toHaveCount(0);
    const counted = await jobView(page).locator('[data-count]').evaluateAll((items) => items.map((item) => item.getAttribute('data-count')));
    expect(counted.filter((name) => !['created', 'skipped', 'failed'].includes(name ?? '')), 'the report counts something the contract does not ("updated")').toEqual([]);
    expect(await copyText(jobView(page)), 'the report has an "updated" count').not.toMatch(/\bupdated\b/i);
  }
  expect(await windowList(page, '__kasuwaObjectUrls'), 'an object URL was made (a client-side file)').toEqual([]);
});

test('a failed import is a translated failed report that keeps its counts @p28-import @p28-import-failed', async ({ page }) => {
  await openImport(page);
  await openFromHistory(page, String(H_FAILED.id));
  await expect(jobView(page)).toHaveAttribute('data-import-status', 'failed');
  await expectSaysOneOf(jobView(page), statusLabels('failed'), 'the failed status');
  await expectCounts(page, H_FAILED.counts as { created: number; skipped: number; failed: number }, 'the failed report');
  expect(await visibleText(jobView(page)), 'a failed import says it finished').not.toContain(statusLabels('finished')[0] ?? '<no finished label>');
});

// ===========================================================================
// History and erased imports
// ===========================================================================

test('the history lists past imports as served, with translated statuses, programme names and counts, and opens each @p28-import @p28-import-history', async ({ page }) => {
  const mock = await openImport(page);
  await expect.poll(() => mock.callsOf('listImports').length).toBeGreaterThan(0);
  const ids = await shown(page.locator('[data-import-row]')).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-import-row')));
  expect(ids, 'the history is not the served list, in served order').toEqual(HISTORY.map((entry) => String(entry.id)));
  for (const entry of HISTORY) {
    const row = shown(page.locator(`[data-import-row="${String(entry.id)}"]`)).first();
    await expectSaysOneOf(row, statusLabels(String(entry.status)), `the ${String(entry.status)} status`);
    await expect(row, 'a history row does not name its programme').toContainText(PROGRAMME_ONE.name);
    await expect(row, 'a history row does not show its created count').toContainText(formatted((entry.counts as { created: number }).created));
    if (entry.filename !== null) await expect(row.locator('[data-record-text]').filter({ hasText: String(entry.filename) })).toHaveCount(1);
  }
  for (const status of IMPORT_STATUSES) {
    expect(statusLabels(status).length, `en.json has no label for the ${status} status`).toBeGreaterThan(0);
  }
  await expectNoIdsPrinted(page, 'the history');
  await openFromHistory(page, String(H_CANCELLED.id));
  await expect(jobView(page)).toHaveAttribute('data-import-status', 'cancelled');
});

test('an erased import (filename and headers null) has a neutral label, never "null", and its errors name columns by position @p28-import @p28-import-erased', async ({ page }) => {
  await openImport(page);
  for (const entry of [H_ERASED, H_ERASED_ERRORS, H_FAILED]) {
    const row = shown(page.locator(`[data-import-row="${String(entry.id)}"]`)).first();
    await expect(row).toHaveAttribute('data-erased', 'true');
    const text = await visibleText(row);
    expect(text, 'an erased row prints null or undefined').not.toMatch(/\bnull\b|\bundefined\b/);
    await expectSaysOneOf(row, [...labels(['import', 'erased'], ['']), ...labels(['import', 'deleted'], [''])], 'the erased-file label');
  }
  for (const entry of [H_FINISHED, H_CANCELLED]) {
    await expect(shown(page.locator(`[data-import-row="${String(entry.id)}"]`)).first()).not.toHaveAttribute('data-erased', 'true');
  }
  await openFromHistory(page, String(H_ERASED_ERRORS.id));
  const rows = shown(page.locator('[data-row-error]'));
  await expect(rows).toHaveCount(2);
  const positioned = await visibleText(rows.nth(1).locator('[data-error-column]').first());
  expect(positioned, 'with the headers erased, column index 6 is not shown as the 7th column (7 or G)').toMatch(/\b7\b|\bG\b/);
  expect(positioned).not.toMatch(/null|undefined|NaN/);
  expect(await visibleText(rows.nth(0).locator('[data-error-column]').first())).not.toMatch(/null|undefined|NaN|\b7\b/);
  await expectSaysOneOf(rows.nth(0).locator('[data-error-code]').first(), errorLabels('possible_duplicate'), 'possible_duplicate');
});

// ===========================================================================
// Accessibility, 360 px, en-XA
// ===========================================================================

test('every step is axe-clean, the step list moves aria-current, and the upload progress is a named progressbar @p28-import @p28-import-axe', async ({ page }) => {
  const mock = await openImport(page, { holdPoll: 2 });
  await expectNoSeriousAxe(page, 'the landing (upload and history)');
  const id = await upload(page, mock);
  await expect(progress(page)).toHaveAccessibleName(/\S/);
  await expectNoSeriousAxe(page, 'the finished upload');
  await toMapping(page);
  await expectNoSeriousAxe(page, 'the mapping step');
  for (const index of HEADERS.keys()) await expect(mapField(page, index), `the select for column ${index} has no name`).toHaveAccessibleName(/\S/);
  await expect(byTestId(page, 'import-reuse')).toHaveAccessibleName(/\S/);
  await toPhones(page);
  await expect(byTestId(page, 'import-country')).toHaveAccessibleName(/\S/);
  await expectNoSeriousAxe(page, 'the phones step');
  await start(page);
  await expectStep(page, 'run');
  await expect.poll(() => mock.polls.filter((poll) => poll.importId === id && poll.phase === 'run').length, { timeout: 60_000 }).toBe(2);
  await expectNoSeriousAxe(page, 'the running import');
  mock.releasePoll();
  await expect(jobView(page)).toHaveAttribute('data-import-status', 'finished', { timeout: 60_000 });
  await expectNoSeriousAxe(page, 'the report');
});

test('at 360px the upload, the mapping and the report fit without sideways scroll and pass axe @p28-import @p28-import-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const mock = await openImport(page);
  expect(await overflow(page), 'the upload step scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P28 upload at 360px');
  await upload(page, mock);
  await toMapping(page);
  expect(await overflow(page), 'the mapping scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P28 mapping at 360px');
  await page.goto(`${importUrl()}/contacts/import`);
  await openFromHistory(page, String(H_FINISHED.id));
  expect(await overflow(page), 'the report scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P28 report at 360px');
  await expectNoIdsPrinted(page, 'the 360px report');
});

test('locale=en-XA renders every string of the upload, the mapping and the report as pseudo text, record data excepted @p28-import @p28-import-pseudo', async ({ page }) => {
  const mock = await openImport(page, {}, '?locale=en-XA');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  // Option text cannot hold markup, so a reuse choice ("<filename> · <date>") is checked by what it contains.
  const records = [...HISTORY.map((entry) => entry.filename).filter((name): name is string => typeof name === 'string'), PROGRAMME_ONE.name, PROGRAMME_TWO.name];
  const report = (scope: Locator) =>
    scope.evaluate((element, [servedJson, recordNames]) => {
      const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
      const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
      const recordish = (text: string) => servedJson.includes(text) || servedJson.includes(JSON.stringify(text).slice(1, -1));
      const skipped = (node: Element | null) => node === null || node.closest('[aria-hidden="true"], [data-testid^="language-"], script, style, noscript, time, kbd') !== null;
      const english: string[] = [];
      const forged: string[] = [];
      let pseudoCount = 0;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = (node.textContent ?? '').trim();
        const parent = node.parentElement;
        if (!letters(text) || skipped(parent)) continue;
        if (parent?.closest('[data-record-text]')) {
          if (!recordish(text)) forged.push(text);
          continue;
        }
        if (parent?.closest('option') && (recordish(text) || recordNames.some((name) => text.includes(name)))) continue;
        if (pseudo(text)) pseudoCount += 1;
        else english.push(text);
      }
      for (const node of Array.from(element.querySelectorAll('[placeholder], [aria-label], [title]'))) {
        if (skipped(node)) continue;
        for (const name of ['placeholder', 'aria-label', 'title']) {
          const value = node.getAttribute(name);
          if (value !== null && letters(value) && !pseudo(value)) english.push(`${name}="${value}"`);
        }
      }
      return { english, forged, pseudoCount };
    }, [servedData(), records] as const);

  const landing = await report(page.locator('[data-shell="crm"]'));
  expect(landing.english, 'strings on the landing that did not come through i18n').toEqual([]);
  expect(landing.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
  expect(landing.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(8);
  await upload(page, mock);
  await toMapping(page);
  const mapping = await report(screenOf(page));
  expect(mapping.english, 'strings on the mapping step that did not come through i18n').toEqual([]);
  expect(mapping.forged).toEqual([]);
  const optionTexts = await mapField(page, 0).locator('option').evaluateAll((items) => items.map((item) => (item.textContent ?? '').trim()).filter((text) => text !== ''));
  expect(optionTexts.filter((text) => !PSEUDO.test(text)), 'field choices that did not come through i18n').toEqual([]);
  await page.goto(`${importUrl()}/contacts/import?locale=en-XA`);
  await openFromHistory(page, String(H_FINISHED.id));
  const result = await report(screenOf(page));
  expect(result.english, 'strings on the report that did not come through i18n').toEqual([]);
  expect(result.forged).toEqual([]);
  expect(NO_NAME_HEADERS.length).toBeGreaterThan(0);
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/contacts/import on the wire', () => {
  /**
   * WHY A PLACEHOLDER. The screen does not exist when this is written. The
   * builder reports two measurements and the lead pins IMPORT_BUDGET_BYTES
   * within 5% of them, at or under 255,000 (the acceptance suite's ceiling).
   * No CSV parser and no XLSX reader ship in the page (a non-goal), which is
   * why the ceiling is the search screen's and not the board's.
   */
  test('/contacts/import stays inside its transferred-byte budget on the production build @p28-import @p28-import-budget', async ({ page }) => {
    // No fake clock here: it replaces window.performance, so the first
    // contentful paint this measures would never be reported (D-L118).
    active = await installImportMock(page);
    const metrics = await measurePageLoad(page, `${importUrl()}/contacts/import`, 'default');
    const record = resolve(__dirname, '.artifacts', 'p28-import-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(record, `${JSON.stringify({ path: '/contacts/import', transferredBytes: metrics.transferredBytes, budget: IMPORT_BUDGET_BYTES }, null, 2)}\n`, 'utf8');
    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webImportUrl is not serving the production build').toBe(built);
    // A 404 page is small: a budget met by the not-found page measures nothing.
    await expect(screenOf(page)).toBeVisible();
    expect(IMPORT_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P28 the import screen', metrics.transferredBytes, IMPORT_BUDGET_BYTES);
  });

  test('/contacts/import paints within 5 s at 256 kbps and 300 ms @p28-import @p28-import-budget', async ({ page }) => {
    active = await installImportMock(page);
    const metrics = await measurePageLoad(page, `${importUrl()}/contacts/import`, 'low-bandwidth');
    await expect(screenOf(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});

/** Kept in the spec so a vocabulary the journeys rely on cannot drift silently from the mock's. */
test('the row-error and status vocabularies the journeys label are the contract’s @p28-import @p28-import-mock', () => {
  expect(ROW_ERROR_CODES).toContain('possible_duplicate');
  expect(ROW_ERROR_CODES).toContain('consent_grant_refused');
  expect(IMPORT_STATUSES).toEqual(['awaiting_upload', 'reading_header', 'awaiting_mapping', 'queued', 'running', 'finished', 'failed', 'rejected', 'cancelled', 'expired']);
  expect(COMPLIANCE_FIELDS).toEqual(['dnd', 'whatsappOptIn', 'consentState']);
});
