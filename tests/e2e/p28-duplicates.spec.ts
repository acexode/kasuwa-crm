import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack, type StackUrls } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import { installAdminMock } from './support/admin-mock';
import {
  A1,
  A2,
  AUDIT_ACTIONS,
  AUDIT_MERGED,
  B1,
  B2,
  C1,
  C2,
  C3,
  COMPLIANCE_FIELDS,
  COMPLIANCE_ORDER,
  CONSENT_STATES,
  H1,
  HISTORY_NAMES,
  HM_EXPIRED_ID,
  HM_OLD_ID,
  HM_OPEN_ID,
  HM_OTHER_ID,
  HM_UNDONE_ID,
  HOSTILE_COMPANY,
  HOSTILE_NAME,
  MATCH_ON,
  MERGES_CURSOR,
  MERGE_FIELDS,
  PII_VALUES,
  PROGRAMME_ONE,
  PROGRAMME_TWO,
  SETS_CURSOR,
  answerProblems,
  installAuditMock,
  installDuplicatesMock,
  mostRestrictive,
  servedData,
  type DuplicatesMock,
  type DuplicatesMockOptions,
} from './support/duplicates-mock';

/**
 * T-0097 — the P28 duplicates and merge screen (`docs/design/P28/`, frames C
 * and C1, and the merges history that is Phase 2's recycle bin, D-P27) at
 * `/contacts/duplicates` in the CRM shell, behind `crm_duplicates`, against
 * T-0093's contract (tag `duplicates`) as T-0095 serves it. Written by the
 * lead's QA agent BEFORE the screen exists;
 * `tests/acceptance/records-ui/duplicates-screen.acceptance.test.ts` runs this
 * file with `--grep @p28-duplicates` and reads every outcome by tag.
 * Decisions: D-P12, D-P14, D-P27, D-P28, D-L84, D-L146, D-L148, D-L151,
 * D-L162, D-L163, D-L165, D-L173. The rulings (I1–I17) are in the
 * acceptance suite's header.
 *
 * TAG RULE (D-L84). `@p28-duplicates` is the parent tag. Playwright's --grep
 * is a regular expression, so no other screen's tag may contain it, and it
 * contains no other screen's parent tag (`@p28-import` is T-0096's). Every
 * sub-tag here is `@p28-duplicates-<name>`.
 *
 * ---------------------------------------------------------------------------
 * THE WEB PROCESS
 *
 *   webUrl            — the default server, every flag at its default.
 *                       `/contacts/duplicates` must be a real 404 there. The
 *                       audit-log journey runs here too: the audit screen is
 *                       not behind crm_duplicates, because the API merges
 *                       whatever any web flag says (I13).
 *   webDuplicatesUrl  — NEW, published in the stack file by the builder's
 *                       change to `scripts/run-e2e.mjs`. `crm_duplicates`
 *                       RIDES ON THE RECORDS PROCESS (`webRecordsUrl`), so the
 *                       Contacts list that links the screen, and the contact
 *                       record the result links to, are served there. Every
 *                       other journey and the byte budget run here.
 *
 * EVERYTHING IS READ FROM THE BROWSER, AND MOCKED THERE
 *
 * Every journey installs `support/duplicates-mock.ts`. `afterEach` fails a
 * test in which the screen sent the API anything the contract (or the rules
 * in the mock's header) does not allow, or in which the mock answered
 * something its own contract rejects.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                        the CRM shell
 *   [data-screen="P28"]                       the duplicates screen root
 *   SETS (C)
 *     select[data-testid="duplicates-programme"]  native select, one option per
 *                                             session programme (value = id,
 *                                             text = name)
 *     [data-testid="duplicate-sets"]          the list of sets
 *       [data-duplicate-set]                  one per served set, in served
 *                                             order, with data-match-on =
 *                                             phone | email
 *         [data-duplicate-contact="<id>"]     one per contact; its name inside
 *                                             [data-record-text], or a withheld
 *                                             label (UI copy) when it is null
 *         input[type="checkbox"][data-duplicate-pick="<id>"]
 *                                             in a set of three or more: pick
 *                                             exactly two (pairwise, D-L146)
 *         [data-duplicate-review]             opens the merge (C1). Disabled
 *                                             (or aria-disabled) in a larger
 *                                             set until exactly two are picked
 *     [data-testid="duplicates-more"]         loads the next page; absent at
 *                                             the end
 *     [data-testid="duplicates-empty"]        no sets in the programme
 *     [data-testid="duplicates-throttled"]    the translated wait after a 429
 *     [data-testid="duplicates-retry"]        OPTIONAL: a retry, disabled until
 *                                             the Retry-After has passed
 *     [data-testid="duplicates-error"]        a translated refusal or failure,
 *                                             anywhere on the page
 *   MERGE (C1)
 *     [data-testid="merge-view"]              the side-by-side merge
 *     input[type="radio"][data-main="<id>"]   the main record (the survivor),
 *                                             one per side, one named group
 *     table[data-testid="merge-compare"]      the comparison: a <table> whose
 *                                             field rows have a row header
 *                                             (th[scope="row"] or rowheader)
 *       [data-merge-field="<field>"]          one row per MergeField drawn;
 *                                             data-withheld="true" when either
 *                                             side withholds it (no value is
 *                                             drawn); data-locked="true" when
 *                                             it is readable but not choosable
 *         input[type="radio"][data-merge-side="survivor|merged"]
 *                                             in a choosable row: a named group
 *                                             per field, pre-set from defaults
 *       [data-merge-compliance="dnd|whatsappOptIn|consentState"]
 *                                             a locked row; data-withheld="true"
 *                                             when withheld, else holding
 *         [data-compliance-value="<value>"]   the outcome, translated, the raw
 *                                             value in the attribute
 *     [data-testid="merge-compliance-note"]   "the most restrictive choice is
 *                                             kept" (D-P28)
 *     [data-testid="merge-submit"]            opens the confirm dialog
 *     [data-testid="merge-confirm"]           role="dialog" or "alertdialog",
 *                                             named, focus inside; holding
 *       [data-testid="merge-confirm-yes"] and [data-testid="merge-confirm-cancel"]
 *     [data-testid="merge-done"]              the result, holding
 *       a[data-testid="merge-survivor-link"]  href exactly /contacts/<survivorId>
 *       [data-testid="merge-undo"]            undo
 *       <time datetime="<undoUntil>">         the undo deadline
 *     [data-testid="merge-undone"]            after an undo
 *     [data-testid="merge-kept-edits"]        where survivorReverted is false
 *     [data-testid="merge-back"]              back to the sets
 *   HISTORY (the recycle bin, D-P27)
 *     [data-testid="merges-history"]          on the landing
 *       [data-merge-row="<id>"]               one per served merge, served
 *                                             order, data-merge-state = open |
 *                                             expired | undone
 *         [data-merge-undo]                   in an open row only
 *         [data-testid="merge-kept-edits"]    in an undone row whose
 *                                             survivorReverted is false
 *     [data-testid="merges-more"]             the next page; absent at the end
 *     [data-testid="merges-empty"]            no merges to show
 *   [data-record-text]                        record data (names, field
 *                                             values, programme names), never
 *                                             UI copy
 *   <time datetime>                           every date or time drawn
 *   The Contacts list links the screen: a[href="/contacts/duplicates"] where
 *   `crm_duplicates` is live.
 *
 * DESIGN AGAINST WHAT IS BUILT — WHERE THEY DISAGREE, WHAT IS BUILT WINS
 *
 *   Absent: "Matching rules", confidence, a match score and "Why they match"
 *   with the matched value (exact phone or email only, the value never
 *   served, D-P12); a "Found" date; "Merge 3 contacts" (pairwise); "Moves to
 *   the merged record" counts (the preview serves none); "Not duplicates"
 *   (no operation); "SMS consent keeps the most recent choice" (the most
 *   restrictive wins, whichever survives, D-P28); a "merged into" link on a
 *   merged-away contact (the contract exposes none: it is the one 404).
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P28"]';

/**
 * The /contacts/duplicates transferred-byte budget. PROVISIONAL: a 250,000-byte
 * placeholder under the 255,000 ceiling. The lead re-pins it within 5% of the
 * builder's first green measurement (D-L118), as for T-0109 and T-0096; until
 * then the acceptance suite's budget check fails by design.
 */
const DUPLICATES_BUDGET_BYTES = 250_000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const EN = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8')) as Record<string, string>;

/** The Retry-After the throttle journeys are given, in seconds. */
const RETRY_AFTER = 3;
/** Network and scheduling slack on a Retry-After measurement. */
const RETRY_SLACK_MS = 250;

// ---------------------------------------------------------------------------
// The mock, the wire and the clean-up
// ---------------------------------------------------------------------------

let active: DuplicatesMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults, 'the MOCK answered something its contract rejects (a mock bug, not the screen’s)').toEqual([]);
    expect(mock.violations, 'the screen sent the API something the contract or this screen’s rules do not allow').toEqual([]);
    if (mock.requests.length > 0) {
      const origin = new URL(duplicatesUrl()).origin;
      for (const url of mock.requests) {
        expect(url.origin, 'the duplicates API must be called same-origin, by a relative path').toBe(origin);
      }
    }
  }
});

function duplicatesUrl(): string {
  const urls = stack() as StackUrls & { webDuplicatesUrl?: string };
  if (typeof urls.webDuplicatesUrl !== 'string' || urls.webDuplicatesUrl === '') {
    throw new Error('the stack file has no webDuplicatesUrl: scripts/run-e2e.mjs starts no web process with crm_duplicates on (see the header of p28-duplicates.spec.ts)');
  }
  return urls.webDuplicatesUrl;
}

/** Console lines and history writes, recorded from the page's first script. */
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
  });
  return consoleLines;
}

async function historyWrites(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as unknown as Record<string, unknown>).__kasuwaHistory as string[] | undefined) ?? []);
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

function sets(page: Page): Locator {
  return shown(page.locator('[data-duplicate-set]'));
}

function setWith(page: Page, contactId: string): Locator {
  return sets(page).filter({ has: page.locator(`[data-duplicate-contact="${contactId}"]`) }).first();
}

function mergeView(page: Page): Locator {
  return byTestId(page, 'merge-view');
}

function fieldRow(page: Page, field: string): Locator {
  return shown(page.locator(`[data-merge-field="${field}"]`)).first();
}

function complianceRow(page: Page, field: string): Locator {
  return shown(page.locator(`[data-merge-compliance="${field}"]`)).first();
}

function mergeRow(page: Page, id: string): Locator {
  return shown(page.locator(`[data-merge-row="${id}"]`)).first();
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

/** The duplicates namespace's labels (task file: `duplicates.*`). */
function dupLabels(parts: readonly string[], suffixes: readonly string[] = ['']): string[] {
  return Object.entries(EN)
    .filter(([id]) => id.startsWith('duplicates.') && parts.every((part) => id.toLowerCase().includes(part.toLowerCase())) && suffixes.some((suffix) => id.endsWith(suffix)))
    .map(([, text]) => text);
}

/** The words for an API error code: `records.error.<code>`, or a duplicates label ending `.<code>`. */
function errorWords(code: string): string[] {
  return [...(EN[`records.error.${code}`] === undefined ? [] : [EN[`records.error.${code}`] ?? '']), ...dupLabels(['error'], [`.${code}`, `.${camel(code)}`])];
}

function withheldWords(): string[] {
  return dupLabels(['withheld']);
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
  const error = byTestId(page, 'duplicates-error');
  await expect(error, `no translated message for ${what}`).toBeVisible();
  await expectSaysOneOf(error, texts, what);
  expect(await visibleText(error), `${what} prints a raw code`).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
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

async function openDuplicates(page: Page, options: DuplicatesMockOptions = {}, query = ''): Promise<{ mock: DuplicatesMock; consoleLines: string[] }> {
  const consoleLines = await tap(page);
  const mock = await installDuplicatesMock(page, options);
  active = mock;
  const response = await page.goto(`${duplicatesUrl()}/contacts/duplicates${query}`);
  expect(response?.status(), '/contacts/duplicates with crm_duplicates on').toBe(200);
  await expect(screenOf(page)).toBeVisible();
  return { mock, consoleLines };
}

async function expectSetsLoaded(page: Page): Promise<void> {
  await expect(setWith(page, A1.id), 'the first page of sets never appeared').toBeVisible();
}

async function moreSets(page: Page, mock: DuplicatesMock): Promise<void> {
  const before = mock.callsOf('listDuplicates').length;
  await byTestId(page, 'duplicates-more').click();
  await expect.poll(() => mock.callsOf('listDuplicates').length).toBe(before + 1);
  await expect(setWith(page, C1.id), 'the second page of sets never appeared').toBeVisible();
}

/** The last preview read, as [contactId, with]. */
function lastPreview(mock: DuplicatesMock): [string, string] | undefined {
  const call = mock.callsOf('getContactMergePreview').at(-1);
  if (call === undefined) return undefined;
  return [decodeURIComponent(call.url.pathname.split('/')[4] ?? ''), call.url.searchParams.get('with') ?? ''];
}

/** Opens the merge for a two-contact set and waits for its preview. */
async function review(page: Page, mock: DuplicatesMock, contactId: string): Promise<void> {
  const before = mock.callsOf('getContactMergePreview').length;
  await setWith(page, contactId).locator('[data-duplicate-review]').first().click();
  await expect(mergeView(page), 'Review did not open the merge').toBeVisible();
  await expect.poll(() => mock.callsOf('getContactMergePreview').length, { message: 'the merge read no preview' }).toBeGreaterThan(before);
  await expect(shown(page.locator('[data-merge-field]')).first(), 'the comparison never appeared').toBeVisible();
}

/** Makes `id` the main record (the survivor), waiting for the re-read preview when it changes. */
async function chooseMain(page: Page, mock: DuplicatesMock, id: string): Promise<void> {
  const radio = page.locator(`input[type="radio"][data-main="${id}"]`).first();
  await expect(radio, `no main-record choice for ${id}`).toBeAttached();
  if (!(await radio.isChecked())) {
    const before = mock.callsOf('getContactMergePreview').length;
    await radio.check();
    await expect.poll(() => mock.callsOf('getContactMergePreview').length, { message: 'choosing the main record read no new preview' }).toBeGreaterThan(before);
  }
  await expect.poll(() => lastPreview(mock)?.[0], { message: `the preview's survivor is not ${id}` }).toBe(id);
  await expect(shown(page.locator('[data-merge-field]')).first()).toBeVisible();
}

async function pickedSide(page: Page, field: string): Promise<string | null> {
  return fieldRow(page, field).locator('input[type="radio"]:checked').first().getAttribute('data-merge-side');
}

async function pick(page: Page, field: string, side: 'survivor' | 'merged'): Promise<void> {
  await fieldRow(page, field).locator(`input[type="radio"][data-merge-side="${side}"]`).first().check();
}

async function enabledRadios(row: Locator): Promise<number> {
  return row.locator('input[type="radio"]').evaluateAll((items) => items.filter((item) => !(item as HTMLInputElement).disabled && item.getAttribute('aria-disabled') !== 'true').length);
}

/** Submit, confirm, and wait for the merge to be sent. */
async function confirmMerge(page: Page, mock: DuplicatesMock): Promise<void> {
  const before = mock.callsOf('createContactMerge').length;
  await byTestId(page, 'merge-submit').click();
  const dialog = byTestId(page, 'merge-confirm');
  await expect(dialog, 'Merge opened no confirmation').toBeVisible();
  await dialog.getByTestId('merge-confirm-yes').click();
  await expect.poll(() => mock.callsOf('createContactMerge').length, { message: 'confirming sent no merge' }).toBe(before + 1);
}

function lastMergeBody(mock: DuplicatesMock): { survivorId?: string; mergedId?: string; survivorVersion?: number; mergedVersion?: number; choices?: Record<string, string> } {
  const call = mock.callsOf('createContactMerge').at(-1);
  expect(call, 'no createContactMerge was sent').toBeDefined();
  return (call?.body ?? {}) as { survivorId?: string; choices?: Record<string, string> };
}

async function backToSets(page: Page): Promise<void> {
  if (await mergeView(page).isVisible()) await byTestId(page, 'merge-back').click();
  await expect(byTestId(page, 'duplicate-sets')).toBeVisible();
}

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers @p28-duplicates @p28-duplicates-mock', async ({ page }) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a blank page on a made-up origin (no stack needed) and watch
  // each malformed request land in `violations`. No `active` mock here: the
  // violations are deliberate and counted explicitly.
  const origin = 'https://mock.kasuwa.test';
  await page.route((url) => url.origin === origin && !url.pathname.startsWith('/api/'), (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>mock</title>' }));
  const mock = await installDuplicatesMock(page, { rateLimited: { calls: [9], retryAfter: 30 }, withheld: ['emails'], notEditable: ['source'] });
  await page.goto(`${origin}/`);

  // The served vocabularies are the contract's, and the outcome rule is D-P28's.
  expect(MATCH_ON).toEqual(['phone', 'email']);
  expect(COMPLIANCE_FIELDS).toEqual(['dnd', 'whatsappOptIn', 'consentState']);
  expect(mostRestrictive('consentState', 'opted_in', 'withdrawn')).toBe('withdrawn');
  expect(mostRestrictive('dnd', false, true)).toBe(true);
  expect(mostRestrictive('whatsappOptIn', true, false)).toBe(false);
  expect(COMPLIANCE_ORDER.consentState?.[0]).toBe('withdrawn');
  expect(CONSENT_STATES).toContain('withdrawn');
  for (const field of COMPLIANCE_FIELDS) expect(MERGE_FIELDS, `${field} became choosable`).not.toContain(field);
  // The mock serves no answer its contract rejects.
  expect(answerProblems('listDuplicates', 200, { data: [{ matchOn: 'phone', score: 0.92, contacts: [{ id: A1.id, displayName: 'x', updatedAt: A1.updatedAt }, { id: A2.id, displayName: null, updatedAt: A2.updatedAt }] }], nextCursor: null }), 'a set with a score passed').not.toEqual([]);
  expect(answerProblems('listDuplicates', 200, { data: [{ matchOn: 'phone', value: '+2348030000001', contacts: [] }], nextCursor: null }), 'a set with its matched value passed').not.toEqual([]);
  expect(answerProblems('getContact', 404, { statusCode: 404, error: 'Not Found', code: 'not_found', message: 'x', mergedInto: A1.id }), 'a "merged into" pointer passed the strict check').not.toEqual([]);

  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    page.evaluate(
      async ({ path: target, method: verb, body: payload, headers: extra }) => {
        const response = await fetch(target, {
          method: verb,
          headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
          ...(payload === undefined ? {} : { body: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
        });
        return { status: response.status, body: (await response.json().catch(() => null)) as unknown, retryAfter: response.headers.get('retry-after') };
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
  const sets = `/api/v1/programmes/${PROGRAMME_ONE.id}/duplicates`;

  await expectViolation('a preview before any set was served', () => call(`/api/v1/contacts/${A1.id}/merge-preview?with=${A2.id}`));
  await expectViolation('a programme the session never listed', () => call('/api/v1/programmes/0b6a1f3e-2c4d-4e5f-8a9b-0c1d2e3f4a99/duplicates'));
  await expectViolation('a programmeId query', () => call(`/api/v1/contact-merges?programmeId=${PROGRAMME_ONE.id}`));
  await expectViolation('an undeclared listDuplicates parameter', () => call(`${sets}?matchOn=phone`));
  await expectViolation('a cursor never served', () => call(`${sets}?cursor=forged`));
  await expectViolation('an operation the screen does not use', () => call('/api/v1/contacts'));
  await expectViolation('a scope header', () => call(sets, 'GET', undefined, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id }));

  // Serve page one, then the pair is previewable.
  const first = await call(sets);
  expect(first.status).toBe(200);
  expect((first.body as { nextCursor: string | null }).nextCursor).toBe(SETS_CURSOR);
  const second = await call(`${sets}?cursor=${encodeURIComponent(SETS_CURSOR)}`);
  expect(((second.body as { data: { contacts: { id: string }[] }[] }).data[0]?.contacts ?? []).map((contact) => contact.id)).toEqual([C1.id, C2.id, C3.id]);
  await expectViolation('a preview of two contacts never served in one set', () => call(`/api/v1/contacts/${A1.id}/merge-preview?with=${C1.id}`));
  const before = mock.violations.length;
  const preview = await call(`/api/v1/contacts/${A1.id}/merge-preview?with=${A2.id}`);
  expect(preview.status).toBe(200);
  expect(mock.violations.length, 'a served pair was blamed on the screen').toBe(before);
  const read = preview.body as { defaults: Record<string, string>; survivor: { withheldFields: string[]; version: number }; merged: { version: number }; compliance: Record<string, unknown> };
  expect(Object.keys(read.defaults), 'a withheld field was offered').not.toContain('emails');
  expect(Object.keys(read.defaults), 'a read-only field was offered').not.toContain('source');
  expect(read.survivor.withheldFields).toContain('emails');
  expect(read.compliance.consentState, 'the outcome is not the most restrictive').toBe('withdrawn');
  expect(read.defaults.status, 'the newer side’s non-empty value is not the default').toBe('merged');

  const mergeBody = (extra: Record<string, unknown> = {}) => ({ survivorId: A1.id, mergedId: A2.id, survivorVersion: read.survivor.version, mergedVersion: read.merged.version, ...extra });
  await expectViolation('a compliance field chosen', () => call('/api/v1/contact-merges', 'POST', mergeBody({ choices: { consentState: 'survivor' } })));
  await expectViolation('a withheld field chosen', () => call('/api/v1/contact-merges', 'POST', mergeBody({ choices: { emails: 'merged' } })));
  await expectViolation('a read-only field chosen', () => call('/api/v1/contact-merges', 'POST', mergeBody({ choices: { source: 'merged' } })));
  await expectViolation('the pair the other way round, never previewed', () => call('/api/v1/contact-merges', 'POST', { ...mergeBody(), survivorId: A2.id, mergedId: A1.id }));
  await expectViolation('a version other than the preview’s', () => call('/api/v1/contact-merges', 'POST', mergeBody({ survivorVersion: read.survivor.version + 7 })));
  await expectViolation('a closed body with an extra property', () => call('/api/v1/contact-merges', 'POST', mergeBody({ programmeId: PROGRAMME_ONE.id })));
  const merged = await call('/api/v1/contact-merges', 'POST', mergeBody({ choices: { status: 'survivor' } }));
  expect(merged.status).toBe(201);
  const mergeId = (merged.body as { id: string }).id;
  expect(mock.mergedAway()).toContain(A2.id);
  await expectViolation('the same pair merged again', () => call('/api/v1/contact-merges', 'POST', mergeBody()));

  await expectViolation('an undo with a body', () => call(`/api/v1/contact-merges/${mergeId}/undo`, 'POST', {}));
  expect(mock.mergedAway(), 'the undo did not restore the contact').not.toContain(A2.id);
  await expectViolation('an undo of a merge already undone', () => call(`/api/v1/contact-merges/${mergeId}/undo`, 'POST'));
  await expectViolation('an undo of a merge never served', () => call(`/api/v1/contact-merges/${HM_OPEN_ID}/undo`, 'POST'));
  const history = await call('/api/v1/contact-merges');
  expect(((history.body as { data: { id: string }[] }).data).map((row) => row.id)).toEqual([mergeId, HM_OPEN_ID, HM_OTHER_ID, HM_UNDONE_ID, HM_EXPIRED_ID]);
  expect((history.body as { nextCursor: string | null }).nextCursor).toBe(MERGES_CURSOR);
  await expectViolation('an undo of an expired merge', () => call(`/api/v1/contact-merges/${HM_EXPIRED_ID}/undo`, 'POST'));
  const refused = await call(`/api/v1/contact-merges/${HM_OTHER_ID}/undo`, 'POST');
  expect(refused.status, 'another user’s merge is not 403 (D-L151)').toBe(403);

  // The throttle: the 9th listDuplicates is a 429; a 10th inside its Retry-After is hammering.
  const counted = mock.callsOf('listDuplicates').length;
  for (let index = counted; index < 8; index += 1) await call(sets);
  const limited = await call(sets);
  expect(limited.status).toBe(429);
  expect(limited.retryAfter).toBe('30');
  expect(mock.throttles.length).toBe(1);
  await expectViolation('a listDuplicates inside the Retry-After', () => call(sets));

  expect(mock.mockFaults, 'the mock answered something its contract rejects').toEqual([]);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

/** Kept in the spec so the vocabulary the journeys rely on cannot drift silently from the mock's. */
test('the audit actions and merge vocabulary the journeys label are the contracts’ @p28-duplicates @p28-duplicates-mock', () => {
  expect(AUDIT_ACTIONS).toContain('merged');
  expect(AUDIT_ACTIONS).toContain('restored');
  expect(MERGE_FIELDS).toContain('status');
  expect(MERGE_FIELDS).toContain('emails');
  expect(MERGE_FIELDS).toContain('source');
  expect(PII_VALUES).toContain(A1.displayName);
  expect(PII_VALUES).toContain('+2348030000001');
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_duplicates gates /contacts/duplicates', () => {
  // The flag-off tests PASS BEFORE THE WORK STARTS: there is no route (and on
  // the default server the record route that would catch the path is off
  // too). A negative invariant, legitimately vacuous until the screen exists;
  // the flag-on test gives the pair meaning.
  test('/contacts/duplicates is a real 404 with every flag at its default, and nothing reaches the API @p28-duplicates @p28-duplicates-flag-off', async ({ page }) => {
    const { webUrl } = stack();
    const mock = await installDuplicatesMock(page);
    const response = await page.goto(`${webUrl}/contacts/duplicates`);
    expect(response?.status(), '/contacts/duplicates is reachable with crm_duplicates off').toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    expect(mock.calls.filter((entry) => entry.operation !== 'listMyProgrammes' && entry.operation !== 'getCurrentUser'), 'a flag-off page read duplicates or merges').toEqual([]);
  });

  test('/contacts/duplicates cannot be switched on by anything the browser sends @p28-duplicates @p28-duplicates-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: { 'x-kasuwa-feature-flags': 'crm_duplicates,crm_records,crm_record_view', 'x-crm-duplicates': '1', 'x-kasuwa-tenant-id': TENANT_A },
    });
    await context.addCookies([
      { name: 'crm_duplicates', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_duplicates,crm_records', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of ['/contacts/duplicates?crm_duplicates=on&flags=crm_duplicates', '/contacts/duplicates/', '/contacts/duplicates?locale=en-XA']) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/contacts/duplicates renders P28 in the CRM shell with crm_duplicates on: the programme, the sets and the merges history @p28-duplicates @p28-duplicates-flag-on', async ({ page }) => {
    const { mock } = await openDuplicates(page);
    await expect(page.locator('[data-shell="crm"]').locator(SCREEN)).toBeVisible();
    await expect(byTestId(page, 'duplicates-programme')).toBeVisible();
    await expectSetsLoaded(page);
    await expect(byTestId(page, 'merges-history')).toBeVisible();
    await expect(mergeRow(page, HM_OPEN_ID)).toBeVisible();
    expect(mock.callsOf('listDuplicates').length, 'the landing scanned for duplicates more than once (each page is a whole-programme scan, D-L163)').toBe(1);
  });
});

// ===========================================================================
// The entry and the programme
// ===========================================================================

test('the Contacts list links /contacts/duplicates, it lands on the screen, and no link on the screen is a 404 @p28-duplicates @p28-duplicates-entry', async ({ page }) => {
  await tap(page);
  const mock = await installDuplicatesMock(page, { otherScreens: true });
  active = mock;
  const response = await page.goto(`${duplicatesUrl()}/contacts`);
  expect(response?.status(), '/contacts on the records process').toBe(200);
  const entry = shown(page.locator('a[href="/contacts/duplicates"]')).first();
  await expect(entry, 'the Contacts list does not link the duplicates screen').toBeVisible();
  await entry.click();
  await expect(page).toHaveURL(/\/contacts\/duplicates$/);
  await expect(screenOf(page)).toBeVisible();
  await expectSetsLoaded(page);
  const hrefs = [...new Set(await page.locator('a[href^="/"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? '')))];
  expect(hrefs.length, 'the page links nowhere — not even the CRM nav').toBeGreaterThan(2);
  for (const href of hrefs.filter((link) => !/^\/contacts\/[0-9a-f-]{36}$/i.test(link))) {
    const answer = await page.request.get(`${duplicatesUrl()}${href}`);
    expect(answer.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }
  for (const id of mock.mergedAway()) {
    expect(hrefs, `the page links ${id}, a merged-away contact (a 404, D-P27)`).not.toContain(`/contacts/${id}`);
  }
});

test('the programme is one of the session’s, by name; changing it scans that programme, in the path; an empty one says so @p28-duplicates @p28-duplicates-programme', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  const select = byTestId(page, 'duplicates-programme');
  const options = await select.locator('option').evaluateAll((items) => items.map((item) => ({ value: (item as HTMLOptionElement).value, text: (item.textContent ?? '').trim() })));
  const real = options.filter((option) => option.value !== '');
  expect(real.map((option) => option.value).sort(), 'the programme choices are not the session’s programmes').toEqual([PROGRAMME_ONE.id, PROGRAMME_TWO.id].sort());
  expect(real.find((option) => option.value === PROGRAMME_ONE.id)?.text).toBe(PROGRAMME_ONE.name);
  expect(real.find((option) => option.value === PROGRAMME_TWO.id)?.text).toBe(PROGRAMME_TWO.name);
  await expectSetsLoaded(page);
  await expectNoIdsPrinted(page, 'the programme choice');

  await select.selectOption(PROGRAMME_TWO.id);
  await expect.poll(() => mock.callsOf('listDuplicates').at(-1)?.url.pathname, { message: 'changing the programme did not scan it' }).toBe(`/api/v1/programmes/${PROGRAMME_TWO.id}/duplicates`);
  expect(mock.callsOf('listDuplicates').at(-1)?.url.searchParams.has('cursor'), 'a cursor carried over to another programme').toBe(false);
  await expect(byTestId(page, 'duplicates-empty'), 'an empty programme draws no empty state').toBeVisible();
  await expect(sets(page), 'the other programme’s sets are still drawn').toHaveCount(0);
  expect((await copyText(byTestId(page, 'duplicates-empty'))).length, 'the empty state has no words').toBeGreaterThan(0);

  await select.selectOption(PROGRAMME_ONE.id);
  await expectSetsLoaded(page);
  await expect(byTestId(page, 'duplicates-empty')).toHaveCount(0);
});

// ===========================================================================
// Sets (C)
// ===========================================================================

test('the sets are drawn as served: matched on phone or email in words, names as text, a withheld name labelled, dates in <time>, and no value or score @p28-duplicates @p28-duplicates-sets', async ({ page }) => {
  await openDuplicates(page);
  await expectSetsLoaded(page);
  await expect(sets(page)).toHaveCount(2);
  const order = await sets(page).evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-match-on'), ...Array.from(row.querySelectorAll('[data-duplicate-contact]')).map((contact) => contact.getAttribute('data-duplicate-contact'))]));
  expect(order, 'the sets are not the served page, in served order').toEqual([
    ['phone', A1.id, A2.id],
    ['email', B1.id, B2.id],
  ]);
  await expectSaysOneOf(sets(page).nth(0), dupLabels(['match'], ['.phone']), 'matches on phone');
  await expectSaysOneOf(sets(page).nth(1), dupLabels(['match'], ['.email']), 'matches on email');
  await expect(setWith(page, A1.id).locator(`[data-duplicate-contact="${A1.id}"] [data-record-text]`).first()).toHaveText(A1.displayName);
  await expect(setWith(page, A2.id).locator(`[data-duplicate-contact="${A2.id}"] [data-record-text]`).first()).toHaveText('A. Okonkwo');

  const withheld = shown(page.locator(`[data-duplicate-contact="${B1.id}"]`)).first();
  await expectSaysOneOf(withheld, withheldWords(), 'a withheld name');
  expect(await visibleText(withheld), 'a withheld name prints null, undefined or a stand-in').not.toMatch(/\bnull\b|\bundefined\b|Sample Withheld Fixture/);
  await expect(withheld.locator('[data-record-text]'), 'a withheld label is marked as record data').toHaveCount(0);

  for (const contact of [A1, A2, B1, B2]) {
    const times = await shown(page.locator(`[data-duplicate-contact="${contact.id}"] time`)).evaluateAll((items) => items.map((item) => item.getAttribute('datetime') ?? ''));
    expect(times.length, `${contact.id}'s updatedAt is not drawn in a <time>`).toBeGreaterThan(0);
    expect(times.every((value) => Date.parse(value) === Date.parse(contact.updatedAt)), `${contact.id}'s <time> is not its updatedAt`).toBe(true);
  }
  const html = await byTestId(page, 'duplicate-sets').innerHTML();
  for (const value of PII_VALUES.filter((entry) => entry.startsWith('+') || entry.includes('@'))) {
    expect(html.includes(value), 'a phone number or an email is in the list (the matched value is never served, nor shown)').toBe(false);
  }
  expect(await copyText(byTestId(page, 'duplicate-sets')), 'the list shows a score, a confidence or a match percentage').not.toMatch(/confidence|score|likely|\d+\s?%|similar/i);
  await expectNoIdsPrinted(page, 'the sets');
});

test('the next page is read with the cursor exactly as served, appended in order, and the control goes at the end @p28-duplicates @p28-duplicates-paging', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  await expectSetsLoaded(page);
  const first = mock.callsOf('listDuplicates')[0];
  expect(first?.url.searchParams.has('cursor'), 'the first page was read with a cursor').toBe(false);
  await moreSets(page, mock);
  const second = mock.callsOf('listDuplicates')[1];
  expect(second?.url.pathname).toBe(`/api/v1/programmes/${PROGRAMME_ONE.id}/duplicates`);
  expect(second?.url.searchParams.get('cursor'), 'the cursor was not echoed unchanged').toBe(SETS_CURSOR);
  const order = await sets(page).evaluateAll((rows) => rows.map((row) => row.querySelector('[data-duplicate-contact]')?.getAttribute('data-duplicate-contact')));
  expect(order, 'the second page did not append to the first, in order').toEqual([A1.id, B1.id, C1.id, H1.id]);
  await expect(shown(page.getByTestId('duplicates-more')), 'the next-page control is still offered after the last page').toHaveCount(0);
  expect(mock.callsOf('listDuplicates').length, 'more than one scan per page').toBe(2);
});

test('a 429 is a translated wait, the sets drawn stay, and nothing is asked again until Retry-After has passed @p28-duplicates @p28-duplicates-throttle', async ({ page }) => {
  // Calls 1 and 3 are refused: the landing, and the next page after the retry.
  const { mock } = await openDuplicates(page, { rateLimited: { calls: [1, 3], retryAfter: RETRY_AFTER } });
  const waitWords = [...dupLabels(['throttl']), ...dupLabels(['wait']), ...dupLabels(['too']), ...errorWords('too_many_requests')];

  const waitThenRetry = async (): Promise<void> => {
    const since = mock.throttles.at(-1)?.at ?? 0;
    expect(since, 'the mock answered no 429').toBeGreaterThan(0);
    const after = () => mock.callsOf('listDuplicates').filter((entry) => entry.at > since);
    const throttled = byTestId(page, 'duplicates-throttled');
    await expect(throttled, 'a 429 drew no wait message').toBeVisible();
    await expectSaysOneOf(throttled, waitWords, 'the wait after a 429');
    expect(await visibleText(throttled), 'a 429 was drawn as a connection failure').not.toMatch(/connection|offline|network/i);
    expect(await visibleText(throttled), 'a 429 prints a raw code').not.toMatch(/\b[a-z]+_[a-z_]+\b|\b429\b/);
    const retry = shown(page.getByTestId('duplicates-retry')).first();
    if ((await retry.count()) > 0 && Date.now() - since < (RETRY_AFTER * 1000) / 2) {
      expect(await isDisabled(retry), 'the retry is offered before Retry-After has passed').toBe(true);
    }
    // Wait on state, never on a clock: either the screen retries by itself, or its retry becomes usable.
    await expect
      .poll(async () => after().length > 0 || ((await retry.count()) > 0 && !(await isDisabled(retry))), { timeout: 20_000, message: 'the screen never retried, and offered no usable retry' })
      .toBe(true);
    if (after().length === 0) {
      expect(Date.now() - since, 'the retry became usable before Retry-After had passed').toBeGreaterThanOrEqual(RETRY_AFTER * 1000 - RETRY_SLACK_MS);
      await retry.click();
      await expect.poll(() => after().length, { message: 'the retry sent nothing' }).toBeGreaterThan(0);
    }
    expect((after()[0]?.at ?? 0) - since, 'asked again before the Retry-After had passed').toBeGreaterThanOrEqual(RETRY_AFTER * 1000 - RETRY_SLACK_MS);
  };

  await expect.poll(() => mock.throttles.length).toBe(1);
  await expect(byTestId(page, 'duplicates-empty'), 'a 429 was drawn as "no duplicates"').toHaveCount(0);
  await waitThenRetry();
  await expectSetsLoaded(page);
  await expect(shown(page.getByTestId('duplicates-throttled')), 'the wait message stayed after the sets arrived').toHaveCount(0);

  await byTestId(page, 'duplicates-more').click();
  await expect.poll(() => mock.throttles.length).toBe(2);
  await expect(setWith(page, A1.id), 'a 429 on the next page cleared the sets already drawn').toBeVisible();
  await waitThenRetry();
  await expect(setWith(page, C1.id)).toBeVisible();
  expect(mock.callsOf('listDuplicates').length, 'more scans than the two pages and their two retries').toBe(4);
  expect(mock.callsOf('listDuplicates')[3]?.url.searchParams.get('cursor'), 'the retried next page lost its cursor').toBe(SETS_CURSOR);
});

// ===========================================================================
// The merge (C1)
// ===========================================================================

test('in a set of three, exactly two are picked before Review, and the preview is of that pair @p28-duplicates @p28-duplicates-pair', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  await expectSetsLoaded(page);
  await moreSets(page, mock);
  const trio = setWith(page, C1.id);
  const reviewButton = trio.locator('[data-duplicate-review]').first();
  const pickOf = (id: string) => trio.locator(`input[type="checkbox"][data-duplicate-pick="${id}"]`).first();
  for (const id of [C1.id, C2.id, C3.id]) await pickOf(id).uncheck();
  expect(await isDisabled(reviewButton), 'Review is offered with nothing picked').toBe(true);
  await pickOf(C1.id).check();
  expect(await isDisabled(reviewButton), 'Review is offered with one picked').toBe(true);
  await pickOf(C3.id).check();
  await expect.poll(() => isDisabled(reviewButton)).toBe(false);
  await pickOf(C2.id).check();
  await expect.poll(() => isDisabled(reviewButton), { message: 'Review is offered with three picked (merges are pairwise)' }).toBe(true);
  await pickOf(C2.id).uncheck();
  await expect.poll(() => isDisabled(reviewButton)).toBe(false);
  expect(mock.callsOf('getContactMergePreview'), 'picking read a preview').toEqual([]);
  await reviewButton.click();
  await expect(mergeView(page)).toBeVisible();
  await expect.poll(() => (lastPreview(mock) ?? []).slice().sort()).toEqual([C1.id, C3.id].sort());
  await expect(mergeView(page)).toContainText(C1.displayName);
  await expect(mergeView(page)).toContainText(C3.displayName);
  expect(await visibleText(mergeView(page)), 'the contact left out of the pair is in the merge').not.toContain(C2.displayName);
});

test('the main record is chosen, the preview is read for it, and the per-field picks start at the API’s defaults @p28-duplicates @p28-duplicates-preview', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  const compare = byTestId(page, 'merge-compare');
  await expect(compare).toBeVisible();
  expect(await compare.evaluate((element) => element.tagName), 'the comparison is not a table').toBe('TABLE');

  await chooseMain(page, mock, A1.id);
  expect(lastPreview(mock), 'the preview is not (main, other)').toEqual([A1.id, A2.id]);
  // A2 is newer: its non-empty values are the defaults; its emails are empty, so A1's stand.
  await expect.poll(() => pickedSide(page, 'status'), { message: 'the status pick is not the API’s default' }).toBe('merged');
  await expect.poll(() => pickedSide(page, 'companyName')).toBe('merged');
  await expect.poll(() => pickedSide(page, 'emails'), { message: 'the emails pick is not the API’s default' }).toBe('survivor');
  // Every choosable field has a row with a row header. The owner and the account are ids with no name
  // in the preview (D-L64), so whether they are drawn is the builder's choice.
  for (const field of MERGE_FIELDS.filter((name) => name !== 'ownerUserId' && name !== 'accountId')) {
    const row = fieldRow(page, field);
    await expect(row, `no comparison row for ${field}`).toBeVisible();
    const header = row.locator('th[scope="row"], [role="rowheader"]');
    await expect(header, `the ${field} row has no row header`).toHaveCount(1);
    expect((await visibleText(header.first())).length, `the ${field} row header is empty`).toBeGreaterThan(0);
  }

  await chooseMain(page, mock, A2.id);
  expect(lastPreview(mock), 'swapping the main record did not read the preview the other way round').toEqual([A2.id, A1.id]);
  await expect.poll(() => pickedSide(page, 'emails'), { message: 'the picks were not re-set from the new preview’s defaults' }).toBe('merged');
  await expect.poll(() => pickedSide(page, 'status')).toBe('survivor');
  await expect(fieldRow(page, 'companyName')).toContainText('Okonkwo Fabrics');
  await expectNoIdsPrinted(page, 'the merge');
});

test('a withheld field is shown withheld and never chosen; a read-only field is locked; a withheld compliance outcome is withheld @p28-duplicates @p28-duplicates-withheld', async ({ page }) => {
  const { mock } = await openDuplicates(page, { withheld: ['emails', 'consentState'], notEditable: ['source'] });
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  await chooseMain(page, mock, A1.id);
  const emails = fieldRow(page, 'emails');
  await expect(emails).toHaveAttribute('data-withheld', 'true');
  await expectSaysOneOf(emails, withheldWords(), 'a withheld field');
  expect(await enabledRadios(emails), 'a withheld field can be chosen').toBe(0);
  expect(await mergeView(page).innerHTML(), 'a withheld email reached the page').not.toContain(String((A1.emails as string[])[0]));
  const source = fieldRow(page, 'source');
  await expect(source).toHaveAttribute('data-locked', 'true');
  expect(await enabledRadios(source), 'a field the caller may not edit can be chosen').toBe(0);
  const consent = complianceRow(page, 'consentState');
  await expect(consent).toHaveAttribute('data-withheld', 'true');
  await expectSaysOneOf(consent, withheldWords(), 'a withheld compliance outcome');
  await expect(consent.locator('[data-compliance-value]'), 'a withheld outcome is drawn').toHaveCount(0);
  await expect(complianceRow(page, 'dnd').locator('[data-compliance-value="true"]'), 'a readable outcome is not drawn').toHaveCount(1);
  await confirmMerge(page, mock);
  const choices = Object.keys(lastMergeBody(mock).choices ?? {});
  expect(choices.filter((key) => ['emails', 'source', ...COMPLIANCE_FIELDS].includes(key)), 'a withheld, read-only or compliance field was sent').toEqual([]);
  await expect(byTestId(page, 'merge-done')).toBeVisible();
});

test('compliance is locked at the most restrictive outcome, whichever record is the main one, with the note, and never sent @p28-duplicates @p28-duplicates-compliance', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  for (const main of [A1.id, A2.id]) {
    await chooseMain(page, mock, main);
    for (const field of COMPLIANCE_FIELDS) {
      const row = complianceRow(page, field);
      await expect(row, `no locked row for ${field}`).toBeVisible();
      expect(await enabledRadios(row), `${field} can be chosen (D-P28)`).toBe(0);
      await expect(row.locator('input:not([disabled]), select:not([disabled])'), `${field} has a control`).toHaveCount(0);
    }
    // A1 (main) is opted in; A2 withdrew: the outcome is A2's, whichever survives.
    await expect(complianceRow(page, 'consentState').locator('[data-compliance-value="withdrawn"]'), 'the consent outcome is not the most restrictive').toHaveCount(1);
    await expect(complianceRow(page, 'dnd').locator('[data-compliance-value="true"]')).toHaveCount(1);
    await expect(complianceRow(page, 'whatsappOptIn').locator('[data-compliance-value="true"]')).toHaveCount(1);
    expect(await visibleText(complianceRow(page, 'consentState')), 'the consent outcome prints a raw value').not.toMatch(/\bopted_in\b/);
  }
  const note = byTestId(page, 'merge-compliance-note');
  await expect(note).toBeVisible();
  const text = await visibleText(note);
  expect(text, 'the note promises the most recent choice (D-P28 is most restrictive)').not.toMatch(/most recent|latest|newest/i);
  expect(text, 'the note does not say the most restrictive choice is kept').toMatch(/restrict|strict/i);
  await confirmMerge(page, mock);
  expect(Object.keys(lastMergeBody(mock).choices ?? {}).filter((key) => COMPLIANCE_FIELDS.includes(key)), 'a compliance field was sent').toEqual([]);
});

test('Merge asks first: cancel and Escape send nothing and give focus back; confirm sends one merge @p28-duplicates @p28-duplicates-confirm', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  const submit = byTestId(page, 'merge-submit');
  await submit.click();
  const dialog = byTestId(page, 'merge-confirm');
  await expect(dialog).toBeVisible();
  expect(['dialog', 'alertdialog'], 'the confirmation is not a dialog').toContain(await dialog.getAttribute('role'));
  await expect(dialog).toHaveAccessibleName(/\S/);
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement)), { message: 'focus did not move into the confirmation' }).toBe(true);
  await page.keyboard.press('Escape');
  await expect(shown(page.getByTestId('merge-confirm'))).toHaveCount(0);
  await expect(submit, 'focus did not return to Merge after Escape').toBeFocused();
  await submit.click();
  await byTestId(page, 'merge-confirm').getByTestId('merge-confirm-cancel').click();
  await expect(shown(page.getByTestId('merge-confirm'))).toHaveCount(0);
  expect(mock.callsOf('createContactMerge'), 'a merge was sent without confirmation').toEqual([]);
  await submit.click();
  // Two activations in one tick, as an impatient double click delivers them.
  await byTestId(page, 'merge-confirm')
    .getByTestId('merge-confirm-yes')
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
  await expect(byTestId(page, 'merge-done')).toBeVisible();
  expect(mock.callsOf('createContactMerge').length, 'one confirmation sent more than one merge').toBe(1);
});

test('the merge carries the preview’s versions and the picks; the result links the survivor, offers undo until undoUntil, and never links the merged-away contact @p28-duplicates @p28-duplicates-merge', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  await chooseMain(page, mock, A1.id);
  await pick(page, 'status', 'survivor');
  await confirmMerge(page, mock);
  const body = lastMergeBody(mock);
  expect(body.survivorId).toBe(A1.id);
  expect(body.mergedId).toBe(A2.id);
  expect(body.survivorVersion, 'not the preview’s survivor version').toBe(A1.version);
  expect(body.mergedVersion, 'not the preview’s merged version').toBe(A2.version);
  expect(body.choices?.status, 'the changed pick was not sent').toBe('survivor');

  const done = byTestId(page, 'merge-done');
  await expect(done).toBeVisible();
  await expect(done.locator('a[data-testid="merge-survivor-link"]')).toHaveAttribute('href', `/contacts/${A1.id}`);
  await expect(done.getByTestId('merge-undo')).toBeVisible();
  const deadline = await done.locator('time').evaluateAll((items) => items.map((item) => Date.parse(item.getAttribute('datetime') ?? '')));
  expect(deadline.some((value) => Math.abs(value - (Date.now() + 30 * 86_400_000)) < 86_400_000), 'the undo deadline (undoUntil, 30 days) is not drawn in a <time>').toBe(true);
  await expect(page.locator(`a[href="/contacts/${A2.id}"]`), 'the merged-away contact is linked (it is a 404, D-P27)').toHaveCount(0);
  await expectNoIdsPrinted(page, 'the merge result');

  await backToSets(page);
  await expect(shown(page.locator(`[data-duplicate-contact="${A2.id}"]`)), 'the merged-away contact is still offered as a duplicate').toHaveCount(0);
  await expect(mergeRow(page, mock.merges()[0] ?? '<none>'), 'the merge is not in the history').toBeVisible();
});

test('409 already_merged is translated and the sets are read again without that pair @p28-duplicates @p28-duplicates-already-merged', async ({ page }) => {
  const { mock } = await openDuplicates(page, { mergeRefusal: 'already_merged' });
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  await confirmMerge(page, mock);
  await expectRefusal(page, errorWords('already_merged'), '409 already_merged');
  await backToSets(page);
  await expect.poll(() => mock.callsOf('listDuplicates').length, { message: 'the sets were not read again' }).toBeGreaterThan(1);
  await expect(shown(page.locator(`[data-duplicate-contact="${A2.id}"]`)), 'the pair merged elsewhere is still offered').toHaveCount(0);
  await expect(setWith(page, B1.id)).toBeVisible();
});

test('409 stale_write is translated, the preview is read again, and the next merge carries the new version @p28-duplicates @p28-duplicates-stale', async ({ page }) => {
  const { mock } = await openDuplicates(page, { mergeRefusal: 'stale_write' });
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  await chooseMain(page, mock, A1.id);
  const previews = mock.callsOf('getContactMergePreview').length;
  await confirmMerge(page, mock);
  await expectRefusal(page, errorWords('stale_write'), '409 stale_write');
  await expect.poll(() => mock.callsOf('getContactMergePreview').length, { message: 'the preview was not read again after stale_write' }).toBeGreaterThan(previews);
  await confirmMerge(page, mock);
  expect(lastMergeBody(mock).survivorVersion, 'the retry did not carry the survivor’s new version').toBe(A1.version + 1);
  await expect(byTestId(page, 'merge-done')).toBeVisible();
});

test('an agent’s merge is a translated 403, the controls stay (D-L84), and the empty history is no error @p28-duplicates @p28-duplicates-forbidden', async ({ page }) => {
  const { mock } = await openDuplicates(page, { role: 'agent' });
  await expectSetsLoaded(page);
  await expect(byTestId(page, 'merges-empty'), 'an agent sees no merges, which is the empty history').toBeVisible();
  await expect(shown(page.getByTestId('duplicates-error'))).toHaveCount(0);
  await review(page, mock, A1.id);
  await expect(byTestId(page, 'merge-submit'), 'the merge control is hidden: controls are shown and the 403 is the gate (D-L84)').toBeVisible();
  await confirmMerge(page, mock);
  await expectRefusal(page, errorWords('not_permitted'), '403 not_permitted');
  await expect(shown(page.getByTestId('merge-done'))).toHaveCount(0);
});

test('403 field_not_editable at a pick locks that field, and it is never sent again @p28-duplicates @p28-duplicates-field-refused', async ({ page }) => {
  const { mock } = await openDuplicates(page, { revokedOnMerge: ['status'] });
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  await chooseMain(page, mock, A1.id);
  await pick(page, 'status', 'survivor');
  await confirmMerge(page, mock);
  expect(lastMergeBody(mock).choices?.status).toBe('survivor');
  await expectRefusal(page, [...errorWords('not_permitted'), ...errorWords('field_not_editable')], '403 field_not_editable');
  await expect.poll(async () => (await fieldRow(page, 'status').getAttribute('data-locked')) === 'true' && (await enabledRadios(fieldRow(page, 'status'))) === 0, { message: 'the refused field can still be chosen' }).toBe(true);
  await confirmMerge(page, mock);
  expect(Object.keys(lastMergeBody(mock).choices ?? {}), 'the refused field was sent again').not.toContain('status');
  await expect(byTestId(page, 'merge-done')).toBeVisible();
});

// ===========================================================================
// Undo and the history (the recycle bin, D-P27)
// ===========================================================================

test('undo from the result restores the contact, and a survivor edited since says it kept its edits @p28-duplicates @p28-duplicates-undo', async ({ page }) => {
  const { mock } = await openDuplicates(page, { survivorEdited: true });
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  await confirmMerge(page, mock);
  const mergeId = mock.merges()[0] ?? '';
  await byTestId(page, 'merge-done').getByTestId('merge-undo').click();
  await expect.poll(() => mock.callsOf('undoContactMerge').length).toBe(1);
  expect(mock.callsOf('undoContactMerge')[0]?.url.pathname).toBe(`/api/v1/contact-merges/${mergeId}/undo`);
  await expect(byTestId(page, 'merge-undone'), 'the undo drew no undone state').toBeVisible();
  await expect(byTestId(page, 'merge-kept-edits'), 'survivorReverted false is not explained').toBeVisible();
  await expectSaysOneOf(byTestId(page, 'merge-kept-edits'), [...dupLabels(['kept']), ...dupLabels(['revert'])], 'the survivor kept its edits');
  await expect(shown(page.getByTestId('merge-undo')), 'undo is still offered after the undo').toHaveCount(0);
  await backToSets(page);
  await expect(setWith(page, A2.id), 'the restored contact is not offered as a duplicate again').toBeVisible();
});

test('undo from the history turns an open merge undone @p28-duplicates @p28-duplicates-undo', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  const row = mergeRow(page, HM_OPEN_ID);
  await expect(row).toHaveAttribute('data-merge-state', 'open');
  await row.locator('[data-merge-undo]').first().click();
  await expect.poll(() => mock.callsOf('undoContactMerge').map((entry) => entry.url.pathname)).toEqual([`/api/v1/contact-merges/${HM_OPEN_ID}/undo`]);
  await expect(mergeRow(page, HM_OPEN_ID)).toHaveAttribute('data-merge-state', 'undone');
  await expect(mergeRow(page, HM_OPEN_ID).locator('[data-merge-undo]')).toHaveCount(0);
});

test('an expired merge says "undo expired" with no undo, and a 410 on an open-looking one turns it expired @p28-duplicates @p28-duplicates-undo-expired', async ({ page }) => {
  const { mock } = await openDuplicates(page, { undoRefusal: 'expired' });
  const expired = mergeRow(page, HM_EXPIRED_ID);
  await expect(expired).toHaveAttribute('data-merge-state', 'expired');
  await expect(expired.locator('[data-merge-undo]'), 'an expired merge offers undo').toHaveCount(0);
  const expiredWords = dupLabels(['expired']);
  await expectSaysOneOf(expired, expiredWords, '"undo expired"');
  await byTestId(page, 'merges-more').click();
  await expect(mergeRow(page, HM_OLD_ID)).toHaveAttribute('data-merge-state', 'expired');

  // The browser's clock said open; the server's says expired, and the server wins.
  await mergeRow(page, HM_OPEN_ID).locator('[data-merge-undo]').first().click();
  await expectRefusal(page, [...errorWords('undo_expired'), ...expiredWords], '410 undo_expired');
  await expect.poll(() => mergeRow(page, HM_OPEN_ID).getAttribute('data-merge-state'), { message: 'a 410 did not turn the merge expired' }).toBe('expired');
  await expect(mergeRow(page, HM_OPEN_ID).locator('[data-merge-undo]')).toHaveCount(0);
  expect(mock.callsOf('undoContactMerge').length).toBe(1);
});

test('an undo answered 404 (rights lost, D-L163) reads as "not found", never as a permission, and is offered no more @p28-duplicates @p28-duplicates-undo-not-found', async ({ page }) => {
  const { mock } = await openDuplicates(page, { undoRefusal: 'not_found' });
  await mergeRow(page, HM_OPEN_ID).locator('[data-merge-undo]').first().click();
  await expectRefusal(page, errorWords('not_found'), '404 on undo');
  const said = await visibleText(byTestId(page, 'duplicates-error'));
  for (const text of errorWords('not_permitted')) expect(said, 'a 404 was drawn as a refusal of permission').not.toContain(text);
  expect(said, 'a 404 talks about permission').not.toMatch(/permission|not allowed|forbidden|access|rights/i);
  await expect(shown(page.locator(`[data-merge-row="${HM_OPEN_ID}"] [data-merge-undo]`)), 'undo is still offered after a 404').toHaveCount(0);
  expect(mock.callsOf('undoContactMerge').length).toBe(1);
});

test('undo of another user’s merge is a translated 403 @p28-duplicates @p28-duplicates-undo-refused', async ({ page }) => {
  await openDuplicates(page);
  await mergeRow(page, HM_OTHER_ID).locator('[data-merge-undo]').first().click();
  await expectRefusal(page, errorWords('not_permitted'), '403 not_permitted on undo');
  await expect(mergeRow(page, HM_OTHER_ID)).toHaveAttribute('data-merge-state', 'open');
});

test('undo when the survivor was merged away since is a translated 409 @p28-duplicates @p28-duplicates-undo-refused', async ({ page }) => {
  await openDuplicates(page, { undoRefusal: 'already_merged' });
  await mergeRow(page, HM_OPEN_ID).locator('[data-merge-undo]').first().click();
  await expectRefusal(page, errorWords('already_merged'), '409 already_merged on undo');
});

test('the history is the served list: names or a withheld label, dates in <time>, states, undo only where open, the next page, and no link to a merged-away contact @p28-duplicates @p28-duplicates-history', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  await expect.poll(() => mock.callsOf('listContactMerges').length).toBeGreaterThan(0);
  expect([...mock.callsOf('listContactMerges')[0]?.url.searchParams.keys() ?? []].filter((name) => !['cursor', 'limit'].includes(name))).toEqual([]);
  await expect(mergeRow(page, HM_OPEN_ID)).toBeVisible();
  const ids = await shown(page.locator('[data-merge-row]')).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-merge-row')));
  expect(ids, 'the history is not the served list, in served order').toEqual([HM_OPEN_ID, HM_OTHER_ID, HM_UNDONE_ID, HM_EXPIRED_ID]);
  const states = await shown(page.locator('[data-merge-row]')).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-merge-state')));
  expect(states).toEqual(['open', 'open', 'undone', 'expired']);
  for (const id of [HM_OPEN_ID, HM_OTHER_ID]) await expect(mergeRow(page, id).locator('[data-merge-undo]'), `${id} offers no undo (controls are shown, D-L84)`).toHaveCount(1);
  for (const id of [HM_UNDONE_ID, HM_EXPIRED_ID]) await expect(mergeRow(page, id).locator('[data-merge-undo]'), `${id} offers undo`).toHaveCount(0);
  await expect(mergeRow(page, HM_OPEN_ID).locator('[data-record-text]').filter({ hasText: 'Ngozi Adebayo' })).toHaveCount(1);
  const undone = mergeRow(page, HM_UNDONE_ID);
  await expectSaysOneOf(undone, withheldWords(), 'a withheld survivor name');
  expect(await visibleText(undone)).not.toMatch(/\bnull\b|\bundefined\b/);
  await expect(undone.getByTestId('merge-kept-edits'), 'an undone merge whose survivor kept its edits does not say so').toHaveCount(1);
  await expectSaysOneOf(undone, dupLabels(['undone']), 'the undone state');
  for (const id of [HM_OPEN_ID, HM_OTHER_ID, HM_UNDONE_ID, HM_EXPIRED_ID]) {
    expect(await mergeRow(page, id).locator('time[datetime]').count(), `${id} draws no <time>`).toBeGreaterThan(0);
  }
  for (const id of mock.mergedAway()) {
    await expect(page.locator(`a[href="/contacts/${id}"]`), `the history links ${id}, which is merged away (a 404)`).toHaveCount(0);
  }
  await byTestId(page, 'merges-more').click();
  await expect.poll(() => mock.callsOf('listContactMerges').at(-1)?.url.searchParams.get('cursor')).toBe(MERGES_CURSOR);
  await expect(mergeRow(page, HM_OLD_ID)).toBeVisible();
  await expect(shown(page.getByTestId('merges-more'))).toHaveCount(0);
  await expectNoIdsPrinted(page, 'the history');
});

// ===========================================================================
// Contacts, markup, privacy
// ===========================================================================

test('after a merge the merged-away contact is gone from the Contacts list, its record is the generic not-found with no "merged into" link, and the survivor opens @p28-duplicates @p28-duplicates-contacts', async ({ page }) => {
  const { mock } = await openDuplicates(page, { otherScreens: true });
  await expectSetsLoaded(page);
  await review(page, mock, A1.id);
  await chooseMain(page, mock, A1.id);
  await confirmMerge(page, mock);
  await byTestId(page, 'merge-done').locator('a[data-testid="merge-survivor-link"]').click();
  await expect(page).toHaveURL(new RegExp(`/contacts/${A1.id}$`));
  await expect(shown(page.getByTestId('record')).first(), 'the survivor’s record did not open').toBeVisible();

  await page.goto(`${duplicatesUrl()}/contacts`);
  await expect(page.locator(`[data-row-id="${A1.id}"]`).first(), 'the Contacts list did not draw').toBeAttached();
  await expect(page.locator(`[data-row-id="${A2.id}"]`), 'the merged-away contact is still in the Contacts list').toHaveCount(0);

  await page.goto(`${duplicatesUrl()}/contacts/${A2.id}`);
  await expect(shown(page.getByTestId('record-not-found')).first(), 'the merged-away contact is not the generic not-found').toBeVisible();
  await expect(page.locator(`a[href="/contacts/${A1.id}"]`), 'the not-found page points at the survivor: the contract has no "merged into", and a link would reveal it').toHaveCount(0);
  expect(await visibleText(page.locator('body')), 'the not-found page says the contact was merged').not.toMatch(/merged/i);
});

test('markup in a name or a company is drawn as text, never parsed @p28-duplicates @p28-duplicates-markup', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  await expectSetsLoaded(page);
  await moreSets(page, mock);
  const hostile = shown(page.locator(`[data-duplicate-contact="${H1.id}"] [data-record-text]`)).first();
  await expect(hostile).toHaveText(HOSTILE_NAME);
  await review(page, mock, H1.id);
  await expect(mergeView(page)).toContainText(HOSTILE_COMPANY);
  await expect(page.locator('img[src="x"], b:text-is("Adé"), i:text-is("Textiles")'), 'markup was parsed into elements').toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__kasuwaXss), 'markup ran script').toBeUndefined();
});

test('no name, number or address in the console, the address bar, history state or the title; nothing kept on the device @p28-duplicates @p28-duplicates-privacy', async ({ page }) => {
  const { mock, consoleLines } = await openDuplicates(page);
  await expectSetsLoaded(page);
  await moreSets(page, mock);
  await review(page, mock, A1.id);
  await chooseMain(page, mock, A2.id);
  await confirmMerge(page, mock);
  await byTestId(page, 'merge-done').getByTestId('merge-undo').click();
  await expect(byTestId(page, 'merge-undone')).toBeVisible();
  const places = [consoleLines.join('\n'), page.url(), decodeURIComponent(page.url()), (await historyWrites(page)).join('\n'), await page.title()];
  for (const value of [...PII_VALUES, ...HISTORY_NAMES]) {
    for (const place of places) expect(place.includes(value), `a person's name, number or address left the page (${value.slice(0, 3)}…)`).toBe(false);
  }
  const stored = await page.evaluate(async () => {
    const parts: string[] = [document.cookie];
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index) ?? '';
        parts.push(key, store.getItem(key) ?? '');
      }
    }
    const databases = typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map((info) => info.name ?? '') : [];
    return { dump: parts.join('\n'), databases };
  });
  for (const value of [...PII_VALUES, ...HISTORY_NAMES]) expect(stored.dump.includes(value), 'a person’s data was kept on the device (D-P21)').toBe(false);
  expect(stored.databases, 'the screen opened an IndexedDB database').toEqual([]);
});

// ===========================================================================
// Accessibility, 360 px, en-XA
// ===========================================================================

test('the sets, the merge, the confirmation, the result and the history are axe-clean; every pick is a named radio group @p28-duplicates @p28-duplicates-axe', async ({ page }) => {
  const { mock } = await openDuplicates(page);
  await expectSetsLoaded(page);
  await expect(mergeRow(page, HM_OPEN_ID)).toBeVisible();
  await expectNoSeriousAxe(page, 'the sets and the history');
  await review(page, mock, A1.id);
  await chooseMain(page, mock, A1.id);
  await expectNoSeriousAxe(page, 'the merge');
  const mains = page.locator('input[type="radio"][data-main]');
  expect(new Set(await mains.evaluateAll((items) => items.map((item) => (item as HTMLInputElement).name))).size, 'the main-record choice is not one radio group').toBe(1);
  for (const field of ['status', 'companyName', 'emails']) {
    const radios = fieldRow(page, field).locator('input[type="radio"][data-merge-side]');
    await expect(radios).toHaveCount(2);
    const names = new Set(await radios.evaluateAll((items) => items.map((item) => (item as HTMLInputElement).name)));
    expect(names.size === 1 && !names.has(''), `the ${field} picks are not one named group`).toBe(true);
    for (const index of [0, 1]) await expect(radios.nth(index), `a ${field} pick has no name`).toHaveAccessibleName(/\S/);
    const group = fieldRow(page, field).locator('fieldset, [role="radiogroup"]').first();
    await expect(group, `the ${field} picks are not a fieldset or a radiogroup`).toBeAttached();
    await expect(group).toHaveAccessibleName(/\S/);
  }
  await byTestId(page, 'merge-submit').click();
  await expect(byTestId(page, 'merge-confirm')).toBeVisible();
  await expectNoSeriousAxe(page, 'the confirmation');
  await byTestId(page, 'merge-confirm').getByTestId('merge-confirm-yes').click();
  await expect(byTestId(page, 'merge-done')).toBeVisible();
  await expectNoSeriousAxe(page, 'the result');
});

test('at 360px the sets, the merge and the history fit without sideways scroll and pass axe @p28-duplicates @p28-duplicates-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const { mock } = await openDuplicates(page);
  await expectSetsLoaded(page);
  await expect(mergeRow(page, HM_OPEN_ID)).toBeVisible();
  expect(await overflow(page), 'the sets scroll sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P28 sets at 360px');
  await review(page, mock, A1.id);
  expect(await overflow(page), 'the comparison scrolls sideways at 360px (it stacks)').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P28 merge at 360px');
  await expectNoIdsPrinted(page, 'the 360px merge');
});

test('locale=en-XA renders every string of the sets, the merge and the history as pseudo text, record data excepted @p28-duplicates @p28-duplicates-pseudo', async ({ page }) => {
  const { mock } = await openDuplicates(page, {}, '?locale=en-XA');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await expectSetsLoaded(page);
  await expect(mergeRow(page, HM_OPEN_ID)).toBeVisible();
  const records = [...HISTORY_NAMES, PROGRAMME_ONE.name, PROGRAMME_TWO.name];
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
  expect(landing.english, 'strings on the sets or the history that did not come through i18n').toEqual([]);
  expect(landing.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
  expect(landing.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(8);
  await review(page, mock, A1.id);
  const merge = await report(screenOf(page));
  expect(merge.english, 'strings on the merge that did not come through i18n').toEqual([]);
  expect(merge.forged).toEqual([]);
});

// ===========================================================================
// The audit log knows merged and restored (D-L162)
// ===========================================================================

test('the audit log draws merged and restored events with their labels, and offers them as filters @p28-duplicates @p28-duplicates-audit', async ({ page }) => {
  const { webUrl } = stack();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installAdminMock(page);
  const audit = await installAuditMock(page);
  await page.goto(`${webUrl}/admin/audit`);
  await expect(page.locator('[data-screen="P02/E"]')).toBeVisible();
  const rows = page.getByTestId('audit-row');
  await expect(rows, 'the audit log did not draw the page holding a merge and an undo (an unknown action fails the parse)').toHaveCount(3);
  const merged = EN['admin.audit.action.merged'];
  const restored = EN['admin.audit.action.restored'];
  expect(merged, 'en.json has no admin.audit.action.merged').toBeDefined();
  expect(restored, 'en.json has no admin.audit.action.restored').toBeDefined();
  await expect(rows.nth(0), 'the restored event is not labelled').toContainText(restored ?? '<admin.audit.action.restored>');
  await expect(rows.nth(1), 'the merged event is not labelled').toContainText(merged ?? '<admin.audit.action.merged>');
  const options = await page.getByTestId('audit-action').locator('option').allInnerTexts();
  expect(options.map((text) => text.trim()), 'the action filter does not offer merged and restored').toEqual(expect.arrayContaining([merged ?? '<merged>', restored ?? '<restored>']));
  await page.getByTestId('audit-action').selectOption(String(AUDIT_MERGED.action));
  await expect.poll(() => audit.reads.some((url) => url.searchParams.get('action') === 'merged'), { message: 'filtering by merged sent no action=merged' }).toBe(true);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(merged ?? '<admin.audit.action.merged>');
  expect(audit.mockFaults).toEqual([]);
  expect(errors, 'the audit log threw').toEqual([]);
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/contacts/duplicates on the wire', () => {
  /**
   * WHY A PLACEHOLDER. The screen does not exist when this is written. The
   * builder reports two measurements and the lead pins DUPLICATES_BUDGET_BYTES
   * within 5% of them, at or under 255,000 (the acceptance suite's ceiling).
   */
  test('/contacts/duplicates stays inside its transferred-byte budget on the production build @p28-duplicates @p28-duplicates-budget', async ({ page }) => {
    // No fake clock here: it replaces window.performance, so the first
    // contentful paint this measures would never be reported (D-L118).
    active = await installDuplicatesMock(page);
    const metrics = await measurePageLoad(page, `${duplicatesUrl()}/contacts/duplicates`, 'default');
    const record = resolve(__dirname, '.artifacts', 'p28-duplicates-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(record, `${JSON.stringify({ path: '/contacts/duplicates', transferredBytes: metrics.transferredBytes, budget: DUPLICATES_BUDGET_BYTES }, null, 2)}\n`, 'utf8');
    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webDuplicatesUrl is not serving the production build').toBe(built);
    // A 404 page is small: a budget met by the not-found page measures nothing.
    await expect(screenOf(page)).toBeVisible();
    expect(DUPLICATES_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P28 the duplicates screen', metrics.transferredBytes, DUPLICATES_BUDGET_BYTES);
  });

  test('/contacts/duplicates paints within 5 s at 256 kbps and 300 ms @p28-duplicates @p28-duplicates-budget', async ({ page }) => {
    active = await installDuplicatesMock(page);
    const metrics = await measurePageLoad(page, `${duplicatesUrl()}/contacts/duplicates`, 'low-bandwidth');
    await expect(screenOf(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
