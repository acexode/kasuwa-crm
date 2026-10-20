import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BETA_LOCALES, SUPPORTED_LOCALES } from '@kasuwa/i18n';
import { TENANT_A } from '@kasuwa/db';
import { stack, type StackUrls } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  CONTACT_EXAMPLE,
  CONTACT_PROPERTIES,
  EXAMPLE_NEXT_CURSOR,
  FILTER_PARAMETERS,
  ROW_NULLS,
  ROW_PAGE_TWO,
  ROW_VISIBLE_EMAIL,
  installRecordsMock,
  isListContacts,
  parameterEnum,
  scenarioRows,
  type RecordsMock,
  type RecordsMockOptions,
} from './support/records-mock';

/**
 * T-0042 — the CRM app shell and the P04 Contacts list (frames 02, 05, 06),
 * behind `crm_records`. Written by the lead's QA agent BEFORE the screen
 * exists; `tests/acceptance/records-ui/contacts-list.acceptance.test.ts` runs
 * this file with `--grep @p04` and reads the outcome of every test by tag.
 *
 * ---------------------------------------------------------------------------
 * TWO WEB PROCESSES
 *
 *   webUrl         — the existing default server: production build, every
 *                    flag at its default. `/contacts` must be a real 404.
 *   webRecordsUrl  — NEW, the builder adds it to `scripts/run-e2e.mjs` and the
 *                    stack file: apps/web from the SAME production build
 *                    (`next start`), with `crm_records` named in
 *                    `KASUWA_FEATURE_FLAGS_ON`. Every journey and the byte
 *                    budget run here. It must be a production build because
 *                    the budget is measured on it (D-L28); the budget test
 *                    checks the served build id against `.next/BUILD_ID`.
 *                    If `crm_records` is not production-ready, a NODE_ENV=
 *                    production process refuses to boot with it — how the
 *                    harness resolves that (for example `next start` with
 *                    NODE_ENV=test over the same build) is the builder's call.
 *
 * THE LIST IS READ FROM THE BROWSER, AND MOCKED THERE
 *
 * Every journey installs `support/records-mock.ts`, which serves
 * `listContacts` from `docs/api/records.openapi.yaml`. So the screen reads
 * `/api/v1/contacts` from the browser, same-origin, as `lib/admin-api.ts` does
 * — a server-component read cannot show a loading or offline state, and could
 * not be mocked. The mock records every request; `afterEach` fails a test in
 * which the screen sent anything the contract does not declare (see the mock's
 * header for the list).
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                     the CRM app shell; contains a <nav>
 *   [data-screen="P04/02"]                 the list screen root, carrying
 *     data-list-state="loading|ready|empty|no-results|error"
 *   [data-row-id="<contact id>"]           one row (table row or mobile card)
 *   [role="columnheader"][data-column="<Contact property>"]
 *   [data-field="<Contact property>"]      a cell, inside its row;
 *     data-locked="true"                   when the field is WITHHELD
 *   [data-record-text]                     text that is record data (a name, a
 *                                          number, a tag) and not UI copy; the
 *                                          pseudo-locale check skips it, and
 *                                          checks it really is served data
 *   type="search" input                    a name search (T-0124: no number)
 *   [data-testid="number-search-hint"]     shown instead of sending a typed
 *                                          phone, email or number as q
 *   [data-filter="<listContacts param>"]   a filter chip
 *   [data-filter-menu="<param>"] [data-filter-option="<wire value>"]
 *   [data-testid="filter-apply"]           optional "Done" in a filter menu
 *   [data-testid="column-chooser"]         button; opens
 *   [data-testid="column-chooser-panel"]   with [data-column-option="<property>"]
 *   [data-testid="locked-columns-note"]    in the panel, why a column is locked
 *   [data-testid="programme-chip"]
 *   [data-testid="load-more"] or [data-testid="next-page"]
 *   [data-testid="skeleton-row"]
 *   [data-testid="no-results-message"]
 *   [data-action="clear-search-filters"]
 *   [data-action^="import"], [data-action^="capture"]
 *   [data-requires-connection]             disabled while offline
 *   [data-testid="offline-banner"]         shows the last-synced time
 *   [data-testid="filter-sheet-button"], [data-testid="filter-sheet"] (mobile)
 *   [data-testid="language-button"], [data-testid="language-beta"] (existing)
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS
 *
 *   - No totals (D-P13): no "1–25 of 148", no "Page 1 of 6", no count in the
 *     title, no "Show 148 contacts". Load more, or next/previous.
 *   - Columns are Contact properties. P04's "Last activity" and "Engagement"
 *     have no field and are not drawn.
 *   - Filters are `listContacts` parameters. P04's "Preferred language" and
 *     "Consent status" chips have no parameter and are not drawn.
 *   - The search is by name. A typed phone, email or number sends no `q`
 *     (T-0124, D-L180 I9) and shows the number-search hint. P04's placeholder
 *     also promises email; `q` does not search email, so the box must not say
 *     it does.
 *   - Status values are the contract's codes, labelled through i18n; P04's
 *     Active/Prospect/Former are not values (D-L61).
 *   - Ids are not names. The contract gives an agent no programme, owner or
 *     account NAME, so no uuid may be printed where a name was designed.
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P04/02"]';

/**
 * The /contacts transferred-byte budget. The acceptance suite holds it at or
 * under 240,000 bytes and within 5% of what this run measures, so re-pin it to
 * the measurement once the screen exists. Why 240,000: see the budget test.
 */
const CONTACTS_BUDGET_BYTES = 242_000;

/** A half-typed number: since T-0124 it never goes in a list's q (D-L180 I9). */
const NUMBER_SEARCH = '0803 000 000';
/** Adaeze Okonkwo's family name: the name search that does send q. */
const NAME_SEARCH = 'Okonkwo';
/** One letter in every default row's name, so a name search reaches page two. */
const NAME_ON_EVERY_ROW = 'e';
const NAME_WITH_NO_MATCH = 'Okorafor';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let active: RecordsMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.violations, 'the screen sent listContacts something the contract does not declare').toEqual([]);
    const origin = new URL(recordsUrl()).origin;
    for (const url of mock.requests) {
      expect(url.origin, 'listContacts must be a same-origin relative path').toBe(origin);
    }
  }
});

function recordsUrl(): string {
  const urls = stack() as StackUrls & { webRecordsUrl?: string };
  if (typeof urls.webRecordsUrl !== 'string' || urls.webRecordsUrl === '') {
    throw new Error(
      'the stack file has no webRecordsUrl: scripts/run-e2e.mjs starts no web process with ' +
        'crm_records on (see the header of p04-contacts.spec.ts)',
    );
  }
  return urls.webRecordsUrl;
}

function screen(page: Page): Locator {
  return page.locator(SCREEN);
}

/**
 * Visible elements only. A screen may render the table and the mobile card list
 * both and switch them with CSS; the hidden copy is not what a person sees.
 */
function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

function row(page: Page, id: string): Locator {
  return shown(screen(page).locator(`[data-row-id="${id}"]`));
}

function cell(page: Page, id: string, field: string): Locator {
  return row(page, id).locator(`[data-field="${field}"]`);
}

function lockIcon(scope: Locator): Locator {
  // `<Icon name="lock" />` is an aria-hidden ligature span whose text is its name.
  return scope.locator('[aria-hidden="true"]', { hasText: /^\s*lock\s*$/ });
}

function pager(page: Page): Locator {
  return shown(screen(page).locator('[data-testid="load-more"], [data-testid="next-page"]'));
}

/** Text a person can see or hear: aria-hidden subtrees (icon ligatures) removed. */
async function visibleText(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const clone = element.cloneNode(true) as Element;
    clone.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

async function openContacts(
  page: Page,
  options: RecordsMockOptions & { path?: string; state?: string } = {},
): Promise<RecordsMock> {
  const mock = await installRecordsMock(page, options);
  active = mock;
  const response = await page.goto(`${recordsUrl()}${options.path ?? '/contacts'}`);
  expect(response?.status(), '/contacts with crm_records on').toBe(200);
  await expect(screen(page)).toBeVisible();
  if (options.state !== undefined) {
    await expect(screen(page)).toHaveAttribute('data-list-state', options.state);
  }
  return mock;
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

async function expectNoIds(page: Page): Promise<void> {
  expect(await visibleText(screen(page)), 'an id was printed where a name was designed').not.toMatch(UUID);
}

async function applyFilter(page: Page, scope: Locator, filter: string, value: string): Promise<URLSearchParams> {
  const sent = page.waitForRequest(
    (request) => isListContacts(request) && new URL(request.url()).searchParams.getAll(filter).includes(value),
  );
  // A chip opens its menu; a filter-sheet group may already show its options.
  const option = shown(page.locator(`[data-filter-menu="${filter}"] [data-filter-option="${value}"]`));
  const chip = shown(scope.locator(`[data-filter="${filter}"]`));
  if ((await option.count()) === 0 && (await chip.count()) > 0) {
    await chip.first().click();
  }
  await option.first().click();
  const apply = shown(page.getByTestId('filter-apply'));
  if ((await apply.count()) > 0) {
    await apply.first().click();
  }
  return new URL((await sent).url()).searchParams;
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

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_records gates /contacts', () => {
  // The two flag-off tests PASS BEFORE THE WORK STARTS: on a checkout with no
  // /contacts route, every path is already a 404. That is a negative invariant
  // and legitimately vacuous until the route exists; the flag-on test below is
  // what makes the pair mean something, and it fails until then.
  test('/contacts is a real 404 with crm_records at its default, and nothing reaches listContacts @p04 @p04-flag-off', async ({
    page,
  }) => {
    const { webUrl } = stack();
    const mock = await installRecordsMock(page);
    const response = await page.goto(`${webUrl}/contacts`);
    expect(response?.status(), '/contacts is reachable with crm_records off').toBe(404);
    await expect(page.locator(SCREEN)).toHaveCount(0);
    await expect(page.locator('[data-shell="crm"]')).toHaveCount(0);
    expect(mock.requests, 'a flag-off page still read the contacts list').toEqual([]);
  });

  test('/contacts cannot be switched on by anything the browser sends @p04 @p04-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-kasuwa-feature-flags': 'crm_records',
        'x-crm-records': '1',
        'x-kasuwa-tenant-id': TENANT_A,
      },
    });
    await context.addCookies([
      { name: 'crm_records', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_records', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of ['/contacts?crm_records=on&flags=crm_records', '/contacts/', '/contacts?locale=en-XA']) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/contacts renders with crm_records on @p04 @p04-flag-on', async ({ page }) => {
    await openContacts(page, { state: 'ready' });
    await expect(row(page, CONTACT_EXAMPLE.id)).toBeVisible();
  });
});

// ===========================================================================
// The shell
// ===========================================================================

test('the CRM shell has its own nav, separate from the admin console, and every link in it resolves @p04 @p04-shell', async ({
  page,
}) => {
  await openContacts(page, { state: 'ready' });
  const shell = page.locator('[data-shell="crm"]');
  await expect(shell).toBeVisible();
  await expect(shell.locator(SCREEN)).toBeVisible();

  // Not the admin frame wearing a different menu.
  await expect(page.getByTestId('settings-menu')).toHaveCount(0);

  const nav = shown(shell.locator('nav')).first();
  await expect(nav).toBeVisible();
  const contacts = nav.locator('a[href="/contacts"]');
  await expect(contacts).toHaveAttribute('aria-current', 'page');

  // A link to a route that 404s is worse than no link. Unbuilt destinations
  // are left out or drawn as non-links.
  const hrefs = await nav
    .locator('a[href^="/"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  expect(hrefs).toContain('/contacts');
  for (const href of hrefs) {
    const response = await page.request.get(`${recordsUrl()}${href}`);
    expect(response.status(), `the CRM nav links to ${href}, which is a 404`).not.toBe(404);
  }

  await contacts.click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(screen(page)).toBeVisible();
});

// ===========================================================================
// P04/02 — the table
// ===========================================================================

test.describe('P04/02 — the contacts table', () => {
  test('draws the documented columns, only Contact properties, and passes axe @p04 @p04-columns', async ({ page }) => {
    await openContacts(page, { state: 'ready' });

    const columns = await screen(page)
      .locator('[role="columnheader"][data-column]')
      .evaluateAll((headers) => headers.map((header) => header.getAttribute('data-column') ?? ''));

    // P04/02's columns that the contract can fill.
    for (const required of ['displayName', 'phones', 'whatsappOptIn', 'emails', 'accountId', 'ownerUserId', 'tags', 'status']) {
      expect(columns, `no ${required} column`).toContain(required);
    }
    // And nothing the contract cannot: "Last activity" and "Engagement" have no field.
    const invented = columns.filter((column) => !CONTACT_PROPERTIES.includes(column));
    expect(invented, 'columns with no Contact property behind them').toEqual([]);

    await expect(cell(page, CONTACT_EXAMPLE.id, 'displayName')).toContainText(CONTACT_EXAMPLE.displayName);
    const phone = await visibleText(cell(page, CONTACT_EXAMPLE.id, 'phones'));
    expect(phone.replace(/\D/g, ''), 'the phone is not drawn').toContain('8030000001');
    await expect(cell(page, CONTACT_EXAMPLE.id, 'tags')).toContainText('Callback set');

    await expectNoIds(page);
    await expectNoTotals(page);
    await expectNoSeriousAxe(page, 'P04/02');
  });

  test('name search sends q; a typed number sends no q and shows the number-search hint; neither reaches the address bar @p04 @p04-search', async ({
    page,
  }) => {
    const mock = await openContacts(page, { state: 'ready' });
    const search = shown(screen(page).locator('input[type="search"]')).first();
    await expect(search).toBeVisible();

    // The contract's q matches names only (P04's placeholder also says email).
    const promise = `${(await search.getAttribute('placeholder')) ?? ''} ${(await search.getAttribute('aria-label')) ?? ''}`;
    expect(promise, 'the search box promises an email search q does not do').not.toMatch(/e-?mail/i);

    // T-0124 (D-L180 I9, lead re-pin): a phone, email or half-typed number never
    // goes in q, where it would land in URL and access logs. The screen shows
    // the number-search hint instead.
    await search.fill(NUMBER_SEARCH);
    await expect(shown(screen(page).getByTestId('number-search-hint')).first()).toBeVisible();
    expect(page.url(), 'the number was written into the page URL').not.toMatch(/803|[?&]q=/);
    expect(await page.title(), 'the number was written into the document title').not.toMatch(/803/);

    // The positive control, and the ordering proof: a name typed AFTER the
    // number does send q. Requests are sent in typing order, so once the name's
    // request has arrived, a q carrying the number would already have been seen.
    const sent = page.waitForRequest(
      (request) => isListContacts(request) && new URL(request.url()).searchParams.get('q') === NAME_SEARCH,
    );
    await search.fill(NAME_SEARCH);
    await sent;
    await expect(row(page, CONTACT_EXAMPLE.id)).toBeVisible();
    const numbered = mock.requests
      .map((url) => url.searchParams.get('q'))
      .filter((q): q is string => q !== null && /\d/.test(q));
    expect(numbered, 'a listContacts request carried the typed number in q').toEqual([]);

    // A name is personal data too. In the address bar it lands in history,
    // bookmarks, screenshots and the Referer of every link followed.
    expect(page.url(), 'the search term was written into the page URL').not.toMatch(/okonkwo|803|[?&]q=/i);
    expect(await page.title(), 'the search term was written into the document title').not.toMatch(/okonkwo|803/i);
    expect(mock.requests.length).toBeGreaterThan(1);
  });

  test('filter chips send the contract filter parameters, and offer no filter the contract lacks @p04 @p04-filters', async ({
    page,
  }) => {
    await openContacts(page, { state: 'ready' });

    const chips = await screen(page)
      .locator('[data-filter]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-filter') ?? ''));
    expect(chips.length, 'no filter chips').toBeGreaterThan(0);
    const invented = chips.filter((chip) => !FILTER_PARAMETERS.includes(chip));
    expect(invented, 'chips for filters listContacts does not declare').toEqual([]);
    for (const expected of ['status', 'source', 'dnd']) {
      expect(chips, `no ${expected} chip`).toContain(expected);
    }

    // The status menu offers the contract's codes, not P04's Active/Prospect/Former.
    await shown(screen(page).locator('[data-filter="status"]')).first().click();
    const offered = await page
      .locator('[data-filter-menu="status"] [data-filter-option]')
      .evaluateAll((options) => options.map((option) => option.getAttribute('data-filter-option') ?? ''));
    expect(offered.length, 'the status menu offers nothing').toBeGreaterThan(0);
    expect(offered.filter((value) => !parameterEnum('status').includes(value)), 'status values the contract lacks').toEqual([]);
    await page.keyboard.press('Escape');

    const status = await applyFilter(page, screen(page), 'status', 'qualified');
    expect(status.getAll('status')).toContain('qualified');
    await expect(row(page, ROW_PAGE_TWO.id)).toBeVisible();

    const source = await applyFilter(page, screen(page), 'source', 'ussd');
    expect(source.getAll('source')).toContain('ussd');
    expect(source.getAll('status'), 'a second filter dropped the first').toContain('qualified');

    const dnd = await applyFilter(page, screen(page), 'dnd', 'true');
    expect(dnd.get('dnd')).toBe('true');
  });

  test('the column chooser hides and restores a column, and never hides the name @p04 @p04-column-chooser', async ({
    page,
  }) => {
    await openContacts(page, { state: 'ready' });
    await shown(screen(page).getByTestId('column-chooser')).first().click();
    const panel = page.getByTestId('column-chooser-panel');
    await expect(panel).toBeVisible();

    const tags = panel.locator('[data-column-option="tags"]');
    await tags.click();
    await expect(screen(page).locator('[role="columnheader"][data-column="tags"]')).toHaveCount(0);
    await expect(shown(screen(page).locator('[data-field="tags"]'))).toHaveCount(0);

    if (!(await panel.isVisible())) {
      await shown(screen(page).getByTestId('column-chooser')).first().click();
    }
    await tags.click();
    await expect(screen(page).locator('[role="columnheader"][data-column="tags"]')).toHaveCount(1);
    await expect(cell(page, CONTACT_EXAMPLE.id, 'tags')).toContainText('Callback set');

    const name = panel.locator('[data-column-option="displayName"]');
    if ((await name.count()) > 0) {
      const locked = await name.evaluate(
        (element) => (element as HTMLInputElement).disabled === true || element.getAttribute('aria-disabled') === 'true',
      );
      expect(locked, 'the name column can be hidden').toBe(true);
    }
  });

  test('a withheld field shows a lock, never an empty cell, and a null field is never a lock @p04 @p04-locked', async ({
    page,
  }) => {
    await openContacts(page, { state: 'ready' });

    // The example withholds emails and accountId: OMITTED from the row, named in withheldFields.
    for (const field of ['emails', 'accountId']) {
      expect(CONTACT_EXAMPLE.withheldFields).toContain(field);
      for (const id of [CONTACT_EXAMPLE.id, ROW_NULLS.id]) {
        const locked = cell(page, id, field);
        await expect(locked).toHaveAttribute('data-locked', 'true');
        await expect(lockIcon(locked)).toHaveCount(1);
        const said = await visibleText(locked);
        expect(said, `${field} is withheld and drawn as empty`).not.toBe('');
        expect(said, `${field} is withheld and drawn as a missing value`).not.toMatch(/^(null|undefined|—|-|–)$/i);
      }
      await expect(lockIcon(screen(page).locator(`[role="columnheader"][data-column="${field}"]`))).toHaveCount(1);
    }

    // Row B's owner and status are NULL: "no value", which is not a lock.
    for (const field of ['ownerUserId', 'status']) {
      const empty = cell(page, ROW_NULLS.id, field);
      await expect(empty).toBeVisible();
      await expect(empty).not.toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(empty)).toHaveCount(0);
      expect(await visibleText(empty), `${field} is null and drawn as text`).not.toMatch(/null|undefined/i);
    }

    // The chooser explains the lock.
    await shown(screen(page).getByTestId('column-chooser')).first().click();
    const panel = page.getByTestId('column-chooser-panel');
    const option = panel.locator('[data-column-option="emails"]');
    await expect(option).toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(option)).toHaveCount(1);
    const note = panel.getByTestId('locked-columns-note');
    await expect(note).toBeVisible();
    expect(await visibleText(note), 'the chooser does not say why a column is locked').not.toBe('');
  });

  test('locks are per row: the same column is locked in one programme and readable in another @p04 @p04-locked', async ({
    page,
  }) => {
    await openContacts(page, { scenario: 'mixedWithheld', state: 'ready' });

    await expect(cell(page, CONTACT_EXAMPLE.id, 'emails')).toHaveAttribute('data-locked', 'true');
    const visible = cell(page, ROW_VISIBLE_EMAIL.id, 'emails');
    await expect(visible).toContainText('ngozi.eze@example.com');
    await expect(visible).not.toHaveAttribute('data-locked', 'true');
    await expect(lockIcon(visible)).toHaveCount(0);
  });

  test('the programme chip says the list is programme-scoped, prints no id, and sends no scope @p04 @p04-programme-chip', async ({
    page,
  }) => {
    const mock = await openContacts(page, { state: 'ready' });
    const chip = shown(screen(page).getByTestId('programme-chip')).first();
    await expect(chip).toBeVisible();
    const said = await visibleText(chip);
    expect(said, 'the programme chip is empty').not.toBe('');
    expect(said, 'the programme chip prints an id').not.toMatch(UUID);

    // Scope is resolved, never supplied — whatever the chip does when pressed.
    if (await chip.isEnabled()) {
      await chip.click();
      await page.keyboard.press('Escape');
    }
    for (const url of mock.requests) {
      expect([...url.searchParams.keys()].filter((key) => /programme/i.test(key))).toEqual([]);
    }
  });

  test('pages forward with nextCursor, echoed exactly, with no total and no "Page X of Y" @p04 @p04-paging', async ({
    page,
  }) => {
    await openContacts(page, { state: 'ready' });
    await expect(row(page, CONTACT_EXAMPLE.id)).toBeVisible();
    await expect(row(page, ROW_NULLS.id)).toBeVisible();
    await expect(row(page, ROW_PAGE_TWO.id)).toHaveCount(0);
    await expectNoTotals(page);

    // Two rows against a limit of 25, and a nextCursor: more exists. A screen
    // reading `data.length < limit` as "last page" has no control here.
    await expect(pager(page)).toBeEnabled();
    const sent = page.waitForRequest(
      (request) => isListContacts(request) && new URL(request.url()).searchParams.has('cursor'),
    );
    await pager(page).click();
    expect(new URL((await sent).url()).searchParams.get('cursor'), 'the cursor was not echoed verbatim').toBe(
      EXAMPLE_NEXT_CURSOR,
    );
    await expect(row(page, ROW_PAGE_TWO.id)).toBeVisible();
    await expectNoTotals(page);

    // nextCursor: null — the last page offers no further page.
    const more = pager(page);
    if ((await more.count()) > 0) {
      await expect(more).toBeDisabled();
    }
  });

  test('the next page keeps the search that produced the cursor @p04 @p04-paging', async ({ page }) => {
    await openContacts(page, { state: 'ready' });
    const searched = page.waitForRequest(
      (request) => isListContacts(request) && new URL(request.url()).searchParams.has('q'),
    );
    // T-0124: a name, not a number (a number sends no q, D-L180 I9).
    await shown(screen(page).locator('input[type="search"]')).first().fill(NAME_ON_EVERY_ROW);
    const q = new URL((await searched).url()).searchParams.get('q');
    await expect(pager(page)).toBeEnabled();

    const next = page.waitForRequest(
      (request) => isListContacts(request) && new URL(request.url()).searchParams.has('cursor'),
    );
    await pager(page).click();
    const params = new URL((await next).url()).searchParams;
    expect(params.get('q'), 'the cursor was sent without the search it belongs to').toBe(q);
    await expect(row(page, ROW_PAGE_TWO.id)).toBeVisible();
  });
});

// ===========================================================================
// P04/05 and P04/06 — the states
// ===========================================================================

test.describe('P04/05 and P04/06 — empty, no results, loading, offline', () => {
  test('P04/05 empty: no contacts yet offers import and capture @p04 @p04-empty', async ({ page }) => {
    await openContacts(page, { scenario: 'empty', state: 'empty' });
    await expect(screen(page).locator('[data-action^="import"]').first()).toBeVisible();
    await expect(screen(page).locator('[data-action^="capture"]').first()).toBeVisible();
    await expect(screen(page).getByTestId('no-results-message')).toHaveCount(0);
    await expect(screen(page).locator('[data-row-id]')).toHaveCount(0);
  });

  test('P04/05 no results names the search and the filters, and clears both @p04 @p04-no-results', async ({ page }) => {
    const mock = await openContacts(page, { state: 'ready' });

    const statusLabel = await visibleText(shown(screen(page).locator('[data-filter="status"]')).first());
    expect(statusLabel, 'the status chip has no label').not.toBe('');
    await applyFilter(page, screen(page), 'status', 'qualified');

    const searched = page.waitForRequest(
      (request) => isListContacts(request) && new URL(request.url()).searchParams.get('q') === NAME_WITH_NO_MATCH,
    );
    await shown(screen(page).locator('input[type="search"]')).first().fill(NAME_WITH_NO_MATCH);
    await searched;

    await expect(screen(page)).toHaveAttribute('data-list-state', 'no-results');
    const message = screen(page).getByTestId('no-results-message');
    await expect(message).toContainText(NAME_WITH_NO_MATCH);
    await expect(message).toContainText(statusLabel);

    const cleared = page.waitForRequest((request) => {
      if (!isListContacts(request)) {
        return false;
      }
      const params = new URL(request.url()).searchParams;
      return !params.has('q') && !params.has('status');
    });
    await screen(page).locator('[data-action="clear-search-filters"]').click();
    await cleared;
    await expect(screen(page)).toHaveAttribute('data-list-state', 'ready');
    await expect(row(page, CONTACT_EXAMPLE.id)).toBeVisible();
    expect(mock.requests.length).toBeGreaterThan(2);
  });

  test('P04/06 loading draws skeleton rows, never the empty state, until the list arrives @p04 @p04-loading', async ({
    page,
  }) => {
    const mock = await openContacts(page, { hold: true, state: 'loading' });
    try {
      expect(await screen(page).getByTestId('skeleton-row').count(), 'fewer than three skeleton rows').toBeGreaterThanOrEqual(3);
      // data-list-state is "loading", not "empty": "No contacts yet" while the
      // request is in flight is a lie told for a second.
      await expect(screen(page).getByTestId('no-results-message')).toHaveCount(0);
    } finally {
      mock.release();
    }
    await expect(screen(page)).toHaveAttribute('data-list-state', 'ready');
    await expect(screen(page).getByTestId('skeleton-row')).toHaveCount(0);
    await expect(row(page, CONTACT_EXAMPLE.id)).toBeVisible();
  });

  test('a failed read is an error, not "no contacts" and not "no results" @p04 @p04-loading', async ({ page }) => {
    await openContacts(page, { networkFailure: true, state: 'error' });
    await expect(screen(page).getByTestId('no-results-message')).toHaveCount(0);
    await expect(screen(page).locator('[data-row-id]')).toHaveCount(0);
  });

  test('P04/06 offline keeps the list, says when it last synced, and disables what needs a connection @p04 @p04-offline', async ({
    page,
  }) => {
    await openContacts(page, { state: 'ready' });
    const needsConnection = screen(page).locator('[data-requires-connection]');
    await expect(screen(page).locator('[data-action^="import"][data-requires-connection]').first()).toBeAttached();

    await page.context().setOffline(true);
    try {
      const banner = shown(page.getByTestId('offline-banner')).first();
      await expect(banner).toBeVisible();
      expect(await visibleText(banner), 'the banner does not say when the list last synced').toMatch(/\d{1,2}[:.]\d{2}/);
      await expect(row(page, CONTACT_EXAMPLE.id)).toBeVisible();

      const count = await needsConnection.count();
      expect(count, 'nothing is marked as needing a connection').toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const disabled = await needsConnection
          .nth(index)
          .evaluate(
            (element) =>
              (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true',
          );
        expect(disabled, `a control that needs a connection is enabled offline (#${index})`).toBe(true);
      }
      // The next page is a request; offline, it cannot be fetched.
      if ((await pager(page).count()) > 0) {
        await expect(pager(page)).toBeDisabled();
      }
    } finally {
      await page.context().setOffline(false);
    }
    await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);
  });
});

// ===========================================================================
// Mobile
// ===========================================================================

test('at 360px the list fits without sideways page scroll and the filter sheet opens and filters @p04 @p04-mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openContacts(page, { state: 'ready' });
  await expect(row(page, CONTACT_EXAMPLE.id)).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'the page scrolls sideways at 360px').toBeLessThanOrEqual(0);

  const button = shown(screen(page).getByTestId('filter-sheet-button')).first();
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(Math.min(box?.width ?? 0, box?.height ?? 0), 'the filter button is under 44px').toBeGreaterThanOrEqual(44);

  await button.click();
  const sheet = page.getByTestId('filter-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('role', 'dialog');
  const sheetBox = await sheet.boundingBox();
  expect((sheetBox?.x ?? -1) >= 0 && (sheetBox?.x ?? 0) + (sheetBox?.width ?? 999) <= 360, 'the sheet is off screen').toBe(
    true,
  );

  const params = await applyFilter(page, sheet, 'status', 'qualified');
  expect(params.getAll('status')).toContain('qualified');
  await expect(row(page, ROW_PAGE_TWO.id)).toBeVisible();

  const after = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(after, 'the page scrolls sideways at 360px after filtering').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P04/02 at 360px');
});

// ===========================================================================
// i18n
// ===========================================================================

test.describe('i18n on /contacts', () => {
  test('locale=en-XA renders every string as pseudo text, record data excepted @p04 @p04-pseudo', async ({ page }) => {
    await openContacts(page, { path: '/contacts?locale=en-XA', state: 'ready' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');

    const served = JSON.stringify(scenarioRows('default'));
    const report = await page.locator('[data-shell="crm"]').evaluate((root, rowsJson) => {
      // Generated pseudo text is `[Àccëntëd··]`: brackets, accented vowels, a pad of `·`.
      const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
      const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
      const digits = (text: string) => text.replace(/\D/g, '');
      const recordish = (text: string) =>
        rowsJson.includes(text) || (digits(text).length >= 7 && digits(rowsJson).includes(digits(text)));
      // Icon ligatures are aria-hidden; language names are endonyms, never translated.
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
        if (!letters(text) || skipped(parent)) {
          continue;
        }
        if (parent?.closest('[data-record-text]')) {
          if (!recordish(text)) {
            forged.push(text);
          }
          continue;
        }
        if (pseudo(text)) {
          pseudoCount += 1;
        } else {
          english.push(text);
        }
      }
      for (const element of Array.from(root.querySelectorAll('[placeholder], [aria-label], [title]'))) {
        if (skipped(element)) {
          continue;
        }
        for (const name of ['placeholder', 'aria-label', 'title']) {
          const value = element.getAttribute(name);
          if (value !== null && letters(value) && !pseudo(value)) {
            english.push(`${name}="${value}"`);
          }
        }
      }
      return { english, forged, pseudoCount };
    }, served);

    expect(report.english, 'strings on /contacts that did not come through i18n').toEqual([]);
    expect(report.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
    expect(report.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(10);
    // The status of the example row is a code ("contacted"); its label is copy.
    expect(await visibleText(cell(page, CONTACT_EXAMPLE.id, 'status'))).toMatch(/·/);
  });

  test('the CRM shell language menu still marks every unreviewed language Beta (D-P1) @p04 @p04-beta', async ({
    page,
  }) => {
    await openContacts(page, { state: 'ready' });
    const shell = page.locator('[data-shell="crm"]');
    await shown(shell.getByTestId('language-button')).first().click();
    await expect(page.getByRole('listbox')).toBeVisible();
    const expected = BETA_LOCALES.filter((locale) => !SUPPORTED_LOCALES.includes(locale)).length;
    // Zero would be legitimate only once every language is signed off; the
    // acceptance suite separately checks no design-menu language was dropped.
    await expect(page.getByTestId('language-beta')).toHaveCount(expected);
  });
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/contacts on the wire', () => {
  /**
   * WHY 240,000 BYTES, BEFORE THE SCREEN EXISTS
   *
   * Pinned near the closest measured neighbours (T-0035, p02-admin.spec.ts),
   * not at the 300 KB PRD 2.13 ceiling:
   *
   *   /admin/programmes   218,930 B   a list with a search and a status filter
   *   /admin/audit        253,870 B   a table with filter chips and paging,
   *                                   31,714 B of it JetBrains Mono
   *   P01/1 (sign-in)     252,000 B   budget
   *
   * /contacts is a list like /admin/programmes plus a column chooser, a filter
   * menu, a filter sheet and an offline banner — roughly 20 KB of island — and
   * has no need of the monospace face. 240,000 leaves that and nothing more.
   * The acceptance suite requires it re-pinned within 5% of the measurement.
   */
  test('/contacts stays inside its transferred-byte budget on the production build @p04 @p04-budget', async ({
    page,
  }) => {
    active = await installRecordsMock(page);
    const metrics = await measurePageLoad(page, `${recordsUrl()}/contacts`, 'default');

    const record = resolve(__dirname, '.artifacts', 'p04-contacts-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(
      record,
      `${JSON.stringify({ path: '/contacts', transferredBytes: metrics.transferredBytes, budget: CONTACTS_BUDGET_BYTES }, null, 2)}\n`,
      'utf8',
    );

    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webRecordsUrl is not serving the production build').toBe(built);

    expect(CONTACTS_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P04/02 the contacts list', metrics.transferredBytes, CONTACTS_BUDGET_BYTES);
  });

  test('/contacts paints within 5 s at 256 kbps and 300 ms @p04 @p04-budget', async ({ page }) => {
    active = await installRecordsMock(page);
    const metrics = await measurePageLoad(page, `${recordsUrl()}/contacts`, 'low-bandwidth');
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});

// ===========================================================================
// Live (T-0041)
// ===========================================================================

test.fixme(
  'P04/02 against the real contacts API and the seeded database @p04-live',
  async () => {
    // Pending T-0041 (q, filters and withheldFields on the live wire). When it
    // merges: no mock, a seeded agent from @kasuwa/db, and the seeded contact
    // names asserted — data the contract's example cannot supply.
  },
);
