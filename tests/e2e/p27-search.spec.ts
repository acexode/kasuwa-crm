import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack, type StackUrls } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  A_HOLDINGS,
  A_SAMARA,
  C_COMPOSED_TRAP,
  C_NAMELESS,
  C_SAMPLE,
  C_SAMPLETON,
  C_SAMPLEWISE,
  D_HOLDINGS,
  D_SAMARA,
  FUTURE_GROUP_TEXT,
  HOSTILE_ACCOUNT_ID,
  HOSTILE_CONTACT_ID,
  HOSTILE_NAME,
  HOSTILE_QUERY,
  L_FIXTURE,
  L_SAMPLEFORD,
  MARKUP_QUERY,
  PROGRAMME_ONE,
  Q_MAX,
  SEARCH_TYPES,
  WITHHELD_VALUES,
  answerProblems,
  hasControlCharacter,
  identifierShaped,
  installSearchMock,
  isLookup,
  isSearchRead,
  lookupAnswer,
  phoneLike,
  searchAnswer,
  servedData,
  termOf,
  type SearchMock,
  type SearchMockOptions,
  type SearchType,
} from './support/search-mock';

/**
 * T-0087 — global search and the command palette (P27, `docs/design/P27/`):
 * the `/search` screen and the Ctrl/Cmd-K palette in the CRM shell, behind
 * `crm_search`, against T-0085's contract (`searchRecords`, `lookupRecords`).
 * Written by the lead's QA agent BEFORE the screen exists;
 * `tests/acceptance/records-ui/command-palette.acceptance.test.ts` runs this
 * file with `--grep @p27-search` and reads every outcome by tag.
 * Decisions: D-L133 (R1–R22 of the contract suite), D-L128, D-P13, D-L87,
 * D-L68, D-L80, D-L115.
 *
 * TAG RULE (D-L84). `@p27-search` is the parent tag. Playwright's --grep is a
 * regular expression, so no other screen's tag may contain it, and it contains
 * no other screen's parent tag. Every sub-tag here is `@p27-search-<name>`.
 *
 * ---------------------------------------------------------------------------
 * THE WEB PROCESS
 *
 *   webUrl          — the default server, every flag at its default. `/search`
 *                     must be a real 404 there.
 *   webSearchUrl    — NEW, published in the stack file by the builder's change
 *                     to `scripts/run-e2e.mjs`. `crm_search` RIDES ON THE
 *                     RECORDS PROCESS (`webRecordsUrl`), so the hits link to
 *                     `/contacts/[id]` and `/accounts/[id]` and "see all" lands
 *                     on `/contacts`, `/leads` and `/accounts`, all served
 *                     there. Every journey and the byte budget run here.
 *
 * THE SEARCH IS READ FROM THE BROWSER, AND MOCKED THERE
 *
 * Every journey installs `support/search-mock.ts`, which serves searchRecords
 * and lookupRecords (and the "see all" landings) from the contract and checks
 * every request against it and every answer it gives. `afterEach` fails a test
 * in which the screen sent the API anything the contract (or this screen's
 * rules, in the mock's header) does not allow, left the origin, or in which the
 * mock answered something its own contract rejects.
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                     the CRM shell; with crm_search on
 *     header a[href="/search"]             its search entry (aria-current="page"
 *                                          on /search); absent with it off
 *   [data-screen="P27"]                    the /search screen root, holding a
 *                                          search panel (below), not a dialog
 *   [data-testid="command-palette"]        the palette: role="dialog",
 *                                          aria-modal="true", an accessible
 *                                          name, holding a search panel; opened
 *                                          by Control+K or Meta+K anywhere in
 *                                          the CRM shell, closed by Escape
 *
 *   A SEARCH PANEL (in the palette and on the screen alike):
 *     [data-testid="search-input"]         the input: role="combobox",
 *                                          aria-controls naming the listbox,
 *                                          aria-activedescendant naming the
 *                                          active option while arrowing
 *     [role="listbox"]                     the results, with an accessible name
 *       [data-group="<type>"]              one per type that has hits, in the
 *                                          served order: role="group", named by
 *                                          its translated type label, no count
 *         [data-hit="<id>"]                one hit, in served order: role=
 *           data-hit-type="<type>"         "option" with a unique id; IS or
 *                                          CONTAINS its link when it has one
 *           [data-field="name"]            the name drawn ([data-record-text]
 *                                          when it is record data);
 *                                          data-locked="true" when no name is
 *                                          readable
 *         [data-see-all="<type>"]          a[href]: contact, lead and account
 *                                          only, never deal, never on a lookup
 *     [data-testid="search-loading"]       while the answer is awaited
 *     [data-testid="search-empty"]         an answer with no hits
 *     [data-testid="search-error"]         a failed read (never "no matches")
 *     [data-testid="search-invalid"]       the lookup refused the value as not
 *                                          one whole number or address
 *     [data-testid="search-hint"]          the neutral "keep typing a full
 *                                          number" hint while phone-like input
 *                                          is not yet lookup-eligible (R27);
 *                                          never a refusal
 *   [data-record-text]                     record data, not UI copy (en-XA)
 *
 * PINNED INTERFACES BEYOND THE HOOKS (see the suite's rulings R1–R29)
 *
 *   - A name goes to searchRecords as `q` (all four types), debounced, never
 *     shorter than 2 characters once folded, never over 100, never with a
 *     control character; a newer query is sent without waiting for an older
 *     one, and only the latest answer is ever drawn.
 *   - Phone- or email-shaped input (R21: after NFKC, an `@`, or 6 or more
 *     digits once whitespace and `+()-.` are removed) goes ONLY to
 *     lookupRecords, as a POST body; it is never in any URL, history entry,
 *     link, request query or document title.
 *   - Phone-like input (R27: after NFKC, only digits, whitespace and
 *     `+()-.`, with a digit) never reaches searchRecords at any keystroke,
 *     not even `0803`: the screen shows the neutral hint until the input is
 *     lookup-eligible, then sends lookupRecords only. Text with letters
 *     (`Sample 12`) stays a name query.
 *   - The lookup body is NFKC-normalised (R28): full-width digits and `＠`
 *     arrive as ASCII.
 *   - The palette is loaded on first open (R29); the other CRM screens'
 *     pinned byte budgets are the check.
 *   - Hits link only from well-formed uuids: contacts and leads to
 *     `/contacts/<id>`, accounts to `/accounts/<id>`; deals are not links
 *     (no deal screen yet; whichever of T-0087 and T-0110 merges second
 *     re-pins this spec to link them). "See all" is `/contacts?q=…`,
 *     `/leads?q=…`, `/accounts?q=…`, and the list reads with that `q`: the
 *     builder changes the P04 Contacts, Leads and Accounts screens to read `q`
 *     from their URL.
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS (D-L133)
 *
 *   Absent: recent searches (P27/A), partial-number search and its "also
 *   matches" hint (A2's overruled half), filters and chip counts (A3), the
 *   scope menu and the hidden-results count (B, B1), the results page with
 *   facets and counts (C, C1), commands, programme switching and Ask AI (D,
 *   D2, D3), the "create contact or lead" offer on no results (A5's), and the
 *   tickets, conversations and KB groups (no module serves them).
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P27"]';
const PALETTE = '[data-testid="command-palette"]';

/**
 * The /search transferred-byte budget. A PLACEHOLDER: the acceptance suite
 * holds it at or under 255,000 bytes and within 5% of what this run measures,
 * so the builder measures it and the lead pins it (R26). Until then the
 * wrapper's budget test fails by design.
 */
const SEARCH_BUDGET_BYTES = 250_000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

/**
 * PLACEHOLDER phone numbers (Nigeria has no fictional range; these are the
 * contract's own `+234803000000x` placeholders), one common way of writing a
 * number each, and the contact the mock stores it for. Each is a DIFFERENT
 * number, so a screen that remembers an identical lookup in memory still
 * sends one request per case.
 */
const PHONE_CASES: readonly (readonly [form: string, id: string])[] = [
  ['0803 000 0001', C_SAMPLEWISE.id],
  ['+234 803 000 0003', L_FIXTURE.id],
  ['(0803) 000-0011', C_SAMPLE.id],
  ['2348030000004', C_SAMPLETON.id],
  ['0803.000.0006', C_COMPOSED_TRAP.id],
];
const PHONE_FORMS: readonly string[] = PHONE_CASES.map(([form]) => form);
/** The contract's own placeholder (its phoneLookup example): C_SAMPLEWISE. */
const PHONE = '0803 000 0001';
/** An international form: L_FIXTURE, a lead, so it is in the contact and the lead group. */
const PHONE_INTL = '+234 803 000 0003';
/**
 * L_SAMPLEFORD's placeholder in full-width digits: NFKC makes it a phone
 * (R21), and the lookup body carries it as ASCII (R28). A number no other
 * case uses, so a screen that remembers lookups still sends this one.
 */
const PHONE_FULL_WIDTH = '０８０３ ０００ ０００７';
/** A placeholder nobody has. */
const PHONE_NOBODY = '0803 000 0099';
/** A placeholder for C_NAMELESS, whose every name field is withheld. */
const PHONE_NAMELESS = '0803 000 0077';
/** Seven digits: phone-shaped, but not a whole number (partial-number search is overruled). */
const PHONE_PARTIAL = '0803 000';
/** C_SAMPLE's address, in a different case: lookups compare case-insensitively. */
const EMAIL = 'Sample.Fixture@Example.test';
const EMAIL_PARTIAL = 'sample.fixture@';

/**
 * What each query must draw, per type, in order. Written by hand from the
 * contract's rules (folded prefix of a readable field, at most three, served
 * by the mock's fixed rank) and independent of the mock's oracle; the mock
 * test proves the two agree.
 */
type Expected = Readonly<Record<SearchType, readonly string[]>>;
const EXPECTED: Readonly<Record<string, Expected>> = {
  sam: {
    contact: [C_SAMPLEWISE.id, L_FIXTURE.id, C_SAMPLE.id],
    lead: [L_FIXTURE.id, L_SAMPLEFORD.id],
    account: [A_HOLDINGS.id, A_SAMARA.id],
    deal: [D_HOLDINGS.id, D_SAMARA.id],
  },
  samp: {
    contact: [C_SAMPLEWISE.id, L_FIXTURE.id, C_SAMPLE.id],
    lead: [L_FIXTURE.id, L_SAMPLEFORD.id],
    account: [A_HOLDINGS.id],
    deal: [D_HOLDINGS.id],
  },
  samw: { contact: [C_COMPOSED_TRAP.id], lead: [], account: [], deal: [] },
  sampleton: { contact: [C_SAMPLETON.id], lead: [], account: [], deal: [] },
  samplew: { contact: [C_SAMPLEWISE.id], lead: [], account: [], deal: [] },
};
const PORTAL_SAM: Expected = { ...(EXPECTED.sam as Expected), deal: [] };
const NO_MATCH = 'Testnomatch';

// ---------------------------------------------------------------------------
// The mock, the wire and the clean-up
// ---------------------------------------------------------------------------

let active: SearchMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults, 'the MOCK answered something its contract rejects (a mock bug, not the screen’s)').toEqual([]);
    expect(mock.violations, 'the screen sent the API something the contract or this screen’s rules do not allow').toEqual([]);
    if (mock.requests.length > 0) {
      const origin = new URL(searchUrl()).origin;
      for (const url of mock.requests) {
        expect(url.origin, 'the search must be read same-origin, by a relative path').toBe(origin);
      }
    }
  }
});

function searchUrl(): string {
  const urls = stack() as StackUrls & { webSearchUrl?: string };
  if (typeof urls.webSearchUrl !== 'string' || urls.webSearchUrl === '') {
    throw new Error(
      'the stack file has no webSearchUrl: scripts/run-e2e.mjs starts no web process with crm_search on ' +
        '(see the header of p27-search.spec.ts)',
    );
  }
  return urls.webSearchUrl;
}

/** Every URL the page asked for, every frame navigation, and every history entry it wrote. */
interface Wire {
  readonly urls: string[];
  readonly navigations: string[];
}

async function tapWire(page: Page): Promise<Wire> {
  const wire: Wire = { urls: [], navigations: [] };
  page.on('request', (request) => wire.urls.push(request.url()));
  page.on('framenavigated', (frame) => wire.navigations.push(frame.url()));
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __kasuwaHistory: string[] }).__kasuwaHistory = log;
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = window.history[name].bind(window.history);
      window.history[name] = (state: unknown, unused: string, url?: string | URL | null) => {
        let written = '';
        try {
          written = JSON.stringify(state) ?? '';
        } catch {
          written = '[unserialisable state]';
        }
        log.push(`${String(url ?? '')}\n${written}`);
        original(state, unused, url);
      };
    }
  });
  return wire;
}

async function historyLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __kasuwaHistory?: string[] }).__kasuwaHistory ?? []);
}

/** True when `text` (a URL, a title, a history entry) carries `identifier`, in any encoding the page might use. */
function carries(text: string, identifier: string): boolean {
  let decoded = text;
  try {
    decoded = decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    decoded = text;
  }
  const normal = decoded.normalize('NFKC').toLowerCase();
  const id = identifier.normalize('NFKC').trim().toLowerCase();
  if (id.includes('@')) {
    const local = id.split('@')[0] ?? id;
    return normal.includes(id) || (local.length >= 4 && normal.includes(`${local}@`)) || normal.includes(local.replace(/\./g, '%2e'));
  }
  // The national number: every way of writing it contains these digits.
  const digits = id.replace(/\D/g, '').replace(/^(?:234|0)/, '');
  return normal.replace(/[\s+().-]/g, '').includes(digits);
}

/**
 * R21 on the client: the identifier is in no request URL the page made (build
 * assets excepted: they are fixed at build time and cannot carry input), no
 * navigation, no history entry or state, no link, the address bar and the
 * title.
 */
async function expectIdentifierNowhere(page: Page, wire: Wire, identifier: string, where: string, skipUrl?: string): Promise<void> {
  expect(carries(page.url(), identifier), `the address bar carries the identifier (${where})`).toBe(false);
  expect(carries(await page.title(), identifier), `the document title carries the identifier (${where})`).toBe(false);
  for (const url of wire.urls) {
    if (url === skipUrl || /\/_next\/static\//.test(url)) continue;
    expect(carries(url, identifier), `a request URL carries the identifier (${where}): ${new URL(url).pathname}`).toBe(false);
  }
  for (const url of wire.navigations) {
    if (url === skipUrl) continue;
    expect(carries(url, identifier), `a navigation carries the identifier (${where})`).toBe(false);
  }
  for (const entry of await historyLog(page)) {
    expect(carries(entry, identifier), `a history entry carries the identifier (${where})`).toBe(false);
  }
  const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
  for (const href of hrefs) {
    expect(carries(href, identifier), `a link carries the identifier (${where})`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Locators and readers
// ---------------------------------------------------------------------------

/** Visible elements only: a screen may render desktop and mobile layouts and switch them with CSS. */
function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

function screenOf(page: Page): Locator {
  return page.locator(SCREEN);
}

function paletteOf(page: Page): Locator {
  return shown(page.locator(PALETTE)).first();
}

function input(root: Locator): Locator {
  return shown(root.locator('[data-testid="search-input"]')).first();
}

function group(root: Locator, type: string): Locator {
  return shown(root.locator(`[data-group="${type}"]`)).first();
}

function hit(root: Locator, type: string, id: string): Locator {
  return shown(root.locator(`[data-group="${type}"] [data-hit="${id}"]`)).first();
}

async function hitIds(root: Locator, type: string): Promise<string[]> {
  return shown(root.locator(`[data-group="${type}"] [data-hit]`)).evaluateAll((hits) =>
    hits.map((element) => element.getAttribute('data-hit') ?? ''),
  );
}

/** The groups drawn with at least one hit, in DOM order. */
async function groupsWithHits(root: Locator): Promise<string[]> {
  return shown(root.locator('[data-group]')).evaluateAll((groups) =>
    groups.filter((element) => element.querySelector('[data-hit]') !== null).map((element) => element.getAttribute('data-group') ?? ''),
  );
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

/** UI copy only: visible text with record data ([data-record-text]), hits and icon ligatures removed. */
async function copyText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden="true"], [data-record-text], [data-hit], time, script, style').forEach((hidden) => hidden.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** A group's own copy (its label, its "see all"), hits removed: where a count would be drawn. */
async function groupChrome(root: Locator, type: string): Promise<string> {
  return group(root, type).evaluate((element) => {
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll('[data-hit], [aria-hidden="true"]').forEach((node) => node.remove());
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/** en.json labels under an id about search ending with one of `suffixes`. */
function searchLabels(...suffixes: string[]): string[] {
  return Object.entries(EN)
    .filter(([id]) => /search|palette/i.test(id) && suffixes.some((suffix) => id.endsWith(suffix)))
    .map(([, text]) => text);
}

async function expectSaysOneOf(locator: Locator, labels: readonly string[], what: string): Promise<void> {
  expect(labels.length, `en.json has no label for ${what}`).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const said = await visibleText(locator);
      return labels.some((label) => said.includes(label)) ? 'says it' : said;
    }, { message: `${what} says none of ${labels.map((label) => `"${label}"`).join(', ')}` })
    .toBe('says it');
}

/**
 * No UUID a person can see or hear: visible text, the accessible-name
 * attributes, form values a person reads and the document title. Ids in
 * `data-*`, `id`, `aria-controls`/`aria-activedescendant` and `href` are not
 * printed.
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

// ---------------------------------------------------------------------------
// Journeys' building blocks
// ---------------------------------------------------------------------------

async function openSearch(page: Page, options: SearchMockOptions & { query?: string } = {}): Promise<SearchMock> {
  const mock = await installSearchMock(page, options);
  active = mock;
  const response = await page.goto(`${searchUrl()}/search${options.query ?? ''}`);
  expect(response?.status(), '/search with crm_search on').toBe(200);
  await expect(screenOf(page)).toBeVisible();
  return mock;
}

/** Opens a record screen of the CRM shell that is not the search, to prove the palette is the shell's. */
async function openContacts(page: Page, options: SearchMockOptions = {}): Promise<SearchMock> {
  const mock = await installSearchMock(page, options);
  active = mock;
  const response = await page.goto(`${searchUrl()}/contacts`);
  expect(response?.status(), '/contacts on the records process').toBe(200);
  await expect(page.locator('[data-shell="crm"]')).toBeVisible();
  return mock;
}

async function openPalette(page: Page, chord = 'Control+k'): Promise<Locator> {
  await page.keyboard.press(chord);
  const palette = paletteOf(page);
  await expect(palette, `${chord} did not open the command palette`).toBeVisible();
  await expect(palette).toHaveAttribute('role', 'dialog');
  await expect(input(palette), 'the palette did not put focus in its search box').toBeFocused();
  return palette;
}

/** Waits until a panel has drawn an answer: a hit, the empty state, an error or a refusal. */
async function settled(root: Locator): Promise<void> {
  await expect(
    shown(
      root.locator('[data-hit], [data-testid="search-empty"], [data-testid="search-error"], [data-testid="search-invalid"]'),
    ).first(),
    'the search never drew an answer',
  ).toBeVisible();
}

/** Types a name and waits for its answer to be read and drawn. */
async function searchFor(page: Page, root: Locator, q: string): Promise<void> {
  const read = page.waitForResponse((response) => isSearchRead(response.request(), q));
  await input(root).fill(q);
  await read;
  await expectDrawn(root, EXPECTED[q]);
}

/** Exactly the expected hits, per type, in served order; groups in the served order. */
async function expectDrawn(root: Locator, expected: Expected | undefined): Promise<void> {
  if (expected === undefined) {
    await settled(root);
    return;
  }
  const first = SEARCH_TYPES.find((type) => expected[type].length > 0);
  if (first !== undefined) {
    await expect(hit(root, first, expected[first][0] ?? ''), `the first ${first} hit was not drawn`).toBeVisible();
  }
  for (const type of SEARCH_TYPES) {
    await expect.poll(() => hitIds(root, type), { message: `the ${type} group is not the served hits, in served order` }).toEqual(expected[type]);
  }
  expect(await groupsWithHits(root), 'the groups are not in the served order').toEqual(SEARCH_TYPES.filter((type) => expected[type].length > 0));
}

function digitsOf(value: string): string {
  return value.normalize('NFKC').replace(/\D/g, '').replace(/^(?:234|0)/, '');
}

/** A lookup request for this very value (the same whole number, or the same address). */
function isLookupFor(request: Request, value: string): boolean {
  if (!isLookup(request)) return false;
  const term = termOf(request) ?? '';
  const normal = (text: string) => text.normalize('NFKC').trim().toLowerCase();
  return normal(value).includes('@') ? normal(term) === normal(value) : digitsOf(term) === digitsOf(value);
}

/**
 * Types an identifier and waits for ITS lookup to be answered and drawn. A
 * screen that refuses the value itself sends nothing: then the wait for the
 * request ends after 15 s and the refusal must be on the screen.
 */
async function lookUp(page: Page, root: Locator, value: string): Promise<Request | undefined> {
  const sent = page.waitForRequest((request) => isLookupFor(request, value), { timeout: 15_000 }).catch(() => undefined);
  await input(root).fill(value);
  const request = await sent;
  if (request !== undefined) {
    const response = await request.response();
    await response?.finished();
  }
  await settled(root);
  return request;
}

const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

/** Everything the screen was served or typed that could land on the device. */
function needles(): string[] {
  return [
    'samplew',
    C_SAMPLEWISE.displayName,
    C_SAMPLEWISE.id,
    C_SAMPLE.displayName,
    C_SAMPLE.id,
    digitsOf(PHONE),
    EMAIL.toLowerCase(),
  ];
}

/** Every value the page has written to the device: web storage, cookies, IndexedDB and Cache Storage. */
async function deviceStorage(page: Page): Promise<{ dump: string; cachedApi: string[]; databases: string[] }> {
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
    return { dump: parts.join('\n'), cachedApi, databases };
  });
}

/**
 * Lets the page run every task already queued. Used ONLY after a stale
 * answer has been delivered and its body read, so that a screen which would
 * draw it has had the chance to: a task-queue flush, not a timed wait.
 */
async function flushTasks(page: Page): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await page.evaluate(() => new Promise<void>((done) => setTimeout(() => requestAnimationFrame(() => done()), 0)));
  }
}

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers @p27-search @p27-search-mock', async ({
  page,
}) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (sign-in on the default server) and
  // watch every malformed request land in `violations`, one at a time. No
  // `active` mock here: the violations are deliberate and counted explicitly.
  const { webUrl } = stack();

  // The hand-written table and the mock's oracle agree.
  for (const [q, expected] of Object.entries(EXPECTED)) {
    const groups = searchAnswer(q).groups;
    expect(groups.map((entry) => entry.type), `${q}: the groups are not one per type in the contract's order`).toEqual([...SEARCH_TYPES]);
    for (const type of SEARCH_TYPES) {
      const served = (groups.find((entry) => entry.type === type)?.hits as { id: string }[] | undefined) ?? [];
      expect(served.map((entry) => entry.id), `the mock and the hand-written table disagree on ${q} ${type}`).toEqual(expected[type]);
    }
  }
  const portal = searchAnswer('sam', 'portal').groups;
  expect((portal.find((entry) => entry.type === 'deal')?.hits as unknown[]).length, 'a portal caller was served deals').toBe(0);
  expect(searchAnswer(NO_MATCH).groups.every((entry) => (entry.hits as unknown[]).length === 0)).toBe(true);
  // A withheld field never matches: C_NAMELESS has no readable name, so no name search finds it.
  for (const q of ['sampleshade', 'fixturemoor', 'testmoor']) {
    expect(searchAnswer(q).groups.every((entry) => (entry.hits as unknown[]).length === 0), `${q} matched a withheld field`).toBe(true);
  }
  // R21's rule, as the client must apply it.
  for (const value of [...PHONE_FORMS, PHONE_FULL_WIDTH, PHONE_PARTIAL, EMAIL, EMAIL_PARTIAL, 'Sample＠example']) {
    expect(identifierShaped(value), `${value.length}-character identifier not recognised`).toBe(true);
  }
  for (const value of ['Sample 2026', 'Unit 12 Block 3456', 'sam', 'Sámple Fixture', '0803 0']) {
    expect(identifierShaped(value), `"${value}" is a name the rule refuses`).toBe(false);
  }
  // R27's rule: phone-like, even when too short to look up.
  for (const value of ['0803', '+234 80', '(0803) 0', '０８０３', '1', ...PHONE_FORMS, PHONE_PARTIAL]) {
    expect(phoneLike(value), `"${value.replace(/\d/g, '#')}" is not recognised as phone-like`).toBe(true);
  }
  for (const value of ['Sample 12', 'Unit 12 Block 3456', 'sam', '+-.() ', '', EMAIL]) {
    expect(phoneLike(value), `"${value}" is wrongly phone-like`).toBe(false);
  }

  const mock = await installSearchMock(page);
  await page.goto(`${webUrl}/`);
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, raw?: string) =>
    page.evaluate(
      async ([target, verb, payload, extra, text]) => {
        try {
          const response = await fetch(target, {
            method: verb,
            headers: payload === undefined && text === undefined ? extra : { 'content-type': 'application/json', ...extra },
            body: text ?? (payload === undefined ? null : JSON.stringify(payload)),
          });
          return { status: response.status, cache: response.headers.get('cache-control'), body: (await response.json()) as Record<string, unknown> };
        } catch {
          return { status: 0, cache: null, body: {} as Record<string, unknown> };
        }
      },
      [path, method, body, headers, raw] as const,
    );
  let planted = 0;
  const expectViolation = async (path: string, method: string, body: unknown, status: number, what: RegExp, headers?: Record<string, string>, raw?: string) => {
    const before = mock.violations.length;
    const answer = await call(path, method, body, headers, raw);
    expect(answer.status, `${method} ${path.slice(0, 40)}`).toBe(status);
    const added = mock.violations.slice(before);
    expect(added.join('\n'), `${method} ${path.slice(0, 40)} was not recorded`).toMatch(what);
    expect(added, `${method} ${path.slice(0, 40)} was recorded more than once`).toHaveLength(1);
    planted += 1;
    return answer;
  };
  const s = (query: string) => `/api/v1/search?${query}`;
  const q = (value: string) => s(`q=${encodeURIComponent(value)}`);
  const lookupPath = '/api/v1/search/lookup';

  // Served as the contract says.
  const sam = await call(q('sam'));
  expect(sam.status).toBe(200);
  expect(sam.cache, 'an answer without Cache-Control: no-store').toBe('no-store');
  const samGroups = sam.body.groups as { type: string; hits: Record<string, unknown>[] }[];
  expect(samGroups.map((entry) => entry.type)).toEqual([...SEARCH_TYPES]);
  expect(Object.keys(sam.body), 'the answer carries more than its groups').toEqual(['groups']);
  const withheld = await call(q('sampleton'));
  const sampleton = (withheld.body.groups as { hits: Record<string, unknown>[] }[])[0]?.hits[0] ?? {};
  expect('displayName' in sampleton || 'familyName' in sampleton, 'a withheld name part was served').toBe(false);
  expect(sampleton.withheldFields).toEqual(['displayName', 'familyName']);
  for (const [form, id] of PHONE_CASES) {
    const found = await call(lookupPath, 'POST', { phone: form });
    expect(found.status, `the lookup refused the placeholder written as ${form.length} characters`).toBe(200);
    expect((found.body.groups as { hits: { id: string }[] }[])[0]?.hits.map((entry) => entry.id)).toEqual([id]);
  }
  // One number in every common way of writing it is one number.
  for (const form of ['0803 000 0001', '+234 803 000 0001', '(0803) 000-0001', '2348030000001', '0803.000.0001', '+2348030000001']) {
    const found = await call(lookupPath, 'POST', { phone: form });
    expect((found.body.groups as { hits: { id: string }[] }[])[0]?.hits.map((entry) => entry.id), 'one number, written differently, is not found').toEqual([C_SAMPLEWISE.id]);
  }
  expect(await call(lookupPath, 'POST', { phone: PHONE })).toEqual({ status: 200, cache: 'no-store', body: lookupAnswer({ phone: PHONE }) });
  const byEmail = await call(lookupPath, 'POST', { email: EMAIL });
  expect((byEmail.body.groups as { hits: { id: string }[] }[])[0]?.hits.map((entry) => entry.id), 'the email lookup is not case-insensitive').toEqual([C_SAMPLE.id]);
  const nameless = await call(lookupPath, 'POST', { phone: PHONE_NAMELESS, types: ['contact', 'lead'] });
  const namelessHit = (nameless.body.groups as { hits: Record<string, unknown>[] }[])[0]?.hits[0] ?? {};
  expect(Object.keys(namelessHit).sort()).toEqual(['id', 'programmeId', 'type', 'withheldFields']);
  expect(JSON.stringify(nameless.body), 'a hit carried the number that found it').not.toContain('0077');
  const nobody = await call(lookupPath, 'POST', { phone: PHONE_NOBODY });
  expect((nobody.body.groups as { hits: unknown[] }[]).every((entry) => entry.hits.length === 0)).toBe(true);
  // A value the API cannot normalise is its refusal, not the screen's fault.
  const partial = await call(lookupPath, 'POST', { phone: PHONE_PARTIAL });
  expect(partial.status).toBe(400);
  expect(partial.body.details).toEqual([{ path: 'phone', code: 'invalid_phone' }]);
  const asciiFromFullWidth = await call(lookupPath, 'POST', { phone: PHONE_FULL_WIDTH.normalize('NFKC') });
  expect((asciiFromFullWidth.body.groups as { hits: { id: string }[] }[])[0]?.hits.map((entry) => entry.id), 'the NFKC form of a full-width number is not found').toEqual([L_SAMPLEFORD.id]);
  const badEmail = await call(lookupPath, 'POST', { email: EMAIL_PARTIAL });
  expect(badEmail.body.details).toEqual([{ path: 'email', code: 'invalid_email' }]);
  // Names with a few digits are names (R21's examples).
  expect((await call(q('Sample 2026'))).status).toBe(200);
  expect((await call(q('Unit 12 Block 3456'))).status).toBe(200);
  expect((await call(q('Sample 12'))).status, 'letters and digits are a name (R27)').toBe(200);
  expect((await call(`${q('sam')}&types=contact&types=lead&types=account&types=deal`)).status).toBe(200);
  expect((await call('/api/v1/contacts?q=sam&limit=25')).status).toBe(200);
  expect((await call('/api/v1/leads?q=sam')).status).toBe(200);
  expect((await call('/api/v1/accounts?q=sam')).status).toBe(200);
  expect(mock.violations, 'a well-formed request was recorded as a violation').toEqual([]);

  // searchRecords, refused and blamed on the screen.
  await expectViolation(s(''), 'GET', undefined, 400, /no q/);
  for (const identifier of ['08030000001', '+234 803 000 0001', '(0803) 000-0001', 'sample.fixture@example.test', PHONE_FULL_WIDTH, 'Sample＠example', '0803 000 0001']) {
    const refused = await expectViolation(q(identifier), 'GET', undefined, 400, /phone- or email-shaped/);
    expect(refused.body.details).toEqual([{ path: 'q', code: 'identifier_in_url' }]);
  }
  // R27: the contract answers a short run of digits; the lead's ruling still blames the screen.
  for (const prefix of ['0803', '+234 80', '(0803) 0', '０８']) {
    await expectViolation(q(prefix), 'GET', undefined, 200, /phone-like q/);
  }
  // R28: a full-width number sent as typed is a body the client failed to normalise.
  const raw = await expectViolation(lookupPath, 'POST', { phone: PHONE_FULL_WIDTH }, 400, /not NFKC-normalised/);
  expect(raw.body.details, 'full-width digits are not ASCII: the API refuses them').toEqual([{ path: 'phone', code: 'invalid_phone' }]);
  await expectViolation(lookupPath, 'POST', { email: 'Sample.Fixture＠Example.test' }, 400, /not NFKC-normalised/);
  await expectViolation(`${q('sam')}&phone=08030000001`, 'GET', undefined, 400, /"phone" parameter/);
  await expectViolation(`${q('sam')}&email=${encodeURIComponent(EMAIL)}`, 'GET', undefined, 400, /"email" parameter/);
  await expectViolation(`${q('sam')}&programmeId=${PROGRAMME_ONE.id}`, 'GET', undefined, 200, /no "programmeId"/);
  await expectViolation(`${q('sam')}&limit=10`, 'GET', undefined, 200, /no "limit"/);
  await expectViolation(`${q('sam')}&types=contact`, 'GET', undefined, 200, /narrowed/);
  await expectViolation(`${q('sam')}&types=ticket`, 'GET', undefined, 400, /does not have/);
  await expectViolation(`${q('sam')}&types=contact&types=contact`, 'GET', undefined, 400, /repeated/);
  for (const short of ['s', ' s ', 'É', 'ś', 'Ø ']) {
    const refused = await expectViolation(q(short), 'GET', undefined, 400, /under 2 characters/);
    expect(refused.body.details).toEqual([{ path: 'q', code: 'query_too_short' }]);
  }
  await expectViolation(q('Sample\tFixture'), 'GET', undefined, 400, /control character/);
  await expectViolation(q(`Sample${'x'.repeat(Q_MAX)}`), 'GET', undefined, 400, /over 100/);
  await expectViolation(q('sam'), 'GET', undefined, 200, /scope is never supplied/, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id });

  // lookupRecords, refused and blamed on the screen.
  await expectViolation(`${lookupPath}?phone=08030000001`, 'GET', undefined, 404, /not an operation/);
  await expectViolation(`${lookupPath}?x=1`, 'POST', { phone: PHONE }, 200, /query string/);
  await expectViolation(lookupPath, 'POST', { phone: PHONE, email: EMAIL }, 400, /exactly one of phone or email/);
  await expectViolation(lookupPath, 'POST', {}, 400, /exactly one of phone or email/);
  const unknown = await expectViolation(lookupPath, 'POST', { phone: PHONE, programmeId: PROGRAMME_ONE.id }, 400, /property the contract does not have/);
  expect(unknown.body.details, 'unknown_property must use the fixed path body').toEqual([{ path: 'body', code: 'unknown_property' }]);
  await expectViolation(lookupPath, 'POST', { phone: 'Samplewise' }, 400, /a name belongs to searchRecords/);
  await expectViolation(lookupPath, 'POST', { phone: PHONE, types: ['account'] }, 200, /ask for all four/);
  await expectViolation(lookupPath, 'POST', { phone: PHONE, types: ['ticket'] }, 400, /types/);
  await expectViolation(lookupPath, 'POST', undefined, 200, /not application\/json/, { 'content-type': 'text/plain' }, JSON.stringify({ phone: PHONE }));

  // The "see all" landings and everything else.
  await expectViolation(`/api/v1/contacts?q=sam&programmeId=${PROGRAMME_ONE.id}`, 'GET', undefined, 400, /no "programmeId"/);
  await expectViolation('/api/v1/leads?q=08030000001', 'GET', undefined, 400, /phone- or email-shaped q/);
  await expectViolation('/api/v1/search/recent', 'GET', undefined, 404, /not an operation/);
  await expectViolation(`/api/v1/contacts/${C_SAMPLE.id}`, 'GET', undefined, 404, /not an operation/);
  await expectViolation('/api/v1/search/count?q=sam', 'GET', undefined, 404, /not an operation/);
  expect(mock.violations.length, 'the refusals above were not all recorded, or one was recorded twice').toBe(planted);
  // No violation message repeats the identifier it refused (it would reach a CI log).
  for (const message of mock.violations) {
    expect(carries(message, PHONE), 'a violation message repeats a phone number').toBe(false);
    expect(carries(message, EMAIL), 'a violation message repeats an email address').toBe(false);
  }

  // After leave(), an unexplained read is not the screen's fault.
  mock.leave();
  expect((await call(`/api/v1/contacts/${C_SAMPLE.id}`)).status).toBe(404);
  expect(mock.afterLeave.map((url) => url.pathname)).toEqual([`/api/v1/contacts/${C_SAMPLE.id}`]);
  expect(mock.violations.length).toBe(planted);

  // Holding and failing.
  const holding = await installSearchMock(page, { holdTerms: ['samp'], failTerms: ['samara'] });
  const pending = call(q('samp'));
  await expect.poll(() => holding.searchReads.length, { message: 'the held read never reached the mock' }).toBe(1);
  expect((await call(q('sam'))).status, 'a read not held was held').toBe(200);
  holding.releaseTerm('samp');
  expect((await pending).status).toBe(200);
  expect((await call(q('samara'))).status, 'a failed term was answered').toBe(0);
  expect(holding.violations).toEqual([]);

  // The mock checks its own answers: a planted body the contract rejects is caught.
  const contactHit = samGroups[0]?.hits[0] ?? {};
  const base = (groups: unknown[]) => ({ groups });
  expect(answerProblems('searchRecords', 200, { ...base(samGroups), total: 9 }).join('\n'), 'a total passed').toMatch(/total/);
  expect(answerProblems('searchRecords', 200, base([{ type: 'contact', hits: [contactHit], more: true }])).join('\n'), 'a "more" flag passed').not.toBe('');
  expect(answerProblems('searchRecords', 200, base([{ type: 'contact', hits: [contactHit, contactHit, contactHit, contactHit] }])).join('\n'), 'four hits passed').not.toBe('');
  expect(answerProblems('searchRecords', 200, base([{ type: 'contact', hits: [{ ...contactHit, phones: ['+2348030000001'] }] }])).join('\n'), 'a phone passed').not.toBe('');
  expect(answerProblems('searchRecords', 200, base([{ type: 'contact', hits: [{ ...contactHit, programmeName: 'Sample' }] }])).join('\n'), 'a programme name passed').not.toBe('');
  expect(answerProblems('searchRecords', 200, base([{ type: 'contact', hits: [contactHit], count: 3 }])).join('\n'), 'a count passed').not.toBe('');
  expect(answerProblems('lookupRecords', 201, base(samGroups)).join('\n'), 'a 201 passed').toMatch(/declares no 201/);
  expect(answerProblems('searchRecords', 403, { statusCode: 403 }).join('\n')).toMatch(/declares no 403/);
  expect(answerProblems('searchRecords', 200, sam.body)).toEqual([]);

  // The deliberate faults are served and filed apart.
  const hostile = await installSearchMock(page, { hostileIds: true });
  const hostileAnswer = await call(q(HOSTILE_QUERY));
  expect(JSON.stringify(hostileAnswer.body)).toContain(HOSTILE_CONTACT_ID);
  expect(hostile.plantedFaults.length, 'the hostile ids were not served').toBe(2);
  expect(hostile.mockFaults).toEqual([]);
  const future = await installSearchMock(page, { futureGroup: true });
  const futureAnswer = await call(q('sam'));
  expect((futureAnswer.body.groups as { type: string }[]).map((entry) => entry.type)).toEqual([...SEARCH_TYPES, 'ticket']);
  expect(future.plantedFaults.length, 'the future group was not served').toBeGreaterThan(0);
  expect(future.mockFaults).toEqual([]);
  for (const other of [mock, holding, hostile, future]) {
    expect(other.mockFaults).toEqual([]);
  }
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_search gates /search and the palette', () => {
  // The flag-off tests PASS BEFORE THE WORK STARTS: there is no route and no
  // palette anywhere. A negative invariant, legitimately vacuous until the
  // screen exists; the flag-on test gives the pair meaning. That the shell
  // mounts no palette and draws no search entry with the flag off is held
  // statically by the suite (no process serves the shell with it off).
  test('/search is a real 404 with every flag at its default, nothing reaches the API, and Ctrl+K opens nothing @p27-search @p27-search-flag-off', async ({
    page,
  }) => {
    const { webUrl } = stack();
    const mock = await installSearchMock(page);
    const response = await page.goto(`${webUrl}/search`);
    expect(response?.status(), '/search is reachable with crm_search off').toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    await page.goto(`${webUrl}/`);
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Meta+k');
    await expect(page.locator(PALETTE), 'a palette opened on a page of the default server').toHaveCount(0);
    expect(mock.requests.filter((url) => url.pathname.startsWith('/api/v1/search')), 'a flag-off page searched').toEqual([]);
  });

  test('/search cannot be switched on by anything the browser sends @p27-search @p27-search-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-kasuwa-feature-flags': 'crm_search,crm_records',
        'x-crm-search': '1',
        'x-kasuwa-tenant-id': TENANT_A,
      },
    });
    await context.addCookies([
      { name: 'crm_search', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_search', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of ['/search?crm_search=on&flags=crm_search', '/search/', '/search?q=sam', '/search?locale=en-XA']) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/search renders the P27 search screen with crm_search on @p27-search @p27-search-flag-on', async ({ page }) => {
    await openSearch(page);
    await expect(input(screenOf(page))).toBeVisible();
    await expect(input(screenOf(page))).toHaveAttribute('role', 'combobox');
  });
});

// ===========================================================================
// The shell
// ===========================================================================

test('/search sits in the CRM shell, whose header links it, and no link on it is a 404 @p27-search @p27-search-shell', async ({ page }) => {
  await openSearch(page);
  const shell = page.locator('[data-shell="crm"]');
  await expect(shell).toBeVisible();
  await expect(shell.locator(SCREEN)).toBeVisible();
  await expect(screenOf(page).locator(PALETTE), 'the screen is drawn inside a dialog').toHaveCount(0);
  const entry = shown(shell.locator('header a[href="/search"]')).first();
  await expect(entry, 'the CRM header has no search entry').toBeVisible();
  await expect(entry).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('settings-menu')).toHaveCount(0);

  await searchFor(page, screenOf(page), 'sam');
  const hrefs = [...new Set(await page.locator('a[href^="/"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? '')))];
  expect(hrefs.length, 'the page links nowhere — not even the CRM nav').toBeGreaterThan(3);
  for (const href of hrefs) {
    const response = await page.request.get(`${searchUrl()}${href}`);
    expect(response.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }

  // The same entry, on another screen of the shell.
  await page.goto(`${searchUrl()}/contacts`);
  await expect(shown(page.locator('[data-shell="crm"] header a[href="/search"]')).first(), '/contacts has no search entry').toBeVisible();
});

// ===========================================================================
// The palette: a dialog, opened from anywhere in the shell
// ===========================================================================

test.describe('the command palette', () => {
  test('Ctrl+K and Cmd+K open a labelled modal dialog anywhere in the shell; focus is trapped; Escape closes it and returns focus @p27-search @p27-search-palette', async ({
    page,
  }) => {
    await openSearch(page);
    const opener = shown(page.locator('[data-shell="crm"] nav a[href="/contacts"]')).first();
    await opener.focus();
    const palette = await openPalette(page, 'Control+k');
    await expect(palette).toHaveAttribute('aria-modal', 'true');
    await expect(palette, 'the dialog has no accessible name').toHaveAccessibleName(/\S/);

    // Focus never leaves the dialog, forwards or backwards.
    for (const chord of ['Tab', 'Shift+Tab']) {
      for (let press = 0; press < 12; press += 1) {
        await page.keyboard.press(chord);
        expect(await palette.evaluate((element) => element.contains(document.activeElement)), `${chord} #${press + 1} left the palette`).toBe(true);
      }
    }
    await searchFor(page, palette, 'sam');
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Tab');
      expect(await palette.evaluate((element) => element.contains(document.activeElement)), `Tab #${press + 1} left the palette with results drawn`).toBe(true);
    }
    await expectNoSeriousAxe(page, 'P27/D1, the palette with results');

    await page.keyboard.press('Escape');
    await expect(page.locator(PALETTE).filter({ visible: true }), 'Escape did not close the palette').toHaveCount(0);
    await expect(opener, 'focus did not return to where it was before the palette opened').toBeFocused();

    await openPalette(page, 'Meta+k');
    await page.keyboard.press('Escape');
    await expect(page.locator(PALETTE).filter({ visible: true })).toHaveCount(0);

    // From another screen, with focus in that screen's own text field.
    await page.goto(`${searchUrl()}/contacts`);
    const listSearch = shown(page.locator('input[type="search"]')).first();
    await listSearch.focus();
    const again = await openPalette(page, 'Control+k');
    await searchFor(page, again, 'samp');
  });

  test('arrow keys move through the labelled results, the active option is announced, and Enter opens it @p27-search @p27-search-keyboard', async ({
    page,
  }) => {
    const mock = await openSearch(page);
    const palette = await openPalette(page);
    await searchFor(page, palette, 'sam');
    const box = input(palette);
    await expect(box).toHaveAttribute('role', 'combobox');
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    const controls = await box.getAttribute('aria-controls');
    expect(controls, 'the combobox controls nothing').toBeTruthy();
    const listbox = palette.locator(`[id="${controls ?? ''}"]`);
    await expect(listbox).toHaveAttribute('role', 'listbox');
    await expect(listbox, 'the results have no accessible name').toHaveAccessibleName(/\S/);
    for (const type of SEARCH_TYPES) {
      const labelled = group(palette, type);
      await expect(labelled).toHaveAttribute('role', 'group');
      const labels = searchLabels(`.group.${type}`);
      expect(labels.length, `en.json has no label for the ${type} group (an id about search ending ".group.${type}")`).toBeGreaterThan(0);
      await expect(labelled, `the ${type} group is not named by its label`).toHaveAccessibleName(new RegExp(labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')));
    }

    const options = await listbox.locator('[role="option"]').evaluateAll((elements) => elements.map((element) => element.id));
    expect(options.length, 'fewer options than hits').toBeGreaterThanOrEqual(Object.values(EXPECTED.sam ?? {}).flat().length);
    expect(new Set(options).size, 'two options share an id (a lead is in two groups: ids must still differ)').toBe(options.length);
    expect(options.every((id) => id !== ''), 'an option has no id for aria-activedescendant').toBe(true);

    await page.keyboard.press('ArrowDown');
    await expect(box).toHaveAttribute('aria-activedescendant', options[0] ?? '<none>');
    await expect(listbox.locator(`[id="${options[0] ?? ''}"]`)).toHaveAttribute('aria-selected', 'true');
    await expect(listbox.locator(`[id="${options[0] ?? ''}"]`), 'the first option is not the first contact hit').toHaveAttribute('data-hit', C_SAMPLEWISE.id);
    await page.keyboard.press('ArrowDown');
    await expect(box).toHaveAttribute('aria-activedescendant', options[1] ?? '<none>');
    await expect(listbox.locator(`[id="${options[0] ?? ''}"]`)).not.toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(box).toHaveAttribute('aria-activedescendant', options[0] ?? '<none>');
    await expect(box, 'arrowing moved focus out of the search box').toBeFocused();

    mock.leave();
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/contacts/${C_SAMPLEWISE.id}$`));
  });
});

// ===========================================================================
// Grouped hits and "see all"
// ===========================================================================

test('hits are grouped in the served order, at most three each in served order, labelled, with no count, total or "more" @p27-search @p27-search-groups', async ({
  page,
}) => {
  await openSearch(page);
  const root = screenOf(page);
  await searchFor(page, root, 'sam');
  for (const type of SEARCH_TYPES) {
    expect((await hitIds(root, type)).length, `more than three ${type} hits`).toBeLessThanOrEqual(3);
    await expectSaysOneOf(group(root, type), searchLabels(`.group.${type}`), `the ${type} group`);
    expect(await groupChrome(root, type), `the ${type} group draws a count (D-P13)`).not.toMatch(/\d/);
  }
  // A lead is a contact too: both groups carry it, each its own option.
  await expect(hit(root, 'contact', L_FIXTURE.id)).toBeVisible();
  await expect(hit(root, 'lead', L_FIXTURE.id)).toBeVisible();
  const chrome = await copyText(root);
  expect(chrome, 'a count, total or "more" is drawn (D-P13)').not.toMatch(/\d|\bmore\b|\btotal\b|\bresults?\b\s*\(/i);
  await expectNoSeriousAxe(page, 'P27/A1, grouped results');

  // A different answer replaces the groups: none of the old hits stays.
  await searchFor(page, root, 'samw');
  await expect(shown(root.locator(`[data-hit="${A_SAMARA.id}"]`))).toHaveCount(0);
});

test('"see all" is the type’s own list with q, for contacts, leads and accounts, never for deals, and the list reads it @p27-search @p27-search-see-all', async ({
  page,
}) => {
  const mock = await openSearch(page);
  const targets: readonly (readonly [SearchType, string, string])[] = [
    ['contact', '/contacts', '/api/v1/contacts'],
    ['lead', '/leads', '/api/v1/leads'],
    ['account', '/accounts', '/api/v1/accounts'],
  ];
  for (const [type, path, api] of targets) {
    if (page.url() !== `${searchUrl()}/search`) {
      await page.goto(`${searchUrl()}/search`);
    }
    const root = screenOf(page);
    await searchFor(page, root, 'sam');
    await expect(shown(root.locator('[data-see-all="deal"]')), 'deals have no list, so no "see all"').toHaveCount(0);
    const link = shown(root.locator(`a[data-see-all="${type}"]`)).first();
    await expect(link, `no "see all" for ${type}`).toBeVisible();
    const href = new URL((await link.getAttribute('href')) ?? '', searchUrl());
    expect(href.pathname, `"see all" for ${type} is not ${path}`).toBe(path);
    expect([...href.searchParams.keys()], `"see all" for ${type} carries more than q`).toEqual(['q']);
    expect(href.searchParams.get('q'), `"see all" for ${type} does not carry the q that was searched`).toBe('sam');
    const read = page.waitForRequest((request) => new URL(request.url()).pathname === api && new URL(request.url()).searchParams.get('q') === 'sam');
    await link.click();
    await page.waitForURL((url) => url.pathname === path);
    await read;
    await expect(shown(page.locator('input[type="search"]')).first(), `the ${path} list does not show the q it searched`).toHaveValue('sam');
  }
  expect(mock.listReads.filter((url) => url.searchParams.get('q') === 'sam').map((url) => url.pathname)).toEqual(
    expect.arrayContaining(['/api/v1/contacts', '/api/v1/leads', '/api/v1/accounts']),
  );

  // An answer with no hits still offers the lists (their q is a substring and matches more).
  await page.goto(`${searchUrl()}/search`);
  const root = screenOf(page);
  await input(root).fill(NO_MATCH);
  await expect(shown(root.getByTestId('search-empty'))).toBeVisible();
  for (const [type] of targets) {
    await expect(shown(root.locator(`a[data-see-all="${type}"]`)).first(), `no "see all" for ${type} after an empty answer`).toBeVisible();
  }
  await expect(shown(root.locator('[data-see-all="deal"]'))).toHaveCount(0);
});

// ===========================================================================
// Requests: debounced, a minimum length, the latest answer wins
// ===========================================================================

test('requests are debounced, never shorter than 2 characters once folded, never over 100, never with a control character @p27-search @p27-search-requests', async ({
  page,
}) => {
  // The clock is driven, not waited on: time still flows, and runFor fires any
  // pending debounce at once, so "nothing was sent" is decided, not hoped.
  await page.clock.install();
  const mock = await openSearch(page);
  const root = screenOf(page);
  const box = input(root);

  for (const short of ['s', ' s ', 'É', 'ś', 'Ø ', '   ']) {
    await box.fill(short);
    await page.clock.runFor(3_000);
    await expect(shown(root.getByTestId('search-empty')), `"${short}" drew "no matches": it was never a search`).toHaveCount(0);
    await expect(shown(root.getByTestId('search-error')), `"${short}" drew an error`).toHaveCount(0);
  }
  await box.fill('Sample\tFixture');
  await page.clock.runFor(3_000);
  await box.fill(`Sample${'x'.repeat(Q_MAX + 20)}`);
  await page.clock.runFor(3_000);

  // Something IS sent once it is long enough: the rule is a minimum, not silence.
  const first = page.waitForRequest((request) => isSearchRead(request, 'sa'));
  await box.fill('sa');
  await page.clock.runFor(3_000);
  await first;
  await settled(root);
  for (const url of mock.searchReads) {
    const q = url.searchParams.get('q') ?? '';
    expect(q.length, 'a q over 100 characters was sent').toBeLessThanOrEqual(Q_MAX);
    expect(hasControlCharacter(q), 'a control character was sent').toBe(false);
  }

  // A word typed fast is one request, or two at most: never one per key.
  await box.fill('');
  await page.clock.runFor(3_000);
  const before = mock.searchReads.length;
  const last = page.waitForRequest((request) => isSearchRead(request, 'sample'));
  await box.pressSequentially('sample');
  await page.clock.runFor(3_000);
  await last;
  await settled(root);
  const typed = mock.searchReads.slice(before).map((url) => url.searchParams.get('q'));
  expect(typed.length, `typing "sample" sent ${typed.length} searches: the search is not debounced`).toBeLessThanOrEqual(2);
  expect(typed.at(-1), 'the last search sent is not what was typed').toBe('sample');
  expect(mock.lookups, 'a name was sent to the lookup').toEqual([]);
});

test('a newer query is sent without waiting, and a stale answer or failure never replaces the newer one @p27-search @p27-search-latest', async ({
  page,
}) => {
  // A screen may abort a superseded request (an AbortController): that is
  // allowed, and then there is no stale answer to wait for.
  const failedTerms: string[] = [];
  page.on('requestfailed', (request) => {
    if (isSearchRead(request)) failedTerms.push(new URL(request.url()).searchParams.get('q') ?? '');
  });
  const mock = await openSearch(page, { holdTerms: ['sam', 'samw'], failTerms: ['samw'] });
  const palette = await openPalette(page);
  const box = input(palette);

  // "sam" is asked and held; "samp" is asked and answered first.
  const heldRead = page.waitForRequest((request) => isSearchRead(request, 'sam'));
  await box.fill('sam');
  await heldRead;
  await expect(shown(palette.getByTestId('search-loading')), 'no loading state while the answer is awaited').toBeVisible();
  await searchFor(page, palette, 'samp');

  // Now the stale "sam" answer arrives. It must change nothing.
  if (failedTerms.includes('sam')) {
    mock.releaseTerm('sam');
  } else {
    const staleSettled = Promise.race([
      page.waitForResponse((response) => isSearchRead(response.request(), 'sam')).then((response) => response.finished()),
      page.waitForEvent('requestfailed', (request) => isSearchRead(request, 'sam')),
    ]);
    mock.releaseTerm('sam');
    await staleSettled;
  }
  await flushTasks(page);
  await expectDrawn(palette, EXPECTED.samp);
  await expect(shown(palette.locator(`[data-hit="${A_SAMARA.id}"], [data-hit="${D_SAMARA.id}"]`)), 'the stale answer for "sam" was drawn over "samp"').toHaveCount(0);
  await expect(shown(palette.getByTestId('search-loading')), 'still loading after the latest answer').toHaveCount(0);

  // A stale FAILURE is no better: "samw" is held, "sampleton" answered, then "samw" fails.
  const failingRead = page.waitForRequest((request) => isSearchRead(request, 'samw'));
  await box.fill('samw');
  await failingRead;
  await searchFor(page, palette, 'sampleton');
  if (failedTerms.includes('samw')) {
    mock.releaseTerm('samw');
  } else {
    const failed = page.waitForEvent('requestfailed', (request) => isSearchRead(request, 'samw'));
    mock.releaseTerm('samw');
    await failed;
  }
  await flushTasks(page);
  await expect(shown(palette.getByTestId('search-error')), 'a stale failure replaced the newer answer').toHaveCount(0);
  await expectDrawn(palette, EXPECTED.sampleton);
});

// ===========================================================================
// R21 on the client: identifiers go only to the lookup, and never into a URL
// ===========================================================================

test('a phone number in any common format goes ONLY to lookupRecords, as a POST body, never to searchRecords @p27-search @p27-search-lookup-phone', async ({
  page,
}) => {
  const mock = await openSearch(page);
  const palette = await openPalette(page);
  for (const [form, id] of PHONE_CASES) {
    const sent = await lookUp(page, palette, form);
    expect(sent, `the number written as "${form.replace(/\d/g, '#')}" was not sent to the lookup`).toBeDefined();
    expect(sent?.method()).toBe('POST');
    expect(new URL(sent?.url() ?? searchUrl()).search, 'the lookup carries a query string').toBe('');
    const body = (sent?.postDataJSON() ?? {}) as Record<string, unknown>;
    expect(Object.keys(body).filter((key) => key !== 'types'), 'the lookup body is not exactly one phone').toEqual(['phone']);
    expect(digitsOf(String(body.phone)), 'the lookup did not send the whole number typed').toBe(digitsOf(form));
    await expect(hit(palette, 'contact', id), 'the lookup’s hit was not drawn').toBeVisible();
    await expect(shown(palette.locator('[data-see-all]')), 'a lookup offers "see all", which would put the number in a URL').toHaveCount(0);
    const drawn = (await visibleText(hit(palette, 'contact', id))).replace(/[\s+().-]/g, '');
    expect(drawn.includes(digitsOf(form)), 'the hit draws the number, which the hit does not carry').toBe(false);
  }
  // Full-width digits are a phone after NFKC (R21), and the body carries ASCII (R28).
  const wide = await lookUp(page, palette, PHONE_FULL_WIDTH);
  expect(wide, 'a full-width number was not sent to the lookup').toBeDefined();
  const wideBody = (wide?.postDataJSON() ?? {}) as Record<string, unknown>;
  expect(String(wideBody.phone), 'the lookup body is not NFKC-normalised (R28)').toMatch(/^[0-9+() .-]+$/);
  expect(digitsOf(String(wideBody.phone))).toBe(digitsOf(PHONE_FULL_WIDTH));
  await expect(hit(palette, 'lead', L_SAMPLEFORD.id), 'a full-width number found nothing').toBeVisible();
  for (const url of mock.searchReads) {
    expect(identifierShaped(url.searchParams.get('q') ?? ''), 'searchRecords was sent a phone-shaped q').toBe(false);
    expect(digitsOf(url.searchParams.get('q') ?? '').length, 'searchRecords was sent six or more digits').toBeLessThan(6);
  }
  expect(mock.lookups.length, 'a lookup was sent per form typed').toBeGreaterThanOrEqual(PHONE_FORMS.length);
});

test('an email address goes ONLY to lookupRecords, as a POST body, compared whole @p27-search @p27-search-lookup-email', async ({ page }) => {
  const mock = await openSearch(page);
  const root = screenOf(page);
  const sent = await lookUp(page, root, `  ${EMAIL}  `);
  expect(sent, 'the address was not sent to the lookup').toBeDefined();
  expect(sent?.method()).toBe('POST');
  expect(new URL(sent?.url() ?? searchUrl()).search).toBe('');
  const body = (sent?.postDataJSON() ?? {}) as Record<string, unknown>;
  expect(Object.keys(body).filter((key) => key !== 'types'), 'the lookup body is not exactly one email').toEqual(['email']);
  expect(String(body.email).trim().toLowerCase(), 'the lookup did not send the whole address typed').toBe(EMAIL.toLowerCase());
  await expect(hit(root, 'contact', C_SAMPLE.id)).toBeVisible();
  await expect(shown(root.locator('[data-see-all]'))).toHaveCount(0);
  expect(await visibleText(hit(root, 'contact', C_SAMPLE.id)), 'the hit draws the address').not.toContain('@');
  expect(mock.searchReads.filter((url) => (url.searchParams.get('q') ?? '').includes('@')), 'searchRecords was sent an @').toEqual([]);

  // A full-width ＠ is an @ after NFKC, and the body carries the ASCII form (R28).
  // A different address, so a screen that remembers an identical lookup still sends one.
  const wide = await lookUp(page, root, 'Samplewise.Testcase＠Example.test');
  expect(wide, 'an address with a full-width ＠ was not sent to the lookup').toBeDefined();
  const wideBody = (wide?.postDataJSON() ?? {}) as Record<string, unknown>;
  expect(String(wideBody.email).trim().toLowerCase(), 'the lookup body is not NFKC-normalised (R28)').toBe('samplewise.testcase@example.test');
  await expect(hit(root, 'contact', C_SAMPLEWISE.id)).toBeVisible();
});

test('phone-like input never reaches searchRecords, not even as a prefix; a neutral hint until it is a whole number (R27) @p27-search @p27-search-phone-prefix', async ({
  page,
}) => {
  // The clock is driven, not waited on: runFor fires any pending debounce at
  // once, so "nothing was searched" is decided, not hoped.
  await page.clock.install();
  const wire = await tapWire(page);
  const mock = await openSearch(page);
  const palette = await openPalette(page);
  const box = input(palette);

  // Four digits, typed key by key: no request of any kind, a hint, never a refusal.
  await box.pressSequentially('0803');
  await page.clock.runFor(3_000);
  const hint = shown(palette.getByTestId('search-hint')).first();
  await expect(hint, 'no "keep typing a full number" hint for a phone-like prefix').toBeVisible();
  await expectSaysOneOf(hint, searchLabels('.keep_typing', '.keepTyping'), 'the keep-typing hint');
  for (const state of ['search-invalid', 'search-error', 'search-empty', 'search-loading']) {
    await expect(shown(palette.getByTestId(state)), `a phone-like prefix drew ${state}`).toHaveCount(0);
  }
  await expect(shown(palette.locator('[data-hit]')), 'a phone-like prefix drew hits').toHaveCount(0);

  // The whole number, typed key by key from an empty box: only its lookup.
  const number = '+234 803 000 0001';
  await box.fill('');
  await page.clock.runFor(3_000);
  const whole = page.waitForRequest((request) => isLookupFor(request, number));
  await box.pressSequentially(number);
  await page.clock.runFor(3_000);
  await (await (await whole).response())?.finished();
  await expect(hit(palette, 'contact', C_SAMPLEWISE.id), 'the whole number found nothing').toBeVisible();
  await expect(shown(palette.getByTestId('search-hint')), 'the hint stayed once the number was whole').toHaveCount(0);
  expect(mock.searchReads.length, 'searchRecords was sent a phone-like prefix (R27)').toBe(0);

  // No digit run from the number in any API request's query, the address bar or a history URL.
  const national = digitsOf(number);
  const runsOf = (text: string): string[] => (text.normalize('NFKC').replace(/[\s+().-]/g, '').match(/\d{3,}/g) ?? []);
  const fromNumber = (text: string, shortest = 3): string[] =>
    runsOf(text).filter((run) => run.length >= shortest && (national.includes(run) || run.includes(national)));
  for (const url of wire.urls) {
    const { pathname, search } = new URL(url);
    if (pathname.startsWith('/api/')) {
      expect(/\d/.test(decodeURIComponent(search)), `an API request carried digits in its query while a number was typed: ${pathname}`).toBe(false);
    } else if (!pathname.startsWith('/_next/static/')) {
      // Page and RSC requests: runs of four or more, so a random cache-busting token is not mistaken for a leak.
      expect(fromNumber(decodeURIComponent(search), 4), `a page request carried digits of the number: ${pathname}`).toEqual([]);
    }
  }
  expect(fromNumber(decodeURIComponent(`${new URL(page.url()).search}${new URL(page.url()).hash}`)), 'the address bar carries digits of the number').toEqual([]);
  for (const entry of await historyLog(page)) {
    const written = entry.split('\n')[0] ?? '';
    expect(fromNumber(decodeURIComponent(written.replace(/^[^?#]*/, ''))), 'a history URL carries digits of the number').toEqual([]);
  }
  for (const request of mock.lookups) {
    expect(request.url.search, 'the lookup carried a query string').toBe('');
  }

  // Letters and digits together are a name (the contract's R21 still applies).
  const named = page.waitForRequest((request) => isSearchRead(request, 'Sample 12'));
  await box.fill('Sample 12');
  await page.clock.runFor(3_000);
  await named;
  await settled(palette);
  await expect(shown(palette.getByTestId('search-hint')), 'a name drew the phone hint').toHaveCount(0);
  expect(mock.searchReads.map((url) => url.searchParams.get('q')), 'only the name was searched').toEqual(['Sample 12']);
});

test('the page URL, history, links, titles and every request URL never carry a phone number or an email address @p27-search @p27-search-url', async ({
  page,
}) => {
  const wire = await tapWire(page);
  const mock = await openSearch(page);
  const root = screenOf(page);

  // A name may ride in the screen's own URL (the builder's choice); only a name.
  await searchFor(page, root, 'sam');
  const named = new URL(page.url());
  if (named.searchParams.has('q')) {
    expect(named.searchParams.get('q'), 'the screen keeps something other than what was typed in its URL').toBe('sam');
  }
  // Typed key by key, as a person types it: every prefix is checked by the mock.
  await input(root).fill('');
  await expect(shown(root.locator('[data-hit]')), 'clearing the box left hits drawn').toHaveCount(0);
  const whole = page.waitForRequest((request) => isLookupFor(request, PHONE_INTL));
  await input(root).pressSequentially(PHONE_INTL);
  await (await (await whole).response())?.finished();
  await expect(hit(root, 'contact', L_FIXTURE.id)).toBeVisible();
  await expect(hit(root, 'lead', L_FIXTURE.id)).toBeVisible();
  await expectIdentifierNowhere(page, wire, PHONE_INTL, 'a phone typed on /search');
  await lookUp(page, root, EMAIL);
  await expect(hit(root, 'contact', C_SAMPLE.id)).toBeVisible();
  await expectIdentifierNowhere(page, wire, EMAIL, 'an email typed on /search');
  const kept = new URL(page.url()).searchParams.get('q');
  expect(kept === null || !identifierShaped(kept), 'the screen’s URL holds an identifier').toBe(true);

  // The palette, on another screen of the shell.
  await page.goto(`${searchUrl()}/contacts`);
  const palette = await openPalette(page);
  await lookUp(page, palette, PHONE);
  await expect(hit(palette, 'contact', C_SAMPLEWISE.id)).toBeVisible();
  await expectIdentifierNowhere(page, wire, PHONE, 'a phone typed in the palette');
  await page.keyboard.press('Escape');
  await expectIdentifierNowhere(page, wire, PHONE, 'after the palette closed');

  // A crafted link carrying an identifier: never searched, never looked up, never kept.
  for (const identifier of ['08030000001', 'sample.fixture@example.test']) {
    const crafted = `${searchUrl()}/search?q=${encodeURIComponent(identifier)}`;
    const lookupsBefore = mock.lookups.length;
    await page.goto(crafted);
    await expect(screenOf(page)).toBeVisible();
    await expect.poll(() => carries(page.url(), identifier), { message: 'the screen left a crafted identifier in the address bar' }).toBe(false);
    await expect(input(screenOf(page)), 'the crafted identifier was put in the search box').not.toHaveValue(new RegExp(identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    await searchFor(page, screenOf(page), 'samw');
    expect(mock.lookups.length, 'a crafted identifier was looked up').toBe(lookupsBefore);
  }
});

test('a partial number or address is refused as such, never searched as a prefix, with no hint that it would match @p27-search @p27-search-partial', async ({
  page,
}) => {
  const mock = await openSearch(page);
  const palette = await openPalette(page);
  for (const [value, suffixes, what] of [
    [PHONE_PARTIAL, ['.invalid_phone', '.invalidPhone'], 'a partial number'],
    [EMAIL_PARTIAL, ['.invalid_email', '.invalidEmail'], 'a partial address'],
  ] as const) {
    const sent = await lookUp(page, palette, value);
    const refusal = shown(palette.getByTestId('search-invalid')).first();
    await expect(refusal, `${what} drew no refusal`).toBeVisible();
    await expectSaysOneOf(refusal, searchLabels(...suffixes), what);
    await expect(shown(palette.getByTestId('search-error')), `${what} drew a failure, not a refusal`).toHaveCount(0);
    await expect(shown(palette.locator('[data-hit]')), `${what} drew hits`).toHaveCount(0);
    if (sent !== undefined) {
      const body = sent.postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).filter((key) => key !== 'types')).toEqual([value.includes('@') ? 'email' : 'phone']);
    }
  }
  expect(mock.searchReads, 'a partial identifier was searched as a prefix').toEqual([]);
  expect(await copyText(palette), 'the overruled "also matches" hint is drawn').not.toMatch(/also match|with or without|0 or \+234|partial/i);
});

// ===========================================================================
// Display: only served fields
// ===========================================================================

test('only served fields are drawn: displayName as served, never composed; withheld parts never shown; markup is text @p27-search @p27-search-fields', async ({
  page,
}) => {
  await openSearch(page, { hostileMarkup: true });
  const palette = await openPalette(page);

  // Served, not composed: the parts joined would read differently.
  await searchFor(page, palette, 'samw');
  const trap = hit(palette, 'contact', C_COMPOSED_TRAP.id);
  expect(await visibleText(trap.locator('[data-field="name"]').first()), 'the name drawn is not the served displayName').toContain(C_COMPOSED_TRAP.displayName);
  expect(await visibleText(trap), 'the name was composed from its parts').not.toContain(`${C_COMPOSED_TRAP.givenNames} ${C_COMPOSED_TRAP.familyName}`);

  // The family name is withheld, so displayName is too (D-L68): the readable part, nothing guessed.
  await searchFor(page, palette, 'sampleton');
  const partial = hit(palette, 'contact', C_SAMPLETON.id);
  expect(await visibleText(partial), 'the readable given name is not drawn').toContain(String(C_SAMPLETON.givenNames));
  expect(await visibleText(partial), 'a withheld name was drawn').not.toContain(String(C_SAMPLETON.familyName));

  // No name readable at all: a lock with a neutral label, never the id.
  await lookUp(page, palette, PHONE_NAMELESS);
  const nameless = hit(palette, 'contact', C_NAMELESS.id);
  await expect(nameless).toBeVisible();
  const label = nameless.locator('[data-field="name"]').first();
  await expect(label).toHaveAttribute('data-locked', 'true');
  expect(await visibleText(label), 'a nameless hit draws nothing').not.toBe('');
  await expect(lockIcon(nameless).first()).toBeAttached();
  const everything = await page.evaluate(() => `${document.body.innerText}\n${Array.from(document.querySelectorAll('[aria-label],[title]')).map((element) => `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`).join('\n')}`);
  for (const value of WITHHELD_VALUES) {
    expect(everything.includes(value), `the withheld value "${value}" reached the page`).toBe(false);
  }
  await expectNoIdsAnywhere(page, 'a nameless hit');

  // Accents kept; accounts and deals by name; no field the hit does not carry.
  await searchFor(page, palette, 'sam');
  await expect(hit(palette, 'contact', C_SAMPLE.id)).toContainText(C_SAMPLE.displayName);
  await expect(hit(palette, 'account', A_HOLDINGS.id)).toContainText(A_HOLDINGS.name);
  await expect(hit(palette, 'deal', D_HOLDINGS.id)).toContainText(D_HOLDINGS.name);
  const results = await visibleText(shown(palette.locator('[role="listbox"]')).first());
  expect(results, 'raw values leaked into the results').not.toMatch(/\bnull\b|\bundefined\b|\[object Object\]/);
  expect(results, 'an email was drawn on a hit').not.toContain('@');

  // Markup in a name is text.
  await searchFor(page, palette, MARKUP_QUERY);
  await expect(shown(palette.locator('[data-hit]')).first()).toContainText('<b>Testcase</b>');
  expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss), 'markup in a name ran').toBeUndefined();
  await expect(palette.locator('img[src="x"], [data-hit] b')).toHaveCount(0);
  expect(HOSTILE_NAME).toContain('<img');
});

test('hits link only from well-formed uuids, URL-encoded; deals are not links; no id is printed @p27-search @p27-search-links', async ({ page }) => {
  const mock = await openSearch(page, { hostileIds: true });
  const palette = await openPalette(page);
  await searchFor(page, palette, 'sam');
  const hrefOf = async (scope: Locator): Promise<string | null> =>
    scope.evaluate((element) => (element instanceof HTMLAnchorElement ? element.getAttribute('href') : element.querySelector('a[href]')?.getAttribute('href') ?? null));
  for (const [type, ids, path] of [
    ['contact', EXPECTED.sam?.contact ?? [], '/contacts/'],
    ['lead', EXPECTED.sam?.lead ?? [], '/contacts/'],
    ['account', EXPECTED.sam?.account ?? [], '/accounts/'],
  ] as const) {
    for (const id of ids) {
      const href = await hrefOf(hit(palette, type, id));
      expect(href, `the ${type} hit ${id} links nowhere`).toBe(`${path}${encodeURIComponent(id)}`);
    }
  }
  for (const id of EXPECTED.sam?.deal ?? []) {
    expect(await hrefOf(hit(palette, 'deal', id)), 'a deal hit links somewhere: there is no deal screen yet (T-0110)').toBeNull();
  }
  for (const href of await palette.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''))) {
    const target = new URL(href, searchUrl());
    const id = /^\/(?:contacts|accounts)\/([^/]+)$/.exec(target.pathname)?.[1];
    if (id !== undefined) {
      expect(UUID_ONLY.test(decodeURIComponent(id)), `${href} links a malformed id`).toBe(true);
    } else {
      expect(['/contacts', '/leads', '/accounts'], `${href} is neither a record nor a list`).toContain(target.pathname);
    }
  }
  await expectNoIdsAnywhere(page, 'grouped results');

  // Ids that are not uuids: never a link, never printed.
  await searchFor(page, palette, HOSTILE_QUERY);
  expect(mock.plantedFaults.length, 'the hostile ids were not served').toBe(2);
  for (const [type, id] of [
    ['contact', HOSTILE_CONTACT_ID],
    ['account', HOSTILE_ACCOUNT_ID],
  ] as const) {
    const scope = palette.locator(`[data-group="${type}"] [data-hit="${id}"]`);
    if ((await scope.count()) > 0) {
      expect(await hrefOf(scope.first()), `the ${type} hit with a malformed id is a link`).toBeNull();
    }
  }
  await expect(page.locator('a[href*="admin/audit"], a[href^="javascript:"], a[href*="javascript%3A"]')).toHaveCount(0);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text, 'a malformed id was printed').not.toContain('../../admin');
  expect(text, 'a malformed id was printed').not.toContain('javascript:');
});

// ===========================================================================
// States
// ===========================================================================

test.describe('states', () => {
  test('loading draws its own state, never "no matches" or an error, until the answer arrives @p27-search @p27-search-states', async ({ page }) => {
    const mock = await openSearch(page, { hold: true });
    const root = screenOf(page);
    await input(root).fill('sam');
    await expect(shown(root.getByTestId('search-loading'))).toBeVisible();
    await expect(shown(root.getByTestId('search-empty'))).toHaveCount(0);
    await expect(shown(root.getByTestId('search-error'))).toHaveCount(0);
    mock.release();
    await expectDrawn(root, EXPECTED.sam);
    await expect(shown(root.getByTestId('search-loading'))).toHaveCount(0);
  });

  test('no matches is its own state, for a name and for a number nobody has; nothing typed is not "no matches" @p27-search @p27-search-states', async ({
    page,
  }) => {
    await openSearch(page);
    const root = screenOf(page);
    await expect(shown(root.getByTestId('search-empty')), '"no matches" before anything was typed').toHaveCount(0);
    await expect(shown(root.locator('[data-hit]')), 'hits before anything was typed (recent searches are not served)').toHaveCount(0);
    await input(root).fill(NO_MATCH);
    const empty = shown(root.getByTestId('search-empty')).first();
    await expect(empty).toBeVisible();
    await expect(shown(root.getByTestId('search-error'))).toHaveCount(0);
    await expect(shown(root.getByTestId('search-loading'))).toHaveCount(0);
    expect(await copyText(empty), 'the empty state counts something').not.toMatch(/\d/);
    await lookUp(page, root, PHONE_NOBODY);
    await expect(shown(root.getByTestId('search-empty'))).toBeVisible();
    await expect(shown(root.getByTestId('search-invalid'))).toHaveCount(0);
    await expectNoSeriousAxe(page, 'P27/A5, no matches');
  });

  test('a failed read is an error, never "no matches", for a name and for a lookup @p27-search @p27-search-states', async ({ page }) => {
    await openSearch(page, { networkFailure: true });
    const root = screenOf(page);
    await input(root).fill('sam');
    const error = shown(root.getByTestId('search-error')).first();
    await expect(error).toBeVisible();
    await expect(shown(root.getByTestId('search-empty'))).toHaveCount(0);
    await expect(shown(root.locator('[data-hit]'))).toHaveCount(0);
    expect(await visibleText(error), 'the failure says nothing').not.toBe('');
    await input(root).fill(PHONE);
    await expect(shown(root.getByTestId('search-error'))).toBeVisible();
    await expect(shown(root.getByTestId('search-empty'))).toHaveCount(0);
  });
});

test('a type the caller cannot read is simply empty: no hint, lock, count or error @p27-search @p27-search-unreadable', async ({ page }) => {
  await openSearch(page, { caller: 'portal' });
  const palette = await openPalette(page);
  const read = page.waitForResponse((response) => isSearchRead(response.request(), 'sam'));
  await input(palette).fill('sam');
  await read;
  await expectDrawn(palette, PORTAL_SAM);
  await expect(shown(palette.locator('[data-group="deal"] [data-hit]'))).toHaveCount(0);
  await expect(lockIcon(palette)).toHaveCount(0);
  await expect(shown(palette.getByTestId('search-error'))).toHaveCount(0);
  expect(await copyText(palette), 'the screen hints at what the caller cannot read').not.toMatch(
    /permission|not allowed|can['’]?t (see|open)|cannot (see|open)|restricted|hidden|no access|not on\b|\d/i,
  );
});

test('a group of a type this screen does not know is ignored; the rest is drawn (R17, additive types) @p27-search @p27-search-additive', async ({ page }) => {
  const mock = await openSearch(page, { futureGroup: true });
  const root = screenOf(page);
  await searchFor(page, root, 'sam');
  expect(mock.plantedFaults.length, 'the future group was not served').toBeGreaterThan(0);
  await expect(shown(root.getByTestId('search-error')), 'an unknown group type broke the whole answer').toHaveCount(0);
  expect(await page.evaluate(() => document.body.innerText), 'the unknown group was drawn').not.toContain(FUTURE_GROUP_TEXT);
  await expect(root.locator('[data-group="ticket"]')).toHaveCount(0);
});

// ===========================================================================
// Absent by design
// ===========================================================================

test('nothing is stored on the device and no recent search is kept, even in memory between openings @p27-search @p27-search-device', async ({ page }) => {
  const mock = await openContacts(page);
  let palette = await openPalette(page);
  const read = page.waitForResponse((response) => isSearchRead(response.request(), 'samplew'));
  await input(palette).fill('samplew');
  await read;
  await expectDrawn(palette, EXPECTED.samplew);
  await lookUp(page, palette, PHONE);
  await lookUp(page, palette, EMAIL);
  await page.keyboard.press('Escape');

  palette = await openPalette(page);
  await expect(input(palette), 'the palette reopened with the last query').toHaveValue('');
  await expect(shown(palette.locator('[data-hit]')), 'the palette reopened with hits').toHaveCount(0);
  expect(await visibleText(palette), 'a recent search is drawn').not.toMatch(/samplew|sample\.fixture|0803|recent/i);

  const stored = await deviceStorage(page);
  expect(stored.cachedApi, 'an API response was put in Cache Storage').toEqual([]);
  expect(stored.databases, 'an IndexedDB database was opened').toEqual([]);
  for (const needle of needles()) {
    expect(stored.dump.toLowerCase().includes(needle.toLowerCase()), `"${needle.slice(0, 12)}…" was written to device storage`).toBe(false);
  }
  await page.reload();
  palette = await openPalette(page);
  await expect(input(palette)).toHaveValue('');
  await expect(shown(palette.locator('[data-hit]'))).toHaveCount(0);
  expect(mock.requests.filter((url) => /recent|history|saved/i.test(url.pathname)), 'recent searches were read from the API').toEqual([]);
});

test('none of the overruled design: no partial-number hint, hidden count, facets, filters, scope menu, recents, commands, AI or create @p27-search @p27-search-absent', async ({
  page,
}) => {
  await openSearch(page);
  const banned: readonly (readonly [RegExp, string])[] = [
    [/also match|with or without spaces|0 or \+234|partial number/i, 'the partial-number hint (A2, overruled)'],
    [/not on\b|not assigned|you can['’]?t open|cannot open|who to ask|ask (your|an) admin|\bhidden\b/i, 'the hidden-results count (B)'],
    [/\bfilters?\b|owned by me|\bowner\b|any time|this week|clear all|best match|recently updated|\bsort\b/i, 'filters, facets or sort (A3, C)'],
    [/search in\b|all (my )?programmes|switch programme|your programmes|\bscope\b/i, 'the scope menu (B1, D2)'],
    [/\brecent\b|recently viewed|clear history/i, 'recent searches (A)'],
    [/ask ai|\bAI\b|suggested|run a command|\bcall\b/i, 'commands, calls or Ask AI (D, D3)'],
    [/create (a )?(contact|lead)|new (contact|lead)|add (contact|lead)/i, 'the create offer (A5)'],
    [/tickets?\b|conversations?\b|\bKB\b|knowledge base|articles?\b/i, 'groups no module serves'],
  ];
  const check = async (root: Locator, where: string) => {
    const copy = await copyText(root);
    for (const [pattern, what] of banned) {
      expect(copy, `${what} is drawn on ${where}`).not.toMatch(pattern);
    }
    expect(copy, `a count is drawn on ${where} (D-P13)`).not.toMatch(/\(\s*\d+\s*\)|\b\d+\s+(results?|matches|more|hidden|others?|contacts?|leads?|accounts?|deals?)\b|\+\d+\b|\bof \d+\b/i);
    await expect(root.locator('[data-facet], input[type="checkbox"], select, [role="menu"], [role="menuitemcheckbox"]'), `facets, filters or a scope menu on ${where}`).toHaveCount(0);
    await expect(root.locator('[aria-hidden="true"]', { hasText: /^\s*(auto_awesome|tune|filter_list|badge|history|dialpad|person_add|bolt|call)\s*$/ }), `a hidden feature’s icon on ${where}`).toHaveCount(0);
  };
  const root = screenOf(page);
  await check(root, 'the screen, nothing typed');
  await searchFor(page, root, 'sam');
  await check(root, 'the screen with results');
  await lookUp(page, root, PHONE);
  await check(root, 'the screen after a lookup');
  const palette = await openPalette(page);
  await check(palette, 'the palette, nothing typed');
  await searchFor(page, palette, 'sam');
  await check(palette, 'the palette with results');
  await input(palette).fill(NO_MATCH);
  await expect(shown(palette.getByTestId('search-empty'))).toBeVisible();
  await check(palette, 'the palette with no matches');
});

// ===========================================================================
// Mobile and i18n
// ===========================================================================

test('at 360px the search fits without sideways page scroll, keeps its header entry and passes axe @p27-search @p27-search-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openSearch(page);
  await expect(shown(page.locator('[data-shell="crm"] header a[href="/search"]')).first(), 'no search entry at 360px').toBeVisible();
  const root = screenOf(page);
  await searchFor(page, root, 'sam');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow(), 'the search scrolls sideways at 360px').toBeLessThanOrEqual(0);
  await expectNoIdsAnywhere(page, 'the 360px search');
  await expectNoSeriousAxe(page, 'P27 at 360px');
});

test('locale=en-XA renders every string as pseudo text, record data excepted @p27-search @p27-search-pseudo', async ({ page }) => {
  await openSearch(page, { query: '?locale=en-XA' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  const report = (scope: Locator) =>
    scope.evaluate((element, servedJson) => {
      const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
      const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
      const recordish = (text: string) => servedJson.includes(text) || servedJson.includes(JSON.stringify(text).slice(1, -1));
      const skipped = (node: Element | null) =>
        node === null || node.closest('[aria-hidden="true"], [data-testid^="language-"], script, style, noscript, time, kbd') !== null;
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
    }, servedData());

  const empty = await report(page.locator('[data-shell="crm"]'));
  expect(empty.english, 'strings on the search screen that did not come through i18n').toEqual([]);
  expect(empty.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(5);
  const root = screenOf(page);
  await searchFor(page, root, 'sam');
  const results = await report(page.locator('[data-shell="crm"]'));
  expect(results.english, 'strings among the results that did not come through i18n').toEqual([]);
  expect(results.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
  for (const type of SEARCH_TYPES) {
    expect(await groupChrome(root, type), `the ${type} group label is not translated`).toMatch(PSEUDO);
  }
  const palette = await openPalette(page);
  await input(palette).fill(NO_MATCH);
  await expect(shown(palette.getByTestId('search-empty'))).toBeVisible();
  const paletteReport = await report(palette);
  expect(paletteReport.english, 'strings in the palette that did not come through i18n').toEqual([]);
  await input(palette).fill(PHONE_PARTIAL);
  await expect(shown(palette.getByTestId('search-invalid'))).toBeVisible();
  expect((await report(palette)).english, 'the refusal did not come through i18n').toEqual([]);
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/search on the wire', () => {
  /**
   * WHY 255,000 BYTES, BEFORE THE SCREEN EXISTS
   *
   * A placeholder ceiling, below the activities and pipeline screens' (the
   * same shell, fonts and records clients, with less on the page: a search box
   * and up to twelve hits). The builder measures it on the first green run;
   * the lead pins SEARCH_BUDGET_BYTES within 5% of that measurement (R26).
   * The palette rides in the shell of EVERY CRM screen, so its weight lands
   * in every other screen's pinned budget too: those suites still hold.
   */
  test('/search stays inside its transferred-byte budget on the production build @p27-search @p27-search-budget', async ({ page }) => {
    // No fake clock here: it replaces window.performance, so the first
    // contentful paint this measures would never be reported (D-L118).
    active = await installSearchMock(page);
    const metrics = await measurePageLoad(page, `${searchUrl()}/search`, 'default');

    const record = resolve(__dirname, '.artifacts', 'p27-search-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(
      record,
      `${JSON.stringify({ path: '/search', transferredBytes: metrics.transferredBytes, budget: SEARCH_BUDGET_BYTES }, null, 2)}\n`,
      'utf8',
    );

    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webSearchUrl is not serving the production build').toBe(built);
    // A 404 page is small: a budget met by the not-found page measures nothing.
    await expect(screenOf(page)).toBeVisible();

    expect(SEARCH_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P27 the search screen', metrics.transferredBytes, SEARCH_BUDGET_BYTES);
  });

  test('/search paints within 5 s at 256 kbps and 300 ms @p27-search @p27-search-budget', async ({ page }) => {
    active = await installSearchMock(page);
    const metrics = await measurePageLoad(page, `${searchUrl()}/search`, 'low-bandwidth');
    await expect(screenOf(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
