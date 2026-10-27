import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TENANT_A } from '@kasuwa/db';
import { stack } from './support/stack';
import { assertWithinByteBudget, measurePageLoad } from './support/metrics';
import { servedBuildId } from './support/critical-path';
import {
  ARRIVAL_AMOUNT,
  A_PHARMACY,
  BIG_COLUMN_LENGTH,
  BOARD_DEFAULT_LIMIT,
  CURRENCIES,
  C_ALPHA,
  C_ALPHA_ELSEWHERE,
  DEFAULT_CLOSED_SINCE,
  D_BIG,
  D_C1,
  D_C2,
  D_C3,
  D_D1,
  D_D2,
  D_L1,
  D_L2,
  D_N1,
  D_N2,
  D_P1,
  D_P2,
  D_P3,
  D_P4,
  D_Q1,
  D_Q2,
  D_Q_MARKUP,
  D_Q_OTHER,
  D_W1,
  D_W2,
  EARLIEST_CLOSED_SINCE_MS,
  E_P1,
  E_Q1,
  HOSTILE_NAME,
  ME,
  NO_FILTERS,
  NOW,
  NOW_MS,
  OUT_OF_SCOPE_PIPELINE_ID,
  PIPELINE_ONE,
  PIPELINE_TWO,
  PROGRAMME_ONE,
  R_AMOUNT,
  R_BUDGET,
  R_CLOSE,
  R_CONTACT,
  R_DRIFT,
  R_PO,
  R_QUOTE,
  SORT_KEYS,
  S_CONTRACT,
  S_DISCOVERY,
  S_LOST,
  S_NEGOTIATION,
  S_PROPOSAL,
  S_QUALIFIED,
  S_WON,
  T_NEGOTIATION,
  T_PROPOSAL,
  T_QUALIFIED,
  T_R_QUOTE,
  answerProblems,
  baseDeals,
  boardStages,
  columnRows,
  columnTotals,
  installPipelineMock,
  isBoardRead,
  isCreateDeal,
  isListDeals,
  isMoveDeal,
  listRows,
  pipelineSummaries,
  servedData,
  weightedMinor,
  type PipelineMock,
  type PipelineMockOptions,
  type Stage,
  type StoredDeal,
} from './support/pipeline-mock';

/**
 * T-0109 — the P06 pipeline board and list view (`docs/design/P06/`, frames
 * P06/01 and P06/01b), behind `crm_pipeline`, in the CRM shell, against
 * T-0107's and T-0108's served contract. Written by the lead's QA agent
 * BEFORE the screen exists (D-L23);
 * `tests/acceptance/records-ui/pipeline-board.acceptance.test.ts` runs this
 * file with `--grep @p06-pipeline` and reads every outcome by tag.
 * Decisions: D-L88, D-L102, D-L113, D-L115, D-L123, D-L124, D-L127, D-P19,
 * D-P13, D-P21, D-L97.
 *
 * TAG RULE (D-L84). `@p06-pipeline` is the parent tag. Playwright's --grep is
 * a regular expression, so no other screen's tag may contain it, and it
 * contains no other screen's parent tag. Every sub-tag is `@p06-pipeline-<name>`.
 * T-0110 (deal detail) must not use `@p06-pipeline…` or a bare `@p06`.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTES AND THE WEB PROCESS (rulings R1–R3 in the acceptance suite)
 *
 *   /pipelines                 the caller's pipelines by name (listPipelines),
 *                              each a link to its board; the nav's target
 *   /pipelines/<pipelineId>    the board (P06/01) and the list view (P06/01b)
 *
 *   webUrl           — the default server, every flag at its default. Both
 *                      routes must be a real 404 there.
 *   webPipelineUrl   — NEW, published in the stack file by the builder's
 *                      change to `scripts/run-e2e.mjs`. `crm_pipeline` RIDES
 *                      ON THE RECORDS PROCESS (`webRecordsUrl`), beside
 *                      `crm_records`, `crm_accounts` and `crm_record_view`, so
 *                      the cards' contact and account links resolve. Every
 *                      journey and the byte budget run there, on the
 *                      production build.
 *
 * EVERY READ AND WRITE GOES THROUGH THE CONTRACT MOCK
 *
 * Every journey installs `support/pipeline-mock.ts`, which serves the P06
 * operations from the contracts and checks every answer it gives against
 * them. `afterEach` fails a test in which the screen sent anything the
 * contract or this screen's rules do not allow (the mock's header lists
 * them), left the origin, or in which the mock answered something its own
 * contract rejects.
 *
 * THE CLOCK. Journeys fix the browser's clock to the mock's NOW (09:00 UTC,
 * Monday 12 October 2026) with `page.clock.setFixedTime`; the byte-budget
 * journeys do not (D-L118: the fake clock hides first contentful paint).
 *
 * THE DOM HOOKS THIS FILE RELIES ON (the builder's side of the contract)
 *
 *   [data-shell="crm"]                       the CRM shell; its <nav> links
 *     a[href="/pipelines"]                   (the Deals entry) with
 *                                            aria-current="page" on both routes
 *   INDEX (/pipelines)
 *   [data-testid="pipeline-index"]           the list, holding
 *     [data-pipeline="<pipeline id>"]        one row per pipeline, in served
 *       a[href="/pipelines/<id>"]            order, naming it
 *   [data-testid="pipeline-index-empty"], [data-testid="pipeline-index-error"]
 *   BOARD AND LIST (/pipelines/<id>)
 *   [data-screen="P06/01"]                   the screen root, both views,
 *     data-view="board|list"
 *   h1                                       the pipeline's name
 *   [data-view-option="board"|"list"]        the view switch
 *   [data-testid="board"]                    the board, holding
 *     [data-stage-column="<stage id>"]       one column per open stage, then
 *       data-stage-kind="open|won"           won, in position order; a drop
 *                                            target
 *       [data-field="stage-name"]            the stage's name (record text)
 *       [data-stage-count]                   the served `count`, nothing else
 *       [data-stage-total="<currency>"]      one per served total, in served
 *         [data-money="amount"]              order, each holding the exact
 *         [data-money="weighted"]            amount and weighted amount
 *       [data-stage-totals]                  the totals' container; with
 *         data-locked="true"                 `amount` withheld, a lock
 *       [data-testid="won-since"] <time datetime="<closedSince>">   (won only)
 *       [data-deal-card="<deal id>"]         one card, in served order,
 *         data-rotting="fresh|stale|rotting" the served `rotting` (absent on won)
 *         [data-field="name"]                (record text), holding the one
 *                                            a[href="/deals/<deal id>"] (T-0110,
 *                                            which asserts it: R15)
 *         [data-field="amount"]              the exact amount, or a lock
 *         [data-field="owner"]               the owner's name, a lock, or the
 *                                            translated "former owner"
 *         [data-field="expectedCloseDate"]   a <time>, or a lock (when served)
 *         [data-related="account|contact"]   the summary: a link to
 *                                            /accounts/<id> or /contacts/<id>
 *                                            for a well-formed uuid, else text
 *         [data-action="move-deal"]          a <button> opening the move sheet
 *         data-locked="true"                 on any withheld [data-field]
 *       [data-testid="column-more"], [data-testid="column-empty"],
 *       [data-testid="column-error"]
 *   [data-testid="board-skeleton"|"board-empty"|"board-error"]
 *   [data-testid="record-not-found"]         an unknown or unreachable pipeline
 *   FILTERS
 *   [data-filter="q"]                        input[type="search"]: the name
 *   [data-filter="owner"|"currency"|"closedSince"]
 *                                            a <select>, or a button opening
 *   [data-filter-menu="<param>"]             with [data-filter-option="<value>"]
 *                                            (owner: me, unassigned, ids;
 *                                            currency: the code; closedSince:
 *                                            a whole number of days) and an
 *                                            optional [data-testid="filter-apply"]
 *   [data-filter-input="closeFrom"|"closeTo"]   input[type="date"], visible, or
 *                                            inside a [data-filter="close"]
 *                                            control that opens them
 *   LIST
 *   [data-testid="deal-list"]                rows [data-deal-row="<deal id>"] in
 *                                            served order, each with
 *                                            [data-field="name"|"stage"|"amount"]
 *   [role="columnheader"][data-column="name"|"stage"|"amount"|…]
 *   [data-testid="sort-control"]             a <select>, or a button opening
 *     [data-sort-option="<sort key>"]        options
 *   [data-testid="deal-list-more"], [data-testid="list-empty"],
 *   [data-testid="list-no-results"], [data-testid="list-error"]
 *   MOVES
 *   [data-testid="move-sheet"]               role=dialog:
 *     [data-move-to="<stage id>"]            one option per target, by name
 *   [data-testid="move-requirements"]        role=dialog: the requirement prompt
 *     [data-requirement="<requirement id>"]  every target requirement, with
 *       data-met="true|false", data-locked="true" when withheld
 *       [data-requirement-input="<id>"]      a checkbox (check), a date, text
 *                                            or amount input (field), or a
 *                                            search box (contact or account)
 *       [data-requirement-currency="<id>"]   (amount) the currency <select>
 *       [data-picker-option="<record id>"]   a picker result, by name
 *       [data-conflict]                      D-L102's "changed by someone else"
 *     [data-action="confirm-move"], [role="alert"]
 *   [role="alert"]                           a refusal, inside the screen
 *   CREATE
 *   [data-action="new-deal"]                 opens
 *   [data-testid="deal-create"]              role=dialog, with
 *     [data-field-input="name|amount|currency|expectedCloseDate|nextStep"]
 *                                            (amount: a text input in major
 *                                            units, never type=number;
 *                                            currency: a <select> of codes)
 *     [data-field-error="<field>"]           a translated local refusal
 *     [data-action="create-deal"], [role="alert"]
 *   [data-requires-connection]               on every write control
 *   [data-testid="offline-banner"]           with the last-synced time
 *   [data-record-text]                       record data, not UI copy (en-XA)
 *
 * DESIGN AGAINST CONTRACT — WHERE THEY DISAGREE THE CONTRACT WINS (R4–R18)
 *
 *   Hidden: Show US$ and every FX rate, territory, the amount-band filter, AI
 *   deal risk, products, price books and quotes, approvals and "Waiting for
 *   approval", attachments, last WhatsApp contact, contact roles,
 *   competitors, the template picker (P06/07), the board-level summary
 *   ("Open pipeline", "Weighted", "Won this quarter", "N open deals"), Undo,
 *   the list footer's count and totals, and "+7 won earlier this quarter".
 *   Column totals are EXACT (D-P19), never compact; rotting is the server's
 *   (21 days on Contract), never the design's fixed 7/14.
 * ---------------------------------------------------------------------------
 */

const SCREEN = '[data-screen="P06/01"]';

/**
 * The /pipelines/[pipelineId] transferred-byte budget. PLACEHOLDER, TO BE
 * PINNED BY THE LEAD FROM MEASUREMENT (D-L118): the acceptance suite holds it
 * at or under 260,000 bytes and within 5% of what the run measures, so it
 * fails until the lead re-pins this one line to the builder's first green
 * measurement. Why the ceiling: see the budget test.
 */
const PIPELINE_BUDGET_BYTES = 299_500;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const EN = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'packages', 'i18n', 'src', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>;

const DAY = 86_400_000;

// Kasuwa's users are in WAT/EAT/SAST; the clock and the dates are Lagos'.
test.use({ timezoneId: 'Africa/Lagos' });

/**
 * The board as it starts, written out by hand from the contract's rules and
 * independent of the mock's code (the mock's oracle is checked against it in
 * `@p06-pipeline-mock`). Weighted totals are half-even PER DEAL, then summed:
 * Qualified's 378500002 (not 378500003) and Proposal's NGN 2100000000 (not
 * 2100000001) are what rounding once at the end gets wrong.
 */
interface ExpectedColumn {
  stage: Stage;
  count: number;
  cards: readonly StoredDeal[];
  totals: readonly { currency: string; amountMinor: string; weightedAmountMinor: string }[];
}

const EXPECTED_BOARD: readonly ExpectedColumn[] = [
  {
    stage: S_QUALIFIED,
    count: 4,
    cards: [D_Q2, D_Q1, D_Q_MARKUP, D_Q_OTHER],
    totals: [{ currency: 'NGN', amountMinor: '3785000030', weightedAmountMinor: '378500002' }],
  },
  {
    stage: S_DISCOVERY,
    count: 3,
    cards: [D_D1, D_D2, D_BIG],
    totals: [{ currency: 'NGN', amountMinor: '1000000000974999999', weightedAmountMinor: '250000000243750000' }],
  },
  {
    stage: S_PROPOSAL,
    count: 4,
    cards: [D_P4, D_P3, D_P2, D_P1],
    totals: [
      { currency: 'GHS', amountMinor: '4500003', weightedAmountMinor: '2250002' },
      { currency: 'NGN', amountMinor: '4200000002', weightedAmountMinor: '2100000000' },
    ],
  },
  {
    stage: S_NEGOTIATION,
    count: 2,
    cards: [D_N1, D_N2],
    totals: [
      { currency: 'KES', amountMinor: '7500000', weightedAmountMinor: '5250000' },
      { currency: 'NGN', amountMinor: '1500000015', weightedAmountMinor: '1050000010' },
    ],
  },
  {
    stage: S_CONTRACT,
    count: 3,
    cards: [D_C3, D_C2, D_C1],
    totals: [
      { currency: 'NGN', amountMinor: '1190000000', weightedAmountMinor: '1071000000' },
      { currency: 'ZAR', amountMinor: '125000000', weightedAmountMinor: '112500000' },
    ],
  },
  {
    stage: S_WON,
    count: 1,
    cards: [D_W1],
    totals: [{ currency: 'NGN', amountMinor: '4500000000', weightedAmountMinor: '4500000000' }],
  },
];

/** What rounding once at the end, or summing across currencies, would draw. Never on the screen. */
const WRONG_NUMBERS: readonly string[] = ['378500003', '2100000001', '4204500005', '1507500015', '1315000000'];

let active: PipelineMock | undefined;

test.afterEach(async ({ page }) => {
  const mock = active;
  active = undefined;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  if (mock !== undefined) {
    expect(mock.mockFaults, 'the MOCK answered something its contract rejects (a mock bug, not the screen’s)').toEqual([]);
    expect(mock.violations, 'the screen sent the API something the contract or this screen’s rules do not allow').toEqual([]);
    if (mock.requests.length > 0) {
      const origin = new URL(pipelineUrl()).origin;
      for (const url of mock.requests) {
        expect(url.origin, 'the pipeline API must be called same-origin, by a relative path').toBe(origin);
      }
    }
  }
});

function pipelineUrl(): string {
  const urls = stack() as unknown as Readonly<Record<string, unknown>>;
  const url = urls.webPipelineUrl;
  if (typeof url !== 'string' || url === '') {
    throw new Error(
      'the stack file has no webPipelineUrl: scripts/run-e2e.mjs starts no web process with crm_pipeline on ' +
        '(see the header of p06-pipeline.spec.ts)',
    );
  }
  return url;
}

function screen(page: Page): Locator {
  return page.locator(SCREEN);
}

/** Visible elements only: a screen may render desktop and mobile layouts and switch them with CSS. */
function shown(locator: Locator): Locator {
  return locator.filter({ visible: true });
}

function column(page: Page, stageId: string): Locator {
  return shown(screen(page).locator(`[data-stage-column="${stageId}"]`)).first();
}

function card(page: Page, stageId: string, dealId: string): Locator {
  return shown(screen(page).locator(`[data-stage-column="${stageId}"] [data-deal-card="${dealId}"]`));
}

function anyCard(page: Page, dealId: string): Locator {
  return shown(screen(page).locator(`[data-deal-card="${dealId}"]`));
}

function lockIcon(scope: Locator): Locator {
  // `<Icon name="lock" />` is an aria-hidden ligature span whose text is its name.
  return scope.locator('[aria-hidden="true"]', { hasText: /^\s*lock\s*$/ });
}

/**
 * The text of `locator` that is rendered (an element kept mounted but hidden
 * draws nothing), minus the subtrees `skip` matches. Screen-reader-only text
 * is rendered, so it counts.
 */
async function renderedText(locator: Locator, skip: string): Promise<string> {
  return locator.evaluate((element, skipped) => {
    const parts: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent === null || (skipped !== '' && parent.closest(skipped) !== null) || !parent.checkVisibility()) continue;
      parts.push(node.textContent ?? '');
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }, skip);
}

/** Text a person can see or hear: aria-hidden subtrees (icon ligatures) removed. */
async function visibleText(locator: Locator): Promise<string> {
  return renderedText(locator, '[aria-hidden="true"]');
}

/** UI copy only: visible text with record data ([data-record-text]), times and icon ligatures removed. */
async function copyText(locator: Locator): Promise<string> {
  return renderedText(locator, '[aria-hidden="true"], [data-record-text], time');
}

function digits(text: string): string {
  return text.replace(/\D/g, '');
}

/** The digits an exact amount draws: every currency here has two minor digits. */
function moneyDigits(amountMinor: string): string {
  return amountMinor.padStart(3, '0');
}

/** Every number a text draws, as bare digit strings ("1,234.50" is "123450"). */
function numbersIn(text: string): string[] {
  // U+00A0 and U+202F, the no-break spaces Intl groups digits with (inside a string, where the lint allows them).
  const grouping = '  ';
  expect(grouping, 'the grouping spaces were lost from the source').toBe(String.fromCharCode(0xa0, 0x202f));
  return (text.match(new RegExp(`\\d[\\d,.${grouping}]*\\d|\\d`, 'g')) ?? []).map(digits);
}

/** The labels en.json gives ids ending with one of `suffixes`, under an id about deals or pipelines. */
function dealLabels(...suffixes: string[]): string[] {
  return Object.entries(EN)
    .filter(([id]) => /deal|pipeline/i.test(id) && suffixes.some((suffix) => id.endsWith(suffix)))
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
 * The marks the BROWSER's own Intl gives a currency in the page's language:
 * its symbol, narrow symbol and code. The screen must draw one of them, from
 * Intl, never a symbol written into the source (R5).
 */
async function currencyMarks(page: Page, currency: string): Promise<string[]> {
  return page.evaluate((code) => {
    const lang = document.documentElement.lang || 'en';
    const marks = new Set<string>([code]);
    for (const currencyDisplay of ['symbol', 'narrowSymbol', 'code'] as const) {
      try {
        const part = new Intl.NumberFormat(lang, { style: 'currency', currency: code, currencyDisplay })
          .formatToParts(1)
          .find((entry) => entry.type === 'currency');
        if (part !== undefined) marks.add(part.value);
      } catch {
        // A language this browser has no data for: the code still counts.
      }
    }
    return [...marks];
  }, currency);
}

/** The element draws exactly this amount: its digits, and a mark of its currency. */
async function expectMoney(page: Page, locator: Locator, amountMinor: string, currency: string, what: string): Promise<void> {
  const said = await visibleText(locator);
  expect(digits(said), `${what}: "${said}" is not exactly ${amountMinor} minor units of ${currency}`).toBe(moneyDigits(amountMinor));
  const marks = await currencyMarks(page, currency);
  expect(
    marks.some((mark) => said.includes(mark)),
    `${what}: "${said}" carries none of ${marks.join(', ')} for ${currency}`,
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
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help}`),
    `serious or critical accessibility violations on ${label}`,
  ).toEqual([]);
  expect(results.passes.length, 'axe checked nothing').toBeGreaterThan(0);
}

async function isDisabled(locator: Locator): Promise<boolean> {
  return locator.evaluate(
    (element) => (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true',
  );
}

function json(body: unknown): Record<string, unknown> {
  expect(typeof body === 'object' && body !== null && !Array.isArray(body), 'the write body is not an object').toBe(true);
  return body as Record<string, unknown>;
}

async function openBoard(
  page: Page,
  options: PipelineMockOptions & { pipelineId?: string; query?: string; status?: number } = {},
): Promise<PipelineMock> {
  await page.clock.setFixedTime(new Date(NOW));
  const mock = await installPipelineMock(page, options);
  active = mock;
  const response = await page.goto(`${pipelineUrl()}/pipelines/${options.pipelineId ?? PIPELINE_ONE.id}${options.query ?? ''}`);
  expect(response?.status(), '/pipelines/<id> with crm_pipeline on').toBe(options.status ?? 200);
  await expect(screen(page)).toBeVisible();
  return mock;
}

/** Waits for every column of the board to draw its first page (cards, or its empty state). */
async function boardSettled(page: Page, pipeline = PIPELINE_ONE): Promise<void> {
  for (const stage of boardStages(pipeline)) {
    await expect(
      column(page, stage.id).locator('[data-deal-card], [data-testid="column-empty"]').first(),
      `the ${stage.name} column never drew`,
    ).toBeVisible();
  }
}

/** The column ids in DOM order. */
async function columnIds(page: Page): Promise<string[]> {
  const ids = await shown(screen(page).locator('[data-stage-column]')).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-stage-column') ?? ''),
  );
  return [...new Set(ids)];
}

/** The card ids drawn in a column, in DOM order. */
async function cardIds(page: Page, stageId: string): Promise<string[]> {
  return shown(screen(page).locator(`[data-stage-column="${stageId}"] [data-deal-card]`)).evaluateAll((cards) =>
    cards.map((element) => element.getAttribute('data-deal-card') ?? ''),
  );
}

async function countOf(page: Page, stageId: string): Promise<string> {
  return digits(await visibleText(column(page, stageId).locator('[data-stage-count]').first()));
}

/**
 * Drags with real pointer events, in steps, so both an HTML5 drag-and-drop
 * implementation and a pointer-sensor one see a drag start, a move over the
 * target and a drop. Never a sleep: the caller waits on a request or the DOM.
 */
async function drag(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  expect(from, 'the card has no box to drag').not.toBeNull();
  if (from === null) return;
  const startX = from.x + from.width / 2;
  const startY = from.y + Math.min(from.height / 2, 20);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 12, { steps: 4 });
  await target.scrollIntoViewIfNeeded();
  const to = await target.boundingBox();
  expect(to, 'the column has no box to drop on').not.toBeNull();
  if (to === null) return;
  const dropX = to.x + to.width / 2;
  const dropY = to.y + Math.min(to.height / 2, 120);
  await page.mouse.move(dropX, dropY, { steps: 16 });
  await page.mouse.move(dropX + 4, dropY + 4, { steps: 2 });
  await page.mouse.up();
}

async function openMoveSheet(page: Page, dealId: string): Promise<Locator> {
  // T-0147: a card carries two move controls since T-0135 (the desktop's drag handle, the phone's Move stage), one hidden.
  const button = shown(anyCard(page, dealId).locator('[data-action="move-deal"]')).first();
  await expect(button, 'the card has no move control').toBeVisible();
  await button.click();
  const sheet = shown(page.getByTestId('move-sheet')).first();
  await expect(sheet, 'no move sheet opened').toBeVisible();
  await expect(sheet).toHaveAttribute('role', 'dialog');
  return sheet;
}

async function moveOptions(sheet: Locator): Promise<{ enabled: string[]; all: string[] }> {
  const options = shown(sheet.locator('[data-move-to]'));
  const all: string[] = [];
  const enabled: string[] = [];
  for (let index = 0; index < (await options.count()); index += 1) {
    const option = options.nth(index);
    const id = (await option.getAttribute('data-move-to')) ?? '';
    all.push(id);
    if (!(await isDisabled(option))) enabled.push(id);
  }
  return { enabled: [...new Set(enabled)].sort(), all: [...new Set(all)].sort() };
}

async function prompt(page: Page): Promise<Locator> {
  const dialog = shown(page.getByTestId('move-requirements')).first();
  await expect(dialog, 'no requirement prompt opened').toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  return dialog;
}

function requirement(dialog: Locator, id: string): Locator {
  return dialog.locator(`[data-requirement="${id}"]`).first();
}

function requirementInput(dialog: Locator, id: string): Locator {
  return dialog.locator(`[data-requirement-input="${id}"]`).first();
}

/** The targets the allow-list offers from a stage, by the configuration the screen read. */
function allowedFrom(stageId: string, pipeline = PIPELINE_ONE): string[] {
  return pipeline.transitions.filter((pair) => pair.fromStageId === stageId).map((pair) => pair.toStageId).sort();
}

/** True once the mock has seen a board read after the last move of `dealId`: the counts come from the server. */
function boardReadAfterMove(mock: PipelineMock, dealId: string): boolean {
  const move = mock.requests.findLastIndex((url) => url.pathname === `/api/v1/deals/${dealId}/move`);
  return move >= 0 && mock.requests.slice(move + 1).some((url) => /^\/api\/v1\/pipelines\/[^/]+\/board$/.test(url.pathname));
}

/** True once the mock has seen any re-read of the deal or the board after its last move. */
function reReadAfterMove(mock: PipelineMock, dealId: string): boolean {
  const move = mock.requests.findLastIndex((url) => url.pathname === `/api/v1/deals/${dealId}/move`);
  return (
    move >= 0 &&
    mock.requests
      .slice(move + 1)
      .some((url) => url.pathname === `/api/v1/deals/${dealId}` || /^\/api\/v1\/pipelines\/[^/]+\/board$/.test(url.pathname))
  );
}

/** A filter control: a <select>, or a button opening a menu of options. */
async function chooseFilter(page: Page, param: string, value: string): Promise<void> {
  const control = shown(screen(page).locator(`[data-filter="${param}"]`)).first();
  await expect(control, `no ${param} filter`).toBeVisible();
  if ((await control.evaluate((element) => element.tagName)) === 'SELECT') {
    await control.selectOption(value);
    return;
  }
  await control.click();
  await shown(page.locator(`[data-filter-menu="${param}"] [data-filter-option="${value}"]`)).first().click();
  const apply = shown(page.locator(`[data-filter-menu="${param}"] [data-testid="filter-apply"]`));
  if ((await apply.count()) > 0) await apply.first().click();
}

async function filterOptions(page: Page, param: string): Promise<string[]> {
  const control = shown(screen(page).locator(`[data-filter="${param}"]`)).first();
  if ((await control.evaluate((element) => element.tagName)) === 'SELECT') {
    return (await control.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).filter(
      (value) => value !== '',
    );
  }
  await control.click();
  const values = await shown(page.locator(`[data-filter-menu="${param}"] [data-filter-option]`)).evaluateAll((options) =>
    options.map((option) => option.getAttribute('data-filter-option') ?? ''),
  );
  await page.keyboard.press('Escape');
  return values;
}

/** Whether a filter is offered at all: present and enabled. */
async function offersFilter(page: Page, selector: string): Promise<boolean> {
  const control = shown(screen(page).locator(selector));
  if ((await control.count()) === 0) return false;
  return !(await isDisabled(control.first()));
}

async function closeInput(page: Page, name: 'closeFrom' | 'closeTo'): Promise<Locator> {
  const input = shown(page.locator(`[data-filter-input="${name}"]`));
  if ((await input.count()) === 0) {
    const control = shown(screen(page).locator('[data-filter="close"]')).first();
    // T-0147: the close-date filter is now a preset <select> (T-0135, D-L193); its "Choose dates" preset shows the inputs.
    if ((await control.evaluate((element) => element.tagName)) === 'SELECT') await control.selectOption('custom');
    else await control.click();
  }
  const visible = shown(page.locator(`[data-filter-input="${name}"]`)).first();
  await expect(visible, `no ${name} input`).toBeVisible();
  return visible;
}

async function showList(page: Page): Promise<URL> {
  const read = page.waitForRequest((request) => isListDeals(request));
  await shown(screen(page).locator('[data-view-option="list"]')).first().click();
  const url = new URL((await read).url());
  await expect(screen(page)).toHaveAttribute('data-view', 'list');
  return url;
}

async function listIds(page: Page): Promise<string[]> {
  return shown(screen(page).locator('[data-testid="deal-list"] [data-deal-row]')).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-deal-row') ?? ''),
  );
}

async function sortOptions(page: Page): Promise<string[]> {
  const control = shown(screen(page).getByTestId('sort-control')).first();
  await expect(control, 'the list has no sort control').toBeVisible();
  if ((await control.evaluate((element) => element.tagName)) === 'SELECT') {
    return control.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  }
  await control.click();
  const values = await shown(page.locator('[data-sort-option]')).evaluateAll((options) => options.map((option) => option.getAttribute('data-sort-option') ?? ''));
  await page.keyboard.press('Escape');
  return values;
}

async function chooseSort(page: Page, key: string): Promise<void> {
  const control = shown(screen(page).getByTestId('sort-control')).first();
  if ((await control.evaluate((element) => element.tagName)) === 'SELECT') {
    await control.selectOption(key);
    return;
  }
  await control.click();
  await shown(page.locator(`[data-sort-option="${key}"]`)).first().click();
}

async function openCreate(page: Page): Promise<Locator> {
  await shown(screen(page).locator('[data-action="new-deal"]')).first().click();
  const dialog = shown(page.getByTestId('deal-create')).first();
  await expect(dialog, 'the new-deal form did not open').toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  return dialog;
}

function field(scope: Locator, name: string): Locator {
  return scope.locator(`[data-field-input="${name}"]`).first();
}

const PSEUDO = /[·[\]äëïöüÄËÏÖÜ]/;

/** Everything the screen was served that could land on the device. */
function needles(): string[] {
  const out = new Set<string>();
  for (const row of baseDeals()) {
    out.add(row.id);
    out.add(row.name);
    if (row.nextStep !== null) out.add(row.nextStep);
  }
  return [...out];
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

// ===========================================================================
// The mock bites (it runs, and passes, before the screen exists)
// ===========================================================================

test('the contract mock refuses what the contract and the screen’s rules refuse, and checks its own answers @p06-pipeline @p06-pipeline-mock', async ({
  page,
}) => {
  // A validator only ever seen accepting proves nothing. Drive the mock with
  // fetch() from a page that exists today (sign-in on the default server) and
  // watch every malformed request land in `violations`, one at a time. No
  // `active` mock here: the violations are deliberate and counted explicitly.
  const { webUrl } = stack();

  // The two oracles agree: the mock's board rule and the table written by hand.
  expect(boardStages(PIPELINE_ONE).map((stage) => stage.id), 'the board is every open stage then won').toEqual(EXPECTED_BOARD.map((entry) => entry.stage.id));
  for (const expected of EXPECTED_BOARD) {
    const rows = columnRows(baseDeals(), PIPELINE_ONE.id, expected.stage.id);
    expect(rows.map((row) => row.id), `the mock and the hand-written table disagree on ${expected.stage.name}`).toEqual(expected.cards.map((row) => row.id));
    expect(columnTotals(rows, expected.stage), `the ${expected.stage.name} totals`).toEqual(expected.totals);
  }
  expect(weightedMinor('1000000001', 5000), 'half-even: .5 goes to the even neighbour').toBe('500000000');
  expect(weightedMinor('4500003', 5000), 'half-even: .5 goes to the even neighbour').toBe('2250002');
  expect(weightedMinor('999999999999999999', 2500)).toBe('250000000000000000');

  const mock = await installPipelineMock(page);
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
  let planted = 0;
  const expectViolation = async (path: string, method: string, body: unknown, status: number, what: RegExp, headers?: Record<string, string>) => {
    const before = mock.violations.length;
    expect((await call(path, method, body, headers)).status, `${method} ${path}`).toBe(status);
    const added = mock.violations.slice(before);
    expect(added.join('\n'), `${method} ${path} was not recorded`).toMatch(what);
    expect(added, `${method} ${path} was recorded more than once`).toHaveLength(1);
    planted += 1;
  };
  const boardOf = (id: string, query = '') => `/api/v1/pipelines/${id}/board${query === '' ? '' : `?${query}`}`;
  const dealsOf = (id: string, query = '') => `/api/v1/pipelines/${id}/deals${query === '' ? '' : `?${query}`}`;
  const move = (id: string) => `/api/v1/deals/${id}/move`;
  type Column = { stageId: string; count: number; totals?: unknown; cards: Record<string, unknown>[]; nextCursor: string | null };

  // Served as the contract says.
  const pipelines = await call('/api/v1/pipelines');
  expect(pipelines.status).toBe(200);
  expect((pipelines.body.data as { id: string }[]).map((entry) => entry.id)).toEqual(pipelineSummaries().map((entry) => entry.id));
  const config = await call(`/api/v1/pipelines/${PIPELINE_ONE.id}`);
  expect(config.body, 'getPipeline is not the contract’s example').toEqual(PIPELINE_ONE);
  const whole = await call(boardOf(PIPELINE_ONE.id));
  expect(whole.status).toBe(200);
  expect(whole.body.closedSince, 'the default won window is not echoed').toBe(DEFAULT_CLOSED_SINCE);
  const columns = whole.body.stages as Column[];
  expect(columns.map((entry) => entry.stageId), 'lost is a column, or a column is missing').toEqual(EXPECTED_BOARD.map((entry) => entry.stage.id));
  for (const [index, expected] of EXPECTED_BOARD.entries()) {
    expect(columns[index]?.count).toBe(expected.count);
    expect(columns[index]?.totals).toEqual(expected.totals);
    expect(columns[index]?.cards.map((entry) => entry.id)).toEqual(expected.cards.map((row) => row.id));
  }
  const field = await call(boardOf(PIPELINE_TWO.id));
  expect(field.body.withheldFields).toEqual(['amount', 'expectedCloseDate', 'ownerUserId']);
  const fieldColumns = field.body.stages as Column[];
  expect(fieldColumns.every((entry) => !('totals' in entry)), 'totals were served with amount withheld').toBe(true);
  const fieldCard = fieldColumns[0]?.cards[0] ?? {};
  expect(['amount', 'weightedAmount', 'ownerUserId', 'owner', 'expectedCloseDate'].filter((key) => key in fieldCard), 'a withheld field was served').toEqual([]);
  const listed = await call(dealsOf(PIPELINE_ONE.id, 'sort=name'));
  const listedIds = (listed.body.data as { id: string }[]).map((entry) => entry.id);
  expect(listedIds, 'the list leaves out a lost deal in the window').toContain(D_L1.id);
  expect(listedIds, 'the list holds a lost deal outside the window').not.toContain(D_L2.id);
  expect(listedIds).toEqual(listRows(baseDeals(), PIPELINE_ONE.id, NO_FILTERS, [], 'name').map((row) => row.id));
  const year = new Date(NOW_MS - 365 * DAY).toISOString();
  const yearBoard = await call(boardOf(PIPELINE_ONE.id, `closedSince=${encodeURIComponent(year)}&stageId=${S_WON.id}`));
  expect((yearBoard.body.stages as Column[]).map((entry) => entry.count), 'a 365-day window does not reach the deal won 200 days ago').toEqual([2]);
  const contacts = await call('/api/v1/contacts?q=alpha');
  expect((contacts.body.data as { id: string }[]).map((entry) => entry.id).sort()).toEqual([C_ALPHA.id, C_ALPHA_ELSEWHERE.id].sort());
  expect(mock.violations, 'a well-formed request was recorded as a violation').toEqual([]);

  // Reads, refused and blamed on the screen.
  await expectViolation(boardOf(PIPELINE_ONE.id, 'territory=Lagos'), 'GET', undefined, 400, /no "territory"/);
  await expectViolation(boardOf(PIPELINE_ONE.id, 'limit=51'), 'GET', undefined, 400, /outside 1\.\.50/);
  await expectViolation(boardOf(PIPELINE_ONE.id, `stageId=${S_LOST.id}`), 'GET', undefined, 400, /lost is never a column/);
  await expectViolation(boardOf(PIPELINE_ONE.id, 'cursor=forged'), 'GET', undefined, 400, /not served for this column/);
  await expectViolation(boardOf(PIPELINE_ONE.id, `stageId=${S_QUALIFIED.id}&cursor=forged`), 'GET', undefined, 400, /not served for this column/);
  await expectViolation(boardOf(PIPELINE_ONE.id, 'currency=USD'), 'GET', undefined, 400, /not one of NGN/);
  await expectViolation(boardOf(PIPELINE_ONE.id, `closedSince=${encodeURIComponent(new Date(EARLIEST_CLOSED_SINCE_MS - DAY).toISOString())}`), 'GET', undefined, 400, /more than 366 days/);
  await expectViolation(boardOf(PIPELINE_ONE.id, `closedSince=${encodeURIComponent(new Date(NOW_MS + DAY).toISOString())}`), 'GET', undefined, 400, /in the future/);
  await expectViolation(boardOf(PIPELINE_ONE.id, `closedSince=${encodeURIComponent('2026-10-01T00:00:00+01:00')}`), 'GET', undefined, 400, /UTC date-time/);
  await expectViolation(boardOf(PIPELINE_ONE.id, 'closeFrom=2026-11-01&closeTo=2026-10-01'), 'GET', undefined, 400, /closeTo is before closeFrom/);
  await expectViolation(boardOf(PIPELINE_ONE.id, 'owner=someone'), 'GET', undefined, 400, /not me, unassigned or a user id/);
  await expectViolation(boardOf(PIPELINE_TWO.id, 'currency=NGN'), 'GET', undefined, 400, /must not be offered/);
  await expectViolation(boardOf(PIPELINE_TWO.id, 'owner=me'), 'GET', undefined, 400, /must not be offered/);
  await expectViolation(dealsOf(PIPELINE_TWO.id, 'closeFrom=2026-10-01'), 'GET', undefined, 400, /must not be offered/);
  await expectViolation(dealsOf(PIPELINE_ONE.id, 'sort=amount'), 'GET', undefined, 400, /sort=amount/);
  await expectViolation(boardOf('not-a-uuid'), 'GET', undefined, 404, /not a uuid/);
  await expectViolation(boardOf(PIPELINE_ONE.id), 'GET', undefined, 200, /scope is never supplied/, { 'x-kasuwa-programme-id': PROGRAMME_ONE.id });
  await expectViolation('/api/v1/fx/rates', 'GET', undefined, 404, /not an operation/);
  await expectViolation(`/api/v1/deals/${D_Q1.id}`, 'PATCH', { version: 2, name: 'x' }, 404, /not an operation/);
  // An unreachable pipeline is the API's 404, not the screen's fault.
  expect((await call(boardOf(OUT_OF_SCOPE_PIPELINE_ID))).status).toBe(404);

  // Creates and moves, refused and blamed on the screen. Everything moved here was served above.
  await expectViolation(dealsOf(PIPELINE_ONE.id), 'POST', { name: 'Synthetic create', ownerUserId: ME.id }, 201, /never sends ownerUserId|ownerUserId/);
  await expectViolation(dealsOf(PIPELINE_ONE.id), 'POST', { name: 'Synthetic create', amount: { amountMinor: '100', currency: 'USD' } }, 400, /not one of NGN/);
  await expectViolation(dealsOf(PIPELINE_ONE.id), 'POST', { name: 'Synthetic create', stageId: S_PROPOSAL.id }, 400, /closed body/);
  await expectViolation(dealsOf(PIPELINE_ONE.id), 'POST', { name: 'Synthetic create', amount: { amountMinor: '1.5', currency: 'NGN' } }, 400, /amount matches 0 of oneOf|does not match/);
  await expectViolation(dealsOf(PIPELINE_TWO.id), 'POST', { name: 'Synthetic create', amount: { amountMinor: '100', currency: 'NGN' } }, 403, /withheld/);
  await expectViolation(move('2b3c4d5e-6f7a-4b8c-9d0e-00000000dead'), 'POST', { version: 1, toStageId: S_DISCOVERY.id }, 404, /never served/);
  await expectViolation(move(D_Q1.id), 'POST', { version: 7, toStageId: S_DISCOVERY.id }, 409, /never served/);
  await expectViolation(move(D_Q1.id), 'POST', { version: D_Q1.version, toStageId: S_PROPOSAL.id }, 409, /allow-list the screen read/);
  await expectViolation(move(D_P1.id), 'POST', { version: D_P1.version, toStageId: S_NEGOTIATION.id, fields: { nextStep: 'x' } }, 400, /fields\.nextStep is not one of the target/);
  await expectViolation(move(D_P1.id), 'POST', { version: D_P1.version, toStageId: S_NEGOTIATION.id, fields: { amount: { currency: 'NGN', amountMinor: '2200000000' } }, checks: [R_QUOTE.id] }, 422, /already holds/);
  await expectViolation(move(D_N2.id), 'POST', { version: D_N2.version, toStageId: S_CONTRACT.id, fields: { primaryContactId: C_ALPHA_ELSEWHERE.id }, checks: [R_PO.id] }, 400, /another programme/);
  await expectViolation(move(D_N1.id), 'POST', { version: D_N1.version, toStageId: S_CONTRACT.id, fields: { primaryContactId: C_ALPHA.id }, checks: [R_PO.id, T_R_QUOTE.id] }, 400, /checks\.1 is not one of the target/);
  await expectViolation(move(D_Q1.id), 'POST', { version: D_Q1.version, toStageId: S_DISCOVERY.id, probability: 10 }, 400, /closed body/);
  expect(mock.violations.length, 'the refusals above were not all recorded, or one was recorded twice').toBe(planted);

  // Every mock installed from here on answers in place of the one before (Playwright's newest route wins).

  // Column paging: a cursor echoed with its stageId and the same filters.
  const paging = await installPipelineMock(page, { bigColumn: true });
  const first = await call(boardOf(PIPELINE_ONE.id, 'q=e'));
  const qualified = (first.body.stages as Column[])[0];
  expect(qualified?.cards.length, 'a page with a cursor is short of its limit').toBe(BOARD_DEFAULT_LIMIT);
  const cursor = String(qualified?.nextCursor);
  const next = await call(boardOf(PIPELINE_ONE.id, `q=e&stageId=${S_QUALIFIED.id}&cursor=${encodeURIComponent(cursor)}`));
  expect((next.body.stages as Column[]).map((entry) => [entry.stageId, entry.count])).toEqual([[S_QUALIFIED.id, qualified?.count]]);
  expect(paging.violations).toEqual([]);
  expect((await call(boardOf(PIPELINE_ONE.id, `stageId=${S_QUALIFIED.id}&cursor=${encodeURIComponent(cursor)}`))).status, 'a cursor reused with other filters').toBe(400);
  expect(paging.violations.join('\n')).toMatch(/same filters/);

  // The API's own refusals are not the screen's fault.
  const agent = await installPipelineMock(page, { role: 'agent' });
  await call(boardOf(PIPELINE_ONE.id));
  expect((await call(move(D_Q_OTHER.id), 'POST', { version: D_Q_OTHER.version, toStageId: S_DISCOVERY.id })).status, 'an agent moved another’s deal').toBe(403);
  const qa = await installPipelineMock(page, { role: 'qa_analyst' });
  expect((await call(dealsOf(PIPELINE_ONE.id), 'POST', { name: 'Synthetic create' })).status).toBe(403);
  const locked = await installPipelineMock(page);
  await call(boardOf(PIPELINE_TWO.id));
  const notEditable = await call(move(E_P1.id), 'POST', { version: E_P1.version, toStageId: T_NEGOTIATION.id, checks: [T_R_QUOTE.id] });
  expect(notEditable.status).toBe(403);
  expect(notEditable.body.details).toEqual([
    { path: 'amount', code: 'field_not_editable' },
    { path: 'expectedCloseDate', code: 'field_not_editable' },
  ]);
  for (const other of [agent, qa, locked]) {
    expect(other.violations, 'an API refusal was blamed on the screen').toEqual([]);
  }

  // D-L102 on the wire: somebody else saves first; the blind retry, the undoing
  // resend and the honest rebase are told apart.
  const stale = await installPipelineMock(page, { concurrent: { dealId: D_P1.id, changes: [{ expectedCloseDate: '2026-11-30' }] } });
  await call(boardOf(PIPELINE_ONE.id));
  const lost = await call(move(D_P1.id), 'POST', { version: D_P1.version, toStageId: S_NEGOTIATION.id, fields: { expectedCloseDate: '2026-11-20' }, checks: [R_QUOTE.id] });
  expect(lost.status).toBe(409);
  expect(lost.body.code).toBe('stale_write');
  expect(stale.violations, 'a move beaten by somebody else was blamed on the screen').toEqual([]);
  expect((await call(move(D_P1.id), 'POST', { version: D_P1.version, toStageId: S_NEGOTIATION.id, fields: { expectedCloseDate: '2026-11-20' }, checks: [R_QUOTE.id] })).status).toBe(409);
  expect(stale.violations.join('\n'), 'a blind retry was not recorded').toMatch(/blind retry/);
  const fresh = await call(`/api/v1/deals/${D_P1.id}`);
  expect(fresh.body).toMatchObject({ version: D_P1.version + 1, expectedCloseDate: '2026-11-30' });
  const rebased = await call(move(D_P1.id), 'POST', { version: D_P1.version + 1, toStageId: S_NEGOTIATION.id, fields: { expectedCloseDate: '2026-11-20' }, checks: [R_QUOTE.id] });
  expect(rebased.status, 'the honest rebase was refused').toBe(200);
  expect(rebased.body).toMatchObject({ stageId: S_NEGOTIATION.id, expectedCloseDate: '2026-11-20', version: D_P1.version + 2, closedAt: null });
  expect((rebased.body.checks as { requirementId: string }[]).map((entry) => entry.requirementId)).toEqual([R_BUDGET.id, R_QUOTE.id]);
  expect(stale.violations).toHaveLength(1);

  // Reconfiguration after the screen's first read.
  const transition = await installPipelineMock(page, { transitionDrift: true });
  await call(`/api/v1/pipelines/${PIPELINE_ONE.id}`);
  await call(boardOf(PIPELINE_ONE.id));
  const refusedMove = await call(move(D_Q1.id), 'POST', { version: D_Q1.version, toStageId: S_DISCOVERY.id });
  expect([refusedMove.status, refusedMove.body.code]).toEqual([409, 'transition_not_allowed']);
  expect(transition.violations).toEqual([]);
  const requirement = await installPipelineMock(page, { requirementDrift: true });
  await call(`/api/v1/pipelines/${PIPELINE_ONE.id}`);
  await call(boardOf(PIPELINE_ONE.id));
  const unmet = await call(move(D_Q1.id), 'POST', { version: D_Q1.version, toStageId: S_DISCOVERY.id });
  expect([unmet.status, unmet.body.details]).toEqual([422, [{ path: `requirements.${R_DRIFT.id}`, code: 'requirement_unmet' }]]);
  const reread = await call(`/api/v1/pipelines/${PIPELINE_ONE.id}`);
  const discovery = (reread.body.stages as { id: string; requirements: { id: string; label?: string }[] }[]).find((stage) => stage.id === S_DISCOVERY.id);
  expect(discovery?.requirements, 'the second read does not carry the new requirement').toEqual([R_DRIFT]);
  expect((await call(move(D_Q1.id), 'POST', { version: D_Q1.version, toStageId: S_DISCOVERY.id, checks: [R_DRIFT.id] })).status).toBe(200);
  expect(requirement.violations).toEqual([]);

  // Well-formed writes are applied; a count after a write is the server's, not arithmetic.
  const writer = await installPipelineMock(page, { concurrentArrival: { stageId: S_DISCOVERY.id } });
  await call(boardOf(PIPELINE_ONE.id));
  const created = await call(dealsOf(PIPELINE_ONE.id), 'POST', { name: 'Synthetic created deal', amount: { amountMinor: '125050', currency: 'GHS' }, expectedCloseDate: '2026-12-01' });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ stageId: S_QUALIFIED.id, version: 1, ownerUserId: ME.id, amount: { amountMinor: '125050', currency: 'GHS' }, rotting: 'fresh' });
  const moved = await call(move(D_Q1.id), 'POST', { version: D_Q1.version, toStageId: S_DISCOVERY.id });
  expect(moved.body).toMatchObject({ stageId: S_DISCOVERY.id, version: D_Q1.version + 1, closedAt: null });
  const after = await call(boardOf(PIPELINE_ONE.id));
  expect((after.body.stages as Column[]).slice(0, 2).map((entry) => entry.count), 'Qualified +1 -1, Discovery +1 and the arrival').toEqual([4, 5]);
  const toLost = await call(move(D_Q2.id), 'POST', { version: D_Q2.version, toStageId: S_LOST.id });
  expect(toLost.body).toMatchObject({ stageId: S_LOST.id, rotting: null, closedAt: new Date(NOW_MS + 3000).toISOString() });
  expect(writer.violations).toEqual([]);

  // The mock checks its own answers: a planted body the contract rejects is caught.
  const goodBoard = whole.body;
  const goodCard = columns[0]?.cards[0] ?? {};
  expect(answerProblems('getPipelineBoard', 200, { ...goodBoard, total: 12 }).join('\n'), 'a board-level total passed').toMatch(/total/);
  expect(answerProblems('getPipelineBoard', 200, { ...goodBoard, stages: [{ ...columns[0], usd: '1' }] }).join('\n')).toMatch(/usd/);
  expect(answerProblems('getPipelineBoard', 200, { ...goodBoard, stages: [{ ...columns[0], totals: [{ currency: 'NGN', amountMinor: 1.5, weightedAmountMinor: '1' }] }] })).not.toEqual([]);
  expect(answerProblems('listDeals', 200, { data: [{ ...goodCard, probabilityBp: 1000 }], nextCursor: null }).join('\n')).toMatch(/probabilityBp/);
  expect(answerProblems('listDeals', 200, { data: [goodCard], nextCursor: null, total: 1 }).join('\n')).toMatch(/total/);
  expect(answerProblems('getPipelineBoard', 403, { statusCode: 403 }).join('\n')).toMatch(/declares no 403/);
  expect(answerProblems('listDeals', 200, { data: [goodCard], nextCursor: null })).toEqual([]);

  // The deliberate faults are served and filed apart.
  const hostile = await installPipelineMock(page, { hostileSummaries: true });
  await call(boardOf(PIPELINE_ONE.id));
  expect(hostile.plantedFaults.length, 'the hostile summaries were not served').toBeGreaterThan(0);
  expect(hostile.mockFaults).toEqual([]);
  for (const other of [mock, paging, agent, qa, locked, stale, transition, requirement, writer, hostile]) {
    expect(other.mockFaults).toEqual([]);
  }
});

// ===========================================================================
// The flag
// ===========================================================================

test.describe('crm_pipeline gates /pipelines', () => {
  // The flag-off tests PASS BEFORE THE WORK STARTS: there is no route, so both
  // paths are 404s everywhere. A negative invariant, legitimately vacuous until
  // the screen exists; the flag-on test gives the pair meaning.
  test('/pipelines and /pipelines/<id> are real 404s with every flag at its default, and nothing reaches the API @p06-pipeline @p06-pipeline-flag-off', async ({
    page,
  }) => {
    const { webUrl } = stack();
    const mock = await installPipelineMock(page);
    for (const path of ['/pipelines', `/pipelines/${PIPELINE_ONE.id}`]) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} is reachable with crm_pipeline off`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
      await expect(page.getByTestId('pipeline-index')).toHaveCount(0);
    }
    expect(mock.requests.filter((url) => /^\/api\/v1\/(pipelines|deals)/.test(url.pathname)), 'a flag-off page still read pipelines').toEqual([]);
  });

  test('/pipelines cannot be switched on by anything the browser sends @p06-pipeline @p06-pipeline-flag-off', async ({ browser }) => {
    const { webUrl } = stack();
    const context = await browser.newContext({
      extraHTTPHeaders: {
        'x-kasuwa-feature-flags': 'crm_pipeline,crm_records',
        'x-crm-pipeline': '1',
        'x-kasuwa-tenant-id': TENANT_A,
      },
    });
    await context.addCookies([
      { name: 'crm_pipeline', value: 'on', url: webUrl },
      { name: 'kasuwa_flags', value: 'crm_pipeline', url: webUrl },
    ]);
    const page = await context.newPage();
    for (const path of [`/pipelines/${PIPELINE_ONE.id}?crm_pipeline=on&flags=crm_pipeline`, '/pipelines/', '/pipelines?locale=en-XA']) {
      const response = await page.goto(`${webUrl}${path}`);
      expect(response?.status(), `${path} was switched on from the browser`).toBe(404);
      await expect(page.locator(SCREEN)).toHaveCount(0);
    }
    await context.close();
  });

  test('/pipelines/<id> renders the board with crm_pipeline on @p06-pipeline @p06-pipeline-flag-on', async ({ page }) => {
    await openBoard(page);
    await expect(screen(page)).toHaveAttribute('data-view', 'board');
    await expect(shown(screen(page).getByTestId('board')).first()).toBeVisible();
    await boardSettled(page);
  });
});

test('a caller without deal.write is offered no new-deal or move control, and the board still reads @p06-pipeline @p06-pipeline-writers', async ({ page }) => {
  // T-0158: getMyCapabilities says `deal.write` is held in no programme.
  const mock = await openBoard(page, { capabilities: 'reader' });
  await boardSettled(page);
  await expect(page.locator('[data-deal-card]').first()).toBeVisible();
  await expect(page.locator('[data-action="new-deal"]')).toHaveCount(0);
  await expect(page.locator('[data-action="move-deal"]')).toHaveCount(0);
  expect(mock.violations).toEqual([]);
});

// ===========================================================================
// The shell and the index (R1, R2)
// ===========================================================================

test('the board sits in the CRM shell, the Deals entry links /pipelines and is current, and no link on it is a 404 @p06-pipeline @p06-pipeline-shell', async ({
  page,
}) => {
  await openBoard(page);
  await boardSettled(page);
  const shell = page.locator('[data-shell="crm"]');
  await expect(shell).toBeVisible();
  await expect(shell.locator(SCREEN)).toBeVisible();
  await expect(shown(shell.locator('nav a[href="/pipelines"]')).first(), 'the Deals entry does not link /pipelines').toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('settings-menu')).toHaveCount(0);

  const links = async () => page.locator('a[href^="/"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
  const boardLinks = await links();
  await showList(page);
  await expect(shown(screen(page).locator('[data-testid="deal-list"] [data-deal-row]')).first()).toBeVisible();
  const listLinks = await links();
  const hrefs = [...new Set([...boardLinks, ...listLinks])];
  expect(hrefs.length, 'the page links nowhere — not even the CRM nav').toBeGreaterThan(0);
  for (const href of hrefs) {
    const response = await page.request.get(`${pipelineUrl()}${href}`);
    expect(response.status(), `the page links to ${href}, which is a 404`).not.toBe(404);
  }
});

test.describe('the pipeline index (/pipelines)', () => {
  test('lists the caller’s pipelines by name in served order, each linking its board, no id printed @p06-pipeline @p06-pipeline-index', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date(NOW));
    const mock = await installPipelineMock(page);
    active = mock;
    const response = await page.goto(`${pipelineUrl()}/pipelines`);
    expect(response?.status()).toBe(200);
    await expect(shown(page.locator('[data-shell="crm"] nav a[href="/pipelines"]')).first()).toHaveAttribute('aria-current', 'page');
    const index = shown(page.getByTestId('pipeline-index')).first();
    await expect(index.locator('[data-pipeline]').first()).toBeVisible();
    const rows = await shown(index.locator('[data-pipeline]')).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-pipeline') ?? ''));
    const served = pipelineSummaries();
    expect(rows, 'the pipelines are not in served order').toEqual(served.map((entry) => entry.id));
    for (const entry of served) {
      const row = index.locator(`[data-pipeline="${String(entry.id)}"]`).first();
      await expect(row.locator(`a[href="/pipelines/${String(entry.id)}"]`)).toHaveCount(1);
      expect(await visibleText(row)).toContain(String(entry.name));
    }
    await expectNoIdsAnywhere(page, 'the pipeline index');
    await expectNoSeriousAxe(page, 'the pipeline index');
    await index.locator(`a[href="/pipelines/${PIPELINE_TWO.id}"]`).first().click();
    await expect(screen(page)).toBeVisible();
    await expect(shown(screen(page).getByRole('heading', { level: 1 })).first()).toContainText(PIPELINE_TWO.name);
  });

  test('a caller with no pipeline sees the index’s empty state, not an error @p06-pipeline @p06-pipeline-index', async ({ page }) => {
    const mock = await installPipelineMock(page, { noPipelines: true });
    active = mock;
    await page.goto(`${pipelineUrl()}/pipelines`);
    await expect(shown(page.getByTestId('pipeline-index-empty')).first()).toBeVisible();
    await expect(shown(page.locator('[data-pipeline]'))).toHaveCount(0);
    await expect(shown(page.getByTestId('pipeline-index-error'))).toHaveCount(0);
  });
});

// ===========================================================================
// P06/01 — the board
// ===========================================================================

test.describe('P06/01 — the board', () => {
  test('one column per open stage then won, by name, never lost; exact counts; cards in served order; axe-clean @p06-pipeline @p06-pipeline-board', async ({
    page,
  }) => {
    const mock = await openBoard(page);
    await boardSettled(page);
    await expect(shown(screen(page).getByRole('heading', { level: 1 })).first()).toContainText(PIPELINE_ONE.name);
    expect(await columnIds(page), 'the columns are not every open stage then won, in position order').toEqual(EXPECTED_BOARD.map((entry) => entry.stage.id));
    await expect(shown(screen(page).locator(`[data-stage-column="${S_LOST.id}"]`)), 'lost is drawn as a column').toHaveCount(0);
    for (const expected of EXPECTED_BOARD) {
      const col = column(page, expected.stage.id);
      await expect(col).toHaveAttribute('data-stage-kind', expected.stage.kind);
      expect(await visibleText(col.locator('[data-field="stage-name"]').first())).toBe(expected.stage.name);
      expect(await countOf(page, expected.stage.id), `the ${expected.stage.name} count`).toBe(String(expected.count));
      expect(await cardIds(page, expected.stage.id), `the ${expected.stage.name} cards are not in served order`).toEqual(expected.cards.map((row) => row.id));
    }
    for (const row of [D_L1, D_L2, D_W2]) {
      await expect(anyCard(page, row.id), `${row.name} is on the board`).toHaveCount(0);
    }
    // The board is read whole, once, and not per column on load.
    expect(mock.boardReads.filter((url) => url.searchParams.has('stageId')), 'the board was read column by column on load').toEqual([]);
    await expectNoIdsAnywhere(page, 'the board');
    await expectNoSeriousAxe(page, 'P06/01');
  });

  test('totals are exact, one line per currency in served order, weighted as served, never summed across currencies @p06-pipeline @p06-pipeline-totals', async ({
    page,
  }) => {
    await openBoard(page);
    await boardSettled(page);
    for (const expected of EXPECTED_BOARD) {
      const col = column(page, expected.stage.id);
      const lines = await shown(col.locator('[data-stage-total]')).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-stage-total') ?? ''));
      expect(lines, `the ${expected.stage.name} totals are not one line per served currency, in served order`).toEqual(expected.totals.map((total) => total.currency));
      for (const total of expected.totals) {
        const line = col.locator(`[data-stage-total="${total.currency}"]`).first();
        await expectMoney(page, line.locator('[data-money="amount"]').first(), total.amountMinor, total.currency, `${expected.stage.name} ${total.currency} total`);
        await expectMoney(page, line.locator('[data-money="weighted"]').first(), total.weightedAmountMinor, total.currency, `${expected.stage.name} ${total.currency} weighted`);
      }
      const drawn = numbersIn(await visibleText(col));
      for (const wrong of WRONG_NUMBERS) {
        expect(drawn, `${expected.stage.name} draws ${wrong}: rounded once, or summed across currencies`).not.toContain(wrong);
      }
    }
    // A deal with no amount is counted and adds to no total (Discovery's D_D2).
    expect(await countOf(page, S_DISCOVERY.id)).toBe('3');
  });

  test('every amount is exact and in its currency’s own format from Intl, even past 2^53 @p06-pipeline @p06-pipeline-money', async ({ page }) => {
    await openBoard(page);
    await boardSettled(page);
    const cases: readonly (readonly [StoredDeal, string])[] = [
      [D_BIG, S_DISCOVERY.id],
      [D_Q1, S_QUALIFIED.id],
      [D_P2, S_PROPOSAL.id],
      [D_N2, S_NEGOTIATION.id],
      [D_C1, S_CONTRACT.id],
      [D_N1, S_NEGOTIATION.id],
    ];
    for (const [row, stageId] of cases) {
      const amount = row.amount;
      expect(amount, `${row.name} has no amount in the fixture`).not.toBeNull();
      if (amount === null) continue;
      await expectMoney(page, card(page, stageId, row.id).first().locator('[data-field="amount"]').first(), amount.amountMinor, amount.currency, row.name);
    }
    // Four currencies, four different marks, none of them written into the screen.
    const marks = await Promise.all(CURRENCIES.map((currency) => currencyMarks(page, currency)));
    expect(new Set(marks.map((entry) => entry.join())).size, 'the browser gives two currencies the same marks').toBe(CURRENCIES.length);
  });

  test('a busy column pages on its own cursor, inside the column, with the same filters; its count stays the server’s @p06-pipeline @p06-pipeline-paging', async ({
    page,
  }) => {
    const mock = await openBoard(page, { bigColumn: true });
    await boardSettled(page);
    const firstRead = mock.boardReads[0];
    const limit = Number(firstRead?.searchParams.get('limit') ?? BOARD_DEFAULT_LIMIT);
    const total = EXPECTED_BOARD[0]?.count ?? 0;
    const all = columnRows(mock.store, PIPELINE_ONE.id, S_QUALIFIED.id);
    expect(all.length).toBe(total + BIG_COLUMN_LENGTH);
    expect(await countOf(page, S_QUALIFIED.id), 'the count is the page, not the stage').toBe(String(all.length));
    expect(await cardIds(page, S_QUALIFIED.id)).toEqual(all.slice(0, limit).map((row) => row.id));
    const discoveryBefore = await cardIds(page, S_DISCOVERY.id);

    const more = shown(column(page, S_QUALIFIED.id).getByTestId('column-more')).first();
    await expect(more, 'the busy column offers no way to its next page').toBeVisible();
    const sent = page.waitForRequest((request) => isBoardRead(request) && new URL(request.url()).searchParams.has('cursor'));
    await more.click();
    const paged = new URL((await sent).url());
    expect(paged.searchParams.get('stageId'), 'a column page names its column').toBe(S_QUALIFIED.id);
    expect(mock.issuedCursors()).toContain(paged.searchParams.get('cursor') ?? '');
    await expect.poll(() => cardIds(page, S_QUALIFIED.id).then((ids) => ids.length)).toBe(Math.min(all.length, 2 * limit));
    expect(await cardIds(page, S_QUALIFIED.id), 'the next page was not appended in served order').toEqual(all.slice(0, 2 * limit).map((row) => row.id));
    expect(await countOf(page, S_QUALIFIED.id), 'paging changed the count').toBe(String(all.length));
    expect(await cardIds(page, S_DISCOVERY.id), 'paging one column redrew another').toEqual(discoveryBefore);
    expect(page.url()).not.toMatch(/[?&]cursor=/);
  });

  test('won shows the window the server used; a longer window reaches older wins; lost is never on the board @p06-pipeline @p06-pipeline-won', async ({
    page,
  }) => {
    const mock = await openBoard(page);
    await boardSettled(page);
    const won = column(page, S_WON.id);
    // The server's default, or the screen's own 90 days sent as closedSince: either way the echo is drawn.
    const echoed = mock.boardReads[0]?.searchParams.get('closedSince') ?? DEFAULT_CLOSED_SINCE;
    const echoedMs = Date.parse(echoed);
    expect(echoedMs >= NOW_MS - 91 * DAY && echoedMs <= NOW_MS - 89 * DAY, `the board did not start on a 90-day won window (${echoed})`).toBe(true);
    await expect(won.locator('[data-testid="won-since"] time').first(), 'the won column does not say since when').toHaveAttribute('datetime', echoed);
    expect(await cardIds(page, S_WON.id)).toEqual([D_W1.id]);
    expect(await won.locator('[data-deal-card]').first().getAttribute('data-rotting'), 'a won deal carries a rotting marker').toBeNull();

    const options = (await filterOptions(page, 'closedSince')).map(Number);
    expect(options.length, 'no won-window choices').toBeGreaterThan(0);
    for (const days of options) {
      expect(Number.isInteger(days) && days > 0 && days <= 366, `a won window of ${days} days`).toBe(true);
    }
    expect(options, 'no window of a year (365 days)').toContain(365);
    const sent = page.waitForRequest((request) => isBoardRead(request) && new URL(request.url()).searchParams.has('closedSince'));
    await chooseFilter(page, 'closedSince', '365');
    const since = (new URL((await sent).url()).searchParams.get('closedSince')) ?? '';
    const sinceMs = Date.parse(since);
    expect(sinceMs >= EARLIEST_CLOSED_SINCE_MS && sinceMs <= NOW_MS - 364 * DAY, `closedSince ${since} is not about a year back`).toBe(true);
    await expect(card(page, S_WON.id, D_W2.id), 'the deal won 200 days ago did not appear').toBeVisible();
    await expect.poll(() => countOf(page, S_WON.id)).toBe('2');
    await expect(won.locator('[data-testid="won-since"] time').first()).toHaveAttribute('datetime', since);
    expect(await countOf(page, S_QUALIFIED.id), 'the window changed an open column').toBe('4');
    await expect(anyCard(page, D_L1.id)).toHaveCount(0);
    expect(mock.boardReads.every((url) => url.searchParams.get('stageId') !== S_LOST.id)).toBe(true);
  });

  test('filters send q, owner, close window and currency on board and list alike; withheld fields offer no filter @p06-pipeline @p06-pipeline-filters', async ({
    page,
  }) => {
    const mock = await openBoard(page);
    await boardSettled(page);
    await expect(shown(screen(page).locator('[data-filter="amount"], [data-filter="territory"]')), 'a filter the contract does not have').toHaveCount(0);

    const searched = page.waitForRequest((request) => isBoardRead(request) && new URL(request.url()).searchParams.get('q') === 'lockers');
    await shown(screen(page).locator('input[type="search"][data-filter="q"]')).first().fill('lockers');
    const searchUrl = new URL((await searched).url());
    expect(searchUrl.searchParams.has('stageId'), 'a new filter must re-read every column from the top').toBe(false);
    await expect.poll(() => countOf(page, S_PROPOSAL.id)).toBe('2');
    expect(await countOf(page, S_QUALIFIED.id)).toBe('0');
    await expect(shown(column(page, S_QUALIFIED.id).getByTestId('column-empty')).first()).toBeVisible();

    // T-0147: the owner select, with Me and Unassigned, now lives in the phone's Filters sheet (T-0135, D-L193: P06/01
    // draws only owner avatars on a desktop), so it is checked at 360px; the desktop's avatar row is checked after it.
    const desktop = page.viewportSize();
    await page.setViewportSize({ width: 360, height: 780 });
    await shown(screen(page).locator('[data-action="open-filters"]')).first().click();
    const owners = await filterOptions(page, 'owner');
    expect(owners).toEqual(expect.arrayContaining(['me', 'unassigned']));
    for (const value of owners) {
      expect(/^(me|unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value), `owner option ${value}`).toBe(true);
    }
    const byOwner = page.waitForRequest((request) => isBoardRead(request) && new URL(request.url()).searchParams.getAll('owner').includes('me'));
    await chooseFilter(page, 'owner', 'me');
    await byOwner;
    await page.keyboard.press('Escape');
    await expect(shown(page.getByTestId('filter-sheet'))).toHaveCount(0);
    if (desktop !== null) await page.setViewportSize(desktop);
    // T-0147: the desktop's avatar row (T-0135): one toggle per owner, each an id, sent as the contract's `owner`.
    const avatars = shown(screen(page).locator('[data-filter-group="owner"] [data-owner-option]'));
    const avatarIds = await avatars.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-owner-option') ?? ''));
    expect(avatarIds.length, 'the desktop offers no owner avatars').toBeGreaterThan(0);
    for (const value of avatarIds) expect(UUID.test(value) && value.length === 36, `owner avatar ${value}`).toBe(true);
    const avatarId = avatarIds[0] ?? '';
    const byAvatar = page.waitForRequest((request) => {
      const sent = new URL(request.url()).searchParams.getAll('owner');
      return isBoardRead(request) && sent.includes(avatarId) && sent.includes('me');
    });
    await avatars.first().click();
    await byAvatar;
    await expect(avatars.first()).toHaveAttribute('aria-pressed', 'true');
    expect([...(await filterOptions(page, 'currency'))].sort(), 'the currency filter is not exactly NGN, GHS, KES and ZAR').toEqual([...CURRENCIES].sort());
    const byCurrency = page.waitForRequest((request) => isBoardRead(request) && new URL(request.url()).searchParams.getAll('currency').includes('NGN'));
    await chooseFilter(page, 'currency', 'NGN');
    await byCurrency;
    const byClose = page.waitForRequest((request) => {
      const params = new URL(request.url()).searchParams;
      return isBoardRead(request) && params.get('closeFrom') === '2026-10-01' && params.get('closeTo') === '2026-12-31';
    });
    await (await closeInput(page, 'closeFrom')).fill('2026-10-01');
    await (await closeInput(page, 'closeTo')).fill('2026-12-31');
    const apply = shown(page.locator('[data-filter-menu="close"] [data-testid="filter-apply"]'));
    if ((await apply.count()) > 0) await apply.first().click();
    const combined = new URL((await byClose).url());
    expect(combined.searchParams.get('q'), 'a later filter dropped the search').toBe('lockers');
    expect(combined.searchParams.getAll('owner')).toContain('me');
    expect(combined.searchParams.getAll('currency')).toContain('NGN');

    const list = await showList(page);
    for (const name of ['q', 'owner', 'currency', 'closeFrom', 'closeTo']) {
      expect(list.searchParams.getAll(name), `the list was not read with the board’s ${name}`).toEqual(combined.searchParams.getAll(name));
    }
    expect(mock.violations).toEqual([]);

    // A field the board says is withheld offers no filter (sending one is 400 field_withheld).
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await openBoard(page, { pipelineId: PIPELINE_TWO.id });
    await boardSettled(page, PIPELINE_TWO);
    // T-0147: the desktop's owner filter is the avatar row (T-0135); neither it nor a select may be offered.
    expect(await offersFilter(page, '[data-filter="owner"], [data-filter-group="owner"]'), 'an owner filter with the owner withheld').toBe(false);
    expect(await offersFilter(page, '[data-filter="currency"]'), 'a currency filter with the amount withheld').toBe(false);
    expect(await offersFilter(page, '[data-filter="close"], [data-filter-input="closeFrom"], [data-filter-input="closeTo"]'), 'a close-date filter with the close date withheld').toBe(false);
    expect(await offersFilter(page, '[data-filter="q"]'), 'no search: the name is never withheld').toBe(true);
  });
});

// ===========================================================================
// P06/01b — the list view
// ===========================================================================

test.describe('P06/01b — the list view', () => {
  test('listDeals rows in served order, lost included by stage name, no count and no totals @p06-pipeline @p06-pipeline-list', async ({ page }) => {
    const mock = await openBoard(page);
    await boardSettled(page);
    const read = await showList(page);
    expect(read.searchParams.getAll('stageId'), 'the list narrowed itself to some stages').toEqual([]);
    const sort = read.searchParams.get('sort') ?? '-updatedAt';
    expect(SORT_KEYS).toContain(sort);
    await expect(shown(screen(page).locator('[data-testid="deal-list"] [data-deal-row]')).first()).toBeVisible();
    expect(await listIds(page), 'the rows are not in served order').toEqual(listRows(mock.store, PIPELINE_ONE.id, NO_FILTERS, [], sort).map((row) => row.id));
    const lostRow = shown(screen(page).locator(`[data-deal-row="${D_L1.id}"]`)).first();
    // T-0147: the list's stage cell is now P06/03's select pill (T-0135, D-L193); a select draws its chosen option.
    const lostStage = lostRow.locator('[data-field="stage"]').first();
    const lostStageText = (await lostStage.evaluate((element) => element.tagName)) === 'SELECT'
      ? await lostStage.evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent ?? '')
      : await visibleText(lostStage);
    expect(lostStageText, 'a lost deal’s stage is not named').toContain(S_LOST.name);
    await expect(shown(screen(page).locator(`[data-deal-row="${D_L2.id}"]`)), 'a deal lost before the window is listed').toHaveCount(0);
    await expectMoney(page, shown(screen(page).locator(`[data-deal-row="${D_BIG.id}"] [data-field="amount"]`)).first(), '999999999999999999', 'NGN', 'the list’s amount');

    // Filter controls (a won window of "90 days" is a choice, not a count) are not the list's chrome.
    const chrome = await renderedText(
      screen(page),
      '[data-deal-row], [aria-hidden="true"], time, [data-record-text], select, [data-filter], [data-filter-menu], [data-testid="won-since"]',
    );
    expect(chrome, 'the list draws a count (D-P13)').not.toMatch(/\d/);
    await expect(shown(screen(page).locator('[data-stage-total], [data-stage-count]')), 'the list draws totals or counts').toHaveCount(0);
    await expectNoIdsAnywhere(page, 'the list view');
    await expectNoSeriousAxe(page, 'P06/01b');
  });

  test('sorting offers only the contract’s keys; amount, close date, owner and stage do not sort; a new sort drops the cursor @p06-pipeline @p06-pipeline-sort', async ({
    page,
  }) => {
    const mock = await openBoard(page, { bigColumn: true });
    await boardSettled(page);
    await showList(page);
    await expect(shown(screen(page).locator('[data-testid="deal-list"] [data-deal-row]')).first()).toBeVisible();
    const offered = await sortOptions(page);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.filter((key) => !SORT_KEYS.includes(key)), 'a sort the contract does not serve').toEqual([]);
    expect(offered).toContain('name');
    for (const name of ['amount', 'weightedAmount', 'expectedCloseDate', 'owner', 'ownerUserId', 'stage']) {
      const header = screen(page).locator(`[role="columnheader"][data-column="${name}"]`);
      await expect(header.locator('button'), `the ${name} column sorts`).toHaveCount(0);
      for (let index = 0; index < (await header.count()); index += 1) {
        expect(await header.nth(index).getAttribute('aria-sort'), `the ${name} column claims a sort`).toBeNull();
      }
    }
    await expect(screen(page).locator('[role="columnheader"][data-column="name"]').first(), 'the list has no Deal column header').toBeAttached();

    const more = shown(screen(page).getByTestId('deal-list-more')).first();
    await expect(more).toBeVisible();
    const paged = page.waitForRequest((request) => isListDeals(request) && new URL(request.url()).searchParams.has('cursor'));
    await more.click();
    await paged;
    const sorted = page.waitForRequest((request) => isListDeals(request) && new URL(request.url()).searchParams.get('sort') === 'name');
    await chooseSort(page, 'name');
    const byName = new URL((await sorted).url());
    expect(byName.searchParams.has('cursor'), 'a new sort kept the old cursor').toBe(false);
    await expect.poll(() => listIds(page).then((ids) => ids[0])).toBe(listRows(mock.store, PIPELINE_ONE.id, NO_FILTERS, [], 'name')[0]?.id);
  });

  test('the list pages by keyset "more", the cursor echoed with the same sort and filters, out of the URL, no count @p06-pipeline @p06-pipeline-list-paging', async ({
    page,
  }) => {
    const mock = await openBoard(page, { bigColumn: true });
    await boardSettled(page);
    const first = await showList(page);
    const sort = first.searchParams.get('sort') ?? '-updatedAt';
    const limit = Number(first.searchParams.get('limit') ?? 25);
    const all = listRows(mock.store, PIPELINE_ONE.id, NO_FILTERS, [], sort);
    expect(all.length, 'the fixture does not need a second page').toBeGreaterThan(limit);
    await expect.poll(() => listIds(page)).toEqual(all.slice(0, limit).map((row) => row.id));
    const sent = page.waitForRequest((request) => isListDeals(request) && new URL(request.url()).searchParams.has('cursor'));
    await shown(screen(page).getByTestId('deal-list-more')).first().click();
    const paged = new URL((await sent).url());
    expect(mock.issuedCursors()).toContain(paged.searchParams.get('cursor') ?? '');
    expect(paged.searchParams.get('sort') ?? '-updatedAt').toBe(sort);
    await expect.poll(() => listIds(page)).toEqual(all.slice(0, 2 * limit).map((row) => row.id));
    expect(page.url()).not.toMatch(/[?&]cursor=/);
    expect(await visibleText(screen(page)), 'a "N of TOTAL" was drawn').not.toMatch(/\b\d+\s+of\s+[\d,]+\b/i);
  });
});

// ===========================================================================
// Moves (D-L88, D-P20, D-L102)
// ===========================================================================

test.describe('moves', () => {
  test('a drag sends exactly { version, toStageId }; a drop on its own column sends nothing; counts after it are re-read, never adjusted @p06-pipeline @p06-pipeline-drag', async ({
    page,
  }) => {
    const mock = await openBoard(page, { concurrentArrival: { stageId: S_DISCOVERY.id } });
    await boardSettled(page);
    // Dropped back on its own column: nothing to write. Proved below, without
    // a sleep, by the next write being the FIRST the mock saw.
    await drag(page, card(page, S_QUALIFIED.id, D_Q1.id).first(), column(page, S_QUALIFIED.id));
    await expect(card(page, S_QUALIFIED.id, D_Q1.id)).toBeVisible();

    const moved = page.waitForRequest((request) => isMoveDeal(request, D_Q1.id));
    await drag(page, card(page, S_QUALIFIED.id, D_Q1.id).first(), column(page, S_DISCOVERY.id));
    const body = json((await moved).postDataJSON());
    expect(body, 'a move sent more than { version, toStageId }').toEqual({ version: D_Q1.version, toStageId: S_DISCOVERY.id });
    expect(mock.writes, 'the drop on its own column sent a write').toHaveLength(1);
    await expect(card(page, S_DISCOVERY.id, D_Q1.id)).toBeVisible();
    await expect(card(page, S_QUALIFIED.id, D_Q1.id)).toHaveCount(0);

    // Somebody else created a deal in Discovery at the same moment: only a re-read knows.
    await expect.poll(() => boardReadAfterMove(mock, D_Q1.id), { message: 'the board was not re-read after the move' }).toBe(true);
    await expect.poll(() => countOf(page, S_DISCOVERY.id), { message: 'the Discovery count was adjusted in the browser, not read' }).toBe('5');
    expect(await countOf(page, S_QUALIFIED.id)).toBe('3');
    const discovery = columnTotals(columnRows(mock.store, PIPELINE_ONE.id, S_DISCOVERY.id), S_DISCOVERY)[0];
    expect(discovery?.amountMinor).toBe((BigInt('1000000000974999999') + BigInt('3100000005') + BigInt(ARRIVAL_AMOUNT)).toString());
    await expect
      .poll(async () => digits(await visibleText(column(page, S_DISCOVERY.id).locator('[data-stage-total="NGN"] [data-money="amount"]').first())))
      .toBe(moneyDigits(discovery?.amountMinor ?? ''));

    const again = page.waitForRequest((request) => isMoveDeal(request, D_Q1.id));
    await drag(page, card(page, S_DISCOVERY.id, D_Q1.id).first(), column(page, S_QUALIFIED.id));
    expect(json((await again).postDataJSON()), 'the next move did not send the version the last move was served').toEqual({
      version: D_Q1.version + 1,
      toStageId: S_QUALIFIED.id,
    });
    await expect(card(page, S_QUALIFIED.id, D_Q1.id)).toBeVisible();
    await expectNoIdsAnywhere(page, 'after a move');
  });

  test('the move sheet offers exactly the allow-list, lost included, by pointer and keyboard, through the same write @p06-pipeline @p06-pipeline-move-sheet', async ({
    page,
  }) => {
    const mock = await openBoard(page);
    await boardSettled(page);
    const button = anyCard(page, D_Q2.id).locator('[data-action="move-deal"]').first();
    expect(await button.evaluate((element) => element.tagName === 'BUTTON' || element.getAttribute('role') === 'button'), 'the move control is not a button').toBe(true);
    const sheet = await openMoveSheet(page, D_Q2.id);
    const options = await moveOptions(sheet);
    expect(options.enabled, 'the sheet does not offer exactly the allow-list from Qualified').toEqual(allowedFrom(S_QUALIFIED.id));
    expect(options.enabled, 'lost is not reachable from the sheet').toContain(S_LOST.id);
    expect(options.enabled, 'the sheet offers the stage the deal is in').not.toContain(S_QUALIFIED.id);
    expect(await visibleText(sheet.locator(`[data-move-to="${S_LOST.id}"]`).first())).toContain(S_LOST.name);

    const toLost = page.waitForRequest((request) => isMoveDeal(request, D_Q2.id));
    await sheet.locator(`[data-move-to="${S_LOST.id}"]`).first().click();
    expect(json((await toLost).postDataJSON())).toEqual({ version: D_Q2.version, toStageId: S_LOST.id });
    await expect(anyCard(page, D_Q2.id), 'a lost deal stayed on the board').toHaveCount(0);
    await expect.poll(() => countOf(page, S_QUALIFIED.id)).toBe('3');

    // Again from the keyboard alone: Contract to Won, the only way into won.
    const keyboard = anyCard(page, D_C1.id).locator('[data-action="move-deal"]').first();
    await keyboard.focus();
    await page.keyboard.press('Enter');
    const keySheet = shown(page.getByTestId('move-sheet')).first();
    await expect(keySheet).toBeVisible();
    expect((await moveOptions(keySheet)).enabled).toEqual(allowedFrom(S_CONTRACT.id));
    const target = keySheet.locator(`[data-move-to="${S_WON.id}"]`).first();
    await target.focus();
    const toWon = page.waitForRequest((request) => isMoveDeal(request, D_C1.id));
    await page.keyboard.press('Enter');
    expect(json((await toWon).postDataJSON())).toEqual({ version: D_C1.version, toStageId: S_WON.id });
    await expect(card(page, S_WON.id, D_C1.id)).toBeVisible();
    expect(mock.writes).toHaveLength(2);
  });

  test('a gated stage opens the prompt: met requirements shown met, the rest filled and sent in the same move @p06-pipeline @p06-pipeline-requirements', async ({
    page,
  }) => {
    const mock = await openBoard(page);
    await boardSettled(page);
    await drag(page, card(page, S_PROPOSAL.id, D_P1.id).first(), column(page, S_NEGOTIATION.id));
    const dialog = await prompt(page);
    await expect(requirement(dialog, R_AMOUNT.id), 'a met requirement is asked again').toHaveAttribute('data-met', 'true');
    await expect(requirement(dialog, R_CLOSE.id)).toHaveAttribute('data-met', 'false');
    await expect(requirement(dialog, R_QUOTE.id)).toHaveAttribute('data-met', 'false');
    expect(await visibleText(requirement(dialog, R_QUOTE.id)), 'a check is not labelled word for word').toContain(String(R_QUOTE.label));
    await expectSaysOneOf(requirement(dialog, R_CLOSE.id), dealLabels('.field.expectedCloseDate'), 'the close-date requirement');
    await expect(shown(dialog.locator(`[data-requirement-input="${R_AMOUNT.id}"]`)), 'a met field is offered for editing').toHaveCount(0);

    // Not ready: nothing is sent (proved by the first write below being the full one).
    const confirm = dialog.locator('[data-action="confirm-move"]').first();
    if (!(await isDisabled(confirm))) await confirm.click();
    await expect(dialog).toBeVisible();

    await requirementInput(dialog, R_CLOSE.id).fill('2026-11-20');
    await requirementInput(dialog, R_QUOTE.id).check();
    const sent = page.waitForRequest((request) => isMoveDeal(request, D_P1.id));
    await confirm.click();
    expect(json((await sent).postDataJSON()), 'the move did not carry exactly what the person filled').toEqual({
      version: D_P1.version,
      toStageId: S_NEGOTIATION.id,
      fields: { expectedCloseDate: '2026-11-20' },
      checks: [R_QUOTE.id],
    });
    expect(mock.writes, 'an unfinished prompt was sent').toHaveLength(1);
    await expect(card(page, S_NEGOTIATION.id, D_P1.id)).toBeVisible();
    await expect(shown(page.getByTestId('move-requirements'))).toHaveCount(0);

    // From the sheet: Contract needs a primary contact, picked by name from the deal's programme only.
    const sheet = await openMoveSheet(page, D_N1.id);
    await sheet.locator(`[data-move-to="${S_CONTRACT.id}"]`).first().click();
    const contract = await prompt(page);
    await expect(requirement(contract, R_CONTACT.id)).toHaveAttribute('data-met', 'false');
    await requirementInput(contract, R_CONTACT.id).fill('alpha');
    const option = shown(page.locator(`[data-picker-option="${C_ALPHA.id}"]`)).first();
    await expect(option, 'the picker did not offer the contact').toBeVisible();
    await expect(shown(page.locator(`[data-picker-option="${C_ALPHA_ELSEWHERE.id}"]`)), 'the picker offered another programme’s contact').toHaveCount(0);
    await option.click();
    await requirementInput(contract, R_PO.id).check();
    const toContract = page.waitForRequest((request) => isMoveDeal(request, D_N1.id));
    await contract.locator('[data-action="confirm-move"]').first().click();
    expect(json((await toContract).postDataJSON())).toEqual({
      version: D_N1.version,
      toStageId: S_CONTRACT.id,
      fields: { primaryContactId: C_ALPHA.id },
      checks: [R_PO.id],
    });
    await expect(card(page, S_CONTRACT.id, D_N1.id)).toBeVisible();
    await expectNoIdsAnywhere(page, 'after the requirement prompt');
  });

  test('a move off the allow-list is said and never sent; a 409 transition_not_allowed is a translated message, never retried @p06-pipeline @p06-pipeline-blocked', async ({
    page,
  }) => {
    const mock = await openBoard(page, { transitionDrift: true });
    await boardSettled(page);
    // Qualified to Proposal skips a stage: not on the allow-list the screen read.
    await drag(page, card(page, S_QUALIFIED.id, D_Q1.id).first(), column(page, S_PROPOSAL.id));
    await expect(card(page, S_QUALIFIED.id, D_Q1.id), 'a forbidden drop moved the card').toBeVisible();
    await expect(card(page, S_PROPOSAL.id, D_Q1.id)).toHaveCount(0);
    const said = shown(screen(page).getByRole('alert')).first();
    await expect(said, 'a forbidden drop is not said').toBeVisible();
    expect(await visibleText(said)).not.toBe('');

    // The pipeline was reconfigured since the screen read it: the server refuses Qualified to Discovery.
    const answered = page.waitForResponse((response) => isMoveDeal(response.request(), D_Q1.id));
    await drag(page, card(page, S_QUALIFIED.id, D_Q1.id).first(), column(page, S_DISCOVERY.id));
    expect((await answered).status()).toBe(409);
    expect(mock.writes, 'the forbidden drop was sent').toHaveLength(1);
    const labels = [EN['records.error.transition_not_allowed'] ?? '', ...dealLabels('.transition_not_allowed', '.transitionNotAllowed')].filter((text) => text !== '');
    expect(labels.length, 'en.json has no label for transition_not_allowed').toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const alerts = shown(screen(page).getByRole('alert'));
        const texts = await alerts.evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
        return texts.some((text) => labels.some((label) => text.includes(label)));
      }, { message: 'no alert says the transition is not allowed' })
      .toBe(true);
    await expect(card(page, S_QUALIFIED.id, D_Q1.id), 'the card did not end where the server says').toBeVisible();

    // Never retried: the next write the mock sees is this deliberate one.
    const next = page.waitForRequest((request) => isMoveDeal(request, D_Q2.id));
    const sheet = await openMoveSheet(page, D_Q2.id);
    await sheet.locator(`[data-move-to="${S_LOST.id}"]`).first().click();
    await next;
    expect(mock.writes.map((write) => write.path), 'the refused move was retried').toEqual([`/api/v1/deals/${D_Q1.id}/move`, `/api/v1/deals/${D_Q2.id}/move`]);
  });

  test('a 422 names the unmet requirements by label, learning a new one by re-reading the pipeline, and is never retried @p06-pipeline @p06-pipeline-unmet', async ({
    page,
  }) => {
    const mock = await openBoard(page, { requirementDrift: true });
    await boardSettled(page);
    const answered = page.waitForResponse((response) => isMoveDeal(response.request(), D_Q1.id));
    await drag(page, card(page, S_QUALIFIED.id, D_Q1.id).first(), column(page, S_DISCOVERY.id));
    expect((await answered).status()).toBe(422);
    const alert = shown(screen(page).getByRole('alert')).first();
    await expect(alert).toContainText(String(R_DRIFT.label));
    expect(mock.pipelineReads.length, 'the pipeline was not re-read to name the new requirement').toBeGreaterThanOrEqual(2);
    await expect(card(page, S_QUALIFIED.id, D_Q1.id)).toBeVisible();
    await expectNoIdsAnywhere(page, 'the requirements refusal');
    expect(mock.writes).toHaveLength(1);

    // The person tries again; now the prompt knows the requirement. This is the second write, not a retry.
    await drag(page, card(page, S_QUALIFIED.id, D_Q1.id).first(), column(page, S_DISCOVERY.id));
    const dialog = await prompt(page);
    expect(await visibleText(requirement(dialog, R_DRIFT.id))).toContain(String(R_DRIFT.label));
    await requirementInput(dialog, R_DRIFT.id).check();
    const sent = page.waitForRequest((request) => isMoveDeal(request, D_Q1.id));
    await dialog.locator('[data-action="confirm-move"]').first().click();
    expect(json((await sent).postDataJSON())).toEqual({ version: D_Q1.version, toStageId: S_DISCOVERY.id, checks: [R_DRIFT.id] });
    await expect(card(page, S_DISCOVERY.id, D_Q1.id)).toBeVisible();
    expect(mock.writes).toHaveLength(2);
  });

  test('a 409 stale_write re-reads and rebases: the prompt keeps what was typed, notes the other change, and resends on the fresh version @p06-pipeline @p06-pipeline-stale', async ({
    page,
  }) => {
    const mock = await openBoard(page, { concurrent: { dealId: D_P1.id, changes: [{ expectedCloseDate: '2026-11-30' }] } });
    await boardSettled(page);
    await drag(page, card(page, S_PROPOSAL.id, D_P1.id).first(), column(page, S_NEGOTIATION.id));
    const dialog = await prompt(page);
    await requirementInput(dialog, R_CLOSE.id).fill('2026-11-20');
    await requirementInput(dialog, R_QUOTE.id).check();
    const lost = page.waitForResponse((response) => isMoveDeal(response.request(), D_P1.id));
    await dialog.locator('[data-action="confirm-move"]').first().click();
    expect((await lost).status()).toBe(409);
    await expect.poll(() => reReadAfterMove(mock, D_P1.id), { message: 'the deal was not re-read after the 409' }).toBe(true);

    const rebased = await prompt(page);
    await expect(requirementInput(rebased, R_CLOSE.id), 'the typed close date was lost').toHaveValue('2026-11-20');
    await expect(requirementInput(rebased, R_QUOTE.id)).toBeChecked();
    await expect(shown(requirement(rebased, R_CLOSE.id).locator('[data-conflict]')).first(), 'no "changed by someone else" note').toBeVisible();
    expect(mock.writes, 'the 409 was retried by itself').toHaveLength(1);
    const second = page.waitForRequest((request) => isMoveDeal(request, D_P1.id));
    await rebased.locator('[data-action="confirm-move"]').first().click();
    expect(json((await second).postDataJSON()), 'the second move is not the person’s input on the fresh version').toEqual({
      version: D_P1.version + 1,
      toStageId: S_NEGOTIATION.id,
      fields: { expectedCloseDate: '2026-11-20' },
      checks: [R_QUOTE.id],
    });
    await expect(card(page, S_NEGOTIATION.id, D_P1.id)).toBeVisible();
  });

  test('two 409s in a row: each re-read, each resend on the fresh version, a field nobody typed never sent @p06-pipeline @p06-pipeline-stale', async ({
    page,
  }) => {
    const mock = await openBoard(page, {
      concurrent: { dealId: D_P1.id, changes: [{ nextStep: 'Changed at another desk' }, { nextStep: 'Changed at another desk again' }] },
    });
    await boardSettled(page);
    await drag(page, card(page, S_PROPOSAL.id, D_P1.id).first(), column(page, S_NEGOTIATION.id));
    let dialog = await prompt(page);
    await requirementInput(dialog, R_CLOSE.id).fill('2026-11-20');
    await requirementInput(dialog, R_QUOTE.id).check();
    for (const version of [D_P1.version, D_P1.version + 1, D_P1.version + 2]) {
      const sent = page.waitForRequest((request) => isMoveDeal(request, D_P1.id));
      await dialog.locator('[data-action="confirm-move"]').first().click();
      expect(json((await sent).postDataJSON())).toEqual({ version, toStageId: S_NEGOTIATION.id, fields: { expectedCloseDate: '2026-11-20' }, checks: [R_QUOTE.id] });
      if (version < D_P1.version + 2) {
        await expect.poll(() => mock.writes.length).toBe(version - D_P1.version + 1);
        await expect.poll(() => mock.writes.at(-1)?.status).toBe(409);
        await expect.poll(() => reReadAfterMove(mock, D_P1.id)).toBe(true);
        dialog = await prompt(page);
        await expect(requirementInput(dialog, R_CLOSE.id)).toHaveValue('2026-11-20');
        await expect(shown(dialog.locator('[data-conflict]')), 'a conflict noted where nobody else touched the field').toHaveCount(0);
      }
    }
    await expect(card(page, S_NEGOTIATION.id, D_P1.id)).toBeVisible();
    expect(mock.writes.map((write) => write.status)).toEqual([409, 409, 200]);
  });

  test('a stale move with no prompt is re-read and never resent by itself; the next move sends the fresh version @p06-pipeline @p06-pipeline-stale', async ({
    page,
  }) => {
    const mock = await openBoard(page, { concurrent: { dealId: D_Q1.id, changes: [{ nextStep: 'Changed at another desk' }] } });
    await boardSettled(page);
    const lost = page.waitForResponse((response) => isMoveDeal(response.request(), D_Q1.id));
    await drag(page, card(page, S_QUALIFIED.id, D_Q1.id).first(), column(page, S_DISCOVERY.id));
    expect((await lost).status()).toBe(409);
    await expect(shown(screen(page).getByRole('alert')).first()).toBeVisible();
    await expect.poll(() => reReadAfterMove(mock, D_Q1.id)).toBe(true);
    await expect(card(page, S_QUALIFIED.id, D_Q1.id)).toBeVisible();
    const again = page.waitForRequest((request) => isMoveDeal(request, D_Q1.id));
    await drag(page, card(page, S_QUALIFIED.id, D_Q1.id).first(), column(page, S_DISCOVERY.id));
    expect(json((await again).postDataJSON())).toEqual({ version: D_Q1.version + 1, toStageId: S_DISCOVERY.id });
    expect(mock.writes.map((write) => write.status)).toEqual([409, 200]);
  });

  test('a required field the caller cannot read is a lock in the prompt; the 403 names the fields; an agent’s 403 is translated; neither is retried @p06-pipeline @p06-pipeline-not-editable', async ({
    page,
  }) => {
    const mock = await openBoard(page, { pipelineId: PIPELINE_TWO.id });
    await boardSettled(page, PIPELINE_TWO);
    await drag(page, card(page, T_PROPOSAL.id, E_P1.id).first(), column(page, T_NEGOTIATION.id));
    const dialog = await prompt(page);
    const amountId = T_NEGOTIATION.requirements[0]?.id ?? '';
    const closeId = T_NEGOTIATION.requirements[1]?.id ?? '';
    for (const id of [amountId, closeId]) {
      await expect(requirement(dialog, id), 'a withheld required field is not a lock').toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(requirement(dialog, id))).toHaveCount(1);
      await expect(shown(dialog.locator(`[data-requirement-input="${id}"]`)), 'a lock is offered for filling').toHaveCount(0);
    }
    await requirementInput(dialog, T_R_QUOTE.id).check();
    const answered = page.waitForResponse((response) => isMoveDeal(response.request(), E_P1.id));
    await dialog.locator('[data-action="confirm-move"]').first().click();
    const response = await answered;
    expect(response.status()).toBe(403);
    expect(json(response.request().postDataJSON())).toEqual({ version: E_P1.version, toStageId: T_NEGOTIATION.id, checks: [T_R_QUOTE.id] });
    const alert = shown(page.getByRole('alert')).first();
    await expect(alert).toBeVisible();
    await expectSaysOneOf(alert, dealLabels('.field.amount'), 'the refusal naming the amount');
    await expectSaysOneOf(alert, dealLabels('.field.expectedCloseDate'), 'the refusal naming the close date');
    await expectNoIdsAnywhere(page, 'the field_not_editable refusal');
    await page.keyboard.press('Escape');
    await expect(card(page, T_PROPOSAL.id, E_P1.id)).toBeVisible();
    const next = page.waitForRequest((request) => isMoveDeal(request, E_Q1.id));
    const sheet = await openMoveSheet(page, E_Q1.id);
    await sheet.locator(`[data-move-to="${PIPELINE_TWO.stages[1]?.id ?? ''}"]`).first().click();
    await next;
    expect(mock.writes.map((write) => write.path), 'the 403 was retried').toEqual([`/api/v1/deals/${E_P1.id}/move`, `/api/v1/deals/${E_Q1.id}/move`]);

    // An agent moving somebody else's deal: the API's 403, said in translated copy (en-XA proves it).
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const agent = await openBoard(page, { role: 'agent', query: '?locale=en-XA' });
    await boardSettled(page);
    const refused = page.waitForResponse((response) => isMoveDeal(response.request(), D_Q_OTHER.id));
    await drag(page, card(page, S_QUALIFIED.id, D_Q_OTHER.id).first(), column(page, S_DISCOVERY.id));
    expect((await refused).status()).toBe(403);
    const said = await visibleText(shown(screen(page).getByRole('alert')).first());
    expect(said, 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect(card(page, S_QUALIFIED.id, D_Q_OTHER.id), 'the card did not go back').toBeVisible();
    expect(agent.writes).toHaveLength(1);
  });
});

// ===========================================================================
// Create (R7)
// ===========================================================================

test.describe('create', () => {
  test('a new deal sends name and money as a minor-unit string with its currency, lands in the first open stage, drawn in its currency’s format @p06-pipeline @p06-pipeline-create', async ({
    page,
  }) => {
    const mock = await openBoard(page);
    await boardSettled(page);
    let dialog = await openCreate(page);
    const codes = await field(dialog, 'currency').locator('option').evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value).filter((value) => value !== ''),
    );
    expect([...codes].sort(), 'the currencies offered are not exactly NGN, GHS, KES and ZAR').toEqual([...CURRENCIES].sort());
    // A number input cannot hold eighteen significant digits faithfully (R7).
    expect(await field(dialog, 'amount').getAttribute('type'), 'the amount is a number input').not.toBe('number');

    // Refused before anything is sent.
    await field(dialog, 'name').fill('Synthetic school feeding pilot');
    for (const bad of ['1.234', '-5', 'abc', '10000000000000000']) {
      await field(dialog, 'amount').fill(bad);
      await dialog.locator('[data-action="create-deal"]').first().click();
      await expect(shown(dialog.locator('[data-field-error="amount"]')).first(), `"${bad}" was not refused`).toBeVisible();
    }
    expect(mock.writes, 'a refused amount was sent').toEqual([]);

    await field(dialog, 'amount').fill('1250.5');
    await field(dialog, 'currency').selectOption('GHS');
    await field(dialog, 'expectedCloseDate').fill('2026-12-01');
    const sent = page.waitForRequest((request) => isCreateDeal(request));
    await dialog.locator('[data-action="create-deal"]').first().click();
    expect(json((await sent).postDataJSON()), 'the create did not send exactly what was filled').toEqual({
      name: 'Synthetic school feeding pilot',
      amount: { amountMinor: '125050', currency: 'GHS' },
      expectedCloseDate: '2026-12-01',
    });
    const createdId = mock.store.find((row) => row.name === 'Synthetic school feeding pilot')?.id ?? '';
    await expect(card(page, S_QUALIFIED.id, createdId), 'the new deal is not in the first open stage').toBeVisible();
    await expectMoney(page, card(page, S_QUALIFIED.id, createdId).first().locator('[data-field="amount"]').first(), '125050', 'GHS', 'the new deal');
    await expect.poll(() => countOf(page, S_QUALIFIED.id), { message: 'the count was not re-read after the create' }).toBe('5');

    // Eighteen nines of kobo, exact; a name alone; a fraction of a naira.
    for (const [amount, currency, expected] of [
      ['9999999999999999.99', 'NGN', { amountMinor: '999999999999999999', currency: 'NGN' }],
      ['0.05', 'NGN', { amountMinor: '5', currency: 'NGN' }],
      ['', 'NGN', undefined],
    ] as const) {
      dialog = await openCreate(page);
      await field(dialog, 'name').fill(`Synthetic deal ${currency} ${amount === '' ? 'none' : 'some'} ${expected?.amountMinor.length ?? 0}`);
      if (amount !== '') {
        await field(dialog, 'amount').fill(amount);
        await field(dialog, 'currency').selectOption(currency);
      }
      const next = page.waitForRequest((request) => isCreateDeal(request));
      await dialog.locator('[data-action="create-deal"]').first().click();
      const body = json((await next).postDataJSON());
      expect(Object.keys(body).sort(), 'an empty field was sent').toEqual(expected === undefined ? ['name'] : ['amount', 'name']);
      expect(body.amount).toEqual(expected);
      await expect(shown(page.getByTestId('deal-create'))).toHaveCount(0);
    }
    expect(mock.writes.map((write) => write.status)).toEqual([201, 201, 201, 201]);
  });

  test('a refused create is a translated message and the form keeps what was typed @p06-pipeline @p06-pipeline-create-refused', async ({ page }) => {
    const mock = await openBoard(page, { role: 'qa_analyst', query: '?locale=en-XA' });
    await boardSettled(page);
    const dialog = await openCreate(page);
    await field(dialog, 'name').fill('Synthetic refused deal');
    const answered = page.waitForResponse((response) => isCreateDeal(response.request()));
    await dialog.locator('[data-action="create-deal"]').first().click();
    expect((await answered).status()).toBe(403);
    const alert = shown(page.getByRole('alert')).first();
    await expect(alert).toBeVisible();
    expect(await visibleText(alert), 'the refusal is the server message, not translated copy').toMatch(PSEUDO);
    await expect(dialog).toBeVisible();
    await expect(field(dialog, 'name')).toHaveValue('Synthetic refused deal');
    expect(mock.writes).toHaveLength(1);
  });
});

// ===========================================================================
// Withheld, rotting, links
// ===========================================================================

test.describe('withheld fields, rotting and links', () => {
  test('withheld amounts, owners and close dates are locks, never zero; a null is never a lock; a former owner is named neutrally @p06-pipeline @p06-pipeline-locked', async ({
    page,
  }) => {
    const mock = await openBoard(page, { pipelineId: PIPELINE_TWO.id });
    await boardSettled(page, PIPELINE_TWO);
    for (const stage of boardStages(PIPELINE_TWO)) {
      const totals = column(page, stage.id).locator('[data-stage-totals]').first();
      await expect(totals, `the ${stage.name} totals are not a lock`).toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(totals)).toHaveCount(1);
      await expect(shown(column(page, stage.id).locator('[data-stage-total]')), 'a total was drawn with the amount withheld').toHaveCount(0);
    }
    expect(await countOf(page, T_QUALIFIED.id), 'the count went with the amount').toBe('1');
    const fieldCard = card(page, T_QUALIFIED.id, E_Q1.id).first();
    for (const name of ['amount', 'owner', 'expectedCloseDate']) {
      const cell = fieldCard.locator(`[data-field="${name}"]`).first();
      await expect(cell, `the withheld ${name} is not a lock`).toHaveAttribute('data-locked', 'true');
      await expect(lockIcon(cell)).toHaveCount(1);
      const said = await visibleText(cell);
      expect(said, `the withheld ${name} is blank`).not.toBe('');
      expect(said, `the withheld ${name} draws a number`).not.toMatch(/\d/);
    }
    const board = await visibleText(shown(screen(page).getByTestId('board')).first());
    for (const currency of CURRENCIES) {
      // A one-letter mark (the rand's narrow "R") would match any capital R in the copy.
      for (const mark of (await currencyMarks(page, currency)).filter((entry) => !/^[A-Za-z]$/.test(entry))) {
        expect(board.includes(mark), `money (${mark}) is drawn with the amount withheld`).toBe(false);
      }
    }
    // The create form does not offer what the caller cannot set.
    const dialog = await openCreate(page);
    await expect(shown(dialog.locator('[data-field-input="amount"], [data-field-input="currency"], [data-field-input="expectedCloseDate"]')), 'a withheld field is offered').toHaveCount(0);
    await field(dialog, 'name').fill('Synthetic field deal');
    const sent = page.waitForRequest((request) => isCreateDeal(request));
    await dialog.locator('[data-action="create-deal"]').first().click();
    expect(json((await sent).postDataJSON())).toEqual({ name: 'Synthetic field deal' });
    expect(mock.violations).toEqual([]);

    // PIPELINE_ONE: no amount is not a lock, unassigned is not a lock, a former owner is not an id.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await openBoard(page);
    await boardSettled(page);
    const noAmount = card(page, S_DISCOVERY.id, D_D2.id).first();
    expect(await noAmount.locator('[data-field="amount"]').first().getAttribute('data-locked'), 'a deal with no amount is drawn as withheld').not.toBe('true');
    expect(digits(await visibleText(noAmount.locator('[data-field="amount"]').first())), 'no amount is drawn as zero').toBe('');
    await expectSaysOneOf(noAmount.locator('[data-field="owner"]').first(), [EN['records.owner.former'] ?? ''].filter((text) => text !== ''), 'a former owner');
    const unassigned = card(page, S_QUALIFIED.id, D_Q2.id).first().locator('[data-field="owner"]').first();
    expect(await unassigned.getAttribute('data-locked'), 'an unassigned deal is drawn as withheld').not.toBe('true');
    expect(await visibleText(unassigned)).not.toContain(EN['records.owner.former'] ?? '<none>');
    await expectNoIdsAnywhere(page, 'former owner and no amount');
  });

  test('rotting is the server’s, from the stage’s own days, never the design’s 7/14 rule @p06-pipeline @p06-pipeline-rotting', async ({ page }) => {
    await openBoard(page);
    await boardSettled(page);
    const cases: readonly (readonly [StoredDeal, string, string])[] = [
      [D_C1, S_CONTRACT.id, 'fresh'], // 8 days of 21: the design's rule would say stale
      [D_C2, S_CONTRACT.id, 'stale'], // 15 days of 21: the design's rule would say rotting
      [D_C3, S_CONTRACT.id, 'rotting'],
      [D_Q2, S_QUALIFIED.id, 'stale'],
      [D_Q1, S_QUALIFIED.id, 'fresh'],
      [D_D1, S_DISCOVERY.id, 'rotting'],
      [D_N1, S_NEGOTIATION.id, 'stale'],
    ];
    const staleLabels = dealLabels('.rotting.stale');
    const rottingLabels = dealLabels('.rotting.rotting');
    expect(staleLabels.length, 'en.json has no deal "stale" label').toBeGreaterThan(0);
    expect(rottingLabels.length, 'en.json has no deal "rotting" label').toBeGreaterThan(0);
    for (const [row, stageId, state] of cases) {
      const element = card(page, stageId, row.id).first();
      await expect(element, `${row.name}`).toHaveAttribute('data-rotting', state);
      const said = await copyText(element);
      const saysStale = staleLabels.some((label) => said.includes(label));
      const saysRotting = rottingLabels.some((label) => said.includes(label));
      expect([saysStale, saysRotting], `${row.name} (${state}) says "${said}"`).toEqual([state === 'stale', state === 'rotting']);
    }
    expect(await card(page, S_WON.id, D_W1.id).first().getAttribute('data-rotting'), 'a won deal rots').toBeNull();
  });

  test('summaries link only from well-formed uuids; a name with markup is text; no id is printed @p06-pipeline @p06-pipeline-links', async ({ page }) => {
    const mock = await openBoard(page, { hostileSummaries: true });
    await boardSettled(page);
    expect(mock.plantedFaults.length, 'the hostile summaries were not served').toBeGreaterThan(0);
    const hostile = card(page, S_QUALIFIED.id, D_Q_MARKUP.id).first();
    await expect(hostile.locator('[data-field="name"]').first()).toContainText(HOSTILE_NAME);
    expect(await page.evaluate(() => (window as unknown as { __kasuwaXss?: number }).__kasuwaXss), 'markup in a deal name ran').toBeUndefined();
    // The card's name links its deal (a uuid, R15); only the summaries are judged here.
    await expect(hostile.locator('[data-related] a'), 'a summary with a malformed id is a link').toHaveCount(0);
    await expect(hostile.locator('[data-related]').first(), 'the summary is not drawn as text').toBeVisible();
    await expect(card(page, S_DISCOVERY.id, D_D1.id).first().locator(`[data-related="account"] a[href="/accounts/${A_PHARMACY.id}"]`)).toHaveCount(1);
    await expect(card(page, S_NEGOTIATION.id, D_N2.id).first().locator(`[data-related="contact"] a[href="/contacts/${C_ALPHA.id}"]`)).toHaveCount(1);
    const hrefs = await screen(page).locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
    expect(hrefs.filter((href) => /javascript:|\.\.\//i.test(href)), 'a hostile id reached an href').toEqual([]);
    await expectNoIdsAnywhere(page, 'the board with hostile summaries');
  });
});

// ===========================================================================
// States
// ===========================================================================

test.describe('states', () => {
  test('loading is a skeleton, never empty or an error, until the board arrives @p06-pipeline @p06-pipeline-states', async ({ page }) => {
    const mock = await openBoard(page, { hold: true });
    try {
      await expect(shown(screen(page).getByTestId('board-skeleton')).first()).toBeVisible();
      await expect(shown(screen(page).locator('[data-testid="board-empty"], [data-testid="board-error"], [data-testid="record-not-found"], [data-deal-card]'))).toHaveCount(0);
    } finally {
      mock.release();
    }
    await boardSettled(page);
    await expect(shown(screen(page).getByTestId('board-skeleton'))).toHaveCount(0);
  });

  test('an empty pipeline is its own state with a way to add a deal, not an error @p06-pipeline @p06-pipeline-states', async ({ page }) => {
    await openBoard(page, { empty: true });
    const empty = shown(screen(page).getByTestId('board-empty')).first();
    await expect(empty).toBeVisible();
    expect(await visibleText(empty)).not.toBe('');
    await expect(shown(screen(page).locator('[data-testid="board-error"], [data-deal-card]'))).toHaveCount(0);
    await expect(shown(screen(page).locator('[data-action="new-deal"]')).first()).toBeVisible();
  });

  test('a failed read is an error, never "no deals"; an unknown pipeline is not found, never an error @p06-pipeline @p06-pipeline-states', async ({ page }) => {
    await openBoard(page, { networkFailure: true });
    await expect(shown(screen(page).getByTestId('board-error')).first()).toBeVisible();
    await expect(shown(screen(page).locator('[data-testid="board-empty"], [data-testid="column-empty"], [data-deal-card]'))).toHaveCount(0);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await openBoard(page, { pipelineId: OUT_OF_SCOPE_PIPELINE_ID });
    await expect(shown(screen(page).getByTestId('record-not-found')).first()).toBeVisible();
    await expect(shown(screen(page).locator('[data-testid="board-error"], [data-testid="board-empty"]'))).toHaveCount(0);
  });

  test('a malformed pipeline id is a real 404 that reads nothing @p06-pipeline @p06-pipeline-states', async ({ page }) => {
    const mock = await installPipelineMock(page);
    active = mock;
    const response = await page.goto(`${pipelineUrl()}/pipelines/not-a-uuid`);
    expect(response?.status()).toBe(404);
    expect(mock.requests.filter((url) => /^\/api\/v1\/(pipelines|deals)/.test(url.pathname)), 'a malformed id was read').toEqual([]);
  });

  test('a failed column page is an error in that column; the cards already drawn stay @p06-pipeline @p06-pipeline-states', async ({ page }) => {
    await openBoard(page, { bigColumn: true, columnFailure: S_QUALIFIED.id });
    await boardSettled(page);
    const before = await cardIds(page, S_QUALIFIED.id);
    await shown(column(page, S_QUALIFIED.id).getByTestId('column-more')).first().click();
    await expect(shown(column(page, S_QUALIFIED.id).getByTestId('column-error')).first()).toBeVisible();
    expect(await cardIds(page, S_QUALIFIED.id)).toEqual(before);
    await expect(shown(screen(page).getByTestId('board-error'))).toHaveCount(0);
  });

  test('the list view keeps failed, empty and no results apart @p06-pipeline @p06-pipeline-states', async ({ page }) => {
    await openBoard(page, { listFailure: true });
    await boardSettled(page);
    await showList(page);
    await expect(shown(screen(page).getByTestId('list-error')).first()).toBeVisible();
    await expect(shown(screen(page).locator('[data-testid="list-empty"], [data-testid="list-no-results"]'))).toHaveCount(0);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await openBoard(page, { empty: true });
    await showList(page);
    await expect(shown(screen(page).getByTestId('list-empty')).first()).toBeVisible();
    await expect(shown(screen(page).locator('[data-testid="list-error"], [data-testid="list-no-results"]'))).toHaveCount(0);

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await openBoard(page);
    await boardSettled(page);
    await showList(page);
    const searched = page.waitForRequest((request) => isListDeals(request) && new URL(request.url()).searchParams.get('q') === 'zzqx');
    await shown(screen(page).locator('input[type="search"][data-filter="q"]')).first().fill('zzqx');
    await searched;
    await expect(shown(screen(page).getByTestId('list-no-results')).first()).toBeVisible();
    await expect(shown(screen(page).locator('[data-testid="list-error"], [data-testid="list-empty"]'))).toHaveCount(0);
  });
});

// ===========================================================================
// Offline (D-P21, D-L64)
// ===========================================================================

test('offline: every write and every drag is disabled, nothing is queued or sent, and nothing is kept on the device @p06-pipeline @p06-pipeline-offline', async ({
  page,
}) => {
  const mock = await openBoard(page);
  await boardSettled(page);
  await expect(shown(screen(page).locator('[data-action="new-deal"]')).first()).toHaveAttribute('data-requires-connection', /.*/);
  await expect(anyCard(page, D_Q1.id).locator('[data-action="move-deal"]').first()).toHaveAttribute('data-requires-connection', /.*/);

  await page.context().setOffline(true);
  try {
    const banner = shown(page.getByTestId('offline-banner')).first();
    await expect(banner).toBeVisible();
    expect(await visibleText(banner), 'the banner does not say when the board last synced').toMatch(/\d{1,2}[:.]\d{2}/);
    expect(await copyText(page.locator('body')), 'an offline queue is offered').not.toMatch(/queued|sync queue|will sync|saved on this (phone|device)/i);
    const needsConnection = page.locator('[data-requires-connection]');
    const count = await needsConnection.count();
    expect(count, 'nothing is marked as needing a connection').toBeGreaterThan(2);
    for (let index = 0; index < count; index += 1) {
      expect(await isDisabled(needsConnection.nth(index)), `a control that needs a connection is enabled offline (#${index})`).toBe(true);
    }
    await drag(page, card(page, S_QUALIFIED.id, D_Q1.id).first(), column(page, S_DISCOVERY.id));
    await expect(card(page, S_QUALIFIED.id, D_Q1.id), 'an offline drag moved the card').toBeVisible();
    expect(await cardIds(page, S_PROPOSAL.id), 'the board was dropped when the connection went').toEqual(EXPECTED_BOARD[2]?.cards.map((row) => row.id));

    const stored = await deviceStorage(page);
    expect(stored.cachedApi, 'an API response was put in Cache Storage').toEqual([]);
    expect(stored.databases, 'an IndexedDB database was opened').toEqual([]);
    for (const needle of needles()) {
      expect(stored.dump.includes(needle), `"${needle}" was written to device storage`).toBe(false);
    }
  } finally {
    await page.context().setOffline(false);
  }
  await expect(shown(page.getByTestId('offline-banner'))).toHaveCount(0);
  // Back online, a real move. If the offline drag had been queued, it would land first.
  const sent = page.waitForRequest((request) => isMoveDeal(request));
  const sheet = await openMoveSheet(page, D_Q2.id);
  await sheet.locator(`[data-move-to="${S_DISCOVERY.id}"]`).first().click();
  await sent;
  expect(mock.writes.map((write) => write.path), 'a write was sent or queued while offline').toEqual([`/api/v1/deals/${D_Q2.id}/move`]);
});

// ===========================================================================
// Hidden until their modules exist (D-L88's hidden list, R18)
// ===========================================================================

test('no US$, FX, territory, amount band, AI risk, products, quotes, approvals, attachments, WhatsApp, Undo, templates or board summary @p06-pipeline @p06-pipeline-hidden', async ({
  page,
}) => {
  await openBoard(page);
  await boardSettled(page);
  const banned: readonly (readonly [RegExp, string])[] = [
    [/US\$|\bUSD\b|≈|exchange rate|\bFX\b|\brate locked\b/i, 'US$ or an FX rate'],
    [/territor/i, 'a territory'],
    [/under\s+\S*\d|over\s+\S*\d|any amount/i, 'an amount band'],
    [/\bAI\b|deal risk|win chance/i, 'AI risk'],
    [/\bproducts?\b|price book/i, 'products'],
    [/\bquotes?\b(?!\s+sent)/i, 'quotes'],
    [/approv/i, 'approvals'],
    [/attach|upload/i, 'attachments'],
    [/whatsapp/i, 'the last WhatsApp contact'],
    [/\bundo\b/i, 'Undo'],
    [/template|create your first pipeline|start from blank/i, 'the template picker'],
    [/open pipeline|won this quarter|open deals|earlier this quarter/i, 'a board-level summary'],
    [/competitor|contact roles?/i, 'competitors or contact roles'],
  ];
  const check = async (where: string, root: Locator) => {
    const copy = await copyText(root);
    for (const [pattern, what] of banned) {
      expect(copy, `${what} is drawn on ${where}`).not.toMatch(pattern);
    }
    await expect(shown(root.locator('[aria-hidden="true"]', { hasText: /^\s*(auto_awesome|currency_exchange|chat|upload_file|approval|request_quote)\s*$/ })), `a hidden feature’s icon on ${where}`).toHaveCount(0);
  };
  await expect(shown(screen(page).locator('[data-filter="amount"], [data-filter="territory"], [data-action="show-usd"]'))).toHaveCount(0);
  await check('the board', page.locator('body'));
  await openMoveSheet(page, D_Q1.id);
  await check('the move sheet', page.locator('body'));
  await page.keyboard.press('Escape');
  await drag(page, card(page, S_PROPOSAL.id, D_P1.id).first(), column(page, S_NEGOTIATION.id));
  await check('the requirement prompt', await prompt(page));
  await page.keyboard.press('Escape');
  await check('the create form', await openCreate(page));
  await page.keyboard.press('Escape');
  await showList(page);
  await expect(shown(screen(page).locator('[data-testid="deal-list"] [data-deal-row]')).first()).toBeVisible();
  await check('the list view', page.locator('body'));
});

// ===========================================================================
// Mobile
// ===========================================================================

test('at 360px the board fits without sideways page scroll, passes axe, and the move sheet works @p06-pipeline @p06-pipeline-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const mock = await openBoard(page);
  await expect(anyCard(page, D_Q1.id).first()).toBeVisible();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow(), 'the board scrolls the PAGE sideways at 360px (a column scroller inside it is fine)').toBeLessThanOrEqual(0);
  await expectNoSeriousAxe(page, 'P06/04 at 360px');
  const sheet = await openMoveSheet(page, D_Q1.id);
  const box = await sheet.boundingBox();
  expect(box !== null && box.x >= 0 && box.x + box.width <= 361, 'the move sheet is wider than the screen').toBe(true);
  const sent = page.waitForRequest((request) => isMoveDeal(request, D_Q1.id));
  await sheet.locator(`[data-move-to="${S_DISCOVERY.id}"]`).first().click();
  await sent;
  // The design offers the list view on desktop only (P06/04 is the board as a swipe list).
  await expect(card(page, S_DISCOVERY.id, D_Q1.id)).toBeAttached();
  expect(await overflow(), 'the board scrolls the page sideways after a move at 360px').toBeLessThanOrEqual(0);
  await expectNoIdsAnywhere(page, 'the 360px board');
  expect(mock.writes).toHaveLength(1);
});

// ===========================================================================
// i18n
// ===========================================================================

test('locale=en-XA renders every string as pseudo text, record data and times excepted @p06-pipeline @p06-pipeline-pseudo', async ({ page }) => {
  await openBoard(page, { query: '?locale=en-XA' });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA');
  await boardSettled(page);
  const report = (root: Locator) =>
    root.evaluate((element, servedJson) => {
      const pseudo = (text: string) => /[·[\]äëïöüÄËÏÖÜ]/.test(text);
      const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length >= 2;
      const recordish = (text: string) => servedJson.includes(text) || servedJson.includes(JSON.stringify(text).slice(1, -1));
      // Money is Intl's, in the page's language ("NGN 1.00" carries letters), and so are the currency codes.
      const skipped = (node: Element | null) =>
        node === null ||
        node.closest('[aria-hidden="true"], [data-testid^="language-"], script, style, noscript, time, [data-money], [data-field="amount"], [data-field-input="currency"]') !== null;
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

  const boardReport = await report(page.locator('[data-shell="crm"]'));
  expect(boardReport.english, 'strings on the board that did not come through i18n').toEqual([]);
  expect(boardReport.forged, 'UI copy marked data-record-text that is not served record data').toEqual([]);
  expect(boardReport.pseudoCount, 'almost no pseudo text: the check saw nothing').toBeGreaterThanOrEqual(10);
  const sheet = await openMoveSheet(page, D_Q1.id);
  expect((await report(sheet)).english, 'strings in the move sheet that did not come through i18n').toEqual([]);
  await page.keyboard.press('Escape');
  await drag(page, card(page, S_PROPOSAL.id, D_P1.id).first(), column(page, S_NEGOTIATION.id));
  const dialog = await prompt(page);
  const promptReport = await report(dialog);
  expect(promptReport.english, 'strings in the requirement prompt that did not come through i18n').toEqual([]);
  expect(promptReport.forged).toEqual([]);
  await page.keyboard.press('Escape');
  expect((await report(await openCreate(page))).english, 'strings in the create form that did not come through i18n').toEqual([]);
  await page.keyboard.press('Escape');
  await showList(page);
  await expect(shown(screen(page).locator('[data-testid="deal-list"] [data-deal-row]')).first()).toBeVisible();
  const listReport = await report(page.locator('[data-shell="crm"]'));
  expect(listReport.english, 'strings on the list view that did not come through i18n').toEqual([]);
  expect(listReport.forged).toEqual([]);
});

// ===========================================================================
// Budget
// ===========================================================================

test.describe('/pipelines/[pipelineId] on the wire', () => {
  /**
   * WHY A 260,000-BYTE CEILING, BEFORE THE SCREEN EXISTS
   *
   * The same shell, fonts and records clients as its measured neighbours
   * (/activities pinned at 236,000; /scripts/[scriptId] at 250,000), plus a
   * board with drag and drop, a list view, a move sheet, a requirement prompt
   * and a create form. 255,000 is a PLACEHOLDER: the builder measures it on
   * the first green run and the lead re-pins PIPELINE_BUDGET_BYTES within 5%
   * of that measurement (D-L118). A drag-and-drop library in the initial load
   * will not fit: the board uses the platform's drag events, or the list view
   * and the dialogs load when first opened (`next/dynamic`).
   */
  test('/pipelines/<id> stays inside its transferred-byte budget on the production build @p06-pipeline @p06-pipeline-budget', async ({ page }) => {
    // No fixed clock here: Playwright's fake clock replaces window.performance, so the first
    // contentful paint this measures would never be reported (D-L118).
    active = await installPipelineMock(page);
    const metrics = await measurePageLoad(page, `${pipelineUrl()}/pipelines/${PIPELINE_ONE.id}`, 'default');

    const record = resolve(__dirname, '.artifacts', 'p06-pipeline-budget.json');
    mkdirSync(resolve(__dirname, '.artifacts'), { recursive: true });
    writeFileSync(
      record,
      `${JSON.stringify({ path: '/pipelines/[pipelineId]', transferredBytes: metrics.transferredBytes, budget: PIPELINE_BUDGET_BYTES }, null, 2)}\n`,
      'utf8',
    );

    // Bytes from `next dev` are not a budget (D-L28): prove this is the build.
    const html = await page.content();
    const built = readFileSync(resolve(__dirname, '..', '..', 'apps', 'web', '.next', 'BUILD_ID'), 'utf8').trim();
    expect(servedBuildId(html), 'webPipelineUrl is not serving the production build').toBe(built);
    // A 404 page is small: a budget met by the not-found page measures nothing.
    await expect(screen(page)).toBeVisible();

    expect(PIPELINE_BUDGET_BYTES).toBeLessThan(300_000);
    assertWithinByteBudget('P06/01 the pipeline board', metrics.transferredBytes, PIPELINE_BUDGET_BYTES);
  });

  test('/pipelines/<id> paints within 5 s at 256 kbps and 300 ms @p06-pipeline @p06-pipeline-budget', async ({ page }) => {
    active = await installPipelineMock(page);
    const metrics = await measurePageLoad(page, `${pipelineUrl()}/pipelines/${PIPELINE_ONE.id}`, 'low-bandwidth');
    await expect(screen(page)).toBeVisible();
    expect(metrics.fcpMs, 'first contentful paint on the PRD 2.13 link').toBeLessThan(5_000);
  });
});
